import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type MemocraftApi } from '../shared/contracts';

// 桥接层仅转发白名单调用；输入校验与业务规则在主进程侧执行。
const api: MemocraftApi = {
  load: () => ipcRenderer.invoke(CHANNELS.load),
  saveDraft: (draft) => ipcRenderer.invoke(CHANNELS.saveDraft, draft),
  commitDraft: (draft) => ipcRenderer.invoke(CHANNELS.commitDraft, draft),
  updateNote: (edit) => ipcRenderer.invoke(CHANNELS.updateNote, edit),
  search: (query) => ipcRenderer.invoke(CHANNELS.search, query),
  onCloseRequested: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(CHANNELS.closeRequested, handler);
    return () => ipcRenderer.removeListener(CHANNELS.closeRequested, handler);
  },
  onCloseCancelled: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on(CHANNELS.closeCancelled, handler);
    return () => ipcRenderer.removeListener(CHANNELS.closeCancelled, handler);
  },
  closeReady: () => ipcRenderer.send(CHANNELS.closeReady),
  closeCancelled: () => ipcRenderer.send(CHANNELS.closeCancelled),
  platform:
    process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
};
contextBridge.exposeInMainWorld('memocraft', api);
