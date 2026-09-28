/**
 * 列表呈现偏好：随手记的三种植排与按时间分段的粒度、知识归纳列表的排列方式、
 * 归纳详情的呈现方式与顺序。与外观偏好同一做法：只影响界面，存在本机，不进 SQLite；
 * 读到未知值或读写失败时退回默认呈现（即改版前的卡片网格），不阻塞页面。
 */
export const NOTES_LAYOUTS = [
  { value: 'grid', label: '网格' },
  { value: 'stream', label: '阅读流' },
  { value: 'timeline', label: '按时间' },
] as const;
export type NotesLayout = (typeof NOTES_LAYOUTS)[number]['value'];

/** 按时间分段的粒度：最近一周逐日、更早按月合并；或一律逐日。 */
export const TIMELINE_GRAINS = [
  { value: 'recent-days', label: '最近优先' },
  { value: 'days', label: '一律按天' },
] as const;
export type TimelineGrain = (typeof TIMELINE_GRAINS)[number]['value'];

export const TOPICS_LAYOUTS = [
  { value: 'cards', label: '卡片' },
  { value: 'toc', label: '目录' },
] as const;
export type TopicsLayout = (typeof TOPICS_LAYOUTS)[number]['value'];

/** 归纳详情的呈现方式：连读（收录的手记连成一篇文档）或网格卡片。 */
export const TOPIC_DETAIL_LAYOUTS = [
  { value: 'doc', label: '连读' },
  { value: 'grid', label: '网格' },
] as const;
export type TopicDetailLayout = (typeof TOPIC_DETAIL_LAYOUTS)[number]['value'];

/** 归纳详情的顺序：默认最新在前；「最早在前」适合从头读一遍。 */
export const TOPIC_DETAIL_ORDERS = [
  { value: 'desc', label: '最新在前' },
  { value: 'asc', label: '最早在前' },
] as const;
export type TopicDetailOrder = (typeof TOPIC_DETAIL_ORDERS)[number]['value'];

const NOTES_LAYOUT_KEY = 'memocraft-notes-layout';
const TIMELINE_GRAIN_KEY = 'memocraft-timeline-grain';
const TOPICS_LAYOUT_KEY = 'memocraft-topics-layout';
const TOPIC_DETAIL_LAYOUT_KEY = 'memocraft-topic-detail-layout';
const TOPIC_DETAIL_ORDER_KEY = 'memocraft-topic-detail-order';

/** 只接受选项表里的值，其余一律退回 fallback。 */
function readChoice<T extends string>(
  key: string,
  options: readonly { value: T }[],
  fallback: T,
): T {
  try {
    const stored = localStorage.getItem(key);
    return options.find((option) => option.value === stored)?.value ?? fallback;
  } catch {
    // 读取失败按默认呈现处理。
    return fallback;
  }
}

/** 写入失败返回 false，由调用方提示「已切换但未能保存」。 */
function writeChoice(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const readNotesLayout = (): NotesLayout =>
  readChoice(NOTES_LAYOUT_KEY, NOTES_LAYOUTS, 'grid');
export const writeNotesLayout = (value: NotesLayout): boolean =>
  writeChoice(NOTES_LAYOUT_KEY, value);
export const readTimelineGrain = (): TimelineGrain =>
  readChoice(TIMELINE_GRAIN_KEY, TIMELINE_GRAINS, 'recent-days');
export const writeTimelineGrain = (value: TimelineGrain): boolean =>
  writeChoice(TIMELINE_GRAIN_KEY, value);
export const readTopicsLayout = (): TopicsLayout =>
  readChoice(TOPICS_LAYOUT_KEY, TOPICS_LAYOUTS, 'cards');
export const writeTopicsLayout = (value: TopicsLayout): boolean =>
  writeChoice(TOPICS_LAYOUT_KEY, value);
export const readTopicDetailLayout = (): TopicDetailLayout =>
  readChoice(TOPIC_DETAIL_LAYOUT_KEY, TOPIC_DETAIL_LAYOUTS, 'doc');
export const writeTopicDetailLayout = (value: TopicDetailLayout): boolean =>
  writeChoice(TOPIC_DETAIL_LAYOUT_KEY, value);
export const readTopicDetailOrder = (): TopicDetailOrder =>
  readChoice(TOPIC_DETAIL_ORDER_KEY, TOPIC_DETAIL_ORDERS, 'desc');
export const writeTopicDetailOrder = (value: TopicDetailOrder): boolean =>
  writeChoice(TOPIC_DETAIL_ORDER_KEY, value);
