// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { periodRange, shiftPeriod } from '../../src/domain/time-range';
import type { AiPeriodSummary } from '../../src/shared/ai';
import type { ReviewState } from '../../src/renderer/src/composables/useReview';
import ReviewPage from '../../src/renderer/src/pages/ReviewPage.vue';

const summary: AiPeriodSummary = {
  periodType: 'week',
  startDate: '2026-10-05',
  endDate: '2026-10-11',
  summary: '本周记录了响应式状态和组件边界。',
  suggestions: ['可以收录到 Vue 归纳。', '逐条确认超过 7 天的待办。'],
  noteCount: 3,
  generatedAt: '2026-10-11T04:00:00.000Z',
};

/** 页面只消费父层状态，生成与取消行为由 composable 测试验证。 */
function makeState(): ReviewState {
  const state: ReviewState = {
    phase: ref('ready'),
    periodType: ref('week'),
    startDate: ref(summary.startDate),
    endDate: ref(summary.endDate),
    summary: ref({ ...summary }),
    error: ref(''),
    errorCode: ref(null),
    canGoNext: ref(false),
    availablePeriods: computed(() => {
      const type = state.periodType.value;
      let range = periodRange(type, '2026-10-11');
      return Array.from({ length: 12 }, (_, index) => {
        const option = {
          startDate: range.startDate,
          label: type === 'week' ? `周 ${range.startDate}` : `月 ${range.startDate}`,
          isCurrent: index === 0,
        };
        if (index < 11) range = shiftPeriod(type, range.startDate, -1);
        return option;
      });
    }),
    busy: ref(false),
    load: vi.fn(async () => undefined),
    setPeriodType: vi.fn((type) => {
      const range = periodRange(type, '2026-10-11');
      state.periodType.value = type;
      state.startDate.value = range.startDate;
      state.endDate.value = range.endDate;
    }),
    prevPeriod: vi.fn(),
    nextPeriod: vi.fn(),
    jumpToPeriod: vi.fn((date) => {
      const range = periodRange(state.periodType.value, date);
      state.startDate.value = range.startDate;
      state.endDate.value = range.endDate;
    }),
    regenerate: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(async () => undefined),
    reset: vi.fn(),
  };
  return state;
}

