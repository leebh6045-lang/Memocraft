/**
 * 外观偏好：浅色、深色或跟随系统。
 * 偏好只影响界面，不需要进 SQLite；读取失败时退回浅色，不阻塞启动。
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'memocraft-theme';

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'system') return stored;
  } catch {
    // 读取失败按浅色处理，由调用方决定是否提示。
  }
  return 'light';
}

export function writeThemePreference(preference: ThemePreference): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/** 跟随系统时以系统偏好为准，其余情况直接用用户选择。 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}
