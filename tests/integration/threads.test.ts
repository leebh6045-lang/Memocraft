import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { ThreadStore } from '../../src/storage/thread-store';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
let store: NoteStore;
let threads: ThreadStore;

/** 真实临时 SQLite：时间线排序、引用去重与软删除可见性都按数据库实际行为验证。 */
beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-threads-'));
  store = new NoteStore({
    dataDirectory: join(temporaryDirectory, 'data'),
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  threads = new ThreadStore(store.connection());
});

afterEach(() => {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function note(overrides: Partial<NoteDraft> = {}): Note {
  return store.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '事务样例正文',
    ...overrides,
  });
}

function thread(title: string, confirmDuplicate = false): string {
  return threads.create({ title, description: `${title} 的说明`, summary: '', confirmDuplicate })
    .id;
}

function entry(
  threadId: string,
  overrides: Partial<{
    occurredAt: string;
    summary: string;
    body: string;
    tags: string[];
    noteIds: string[];
  }> = {},
): string {
  return threads.addEntry({
    threadId,
    occurredAt: overrides.occurredAt ?? '2026-09-10T10:00:00.000Z',
    summary: overrides.summary ?? '一条动态',
    body: overrides.body ?? '',
    tags: overrides.tags ?? [],
    noteIds: overrides.noteIds ?? [],
  }).id;
}

function setEntryCreatedAt(entryId: string, iso: string): void {
  store
    .connection()
    .prepare('UPDATE thread_entries SET created_at = ? WHERE id = ?')
    .run(iso, entryId);
}

function softDeleteNote(noteId: string): void {
  store
    .connection()
    .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
    .run(new Date().toISOString(), noteId);
}

