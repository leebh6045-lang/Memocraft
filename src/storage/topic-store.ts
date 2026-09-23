import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  MAX_TOPIC_LINK_BATCH,
  TOPIC_DESCRIPTION_MAX_LENGTH,
  TOPIC_TITLE_MAX_LENGTH,
  type TopicCreate,
  type TopicEdit,
  type TopicSummary,
} from '../domain/topic';
import { AppError } from '../shared/errors';
import { transaction } from './database';
import { NOTE_VISIBLE, TOPIC_VISIBLE } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '归纳字段格式异常，原数据已保留。');
  return value;
}

function numberField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new AppError('STORAGE', '归纳版本字段异常，原数据已保留。');
  return value;
}

/**
 * 归纳标题与说明的服务层校验。数据库的 CHECK 只兜底「标题非空」，
 * 长度上限留在这里，避免把产品文案规则写进已发布的迁移。
 */
function validateTopicContent(input: { title: unknown; description: unknown }): {
  title: string;
  description: string;
} {
  if (typeof input.title !== 'string') throw new AppError('VALIDATION', '请填写归纳标题。');
  const title = input.title.trim();
  if (!title) throw new AppError('VALIDATION', '请填写归纳标题。');
  if (title.length > TOPIC_TITLE_MAX_LENGTH)
    throw new AppError('VALIDATION', `归纳标题不能超过 ${TOPIC_TITLE_MAX_LENGTH} 个字符。`);
  if (typeof input.description !== 'string') throw new AppError('VALIDATION', '归纳说明须为文本。');
  if (input.description.length > TOPIC_DESCRIPTION_MAX_LENGTH)
    throw new AppError('VALIDATION', `归纳说明不能超过 ${TOPIC_DESCRIPTION_MAX_LENGTH} 个字符。`);
  // 说明保留用户原文，只有标题去掉两端空白。
  return { title, description: input.description };
}

function requireIdentifier(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value) throw new AppError('VALIDATION', message);
  return value;
}

/**
 * 归纳存储：与手记、附图共用同一条连接，连接的所有权仍在 NoteStore。
 * 收录关系只存于 note_topics，归纳本身不保存手记列表副本。
 */
