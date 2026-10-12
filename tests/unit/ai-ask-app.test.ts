// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';
import { shallowMount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/src/App.vue';
import SearchPalette from '../../src/renderer/src/components/SearchPalette.vue';
import NoteDrawer from '../../src/renderer/src/components/NoteDrawer.vue';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import { emptyDraft, type LibrarySnapshot, type Note } from '../../src/domain/note';
import { DEFAULT_AI_BASE_URL, type AiAnswer, type AiSettings } from '../../src/shared/ai';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('等待对象尚未初始化');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
const note: Note = {
  ...emptyDraft(randomUUID()),
  revision: 1,
  body: 'ref 通过 value 访问。',
  title: 'Vue 手记',
  createdAt: '2026-10-10',
  updatedAt: '2026-10-10',
};
const answer: AiAnswer = {
  answer: 'ref 使用 value。',
  sources: [{ index: 1, noteId: note.id, title: note.title }],
  matchedNotes: 1,
};
const settings = (keyConfigured: boolean): AiSettings => ({
  provider: 'deepseek',
  model: 'deepseek-flash',
  baseUrl: DEFAULT_AI_BASE_URL,
  keyConfigured,
  encryptionAvailable: true,
});
let wrapper: VueWrapper | undefined;
let originalBridge: PropertyDescriptor | undefined;

/** App持有问答现场，真实子事件验证面板开关与配置读取之间的乱序隔离。 */
async function setup(keyConfigured = true, realPalette = false) {
  const bridge: MemocraftApi = {
    ...disconnectedApi,
    ai: {
      ...disconnectedApi.ai,
      loadSettings: vi.fn(async () => success(settings(keyConfigured))),
      ask: vi.fn(async () => success(answer)),
      cancelAsk: vi.fn(async () => success(null)),
    },
    load: vi.fn(async () =>
      success<LibrarySnapshot>({ draft: emptyDraft(randomUUID()), notes: [note] }),
    ),
    loadTopics: vi.fn(async () => success([])),
    loadThreads: vi.fn(async () => success([])),
    search: vi.fn(async () =>
      success({
        hits: [
          {
            kind: 'note' as const,
            id: note.id,
            title: note.title,
            excerpt: note.body,
            context: '收获',
            threadId: null,
            threadTitle: null,
            at: note.updatedAt,
          },
        ],
        hasMore: false,
      }),
    ),
  };
  Object.defineProperty(window, 'memocraft', { configurable: true, value: bridge });
  wrapper = shallowMount(App, { global: { stubs: { SearchPalette: !realPalette } } });
  await flushPromises();
  const app = wrapper;
  const button = app
    .findAll('.nav-tools button')
    .find((item) => item.find('.label').text() === '搜索');
  if (!button) throw new Error('搜索入口不存在');
  await button.trigger('click');
  await flushPromises();
  return { app, bridge, button, palette: app.getComponent(SearchPalette) };
}
async function advance(ms = 600) {
  await vi.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

beforeEach(() => {
  originalBridge = Object.getOwnPropertyDescriptor(window, 'memocraft');
  vi.useFakeTimers();
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
  if (originalBridge) Object.defineProperty(window, 'memocraft', originalBridge);
  else Reflect.deleteProperty(window, 'memocraft');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App搜索问答接线', () => {
  it('未配置整个面板周期均不加载或请求AI，原搜索可用', async () => {
    const { palette, bridge } = await setup(false, true);
    await palette.get('[role="combobox"]').setValue('reactive');
    expect(palette.props('askPhase')).toBe('idle');
    await advance(600);
    expect(palette.props('askPhase')).toBe('idle');
    expect(bridge.ai.ask).not.toHaveBeenCalled();
    expect(bridge.search).toHaveBeenCalledWith('reactive');
    expect(palette.get('[role="option"]').text()).toContain(note.title);
    expect(palette.find('.ai-answer-row').exists()).toBe(false);
    await palette.get('[role="combobox"]').setValue('ref reactive');
    await advance(1200);
    expect(bridge.ai.ask).not.toHaveBeenCalled();
    expect(bridge.ai.loadSettings).toHaveBeenCalledTimes(1);
  });
  it('配置读取迟到后采用当前问句；旧面板配置响应不能重启已关闭现场', async () => {
    const { app, bridge, button, palette } = await setup();
    palette.vm.$emit('close');
    await flushPromises();
    const pending = deferred<Result<AiSettings>>();
    vi.mocked(bridge.ai.loadSettings).mockReturnValueOnce(pending.promise);
    await button.trigger('click');
    await flushPromises();
    const newPalette = app.getComponent(SearchPalette);
    newPalette.vm.$emit('ask-query', '旧面板问题');
    await advance();
    expect(bridge.ai.ask).not.toHaveBeenCalled();
    newPalette.vm.$emit('close');
    await flushPromises();
    await button.trigger('click');
    await flushPromises();
    app.getComponent(SearchPalette).vm.$emit('ask-query', '新面板问题');
    await advance();
    expect(bridge.ai.ask).toHaveBeenCalledTimes(1);
    expect(bridge.ai.ask).toHaveBeenCalledWith(expect.objectContaining({ question: '新面板问题' }));
    pending.resolve(success(settings(true)));
    await flushPromises();
    await advance();
    expect(bridge.ai.ask).toHaveBeenCalledTimes(1);
  });
  it('合法来源打开对应手记并关闭面板，未知来源不能打开', async () => {
    const { app, bridge, palette } = await setup();
    palette.vm.$emit('ask-query', 'reactive');
    await advance();
    expect(bridge.ai.ask).toHaveBeenCalledTimes(1);
    palette.vm.$emit('open-note', 'unknown');
    await flushPromises();
    expect(app.findComponent(NoteDrawer).exists()).toBe(false);
    palette.vm.$emit('open-note', note.id);
    await flushPromises();
    expect(app.findComponent(SearchPalette).exists()).toBe(false);
    expect(app.getComponent(NoteDrawer).props('note')).toMatchObject({ id: note.id });
  });
  it('关闭在途面板取消请求，迟到失败不污染再次打开的新面板', async () => {
    const { app, bridge, palette, button } = await setup();
    const pending = deferred<Result<AiAnswer>>();
    vi.mocked(bridge.ai.ask).mockReturnValueOnce(pending.promise);
    palette.vm.$emit('ask-query', 'reactive');
    await advance();
    palette.vm.$emit('close');
    await flushPromises();
    expect(bridge.ai.cancelAsk).toHaveBeenCalledTimes(1);
    await button.trigger('click');
    await flushPromises();
    app.getComponent(SearchPalette).vm.$emit('ask-query', '最新问题');
    await advance();
    expect(app.getComponent(SearchPalette).props('askPhase')).toBe('ready');
    pending.resolve({ ok: false, error: { code: 'AI_NETWORK', message: '旧错误不可见' } });
    await flushPromises();
    expect(app.getComponent(SearchPalette).props('askPhase')).toBe('ready');
    expect(app.getComponent(SearchPalette).props('askError')).toBe('');
  });
});
