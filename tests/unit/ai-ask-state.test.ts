import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiAsk } from '../../src/renderer/src/composables/useAiAsk';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import type { AiAnswer, AiApi } from '../../src/shared/ai';
import type { ErrorCode, Result } from '../../src/shared/errors';

const firstAnswer: AiAnswer = {
  answer: 'ref 用于保存单值，reactive 用于响应式对象。[1]',
  sources: [{ index: 1, noteId: 'note-1', title: '响应式记录' }],
  matchedNotes: 1,
};
function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** 由测试控制 IPC 结算时机，观察新旧现场隔离，不访问网络。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟请求未初始化');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const scopes: EffectScope[] = [];
function setup() {
  const scope = effectScope();
  scopes.push(scope);
  const ai = {
    ...disconnectedApi.ai,
    ask: vi.fn<AiApi['ask']>(async () => success(firstAnswer)),
    cancelAsk: vi.fn<AiApi['cancelAsk']>(async () => success(null)),
  };
  const state = scope.run(() => useAiAsk({ ai }));
  if (!state) throw new Error('问答作用域未创建');
  return { ai, state, scope };
}

async function settleResponses() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.stop();
  await settleResponses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AI 搜索问答现场', () => {
  it('三字符与空白不请求，四字符在 600 ms 后请求并保存去空白的问题', async () => {
    const { ai, state } = setup();
    expect(state.phase.value).toBe('idle');
    state.schedule('  三字符  ');
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.ask).not.toHaveBeenCalled();
    expect(state.phase.value).toBe('idle');
    state.schedule('  四个字符  ');
    expect(state.phase.value).toBe('loading');
    await vi.advanceTimersByTimeAsync(599);
    expect(ai.ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ai.ask.mock.calls[0]?.[0]).toMatchObject({ question: '四个字符' });
    expect(state.phase.value).toBe('ready');
    expect(state.answerQuestion.value).toBe('四个字符');
  });

  it('快速连续输入只处理最终问题，同词重复 schedule 不改变防抖期限', async () => {
    const { ai, state } = setup();
    state.schedule('最初问题');
    await vi.advanceTimersByTimeAsync(300);
    state.schedule('最新问题');
    await vi.advanceTimersByTimeAsync(300);
    state.schedule('  最新问题 ');
    await vi.advanceTimersByTimeAsync(299);
    expect(ai.ask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(ai.ask.mock.calls[0]?.[0]).toMatchObject({ question: '最新问题' });
  });

  it('本次面板内重搜命中缓存，短词不清缓存；外部 reset 后重新请求', async () => {
    const { ai, state } = setup();
    state.schedule('响应式区别');
    await vi.advanceTimersByTimeAsync(600);
    state.schedule('别的问题');
    await vi.advanceTimersByTimeAsync(600);
    state.schedule('响应式区别');
    expect(state.phase.value).toBe('ready');
    expect(state.answer.value).toEqual(firstAnswer);
    expect(ai.ask).toHaveBeenCalledTimes(2);
    state.schedule('短词');
    state.schedule('响应式区别');
    expect(ai.ask).toHaveBeenCalledTimes(2);
    state.reset();
    expect(state.phase.value).toBe('idle');
    state.schedule('响应式区别');
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.ask).toHaveBeenCalledTimes(3);
  });

  it('缓存最多保留二十条，最早成功问题被淘汰', async () => {
    const { ai, state } = setup();
    for (let index = 0; index < 21; index += 1) {
      state.schedule(`检索问题${index}`);
      await vi.advanceTimersByTimeAsync(600);
    }
    state.schedule('检索问题1');
    expect(state.phase.value).toBe('ready');
    expect(ai.ask).toHaveBeenCalledTimes(21);
    state.schedule('检索问题0');
    expect(state.phase.value).toBe('loading');
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.ask).toHaveBeenCalledTimes(22);
  });

  it('本地无命中为 empty；有回答但来源空仍为 ready', async () => {
    const { ai, state } = setup();
    ai.ask.mockResolvedValueOnce(success({ answer: '', sources: [], matchedNotes: 0 }));
    state.schedule('没有相关记录');
    await vi.advanceTimersByTimeAsync(600);
    expect(state.phase.value).toBe('empty');
    state.expand();
    expect(state.expanded.value).toBe(false);
    ai.ask.mockResolvedValueOnce(
      success({ answer: '无可引用的来源。', sources: [], matchedNotes: 2 }),
    );
    state.schedule('来源越界问题');
    await vi.advanceTimersByTimeAsync(600);
    expect(state.phase.value).toBe('ready');
    state.expand();
    expect(state.expanded.value).toBe(true);
    state.collapse();
    expect(state.expanded.value).toBe(false);
  });

  it.each(['AI_NOT_CONFIGURED', 'AI_CANCELLED', 'CONFLICT'] as const)(
    '%s 静默清理现场，不为未配置或已离开的问答显示错误',
    async (code) => {
      const { ai, state } = setup();
      ai.ask.mockResolvedValueOnce(failure(code, '不应显示的错误'));
      state.schedule('搜索问答问题');
      await vi.advanceTimersByTimeAsync(600);
      expect(state.phase.value).toBe('idle');
      expect(state.error.value).toBe('');
      expect(state.errorCode.value).toBeNull();
    },
  );

  it.each([
    'AI_AUTH',
    'AI_BALANCE',
    'AI_RATE_LIMIT',
    'AI_NETWORK',
    'AI_TIMEOUT',
    'AI_RESPONSE',
    'STORAGE',
  ] as const)('%s 明确呈现业务失败，显式重试重新调用', async (code) => {
    const { ai, state } = setup();
    ai.ask.mockResolvedValueOnce(failure(code, '请处理后重试。'));
    state.schedule('搜索问答问题');
    await vi.advanceTimersByTimeAsync(600);
    expect(state.phase.value).toBe('error');
    expect(state.error.value).toBe('请处理后重试。');
    expect(state.errorCode.value).toBe(code);
    state.schedule('搜索问答问题');
    expect(ai.ask).toHaveBeenCalledTimes(1);
    state.retry();
    state.retry();
    await settleResponses();
    expect(state.phase.value).toBe('ready');
    expect(state.error.value).toBe('');
    expect(ai.ask).toHaveBeenCalledTimes(2);
  });

  it('桥接异常不泄露原始内容，仍可重试', async () => {
    const { ai, state } = setup();
    ai.ask.mockRejectedValueOnce(new Error('secret /private/path'));
    state.schedule('搜索问答问题');
    await vi.advanceTimersByTimeAsync(600);
    expect(state.error.value).toBe('AI 回答暂时不可用，请重试。');
    expect(state.errorCode.value).toBe('UNAVAILABLE');
    state.retry();
    await settleResponses();
    expect(state.phase.value).toBe('ready');
  });

  it('新问题取消旧请求，取消回执不阻塞下一问，迟到回答不覆盖新现场', async () => {
    const { ai, state } = setup();
    const oldResponse = deferred<Result<AiAnswer>>();
    const newResponse = deferred<Result<AiAnswer>>();
    const cancellation = deferred<Result<null>>();
    ai.ask.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    ai.cancelAsk.mockReturnValueOnce(cancellation.promise);
    state.schedule('旧搜索问题');
    await vi.advanceTimersByTimeAsync(600);
    const oldId = ai.ask.mock.calls[0]?.[0].requestId;
    state.schedule('新搜索问题');
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.cancelAsk).toHaveBeenCalledWith(oldId);
    expect(ai.ask).toHaveBeenCalledTimes(2);
    oldResponse.resolve(success({ ...firstAnswer, answer: '迟到旧回答' }));
    await settleResponses();
    expect(state.phase.value).toBe('loading');
    expect(state.answer.value).toBeNull();
    cancellation.resolve(success(null));
    newResponse.resolve(success({ ...firstAnswer, answer: '新回答' }));
    await settleResponses();
    expect(state.answer.value?.answer).toBe('新回答');
    expect(state.answerQuestion.value).toBe('新搜索问题');
  });

  it('取消立即清空展示并等待自己的回执，迟到失败不恢复错误', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiAnswer>>();
    const cancellation = deferred<Result<null>>();
    ai.ask.mockReturnValueOnce(pending.promise);
    ai.cancelAsk.mockReturnValueOnce(cancellation.promise);
    state.schedule('搜索问答问题');
    await vi.advanceTimersByTimeAsync(600);
    let settled = false;
    const operation = state.cancel().then(() => {
      settled = true;
    });
    await settleResponses();
    expect(state.phase.value).toBe('idle');
    expect(settled).toBe(false);
    pending.resolve(failure('AI_NETWORK', '离开后网络错误'));
    cancellation.resolve(success(null));
    await operation;
    expect(settled).toBe(true);
    expect(state.error.value).toBe('');
  });

  it('reset 清防抖与展开，取消失败和旧响应不污染后续问题', async () => {
    const { ai, state } = setup();
    state.schedule('尚未发送问题');
    state.reset();
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.ask).not.toHaveBeenCalled();
    const pending = deferred<Result<AiAnswer>>();
    ai.ask.mockReturnValueOnce(pending.promise);
    ai.cancelAsk.mockRejectedValueOnce(new Error('cancel secret'));
    state.schedule('旧搜索问题');
    await vi.advanceTimersByTimeAsync(600);
    state.reset();
    state.schedule('新搜索问题');
    await vi.advanceTimersByTimeAsync(600);
    pending.resolve(failure('AI_TIMEOUT', '旧错误'));
    await settleResponses();
    expect(state.phase.value).toBe('ready');
    expect(state.answerQuestion.value).toBe('新搜索问题');
    expect(state.error.value).toBe('');
    state.expand();
    state.reset();
    expect(state.expanded.value).toBe(false);
    expect(state.answerQuestion.value).toBeNull();
  });

  it('作用域销毁取消在途请求，拒绝再请求和迟到结果', async () => {
    const { ai, state, scope } = setup();
    const pending = deferred<Result<AiAnswer>>();
    ai.ask.mockReturnValueOnce(pending.promise);
    state.schedule('搜索问答问题');
    await vi.advanceTimersByTimeAsync(600);
    const id = ai.ask.mock.calls[0]?.[0].requestId;
    scope.stop();
    await settleResponses();
    expect(ai.cancelAsk).toHaveBeenCalledWith(id);
    pending.resolve(success(firstAnswer));
    await settleResponses();
    expect(state.answer.value).toBeNull();
    state.schedule('销毁之后问题');
    state.retry();
    await vi.advanceTimersByTimeAsync(600);
    expect(ai.ask).toHaveBeenCalledTimes(1);
  });
});
