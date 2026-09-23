import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type NoteDraft } from '../../src/domain/note';
import { NoteStore } from '../../src/storage/note-store';
import { backupLibrary, restoreDatabaseBackup } from '../../src/storage/backup';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
const stores: NoteStore[] = [];
const imageStores: NoteImageStore[] = [];

/** 附图存储与手记共用同一条连接：备份必须同时覆盖数据库与附件目录。 */
function withImages(store: NoteStore): NoteImageStore {
  const images = new NoteImageStore(store.connection(), join(temporaryDirectory, 'data'));
  imageStores.push(images);
  return images;
}

function open(
  directory = join(temporaryDirectory, 'data'),
  migrations = migrationsDirectory,
  expectedSchemaVersion = SCHEMA_VERSION,
): NoteStore {
  const store = new NoteStore({
    dataDirectory: directory,
    migrationsDirectory: migrations,
    expectedSchemaVersion,
  });
  stores.push(store);
  return store;
}
function close(store: NoteStore): void {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return {
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '中文知识\n```ts\nconst value = "🙂";\n```\n',
    ...overrides,
  };
}
function mutateDatabase(operation: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(join(temporaryDirectory, 'data', 'memocraft.sqlite'));
  try {
    database.exec('PRAGMA foreign_keys = ON');
    operation(database);
  } finally {
    database.close();
  }
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-storage-'));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe('真实 SQLite 记录闭环', () => {
  it('重启恢复草稿全部字段，清空载荷后旧版本不会复活', () => {
    const first = open();
    const content = draft({
      title: '草稿标题',
      tags: ['SQLite'],
      category: 'todo',
      extrasOpen: true,
      revision: 4,
    });
    first.saveDraft(content);
    expect(first.load().notes).toEqual([]);
    close(first);
    const reopened = open();
    expect(reopened.load().draft).toEqual(content);
    const cleared = { ...content, body: '', title: '', tags: [], revision: 5 };
    reopened.saveDraft(cleared);
    expect(reopened.saveDraft(content)).toEqual(cleared);
    close(reopened);
    expect(open().load().draft).toEqual(cleared);
  });

  it('原子提交幂等，迟到草稿不能覆盖下一条草稿', () => {
    const store = open();
    const content = draft({ tags: ['知识', 'SQLite'] });
    store.saveDraft(content);
    const saved = store.commitDraft(content);
    expect(saved.body).toBe(content.body);
    expect(saved.tags).toEqual(content.tags);
    expect(store.load().draft).toBeNull();
    const next = draft({ body: '下一份内容' });
    store.saveDraft(next);
    expect(store.commitDraft(content)).toEqual(saved);
    expect(() => store.saveDraft({ ...content, revision: 9 })).toThrow('已经保存');
    expect(() => store.saveDraft(draft())).toThrow('另一份草稿');
    expect(store.load()).toEqual({ draft: next, notes: [saved] });
    expect(new Date(saved.createdAt).toISOString()).toBe(saved.createdAt);
  });

  it('拒绝相同版本不同载荷和使用过期内容提交', () => {
    const store = open();
    const content = draft({ revision: 3 });
    store.saveDraft(content);
    expect(() => store.saveDraft({ ...content, body: '冲突' })).toThrow('版本发生冲突');
    expect(() => store.commitDraft({ ...content, revision: 2 })).toThrow('更新的草稿');
    expect(store.load().draft).toEqual(content);
  });

  it('标签写入故障回滚手记和关联，保留草稿且可重试', () => {
    const store = open();
    const content = draft({ tags: ['事务回滚'] });
    store.saveDraft(content);
    mutateDatabase((database) =>
      database.exec(
        "CREATE TRIGGER reject_tag BEFORE INSERT ON note_tags BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
      ),
    );
    expect(() => store.commitDraft(content)).toThrow('simulated write failure');
    expect(store.load()).toEqual({ draft: content, notes: [] });
    mutateDatabase((database) => {
      expect(database.prepare('SELECT count(*) AS count FROM tags').get()?.count).toBe(0);
      database.exec('DROP TRIGGER reject_tag');
    });
    expect(store.commitDraft(content).tags).toEqual(['事务回滚']);
  });

  it('编辑原记录保留创建时间，支持幂等重试，拒绝冲突且不影响首页草稿', () => {
    const store = open();
    const saved = store.commitDraft(draft({ category: 'todo' }));
    const next = draft();
    store.saveDraft(next);
    const edit = {
      ...saved,
      expectedRevision: saved.revision,
      body: '更新后的正文',
      category: 'done' as const,
      tags: ['完成'],
    };
    const updated = store.updateNote(edit);
    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(updated.revision).toBe(2);
    expect(store.updateNote(edit)).toEqual(updated);
    expect(() => store.updateNote({ ...edit, body: '旧窗口内容' })).toThrow('已有更新');
    expect(store.load().draft).toEqual(next);
  });

  it('空白正文拒绝保存，数据库分类/关系约束实际生效', () => {
    const store = open();
    expect(() => store.commitDraft(draft({ body: '\t\n　 ' }))).toThrow('正文');
    const note = store.commitDraft(draft());
    expect(note.category).toBe('insight');
    mutateDatabase((database) => {
      expect(() =>
        database.prepare('UPDATE notes SET category = ? WHERE id = ?').run('invalid', note.id),
      ).toThrow();
      expect(() =>
        database.prepare('INSERT INTO note_tags VALUES (?, ?, ?)').run('missing', 999, 0),
      ).toThrow();
      // 已执行迁移数量与 schema 版本必须一致，避免迁移被静默跳过。
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(
        readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).length,
      );
    });
  });

  it('标签原文区分大小写，编辑重试不会被其他手记的标签拼写影响', () => {
    const store = open();
    store.commitDraft(draft({ tags: ['SQLite'] }));
    const note = store.commitDraft(draft({ tags: ['sqlite'] }));
    const edit = { ...note, expectedRevision: note.revision, body: '修改正文' };
    const updated = store.updateNote(edit);
    expect(updated.tags).toEqual(['sqlite']);
    expect(store.updateNote(edit)).toEqual(updated);
  });
});

