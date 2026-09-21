import { ipcMain, type BrowserWindow } from 'electron';
import { CHANNELS, type StoreRequest } from '../../shared/contracts';
import { AppError, failure } from '../../shared/errors';
import type { StoreClient } from '../store-client';
import { isTrustedSender } from '../window';

export function registerStoreIpc(
  window: BrowserWindow,
  rendererUrl: string,
  store: StoreClient,
): () => void {
  const operations = ['load', 'saveDraft', 'commitDraft', 'updateNote', 'search'] as const;
  for (const operation of operations) {
    ipcMain.handle(CHANNELS[operation], async (event, payload: unknown) => {
      if (!isTrustedSender(event, window, rendererUrl))
        return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
      const request: StoreRequest = operation === 'load' ? { operation } : { operation, payload };
      try {
        return await store.request(request);
      } catch (error) {
        return failure(error);
      }
    });
  }
  return () => {
    for (const operation of operations) ipcMain.removeHandler(CHANNELS[operation]);
  };
}
