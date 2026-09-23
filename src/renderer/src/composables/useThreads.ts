import { ref, type Ref } from 'vue';
import type {
  EntryCreate,
  EntryEdit,
  EntrySummary,
  NoteReference,
  ThreadCreate,
  ThreadEdit,
  ThreadSummary,
  TimelineOrder,
} from '../../../domain/thread';
import type { MemocraftApi } from '../../../shared/contracts';

export interface ThreadState {
  threads: Ref<ThreadSummary[]>;
  entries: Ref<EntrySummary[]>;
  references: Ref<NoteReference[]>;
  includeArchived: Ref<boolean>;
  loading: Ref<boolean>;
  error: Ref<string>;
  load(): Promise<boolean>;
  setIncludeArchived(value: boolean): Promise<boolean>;
  create(input: ThreadCreate): Promise<ThreadSummary | null>;
  update(edit: ThreadEdit): Promise<ThreadSummary | null>;
  setArchived(
    threadId: string,
    archived: boolean,
    expectedRevision: number,
  ): Promise<ThreadSummary | null>;
  addNotes(threadId: string, noteIds: string[]): Promise<boolean>;
  removeNote(threadId: string, noteId: string): Promise<boolean>;
  loadEntries(threadId: string, order: TimelineOrder): Promise<boolean>;
  createEntry(input: EntryCreate): Promise<EntrySummary | null>;
  updateEntry(edit: EntryEdit): Promise<EntrySummary | null>;
  loadReferences(noteId: string): Promise<boolean>;
}

function messageOf(error: { message: string }): string {
  return error.message;
}

/**
 * 长期事务现场：事务列表与当前打开的时间线各持一份，写入后就地替换受影响项。
 * 手记的反查结果单独存放，抽屉打开时按手记 ID 读取，避免把所有动态都读进内存。
 */
export function useThreads(bridge: MemocraftApi): ThreadState {
  const threads = ref<ThreadSummary[]>([]);
  const entries = ref<EntrySummary[]>([]);
  const references = ref<NoteReference[]>([]);
  const includeArchived = ref(false);
  const loading = ref(false);
  const error = ref('');

  function replace(updated: ThreadSummary): void {
    const index = threads.value.findIndex((item) => item.id === updated.id);
    if (index >= 0)
      threads.value = threads.value.map((item) => (item.id === updated.id ? updated : item));
    else threads.value = [updated, ...threads.value];
  }

  /** 归档筛选变化后重新读取列表；调用方拿到 false 时保留原列表并提示。 */
  async function load(): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const result = await bridge.loadThreads(includeArchived.value);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      threads.value = result.value;
      return true;
    } finally {
      loading.value = false;
    }
  }

  return {
    threads,
    entries,
    references,
    includeArchived,
    loading,
    error,
    load,
    async setIncludeArchived(value) {
      includeArchived.value = value;
      return await load();
    },
    async create(input) {
      error.value = '';
      const result = await bridge.createThread(input);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      replace(result.value);
      return result.value;
    },
    async update(edit) {
      error.value = '';
      const result = await bridge.updateThread(edit);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      replace(result.value);
      return result.value;
    },
    async setArchived(threadId, archived, expectedRevision) {
      error.value = '';
      const result = await bridge.archiveThread(threadId, archived, expectedRevision);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      replace(result.value);
      // 归档后是否还在列表里取决于当前筛选，重新读取以免留下不该显示的项。
      await load();
      return result.value;
    },
    async addNotes(threadId, noteIds) {
      error.value = '';
      // Vue 的响应式数组是 Proxy，无法通过 IPC 的结构化克隆；边界上转成普通数组。
      const result = await bridge.addNotesToThread(threadId, Array.from(noteIds, String));
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      replace(result.value);
      return true;
    },
    async removeNote(threadId, noteId) {
      error.value = '';
      const result = await bridge.removeNoteFromThread(threadId, noteId);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      replace(result.value);
      return true;
    },
    async loadEntries(threadId, order) {
      error.value = '';
      const result = await bridge.loadEntries(threadId, order);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      entries.value = result.value;
      return true;
    },
    async createEntry(input) {
      error.value = '';
      const result = await bridge.createEntry(input);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      return result.value;
    },
    async updateEntry(edit) {
      error.value = '';
      const result = await bridge.updateEntry(edit);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      entries.value = entries.value.map((item) =>
        item.id === result.value.id ? result.value : item,
      );
      return result.value;
    },
    async loadReferences(noteId) {
      references.value = [];
      const result = await bridge.loadNoteReferences(noteId);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      references.value = result.value;
      return true;
    },
  };
}
