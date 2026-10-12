import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { NOTE_CATEGORIES } from '../domain/note';
import { isLocalDate, periodRange, type DateRange } from '../domain/time-range';
import { isPeriodPointSources } from '../domain/period-summary';
import {
  AI_PERIOD_MAX_SUGGESTIONS,
  AI_PERIOD_SUGGESTION_MAX_LENGTH,
  AI_PERIOD_SUMMARY_LIMIT,
  type StoredAiPeriodSummary,
  type AiPeriodType,
  type PeriodNote,
  type PeriodNotesQuery,
  type PeriodNotesResult,
} from '../shared/ai';
import { AppError } from '../shared/errors';
import { IMAGE_SELF_VISIBLE, NOTE_VISIBLE, TOPIC_VISIBLE } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

function invalidCache(): AppError {
  return new AppError('STORAGE', '回顾缓存格式异常，原数据已保留。');
}

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '回顾数据字段异常，原数据已保留。');
  return value;
}

function countField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AppError('STORAGE', '回顾数量字段异常，原数据已保留。');
  return value;
}

/** 有时区的生成时间才能在重开与恢复后继续准确展示；不接受 Date 的宽松日期补齐。 */
function validGeneratedAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isLocalDate(value.slice(0, 10)) &&
    Number(value.slice(11, 13)) < 24 &&
    Number.isFinite(Date.parse(value))
  );
}

function summaryFromRow(row: DatabaseRow): StoredAiPeriodSummary {
  const periodType = stringField(row, 'period_type');
  const startDate = stringField(row, 'start_date');
  if ((periodType !== 'week' && periodType !== 'month') || !isLocalDate(startDate))
    throw invalidCache();
  let range: DateRange;
  try {
    range = periodRange(periodType, startDate);
  } catch {
    throw invalidCache();
  }
  if (range.startDate !== startDate) throw invalidCache();
  const summary = stringField(row, 'summary');
  const generatedAt = stringField(row, 'generated_at');
  const noteCount = countField(row, 'note_count');
  let suggestions: unknown;
  let pointSources: unknown;
  try {
    suggestions = JSON.parse(stringField(row, 'suggestions'));
    if (row.point_sources !== null) pointSources = JSON.parse(stringField(row, 'point_sources'));
  } catch {
    // 损坏缓存不能伪装成未命中，更不能静默删除；保留数据供用户恢复。
    throw invalidCache();
  }
  if (
    !summary.trim() ||
    (pointSources !== undefined && !isPeriodPointSources(pointSources, summary)) ||
    summary.length > AI_PERIOD_SUMMARY_LIMIT + 1 ||
    noteCount === 0 ||
    !validGeneratedAt(generatedAt) ||
    !Array.isArray(suggestions) ||
    suggestions.length > AI_PERIOD_MAX_SUGGESTIONS ||
    !suggestions.every(
      (item: unknown): item is string =>
        typeof item === 'string' && !!item.trim() && item.length <= AI_PERIOD_SUGGESTION_MAX_LENGTH,
    )
  )
    throw invalidCache();
  return {
    periodType,
    startDate,
    endDate: range.endDate,
    summary,
    ...(pointSources !== undefined ? { pointSources } : {}),
    suggestions,
    noteCount,
    generatedAt,
  };
}

function noteFromRow(row: DatabaseRow): PeriodNote {
  const category = NOTE_CATEGORIES.find((item) => item.value === row.category)?.value;
  if (!category) throw new AppError('STORAGE', '回顾手记分类异常，原数据已保留。');
  const firstImageId = row.first_image_id;
  if (firstImageId !== null && typeof firstImageId !== 'string')
    throw new AppError('STORAGE', '回顾图片字段异常，原数据已保留。');
  return {
    id: stringField(row, 'id'),
    title: stringField(row, 'title'),
    category,
    body: stringField(row, 'body'),
    createdAt: stringField(row, 'created_at'),
    firstImageId,
  };
}

