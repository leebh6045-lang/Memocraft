import { ipcMain, shell, type BrowserWindow } from 'electron';
import { CHANNELS } from '../../shared/contracts';
import type { Result } from '../../shared/errors';
import { isTrustedSender } from '../window';

// 帮助网址只在主进程维护；域名就绪后替换此处，不开放任意外部地址能力。
const HELP_URL = 'http://47.119.177.34/memocraft/help/';

export function registerHelpIpc(window: BrowserWindow, rendererUrl: string): () => void {
  ipcMain.handle(CHANNELS.openHelp, async (event, ...args: unknown[]): Promise<Result<null>> => {
    if (!isTrustedSender(event, window, rendererUrl))
      return { ok: false, error: { code: 'UNAVAILABLE', message: '请求来源无效。' } };
    if (args.length !== 0)
      return { ok: false, error: { code: 'VALIDATION', message: '帮助入口不接受额外参数。' } };
    try {
      // 系统浏览器独立打开教程，应用窗口仍保持原页面与编辑现场。
      await shell.openExternal(HELP_URL);
      return { ok: true, value: null };
    } catch {
      return {
        ok: false,
        error: {
          code: 'UNAVAILABLE',
          message: '无法打开新手指南，请检查默认浏览器后重试。',
        },
      };
    }
  });
  return () => ipcMain.removeHandler(CHANNELS.openHelp);
}
