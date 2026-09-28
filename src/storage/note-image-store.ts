import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  imageExtension,
  isImageMimeType,
  readImageSize,
  MAX_IMAGE_BYTES,
  MAX_NOTE_IMAGE_BYTES,
  MAX_NOTE_IMAGE_COUNT,
  sniffImageMimeType,
  type ImageInput,
  type ImageMimeType,
  type NoteImage,
  type NoteImageIndex,
  type NoteImageList,
  type NoteImageSummary,
} from '../domain/note-image';
import { AppError } from '../shared/errors';
import { requireMigrationVersion, transaction } from './database';
import { SCHEMA_VERSION } from './schema';
import { IMAGE_SELF_VISIBLE, IMAGE_VISIBLE, NOTE_VISIBLE } from './visibility';

export const ATTACHMENTS_DIRECTORY = 'attachments';

type DatabaseRow = Record<string, SQLOutputValue>;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '图片记录字段异常，原数据已保留。');
  return value;
}

function numberField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new AppError('STORAGE', '图片记录字段异常，原数据已保留。');
  return value;
}

function tryRemoveFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // 清理失败只留下不可见的孤儿文件；不能因此把已完成的失败结果改成异常。
  }
}

/**
 * 附图存储：文件落在数据目录的 attachments/ 下，元数据落在 note_images。
 * 与 NoteStore 共用同一个单连接，由 worker 串行调用，因此不需要额外加锁。
 */
export class NoteImageStore {
  private readonly attachmentsDirectory: string;

  constructor(
    private readonly database: DatabaseSync,
    dataDirectory: string,
    /** 期望的库版本；默认当前应用版本。读取旧版本库的迁移/备份用例会显式传入较小值。 */
    expectedSchemaVersion: number = SCHEMA_VERSION,
  ) {
    requireMigrationVersion(database, expectedSchemaVersion);
    this.attachmentsDirectory = join(dataDirectory, ATTACHMENTS_DIRECTORY);
  }

  list(noteId: string): NoteImageList {
    // 手记在回收站时其图片不可见；图片自身的软删除单独判断。
    if (!this.findNote(noteId)) return { images: [], totalBytes: 0 };
    const rows = this.database
      .prepare(
        `SELECT * FROM note_images WHERE note_id = ? AND ${IMAGE_SELF_VISIBLE} ORDER BY position, id`,
      )
      .all(noteId);
    const images = rows.map((row) => this.imageFromRow(row));
    return { images, totalBytes: images.reduce((total, image) => total + image.byteSize, 0) };
  }

