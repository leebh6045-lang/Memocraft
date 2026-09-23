import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import { MAX_NOTE_IMAGE_COUNT } from '../../src/domain/note-image';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { backupLibrary, restoreDatabaseBackup } from '../../src/storage/backup';
import { GIF_4X2, JPEG_6X7, NOT_AN_IMAGE, PNG_2X3, WEBP_5X4 } from '../fixtures/images';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
let dataDirectory: string;
const stores: NoteStore[] = [];

function open(): { store: NoteStore; images: NoteImageStore } {
  const store = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  stores.push(store);
  // 附图与手记共用同一条连接，测试也按生产的装配方式构造。
  return { store, images: new NoteImageStore(store.connection(), dataDirectory) };
}

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: `附图手记 ${randomUUID()}`,
    ...overrides,
  };
}

function commit(store: NoteStore): Note {
  return store.commitDraft(draft());
}

function input(bytes: Uint8Array, originalName = 'sample') {
  return { bytes, originalName };
}

function imageFiles(directory = dataDirectory): string[] {
  const path = join(directory, 'attachments');
  return existsSync(path) ? readdirSync(path).sort() : [];
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-images-'));
  dataDirectory = join(temporaryDirectory, 'data');
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('真实 SQLite 附图闭环', () => {
  it('添加图片同时写入文件与元数据，尺寸与类型由内容判定', () => {
    const { store, images } = open();
    const note = commit(store);
    const list = images.add(note.id, [
      input(PNG_2X3, '设计草图.png'),
      input(JPEG_6X7, 'photo.jpg'),
      input(GIF_4X2, 'anim.gif'),
      input(WEBP_5X4, 'web.webp'),
    ]);
    expect(list.images.map((image) => image.mimeType)).toEqual([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);
    expect(list.images.map((image) => [image.width, image.height])).toEqual([
      [2, 3],
      [6, 7],
      [4, 2],
      [5, 4],
    ]);
    expect(list.images.map((image) => image.position)).toEqual([0, 1, 2, 3]);
    expect(list.images.map((image) => image.originalName)).toEqual([
      '设计草图.png',
      'photo.jpg',
      'anim.gif',
      'web.webp',
    ]);
    // 落盘扩展名只由签名决定，不看原文件名。
    expect(list.images.every((image) => image.relativePath.startsWith('attachments/'))).toBe(true);
    expect(imageFiles()).toEqual(
      list.images.map((image) => image.relativePath.replace('attachments/', '')).sort(),
    );
    expect(list.totalBytes).toBe(
      PNG_2X3.byteLength + JPEG_6X7.byteLength + GIF_4X2.byteLength + WEBP_5X4.byteLength,
    );
    // 重新打开后仍然可读，说明元数据真正落库。
    const reopened = open();
    expect(reopened.images.list(note.id)).toEqual(list);
  });

  it('非图片内容被拒绝，且不留下文件或记录', () => {
    const { store, images } = open();
    const note = commit(store);
    expect(() => images.add(note.id, [input(NOT_AN_IMAGE, 'fake.png')])).toThrow('只支持');
    expect(images.list(note.id).images).toEqual([]);
    expect(imageFiles()).toEqual([]);
  });

  it('未保存的 note_id 无法写入图片，外键不会产生孤儿记录', () => {
    const { store, images } = open();
    const note = commit(store);
    expect(() => images.add(randomUUID(), [input(PNG_2X3)])).toThrow('手记不存在');
    const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO note_images (id, note_id, relative_path, mime_type, byte_size, width, height, position, created_at)
             VALUES (?, ?, ?, 'image/png', 1, 1, 1, 9, '2026-09-21T00:00:00.000Z')`,
          )
          .run(randomUUID(), randomUUID(), `attachments/${randomUUID()}.png`),
      ).toThrow();
    } finally {
      database.close();
    }
    expect(images.list(note.id).images).toEqual([]);
  });

  it('命名只改显示名称，删除为软删除：文件保留但不再列出', () => {
    const { store, images } = open();
    const note = commit(store);
    const added = images.add(note.id, [input(PNG_2X3, 'original.png')]);
    const image = added.images[0];
    if (!image) throw new Error('测试前置数据缺失');
    const renamed = images.rename(image.id, '  证书截图  ');
    expect(renamed.images[0]?.displayName).toBe('证书截图');
    expect(renamed.images[0]?.originalName).toBe('original.png');
    expect(renamed.images[0]?.relativePath).toBe(image.relativePath);

    const removed = images.remove(image.id);
    expect(removed.images).toEqual([]);
    expect(removed.totalBytes).toBe(0);
    expect(imageFiles()).toEqual([image.relativePath.replace('attachments/', '')]);
    // 软删除的图片不能再被取图或改名。
    expect(() => images.readBytes(image.id)).toThrow('已删除');
    expect(() => images.rename(image.id, 'again')).toThrow('已删除');
    // 软删除的图片仍占用位置序号，新图片接着往后排，不与其冲突。
    const again = images.add(note.id, [input(JPEG_6X7)]);
    expect(again.images.map((item) => item.position)).toEqual([1]);
    expect(again.images.map((item) => item.mimeType)).toEqual(['image/jpeg']);
  });

  it('手记进入回收站后其图片不再可见也不可读取', () => {
    const { store, images } = open();
    const note = commit(store);
    const image = images.add(note.id, [input(PNG_2X3)]).images[0];
    if (!image) throw new Error('测试前置数据缺失');
    const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database
        .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), note.id);
    } finally {
      database.close();
    }
    expect(images.list(note.id)).toEqual({ images: [], totalBytes: 0 });
    expect(() => images.readBytes(image.id)).toThrow('回收站');
    // 文件仍然保留，软删除不丢内容。
    expect(imageFiles()).toHaveLength(1);
  });

  it('单条手记的图片数量上限在写入前生效', () => {
    const { store, images } = open();
    const note = commit(store);
    const batch = Array.from({ length: MAX_NOTE_IMAGE_COUNT }, () => input(PNG_2X3));
    expect(images.add(note.id, batch).images).toHaveLength(MAX_NOTE_IMAGE_COUNT);
    expect(() => images.add(note.id, [input(PNG_2X3)])).toThrow('最多保存');
    // 被拒绝的一批不会留下多余文件。
    expect(imageFiles()).toHaveLength(MAX_NOTE_IMAGE_COUNT);
  });

  it('数据库拒绝逃逸路径与非法字段，凭约束仍能保住附件目录', () => {
    const { store } = open();
    const note = commit(store);
    const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      database.exec('PRAGMA foreign_keys = ON');
      const insert = (relativePath: string, mimeType = 'image/png') =>
        database
          .prepare(
            `INSERT INTO note_images (id, note_id, relative_path, mime_type, byte_size, width, height, position, created_at)
             VALUES (?, ?, ?, ?, 1, 1, 1, 0, '2026-09-21T00:00:00.000Z')`,
          )
          .run(randomUUID(), note.id, relativePath, mimeType);
      expect(() => insert('../../etc/passwd')).toThrow();
      expect(() => insert('other/escape.png')).toThrow();
      expect(() => insert('attachments/../outside.png')).toThrow();
      expect(() => insert('attachments/ok.svg', 'image/svg+xml')).toThrow();
    } finally {
      database.close();
    }
  });
});

describe('图片随备份与恢复一起搬运', () => {
  it('目录包恢复后数据库与附件逐项一致', async () => {
    const { store, images } = open();
    const note = commit(store);
    images.add(note.id, [input(PNG_2X3, '第一张.png'), input(JPEG_6X7, '第二张.jpg')]);
    const other = commit(store);
    images.add(other.id, [input(GIF_4X2)]);
    const backup = join(temporaryDirectory, 'library-backup');
    await backupLibrary(store, images, backup);
    const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(manifest.attachments).toHaveLength(3);
    // 备份文件字节与源文件一致。
    for (const entry of manifest.attachments)
      expect(readFileSync(join(backup, entry.relativePath))).toEqual(
        readFileSync(join(dataDirectory, entry.relativePath)),
      );

    const destination = join(temporaryDirectory, 'restored');
    await restoreDatabaseBackup(backup, destination, migrationsDirectory);
    const restoredStore = new NoteStore({
      dataDirectory: destination,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      const restoredImages = new NoteImageStore(restoredStore.connection(), destination);
      expect(restoredStore.load()).toEqual(store.load());
      expect(restoredImages.list(note.id)).toEqual(images.list(note.id));
      expect(restoredImages.list(other.id)).toEqual(images.list(other.id));
      expect(imageFiles(destination)).toEqual(imageFiles());
    } finally {
      restoredStore.close();
    }
  });

  it('附件被改动或缺失时拒绝恢复，目标目录保持为空', async () => {
    const { store, images } = open();
    const note = commit(store);
    images.add(note.id, [input(PNG_2X3)]);
    const backup = join(temporaryDirectory, 'tampered-backup');
    await backupLibrary(store, images, backup);
    const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
    const target = join(backup, manifest.attachments[0].relativePath);
    writeFileSync(target, Buffer.from('tampered'));
    const destination = join(temporaryDirectory, 'tampered-restore');
    await expect(restoreDatabaseBackup(backup, destination, migrationsDirectory)).rejects.toThrow(
      '不一致',
    );
    expect(existsSync(destination)).toBe(false);

    rmSync(target, { force: true });
    await expect(restoreDatabaseBackup(backup, destination, migrationsDirectory)).rejects.toThrow(
      '缺少清单登记的附件',
    );
    expect(existsSync(destination)).toBe(false);
  });

  it('清单登记逃逸路径时拒绝恢复，不写到目标目录之外', async () => {
    const { store, images } = open();
    const note = commit(store);
    images.add(note.id, [input(PNG_2X3)]);
    const backup = join(temporaryDirectory, 'escape-backup');
    await backupLibrary(store, images, backup);
    const manifestPath = join(backup, 'backup.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.attachments[0].relativePath = '../../escaped.png';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const destination = join(temporaryDirectory, 'escape-restore');
    await expect(restoreDatabaseBackup(backup, destination, migrationsDirectory)).rejects.toThrow(
      '路径不合法',
    );
    expect(existsSync(join(temporaryDirectory, '..', 'escaped.png'))).toBe(false);
  });

  it('缺少清单的旧快照仍可恢复为无附件的库', async () => {
    const { store, images } = open();
    const note = commit(store);
    images.add(note.id, [input(PNG_2X3)]);
    const snapshotDirectory = join(temporaryDirectory, 'legacy');
    mkdirSync(snapshotDirectory);
    const snapshot = join(snapshotDirectory, 'old.sqlite');
    // 用 SQLite 备份接口生成一致快照：直接复制主库文件会漏掉 WAL 中尚未合并的内容。
    const live = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      await sqliteBackup(live, snapshot);
    } finally {
      live.close();
    }
    const destination = join(temporaryDirectory, 'legacy-restore');
    await restoreDatabaseBackup(snapshot, destination, migrationsDirectory);
    const restored = new NoteStore({
      dataDirectory: destination,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      expect(restored.load().notes.map((item) => item.id)).toEqual([note.id]);
      expect(imageFiles(destination)).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it('备份时附件文件缺失会中止，且不产生半套备份目录', async () => {
    const { store, images } = open();
    const note = commit(store);
    const image = images.add(note.id, [input(PNG_2X3)]).images[0];
    if (!image) throw new Error('测试前置数据缺失');
    rmSync(join(dataDirectory, image.relativePath), { force: true });
    const backup = join(temporaryDirectory, 'missing-file-backup');
    await expect(backupLibrary(store, images, backup)).rejects.toThrow('缺失');
    expect(existsSync(backup)).toBe(false);
    expect(
      readdirSync(temporaryDirectory).filter((name) => name.includes('missing-file-backup')),
    ).toEqual([]);
  });
});
