import type { LibrarySnapshot, Note, NoteDraft, NoteEdit, NoteSearchResult } from '../domain/note';
import type { ImageInput, NoteImage, NoteImageList } from '../domain/note-image';
import type { Result } from './errors';

export const CHANNELS = {
  load: 'library:load',
  saveDraft: 'notes:save-draft',
  commitDraft: 'notes:commit-draft',
  updateNote: 'notes:update',
  search: 'notes:search',
  loadImages: 'images:load',
  addImages: 'images:add',
  addImagesFromDialog: 'images:add-from-dialog',
  renameImage: 'images:rename',
  deleteImage: 'images:delete',
  closeRequested: 'window:close-requested',
  closeReady: 'window:close-ready',
  closeCancelled: 'window:close-cancelled',
} as const;

/** 渲染端只获得这些业务能力，不暴露通用 IPC 或文件操作。 */
export interface MemocraftApi {
  load(): Promise<Result<LibrarySnapshot>>;
  saveDraft(draft: NoteDraft): Promise<Result<NoteDraft>>;
  commitDraft(draft: NoteDraft): Promise<Result<Note>>;
  updateNote(edit: NoteEdit): Promise<Result<Note>>;
  search(query: string): Promise<Result<NoteSearchResult>>;
  loadImages(noteId: string): Promise<Result<NoteImageList>>;
  /** 主进程打开系统文件选择并复制所选图片；用户取消时返回空列表。 */
  addImagesFromDialog(noteId: string): Promise<Result<NoteImageList>>;
  /** 粘贴剪贴板位图；字节随本次调用传入，渲染端不接触文件路径。 */
  addImageFromClipboard(noteId: string, image: ImageInput): Promise<Result<NoteImageList>>;
  renameImage(imageId: string, displayName: string): Promise<Result<NoteImageList>>;
  deleteImage(imageId: string): Promise<Result<NoteImageList>>;
  /** 收到关闭请求后先保存编辑现场；返回函数用于解除订阅。 */
  onCloseRequested(listener: () => void): () => void;
  onCloseCancelled(listener: () => void): () => void;
  /** 仅在编辑内容确认保存后通知主进程关库。 */
  closeReady(): void;
  closeCancelled(): void;
  platform: 'mac' | 'windows' | 'linux';
}

/** 图片通过自定义协议展示；该协议只接受图片 ID，不接受任意路径。 */
export const IMAGE_PROTOCOL = 'memocraft-image';
export function imageUrl(image: Pick<NoteImage, 'id'>): string {
  return `${IMAGE_PROTOCOL}://image/${image.id}`;
}

export type StoreRequest =
  | { operation: 'load' }
  | { operation: 'saveDraft'; payload: unknown }
  | { operation: 'commitDraft'; payload: unknown }
  | { operation: 'updateNote'; payload: unknown }
  | { operation: 'search'; payload: unknown }
  | { operation: 'loadImages'; payload: unknown }
  | { operation: 'addImages'; payload: unknown }
  | { operation: 'renameImage'; payload: unknown }
  | { operation: 'deleteImage'; payload: unknown }
  | { operation: 'readImage'; payload: unknown }
  | { operation: 'close' };

/** 自定义协议取图的结果；只暴露类型与字节，不把数据目录路径带到主进程。 */
export interface ImageBytes {
  mimeType: string;
  bytes: Uint8Array;
}

export type StoreValue =
  LibrarySnapshot | NoteDraft | Note | NoteSearchResult | NoteImageList | ImageBytes | null;
export interface WorkerRequest {
  id: number;
  request: StoreRequest;
}
export interface WorkerReply {
  id: number;
  result: Result<StoreValue>;
}
