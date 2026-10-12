import { onScopeDispose, ref, type Ref } from 'vue';
import { AI_ASK_MIN_QUESTION_LENGTH, type AiAnswer } from '../../../shared/ai';
import type { MemocraftApi } from '../../../shared/contracts';
import type { ErrorCode } from '../../../shared/errors';

export type AskPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

export interface AiAskState {
  phase: Ref<AskPhase>;
  answer: Ref<AiAnswer | null>;
  error: Ref<string>;
  errorCode: Ref<ErrorCode | null>;
  answerQuestion: Ref<string | null>;
  expanded: Ref<boolean>;
  schedule(question: string): void;
  retry(): void;
  expand(): void;
  collapse(): void;
  cancel(): Promise<void>;
  reset(): void;
}

const ASK_DEBOUNCE_MS = 600;
const ASK_CACHE_LIMIT = 20;

/** 问答现场归父层所有；面板关闭、手记变更与恢复由父层 reset 清理。 */
export function useAiAsk(api: Pick<MemocraftApi, 'ai'>): AiAskState {
  const phase = ref<AskPhase>('idle');
  const answer = ref<AiAnswer | null>(null);
  const error = ref('');
  const errorCode = ref<ErrorCode | null>(null);
  const answerQuestion = ref<string | null>(null);
  const expanded = ref(false);
  const cache = new Map<string, AiAnswer>();
  const cancellations = new Set<Promise<void>>();
  let currentQuestion = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: { id: string; version: number } | null = null;
  let version = 0;
  let disposed = false;

  function clearFeedback(): void {
    phase.value = 'idle';
    answer.value = null;
    error.value = '';
    errorCode.value = null;
    answerQuestion.value = null;
    expanded.value = false;
  }

  /** 取消先撤销旧应答资格；资源释放不阻塞下一次防抖或污染新的搜索。 */
  function invalidate(): void {
    clearTimeout(timer);
    timer = undefined;
    version += 1;
    const flight = active;
    active = null;
    if (!flight) return;
    const operation = Promise.resolve().then(async () => {
      try {
        await api.ai.cancelAsk(flight.id);
      } catch {
        // 现场已经离开，取消桥接失败不展示旧错误；主进程超时与排空兜底释放。
        return;
      }
    });
    cancellations.add(operation);
    void operation.then(() => cancellations.delete(operation));
  }

  function showAnswer(question: string, value: AiAnswer): void {
    answer.value = value;
    answerQuestion.value = question;
    phase.value = value.matchedNotes === 0 ? 'empty' : 'ready';
  }

  async function request(question: string, requestVersion: number): Promise<void> {
    if (disposed || version !== requestVersion) return;
    const flight = { id: crypto.randomUUID(), version: requestVersion };
    active = flight;
    try {
      const result = await api.ai.ask({ requestId: flight.id, question });
      if (disposed || active !== flight || version !== flight.version) return;
      if (!result.ok) {
        // 高频搜索不为未配置、已取消或被替换的旧现场展示错误行。
        if (
          result.error.code === 'AI_NOT_CONFIGURED' ||
          result.error.code === 'AI_CANCELLED' ||
          result.error.code === 'CONFLICT'
        ) {
          clearFeedback();
          return;
        }
        error.value = result.error.message;
        errorCode.value = result.error.code;
        phase.value = 'error';
        return;
      }
      cache.set(question, result.value);
      if (cache.size > ASK_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      showAnswer(question, result.value);
    } catch {
      if (!disposed && active === flight && version === flight.version) {
        error.value = 'AI 回答暂时不可用，请重试。';
        errorCode.value = 'UNAVAILABLE';
        phase.value = 'error';
      }
    } finally {
      if (active === flight) active = null;
    }
  }

  function schedule(question: string): void {
    if (disposed) return;
    const trimmed = question.trim();
    // 普通搜索重试不重复计费；显式 AI 重试才绕开当前现场与缓存。
    if (trimmed === currentQuestion && trimmed.length >= AI_ASK_MIN_QUESTION_LENGTH) return;
    invalidate();
    currentQuestion = trimmed;
    clearFeedback();
    // 短词只退出当前问答，仍保留同一次面板打开期间的成功缓存。
    if (trimmed.length < AI_ASK_MIN_QUESTION_LENGTH) return;
    const cached = cache.get(trimmed);
    if (cached) {
      showAnswer(trimmed, cached);
      return;
    }
    phase.value = 'loading';
    const requestVersion = version;
    timer = setTimeout(() => {
      timer = undefined;
      void request(trimmed, requestVersion);
    }, ASK_DEBOUNCE_MS);
  }

  function retry(): void {
    if (
      disposed ||
      phase.value === 'loading' ||
      currentQuestion.length < AI_ASK_MIN_QUESTION_LENGTH
    )
      return;
    invalidate();
    cache.delete(currentQuestion);
    clearFeedback();
    phase.value = 'loading';
    void request(currentQuestion, version);
  }

  function expand(): void {
    if (phase.value === 'ready') expanded.value = true;
  }

  function collapse(): void {
    expanded.value = false;
  }

  async function cancel(): Promise<void> {
    if (disposed) return;
    invalidate();
    currentQuestion = '';
    clearFeedback();
    await Promise.all([...cancellations]);
  }

  function reset(): void {
    if (disposed) return;
    invalidate();
    currentQuestion = '';
    cache.clear();
    clearFeedback();
  }

  onScopeDispose(() => {
    invalidate();
    disposed = true;
    cache.clear();
  });

  return {
    phase,
    answer,
    error,
    errorCode,
    answerQuestion,
    expanded,
    schedule,
    retry,
    expand,
    collapse,
    cancel,
    reset,
  };
}
