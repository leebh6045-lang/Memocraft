import { writeFileSync } from 'node:fs';

/**
 * 测试用图片：用代码生成最小但结构合法的图片字节。
 * 不向仓库提交二进制样例，也不包含任何个人内容。
 * 尺寸取 2×3 等非正方形，便于验证宽高是按文件头解析而不是写死的默认值。
 */

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

/** 2×3 的 PNG，字节与 CRC 合法，可被浏览器真正解码。 */
export const PNG_2X3 = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR42mOwjq4BIgYUCgBB/QZtMEoWTgAAAABJRU5ErkJggg==',
);

/** 4×2 的 GIF87a，无调色板数据也足以让头部解析出尺寸。 */
export const GIF_4X2 = fromBase64('R0lGODdhBAACAAAAAAAAACwAAAAABAAEAAACAkQBADs=');

/** 5×4 的 WebP（VP8L 无损格式），宽高位打包进 4 字节位流。 */
export const WEBP_5X4 = fromBase64('UklGRhYAAABXRUJQVlA4TAkAAAAvBMAAEAAAAAAA');

/** 6×7 的 JPEG：含 SOF0 段，用于验证逐段扫描的逻辑。 */
export const JPEG_6X7 = fromBase64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/wAARCAAHAAYDAREAAhEAAxEA/8QAEwAAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIAAwAAPwAAAAAAAAAAAP/Z',
);

/** 不是任何受支持图片：用于验证按签名拒绝。 */
export const NOT_AN_IMAGE = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x3e, 0x00, 0x01]);

export function writeFixture(path: string, bytes: Uint8Array): string {
  writeFileSync(path, bytes);
  return path;
}
