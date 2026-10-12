import { effectScope, ref, type EffectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAiSuggestion } from '../../src/renderer/src/composables/useAiSuggestion';
import {
  AI_SUGGESTION_INPUT_LIMIT,
  DEFAULT_AI_BASE_URL,
  type AiApi,
  type AiConfiguration,
  type AiModel,
  type AiSettings,
  type AiSuggestion,
} from '../../src/shared/ai';
import type { ErrorCode, Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

const draftId = '550e8400-e29b-41d4-a716-446655440000';
const imageMetadata = { usedImages: 0, skippedImages: 0, imagesSupported: true };

function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** 手动结算跨进程应答，验证取消和乱序，不依赖计时或真实网络。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟请求尚未初始化');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function makeApi(): AiApi {
  return {
    loadSettings: vi.fn(async () =>
      success<AiSettings>({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: DEFAULT_AI_BASE_URL,
        keyConfigured: true,
        encryptionAvailable: true,
      }),
    ),
    saveModel: vi.fn(async (model: AiModel) =>
      success<AiConfiguration>({ provider: 'deepseek', model, baseUrl: DEFAULT_AI_BASE_URL }),
    ),
    saveBaseUrl: vi.fn(async (baseUrl: string) =>
      success<AiConfiguration>({ provider: 'deepseek', model: 'deepseek-flash', baseUrl }),
    ),
    saveKey: vi.fn(async () => success(null)),
    clearKey: vi.fn(async () => success(null)),
    testConnection: vi.fn(async () => failure('UNAVAILABLE', '此测试不会调用连接测试。')),
    cancelTest: vi.fn(async () => success(null)),
    suggest: vi.fn(async () =>
      success({ ...imageMetadata, tags: ['学习'], topics: [{ id: 'topic-1', title: '学习方法' }] }),
    ),
    cancelSuggestion: vi.fn(async () => success(null)),
    ask: vi.fn(async () => ({
      ok: true as const,
      value: { answer: '', sources: [], matchedNotes: 0 },
    })),
    cancelAsk: vi.fn(async () => ({ ok: true as const, value: null })),
    summarizePeriod: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNAVAILABLE' as const, message: '此测试不生成回顾' },
    })),
    cancelPeriodSummary: vi.fn(async () => ({ ok: true as const, value: null })),
  };
}

const scopes: EffectScope[] = [];
function setup(body = '当前正文', imageIds: string[] = []) {
  const scope = effectScope();
  scopes.push(scope);
  const ai = makeApi();
  const currentBody = ref(body);
  const currentImages = ref([...imageIds]);
  const state = scope.run(() =>
    useAiSuggestion(
      { ai },
      () => currentBody.value,
      () => currentImages.value,
    ),
  );
  if (!state) throw new Error('Vue 作用域未创建');
  return { ai, currentBody, currentImages, state, scope };
}

async function settleResponses() {
  for (let count = 0; count < 6; count += 1) await Promise.resolve();
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.restoreAllMocks();
});

