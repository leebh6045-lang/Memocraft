// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/src/App.vue';
import HomePage from '../../src/renderer/src/pages/HomePage.vue';
import ReviewPage from '../../src/renderer/src/pages/ReviewPage.vue';
import SettingsPage from '../../src/renderer/src/pages/SettingsPage.vue';
import TrashPage from '../../src/renderer/src/pages/TrashPage.vue';
import NoteDrawer from '../../src/renderer/src/components/NoteDrawer.vue';
import ToastStack from '../../src/renderer/src/components/ToastStack.vue';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import { emptyDraft, type Note } from '../../src/domain/note';
import { localToday, periodRange } from '../../src/domain/time-range';
import { DEFAULT_AI_BASE_URL, type AiPeriodSummary } from '../../src/shared/ai';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';
import type { ReviewState } from '../../src/renderer/src/composables/useReview';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('尚未初始化');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
let wrapper: VueWrapper | undefined;
let original: PropertyDescriptor | undefined;
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(window, 'memocraft');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
  localStorage.clear();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  if (original) Object.defineProperty(window, 'memocraft', original);
  else Reflect.deleteProperty(window, 'memocraft');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function setup(configured = true) {
  const now = new Date().toISOString();
  const note: Note = {
    ...emptyDraft(randomUUID()),
    body: '本期学习内容',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  const summary: AiPeriodSummary = {
    periodType: 'week',
    ...periodRange('week', localToday()),
    summary: '回顾内容',
    suggestions: [],
    noteCount: 1,
    generatedAt: now,
  };
  let closeRequested: () => void = () => undefined;
  const bridge: MemocraftApi = {
    ...disconnectedApi,
    ai: {
      ...disconnectedApi.ai,
      loadSettings: vi.fn(async () =>
        success({
          provider: 'deepseek' as const,
          model: 'deepseek-flash' as const,
          baseUrl: DEFAULT_AI_BASE_URL,
          keyConfigured: configured,
          encryptionAvailable: true,
        }),
      ),
      summarizePeriod: vi.fn(async () => success(summary)),
      cancelPeriodSummary: vi.fn(async () => success(null)),
    },
    load: vi.fn(async () => success({ draft: emptyDraft(randomUUID()), notes: [note] })),
    saveDraft: vi.fn(async (draft) => success(draft)),
    onCloseRequested: (callback) => {
      closeRequested = callback;
      return () => undefined;
    },
    closeReady: vi.fn(),
  };
  Object.defineProperty(window, 'memocraft', { configurable: true, value: bridge });
  wrapper = shallowMount(App);
  await flushPromises();
  return { app: wrapper, bridge, summary, note, close: () => closeRequested() };
}
// 普通 tsc 仅看到 Vue 文件入口声明；该 prop 的类型与正式页面契约一致。
function reviewState(app: VueWrapper): ReviewState {
  return app.getComponent(ReviewPage).props('state') as ReviewState;
}

async function navigate(app: VueWrapper, label: string) {
  const button = app.findAll('.nav-item').find((item) => item.find('.label').text() === label);
  if (!button) throw new Error(`缺少导航${label}`);
  await button.trigger('click');
  await flushPromises();
}

describe('回顾 App 接线与知识库生命周期', () => {
  it('只接受当前分点链接，打开真实手记抽屉并在关闭后保留回顾现场', async () => {
    const { app, summary, note, bridge } = await setup();
    summary.summary = '- **学习积累**：本期记录。';
    summary.pointSources = [[{ index: 1, noteId: note.id, title: '学习记录' }]];
    await navigate(app, '回顾');
    const page = app.getComponent(ReviewPage);
    page.vm.$emit('open-note', '不在当前来源里的ID');
    await flushPromises();
    expect(app.findComponent(NoteDrawer).exists()).toBe(false);
    page.vm.$emit('open-note', note.id);
    await flushPromises();
    expect(app.getComponent(NoteDrawer).props('note')).toMatchObject({
      id: note.id,
      body: note.body,
    });
    expect(app.findComponent(ReviewPage).exists()).toBe(true);
    app.getComponent(NoteDrawer).vm.$emit('close');
    await flushPromises();
    expect(app.findComponent(NoteDrawer).exists()).toBe(false);
    expect(reviewState(app).summary.value).toEqual(summary);
    expect(bridge.ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });

  it('旧引用已不在当前有效手记中时明确提示，不打开过期正文', async () => {
    const { app, summary } = await setup();
    summary.summary = '- **学习积累**：原有记录。';
    summary.pointSources = [[{ index: 1, noteId: '已删除手记', title: '旧标题' }]];
    await navigate(app, '回顾');
    app.getComponent(ReviewPage).vm.$emit('open-note', '已删除手记');
    await flushPromises();
    expect(app.findComponent(NoteDrawer).exists()).toBe(false);
    expect(app.getComponent(ToastStack).props('toasts')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '这条手记已不存在或已移到回收站。' }),
      ]),
    );
  });
  it('只首次进入触发；四个快捷导航仍在原位，切页回来保持现场不重复请求', async () => {
    const { app, bridge } = await setup();
    expect(bridge.ai.summarizePeriod).not.toHaveBeenCalled();
    expect(
      app
        .findAll('.nav-key')
        .slice(0, 4)
        .map((key) => key.text()),
    ).toEqual(['⌘1', '⌘2', '⌘3', '⌘4']);
    await navigate(app, '回顾');
    expect(reviewState(app).summary.value?.summary).toBe('回顾内容');
    await navigate(app, '首页');
    await navigate(app, '回顾');
    expect(bridge.ai.summarizePeriod).toHaveBeenCalledTimes(1);
    expect(document.title).toBe('Memocraft · 回顾');
  });
  it('未配置引导去设置后返回可生成', async () => {
    const { app, bridge } = await setup(false);
    await navigate(app, '回顾');
    expect(reviewState(app).errorCode.value).toBe('AI_NOT_CONFIGURED');
    app.getComponent(ReviewPage).vm.$emit('navigate', 'settings');
    await flushPromises();
    expect(app.findComponent(SettingsPage).exists()).toBe(true);
    expect(app.getComponent(SettingsPage).props('initialSection')).toBe('ai');
    vi.mocked(bridge.ai.loadSettings).mockResolvedValue(
      success({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: DEFAULT_AI_BASE_URL,
        keyConfigured: true,
        encryptionAvailable: true,
      }),
    );
    await navigate(app, '回顾');
    expect(bridge.ai.summarizePeriod).toHaveBeenCalledTimes(1);
  });
  it('草稿保存失败保留首页，不启动回顾', async () => {
    const { app, bridge } = await setup();
    vi.mocked(bridge.saveDraft).mockResolvedValue({
      ok: false,
      error: { code: 'STORAGE', message: '保存失败' },
    });
    app.getComponent(HomePage).vm.$emit('change', { body: '未保存的新内容' });
    await navigate(app, '回顾');
    expect(app.findComponent(HomePage).exists()).toBe(true);
    expect(bridge.ai.summarizePeriod).not.toHaveBeenCalled();
    expect(app.get('.app-banner').text()).toContain('已留在当前页面');
  });
  it('切页取消迟到应答，不覆盖重返页面的新结果', async () => {
    const { app, bridge, summary } = await setup();
    const pending = deferred<Result<AiPeriodSummary>>();
    vi.mocked(bridge.ai.summarizePeriod).mockReturnValueOnce(pending.promise);
    await navigate(app, '回顾');
    await navigate(app, '首页');
    await navigate(app, '回顾');
    expect(bridge.ai.cancelPeriodSummary).toHaveBeenCalledTimes(1);
    pending.resolve(success({ ...summary, summary: '已离开现场的内容' }));
    await flushPromises();
    expect(reviewState(app).summary.value?.summary).toBe('回顾内容');
  });
  it('整库替换清掉旧回顾；回收站恢复单条内容保留缓存现场', async () => {
    const { app, bridge, summary } = await setup();
    await navigate(app, '回顾');
    await app.get('.corner-btn[title="回收站"]').trigger('click');
    await flushPromises();
    app.getComponent(TrashPage).vm.$emit('restored');
    await flushPromises();
    await navigate(app, '回顾');
    expect(bridge.ai.summarizePeriod).toHaveBeenCalledTimes(1);
    await app.get('.corner-btn[title="设置"]').trigger('click');
    await flushPromises();
    app.getComponent(SettingsPage).vm.$emit('data-replaced');
    await flushPromises();
    vi.mocked(bridge.ai.summarizePeriod).mockResolvedValueOnce(
      success({ ...summary, summary: '恢复后的库' }),
    );
    await navigate(app, '回顾');
    expect(bridge.ai.summarizePeriod).toHaveBeenCalledTimes(2);
    expect(reviewState(app).summary.value?.summary).toBe('恢复后的库');
  });
  it('关闭先等待回顾取消回执和编辑保存，再发送 closeReady', async () => {
    const { app, bridge, close } = await setup();
    const pending = deferred<Result<AiPeriodSummary>>();
    const cancellation = deferred<Result<null>>();
    vi.mocked(bridge.ai.summarizePeriod).mockReturnValueOnce(pending.promise);
    vi.mocked(bridge.ai.cancelPeriodSummary).mockReturnValueOnce(cancellation.promise);
    await navigate(app, '回顾');
    close();
    await flushPromises();
    expect(bridge.closeReady).not.toHaveBeenCalled();
    cancellation.resolve(success(null));
    await flushPromises();
    expect(bridge.closeReady).toHaveBeenCalledTimes(1);
  });
});
