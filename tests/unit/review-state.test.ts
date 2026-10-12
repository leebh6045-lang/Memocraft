import { effectScope, type EffectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../../src/domain/note';
import { periodRange } from '../../src/domain/time-range';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import { useReview } from '../../src/renderer/src/composables/useReview';
import {
  DEFAULT_AI_BASE_URL,
  type AiApi,
  type AiPeriodSummary,
  type AiSettings,
} from '../../src/shared/ai';
import type { ErrorCode, Result } from '../../src/shared/errors';

const today = () => new Date('2026-10-11T12:00:00');
const settings: AiSettings = {
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseUrl: DEFAULT_AI_BASE_URL,
  keyConfigured: true,
  encryptionAvailable: true,
};
const firstSummary: AiPeriodSummary = {
  periodType: 'week',
  startDate: '2026-10-05',
  endDate: '2026-10-11',
  summary: '本周记录了响应式状态和组件边界。',
  suggestions: ['可以把组件边界的手记收录到 Vue 归纳。'],
  noteCount: 1,
  generatedAt: '2026-10-11T04:00:00.000Z',
};

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** 控制主进程结算顺序，验证导航、关闭和旧响应之间的竞态。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟请求尚未初始化');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function note(createdAt = '2026-10-07T12:00:00'): Note {
  return {
    id: 'note-1',
    revision: 1,
    title: '响应式记录',
    body: 'ref 保存单值状态。',
    category: 'insight',
    tags: [],
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(createdAt).toISOString(),
  };
}

const scopes: EffectScope[] = [];
function setup(notes: Note[] = [note()], now = today) {
  const scope = effectScope();
  scopes.push(scope);
  const ai = {
    ...disconnectedApi.ai,
    loadSettings: vi.fn<AiApi['loadSettings']>(async () => success(settings)),
    summarizePeriod: vi.fn<AiApi['summarizePeriod']>(async (input) =>
      success({
        ...firstSummary,
        periodType: input.periodType,
        ...periodRange(input.periodType, input.startDate),
      }),
    ),
    cancelPeriodSummary: vi.fn<AiApi['cancelPeriodSummary']>(async () => success(null)),
  };
  const state = scope.run(() => useReview({ ai }, () => notes, now));
  if (!state) throw new Error('回顾作用域未创建');
  return { ai, state, scope, notes };
}

