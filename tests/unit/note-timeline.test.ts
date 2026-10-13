import { describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import {
  groupNotesByTime,
  timelineLabel,
  type TimelineGroup,
} from '../../src/renderer/src/note-timeline';

/** 固定「现在」为 2026-09-27（周日）16:40，按本机时区构造时间，与界面的解释方式一致。 */
const NOW = new Date(2026, 8, 27, 16, 40);

function note(id: string, created: Date | string): Note {
  const iso = typeof created === 'string' ? created : created.toISOString();
  return {
    id,
    title: '',
    body: id,
    category: 'insight',
    tags: [],
    revision: 1,
    createdAt: iso,
    updatedAt: iso,
  };
}
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute);
const summary = (groups: TimelineGroup[]) =>
  groups.map((group) => `${group.kind}:${group.notes.map((item) => item.id).join(',')}`);
/** 取第 index 段；分段数量不对时直接失败，而不是把 undefined 传下去。 */
function groupAt(groups: TimelineGroup[], index: number): TimelineGroup {
  const group = groups[index];
  if (!group) throw new Error(`缺少第 ${index + 1} 段，实际只有 ${groups.length} 段`);
  return group;
}

describe('手记按时间分段', () => {
  const todayLate = note('today-2', at(9, 27, 15, 5));
  const todayEarly = note('today-1', at(9, 27, 9, 30));
  const yesterday = note('yesterday', at(9, 26, 23, 16));
  const sixDays = note('six-days', at(9, 21, 0, 0));
  const sevenDays = note('seven-days', at(9, 20, 23, 59));
  const earlySept = note('early-sept', at(9, 3));
  const august = note('august', at(8, 28));
  const lastYear = note('last-year', at(12, 20, 22, 30, 2025));
  const notes = [todayLate, todayEarly, yesterday, sixDays, sevenDays, earlySept, august, lastYear];

  it('近一周（今天与往前 6 天）逐日分段，更早的按月合并', () => {
    expect(summary(groupNotesByTime(notes, 'recent-days', NOW))).toEqual([
      'day:today-2,today-1',
      'day:yesterday',
      'day:six-days',
      'month:seven-days,early-sept',
      'month:august',
      'month:last-year',
    ]);
  });

  it('一律按天时，每个日历日各成一段', () => {
    const groups = groupNotesByTime(notes, 'days', NOW);
    expect(groups.every((group) => group.kind === 'day')).toBe(true);
    expect(groups).toHaveLength(7);
    expect(groupAt(groups, 0).notes.map((item) => item.id)).toEqual(['today-2', 'today-1']);
  });

  it('沿用传入顺序；同一段即使被隔开也不会拆成两段', () => {
    const shuffled = [yesterday, todayLate, sixDays, todayEarly];
    expect(summary(groupNotesByTime(shuffled, 'days', NOW))).toEqual([
      'day:yesterday',
      'day:today-2,today-1',
      'day:six-days',
    ]);
  });

  it('无法解析的创建时间单独成段，不混进任何日期', () => {
    const groups = groupNotesByTime([note('broken', 'not-a-date'), todayLate], 'days', NOW);
    expect(summary(groups)).toEqual(['unknown:broken', 'day:today-2']);
    expect(timelineLabel(groupAt(groups, 0), NOW)).toMatchObject({
      primary: '—',
      detail: '时间未知',
    });
  });

  it('日期栏：今天、昨天带标记，跨年写出年份', () => {
    const groups = groupNotesByTime(notes, 'recent-days', NOW);
    expect(timelineLabel(groupAt(groups, 0), NOW)).toEqual({
      primary: '27',
      unit: '',
      detail: '9月 · 周日',
      mark: '今天',
      spoken: '2026年9月27日 周日（今天）',
    });
    expect(timelineLabel(groupAt(groups, 1), NOW)).toMatchObject({ primary: '26', mark: '昨天' });
    expect(timelineLabel(groupAt(groups, 2), NOW)).toMatchObject({
      detail: '9月 · 周一',
      mark: '',
    });

    const lastYearDay = groupAt(groupNotesByTime([lastYear], 'days', NOW), 0);
    expect(timelineLabel(lastYearDay, NOW)).toMatchObject({
      primary: '20',
      detail: '2025.12 · 周六',
    });
  });

  it('月份段：本月写「本月更早」，今年其他月份不写年份，跨年写出年份', () => {
    const months = groupNotesByTime(notes, 'recent-days', NOW).filter(
      (group) => group.kind === 'month',
    );
    expect(months.map((group) => timelineLabel(group, NOW))).toEqual([
      { primary: '9', unit: '月', detail: '本月更早', mark: '', spoken: '2026年9月（一周以前）' },
      { primary: '8', unit: '月', detail: '', mark: '', spoken: '2026年8月' },
      { primary: '12', unit: '月', detail: '2025', mark: '', spoken: '2025年12月' },
    ]);
  });
});
