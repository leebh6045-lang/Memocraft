import type { Note } from '../../domain/note';
import type { TimelineGrain } from './view-preferences';

/**
 * 手记「按时间」呈现的分段：按本机时区的日历日或月份把手记切成几段。
 * 只决定怎么分组，不改变顺序——段的先后与段内顺序都沿用传入列表（创建时间倒序）。
 */
export interface TimelineGroup {
  key: string;
  /** unknown 只用于无法解析的创建时间，正常数据不会出现。 */
  kind: 'day' | 'month' | 'unknown';
  /** 段的起点：当天 0 点或当月 1 日（本机时区）。 */
  start: Date;
  notes: Note[];
}

/** 日期栏上的文字：大号数字 + 单位，下面一行补充说明，今天 / 昨天另有标记。 */
export interface TimelineLabel {
  primary: string;
  unit: string;
  detail: string;
  mark: string;
  /** 给读屏的完整说法，例如「2026年9月27日 周日（今天）」。 */
  spoken: string;
}

/** 「近一周」：今天与往前 6 天，共 7 个日历日逐日分段，更早的按月合并。 */
export const RECENT_DAY_COUNT = 7;
const WEEKDAYS = '日一二三四五六';

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(later: Date, earlier: Date): number {
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / 86_400_000);
}

export function groupNotesByTime(
  notes: Note[],
  grain: TimelineGrain,
  now: Date = new Date(),
): TimelineGroup[] {
  // 用 Map 按首次出现的顺序收集：即使传入列表局部乱序，同一段也不会被拆成两段。
  const groups = new Map<string, TimelineGroup>();
  for (const note of notes) {
    const created = new Date(note.createdAt);
    let group: Omit<TimelineGroup, 'notes'>;
    if (Number.isNaN(created.getTime())) {
      group = { key: 'unknown', kind: 'unknown', start: new Date(0) };
    } else if (grain === 'days' || daysBetween(now, created) < RECENT_DAY_COUNT) {
      const start = startOfDay(created);
      group = { key: `d-${start.getTime()}`, kind: 'day', start };
    } else {
      const start = new Date(created.getFullYear(), created.getMonth(), 1);
      group = { key: `m-${start.getTime()}`, kind: 'month', start };
    }
    const existing = groups.get(group.key);
    if (existing) existing.notes.push(note);
    else groups.set(group.key, { ...group, notes: [note] });
  }
  return [...groups.values()];
}

export function timelineLabel(group: TimelineGroup, now: Date = new Date()): TimelineLabel {
  const { start } = group;
  const sameYear = start.getFullYear() === now.getFullYear();
  if (group.kind === 'day') {
    const days = daysBetween(now, start);
    const mark = days === 0 ? '今天' : days === 1 ? '昨天' : '';
    const weekday = `周${WEEKDAYS[start.getDay()]}`;
    const month = sameYear
      ? `${start.getMonth() + 1}月`
      : `${start.getFullYear()}.${start.getMonth() + 1}`;
    const spoken = `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日 ${weekday}`;
    return {
      primary: String(start.getDate()),
      unit: '',
      detail: `${month} · ${weekday}`,
      mark,
      spoken: mark ? `${spoken}（${mark}）` : spoken,
    };
  }
  if (group.kind === 'month') {
    // 本月出现月份段，只可能是「近一周以前」的那部分。
    const thisMonth = sameYear && start.getMonth() === now.getMonth();
    const detail = thisMonth ? '本月更早' : sameYear ? '' : String(start.getFullYear());
    const spoken = `${start.getFullYear()}年${start.getMonth() + 1}月${thisMonth ? '（一周以前）' : ''}`;
    return { primary: String(start.getMonth() + 1), unit: '月', detail, mark: '', spoken };
  }
  return { primary: '—', unit: '', detail: '时间未知', mark: '', spoken: '创建时间未知' };
}
