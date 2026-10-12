import { ipcMain, type BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/contracts';
import { AppError, failure, type Result } from '../../shared/errors';
import type { AiService } from '../ai-service';
import type { AiSuggestionService } from '../ai-suggestion-service';
import type { AiAskService } from '../ai-ask-service';
import type { AiPeriodSummaryService } from '../ai-period-summary-service';
import { isTrustedSender } from '../window';

/** 独立 AI 白名单；沿用窗口/frame/地址来源检查，不开放任意网络请求。 */
export function registerAiIpc(
  window: BrowserWindow,
  rendererUrl: string,
  service: AiService,
  suggestions: AiSuggestionService,
  asks: AiAskService,
  periods: AiPeriodSummaryService,
  isPaused: () => boolean,
): () => void {
  const channels: string[] = [];
  function register<T>(channel: string, run: (payload: unknown) => T | Promise<T>): void {
    channels.push(channel);
    ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<T>> => {
      if (!isTrustedSender(event, window, rendererUrl))
        return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
      // 关闭和整库替换期间不接新请求，但仍允许取消。
      if (
        isPaused() &&
        channel !== CHANNELS.aiCancelTest &&
        channel !== CHANNELS.aiCancelSuggestion &&
        channel !== CHANNELS.aiCancelAsk &&
        channel !== CHANNELS.aiCancelPeriodSummary
      )
        return failure(new AppError('UNAVAILABLE', '正在关闭或恢复知识库，请稍后重试。'));
      try {
        return { ok: true, value: await run(payload) };
      } catch (error) {
        // AI 的未知错误不映射成「笔记保存失败」，也不泄露原始请求与认证信息。
        return error instanceof AppError
          ? failure(error)
          : failure(new AppError('UNAVAILABLE', 'AI 操作未完成，请重试。'));
      }
    });
  }
  register(CHANNELS.aiLoadSettings, () => service.loadSettings());
  register(CHANNELS.aiSaveModel, (payload) => service.saveModel(payload));
  register(CHANNELS.aiSaveBaseUrl, (payload) => service.saveBaseUrl(payload));
  register(CHANNELS.aiSaveKey, (payload) => service.saveKey(payload));
  register(CHANNELS.aiClearKey, () => service.clearKey());
  register(CHANNELS.aiTestConnection, (payload) => service.testConnection(payload));
  register(CHANNELS.aiCancelTest, (payload) => service.cancelTest(payload));
  register(CHANNELS.aiSuggest, (payload) => suggestions.suggest(payload));
  register(CHANNELS.aiCancelSuggestion, (payload) => suggestions.cancel(payload));
  register(CHANNELS.aiAsk, (payload) => asks.ask(payload));
  register(CHANNELS.aiCancelAsk, (payload) => asks.cancel(payload));
  register(CHANNELS.aiPeriodSummary, (payload) => periods.summarize(payload));
  register(CHANNELS.aiCancelPeriodSummary, (payload) => periods.cancel(payload));
  return () => {
    for (const channel of channels) ipcMain.removeHandler(channel);
  };
}