  /**
   * 列表缩略图用：一次取回一批手记的图片摘要，避免为每条手记单独发起请求。
   * 可见性与 list 一致（图片与所属手记都未删除），只取展示需要的列，不读文件。
   */
  listSummaries(noteIds: string[]): NoteImageIndex {
    if (noteIds.length === 0) return {};
    const placeholders = noteIds.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT note_images.id, note_images.note_id, note_images.display_name, note_images.original_name,
                note_images.width, note_images.height
           FROM note_images
           JOIN notes ON notes.id = note_images.note_id
          WHERE note_images.note_id IN (${placeholders}) AND ${IMAGE_VISIBLE}
          ORDER BY note_images.note_id, note_images.position, note_images.id`,
      )
      .all(...noteIds);
    const index: NoteImageIndex = {};
    for (const row of rows) {
      const noteId = stringField(row, 'note_id');
      const summary: NoteImageSummary = {
        id: stringField(row, 'id'),
        displayName: stringField(row, 'display_name'),
        originalName: stringField(row, 'original_name'),
        width: numberField(row, 'width'),
        height: numberField(row, 'height'),
      };
      const bucket = index[noteId];
      if (bucket) bucket.push(summary);
      else index[noteId] = [summary];
    }
    return index;
  }

  add(noteId: string, inputs: ImageInput[]): NoteImageList {
    if (!this.findNote(noteId)) throw new AppError('NOT_FOUND', '手记不存在或已进入回收站。');
    const prepared = inputs.map((input) => this.prepareImage(input));
    const addedBytes = prepared.reduce((total, image) => total + image.bytes.byteLength, 0);
    mkdirSync(this.attachmentsDirectory, { recursive: true });
    const written: string[] = [];
    try {
      for (const image of prepared) {
        const path = this.filePath(image.relativePath);
        writeFileSync(path, image.bytes, { flag: 'wx' });
        written.push(path);
      }
    } catch (error) {
      // 文件系统没有事务：任一张写入失败就把本次已写入的文件删掉，不留半套结果。
      for (const path of written) tryRemoveFile(path);
      if (error instanceof AppError) throw error;
      throw new AppError('STORAGE', '图片未能写入数据目录，请检查可用空间后重试。');
    }
    try {
      transaction(this.database, () => {
        // 数量与体积上限在事务内按最新状态判断，避免与并发写入互相覆盖。
        const current = this.list(noteId);
        if (current.images.length + prepared.length > MAX_NOTE_IMAGE_COUNT) {
          throw new AppError('VALIDATION', `每条手记最多保存 ${MAX_NOTE_IMAGE_COUNT} 张图片。`);
        }
        if (current.totalBytes + addedBytes > MAX_NOTE_IMAGE_BYTES) {
          throw new AppError(
            'VALIDATION',
            `每条手记的图片总大小不能超过 ${Math.round(MAX_NOTE_IMAGE_BYTES / 1024 / 1024)} MB。`,
          );
        }
        // 位置必须接在已有最大位置之后：软删除的图片仍占用位置，不能复用它的序号。
        const last = this.database
          .prepare('SELECT max(position) AS last FROM note_images WHERE note_id = ?')
          .get(noteId)?.last;
        let position = typeof last === 'number' && Number.isSafeInteger(last) ? last + 1 : 0;
        for (const image of prepared) {
          this.database
            .prepare(
              `INSERT INTO note_images
                (id, note_id, relative_path, mime_type, byte_size, width, height, display_name, original_name, position, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
            )
            .run(
              image.id,
              noteId,
              image.relativePath,
              image.mimeType,
              image.bytes.byteLength,
              image.width,
              image.height,
              image.originalName,
              position,
              new Date().toISOString(),
            );
          position += 1;
        }
      });
    } catch (error) {
      // 数据库回滚后文件已失去归属，按同一顺序补偿删除。
      for (const path of written) tryRemoveFile(path);
      throw error;
    }
    return this.list(noteId);
  }

  rename(imageId: string, displayName: string): NoteImageList {
    const image = this.requireImage(imageId);
    transaction(this.database, () => {
      this.database
        .prepare('UPDATE note_images SET display_name = ? WHERE id = ?')
        .run(displayName.trim(), imageId);
    });
    return this.list(image.noteId);
  }

  remove(imageId: string): NoteImageList {
    const image = this.requireImage(imageId);
    transaction(this.database, () => {
      // 软删除只标记时间：文件保留，回收站语义与手记、归纳保持一致。
      this.database
        .prepare(`UPDATE note_images SET deleted_at = ? WHERE id = ? AND ${IMAGE_SELF_VISIBLE}`)
        .run(new Date().toISOString(), imageId);
    });
    return this.list(image.noteId);
  }

  /** 自定义协议取图：每次请求都按 ID、软删除、所属手记和路径归属重新校验。 */
  readBytes(imageId: string): { image: NoteImage; bytes: Buffer } {
    const image = this.requireImage(imageId);
    if (!this.findNote(image.noteId)) throw new AppError('NOT_FOUND', '图片所属手记已进入回收站。');
    const path = this.filePath(image.relativePath);
    if (!existsSync(path))
      throw new AppError('NOT_FOUND', '图片文件不在数据目录中，可能已被移动。');
    return { image, bytes: readFileSync(path) };
  }

  /** 备份用：导出全部图片文件（含已软删除的），由备份实现复制到目标目录。 */
  allFiles(): { relativePath: string; bytes: Buffer }[] {
    const rows = this.database.prepare('SELECT relative_path FROM note_images ORDER BY id').all();
    return rows.map((row) => {
      const relativePath = stringField(row, 'relative_path');
      const path = this.filePath(relativePath);
      if (!existsSync(path))
        throw new AppError('STORAGE', '图片文件缺失，备份已停止且未覆盖任何已有备份。');
      return { relativePath, bytes: readFileSync(path) };
    });
  }

  private prepareImage(input: ImageInput): {
    id: string;
    relativePath: string;
    bytes: Uint8Array;
    mimeType: ImageMimeType;
    width: number;
    height: number;
    originalName: string;
  } {
    if (input.bytes.byteLength > MAX_IMAGE_BYTES)
      throw new AppError(
        'VALIDATION',
        `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB。`,
      );
    const mimeType = sniffImageMimeType(input.bytes);
    if (!mimeType)
      throw new AppError('VALIDATION', '只支持 PNG、JPEG、GIF 与 WebP 图片，请换一张再试。');
    const size = readImageSize(input.bytes, mimeType);
    if (!size || size.width <= 0 || size.height <= 0)
      throw new AppError('VALIDATION', '这张图片无法识别尺寸，可能已损坏。');
    const id = randomUUID();
    return {
      id,
      // 扩展名只由签名决定，原文件名不会进入落盘路径。
      relativePath: `${ATTACHMENTS_DIRECTORY}/${id}${imageExtension(mimeType)}`,
      bytes: input.bytes,
      mimeType,
      width: size.width,
      height: size.height,
      originalName: input.originalName,
    };
  }

  /** 相对路径先按前缀与上跳过滤，再拼绝对路径并核对仍在附件目录内。 */
  private filePath(relativePath: string): string {
    if (!relativePath.startsWith(`${ATTACHMENTS_DIRECTORY}/`) || relativePath.includes('..'))
      throw new AppError('STORAGE', '图片路径不在附件目录内，已拒绝访问。');
    const base = resolve(this.attachmentsDirectory);
    const target = resolve(base, relative(ATTACHMENTS_DIRECTORY, relativePath));
    const inside = relative(base, target);
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new AppError('STORAGE', '图片路径不在附件目录内，已拒绝访问。');
    return target;
  }

  private findNote(noteId: string): boolean {
    // 只做存在性与软删除判断，不复制手记读取逻辑。
    const row = this.database
      .prepare(`SELECT 1 AS present FROM notes WHERE id = ? AND ${NOTE_VISIBLE}`)
      .get(noteId);
    return row !== undefined;
  }

  private requireImage(imageId: string): NoteImage {
    const row = this.database
      .prepare(`SELECT * FROM note_images WHERE id = ? AND ${IMAGE_SELF_VISIBLE}`)
      .get(imageId);
    if (!row) throw new AppError('NOT_FOUND', '图片不存在或已删除。');
    return this.imageFromRow(row);
  }

  private imageFromRow(row: DatabaseRow): NoteImage {
    const mimeType = row.mime_type;
    if (!isImageMimeType(mimeType))
      throw new AppError('STORAGE', '图片类型字段异常，原数据已保留。');
    return {
      id: stringField(row, 'id'),
      noteId: stringField(row, 'note_id'),
      relativePath: stringField(row, 'relative_path'),
      mimeType,
      byteSize: numberField(row, 'byte_size'),
      width: numberField(row, 'width'),
      height: numberField(row, 'height'),
      displayName: stringField(row, 'display_name'),
      originalName: stringField(row, 'original_name'),
      position: numberField(row, 'position'),
      createdAt: stringField(row, 'created_at'),
    };
  }
}
