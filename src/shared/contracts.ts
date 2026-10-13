import type { LibrarySnapshot, Note, NoteDraft, NoteEdit } from '../domain/note';
import type { SearchResult } from '../domain/search';
import type { NoteSearchResult } from '../domain/note-search';
import type {
  ImageInput,
  ImageOwner,
  NoteImage,
  NoteImageIndex,
  NoteImageList,
} from '../domain/note-image';
import type { TopicCreate, TopicEdit, TopicSummary } from '../domain/topic';
import type { RemovalImpact, TrashItem, TrashKind } from '../domain/trash';
import type { BackupSummary, ExportSummary, StagedRestore } from '../domain/library-data';
import type {
  EntryCreate,
  EntryEdit,
  EntrySummary,
  NoteReference,
  ThreadCreate,
  ThreadEdit,
  ThreadSummary,
  TimelineOrder,
} from '../domain/thread';
import type { Result } from './errors';
import type { AiApi, AiConfiguration, StoredAiPeriodSummary, PeriodNotesResult } from './ai';

export const CHANNELS = {
  openHelp: 'help:open',
  load: 'library:load',
  saveDraft: 'notes:save-draft',
  commitDraft: 'notes:commit-draft',
  updateNote: 'notes:update',
  search: 'notes:search',
  loadImages: 'images:load',
  /** 列表缩略图：一次读取一批手记的图片摘要，只含 ID、名称与尺寸。 */
  loadImageIndex: 'images:index',
  addImages: 'images:add',
  addImagesFromDialog: 'images:add-from-dialog',
  renameImage: 'images:rename',
  deleteImage: 'images:delete',
  loadTopics: 'topics:load',
  createTopic: 'topics:create',
  updateTopic: 'topics:update',
  loadTrash: 'trash:load',
  loadRemovalImpact: 'trash:impact',
  removeItem: 'trash:remove',
  restoreItem: 'trash:restore',
  backupLibrary: 'data:backup',
  restoreLibrary: 'data:restore',
  applyRestore: 'data:restore-apply',
  exportLibrary: 'data:export',
  appNotice: 'app:notice',
  addNotesToTopic: 'topics:add-notes',
  removeNoteFromTopic: 'topics:remove-note',
  loadThreads: 'threads:load',
  createThread: 'threads:create',
  updateThread: 'threads:update',
  archiveThread: 'threads:archive',
  addNotesToThread: 'threads:add-notes',
  removeNoteFromThread: 'threads:remove-note',
  loadEntries: 'entries:load',
  createEntry: 'entries:create',
  updateEntry: 'entries:update',
  loadNoteReferences: 'references:by-note',
  closeRequested: 'window:close-requested',
  closeReady: 'window:close-ready',
  closeCancelled: 'window:close-cancelled',
  aiLoadSettings: 'ai:load-settings',
  aiSaveModel: 'ai:save-model',
  aiSaveBaseUrl: 'ai:save-base-url',
  aiSaveKey: 'ai:save-key',
  aiClearKey: 'ai:clear-key',
  aiTestConnection: 'ai:test-connection',
  aiCancelTest: 'ai:cancel-test',
  aiSuggest: 'ai:suggest',
  aiCancelSuggestion: 'ai:cancel-suggestion',
  aiAsk: 'ai:ask',
  aiCancelAsk: 'ai:cancel-ask',
  aiPeriodSummary: 'ai:period-summary',
  aiCancelPeriodSummary: 'ai:cancel-period-summary',
} as const;