async function settleResponses(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(async () => {
  for (const scope of scopes.splice(0)) scope.stop();
  await settleResponses();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('回顾现场', () => {
  it('初始为当前自然周，首次 load 生成；切页回来保留成功内容', async () => {
    const { ai, state } = setup();
    expect(state.periodType.value).toBe('week');
    expect(state.startDate.value).toBe('2026-10-05');
    expect(state.endDate.value).toBe('2026-10-11');
    expect(state.canGoNext.value).toBe(false);
    expect(state.phase.value).toBe('idle');
    expect(ai.summarizePeriod).not.toHaveBeenCalled();
    await state.load();
    expect(state.phase.value).toBe('ready');
    expect(state.summary.value).toEqual(firstSummary);
    expect(ai.summarizePeriod.mock.calls[0]?.[0]).toMatchObject({
      periodType: 'week',
      startDate: '2026-10-05',
      regenerate: false,
    });
    await state.cancel();
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(state.summary.value).toEqual(firstSummary);
  });

  it('先检查配置，不闪 loading；未配置引导且不发总结请求', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiSettings>>();
    ai.loadSettings.mockReturnValueOnce(pending.promise);
    const loading = state.load();
    expect(state.busy.value).toBe(true);
    expect(state.phase.value).toBe('idle');
    state.regenerate();
    state.retry();
    expect(ai.loadSettings).toHaveBeenCalledTimes(1);
    pending.resolve(success({ ...settings, keyConfigured: false }));
    await loading;
    expect(state.busy.value).toBe(false);
    expect(state.phase.value).toBe('error');
    expect(state.errorCode.value).toBe('AI_NOT_CONFIGURED');
    expect(ai.summarizePeriod).not.toHaveBeenCalled();
    await state.load();
    expect(state.phase.value).toBe('ready');
  });

  it('配置读取失败不进入骨架屏，桥接异常不会泄露原始内容', async () => {
    const { ai, state } = setup();
    ai.loadSettings.mockResolvedValueOnce(failure('AI_CREDENTIAL', '本机凭据暂时不可用。'));
    await state.load();
    expect(state.error.value).toBe('本机凭据暂时不可用。');
    expect(ai.summarizePeriod).not.toHaveBeenCalled();
    ai.loadSettings.mockRejectedValueOnce(new Error('/private/secret key'));
    state.retry();
    await settleResponses();
    expect(state.errorCode.value).toBe('UNAVAILABLE');
    expect(state.error.value).toBe('回顾暂时不可用，请重试。');
  });

  it('空期仍读取主进程缓存，但始终不闪骨架；空结果返回后保留现场', async () => {
    const { ai, state } = setup([]);
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    const loading = state.load();
    await settleResponses();
    expect(state.phase.value).toBe('idle');
    expect(state.busy.value).toBe(true);
    pending.resolve(success({ ...firstSummary, summary: '', suggestions: [], noteCount: 0 }));
    await loading;
    expect(state.phase.value).toBe('empty');
    expect(state.summary.value).toBeNull();
    await state.cancel();
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });

  it('本地已无手记时仍可展示持久缓存，不使旧总结自动失效', async () => {
    const { state } = setup([]);
    await state.load();
    expect(state.phase.value).toBe('ready');
    expect(state.summary.value?.noteCount).toBe(1);
  });

  it('离开空期后新增本期手记，返回页面首次生成；已有结果不随新增手记自动失效', async () => {
    const { ai, state, notes } = setup([]);
    ai.summarizePeriod.mockResolvedValueOnce(
      success({ ...firstSummary, summary: '', suggestions: [], noteCount: 0 }),
    );
    await state.load();
    expect(state.phase.value).toBe('empty');
    await state.cancel();
    notes.push(note('2026-09-28T12:00:00'));
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(state.phase.value).toBe('empty');
    notes.push(note());
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(2);
    expect(state.phase.value).toBe('ready');
    expect(state.summary.value).toEqual(firstSummary);
    await state.cancel();
    notes.push(note('2026-10-11T18:00:00'));
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(2);
    expect(state.summary.value).toEqual(firstSummary);
  });

  it.each([
    ['2026-10-05T00:00:00', true],
    ['2026-10-11T23:59:59.999', true],
    ['2026-10-04T23:59:59.999', false],
    ['2026-10-12T00:00:00', false],
  ])('以本地日期的 UTC 半开区间判断 %s，loading 为 %s', async (createdAt, hasNotes) => {
    const { ai, state } = setup([note(String(createdAt))]);
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    const loading = state.load();
    await settleResponses();
    expect(state.phase.value === 'loading').toBe(hasNotes);
    pending.resolve(success(firstSummary));
    await loading;
  });

  it('按月切换重置到当前月；前后导航跨年正确且拒绝未来', async () => {
    const { ai, state } = setup([], () => new Date('2027-01-03T12:00:00'));
    expect(state.startDate.value).toBe('2026-12-28');
    expect(state.endDate.value).toBe('2027-01-03');
    state.nextPeriod();
    expect(ai.loadSettings).not.toHaveBeenCalled();
    state.prevPeriod();
    await settleResponses();
    expect(state.startDate.value).toBe('2026-12-21');
    expect(state.canGoNext.value).toBe(true);
    state.setPeriodType('month');
    await settleResponses();
    expect(state.startDate.value).toBe('2027-01-01');
    expect(state.endDate.value).toBe('2027-01-31');
    expect(state.canGoNext.value).toBe(false);
    state.prevPeriod();
    await settleResponses();
    expect(state.startDate.value).toBe('2026-12-01');
    state.nextPeriod();
    await settleResponses();
    expect(state.startDate.value).toBe('2027-01-01');
    state.setPeriodType('month');
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(4);
  });

  it('切换周期取消旧请求；迟到旧结果及取消回执不会覆盖新结果', async () => {
    const { ai, state } = setup();
    const oldResponse = deferred<Result<AiPeriodSummary>>();
    const cancellation = deferred<Result<null>>();
    ai.summarizePeriod.mockReturnValueOnce(oldResponse.promise);
    ai.cancelPeriodSummary.mockReturnValueOnce(cancellation.promise);
    const oldLoad = state.load();
    await settleResponses();
    const oldId = ai.summarizePeriod.mock.calls[0]?.[0].requestId;
    state.setPeriodType('month');
    await settleResponses();
    expect(ai.cancelPeriodSummary).toHaveBeenCalledWith(oldId);
    expect(state.summary.value?.periodType).toBe('month');
    oldResponse.resolve(success({ ...firstSummary, summary: '迟到旧结果' }));
    cancellation.resolve(success(null));
    await oldLoad;
    await settleResponses();
    expect(state.summary.value?.periodType).toBe('month');
    expect(state.summary.value?.summary).toBe(firstSummary.summary);
  });

  it('设置检查中的导航让旧检查失效，只为新周期发送总结', async () => {
    const { ai, state } = setup();
    const oldSettings = deferred<Result<AiSettings>>();
    ai.loadSettings.mockReturnValueOnce(oldSettings.promise);
    const oldLoad = state.load();
    state.prevPeriod();
    await settleResponses();
    oldSettings.resolve(success(settings));
    await oldLoad;
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(state.summary.value?.startDate).toBe('2026-09-28');
  });

  it('重生成失败保留上次内容与时间；重试使用缓存路径且防重复计费', async () => {
    const { ai, state } = setup();
    await state.load();
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    state.regenerate();
    state.regenerate();
    state.retry();
    await settleResponses();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(2);
    expect(ai.summarizePeriod.mock.calls[1]?.[0].regenerate).toBe(true);
    expect(state.summary.value).toEqual(firstSummary);
    pending.resolve(failure('AI_NETWORK', '网络连接失败，请重试。'));
    await settleResponses();
    expect(state.phase.value).toBe('error');
    expect(state.summary.value).toEqual(firstSummary);
    state.retry();
    state.retry();
    await settleResponses();
    expect(ai.summarizePeriod.mock.calls[2]?.[0].regenerate).toBe(false);
    expect(state.phase.value).toBe('ready');
    expect(state.error.value).toBe('');
  });

  it('取消等待自己的回执并保留已显示结果，迟到错误不污染现场', async () => {
    const { ai, state } = setup();
    await state.load();
    const pending = deferred<Result<AiPeriodSummary>>();
    const cancellation = deferred<Result<null>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    ai.cancelPeriodSummary.mockReturnValueOnce(cancellation.promise);
    state.regenerate();
    await settleResponses();
    let settled = false;
    const cancelling = state.cancel().then(() => {
      settled = true;
    });
    await settleResponses();
    expect(settled).toBe(false);
    expect(state.phase.value).toBe('ready');
    expect(state.summary.value).toEqual(firstSummary);
    pending.resolve(failure('AI_TIMEOUT', '迟到旧错误'));
    cancellation.resolve(success(null));
    await cancelling;
    expect(state.error.value).toBe('');
  });

  it('无结果在途取消后回 idle；返回页重新 load 可续生成', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    const firstLoad = state.load();
    await settleResponses();
    await state.cancel();
    expect(state.phase.value).toBe('idle');
    await state.load();
    pending.resolve(success({ ...firstSummary, summary: '迟到的已取消结果' }));
    await firstLoad;
    expect(state.summary.value?.summary).toBe(firstSummary.summary);
  });

  it('reset 清除旧库结果且保持周期；所有未结算取消都纳入 cancel 等待', async () => {
    const { ai, state } = setup();
    await state.load();
    const pending = deferred<Result<AiPeriodSummary>>();
    const cancellation = deferred<Result<null>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    ai.cancelPeriodSummary.mockReturnValueOnce(cancellation.promise);
    state.regenerate();
    await settleResponses();
    state.reset();
    expect(state.summary.value).toBeNull();
    expect(state.startDate.value).toBe('2026-10-05');
    let settled = false;
    const draining = state.cancel().then(() => {
      settled = true;
    });
    await settleResponses();
    expect(settled).toBe(false);
    cancellation.resolve(success(null));
    await draining;
    pending.resolve(success(firstSummary));
    await settleResponses();
    expect(state.summary.value).toBeNull();
    await state.load();
    expect(state.phase.value).toBe('ready');
  });

  it('作用域销毁取消请求，拒绝迟到结果和再次生成', async () => {
    const { ai, state, scope } = setup();
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    const loading = state.load();
    await settleResponses();
    const id = ai.summarizePeriod.mock.calls[0]?.[0].requestId;
    scope.stop();
    await settleResponses();
    expect(ai.cancelPeriodSummary).toHaveBeenCalledWith(id);
    pending.resolve(success(firstSummary));
    await loading;
    expect(state.summary.value).toBeNull();
    state.retry();
    state.regenerate();
    state.prevPeriod();
    await state.load();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });
});

describe('回顾周期选择', () => {
  it('周列表固定为最近12个自然周，倒序且只有本周标记为当前', () => {
    const { ai, state } = setup();
    expect(state.availablePeriods.value.map((period) => period.startDate)).toEqual([
      '2026-10-05',
      '2026-09-28',
      '2026-09-21',
      '2026-09-14',
      '2026-09-07',
      '2026-08-31',
      '2026-08-24',
      '2026-08-17',
      '2026-08-10',
      '2026-08-03',
      '2026-07-27',
      '2026-07-20',
    ]);
    expect(state.availablePeriods.value[0]).toEqual({
      startDate: '2026-10-05',
      label: '第41周（10月5日–10月11日）',
      isCurrent: true,
    });
    expect(state.availablePeriods.value.slice(1).every((period) => !period.isCurrent)).toBe(true);
    expect(ai.summarizePeriod).not.toHaveBeenCalled();
  });

  it('跨ISO年周标签采用周所属年份，仍只列出最近12周', () => {
    const { state } = setup([], () => new Date('2027-01-03T12:00:00'));
    expect(state.availablePeriods.value).toHaveLength(12);
    expect(state.availablePeriods.value[0]).toEqual({
      startDate: '2026-12-28',
      label: '2026年第53周（12月28日–1月3日）',
      isCurrent: true,
    });
    expect(state.availablePeriods.value[1]).toMatchObject({
      startDate: '2026-12-21',
      label: '2026年第52周（12月21日–12月27日）',
      isCurrent: false,
    });
    expect(state.availablePeriods.value.every((period) => period.startDate <= '2026-12-28')).toBe(
      true,
    );
  });

  it('月列表固定为最近12个月，跨年标签完整；闰年二月跳转包含29日', async () => {
    const { state } = setup([], () => new Date('2024-03-15T12:00:00'));
    state.setPeriodType('month');
    await settleResponses();
    expect(state.availablePeriods.value.map((period) => period.startDate)).toEqual([
      '2024-03-01',
      '2024-02-01',
      '2024-01-01',
      '2023-12-01',
      '2023-11-01',
      '2023-10-01',
      '2023-09-01',
      '2023-08-01',
      '2023-07-01',
      '2023-06-01',
      '2023-05-01',
      '2023-04-01',
    ]);
    expect(state.availablePeriods.value[0]).toEqual({
      startDate: '2024-03-01',
      label: '3月',
      isCurrent: true,
    });
    expect(state.availablePeriods.value[1]?.label).toBe('2月');
    expect(state.availablePeriods.value[3]?.label).toBe('2023年12月');
    expect(state.availablePeriods.value.slice(1).every((period) => !period.isCurrent)).toBe(true);
    state.jumpToPeriod('2024-02-01');
    await settleResponses();
    expect(state.startDate.value).toBe('2024-02-01');
    expect(state.endDate.value).toBe('2024-02-29');
  });

  it.each([
    'not-a-date',
    '2026-02-30',
    '2026-9-28',
    ' 2026-09-28 ',
    '2026-09-29',
    '2026-10-12',
    '2026-07-13',
    '2026-10-05',
  ])('非法、未来、列表外或当前选中日期 %s 均不检查配置、不请求总结', async (startDate) => {
    const { ai, state } = setup();
    expect(() => state.jumpToPeriod(startDate)).not.toThrow();
    await settleResponses();
    expect(state.startDate.value).toBe('2026-10-05');
    expect(state.phase.value).toBe('idle');
    expect(ai.loadSettings).not.toHaveBeenCalled();
    expect(ai.summarizePeriod).not.toHaveBeenCalled();
    expect(ai.cancelPeriodSummary).not.toHaveBeenCalled();
  });

  it('选择同一期不重复请求，也不取消正在生成的该期请求', async () => {
    const { ai, state } = setup();
    const pending = deferred<Result<AiPeriodSummary>>();
    ai.summarizePeriod.mockReturnValueOnce(pending.promise);
    const loading = state.load();
    await settleResponses();
    state.jumpToPeriod('2026-10-05');
    await settleResponses();
    expect(state.phase.value).toBe('loading');
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(ai.cancelPeriodSummary).not.toHaveBeenCalled();
    pending.resolve(success(firstSummary));
    await loading;
    state.jumpToPeriod('2026-10-05');
    await settleResponses();
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(state.summary.value).toEqual(firstSummary);
  });

  it('选择新周期取消旧请求，迟到结果和取消回执不能覆盖新周期', async () => {
    const { ai, state } = setup();
    const oldResponse = deferred<Result<AiPeriodSummary>>();
    const cancellation = deferred<Result<null>>();
    ai.summarizePeriod.mockReturnValueOnce(oldResponse.promise);
    ai.cancelPeriodSummary.mockReturnValueOnce(cancellation.promise);
    const loading = state.load();
    await settleResponses();
    const oldId = ai.summarizePeriod.mock.calls[0]?.[0].requestId;
    state.jumpToPeriod('2026-09-28');
    await settleResponses();
    expect(ai.cancelPeriodSummary).toHaveBeenCalledWith(oldId);
    expect(ai.summarizePeriod.mock.calls[1]?.[0]).toMatchObject({
      periodType: 'week',
      startDate: '2026-09-28',
      regenerate: false,
    });
    expect(state.summary.value?.startDate).toBe('2026-09-28');
    expect(state.phase.value).toBe('ready');
    oldResponse.resolve(success({ ...firstSummary, summary: '迟到旧结果' }));
    cancellation.resolve(success(null));
    await loading;
    await settleResponses();
    expect(state.summary.value?.startDate).toBe('2026-09-28');
    expect(state.summary.value?.summary).toBe(firstSummary.summary);
    expect(state.error.value).toBe('');
  });

  it('配置检查中的选择使旧检查失效，只为最后所选周期生成', async () => {
    const { ai, state } = setup();
    const oldSettings = deferred<Result<AiSettings>>();
    ai.loadSettings.mockReturnValueOnce(oldSettings.promise);
    const loading = state.load();
    state.jumpToPeriod('2026-09-28');
    state.jumpToPeriod('2026-09-21');
    await settleResponses();
    oldSettings.resolve(success(settings));
    await loading;
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(state.summary.value?.startDate).toBe('2026-09-21');
  });

  it('午夜跨周只更新列表与下一期可用性，保留选中期和内容；销毁清理定时器', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T23:59:59.500'));
    const { ai, state, scope } = setup([note()], () => new Date());
    await state.load();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(state.availablePeriods.value[0]?.startDate).toBe('2026-10-05');
    await vi.advanceTimersByTimeAsync(1);
    expect(state.availablePeriods.value[0]).toMatchObject({
      startDate: '2026-10-12',
      isCurrent: true,
    });
    expect(state.availablePeriods.value[1]).toMatchObject({
      startDate: '2026-10-05',
      isCurrent: false,
    });
    expect(state.startDate.value).toBe('2026-10-05');
    expect(state.summary.value).toEqual(firstSummary);
    expect(state.canGoNext.value).toBe(true);
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(ai.cancelPeriodSummary).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    scope.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });

  it('闰年二月末的午夜更新月列表，不自动切换已选择二月或调用AI', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-29T23:59:59.900'));
    const { ai, state } = setup([], () => new Date());
    state.setPeriodType('month');
    await settleResponses();
    const before = state.summary.value;
    expect(state.availablePeriods.value[0]?.startDate).toBe('2024-02-01');
    await vi.advanceTimersByTimeAsync(100);
    expect(state.availablePeriods.value[0]).toEqual({
      startDate: '2024-03-01',
      label: '3月',
      isCurrent: true,
    });
    expect(state.startDate.value).toBe('2024-02-01');
    expect(state.endDate.value).toBe('2024-02-29');
    expect(state.summary.value).toEqual(before);
    expect(state.canGoNext.value).toBe(true);
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });

  it('系统时间跨日但定时器尚未执行时，load、类型切换和选择同步当前日期', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T23:59:59'));
    const { ai, state } = setup([note()], () => new Date());
    await state.load();
    vi.setSystemTime(new Date('2026-10-12T00:00:01'));
    await state.load();
    expect(state.availablePeriods.value[0]?.startDate).toBe('2026-10-12');
    expect(state.startDate.value).toBe('2026-10-05');
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-10-19T00:00:01'));
    state.jumpToPeriod('2026-10-19');
    await settleResponses();
    expect(state.startDate.value).toBe('2026-10-19');
    expect(state.availablePeriods.value[0]?.startDate).toBe('2026-10-19');
    vi.setSystemTime(new Date('2026-11-01T00:00:01'));
    state.setPeriodType('month');
    await settleResponses();
    expect(state.startDate.value).toBe('2026-11-01');
    expect(state.availablePeriods.value[0]).toEqual({
      startDate: '2026-11-01',
      label: '11月',
      isCurrent: true,
    });
    expect(ai.summarizePeriod).toHaveBeenCalledTimes(3);
  });
});
