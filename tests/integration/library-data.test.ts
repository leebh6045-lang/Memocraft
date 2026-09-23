import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import { backupLibrary, stageRestoreInto } from '../../src/storage/backup';
import { DATABASE_FILENAME } from '../../src/storage/database';
import { ExportStore } from '../../src/storage/export-store';
import { NoteStore } from '../../src/storage/note-store';
import {
  PRE_RESTORE_DIRECTORY,
  RESTORE_MARKER,
  applyStagedRestore,
  beginRestore,
  commitRestore,
  recoverInterruptedRestore,
  rollbackRestore,
} from '../../src/storage/recovery';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';

const migrationsDirectory = resolve('migrations');
let root: string;
let dataDirectory: string;
let store: NoteStore;
let topics: TopicStore;
let threads: ThreadStore;
let exporter: ExportStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memocraft-data-'));
  dataDirectory = join(root, 'data');
  store = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  const connection = store.connection();
  topics = new TopicStore(connection);
  threads = new ThreadStore(connection);
  exporter = new ExportStore(connection, store, topics, threads);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // 已关闭的连接再次关闭不影响用例结论。
  }
  rmSync(root, { recursive: true, force: true });
});

function note(overrides: Partial<NoteDraft> = {}): Note {
  return store.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '导出样例正文',
    ...overrides,
  });
}

