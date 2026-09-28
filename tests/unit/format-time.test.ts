import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatFullTime,
  formatTime,
  fromDateTimeInput,
  toDateTimeInput,
} from '../../src/renderer/src/format-time';

/** 统一时间格式：今天 / 昨天 / 同年 / 跨年四档，卡片与列表共用同一实现。 */
describe('时间显示', () => {
  const now = new Date('2026-09-22T20:00:00');
  const local = (value: string) => new Date(value).toISOString();

  it('当天显示「今天 HH:MM」', () => {
    expect(formatTime(local('2026-09-22T10:24:00'), now)).toBe('今天 10:24');
  });

  it('前一天显示「昨天 HH:MM」', () => {
    expect(formatTime(local('2026-09-21T19:16:00'), now)).toBe('昨天 19:16');
  });

  it('同年更早显示「MM.DD HH:MM」', () => {
    expect(formatTime(local('2026-09-18T13:40:00'), now)).toBe('09.18 13:40');
  });

  it('跨年只显示日期', () => {
    expect(formatTime(local('2025-12-31T23:10:00'), now)).toBe('2025.12.31');
  });

  it('跨天按日历天判断，不按 24 小时', () => {
    // 今天 00:30 与昨天 23:30 相差不到 24 小时，但必须分别显示今天与昨天。
    const midnight = new Date('2026-09-22T00:30:00');
    expect(formatTime(local('2026-09-22T00:30:00'), midnight)).toBe('今天 00:30');
    expect(formatTime(local('2026-09-21T23:30:00'), midnight)).toBe('昨天 23:30');
  });

  it('非法时间返回空字符串，不显示 Invalid Date', () => {
    expect(formatTime('not-a-date', now)).toBe('');
    expect(formatFullTime('not-a-date')).toBe('');
    expect(formatClock('not-a-date')).toBe('');
  });

  it('按天分段里只写时刻，补零且按本地时区', () => {
    expect(formatClock(local('2026-09-22T09:05:00'))).toBe('09:05');
    expect(formatClock(local('2025-12-31T23:10:00'))).toBe('23:10');
  });
});

describe('发生时间输入与存储互转', () => {
  it('ISO 转本地输入值，分钟精度且补零', () => {
    const iso = new Date('2026-09-10T08:05:00').toISOString();
    expect(toDateTimeInput(iso)).toBe('2026-09-10T08:05');
  });

  it('输入值回转 ISO，非法输入返回空串', () => {
    expect(new Date(fromDateTimeInput('2026-09-10T08:05')).toISOString()).toBe(
      new Date('2026-09-10T08:05').toISOString(),
    );
    expect(fromDateTimeInput('')).toBe('');
    expect(fromDateTimeInput('昨天')).toBe('');
    expect(toDateTimeInput('not-a-date')).toBe('');
  });

  it('来回转换不丢分钟，跨时区也按本地解释', () => {
    const iso = new Date('2026-01-31T23:59:00').toISOString();
    expect(fromDateTimeInput(toDateTimeInput(iso))).toBe(iso);
  });
});
