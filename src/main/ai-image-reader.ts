import { isImageMimeType, readImageSize, sniffImageMimeType } from '../domain/note-image';
import type { AiContentBlock } from '../shared/ai';
import type { ImageBytes, StoreRequest, StoreValue } from '../shared/contracts';
import { AppError, type Result } from '../shared/errors';

export interface AiImageBudget {
  maxImages: number;
  /** 编码后的字符数，不含 data URL 前缀。 */
  maxBase64Bytes: number;
  /** 默认 auto，归纳建议与周期回顾均保留截图细节；调用方可显式指定低精度。 */
  detail?: 'auto' | 'low';
}

export interface AiImageCollection {
  blocks: AiContentBlock[];
  used: number;
  skipped: number;
  /** 与 blocks 一一对应，跳过图片后仍能回填正确的手记归属。 */
  imageIds: string[];
}

interface AiImageReaderDependencies {
  request(request: StoreRequest): Promise<Result<StoreValue>>;
}

// 供应商当前要求单边不超过 8192；首版只检查文件头，超尺寸跳过，不解码缩放。
const MAX_IMAGE_DIMENSION = 8192;

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('AI_CANCELLED', 'AI 请求已取消。');
}

function validateBudget(budget: AiImageBudget): void {
  if (
    !Number.isSafeInteger(budget.maxImages) ||
    budget.maxImages < 0 ||
    !Number.isSafeInteger(budget.maxBase64Bytes) ||
    budget.maxBase64Bytes < 0
  )
    throw new AppError('VALIDATION', 'AI 图片预算必须是非负整数。');
}

function isUsableImage(value: unknown): value is ImageBytes {
  if (typeof value !== 'object' || value === null || !('bytes' in value) || !('mimeType' in value))
    return false;
  const { bytes, mimeType } = value;
  if (!(bytes instanceof Uint8Array) || !isImageMimeType(mimeType)) return false;
  // 不把损坏附件或与记录不符的类型发给供应商；尺寸解析沿用项目现有规则。
  if (sniffImageMimeType(bytes) !== mimeType) return false;
  const size = readImageSize(bytes, mimeType);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width <= MAX_IMAGE_DIMENSION &&
    size.height <= MAX_IMAGE_DIMENSION
  );
}

/** 只读图片并按预算编码；字节始终留在主进程，不经渲染端回传。 */
export class AiImageReader {
  constructor(private readonly dependencies: AiImageReaderDependencies) {}

  async collect(
    imageIds: string[],
    budget: AiImageBudget,
    signal?: AbortSignal,
  ): Promise<AiImageCollection> {
    validateBudget(budget);
    requireActive(signal);
    const ids = [...imageIds];
    const blocks: AiContentBlock[] = [];
    const acceptedIds: string[] = [];
    let base64Bytes = 0;
    for (const id of ids) {
      requireActive(signal);
      if (blocks.length >= budget.maxImages || base64Bytes >= budget.maxBase64Bytes) break;
      let result: Result<StoreValue>;
      try {
        result = await this.dependencies.request({ operation: 'readImage', payload: id });
      } catch (error) {
        requireActive(signal);
        if (error instanceof AppError && error.code === 'AI_CANCELLED') throw error;
        // 某张附件不可读不影响其他图片；底层路径与异常不进入 prompt 或界面。
        continue;
      }
      requireActive(signal);
      if (!result.ok) {
        if (result.error.code === 'AI_CANCELLED')
          throw new AppError('AI_CANCELLED', 'AI 请求已取消。');
        continue;
      }
      if (!isUsableImage(result.value)) continue;
      const { bytes, mimeType } = result.value;
      // 先算编码长度再分配字符串；预算不足即停止，不再读取余下的附件。
      const encodedLength = Math.ceil(bytes.byteLength / 3) * 4;
      if (encodedLength > budget.maxBase64Bytes - base64Bytes) break;
      blocks.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
          detail: budget.detail ?? 'auto',
        },
      });
      acceptedIds.push(id);
      base64Bytes += encodedLength;
    }
    return {
      blocks,
      used: blocks.length,
      skipped: ids.length - blocks.length,
      imageIds: acceptedIds,
    };
  }
}
