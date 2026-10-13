// 分类顺序是产品约定；完成语义也由 category 表达，不另存任务状态。
export const NOTE_CATEGORIES = [
  { value: 'insight', label: '收获' },
  { value: 'thought', label: '思绪' },
  { value: 'todo', label: '待办' },
  { value: 'done', label: '完成' },
  // 其他沿用旧杂项的标识，旧手记与草稿无需转换。
  { value: 'misc', label: '其他' },
] as const;

export type NoteCategory = (typeof NOTE_CATEGORIES)[number]['value'];

/** 草稿与手记共用标签容量，采纳建议也必须遵守保存边界。 */
export const NOTE_MAX_TAGS = 100;
export const NOTE_TAG_MAX_LENGTH = 100;

export interface NoteContent {
  body: string;
  title: string;
  category: NoteCategory;
  tags: string[];
}

export interface NoteDraft extends NoteContent {
  /** 正式提交时沿用此 ID，重试也不会新建另一条手记。 */
  id: string;
  /** 随本地输入递增，用于拒绝迟到的草稿写入。 */
  revision: number;
  extrasOpen: boolean;
}

export interface Note extends NoteContent {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteEdit extends NoteContent {
  id: string;
  /** 编辑所基于的已保存版本，防止覆盖其他更新。 */
  expectedRevision: number;
}

export interface LibrarySnapshot {
  draft: NoteDraft | null;
  notes: Note[];
}

// 无标题时只生成展示摘要，不把摘要写回标题或正文。
export function noteTitle(note: NoteContent): string {
  return (
    note.title.trim() ||
    note.body
      .split('\n')
      .find((line) => line.trim())
      ?.trim()
      .slice(0, 80) ||
    '无标题手记'
  );
}

/**
 * 卡片与阅读流用的正文摘要。没填标题时，标题已经取自正文首个非空行，
 * 摘要就跳过这一行，避免同一句话在卡片上出现两次；只影响展示，正文数据不变。
 */
export function noteExcerpt(note: NoteContent): string {
  if (note.title.trim()) return note.body.trim();
  const lines = note.body.split('\n');
  const firstContentLine = lines.findIndex((line) => line.trim());
  return (firstContentLine < 0 ? '' : lines.slice(firstContentLine + 1).join('\n')).trim();
}

export function categoryLabel(category: NoteCategory): string {
  return NOTE_CATEGORIES.find((item) => item.value === category)?.label ?? '其他';
}

export function emptyDraft(id: string): NoteDraft {
  return { id, revision: 0, body: '', title: '', category: 'insight', tags: [], extrasOpen: false };
}
