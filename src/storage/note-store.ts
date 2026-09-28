import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import {
  NOTE_CATEGORIES,
  type LibrarySnapshot,
  type Note,
  type NoteContent,
  type NoteDraft,
  type NoteEdit,
} from '../domain/note';
import { AppError } from '../shared/errors';
import {
  assertMigrationCount,
  checkIntegrity,
  DATABASE_FILENAME,
  migrate,
  requireMigrationVersion,
  transaction,
} from './database';
import { NOTE_VISIBLE } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string')
    throw new AppError('STORAGE', '数据库字段格式异常，原数据已保留。');
  return value;
}

function numberField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new AppError('STORAGE', '数据库版本字段异常，原数据已保留。');
  return value;
}

function sameContent(left: NoteContent, right: NoteContent): boolean {
  return (
    left.body === right.body &&
    left.title === right.title &&
    left.category === right.category &&
    JSON.stringify(left.tags) === JSON.stringify(right.tags)
  );
}

function validateContent(content: NoteContent, requireBody: boolean): void {
  if (
    typeof content.body !== 'string' ||
    typeof content.title !== 'string' ||
    !NOTE_CATEGORIES.some((category) => category.value === content.category) ||
    !Array.isArray(content.tags) ||
    content.tags.some((tag) => typeof tag !== 'string' || !tag.trim() || tag !== tag.trim())
  ) {
    throw new AppError('VALIDATION', '手记内容或分类无效，请检查后重试。');
  }
  if (requireBody && !content.body.trim())
    throw new AppError('VALIDATION', '请先写下正文，再保存手记。');
  const normalized = content.tags.map((tag) => tag.trim());
  if (new Set(normalized).size !== normalized.length)
    throw new AppError('VALIDATION', '标签不能重复。');
}

function validateDraft(draft: NoteDraft): void {
  validateContent(draft, false);
  if (
    !draft.id ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 0 ||
    typeof draft.extrasOpen !== 'boolean'
  )
    throw new AppError('VALIDATION', '草稿标识或版本无效。');
}

function draftFromRow(row: DatabaseRow): NoteDraft {
  const payload: unknown = JSON.parse(stringField(row, 'payload'));
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('body' in payload) ||
    typeof payload.body !== 'string' ||
    !('title' in payload) ||
    typeof payload.title !== 'string' ||
    !('category' in payload) ||
    !('tags' in payload) ||
    !Array.isArray(payload.tags) ||
    !payload.tags.every((tag: unknown): tag is string => typeof tag === 'string') ||
    !('extrasOpen' in payload) ||
    typeof payload.extrasOpen !== 'boolean'
  ) {
    throw new AppError('STORAGE', '草稿格式异常，原数据已保留。');
  }
  const category = NOTE_CATEGORIES.find((item) => item.value === payload.category)?.value;
  if (!category) throw new AppError('STORAGE', '草稿分类无效，原数据已保留。');
  const draft = {
    id: stringField(row, 'id'),
    revision: numberField(row, 'revision'),
    body: payload.body,
    title: payload.title,
    category,
    tags: payload.tags,
    extrasOpen: payload.extrasOpen,
  };
  validateDraft(draft);
  return draft;
}

/** 单连接由主进程侧调度；所有复合写入在同步短事务内完成。 */
export class NoteStore {
  private readonly database: DatabaseSync;

