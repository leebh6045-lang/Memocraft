import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  ENTRY_BODY_MAX_LENGTH,
  ENTRY_SUMMARY_MAX_LENGTH,
  MAX_REFERENCE_BATCH,
  THREAD_DESCRIPTION_MAX_LENGTH,
  THREAD_SUMMARY_MAX_LENGTH,
  THREAD_TITLE_MAX_LENGTH,
  type Entry,
  type EntryCreate,
  type EntryEdit,
  type EntrySummary,
  type NoteReference,
  type ThreadCreate,
  type ThreadEdit,
  type ThreadStatus,
  type ThreadSummary,
  type TimelineOrder,
} from '../domain/thread';
import { AppError } from '../shared/errors';
import { transaction } from './database';
import { ENTRY_SELF_VISIBLE, ENTRY_VISIBLE, NOTE_VISIBLE, THREAD_VISIBLE } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '事务字段格式异常，原数据已保留。');
  return value;
}

function numberField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new AppError('STORAGE', '事务版本字段异常，原数据已保留。');
  return value;
}

function requireIdentifier(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new AppError('VALIDATION', message);
  return value;
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new AppError('VALIDATION', '内容版本不正确，请重新载入后重试。');
  return value as number;
}

function text(value: unknown, max: number, message: string): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', message);
  if (value.length > max) throw new AppError('VALIDATION', `${message}（上限 ${max} 个字符）`);
  return value;
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', '请填写事务标题。');
  const title = value.trim();
  if (!title) throw new AppError('VALIDATION', '请填写事务标题。');
  if (title.length > THREAD_TITLE_MAX_LENGTH)
    throw new AppError('VALIDATION', `事务标题不能超过 ${THREAD_TITLE_MAX_LENGTH} 个字符。`);
  return title;
}

/** 发生时间必须是可解析的时间文本；非法时间拒绝写入，空值由界面填当前时间。 */
function requireOccurredAt(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime()))
    throw new AppError('VALIDATION', '发生时间不正确，请重新选择。');
  return value;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new AppError('VALIDATION', '标签最多 100 个。');
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 100)
      throw new AppError('VALIDATION', '每个标签须包含 1 至 100 个字符。');
    tags.push(tag.trim());
  }
  return [...new Set(tags)];
}

function requireReferences(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppError('VALIDATION', '手记引用格式不正确。');
  if (value.length > MAX_REFERENCE_BATCH)
    throw new AppError('VALIDATION', `一次最多关联 ${MAX_REFERENCE_BATCH} 条手记。`);
  return [
    ...new Set(value.map((id) => requireIdentifier(id, '手记标识不正确，请重新打开后重试。'))),
  ];
}

/**
 * 事务与动态的存储：与手记、附图、归纳共用同一条连接，连接所有权仍在 NoteStore。
 * 引用关系只存于 entry_notes 与 thread_notes，事务与动态本身不保存手记列表副本。
 */
