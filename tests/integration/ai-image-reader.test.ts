import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDraft, type NoteDraft } from '../../src/domain/note';
import { draftOwner, noteOwner } from '../../src/domain/note-image';
import { AiImageReader } from '../../src/main/ai-image-reader';
import { executeStoreRequest, type StoreContext } from '../../src/services/note-service';
import type { AiContentBlock } from '../../src/shared/ai';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import { failure, type Result } from '../../src/shared/errors';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { ExportStore } from '../../src/storage/export-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { NoteSearchStore } from '../../src/storage/note-search-store';
import { TagStore } from '../../src/storage/tag-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';
import { TrashStore } from '../../src/storage/trash-store';
import { GIF_4X2, JPEG_6X7, PNG_2X3, WEBP_5X4 } from '../fixtures/images';

let directory: string;
let stores: StoreContext;
const budget = { maxImages: 4, maxBase64Bytes: 8 * 1024 * 1024 };

/** 与存储线程相同的装配和分发；读取只用临时 SQLite 与临时附件，不接触用户库。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-ai-images-'));
  const dataDirectory = join(directory, 'data');
  const migrationsDirectory = resolve('migrations');
  const notes = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = notes.connection();
  const topics = new TopicStore(connection);
  const threads = new ThreadStore(connection);
  stores = {
    notes,
    images: new NoteImageStore(connection, dataDirectory),
    topics,
    tags: new TagStore(connection),
    threads,
    search: new SearchStore(connection),
    noteSearch: new NoteSearchStore(connection),
    trash: new TrashStore(connection, notes, topics, threads),
    exporter: new ExportStore(connection, notes, topics, threads),
    aiSettings: new AiSettingsStore(connection),
    periodSummaries: new PeriodSummaryStore(connection),
    dataDirectory,
    migrationsDirectory,
  };
});
afterEach(() => {
  stores.notes.close();
  rmSync(directory, { recursive: true, force: true });
});

async function request(request: StoreRequest): Promise<Result<StoreValue>> {
  try {
    return { ok: true, value: await executeStoreRequest(stores, request) };
  } catch (error) {
    return failure(error);
  }
}

function createDraft(): NoteDraft {
  const draft = { ...emptyDraft(randomUUID()), revision: 1, body: '附图参与 AI 判断' };
  stores.notes.saveDraft(draft);
  return draft;
}

function decode(blocks: AiContentBlock[]): { mimeType: string; bytes: Buffer }[] {
  return blocks.map((block) => {
    if (block.type !== 'image_url') throw new Error('读取器不应生成文本块');
    const match = /^data:([^;]+);base64,(.+)$/.exec(block.image_url.url);
    if (!match?.[1] || !match[2]) throw new Error('图片内容块格式不合法');
    expect(block.image_url.detail).toBe('auto');
    return { mimeType: match[1], bytes: Buffer.from(match[2], 'base64') };
  });
}

/** 内容快照加 total_changes 能捕获先写后还原；附件字节也逐个比较。 */
function snapshot() {
  const connection = stores.notes.connection();
  const tables = connection
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const attachments = join(stores.dataDirectory, 'attachments');
  return {
    changes: connection.prepare('SELECT total_changes() AS count').get(),
    version: connection.prepare('PRAGMA user_version').get(),
    tables: tables.map((table) => {
      if (typeof table.name !== 'string' || !/^[a-z_]+$/.test(table.name))
        throw new Error('测试库表名异常');
      return {
        name: table.name,
        rows: connection.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all(),
      };
    }),
    files: readdirSync(attachments)
      .sort()
      .map((name) => ({ name, bytes: readFileSync(join(attachments, name)) })),
  };
}

