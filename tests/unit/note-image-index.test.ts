import { describe, expect, it } from 'vitest';
import { useNoteImageIndex } from '../../src/renderer/src/composables/useNoteImageIndex';
import { MAX_IMAGE_INDEX_NOTES } from '../../src/domain/note-image';
import type { Result } from '../../src/shared/errors';
import type { NoteImageIndex } from '../../src/domain/note-image';

const NOTE_A = '11111111-1111-4111-8111-111111111111';
const NOTE_B = '22222222-2222-4222-8222-222222222222';
const NOTE_C = '33333333-3333-4333-8333-333333333333';

function summary(id: string) {
  return { id, displayName: '', originalName: `${id}.png`, width: 2, height: 3 };
}

/** 记录每次请求的 ID 列表，便于观察批量、缓存与重试行为。 */
function recorder(handler: (noteIds: string[]) => Result<NoteImageIndex>) {
  const calls: string[][] = [];
  return {
    calls,
    api: {
      loadImageIndex: async (noteIds: string[]): Promise<Result<NoteImageIndex>> => {
        calls.push([...noteIds]);
        return handler(noteIds);
      },
    },
  };
}

describe('列表缩略图的图片摘要缓存', () => {
  it('批量读回后按手记 ID 分组，没有附图的手记不出现', async () => {
    const { api, calls } = recorder(() => ({
      ok: true,
      value: { [NOTE_A]: [summary('a1'), summary('a2')], [NOTE_B]: [summary('b1')] },
    }));
    const errors: string[] = [];
    const store = useNoteImageIndex(api, (message) => errors.push(message));

    await store.load([NOTE_A, NOTE_B, NOTE_C]);
    expect(calls).toEqual([[NOTE_A, NOTE_B, NOTE_C]]);
    expect(store.index.value[NOTE_A]).toHaveLength(2);
    expect(store.index.value[NOTE_B]).toHaveLength(1);
    expect(store.index.value[NOTE_C]).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('已经问过的手记不再重复请求，新增手记只补读新的', async () => {
    const { api, calls } = recorder(() => ({ ok: true, value: {} }));
    const store = useNoteImageIndex(api, () => undefined);

    await store.load([NOTE_A, NOTE_B]);
    await store.load([NOTE_A, NOTE_B]);
    expect(calls).toHaveLength(1);
    await store.load([NOTE_A, NOTE_B, NOTE_C]);
    expect(calls).toEqual([[NOTE_A, NOTE_B], [NOTE_C]]);
  });

  it('超过单批上限时拆成多次请求，起点不重复', async () => {
    const ids = Array.from(
      { length: MAX_IMAGE_INDEX_NOTES + 3 },
      (_value, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    );
    const { api, calls } = recorder(() => ({ ok: true, value: {} }));
    const store = useNoteImageIndex(api, () => undefined);

    await store.load(ids);
    expect(calls.map((call) => call.length)).toEqual([MAX_IMAGE_INDEX_NOTES, 3]);
    expect(new Set(calls.flat()).size).toBe(ids.length);
  });

  it('读取失败不写入缓存：报告一次原因，下次调用仍会重试', async () => {
    let attempt = 0;
    const { api, calls } = recorder(() => {
      attempt += 1;
      return attempt === 1
        ? { ok: false, error: { code: 'UNAVAILABLE', message: '数据服务暂时不可用。' } }
        : { ok: true, value: { [NOTE_A]: [summary('a1')] } };
    });
    const errors: string[] = [];
    const store = useNoteImageIndex(api, (message) => errors.push(message));

    await store.load([NOTE_A]);
    expect(errors).toEqual(['数据服务暂时不可用。']);
    expect(store.index.value[NOTE_A]).toBeUndefined();

    await store.load([NOTE_A]);
    expect(calls).toHaveLength(2);
    expect(store.index.value[NOTE_A]).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});
