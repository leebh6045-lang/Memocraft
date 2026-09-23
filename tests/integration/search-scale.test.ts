import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';

const migrationsDirectory = resolve('migrations');
/** 与「重新评估条件」对齐的规模：远大于个人日常积累量，用来判断是否需要引入索引。 */
const NOTE_COUNT = 2000;
const TOPIC_COUNT = 200;
const THREAD_COUNT = 100;
const ENTRY_COUNT = 3000;
/** 宽松上限：只拦截数量级退化（例如误改成逐行查询），不约束具体毫秒数。 */
const TIME_BUDGET_MS = 400;

let temporaryDirectory: string;
let store: NoteStore;
let search: SearchStore;

function now(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, offsetSeconds % 3600)).toISOString();
}

/** 用真实 SQLite 灌入真实规模的数据，只测查询本身，不经过界面。 */
beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-search-scale-'));
  store = new NoteStore({
    dataDirectory: join(temporaryDirectory, 'data'),
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = store.connection();
  connection.exec('BEGIN');
  const insertNote = connection.prepare(
    `INSERT INTO notes (id, body, title, category, revision, created_at, updated_at)
     VALUES (?, ?, '', 'insight', 1, ?, ?)`,
  );
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    const at = now(index);
    const body =
      index % 250 === 0
        ? `第 ${index} 条手记提到 罕见关键词 与 SQLite 事务`
        : `第 ${index} 条手记的正文内容，包含若干日常记录文字与代码片段 SELECT ${index};`;
    insertNote.run(randomUUID(), body, at, at);
  }
  const insertTopic = connection.prepare(
    `INSERT INTO topics (id, title, description, revision, created_at, updated_at)
     VALUES (?, ?, '记录说明文字', 1, ?, ?)`,
  );
  for (let index = 0; index < TOPIC_COUNT; index += 1) {
    const at = now(index);
    insertTopic.run(randomUUID(), `归纳 ${index}`, at, at);
  }
  const insertThread = connection.prepare(
    `INSERT INTO threads (id, title, description, summary, status, revision, created_at, updated_at)
     VALUES (?, ?, '', '记录概况文字', 'active', 1, ?, ?)`,
  );
  const threadIds: string[] = [];
  for (let index = 0; index < THREAD_COUNT; index += 1) {
    const id = randomUUID();
    threadIds.push(id);
    const at = now(index);
    insertThread.run(id, `事务 ${index}`, at, at);
  }
  const insertEntry = connection.prepare(
    `INSERT INTO thread_entries (id, thread_id, occurred_at, summary, body, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, '记录动态正文', 1, ?, ?)`,
  );
  for (let index = 0; index < ENTRY_COUNT; index += 1) {
    const at = now(index);
    const threadId = threadIds[index % threadIds.length];
    if (!threadId) throw new Error('缺少测试事务');
    insertEntry.run(randomUUID(), threadId, at, `动态 ${index}`, at, at);
  }
  connection.exec('COMMIT');
  search = new SearchStore(connection);
});

afterEach(() => {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function measure(label: string, query: string): { ms: number; hits: number } {
  const started = performance.now();
  const result = search.search(query);
  const ms = performance.now() - started;
  console.log(`[搜索测量] ${label}：${ms.toFixed(1)} ms，命中 ${result.hits.length} 条`);
  return { ms, hits: result.hits.length };
}

describe('真实数据量下的搜索耗时', () => {
  it('罕见词、常见词与空查询都在预算内，当前规模不需要全文索引', () => {
    // 先跑一次热身，避免首次语句准备被算进结果。
    search.search('热身');

    const rare = measure('罕见关键词（约 8 条命中）', '罕见关键词');
    const common = measure('跨四类常见词（触发总数截断）', '记录');
    const specific = measure('指定类型常见词', '动态 2');
    const recent = measure('空查询（每类最近 5 条）', '');

    expect(rare.hits).toBeGreaterThan(0);
    expect(rare.hits).toBeLessThanOrEqual(20);
    expect(common.hits).toBe(50);
    expect(specific.hits).toBeGreaterThan(0);
    expect(recent.hits).toBe(20);

    for (const result of [rare, common, specific, recent]) {
      expect(result.ms).toBeLessThan(TIME_BUDGET_MS);
    }
  });
});
