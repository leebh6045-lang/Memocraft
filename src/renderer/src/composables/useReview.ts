import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import type { Note } from '../../../domain/note';
import {
  addDays,
  isFuture,
  isoWeekNumber,
  localDateToUtcStart,
  localToday,
  periodRange,
  shiftPeriod,
} from '../../../domain/time-range';
import type { AiPeriodSummary, AiPeriodType } from '../../../shared/ai';
import type { MemocraftApi } from '../../../shared/contracts';
import type { ErrorCode } from '../../../shared/errors';

export type ReviewPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface ReviewPeriodOption {
  startDate: string;
  label: string;
  isCurrent: boolean;
}

export interface ReviewState {
  phase: Ref<ReviewPhase>;
  periodType: Ref<AiPeriodType>;
  startDate: Ref<string>;
  endDate: Ref<string>;
  summary: Ref<AiPeriodSummary | null>;
  error: Ref<string>;
  errorCode: Ref<ErrorCode | null>;
  canGoNext: Ref<boolean>;
  availablePeriods: ComputedRef<ReviewPeriodOption[]>;
  busy: Ref<boolean>;
  load(): Promise<void>;
  setPeriodType(type: AiPeriodType): void;
  prevPeriod(): void;
  nextPeriod(): void;
  jumpToPeriod(startDate: string): void;
  regenerate(): void;
  retry(): void;
  cancel(): Promise<void>;
  reset(): void;
}

