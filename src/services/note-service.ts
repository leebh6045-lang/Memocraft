import { join } from 'node:path';
import type { StoreRequest, StoreValue } from '../shared/contracts';
import { STAGING_DIRECTORY } from '../storage/recovery';
import type { NoteStore } from '../storage/note-store';
import type { NoteImageStore } from '../storage/note-image-store';
import type { TopicStore } from '../storage/topic-store';
import type { ThreadStore } from '../storage/thread-store';
import type { SearchStore } from '../storage/search-store';
import type { TrashStore } from '../storage/trash-store';
import type { ExportStore } from '../storage/export-store';
import { backupLibrary, stageRestoreInto } from '../storage/backup';
import {
  validateAddImages,
  validateDraft,
  validateImageId,
  validateImageRename,
  validateNoteEdit,
  validateImageOwner,
  validateNoteIds,
  validateSearch,
  validateTopicCreate,
  validateTopicEdit,
  validateTopicNote,
  validateTopicNotes,
  validateEntriesQuery,
  validateEntryCreate,
  validateEntryEdit,
  validateIncludeArchived,
  validateNoteReferences,
  validateThreadArchive,
  validateThreadCreate,
  validateThreadEdit,
  validateThreadNote,
  validateThreadNotes,
  validateTrashRef,
  validateDestinationPath,
  validateSourcePath,
} from './validation';

/** 各聚合根的存储实现；它们共用同一条连接，装配在存储线程里完成。 */
export interface StoreContext {
  notes: NoteStore;
  images: NoteImageStore;
  topics: TopicStore;
  threads: ThreadStore;
  search: SearchStore;
  trash: TrashStore;
  exporter: ExportStore;
  /** 数据目录与迁移目录：备份、恢复与导出都在存储线程内完成文件操作。 */
  dataDirectory: string;
  migrationsDirectory: string;
}

/**
 * 一个请求对应一个同步存储用例；复合写入的事务由各存储实现保证。
 * 所有存储共用同一条连接，因此这里只是转发，不额外加锁。
 */
export async function executeStoreRequest(
  stores: StoreContext,
  request: StoreRequest,
): Promise<StoreValue> {
  const { notes: store, images, topics, threads, search, trash, exporter } = stores;
  switch (request.operation) {
    case 'load':
      return store.load();
    case 'saveDraft':
      return store.saveDraft(validateDraft(request.payload));
    case 'commitDraft': {
      const draft = validateDraft(request.payload, true);
      // 草稿附图与创建手记、清理草稿在同一个事务里完成归属。
      return store.commitDraft(draft, (noteId) => images.claimDraftImages(draft.id, noteId));
    }
    case 'updateNote':
      return store.updateNote(validateNoteEdit(request.payload));
    case 'search':
      return search.search(validateSearch(request.payload));
    case 'loadImages':
      return images.list(validateImageOwner(request.payload));
    case 'loadImageIndex':
      return images.listSummaries(validateNoteIds(request.payload));
    case 'addImages': {
      const { owner, images: inputs } = validateAddImages(request.payload);
      return images.add(owner, inputs);
    }
    case 'renameImage': {
      const { imageId, displayName } = validateImageRename(request.payload);
      return images.rename(imageId, displayName);
    }
    case 'deleteImage':
      return images.remove(validateImageId(request.payload));
    case 'readImage': {
      const { image, bytes } = images.readBytes(validateImageId(request.payload));
      return { mimeType: image.mimeType, bytes };
    }
    case 'loadTopics':
      return topics.list();
    case 'createTopic':
      return topics.create(validateTopicCreate(request.payload));
    case 'updateTopic':
      return topics.update(validateTopicEdit(request.payload));
    case 'addNotesToTopic': {
      const { topicId, noteIds } = validateTopicNotes(request.payload);
      return topics.addNotes(topicId, noteIds);
    }
    case 'removeNoteFromTopic': {
      const { topicId, noteId } = validateTopicNote(request.payload);
      return topics.removeNote(topicId, noteId);
    }
    case 'loadThreads':
      return threads.list(validateIncludeArchived(request.payload));
    case 'createThread':
      return threads.create(validateThreadCreate(request.payload));
    case 'updateThread':
      return threads.update(validateThreadEdit(request.payload));
    case 'archiveThread': {
      const { threadId, archived, expectedRevision } = validateThreadArchive(request.payload);
      return threads.setArchived(threadId, archived, expectedRevision);
    }
    case 'addNotesToThread': {
      const { threadId, noteIds } = validateThreadNotes(request.payload);
      return threads.addNotes(threadId, noteIds);
    }
    case 'removeNoteFromThread': {
      const { threadId, noteId } = validateThreadNote(request.payload);
      return threads.removeNote(threadId, noteId);
    }
    case 'loadEntries': {
      const { threadId, order } = validateEntriesQuery(request.payload);
      return threads.entries(threadId, order);
    }
    case 'createEntry':
      return threads.addEntry(validateEntryCreate(request.payload));
    case 'updateEntry':
      return threads.updateEntry(validateEntryEdit(request.payload));
    case 'loadNoteReferences':
      return threads.referencesOfNote(validateNoteReferences(request.payload));
    case 'loadTrash':
      return trash.list();
    case 'loadRemovalImpact': {
      const ref = validateTrashRef(request.payload);
      return trash.impactOf(ref.kind, ref.id);
    }
    case 'removeItem': {
      const ref = validateTrashRef(request.payload);
      trash.remove(ref.kind, ref.id);
      return null;
    }
    case 'restoreItem': {
      const ref = validateTrashRef(request.payload);
      trash.restore(ref.kind, ref.id);
      return null;
    }
    case 'backupLibrary': {
      const destination = validateDestinationPath(request.payload);
      // 备份与导出都是长任务：含附件的复制可能远超普通请求，超时按操作区分。
      return await backupLibrary(store, images, destination);
    }
    case 'exportLibrary': {
      const destination = validateDestinationPath(request.payload);
      return exporter.exportTo(destination);
    }
    case 'stageRestore': {
      const source = validateSourcePath(request.payload);
      return stageRestoreInto(
        source,
        join(stores.dataDirectory, STAGING_DIRECTORY),
        stores.migrationsDirectory,
      );
    }
    case 'close':
      store.close();
      return null;
  }
}
