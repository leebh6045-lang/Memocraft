// 图片限制是业务入口的资源边界；超限明确拒绝并保留用户已添加的内容。
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_IMAGE_COUNT = 50;
export const MAX_NOTE_IMAGE_BYTES = 200 * 1024 * 1024;
export const MAX_IMAGE_NAME_LENGTH = 200;

/** 手记附图；正文不含图片引用，图集以 position 表达加入顺序。 */
export interface NoteImage {
  id: string;
  /** 归属手记；还没保存的草稿图片这里为 null。 */
  noteId: string | null;
  /** 归属草稿；保存手记时转成 note_id，之后为 null。 */
  draftId: string | null;
  /** 相对数据目录的路径，固定为 attachments/<id>.<扩展名>。 */
  relativePath: string;
  mimeType: ImageMimeType;
  byteSize: number;
  width: number;
  height: number;
  /** 用户命名；为空时展示回退名称，不写回该字段。 */
  displayName: string;
  originalName: string;
  position: number;
  createdAt: string;
}

/**
 * 图片的归属对象：已保存的手记，或首页还没保存的草稿。
 * 草稿附图在保存手记的同一事务里转成这条手记的图片，因此两者用同一套图集操作。
 */
export type ImageOwner = { kind: 'note'; id: string } | { kind: 'draft'; id: string };

export const noteOwner = (id: string): ImageOwner => ({ kind: 'note', id });
export const draftOwner = (id: string): ImageOwner => ({ kind: 'draft', id });

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** 待写入的一张图片；bytes 已由调用方携带，主进程只负责校验与落盘。 */
export interface ImageInput {
  bytes: Uint8Array;
  originalName: string;
}

export interface NoteImageList {
  images: NoteImage[];
  /** 供界面判断还能添加多少张、多少字节，避免用户添加后才被拒绝。 */
  totalBytes: number;
}

/**
 * 列表缩略图只要这些字段：ID 用于按 ID 取图，名称与尺寸用于可读名称和占位。
 * 不含相对路径与字节，渲染端仍然拿不到文件位置。
 */
export interface NoteImageSummary {
  id: string;
  displayName: string;
  originalName: string;
  width: number;
  height: number;
}

/** 一批手记的附图摘要，按手记 ID 分组；没有附图的手记可以不出现在结果里。 */
export type NoteImageIndex = Record<string, NoteImageSummary[]>;

/** 一次批量读取的手记条数上限：列表一次显示不了更多，也避免一条 SQL 塞入过多参数。 */
export const MAX_IMAGE_INDEX_NOTES = 200;

/**
 * 放大层需要的最小形状：按 ID 取图、按命名规则显示名称。
 * 图集里的完整图片与列表用的摘要都能直接传进来。
 */
export type ViewableImage = Pick<NoteImage, 'id' | 'displayName' | 'originalName'>;

export interface ImageCapacity {
  count: number;
  bytes: number;
}

const EXTENSIONS: Record<ImageMimeType, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function imageExtension(mimeType: ImageMimeType): string {
  return EXTENSIONS[mimeType];
}

export function isImageMimeType(value: unknown): value is ImageMimeType {
  return typeof value === 'string' && value in EXTENSIONS;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * 按文件签名判定真实类型，不信任调用方声明的 MIME 或文件后缀。
 * 只接受主流程需要位图解码的格式：PNG、JPEG、GIF、WebP。
 */
export function sniffImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // WebP 是 RIFF 容器：'RIFF' + 4 字节长度 + 'WEBP'。
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  )
    return 'image/webp';
  return null;
}

/**
 * 读取位图宽高；只解析文件头，不解码像素。
 * SVG 等矢量格式与损坏文件都返回 null，由调用方给出明确提示。
 */
export function readImageSize(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mimeType === 'image/png') {
      if (bytes.byteLength < 24) return null;
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (mimeType === 'image/gif') {
      if (bytes.byteLength < 10) return null;
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (mimeType === 'image/webp') {
      if (bytes.byteLength < 30) return null;
      const format = String.fromCharCode(...bytes.subarray(12, 16));
      if (format === 'VP8X')
        return { width: 1 + readUint24(view, 24), height: 1 + readUint24(view, 27) };
      if (format === 'VP8 ') {
        return {
          width: view.getUint16(26, true) & 0x3fff,
          height: view.getUint16(28, true) & 0x3fff,
        };
      }
      if (format === 'VP8L') {
        const bits = view.getUint32(21, true);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
      }
      return null;
    }
    return readJpegSize(bytes, view);
  } catch {
    // 头部被截断或长度声明超出实际文件时按「无法识别」处理，不向外抛底层异常。
    return null;
  }
}

function readUint24(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16)
  );
}

/** JPEG 的宽高在 SOF 段中，需要逐段跳过可变长度的其他标记。 */
function readJpegSize(bytes: Uint8Array, view: DataView): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    // SOF0–SOF15 中除 DHT、JPG、DAC 外都带尺寸信息。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * 显示名称优先用户命名，其次原文件名，最后按序号兜底；都不写回数据库字段。
 * 只要求命名相关的字段，图集与列表摘要都能复用同一条规则。
 */
export function imageLabel(
  image: Pick<NoteImage, 'displayName' | 'originalName'>,
  index: number,
): string {
  return image.displayName.trim() || image.originalName.trim() || `图片 ${index + 1}`;
}