describe('AiImageReader 真实 SQLite 和附件读取', () => {
  it('未保存手记的草稿图片可读，顺序和原字节保留，数据库和文件均无写入', async () => {
    const draft = createDraft();
    const fixtures = [
      { bytes: PNG_2X3, originalName: '截屏.png', mimeType: 'image/png' },
      { bytes: JPEG_6X7, originalName: '照片.jpg', mimeType: 'image/jpeg' },
      { bytes: GIF_4X2, originalName: '动画.gif', mimeType: 'image/gif' },
      { bytes: WEBP_5X4, originalName: '草图.webp', mimeType: 'image/webp' },
    ];
    const added = stores.images.add(draftOwner(draft.id), fixtures);
    expect(added.images.every((image) => image.noteId === null && image.draftId === draft.id)).toBe(
      true,
    );
    expect(stores.notes.load().notes).toEqual([]);
    const before = snapshot();
    const bridge = vi.fn(request);
    const result = await new AiImageReader({ request: bridge }).collect(
      added.images.map((image) => image.id),
      budget,
    );
    expect(result).toMatchObject({ used: 4, skipped: 0 });
    expect(decode(result.blocks)).toEqual(
      fixtures.map((fixture) => ({
        mimeType: fixture.mimeType,
        bytes: Buffer.from(fixture.bytes),
      })),
    );
    expect(bridge.mock.calls.map(([operation]) => operation)).toEqual(
      added.images.map((image) => ({ operation: 'readImage', payload: image.id })),
    );
    expect(snapshot()).toEqual(before);
    expect(stores.notes.load().draft).toEqual(draft);
  });

  it('移出图片、缺失附件和不存在 ID 都被跳过，后续有效图片仍可参与且无副作用', async () => {
    const draft = createDraft();
    const added = stores.images.add(draftOwner(draft.id), [
      { bytes: PNG_2X3, originalName: '已移出.png' },
      { bytes: GIF_4X2, originalName: '缺失.gif' },
      { bytes: WEBP_5X4, originalName: '保留.webp' },
    ]);
    const [removed, missing, valid] = added.images;
    if (!removed || !missing || !valid) throw new Error('图片前置数据缺失');
    stores.images.remove(removed.id);
    rmSync(join(stores.dataDirectory, missing.relativePath));
    const before = snapshot();
    const result = await new AiImageReader({ request }).collect(
      [removed.id, missing.id, randomUUID(), valid.id],
      budget,
    );
    expect(result).toMatchObject({ used: 1, skipped: 3 });
    expect(decode(result.blocks)).toEqual([
      { mimeType: 'image/webp', bytes: Buffer.from(WEBP_5X4) },
    ]);
    expect(snapshot()).toEqual(before);
    expect(stores.images.list(draftOwner(draft.id)).images.map((image) => image.id)).toEqual([
      missing.id,
      valid.id,
    ]);
  });

  it('保存后进入回收站的手记图片不可读；超尺寸草稿图跳过后继续，预算限制不改变库内容', async () => {
    const saved = stores.notes.commitDraft({
      ...emptyDraft(randomUUID()),
      revision: 1,
      body: '回收站附图',
    });
    const deletedImage = stores.images.add(noteOwner(saved.id), [
      { bytes: PNG_2X3, originalName: '回收站.png' },
    ]).images[0];
    if (!deletedImage) throw new Error('已保存图片缺失');
    stores.notes.remove(saved.id);
    const draft = createDraft();
    const oversized = Uint8Array.from(PNG_2X3);
    new DataView(oversized.buffer).setUint32(16, 8193);
    const added = stores.images.add(draftOwner(draft.id), [
      { bytes: oversized, originalName: '超宽.png' },
      { bytes: JPEG_6X7, originalName: '正常.jpg' },
      { bytes: GIF_4X2, originalName: '预算外.gif' },
    ]);
    const before = snapshot();
    const bridge = vi.fn(request);
    const result = await new AiImageReader({ request: bridge }).collect(
      [deletedImage.id, ...added.images.map((image) => image.id)],
      { ...budget, maxImages: 1 },
    );
    expect(result).toMatchObject({ used: 1, skipped: 3 });
    expect(decode(result.blocks)).toEqual([
      { mimeType: 'image/jpeg', bytes: Buffer.from(JPEG_6X7) },
    ]);
    expect(bridge).toHaveBeenCalledTimes(3);
    expect(snapshot()).toEqual(before);
  });
});