  constructor(options: {
    dataDirectory: string;
    migrationsDirectory: string;
    /** 本应用的数据结构版本；迁移完成后数据库必须等于它，否则拒绝打开。 */
    expectedSchemaVersion: number;
  }) {
    mkdirSync(options.dataDirectory, { recursive: true });
    const filename = join(options.dataDirectory, DATABASE_FILENAME);
    if (existsSync(filename) && statSync(filename).size === 0) {
      throw new AppError('STORAGE', '已有数据库文件为空，可能已损坏。原文件已保留，请从备份恢复。');
    }
    // 先确认安装自带的迁移文件齐全，再打开库：缺文件时报出真实原因，不误报数据版本问题。
    assertMigrationCount(options.migrationsDirectory, options.expectedSchemaVersion);
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      if (this.database.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1)
        throw new AppError('STORAGE', '数据库外键保护未能启用。');
      checkIntegrity(this.database);
      migrate(this.database, options.migrationsDirectory);
      // 迁移后再确认版本，附图与归纳等其他存储实现可以直接按当前模式准备语句。
      requireMigrationVersion(this.database, options.expectedSchemaVersion);
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  load(): LibrarySnapshot {
    return {
      draft: this.currentDraft(),
      notes: this.database
        .prepare(`SELECT * FROM notes WHERE ${NOTE_VISIBLE} ORDER BY created_at DESC, id DESC`)
        .all()
        .map((row) => this.noteFromRow(row)),
    };
  }

  saveDraft(draft: NoteDraft): NoteDraft {
    validateDraft(draft);
    return transaction(this.database, () => {
      // 已提交 ID 不得再写为草稿，防止迟到的自动保存复活旧内容。
      if (this.findNote(draft.id, true))
        throw new AppError('CONFLICT', '这份草稿已经保存为手记，请开始新的记录。');
      const current = this.currentDraft();
      this.assertDraftSlot(draft, current);
      if (current && current.revision > draft.revision) return current;
      // 清空也保存空载荷及版本，不能把旧版本重新当作首次写入。
      this.database
        .prepare(
          `INSERT INTO note_drafts (slot, id, revision, payload, updated_at) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(slot) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`,
        )
        .run(
          draft.id,
          draft.revision,
          JSON.stringify({
            body: draft.body,
            title: draft.title,
            category: draft.category,
            tags: draft.tags,
            extrasOpen: draft.extrasOpen,
          }),
          new Date().toISOString(),
        );
      return draft;
    });
  }

  /**
   * 正式提交草稿。
   * `claimDraftImages` 由服务层传入：草稿期间的附图必须与创建手记、清理草稿在同一个事务里
   * 归属到这条手记，任一步失败整体回滚，不留「有手记没图」或「图还挂在草稿上」的半套结果。
   */
  commitDraft(draft: NoteDraft, claimDraftImages?: (noteId: string) => void): Note {
    validateDraft(draft);
    validateContent(draft, true);
    return transaction(this.database, () => {
      // 按稳定 ID 查证重复提交；创建、标签关联、附图归属和草稿清理共用本事务。
      const existing = this.findNote(draft.id, true);
      if (existing) return existing;
      const current = this.currentDraft();
      this.assertDraftSlot(draft, current);
      if (current && current.revision > draft.revision)
        throw new AppError('CONFLICT', '已存在更新的草稿，请确认最新内容后保存。');
      const now = new Date().toISOString();
      this.database
        .prepare(
          'INSERT INTO notes (id, body, title, category, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        )
        .run(draft.id, draft.body, draft.title, draft.category, now, now);
      this.replaceTags(draft.id, draft.tags);
      // 先插入手记，再把草稿附图转过来，最后才删草稿行：外键保证顺序不能颠倒。
      claimDraftImages?.(draft.id);
      this.database.prepare('DELETE FROM note_drafts WHERE id = ?').run(draft.id);
      return this.requireNote(draft.id);
    });
  }

  updateNote(edit: NoteEdit): Note {
    validateContent(edit, true);
    if (!edit.id || !Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision < 1)
      throw new AppError('VALIDATION', '手记标识或版本无效。');
    return transaction(this.database, () => {
      const current = this.requireNote(edit.id);
      if (current.revision !== edit.expectedRevision) {
        // 只接受刚完成的同内容重试；其他版本差异都视为冲突。
        if (current.revision === edit.expectedRevision + 1 && sameContent(current, edit))
          return current;
        throw new AppError('CONFLICT', '这条手记已有更新。当前编辑内容已保留，请重新打开后核对。');
      }
      this.database
        .prepare(
          'UPDATE notes SET body = ?, title = ?, category = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(edit.body, edit.title, edit.category, new Date().toISOString(), edit.id);
      this.replaceTags(edit.id, edit.tags);
      return this.requireNote(edit.id);
    });
  }

  /** 软删除手记：只标记时间，草稿、收录关系与引用都不受影响。 */
  remove(noteId: string): void {
    transaction(this.database, () => {
      const note = this.requireNote(noteId);
      const now = new Date().toISOString();
      this.database
        .prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, note.id);
    });
  }

  close(): void {
    this.database.close();
  }

  /**
   * 供同一 worker 内的其他存储实现复用这条唯一连接。
   * 连接仍由本类负责打开与关闭，调用方不得自行关闭或跨线程传递。
   */
  connection(): DatabaseSync {
    return this.database;
  }

  private currentDraft(): NoteDraft | null {
    const row = this.database.prepare('SELECT * FROM note_drafts WHERE slot = 1').get();
    return row ? draftFromRow(row) : null;
  }

  private assertDraftSlot(draft: NoteDraft, current: NoteDraft | null): void {
    if (!current) return;
    if (current.id !== draft.id)
      throw new AppError('CONFLICT', '首页已有另一份草稿，当前内容已保留，请重新载入后核对。');
    if (
      current.revision === draft.revision &&
      (!sameContent(current, draft) || current.extrasOpen !== draft.extrasOpen)
    )
      throw new AppError('CONFLICT', '草稿版本发生冲突，当前内容已保留。');
  }

  private findNote(id: string, includeDeleted = false): Note | null {
    const row = this.database
      .prepare(`SELECT * FROM notes WHERE id = ? ${includeDeleted ? '' : `AND ${NOTE_VISIBLE}`}`)
      .get(id);
    return row ? this.noteFromRow(row) : null;
  }

  private requireNote(id: string): Note {
    const note = this.findNote(id);
    if (!note) throw new AppError('NOT_FOUND', '手记不存在或已进入回收站。');
    return note;
  }

  private noteFromRow(row: DatabaseRow): Note {
    const category = NOTE_CATEGORIES.find((item) => item.value === row.category)?.value;
    if (!category) throw new AppError('STORAGE', '手记分类无效，原数据已保留。');
    const id = stringField(row, 'id');
    const tags = this.database
      .prepare(
        'SELECT tags.name FROM note_tags JOIN tags ON tags.id = note_tags.tag_id WHERE note_id = ? ORDER BY position',
      )
      .all(id)
      .map((tag) => stringField(tag, 'name'));
    return {
      id,
      body: stringField(row, 'body'),
      title: stringField(row, 'title'),
      category,
      revision: numberField(row, 'revision'),
      createdAt: stringField(row, 'created_at'),
      updatedAt: stringField(row, 'updated_at'),
      tags,
    };
  }

  private replaceTags(noteId: string, tags: string[]): void {
    this.database.prepare('DELETE FROM note_tags WHERE note_id = ?').run(noteId);
    for (const [position, name] of tags.entries()) {
      const normalized = name.trim();
      this.database
        .prepare(
          'INSERT INTO tags (name, normalized_name) VALUES (?, ?) ON CONFLICT(normalized_name) DO NOTHING',
        )
        .run(name, normalized);
      this.database
        .prepare(
          'INSERT INTO note_tags (note_id, tag_id, position) SELECT ?, id, ? FROM tags WHERE normalized_name = ?',
        )
        .run(noteId, position, normalized);
    }
  }
}
