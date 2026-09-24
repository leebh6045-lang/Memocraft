import { contextBridge, ipcRenderer } from 'electron';
import { APP_VERSION_ARGUMENT, CHANNELS, type MemocraftApi } from '../shared/contracts';

// 桥接层仅转发白名单调用；输入校验与业务规则在主进程侧执行。
const api: MemocraftApi = {
  load: () => ipcRenderer.invoke(CHANNELS.load),
  saveDraft: (draft) => ipcRenderer.invoke(CHANNELS.saveDraft, draft),
  commitDraft: (draft) => ipcRenderer.invoke(CHANNELS.commitDraft, draft),
  updateNote: (edit) => ipcRenderer.invoke(CHANNELS.updateNote, edit),
  search: (query) => ipcRenderer.invoke(CHANNELS.search, query),
  loadImages: (noteId) => ipcRenderer.invoke(CHANNELS.loadImages, noteId),
  addImagesFromDialog: (noteId) => ipcRenderer.invoke(CHANNELS.addImagesFromDialog, noteId),
  addImageFromClipboard: (noteId, image) =>
    ipcRenderer.invoke(CHANNELS.addImages, { noteId, images: [image] }),
  renameImage: (imageId, displayName) =>
    ipcRenderer.invoke(CHANNELS.renameImage, { imageId, displayName }),
  deleteImage: (imageId) => ipcRenderer.invoke(CHANNELS.deleteImage, imageId),
  loadTopics: () => ipcRenderer.invoke(CHANNELS.loadTopics),
  createTopic: (input) => ipcRenderer.invoke(CHANNELS.createTopic, input),
  updateTopic: (edit) => ipcRenderer.invoke(CHANNELS.updateTopic, edit),
  loadTrash: () => ipcRenderer.invoke(CHANNELS.loadTrash),
  // 备份、恢复与导出的目标路径由主进程弹出对话框选择，渲染端不传路径。
  backupLibrary: () => ipcRenderer.invoke(CHANNELS.backupLibrary),
  restoreLibrary: () => ipcRenderer.invoke(CHANNELS.restoreLibrary),
  applyRestore: () => ipcRenderer.invoke(CHANNELS.applyRestore),
  exportLibrary: () => ipcRenderer.invoke(CHANNELS.exportLibrary),
  onNotice: (listener) => {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on(CHANNELS.appNotice, handler);
    return () => ipcRenderer.removeListener(CHANNELS.appNotice, handler);
  },
  loadRemovalImpact: (kind, id) => ipcRenderer.invoke(CHANNELS.loadRemovalImpact, { kind, id }),
  removeItem: (kind, id) => ipcRenderer.invoke(CHANNELS.removeItem, { kind, id }),
  restoreItem: (kind, id) => ipcRenderer.invoke(CHANNELS.restoreItem, { kind, id }),
  addNotesToTopic: (topicId, noteIds) =>
    ipcRenderer.invoke(CHANNELS.addNotesToTopic, { topicId, noteIds }),
  removeNoteFromTopic: (topicId, noteId) =>
    ipcRenderer.invoke(CHANNELS.removeNoteFromTopic, { topicId, noteId }),
  loadThreads: (includeArchived) => ipcRenderer.invoke(CHANNELS.loadThreads, includeArchived),
  createThread: (input) => ipcRenderer.invoke(CHANNELS.createThread, input),
  updateThread: (edit) => ipcRenderer.invoke(CHANNELS.updateThread, edit),
  archiveThread: (threadId, archived, expectedRevision) =>
    ipcRenderer.invoke(CHANNELS.archiveThread, { threadId, archived, expectedRevision }),
  addNotesToThread: (threadId, noteIds) =>
    ipcRenderer.invoke(CHANNELS.addNotesToThread, { threadId, noteIds }),
  removeNoteFromThread: (threadId, noteId) =>
    ipcRenderer.invoke(CHANNELS.removeNoteFromThread, { threadId, noteId }),
  loadEntries: (threadId, order) => ipcRenderer.invoke(CHANNELS.loadEntries, { threadId, order }),
  createEntry: (input) => ipcRenderer.invoke(CHANNELS.createEntry, input),
  updateEntry: (edit) => ipcRenderer.invoke(CHANNELS.updateEntry, edit),
  loadNoteReferences: (noteId) => ipcRenderer.invoke(CHANNELS.loadNoteReferences, noteId),
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
  // 启动参数由主进程写死（见 window.ts）：拿不到时留空，界面不显示版本，而不是编一个。
  version:
    process.argv
      .find((argument) => argument.startsWith(`${APP_VERSION_ARGUMENT}=`))
      ?.slice(APP_VERSION_ARGUMENT.length + 1) ?? '',
};
contextBridge.exposeInMainWorld('memocraft', api);
