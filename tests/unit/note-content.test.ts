import { describe, expect, it } from 'vitest';
import { noteExcerpt, noteTitle, type NoteContent } from '../../src/domain/note';

function content(body: string, title = ''): NoteContent {
  return { body, title, category: 'insight', tags: [] };
}

/** 卡片标题与摘要共用同一份规则：标题取自正文首行时，摘要不能把这一行再显示一次。 */
describe('手记标题与摘要', () => {
  it('填了标题就用标题，摘要仍是完整正文（去掉首尾空行）', () => {
    expect(noteTitle(content('正文内容', '自定标题'))).toBe('自定标题');
    expect(noteExcerpt(content('\n\n正文内容\n\n', '自定标题'))).toBe('正文内容');
  });

  it('没填标题时标题取正文首个非空行，摘要跳过这一行', () => {
    const note = content('\n\n第一行标题\n第二行正文\n第三行正文');
    expect(noteTitle(note)).toBe('第一行标题');
    expect(noteExcerpt(note)).toBe('第二行正文\n第三行正文');
  });

  it('整条只有一个非空行时摘要为空，界面据此不渲染摘要区', () => {
    expect(noteExcerpt(content('只有一行'))).toBe('');
    expect(noteExcerpt(content('   '))).toBe('');
  });

  it('无非空行的空正文仍有可展示标题，不产生 undefined', () => {
    expect(noteTitle(content('   '))).toBe('无标题手记');
    expect(noteExcerpt(content('   '))).toBe('');
  });

  it('超长首行按 80 字截断，摘要不因此丢内容', () => {
    const long = '长'.repeat(120);
    const note = content(`${long}\n后面的正文`);
    expect(noteTitle(note)).toHaveLength(80);
    expect(noteExcerpt(note)).toBe('后面的正文');
  });
});