/** 父层持有回顾现场；数据库是缓存唯一来源，本地手记只用于避免空期加载闪烁。 */
export function useReview(
  api: Pick<MemocraftApi, 'ai'>,
  currentNotes: () => readonly Note[],
  now: () => Date = () => new Date(),
): ReviewState {
  const initial = periodRange('week', localToday(now()));
  const currentDate = ref(localToday(now()));
  const phase = ref<ReviewPhase>('idle');
  const periodType = ref<AiPeriodType>('week');
  const startDate = ref(initial.startDate);
  const endDate = ref(initial.endDate);
  const summary = ref<AiPeriodSummary | null>(null);
  const error = ref('');
  const errorCode = ref<ErrorCode | null>(null);
  const busy = ref(false);
  const canGoNext = computed(
    () => !isFuture(shiftPeriod(periodType.value, startDate.value, 1).startDate, currentDate.value),
  );
  const availablePeriods = computed<ReviewPeriodOption[]>(() => {
    const type = periodType.value;
    const today = currentDate.value;
    // 周号属于 ISO 年；与今天公历年不同就显式标年，避免一月初把去年的周误认为今年。
    const currentYear = Number(today.slice(0, 4));
    let range = periodRange(type, today);
    const options: ReviewPeriodOption[] = [];
    const monthDay = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
    for (let index = 0; index < 12; index += 1) {
      let label: string;
      if (type === 'week') {
        const { year, week } = isoWeekNumber(range.startDate);
        label = `${year === currentYear ? '' : `${year}年`}第${week}周（${monthDay(range.startDate)}–${monthDay(range.endDate)}）`;
      } else {
        const year = Number(range.startDate.slice(0, 4));
        label = `${year === currentYear ? '' : `${year}年`}${Number(range.startDate.slice(5, 7))}月`;
      }
      options.push({ startDate: range.startDate, label, isCurrent: index === 0 });
      if (index < 11) range = shiftPeriod(type, range.startDate, -1);
    }
    return options;
  });
  const cancellations = new Set<Promise<void>>();
  let active: { id: string; version: number } | null = null;
  let version = 0;
  let disposed = false;
  let dateRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** 日界只刷新列表边界，不切走当前回顾或自动调用模型；唤醒窗口时再校准一次。 */
  function syncCurrentDate(): void {
    if (disposed) return;
    const instant = now();
    currentDate.value = localToday(instant);
    clearTimeout(dateRefreshTimer);
    const midnight = new Date(instant.getFullYear(), instant.getMonth(), instant.getDate() + 1);
    dateRefreshTimer = setTimeout(
      syncCurrentDate,
      Math.max(1, midnight.getTime() - instant.getTime()),
    );
  }
  syncCurrentDate();
  if (typeof window !== 'undefined') window.addEventListener('focus', syncCurrentDate);

  function clearFeedback(): void {
    phase.value = 'idle';
    summary.value = null;
    error.value = '';
    errorCode.value = null;
  }

  /** 发出取消即撤销展示资格；主进程接替链负责等待旧请求和缓存写入排空。 */
  function invalidate(): void {
    version += 1;
    busy.value = false;
    const flight = active;
    active = null;
    if (!flight) return;
    const operation = Promise.resolve().then(async () => {
      try {
        await api.ai.cancelPeriodSummary(flight.id);
      } catch {
        // 离开的现场不显示取消桥接错误；关闭与恢复仍由主进程 stopAndDrain 兜底。
      }
    });
    cancellations.add(operation);
    void operation.then(() => cancellations.delete(operation));
  }

  function showError(code: ErrorCode, message: string): void {
    // 刷新失败保留上次结果与生成时间，让用户可以继续阅读并再次重试。
    error.value = message;
    errorCode.value = code;
    phase.value = 'error';
  }

  function hasPeriodNotes(start: string, end: string): boolean {
    const startAt = new Date(localDateToUtcStart(start)).getTime();
    const endBefore = new Date(localDateToUtcStart(addDays(end, 1))).getTime();
    return currentNotes().some((note) => {
      const createdAt = new Date(note.createdAt).getTime();
      return createdAt >= startAt && createdAt < endBefore;
    });
  }

  async function request(regenerate: boolean): Promise<void> {
    if (disposed || busy.value) return;
    const requestVersion = ++version;
    const type = periodType.value;
    const start = startDate.value;
    const end = endDate.value;
    busy.value = true;
    error.value = '';
    errorCode.value = null;
    phase.value = summary.value ? 'ready' : 'idle';
    const isCurrent = () => !disposed && version === requestVersion;
    try {
      // 未配置时直接引导，不先进入 loading；设置和本地空期检查同样防重复提交。
      const settings = await api.ai.loadSettings();
      if (!isCurrent()) return;
      if (!settings.ok) {
        showError(settings.error.code, settings.error.message);
        return;
      }
      if (!settings.value.keyConfigured) {
        showError('AI_NOT_CONFIGURED', '请先在设置页配置 DeepSeek API Key，才能生成回顾。');
        return;
      }
      if (hasPeriodNotes(start, end)) phase.value = 'loading';
      const flight = { id: crypto.randomUUID(), version: requestVersion };
      active = flight;
      // 即使本地空期仍查询主进程：持久缓存可能包含已删除手记的旧总结，不自动失效。
      const result = await api.ai.summarizePeriod({
        requestId: flight.id,
        periodType: type,
        startDate: start,
        regenerate,
      });
      if (!isCurrent() || active !== flight) return;
      if (!result.ok) {
        if (result.error.code === 'AI_CANCELLED') phase.value = summary.value ? 'ready' : 'idle';
        else showError(result.error.code, result.error.message);
        return;
      }
      summary.value = result.value.noteCount ? result.value : null;
      phase.value = result.value.noteCount ? 'ready' : 'empty';
    } catch {
      if (isCurrent()) showError('UNAVAILABLE', '回顾暂时不可用，请重试。');
    } finally {
      if (isCurrent()) {
        active = null;
        busy.value = false;
      }
    }
  }

  async function load(): Promise<void> {
    syncCurrentDate();
    // 成功缓存不自动失效；空期没有落库，新增本期手记后返回页面应能首次生成。
    if (phase.value === 'ready') return;
    if (phase.value === 'empty' && !hasPeriodNotes(startDate.value, endDate.value)) return;
    await request(false);
  }

  function changePeriod(type: AiPeriodType, anchorDate: string): void {
    if (disposed) return;
    invalidate();
    const range = periodRange(type, anchorDate);
    periodType.value = type;
    startDate.value = range.startDate;
    endDate.value = range.endDate;
    clearFeedback();
    void load();
  }

  function setPeriodType(type: AiPeriodType): void {
    syncCurrentDate();
    if (type === periodType.value) return;
    changePeriod(type, currentDate.value);
  }

  function prevPeriod(): void {
    changePeriod(periodType.value, shiftPeriod(periodType.value, startDate.value, -1).startDate);
  }

  function nextPeriod(): void {
    syncCurrentDate();
    if (!canGoNext.value) return;
    changePeriod(periodType.value, shiftPeriod(periodType.value, startDate.value, 1).startDate);
  }

  /** 仅接受列表里已知的规范起点，重复选择不取消现场或重复计费。 */
  function jumpToPeriod(date: string): void {
    syncCurrentDate();
    if (
      date === startDate.value ||
      !availablePeriods.value.some((period) => period.startDate === date)
    )
      return;
    changePeriod(periodType.value, date);
  }

  function regenerate(): void {
    void request(true);
  }

  function retry(): void {
    void request(false);
  }

  async function cancel(): Promise<void> {
    const wasBusy = busy.value;
    invalidate();
    if (wasBusy) phase.value = summary.value ? 'ready' : 'idle';
    await Promise.all([...cancellations]);
  }

  function reset(): void {
    if (disposed) return;
    invalidate();
    clearFeedback();
  }

  onScopeDispose(() => {
    invalidate();
    disposed = true;
    clearTimeout(dateRefreshTimer);
    if (typeof window !== 'undefined') window.removeEventListener('focus', syncCurrentDate);
  });

  return {
    phase,
    periodType,
    startDate,
    endDate,
    summary,
    error,
    errorCode,
    canGoNext,
    availablePeriods,
    busy,
    load,
    setPeriodType,
    prevPeriod,
    nextPeriod,
    jumpToPeriod,
    regenerate,
    retry,
    cancel,
    reset,
  };
}
