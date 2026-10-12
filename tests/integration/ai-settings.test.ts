import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft } from '../../src/domain/note';
import { DEFAULT_AI_BASE_URL } from '../../src/shared/ai';
import { NoteStore } from '../../src/storage/note-store';
import { TopicStore } from '../../src/storage/topic-store';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { backupLibrary, restoreDatabaseBackup } from '../../src/storage/backup';
import { SCHEMA_VERSION } from '../../src/storage/schema';

let directory: string;
const stores: NoteStore[] = [];
const migrations = resolve('migrations');
function open(
  dataDirectory: string,
  migrationsDirectory = migrations,
  expectedSchemaVersion = SCHEMA_VERSION,
) {
  const store = new NoteStore({ dataDirectory, migrationsDirectory, expectedSchemaVersion });
  stores.push(store);
  return store;
}
function close(store: NoteStore) {
  store.close();
  stores.splice(stores.indexOf(store), 1);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-ai-settings-'));
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('AI 模型与接口地址 SQLite 配置', () => {
  it('从版本 5 升级保留手记和收录关系，并补默认 Flash', () => {
    const previousMigrations = join(directory, 'previous-migrations');
    mkdirSync(previousMigrations);
    for (const name of readdirSync(migrations).filter((item) => /^00[1-5]_/.test(item)))
      copyFileSync(join(migrations, name), join(previousMigrations, name));
    const data = join(directory, 'data');
    const previous = open(data, previousMigrations, 5);
    const note = previous.commitDraft({
      ...emptyDraft(randomUUID()),
      body: '升级前保留正文',
      revision: 1,
    });
    const topics = new TopicStore(previous.connection());
    const topic = topics.create({ title: '升级前归纳', description: '', confirmDuplicate: false });
    topics.addNotes(topic.id, [note.id]);
    close(previous);
    const current = open(data);
    expect(current.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(current.load().notes[0]?.body).toBe('升级前保留正文');
    expect(new TopicStore(current.connection()).list()[0]?.noteIds).toEqual([note.id]);
    expect(new AiSettingsStore(current.connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: DEFAULT_AI_BASE_URL,
    });
  });

  it('从版本 7 升级补官方地址，保留模型、手记、草稿、收录关系和周期缓存', () => {
    const previousMigrations = join(directory, 'version-7-migrations');
    mkdirSync(previousMigrations);
    for (const name of readdirSync(migrations).filter((item) => /^00[1-7]_/.test(item)))
      copyFileSync(join(migrations, name), join(previousMigrations, name));
    const data = join(directory, 'data');
    const previous = open(data, previousMigrations, 7);
    // 旧库没有 base_url，使用旧版 SQL 写入样例，避免新存储类依赖新列。
    previous.connection().prepare('UPDATE ai_settings SET model = ?').run('deepseek-v4-pro');
    const note = previous.commitDraft({
      ...emptyDraft(randomUUID()),
      body: '版本 7 的原始手记',
      revision: 1,
      tags: ['原有标签'],
    });
    previous.saveDraft({ ...emptyDraft(randomUUID()), body: '尚未提交的草稿', revision: 1 });
    const topics = new TopicStore(previous.connection());
    const topic = topics.create({ title: '旧版收录', description: '', confirmDuplicate: false });
    topics.addNotes(topic.id, [note.id]);
    const summary = {
      periodType: 'week' as const,
      startDate: '2026-10-05',
      endDate: '2026-10-11',
      summary: '已有周期总结',
      suggestions: ['继续整理记录'],
      noteCount: 1,
      generatedAt: '2026-10-11T04:00:00.000Z',
    };
    new PeriodSummaryStore(previous.connection()).savePeriodSummary(summary);
    const before = previous.load();
    close(previous);

    const current = open(data);
    expect(current.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(8);
    expect(current.load()).toEqual(before);
    expect(new TopicStore(current.connection()).list()[0]?.noteIds).toEqual([note.id]);
    expect(
      new PeriodSummaryStore(current.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(summary);
    expect(new AiSettingsStore(current.connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: DEFAULT_AI_BASE_URL,
    });
  });

  it('选择 Pro 后重开保持，并由 SQLite 拒绝未知模型与重复配置行', () => {
    const data = join(directory, 'data');
    const store = open(data);
    const settings = new AiSettingsStore(store.connection());
    expect(settings.saveModel('deepseek-v4-pro').model).toBe('deepseek-v4-pro');
    expect(() =>
      store.connection().prepare('UPDATE ai_settings SET model = ?').run('unknown'),
    ).toThrow();
    expect(() =>
      store
        .connection()
        .exec(
          "INSERT INTO ai_settings (id, provider, model) VALUES (2, 'deepseek', 'deepseek-flash')",
        ),
    ).toThrow();
    close(store);
    expect(new AiSettingsStore(open(data).connection()).load().model).toBe('deepseek-v4-pro');
  });

  it('自定义地址重开仍保留，模型与地址分别保存互不覆盖', () => {
    const data = join(directory, 'data');
    const store = open(data);
    const settings = new AiSettingsStore(store.connection());
    const baseUrl = 'https://gateway.example.test/compatibility/v1';
    expect(settings.saveBaseUrl(baseUrl)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl,
    });
    expect(settings.saveModel('deepseek-v4-pro')).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl,
    });
    const nextBaseUrl = 'http://127.0.0.1:8080/v1';
    expect(settings.saveBaseUrl(nextBaseUrl)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: nextBaseUrl,
    });
    close(store);
    expect(new AiSettingsStore(open(data).connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: nextBaseUrl,
    });
  });

  it('地址在写库前归一化，清空恢复官方且非法输入不改写已保存值', () => {
    const store = open(join(directory, 'data'));
    const settings = new AiSettingsStore(store.connection());
    expect(
      settings.saveBaseUrl(' https://gateway.example.test/compatibility/v1/chat/completions/ ')
        .baseUrl,
    ).toBe('https://gateway.example.test/compatibility/v1');
    const before = settings.load();
    const changes = store.connection().prepare('SELECT total_changes() AS count').get();
    for (const invalid of [
      'ftp://gateway.example.test/v1',
      'https://user:password@gateway.example.test/v1',
      'https://gateway.example.test/v1?api_key=secret',
      'https://gateway.example.test/v1#fragment',
      'https://gateway.example.test/v 1',
      `https://gateway.example.test/${'x'.repeat(2048)}`,
    ]) {
      expect(() => settings.saveBaseUrl(invalid)).toThrow();
      expect(settings.load()).toEqual(before);
    }
    expect(store.connection().prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    expect(settings.saveBaseUrl('').baseUrl).toBe(DEFAULT_AI_BASE_URL);
    expect(settings.load().baseUrl).toBe(DEFAULT_AI_BASE_URL);
  });

  it('SQLite 拒绝写入时，原有模型和接口地址保持不变', () => {
    const store = open(join(directory, 'data'));
    const settings = new AiSettingsStore(store.connection());
    settings.saveModel('deepseek-v4-pro');
    settings.saveBaseUrl('https://kept.example.test/v1');
    const before = settings.load();
    // 由真实 SQLite 禁止写入，验证失败不会被当成成功或替换已保存配置。
    store.connection().exec('PRAGMA query_only = ON');
    try {
      expect(() => settings.saveBaseUrl('https://new.example.test/v1')).toThrow();
      expect(settings.load()).toEqual(before);
      expect(() => settings.saveModel('deepseek-flash')).toThrow();
      expect(settings.load()).toEqual(before);
    } finally {
      store.connection().exec('PRAGMA query_only = OFF');
    }
  });

  it('库内非法地址明确报存储错误，不静默恢复官方或修改损坏值', () => {
    const store = open(join(directory, 'data'));
    const settings = new AiSettingsStore(store.connection());
    const damagedBaseUrl = 'ftp://damaged.example.test/v1';
    // 绕过业务入口模拟文件损坏；仍用 SQLite 写入和读出观察真实持久状态。
    store.connection().exec('PRAGMA ignore_check_constraints = ON');
    store.connection().prepare('UPDATE ai_settings SET base_url = ?').run(damagedBaseUrl);
    store.connection().exec('PRAGMA ignore_check_constraints = OFF');
    expect(() => settings.load()).toThrow(expect.objectContaining({ code: 'STORAGE' }));
    expect(
      store.connection().prepare('SELECT base_url FROM ai_settings WHERE id = 1').get()?.base_url,
    ).toBe(damagedBaseUrl);
  });

  it('完整备份与恢复携带模型及自定义地址，库内没有密钥列', async () => {
    const data = join(directory, 'data');
    const store = open(data);
    const settings = new AiSettingsStore(store.connection());
    settings.saveModel('deepseek-v4-pro');
    settings.saveBaseUrl('https://backup-gateway.example.test/v1');
    const pack = join(directory, 'backup');
    await backupLibrary(store, new NoteImageStore(store.connection(), data), pack);
    const restoredDirectory = join(directory, 'restored');
    await restoreDatabaseBackup(pack, restoredDirectory, migrations);
    const restored = open(restoredDirectory);
    expect(new AiSettingsStore(restored.connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://backup-gateway.example.test/v1',
    });
    expect(
      restored
        .connection()
        .prepare('PRAGMA table_info(ai_settings)')
        .all()
        .map((row) => row.name),
    ).toEqual(['id', 'provider', 'model', 'base_url']);
    expect(readFileSync(join(pack, 'backup.json'), 'utf8')).not.toContain('credentials');
  });

  it('版本 7 的备份在副本升级补官方地址，原备份与旧模型保持', async () => {
    const previousMigrations = join(directory, 'backup-version-7-migrations');
    mkdirSync(previousMigrations);
    for (const filename of readdirSync(migrations).filter((name) => /^00[1-7]_/.test(name)))
      copyFileSync(join(migrations, filename), join(previousMigrations, filename));
    const data = join(directory, 'old-backup-data');
    const old = open(data, previousMigrations, 7);
    old.connection().prepare('UPDATE ai_settings SET model = ?').run('deepseek-v4-pro');
    old.commitDraft({ ...emptyDraft(randomUUID()), body: '旧版备份中的手记', revision: 1 });
    const snapshot = old.load();
    const pack = join(directory, 'old-backup');
    await backupLibrary(old, new NoteImageStore(old.connection(), data, 7), pack);
    const backupBefore = readFileSync(join(pack, 'memocraft.sqlite'));
    const restoredDirectory = join(directory, 'old-restored');
    await restoreDatabaseBackup(pack, restoredDirectory, migrations);
    const restored = open(restoredDirectory);
    expect(restored.load()).toEqual(snapshot);
    expect(new AiSettingsStore(restored.connection()).load()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      baseUrl: DEFAULT_AI_BASE_URL,
    });
    expect(readFileSync(join(pack, 'memocraft.sqlite'))).toEqual(backupBefore);
  });
});
