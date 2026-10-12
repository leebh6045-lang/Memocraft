import { describe, expect, it, vi } from 'vitest';
import { AiImageReader } from '../../src/main/ai-image-reader';
import type { ImageMimeType } from '../../src/domain/note-image';
import type { AiContentBlock } from '../../src/shared/ai';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { AppError, type Result } from '../../src/shared/errors';
import { GIF_4X2, JPEG_6X7, NOT_AN_IMAGE, PNG_2X3, WEBP_5X4 } from '../fixtures/images';

const budget = { maxImages: 4, maxBase64Bytes: 8 * 1024 * 1024 };
const encodedLength = (bytes: Uint8Array) => Math.ceil(bytes.byteLength / 3) * 4;

function image(bytes = PNG_2X3, mimeType: ImageMimeType = 'image/png'): Result<StoreValue> {
  return { ok: true, value: { mimeType, bytes } };
}

function urls(blocks: AiContentBlock[]): string[] {
  return blocks.map((block) => {
    if (block.type !== 'image_url') throw new Error('图片读取器不应生成文本块');
    expect(block.image_url.detail).toBe('auto');
    return block.image_url.url;
  });
}

function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(PNG_2X3);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, width);
  header.setUint32(20, height);
  return bytes;
}

describe('AiImageReader 图片参与判断', () => {
  it('按输入顺序编码四种项目支持的格式，并保留原字节与 auto detail', async () => {
    const fixtures = [
      { id: 'jpeg', bytes: JPEG_6X7, mimeType: 'image/jpeg' as const },
      { id: 'png', bytes: PNG_2X3, mimeType: 'image/png' as const },
      { id: 'webp', bytes: WEBP_5X4, mimeType: 'image/webp' as const },
      { id: 'gif', bytes: GIF_4X2, mimeType: 'image/gif' as const },
    ];
    const request = vi.fn(async (request: StoreRequest): Promise<Result<StoreValue>> => {
      if (request.operation !== 'readImage') throw new Error('只允许读取图片');
      const fixture = fixtures.find((fixture) => fixture.id === request.payload);
      if (!fixture) throw new Error('测试图片不存在');
      return image(fixture.bytes, fixture.mimeType);
    });
    const result = await new AiImageReader({ request }).collect(
      fixtures.map((fixture) => fixture.id),
      budget,
    );
    expect(result.used).toBe(4);
    expect(result.skipped).toBe(0);
    expect(urls(result.blocks)).toEqual(
      fixtures.map(
        (fixture) =>
          `data:${fixture.mimeType};base64,${Buffer.from(fixture.bytes).toString('base64')}`,
      ),
    );
    expect(request.mock.calls.map(([request]) => request)).toEqual(
      fixtures.map((fixture) => ({ operation: 'readImage', payload: fixture.id })),
    );
  });

  it('达到张数上限后不读取余下图片', async () => {
    const request = vi.fn(async () => image());
    const result = await new AiImageReader({ request }).collect(['first', 'second', 'third'], {
      ...budget,
      maxImages: 1,
    });
    expect(result).toMatchObject({ used: 1, skipped: 2 });
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: 'readImage', payload: 'first' });
  });

  it('base64 恰好达到预算时纳入该图片，并停止后续读取', async () => {
    const request = vi.fn(async () => image());
    const result = await new AiImageReader({ request }).collect(['first', 'second'], {
      ...budget,
      maxBase64Bytes: encodedLength(PNG_2X3),
    });
    expect(result).toMatchObject({ used: 1, skipped: 1 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('累计预算不足以纳入下一张时停止，不再读取更小的后续图片', async () => {
    const request = vi.fn(async () => image());
    const result = await new AiImageReader({ request }).collect(['first', 'too-large', 'smaller'], {
      ...budget,
      maxBase64Bytes: encodedLength(PNG_2X3) * 2 - 1,
    });
    expect(result).toMatchObject({ used: 1, skipped: 2 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalledWith({ operation: 'readImage', payload: 'smaller' });
  });

  it('第一张超过 base64 预算时全部跳过，仅读取第一张', async () => {
    const request = vi.fn(async () => image());
    expect(
      await new AiImageReader({ request }).collect(['first', 'second'], {
        ...budget,
        maxBase64Bytes: encodedLength(PNG_2X3) - 1,
      }),
    ).toEqual({ blocks: [], used: 0, skipped: 2, imageIds: [] });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxImages: 0, maxBase64Bytes: budget.maxBase64Bytes },
    { maxImages: budget.maxImages, maxBase64Bytes: 0 },
  ])('零预算不读取任何图片：%j', async (limit) => {
    const request = vi.fn(async () => image());
    expect(await new AiImageReader({ request }).collect(['first', 'second'], limit)).toEqual({
      blocks: [],
      imageIds: [],
      used: 0,
      skipped: 2,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('空图集直接返回，不请求存储', async () => {
    const request = vi.fn(async () => image());
    expect(await new AiImageReader({ request }).collect([], budget)).toEqual({
      blocks: [],
      imageIds: [],
      used: 0,
      skipped: 0,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('某张读取失败或存储桥抛错时跳过，仍尝试后续图片', async () => {
    const request = vi.fn(async (request: StoreRequest): Promise<Result<StoreValue>> => {
      if (request.operation !== 'readImage') throw new Error('只允许读取图片');
      if (request.payload === 'missing')
        return { ok: false, error: { code: 'NOT_FOUND', message: '附件不存在' } };
      if (request.payload === 'storage')
        return { ok: false, error: { code: 'STORAGE', message: '附件不可读' } };
      if (request.payload === 'throw') throw new Error('包含本地路径的底层异常');
      return image();
    });
    const result = await new AiImageReader({ request }).collect(
      ['missing', 'storage', 'throw', 'valid'],
      { ...budget, maxImages: 1 },
    );
    expect(result).toMatchObject({ used: 1, skipped: 3 });
    expect(request).toHaveBeenCalledTimes(4);
    expect(urls(result.blocks)).toEqual([
      `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
    ]);
  });

  it.each([
    ['横向超过限制', 8193, 3],
    ['纵向超过限制', 2, 8193],
    ['宽度为零', 0, 3],
    ['高度为零', 2, 0],
  ])('%s的图片跳过后继续收集', async (_name, width, height) => {
    const request = vi.fn(async (request: StoreRequest) =>
      image(
        request.operation === 'readImage' && request.payload === 'invalid'
          ? pngWithSize(width, height)
          : PNG_2X3,
      ),
    );
    const result = await new AiImageReader({ request }).collect(['invalid', 'valid'], budget);
    expect(result).toMatchObject({ used: 1, skipped: 1 });
    expect(request).toHaveBeenCalledTimes(2);
    expect(urls(result.blocks)).toEqual([
      `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
    ]);
  });

  it('单边尺寸恰好 8192 时仍纳入', async () => {
    const bytes = pngWithSize(8192, 8192);
    const result = await new AiImageReader({ request: async () => image(bytes) }).collect(
      ['boundary'],
      budget,
    );
    expect(result).toMatchObject({ used: 1, skipped: 0 });
  });

  it.each([
    null,
    {},
    { mimeType: 'image/png', bytes: Array.from(PNG_2X3) },
    { mimeType: 'image/svg+xml', bytes: PNG_2X3 },
    { mimeType: 'image/jpeg', bytes: PNG_2X3 },
    { mimeType: 'image/png', bytes: NOT_AN_IMAGE },
    { mimeType: 'image/png', bytes: PNG_2X3.slice(0, 8) },
  ])('存储返回不合法的字节／类型时安全跳过：%j', async (payload: unknown) => {
    const request = vi.fn(async (request: StoreRequest): Promise<Result<StoreValue>> =>
      request.operation === 'readImage' && request.payload === 'invalid'
        ? { ok: true, value: payload as StoreValue }
        : image(),
    );
    expect(
      await new AiImageReader({ request }).collect(['invalid', 'valid'], budget),
    ).toMatchObject({ used: 1, skipped: 1 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('只编码 Uint8Array 的可见切片，不包含底层缓冲区其他字节', async () => {
    const padded = new Uint8Array(PNG_2X3.length + 10);
    padded.set(PNG_2X3, 5);
    const bytes = padded.subarray(5, 5 + PNG_2X3.length);
    const result = await new AiImageReader({ request: async () => image(bytes) }).collect(
      ['slice'],
      budget,
    );
    expect(urls(result.blocks)).toEqual([
      `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
    ]);
  });

  it.each([
    { maxImages: -1, maxBase64Bytes: 100 },
    { maxImages: 1.5, maxBase64Bytes: 100 },
    { maxImages: Number.POSITIVE_INFINITY, maxBase64Bytes: 100 },
    { maxImages: 4, maxBase64Bytes: Number.NaN },
    { maxImages: 4, maxBase64Bytes: -1 },
    { maxImages: 4, maxBase64Bytes: Number.MAX_SAFE_INTEGER + 1 },
  ])('非法预算拒绝并且不读取附件：%j', async (limit) => {
    const request = vi.fn(async () => image());
    await expect(new AiImageReader({ request }).collect(['first'], limit)).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('开始前已取消时不读取附件', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => image());
    await expect(
      new AiImageReader({ request }).collect(['first'], budget, controller.signal),
    ).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(request).not.toHaveBeenCalled();
  });

  it('读取等待期间取消后，丢弃迟到字节且不读取后续图片', async () => {
    const controller = new AbortController();
    let release: (value: Result<StoreValue>) => void = () => {
      throw new Error('未开始读取');
    };
    const request = vi.fn(
      () =>
        new Promise<Result<StoreValue>>((resolve) => {
          release = resolve;
        }),
    );
    const pending = new AiImageReader({ request }).collect(
      ['first', 'second'],
      budget,
      controller.signal,
    );
    const outcome = expect(pending).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(request).toHaveBeenCalledTimes(1);
    controller.abort();
    release(image());
    await outcome;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['result', 'throw'])('存储%s的取消错误向上传播，不按普通缺图继续', async (kind) => {
    const request = vi.fn(async (): Promise<Result<StoreValue>> => {
      if (kind === 'throw') throw new AppError('AI_CANCELLED', '图片读取已取消');
      return { ok: false, error: { code: 'AI_CANCELLED', message: '图片读取已取消' } };
    });
    await expect(
      new AiImageReader({ request }).collect(['first', 'second'], budget),
    ).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
