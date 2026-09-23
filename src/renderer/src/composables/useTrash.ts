import { ref, type Ref } from 'vue';
import type { RemovalImpact, TrashItem, TrashKind } from '../../../domain/trash';
import type { MemocraftApi } from '../../../shared/contracts';

export interface TrashState {
  items: Ref<TrashItem[]>;
  loading: Ref<boolean>;
  error: Ref<string>;
  /** 待确认的删除；非空时应用外壳展示确认对话框。 */
  pending: Ref<RemovalImpact | null>;
  load(): Promise<boolean>;
  restore(kind: TrashKind, id: string): Promise<boolean>;
  /**
   * 请求删除：先取影响面并交给界面确认，用户确认后执行删除。
   * 返回是否真的删除了，调用方据此决定刷新或跳转。
   */
  requestRemoval(kind: TrashKind, id: string): Promise<boolean>;
  confirmRemoval(): Promise<boolean>;
  cancelRemoval(): void;
}

function messageOf(error: { message: string }): string {
  return error.message;
}

/**
 * 回收站现场：列表、删除确认与恢复。
 * 删除一律先展示影响面再执行，调用方不需要各自实现确认流程。
 */
export function useTrash(bridge: MemocraftApi): TrashState {
  const items = ref<TrashItem[]>([]);
  const loading = ref(false);
  const error = ref('');
  const pending = ref<RemovalImpact | null>(null);
  let resolver: ((removed: boolean) => void) | null = null;

  async function load(): Promise<boolean> {
    loading.value = true;
    error.value = '';
    try {
      const result = await bridge.loadTrash();
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      items.value = result.value;
      return true;
    } finally {
      loading.value = false;
    }
  }

  function settle(removed: boolean): void {
    pending.value = null;
    const resolve = resolver;
    resolver = null;
    resolve?.(removed);
  }

  return {
    items,
    loading,
    error,
    pending,
    load,
    async restore(kind, id) {
      error.value = '';
      const result = await bridge.restoreItem(kind, id);
      if (!result.ok) {
        error.value = messageOf(result.error);
        return false;
      }
      await load();
      return true;
    },
    async requestRemoval(kind, id) {
      error.value = '';
      const impact = await bridge.loadRemovalImpact(kind, id);
      if (!impact.ok) {
        error.value = messageOf(impact.error);
        return false;
      }
      pending.value = impact.value;
      return await new Promise<boolean>((resolve) => {
        resolver = resolve;
      });
    },
    async confirmRemoval() {
      const impact = pending.value;
      if (!impact) return false;
      const result = await bridge.removeItem(impact.kind, impact.id);
      if (!result.ok) {
        error.value = messageOf(result.error);
        settle(false);
        return false;
      }
      await load();
      settle(true);
      return true;
    },
    cancelRemoval() {
      settle(false);
    },
  };
}
