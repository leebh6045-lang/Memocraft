// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import AiAnswerRow from '../../src/renderer/src/components/AiAnswerRow.vue';
import SearchPalette from '../../src/renderer/src/components/SearchPalette.vue';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import type { AiAnswer } from '../../src/shared/ai';
import type { AskPhase } from '../../src/renderer/src/composables/useAiAsk';
import type { SearchHit } from '../../src/domain/search';

const answer: AiAnswer = {
  answer: '完整回答保留所有文字与引用。[1]\n第二句话也能在展开后阅读。',
  sources: [
    { index: 1, noteId: 'real-note-1', title: '真实本地标题' },
    { index: 3, noteId: 'real-note-3', title: '另一条手记' },
  ],
  matchedNotes: 3,
};
const wrappers: VueWrapper[] = [];
const styles: HTMLStyleElement[] = [];
function mountRow(
  phase: AskPhase,
  overrides: Partial<{ answer: AiAnswer | null; error: string; expanded: boolean }> = {},
) {
  const wrapper = mount(AiAnswerRow, {
    props: { phase, answer, error: '', expanded: false, ...overrides },
  });
  wrappers.push(wrapper);
  return wrapper;
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === label);
  if (!found) throw new Error(`没有找到按钮：${label}`);
  return found;
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  for (const style of styles.splice(0)) style.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AI 搜索摘要行', () => {
  it('idle 不保留占位；loading 和 empty 给出对应状态文案', async () => {
    const row = mountRow('idle');
    expect(row.find('section').exists()).toBe(false);
    await row.setProps({ phase: 'loading' });
    expect(row.get('[role="status"]').text()).toBe('正在从你的手记中查找…');
    expect(row.get('[role="status"]').attributes('aria-busy')).toBe('true');
    expect(row.find('[role="dialog"]').exists()).toBe(false);
    await row.setProps({ phase: 'empty' });
    expect(row.get('[role="status"]').text()).toBe('这次没找到相关手记，换个词试试。');
    expect(row.find('button').exists()).toBe(false);
  });

  it('收起时保留完整文本与来源数量，CSS 限制单行省略；点击上抛展开', async () => {
    const row = mountRow('ready');
    expect(row.get('.ai-summary').text()).toBe(answer.answer);
    expect(row.get('.source-count').text()).toBe('2 个来源');
    expect(row.find('.ai-sources').exists()).toBe(false);
    // 将真实组件样式加入 jsdom，验证省略只影响显示而不截短模型正文。
    const source = readFileSync('src/renderer/src/components/AiAnswerRow.vue', 'utf8');
    const stylesheet = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1];
    if (!stylesheet) throw new Error('回答行样式未找到');
    const style = document.createElement('style');
    style.textContent = stylesheet;
    document.head.append(style);
    styles.push(style);
    const summaryStyle = window.getComputedStyle(row.get('.ai-summary').element);
    expect(summaryStyle.whiteSpace).toBe('nowrap');
    expect(summaryStyle.textOverflow).toBe('ellipsis');
    expect(summaryStyle.overflow).toBe('hidden');
    await row.get('.is-result').trigger('click');
    expect(row.emitted('expand')).toEqual([[]]);
  });

  it('展开在原面板内显示完整回答、真实来源标题与 ID，可收起', async () => {
    const row = mountRow('ready', { expanded: true });
    expect(row.get('.ai-answer').text()).toBe(answer.answer);
    expect(row.findAll('.source-link').map((source) => source.text())).toEqual([
      '[1] 真实本地标题',
      '[3] 另一条手记',
    ]);
    await row.findAll('.source-link')[1]?.trigger('click');
    expect(row.emitted('open-note')).toEqual([['real-note-3']]);
    await button(row, '收起').trigger('click');
    expect(row.emitted('collapse')).toEqual([[]]);
    expect(row.find('[role="dialog"]').exists()).toBe(false);
  });

  it('来源全部被主进程丢弃时显示回答，隐藏来源区和来源数量', async () => {
    const row = mountRow('ready', { answer: { ...answer, sources: [] } });
    expect(row.find('.source-count').exists()).toBe(false);
    await row.setProps({ expanded: true });
    expect(row.get('.ai-answer').text()).toBe(answer.answer);
    expect(row.find('.ai-sources').exists()).toBe(false);
    expect(row.find('.source-link').exists()).toBe(false);
  });

  it('业务错误通过 alert 呈现并支持重试', async () => {
    const row = mountRow('error', { error: '余额不足，请充值后重试。' });
    expect(row.get('[role="alert"]').text()).toContain('余额不足，请充值后重试。');
    expect(row.find('.is-result').exists()).toBe(false);
    await button(row, '重试').trigger('click');
    expect(row.emitted('retry')).toEqual([[]]);
  });

  it('回答和来源标题均按纯文本展示，不能注入 HTML', () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const row = mountRow('ready', {
      expanded: true,
      answer: {
        answer: unsafe,
        sources: [{ index: 1, noteId: 'real-id', title: unsafe }],
        matchedNotes: 1,
      },
    });
    expect(row.text()).toContain(unsafe);
    expect(row.find('img').exists()).toBe(false);
    expect(row.get('.source-link').attributes('title')).toBe(unsafe);
  });
});

