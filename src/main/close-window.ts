import { app, dialog, ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { CHANNELS } from '../shared/contracts';
import type { StoreClient } from './store-client';
import { isTrustedSender } from './window';
import { AppError } from '../shared/errors';

/** 先让界面刷新独立编辑现场，再排空存储消息并关库。失败始终保留窗口。 */
export function coordinateWindowClose(
  window: BrowserWindow,
  rendererUrl: string,
  store: StoreClient,
  settleExternalTasks?: () => Promise<void>,
  resumeExternalTasks?: () => void,
): void {
  let approved = false;
  let awaitingRenderer = false;
  let closingStore = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function cancel(): void {
    clearTimeout(timeout);
    awaitingRenderer = false;
  }

  function requestClose(event: Electron.Event): void {
    if (approved) return;
    event.preventDefault();
    if (awaitingRenderer || closingStore) return;
    awaitingRenderer = true;
    window.webContents.send(CHANNELS.closeRequested);
    // 等待时间长于存储请求超时，给界面处理失败并保留输入的机会。
    timeout = setTimeout(() => {
      cancel();
      window.webContents.send(CHANNELS.closeCancelled);
      dialog.showMessageBoxSync(window, {
        type: 'warning',
        title: '尚未退出',
        message: '编辑区没有确认保存，窗口已保留。',
        detail: '请检查未保存内容并重试关闭。',
      });
    }, 45_000);
  }

  async function finishClose(): Promise<void> {
    closingStore = true;
    try {
      // AI 密钥是独立文件；等已提交的写入结束，网络请求则由协作者取消。
      await settleExternalTasks?.();
      const result = await store.close();
      if (!result.ok) {
        dialog.showMessageBoxSync(window, {
          type: 'error',
          title: '尚未退出',
          message: '本地数据未能确认关闭，窗口已保留。',
          detail: result.error.message,
        });
        return;
      }
      // 只有编辑已保存且数据库已关闭，才允许销毁窗口并退出。
      approved = true;
      window.destroy();
      app.quit();
    } catch (error) {
      dialog.showMessageBoxSync(window, {
        type: 'error',
        title: '尚未退出',
        message: '操作未能确认完成，窗口与输入已保留。',
        detail: error instanceof AppError ? error.message : '请检查未保存内容后重试关闭。',
      });
    } finally {
      closingStore = false;
      if (!approved) resumeExternalTasks?.();
      if (!approved && !window.isDestroyed()) window.webContents.send(CHANNELS.closeCancelled);
    }
  }

  function ready(event: IpcMainEvent): void {
    if (!isTrustedSender(event, window, rendererUrl) || !awaitingRenderer) return;
    cancel();
    void finishClose();
  }

  function cancelled(event: IpcMainEvent): void {
    if (isTrustedSender(event, window, rendererUrl)) cancel();
  }

  window.on('close', requestClose);
  app.on('before-quit', requestClose);
  ipcMain.on(CHANNELS.closeReady, ready);
  ipcMain.on(CHANNELS.closeCancelled, cancelled);
  window.once('closed', () => {
    cancel();
    app.removeListener('before-quit', requestClose);
    ipcMain.removeListener(CHANNELS.closeReady, ready);
    ipcMain.removeListener(CHANNELS.closeCancelled, cancelled);
  });
}
