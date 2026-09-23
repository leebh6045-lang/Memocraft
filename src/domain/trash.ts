/** 回收站里的四类对象：手记、归纳、事务、动态。 */
export type TrashKind = 'note' | 'topic' | 'thread' | 'entry';

export const TRASH_KIND_LABELS: Record<TrashKind, string> = {
  note: '手记',
  topic: '归纳',
  thread: '事务',
  entry: '动态',
};

export const TRASH_KINDS = Object.keys(TRASH_KIND_LABELS) as TrashKind[];

export interface TrashItem {
  kind: TrashKind;
  id: string;
  title: string;
  /** 来源上下文：原属哪个归纳或事务、含多少条动态，帮助用户认领内容。 */
  context: string;
  deletedAt: string;
}

/**
 * 删除前的影响面：逐条列出会发生什么、什么不受影响。
 * 界面必须先把这些内容展示给用户确认，再执行删除。
 */
export interface RemovalImpact {
  kind: TrashKind;
  id: string;
  title: string;
  effects: string[];
}

/** 回收站引用：按类型定位一条内容。 */
export interface TrashRef {
  kind: TrashKind;
  id: string;
}
