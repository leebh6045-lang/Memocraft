import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TIMELINE_GRAINS,
  readNotesLayout,
  readTimelineGrain,
  readTopicDetailLayout,
  readTopicDetailOrder,
  readTopicsLayout,
  writeNotesLayout,
  writeTimelineGrain,
  writeTopicDetailLayout,
  writeTopicDetailOrder,
  writeTopicsLayout,
} from '../../src/renderer/src/view-preferences';

/** 列表呈现偏好：默认是改版前的卡片网格，脏值与读写失败都退回默认。 */
describe('列表呈现偏好', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  it('默认网格、最近优先、归纳卡片、详情连读且最新在前', () => {
    expect(readNotesLayout()).toBe('grid');
    expect(readTimelineGrain()).toBe('recent-days');
    expect(readTopicsLayout()).toBe('cards');
    expect(readTopicDetailLayout()).toBe('doc');
    expect(readTopicDetailOrder()).toBe('desc');
  });

  it('分段方式只有两项，文案保持短，避免下拉框过宽', () => {
    expect(TIMELINE_GRAINS.map((option) => option.value)).toEqual(['recent-days', 'days']);
    expect(TIMELINE_GRAINS.map((option) => option.label)).toEqual(['最近优先', '一律按天']);
  });

  it('保存的选择原样读回，五项互不影响', () => {
    expect(writeNotesLayout('timeline')).toBe(true);
    expect(writeTimelineGrain('days')).toBe(true);
    expect(writeTopicsLayout('toc')).toBe(true);
    expect(writeTopicDetailLayout('grid')).toBe(true);
    expect(writeTopicDetailOrder('asc')).toBe(true);
    expect(readNotesLayout()).toBe('timeline');
    expect(readTimelineGrain()).toBe('days');
    expect(readTopicsLayout()).toBe('toc');
    expect(readTopicDetailLayout()).toBe('grid');
    expect(readTopicDetailOrder()).toBe('asc');
    expect(writeNotesLayout('stream')).toBe(true);
    expect(readNotesLayout()).toBe('stream');
    expect(readTopicsLayout()).toBe('toc');
    expect(readTopicDetailLayout()).toBe('grid');
  });

  it('未知取值退回默认，不把脏数据当成有效偏好', () => {
    store.set('memocraft-notes-layout', 'masonry');
    store.set('memocraft-timeline-grain', 'weeks');
    store.set('memocraft-topics-layout', 'shelf');
    store.set('memocraft-topic-detail-layout', 'timeline');
    store.set('memocraft-topic-detail-order', 'random');
    expect(readNotesLayout()).toBe('grid');
    expect(readTimelineGrain()).toBe('recent-days');
    expect(readTopicsLayout()).toBe('cards');
    expect(readTopicDetailLayout()).toBe('doc');
    expect(readTopicDetailOrder()).toBe('desc');
  });

  it('读取与写入失败都不抛出，只返回退路结果', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(readNotesLayout()).toBe('grid');
    expect(readTopicsLayout()).toBe('cards');
    expect(readTopicDetailLayout()).toBe('doc');
    expect(readTopicDetailOrder()).toBe('desc');
    expect(writeNotesLayout('timeline')).toBe(false);
    expect(writeTimelineGrain('days')).toBe(false);
    expect(writeTopicsLayout('toc')).toBe(false);
    expect(writeTopicDetailLayout('grid')).toBe(false);
    expect(writeTopicDetailOrder('asc')).toBe(false);
  });
});
