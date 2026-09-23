/** 可读导出的文件名与元数据规则；这些规则是纯函数，便于单独验证。 */

/** Windows 非法字符：导出文件可能被移动到其他平台，必须提前清理。 */
const ILLEGAL = /[<>:"/\\|?*]/g;
const MAX_SLUG_LENGTH = 60;

/** 控制字符（含换行、制表）按码点剔除，不用带控制字符的正则。 */
function stripControl(value: string): string {
  return Array.from(value)
    .filter((character) => (character.codePointAt(0) ?? 0) >= 32)
    .join('');
}

/**
 * 文件名 = 稳定 ID + 清理后的标题。
 * 稳定 ID 保证即使标题被改名或清理成空，文件仍能唯一对应一条内容。
 */
export function exportFileName(title: string, id: string): string {
  const slug = stripControl(title)
    .replace(ILLEGAL, ' ')
    .replace(/[\s.]+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .trim();
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}

/** 去掉会破坏 Markdown 结构的字符，用于单行字段（标题、标签）。 */
export function inlineText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * YAML 前置元数据：导出既能被人读，也能被脚本解析。
 * 关系只写稳定 ID 与标题，不复制正文，避免导出物成为第二份事实来源。
 */
export function frontMatter(fields: Record<string, string | string[]>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      if (!value.length) continue;
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${inlineText(item)}`);
      continue;
    }
    if (!value) continue;
    lines.push(`${key}: ${inlineText(value)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
