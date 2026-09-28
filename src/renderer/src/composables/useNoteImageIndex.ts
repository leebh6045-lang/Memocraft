import { ref } from 'vue';
import { MAX_IMAGE_INDEX_NOTES, type NoteImageIndex } from '../../../domain/note-image';
import type { MemocraftApi } from '../../../shared/contracts';

/**
 * 列表缩略图用的图片摘要缓存：按手记 ID 批量读取，已经问过的 ID 不再重复请求。
 * 摘要只含 ID、名称与尺寸，缩略图仍由自定义协议按 ID 取图，渲染端拿不到文件路径。
 * 读取失败不写入缓存，下次列表变化时会重试，并只报告一次，避免每次渲染都提示。
 *
 * 图集的增删与改名不改变手记集合，因此图集操作之后必须由调用方 refresh 这条手记，
 * 否则列表会一直沿用「当时问到的空结果」或旧名称。
 */
export function useNoteImageIndex(
  api: Pick<MemocraftApi, 'loadImageIndex'>,
  onError: (message: string) => void,
) {
  const index = ref<NoteImageIndex>({});
  /** 已经问过的 ID 包含「没有附图」的手记，否则每次列表变化都会把它们重问一遍。 */
  const asked = new Set<string>();
  let flight: Promise<void> | null = null;

  /** 图集变化后重读这一条：先丢掉缓存与「问过」的记录，再按新状态取一次。 */
  async function refresh(noteId: string): Promise<void> {
    asked.delete(noteId);
    const next = { ...index.value };
    delete next[noteId];
    index.value = next;
    await load([noteId]);
  }

  /** 整个库被替换（例如从备份恢复）后调用：下一次 load 会重新问全部手记。 */
  function reset(): void {
    asked.clear();
    index.value = {};
  }

  async function load(noteIds: string[]): Promise<void> {
    // 同一时刻只跑一批：列表在启动、保存与删除时都会触发，串行才能保证结果合并顺序稳定。
    if (flight) await flight;
    const pending = noteIds.filter((id) => !asked.has(id));
    if (!pending.length) return;
    flight = run(pending);
    try {
      await flight;
    } finally {
      flight = null;
    }
  }

  async function run(pending: string[]): Promise<void> {
    for (let start = 0; start < pending.length; start += MAX_IMAGE_INDEX_NOTES) {
      const chunk = pending.slice(start, start + MAX_IMAGE_INDEX_NOTES);
      const result = await api.loadImageIndex(chunk);
      if (!result.ok) {
        onError(result.error.message);
        return;
      }
      for (const id of chunk) asked.add(id);
      index.value = { ...index.value, ...result.value };
    }
  }

  return { index, load, refresh, reset };
}
