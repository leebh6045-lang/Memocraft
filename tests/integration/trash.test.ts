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
import { TrashStore } from '../../src/storage/trash-store';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
let store: NoteStore;
let topics: TopicStore;
let threads: ThreadStore;
let trash: TrashStore;
let search: SearchStore;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-trash-'));
  store = new NoteStore({
    dataDirectory: join(temporaryDirectory, 'data'),
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = store.connection();
  topics = new TopicStore(connection);
  threads = new ThreadStore(connection);
  search = new SearchStore(connection);
  trash = new TrashStore(connection, store, topics, threads);
});

afterEach(() => {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function note(overrides: Partial<NoteDraft> = {}): Note {
  return store.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '回收站样例',
    ...overrides,
  });
}

function thread(title: string): string {
  return threads.create({ title, description: '', summary: '', confirmDuplicate: false }).id;
}

function entry(threadId: string, summary: string, noteIds: string[] = []): string {
  return threads.addEntry({
    threadId,
    occurredAt: '2026-09-10T10:00:00.000Z',
    summary,
    body: '',
    tags: [],
    noteIds,
  }).id;
}

function kinds(): string[] {
  return trash.list().map((item) => item.kind);
}

describe('回收站', () => {
  it('四类内容删除后都出现在回收站，最近删除的排在前面', () => {
    const noteId = note({ body: '要删除的手记' }).id;
    const topicId = topics.create({
      title: '要删除的归纳',
      description: '',
      confirmDuplicate: false,
    }).id;
    const threadId = thread('要删除的事务');
    const entryId = entry(threadId, '要删除的动态');

    trash.remove('note', noteId);
    trash.remove('topic', topicId);
    trash.remove('entry', entryId);
    trash.remove('thread', threadId);

    const items = trash.list();
    expect(new Set(items.map((item) => item.kind))).toEqual(
      new Set(['note', 'topic', 'thread', 'entry']),
    );
    expect(items.map((item) => item.id)).toContain(noteId);
    expect(items.map((item) => item.id)).toContain(topicId);
    expect(items.map((item) => item.id)).toContain(threadId);
    expect(items.map((item) => item.id)).toContain(entryId);
    for (let index = 1; index < items.length; index += 1) {
      expect(items[index - 1]!.deletedAt >= items[index]!.deletedAt).toBe(true);
    }
  });

  it('列表带出来源上下文：归属归纳、动态数量与所属事务', () => {
    const topicId = topics.create({
      title: '前端开发',
      description: '',
      confirmDuplicate: false,
    }).id;
    const noteId = note({ body: '被收录的手记' }).id;
    topics.addNotes(topicId, [noteId]);
    const threadId = thread('服务器运维');
    entry(threadId, '第一条动态');
    entry(threadId, '第二条动态');

    trash.remove('note', noteId);
    trash.remove('thread', threadId);

    const byKind = new Map(trash.list().map((item) => [item.kind, item]));
    expect(byKind.get('note')?.context).toBe('原属归纳：前端开发');
    expect(byKind.get('thread')?.context).toBe('含 2 条动态');
    expect(byKind.get('thread')?.title).toBe('服务器运维');
  });

  it('删除手记前的影响面列出收录位置与引用位置', () => {
    const topicId = topics.create({
      title: '本地数据库',
      description: '',
      confirmDuplicate: false,
    }).id;
    const threadId = thread('Memocraft 开发');
    const noteId = note({ body: '被多处引用的手记' }).id;
    topics.addNotes(topicId, [noteId]);
    threads.addNotes(threadId, [noteId]);
    const entryId = entry(threadId, '排查证书链', [noteId]);

    const impact = trash.impactOf('note', noteId);
    expect(impact.title).toBe('被多处引用的手记');
    expect(impact.effects.join('\n')).toContain('会从这些归纳里隐藏：本地数据库');
    expect(impact.effects.join('\n')).toContain('Memocraft 开发（事务资料）');
    expect(impact.effects.join('\n')).toContain('Memocraft 开发 · 排查证书链');
    expect(entryId).toBeTruthy();
  });

  it('删除事务前说明动态会一起隐藏，且不会连带恢复此前单独删除的动态', () => {
    const threadId = thread('归档样例');
    entry(threadId, '保留的动态');
    const removed = entry(threadId, '单独删除的动态');
    threads.removeEntry(removed);

    const impact = trash.impactOf('thread', threadId);
    expect(impact.effects.join('\n')).toContain('它的 1 条动态会一起隐藏');
    expect(impact.effects.join('\n')).toContain('此前单独删除的动态仍留在回收站');
  });

  it('恢复手记后回到列表，收录关系与引用都原样保留', () => {
    const topicId = topics.create({ title: '工具链', description: '', confirmDuplicate: false }).id;
    const threadId = thread('恢复引用');
    const noteId = note({ body: '恢复后仍在归纳里' }).id;
    topics.addNotes(topicId, [noteId]);
    threads.addNotes(threadId, [noteId]);

    trash.remove('note', noteId);
    expect(store.load().notes.map((item) => item.id)).not.toContain(noteId);
    expect(search.search('恢复后仍在归纳里').hits).toEqual([]);
    expect(topics.list()[0]?.noteIds).toEqual([]);

    trash.restore('note', noteId);
    expect(store.load().notes.map((item) => item.id)).toContain(noteId);
    expect(topics.list()[0]?.noteIds).toEqual([noteId]);
    expect(threads.list(false)[0]?.noteIds).toEqual([noteId]);
    expect(search.search('恢复后仍在归纳里').hits).toHaveLength(1);
  });

  it('恢复归纳后收录关系原样回来，手记从未受影响', () => {
    const topicId = topics.create({
      title: '服务器运维',
      description: '',
      confirmDuplicate: false,
    }).id;
    const noteId = note({ body: '手记不受影响' }).id;
    topics.addNotes(topicId, [noteId]);

    trash.remove('topic', topicId);
    expect(topics.list()).toHaveLength(0);
    expect(store.load().notes.map((item) => item.id)).toContain(noteId);

    trash.restore('topic', topicId);
    expect(topics.list()[0]?.noteIds).toEqual([noteId]);
  });

  it('恢复事务只恢复事务自身，此前单独删除的动态仍留在回收站', () => {
    const threadId = thread('恢复顺序');
    const kept = entry(threadId, '保留的动态');
    const removed = entry(threadId, '单独删除的动态');
    threads.removeEntry(removed);
    trash.remove('thread', threadId);

    expect(kinds()).toContain('thread');
    expect(trash.list().map((item) => item.id)).toContain(removed);

    trash.restore('thread', threadId);
    expect(threads.entries(threadId, 'newest').map((item) => item.id)).toEqual([kept]);
    // 单独删除的动态没有被一起恢复，仍在回收站里可单独恢复。
    const stillDeleted = trash.list().find((item) => item.id === removed);
    expect(stillDeleted?.kind).toBe('entry');
    trash.restore('entry', removed);
    expect(
      threads
        .entries(threadId, 'newest')
        .map((item) => item.id)
        .sort(),
    ).toEqual([kept, removed].sort());
  });

  it('父事务在回收站时，动态不能单独恢复', () => {
    const threadId = thread('父事务边界');
    const entryId = entry(threadId, '受父事务约束的动态');
    threads.removeEntry(entryId);
    trash.remove('thread', threadId);

    expect(() => trash.restore('entry', entryId)).toThrow('父事务还在回收站，请先恢复它');
    trash.restore('thread', threadId);
    trash.restore('entry', entryId);
    expect(threads.entries(threadId, 'newest').map((item) => item.id)).toEqual([entryId]);
  });

  it('删除归纳不删除手记，删除动态不删除引用手记', () => {
    const topicId = topics.create({
      title: '待删归纳',
      description: '',
      confirmDuplicate: false,
    }).id;
    const threadId = thread('待删事务');
    const noteId = note({ body: '始终存在的手记' }).id;
    topics.addNotes(topicId, [noteId]);
    const entryId = entry(threadId, '待删动态', [noteId]);

    trash.remove('topic', topicId);
    trash.remove('entry', entryId);
    expect(store.load().notes.map((item) => item.id)).toContain(noteId);
    expect(() => trash.impactOf('note', noteId)).not.toThrow();
  });

  it('恢复不在回收站里的内容会被拒绝，不会误改数据', () => {
    const noteId = note().id;
    expect(() => trash.restore('note', noteId)).toThrow('不在回收站里');
    const topicId = topics.create({
      title: '正常归纳',
      description: '',
      confirmDuplicate: false,
    }).id;
    expect(() => trash.restore('topic', topicId)).toThrow('不在回收站里');
    expect(() => trash.restore('note', randomUUID())).toThrow('不存在');
  });

  it('删除后搜索与详情都不再出现，恢复后重新可见', () => {
    const threadId = thread('搜索可见性');
    const entryId = entry(threadId, '可搜索的动态关键词');
    expect(search.search('可搜索的动态关键词').hits).toHaveLength(1);

    trash.remove('entry', entryId);
    expect(search.search('可搜索的动态关键词').hits).toEqual([]);
    trash.restore('entry', entryId);
    expect(search.search('可搜索的动态关键词').hits).toHaveLength(1);
  });
});
