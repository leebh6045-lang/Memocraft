/** 搜索覆盖四类对象：手记、归纳、事务、动态。 */
export type SearchKind = 'note' | 'topic' | 'thread' | 'entry';

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  note: '手记',
  topic: '归纳',
  thread: '事务',
  entry: '动态',
};

/** 浮层里最多显示多少条结果，以及空查询时每类展示多少条最近内容。 */
export const SEARCH_PAGE_SIZE = 50;
export const SEARCH_RECENT_PER_KIND = 5;

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** 主行文字：手记与动态用标题或首行，归纳与事务用标题。 */
  title: string;
  /** 命中处的上下文摘要；命中标题时可能为空。 */
  excerpt: string;
  /** 次要文字：手记是分类，事务是状态，动态是所属事务，归纳留空。 */
  context: string;
  /** 动态与事务的所属事务；手记与归纳为 null。 */
  threadId: string | null;
  threadTitle: string | null;
  /** 最近更新时间的 ISO 文本，用于排序与展示。 */
  at: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** 结果被截断时为真，界面据此提示补充关键词。 */
  hasMore: boolean;
}
