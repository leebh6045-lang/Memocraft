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
import { draftOwner, noteOwner } from '../../src/domain/note-image';
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
    const list = images.add(noteOwner(note.id), [
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
    expect(reopened.images.list(noteOwner(note.id))).toEqual(list);
  });

  it('非图片内容被拒绝，且不留下文件或记录', () => {
    const { store, images } = open();
    const note = commit(store);
    expect(() => images.add(noteOwner(note.id), [input(NOT_AN_IMAGE, 'fake.png')])).toThrow(
      '只支持',
    );
    expect(images.list(noteOwner(note.id)).images).toEqual([]);
    expect(imageFiles()).toEqual([]);
  });

  it('未保存的 note_id 无法写入图片，外键不会产生孤儿记录', () => {
    const { store, images } = open();
    const note = commit(store);
    expect(() => images.add(noteOwner(randomUUID()), [input(PNG_2X3)])).toThrow('手记不存在');
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
    expect(images.list(noteOwner(note.id)).images).toEqual([]);
  });

  it('命名只改显示名称，删除为软删除：文件保留但不再列出', () => {
    const { store, images } = open();
    const note = commit(store);
    const added = images.add(noteOwner(note.id), [input(PNG_2X3, 'original.png')]);
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
    const again = images.add(noteOwner(note.id), [input(JPEG_6X7)]);
    expect(again.images.map((item) => item.position)).toEqual([1]);
    expect(again.images.map((item) => item.mimeType)).toEqual(['image/jpeg']);
  });

  it('手记进入回收站后其图片不再可见也不可读取', () => {
    const { store, images } = open();
    const note = commit(store);
    const image = images.add(noteOwner(note.id), [input(PNG_2X3)]).images[0];
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
    expect(images.list(noteOwner(note.id))).toEqual({ images: [], totalBytes: 0 });
    expect(() => images.readBytes(image.id)).toThrow('回收站');
    // 文件仍然保留，软删除不丢内容。
    expect(imageFiles()).toHaveLength(1);
  });

  it('列表缩略图批量取摘要：只给可见图片，按加入顺序，空列表直接返回空结果', () => {
    const { store, images } = open();
    const first = commit(store);
    const second = commit(store);
    const third = commit(store);
    const added = images.add(noteOwner(first.id), [
      input(PNG_2X3, 'first.png'),
      input(JPEG_6X7, 'second.jpg'),
    ]);
    images.rename(added.images[1]?.id ?? '', '第二张');
    images.add(noteOwner(second.id), [input(GIF_4X2, 'anim.gif')]);

    const index = images.listSummaries([first.id, second.id, third.id]);
    // 没有附图的手记不出现在结果里，界面据此不渲染缩略图区。
    expect(Object.keys(index).sort()).toEqual([first.id, second.id].sort());
    expect(index[first.id]?.map((image) => image.displayName)).toEqual(['', '第二张']);
    expect(index[first.id]?.map((image) => image.originalName)).toEqual([
      'first.png',
      'second.jpg',
    ]);
    expect(index[first.id]?.map((image) => `${image.width}x${image.height}`)).toEqual([
      '2x3',
      '6x7',
    ]);
    // 摘要不带路径与字节，渲染端仍然拿不到文件位置。
    expect(Object.keys(index[first.id]?.[0] ?? {}).sort()).toEqual([
      'displayName',
      'height',
      'id',
      'originalName',
      'width',
    ]);
    expect(images.listSummaries([])).toEqual({});

    // 软删除的图片与进入回收站的手记都不再出现。
    images.remove(added.images[0]?.id ?? '');
    expect(images.listSummaries([first.id])[first.id]?.map((item) => item.originalName)).toEqual([
      'second.jpg',
    ]);
    store.remove(second.id);
    expect(images.listSummaries([second.id])).toEqual({});
  });

  it('草稿附图：先归属草稿，保存手记的同一事务里转成这条手记的图片', () => {
    const { store, images } = open();
    const pending = draft();
    store.saveDraft(pending);
    const added = images.add(draftOwner(pending.id), [
      input(PNG_2X3, '草稿图.png'),
      input(JPEG_6X7, '第二张.jpg'),
    ]);
    expect(added.images.map((image) => [image.noteId, image.draftId])).toEqual([
      [null, pending.id],
      [null, pending.id],
    ]);
    // 草稿附图不参与列表缩略图：它还没有对应的手记。
    expect(images.listSummaries([pending.id])).toEqual({});

    const note = store.commitDraft(pending, (noteId) =>
      images.claimDraftImages(pending.id, noteId),
    );
    // 稳定 ID 让草稿直接变成这条手记，图片同时换了归属。
    expect(note.id).toBe(pending.id);
    expect(images.list(noteOwner(note.id)).images.map((image) => image.originalName)).toEqual([
      '草稿图.png',
      '第二张.jpg',
    ]);
    expect(images.list(draftOwner(pending.id))).toEqual({ images: [], totalBytes: 0 });
    // 归属换过来之后，列表缩略图的摘要才看得到它。
    expect(images.listSummaries([note.id])[note.id]).toHaveLength(2);
    // 文件仍在附件目录里，只是换了归属记录。
    expect(imageFiles()).toHaveLength(2);
  });

  it('草稿尚未落盘时拒绝添加图片；草稿附图可改名与移出', () => {
    const { store, images } = open();
    const missing = draft();
    expect(() => images.add(draftOwner(missing.id), [input(PNG_2X3)])).toThrow('草稿还没有保存');

    store.saveDraft(missing);
    const image = images.add(draftOwner(missing.id), [input(PNG_2X3, '草稿.png')]).images[0];
    if (!image) throw new Error('测试前置数据缺失');
    expect(images.rename(image.id, '  起个名字  ').images[0]?.displayName).toBe('起个名字');
    // 改名与移出都返回草稿归属的图集，而不是手记的。
    expect(images.remove(image.id).images).toEqual([]);
    expect(() => images.readBytes(image.id)).toThrow('已删除');
    // 软删除的文件保留，草稿记录不再可读。
    expect(imageFiles()).toHaveLength(1);
  });

  it('旧库升级到 005：已有图片行原样保留，并补上可空的草稿归属', () => {
    // 先用只到 004 的迁移目录造一个旧库，并在里面写一张图片。
    const legacyMigrations = join(temporaryDirectory, 'migrations-004');
    mkdirSync(legacyMigrations);
    for (const name of [
      '001_notes.sql',
      '002_note_images.sql',
      '003_topics.sql',
      '004_threads.sql',
    ]) {
      writeFileSync(join(legacyMigrations, name), readFileSync(join(migrationsDirectory, name)));
    }
    const legacy = new NoteStore({
      dataDirectory,
      migrationsDirectory: legacyMigrations,
      expectedSchemaVersion: 4,
    });
    const note = legacy.commitDraft(draft());
    // 旧库还没有 draft_id 列：按旧结构直接写入，才代表真实的待升级数据。
    const legacyImageId = randomUUID();
    const legacyRelative = `attachments/${legacyImageId}.png`;
    mkdirSync(join(dataDirectory, 'attachments'), { recursive: true });
    writeFileSync(join(dataDirectory, legacyRelative), PNG_2X3);
    legacy
      .connection()
      .prepare(
        `INSERT INTO note_images
           (id, note_id, relative_path, mime_type, byte_size, width, height, display_name, original_name, position, created_at)
         VALUES (?, ?, ?, 'image/png', ?, 2, 3, '', '旧库图片.png', 0, ?)`,
      )
      .run(legacyImageId, note.id, legacyRelative, PNG_2X3.byteLength, new Date().toISOString());
    legacy.close();

    // 换回当前迁移目录打开：005 重建表，旧行必须完整保留。
    const { store, images } = open();
    const migrated = images.list(noteOwner(note.id)).images;
    expect(migrated.map((image) => image.originalName)).toEqual(['旧库图片.png']);
    expect(migrated[0]?.noteId).toBe(note.id);
    expect(migrated[0]?.draftId).toBeNull();
    // 升级后的库同时支持草稿归属。
    const pending = draft();
    store.saveDraft(pending);
    expect(images.add(draftOwner(pending.id), [input(GIF_4X2)]).images).toHaveLength(1);
    expect(imageFiles()).toHaveLength(2);
  });

  it('单条手记的图片数量上限在写入前生效', () => {
    const { store, images } = open();
    const note = commit(store);
    const batch = Array.from({ length: MAX_NOTE_IMAGE_COUNT }, () => input(PNG_2X3));
    expect(images.add(noteOwner(note.id), batch).images).toHaveLength(MAX_NOTE_IMAGE_COUNT);
    expect(() => images.add(noteOwner(note.id), [input(PNG_2X3)])).toThrow('最多保存');
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
    images.add(noteOwner(note.id), [input(PNG_2X3, '第一张.png'), input(JPEG_6X7, '第二张.jpg')]);
    const other = commit(store);
    images.add(noteOwner(other.id), [input(GIF_4X2)]);
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
      expect(restoredImages.list(noteOwner(note.id))).toEqual(images.list(noteOwner(note.id)));
      expect(restoredImages.list(noteOwner(other.id))).toEqual(images.list(noteOwner(other.id)));
      expect(imageFiles(destination)).toEqual(imageFiles());
    } finally {
      restoredStore.close();
    }
  });

  it('附件被改动或缺失时拒绝恢复，目标目录保持为空', async () => {
    const { store, images } = open();
    const note = commit(store);
    images.add(noteOwner(note.id), [input(PNG_2X3)]);
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
    images.add(noteOwner(note.id), [input(PNG_2X3)]);
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
    images.add(noteOwner(note.id), [input(PNG_2X3)]);
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
    const image = images.add(noteOwner(note.id), [input(PNG_2X3)]).images[0];
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
