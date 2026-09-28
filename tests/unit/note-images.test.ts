import { describe, expect, it } from 'vitest';
import { useNoteImages } from '../../src/renderer/src/composables/useNoteImages';
import { draftOwner, noteOwner } from '../../src/domain/note-image';
import type { NoteImageList } from '../../src/domain/note-image';
import type { Result } from '../../src/shared/errors';

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const owner = noteOwner(NOTE_ID);
const withImage: NoteImageList = {
  images: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      noteId: NOTE_ID,
      draftId: null,
      relativePath: 'attachments/22222222-2222-4222-8222-222222222222.png',
      mimeType: 'image/png',
      byteSize: 120,
      width: 2,
      height: 3,
      displayName: '',
      originalName: '选中的图片.png',
      position: 0,
      createdAt: '2026-09-28T10:00:00.000Z',
    },
  ],
  totalBytes: 120,
};

/** 只有选图返回不同；其余图集能力不在本文件覆盖范围内，统一返回明确失败。 */
function api(addImagesFromDialog: () => Result<NoteImageList | null>) {
  const unused = async (): Promise<Result<never>> => ({
    ok: false,
    error: { code: 'UNAVAILABLE', message: '本用例不涉及这个操作。' },
  });
  return {
    loadImages: unused,
    addImagesFromDialog: async () => addImagesFromDialog(),
    addImageFromClipboard: unused,
    renameImage: unused,
    deleteImage: unused,
  };
}

describe('选图对话框的结果处理', () => {
  it('用户取消时不写状态、不改图集，也不刷新列表摘要', async () => {
    const refreshed: string[] = [];
    const images = useNoteImages(
      api(() => ({ ok: true, value: null })),
      (noteId) => refreshed.push(noteId),
    );

    expect(await images.addFromDialog(owner)).toBe(true);
    expect(images.status.value).toBe('');
    expect(images.error.value).toBe('');
    expect(images.images.value).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  it('真正添加后才提示成功并刷新这条手记的列表摘要', async () => {
    const refreshed: string[] = [];
    const images = useNoteImages(
      api(() => ({ ok: true, value: withImage })),
      (noteId) => refreshed.push(noteId),
    );

    expect(await images.addFromDialog(owner)).toBe(true);
    expect(images.status.value).toBe('图片已添加');
    expect(images.images.value).toHaveLength(1);
    expect(refreshed).toEqual([NOTE_ID]);
  });

  it('读取失败时保留原因，不假装成功', async () => {
    const images = useNoteImages(
      api(() => ({ ok: false, error: { code: 'VALIDATION', message: '只支持 PNG 图片。' } })),
      () => undefined,
    );

    expect(await images.addFromDialog(owner)).toBe(false);
    expect(images.error.value).toBe('只支持 PNG 图片。');
    expect(images.status.value).toBe('');
  });

  it('草稿归属不触发列表摘要刷新：草稿没有对应手记', async () => {
    const refreshed: string[] = [];
    const images = useNoteImages(
      api(() => ({ ok: true, value: withImage })),
      (noteId) => refreshed.push(noteId),
    );
    await images.addFromDialog(draftOwner('33333333-3333-4333-8333-333333333333'));
    expect(images.status.value).toBe('图片已添加');
    expect(refreshed).toEqual([]);
  });
});
