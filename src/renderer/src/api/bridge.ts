import type { MemocraftApi } from '../../../shared/contracts';
import type { Result } from '../../../shared/errors';
import type { NoteImageIndex, NoteImageList } from '../../../domain/note-image';
import type { TopicSummary } from '../../../domain/topic';
import type { EntrySummary, NoteReference, ThreadSummary } from '../../../domain/thread';
import type { RemovalImpact, TrashItem } from '../../../domain/trash';

function unavailable(): Promise<Result<never>> {
  return Promise.resolve({
    ok: false as const,
    error: {
      code: 'UNAVAILABLE' as const,
      message: '请在 Memocraft 桌面应用中打开，本地数据连接尚未建立。',
    },
  });
}

const emptyImages: Result<NoteImageList> = { ok: true, value: { images: [], totalBytes: 0 } };
const emptyImageIndex: Result<NoteImageIndex> = { ok: true, value: {} };
const emptyTopics: Result<TopicSummary[]> = { ok: true, value: [] };
const emptyThreads: Result<ThreadSummary[]> = { ok: true, value: [] };
const emptyEntries: Result<EntrySummary[]> = { ok: true, value: [] };
const emptyReferences: Result<NoteReference[]> = { ok: true, value: [] };
const emptyTrash: Result<TrashItem[]> = { ok: true, value: [] };

/**
 * 普通浏览器不伪造保存能力：所有数据方法返回同一条明确失败。
 * 图集与归纳的读取返回空集合，使界面在未接入桌面能力时也能正常渲染空状态，
 * 写入仍然失败，不会出现「看起来保存成功」的假象。
 */
export const disconnectedApi: MemocraftApi = {
  ai: {
    loadSettings: unavailable,
    saveModel: unavailable,
    saveBaseUrl: unavailable,
    saveKey: unavailable,
    clearKey: unavailable,
    testConnection: unavailable,
    cancelTest: unavailable,
    suggest: unavailable,
    cancelSuggestion: unavailable,
    ask: unavailable,
    cancelAsk: unavailable,
    summarizePeriod: unavailable,
    cancelPeriodSummary: unavailable,
  },
  load: unavailable,
  saveDraft: unavailable,
  commitDraft: unavailable,
  updateNote: unavailable,
  search: unavailable,
  loadImages: () => Promise.resolve(emptyImages),
  loadImageIndex: () => Promise.resolve(emptyImageIndex),
  addImagesFromDialog: () => Promise.resolve(emptyImages),
  addImageFromClipboard: () => Promise.resolve(emptyImages),
  renameImage: () => Promise.resolve(emptyImages),
  deleteImage: () => Promise.resolve(emptyImages),
  loadTopics: () => Promise.resolve(emptyTopics),
  createTopic: unavailable,
  updateTopic: unavailable,
  loadTrash: () => Promise.resolve(emptyTrash),
  backupLibrary: unavailable,
  restoreLibrary: unavailable,
  applyRestore: unavailable,
  exportLibrary: unavailable,
  onNotice: () => () => undefined,
  loadRemovalImpact: (): Promise<Result<RemovalImpact>> => unavailable(),
  removeItem: unavailable,
  restoreItem: unavailable,
  addNotesToTopic: unavailable,
  removeNoteFromTopic: unavailable,
  loadThreads: () => Promise.resolve(emptyThreads),
  createThread: unavailable,
  updateThread: unavailable,
  archiveThread: unavailable,
  addNotesToThread: unavailable,
  removeNoteFromThread: unavailable,
  loadEntries: () => Promise.resolve(emptyEntries),
  createEntry: unavailable,
  updateEntry: unavailable,
  loadNoteReferences: () => Promise.resolve(emptyReferences),
  onCloseRequested: () => () => undefined,
  onCloseCancelled: () => () => undefined,
  closeReady: () => undefined,
  closeCancelled: () => undefined,
  platform: 'mac',
};

/** preload 已注入时直接使用桥接能力，否则退回明确失败的替身。 */
export function imageApi(bridge: MemocraftApi | undefined): MemocraftApi {
  return bridge ?? disconnectedApi;
}
