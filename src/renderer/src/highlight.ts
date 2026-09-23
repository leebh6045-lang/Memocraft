/**
 * 命中高亮：先转义 HTML，再把关键词包进 `<mark>`。
 * 返回值用于 v-html，因此转义必须发生在这里，且只对已转义文本做替换。
 */
function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );
}

export function highlightMatch(text: string, query: string): string {
  const safe = escapeHtml(text);
  const needle = escapeHtml(query.trim());
  if (!needle) return safe;
  // 转义后的关键词按字面量匹配，正则元字符需要再转义一层。
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(pattern, 'gi'), (match) => `<mark>${match}</mark>`);
}

/** 主行是否已经展示了命中位置；没有命中时才需要在上下文里补充摘要。 */
export function containsQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return Boolean(needle) && text.toLowerCase().includes(needle);
}
