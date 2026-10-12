import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import type { AiPeriodSummary, PeriodNotesQuery } from '../../src/shared/ai';
import { AiSettingsStore } from '../../src/storage/ai-settings-store';
import { backupLibrary, restoreDatabaseBackup } from '../../src/storage/backup';
import { NoteImageStore } from '../../src/storage/note-image-store';
import { NoteStore } from '../../src/storage/note-store';
import { PeriodSummaryStore } from '../../src/storage/period-summary-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { ThreadStore } from '../../src/storage/thread-store';
import { TopicStore } from '../../src/storage/topic-store';

let directory: string;
const stores: NoteStore[] = [];
const migrationsDirectory = resolve('migrations');
const query: PeriodNotesQuery = {
  // UTC+8 的 10 月 5 日至 11 日；上界为 12 日本地零时，不含。
  startAt: '2026-10-04T16:00:00.000Z',
  endBefore: '2026-10-11T16:00:00.000Z',
  staleBefore: '2026-10-04T04:00:00.000Z',
};

function open(
  dataDirectory = join(directory, 'data'),
  migrationPath = migrationsDirectory,
  expectedSchemaVersion = SCHEMA_VERSION,
): NoteStore {
  const notes = new NoteStore({
    dataDirectory,
    migrationsDirectory: migrationPath,
    expectedSchemaVersion,
  });
  stores.push(notes);
  return notes;
}

function close(notes: NoteStore): void {
  notes.close();
  stores.splice(stores.indexOf(notes), 1);
}

function note(
  notes: NoteStore,
  createdAt = '2026-10-05T12:00:00.000Z',
  overrides: Partial<NoteDraft> = {},
): Note {
  const saved = notes.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '本期手记正文',
    ...overrides,
  });
  notes
    .connection()
    .prepare('UPDATE notes SET created_at = ? WHERE id = ?')
    .run(createdAt, saved.id);
  return saved;
}

function summary(overrides: Partial<AiPeriodSummary> = {}): AiPeriodSummary {
  return {
    periodType: 'week',
    startDate: '2026-10-05',
    endDate: '2026-10-11',
    summary: '本期学习了 SQLite 事务与索引。可以继续整理实践记录。',
    suggestions: ['将事务实践记录收录到 SQLite 归纳。'],
    noteCount: 3,
    generatedAt: '2026-10-11T04:00:00.000Z',
    ...overrides,
  };
}

