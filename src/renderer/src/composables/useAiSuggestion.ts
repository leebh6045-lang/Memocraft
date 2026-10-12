import { computed, onScopeDispose, ref } from 'vue';
import { AI_SUGGESTION_INPUT_LIMIT, type AiSuggestion } from '../../../shared/ai';
import type { MemocraftApi } from '../../../shared/contracts';
import type { ErrorCode } from '../../../shared/errors';

export type SuggestionPhase = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/** 建议只保存当前界面现场；取消、重置和销毁均令迟到应答失效。 */
export function useAiSuggestion(
  api: Pick<MemocraftApi, 'ai'>,
  currentBody: () => string,
  currentImageIds: () => string[],
) {
  const phase = ref<SuggestionPhase>('idle');
  const suggestion = ref<AiSuggestion | null>(null);
  const error = ref('');
  const errorCode = ref<ErrorCode | null>(null);
  const staleBody = ref<string | null>(null);
  const staleImageIds = ref<string[] | null>(null);
  const requestId = ref<string | null>(null);
  const cancelling = ref(false);
  let disposed = false;
  let version = 0;
  let active: { id: string; version: number } | null = null;
  let cancellation: Promise<void> | null = null;

  // 比较完整正文与图集顺序：超出发送预算的修改同样会令旧建议过期。
  const isStale = computed(() => {
    if (phase.value !== 'ready' && phase.value !== 'empty') return false;
    if (staleBody.value === null || staleImageIds.value === null) return false;
    const imageIds = currentImageIds();
    return (
      staleBody.value !== currentBody() ||
      staleImageIds.value.length !== imageIds.length ||
      staleImageIds.value.some((id, index) => id !== imageIds[index])
    );
  });

  function clearFeedback(): void {
    phase.value = 'idle';
    suggestion.value = null;
    error.value = '';
    errorCode.value = null;
    staleBody.value = null;
    staleImageIds.value = null;
  }

  function showError(code: ErrorCode, message: string): void {
    suggestion.value = null;
    error.value = message;
    errorCode.value = code;
    phase.value = 'error';
  }

  async function request(
    body: string,
    title: string,
    existingTags: string[],
    imageIds: string[],
    draftId: string,
  ): Promise<void> {
    // 不依赖按钮禁用：旧请求或取消回执未结算时，重复调用也不产生计费请求。
    if (disposed || active || cancellation || !body.trim()) return;
    const flight = { id: crypto.randomUUID(), version: ++version };
    active = flight;
    requestId.value = flight.id;
    staleBody.value = body;
    staleImageIds.value = [...imageIds];
    suggestion.value = null;
    error.value = '';
    errorCode.value = null;
    phase.value = 'loading';
    try {
      const result = await api.ai.suggest({
        requestId: flight.id,
        body: body.slice(0, AI_SUGGESTION_INPUT_LIMIT),
        title,
        existingTags: [...existingTags],
        imageIds: [...imageIds],
        draftId,
      });
      // 正文与图片允许继续编辑；只认本次请求身份，内容变化由 isStale 提示。
      if (disposed || active !== flight || version !== flight.version) return;
      if (!result.ok) {
        if (result.error.code === 'AI_CANCELLED') clearFeedback();
        else showError(result.error.code, result.error.message);
        return;
      }
      suggestion.value = result.value;
      phase.value = result.value.tags.length || result.value.topics.length ? 'ready' : 'empty';
    } catch {
      // 桥接异常不展示原始内容，避免正文、凭据或系统路径进入提示。
      if (!disposed && active === flight && version === flight.version)
        showError('UNAVAILABLE', 'AI 建议未能生成，请重试。');
    } finally {
      if (!disposed && active === flight) {
        active = null;
        requestId.value = null;
      }
    }
  }

  function beginCancellation(reportFailure: boolean): Promise<void> {
    if (cancellation) return cancellation;
    const flight = active;
    if (!flight) return Promise.resolve();
    const cancelVersion = ++version;
    if (!disposed) cancelling.value = true;
    // 发起取消即撤销展示资格，避免关闭动作与原请求成功同时到达时闪回旧建议。
    const operation: Promise<void> = Promise.resolve().then(async () => {
      try {
        const result = await api.ai.cancelSuggestion(flight.id);
        if (!result.ok) {
          if (!disposed && reportFailure && version === cancelVersion)
            showError(result.error.code, result.error.message);
          return;
        }
        if (!disposed && active === flight) {
          active = null;
          requestId.value = null;
        }
        if (!disposed && version === cancelVersion) clearFeedback();
      } catch {
        if (!disposed && reportFailure && version === cancelVersion)
          showError('UNAVAILABLE', '取消未完成，可以再次关闭或等待生成结束。');
      } finally {
        if (cancellation === operation) {
          cancellation = null;
          if (!disposed) cancelling.value = false;
        }
      }
    });
    cancellation = operation;
    return operation;
  }

  function cancel(): Promise<void> {
    // 取消失败后原请求可能已自然结束，此时再次关闭无需再等待网络资源。
    if (!active && !cancellation) {
      if (!disposed) clearFeedback();
      return Promise.resolve();
    }
    return beginCancellation(true);
  }

  function reset(): void {
    if (disposed) return;
    version += 1;
    clearFeedback();
    // 切页、提交或恢复后的现场已结束；仍取消资源，但失败不污染新的页面。
    void beginCancellation(false);
  }

  onScopeDispose(() => {
    disposed = true;
    version += 1;
    // 只取消本作用域的请求；主进程超时和生命周期排空仍承担最终释放边界。
    void beginCancellation(false);
  });

  return {
    phase,
    suggestion,
    error,
    errorCode,
    staleBody,
    staleImageIds,
    isStale,
    requestId,
    cancelling,
    request,
    cancel,
    reset,
  };
}
