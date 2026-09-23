import type { Note } from './note';

/** 事务标题与手记标题同一上限；说明与概况是长文本，单独设上限。 */
export const THREAD_TITLE_MAX_LENGTH = 300;
export const THREAD_DESCRIPTION_MAX_LENGTH = 2000;
export const THREAD_SUMMARY_MAX_LENGTH = 4000;
export const ENTRY_SUMMARY_MAX_LENGTH = 300;
export const ENTRY_BODY_MAX_LENGTH = 20000;
/** 动态单次关联手记与事务单次关联手记的数量上限。 */
export const MAX_REFERENCE_BATCH = 200;

export type ThreadStatus = 'active' | 'archived';

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  active: '进行中',
  archived: '已归档',
};

export interface Thread {
  id: string;
  title: string;
  description: string;
  /** 当前概况：由用户维护，动态只记录历史。 */
  summary: string;
  status: ThreadStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 事务的列表形态。动态数量与直接关联的手记 ID 随列表一起返回，
 * 渲染端据此显示数量、判断归档筛选，不需要第二份索引。
 */
export interface ThreadSummary extends Thread {
  entryCount: number;
  /** 事务级直接引用（参考资料），按手记创建时间倒序。 */
  noteIds: string[];
}

export interface ThreadCreate {
  title: string;
  description: string;
  summary: string;
  confirmDuplicate: boolean;
}

export interface ThreadEdit {
  id: string;
  title: string;
  description: string;
  summary: string;
  /** 编辑所基于的已保存版本，防止覆盖其他更新。 */
  expectedRevision: number;
}

export interface Entry {
  id: string;
  threadId: string;
  /** 发生时间，可补录与修改；时间线按它排序。 */
  occurredAt: string;
  summary: string;
  body: string;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 动态的列表形态：带上它引用的手记 ID，详情与反查共用同一份数据。 */
export interface EntrySummary extends Entry {
  noteIds: string[];
}

export interface EntryCreate {
  threadId: string;
  occurredAt: string;
  summary: string;
  body: string;
  tags: string[];
  noteIds: string[];
}

/** 动态编辑：改描述、正文或发生时间都不改写被引用的手记。 */
export interface EntryEdit {
  id: string;
  occurredAt: string;
  summary: string;
  body: string;
  tags: string[];
  expectedRevision: number;
}

/** 事务详情：事务本身、时间线（按当前排序）与直接关联的手记。 */
export interface ThreadDetail {
  thread: ThreadSummary;
  entries: EntrySummary[];
  notes: Note[];
}

export type TimelineOrder = 'newest' | 'oldest';

/** 手记被引用的位置：事务级与动态级分开列出，便于界面提示影响范围。 */
export interface NoteReference {
  threadId: string;
  threadTitle: string;
  /** 动态级引用时给出所属动态；事务级引用为 null。 */
  entryId: string | null;
  entrySummary: string | null;
}

export function emptyThreadDraft(): ThreadCreate {
  return { title: '', description: '', summary: '', confirmDuplicate: false };
}