/** 渲染端只获得这些业务能力，不暴露通用 IPC 或文件操作。 */
export interface MemocraftApi {
  /** 在系统浏览器打开固定新手指南，不接受外部网址参数。 */
  openHelp(): Promise<Result<null>>;
  /** 只暴露明确的 AI 配置、测试、建议与问答能力；已保存的密钥不会回传给页面。 */
  ai: AiApi;
  load(): Promise<Result<LibrarySnapshot>>;
  saveDraft(draft: NoteDraft): Promise<Result<NoteDraft>>;
  commitDraft(draft: NoteDraft): Promise<Result<Note>>;
  updateNote(edit: NoteEdit): Promise<Result<Note>>;
  /** 全对象搜索：覆盖手记、归纳、事务与动态；草稿与回收站内容不参与。 */
  search(query: string): Promise<Result<SearchResult>>;
  /** 图集按归属读取：已保存的手记，或首页尚未保存的草稿。 */
  loadImages(owner: ImageOwner): Promise<Result<NoteImageList>>;
  /** 列表缩略图：按手记 ID 批量取图片摘要，未收录附图或已删除的手记不出现在结果里。 */
  loadImageIndex(noteIds: string[]): Promise<Result<NoteImageIndex>>;
  /** 主进程打开系统文件选择并复制所选图片；用户取消时返回 null，界面据此不提示成功。 */
  addImagesFromDialog(owner: ImageOwner): Promise<Result<NoteImageList | null>>;
  /** 粘贴剪贴板位图；字节随本次调用传入，渲染端不接触文件路径。 */
  addImageFromClipboard(owner: ImageOwner, image: ImageInput): Promise<Result<NoteImageList>>;
  renameImage(imageId: string, displayName: string): Promise<Result<NoteImageList>>;
  deleteImage(imageId: string): Promise<Result<NoteImageList>>;
  /** 归纳列表：每个归纳带上当前收录的有效手记 ID，计数与反查共用这一份数据。 */
  loadTopics(): Promise<Result<TopicSummary[]>>;
  createTopic(input: TopicCreate): Promise<Result<TopicSummary>>;
  updateTopic(edit: TopicEdit): Promise<Result<TopicSummary>>;
  /** 回收站：列出已删除内容、删除前的影响面、删除与恢复。 */
  loadTrash(): Promise<Result<TrashItem[]>>;
  loadRemovalImpact(kind: TrashKind, id: string): Promise<Result<RemovalImpact>>;
  removeItem(kind: TrashKind, id: string): Promise<Result<null>>;
  restoreItem(kind: TrashKind, id: string): Promise<Result<null>>;
  /**
   * 备份、恢复与导出：目标路径由主进程弹出对话框选择，
   * 渲染端只拿到用于显示的结果，不获得任意路径读写能力。
   */
  backupLibrary(): Promise<Result<BackupSummary>>;
  /** 选择备份并校验：只展开到暂存目录，不触碰当前数据；返回内容摘要供确认。 */
  restoreLibrary(): Promise<Result<StagedRestore>>;
  /** 确认后替换活动库；失败会回滚到恢复前的数据。 */
  applyRestore(): Promise<Result<null>>;
  exportLibrary(): Promise<Result<ExportSummary>>;
  /** 启动时的提示（例如检测到未完成的恢复并已回滚）。 */
  onNotice(listener: (message: string) => void): () => void;
  addNotesToTopic(topicId: string, noteIds: string[]): Promise<Result<TopicSummary>>;
  removeNoteFromTopic(topicId: string, noteId: string): Promise<Result<TopicSummary>>;
  /** 长期事务：默认只列进行中，已归档需显式请求。 */
  loadThreads(includeArchived: boolean): Promise<Result<ThreadSummary[]>>;
  createThread(input: ThreadCreate): Promise<Result<ThreadSummary>>;
  updateThread(edit: ThreadEdit): Promise<Result<ThreadSummary>>;
  archiveThread(
    threadId: string,
    archived: boolean,
    expectedRevision: number,
  ): Promise<Result<ThreadSummary>>;
  addNotesToThread(threadId: string, noteIds: string[]): Promise<Result<ThreadSummary>>;
  removeNoteFromThread(threadId: string, noteId: string): Promise<Result<ThreadSummary>>;
  /** 动态时间线：按发生时间排序，同时间以创建时间与 ID 稳定排序。 */
  loadEntries(threadId: string, order: TimelineOrder): Promise<Result<EntrySummary[]>>;
  createEntry(input: EntryCreate): Promise<Result<EntrySummary>>;
  updateEntry(edit: EntryEdit): Promise<Result<EntrySummary>>;
  /** 手记被引用的位置：事务级与动态级分开返回。 */
  loadNoteReferences(noteId: string): Promise<Result<NoteReference[]>>;
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
  | { operation: 'loadAiConfiguration' }
  | { operation: 'saveAiModel'; payload: unknown }
  | { operation: 'saveAiBaseUrl'; payload: unknown }
  | { operation: 'saveDraft'; payload: unknown }
  | { operation: 'commitDraft'; payload: unknown }
  | { operation: 'updateNote'; payload: unknown }
  | { operation: 'search'; payload: unknown }
  | { operation: 'retrieveNotes'; payload: unknown }
  | { operation: 'fetchPeriodNotes'; payload: unknown }
  | { operation: 'loadPeriodSummary'; payload: unknown }
  | { operation: 'savePeriodSummary'; payload: unknown }
  | { operation: 'loadImages'; payload: unknown }
  | { operation: 'loadImageIndex'; payload: unknown }
  | { operation: 'addImages'; payload: unknown }
  | { operation: 'renameImage'; payload: unknown }
  | { operation: 'deleteImage'; payload: unknown }
  | { operation: 'readImage'; payload: unknown }
  | { operation: 'loadTopics' }
  | { operation: 'loadTagPool' }
  | { operation: 'createTopic'; payload: unknown }
  | { operation: 'updateTopic'; payload: unknown }
  | { operation: 'loadTrash' }
  | { operation: 'loadRemovalImpact'; payload: unknown }
  | { operation: 'removeItem'; payload: unknown }
  | { operation: 'restoreItem'; payload: unknown }
  | { operation: 'backupLibrary'; payload: unknown }
  | { operation: 'exportLibrary'; payload: unknown }
  | { operation: 'stageRestore'; payload: unknown }
  | { operation: 'addNotesToTopic'; payload: unknown }
  | { operation: 'removeNoteFromTopic'; payload: unknown }
  | { operation: 'loadThreads'; payload: unknown }
  | { operation: 'createThread'; payload: unknown }
  | { operation: 'updateThread'; payload: unknown }
  | { operation: 'archiveThread'; payload: unknown }
  | { operation: 'addNotesToThread'; payload: unknown }
  | { operation: 'removeNoteFromThread'; payload: unknown }
  | { operation: 'loadEntries'; payload: unknown }
  | { operation: 'createEntry'; payload: unknown }
  | { operation: 'updateEntry'; payload: unknown }
  | { operation: 'loadNoteReferences'; payload: unknown }
  | { operation: 'close' };

/** 自定义协议取图的结果；只暴露类型与字节，不把数据目录路径带到主进程。 */
export interface ImageBytes {
  mimeType: string;
  bytes: Uint8Array;
}

export type StoreValue =
  | LibrarySnapshot
  | AiConfiguration
  | NoteDraft
  | Note
  | NoteImageList
  | NoteImageIndex
  | ImageBytes
  | TopicSummary
  | TopicSummary[]
  | string[]
  | ThreadSummary
  | ThreadSummary[]
  | EntrySummary
  | EntrySummary[]
  | NoteReference[]
  | SearchResult
  | NoteSearchResult
  | PeriodNotesResult
  | StoredAiPeriodSummary
  | TrashItem[]
  | RemovalImpact
  | ExportSummary
  | BackupSummary
  | StagedRestore
  | null;
export interface WorkerRequest {
  id: number;
  request: StoreRequest;
}
export interface WorkerReply {
  id: number;
  result: Result<StoreValue>;
}
