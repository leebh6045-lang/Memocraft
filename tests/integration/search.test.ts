import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
let store: NoteStore;
let search: SearchStore;
let topics: TopicStore;
let threads: ThreadStore;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-search-'));
  store = new NoteStore({
    dataDirectory: join(temporaryDirectory, 'data'),
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = store.connection();
  search = new SearchStore(connection);
  topics = new TopicStore(connection);
  threads = new ThreadStore(connection);
});

afterEach(() => {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function note(overrides: Partial<NoteDraft> = {}): Note {
  return store.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '样例正文',
    ...overrides,
  });
}

function kindsOf(query: string): string[] {
  return search.search(query).hits.map((hit) => hit.kind);
}

function idsOf(query: string, kind: string): string[] {
  return search
    .search(query)
    .hits.filter((hit) => hit.kind === kind)
    .map((hit) => hit.id);
}

function softDelete(table: 'notes' | 'topics' | 'threads' | 'thread_entries', id: string): void {
  store
    .connection()
    .prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

describe('全对象搜索', () => {
  it('手记按标题、正文与标签命中，中英文大小写与普通符号按子串处理', () => {
    const target = note({
      body: '证书 TLS 100% foo_bar C:\\temp 🙂',
      title: '唯一标题',
      tags: ['标签命中'],
    });
    note({ body: '100000 fooXbar C:/temp' });
    for (const query of ['证书', 'tls', 'TLS', '%', '_', '\\', '🙂', '唯一标题', '标签命中']) {
      expect(idsOf(query, 'note')).toEqual([target.id]);
    }
    expect(search.search('fooXbar').hits.every((hit) => hit.id !== target.id)).toBe(true);
  });

  it('标签比较不区分英文字母大小写，标签原文保持用户输入', () => {
    note({ tags: ['SQLite'] });
    note({ tags: ['sqlite'] });
    expect(idsOf('SQLITE', 'note')).toHaveLength(2);
    expect(
      store
        .load()
        .notes.flatMap((item) => item.tags)
        .sort(),
    ).toEqual(['SQLite', 'sqlite']);
  });

  it('归纳按标题与说明命中', () => {
    const hit = topics.create({
      title: '本地数据库',
      description: 'SQLite 的事务与备份',
      confirmDuplicate: false,
    });
    expect(idsOf('本地数据库', 'topic')).toEqual([hit.id]);
    expect(idsOf('事务与备份', 'topic')).toEqual([hit.id]);
    expect(search.search('本地数据库').hits[0]).toMatchObject({
      kind: 'topic',
      title: '本地数据库',
      excerpt: expect.stringContaining('SQLite'),
    });
  });

  it('事务按标题、说明与当前概况命中，已归档事务照常可检索', () => {
    const hit = threads.create({
      title: '个人服务器',
      description: '一台 VPS 上的 Nginx',
      summary: 'Ubuntu 24.04，证书自动续期',
      confirmDuplicate: false,
    });
    expect(idsOf('个人服务器', 'thread')).toEqual([hit.id]);
    expect(idsOf('VPS', 'thread')).toEqual([hit.id]);
    expect(idsOf('自动续期', 'thread')).toEqual([hit.id]);
    threads.setArchived(hit.id, true, 1);
    expect(idsOf('自动续期', 'thread')).toEqual([hit.id]);
    expect(search.search('个人服务器').hits[0]).toMatchObject({ context: '已归档' });
  });

  it('动态按描述、正文与标签命中，并带出所属事务', () => {
    const thread = threads.create({
      title: 'Memocraft 开发',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    const entry = threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '排查证书链',
      body: '原因是只配了 cert.pem',
      tags: ['运维'],
      noteIds: [],
    });
    for (const query of ['排查证书链', 'cert.pem', '运维']) {
      const hit = search.search(query).hits.find((item) => item.kind === 'entry');
      expect(hit).toMatchObject({
        id: entry.id,
        threadId: thread.id,
        threadTitle: 'Memocraft 开发',
        context: 'Memocraft 开发',
      });
    }
  });

  it('草稿、回收站内容与被删除事务下的动态都不参与搜索', () => {
    const saved = note({ body: '可见的手记关键词' });
    const removedNote = note({ body: '回收站里的关键词' });
    softDelete('notes', removedNote.id);

    const topic = topics.create({
      title: '回收站里的归纳',
      description: '',
      confirmDuplicate: false,
    });
    softDelete('topics', topic.id);

    const thread = threads.create({
      title: '被删除的事务',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    const entry = threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '删除事务下的动态关键词',
      body: '',
      tags: [],
      noteIds: [],
    });
    threads.remove(thread.id);

    // 草稿槽位固定为 1：先把要提交的手记都建好，最后再写入草稿。
    store.saveDraft(draftWith('草稿里的关键词'));

    expect(idsOf('可见的手记关键词', 'note')).toEqual([saved.id]);
    expect(search.search('草稿里的关键词').hits).toEqual([]);
    expect(search.search('回收站里的关键词').hits).toEqual([]);
    expect(search.search('删除事务下的动态关键词').hits).toEqual([]);
    expect(search.search('被删除的事务').hits).toEqual([]);
    expect(
      store
        .connection()
        .prepare('SELECT 1 AS found FROM thread_entries WHERE id = ?')
        .get(entry.id),
    ).toBeDefined();
  });

  it('动态自身被软删除后不参与，恢复后重新出现', () => {
    const thread = threads.create({
      title: '恢复样例',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    const entry = threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '可恢复的动态',
      body: '',
      tags: [],
      noteIds: [],
    });
    threads.removeEntry(entry.id);
    expect(search.search('可恢复的动态').hits).toEqual([]);
    store
      .connection()
      .prepare('UPDATE thread_entries SET deleted_at = NULL WHERE id = ?')
      .run(entry.id);
    expect(idsOf('可恢复的动态', 'entry')).toEqual([entry.id]);
  });

  it('空查询给出每类最近更新内容，分组类型齐全且不含草稿与回收站', () => {
    const oldNote = note({ body: '较早的手记' });
    const newNote = note({ body: '较新的手记' });
    store
      .connection()
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run('2026-09-01T00:00:00.000Z', oldNote.id);
    store
      .connection()
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run('2026-09-20T00:00:00.000Z', newNote.id);
    topics.create({ title: '归纳样例', description: '', confirmDuplicate: false });
    const thread = threads.create({
      title: '事务样例',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '动态样例',
      body: '',
      tags: [],
      noteIds: [],
    });
    const removed = note({ body: '被删除的手记' });
    softDelete('notes', removed.id);
    store.saveDraft(draftWith('尚未提交的草稿'));

    for (const query of ['', '  \t\n  ']) {
      const result = search.search(query);
      expect(result.hasMore).toBe(false);
      expect(new Set(result.hits.map((hit) => hit.kind))).toEqual(
        new Set(['note', 'topic', 'thread', 'entry']),
      );
      expect(idsOf(query, 'note')).toEqual([newNote.id, oldNote.id]);
      expect(idsOf(query, 'note')).not.toContain(removed.id);
    }
  });

  it('结果按每类上限与总数上限截断，并明确还有更多', () => {
    for (let index = 0; index < 25; index += 1) note({ body: `共同关键词 ${index}` });
    const many = search.search('共同关键词');
    expect(many.hits.filter((hit) => hit.kind === 'note')).toHaveLength(20);
    expect(many.hasMore).toBe(true);

    for (let index = 0; index < 25; index += 1)
      threads.create({
        title: `共同关键词事务 ${index}`,
        description: '',
        summary: '',
        confirmDuplicate: true,
      });
    for (let index = 0; index < 25; index += 1)
      topics.create({ title: `共同关键词归纳 ${index}`, description: '', confirmDuplicate: true });
    const capped = search.search('共同关键词');
    expect(capped.hits).toHaveLength(50);
    expect(capped.hasMore).toBe(true);
  });

  it('命中上下文取自命中位置，无标题手记用首行作为主行文字', () => {
    note({ body: '第一行摘要\n第二行里包含 关键词甲', title: '' });
    const hit = search.search('第一行摘要').hits[0];
    expect(hit).toMatchObject({ kind: 'note', title: '第一行摘要', context: '收获' });
    const bodyHit = search.search('关键词甲').hits[0];
    expect(bodyHit?.excerpt).toContain('关键词甲');
    expect(bodyHit?.title).toBe('第一行摘要');
  });

  it('事务与动态的归属关系在结果里保持可追溯', () => {
    const thread = threads.create({
      title: '归属样例',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '归属动态',
      body: '',
      tags: [],
      noteIds: [],
    });
    expect(kindsOf('归属')).toEqual(['thread', 'entry']);
    const entryHit = search.search('归属动态').hits.find((hit) => hit.kind === 'entry');
    expect(entryHit?.threadId).toBe(thread.id);
    expect(entryHit?.threadTitle).toBe('归属样例');
  });
});

/** 草稿只用于验证「不参与搜索」，这里单独构造以免与正式手记混淆。 */
function draftWith(body: string): NoteDraft {
  return { ...emptyDraft(randomUUID()), revision: 1, body };
}
