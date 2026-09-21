import type { LibrarySnapshot, Note, NoteDraft, NoteEdit, NoteSearchResult } from '../domain/note';
import type { Result } from './errors';

export const CHANNELS = {
  load: 'library:load',
  saveDraft: 'notes:save-draft',
  commitDraft: 'notes:commit-draft',
  updateNote: 'notes:update',
  search: 'notes:search',
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
  /** 收到关闭请求后先保存编辑现场；返回函数用于解除订阅。 */
  onCloseRequested(listener: () => void): () => void;
  onCloseCancelled(listener: () => void): () => void;
  /** 仅在编辑内容确认保存后通知主进程关库。 */
  closeReady(): void;
  closeCancelled(): void;
  platform: 'mac' | 'windows' | 'linux';
}

export type StoreRequest =
  | { operation: 'load' }
  | { operation: 'saveDraft'; payload: unknown }
  | { operation: 'commitDraft'; payload: unknown }
  | { operation: 'updateNote'; payload: unknown }
  | { operation: 'search'; payload: unknown }
  | { operation: 'close' };

export type StoreValue = LibrarySnapshot | NoteDraft | Note | NoteSearchResult | null;
export interface WorkerRequest {
  id: number;
  request: StoreRequest;
}
export interface WorkerReply {
  id: number;
  result: Result<StoreValue>;
}
