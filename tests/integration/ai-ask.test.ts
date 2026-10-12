import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft } from '../../src/domain/note';
import { noteOwner } from '../../src/domain/note-image';
import { AiAskService } from '../../src/main/ai-ask-service';
import { executeStoreRequest, type StoreContext } from '../../src/services/note-service';
import type { DeepSeekClient } from '../../src/services/deepseek-client';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { AppError, failure, type Result } from '../../src/shared/errors';
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
import { PNG_2X3 } from '../fixtures/images';

let directory: string;
let stores: StoreContext;
let service: AiAskService | null;

/** 真实SQLite和生产分发保持不变，只有供应商调用与已解密凭据使用测试替身。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-ai-ask-'));
  const dataDirectory = join(directory, 'data');
  const migrationsDirectory = resolve('migrations');
  const notes = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = notes.connection();
  const topics = new TopicStore(connection);
  const threads = new ThreadStore(connection);
  stores = {
    notes,
    topics,
    threads,
    images: new NoteImageStore(connection, dataDirectory),
    tags: new TagStore(connection),
    search: new SearchStore(connection),
    noteSearch: new NoteSearchStore(connection),
    trash: new TrashStore(connection, notes, topics, threads),
    exporter: new ExportStore(connection, notes, topics, threads),
    aiSettings: new AiSettingsStore(connection),
    periodSummaries: new PeriodSummaryStore(connection),
    dataDirectory,
    migrationsDirectory,
  };
  service = null;
});
afterEach(async () => {
  await service?.stopAndDrain();
  stores.notes.close();
  rmSync(directory, { recursive: true, force: true });
});
async function request(query: StoreRequest): Promise<Result<StoreValue>> {
  try {
    return { ok: true, value: await executeStoreRequest(stores, query) };
  } catch (error) {
    return failure(error);
  }
}
function createService(complete: DeepSeekClient['complete']) {
  service = new AiAskService({
    request,
    resolveCallContext: async () => ({
      ...stores.aiSettings.load(),
      apiKey: 'integration-test-ask-key',
    }),
    client: { complete },
  });
  return service;
}
function addNote(body: string, title = '', tags: string[] = []) {
  return stores.notes.commitDraft({ ...emptyDraft(randomUUID()), revision: 1, body, title, tags });
}
/** 观察所有表与写入计数，问答先写后删也会被识别为违反只读边界。 */
function databaseSnapshot() {
  const database = stores.notes.connection();
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return {
    schemaVersion: database.prepare('PRAGMA user_version').get(),
    changes: database.prepare('SELECT total_changes() AS count').get(),
    tables: tables.map((table) => {
      if (typeof table.name !== 'string' || !/^[a-z_]+$/.test(table.name))
        throw new Error('测试数据库包含未知表名');
      return {
        name: table.name,
        rows: database.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all(),
      };
    }),
  };
}