const wrappers: VueWrapper[] = [];
function render(state = makeState(), busy = false) {
  const wrapper = mount(ReviewPage, { props: { state, busy }, attachTo: document.body });
  wrappers.push(wrapper);
  return { wrapper, state };
}

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('回顾页面', () => {
  it('兼容已有段落摘要，展示周期、建议与生成时间并提供重生成入口', async () => {
    const { wrapper, state } = render();
    expect(wrapper.get('h1').text()).toBe('回顾');
    expect(wrapper.get('h1').attributes('tabindex')).toBe('-1');
    expect(wrapper.get('.period-label').text()).toBe('2026年第41周（10月5日–10月11日）');
    expect(wrapper.get('.period-trigger').attributes('aria-label')).toBe(
      '选择回顾时间段：2026年第41周（10月5日–10月11日）',
    );
    expect(wrapper.find('.period-count').exists()).toBe(false);
    expect(wrapper.find('.review-card').exists()).toBe(false);
    expect(wrapper.findAll('.review-section-title').map((item) => item.text())).toEqual([
      '总结',
      '推荐',
    ]);
    expect(wrapper.get('.summary-text').text()).toBe(summary.summary);
    expect(wrapper.findAll('.review-suggestions li').map((item) => item.text())).toEqual(
      summary.suggestions,
    );
    expect(wrapper.get('time').attributes('datetime')).toBe(summary.generatedAt);
    expect(wrapper.get('.summary-meta').text()).toContain('上次生成于');
    expect(wrapper.get('.summary-meta').text()).toContain('覆盖 3 条手记');
    expect(
      wrapper
        .get('.summary-meta')
        .element.compareDocumentPosition(wrapper.get('.review-suggestions').element) &
        Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();
    await wrapper.get('.summary-meta button').trigger('click');
    expect(state.regenerate).toHaveBeenCalledTimes(1);
    state.summary.value = { ...summary, summary: '<img src=x onerror=alert(1)>', suggestions: [] };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.summary-text img').exists()).toBe(false);
    expect(wrapper.get('.summary-text').text()).toContain('<img');
    expect(wrapper.find('.review-suggestions').exists()).toBe(false);
    expect(wrapper.findAll('.section-divider')).toHaveLength(1);
  });

  it('跨年自然周显示 ISO 所属年，不误用周期起点年份', () => {
    const state = makeState();
    state.startDate.value = '2025-12-29';
    state.endDate.value = '2026-01-04';
    state.canGoNext.value = true;
    const { wrapper } = render(state);
    expect(wrapper.get('.period-label').text()).toBe('2026年第1周（12月29日–1月4日）');
    expect(wrapper.find('.period-count').exists()).toBe(false);
  });

  it('标签使用 tablist 与 roving tabindex，左右键和 Home/End 同步激活焦点', async () => {
    const { wrapper, state } = render();
    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('回顾周期');
    const week = wrapper.get('#review-week-tab');
    const month = wrapper.get('#review-month-tab');
    expect(week.attributes('aria-selected')).toBe('true');
    expect(month.attributes('tabindex')).toBe('-1');
    expect(month.attributes('aria-controls')).toBe('review-period-panel');
    await week.trigger('keydown', { key: 'ArrowRight' });
    expect(state.setPeriodType).toHaveBeenLastCalledWith('month');
    expect(month.attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(month.element);
    expect(wrapper.get('.period-label').text()).toBe('2026年10月');
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('review-month-tab');
    await month.trigger('keydown', { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(week.element);
    await week.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(month.element);
    await month.trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(week.element);
  });

  it('生成时仍允许展开列表跳转与切换周/月，生成操作防止重复提交', async () => {
    const { wrapper, state } = render();
    expect(wrapper.find('.period-arrow').exists()).toBe(false);
    state.busy.value = true;
    await wrapper.vm.$nextTick();
    await wrapper.get('.period-trigger').trigger('click');
    await wrapper.get('[data-start-date="2026-09-28"]').trigger('click');
    expect(state.jumpToPeriod).toHaveBeenCalledWith('2026-09-28');
    expect(wrapper.get('.period-trigger').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(wrapper.get('.period-trigger').element);
    await wrapper.get('#review-month-tab').trigger('click');
    expect(state.setPeriodType).toHaveBeenCalledWith('month');
    expect(wrapper.get('.summary-meta button').attributes('disabled')).toBeDefined();
  });

  it('列表有 12 项、当前徽章与选中标记，方向键和 Home/End 移动焦点，Enter 选择', async () => {
    const { wrapper, state } = render();
    const trigger = wrapper.get('.period-trigger');
    expect(trigger.attributes('aria-haspopup')).toBe('listbox');
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    const list = wrapper.get('[role="listbox"]');
    expect(list.attributes('id')).toBe(trigger.attributes('aria-controls'));
    const options = list.findAll('[role="option"]');
    expect(options).toHaveLength(12);
    expect(options[0]?.attributes('aria-selected')).toBe('true');
    expect(options[0]?.text()).toContain('本周');
    expect(options[0]?.find('svg').exists()).toBe(true);
    expect(document.activeElement).toBe(options[0]?.element);
    await options[0]?.trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(options[11]?.element);
    await options[11]?.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[11]?.element);
    await options[11]?.trigger('keydown', { key: 'Home' });
    await options[0]?.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(options[0]?.element);
    await options[0]?.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(options[1]?.element);
    await options[1]?.trigger('keydown', { key: 'Enter' });
    expect(state.jumpToPeriod).toHaveBeenCalledWith('2026-09-28');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    expect(document.activeElement).toBe(wrapper.get('[role="option"]').element);
    expect(wrapper.get('[data-start-date="2026-09-28"]').attributes('aria-selected')).toBe('true');
    expect(wrapper.find('[data-start-date="2026-09-28"] svg').exists()).toBe(true);
  });

  it('Escape 和外点击关闭并归还焦点；Tab 离开时不抢焦点，合成输入不关闭', async () => {
    const { wrapper } = render();
    const trigger = wrapper.get('.period-trigger');
    await trigger.trigger('click');
    await wrapper.get('[role="option"]').trigger('keydown', { key: 'Escape', isComposing: true });
    expect(trigger.attributes('aria-expanded')).toBe('true');
    await wrapper.get('[role="option"]').trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    await wrapper.get('.period-backdrop').trigger('click');
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(wrapper.get('[role="option"]').element);
    (trigger.element as HTMLButtonElement).focus();
    await trigger.trigger('keydown', { key: 'Escape' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    const regenerate = wrapper.get<HTMLButtonElement>('.summary-meta button');
    regenerate.element.focus();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(document.activeElement).toBe(regenerate.element);
  });

  it('月列表使用本月徽章，周期或外壳状态改变后关闭旧菜单', async () => {
    const { wrapper, state } = render();
    await wrapper.get('.period-trigger').trigger('click');
    state.setPeriodType('month');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    await wrapper.get('.period-trigger').trigger('click');
    expect(wrapper.findAll('[role="option"]')).toHaveLength(12);
    expect(wrapper.get('.period-current').text()).toBe('本月');
    await wrapper.setProps({ busy: true });
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    expect(wrapper.get('.period-trigger').attributes('disabled')).toBeDefined();
    expect(state.jumpToPeriod).not.toHaveBeenCalled();
  });

  it('长正文与段落完整保留，建议仍以纯文本呈现', () => {
    const state = makeState();
    const text = `${'核心积累与具体分析。'.repeat(45)}\n\n其他方向如实带出。`;
    state.summary.value = { ...summary, summary: text, suggestions: ['<script>无效指令</script>'] };
    const { wrapper } = render(state);
    expect(wrapper.findAll('.summary-text p').map((paragraph) => paragraph.text())).toEqual(
      text.split('\n\n'),
    );
    expect(wrapper.find('.review-suggestions script').exists()).toBe(false);
    expect(wrapper.get('.review-suggestions li').text()).toBe('<script>无效指令</script>');
    expect(wrapper.get('.review-content').attributes('aria-live')).toBe('polite');
  });

  it('按主题生成的概要展示为列表，保留核心首项与加粗短标题', () => {
    const state = makeState();
    state.summary.value = {
      ...summary,
      summary:
        '- **组件边界：核心积累**：明确输入与修改责任。记录对实际实现进行了深入分析。\n- **命令备忘**：另有 git status 的简短记录。',
    };
    const { wrapper } = render(state);
    const points = wrapper.findAll('.summary-text ul > li');
    expect(points).toHaveLength(2);
    expect(points[0]?.get('strong').text()).toBe('组件边界：核心积累');
    expect(points[0]?.text()).toContain('记录对实际实现进行了深入分析。');
    expect(points[1]?.get('strong').text()).toBe('命令备忘');
    expect(points[0]?.text().length).toBeGreaterThan(points[1]?.text().length ?? 0);
    expect(wrapper.find('.summary-text ol').exists()).toBe(false);
    expect(wrapper.get('.review-suggestions').element.tagName).toBe('UL');
  });

  it('概要格式化只显示文字与强调，恶意HTML、图片和链接不会变成可执行元素', () => {
    const state = makeState();
    state.summary.value = {
      ...summary,
      summary:
        '- **可见记录**：<img src=x onerror=alert(1)> <script>alert(1)</script> [链接](javascript:alert(1)) <https://example.invalid> ![图](https://example.invalid/image.png)\n- **其他记录**：正常文字。',
    };
    const { wrapper } = render(state);
    expect(wrapper.findAll('.summary-text ul > li')).toHaveLength(2);
    expect(wrapper.find('.summary-text img, .summary-text script, .summary-text a').exists()).toBe(
      false,
    );
    expect(wrapper.get('.summary-text').text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.get('.summary-text').text()).toContain('<script>alert(1)</script>');
    expect(wrapper.get('.summary-text').text()).toContain('[链接](javascript:alert(1))');
    expect(wrapper.get('.summary-text').text()).toContain('<https://example.invalid>');
  });

  it('loading 显示带状态语义的骨架；empty 和未配置没有骨架或加载行', async () => {
    const state = makeState();
    state.phase.value = 'loading';
    state.summary.value = null;
    state.busy.value = true;
    const { wrapper } = render(state);
    expect(wrapper.get('[role="status"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.get('[role="status"]').attributes('aria-label')).toBe('正在生成回顾');
    expect(wrapper.findAll('.skeleton-line')).toHaveLength(3);
    expect(wrapper.find('.skeleton-card').exists()).toBe(false);
    expect(wrapper.get('.review-section-title').text()).toBe('总结');
    state.phase.value = 'empty';
    state.busy.value = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('这段时间没有新手记。');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('.period-count').exists()).toBe(false);
    state.phase.value = 'error';
    state.errorCode.value = 'AI_NOT_CONFIGURED';
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('请先在设置页配置 DeepSeek API Key');
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('正在生成');
    await wrapper.get('.review-notice button').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([['settings']]);
  });

  it('刷新失败展示错误与重试，同时保留旧摘要和时间', async () => {
    const state = makeState();
    state.phase.value = 'error';
    state.errorCode.value = 'AI_NETWORK';
    state.error.value = '网络连接失败，请重试。';
    const { wrapper } = render(state);
    expect(wrapper.get('[role="alert"]').text()).toContain(state.error.value);
    expect(wrapper.text()).toContain('以下保留上次生成的回顾。');
    expect(wrapper.get('.summary-text').text()).toBe(summary.summary);
    expect(wrapper.get('time').attributes('datetime')).toBe(summary.generatedAt);
    await wrapper.get('.review-error button').trigger('click');
    expect(state.retry).toHaveBeenCalledTimes(1);
    state.busy.value = true;
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.review-error button').attributes('disabled')).toBeDefined();
  });

  it('当次图片跳过与 Pro 文字降级提示可见，缓存没有图片字段就不保留旧回执', async () => {
    const state = makeState();
    state.summary.value = { ...summary, usedImages: 4, skippedImages: 2, imagesSupported: true };
    const { wrapper } = render(state);
    expect(wrapper.get('.review-image-receipt').text()).toBe('有 2 张图片未参与本次回顾。');
    state.summary.value = { ...summary, usedImages: 0, skippedImages: 3, imagesSupported: false };
    await wrapper.vm.$nextTick();
    expect(wrapper.get('.review-image-receipt').text()).toContain('当前模型不支持图片');
    state.summary.value = { ...summary, usedImages: 0, skippedImages: 0, imagesSupported: false };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.review-image-receipt').exists()).toBe(false);
    state.summary.value = { ...summary };
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.review-image-receipt').exists()).toBe(false);
  });

  it('外壳 busy 禁止周期、设置及重试操作；页面卸载保留父层现场与取消权限', async () => {
    const state = makeState();
    state.phase.value = 'error';
    state.errorCode.value = 'AI_NOT_CONFIGURED';
    const { wrapper } = render(state, true);
    for (const item of wrapper.findAll('button')) expect(item.attributes('disabled')).toBeDefined();
    await wrapper.get('#review-week-tab').trigger('keydown', { key: 'ArrowRight' });
    expect(state.setPeriodType).not.toHaveBeenCalled();
    wrapper.unmount();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.summary.value).toEqual(summary);
  });

  it('旧页面过渡卸载不会取消父层快速返回后启动的新请求', () => {
    const { wrapper, state } = render();
    state.phase.value = 'loading';
    state.summary.value = null;
    state.busy.value = true;
    wrapper.unmount();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.reset).not.toHaveBeenCalled();
    expect(state.busy.value).toBe(true);
  });
});