export class TopicStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 列表按最近更新倒序；每个归纳带上当前收录的有效手记 ID，供计数与反查共用。 */
  list(): TopicSummary[] {
    const rows = this.database
      .prepare(`SELECT * FROM topics WHERE ${TOPIC_VISIBLE} ORDER BY updated_at DESC, id DESC`)
      .all();
    const noteIdsByTopic = this.noteIdsByTopic();
    return rows.map((row) => this.summaryFromRow(row, noteIdsByTopic));
  }

  create(input: TopicCreate): TopicSummary {
    const { title, description } = validateTopicContent(input);
    if (typeof input.confirmDuplicate !== 'boolean')
      throw new AppError('VALIDATION', '同名确认状态不正确。');
    return transaction(this.database, () => {
      if (!input.confirmDuplicate && this.findByTitle(title))
        throw new AppError(
          'CONFLICT',
          `已经有名为「${title}」的归纳。确认后仍可创建，两者互不影响。`,
        );
      const id = randomUUID();
      const now = new Date().toISOString();
      this.database
        .prepare(
          'INSERT INTO topics (id, title, description, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
        )
        .run(id, title, description, now, now);
      return this.require(id);
    });
  }

  update(edit: TopicEdit): TopicSummary {
    const { title, description } = validateTopicContent(edit);
    const id = requireIdentifier(edit.id, '归纳标识不正确，请重新打开后重试。');
    if (!Number.isSafeInteger(edit.expectedRevision) || edit.expectedRevision < 1)
      throw new AppError('VALIDATION', '归纳版本不正确，请重新载入后重试。');
    return transaction(this.database, () => {
      const current = this.require(id);
      if (current.revision !== edit.expectedRevision) {
        // 与手记一致：只接受刚完成的同内容重试，其他版本差异视为冲突并保留本地输入。
        if (
          current.revision === edit.expectedRevision + 1 &&
          current.title === title &&
          current.description === description
        )
          return current;
        throw new AppError('CONFLICT', '这个归纳已有更新。当前编辑内容已保留，请重新打开后核对。');
      }
      this.database
        .prepare(
          'UPDATE topics SET title = ?, description = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        )
        .run(title, description, new Date().toISOString(), id);
      return this.require(id);
    });
  }

  /** 软删除：只标记 deleted_at，不动 note_topics，也不改动手记；恢复后收录关系原样回来。 */
  remove(topicId: string): void {
    const id = requireIdentifier(topicId, '归纳标识不正确，请重新打开后重试。');
    transaction(this.database, () => {
      const current = this.require(id);
      this.database
        .prepare('UPDATE topics SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), new Date().toISOString(), current.id);
    });
  }

  /** 批量收录：幂等，重复收录不产生第二行，也不改动首次收录时间。 */
  addNotes(topicId: string, noteIds: string[]): TopicSummary {
    const id = requireIdentifier(topicId, '归纳标识不正确，请重新打开后重试。');
    if (!Array.isArray(noteIds) || noteIds.length === 0)
      throw new AppError('VALIDATION', '请选择要收录的手记。');
    if (noteIds.length > MAX_TOPIC_LINK_BATCH)
      throw new AppError('VALIDATION', `一次最多收录 ${MAX_TOPIC_LINK_BATCH} 条手记。`);
    const unique = [
      ...new Set(
        noteIds.map((noteId) => requireIdentifier(noteId, '手记标识不正确，请重新打开后重试。')),
      ),
    ];
    return transaction(this.database, () => {
      this.require(id);
      // 外键不能代替这条业务规则：删除是软删除，被删除的手记行仍然存在。
      for (const noteId of unique) {
        if (!this.activeNoteExists(noteId))
          throw new AppError('NOT_FOUND', '要收录的手记不存在或已移入回收站，请刷新后重试。');
      }
      const insert = this.database.prepare(
        'INSERT INTO note_topics (note_id, topic_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      );
      const now = new Date().toISOString();
      for (const noteId of unique) insert.run(noteId, id, now);
      return this.require(id);
    });
  }

  /** 移出单个收录：只删关系行，手记正文、分类与其他归纳的收录都不受影响。 */
  removeNote(topicId: string, noteId: string): TopicSummary {
    const id = requireIdentifier(topicId, '归纳标识不正确，请重新打开后重试。');
    const targetNoteId = requireIdentifier(noteId, '手记标识不正确，请重新打开后重试。');
    return transaction(this.database, () => {
      this.require(id);
      this.database
        .prepare('DELETE FROM note_topics WHERE topic_id = ? AND note_id = ?')
        .run(id, targetNoteId);
      return this.require(id);
    });
  }

  private require(topicId: string): TopicSummary {
    const row = this.database
      .prepare(`SELECT * FROM topics WHERE id = ? AND ${TOPIC_VISIBLE}`)
      .get(topicId);
    if (!row) throw new AppError('NOT_FOUND', '这个归纳不存在或已移入回收站。');
    return this.summaryFromRow(row, this.noteIdsByTopic());
  }

  /** 只统计未删除手记；已删除手记的收录行保留，但不出现在列表与计数里。 */
  private noteIdsByTopic(): Map<string, string[]> {
    const rows = this.database
      .prepare(
        `SELECT note_topics.topic_id AS topic_id, note_topics.note_id AS note_id
         FROM note_topics JOIN notes ON notes.id = note_topics.note_id
         WHERE ${NOTE_VISIBLE}
         ORDER BY notes.created_at DESC, notes.id DESC`,
      )
      .all();
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const topicId = stringField(row, 'topic_id');
      const noteId = stringField(row, 'note_id');
      const list = result.get(topicId);
      if (list) list.push(noteId);
      else result.set(topicId, [noteId]);
    }
    return result;
  }

  private activeNoteExists(noteId: string): boolean {
    return (
      this.database
        .prepare(`SELECT 1 AS found FROM notes WHERE id = ? AND ${NOTE_VISIBLE}`)
        .get(noteId) !== undefined
    );
  }

  /** 同名判定按去空白后的标题比较；大小写折叠限于英文字母，与 SQLite 的 lower() 一致。 */
  private findByTitle(title: string): string | null {
    const row = this.database
      .prepare(
        `SELECT id FROM topics WHERE ${TOPIC_VISIBLE} AND lower(trim(title)) = lower(?) LIMIT 1`,
      )
      .get(title.trim());
    return row ? stringField(row, 'id') : null;
  }

  private summaryFromRow(row: DatabaseRow, noteIdsByTopic: Map<string, string[]>): TopicSummary {
    const id = stringField(row, 'id');
    return {
      id,
      title: stringField(row, 'title'),
      description: stringField(row, 'description'),
      revision: numberField(row, 'revision'),
      createdAt: stringField(row, 'created_at'),
      updatedAt: stringField(row, 'updated_at'),
      noteIds: noteIdsByTopic.get(id) ?? [],
    };
  }
}
