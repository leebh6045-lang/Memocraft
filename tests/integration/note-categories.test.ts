import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { categoryLabel, emptyDraft, type NoteCategory } from '../../src/domain/note';
import { backupLibrary, restoreDatabaseBackup } from '../../src/storage/backup';
import { migrate } from '../../src/storage/database';
import { ExportStore } from '../../src/storage/export-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteSearchStore } from '../../src/storage/note-search-store';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { SearchStore } from '../../src/storage/search-store';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';
import { PNG_2X3 } from '../fixtures/images';

const migrationsDirectory = resolve('migrations');
let root: string;
const stores: NoteStore[] = [];

function open(directory: string, migrations = migrationsDirectory, version = SCHEMA_VERSION) {
  const store = new NoteStore({
    dataDirectory: directory,
    migrationsDirectory: migrations,
    expectedSchemaVersion: version,
  });
  stores.push(store);
  return store;
}
function close(store: NoteStore) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
function content(category: NoteCategory) {
  return { ...emptyDraft(randomUUID()), revision: 1, body: '某一刻的个人思考', category };
}

/** 模式 9 样例使用原始迁移，验证真实已发布约束的升级，不手工伪造版本号。 */
function legacyMigrations() {
  const directory = join(root, 'legacy-migrations');
  mkdirSync(directory);
  for (const name of readdirSync(migrationsDirectory).filter(
    (name) => Number(name.slice(0, 3)) <= 9,
  ))
    writeFileSync(join(directory, name), readFileSync(join(migrationsDirectory, name)));
  return directory;
}
function businessRows(database: DatabaseSync) {
  const tables = [
    'notes',
    'note_drafts',
    'tags',
    'note_tags',
    'note_images',
    'topics',
    'note_topics',
    'threads',
    'thread_entries',
    'entry_tags',
    'entry_notes',
    'thread_notes',
    'ai_settings',
    'ai_period_summaries',
  ];
  return Object.fromEntries(
    tables.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memocraft-categories-'));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('五分类存储与兼容', () => {
  it('思绪草稿重启恢复、提交与改选；搜索导出名称一致且备份恢复保留五类', async () => {
    const directory = join(root, 'data');
    let store = open(directory);
    const draft = content('thought');
    store.saveDraft(draft);
    close(store);
    store = open(directory);
    expect(store.load().draft).toEqual(draft);
    const thought = store.commitDraft(draft);
    expect(store.load().draft).toBeNull();
    expect(thought.category).toBe('thought');
    for (const category of ['insight', 'todo', 'done', 'misc'] as const)
      store.commitDraft(content(category));
    const search = new SearchStore(store.connection());
    expect(search.search('个人思考').hits.map((hit) => hit.context)).toEqual(
      expect.arrayContaining(['思绪', '其他', '收获', '待办', '完成']),
    );
    expect(new NoteSearchStore(store.connection()).retrieve(['个人思考']).hits).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: thought.id, category: 'thought' })]),
    );
    const exporter = new ExportStore(
      store.connection(),
      store,
      new TopicStore(store.connection()),
      new ThreadStore(store.connection()),
    );
    const destination = join(root, 'export');
    exporter.exportTo(destination);
    const texts = readdirSync(join(destination, '手记')).map((name) =>
      readFileSync(join(destination, '手记', name), 'utf8'),
    );
    expect(texts.some((text) => text.includes('分类: 思绪'))).toBe(true);
    expect(texts.some((text) => text.includes('分类: 其他'))).toBe(true);
    const snapshot = store.load();
    const backup = join(root, 'backup');
    await backupLibrary(store, new NoteImageStore(store.connection(), directory), backup);
    const restoredDirectory = join(root, 'restored');
    await restoreDatabaseBackup(backup, restoredDirectory, migrationsDirectory);
    expect(open(restoredDirectory).load()).toEqual(snapshot);
    const other = store.updateNote({
      ...thought,
      category: 'misc',
      expectedRevision: thought.revision,
    });
    expect(other).toMatchObject({
      body: thought.body,
      createdAt: thought.createdAt,
      category: 'misc',
    });
    expect(categoryLabel(other.category)).toBe('其他');
    expect(
      store.updateNote({ ...other, category: 'thought', expectedRevision: other.revision })
        .category,
    ).toBe('thought');
  });

  it('模式 9 升级保留全部记录、草稿、附图和关系；旧备份在副本升级', async () => {
    const directory = join(root, 'legacy-data');
    const legacy = open(directory, legacyMigrations(), 9);
    const kept = legacy.commitDraft({ ...content('misc'), tags: ['日常', '关系'] });
    for (const category of ['insight', 'todo', 'done'] as const)
      legacy.commitDraft(content(category));
    const removed = legacy.commitDraft(content('misc'));
    const topics = new TopicStore(legacy.connection());
    const topic = topics.create({
      title: '生活',
      description: '原始说明',
      confirmDuplicate: false,
    });
    topics.addNotes(topic.id, [kept.id, removed.id]);
    const threads = new ThreadStore(legacy.connection());
    const thread = threads.create({
      title: '生活事务',
      description: '',
      summary: '原始概况',
      confirmDuplicate: false,
    });
    threads.addNotes(thread.id, [kept.id]);
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-10-10T10:00:00.000Z',
      summary: '原始动态',
      body: '动态正文',
      tags: ['生活'],
      noteIds: [kept.id],
    });
    const images = new NoteImageStore(legacy.connection(), directory, 9);
    const attached = images.add({ kind: 'note', id: kept.id }, [
      { bytes: PNG_2X3, originalName: '生活.png' },
    ]).images[0];
    if (!attached) throw new Error('升级样例附图缺失');
    legacy.remove(removed.id);
    const draft = { ...content('misc'), tags: ['草稿标签'], extrasOpen: true };
    legacy.saveDraft(draft);
    images.add({ kind: 'draft', id: draft.id }, [{ bytes: PNG_2X3, originalName: '草稿.png' }]);
    const rows = businessRows(legacy.connection());
    const snapshot = legacy.load();
    const backup = join(root, 'legacy-backup');
    await backupLibrary(legacy, images, backup);
    close(legacy);

    const upgraded = open(directory);
    expect(upgraded.load()).toEqual(snapshot);
    expect(businessRows(upgraded.connection())).toEqual(rows);
    expect(upgraded.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(10);
    expect(upgraded.connection().prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(upgraded.connection().prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      upgraded
        .connection()
        .prepare("SELECT name FROM sqlite_master WHERE name = 'notes_created_at'")
        .get(),
    ).toBeDefined();
    expect(() =>
      upgraded
        .connection()
        .prepare('UPDATE notes SET category = ? WHERE id = ?')
        .run('invalid', kept.id),
    ).toThrow();
    // 新约束保持外键保护，普通业务不能写入悬空关系。
    expect(() =>
      upgraded.connection().prepare('INSERT INTO note_tags VALUES (?, ?, ?)').run('missing', 1, 0),
    ).toThrow();
    upgraded.updateNote({ ...kept, category: 'thought', expectedRevision: kept.revision });
    const restoredDirectory = join(root, 'legacy-restored');
    await restoreDatabaseBackup(backup, restoredDirectory, migrationsDirectory);
    const restored = open(restoredDirectory);
    expect(restored.load()).toEqual(snapshot);
    expect(businessRows(restored.connection())).toEqual(rows);
    const restoredImages = new NoteImageStore(restored.connection(), restoredDirectory);
    expect(new Uint8Array(restoredImages.readBytes(attached.id).bytes)).toEqual(PNG_2X3);
    const source = new DatabaseSync(join(backup, 'memocraft.sqlite'), { readOnly: true });
    try {
      expect(source.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    } finally {
      source.close();
    }
  });

  it('父表迁移造成悬空关系时整体回滚到模式 9，并恢复外键执行', () => {
    const oldMigrations = legacyMigrations();
    const directory = join(root, 'legacy-data');
    const legacy = open(directory, oldMigrations, 9);
    legacy.commitDraft({ ...content('misc'), tags: ['必须保留'] });
    const rows = businessRows(legacy.connection());
    for (const name of ['010_note_categories.sql'])
      writeFileSync(
        join(oldMigrations, name),
        readFileSync(join(migrationsDirectory, name), 'utf8') + '\nDELETE FROM notes;',
      );
    expect(() => migrate(legacy.connection(), oldMigrations)).toThrow('关系检查失败');
    expect(legacy.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(legacy.connection().prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(businessRows(legacy.connection())).toEqual(rows);
    expect(() =>
      legacy.connection().prepare('UPDATE notes SET category = ?').run('thought'),
    ).toThrow();
    close(legacy);
    expect(open(directory).load().notes[0]?.category).toBe('misc');
  });
});
