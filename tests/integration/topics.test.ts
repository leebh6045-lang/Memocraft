import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft, type Note, type NoteDraft } from '../../src/domain/note';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { TopicStore } from '../../src/storage/topic-store';

const migrationsDirectory = resolve('migrations');
let temporaryDirectory: string;
let store: NoteStore;
let topics: TopicStore;

/** 真实临时 SQLite：收录关系、幂等与软删除可见性都按数据库实际行为验证。 */
beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'memocraft-topics-'));
  store = new NoteStore({
    dataDirectory: join(temporaryDirectory, 'data'),
    migrationsDirectory,
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  topics = new TopicStore(store.connection());
});

afterEach(() => {
  store.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function draft(overrides: Partial<NoteDraft> = {}): NoteDraft {
  return { ...emptyDraft(randomUUID()), revision: 1, body: '归纳样例正文', ...overrides };
}

function note(overrides: Partial<NoteDraft> = {}): Note {
  return store.commitDraft(draft(overrides));
}

function topic(title: string, confirmDuplicate = false): string {
  return topics.create({ title, description: `${title} 的说明`, confirmDuplicate }).id;
}

/** 直接改创建时间：同一毫秒内连续提交的两条手记无法靠 API 排出稳定先后。 */
function setNoteCreatedAt(noteId: string, iso: string): void {
  store.connection().prepare('UPDATE notes SET created_at = ? WHERE id = ?').run(iso, noteId);
}

function softDeleteNote(noteId: string): void {
  store
    .connection()
    .prepare('UPDATE notes SET deleted_at = ? WHERE id = ?')
    .run(new Date().toISOString(), noteId);
}

describe('主题归纳与多重收录', () => {
  it('新建归纳后可列出，初始没有收录手记', () => {
    const id = topic('前端开发');
    const list = topics.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      title: '前端开发',
      description: '前端开发 的说明',
      revision: 1,
    });
    expect(list[0]?.noteIds).toEqual([]);
  });

  it('同名标题需要用户确认，确认后允许并存', () => {
    topic('本地数据库');
    expect(() => topic('本地数据库')).toThrow('已经有名为「本地数据库」的归纳');
    // 大小写与空白差异视为同名，避免出现只有空格不同的重复项。
    expect(() => topic('  本地数据库  ')).toThrow('已经有名为');
    expect(topic('本地数据库', true)).toBeTruthy();
    expect(topics.list()).toHaveLength(2);
  });

  it('一条手记可被两个归纳收录，两处都能反查到它', () => {
    const first = topic('前端开发');
    const second = topic('工具链');
    const noteId = note().id;
    topics.addNotes(first, [noteId]);
    topics.addNotes(second, [noteId]);

    const list = topics.list();
    expect(list.find((item) => item.id === first)?.noteIds).toEqual([noteId]);
    expect(list.find((item) => item.id === second)?.noteIds).toEqual([noteId]);
  });

  it('重复收录幂等：不产生第二行，也不改动首次收录时间', () => {
    const id = topic('本地数据库');
    const noteId = note().id;
    topics.addNotes(id, [noteId]);
    const collectedAt = store
      .connection()
      .prepare('SELECT created_at FROM note_topics WHERE topic_id = ? AND note_id = ?')
      .get(id, noteId)?.created_at;

    topics.addNotes(id, [noteId, noteId]);
    const rows = store
      .connection()
      .prepare('SELECT created_at FROM note_topics WHERE topic_id = ? AND note_id = ?')
      .all(id, noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(collectedAt);
    expect(topics.list()[0]?.noteIds).toEqual([noteId]);
  });

  it('收录不推进归纳版本，避免与标题编辑互相误判冲突', () => {
    const id = topic('服务器运维');
    const before = topics.list()[0]?.revision;
    topics.addNotes(id, [note().id]);
    expect(topics.list()[0]?.revision).toBe(before);
  });

  it('归纳内手记按手记创建时间倒序，与手记一致', () => {
    const id = topic('计算机基础');
    const older = note({ body: '先写的一条' });
    const newer = note({ body: '后写的一条' });
    setNoteCreatedAt(older.id, '2026-01-01T00:00:00.000Z');
    setNoteCreatedAt(newer.id, '2026-02-01T00:00:00.000Z');
    topics.addNotes(id, [older.id, newer.id]);
    expect(topics.list()[0]?.noteIds).toEqual([newer.id, older.id]);
  });

  it('移出只删关系：手记仍在，其他归纳的收录不受影响', () => {
    const first = topic('前端开发');
    const second = topic('工具链');
    const kept = note();
    topics.addNotes(first, [kept.id]);
    topics.addNotes(second, [kept.id]);

    const updated = topics.removeNote(first, kept.id);
    expect(updated.noteIds).toEqual([]);
    expect(store.load().notes.map((item) => item.id)).toContain(kept.id);
    expect(topics.list().find((item) => item.id === second)?.noteIds).toEqual([kept.id]);
  });

  it('编辑推进版本，同内容重试视为成功，过期版本冲突', () => {
    const id = topic('前端开发');
    const edited = topics.update({
      id,
      title: '前端开发',
      description: '新的说明',
      expectedRevision: 1,
    });
    expect(edited.revision).toBe(2);
    expect(edited.description).toBe('新的说明');

    // 同内容重试：版本已推进一格且内容一致，按成功返回，不再写库。
    const retried = topics.update({
      id,
      title: '前端开发',
      description: '新的说明',
      expectedRevision: 1,
    });
    expect(retried.revision).toBe(2);

    expect(() =>
      topics.update({ id, title: '前端开发', description: '过期写入', expectedRevision: 1 }),
    ).toThrow('这个归纳已有更新');
    expect(topics.list()[0]?.description).toBe('新的说明');
  });

  it('重命名不重写收录关系', () => {
    const id = topic('前端开发');
    const noteId = note().id;
    topics.addNotes(id, [noteId]);
    topics.update({ id, title: '前端与工具链', description: '', expectedRevision: 1 });
    expect(topics.list()[0]?.noteIds).toEqual([noteId]);
    expect(store.load().notes.map((item) => item.id)).toContain(noteId);
  });

  it('删除归纳后列表不显示，手记与收录关系都保留，恢复后原样回来', () => {
    const id = topic('服务器运维');
    const noteId = note().id;
    topics.addNotes(id, [noteId]);

    topics.remove(id);
    expect(topics.list()).toHaveLength(0);
    expect(store.load().notes.map((item) => item.id)).toContain(noteId);
    // 关系行仍在：阶段 4 的恢复只需清空 deleted_at。
    expect(
      store.connection().prepare('SELECT 1 AS found FROM note_topics WHERE topic_id = ?').get(id),
    ).toBeDefined();

    store.connection().prepare('UPDATE topics SET deleted_at = NULL WHERE id = ?').run(id);
    expect(topics.list()[0]?.noteIds).toEqual([noteId]);
  });

  it('已删除的归纳不再接受收录与编辑', () => {
    const id = topic('计算机基础');
    topics.remove(id);
    expect(() => topics.addNotes(id, [note().id])).toThrow('不存在或已移入回收站');
    expect(() =>
      topics.update({ id, title: '改名', description: '', expectedRevision: 1 }),
    ).toThrow('不存在或已移入回收站');
  });

  it('拒绝收录不存在或已删除的手记', () => {
    const id = topic('本地数据库');
    expect(() => topics.addNotes(id, [randomUUID()])).toThrow('不存在或已移入回收站');

    const deleted = note();
    softDeleteNote(deleted.id);
    expect(() => topics.addNotes(id, [deleted.id])).toThrow('不存在或已移入回收站');
  });

  it('已删除手记不再计入收录数量，但关系行保留', () => {
    const id = topic('本地数据库');
    const removed = note();
    const kept = note();
    topics.addNotes(id, [removed.id, kept.id]);
    softDeleteNote(removed.id);

    expect(topics.list()[0]?.noteIds).toEqual([kept.id]);
    expect(
      store
        .connection()
        .prepare('SELECT count(*) AS total FROM note_topics WHERE topic_id = ?')
        .get(id)?.total,
    ).toBe(2);
  });

  it('单批收录数量有上限，超出时整体拒绝', () => {
    const id = topic('批量样例');
    const noteIds = Array.from({ length: 201 }, () => randomUUID());
    expect(() => topics.addNotes(id, noteIds)).toThrow('一次最多收录 200 条手记');
    expect(topics.list()[0]?.noteIds).toEqual([]);
  });

  it('数据库约束兜底：外键拒绝孤儿收录行，标题不能为空白', () => {
    const connection = store.connection();
    const id = topic('约束样例');
    expect(() =>
      connection
        .prepare('INSERT INTO note_topics (note_id, topic_id, created_at) VALUES (?, ?, ?)')
        .run(randomUUID(), id, new Date().toISOString()),
    ).toThrow();
    expect(() =>
      connection
        .prepare(
          'INSERT INTO topics (id, title, description, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
        )
        .run(randomUUID(), '   ', '', new Date().toISOString(), new Date().toISOString()),
    ).toThrow();
  });
});
