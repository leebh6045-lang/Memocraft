import type { StoreRequest, StoreValue } from '../shared/contracts';
import type { NoteStore } from '../storage/note-store';
import type { NoteImageStore } from '../storage/note-image-store';
import {
  validateAddImages,
  validateDraft,
  validateImageId,
  validateImageRename,
  validateNoteEdit,
  validateNoteId,
  validateSearch,
} from './validation';

/**
 * 一个请求对应一个同步存储用例；复合写入的事务由各存储实现保证。
 * 附图与手记共用同一条连接，因此这里只是转发，不额外加锁。
 */
export function executeStoreRequest(
  store: NoteStore,
  images: NoteImageStore,
  request: StoreRequest,
): StoreValue {
  switch (request.operation) {
    case 'load':
      return store.load();
    case 'saveDraft':
      return store.saveDraft(validateDraft(request.payload));
    case 'commitDraft':
      return store.commitDraft(validateDraft(request.payload, true));
    case 'updateNote':
      return store.updateNote(validateNoteEdit(request.payload));
    case 'search':
      return store.search(validateSearch(request.payload));
    case 'loadImages':
      return images.list(validateNoteId(request.payload));
    case 'addImages': {
      const { noteId, images: inputs } = validateAddImages(request.payload);
      return images.add(noteId, inputs);
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
    case 'close':
      store.close();
      return null;
  }
}
