/**
 * 跨实体可见性谓词：**只在这里表达一次**，其余查询从这里拼接。
 *
 * 规则：
 * - 实体自身未删除（`deleted_at IS NULL`）；
 * - 动态额外要求所属事务未删除——父事务在回收站时，动态既不出现在列表里，也不能单独恢复；
 * - 图片额外要求所属手记未删除。
 *
 * 复合谓词里同时带上两张表的条件，是为了让关联查询（如搜索结果、备份导出）
 * 直接拼一段就得到正确结果，避免各处再补一次父实体判断而漏掉。
 */
export const NOTE_VISIBLE = 'notes.deleted_at IS NULL';
export const TOPIC_VISIBLE = 'topics.deleted_at IS NULL';
export const THREAD_VISIBLE = 'threads.deleted_at IS NULL';
export const ENTRY_SELF_VISIBLE = 'thread_entries.deleted_at IS NULL';
export const ENTRY_VISIBLE = `${ENTRY_SELF_VISIBLE} AND ${THREAD_VISIBLE}`;
export const IMAGE_SELF_VISIBLE = 'note_images.deleted_at IS NULL';
export const IMAGE_VISIBLE = `${IMAGE_SELF_VISIBLE} AND ${NOTE_VISIBLE}`;

/** 按表名取对应谓词，供表名动态拼接的查询使用。 */
export const VISIBLE_BY_TABLE = {
  notes: NOTE_VISIBLE,
  topics: TOPIC_VISIBLE,
  threads: THREAD_VISIBLE,
} as const;

/** 行级判断：自身未删除，且（动态的）父事务也未删除。 */
export function isVisible(deletedAt: unknown, parentDeletedAt: unknown = null): boolean {
  return !deletedAt && !parentDeletedAt;
}