const hits: SearchHit[] = ['first', 'second'].map((id) => ({
  kind: 'note',
  id,
  title: `手记 ${id}`,
  excerpt: '',
  context: '收获',
  threadId: null,
  threadTitle: null,
  at: '2026-10-10T00:00:00Z',
}));

function mountPalette() {
  const search = vi.fn(async () => ({ ok: true as const, value: { hits, hasMore: false } }));
  const wrapper = mount(SearchPalette, {
    props: {
      bridge: { ...disconnectedApi, search },
      changeVersion: 0,
      askPhase: 'ready',
      answer,
      askError: '',
      askExpanded: false,
    },
  });
  wrappers.push(wrapper);
  return { wrapper, search };
}

describe('搜索面板与 AI 问答互不干扰', () => {
  it('摘要行在普通结果上方并独立上抛 query、展开、收起、重试与来源', async () => {
    vi.useFakeTimers();
    const { wrapper } = mountPalette();
    await vi.advanceTimersByTimeAsync(0);
    expect(wrapper.emitted('ask-query')).toEqual([['']]);
    const results = wrapper.get('.palette-results');
    expect(results.element.firstElementChild?.classList.contains('ai-answer-row')).toBe(true);
    const input = wrapper.get('input');
    await input.setValue('响应式区别');
    expect(wrapper.emitted('ask-query')?.at(-1)).toEqual(['响应式区别']);
    await wrapper.get('.is-result').trigger('click');
    expect(wrapper.emitted('ask-expand')).toEqual([[]]);
    await wrapper.setProps({ askExpanded: true });
    await button(wrapper, '[1] 真实本地标题').trigger('click');
    expect(wrapper.emitted('open-note')).toEqual([['real-note-1']]);
    await button(wrapper, '收起').trigger('click');
    expect(wrapper.emitted('ask-collapse')).toEqual([[]]);
    await wrapper.setProps({ askPhase: 'error', askError: 'AI 网络失败' });
    await wrapper.get('.is-error .btn-ghost').trigger('click');
    expect(wrapper.emitted('ask-retry')).toEqual([[]]);
    await vi.advanceTimersByTimeAsync(120);
    expect(wrapper.findAll('[role="option"]')).toHaveLength(2);
  });

  it('方向键和 Enter 始终只选择普通 hits，AI 摘要不占索引', async () => {
    vi.useFakeTimers();
    const { wrapper } = mountPalette();
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
    for (const result of wrapper.findAll('[role="option"]')) {
      const element = result.element;
      if (!(element instanceof HTMLElement)) throw new Error('搜索结果必须是 HTML 元素');
      element.scrollIntoView = vi.fn();
    }
    const input = wrapper.get('input');
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.get('[aria-selected="true"]').text()).toContain('second');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('open')).toEqual([[hits[1]]]);
    expect(wrapper.emitted('ask-expand')).toBeUndefined();
    expect(wrapper.emitted('open-note')).toBeUndefined();
  });
});
