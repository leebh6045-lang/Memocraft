import { noteTitle, type Note } from '../../domain/note';
import type { TopicSummary } from '../../domain/topic';
import { formatTime } from './format-time';

/**
 * 选择器条目：手记抽屉里的「收录到归纳」与归纳详情里的「收录手记」共用同一种形状。
 * `badge` 有值表示已经关联，条目显示为不可选，避免制造重复操作。
 */
export interface PickerOption {
  id: string;
  title: string;
  /** 右侧次要信息：手记的创建时间，或归纳已收录的手记数量。 */
  meta: string;
  /** 搜索用的合并文本，已转小写：手记是标题 + 正文 + 标签，归纳是标题 + 说明。 */
  searchText: string;
  badge?: string;
}

function searchable(parts: string[]): string {
  return parts.join('\n').toLowerCase();
}

/** 手记选项：已关联的手记不再列出，只回报数量，供选择器解释空状态。 */
export function notePickerOptions(
  notes: Note[],
  linkedIds: Iterable<string>,
): { options: PickerOption[]; linkedCount: number } {
  const linked = new Set(linkedIds);
  const options = notes
    .filter((note) => !linked.has(note.id))
    .map((note) => ({
      id: note.id,
      title: noteTitle(note),
      meta: formatTime(note.createdAt),
      searchText: searchable([noteTitle(note), note.body, ...note.tags]),
    }));
  return { options, linkedCount: notes.length - options.length };
}

/** 归纳选项：全部列出，已收录这条手记的归纳带标记且不可重复选择。 */
export function topicPickerOptions(
  topics: TopicSummary[],
  linkedIds: Iterable<string>,
): PickerOption[] {
  const linked = new Set(linkedIds);
  return topics.map((topic) => ({
    id: topic.id,
    title: topic.title,
    meta: `${topic.noteIds.length} 条手记`,
    searchText: searchable([topic.title, topic.description]),
    badge: linked.has(topic.id) ? '已收录' : undefined,
  }));
}
