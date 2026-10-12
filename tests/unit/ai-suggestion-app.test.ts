// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils';
import { randomUUID } from 'node:crypto';
import App from '../../src/renderer/src/App.vue';
import HomePage from '../../src/renderer/src/pages/HomePage.vue';
import NotesPage from '../../src/renderer/src/pages/NotesPage.vue';
import TopicsPage from '../../src/renderer/src/pages/TopicsPage.vue';
import NoteImageGallery from '../../src/renderer/src/components/NoteImageGallery.vue';
import ToastStack from '../../src/renderer/src/components/ToastStack.vue';
import type { ToastItem } from '../../src/renderer/src/composables/useToasts';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import {
  emptyDraft,
  NOTE_MAX_TAGS,
  type LibrarySnapshot,
  type NoteDraft,
} from '../../src/domain/note';
import type { NoteImage } from '../../src/domain/note-image';
import type { TopicSummary } from '../../src/domain/topic';
import type { AiSuggestion } from '../../src/shared/ai';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 真实 App 的页面事件配合独立桥接替身，观察父子接线与用户操作后的可见现场。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟请求尚未初始化');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('延迟请求尚未初始化');
  };
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const topic: TopicSummary = {
  id: randomUUID(),
  title: '学习方法',
  description: '',
  revision: 1,
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  noteIds: [],
};
const suggestion: AiSuggestion = {
  usedImages: 0,
  skippedImages: 0,
  imagesSupported: true,
  tags: ['已有标签', '新标签'],
  topics: [{ id: topic.id, title: topic.title }],
};
let wrapper: VueWrapper | undefined;
let originalBridge: PropertyDescriptor | undefined;

type ObservedDraft = Pick<NoteDraft, 'body' | 'tags' | 'revision'>;
type ObservedToast = Pick<ToastItem, 'id' | 'message'>;

function isObservedDraft(value: unknown): value is ObservedDraft {
  if (typeof value !== 'object' || value === null) return false;
  if (!('revision' in value) || !('body' in value) || !('tags' in value)) return false;
  return (
    typeof value.revision === 'number' &&
    typeof value.body === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.every((tag: unknown) => typeof tag === 'string')
  );
}

// 普通 tsc 不解析 Vue SFC 的 props；读取前校验本测试实际观察的字段。
function observedDraft(value: unknown): ObservedDraft {
  if (!isObservedDraft(value)) throw new Error('首页未提供有效草稿属性');
  return value;
}

function isObservedToasts(value: unknown): value is ObservedToast[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'id' in item &&
        typeof item.id === 'number' &&
        'message' in item &&
        typeof item.message === 'string',
    )
  );
}

function observedToasts(value: unknown): ObservedToast[] {
  if (!isObservedToasts(value)) throw new Error('提示条属性格式不正确');
  return value;
}

async function setup(tags: string[] = ['已有标签'], imageCount = 0) {
  const initialDraft: NoteDraft = { ...emptyDraft(randomUUID()), body: '学习相关正文', tags };
  const images: NoteImage[] = Array.from({ length: imageCount }, (_, position) => {
    const id = randomUUID();
    return {
      id,
      draftId: initialDraft.id,
      noteId: null,
      relativePath: `attachments/${id}.png`,
      mimeType: 'image/png',
      byteSize: 100,
      width: 100,
      height: 100,
      displayName: '',
      originalName: `图片${position + 1}.png`,
      position,
      createdAt: '2026-10-10T10:00:00.000Z',
    };
  });
  const expectedSuggestion: AiSuggestion = {
    ...suggestion,
    usedImages: Math.min(imageCount, 4),
    skippedImages: Math.max(0, imageCount - 4),
  };
  const bridge: MemocraftApi = {
    ...disconnectedApi,
    ai: {
      ...disconnectedApi.ai,
      suggest: vi.fn(async () => success(expectedSuggestion)),
      cancelSuggestion: vi.fn(async () => success(null)),
    },
    load: vi.fn(async () => success<LibrarySnapshot>({ draft: initialDraft, notes: [] })),
    saveDraft: vi.fn(async (draft: NoteDraft) => success({ ...draft, tags: [...draft.tags] })),
    loadTopics: vi.fn(async () => success([topic])),
    loadImages: vi.fn(async () => success({ images, totalBytes: images.length * 100 })),
    deleteImage: vi.fn(async () => success({ images: [], totalBytes: 0 })),
  };
  Object.defineProperty(window, 'memocraft', { value: bridge, configurable: true });
  // 带图场景保留真实首页，由其归属监听加载图集；其余页面仍使用替身。
  wrapper = shallowMount(App, { global: { stubs: { HomePage: imageCount === 0 } } });
  await flushPromises();
  const home = wrapper.getComponent(HomePage);
  home.vm.$emit('suggest');
  await flushPromises();
  expect(home.props('suggestionPhase')).toBe('ready');
  return { app: wrapper, home, bridge, initialDraft, images, expectedSuggestion };
}

