import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDraft } from '../../src/domain/note';
import { AI_SUGGESTION_TAG_POOL_LIMIT } from '../../src/shared/ai';
import { NoteStore } from '../../src/storage/note-store';
import { SCHEMA_VERSION } from '../../src/storage/schema';
import { TagStore } from '../../src/storage/tag-store';

let directory: string;
let notes: NoteStore;
let tags: TagStore;

/** 用真实关系验证排序和软删除；标签池不维护第二份频次数据。 */
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memocraft-tag-pool-'));
  notes = new NoteStore({
    dataDirectory: join(directory, 'data'),
    migrationsDirectory: resolve('migrations'),
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  tags = new TagStore(notes.connection());
});
afterEach(() => {
  notes.close();
  rmSync(directory, { recursive: true, force: true });
});

function noteWithTags(names: string[]) {
  return notes.commitDraft({
    ...emptyDraft(randomUUID()),
    revision: 1,
    body: '用于标签候选的有效手记',
    tags: names,
  });
}

describe('AI 建议标签池', () => {
  it('空库返回空池，草稿标签不计入', () => {
    expect(tags.list()).toEqual([]);
    notes.saveDraft({ ...emptyDraft(randomUUID()), revision: 1, body: '未提交', tags: ['草稿'] });
    expect(tags.list()).toEqual([]);
  });

  it('按使用手记数量倒序，同频次按名称排序并只返回一份标签', () => {
    noteWithTags(['C', 'B', 'A']);
    noteWithTags(['B', 'A']);
    noteWithTags(['C']);
    noteWithTags(['C']);
    expect(tags.list()).toEqual(['C', 'A', 'B']);
  });

  it('已删除手记不影响频次，孤立标签与仅被删除手记使用的标签不返回', () => {
    noteWithTags(['B']);
    const first = noteWithTags(['A', '仅删除']);
    const second = noteWithTags(['A']);
    notes.remove(first.id);
    notes.remove(second.id);
    notes
      .connection()
      .prepare('INSERT INTO tags (name, normalized_name) VALUES (?, ?)')
      .run('未使用', '未使用');
    expect(tags.list()).toEqual(['B']);
    // 保留原有软删除关系：读取候选不应清理用户数据。
    expect(notes.connection().prepare('SELECT COUNT(*) AS count FROM note_tags').get()?.count).toBe(
      4,
    );
  });

  it('先按频次排序再截取 40 项，同频次的截取稳定', () => {
    const names = Array.from(
      { length: 45 },
      (_unused, index) => `标签${String(index).padStart(2, '0')}`,
    );
    noteWithTags([...names, '置顶']);
    noteWithTags(['置顶']);
    expect(tags.list()).toEqual(['置顶', ...names.slice(0, AI_SUGGESTION_TAG_POOL_LIMIT - 1)]);
    expect(tags.list()).toHaveLength(AI_SUGGESTION_TAG_POOL_LIMIT);
  });
});
