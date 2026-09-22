import type { MemocraftApi } from '../../../shared/contracts';
import type { Result } from '../../../shared/errors';
import type { NoteImageList } from '../../../domain/note-image';

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

/**
 * 普通浏览器不伪造保存能力：所有数据方法返回同一条明确失败。
 * 图集方法返回空列表，使界面在未接入桌面能力时也能正常渲染空状态。
 */
export const disconnectedApi: MemocraftApi = {
  load: unavailable,
  saveDraft: unavailable,
  commitDraft: unavailable,
  updateNote: unavailable,
  search: unavailable,
  loadImages: () => Promise.resolve(emptyImages),
  addImagesFromDialog: () => Promise.resolve(emptyImages),
  addImageFromClipboard: () => Promise.resolve(emptyImages),
  renameImage: () => Promise.resolve(emptyImages),
  deleteImage: () => Promise.resolve(emptyImages),
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
