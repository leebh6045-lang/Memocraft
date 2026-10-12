import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AiImageReader } from '../../src/main/ai-image-reader';
import { AiSuggestionService } from '../../src/main/ai-suggestion-service';
import { AiService } from '../../src/main/ai-service';
import type { TopicSummary } from '../../src/domain/topic';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { DEFAULT_AI_BASE_URL } from '../../src/shared/ai';
import { AppError, type Result } from '../../src/shared/errors';
import { validateAiSuggestionInput } from '../../src/services/ai-validation';
import type { DeepSeekClient } from '../../src/services/deepseek-client';
import { PNG_2X3 } from '../fixtures/images';
import type { AiImageCollection } from '../../src/main/ai-image-reader';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('等待对象尚未初始化');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function input() {
  return {
    requestId: randomUUID(),
    body: '学习 Vue 响应式与数据归纳',
    title: '学习记录',
    existingTags: ['Vue'],
    imageIds: [],
    draftId: randomUUID(),
  };
}
function topic(title: string, time: string, noteIds: string[] = []): TopicSummary {
  return {
    id: randomUUID(),
    title,
    description: '不发送说明',
    revision: 1,
    createdAt: time,
    updatedAt: time,
    noteIds,
  };
}
/** 替身只隔离外部能力，断言候选、合法输出与取消时序等公开行为。 */
function fixture(topics: TopicSummary[] = [], tags = ['Vue', 'SQLite', 'SQLite']) {
  const request = vi.fn(async (query: StoreRequest): Promise<Result<StoreValue>> => ({
    ok: true,
    value: query.operation === 'loadTopics' ? topics : tags,
  }));
  const resolveCallContext = vi.fn(async () => ({
    model: 'deepseek-flash' as const,
    baseUrl: DEFAULT_AI_BASE_URL,
    apiKey: 'test-only-key',
  }));
  const client = {
    complete: vi.fn<DeepSeekClient['complete']>(async () =>
      JSON.stringify({ tags: ['Vue', '响应式', '学习'], topicIds: [] }),
    ),
  };
  return {
    service: new AiSuggestionService({
      request,
      resolveCallContext,
      client,
      images: new AiImageReader({ request }),
    }),
    request,
    resolveCallContext,
    client,
  };
}