describe('搜索问答真实SQLite集成', () => {
  it('自然问题多词召回后来源指向真实手记，只发送摘录且不写库', async () => {
    const first = addNote(
      '前文'.repeat(300) +
        ' ref 使用 value 访问；reactive 包装对象。 ' +
        '后文'.repeat(300) +
        'PRIVATE_TAIL_DO_NOT_SEND',
      'Vue 响应式区别',
      ['Vue'],
    );
    const second = addNote(
      'reactive 的对象属性可以直接读写，ref 则通过 value 访问。',
      '响应式实践',
    );
    const privateNote = addNote('PRIVATE_UNRELATED_NOTE_DO_NOT_SEND', '私人日记');
    const removed = addNote('DELETED_REF_DO_NOT_SEND ref reactive 区别', '已删除知识');
    stores.notes.remove(removed.id);
    stores.notes.saveDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: 'DRAFT_REF_DO_NOT_SEND ref reactive 区别',
    });
    stores.topics.create({
      title: 'ref reactive 区别',
      description: 'TOPIC_PRIVATE_DO_NOT_SEND',
      confirmDuplicate: false,
    });
    stores.images.add(noteOwner(first.id), [
      { bytes: PNG_2X3, originalName: 'PRIVATE_IMAGE_NAME_DO_NOT_SEND.png' },
    ]);
    const before = databaseSnapshot();
    let captured: Parameters<DeepSeekClient['complete']>[0] | undefined;
    const answer = await createService(async (call) => {
      captured = call;
      return JSON.stringify({
        answer: 'ref 通过 value 访问，reactive 包装对象并直接访问属性。',
        sources: [2, 1, 99, 1],
        titles: ['模型编造标题'],
      });
    }).ask({ requestId: randomUUID(), question: 'ref 和 reactive 有什么区别' });
    expect(answer.matchedNotes).toBe(2);
    expect(answer.sources.map((source) => source.noteId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    for (const source of answer.sources)
      expect(source.title).toBe(source.noteId === first.id ? first.title : second.title);
    expect(answer.sources.some((source) => source.noteId === privateNote.id)).toBe(false);
    const prompt = captured?.messages.map((message) => message.content).join('\n') ?? '';
    expect(prompt).toContain('ref 使用 value');
    expect(prompt).toContain('收获');
    for (const forbidden of [
      'PRIVATE_TAIL_DO_NOT_SEND',
      'PRIVATE_UNRELATED_NOTE_DO_NOT_SEND',
      'DELETED_REF_DO_NOT_SEND',
      'DRAFT_REF_DO_NOT_SEND',
      'TOPIC_PRIVATE_DO_NOT_SEND',
      'PRIVATE_IMAGE_NAME_DO_NOT_SEND',
      first.id,
      second.id,
      'data:image',
      directory,
    ])
      expect(prompt).not.toContain(forbidden);
    expect(captured?.messages.every((message) => typeof message.content === 'string')).toBe(true);
    expect(databaseSnapshot()).toEqual(before);
  });
  it('空库和库中只有不相关手记时不调用模型、不写库', async () => {
    const complete = vi.fn<DeepSeekClient['complete']>(
      async () => '{"answer":"不应调用","sources":[]}',
    );
    const ai = createService(complete);
    const emptyBefore = databaseSnapshot();
    await expect(ai.ask({ requestId: randomUUID(), question: 'SQLite 事务隔离' })).resolves.toEqual(
      { answer: '', sources: [], matchedNotes: 0 },
    );
    expect(databaseSnapshot()).toEqual(emptyBefore);
    addNote('今天阳光很好，午后散步。');
    const before = databaseSnapshot();
    await expect(ai.ask({ requestId: randomUUID(), question: 'SQLite 事务隔离' })).resolves.toEqual(
      { answer: '', sources: [], matchedNotes: 0 },
    );
    expect(databaseSnapshot()).toEqual(before);
    expect(complete).not.toHaveBeenCalled();
  });
  it('归纳、事务、动态、草稿和回收站都不能成为问答依据', async () => {
    const keyword = '专属证书';
    stores.topics.create({ title: keyword, description: keyword, confirmDuplicate: false });
    const thread = stores.threads.create({
      title: keyword,
      description: keyword,
      summary: keyword,
      confirmDuplicate: false,
    });
    stores.threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-10-10T10:00:00.000Z',
      summary: keyword,
      body: keyword,
      tags: [],
      noteIds: [],
    });
    const deleted = addNote(keyword);
    stores.notes.remove(deleted.id);
    stores.notes.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: keyword });
    const complete = vi.fn<DeepSeekClient['complete']>(
      async () => '{"answer":"不应调用","sources":[]}',
    );
    const before = databaseSnapshot();
    await expect(
      createService(complete).ask({ requestId: randomUUID(), question: keyword }),
    ).resolves.toEqual({ answer: '', sources: [], matchedNotes: 0 });
    expect(complete).not.toHaveBeenCalled();
    expect(databaseSnapshot()).toEqual(before);
    expect(stores.search.search(keyword).hits.length).toBeGreaterThan(0);
  });
  it('标签命中且无标题时回填正文标题，正文未命中时退回开头', async () => {
    const note = addNote('第一行是来源标题\n其余正文只有实践说明。', '', ['SQLite']);
    let prompt = '';
    const answer = await createService(async (call) => {
      prompt = call.messages.map((message) => message.content).join('\n');
      return '{"answer":"记录中保存了实践说明。","sources":[1]}';
    }).ask({ requestId: randomUUID(), question: 'SQLite' });
    expect(answer.sources).toEqual([{ index: 1, noteId: note.id, title: '第一行是来源标题' }]);
    expect(prompt).toContain('其余正文只有实践说明');
  });
  it('格式错误、网络失败和取消都不写入数据库，后续可重新提问', async () => {
    addNote('SQLite 事务提交成功后数据可读。', 'SQLite');
    const before = databaseSnapshot();
    const complete = vi.fn<DeepSeekClient['complete']>(async () => 'invalid json');
    const ai = createService(complete);
    await expect(ai.ask({ requestId: randomUUID(), question: 'SQLite' })).rejects.toMatchObject({
      code: 'AI_RESPONSE',
    });
    expect(databaseSnapshot()).toEqual(before);
    complete.mockRejectedValueOnce(new AppError('AI_NETWORK', '网络暂不可用'));
    await expect(ai.ask({ requestId: randomUUID(), question: 'SQLite' })).rejects.toMatchObject({
      code: 'AI_NETWORK',
    });
    expect(databaseSnapshot()).toEqual(before);
    complete.mockImplementationOnce(
      (call) =>
        new Promise((_resolve, reject) =>
          call.signal?.addEventListener(
            'abort',
            () => reject(new AppError('AI_CANCELLED', '已取消')),
            { once: true },
          ),
        ),
    );
    const requestId = randomUUID();
    const flight = ai.ask({ requestId, question: 'SQLite' });
    const rejected = expect(flight).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3));
    await ai.cancel(requestId);
    await rejected;
    expect(databaseSnapshot()).toEqual(before);
    complete.mockResolvedValueOnce('{"answer":"事务提交后可读。","sources":[1]}');
    await expect(ai.ask({ requestId: randomUUID(), question: 'SQLite' })).resolves.toHaveProperty(
      'sources',
    );
    expect(databaseSnapshot()).toEqual(before);
  });
  it('当前版本现有库重开时不改写内容、关系和模型配置', async () => {
    const note = addNote('SQLite 关系和事务。', '现有知识');
    const topic = stores.topics.create({
      title: '现有归纳',
      description: '关系保留',
      confirmDuplicate: false,
    });
    stores.topics.addNotes(topic.id, [note.id]);
    stores.aiSettings.saveModel('deepseek-v4-pro');
    await executeStoreRequest(stores, {
      operation: 'saveAiBaseUrl',
      payload: ' https://ask-gateway.example.test/v1/chat/completions/ ',
    });
    const before = databaseSnapshot();
    await createService(async (call) => {
      expect(call.model).toBe('deepseek-v4-pro');
      expect(call.baseUrl).toBe('https://ask-gateway.example.test/v1');
      return '{"answer":"记录涉及关系和事务。","sources":[1]}';
    }).ask({ requestId: randomUUID(), question: 'SQLite' });
    expect(databaseSnapshot()).toEqual(before);
    await service?.stopAndDrain();
    stores.notes.close();
    stores.notes = new NoteStore({
      dataDirectory: stores.dataDirectory,
      migrationsDirectory: stores.migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    expect(stores.notes.load().notes[0]?.id).toBe(note.id);
    expect(new TopicStore(stores.notes.connection()).list()[0]?.noteIds).toEqual([note.id]);
    expect(new AiSettingsStore(stores.notes.connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://ask-gateway.example.test/v1',
    });
    expect(stores.notes.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    );
  });
});