export class ThreadStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 默认只列进行中；已归档只在明确要求时出现，但内容始终可打开。 */
  list(includeArchived: boolean): ThreadSummary[] {
    const rows = includeArchived
      ? this.database
          .prepare(
            `SELECT * FROM threads WHERE ${THREAD_VISIBLE} ORDER BY updated_at DESC, id DESC`,
          )
          .all()
      : this.database
          .prepare(
            `SELECT * FROM threads WHERE ${THREAD_VISIBLE} AND status = 'active' ORDER BY updated_at DESC, id DESC`,
          )
          .all();
    const counts = this.entryCounts();
    const notes = this.threadNoteIds();
    return rows.map((row) => this.summaryFromRow(row, counts, notes));
  }

  create(input: ThreadCreate): ThreadSummary {
    const title = requireTitle(input.title);
    const description = text(input.description, THREAD_DESCRIPTION_MAX_LENGTH, '事务说明过长。');
    const summary = text(input.summary, THREAD_SUMMARY_MAX_LENGTH, '当前概况过长。');
    if (typeof input.confirmDuplicate !== 'boolean')
      throw new AppError('VALIDATION', '同名确认状态不正确。');
    return transaction(this.database, () => {
      if (!input.confirmDuplicate && this.findByTitle(title))
        throw new AppError(
          'CONFLICT',
          `已经有名为「${title}」的事务。确认后仍可创建，两者互不影响。`,
        );
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO threads (id, title, description, summary, status, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
        )
        .run(id, title, description, summary, now, now);
      return this.require(id);
    });
  }

  update(edit: ThreadEdit): ThreadSummary {
    const id = requireIdentifier(edit.id, '事务标识不正确，请重新打开后重试。');
    const title = requireTitle(edit.title);
    const description = text(edit.description, THREAD_DESCRIPTION_MAX_LENGTH, '事务说明过长。');
    const summary = text(edit.summary, THREAD_SUMMARY_MAX_LENGTH, '当前概况过长。');
    const expectedRevision = requireRevision(edit.expectedRevision);
    return transaction(this.database, () => {
      const current = this.require(id);
      if (current.revision !== expectedRevision) {
        // 与手记、归纳一致：只接受刚完成的同内容重试，其他版本差异视为冲突。
        if (
          current.revision === expectedRevision + 1 &&
          current.title === title &&
          current.description === description &&
          current.summary === summary
        )
          return current;
        throw new AppError('CONFLICT', '这个事务已有更新。当前编辑内容已保留，请重新打开后核对。');
      }
      this.database
        .prepare(
          'UPDATE threads SET title = ?, description = ?, summary = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(title, description, summary, new Date().toISOString(), id);
      return this.require(id);
    });
  }

  /** 归档与重新启用：只改状态，不改内容与版本之外的东西，也不影响动态自身。 */
  setArchived(threadId: string, archived: boolean, expectedRevision: number): ThreadSummary {
    const id = requireIdentifier(threadId, '事务标识不正确，请重新打开后重试。');
    const revision = requireRevision(expectedRevision);
    const status: ThreadStatus = archived ? 'archived' : 'active';
    return transaction(this.database, () => {
      const current = this.require(id);
      if (current.status === status) return current;
      if (current.revision !== revision)
        throw new AppError('CONFLICT', '这个事务已有更新，请重新打开后再归档。');
      this.database
        .prepare(
          'UPDATE threads SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(status, new Date().toISOString(), id);
      return this.require(id);
    });
  }

  /** 软删除：只标记事务自身，动态与引用行保留，恢复后时间线原样回来。 */
  remove(threadId: string): void {
    const id = requireIdentifier(threadId, '事务标识不正确，请重新打开后重试。');
    transaction(this.database, () => {
      const current = this.require(id);
      this.database
        .prepare('UPDATE threads SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), current.id);
    });
  }

  /** 事务级直接引用：幂等，重复关联不产生第二行。 */
  addNotes(threadId: string, noteIds: string[]): ThreadSummary {
    const id = requireIdentifier(threadId, '事务标识不正确，请重新打开后重试。');
    const targets = requireReferences(noteIds);
    if (targets.length === 0) throw new AppError('VALIDATION', '请选择要关联的手记。');
    return transaction(this.database, () => {
      this.require(id);
      this.assertNotesUsable(targets);
      const insert = this.database.prepare(
        'INSERT INTO thread_notes (thread_id, note_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      );
      const now = new Date().toISOString();
      for (const noteId of targets) insert.run(id, noteId, now);
      return this.require(id);
    });
  }

  removeNote(threadId: string, noteId: string): ThreadSummary {
    const id = requireIdentifier(threadId, '事务标识不正确，请重新打开后重试。');
    const target = requireIdentifier(noteId, '手记标识不正确，请重新打开后重试。');
    return transaction(this.database, () => {
      this.require(id);
      this.database
        .prepare('DELETE FROM thread_notes WHERE thread_id = ? AND note_id = ?')
        .run(id, target);
      return this.require(id);
    });
  }

  /**
   * 时间线：默认最近在前，可切换顺序；同一发生时间按创建时间与 ID 稳定排序。
   * 已删除的事务不可读。
   */
  entries(threadId: string, order: TimelineOrder): EntrySummary[] {
    const id = requireIdentifier(threadId, '事务标识不正确，请重新打开后重试。');
    this.require(id);
    const direction = order === 'oldest' ? 'ASC' : 'DESC';
    const rows = this.database
      .prepare(
        `SELECT * FROM thread_entries
         WHERE thread_id = ? AND ${ENTRY_SELF_VISIBLE}
         ORDER BY occurred_at ${direction}, created_at ${direction}, id ${direction}`,
      )
      .all(id);
    const notes = this.entryNoteIds();
    return rows.map((row) => this.entryFromRow(row, notes));
  }

  /** 新建动态：动态、标签与引用手记在同一事务内写入，任一步失败都不留下半套结果。 */
  addEntry(input: EntryCreate): EntrySummary {
    const threadId = requireIdentifier(input.threadId, '事务标识不正确，请重新打开后重试。');
    const occurredAt = requireOccurredAt(input.occurredAt);
    const summary = this.requireEntrySummary(input.summary);
    const body = text(input.body, ENTRY_BODY_MAX_LENGTH, '动态正文过长。');
    const tags = normalizeTags(input.tags);
    const noteIds = requireReferences(input.noteIds ?? []);
    return transaction(this.database, () => {
      this.require(threadId);
      this.assertNotesUsable(noteIds);
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO thread_entries (id, thread_id, occurred_at, summary, body, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(id, threadId, occurredAt, summary, body, now, now);
      this.replaceEntryTags(id, tags);
      this.linkEntryNotes(id, noteIds, now);
      return this.requireEntry(id);
    });
  }

  /** 编辑动态：只改动态自身，不改写被引用的手记，也不改写手记内容。 */
  updateEntry(edit: EntryEdit): EntrySummary {
    const id = requireIdentifier(edit.id, '动态标识不正确，请重新打开后重试。');
    const occurredAt = requireOccurredAt(edit.occurredAt);
    const summary = this.requireEntrySummary(edit.summary);
    const body = text(edit.body, ENTRY_BODY_MAX_LENGTH, '动态正文过长。');
    const tags = normalizeTags(edit.tags);
    const expectedRevision = requireRevision(edit.expectedRevision);
    return transaction(this.database, () => {
      const current = this.requireEntry(id);
      if (current.revision !== expectedRevision) {
        if (
          current.revision === expectedRevision + 1 &&
          current.occurredAt === occurredAt &&
          current.summary === summary &&
          current.body === body &&
          JSON.stringify(current.tags) === JSON.stringify(tags)
        )
          return current;
        throw new AppError('CONFLICT', '这条动态已有更新。当前编辑内容已保留，请重新打开后核对。');
      }
      this.database
        .prepare(
          'UPDATE thread_entries SET occurred_at = ?, summary = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(occurredAt, summary, body, new Date().toISOString(), id);
      this.replaceEntryTags(id, tags);
      return this.requireEntry(id);
    });
  }

  /** 软删除动态：引用手记继续存在，事务本身不受影响。 */
  removeEntry(entryId: string): void {
    const id = requireIdentifier(entryId, '动态标识不正确，请重新打开后重试。');
    transaction(this.database, () => {
      const current = this.requireEntry(id);
      this.database
        .prepare('UPDATE thread_entries SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), current.id);
    });
  }

  /**
   * 手记被引用的位置：事务级与动态级分开返回，供抽屉提示影响范围与回收站阶段使用。
   * 可见性规则在这里集中表达：动态可见要求自身与所属事务都未删除。
   */
  referencesOfNote(noteId: string): NoteReference[] {
    const id = requireIdentifier(noteId, '手记标识不正确，请重新打开后重试。');
    const threadRows = this.database
      .prepare(
        `SELECT threads.id AS thread_id, threads.title AS title
         FROM thread_notes JOIN threads ON threads.id = thread_notes.thread_id
         WHERE thread_notes.note_id = ? AND ${THREAD_VISIBLE}
         ORDER BY threads.updated_at DESC, threads.id DESC`,
      )
      .all(id);
    const entryRows = this.database
      .prepare(
        `SELECT thread_entries.id AS entry_id, thread_entries.summary AS summary,
                threads.id AS thread_id, threads.title AS title
         FROM entry_notes
         JOIN thread_entries ON thread_entries.id = entry_notes.entry_id
         JOIN threads ON threads.id = thread_entries.thread_id
         WHERE entry_notes.note_id = ?
           AND ${ENTRY_VISIBLE}
         ORDER BY thread_entries.occurred_at DESC, thread_entries.id DESC`,
      )
      .all(id);
    return [
      ...threadRows.map((row) => ({
        threadId: stringField(row, 'thread_id'),
        threadTitle: stringField(row, 'title'),
        entryId: null,
        entrySummary: null,
      })),
      ...entryRows.map((row) => ({
        threadId: stringField(row, 'thread_id'),
        threadTitle: stringField(row, 'title'),
        entryId: stringField(row, 'entry_id'),
        entrySummary: stringField(row, 'summary'),
      })),
    ];
  }

  private requireEntrySummary(value: unknown): string {
    if (typeof value !== 'string') throw new AppError('VALIDATION', '请填写动态描述。');
    const summary = value.trim();
    if (!summary) throw new AppError('VALIDATION', '请填写动态描述。');
    if (summary.length > ENTRY_SUMMARY_MAX_LENGTH)
      throw new AppError('VALIDATION', `动态描述不能超过 ${ENTRY_SUMMARY_MAX_LENGTH} 个字符。`);
    return summary;
  }

  private require(threadId: string): ThreadSummary {
    const row = this.database
      .prepare(`SELECT * FROM threads WHERE id = ? AND ${THREAD_VISIBLE}`)
      .get(threadId);
    if (!row) throw new AppError('NOT_FOUND', '这个事务不存在或已移入回收站。');
    return this.summaryFromRow(row, this.entryCounts(), this.threadNoteIds());
  }

  private requireEntry(entryId: string): EntrySummary {
    const row = this.database
      .prepare(`SELECT * FROM thread_entries WHERE id = ? AND ${ENTRY_SELF_VISIBLE}`)
      .get(entryId);
    if (!row) throw new AppError('NOT_FOUND', '这条动态不存在或已移入回收站。');
    // 动态的可见性还要求所属事务未被删除。
    this.require(stringField(row, 'thread_id'));
    return this.entryFromRow(row, this.entryNoteIds());
  }

  /** 外键不能代替这条业务规则：删除是软删除，被删除的手记行仍然存在。 */
  private assertNotesUsable(noteIds: string[]): void {
    for (const noteId of noteIds) {
      const found = this.database
        .prepare(`SELECT 1 AS found FROM notes WHERE id = ? AND ${NOTE_VISIBLE}`)
        .get(noteId);
      if (!found)
        throw new AppError('NOT_FOUND', '要关联的手记不存在或已移入回收站，请刷新后重试。');
    }
  }

  private linkEntryNotes(entryId: string, noteIds: string[], now: string): void {
    const insert = this.database.prepare(
      'INSERT INTO entry_notes (entry_id, note_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    );
    for (const noteId of noteIds) insert.run(entryId, noteId, now);
  }

  /** 标签与手记标签共用 tags 表：按规范化名称复用已有标签，再按位置重排。 */
  private replaceEntryTags(entryId: string, tags: string[]): void {
    this.database.prepare('DELETE FROM entry_tags WHERE entry_id = ?').run(entryId);
    const upsert = this.database.prepare(
      `INSERT INTO tags (name, normalized_name) VALUES (?, ?)
       ON CONFLICT(normalized_name) DO NOTHING`,
    );
    const find = this.database.prepare('SELECT id FROM tags WHERE normalized_name = ?');
    const link = this.database.prepare(
      'INSERT INTO entry_tags (entry_id, tag_id, position) VALUES (?, ?, ?)',
    );
    tags.forEach((tag, position) => {
      const normalized = tag.normalize('NFKC').toLocaleLowerCase();
      upsert.run(tag, normalized);
      const row = find.get(normalized);
      if (!row) throw new AppError('STORAGE', '标签写入未完成，原数据已保留。');
      link.run(entryId, numberField(row, 'id'), position);
    });
  }

  private entryTags(entryId: string): string[] {
    return this.database
      .prepare(
        `SELECT tags.name AS name FROM entry_tags JOIN tags ON tags.id = entry_tags.tag_id
         WHERE entry_id = ? ORDER BY position`,
      )
      .all(entryId)
      .map((row) => stringField(row, 'name'));
  }

  /** 只统计未删除事务下的未删除动态。 */
  private entryCounts(): Map<string, number> {
    const rows = this.database
      .prepare(
        `SELECT thread_entries.thread_id AS thread_id, count(*) AS total
         FROM thread_entries JOIN threads ON threads.id = thread_entries.thread_id
         WHERE ${ENTRY_VISIBLE}
         GROUP BY thread_entries.thread_id`,
      )
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(stringField(row, 'thread_id'), numberField(row, 'total'));
    return counts;
  }

  private threadNoteIds(): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT thread_notes.thread_id AS thread_id, thread_notes.note_id AS note_id
         FROM thread_notes
         JOIN notes ON notes.id = thread_notes.note_id
         JOIN threads ON threads.id = thread_notes.thread_id
         WHERE ${NOTE_VISIBLE} AND ${THREAD_VISIBLE}
         ORDER BY notes.created_at DESC, notes.id DESC`,
      )
      .all();
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const threadId = stringField(row, 'thread_id');
      const list = result.get(threadId);
      if (list) list.push(stringField(row, 'note_id'));
      else result.set(threadId, [stringField(row, 'note_id')]);
    }
    return result;
  }

  private entryNoteIds(): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT entry_notes.entry_id AS entry_id, entry_notes.note_id AS note_id
         FROM entry_notes
         JOIN notes ON notes.id = entry_notes.note_id
         WHERE ${NOTE_VISIBLE}
         ORDER BY notes.created_at DESC, notes.id DESC`,
      )
      .all();
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const entryId = stringField(row, 'entry_id');
      const list = result.get(entryId);
      if (list) list.push(stringField(row, 'note_id'));
      else result.set(entryId, [stringField(row, 'note_id')]);
    }
    return result;
  }

  private findByTitle(title: string): string | null {
    const row = this.database
      .prepare(
        `SELECT id FROM threads WHERE ${THREAD_VISIBLE} AND lower(trim(title)) = lower(?) LIMIT 1`,
      )
      .get(title.trim());
    return row ? stringField(row, 'id') : null;
  }

  private summaryFromRow(
    row: DatabaseRow,
    counts: Map<string, number>,
    notes: Map<string, string[]>,
  ): ThreadSummary {
    const id = stringField(row, 'id');
    const status = row.status === 'archived' ? 'archived' : 'active';
    return {
      id,
      title: stringField(row, 'title'),
      description: stringField(row, 'description'),
      summary: stringField(row, 'summary'),
      status,
      revision: numberField(row, 'revision'),
      createdAt: stringField(row, 'created_at'),
      updatedAt: stringField(row, 'updated_at'),
      entryCount: counts.get(id) ?? 0,
      noteIds: notes.get(id) ?? [],
    };
  }

  private entryFromRow(row: DatabaseRow, notes: Map<string, string[]>): EntrySummary {
    const id = stringField(row, 'id');
    return {
      id,
      threadId: stringField(row, 'thread_id'),
      occurredAt: stringField(row, 'occurred_at'),
      summary: stringField(row, 'summary'),
      body: stringField(row, 'body'),
      tags: this.entryTags(id),
      revision: numberField(row, 'revision'),
      createdAt: stringField(row, 'created_at'),
      updatedAt: stringField(row, 'updated_at'),
      noteIds: notes.get(id) ?? [],
    };
  }
}

export type { Entry, EntryCreate, EntryEdit, ThreadCreate, ThreadEdit };