describe('归纳建议服务', () => {
  it('只给模型正文前800字和受限候选，重叠标题优先，空无关归纳不进入候选', async () => {
    const related = topic('Vue 响应式', '2020-01-01');
    const empty = topic('无关空归纳', '2030-01-01');
    const others = Array.from({ length: 35 }, (_, index) =>
      topic(`候选${index}`, `2026-10-${String(index + 1).padStart(2, '0')}`, [randomUUID()]),
    );
    const { service, client } = fixture([...others, empty, related]);
    await service.suggest({
      ...input(),
      body: 'Vue 响应式' + '内'.repeat(794) + 'TAIL_MUST_NOT_SEND',
    });
    const call = client.complete.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      maxTokens: 512,
      model: 'deepseek-flash',
      baseUrl: DEFAULT_AI_BASE_URL,
      apiKey: 'test-only-key',
    });
    const system = typeof call?.messages[0]?.content === 'string' ? call.messages[0].content : '';
    expect(system).toContain(related.id);
    expect(system).not.toContain(empty.id);
    expect(system.match(/[0-9a-f-]{36} \| /g)).toHaveLength(30);
    expect(system.indexOf(related.id)).toBeLessThan(system.indexOf(others[34]?.id ?? ''));
    expect(system).not.toContain('不发送说明');
    expect(call?.messages[1]?.content).not.toContain('TAIL_MUST_NOT_SEND');
  });

  it('草稿已有标签与池合计最多40项，池去重且不重复引用已有标签', async () => {
    const { service, client } = fixture(
      [],
      Array.from({ length: 50 }, (_, index) => `池${index}`),
    );
    await service.suggest({
      ...input(),
      existingTags: Array.from({ length: 35 }, (_, index) => `草稿${index}`),
    });
    const system = client.complete.mock.calls[0]?.[0].messages[0]?.content ?? '';
    expect(system).toContain('池4');
    expect(system).not.toContain('池5');
    expect(system).toContain('草稿34');
    const second = fixture();
    await second.service.suggest(input());
    const prompt = second.client.complete.mock.calls[0]?.[0].messages[0]?.content ?? '';
    expect(prompt).toContain('草稿已有标签：["Vue"]');
    expect(prompt).toContain('已有标签参考：["SQLite"]');
  });

  it('保留已有标签并去重；仅采纳白名单ID，本地回填标题', async () => {
    const current = topic('Vue 响应式', '2026-10-10');
    const { service, client } = fixture([current]);
    client.complete.mockResolvedValue(
      JSON.stringify({
        tags: [' Vue ', 'Vue', '学习'],
        topicIds: [current.id, 'made-up', current.id],
        topicTitles: ['伪造标题'],
      }),
    );
    await expect(service.suggest(input())).resolves.toEqual({
      tags: ['Vue', '学习'],
      topics: [{ id: current.id, title: current.title }],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
  });

  it('无归纳仍调用，未知ID全丢弃后可返回合法空建议', async () => {
    const { service, client } = fixture();
    client.complete.mockResolvedValue('{"tags":[],"topicIds":["invented"]}');
    await expect(service.suggest(input())).resolves.toEqual({
      tags: [],
      topics: [],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
    expect(client.complete.mock.calls[0]?.[0].messages[0]?.content).toContain('知识库中还没有归纳');
  });

  it.each([
    'not json',
    '[]',
    'null',
    '{}',
    '{"tags":[],"topicIds":null}',
    JSON.stringify({ tags: 'bad', topicIds: [] }),
    JSON.stringify({ tags: [1], topicIds: [] }),
    JSON.stringify({ tags: [''], topicIds: [] }),
    JSON.stringify({ tags: ['  '], topicIds: [] }),
    JSON.stringify({ tags: ['a\nb'], topicIds: [] }),
    JSON.stringify({ tags: ['\r边界'], topicIds: [] }),
    JSON.stringify({ tags: ['a\u2028b'], topicIds: [] }),
    JSON.stringify({ tags: ['长'.repeat(31)], topicIds: [] }),
    JSON.stringify({ tags: Array(9).fill('重复'), topicIds: [] }),
    JSON.stringify({ tags: [], topicIds: [1] }),
    JSON.stringify({ tags: [], topicIds: Array(4).fill('重复') }),
  ])('拒绝非法整份输出：%s', async (content) => {
    const { service, client } = fixture();
    client.complete.mockResolvedValue(content);
    await expect(service.suggest(input())).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    // 失败释放槽位，可以主动重试；不存在自动重试计费请求。
    client.complete.mockResolvedValue('{"tags":[],"topicIds":[]}');
    await expect(service.suggest(input())).resolves.toEqual({
      tags: [],
      topics: [],
      usedImages: 0,
      skippedImages: 0,
      imagesSupported: true,
    });
  });

  it('准备期间即防重，取消只认相同ID，旧请求结束后可重新生成', async () => {
    const { service, resolveCallContext, client } = fixture();
    const pending = deferred<{ model: 'deepseek-flash'; baseUrl: string; apiKey: string }>();
    resolveCallContext.mockImplementationOnce(() => pending.promise);
    const firstInput = input();
    const first = service.suggest(firstInput);
    const rejected = expect(first).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await expect(service.suggest(input())).rejects.toMatchObject({ code: 'CONFLICT' });
    await service.cancel(randomUUID());
    const cancelling = service.cancel(firstInput.requestId);
    pending.resolve({
      model: 'deepseek-flash',
      baseUrl: DEFAULT_AI_BASE_URL,
      apiKey: 'test-only-key',
    });
    await rejected;
    await cancelling;
    expect(client.complete).not.toHaveBeenCalled();
    await expect(service.suggest(input())).resolves.toMatchObject({
      tags: ['Vue', '响应式', '学习'],
    });
  });

  it('候选准备期间取消不会进入网络，排空会等待准备结束', async () => {
    const { service, request, client } = fixture();
    const pending = deferred<Result<StoreValue>>();
    request.mockImplementationOnce(() => pending.promise);
    const flight = service.suggest(input());
    const rejected = expect(flight).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    let drained = false;
    const stopping = service.stopAndDrain().then(() => {
      drained = true;
    });
    await expect(service.suggest(input())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve({ ok: true, value: [] });
    await rejected;
    await stopping;
    expect(client.complete).not.toHaveBeenCalled();
    await expect(service.suggest(input())).resolves.toHaveProperty('tags');
  });

  it('取消后迟到成功也无效，排空等待底层结束而非仅发abort', async () => {
    const { service, client } = fixture();
    const pending = deferred<string>();
    client.complete.mockImplementationOnce(() => pending.promise);
    const flight = service.suggest(input());
    const rejected = expect(flight).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
    let drained = false;
    const closing = service.stopAndDrain().then(() => {
      drained = true;
    });
    expect(client.complete.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve('{"tags":["迟到"],"topicIds":[]}');
    await rejected;
    await closing;
    expect(drained).toBe(true);
  });

  it('未配置或存储异常不消耗额度，保留错误类别并释放槽位', async () => {
    const { service, resolveCallContext, request, client } = fixture();
    resolveCallContext.mockRejectedValueOnce(new AppError('AI_NOT_CONFIGURED', '未配置'));
    await expect(service.suggest(input())).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
    request.mockResolvedValueOnce({ ok: false, error: { code: 'STORAGE', message: '候选失败' } });
    await expect(service.suggest(input())).rejects.toThrow('候选失败');
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('切换模型/密钥不取消在途建议，下次调用使用新快照', async () => {
    let key = 'first-test-key';
    let model: 'deepseek-flash' | 'deepseek-v4-pro' = 'deepseek-flash';
    const ai = new AiService({
      credentials: {
        hasKey: async () => true,
        readKey: async () => key,
        saveKey: async (value) => {
          key = value;
        },
        clearKey: async () => {
          key = '';
        },
        isEncryptionAvailable: () => true,
      },
      request: async (query) => {
        if (query.operation === 'saveAiModel') model = 'deepseek-v4-pro';
        return { ok: true, value: { provider: 'deepseek', model, baseUrl: DEFAULT_AI_BASE_URL } };
      },
      client: { complete: async () => 'OK' },
    });
    const { request, client } = fixture();
    const service = new AiSuggestionService({
      request,
      client,
      resolveCallContext: () => ai.resolveCallContext(),
      images: new AiImageReader({ request }),
    });
    const pending = deferred<string>();
    client.complete.mockImplementationOnce(() => pending.promise);
    const first = service.suggest(input());
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
    await ai.saveModel('deepseek-v4-pro');
    await ai.saveKey('second-test-key');
    expect(client.complete.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    pending.resolve('{"tags":[],"topicIds":[]}');
    await first;
    await service.suggest(input());
    expect(client.complete.mock.calls[1]?.[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      baseUrl: DEFAULT_AI_BASE_URL,
      apiKey: 'second-test-key',
    });
  });
});

describe('建议图片组装与取消', () => {
  function imageFixture() {
    const draftId = randomUUID();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const request = vi.fn(async (query: StoreRequest): Promise<Result<StoreValue>> => {
      if (query.operation === 'loadTopics' || query.operation === 'loadTagPool')
        return { ok: true, value: [] };
      if (query.operation === 'loadImages')
        return {
          ok: true,
          value: {
            images: ids.map((id, position) => ({
              id,
              noteId: null,
              draftId,
              position,
              mimeType: 'image/png' as const,
              byteSize: PNG_2X3.length,
              relativePath: 'attachments/local.png',
              width: 2,
              height: 3,
              displayName: '',
              originalName: '',
              createdAt: '2026-10-10',
            })),
            totalBytes: ids.length * PNG_2X3.length,
          },
        };
      return { ok: true, value: { mimeType: 'image/png' as const, bytes: PNG_2X3 } };
    });
    const context = {
      model: 'deepseek-flash' as const,
      baseUrl: DEFAULT_AI_BASE_URL,
      apiKey: 'test-only-key',
    };
    const images = new AiImageReader({ request });
    const collect = vi.spyOn(images, 'collect');
    const client = {
      complete: vi.fn<DeepSeekClient['complete']>(
        async () => '{"tags":[],"topicIds":[],"usedImages":99}',
      ),
    };
    const service = new AiSuggestionService({
      request,
      images,
      client,
      resolveCallContext: async () => context,
    });
    return { service, request, collect, client, context, draftId, ids };
  }

  it('Flash按本地图集顺序纳入4图，原始IDs可逆序，统计由本地回填且带图60秒', async () => {
    const { service, request, client, draftId, ids } = imageFixture();
    expect(await service.suggest({ ...input(), draftId, imageIds: [...ids].reverse() })).toEqual({
      tags: [],
      topics: [],
      usedImages: 4,
      skippedImages: 2,
      imagesSupported: true,
    });
    expect(
      request.mock.calls
        .filter(([query]) => query.operation === 'readImage')
        .map(([query]) => ('payload' in query ? query.payload : null)),
    ).toEqual(ids.slice(0, 4));
    expect(client.complete.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 60_000, maxTokens: 512 });
    const content = client.complete.mock.calls[0]?.[0].messages[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('带图必须是内容块');
    expect(content[0]).toMatchObject({ type: 'text' });
    expect(content.slice(1)).toEqual(
      Array(4).fill({
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
          detail: 'auto',
        },
      }),
    );
  });

  it('Pro完全不读图片不调用collect，不静默换模型，回执仍含全部跳过数', async () => {
    const { request, client, collect, draftId, ids } = imageFixture();
    const service = new AiSuggestionService({
      request,
      client,
      images: { collect },
      resolveCallContext: async () => ({
        model: 'deepseek-v4-pro',
        baseUrl: DEFAULT_AI_BASE_URL,
        apiKey: 'test-key',
      }),
    });
    await expect(service.suggest({ ...input(), draftId, imageIds: ids })).resolves.toMatchObject({
      usedImages: 0,
      skippedImages: 6,
      imagesSupported: false,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(
      request.mock.calls.some(
        ([query]) => query.operation === 'loadImages' || query.operation === 'readImage',
      ),
    ).toBe(false);
    expect(client.complete.mock.calls[0]?.[0]).toMatchObject({ model: 'deepseek-v4-pro' });
    expect(client.complete.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    expect(typeof client.complete.mock.calls[0]?.[0].messages[1]?.content).toBe('string');
  });

  it('陌生图片ID未读字节，全跳过时使用30秒纯文字路径', async () => {
    const { service, request, client, draftId } = imageFixture();
    await expect(
      service.suggest({ ...input(), draftId, imageIds: [randomUUID()] }),
    ).resolves.toMatchObject({ usedImages: 0, skippedImages: 1, imagesSupported: true });
    expect(request.mock.calls.some(([query]) => query.operation === 'readImage')).toBe(false);
    expect(client.complete.mock.calls[0]?.[0].timeoutMs).toBeUndefined();
    expect(typeof client.complete.mock.calls[0]?.[0].messages[1]?.content).toBe('string');
  });

  it('读取图集失败不冒充图片已参与', async () => {
    const { service, request, draftId, ids } = imageFixture();
    request.mockImplementation(async (query) =>
      query.operation === 'loadImages'
        ? { ok: false, error: { code: 'NOT_FOUND', message: 'private path' } }
        : { ok: true, value: [] },
    );
    await expect(service.suggest({ ...input(), draftId, imageIds: ids })).resolves.toMatchObject({
      usedImages: 0,
      skippedImages: 6,
    });
  });

  it('图片读取期间取消与关闭排空均等待当前读取结束，取消后无供应商请求', async () => {
    const { service, collect, client, draftId, ids } = imageFixture();
    const pending = deferred<AiImageCollection>();
    collect.mockReturnValueOnce(pending.promise);
    const flight = service.suggest({ ...input(), draftId, imageIds: ids });
    const cancelled = expect(flight).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    let drained = false;
    const draining = service.stopAndDrain().then(() => {
      drained = true;
    });
    expect(collect.mock.calls[0]?.[2]?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve({ blocks: [], used: 0, skipped: 6, imageIds: [] });
    await cancelled;
    await draining;
    expect(client.complete).not.toHaveBeenCalled();
  });
});

describe('建议输入校验', () => {
  it.each([
    null,
    [],
    {},
    { ...input(), requestId: 'bad' },
    { ...input(), body: 1 },
    { ...input(), body: '  \n' },
    { ...input(), body: 'x'.repeat(4001) },
    { ...input(), title: 'x'.repeat(301) },
    { ...input(), title: null },
    { ...input(), existingTags: null },
    { ...input(), existingTags: [1] },
    { ...input(), existingTags: [''] },
    { ...input(), existingTags: ['x'.repeat(101)] },
    { ...input(), existingTags: Array(101).fill('重复') },
    { ...input(), draftId: 'not-draft-id' },
    { ...input(), imageIds: null },
    { ...input(), imageIds: [1] },
    { ...input(), imageIds: ['bad-id'] },
    { ...input(), imageIds: Array(51).fill(randomUUID()) },
  ])('拒绝无效载荷 %#', (value) => {
    expect(() => validateAiSuggestionInput(value)).toThrow(AppError);
  });
  it('保留正文、清理并去重已有标签，接受兼容边界', () => {
    const valid = {
      ...input(),
      body: '字'.repeat(4000),
      title: '',
      existingTags: [' Vue ', 'Vue'],
    };
    expect(validateAiSuggestionInput(valid)).toEqual({ ...valid, existingTags: ['Vue'] });
  });
});

describe('完整图集输入边界', () => {
  it('接受最多50张并按出现顺序去重，仍拒绝原始51项', () => {
    const ids = Array.from({ length: 50 }, () => randomUUID());
    expect(validateAiSuggestionInput({ ...input(), imageIds: ids }).imageIds).toEqual(ids);
    expect(
      validateAiSuggestionInput({ ...input(), imageIds: [ids[0], ids[0], ids[1]] }).imageIds,
    ).toEqual(ids.slice(0, 2));
    expect(() => validateAiSuggestionInput({ ...input(), imageIds: [...ids, ids[0]] })).toThrow();
  });
});
