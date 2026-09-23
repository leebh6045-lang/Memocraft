import { describe, expect, it } from 'vitest';
import { containsQuery, highlightMatch } from '../../src/renderer/src/highlight';

/** 命中高亮的返回值会交给 v-html，转义必须发生在拼接之前。 */
describe('命中高亮', () => {
  it('包住命中的关键词并保留原文大小写', () => {
    expect(highlightMatch('SQLite 备份与恢复', 'sqlite')).toBe('<mark>SQLite</mark> 备份与恢复');
    expect(highlightMatch('a-b-c', 'b')).toBe('a-<mark>b</mark>-c');
  });

  it('先转义 HTML，再插入 mark，不产生可执行内容', () => {
    const html = highlightMatch('<script>alert(1)</script>', 'alert');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<mark>alert</mark>');
  });

  it('关键词里的正则元字符按字面量处理', () => {
    expect(highlightMatch('a.b', '.')).toBe('a<mark>.</mark>b');
    expect(highlightMatch('a+b', '+')).toBe('a<mark>+</mark>b');
    expect(highlightMatch('c:\\temp', '\\')).toBe('c:<mark>\\</mark>temp');
  });

  it('空关键词只返回转义后的原文', () => {
    expect(highlightMatch('a & b', '   ')).toBe('a &amp; b');
  });

  it('大小写不敏感地判断主行是否已展示命中', () => {
    expect(containsQuery('SQLite 备份', 'sqlite')).toBe(true);
    expect(containsQuery('SQLite 备份', 'mysql')).toBe(false);
    expect(containsQuery('SQLite 备份', '  ')).toBe(false);
  });
});
