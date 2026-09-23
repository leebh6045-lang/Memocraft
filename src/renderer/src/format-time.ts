/**
 * 统一的时间显示规则（基准第 2 节）：
 * 当天「今天 HH:MM」、前一天「昨天 HH:MM」、同年「MM.DD HH:MM」、跨年「YYYY.MM.DD」。
 * 存储里是 UTC ISO 文本，这里按本机时区解释后展示；卡片与列表共用，不各自实现一套。
 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function formatTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  if (date.getFullYear() === now.getFullYear()) return `${month}.${day} ${clock}`;
  return `${date.getFullYear()}.${month}.${day}`;
}

/** 悬停提示用的完整时间，避免为了精确值去猜相对文案。 */
export function formatFullTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN');
}

/**
 * 发生时间输入用本地时间，存储用 UTC ISO 文本。
 * 互转集中在这里，界面不各自拼字符串；非法输入返回空串，由校验层拒绝空值。
 */
export function toDateTimeInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function fromDateTimeInput(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
