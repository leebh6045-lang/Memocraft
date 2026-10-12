import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/renderer/src/markdown';

describe('共享 Markdown 只格式化文字', () => {
  it('保留主题列表和加粗短标题', () => {
    const html = renderMarkdown('- **核心主题**：重点回顾。\n- **其他方向**：简要带出。');
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html).toContain('<strong>核心主题</strong>');
    expect(html).toContain('<strong>其他方向</strong>');
  });

  it('HTML、图片、普通链接与尖括号自动链接都只能显示文字', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[链接](https://example.invalid) ![图](https://example.invalid/private.png) <https://example.invalid> <review@example.invalid>',
    );
    expect(html).not.toMatch(/<(?:a|img|script)\b/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;https://example.invalid&gt;');
    expect(html).toContain('&lt;review@example.invalid&gt;');
    expect(html).toContain('[链接](https://example.invalid)');
    expect(html).toContain('![图](https://example.invalid/private.png)');
  });
});
