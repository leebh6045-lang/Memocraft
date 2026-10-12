import { AppError } from '../shared/errors';

export interface DateRange {
  startDate: string;
  endDate: string;
}

/** 日历运算用 UTC 避免夏令时改变天数；只有查询边界按本机时区转换。 */
function calendarDate(value: string): Date {
  if (!isLocalDate(value)) throw new AppError('VALIDATION', '请选择有效的日期。');
  return new Date(`${value}T00:00:00.000Z`);
}

export function isLocalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01')
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateString(date: Date): string {
  const value = date.toISOString().slice(0, 10);
  if (!isLocalDate(value)) throw new AppError('VALIDATION', '日期超出支持范围。');
  return value;
}

export function localToday(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function addDays(value: string, days: number): string {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return dateString(date);
}

export function isoWeekRange(anchorDate: string): DateRange {
  const date = calendarDate(anchorDate);
  const startDate = addDays(anchorDate, 1 - (date.getUTCDay() || 7));
  return { startDate, endDate: addDays(startDate, 6) };
}

export function monthRange(anchorDate: string): DateRange {
  const start = calendarDate(anchorDate);
  start.setUTCDate(1);
  const startDate = dateString(start);
  start.setUTCMonth(start.getUTCMonth() + 1);
  start.setUTCDate(0);
  return { startDate, endDate: dateString(start) };
}

export function periodRange(type: 'week' | 'month', anchorDate: string): DateRange {
  return type === 'week' ? isoWeekRange(anchorDate) : monthRange(anchorDate);
}

export function shiftPeriod(
  type: 'week' | 'month',
  startDate: string,
  direction: -1 | 1,
): DateRange {
  if (type === 'week') return isoWeekRange(addDays(startDate, direction * 7));
  const date = calendarDate(startDate);
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return monthRange(dateString(date));
}

/** 次日零时独立转换，不能用 UTC 起点加 24 小时代替夏令时切换日。 */
export function localDateToUtcStart(localDate: string): string {
  calendarDate(localDate);
  return new Date(`${localDate}T00:00:00`).toISOString();
}

export function isFuture(startDate: string, today = localToday()): boolean {
  calendarDate(startDate);
  calendarDate(today);
  return startDate > today;
}

/** ISO 周所属年份取周四所在年，跨年周不能使用普通日历年份。 */
export function isoWeekNumber(anchorDate: string): { year: number; week: number } {
  const thursday = calendarDate(addDays(isoWeekRange(anchorDate).startDate, 3));
  const year = thursday.getUTCFullYear();
  const firstMonday = isoWeekRange(`${String(year).padStart(4, '0')}-01-04`).startDate;
  const week =
    Math.floor((thursday.getTime() - calendarDate(firstMonday).getTime()) / 604_800_000) + 1;
  return { year, week };
}
