import { describe, expect, it } from 'vitest';
import {
  imageLabel,
  readImageSize,
  sniffImageMimeType,
  MAX_IMAGE_NAME_LENGTH,
  type NoteImage,
} from '../../src/domain/note-image';
import { GIF_4X2, JPEG_6X7, NOT_AN_IMAGE, PNG_2X3, WEBP_5X4 } from '../fixtures/images';
import {
  validateAddImages,
  validateImageRename,
  validateImageName,
} from '../../src/services/validation';

function image(overrides: Partial<NoteImage> = {}): NoteImage {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    noteId: '22222222-2222-4222-8222-222222222222',
    relativePath: 'attachments/11111111-1111-4111-8111-111111111111.png',
    mimeType: 'image/png',
    byteSize: 100,
    width: 2,
    height: 3,
    displayName: '',
    originalName: '',
    position: 0,
    createdAt: '2026-09-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('图片类型与尺寸识别', () => {
  it('按文件签名判定真实类型，不信任后缀或声明', () => {
    expect(sniffImageMimeType(PNG_2X3)).toBe('image/png');
    expect(sniffImageMimeType(JPEG_6X7)).toBe('image/jpeg');
    expect(sniffImageMimeType(GIF_4X2)).toBe('image/gif');
    expect(sniffImageMimeType(WEBP_5X4)).toBe('image/webp');
    expect(sniffImageMimeType(NOT_AN_IMAGE)).toBeNull();
    expect(sniffImageMimeType(new Uint8Array())).toBeNull();
  });

  it('从文件头解析宽高，不依赖解码像素', () => {
    expect(readImageSize(PNG_2X3, 'image/png')).toEqual({ width: 2, height: 3 });
    expect(readImageSize(GIF_4X2, 'image/gif')).toEqual({ width: 4, height: 2 });
    expect(readImageSize(WEBP_5X4, 'image/webp')).toEqual({ width: 5, height: 4 });
    expect(readImageSize(JPEG_6X7, 'image/jpeg')).toEqual({ width: 6, height: 7 });
  });

  it('截断的文件头返回 null 而不是抛出底层异常', () => {
    expect(readImageSize(PNG_2X3.subarray(0, 10), 'image/png')).toBeNull();
    expect(readImageSize(JPEG_6X7.subarray(0, 4), 'image/jpeg')).toBeNull();
    expect(readImageSize(GIF_4X2.subarray(0, 5), 'image/gif')).toBeNull();
  });
});

describe('图片显示名称', () => {
  it('优先用户命名，其次原文件名，最后按序号兜底', () => {
    expect(imageLabel(image({ displayName: '架构草图' }), 0)).toBe('架构草图');
    expect(imageLabel(image({ originalName: 'screenshot.png' }), 0)).toBe('screenshot.png');
    expect(imageLabel(image(), 2)).toBe('图片 3');
    expect(imageLabel(image({ displayName: '   ' }), 0)).toBe('图片 1');
  });

  it('名称超长被拒绝，两端空白被清理', () => {
    expect(validateImageName('  证书截图  ')).toBe('证书截图');
    expect(validateImageName('')).toBe('');
    expect(() => validateImageName('长'.repeat(MAX_IMAGE_NAME_LENGTH + 1))).toThrow('不能超过');
    expect(() => validateImageName(123)).toThrow();
  });
});

describe('图片入口校验', () => {
  const noteId = '22222222-2222-4222-8222-222222222222';

  it('接受 Uint8Array 与普通数字数组两种传输形态', () => {
    expect(validateAddImages({ noteId, images: [{ bytes: PNG_2X3 }] }).images[0]?.bytes).toEqual(
      PNG_2X3,
    );
    const asArray = validateAddImages({
      noteId,
      images: [{ bytes: Array.from(PNG_2X3), originalName: 'a.png' }],
    });
    expect(asArray.images[0]?.bytes).toEqual(PNG_2X3);
    expect(asArray.images[0]?.originalName).toBe('a.png');
  });

  it('空内容、非法标识与非数组载荷被拒绝', () => {
    expect(() => validateAddImages({ noteId, images: [] })).toThrow('请选择');
    expect(() => validateAddImages({ noteId, images: [{ bytes: new Uint8Array() }] })).toThrow(
      '为空',
    );
    expect(() =>
      validateAddImages({ noteId: '../escape', images: [{ bytes: PNG_2X3 }] }),
    ).toThrow();
    expect(() => validateAddImages({ noteId, images: PNG_2X3 })).toThrow();
    expect(() => validateAddImages({ noteId, images: [{ bytes: [0, 999] }] })).toThrow();
  });

  it('重命名载荷要求图片 ID 与名称同时合法', () => {
    expect(
      validateImageRename({ imageId: '11111111-1111-4111-8111-111111111111', displayName: ' 图 ' }),
    ).toEqual({ imageId: '11111111-1111-4111-8111-111111111111', displayName: '图' });
    expect(() => validateImageRename({ imageId: 'not-a-uuid', displayName: '图' })).toThrow();
    expect(() => validateImageRename({ displayName: '图' })).toThrow();
  });
});