describe('长期事务与动态', () => {
  it('新建事务后可列出，初始没有动态也没有关联手记', () => {
    const id = thread('个人服务器搭建与维护');
    const list = threads.list(false);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      title: '个人服务器搭建与维护',
      status: 'active',
      revision: 1,
      entryCount: 0,
      noteIds: [],
    });
  });

  it('同名标题需要用户确认，确认后允许并存', () => {
    thread('Memocraft 开发');
    expect(() => thread('Memocraft 开发')).toThrow('已经有名为「Memocraft 开发」的事务');
    expect(() => thread('  memocraft 开发  ')).toThrow('已经有名为');
    expect(thread('Memocraft 开发', true)).toBeTruthy();
    expect(threads.list(false)).toHaveLength(2);
  });

  it('归档只影响默认列表，内容仍可读取，也可重新启用', () => {
    const id = thread('旧笔记本改造');
    entry(id, { summary: '刷了 Debian' });
    threads.setArchived(id, true, 1);

    expect(threads.list(false)).toHaveLength(0);
    const archived = threads.list(true);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ id, status: 'archived', revision: 2, entryCount: 1 });
    expect(threads.entries(id, 'newest')).toHaveLength(1);

    threads.setArchived(id, false, 2);
    expect(threads.list(false)[0]).toMatchObject({ status: 'active' });
  });

  it('重复归档是幂等的，不推进版本', () => {
    const id = thread('幂等归档');
    threads.setArchived(id, true, 1);
    const again = threads.setArchived(id, true, 2);
    expect(again.revision).toBe(2);
  });

  it('编辑推进版本，同内容重试视为成功，过期版本冲突', () => {
    const id = thread('服务器运维');
    const edited = threads.update({
      id,
      title: '服务器运维',
      description: '新的说明',
      summary: 'Nginx 已上线',
      expectedRevision: 1,
    });
    expect(edited).toMatchObject({ revision: 2, summary: 'Nginx 已上线' });

    const retried = threads.update({
      id,
      title: '服务器运维',
      description: '新的说明',
      summary: 'Nginx 已上线',
      expectedRevision: 1,
    });
    expect(retried.revision).toBe(2);

    expect(() =>
      threads.update({
        id,
        title: '服务器运维',
        description: '过期',
        summary: '',
        expectedRevision: 1,
      }),
    ).toThrow('这个事务已有更新');
  });

  it('时间线默认最近在前，可切换为最早在前', () => {
    const id = thread('时间线样例');
    const early = entry(id, { occurredAt: '2026-09-01T09:00:00.000Z', summary: '最早' });
    const late = entry(id, { occurredAt: '2026-09-20T09:00:00.000Z', summary: '最近' });

    expect(threads.entries(id, 'newest').map((item) => item.id)).toEqual([late, early]);
    expect(threads.entries(id, 'oldest').map((item) => item.id)).toEqual([early, late]);
  });

  it('同一发生时间按创建时间与 ID 稳定排序', () => {
    const id = thread('同日多条');
    const first = entry(id, { occurredAt: '2026-09-10T10:00:00.000Z', summary: '先创建' });
    const second = entry(id, { occurredAt: '2026-09-10T10:00:00.000Z', summary: '后创建' });
    setEntryCreatedAt(first, '2026-09-10T10:00:01.000Z');
    setEntryCreatedAt(second, '2026-09-10T10:00:02.000Z');

    expect(threads.entries(id, 'newest').map((item) => item.id)).toEqual([second, first]);
    expect(threads.entries(id, 'oldest').map((item) => item.id)).toEqual([first, second]);
  });

  it('补录过去的动态后落在时间线正确位置', () => {
    const id = thread('补录样例');
    const recent = entry(id, { occurredAt: '2026-09-20T09:00:00.000Z', summary: '最近的' });
    const backfilled = entry(id, { occurredAt: '2026-08-01T09:00:00.000Z', summary: '补录的过去' });
    expect(threads.entries(id, 'newest').map((item) => item.id)).toEqual([recent, backfilled]);
  });

  it('动态保存标签，并与手记标签共用同一份标签表', () => {
    const id = thread('标签样例');
    const noteId = note({ tags: ['运维'] }).id;
    const entryId = entry(id, { tags: ['运维', '证书'], summary: '带标签的动态' });

    const saved = threads.entries(id, 'newest')[0];
    expect(saved?.id).toBe(entryId);
    expect(saved?.tags).toEqual(['运维', '证书']);
    const tagRows = store
      .connection()
      .prepare('SELECT count(*) AS total FROM tags WHERE normalized_name = ?')
      .get('运维');
    expect(tagRows?.total).toBe(1);
    expect(noteId).toBeTruthy();
  });

  it('动态引用手记幂等，重复关联不产生重复项', () => {
    const id = thread('引用样例');
    const noteId = note().id;
    const entryId = entry(id, { noteIds: [noteId, noteId], summary: '引用一条手记' });
    expect(threads.entries(id, 'newest')[0]?.noteIds).toEqual([noteId]);
    expect(
      store.connection().prepare('SELECT count(*) AS total FROM entry_notes').get()?.total,
    ).toBe(1);
    expect(entryId).toBeTruthy();
  });

  it('事务级直接引用与动态级引用可以并存', () => {
    const id = thread('双重引用');
    const shared = note().id;
    const other = note().id;
    threads.addNotes(id, [shared, other]);
    entry(id, { noteIds: [shared], summary: '动态也引用同一条' });

    const updated = threads.list(false)[0];
    expect(updated?.noteIds).toEqual(expect.arrayContaining([shared, other]));

    const references = threads.referencesOfNote(shared);
    expect(references).toHaveLength(2);
    expect(references.filter((item) => item.entryId === null)).toHaveLength(1);
    expect(references.filter((item) => item.entryId !== null)).toHaveLength(1);
  });

  it('反查只返回可见引用，且带出所属事务标题', () => {
    const id = thread('反查样例');
    const noteId = note().id;
    const entryId = entry(id, { noteIds: [noteId], summary: '排查证书链' });

    const references = threads.referencesOfNote(noteId);
    expect(references).toEqual([
      {
        threadId: id,
        threadTitle: '反查样例',
        entryId,
        entrySummary: '排查证书链',
      },
    ]);
  });

  it('编辑动态不改写引用手记，编辑手记也不改写动态描述', () => {
    const id = thread('互不改写');
    const target = note({ body: '手记原始正文' });
    const entryId = entry(id, { noteIds: [target.id], summary: '动态原始描述' });

    threads.updateEntry({
      id: entryId,
      occurredAt: '2026-09-11T10:00:00.000Z',
      summary: '动态改写后的描述',
      body: '动态正文',
      tags: [],
      expectedRevision: 1,
    });
    expect(store.load().notes.find((item) => item.id === target.id)?.body).toBe('手记原始正文');

    store.updateNote({
      id: target.id,
      body: '手记改写后的正文',
      title: '',
      category: 'insight',
      tags: [],
      expectedRevision: target.revision,
    });
    expect(threads.entries(id, 'newest')[0]?.summary).toBe('动态改写后的描述');
  });

  it('拒绝引用不存在或已删除的手记，事务级关联同样受限', () => {
    const id = thread('引用校验');
    expect(() => entry(id, { noteIds: [randomUUID()] })).toThrow('不存在或已移入回收站');
    expect(() => threads.addNotes(id, [randomUUID()])).toThrow('不存在或已移入回收站');

    const removed = note();
    softDeleteNote(removed.id);
    expect(() => entry(id, { noteIds: [removed.id] })).toThrow('不存在或已移入回收站');
    expect(threads.list(false)[0]?.noteIds).toEqual([]);
  });

  it('单次关联数量有上限，超出时整体拒绝且不留下半套结果', () => {
    const id = thread('批量关联');
    const noteIds = Array.from({ length: 201 }, () => randomUUID());
    expect(() => threads.addNotes(id, noteIds)).toThrow('一次最多关联 200 条手记');
    expect(() => entry(id, { noteIds })).toThrow('一次最多关联 200 条手记');
    expect(threads.entries(id, 'newest')).toHaveLength(0);
  });

  it('删除事务后动态不可见，恢复后时间线原样回来', () => {
    const id = thread('删除恢复');
    const noteId = note().id;
    const entryId = entry(id, { noteIds: [noteId], summary: '删除前的动态' });

    threads.remove(id);
    expect(threads.list(true)).toHaveLength(0);
    expect(() => threads.entries(id, 'newest')).toThrow('这个事务不存在或已移入回收站');
    expect(threads.referencesOfNote(noteId)).toHaveLength(0);

    store.connection().prepare('UPDATE threads SET deleted_at = NULL WHERE id = ?').run(id);
    const restored = threads.entries(id, 'newest');
    expect(restored.map((item) => item.id)).toEqual([entryId]);
    expect(threads.referencesOfNote(noteId)).toHaveLength(1);
  });

  it('恢复事务不会恢复此前单独删除的动态', () => {
    const id = thread('恢复顺序');
    const kept = entry(id, { summary: '保留的动态' });
    const removed = entry(id, { summary: '单独删除的动态' });
    threads.removeEntry(removed);
    expect(threads.entries(id, 'newest').map((item) => item.id)).toEqual([kept]);

    threads.remove(id);
    store.connection().prepare('UPDATE threads SET deleted_at = NULL WHERE id = ?').run(id);
    // 事务恢复后，之前单独删除的动态仍留在回收站。
    expect(threads.entries(id, 'newest').map((item) => item.id)).toEqual([kept]);
    expect(
      store.connection().prepare('SELECT deleted_at FROM thread_entries WHERE id = ?').get(removed)
        ?.deleted_at,
    ).toBeTruthy();
  });

  it('数据库约束兜底：动态必须属于存在的事务，引用行不能指向不存在的实体', () => {
    const connection = store.connection();
    const id = thread('约束样例');
    const entryId = entry(id, { summary: '约束用动态' });
    const now = new Date().toISOString();
    expect(() =>
      connection
        .prepare(
          `INSERT INTO thread_entries (id, thread_id, occurred_at, summary, body, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', 1, ?, ?)`,
        )
        .run(randomUUID(), randomUUID(), now, '孤儿动态', now, now),
    ).toThrow();
    expect(() =>
      connection
        .prepare('INSERT INTO entry_notes (entry_id, note_id, created_at) VALUES (?, ?, ?)')
        .run(entryId, randomUUID(), now),
    ).toThrow();
    expect(() =>
      connection
        .prepare(
          `INSERT INTO threads (id, title, description, summary, status, revision, created_at, updated_at)
           VALUES (?, '   ', '', '', 'active', 1, ?, ?)`,
        )
        .run(randomUUID(), now, now),
    ).toThrow();
  });
});
