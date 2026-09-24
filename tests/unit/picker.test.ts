import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import type { TopicSummary } from '../../src/domain/topic';
import { notePickerOptions, topicPickerOptions } from '../../src/renderer/src/picker';

/**
 * 选择器条目的方向性：手记侧挑归纳时「全部列出、已收录带标记」，
 * 归纳侧挑手记时「已关联不列出、只回报数量」。方向搞反正是这次修复的起因。
 */
function note(id: string, title: string, body = '正文', tags: string[] = []): Note {
  return {
    id,
    title,
    body,
    tags,
    category: 'insight',
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
    revision: 1,
  };
}

function topic(id: string, title: string, noteIds: string[], description = ''): TopicSummary {
  return {
    id,
    title,
    description,
    noteIds,
    revision: 1,
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T10:00:00.000Z',
  };
}

describe('归纳选择器条目', () => {
  it('列出全部归纳，已收录的带标记而不是消失', () => {
    const options = topicPickerOptions(
      [topic('t1', '本地数据库', ['n1']), topic('t2', '服务器运维', [])],
      ['t1'],
    );
    expect(options.map((option) => option.id)).toEqual(['t1', 't2']);
    expect(options[0]?.badge).toBe('已收录');
    expect(options[1]?.badge).toBeUndefined();
  });

  it('次要信息显示收录数量，搜索文本含标题与说明', () => {
    const [option] = topicPickerOptions(
      [topic('t1', '本地数据库', ['n1', 'n2'], '备份与查询')],
      [],
    );
    expect(option?.meta).toBe('2 条手记');
    expect(option?.searchText).toContain('本地数据库');
    expect(option?.searchText).toContain('备份与查询');
  });
});

describe('手记选择器条目', () => {
  it('已关联的手记不列出，并回报数量用于空状态', () => {
    const result = notePickerOptions([note('n1', '第一条'), note('n2', '第二条')], ['n1']);
    expect(result.options.map((option) => option.id)).toEqual(['n2']);
    expect(result.linkedCount).toBe(1);
  });

  it('无标题手记用正文首行作为条目名，标签也参与搜索', () => {
    const result = notePickerOptions([note('n1', '  ', '只配 cert.pem 会报错', ['证书'])], []);
    expect(result.options[0]?.title).toBe('只配 cert.pem 会报错');
    expect(result.options[0]?.searchText).toContain('证书');
  });

  it('没有已关联项时数量为 0', () => {
    const result = notePickerOptions([note('n1', '第一条')], []);
    expect(result.linkedCount).toBe(0);
  });
});
