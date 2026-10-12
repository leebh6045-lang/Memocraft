// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import AiSuggestionCard from '../../src/renderer/src/components/AiSuggestionCard.vue';
import type { AiSuggestion } from '../../src/shared/ai';
import type { SuggestionPhase } from '../../src/renderer/src/composables/useAiSuggestion';

let wrapper: VueWrapper | undefined;
const imageMetadata = { usedImages: 0, skippedImages: 0, imagesSupported: true };
const suggestion: AiSuggestion = {
  ...imageMetadata,
  tags: ['已有标签', '新标签'],
  topics: [{ id: 'topic-1', title: '学习与思考' }],
};

function mountCard(
  phase: SuggestionPhase,
  overrides: Partial<{
    suggestion: AiSuggestion | null;
    error: string;
    isStale: boolean;
    selectedTags: string[];
    busy: boolean;
  }> = {},
) {
  wrapper = mount(AiSuggestionCard, {
    props: {
      phase,
      suggestion,
      error: '',
      isStale: false,
      selectedTags: [],
      busy: false,
      ...overrides,
    },
  });
  return wrapper;
}

function button(card: VueWrapper, text: string) {
  const found = card.findAll('button').find((item) => item.text() === text);
  if (!found) throw new Error(`没有找到按钮：${text}`);
  return found;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe('AI 建议内联卡片', () => {
  it('idle 不展示现场；loading 显示阅读状态、隐私说明和关闭操作', async () => {
    const card = mountCard('idle');
    expect(card.find('section').exists()).toBe(false);
    await card.setProps({ phase: 'loading' });
    expect(card.get('section').attributes('aria-live')).toBe('polite');
    expect(card.get('.suggest-content').attributes('aria-busy')).toBe('true');
    expect(card.get('[role="status"]').text()).toBe('正在阅读这条手记…');
    expect(card.text()).toContain('正文前 800 字');
    expect(card.text()).toContain('会发送给 DeepSeek');
    expect(card.find('[role="dialog"]').exists()).toBe(false);
    expect(card.find('.chip').exists()).toBe(false);
    await card.get('[aria-label="关闭 AI 建议"]').trigger('click');
    expect(card.emitted('close')).toEqual([[]]);
  });

  it('成功显示标签与本地归纳标题，点击仅上抛采纳和跳转意图', async () => {
    const card = mountCard('ready');
    await button(card, '新标签').trigger('click');
    await button(card, '学习与思考→').trigger('click');
    expect(card.emitted('apply-tag')).toEqual([['新标签']]);
    expect(card.emitted('open-topic')).toEqual([['topic-1']]);
    expect(card.text()).toContain('可归入');
    expect(suggestion.tags).toEqual(['已有标签', '新标签']);
  });

  it('已有标签直接显示勾选且禁用，父级采纳后实时更新选中状态', async () => {
    const card = mountCard('ready', { selectedTags: ['已有标签'] });
    const selected = button(card, '已有标签');
    expect(selected.attributes('disabled')).toBeDefined();
    expect(selected.attributes('aria-pressed')).toBe('true');
    expect(selected.classes()).toContain('on');
    expect(selected.find('svg').exists()).toBe(true);
    await selected.trigger('click');
    expect(card.emitted('apply-tag')).toBeUndefined();
    await card.setProps({ selectedTags: ['已有标签', '新标签'] });
    expect(button(card, '新标签').attributes('disabled')).toBeDefined();
    expect(button(card, '新标签').find('svg').exists()).toBe(true);
  });

  it('没有匹配归纳时明确说明，标签空时也不伪装生成成功', async () => {
    const card = mountCard('ready', {
      suggestion: { ...imageMetadata, tags: ['标签'], topics: [] },
    });
    expect(card.text()).toContain('没有匹配的现有归纳');
    await card.setProps({
      suggestion: { ...imageMetadata, tags: [], topics: [{ id: 't', title: '归纳' }] },
    });
    expect(card.text()).toContain('没有合适的标签建议');
    expect(card.text()).toContain('归纳');
  });

  it('empty 明确显示无建议，正文变化时仍可重新生成', async () => {
    const card = mountCard('empty', {
      suggestion: { ...imageMetadata, tags: [], topics: [] },
      isStale: true,
    });
    expect(card.text()).toContain('没有找到合适的建议');
    expect(card.text()).toContain('正文或图片已修改，建议可能不再匹配');
    expect(card.find('.chip').exists()).toBe(false);
    await button(card, '重新生成').trigger('click');
    expect(card.emitted('retry')).toEqual([[]]);
  });

  it('ready 正文变化显示提示并提供重新生成', async () => {
    const card = mountCard('ready', { isStale: true });
    expect(card.text()).toContain('正文或图片已修改，建议可能不再匹配');
    await button(card, '重新生成').trigger('click');
    expect(card.emitted('retry')).toEqual([[]]);
    await card.setProps({ isStale: false });
    expect(card.find('.stale').exists()).toBe(false);
  });

  it('Flash 图片全部参与时不额外提示，隐私说明反映本次发送图片', () => {
    const card = mountCard('ready', { suggestion: { ...suggestion, usedImages: 2 } });
    expect(card.find('.image-feedback').exists()).toBe(false);
    expect(card.get('.privacy').text()).toContain('本次纳入图片会发送给 DeepSeek');
  });

  it('Pro 带图仅依据文字，空结果仍提示可切换到 Flash', async () => {
    const card = mountCard('ready', {
      suggestion: { ...suggestion, skippedImages: 3, imagesSupported: false },
    });
    expect(card.get('.image-feedback').text()).toBe(
      '当前模型不支持图片，建议仅依据文字；切换到 Flash 可让图片参与判断。',
    );
    expect(card.get('.privacy').text()).not.toContain('本次纳入图片');
    expect(card.text()).not.toContain('有 3 张图片未参与建议');
    await card.setProps({
      phase: 'empty',
      suggestion: { tags: [], topics: [], usedImages: 0, skippedImages: 3, imagesSupported: false },
    });
    expect(card.text()).toContain('没有找到合适的建议');
    expect(card.get('.image-feedback').text()).toContain('当前模型不支持图片');
  });

  it('Flash 图片部分或全部跳过时明确计数，空结果同样展示', async () => {
    const card = mountCard('ready', {
      suggestion: { ...suggestion, usedImages: 4, skippedImages: 2 },
    });
    expect(card.get('.image-feedback').text()).toBe('有 2 张图片未参与建议。');
    expect(card.get('.privacy').text()).toContain('本次纳入图片');
    await card.setProps({
      phase: 'empty',
      suggestion: { ...imageMetadata, tags: [], topics: [], skippedImages: 1 },
    });
    expect(card.get('.image-feedback').text()).toBe('有 1 张图片未参与建议。');
    expect(card.get('.privacy').text()).not.toContain('本次纳入图片');
  });

  it('无附图时不提示 Pro 降级，也不宣称图片被发送', () => {
    const card = mountCard('ready', {
      suggestion: { ...suggestion, imagesSupported: false },
    });
    expect(card.find('.image-feedback').exists()).toBe(false);
    expect(card.get('.privacy').text()).not.toContain('图片');
  });

  it('错误通过 alert 展示并由用户主动重试', async () => {
    const card = mountCard('error', { error: '余额不足，请充值后重试。' });
    expect(card.get('[role="alert"]').text()).toBe('余额不足，请充值后重试。');
    expect(card.find('.chip').exists()).toBe(false);
    expect(card.emitted('retry')).toBeUndefined();
    await button(card, '重试').trigger('click');
    expect(card.emitted('retry')).toEqual([[]]);
  });

  it('busy 禁止采纳、跳转和重新生成，仍可发出关闭意图', async () => {
    const card = mountCard('ready', { busy: true, isStale: true });
    for (const label of ['已有标签', '新标签', '学习与思考→', '重新生成']) {
      expect(button(card, label).attributes('disabled')).toBeDefined();
      await button(card, label).trigger('click');
    }
    expect(card.emitted('apply-tag')).toBeUndefined();
    expect(card.emitted('open-topic')).toBeUndefined();
    expect(card.emitted('retry')).toBeUndefined();
    await card.get('[aria-label="关闭 AI 建议"]').trigger('click');
    expect(card.emitted('close')).toEqual([[]]);
    await card.setProps({ phase: 'error', error: '网络失败' });
    expect(button(card, '重试').attributes('disabled')).toBeDefined();
  });

  it('标签及归纳标题按文本渲染，模型文字不能创建元素', () => {
    const unsafeText = '<img src=x onerror=alert(1)>';
    const card = mountCard('ready', {
      suggestion: {
        ...imageMetadata,
        tags: [unsafeText],
        topics: [{ id: 'topic-1', title: unsafeText }],
      },
    });
    expect(card.text()).toContain(unsafeText);
    expect(card.find('img').exists()).toBe(false);
  });
});
