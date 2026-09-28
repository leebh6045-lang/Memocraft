// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import TopicReadingView from '../../src/renderer/src/components/TopicReadingView.vue';
import type { Note } from '../../src/domain/note';
import type { NoteImageIndex } from '../../src/domain/note-image';
import type { TopicSummary } from '../../src/domain/topic';

// jsdom 没有 matchMedia：组件只读取「减少动态」偏好，这里给一个明确的假实现。
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';
const UUID_IMAGE = '44444444-4444-4444-8444-444444444444';

function note(overrides: Partial<Note> & { id: string }): Note {
  const createdAt = '2026-09-27T14:52:00.000Z';
  return {
    title: '',
    body: `${overrides.id} 的正文`,
    category: 'insight',
    tags: [],
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function topic(id: string, title: string, noteIds: string[]): TopicSummary {
  return {
    id,
    title,
    description: '',
    revision: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    noteIds,
  };
}

const NOTES: Note[] = [
  note({ id: UUID_A, title: '关于依赖名称@符号解惑', tags: ['疑惑'], body: '正文一' }),
  note({ id: UUID_B, body: '首行被当作标题\n真正的正文', tags: [] }),
  note({ id: UUID_C, title: '检查代码常用的依赖', body: '正文三' }),
];
const TOPICS: TopicSummary[] = [
  topic(UUID_A, '一些关于命令行的解惑', [UUID_A, UUID_B]),
  topic(UUID_B, '学习方法', [UUID_B]),
];
const IMAGE_INDEX: NoteImageIndex = {
  [UUID_C]: [
    { id: UUID_IMAGE, displayName: 'lint 配置', originalName: 'lint.png', width: 240, height: 168 },
  ],
};

let wrapper: VueWrapper | undefined;

function mountView(notes: Note[] = NOTES) {
  wrapper = mount(TopicReadingView, {
    props: { topicId: UUID_A, notes, topics: TOPICS, imageIndex: IMAGE_INDEX },
  });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe('连读视图', () => {
  it('每条手记是一个带序号的小节，标题与正文来自同一条手记', async () => {
    const view = mountView();
    await flushPromises();
    const sections = view.findAll('.doc-sec');
    expect(sections).toHaveLength(3);
    expect(sections.map((section) => section.find('.doc-no').text())).toEqual(['01', '02', '03']);
    expect(sections[0]?.find('h2').text()).toContain('关于依赖名称@符号解惑');
    // 没填标题时用正文首行，正文不再重复这一行。
    expect(sections[1]?.find('h2').text()).toContain('首行被当作标题');
    expect(sections[1]?.find('.doc-body').text()).toBe('真正的正文');
  });

  it('右侧目录与小节一一对应，并始终只有一个当前项', async () => {
    const view = mountView();
    await flushPromises();
    const links = view.findAll('.doc-toc a');
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.find('.n').text())).toEqual(['01', '02', '03']);
    expect(links[0]?.attributes('href')).toBe(`#doc-${UUID_A}`);
    expect(view.findAll('.doc-toc a[aria-current="true"]')).toHaveLength(1);
  });

  it('附图按图片 ID 走自定义协议，名称进入可读文本', async () => {
    const view = mountView();
    await flushPromises();
    const image = view.find('.doc-imgs img');
    expect(image.attributes('src')).toBe(`memocraft-image://image/${UUID_IMAGE}`);
    expect(image.attributes('alt')).toBe('lint 配置');
    expect(image.attributes('loading')).toBe('lazy');
  });

  it('点小节的附图打开放大层，关闭后放大层消失', async () => {
    const view = mountView();
    await flushPromises();
    // 缩略图是可聚焦按钮；放大层挂在 body 上，因此从 document 查找。
    const thumb = view.find('.doc-thumb');
    expect(thumb.attributes('aria-label')).toBe('放大查看 lint 配置');
    await thumb.trigger('click');
    await flushPromises();
    const viewer = document.body.querySelector('.viewer');
    expect(viewer?.getAttribute('role')).toBe('dialog');
    expect(viewer?.querySelector('.viewer-image')?.getAttribute('src')).toBe(
      `memocraft-image://image/${UUID_IMAGE}`,
    );

    document.body.querySelector<HTMLButtonElement>('.viewer-close')?.click();
    await flushPromises();
    expect(document.body.querySelector('.viewer')).toBeNull();
  });

  it('小节动作发出打开与移出，移出只带手记 ID', async () => {
    const view = mountView();
    await flushPromises();
    const first = view.findAll('.doc-sec')[0];
    const buttons = first?.findAll('.doc-actions button') ?? [];
    await buttons[0]?.trigger('click');
    await buttons[1]?.trigger('click');
    expect(view.emitted('open')).toEqual([[UUID_A]]);
    expect(view.emitted('remove')).toEqual([[UUID_A]]);
  });

  it('另见列出还收录了这条手记的其他归纳，点击可跳转', async () => {
    const view = mountView();
    await flushPromises();
    const second = view.findAll('.doc-sec')[1];
    expect(second?.find('.doc-also').text()).toContain('学习方法');
    // 当前归纳自己不作为「另见」出现。
    expect(view.findAll('.doc-sec')[0]?.find('.doc-also').exists()).toBe(false);
    await second?.find('.doc-also button').trigger('click');
    expect(view.emitted('open-topic')).toEqual([[UUID_B]]);
  });

  it('手记换顺序后小节与目录同步，不保留旧顺序', async () => {
    const view = mountView();
    await flushPromises();
    await view.setProps({ notes: [...NOTES].reverse() });
    await nextTick();
    const titles = view.findAll('.doc-sec h2').map((heading) => heading.text());
    expect(titles[0]).toContain('检查代码常用的依赖');
    expect(view.findAll('.doc-toc a')[0]?.attributes('href')).toBe(`#doc-${UUID_C}`);
  });
});