function nav(app: VueWrapper, label: string) {
  const button = app.findAll('nav button').find((item) => item.find('.label').text() === label);
  if (!button) throw new Error(`没有找到导航：${label}`);
  return button;
}

beforeEach(() => {
  originalBridge = Object.getOwnPropertyDescriptor(window, 'memocraft');
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('首页 AI 建议接线与导航', () => {
  it('请求携带完整草稿图集和归属，超过四张时交由主进程裁剪', async () => {
    const { home, bridge, initialDraft, images, expectedSuggestion } = await setup(['已有标签'], 6);
    expect(bridge.ai.suggest).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: initialDraft.id,
        imageIds: images.map((image) => image.id),
      }),
    );
    expect(home.props('suggestionResult')).toEqual(expectedSuggestion);
    expect(home.props('suggestionResult')).toMatchObject({ usedImages: 4, skippedImages: 2 });
  });

  it('移出草稿图片后保留旧建议并标记过期，不自动重发请求', async () => {
    const { home, bridge, images } = await setup(['已有标签'], 2);
    const removed = images[1];
    if (!removed) throw new Error('测试草稿需要两张图片');
    vi.mocked(bridge.deleteImage).mockResolvedValueOnce(
      success({ images: images.slice(0, 1), totalBytes: 100 }),
    );
    expect(home.props('suggestionStale')).toBe(false);
    home.getComponent(NoteImageGallery).vm.$emit('remove', removed.id);
    await flushPromises();
    expect(bridge.deleteImage).toHaveBeenCalledWith(removed.id);
    expect(home.props('suggestionPhase')).toBe('ready');
    expect(home.props('suggestionStale')).toBe(true);
    expect(bridge.ai.suggest).toHaveBeenCalledTimes(1);
  });

  it('采纳只追加草稿标签；归纳跳转先保存草稿，再给详情发送打开意图', async () => {
    const { app, home, bridge } = await setup();
    home.vm.$emit('apply-tag', '新标签');
    await flushPromises();
    expect(observedDraft(home.props('draft')).tags).toEqual(['已有标签', '新标签']);
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    expect(bridge.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ body: '学习相关正文', tags: ['已有标签', '新标签'] }),
    );
    expect(app.getComponent(TopicsPage).props('openSignal')).toEqual({ id: topic.id, nonce: 1 });
    expect(app.findComponent(HomePage).exists()).toBe(false);
  });

  it('保存失败保持首页和建议，之后手动导航不携带上次失败的归纳打开意图', async () => {
    const { app, home, bridge } = await setup();
    home.vm.$emit('change', { body: '修改后的未保存正文' });
    vi.mocked(bridge.saveDraft).mockResolvedValueOnce({
      ok: false,
      error: { code: 'STORAGE', message: '保存失败，内容仍保留。' },
    });
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    expect(app.findComponent(HomePage).exists()).toBe(true);
    expect(app.findComponent(TopicsPage).exists()).toBe(false);
    expect(observedDraft(home.props('draft')).body).toBe('修改后的未保存正文');
    expect(home.props('suggestionPhase')).toBe('ready');
    expect(app.text()).toContain('保存未完成，已留在当前页面');
    await nav(app, '知识归纳').trigger('click');
    await flushPromises();
    expect(app.getComponent(TopicsPage).props('openSignal')).toBeNull();
  });

  it('100 个标签时拒绝新采纳并提示，移除一个后可以正常采纳且保持容量', async () => {
    const tags = Array.from({ length: NOTE_MAX_TAGS }, (_, index) => `标签${index}`);
    const { app, home, bridge } = await setup(tags);
    home.vm.$emit('apply-tag', '新标签');
    await flushPromises();
    expect(observedDraft(home.props('draft')).tags).toEqual(tags);
    expect(observedDraft(home.props('draft')).revision).toBe(0);
    expect(bridge.saveDraft).not.toHaveBeenCalled();
    expect(observedToasts(app.getComponent(ToastStack).props('toasts'))).toContainEqual(
      expect.objectContaining({ message: '草稿已有 100 个标签，请先移除一个再采纳新标签。' }),
    );
    home.vm.$emit('change', { tags: tags.slice(0, -1) });
    home.vm.$emit('apply-tag', '新标签');
    await flushPromises();
    expect(observedDraft(home.props('draft')).tags).toHaveLength(NOTE_MAX_TAGS);
    expect(observedDraft(home.props('draft')).tags.at(-1)).toBe('新标签');
  });

  it('归纳查询挂起时用户切页，迟到查询不覆盖后来导航也不留下打开意图', async () => {
    const { app, home, bridge } = await setup();
    const lookup = deferred<Result<TopicSummary[]>>();
    vi.mocked(bridge.loadTopics).mockReturnValueOnce(lookup.promise);
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    await nav(app, '随手记').trigger('click');
    await flushPromises();
    expect(app.findComponent(NotesPage).exists()).toBe(true);
    lookup.resolve(success([topic]));
    await flushPromises();
    expect(app.findComponent(NotesPage).exists()).toBe(true);
    expect(app.findComponent(TopicsPage).exists()).toBe(false);
    await nav(app, '知识归纳').trigger('click');
    await flushPromises();
    expect(app.getComponent(TopicsPage).props('openSignal')).toBeNull();
  });

  it('归纳查询挂起时关闭卡片，迟到成功不再跳转', async () => {
    const { app, home, bridge } = await setup();
    const lookup = deferred<Result<TopicSummary[]>>();
    vi.mocked(bridge.loadTopics).mockReturnValueOnce(lookup.promise);
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    home.vm.$emit('close-suggestion');
    await flushPromises();
    expect(home.props('suggestionPhase')).toBe('idle');
    lookup.resolve(success([topic]));
    await flushPromises();
    expect(app.findComponent(HomePage).exists()).toBe(true);
    expect(app.findComponent(TopicsPage).exists()).toBe(false);
  });

  it('归纳查询桥接异常仅提示当前建议现场，关闭后的迟到失败不重新报警', async () => {
    const { app, home, bridge } = await setup();
    vi.mocked(bridge.loadTopics).mockRejectedValueOnce(new Error('private transport detail'));
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    expect(observedToasts(app.getComponent(ToastStack).props('toasts'))).toContainEqual(
      expect.objectContaining({ message: '归纳列表未能读取，请重试。' }),
    );
    const previousToasts = [...observedToasts(app.getComponent(ToastStack).props('toasts'))];
    const lookup = deferred<Result<TopicSummary[]>>();
    vi.mocked(bridge.loadTopics).mockReturnValueOnce(lookup.promise);
    home.vm.$emit('open-topic', topic.id);
    await flushPromises();
    home.vm.$emit('close-suggestion');
    await flushPromises();
    lookup.reject(new Error('late private transport detail'));
    await flushPromises();
    expect(observedToasts(app.getComponent(ToastStack).props('toasts'))).toEqual(previousToasts);
    expect(app.findComponent(HomePage).exists()).toBe(true);
  });
});
