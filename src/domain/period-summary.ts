import { AI_PERIOD_CONTEXT_LIMIT, AI_PERIOD_MAX_POINTS, type AiAnswerSource } from '../shared/ai';

/** 引用仅对应单行顶层要点；旧段落或复杂列表保持原文展示，不猜测分点关系。 */
export function splitPeriodSummaryPoints(summary: string): string[] | null {
  const lines = summary
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  if (!lines.length || lines.length > AI_PERIOD_MAX_POINTS) return null;
  const points: string[] = [];
  for (const line of lines) {
    const match = /^[-*+]\s+(\S.*)$/u.exec(line);
    if (!match?.[1]) return null;
    points.push(match[1].trim());
  }
  return points;
}

/** 模型映射与持久边界共用校验；正文是唯一文字来源，二维引用必须逐点对应。 */
export function isPeriodPointSources(value: unknown, summary: string): value is AiAnswerSource[][] {
  const points = splitPeriodSummaryPoints(summary);
  if (!points || !Array.isArray(value) || value.length !== points.length) return false;
  const byIndex = new Map<number, { noteId: string; title: string }>();
  const byNote = new Map<string, number>();
  return value.every((group: unknown) => {
    if (!Array.isArray(group) || group.length > AI_PERIOD_CONTEXT_LIMIT) return false;
    const indices = new Set<number>();
    return group.every((source: unknown) => {
      if (
        typeof source !== 'object' ||
        source === null ||
        !('index' in source) ||
        !('noteId' in source) ||
        !('title' in source) ||
        typeof source.index !== 'number' ||
        !Number.isInteger(source.index) ||
        source.index < 1 ||
        source.index > AI_PERIOD_CONTEXT_LIMIT ||
        indices.has(source.index) ||
        typeof source.noteId !== 'string' ||
        !source.noteId.trim() ||
        source.noteId.length > 128 ||
        typeof source.title !== 'string' ||
        !source.title.trim() ||
        source.title.length > 300
      )
        return false;
      const previous = byIndex.get(source.index);
      if (previous && (previous.noteId !== source.noteId || previous.title !== source.title))
        return false;
      const previousIndex = byNote.get(source.noteId);
      if (previousIndex !== undefined && previousIndex !== source.index) return false;
      indices.add(source.index);
      byIndex.set(source.index, { noteId: source.noteId, title: source.title });
      byNote.set(source.noteId, source.index);
      return true;
    });
  });
}