describe('恢复保护与中断检测', () => {
  it('回滚把恢复前的数据放回原位，并清掉标记与备份', () => {
    const kept = note({ body: '恢复前的数据' });
    beginRestore(dataDirectory, 'test-source');
    expect(existsSync(join(dataDirectory, RESTORE_MARKER))).toBe(true);
    expect(existsSync(join(dataDirectory, PRE_RESTORE_DIRECTORY))).toBe(true);

    // 模拟替换到一半：活动库被清空，随后进程中断。
    store.close();
    rmSync(join(dataDirectory, DATABASE_FILENAME), { force: true });
    rollbackRestore(dataDirectory);

    expect(existsSync(join(dataDirectory, RESTORE_MARKER))).toBe(false);
    expect(existsSync(join(dataDirectory, PRE_RESTORE_DIRECTORY))).toBe(false);
    const reopened = new NoteStore({
      dataDirectory,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      expect(reopened.load().notes.map((item) => item.id)).toEqual([kept.id]);
    } finally {
      reopened.close();
    }
  });

  it('启动检测发现未完成的恢复时自动回滚；没有标记时不做任何事', () => {
    note({ body: '启动检测' });
    expect(recoverInterruptedRestore(dataDirectory)).toBe('none');

    beginRestore(dataDirectory, 'test-source');
    store.close();
    rmSync(join(dataDirectory, DATABASE_FILENAME), { force: true });
    expect(recoverInterruptedRestore(dataDirectory)).toBe('rolled-back');
    expect(recoverInterruptedRestore(dataDirectory)).toBe('none');

    const reopened = new NoteStore({
      dataDirectory,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      expect(reopened.load().notes).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('标记存在但恢复前备份缺失时拒绝打开，不静默丢掉数据', () => {
    writeFileSync(join(dataDirectory, RESTORE_MARKER), '{}', 'utf8');
    expect(() => recoverInterruptedRestore(dataDirectory)).toThrow('恢复前备份已不存在');
  });

  it('提交后标记与恢复前备份都被清理', () => {
    note();
    beginRestore(dataDirectory, 'test-source');
    commitRestore(dataDirectory);
    expect(existsSync(join(dataDirectory, RESTORE_MARKER))).toBe(false);
    expect(existsSync(join(dataDirectory, PRE_RESTORE_DIRECTORY))).toBe(false);
  });
});

describe('备份与暂存恢复', () => {
  it('备份返回真实摘要，暂存恢复会统计内容数量且不改动活动库', async () => {
    const kept = note({ body: '会被备份的手记' });
    const topic = topics.create({
      title: '备份样例归纳',
      description: '',
      confirmDuplicate: false,
    });
    topics.addNotes(topic.id, [kept.id]);
    const thread = threads.create({
      title: '备份样例事务',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '备份样例动态',
      body: '',
      tags: [],
      noteIds: [kept.id],
    });

    const backupPath = join(root, 'backup-pack');
    const summary = await backupLibrary(
      store,
      new (await import('../../src/storage/note-image-store')).NoteImageStore(
        store.connection(),
        dataDirectory,
      ),
      backupPath,
    );
    expect(summary.attachments).toBe(0);
    expect(summary.bytes).toBeGreaterThan(0);
    expect(existsSync(join(backupPath, 'backup.json'))).toBe(true);

    store.close();
    const staged = await stageRestoreInto(
      backupPath,
      join(dataDirectory, '.restore-staging'),
      migrationsDirectory,
    );
    expect(staged.counts).toEqual({ notes: 1, topics: 1, threads: 1, entries: 1 });
    expect(existsSync(join(dataDirectory, DATABASE_FILENAME))).toBe(true);

    applyStagedRestore(dataDirectory, DATABASE_FILENAME);
    const reopened = new NoteStore({
      dataDirectory,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      expect(reopened.load().notes.map((item) => item.id)).toEqual([kept.id]);
    } finally {
      reopened.close();
    }
  });

  it('损坏的备份被拒绝，暂存目录不残留', async () => {
    const backupPath = join(root, 'broken-pack');
    mkdirSync(backupPath, { recursive: true });
    writeFileSync(join(backupPath, 'not-a-database.sqlite'), 'not sqlite', 'utf8');
    const staging = join(dataDirectory, '.restore-staging');
    await expect(stageRestoreInto(backupPath, staging, migrationsDirectory)).rejects.toThrow();
    expect(existsSync(staging)).toBe(false);
  });
});

describe('可读导出', () => {
  it('导出正文与关系元数据，文件名带稳定 ID', () => {
    const kept = note({ body: '正文里有关键结论', tags: ['运维'] });
    const topic = topics.create({
      title: '导出归纳：a/b?c',
      description: '说明文字',
      confirmDuplicate: false,
    });
    topics.addNotes(topic.id, [kept.id]);
    const thread = threads.create({
      title: '导出事务',
      description: '事务说明',
      summary: '当前概况',
      confirmDuplicate: false,
    });
    threads.addNotes(thread.id, [kept.id]);
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-09-10T10:00:00.000Z',
      summary: '导出动态',
      body: '动态正文',
      tags: ['证书'],
      noteIds: [kept.id],
    });

    const destination = join(root, 'export');
    const summary = exporter.exportTo(destination);
    expect(summary).toMatchObject({ notes: 1, topics: 1, threads: 1, entries: 1 });

    const noteFile = readdirSync(join(destination, '手记'))[0] ?? '';
    expect(noteFile.startsWith(kept.id)).toBe(true);
    expect(noteFile.endsWith('.md')).toBe(true);
    const noteText = readFileSync(join(destination, '手记', noteFile), 'utf8');
    expect(noteText).toContain('类型: 手记');
    expect(noteText).toContain('标识: ' + kept.id);
    expect(noteText).toContain('分类: 收获');
    expect(noteText).toContain('- 运维');
    // 元数据保留原始标题，只有文件名做平台清理。
    expect(noteText).toContain(`导出归纳：a/b?c（${topic.id}）`);
    expect(noteText).toContain(`导出事务（事务资料，${thread.id}）`);
    expect(noteText).toContain('导出事务 · 导出动态');
    expect(noteText).toContain('正文里有关键结论');

    const topicFile = readdirSync(join(destination, '归纳'))[0] ?? '';
    expect(topicFile).not.toContain('/');
    expect(topicFile).not.toContain('?');
    const threadText = readFileSync(
      join(destination, '事务', readdirSync(join(destination, '事务'))[0] ?? ''),
      'utf8',
    );
    expect(threadText).toContain('状态: 进行中');
    expect(threadText).toContain('### 导出动态');
    expect(threadText).toContain('动态正文');

    const index = readFileSync(join(destination, 'index.md'), 'utf8');
    expect(index).toContain('不是完整备份');
    expect(index).toContain('手记：1 条');
  });

  it('软删除的内容不导出，导出位置非空时拒绝', () => {
    const removed = note({ body: '会被删除' });
    store.remove(removed.id);
    const destination = join(root, 'export-2');
    expect(exporter.exportTo(destination).notes).toBe(0);

    // 目标非空时拒绝，避免覆盖用户已有文件。
    writeFileSync(join(destination, 'keep.txt'), 'user file', 'utf8');
    expect(() => exporter.exportTo(destination)).toThrow('已存在且不为空');
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('user file');
  });
});