/** 历史库样例只使用当时的列，避免新存储实现反向依赖尚未执行的迁移。 */
function insertLegacySummary(notes: NoteStore, value: AiPeriodSummary): void {
  notes
    .connection()
    .prepare(
      `INSERT INTO ai_period_summaries
        (period_type, start_date, summary, suggestions, note_count, generated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      value.periodType,
      value.startDate,
      value.summary,
      JSON.stringify(value.suggestions),
      value.noteCount,
      value.generatedAt,
    );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-period-summary-'));
});

afterEach(() => {
  for (const notes of stores.splice(0)) notes.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('周期手记与事实统计', () => {
  it('空库返回完整空结构，查询不产生写入', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    const changes = notes.connection().prepare('SELECT total_changes() AS total').get()?.total;
    expect(periods.fetchPeriodNotes(query)).toEqual({
      notes: [],
      total: 0,
      stats: { staleTodoCount: 0, activeTopics: [] },
    });
    expect(notes.connection().prepare('SELECT total_changes() AS total').get()?.total).toBe(
      changes,
    );
  });

  it('使用 UTC 半开边界，按创建时间及 ID 倒序，保留完整正文和全部手记', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    note(notes, '2026-10-04T15:59:59.999Z');
    const first = note(notes, query.startAt, { title: '起点', body: '全'.repeat(500) });
    const sameA = note(notes, '2026-10-05T12:00:00.000Z', {
      id: '00000000-0000-4000-8000-000000000001',
      category: 'todo',
    });
    const sameB = note(notes, '2026-10-05T12:00:00.000Z', {
      id: '00000000-0000-4000-8000-000000000002',
      category: 'done',
    });
    const last = note(notes, '2026-10-11T15:59:59.999Z');
    note(notes, query.endBefore);
    expect(periods.fetchPeriodNotes(query)).toMatchObject({
      total: 4,
      notes: [
        { id: last.id },
        { id: sameB.id, category: 'done' },
        { id: sameA.id, category: 'todo' },
        { id: first.id, title: '起点', body: '全'.repeat(500), createdAt: query.startAt },
      ],
    });
    for (let index = 0; index < 30; index += 1) note(notes);
    expect(periods.fetchPeriodNotes(query).notes).toHaveLength(34);
    expect(periods.fetchPeriodNotes(query).total).toBe(34);
  });

  it('只查询有效手记，草稿、回收站、归纳、事务和动态不进入结果', () => {
    const notes = open();
    const visible = note(notes);
    const deleted = note(notes);
    notes.remove(deleted.id);
    notes.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '未提交草稿' });
    new TopicStore(notes.connection()).create({
      title: '本期归纳',
      description: '不参与周期正文',
      confirmDuplicate: false,
    });
    const threads = new ThreadStore(notes.connection());
    const thread = threads.create({
      title: '本期事务',
      description: '',
      summary: '',
      confirmDuplicate: false,
    });
    threads.addEntry({
      threadId: thread.id,
      occurredAt: '2026-10-05T12:00:00.000Z',
      summary: '本期动态',
      body: '不参与周期正文',
      tags: [],
      noteIds: [],
    });
    const periods = new PeriodSummaryStore(notes.connection());
    expect(periods.fetchPeriodNotes(query).notes.map((item) => item.id)).toEqual([visible.id]);
    notes.connection().prepare('UPDATE notes SET deleted_at = NULL WHERE id = ?').run(deleted.id);
    expect(periods.fetchPeriodNotes(query).total).toBe(2);
  });

  it('每条手记只返回按位置排序的第一张有效图片，无图返回 null', () => {
    const notes = open();
    const illustrated = note(notes);
    const plain = note(notes);
    const insert = notes.connection().prepare(`
      INSERT INTO note_images
        (id, note_id, relative_path, mime_type, byte_size, width, height, position, created_at, deleted_at)
      VALUES (?, ?, ?, 'image/png', 10, 1, 1, ?, ?, ?)
    `);
    insert.run('image-a', illustrated.id, 'attachments/a.png', 2, query.startAt, null);
    insert.run('image-z', illustrated.id, 'attachments/z.png', 1, query.startAt, null);
    insert.run(
      'image-deleted',
      illustrated.id,
      'attachments/deleted.png',
      0,
      query.startAt,
      query.startAt,
    );
    const result = new PeriodSummaryStore(notes.connection()).fetchPeriodNotes(query);
    expect(result.notes.find((item) => item.id === illustrated.id)?.firstImageId).toBe('image-z');
    expect(result.notes.find((item) => item.id === plain.id)?.firstImageId).toBeNull();
    expect(result.total).toBe(2);
  });

  it('过期待办统计来自全库，严格超过 7 天且排除完成、杂项和已删除手记', () => {
    const notes = open();
    note(notes, '2026-09-01T00:00:00.000Z', { category: 'todo' });
    note(notes, '2026-10-04T03:59:59.999Z', { category: 'todo' });
    note(notes, query.staleBefore, { category: 'todo' });
    note(notes, query.startAt, { category: 'todo' });
    note(notes, '2026-09-01T00:00:00.000Z', { category: 'done' });
    note(notes, '2026-09-01T00:00:00.000Z', { category: 'misc' });
    const deleted = note(notes, '2026-09-01T00:00:00.000Z', { category: 'todo' });
    notes.remove(deleted.id);
    const periods = new PeriodSummaryStore(notes.connection());
    expect(periods.fetchPeriodNotes(query)).toMatchObject({
      total: 1,
      stats: { staleTodoCount: 2 },
    });
    expect(
      periods.fetchPeriodNotes({
        ...query,
        startAt: query.endBefore,
        endBefore: '2026-10-20T00:00:00.000Z',
      }),
    ).toMatchObject({ total: 0, stats: { staleTodoCount: 2 } });
  });

  it('活跃归纳仅计本期有效手记，排除删除归纳，至少 3 条并稳定返回最多 5 条', () => {
    const notes = open();
    const topics = new TopicStore(notes.connection());
    const current = Array.from({ length: 4 }, () => note(notes));
    const old = note(notes, '2026-09-01T00:00:00.000Z');
    const deleted = note(notes);
    const ids = current.map((item) => item.id);
    const top = topics.create({ title: '4 条归纳', description: '', confirmDuplicate: false });
    topics.addNotes(top.id, [...ids, old.id, deleted.id]);
    const ties = Array.from({ length: 5 }, (_, index) => {
      const topic = topics.create({
        title: `3 条归纳 ${index}`,
        description: '',
        confirmDuplicate: false,
      });
      topics.addNotes(topic.id, ids.slice(0, 3));
      return topic;
    });
    const below = topics.create({
      title: '有效条数不足',
      description: '',
      confirmDuplicate: false,
    });
    topics.addNotes(below.id, [...ids.slice(0, 2), old.id, deleted.id]);
    const removed = topics.create({
      title: '已删除归纳',
      description: '',
      confirmDuplicate: false,
    });
    topics.addNotes(removed.id, ids);
    topics.remove(removed.id);
    notes.remove(deleted.id);
    const result = new PeriodSummaryStore(notes.connection()).fetchPeriodNotes(query);
    const orderedTies = ties.sort((left, right) => (left.id < right.id ? 1 : -1)).slice(0, 4);
    expect(result.stats.activeTopics).toEqual([
      { id: top.id, title: top.title, noteCount: 4 },
      ...orderedTies.map((topic) => ({ id: topic.id, title: topic.title, noteCount: 3 })),
    ]);
  });
});

describe('周期总结 SQLite 缓存', () => {
  it('未缓存返回 null，保存后跨连接重开保留结果且不保存图片回执与结束日期', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toBeNull();
    periods.savePeriodSummary(summary({ usedImages: 2, skippedImages: 3, imagesSupported: true }));
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(summary());
    expect(
      notes
        .connection()
        .prepare('PRAGMA table_info(ai_period_summaries)')
        .all()
        .map((row) => row.name),
    ).toEqual([
      'period_type',
      'start_date',
      'summary',
      'suggestions',
      'note_count',
      'generated_at',
      'point_sources',
    ]);
    expect(
      notes.connection().prepare('SELECT point_sources FROM ai_period_summaries').get()
        ?.point_sources,
    ).toBeNull();
    close(notes);
    expect(
      new PeriodSummaryStore(open().connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(summary());
  });

  it('分点来源按组跨连接重开保留，并随完整备份恢复', async () => {
    const data = join(directory, 'sourced-data');
    const notes = open(data);
    const first = note(notes, query.startAt, { title: '事务实践' });
    const second = note(notes, query.startAt, { title: '索引实践' });
    const value = summary({
      summary: '- **事务**：保留提交与回滚的实践。\n- **索引**：积累查询性能的记录。',
      pointSources: [
        [{ index: 1, noteId: first.id, title: first.title }],
        [
          { index: 1, noteId: first.id, title: first.title },
          { index: 2, noteId: second.id, title: second.title },
        ],
      ],
      noteCount: 2,
    });
    new PeriodSummaryStore(notes.connection()).savePeriodSummary(value);
    close(notes);
    const reopened = open(data);
    expect(
      new PeriodSummaryStore(reopened.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(value);
    const pack = join(directory, 'sourced-backup');
    await backupLibrary(reopened, new NoteImageStore(reopened.connection(), data), pack);
    const target = join(directory, 'sourced-restored');
    await restoreDatabaseBackup(pack, target, migrationsDirectory);
    const restored = open(target);
    expect(
      new PeriodSummaryStore(restored.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(value);
    expect(restored.load()).toEqual(reopened.load());
  });

  it('来源手记软删除不改写已生成映射，重新生成旧格式时不会留下旧链接', () => {
    const notes = open();
    const saved = note(notes, query.startAt, { title: '事务记录' });
    const periods = new PeriodSummaryStore(notes.connection());
    const value = summary({
      summary: '- **事务**：记录了提交与回滚。',
      pointSources: [[{ index: 1, noteId: saved.id, title: saved.title }]],
    });
    periods.savePeriodSummary(value);
    notes.remove(saved.id);
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(value);
    // 旧缓存仍可写读；覆盖时必须同步清掉映射，不能把旧链接附在新正文后面。
    periods.savePeriodSummary(summary());
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(summary());
    expect(
      notes.connection().prepare('SELECT point_sources FROM ai_period_summaries').get()
        ?.point_sources,
    ).toBeNull();
  });

  it('缺少可展示链接的分点可保留空来源组，并支持六个不同分点', () => {
    const notes = open();
    const value = summary({
      summary: Array.from({ length: 6 }, (_, index) => `- **方向 ${index + 1}**：保留总结。`).join(
        '\n',
      ),
      pointSources: Array.from({ length: 6 }, () => []),
    });
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(value);
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(value);
  });

  it('来源与正文原位更新，SQLite 写入失败保留原有配对结果', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    const first = note(notes, query.startAt, { title: '第一条实践' });
    const second = note(notes, query.startAt, { title: '第二条实践' });
    const previous = summary({
      summary: '- **第一方向**：原有积累。',
      pointSources: [[{ index: 1, noteId: first.id, title: first.title }]],
    });
    const replacement = summary({
      summary: '- **第二方向**：更新后的积累。',
      pointSources: [[{ index: 2, noteId: second.id, title: second.title }]],
      generatedAt: '2026-10-11T05:00:00.000Z',
    });
    periods.savePeriodSummary(previous);
    notes.connection().exec('PRAGMA query_only = ON');
    try {
      expect(() => periods.savePeriodSummary(replacement)).toThrow();
      expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(previous);
    } finally {
      notes.connection().exec('PRAGMA query_only = OFF');
    }
    periods.savePeriodSummary(replacement);
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(replacement);
    expect(
      notes.connection().prepare('SELECT COUNT(*) AS total FROM ai_period_summaries').get()?.total,
    ).toBe(1);
  });

  it.each([
    ['来源 JSON 无法解析', 'not-json'],
    ['来源非数组', '{}'],
    ['来源组数与分点数不同', '[[],[]]'],
    ['来源组不是数组', '[{}]'],
    ['来源索引小于一', JSON.stringify([[{ index: 0, noteId: 'note-a', title: '原手记' }]])],
    ['来源索引超过采样上限', JSON.stringify([[{ index: 21, noteId: 'note-a', title: '原手记' }]])],
    ['来源索引不是整数', JSON.stringify([[{ index: 1.5, noteId: 'note-a', title: '原手记' }]])],
    ['来源手记 ID 为空', JSON.stringify([[{ index: 1, noteId: '  ', title: '原手记' }]])],
    [
      '来源手记 ID 超长',
      JSON.stringify([[{ index: 1, noteId: 'n'.repeat(129), title: '原手记' }]]),
    ],
    ['来源标题为空', JSON.stringify([[{ index: 1, noteId: 'note-a', title: '  ' }]])],
    ['来源标题超长', JSON.stringify([[{ index: 1, noteId: 'note-a', title: '字'.repeat(301) }]])],
    [
      '同一分点重复来源索引',
      JSON.stringify([
        [
          { index: 1, noteId: 'note-a', title: '原手记' },
          { index: 1, noteId: 'note-b', title: '另一手记' },
        ],
      ]),
    ],
    [
      '单组来源超过采样上限',
      JSON.stringify([
        Array.from({ length: 21 }, (_, index) => ({
          index: index + 1,
          noteId: `note-${index}`,
          title: '原手记',
        })),
      ]),
    ],
  ])('%s 时明确报 STORAGE，损坏映射和正文保持原样', (_label, damagedSources) => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary({ summary: '- **事务**：保留原始总结。' }));
    // 在隔离库模拟不受数据库 CHECK 保护的损坏文件，读取失败不能清理或覆盖原行。
    notes.connection().exec('PRAGMA ignore_check_constraints = ON');
    notes
      .connection()
      .prepare('UPDATE ai_period_summaries SET point_sources = ?')
      .run(damagedSources);
    notes.connection().exec('PRAGMA ignore_check_constraints = OFF');
    const before = notes.connection().prepare('SELECT * FROM ai_period_summaries').all();
    const changes = notes.connection().prepare('SELECT total_changes() AS total').get();
    expect(() => periods.loadPeriodSummary('week', '2026-10-05')).toThrowError(
      expect.objectContaining({ code: 'STORAGE' }),
    );
    expect(notes.connection().prepare('SELECT * FROM ai_period_summaries').all()).toEqual(before);
    expect(notes.connection().prepare('SELECT total_changes() AS total').get()).toEqual(changes);
  });

  it.each([
    [
      '相同编号跨分点映射到不同手记',
      [
        [{ index: 1, noteId: 'note-a', title: '第一条手记' }],
        [{ index: 1, noteId: 'note-b', title: '第二条手记' }],
      ],
    ],
    [
      '相同手记跨分点使用不同编号',
      [
        [{ index: 1, noteId: 'note-a', title: '原手记' }],
        [{ index: 2, noteId: 'note-a', title: '原手记' }],
      ],
    ],
  ])('%s 时保留损坏缓存并报 STORAGE', (_label, damagedSources) => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary({ summary: '- 第一项总结。\n- 第二项总结。' }));
    notes
      .connection()
      .prepare('UPDATE ai_period_summaries SET point_sources = ?')
      .run(JSON.stringify(damagedSources));
    const before = notes.connection().prepare('SELECT * FROM ai_period_summaries').all();
    expect(() => periods.loadPeriodSummary('week', '2026-10-05')).toThrowError(
      expect.objectContaining({ code: 'STORAGE' }),
    );
    expect(notes.connection().prepare('SELECT * FROM ai_period_summaries').all()).toEqual(before);
  });

  it('七个分点及来源组的损坏缓存保留原文并报 STORAGE', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary());
    const damagedSummary = Array.from({ length: 7 }, (_, index) => `- 分点 ${index + 1}`).join(
      '\n',
    );
    const damagedSources = JSON.stringify(Array.from({ length: 7 }, () => []));
    notes
      .connection()
      .prepare('UPDATE ai_period_summaries SET summary = ?, point_sources = ?')
      .run(damagedSummary, damagedSources);
    const before = notes.connection().prepare('SELECT * FROM ai_period_summaries').all();
    expect(() => periods.loadPeriodSummary('week', '2026-10-05')).toThrowError(
      expect.objectContaining({ code: 'STORAGE' }),
    );
    expect(notes.connection().prepare('SELECT * FROM ai_period_summaries').all()).toEqual(before);
  });

  it('重新生成原位更新同一周期，自然月和自然周即使起点相同也分别缓存', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary({ startDate: '2026-06-01', endDate: '2026-06-07' }));
    const replacement = summary({
      startDate: '2026-06-01',
      endDate: '2026-06-07',
      summary: '重新生成的摘要。',
      suggestions: [],
      generatedAt: '2026-10-11T05:00:00+08:00',
      noteCount: 4,
    });
    periods.savePeriodSummary(replacement);
    periods.savePeriodSummary(
      summary({ periodType: 'month', startDate: '2026-06-01', endDate: '2026-06-30' }),
    );
    expect(periods.loadPeriodSummary('week', '2026-06-01')).toEqual(replacement);
    expect(periods.loadPeriodSummary('month', '2026-06-01')?.endDate).toBe('2026-06-30');
    expect(
      notes.connection().prepare('SELECT COUNT(*) AS total FROM ai_period_summaries').get()?.total,
    ).toBe(2);
  });

  it('普通手记新增、编辑和软删除均不自动使缓存失效', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    const saved = note(notes);
    periods.savePeriodSummary(summary());
    notes.updateNote({ ...saved, expectedRevision: saved.revision, body: '编辑后的内容' });
    notes.remove(saved.id);
    note(notes);
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(summary());
  });

  it.each([
    ['建议 JSON 无法解析', "suggestions = 'not-json'"],
    ['建议非数组', "suggestions = '{}'"],
    ['建议含非字符串', "suggestions = '[123]'"],
    ['建议为空白', `suggestions = '["  "]'`],
    ['建议超过 5 条', `suggestions = '${JSON.stringify(Array.from({ length: 6 }, () => '建议'))}'`],
    ['单条建议超过 200 字', `suggestions = '${JSON.stringify(['字'.repeat(201)])}'`],
    ['摘要为空白', "summary = '  '"],
    ['摘要超过上限', `summary = '${'字'.repeat(602)}'`],
    ['生成时间无时区', "generated_at = '2026-10-11T04:00:00'"],
    ['生成时间日期无效', "generated_at = '2026-02-30T04:00:00.000Z'"],
    ['生成时间日期非法补齐', "generated_at = '2026-10-11T24:00:00.000Z'"],
    ['手记数量为负', 'note_count = -1'],
    ['空期被误缓存', 'note_count = 0'],
    ['手记数量超出安全整数', 'note_count = 9007199254740992'],
  ])('%s 时抛出 STORAGE，原行不被清理或替换', (_label, assignment) => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary());
    // 仅在隔离库模拟损坏缓存；实际迁移约束会阻止坏 JSON 与负数写入。
    notes.connection().exec('PRAGMA ignore_check_constraints = ON');
    notes.connection().exec(`UPDATE ai_period_summaries SET ${assignment}`);
    notes.connection().exec('PRAGMA ignore_check_constraints = OFF');
    expect(() => periods.loadPeriodSummary('week', '2026-10-05')).toThrowError(
      expect.objectContaining({ code: 'STORAGE' }),
    );
    expect(
      notes.connection().prepare('SELECT COUNT(*) AS total FROM ai_period_summaries').get()?.total,
    ).toBe(1);
  });

  it.each(['2026-10-06', '2026-02-30', '9999-12-27'])(
    '无效自然周期起点 %s 保留原数据并报 STORAGE',
    (startDate) => {
      const notes = open();
      const periods = new PeriodSummaryStore(notes.connection());
      periods.savePeriodSummary(summary());
      notes.connection().prepare('UPDATE ai_period_summaries SET start_date = ?').run(startDate);
      expect(() => periods.loadPeriodSummary('week', startDate)).toThrowError(
        expect.objectContaining({ code: 'STORAGE' }),
      );
      expect(
        notes.connection().prepare('SELECT start_date FROM ai_period_summaries').get()?.start_date,
      ).toBe(startDate);
    },
  );

  it('新增严格表通过约束拒绝未知周期、坏 JSON、负数与非整数计数', () => {
    const notes = open();
    const periods = new PeriodSummaryStore(notes.connection());
    periods.savePeriodSummary(summary());
    for (const assignment of [
      "period_type = 'year'",
      "suggestions = 'not-json'",
      "point_sources = 'not-json'",
      'note_count = -1',
      'note_count = 1.5',
    ]) {
      expect(() =>
        notes.connection().exec(`UPDATE ai_period_summaries SET ${assignment}`),
      ).toThrow();
    }
    expect(periods.loadPeriodSummary('week', '2026-10-05')).toEqual(summary());
  });

  it('从版本 6 升级只新增缓存表，原有手记、草稿、关系与 AI 配置保持', () => {
    const previousMigrations = join(directory, 'previous-migrations');
    mkdirSync(previousMigrations);
    for (const filename of readdirSync(migrationsDirectory).filter((name) =>
      /^00[1-6]_/.test(name),
    ))
      copyFileSync(join(migrationsDirectory, filename), join(previousMigrations, filename));
    // 固定验证第 7 版迁移，避免后续 AI 设置新增列改变本用例的模式比较范围。
    const periodMigrations = join(directory, 'version-7-migrations');
    mkdirSync(periodMigrations);
    for (const filename of readdirSync(migrationsDirectory).filter((name) =>
      /^00[1-7]_/.test(name),
    ))
      copyFileSync(join(migrationsDirectory, filename), join(periodMigrations, filename));
    const data = join(directory, 'upgrade-data');
    const previous = open(data, previousMigrations, 6);
    const kept = note(previous, query.startAt, { body: '升级前内容', tags: ['SQLite'] });
    previous.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '升级前草稿' });
    const topics = new TopicStore(previous.connection());
    const topic = topics.create({ title: '升级前归纳', description: '', confirmDuplicate: false });
    topics.addNotes(topic.id, [kept.id]);
    previous.connection().prepare('UPDATE ai_settings SET model = ?').run('deepseek-v4-pro');
    const before = previous.load();
    const originalSchema = previous
      .connection()
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    close(previous);
    const current = open(data, periodMigrations, 7);
    expect(current.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(7);
    expect(current.load()).toEqual(before);
    expect(new TopicStore(current.connection()).list()[0]?.noteIds).toEqual([kept.id]);
    expect(
      current.connection().prepare('SELECT model FROM ai_settings WHERE id = 1').get()?.model,
    ).toBe('deepseek-v4-pro');
    expect(
      current
        .connection()
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'ai_period_summaries' ORDER BY name",
        )
        .all(),
    ).toEqual(originalSchema);
    const value = summary();
    insertLegacySummary(current, value);
    expect(current.connection().prepare('SELECT * FROM ai_period_summaries').get()).toEqual({
      period_type: value.periodType,
      start_date: value.startDate,
      summary: value.summary,
      suggestions: JSON.stringify(value.suggestions),
      note_count: value.noteCount,
      generated_at: value.generatedAt,
    });
  });

  it('版本 8 升级保留原文缓存、手记、草稿、关系与自定义地址，不伪造来源', () => {
    const previousMigrations = join(directory, 'version-8-migrations');
    mkdirSync(previousMigrations);
    for (const filename of readdirSync(migrationsDirectory).filter((name) =>
      /^00[1-8]_/.test(name),
    ))
      copyFileSync(join(migrationsDirectory, filename), join(previousMigrations, filename));
    const data = join(directory, 'version-8-data');
    const previous = open(data, previousMigrations, 8);
    const saved = note(previous, query.startAt, { body: '旧库的原始正文', tags: ['保留'] });
    previous.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '旧库的未提交草稿' });
    const topics = new TopicStore(previous.connection());
    const topic = topics.create({ title: '旧版收录', description: '', confirmDuplicate: false });
    topics.addNotes(topic.id, [saved.id]);
    const settings = new AiSettingsStore(previous.connection());
    settings.saveModel('deepseek-v4-pro');
    settings.saveBaseUrl('https://existing-gateway.example.test/v1');
    const value = summary();
    insertLegacySummary(previous, value);
    const originalCache = previous.connection().prepare('SELECT * FROM ai_period_summaries').get();
    const snapshot = previous.load();
    const configuration = settings.load();
    close(previous);
    const current = open(data);
    expect(current.connection().prepare('PRAGMA user_version').get()?.user_version).toBe(
      SCHEMA_VERSION,
    );
    expect(current.load()).toEqual(snapshot);
    expect(new TopicStore(current.connection()).list()[0]?.noteIds).toEqual([saved.id]);
    expect(new AiSettingsStore(current.connection()).load()).toEqual(configuration);
    expect(current.connection().prepare('SELECT * FROM ai_period_summaries').get()).toEqual({
      ...originalCache,
      point_sources: null,
    });
    expect(
      new PeriodSummaryStore(current.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(value);
  });

  it('版本 8 备份在副本升级保留旧总结，原备份文件不被改写', async () => {
    const previousMigrations = join(directory, 'backup-version-8-migrations');
    mkdirSync(previousMigrations);
    for (const filename of readdirSync(migrationsDirectory).filter((name) =>
      /^00[1-8]_/.test(name),
    ))
      copyFileSync(join(migrationsDirectory, filename), join(previousMigrations, filename));
    const data = join(directory, 'backup-version-8-data');
    const previous = open(data, previousMigrations, 8);
    note(previous, query.startAt, { body: '备份内的旧手记' });
    insertLegacySummary(previous, summary());
    const snapshot = previous.load();
    const pack = join(directory, 'version-8-backup');
    await backupLibrary(previous, new NoteImageStore(previous.connection(), data, 8), pack);
    const before = readFileSync(join(pack, 'memocraft.sqlite'));
    const target = join(directory, 'version-8-restored');
    await restoreDatabaseBackup(pack, target, migrationsDirectory);
    const restored = open(target);
    expect(restored.load()).toEqual(snapshot);
    expect(
      new PeriodSummaryStore(restored.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(summary());
    expect(readFileSync(join(pack, 'memocraft.sqlite'))).toEqual(before);
  });

  it('整库备份与恢复包含周期缓存、原有内容和 AI 模型配置', async () => {
    const data = join(directory, 'backup-data');
    const notes = open(data);
    const kept = note(notes, query.startAt, { body: '完整备份中的手记' });
    new AiSettingsStore(notes.connection()).saveModel('deepseek-v4-pro');
    new PeriodSummaryStore(notes.connection()).savePeriodSummary(summary());
    const pack = join(directory, 'backup-pack');
    await backupLibrary(notes, new NoteImageStore(notes.connection(), data), pack);
    const target = join(directory, 'restored');
    await restoreDatabaseBackup(pack, target, migrationsDirectory);
    const restored = open(target);
    expect(
      new PeriodSummaryStore(restored.connection()).loadPeriodSummary('week', '2026-10-05'),
    ).toEqual(summary());
    expect(restored.load().notes.map((item) => item.id)).toEqual([kept.id]);
    expect(new AiSettingsStore(restored.connection()).load().model).toBe('deepseek-v4-pro');
  });
});
