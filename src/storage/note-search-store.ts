import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { NOTE_CATEGORIES, noteTitle } from '../domain/note';
import type { NoteSearchHit, NoteSearchResult } from '../domain/note-search';
import {
  AI_ASK_CONTEXT_LIMIT,
  AI_ASK_EXCERPT_LIMIT,
  AI_ASK_TERM_CANDIDATE_LIMIT,
} from '../shared/ai';
import { AppError } from '../shared/errors';
import { NOTE_VISIBLE } from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;
interface Candidate {
  row: DatabaseRow;
  score: number;
  matchedTerms: number;
}
interface TermOccurrence {
  term: string;
  nextStart: number;
  latestStart: number;
}

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '手记检索结果字段异常。');
  return value;
}

/** 与 SQL 的 BINARY 排序一致，避免系统语言设置影响同时间记录的稳定顺序。 */
function descendingText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function numberField(row: DatabaseRow, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AppError('STORAGE', '手记检索结果数量异常。');
  return value;
}

/** 参数绑定不会关闭 LIKE 的通配语义，反斜线也必须一并转义。 */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** 与 SQLite 默认 LIKE 对齐：仅折叠 ASCII 大写，避免 Unicode 转换改变字符位置。 */
function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * 按命中结尾从左到右扫描，只保留每词最近的命中起点，避免长正文积累全部命中数组。
 * 每个结尾都可得到当前 300 字内最多词的最短跨度，再以最佳跨度为中心补足上下文。
 */
function excerptOf(body: string, terms: string[]): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const folded = foldAscii(compact);
  const occurrences: TermOccurrence[] = terms.map((value) => {
    const term = foldAscii(value);
    return { term, nextStart: folded.indexOf(term), latestStart: -1 };
  });
  let bestStart = 0;
  let bestEnd = 0;
  let bestCount = 0;
  let bestLength = Infinity;
  const minimumSpan = Math.max(...terms.map((term) => term.length));

  for (;;) {
    let next: TermOccurrence | undefined;
    let end = Infinity;
    for (const occurrence of occurrences) {
      if (occurrence.nextStart < 0) continue;
      const candidateEnd = occurrence.nextStart + occurrence.term.length;
      if (candidateEnd < end) {
        end = candidateEnd;
        next = occurrence;
      }
    }
    if (!next) break;
    next.latestStart = next.nextStart;
    // 步长为 1，中文滑窗词和重叠子串也不能漏掉。
    next.nextStart = folded.indexOf(next.term, next.nextStart + 1);
    let count = 0;
    let start = end;
    for (const occurrence of occurrences) {
      if (occurrence.latestStart >= 0 && occurrence.latestStart >= end - AI_ASK_EXCERPT_LIMIT) {
        count += 1;
        start = Math.min(start, occurrence.latestStart);
      }
    }
    const length = end - start;
    if (count > bestCount || (count === bestCount && length < bestLength)) {
      bestStart = start;
      bestEnd = end;
      bestCount = count;
      bestLength = length;
    }
    // 已覆盖全部词且达到理论最短跨度，后续命中不可能提供更好的窗口。
    if (bestCount === terms.length && bestLength === minimumSpan) break;
  }

  const centered = Math.floor((bestStart + bestEnd - AI_ASK_EXCERPT_LIMIT) / 2);
  const start =
    bestCount === 0 ? 0 : Math.max(0, Math.min(centered, compact.length - AI_ASK_EXCERPT_LIMIT));
  const end = Math.min(compact.length, start + AI_ASK_EXCERPT_LIMIT);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

/** 该条件只查有效手记；草稿、归纳、事务和动态不进入问答上下文。 */
const MATCH_TERM = `(
  notes.title LIKE ? ESCAPE '\\' OR notes.body LIKE ? ESCAPE '\\' OR EXISTS (
    SELECT 1 FROM note_tags JOIN tags ON tags.id = note_tags.tag_id
    WHERE note_tags.note_id = notes.id AND tags.name LIKE ? ESCAPE '\\'
  )
)`;

/** 面向问答的只读检索；共用 NoteStore 的连接，原有四类搜索保持独立。 */
export class NoteSearchStore {
  constructor(private readonly database: DatabaseSync) {}

  retrieve(terms: string[]): NoteSearchResult {
    if (terms.length === 0) return { hits: [], total: 0 };
    const patterns = terms.map((term) => `%${escapeLike(term)}%`);
    const match = this.database.prepare(`
      SELECT notes.id, notes.title, notes.body, notes.category, notes.updated_at,
        (CASE WHEN notes.title LIKE ? ESCAPE '\\' THEN 3 ELSE 0 END
         + CASE WHEN EXISTS (
             SELECT 1 FROM note_tags JOIN tags ON tags.id = note_tags.tag_id
             WHERE note_tags.note_id = notes.id AND tags.name LIKE ? ESCAPE '\\'
           ) THEN 2 ELSE 0 END
         + CASE WHEN notes.body LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS score
      FROM notes
      WHERE ${NOTE_VISIBLE} AND ${MATCH_TERM}
      ORDER BY score DESC, notes.updated_at DESC, notes.id DESC LIMIT ?
    `);
    const candidates = new Map<string, Candidate>();
    for (const pattern of patterns) {
      for (const row of match.all(
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        pattern,
        AI_ASK_TERM_CANDIDATE_LIMIT,
      )) {
        const id = stringField(row, 'id');
        const existing = candidates.get(id);
        if (existing) {
          existing.score += numberField(row, 'score');
          existing.matchedTerms += 1;
        } else {
          candidates.set(id, { row, score: numberField(row, 'score'), matchedTerms: 1 });
        }
      }
    }
    // 统计未裁剪的并集，避免把「每词最多 20 条候选」误报成总命中数量。
    const countRow = this.database
      .prepare(
        `
      SELECT COUNT(*) AS total FROM notes WHERE ${NOTE_VISIBLE}
      AND (${patterns.map(() => MATCH_TERM).join(' OR ')})
    `,
      )
      .get(...patterns.flatMap((pattern) => [pattern, pattern, pattern]));
    if (!countRow) throw new AppError('STORAGE', '手记检索数量读取失败。');
    const ranked = [...candidates.values()].sort(
      (left, right) =>
        right.matchedTerms - left.matchedTerms ||
        right.score - left.score ||
        descendingText(stringField(left.row, 'updated_at'), stringField(right.row, 'updated_at')) ||
        descendingText(stringField(left.row, 'id'), stringField(right.row, 'id')),
    );
    const hits = ranked
      .slice(0, AI_ASK_CONTEXT_LIMIT)
      .map((candidate) => this.hitOf(candidate, terms));
    return { hits, total: numberField(countRow, 'total') };
  }

  private hitOf(candidate: Candidate, terms: string[]): NoteSearchHit {
    const { row } = candidate;
    const category = NOTE_CATEGORIES.find((item) => item.value === row.category)?.value;
    if (!category) throw new AppError('STORAGE', '手记检索分类异常，原数据已保留。');
    const body = stringField(row, 'body');
    const title = stringField(row, 'title');
    return {
      id: stringField(row, 'id'),
      title: noteTitle({ body, title, category, tags: [] }).slice(0, 300),
      category,
      excerpt: excerptOf(body, terms),
      matchedTerms: candidate.matchedTerms,
      updatedAt: stringField(row, 'updated_at'),
    };
  }
}
