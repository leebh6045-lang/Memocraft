import { ref, type Ref } from 'vue';
import type { TopicCreate, TopicEdit, TopicSummary } from '../../../domain/topic';
import type { MemocraftApi } from '../../../shared/contracts';

export interface TopicState {
  topics: Ref<TopicSummary[]>;
  loading: Ref<boolean>;
  error: Ref<string>;
  /** 读取全部归纳；渲染端持有这份列表，收录数量与"是否已收录"都由它推导。 */
  load(): Promise<boolean>;
  create(input: TopicCreate): Promise<TopicSummary | null>;
  update(edit: TopicEdit): Promise<TopicSummary | null>;
  addNotes(topicId: string, noteIds: string[]): Promise<boolean>;
  removeNote(topicId: string, noteId: string): Promise<boolean>;
}

function messageOf(error: { message: string }): string {
  return error.message;
}

/**
 * 归纳现场：列表是唯一数据源，创建、收录、移出都返回受影响归纳的最新形态并就地替换，
 * 因此列表计数、详情收录列表与选择器的已收录状态会同时更新，不需要额外的刷新信号。
 */
export function useTopics(bridge: MemocraftApi): TopicState {
  const topics = ref<TopicSummary[]>([]);
  const loading = ref(false);
  const error = ref('');

  function replace(updated: TopicSummary): void {
    const index = topics.value.findIndex((item) => item.id === updated.id);
    if (index >= 0)
      topics.value = topics.value.map((item) => (item.id === updated.id ? updated : item));
    else topics.value = [updated, ...topics.value];
  }

  async function load(): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const result = await bridge.loadTopics();
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      topics.value = result.value;
      return true;
    } finally {
      loading.value = false;
    }
  }

  return {
    topics,
    loading,
    error,
    load,
    async create(input) {
      error.value = '';
      const result = await bridge.createTopic(input);
      if (!result.ok) {
        // 同名冲突由界面询问用户后带 confirmDuplicate 重试，因此这里原样返回提示。
        error.value = messageOf(result.error);
        return null;
      }
      replace(result.value);
      return result.value;
    },
    async update(edit) {
      error.value = '';
      const result = await bridge.updateTopic(edit);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return null;
      }
      replace(result.value);
      return result.value;
    },
    async addNotes(topicId, noteIds) {
      error.value = '';
      // Vue 的响应式数组是 Proxy，无法通过 IPC 的结构化克隆；边界上转成普通数组。
      const result = await bridge.addNotesToTopic(topicId, Array.from(noteIds, String));
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      replace(result.value);
      return true;
    },
    async removeNote(topicId, noteId) {
      error.value = '';
      const result = await bridge.removeNoteFromTopic(topicId, noteId);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      replace(result.value);
      return true;
    },
  };
}