describe('AI 建议现场与异步生命周期', () => {
  it('初始为空，不自动请求；纯空白正文不触发调用', async () => {
    const { ai, state } = setup();
    expect(state.phase.value).toBe('idle');
    expect(state.suggestion.value).toBeNull();
    expect(state.isStale.value).toBe(false);
    await state.request(' \n ', '', [], [], draftId);
    expect(ai.suggest).not.toHaveBeenCalled();
  });

  it('复制标签并限制 IPC 正文，同时保存完整正文用于变化提示', async () => {
    const originalBody = '文'.repeat(AI_SUGGESTION_INPUT_LIMIT + 50);
    const { ai, state, currentBody } = setup(originalBody);
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    const tags = ['学习'];
    const request = state.request(originalBody, '标题', tags, [], draftId);
    tags.push('后来加入');
    expect(state.phase.value).toBe('loading');
    expect(vi.mocked(ai.suggest).mock.calls[0]?.[0]).toMatchObject({
      body: '文'.repeat(AI_SUGGESTION_INPUT_LIMIT),
      title: '标题',
      existingTags: ['学习'],
    });
    expect(state.staleBody.value).toBe(originalBody);
    currentBody.value += '末尾变化';
    pending.resolve(success({ ...imageMetadata, tags: ['学习'], topics: [] }));
    await request;
    expect(state.phase.value).toBe('ready');
    expect(state.suggestion.value?.tags).toEqual(['学习']);
    expect(state.isStale.value).toBe(true);
    currentBody.value = originalBody;
    expect(state.isStale.value).toBe(false);
  });

  it('复制完整图集并传草稿归属；增删、换序和第 5 张之后的变化均令建议过期', async () => {
    const imageIds = Array.from(
      { length: 6 },
      (_, index) => `550e8400-e29b-41d4-a716-44665544000${index + 1}`,
    );
    const { ai, state, currentImages } = setup('当前正文', imageIds);
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    const passedIds = [...imageIds];
    const request = state.request('当前正文', '', [], passedIds, draftId);
    passedIds.reverse();
    expect(vi.mocked(ai.suggest).mock.calls[0]?.[0]).toMatchObject({
      imageIds,
      draftId,
    });
    expect(state.staleImageIds.value).toEqual(imageIds);
    currentImages.value = imageIds.slice(0, -1);
    pending.resolve(success({ ...imageMetadata, tags: ['图文'], topics: [] }));
    await request;
    expect(state.isStale.value).toBe(true);
    currentImages.value = [...imageIds];
    expect(state.isStale.value).toBe(false);
    currentImages.value = [
      ...imageIds.slice(0, 4),
      '550e8400-e29b-41d4-a716-446655440006',
      '550e8400-e29b-41d4-a716-446655440005',
    ];
    expect(state.isStale.value).toBe(true);
    currentImages.value = [...imageIds, '550e8400-e29b-41d4-a716-446655440007'];
    expect(state.isStale.value).toBe(true);
    state.reset();
    expect(state.staleImageIds.value).toBeNull();
    expect(state.isStale.value).toBe(false);
  });

  it('空建议的图片增删也标记过期，重新生成采用当前图集', async () => {
    const { ai, state, currentImages } = setup();
    vi.mocked(ai.suggest).mockResolvedValueOnce(
      success({ ...imageMetadata, tags: [], topics: [] }),
    );
    await state.request('当前正文', '', [], currentImages.value, draftId);
    expect(state.phase.value).toBe('empty');
    currentImages.value = ['550e8400-e29b-41d4-a716-446655440001'];
    expect(state.isStale.value).toBe(true);
    await state.request('当前正文', '', [], currentImages.value, draftId);
    expect(vi.mocked(ai.suggest).mock.calls[1]?.[0].imageIds).toEqual(currentImages.value);
    expect(state.isStale.value).toBe(false);
  });

  it('加载期间拒绝重复请求，结果返回前不允许第二次计费', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    const request = state.request('当前正文', '', [], [], draftId);
    await state.request('另一个正文', '', [], [], draftId);
    expect(ai.suggest).toHaveBeenCalledTimes(1);
    expect(state.staleBody.value).toBe('当前正文');
    pending.resolve(
      success({ ...imageMetadata, tags: [], topics: [{ id: 'topic-1', title: '归纳' }] }),
    );
    await request;
    expect(state.phase.value).toBe('ready');
    expect(state.requestId.value).toBeNull();
  });

  it('空结果独立显示 empty，后续正文变化仍标记过期', async () => {
    const { ai, state, currentBody } = setup();
    vi.mocked(ai.suggest).mockResolvedValueOnce(
      success({ ...imageMetadata, tags: [], topics: [] }),
    );
    await state.request(currentBody.value, '', [], [], draftId);
    expect(state.phase.value).toBe('empty');
    expect(state.error.value).toBe('');
    currentBody.value = '新正文';
    expect(state.isStale.value).toBe(true);
  });

  it('业务失败保留错误码，未知桥接错误不泄露原始消息，也不自动重试', async () => {
    const { ai, state } = setup();
    vi.mocked(ai.suggest)
      .mockResolvedValueOnce(failure('AI_NOT_CONFIGURED', '请先配置 DeepSeek API Key。'))
      .mockRejectedValueOnce(new Error('正文与密钥不应显示'));
    await state.request('当前正文', '', [], [], draftId);
    expect(state.phase.value).toBe('error');
    expect(state.errorCode.value).toBe('AI_NOT_CONFIGURED');
    expect(state.error.value).toContain('请先配置');
    expect(ai.suggest).toHaveBeenCalledTimes(1);
    await state.request('当前正文', '', [], [], draftId);
    expect(state.errorCode.value).toBe('UNAVAILABLE');
    expect(state.error.value).toBe('AI 建议未能生成，请重试。');
    expect(state.suggestion.value).toBeNull();
    expect(ai.suggest).toHaveBeenCalledTimes(2);
  });

  it('重新生成使用新身份和当前正文，清除旧结果和旧错误', async () => {
    const { ai, state, currentBody } = setup();
    await state.request(currentBody.value, '', [], [], draftId);
    const previousId = vi.mocked(ai.suggest).mock.calls[0]?.[0].requestId;
    currentBody.value = '修改后的正文';
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    const retry = state.request(currentBody.value, '新标题', ['学习'], [], draftId);
    expect(state.phase.value).toBe('loading');
    expect(state.suggestion.value).toBeNull();
    expect(state.error.value).toBe('');
    expect(state.requestId.value).not.toBe(previousId);
    pending.resolve(success({ ...imageMetadata, tags: ['新标签'], topics: [] }));
    await retry;
    expect(state.isStale.value).toBe(false);
    expect(state.suggestion.value?.tags).toEqual(['新标签']);
  });

  it('取消等待主进程回执，在等待期间不能发起下一次请求；迟到成功被丢弃', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    const cancellation = deferred<Result<null>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockReturnValueOnce(cancellation.promise);
    const request = state.request('当前正文', '', [], [], draftId);
    const id = state.requestId.value;
    const cancel = state.cancel();
    await settleResponses();
    expect(ai.cancelSuggestion).toHaveBeenCalledWith(id);
    expect(state.cancelling.value).toBe(true);
    await state.request('新的正文', '', [], [], draftId);
    expect(ai.suggest).toHaveBeenCalledTimes(1);
    cancellation.resolve(success(null));
    await cancel;
    expect(state.phase.value).toBe('idle');
    expect(state.requestId.value).toBeNull();
    expect(state.cancelling.value).toBe(false);
    pending.resolve(success({ ...imageMetadata, tags: ['迟到'], topics: [] }));
    await request;
    expect(state.suggestion.value).toBeNull();
    await state.request('新的正文', '', [], [], draftId);
    expect(state.suggestion.value?.tags).toEqual(['学习']);
  });

  it('原请求先结算时仍等待取消回执，取消意图不被迟到成功反转', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    const cancellation = deferred<Result<null>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockReturnValueOnce(cancellation.promise);
    const request = state.request('当前正文', '', [], [], draftId);
    const cancel = state.cancel();
    pending.resolve(success({ ...imageMetadata, tags: ['不应显示'], topics: [] }));
    await request;
    expect(state.suggestion.value).toBeNull();
    await state.request('新正文', '', [], [], draftId);
    expect(ai.suggest).toHaveBeenCalledTimes(1);
    cancellation.resolve(success(null));
    await cancel;
    expect(state.phase.value).toBe('idle');
  });

  it('取消失败明确提示，仍锁住在途请求；允许再次取消并忽略旧结果', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockResolvedValueOnce(
      failure('UNAVAILABLE', '取消失败，请重试。'),
    );
    const request = state.request('当前正文', '', [], [], draftId);
    const id = state.requestId.value;
    await state.cancel();
    expect(state.phase.value).toBe('error');
    expect(state.error.value).toBe('取消失败，请重试。');
    expect(state.requestId.value).toBe(id);
    expect(state.cancelling.value).toBe(false);
    await state.request('新的正文', '', [], [], draftId);
    expect(ai.suggest).toHaveBeenCalledTimes(1);
    await state.cancel();
    expect(state.phase.value).toBe('idle');
    pending.resolve(success({ ...imageMetadata, tags: ['旧结果'], topics: [] }));
    await request;
    expect(state.suggestion.value).toBeNull();
  });

  it('取消桥接同步异常不泄露细节，原请求结束后可以重试', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockImplementationOnce(() => {
      throw new Error('secret');
    });
    const request = state.request('当前正文', '', [], [], draftId);
    await state.cancel();
    expect(state.error.value).toBe('取消未完成，可以再次关闭或等待生成结束。');
    expect(state.cancelling.value).toBe(false);
    pending.resolve(failure('AI_CANCELLED', '已取消'));
    await request;
    expect(state.error.value).toContain('取消未完成');
    await state.cancel();
    expect(state.phase.value).toBe('idle');
    expect(state.error.value).toBe('');
    await state.request('新正文', '', [], [], draftId);
    expect(state.phase.value).toBe('ready');
    expect(state.error.value).toBe('');
  });

  it('切页重置立即清空现场，静默取消失败和迟到错误均不污染新页面', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockRejectedValueOnce(new Error('cancel bridge failure'));
    const request = state.request('当前正文', '', [], [], draftId);
    state.reset();
    expect(state.phase.value).toBe('idle');
    expect(state.staleBody.value).toBeNull();
    expect(state.staleImageIds.value).toBeNull();
    await settleResponses();
    expect(ai.cancelSuggestion).toHaveBeenCalledTimes(1);
    pending.resolve(failure('AI_NETWORK', '迟到网络错误'));
    await request;
    expect(state.error.value).toBe('');
    expect(state.errorCode.value).toBeNull();
    expect(state.phase.value).toBe('idle');
  });

  it('重置后旧应答不能覆盖较新的请求，也不会解除新请求的锁', async () => {
    const { ai, state } = setup();
    const oldResponse = deferred<Result<AiSuggestion>>();
    const newResponse = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest)
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const oldRequest = state.request('旧正文', '', [], [], draftId);
    state.reset();
    await settleResponses();
    const newRequest = state.request('新正文', '', [], [], draftId);
    const newId = state.requestId.value;
    oldResponse.resolve(success({ ...imageMetadata, tags: ['旧建议'], topics: [] }));
    await oldRequest;
    expect(state.phase.value).toBe('loading');
    expect(state.requestId.value).toBe(newId);
    newResponse.resolve(success({ ...imageMetadata, tags: ['新建议'], topics: [] }));
    await newRequest;
    expect(state.suggestion.value?.tags).toEqual(['新建议']);
  });

  it('取消进行中再次重置，取消失败不会让 idle 变为 error', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    const cancellation = deferred<Result<null>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelSuggestion).mockReturnValueOnce(cancellation.promise);
    const request = state.request('当前正文', '', [], [], draftId);
    const cancel = state.cancel();
    state.reset();
    cancellation.resolve(failure('UNAVAILABLE', '已离开后的错误'));
    await cancel;
    pending.resolve(success({ ...imageMetadata, tags: ['迟到'], topics: [] }));
    await request;
    expect(state.phase.value).toBe('idle');
    expect(state.error.value).toBe('');
  });

  it('主进程主动取消不显示业务错误；作用域销毁取消自己的请求且拒绝新调用', async () => {
    const first = setup();
    vi.mocked(first.ai.suggest).mockResolvedValueOnce(failure('AI_CANCELLED', '已取消'));
    await first.state.request('当前正文', '', [], [], draftId);
    expect(first.state.phase.value).toBe('idle');
    expect(first.state.error.value).toBe('');

    const { ai, state, scope } = setup();
    const pending = deferred<Result<AiSuggestion>>();
    vi.mocked(ai.suggest).mockReturnValueOnce(pending.promise);
    const request = state.request('当前正文', '', [], [], draftId);
    const id = state.requestId.value;
    scope.stop();
    await settleResponses();
    expect(ai.cancelSuggestion).toHaveBeenCalledWith(id);
    pending.resolve(success({ ...imageMetadata, tags: ['卸载后的结果'], topics: [] }));
    await request;
    expect(state.suggestion.value).toBeNull();
    await state.request('新请求', '', [], [], draftId);
    expect(ai.suggest).toHaveBeenCalledTimes(1);
  });
});
