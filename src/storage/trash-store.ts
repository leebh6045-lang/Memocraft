import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { noteTitle } from '../domain/note';
import {
  TRASH_KIND_LABELS,
  type RemovalImpact,
  type TrashItem,
  type TrashKind,
} from '../domain/trash';
import { AppError } from '../shared/errors';
import { transaction } from './database';
import type { NoteStore } from './note-store';
import type { ThreadStore } from './thread-store';
import type { TopicStore } from './topic-store';
import { isVisible } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '回收站记录字段异常。');
  return value;
}

function deletedAtOf(row: DatabaseRow): string {
  const value = row['deleted_at'];
  if (typeof value !== 'string') throw new AppError('STORAGE', '回收站记录缺少删除时间。');
  return value;
}

/**
 * 回收站：列表、恢复与删除影响面。
 *
 * 删除本身仍由各实体的存储实现完成（归纳、事务、动态、手记各自拥有自己的软删除语义），
 * 这里只做三件跨实体的事：汇总已删除内容、恢复时判断父实体边界、删除前算出影响面。
 * 可见性判断统一取自 `visibility.ts`，不在这里另写一套。
 */
export class TrashStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly notes: NoteStore,
    private readonly topics: TopicStore,
    private readonly threads: ThreadStore,
  ) {}

  /** 最近删除的排在前面；动态即使父事务也在回收站，也照常列出以便单独认领。 */
  list(): TrashItem[] {
    const items: TrashItem[] = [
      ...this.deletedNotes(),
      ...this.deletedTopics(),
      ...this.deletedThreads(),
      ...this.deletedEntries(),
    ];
    return items.sort((left, right) => (left.deletedAt < right.deletedAt ? 1 : -1));
  }

  /** 删除前的影响面：说清会隐藏什么、什么不受影响。 */
  impactOf(kind: TrashKind, id: string): RemovalImpact {
    const title = this.titleOf(kind, id, false);
    const effects: string[] = [];
    if (kind === 'note') {
      const topics = this.topicsOfNote(id);
      if (topics.length) effects.push(`会从这些归纳里隐藏：${topics.join('、')}`);
      const references = this.referencesOfNote(id);
      if (references.length)
        effects.push(`这些位置会显示「已移入回收站」：${references.join('、')}`);
      effects.push('手记本身、分类与关系都保留，恢复后原样回来。');
    }
    if (kind === 'topic') {
      const collected = this.collectedCount(id);
      effects.push(`收录的 ${collected} 条手记不会受影响，收录关系保留。`);
      effects.push('手记的分类与正文都不会改变。');
    }
    if (kind === 'thread') {
      const entries = this.entryCount(id);
      if (entries) effects.push(`它的 ${entries} 条动态会一起隐藏，并随事务一起恢复。`);
      effects.push('此前单独删除的动态仍留在回收站，不会因为恢复事务被一起恢复。');
      effects.push('引用的手记继续存在，其他事务不受影响。');
    }
    if (kind === 'entry') {
      const references = this.notesOfEntry(id);
      effects.push(
        references
          ? `引用的 ${references} 条手记不受影响，仍留在随手记。`
          : '这条动态没有引用手记。',
      );
    }
    return { kind, id, title, effects };
  }

  /**
   * 删除：委托给各实体的存储实现，保证「归纳删除不删手记」这类语义只有一处定义。
   */
  remove(kind: TrashKind, id: string): void {
    if (kind === 'note') {
      this.notes.remove(id);
      return;
    }
    if (kind === 'topic') {
      this.topics.remove(id);
      return;
    }
    if (kind === 'thread') {
      this.threads.remove(id);
      return;
    }
    this.threads.removeEntry(id);
  }

  /**
   * 恢复：父实体在回收站时先恢复父实体（动态不能单独越过父事务恢复）。
   * 恢复事务不会清除动态自己的删除标记，因此此前单独删除的动态仍留在回收站。
   */
  restore(kind: TrashKind, id: string): void {
    if (kind === 'entry') {
      const entry = this.database
        .prepare('SELECT thread_id, deleted_at FROM thread_entries WHERE id = ?')
        .get(id);
      if (!entry) throw new AppError('NOT_FOUND', '这条动态不存在。');
      const thread = this.database
        .prepare('SELECT deleted_at FROM threads WHERE id = ?')
        .get(stringField(entry, 'thread_id'));
      if (!thread || !isVisible(thread.deleted_at))
        throw new AppError('CONFLICT', '父事务还在回收站，请先恢复它，再恢复这条动态。');
      this.clearDeletedAt('thread_entries', id);
      return;
    }
    const table = kind === 'note' ? 'notes' : kind === 'topic' ? 'topics' : 'threads';
    this.clearDeletedAt(table, id);
  }

  private clearDeletedAt(
    table: 'notes' | 'topics' | 'threads' | 'thread_entries',
    id: string,
  ): void {
    transaction(this.database, () => {
      const row = this.database.prepare(`SELECT deleted_at FROM ${table} WHERE id = ?`).get(id);
      if (!row) throw new AppError('NOT_FOUND', '这条内容不存在。');
      if (isVisible(row.deleted_at))
        throw new AppError('NOT_FOUND', '这条内容不在回收站里，无需恢复。');
      const now = new Date().toISOString();
      // 恢复后更新修改时间，让它在列表里回到可见位置；其他字段一律不动。
      this.database
        .prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`)
        .run(now, id);
    });
  }

  private titleOf(kind: TrashKind, id: string, requireDeleted = true): string {
    const filter = requireDeleted ? 'AND deleted_at IS NOT NULL' : '';
    if (kind === 'note') {
      const row = this.database
        .prepare(`SELECT title, body FROM notes WHERE id = ? ${filter}`)
        .get(id);
      if (!row) throw new AppError('NOT_FOUND', '这条手记不存在。');
      return noteTitle({
        title: stringField(row, 'title'),
        body: stringField(row, 'body'),
        category: 'insight',
        tags: [],
      });
    }
    if (kind === 'entry') {
      const row = this.database
        .prepare(`SELECT summary FROM thread_entries WHERE id = ? ${filter}`)
        .get(id);
      if (!row) throw new AppError('NOT_FOUND', '这条动态不存在。');
      return stringField(row, 'summary');
    }
    const table = kind === 'topic' ? 'topics' : 'threads';
    const row = this.database.prepare(`SELECT title FROM ${table} WHERE id = ? ${filter}`).get(id);
    if (!row) throw new AppError('NOT_FOUND', `这个${TRASH_KIND_LABELS[kind]}不存在。`);
    return stringField(row, 'title');
  }

  private deletedNotes(): TrashItem[] {
    return this.database
      .prepare('SELECT * FROM notes WHERE deleted_at IS NOT NULL')
      .all()
      .map((row) => {
        const id = stringField(row, 'id');
        const topics = this.topicsOfNote(id);
        return {
          kind: 'note' as const,
          id,
          title: noteTitle({
            title: stringField(row, 'title'),
            body: stringField(row, 'body'),
            category: 'insight',
            tags: [],
          }),
          context: topics.length ? `原属归纳：${topics.join('、')}` : '未被任何归纳收录',
          deletedAt: deletedAtOf(row),
        };
      });
  }

  private deletedTopics(): TrashItem[] {
    return this.database
      .prepare('SELECT * FROM topics WHERE deleted_at IS NOT NULL')
      .all()
      .map((row) => {
        const id = stringField(row, 'id');
        return {
          kind: 'topic' as const,
          id,
          title: stringField(row, 'title'),
          context: `收录过 ${this.collectedCount(id)} 条手记`,
          deletedAt: deletedAtOf(row),
        };
      });
  }

  private deletedThreads(): TrashItem[] {
    return this.database
      .prepare('SELECT * FROM threads WHERE deleted_at IS NOT NULL')
      .all()
      .map((row) => {
        const id = stringField(row, 'id');
        const entries = this.entryCount(id);
        return {
          kind: 'thread' as const,
          id,
          title: stringField(row, 'title'),
          context: entries ? `含 ${entries} 条动态` : '还没有动态',
          deletedAt: deletedAtOf(row),
        };
      });
  }

  private deletedEntries(): TrashItem[] {
    // 动态按自身删除时间列出，父事务是否已删除不影响它在回收站里的可见性。
    return this.database
      .prepare('SELECT * FROM thread_entries WHERE deleted_at IS NOT NULL')
      .all()
      .map((row) => {
        const id = stringField(row, 'id');
        const thread = this.database
          .prepare('SELECT title, deleted_at FROM threads WHERE id = ?')
          .get(stringField(row, 'thread_id'));
        const threadTitle = thread ? stringField(thread, 'title') : '已不存在的事务';
        const threadDeleted = thread ? !isVisible(thread.deleted_at) : true;
        return {
          kind: 'entry' as const,
          id,
          title: stringField(row, 'summary'),
          context: `原属事务：${threadTitle}${threadDeleted ? '（事务也在回收站）' : ''}`,
          deletedAt: deletedAtOf(row),
        };
      });
  }

  /** 手记当前所属的归纳标题：删除确认与回收站列表都用它说明来源。 */
  private topicsOfNote(noteId: string): string[] {
    return this.database
      .prepare(
        `SELECT topics.title AS title FROM note_topics
         JOIN topics ON topics.id = note_topics.topic_id
         WHERE note_topics.note_id = ? AND topics.deleted_at IS NULL
         ORDER BY topics.updated_at DESC, topics.id DESC`,
      )
      .all(noteId)
      .map((row) => stringField(row, 'title'));
  }

  /** 手记被引用的位置：事务资料与动态引用分开描述。 */
  private referencesOfNote(noteId: string): string[] {
    const threads = this.database
      .prepare(
        `SELECT threads.title AS title FROM thread_notes
         JOIN threads ON threads.id = thread_notes.thread_id
         WHERE thread_notes.note_id = ? AND threads.deleted_at IS NULL`,
      )
      .all(noteId)
      .map((row) => `${stringField(row, 'title')}（事务资料）`);
    const entries = this.database
      .prepare(
        `SELECT threads.title AS thread_title, thread_entries.summary AS summary
         FROM entry_notes
         JOIN thread_entries ON thread_entries.id = entry_notes.entry_id
         JOIN threads ON threads.id = thread_entries.thread_id
         WHERE entry_notes.note_id = ? AND thread_entries.deleted_at IS NULL AND threads.deleted_at IS NULL`,
      )
      .all(noteId)
      .map((row) => `${stringField(row, 'thread_title')} · ${stringField(row, 'summary')}`);
    return [...threads, ...entries];
  }

  /** 统计口径与列表一致：只算仍然可见的收录行，已删除手记不计入。 */
  private collectedCount(topicId: string): number {
    const row = this.database
      .prepare(
        `SELECT count(*) AS total FROM note_topics
         JOIN notes ON notes.id = note_topics.note_id
         WHERE note_topics.topic_id = ? AND notes.deleted_at IS NULL`,
      )
      .get(topicId);
    const total = row?.total;
    return typeof total === 'number' ? total : 0;
  }

  private entryCount(threadId: string): number {
    const row = this.database
      .prepare(
        'SELECT count(*) AS total FROM thread_entries WHERE thread_id = ? AND deleted_at IS NULL',
      )
      .get(threadId);
    const total = row?.total;
    return typeof total === 'number' ? total : 0;
  }

  private notesOfEntry(entryId: string): number {
    const row = this.database
      .prepare(
        `SELECT count(*) AS total FROM entry_notes
         JOIN notes ON notes.id = entry_notes.note_id
         WHERE entry_notes.entry_id = ? AND notes.deleted_at IS NULL`,
      )
      .get(entryId);
    const total = row?.total;
    return typeof total === 'number' ? total : 0;
  }
}
