import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readThemePreference,
  resolveTheme,
  writeThemePreference,
} from '../../src/renderer/src/theme';

/** 外观偏好：三选一的解析规则，以及读写失败时的退路。 */
describe('外观偏好', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it('默认浅色，已保存的值原样读回', () => {
    expect(readThemePreference()).toBe('light');
    expect(writeThemePreference('dark')).toBe(true);
    expect(readThemePreference()).toBe('dark');
    expect(writeThemePreference('system')).toBe(true);
    expect(readThemePreference()).toBe('system');
  });

  it('未知取值退回浅色，不把脏数据当成有效偏好', () => {
    store.set('memocraft-theme', 'midnight');
    expect(readThemePreference()).toBe('light');
  });

  it('读取与写入失败都不抛出，只返回退路结果', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readThemePreference()).toBe('light');
    expect(writeThemePreference('dark')).toBe(false);
  });

  it('跟随系统时以系统偏好为准，其余情况用用户选择', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
