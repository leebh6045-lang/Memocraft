import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import type { NoteSearchResult } from '../../src/domain/note-search';
import { executeStoreRequest, type StoreContext } from '../../src/services/note-service';
import { AI_ASK_CONTEXT_LIMIT, AI_ASK_EXCERPT_LIMIT } from '../../src/shared/ai';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { ExportStore } from '../../src/storage/export-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteSearchStore } from '../../src/storage/note-search-store';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { TagStore } from '../../src/storage/tag-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';
import { TrashStore } from '../../src/storage/trash-store';

let directory: string;
let notes: NoteStore;
let search: NoteSearchStore;
let stores: StoreContext;

/** 每个用例使用隔离的真实 SQLite，包含服务入口与唯一连接的装配。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-note-search-'));
  const dataDirectory = join(directory, 'data');
  const migrationsDirectory = resolve('migrations');
  notes = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = notes.connection();
  const topics = new TopicStore(connection);
  const threads = new ThreadStore(connection);
  search = new NoteSearchStore(connection);
  stores = {
    notes,
    images: new NoteImageStore(connection, dataDirectory),
    topics,
    tags: new TagStore(connection),
    threads,
    search: new SearchStore(connection),
    noteSearch: search,
    trash: new TrashStore(connection, notes, topics, threads),
    exporter: new ExportStore(connection, notes, topics, threads),
    aiSettings: new AiSettingsStore(connection),
    periodSummaries: new PeriodSummaryStore(connection),
    dataDirectory,
    migrationsDirectory,
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  notes.close();
  rmSync(directory, { recursive: true, force: true });
});

function note(overrides: Partial<NoteDraft> = {}, at = '2026-10-01T00:00:00.000Z'): Note {
  const saved = notes.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '普通正文',
    ...overrides,
  });
  notes.connection().prepare('UPDATE notes SET updated_at = ? WHERE id = ?').run(at, saved.id);
  return saved;
}

function retrieve(payload: unknown) {
  return executeStoreRequest(stores, { operation: 'retrieveNotes', payload });
}

function excerpt(terms: string[], body: string): string {
  const saved = note({ body });
  const hit = search.retrieve(terms).hits.find((item) => item.id === saved.id);
  expect(hit).toBeDefined();
  if (!hit) throw new Error('测试手记未命中');
  return hit.excerpt;
}

function contentLength(value: string): number {
  return value.replace(/^…|…$/g, '').length;
}

describe('问答手记专用检索', () => {
  it('空库和空词组返回空结果，不修改原数据库版本', async () => {
    expect(search.retrieve(['没有的关键词'])).toEqual({ hits: [], total: 0 });
    expect(await retrieve({ terms: [] })).toEqual({ hits: [], total: 0 });
    expect(notes.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    );
  });

  it('标题 3、标签 2、正文 1，字段权重相加且同字段多次命中不重复加权', () => {
    const body = note({ body: 'ref ref ref', category: 'todo' }, '2026-10-05T00:00:00.000Z');
    const tags = note({ tags: ['ref', 'ref使用'] }, '2026-10-04T00:00:00.000Z');
    const title = note({ title: 'ref知识' }, '2026-10-03T00:00:00.000Z');
    const all = note({ title: 'ref', tags: ['ref'], body: 'ref原理', category: 'done' });
    const result = search.retrieve(['REF']);
    expect(result.total).toBe(4);
    expect(result.hits.map((hit) => hit.id)).toEqual([all.id, title.id, tags.id, body.id]);
    expect(result.hits[0]).toMatchObject({ category: 'done', matchedTerms: 1, title: 'ref' });
    expect(result.hits[3]).toMatchObject({ category: 'todo', title: 'ref ref ref' });
  });

  it('不同词的命中数先于加权分，分数相同再按更新时间与 ID 倒序', () => {
    const one = note({ title: 'ref', tags: ['ref'], body: 'ref' });
    const two = note({ body: 'ref reactive' }, '2026-09-01T00:00:00.000Z');
    const three = note({ body: 'ref reactive computed' }, '2026-08-01T00:00:00.000Z');
    const sameOld = note({ body: 'ref reactive' }, '2026-08-01T00:00:00.000Z');
    const tieA = note({ id: '00000000-0000-4000-8000-000000000001', body: 'ref reactive' });
    const tieB = note({ id: '00000000-0000-4000-8000-000000000002', body: 'ref reactive' });
    expect(search.retrieve(['ref', 'reactive', 'computed']).hits.map((hit) => hit.id)).toEqual([
      three.id,
      tieB.id,
      tieA.id,
      two.id,
      sameOld.id,
      one.id,
    ]);
    expect(
      search.retrieve(['ref', 'reactive', 'computed']).hits.map((hit) => hit.matchedTerms),
    ).toEqual([3, 2, 2, 2, 2, 1]);
  });

  it('草稿、回收站、归纳、事务和动态不参与；恢复手记后重新可见', () => {
    const saved = note({ body: '唯一关键词可见' });
    const removed = note({ body: '唯一关键词已删除', tags: ['唯一关键词'] });
    notes.remove(removed.id);
    stores.topics.create({
      title: '唯一关键词归纳',
      description: '唯一关键词',
      confirmDuplicate: false,
    });
    const thread = stores.threads.create({
      title: '唯一关键词事务',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    stores.threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-10-01T00:00:00.000Z',
      summary: '唯一关键词动态',
      body: '唯一关键词',
      tags: ['唯一关键词'],
      noteIds: [],
    });
    notes.saveDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '唯一关键词草稿',
      tags: ['唯一关键词'],
    });
    expect(search.retrieve(['唯一关键词'])).toMatchObject({ hits: [{ id: saved.id }], total: 1 });
    notes.connection().prepare('UPDATE notes SET deleted_at = NULL WHERE id = ?').run(removed.id);
    expect(search.retrieve(['唯一关键词']).total).toBe(2);
    expect(notes.load().draft?.body).toBe('唯一关键词草稿');
  });

  it('LIKE 的百分号、下划线与反斜线都按原文字匹配，英文不区分大小写', () => {
    const exact = note({ body: '100% foo_bar C:\\Temp REF' });
    note({ body: '100000 fooXbar C:/temp' });
    for (const term of ['%', '_', '\\', '100%', 'foo_bar', 'C:\\temp', 'ref']) {
      expect(search.retrieve([term]).hits.map((hit) => hit.id)).toEqual([exact.id]);
    }
    expect(search.retrieve(['fooXbar']).hits.map((hit) => hit.id)).not.toContain(exact.id);
  });

  it('最多返回 8 条，total 统计超过每词候选限制的完整并集', () => {
    for (let index = 0; index < 35; index += 1) note({ title: 'alpha' });
    for (let index = 0; index < 35; index += 1) note({ title: 'beta' });
    for (let index = 0; index < 5; index += 1)
      note({ title: 'alpha beta' }, '2026-10-02T00:00:00.000Z');
    const removed = note({ title: 'alpha beta' });
    notes.remove(removed.id);
    const result = search.retrieve(['alpha', 'beta']);
    expect(result.hits).toHaveLength(AI_ASK_CONTEXT_LIMIT);
    expect(result.total).toBe(75);
    expect(result.hits.filter((hit) => hit.matchedTerms === 2)).toHaveLength(5);
  });

  it('每词只纳入权重最高的前 20 个候选，未入选手记仍计入总数', () => {
    for (let index = 0; index < 20; index += 1) note({ title: 'alpha' });
    for (let index = 0; index < 20; index += 1) note({ title: 'beta' });
    const belowCandidateLimit = note({ body: 'alpha beta' });
    const result = search.retrieve(['alpha', 'beta']);
    expect(result.total).toBe(41);
    expect(result.hits.map((hit) => hit.id)).not.toContain(belowCandidateLimit.id);
    expect(result.hits.every((hit) => hit.matchedTerms === 1)).toBe(true);
  });

  it('只读检索不写入正文、关系或问答结果', async () => {
    note({ body: 'SQLite 事务', tags: ['SQLite'] });
    const before = notes.connection().prepare('SELECT total_changes() AS count').get()?.count;
    const snapshot = notes.load();
    await retrieve({ terms: ['SQLite', '事务'] });
    expect(notes.connection().prepare('SELECT total_changes() AS count').get()?.count).toBe(before);
    expect(notes.load()).toEqual(snapshot);
  });
});

describe('命中窗口摘录', () => {
  it('长正文取命中处上下文，而不是只取开头；省略号不计入 300 字正文预算', () => {
    const text = `${'甲'.repeat(500)}响应式原理${'乙'.repeat(500)}`;
    const value = excerpt(['响应式'], text);
    expect(value).toContain('响应式原理');
    expect(value).toMatch(/^…/);
    expect(value).toMatch(/…$/);
    expect(contentLength(value)).toBe(AI_ASK_EXCERPT_LIMIT);
    expect(value).toContain('甲');
    expect(value).toContain('乙');
  });

  it('优先覆盖最多不同词，单词重复再多也不能压过多词窗口', () => {
    const value = excerpt(
      ['alpha', 'beta', 'gamma'],
      `${'alpha '.repeat(70)}${'甲'.repeat(500)}alpha beta gamma${'乙'.repeat(500)}`,
    );
    expect(value).toContain('alpha beta gamma');
    expect(value).not.toContain('alpha alpha alpha');
    expect(contentLength(value)).toBe(AI_ASK_EXCERPT_LIMIT);
  });

  it('覆盖词数相同取最短跨度，不能依赖第一处命中', () => {
    const value = excerpt(
      ['alpha', 'beta'],
      `${'甲'.repeat(400)}alpha${'宽'.repeat(260)}beta${'乙'.repeat(500)}alpha beta${'丙'.repeat(500)}`,
    );
    expect(value).toContain('alpha beta');
    expect(value).not.toContain('宽');
    expect(contentLength(value)).toBe(AI_ASK_EXCERPT_LIMIT);
  });

  it('超出 300 字跨度时取可容纳最多词的窗口，允许重叠词命中', () => {
    const value = excerpt(
      ['响应', '应式', '原理'],
      `${'甲'.repeat(500)}响应式${'隔'.repeat(400)}原理${'乙'.repeat(500)}`,
    );
    expect(value).toContain('响应式');
    expect(value).not.toContain('原理');
    expect(contentLength(value)).toBe(AI_ASK_EXCERPT_LIMIT);
  });

  it('恰好 300 字的多词跨度完整保留，超出一字时不把残缺命中当作覆盖', () => {
    const fullWindow = `alpha${'间'.repeat(291)}beta`;
    const full = excerpt(['alpha', 'beta'], `${'前'.repeat(400)}${fullWindow}${'后'.repeat(400)}`);
    expect(full).toBe(`…${fullWindow}…`);
    const tooWide = excerpt(
      ['gamma', 'delta'],
      `${'前'.repeat(400)}gamma${'间'.repeat(291)}delta${'后'.repeat(400)}`,
    );
    expect(contentLength(tooWide)).toBe(AI_ASK_EXCERPT_LIMIT);
    expect(tooWide).toContain('gamma');
    expect(tooWide).not.toContain('delta');
  });

  it('标题或标签命中但正文无命中时退回正文开头，折叠空白不改变持久化原文', () => {
    const body = `  开头\n\n${'文'.repeat(400)}  `;
    const saved = note({ title: '标题关键词', tags: ['标签关键词'], body });
    const first = search.retrieve(['标题关键词']).hits[0];
    const second = search.retrieve(['标签关键词']).hits[0];
    const expected = `开头 ${'文'.repeat(297)}…`;
    expect(first?.excerpt).toBe(expected);
    expect(second?.excerpt).toBe(expected);
    expect(notes.load().notes.find((item) => item.id === saved.id)?.body).toBe(body);
  });

  it('正文短于预算时不添加省略号；SQLite 的 ASCII 大小写匹配对应正确窗口', () => {
    expect(excerpt(['REF'], '  使用 ref\n与 reactive  ')).toBe('使用 ref 与 reactive');
  });

  it('标题保留恰好 300 字符，不向模型转交额外字段', () => {
    const title = '题'.repeat(300);
    note({ title, body: '内容', tags: ['标题边界'] });
    const hit = search.retrieve(['标题边界']).hits[0];
    expect(hit?.title).toBe(title);
    expect(Object.keys(hit ?? {}).sort()).toEqual(
      ['id', 'title', 'category', 'excerpt', 'matchedTerms', 'updatedAt'].sort(),
    );
  });
});

describe('跨线程检索词边界', () => {
  it('服务入口 trim 并去重，保留顺序且重复词不增加 matchedTerms', async () => {
    note({ body: 'ref reactive' });
    const result = (await retrieve({ terms: [' ref ', 'ref', 'reactive'] })) as NoteSearchResult;
    expect(result.hits[0]?.matchedTerms).toBe(2);
  });

  it.each([
    null,
    [],
    'ref',
    {},
    { terms: null },
    { terms: 'ref' },
    { terms: [1] },
    { terms: [''] },
    { terms: ['  '] },
    { terms: ['x'.repeat(201)] },
    { terms: [` ${'x'.repeat(199)} `] },
    { terms: Array(9).fill('ref') },
  ])('非法载荷 %j 在进入检索前被拒绝，不静默截断', async (payload) => {
    const retrieval = vi.spyOn(search, 'retrieve');
    await expect(retrieve(payload)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(retrieval).not.toHaveBeenCalled();
  });

  it('接受恰好 8 个关键词与恰好 200 字符的词', async () => {
    const term = '字'.repeat(200);
    note({ body: term });
    expect(await retrieve({ terms: [term] })).toMatchObject({ total: 1 });
    expect(await retrieve({ terms: ['1', '2', '3', '4', '5', '6', '7', '8'] })).toMatchObject({
      total: 0,
    });
  });
});
