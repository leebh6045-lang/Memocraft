import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG_2X3 } from '../fixtures/images';
import { draftOwner, noteOwner } from '../../src/domain/note-image';
import { emptyDraft } from '../../src/domain/note';
import { AiImageReader } from '../../src/main/ai-image-reader';
import { AiSuggestionService } from '../../src/main/ai-suggestion-service';
import { executeStoreRequest, type StoreContext } from '../../src/services/note-service';
import type { DeepSeekClient } from '../../src/services/deepseek-client';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { DEFAULT_AI_BASE_URL } from '../../src/shared/ai';
import { failure, type Result } from '../../src/shared/errors';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { ExportStore } from '../../src/storage/export-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { NoteSearchStore } from '../../src/storage/note-search-store';
import { TagStore } from '../../src/storage/tag-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';
import { TrashStore } from '../../src/storage/trash-store';

let directory: string;
let stores: StoreContext;
let service: AiSuggestionService | null;

/** 存储请求沿用生产分发，模型替身只代替网络，不替代 SQLite 查询与保存。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-ai-suggestion-'));
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
    images: new NoteImageStore(connection, dataDirectory),
    topics,
    tags: new TagStore(connection),
    threads,
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

async function request(request: StoreRequest): Promise<Result<StoreValue>> {
  try {
    return { ok: true, value: await executeStoreRequest(stores, request) };
  } catch (error) {
    return failure(error);
  }
}

function createService(complete: DeepSeekClient['complete']): AiSuggestionService {
  service = new AiSuggestionService({
    request,
    resolveCallContext: async () => ({
      ...stores.aiSettings.load(),
      apiKey: 'integration-test-key',
    }),
    client: { complete },
    images: new AiImageReader({ request }),
  });
  return service;
}

/** 比较完整内容并观察写入计数，避免建议先写后删也被误判为只读。 */
function databaseSnapshot() {
  const database = stores.notes.connection();
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
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

describe('AI 归纳建议真实 SQLite 集成', () => {
  it('读取有效候选后返回本地归纳标题，只有采纳标签才写入草稿且重开可读', async () => {
    stores.notes.commitDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '其他手记正文不应发给模型',
      tags: ['时间管理'],
    });
    const deletedNote = stores.notes.commitDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '删除手记',
      tags: ['删除标签'],
    });
    stores.notes.remove(deletedNote.id);
    const topic = stores.topics.create({
      title: '事务管理',
      description: '归纳说明不应发给模型',
      confirmDuplicate: false,
    });
    const removedTopic = stores.topics.create({
      title: '删除归纳',
      description: '',
      confirmDuplicate: false,
    });
    stores.topics.remove(removedTopic.id);
    const draft = {
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '把长期事务拆成每日任务并安排时间。',
      title: '工作规划',
      tags: ['已选'],
    };
    await executeStoreRequest(stores, { operation: 'saveDraft', payload: draft });
    stores.aiSettings.saveBaseUrl('https://suggestion-gateway.example.test/v1');
    const before = databaseSnapshot();
    let prompt = '';
    const suggestion = await createService(async (input) => {
      expect(input.baseUrl).toBe('https://suggestion-gateway.example.test/v1');
      prompt = input.messages.map((message) => message.content).join('\n');
      return JSON.stringify({
        tags: ['时间管理', '规划'],
        topicIds: [topic.id, removedTopic.id, randomUUID()],
      });
    }).suggest({
      requestId: randomUUID(),
      body: draft.body,
      title: draft.title,
      existingTags: draft.tags,
      draftId: draft.id,
      imageIds: [],
    });
    expect(suggestion).toEqual({
      tags: ['时间管理', '规划'],
      topics: [{ id: topic.id, title: topic.title }],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
    expect(prompt).toContain('事务管理');
    expect(prompt).toContain('时间管理');
    expect(prompt).toContain(draft.body);
    expect(prompt).not.toContain('删除归纳');
    expect(prompt).not.toContain('删除标签');
    expect(prompt).not.toContain('其他手记正文不应发给模型');
    expect(prompt).not.toContain('归纳说明不应发给模型');
    expect(databaseSnapshot()).toEqual(before);
    expect(stores.notes.load().draft).toEqual(draft);
    expect(stores.topics.list()[0]?.noteIds).toEqual([]);

    const acceptedDraft = {
      ...draft,
      revision: draft.revision + 1,
      tags: [...draft.tags, suggestion.tags[0] ?? ''],
    };
    await executeStoreRequest(stores, { operation: 'saveDraft', payload: acceptedDraft });
    expect(stores.notes.load().draft).toEqual(acceptedDraft);
    // 重开验证真正落盘；不提交手记，也不自动产生归纳收录关系。
    stores.notes.close();
    stores.notes = new NoteStore({
      dataDirectory: stores.dataDirectory,
      migrationsDirectory: stores.migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    expect(stores.notes.load().draft).toEqual(acceptedDraft);
    expect(stores.notes.load().notes).toHaveLength(1);
    expect(
      stores.notes.connection().prepare('SELECT COUNT(*) AS count FROM note_topics').get()?.count,
    ).toBe(0);
  });

  it('空知识库可产生新标签，合法空结果也不写入数据', async () => {
    const before = databaseSnapshot();
    let output = { tags: ['新标签'], topicIds: [] as string[] };
    const suggestionService = createService(async () => JSON.stringify(output));
    const input = {
      requestId: randomUUID(),
      body: '在空知识库里写第一条手记。',
      title: '',
      existingTags: [],
      draftId: randomUUID(),
      imageIds: [],
    };
    expect(await suggestionService.suggest(input)).toEqual({
      tags: ['新标签'],
      topics: [],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
    output = { tags: [], topicIds: [] };
    expect(await suggestionService.suggest({ ...input, requestId: randomUUID() })).toEqual({
      tags: [],
      topics: [],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
    expect(databaseSnapshot()).toEqual(before);
  });

  it('模型输出异常时草稿与知识库均保持原样', async () => {
    const draft = {
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '失败时应保留正文',
      tags: ['原标签'],
    };
    await executeStoreRequest(stores, { operation: 'saveDraft', payload: draft });
    const before = databaseSnapshot();
    await expect(
      createService(async () => '不是 JSON').suggest({
        requestId: randomUUID(),
        body: draft.body,
        title: '',
        existingTags: draft.tags,
        draftId: draft.id,
        imageIds: [],
      }),
    ).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    expect(databaseSnapshot()).toEqual(before);
    expect(stores.notes.load().draft).toEqual(draft);
  });
});

/** 与供应商替身结合实际附件读取，验证图集归属不能被任意 ID 绕过。 */
describe('AI 建议真实草稿图片链路', () => {
  it('只发送当前草稿图片，保存手记和陌生ID跳过，字节及统计均真实且不写库', async () => {
    const note = stores.notes.commitDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '另一个已保存手记',
    });
    const other = stores.images.add(noteOwner(note.id), [
      { bytes: PNG_2X3, originalName: '不可上传的手记图.png' },
    ]).images[0];
    if (!other) throw new Error('测试手记图片未添加');
    const draft = { ...emptyDraft(randomUUID()), revision: 1, body: '请结合附带的截图给建议' };
    stores.notes.saveDraft(draft);
    const own = stores.images.add(draftOwner(draft.id), [
      { bytes: PNG_2X3, originalName: '本草稿图.png' },
    ]).images[0];
    if (!own) throw new Error('草稿图片未添加');
    const before = databaseSnapshot();
    const queries: StoreRequest[] = [];
    const loggedRequest = async (query: StoreRequest) => {
      queries.push(query);
      return request(query);
    };
    let captured: Parameters<DeepSeekClient['complete']>[0] | undefined;
    service = new AiSuggestionService({
      request: loggedRequest,
      images: new AiImageReader({ request: loggedRequest }),
      resolveCallContext: async () => ({
        model: 'deepseek-flash',
        baseUrl: DEFAULT_AI_BASE_URL,
        apiKey: 'test-only',
      }),
      client: {
        complete: async (value) => {
          captured = value;
          return '{"tags":["截图"],"topicIds":[]}';
        },
      },
    });
    const result = await service.suggest({
      requestId: randomUUID(),
      draftId: draft.id,
      body: draft.body,
      title: '',
      existingTags: [],
      imageIds: [other.id, randomUUID(), own.id],
    });
    expect(result).toEqual({
      tags: ['截图'],
      topics: [],
      usedImages: 1,
      skippedImages: 2,
      imagesSupported: true,
    });
    expect(queries.filter((query) => query.operation === 'readImage')).toEqual([
      { operation: 'readImage', payload: own.id },
    ]);
    const content = captured?.messages[1]?.content;
    expect(content).toEqual([
      { type: 'text', text: `用户手记标题：""\n用户手记正文：\n<<<BODY\n${draft.body}\nBODY>>>` },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
          detail: 'auto',
        },
      },
    ]);
    expect(captured?.timeoutMs).toBe(60_000);
    expect(databaseSnapshot()).toEqual(before);
  });

  it('超过4张按加入顺序纳入；Pro不发送、不读取图片，也不改模型配置', async () => {
    const draft = { ...emptyDraft(randomUUID()), revision: 1, body: '附图知识整理' };
    stores.notes.saveDraft(draft);
    const list = stores.images.add(
      draftOwner(draft.id),
      Array.from({ length: 5 }, (_, index) => ({ bytes: PNG_2X3, originalName: `图${index}.png` })),
    );
    const before = databaseSnapshot();
    let captured: Parameters<DeepSeekClient['complete']>[0] | undefined;
    const ai = createService(async (value) => {
      captured = value;
      return '{"tags":[],"topicIds":[]}';
    });
    const data = {
      requestId: randomUUID(),
      draftId: draft.id,
      body: draft.body,
      title: '',
      existingTags: [],
      imageIds: list.images.map((image) => image.id),
    };
    await expect(ai.suggest(data)).resolves.toMatchObject({
      usedImages: 4,
      skippedImages: 1,
      imagesSupported: true,
    });
    const content = captured?.messages[1]?.content;
    expect(
      Array.isArray(content) && content.filter((block) => block.type === 'image_url'),
    ).toHaveLength(4);
    expect(databaseSnapshot()).toEqual(before);
    stores.aiSettings.saveModel('deepseek-v4-pro');
    const proBefore = databaseSnapshot();
    await expect(ai.suggest({ ...data, requestId: randomUUID() })).resolves.toMatchObject({
      usedImages: 0,
      skippedImages: 5,
      imagesSupported: false,
    });
    expect(captured?.model).toBe('deepseek-v4-pro');
    expect(typeof captured?.messages[1]?.content).toBe('string');
    expect(captured?.timeoutMs).toBeUndefined();
    expect(databaseSnapshot()).toEqual(proBefore);
  });

  it('超尺寸图跳过继续，超过累计编码预算后停止，不修改附件和草稿', async () => {
    const draft = { ...emptyDraft(randomUUID()), revision: 1, body: '分析图片数据' };
    stores.notes.saveDraft(draft);
    const hugeDimension = Uint8Array.from(PNG_2X3);
    new DataView(hugeDimension.buffer).setUint32(16, 8193);
    const overBudget = new Uint8Array(6 * 1024 * 1024);
    overBudget.set(PNG_2X3);
    const list = stores.images.add(draftOwner(draft.id), [
      { bytes: hugeDimension, originalName: '超尺寸.png' },
      { bytes: PNG_2X3, originalName: '有效.png' },
      { bytes: overBudget, originalName: '超剩余预算.png' },
      { bytes: PNG_2X3, originalName: '预算已停止.png' },
    ]);
    const before = databaseSnapshot();
    const ai = createService(async () => '{"tags":[],"topicIds":[]}');
    await expect(
      ai.suggest({
        requestId: randomUUID(),
        draftId: draft.id,
        body: draft.body,
        title: '',
        existingTags: [],
        imageIds: list.images.map((image) => image.id),
      }),
    ).resolves.toMatchObject({ usedImages: 1, skippedImages: 3 });
    expect(databaseSnapshot()).toEqual(before);
    expect(
      stores.images.readBytes(list.images[2]?.id ?? '').bytes.equals(Buffer.from(overBudget)),
    ).toBe(true);
  });
});
