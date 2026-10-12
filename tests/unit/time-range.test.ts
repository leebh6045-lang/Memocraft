import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  isFuture,
  isLocalDate,
  isoWeekNumber,
  isoWeekRange,
  localDateToUtcStart,
  localToday,
  monthRange,
  shiftPeriod,
} from '../../src/domain/time-range';
import {
  validateAiPeriodSummaryInput,
  validatePeriodNotesQuery,
  validatePeriodSummaryKey,
} from '../../src/services/ai-validation';

const requestId = '68d2b2a5-7c0c-4d97-848c-518fa6a78756';
afterEach(() => vi.unstubAllEnvs());

describe('自然周期日历与本地查询边界', () => {
  it.each(['2026-10-05', '2026-10-11'])('周一至周日包含锚点 %s', (anchor) => {
    expect(isoWeekRange(anchor)).toEqual({ startDate: '2026-10-05', endDate: '2026-10-11' });
  });
  it('跨年使用 ISO 周年份，跨月也连续导航', () => {
    expect(isoWeekRange('2021-01-01')).toEqual({ startDate: '2020-12-28', endDate: '2021-01-03' });
    expect(isoWeekNumber('2021-01-01')).toEqual({ year: 2020, week: 53 });
    expect(isoWeekNumber('2026-10-11')).toEqual({ year: 2026, week: 41 });
    expect(shiftPeriod('week', '2026-10-26', 1)).toEqual({
      startDate: '2026-11-02',
      endDate: '2026-11-08',
    });
  });
  it.each([
    ['2024-02-17', '2024-02-01', '2024-02-29'],
    ['2025-02-28', '2025-02-01', '2025-02-28'],
    ['2026-01-20', '2026-01-01', '2026-01-31'],
    ['2026-12-20', '2026-12-01', '2026-12-31'],
  ])('自然月 %s', (anchor, startDate, endDate) =>
    expect(monthRange(anchor)).toEqual({ startDate, endDate }),
  );
  it('从月初导航，不受月底或闰日溢出影响', () => {
    expect(shiftPeriod('month', '2024-03-01', -1)).toEqual({
      startDate: '2024-02-01',
      endDate: '2024-02-29',
    });
    expect(shiftPeriod('month', '2026-12-01', 1).startDate).toBe('2027-01-01');
  });
  it.each(['', '2026-2-01', '2026-02-29', '2026-13-01', '2026-04-31', '0000-01-01', 'text'])(
    '拒绝非法日历日期 %s',
    (value) => {
      expect(isLocalDate(value)).toBe(false);
      expect(() => isoWeekRange(value)).toThrow();
    },
  );
  it('UTC+8 的半开边界包含结束日期全天', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    expect(localDateToUtcStart('2026-10-05')).toBe('2026-10-04T16:00:00.000Z');
    expect(localDateToUtcStart(addDays('2026-10-11', 1))).toBe('2026-10-11T16:00:00.000Z');
    expect(localToday(new Date('2026-10-10T16:30:00.000Z'))).toBe('2026-10-11');
  });
  it('UTC-5 与夏令时切换日按次日零时换算，不能固定加24小时', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(localDateToUtcStart('2026-01-05')).toBe('2026-01-05T05:00:00.000Z');
    const start = localDateToUtcStart('2026-03-08');
    const end = localDateToUtcStart('2026-03-09');
    expect(start).toBe('2026-03-08T05:00:00.000Z');
    expect(end).toBe('2026-03-09T04:00:00.000Z');
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3_600_000);
    expect(
      Date.parse(localDateToUtcStart('2026-11-02')) - Date.parse(localDateToUtcStart('2026-11-01')),
    ).toBe(25 * 3_600_000);
  });
  it('只拒绝未来起点，不拒绝结束日期在未来的当前周期', () => {
    const today = '2026-10-11';
    expect(isFuture(today, today)).toBe(false);
    expect(isFuture('2026-10-12', today)).toBe(true);
    expect(isFuture('2026-10-10', today)).toBe(false);
    const now = new Date('2026-10-11T12:00:00Z');
    expect(
      validateAiPeriodSummaryInput(
        { requestId, periodType: 'month', startDate: '2026-10-31', regenerate: false },
        now,
      ),
    ).toEqual({ requestId, periodType: 'month', startDate: '2026-10-01', regenerate: false });
    expect(() =>
      validateAiPeriodSummaryInput(
        { requestId, periodType: 'week', startDate: '2026-10-12', regenerate: false },
        now,
      ),
    ).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { requestId, periodType: 'year', startDate: '2026-10-05', regenerate: false },
    { requestId: 'bad', periodType: 'week', startDate: '2026-10-05', regenerate: false },
    { requestId, periodType: 'week', startDate: '2026-10-05', regenerate: 'false' },
    { requestId, periodType: 'week', startDate: '2026-02-29', regenerate: false },
  ])('IPC 不放行非法载荷 %j', (value) =>
    expect(() => validateAiPeriodSummaryInput(value)).toThrow(),
  );
  it('存储查询拒绝日期冒充UTC时间或倒序，缓存键必须规范化', () => {
    expect(() =>
      validatePeriodNotesQuery({
        startAt: '2026-10-05',
        endBefore: '2026-10-12',
        staleBefore: '2026-10-04',
      }),
    ).toThrow();
    expect(() =>
      validatePeriodNotesQuery({
        startAt: '2026-10-12T00:00:00.000Z',
        endBefore: '2026-10-05T00:00:00.000Z',
        staleBefore: '2026-10-04T00:00:00.000Z',
      }),
    ).toThrow();
    expect(() =>
      validatePeriodSummaryKey({ periodType: 'week', startDate: '2026-10-06' }),
    ).toThrow();
  });
});
