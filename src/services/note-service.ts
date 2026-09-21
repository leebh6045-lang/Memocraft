import type { StoreRequest, StoreValue } from '../shared/contracts';
import type { NoteStore } from '../storage/note-store';
import { validateDraft, validateNoteEdit, validateSearch } from './validation';

/** 一个请求对应一个同步存储用例；复合写入的事务由 NoteStore 保证。 */
export function executeStoreRequest(store: NoteStore, request: StoreRequest): StoreValue {
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
    case 'close':
      store.close();
      return null;
  }
}
