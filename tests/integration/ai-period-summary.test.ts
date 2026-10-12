import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, NOTE_CATEGORIES, type Note, type NoteDraft } from '../../src/domain/note';
import { draftOwner, noteOwner } from '../../src/domain/note-image';
import { addDays, localDateToUtcStart } from '../../src/domain/time-range';
import { AiImageReader } from '../../src/main/ai-image-reader';
import { AiPeriodSummaryService } from '../../src/main/ai-period-summary-service';
import type { DeepSeekClient } from '../../src/services/deepseek-client';
import { executeStoreRequest, type StoreContext } from '../../src/services/note-service';
import type { AiContentBlock, AiPeriodSummaryInput } from '../../src/shared/ai';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { AppError, failure, type Result } from '../../src/shared/errors';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { transaction } from '../../src/storage/database';
import { ExportStore } from '../../src/storage/export-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteSearchStore } from '../../src/storage/note-search-store';
import { NoteStore } from '../../src/storage/note-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { TagStore } from '../../src/storage/tag-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';
import { TrashStore } from '../../src/storage/trash-store';
import { GIF_4X2, JPEG_6X7, PNG_2X3, WEBP_5X4 } from '../fixtures/images';

const startDate = '2026-10-05';
const defaultResponse = JSON.stringify({
  summary: '- 本期积累了 SQLite 事务和索引实践。可以继续整理已有记录。',
  suggestions: ['检查超时待办，并补充 SQLite 归纳说明。'],
  pointSources: [[1]],
});
let directory: string;
let stores: StoreContext;
let service: AiPeriodSummaryService;
let currentTime: Date;
let configured: boolean;
let requests: StoreRequest[];
let complete: ReturnType<typeof vi.fn<DeepSeekClient['complete']>>;

/** 与存储线程一致的分发和连接；只有凭据上下文与网络客户端使用替身。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-ai-period-'));
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
  currentTime = new Date('2026-10-11T04:00:00.000Z');
  configured = true;
  requests = [];
  complete = vi.fn<DeepSeekClient['complete']>(async () => defaultResponse);
  service = new AiPeriodSummaryService({
    request,
    resolveCallContext: async () => {
      if (!configured) throw new AppError('AI_NOT_CONFIGURED', '尚未配置测试凭据。');
      return { ...stores.aiSettings.load(), apiKey: 'integration-test-key' };
    },
    client: { complete },
    images: new AiImageReader({ request }),
    now: () => currentTime,
  });
});

afterEach(async () => {
  await service.stopAndDrain();
  stores.notes.close();
  rmSync(directory, { recursive: true, force: true });
});

async function request(operation: StoreRequest): Promise<Result<StoreValue>> {
  requests.push(operation);
  try {
    return { ok: true, value: await executeStoreRequest(stores, operation) };
  } catch (error) {
    return failure(error);
  }
}

function input(regenerate = false): AiPeriodSummaryInput {
  return { requestId: randomUUID(), periodType: 'week', startDate, regenerate };
}

function note(
  overrides: Partial<NoteDraft> = {},
  createdAt = localDateToUtcStart('2026-10-06'),
): Note {
  const saved = stores.notes.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '本期记录',
    ...overrides,
  });
  stores.notes
    .connection()
    .prepare('UPDATE notes SET created_at = ? WHERE id = ?')
    .run(createdAt, saved.id);
  return { ...saved, createdAt };
}

function userContent(callIndex = 0): string | AiContentBlock[] {
  const call = complete.mock.calls[callIndex];
  const message = call?.[0].messages.find((item) => item.role === 'user');
  if (!message) throw new Error('模型替身没有收到用户消息');
  return message.content;
}

function textContent(content: string | AiContentBlock[]): string {
  return typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/** 排除允许写入的缓存表，逐表比对原业务数据，并用写入计数发现额外修改。 */
