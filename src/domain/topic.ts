import type { Note } from './note';

/** 标题与手记标题同一上限；说明是长文本，单独设上限。 */
export const TOPIC_TITLE_MAX_LENGTH = 300;
export const TOPIC_DESCRIPTION_MAX_LENGTH = 2000;
/** 单次收录上限：避免一个请求构造超大 IN 子句与超长事务；界面按此给出提示。 */
export const MAX_TOPIC_LINK_BATCH = 200;

export interface Topic {
  id: string;
  title: string;
  description: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 归纳的列表形态。收录的手记 ID 随列表一起返回，渲染端据此同时得到
 * 收录数量、「这条手记属于哪些归纳」和选择器的已收录状态，不需要第二份索引。
 */
export interface TopicSummary extends Topic {
  /** 当前收录的有效手记 ID，按手记创建时间倒序；已删除的手记不在此列。 */
  noteIds: string[];
}

/** 新建归纳；同名标题需要用户确认，确认后仍可创建（稳定 ID 才是标识）。 */
export interface TopicCreate {
  title: string;
  description: string;
  confirmDuplicate: boolean;
}

export interface TopicEdit {
  id: string;
  title: string;
  description: string;
  /** 编辑所基于的已保存版本，防止覆盖其他更新。 */
  expectedRevision: number;
}

/** 归纳详情：归纳本身加上它当前收录的有效手记，按手记创建时间倒序。 */
export interface TopicDetail {
  topic: TopicSummary;
  notes: Note[];
}

/** 空白归纳的初始值，供新建表单使用。 */
export function emptyTopicDraft(): TopicCreate {
  return { title: '', description: '', confirmDuplicate: false };
}