/** 共用知识库唯一连接；返回全量事实，采样与正文截取留给主进程业务。 */
export class PeriodSummaryStore {
  constructor(private readonly database: DatabaseSync) {}

  fetchPeriodNotes(query: PeriodNotesQuery): PeriodNotesResult {
    const notes = this.database
      .prepare(
        `
        SELECT notes.id, notes.title, notes.category, notes.body, notes.created_at,
          (SELECT note_images.id FROM note_images
           WHERE note_images.note_id = notes.id AND ${IMAGE_SELF_VISIBLE}
           ORDER BY note_images.position, note_images.id LIMIT 1) AS first_image_id
        FROM notes
        WHERE ${NOTE_VISIBLE} AND notes.created_at >= ? AND notes.created_at < ?
        ORDER BY notes.created_at DESC, notes.id DESC
      `,
      )
      .all(query.startAt, query.endBefore)
      .map(noteFromRow);
    // 待办龄期统计针对全库，不能被本次查看的周/月范围缩窄。
    const staleTodos = this.database
      .prepare(
        `
        SELECT COUNT(*) AS total FROM notes
        WHERE ${NOTE_VISIBLE} AND notes.category = 'todo' AND notes.created_at < ?
      `,
      )
      .get(query.staleBefore);
    if (!staleTodos) throw new AppError('STORAGE', '回顾待办数量读取失败。');
    const activeTopics = this.database
      .prepare(
        `
        SELECT topics.id, topics.title, COUNT(note_topics.note_id) AS note_count
        FROM topics
        JOIN note_topics ON note_topics.topic_id = topics.id
        JOIN notes ON notes.id = note_topics.note_id
        WHERE ${TOPIC_VISIBLE} AND ${NOTE_VISIBLE}
          AND notes.created_at >= ? AND notes.created_at < ?
        GROUP BY topics.id
        HAVING COUNT(note_topics.note_id) >= 3
        ORDER BY note_count DESC, topics.id DESC LIMIT 5
      `,
      )
      .all(query.startAt, query.endBefore)
      .map((row) => ({
        id: stringField(row, 'id'),
        title: stringField(row, 'title'),
        noteCount: countField(row, 'note_count'),
      }));
    return {
      notes,
      // 查询没有 LIMIT，后续分类采样需要全量手记；总数直接与同次查询结果保持一致。
      total: notes.length,
      stats: { staleTodoCount: countField(staleTodos, 'total'), activeTopics },
    };
  }

  loadPeriodSummary(periodType: AiPeriodType, startDate: string): StoredAiPeriodSummary | null {
    try {
      const row = this.database
        .prepare('SELECT * FROM ai_period_summaries WHERE period_type = ? AND start_date = ?')
        .get(periodType, startDate);
      return row ? summaryFromRow(row) : null;
    } catch (error) {
      if (error instanceof AppError) throw error;
      // SQLite 超出 JS 安全整数范围时会在映射行之前抛错，同样保留缓存并报存储异常。
      throw invalidCache();
    }
  }

  savePeriodSummary(summary: StoredAiPeriodSummary): void {
    // UPSERT 原位更新同一周期；图片回执和可推算的 endDate 均不进入持久数据。
    this.database
      .prepare(
        `
        INSERT INTO ai_period_summaries
          (period_type, start_date, summary, suggestions, note_count, generated_at, point_sources)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (period_type, start_date) DO UPDATE SET
          summary = excluded.summary, suggestions = excluded.suggestions,
          note_count = excluded.note_count, generated_at = excluded.generated_at,
          point_sources = excluded.point_sources
      `,
      )
      .run(
        summary.periodType,
        summary.startDate,
        summary.summary,
        JSON.stringify(summary.suggestions),
        summary.noteCount,
        summary.generatedAt,
        summary.pointSources === undefined ? null : JSON.stringify(summary.pointSources),
      );
  }
}
