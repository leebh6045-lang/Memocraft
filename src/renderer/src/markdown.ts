import MarkdownIt from 'markdown-it';

/**
 * 共享的 Markdown 渲染器：一律关闭 HTML，且不解析图片与链接。
 * 正文里的图片由独立图集承载、链接不在此处打开，因此渲染只负责文本与代码。
 * 手记抽屉与动态正文共用同一份配置，避免两处安全设置漂移。
 */
const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
markdown.disable(['image', 'link']);

export function renderMarkdown(text: string): string {
  return markdown.render(text);
}
