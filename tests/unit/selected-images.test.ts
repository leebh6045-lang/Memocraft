import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleAddImagesFromDialog, readSelectedImages } from '../../src/main/ipc/register';
import { MAX_IMAGE_BYTES } from '../../src/domain/note-image';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';
import { PNG_2X3 } from '../fixtures/images';

/**
 * 系统选图对话框无法自动化，但它之后的主进程读取逻辑必须可验证：
 * 这里用真实临时文件覆盖成功路径、后缀与体积限制，以及数量上限。
 */
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-selected-'));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function fixture(name: string, bytes: Uint8Array): string {
  const path = join(directory, name);
  writeFileSync(path, bytes);
  return path;
}

describe('系统选图后的主进程读取', () => {
  it('读取真实文件字节并保留原文件名', async () => {
    const result = await readSelectedImages([
      fixture('设计草图.PNG', PNG_2X3),
      fixture('photo.jpeg', PNG_2X3),
    ]);
    expect(result).toHaveLength(2);
    // Buffer 在断言比较中等价于其字节内容，逐个比较避免类型差异造成误判。
    expect(Array.from(result[0]?.bytes ?? [])).toEqual(Array.from(PNG_2X3));
    expect(result[0]?.originalName).toBe('设计草图.PNG');
    expect(result[1]?.originalName).toBe('photo.jpeg');
  });

  it('拒绝非图片后缀与空文件，不把内容读进内存', async () => {
    await expect(readSelectedImages([fixture('note.txt', PNG_2X3)])).rejects.toThrow('只支持');
    await expect(readSelectedImages([fixture('empty.png', new Uint8Array())])).rejects.toThrow(
      '为空',
    );
  });

  it('超过单张上限或一次数量上限时拒绝', async () => {
    const large = new Uint8Array(MAX_IMAGE_BYTES + 1);
    await expect(readSelectedImages([fixture('large.png', large)])).rejects.toThrow('不能超过');
    const many = Array.from({ length: 21 }, (_item, index) =>
      fixture(`many-${index}.png`, PNG_2X3),
    );
    await expect(readSelectedImages(many)).rejects.toThrow('最多添加');
  });
});

describe('选图对话框的取消与转发', () => {
  const owner = { kind: 'note', id: '22222222-2222-4222-8222-222222222222' } as const;

  function recorder() {
    const requests: StoreRequest[] = [];
    const request = async (value: StoreRequest): Promise<Result<StoreValue>> => {
      requests.push(value);
      return { ok: true, value: { images: [], totalBytes: 0 } };
    };
    return { requests, request };
  }

  it('取消选择时返回 null：没有写入，界面据此不提示成功', async () => {
    const { requests, request } = recorder();
    const result = await handleAddImagesFromDialog(
      async () => ({ canceled: true, filePaths: [] }),
      request,
      owner,
    );
    expect(result).toEqual({ ok: true, value: null });
    expect(requests).toEqual([]);
  });

  it('选择文件后把读到的字节随 addImages 一起提交', async () => {
    const { requests, request } = recorder();
    const result = await handleAddImagesFromDialog(
      async () => ({ canceled: false, filePaths: [fixture('选中的图片.png', PNG_2X3)] }),
      request,
      owner,
    );
    expect(result.ok).toBe(true);
    const add = requests[0];
    expect(add?.operation).toBe('addImages');
    if (add?.operation !== 'addImages') throw new Error('未提交添加请求');
    const payload = add.payload as { owner: unknown; images: { bytes: Uint8Array }[] };
    expect(payload.owner).toEqual(owner);
    expect(Array.from(payload.images[0]?.bytes ?? [])).toEqual(Array.from(PNG_2X3));
  });

  it('读取失败时返回可展示的错误，不向存储提交半套数据', async () => {
    const { requests, request } = recorder();
    const result = await handleAddImagesFromDialog(
      async () => ({ canceled: false, filePaths: [fixture('说明.txt', PNG_2X3)] }),
      request,
      owner,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('本应失败');
    expect(result.error.code).toBe('VALIDATION');
    expect(requests).toEqual([]);
  });
});
