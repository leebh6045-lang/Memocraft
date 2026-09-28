// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import NoteStreamCard from '../../src/renderer/src/components/NoteStreamCard.vue';
import type { Note } from '../../src/domain/note';
import type { NoteImageSummary } from '../../src/domain/note-image';

const NOTE: Note = {
  id: '11111111-1111-4111-8111-111111111111',
  title: '查询计划怎么看',
  body: '先用 EXPLAIN QUERY PLAN 看有没有走索引。',
  category: 'insight',
  tags: ['涨知识'],
  revision: 1,
  createdAt: '2026-09-27T14:52:00.000Z',
  updatedAt: '2026-09-27T14:52:00.000Z',
};

function image(index: number, displayName = ''): NoteImageSummary {
  return {
    id: `2222222${index}-2222-4222-8222-22222222222${index}`,
    displayName,
    originalName: `shot-${index}.png`,
    width: 240,
    height: 168,
  };
}

let wrapper: VueWrapper | undefined;

function mountCard(props: Record<string, unknown> = {}) {
  wrapper = mount(NoteStreamCard, { props: { note: NOTE, ...props } });
  return wrapper;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
});

describe('阅读流卡片', () => {
  it('没有附图时不渲染缩略图区，也不写张数', () => {
    const card = mountCard();
    expect(card.find('.stream-images').exists()).toBe(false);
    expect(card.find('.stream-meta').text()).not.toContain('张图');
  });

  it('有附图时写出张数，最多露出三张，其余只报数量', () => {
    const card = mountCard({ images: [image(1), image(2), image(3), image(4), image(5)] });
    expect(card.find('.stream-meta').text()).toContain('5 张图');
    expect(card.findAll('.stream-images img')).toHaveLength(3);
    expect(card.find('.image-more').text()).toBe('+2');
  });

  it('缩略图按图片 ID 走自定义协议，懒加载并按规则给出可读名称', () => {
    const card = mountCard({ images: [image(1, '查询计划'), image(2)] });
    const images = card.findAll('.stream-images img');
    expect(images[0]?.attributes('src')).toBe(`memocraft-image://image/${image(1).id}`);
    expect(images[0]?.attributes('alt')).toBe('查询计划');
    expect(images[1]?.attributes('alt')).toBe('shot-2.png');
    expect(images[0]?.attributes('loading')).toBe('lazy');
  });

  it('没填标题时标题取正文首行，正文不再重复这一行', () => {
    const card = mountCard({
      note: { ...NOTE, title: '', body: '首行当标题\n第二行是正文' },
    });
    expect(card.find('.stream-title').text()).toBe('首行当标题');
    expect(card.find('.stream-body').text()).toBe('第二行是正文');
  });

  it('点卡片打开手记，但正在拖选正文时不打开', async () => {
    const card = mountCard();
    await card.trigger('click');
    expect(card.emitted('open')).toEqual([[NOTE.id]]);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '选中的正文',
    } as unknown as Selection);
    await card.trigger('click');
    expect(card.emitted('open')).toHaveLength(1);
  });
});