function businessSnapshot() {
  const connection = stores.notes.connection();
  const tables = connection
    .prepare(
      `
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%' AND name != 'ai_period_summaries' ORDER BY name
  `,
    )
    .all();
  return tables.map((table) => {
    if (typeof table.name !== 'string' || !/^[a-z_]+$/.test(table.name))
      throw new Error('测试库包含不支持的表名');
    return {
      name: table.name,
      rows: connection.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all(),
    };
  });
}

function changes(): number {
  const count = stores.notes.connection().prepare('SELECT total_changes() AS total').get()?.total;
  if (typeof count !== 'number') throw new Error('测试库无法读取写入计数');
  return count;
}

function attachmentSnapshot() {
  return readdirSync(join(stores.dataDirectory, 'attachments'))
    .sort()
    .map((filename) => ({
      filename,
      bytes: readFileSync(join(stores.dataDirectory, 'attachments', filename)),
    }));
}

function cached() {
  return stores.periodSummaries.loadPeriodSummary('week', startDate);
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

describe('周期总结真实 SQLite 业务链', () => {
  it('使用本地事实生成正确计数，模型伪造元数据无效，只有缓存写入一次', async () => {
    const notes = [
      note({ title: '事务实践', body: 'SQLite 事务保证一致性。', tags: ['SQLite'] }),
      note({ title: '索引实践', body: '记录查询计划。', category: 'todo' }),
      note({ title: '事务结论', body: '本期完成事务验证。', category: 'done' }),
    ];
    const topic = stores.topics.create({
      title: 'SQLite 实践',
      description: '不发往模型的归纳正文',
      confirmDuplicate: false,
    });
    stores.topics.addNotes(
      topic.id,
      notes.map((item) => item.id),
    );
    note(
      { body: '全库旧待办正文不发送', category: 'todo' },
      new Date(currentTime.getTime() - 8 * 86_400_000).toISOString(),
    );
    note(
      { body: '全库旧完成正文不发送', category: 'done' },
      new Date(currentTime.getTime() - 10 * 86_400_000).toISOString(),
    );
    const deleted = note({ body: '回收站正文不发送' });
    stores.notes.remove(deleted.id);
    stores.notes.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '草稿正文不发送' });
    const thread = stores.threads.create({
      title: '事务标题不发送',
      description: '事务正文不发送',
      summary: '',
      confirmDuplicate: false,
    });
    stores.threads.addEntry({
      threadId: thread.id,
      occurredAt: currentTime.toISOString(),
      summary: '动态正文不发送',
      body: '',
      tags: [],
      noteIds: [],
    });
    stores.aiSettings.saveBaseUrl('https://review-gateway.example.test/v1');
    const before = businessSnapshot();
    const beforeChanges = changes();
    complete.mockResolvedValueOnce(
      JSON.stringify({
        summary: '- 本期有 SQLite 实践记录。可以结合已有归纳继续整理。',
        suggestions: ['检查 1 条超时待办。'],
        pointSources: [[1]],
        noteCount: 999,
        periodType: 'month',
        generatedAt: '1900-01-01T00:00:00.000Z',
      }),
    );
    const result = await service.summarize(input());
    expect(result).toMatchObject({
      periodType: 'week',
      startDate,
      endDate: '2026-10-11',
      noteCount: 3,
      generatedAt: currentTime.toISOString(),
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
    const prompt = textContent(userContent());
    expect(prompt).toContain('共 3 条手记');
    expect(prompt).toContain('超时待办（7 天以上未处理）：1 条');
    expect(prompt).toContain('"SQLite 实践" 收录了 3 条本期手记');
    for (const excluded of [
      '全库旧待办正文不发送',
      '全库旧完成正文不发送',
      '回收站正文不发送',
      '草稿正文不发送',
      '不发往模型的归纳正文',
      '事务标题不发送',
      '事务正文不发送',
      '动态正文不发送',
    ])
      expect(prompt).not.toContain(excluded);
    expect(businessSnapshot()).toEqual(before);
    expect(changes()).toBe(beforeChanges + 1);
    expect(cached()).toMatchObject({
      noteCount: 3,
      summary: result.summary,
      generatedAt: result.generatedAt,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0].baseUrl).toBe('https://review-gateway.example.test/v1');
    expect(complete.mock.calls[0]?.[0].maxTokens).toBe(1024);
  });

  it('空期不调用模型、不落缓存，草稿也不计入手记数', async () => {
    stores.notes.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '尚未提交' });
    const before = businessSnapshot();
    const beforeChanges = changes();
    expect(await service.summarize(input())).toEqual({
      periodType: 'week',
      startDate,
      endDate: '2026-10-11',
      summary: '',
      suggestions: [],
      noteCount: 0,
      generatedAt: currentTime.toISOString(),
    });
    expect(complete).not.toHaveBeenCalled();
    expect(cached()).toBeNull();
    expect(businessSnapshot()).toEqual(before);
    expect(changes()).toBe(beforeChanges);
  });

  it('重复访问命中持久缓存，不再查手记、读图、请求网络或写入', async () => {
    const saved = note();
    stores.images.add(noteOwner(saved.id), [{ bytes: PNG_2X3, originalName: '首图.png' }]);
    const first = await service.summarize(input());
    const before = businessSnapshot();
    const beforeChanges = changes();
    requests = [];
    const second = await service.summarize(input());
    expect(second).toEqual(cached());
    expect(second.summary).toBe(first.summary);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(second.usedImages).toBeUndefined();
    expect(second.skippedImages).toBeUndefined();
    expect(second.imagesSupported).toBeUndefined();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(requests.map((operation) => operation.operation)).toEqual(['loadPeriodSummary']);
    expect(businessSnapshot()).toEqual(before);
    expect(changes()).toBe(beforeChanges);
  });

  it('逐点链接按本地采样编号落缓存，无标题参与分析但不链接，删改手记不改写旧引用', async () => {
    const first = note(
      { title: '事务原理', body: '事务实践的真实内容。' },
      localDateToUtcStart('2026-10-06'),
    );
    const second = note(
      { title: '索引计划', body: '索引实践的真实内容。' },
      localDateToUtcStart('2026-10-07'),
    );
    note(
      { title: '', body: '未标题正文依旧参与本期分析。\n第二行不是链接标题。' },
      localDateToUtcStart('2026-10-08'),
    );
    complete.mockResolvedValueOnce(
      JSON.stringify({
        summary: '- 事务与索引实践。\n- 索引有进一步积累。',
        suggestions: [],
        pointSources: [[3, 1, 2, 2, 999], [2]],
        sources: [{ index: 2, noteId: randomUUID(), title: '供应商伪造标题' }],
      }),
    );
    const firstResult = await service.summarize(input());
    const pointSources = [
      [
        { index: 2, noteId: second.id, title: '索引计划' },
        { index: 3, noteId: first.id, title: '事务原理' },
      ],
      [{ index: 2, noteId: second.id, title: '索引计划' }],
    ];
    expect(firstResult).toMatchObject({ noteCount: 3, pointSources });
    expect(textContent(userContent())).toContain('未标题正文依旧参与本期分析。');
    expect(
      new PeriodSummaryStore(stores.notes.connection()).loadPeriodSummary('week', startDate),
    ).toMatchObject({ summary: firstResult.summary, pointSources });
    stores.notes.updateNote({
      ...first,
      expectedRevision: first.revision,
      title: '后来修改的标题',
    });
    stores.notes.remove(second.id);
    const beforeChanges = changes();
    requests = [];
    expect(await service.summarize(input())).toMatchObject({
      noteCount: 3,
      pointSources,
      generatedAt: firstResult.generatedAt,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(requests.map((operation) => operation.operation)).toEqual(['loadPeriodSummary']);
    expect(changes()).toBe(beforeChanges);
  });

  it('旧版本单段缓存没有引用仍可读取，不为新增链接重生成或改写缓存', async () => {
    note({ title: '已有手记' });
    stores.notes
      .connection()
      .prepare(
        `
      INSERT INTO ai_period_summaries
        (period_type, start_date, summary, suggestions, note_count, generated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run('week', startDate, '旧版本的单段回顾内容。', '[]', 1, currentTime.toISOString());
    const before = businessSnapshot();
    const beforeChanges = changes();
    const result = await service.summarize(input());
    expect(result.summary).toBe('旧版本的单段回顾内容。');
    expect(result).not.toHaveProperty('pointSources');
    expect(complete).not.toHaveBeenCalled();
    expect(requests.map((operation) => operation.operation)).toEqual(['loadPeriodSummary']);
    expect(cached()).toEqual(result);
    expect(businessSnapshot()).toEqual(before);
    expect(changes()).toBe(beforeChanges);
  });

  it('编辑、删除和新增手记后旧缓存仍保持，用户主动重新生成才更新', async () => {
    const saved = note({ body: '初始记录' });
    note({ body: '保留记录', category: 'todo' });
    const first = await service.summarize(input());
    stores.notes.updateNote({ ...saved, expectedRevision: saved.revision, body: '编辑后的正文' });
    stores.notes.remove(saved.id);
    note({ body: '后来新增的正文' });
    expect((await service.summarize(input())).summary).toBe(first.summary);
    expect(complete).toHaveBeenCalledTimes(1);
    currentTime = new Date('2026-10-11T05:00:00.000Z');
    complete.mockResolvedValueOnce(
      JSON.stringify({
        summary: '- 根据新增记录刷新了回顾。当前有效手记有两条。',
        suggestions: [],
        pointSources: [[1]],
      }),
    );
    const regenerated = await service.summarize(input(true));
    expect(regenerated.summary).not.toBe(first.summary);
    expect(regenerated.generatedAt).toBe(currentTime.toISOString());
    expect(regenerated.noteCount).toBe(2);
    expect(textContent(userContent(1))).toContain('后来新增的正文');
    expect(textContent(userContent(1))).not.toContain('编辑后的正文');
    expect(cached()).toMatchObject({
      summary: regenerated.summary,
      generatedAt: regenerated.generatedAt,
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each(['format', 'sources', 'network', 'cache-write'] as const)(
    '重新生成发生 %s 失败时保留旧缓存及全部业务数据',
    async (kind) => {
      note();
      await service.summarize(input());
      const old = cached();
      currentTime = new Date('2026-10-11T05:00:00.000Z');
      if (kind === 'format') complete.mockResolvedValueOnce('不是 JSON');
      if (kind === 'sources')
        complete.mockResolvedValueOnce(
          JSON.stringify({
            summary: '- 第一主题\n- 第二主题',
            suggestions: [],
            pointSources: [[1]],
          }),
        );
      if (kind === 'network')
        complete.mockRejectedValueOnce(new AppError('AI_NETWORK', '测试网络失败。'));
      if (kind === 'cache-write') {
        complete.mockResolvedValueOnce(
          JSON.stringify({
            summary: '- 这份新摘要不应覆盖旧结果。',
            suggestions: [],
            pointSources: [[1]],
          }),
        );
        // 真正 SQLite 写入失败验证 UPSERT 的原子性，不通过替换存储依赖伪装失败。
        stores.notes.connection().exec(`
        CREATE TEMP TRIGGER fail_period_cache_update BEFORE UPDATE ON ai_period_summaries
        BEGIN SELECT RAISE(ABORT, 'isolated cache write failure'); END;
      `);
      }
      const before = businessSnapshot();
      const beforeChanges = changes();
      await expect(service.summarize(input(true))).rejects.toMatchObject({
        code:
          kind === 'format' || kind === 'sources'
            ? 'AI_RESPONSE'
            : kind === 'network'
              ? 'AI_NETWORK'
              : 'STORAGE',
      });
      expect(cached()).toEqual(old);
      expect(businessSnapshot()).toEqual(before);
      expect(changes()).toBe(beforeChanges);
    },
  );

  it('未配置优先返回引导错误，即使已有缓存也不读取缓存或请求网络', async () => {
    note();
    await service.summarize(input());
    const old = cached();
    requests = [];
    configured = false;
    await expect(service.summarize(input())).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    expect(requests).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(cached()).toEqual(old);
  });
});

describe('周期图片归属与上下文边界', () => {
  it('只发送采样手记的有效首图，缺失图跳过后其余图片仍紧随对应文字', async () => {
    const start = new Date(localDateToUtcStart('2026-10-06')).getTime();
    const insights = Array.from({ length: 21 }, (_, index) =>
      note(
        { title: `采样${index}`, body: index === 0 ? '未采样正文不发送' : `本期记录${index}` },
        new Date(start + index * 1000).toISOString(),
      ),
    );
    note({ title: '待办', category: 'todo' });
    note({ title: '完成', category: 'done' });
    note({ title: '杂项', category: 'misc' });
    const [last, missing, gif, webp, unsampled] = [
      insights[20],
      insights[19],
      insights[18],
      insights[17],
      insights[0],
    ];
    if (!last || !missing || !gif || !webp || !unsampled) throw new Error('采样手记缺失');
    const firstImages = stores.images.add(noteOwner(last.id), [
      { bytes: PNG_2X3, originalName: '首图.png' },
      { bytes: JPEG_6X7, originalName: '第二张不发送.jpg' },
    ]).images;
    const missingImage = stores.images.add(noteOwner(missing.id), [
      { bytes: PNG_2X3, originalName: '缺失.png' },
    ]).images[0];
    const gifImage = stores.images.add(noteOwner(gif.id), [
      { bytes: GIF_4X2, originalName: '首图.gif' },
    ]).images[0];
    const webpImage = stores.images.add(noteOwner(webp.id), [
      { bytes: WEBP_5X4, originalName: '首图.webp' },
    ]).images[0];
    stores.images.add(noteOwner(unsampled.id), [{ bytes: JPEG_6X7, originalName: '未采样.jpg' }]);
    const deleted = note({ body: '回收站图文不发送' });
    stores.images.add(noteOwner(deleted.id), [{ bytes: JPEG_6X7, originalName: '回收站.jpg' }]);
    stores.notes.remove(deleted.id);
    const outside = note({ body: '期外图文不发送' }, localDateToUtcStart(addDays(startDate, -1)));
    stores.images.add(noteOwner(outside.id), [{ bytes: JPEG_6X7, originalName: '期外.jpg' }]);
    const draft = { ...emptyDraft(randomUUID()), revision: 1, body: '草稿图文不发送' };
    stores.notes.saveDraft(draft);
    stores.images.add(draftOwner(draft.id), [{ bytes: JPEG_6X7, originalName: '草稿.jpg' }]);
    if (!firstImages[0] || !missingImage || !gifImage || !webpImage)
      throw new Error('采样图片缺失');
    rmSync(join(stores.dataDirectory, missingImage.relativePath));
    const before = businessSnapshot();
    const files = attachmentSnapshot();
    const result = await service.summarize(input());
    expect(result).toMatchObject({
      noteCount: 24,
      usedImages: 3,
      skippedImages: 1,
      imagesSupported: true,
    });
    expect(
      requests
        .filter((operation) => operation.operation === 'readImage')
        .map((operation) => operation.payload),
    ).toEqual([firstImages[0].id, missingImage.id, gifImage.id, webpImage.id]);
    const blocks = userContent();
    if (typeof blocks === 'string') throw new Error('Flash 有有效图片时应收到内容块');
    const expectedImages = [
      ['采样20', dataUrl('image/png', PNG_2X3)],
      ['采样18', dataUrl('image/gif', GIF_4X2)],
      ['采样17', dataUrl('image/webp', WEBP_5X4)],
    ];
    for (const [title, url] of expectedImages) {
      const index = blocks.findIndex(
        (block) => block.type === 'text' && block.text.includes(`"${title}"`),
      );
      expect(index).toBeGreaterThan(0);
      expect(blocks[index + 1]).toEqual({ type: 'image_url', image_url: { url, detail: 'auto' } });
    }
    const missingIndex = blocks.findIndex(
      (block) => block.type === 'text' && block.text.includes('"采样19"'),
    );
    expect(blocks[missingIndex + 1]?.type).toBe('text');
    expect(blocks.filter((block) => block.type === 'image_url')).toHaveLength(3);
    const prompt = textContent(blocks);
    for (const excluded of [
      '未采样正文不发送',
      '回收站图文不发送',
      '期外图文不发送',
      '草稿图文不发送',
    ])
      expect(prompt).not.toContain(excluded);
    expect(businessSnapshot()).toEqual(before);
    expect(attachmentSnapshot()).toEqual(files);
    expect(cached()).not.toHaveProperty('usedImages');
    expect(cached()).not.toHaveProperty('skippedImages');
  });

  it('Pro 不读取真实附件且使用纯文字，图片不支持回执仅出现在当次结果', async () => {
    stores.aiSettings.saveModel('deepseek-v4-pro');
    const saved = note();
    stores.images.add(noteOwner(saved.id), [{ bytes: PNG_2X3, originalName: '正常.png' }]);
    const result = await service.summarize(input());
    expect(result).toMatchObject({ usedImages: 0, skippedImages: 1, imagesSupported: false });
    expect(typeof userContent()).toBe('string');
    expect(requests.some((operation) => operation.operation === 'readImage')).toBe(false);
    expect(complete.mock.calls[0]?.[0].model).toBe('deepseek-v4-pro');
    expect(cached()).not.toHaveProperty('imagesSupported');
  });

  it('六条真实附图手记按顺序参与最多四张，后续附件不读取', async () => {
    const start = new Date(localDateToUtcStart('2026-10-06')).getTime();
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const saved = note({ title: `附图${index}` }, new Date(start + index * 1000).toISOString());
      const image = stores.images.add(noteOwner(saved.id), [
        { bytes: PNG_2X3, originalName: `${index}.png` },
      ]).images[0];
      if (!image) throw new Error('预算测试图片缺失');
      ids.unshift(image.id);
    }
    expect(await service.summarize(input())).toMatchObject({ usedImages: 4, skippedImages: 2 });
    expect(
      requests
        .filter((operation) => operation.operation === 'readImage')
        .map((operation) => operation.payload),
    ).toEqual(ids.slice(0, 4));
  });

  it('2000 条真实手记返回全量统计，发往模型的每类摘录最多五条且每条正文有界', async () => {
    const connection = stores.notes.connection();
    const startAt = localDateToUtcStart('2026-10-06');
    const insert = connection.prepare(`
      INSERT INTO notes (id, title, body, category, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    transaction(connection, () => {
      for (let index = 0; index < 2000; index += 1) {
        const category = NOTE_CATEGORIES[index % 4];
        if (!category) throw new Error('分类样例缺失');
        const at = new Date(new Date(startAt).getTime() + index * 1000).toISOString();
        insert.run(
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          `规模记录${index}`,
          `${'文'.repeat(400)}DO_NOT_SEND_TRAILING_TEXT`,
          category.value,
          at,
          at,
        );
      }
    });
    const before = businessSnapshot();
    const result = await service.summarize(input());
    expect(result.noteCount).toBe(2000);
    const content = userContent();
    if (typeof content !== 'string') throw new Error('无图规模测试应使用纯文字');
    expect(content).toContain('共 2000 条手记，以下为代表性摘录');
    expect(content).not.toContain('DO_NOT_SEND_TRAILING_TEXT');
    const lines = content.split('\n').filter((line) => /^\[\d+\] /.test(line));
    expect(lines).toHaveLength(20);
    for (const category of NOTE_CATEGORIES)
      expect(lines.filter((line) => line.includes(`] ${category.label} |`))).toHaveLength(5);
    for (const line of lines) {
      const excerpt = line.split(' | ')[2];
      if (!excerpt) throw new Error('规模摘录缺失');
      const body: unknown = JSON.parse(excerpt);
      expect(typeof body === 'string' && body.length === 200).toBe(true);
    }
    expect(Buffer.byteLength(JSON.stringify(complete.mock.calls[0]?.[0].messages))).toBeLessThan(
      20_000,
    );
    expect(businessSnapshot()).toEqual(before);
    expect(complete).toHaveBeenCalledTimes(1);
    // 此用例证明本地查询和载荷上限，不对真实模型网络耗时作声明。
  });
});