describe('数据库迁移、备份和恢复保护', () => {
  it('WAL 数据库快照恢复到干净目录后手记、标签、草稿、软删除完全一致', async () => {
    const store = open();
    const deleted = store.commitDraft(draft({ body: '回收站内容', tags: ['关系仍保留'] }));
    mutateDatabase((database) =>
      database
        .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
        .run(new Date().toISOString(), deleted.id),
    );
    store.commitDraft(draft({ tags: ['SQLite', '知识'], category: 'misc' }));
    store.saveDraft(draft({ category: 'done', extrasOpen: true }));
    const backup = join(temporaryDirectory, 'snapshot-backup');
    await backupLibrary(store, withImages(store), backup);
    const destination = join(temporaryDirectory, 'restored');
    await restoreDatabaseBackup(backup, destination, migrationsDirectory);
    expect(open(destination).load()).toEqual(store.load());
    const restored = new DatabaseSync(join(destination, 'memocraft.sqlite'));
    try {
      expect(
        restored.prepare('SELECT deleted_at FROM notes WHERE id = ?').get(deleted.id)?.deleted_at,
      ).toBeTypeOf('string');
      expect(
        restored
          .prepare('SELECT count(*) AS count FROM note_tags WHERE note_id = ?')
          .get(deleted.id)?.count,
      ).toBe(1);
    } finally {
      restored.close();
    }
    const existing = readFileSync(join(backup, 'backup.json'));
    await expect(backupLibrary(store, withImages(store), backup)).rejects.toThrow('目标已存在');
    expect(readFileSync(join(backup, 'backup.json'))).toEqual(existing);
    await expect(restoreDatabaseBackup(backup, destination, migrationsDirectory)).rejects.toThrow(
      '目录必须为空',
    );
  });

  it('损坏和未来版本备份被拒绝，保留现有源文件且不会留下半恢复库', async () => {
    const broken = join(temporaryDirectory, 'broken-backup');
    mkdirSync(broken);
    writeFileSync(join(broken, 'memocraft.sqlite'), 'not sqlite');
    const brokenDestination = join(temporaryDirectory, 'broken-restore');
    await expect(
      restoreDatabaseBackup(broken, brokenDestination, migrationsDirectory),
    ).rejects.toThrow();
    expect(readFileSync(join(broken, 'memocraft.sqlite'), 'utf8')).toBe('not sqlite');
    expect(readdirSync(brokenDestination)).toEqual([]);
    const store = open();
    const future = join(temporaryDirectory, 'future-backup');
    await backupLibrary(store, withImages(store), future);
    const connection = new DatabaseSync(join(future, 'memocraft.sqlite'));
    connection.exec('PRAGMA user_version = 999');
    connection.close();
    const futureDestination = join(temporaryDirectory, 'future-restore');
    await expect(
      restoreDatabaseBackup(future, futureDestination, migrationsDirectory),
    ).rejects.toThrow('模式版本');
    expect(readdirSync(futureDestination)).toEqual([]);
  });

  it('迁移失败回滚全部本次 DDL 和版本，已有库不被重建', () => {
    // 先造出「只到 001」的旧库，再让 002 失败，验证升级失败不会留下半套结构。
    const only001 = join(temporaryDirectory, 'migrations-001');
    mkdirSync(only001);
    writeFileSync(
      join(only001, '001_notes.sql'),
      readFileSync(join(migrationsDirectory, '001_notes.sql')),
    );
    const store = open(join(temporaryDirectory, 'data'), only001, 1);
    const note = store.commitDraft(draft());
    close(store);
    const faulty = join(temporaryDirectory, 'migrations');
    mkdirSync(faulty);
    writeFileSync(
      join(faulty, '001_notes.sql'),
      readFileSync(join(migrationsDirectory, '001_notes.sql')),
    );
    writeFileSync(
      join(faulty, '002_fault.sql'),
      'CREATE TABLE partial_upgrade (id INTEGER); INSERT INTO nonexistent VALUES (1);',
    );
    writeFileSync(join(faulty, '003_missing.sql'), 'CREATE TABLE never_reached (id INTEGER);');
    expect(
      () =>
        new NoteStore({
          dataDirectory: join(temporaryDirectory, 'data'),
          migrationsDirectory: faulty,
          expectedSchemaVersion: 3,
        }),
    ).toThrow();
    mutateDatabase((database) => {
      expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'partial_upgrade'").get(),
      ).toBeUndefined();
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'never_reached'").get(),
      ).toBeUndefined();
    });
    // 失败的迁移不能破坏原库：用原迁移目录仍能正常打开并读到原记录。
    expect(open(join(temporaryDirectory, 'data')).load().notes).toEqual([note]);
  });

  it('备份在副本上升级受支持的旧版本，保留源备份版本和记录', async () => {
    // 造一份只到 002 的旧库：迁移目录只放 001 与 002，期望版本一起声明为 2。
    const legacyMigrations = join(temporaryDirectory, 'legacy-migrations');
    mkdirSync(legacyMigrations);
    for (const name of ['001_notes.sql', '002_note_images.sql']) {
      writeFileSync(join(legacyMigrations, name), readFileSync(join(migrationsDirectory, name)));
    }
    const legacyDirectory = join(temporaryDirectory, 'legacy-data');
    const legacy = open(legacyDirectory, legacyMigrations, 2);
    legacy.commitDraft(draft({ tags: ['升级样例'] }));
    const snapshot = legacy.load();
    const legacyImages = new NoteImageStore(legacy.connection(), legacyDirectory, 2);
    imageStores.push(legacyImages);
    const backup = join(temporaryDirectory, 'old-backup');
    await backupLibrary(legacy, legacyImages, backup);
    // 用应用自带的完整迁移目录恢复旧备份：副本应被升级到当前模式版本。
    const destination = join(temporaryDirectory, 'upgraded');
    await restoreDatabaseBackup(backup, destination, migrationsDirectory);
    expect(open(destination).load()).toEqual(snapshot);
    const source = new DatabaseSync(join(backup, 'memocraft.sqlite'), { readOnly: true });
    try {
      expect(source.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      // 恢复在副本上推进到当前迁移数，源备份保持原版本。
      const upgraded = new DatabaseSync(join(destination, 'memocraft.sqlite'), { readOnly: true });
      try {
        expect(upgraded.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
      } finally {
        upgraded.close();
      }
    } finally {
      source.close();
    }
  });

  it('已有零字节库不会被当成新库初始化', () => {
    const directory = join(temporaryDirectory, 'empty-damaged');
    mkdirSync(directory);
    const filename = join(directory, 'memocraft.sqlite');
    writeFileSync(filename, '');
    expect(() => open(directory)).toThrow('已有数据库文件为空');
    expect(readFileSync(filename)).toHaveLength(0);
  });

  it('损坏现有库启动失败后保留原始字节', () => {
    const directory = join(temporaryDirectory, 'damaged');
    mkdirSync(directory);
    const filename = join(directory, 'memocraft.sqlite');
    writeFileSync(filename, 'irreplaceable damaged data');
    expect(() => open(directory)).toThrow();
    expect(readFileSync(filename, 'utf8')).toBe('irreplaceable damaged data');
  });
});
