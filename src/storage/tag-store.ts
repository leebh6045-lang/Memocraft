import type { DatabaseSync } from 'node:sqlite';
import { AI_SUGGESTION_TAG_POOL_LIMIT } from '../shared/ai';
import { AppError } from '../shared/errors';
import { NOTE_VISIBLE } from './visibility';

/** 标签池只读已有关系，与其他存储共用 NoteStore 的连接。 */
export class TagStore {
  constructor(private readonly database: DatabaseSync) {}

  /** 已删除手记及未使用标签不参与候选；同频次按名称稳定排序。 */
  list(): string[] {
    return this.database
      .prepare(
        `SELECT tags.name AS name, COUNT(*) AS used
         FROM note_tags
         JOIN tags ON tags.id = note_tags.tag_id
         JOIN notes ON notes.id = note_tags.note_id
         WHERE ${NOTE_VISIBLE}
         GROUP BY tags.name
         ORDER BY used DESC, tags.name ASC
         LIMIT ?`,
      )
      .all(AI_SUGGESTION_TAG_POOL_LIMIT)
      .map((row) => {
        if (typeof row.name !== 'string')
          throw new AppError('STORAGE', '标签字段格式异常，原数据已保留。');
        return row.name;
      });
  }
}
