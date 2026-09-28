import { ref } from 'vue';
import { MAX_IMAGE_INDEX_NOTES, type NoteImageIndex } from '../../../domain/note-image';
import type { MemocraftApi } from '../../../shared/contracts';

/**
 * 列表缩略图用的图片摘要缓存：按手记 ID 批量读取，已经问过的 ID 不再重复请求。
 * 摘要只含 ID、名称与尺寸，缩略图仍由自定义协议按 ID 取图，渲染端拿不到文件路径。
 * 读取失败不写入缓存，下次列表变化时会重试，并只报告一次，避免每次渲染都提示。
 */
export function useNoteImageIndex(
  api: Pick<MemocraftApi, 'loadImageIndex'>,
  onError: (message: string) => void,
) {
  const index = ref<NoteImageIndex>({});
  /** 已经问过的 ID 包含「没有附图」的手记，否则每次列表变化都会把它们重问一遍。 */
  const asked = new Set<string>();
  let flight: Promise<void> | null = null;

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

  return { index, load };
}
