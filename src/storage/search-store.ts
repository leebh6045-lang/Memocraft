import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { categoryLabel, noteTitle, NOTE_CATEGORIES } from '../domain/note';
import {
  SEARCH_PAGE_SIZE,
  SEARCH_RECENT_PER_KIND,
  type SearchHit,
  type SearchResult,
} from '../domain/search';
import { THREAD_STATUS_LABELS } from '../domain/thread';
import { AppError } from '../shared/errors';
import {
  ENTRY_VISIBLE,
  NOTE_VISIBLE,
  THREAD_VISIBLE,
  TOPIC_VISIBLE,
  VISIBLE_BY_TABLE,
} from './visibility';

type DatabaseRow = Record<string, SQLOutputValue>;

/** 每类对象各自最多取出多少条，再合并截断；多取一条用于判断是否截断。 */
const PER_KIND_LIMIT = 20;

function stringField(row: DatabaseRow, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new AppError('STORAGE', '搜索结果字段异常。');
  return value;
}

/** 参数绑定不消除 LIKE 通配语义，仍需转义用户输入的 %、_ 与反斜线。 */
function escapeLike(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * 命中处的上下文摘要：折叠空白后在命中位置前后各取一段。
 * 未命中该字段时退回开头，让界面仍能显示说明性文字而不是空行。
 */
function excerptOf(text: string, query: string, radius = 22): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (!query) return compact.slice(0, 80);
  const at = compact.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return compact.slice(0, 80);
  const start = Math.max(0, at - radius);
  const end = Math.min(compact.length, at + query.length + radius);
  return `${start > 0 ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}

/**
 * 全对象搜索：手记（标题/正文/标签）、归纳（标题/说明）、事务（标题/说明/当前概况）、
 * 动态（描述/正文/标签）。
 *
 * 可见性：草稿从不参与；已删除的手记、归纳、事务不参与；动态还要求所属事务未删除。
 * 归档事务照常可检索——归档只影响默认列表，不影响查找。
 * 首版是参数化子串匹配，大小写不敏感限于英文字母；分词、拼音与语义搜索后置。
 */
export class SearchStore {
  constructor(private readonly database: DatabaseSync) {}

  search(query: string): SearchResult {
    const keyword = query.trim();
    if (!keyword) return this.recent();
    const pattern = `%${escapeLike(keyword)}%`;
    const hits: SearchHit[] = [];
    let truncated = false;

    for (const [kind, rows, build] of [
      ['note', this.matchNotes(pattern), this.noteHit.bind(this)],
      ['topic', this.matchTopics(pattern), this.topicHit.bind(this)],
      ['thread', this.matchThreads(pattern), this.threadHit.bind(this)],
      ['entry', this.matchEntries(pattern), this.entryHit.bind(this)],
    ] as const) {
      if (rows.length > PER_KIND_LIMIT) truncated = true;
      for (const row of rows.slice(0, PER_KIND_LIMIT)) hits.push(build(row, keyword));
      if (kind === 'entry' && hits.length >= SEARCH_PAGE_SIZE) break;
    }

    if (hits.length > SEARCH_PAGE_SIZE) truncated = true;
    return { hits: hits.slice(0, SEARCH_PAGE_SIZE), hasMore: truncated };
  }

  /** 空查询给出最近内容：每类各取最近更新的若干条，分组名与对象类型一致。 */
  private recent(): SearchResult {
    const hits: SearchHit[] = [
      ...this.recentRows('notes').map((row) => this.noteHit(row, '')),
      ...this.recentRows('topics').map((row) => this.topicHit(row, '')),
      ...this.recentRows('threads').map((row) => this.threadHit(row, '')),
      ...this.recentEntries().map((row) => this.entryHit(row, '')),
    ];
    return { hits, hasMore: false };
  }

  private recentRows(table: 'notes' | 'topics' | 'threads'): DatabaseRow[] {
    return this.database
      .prepare(
        `SELECT * FROM ${table} WHERE ${VISIBLE_BY_TABLE[table]} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(SEARCH_RECENT_PER_KIND);
  }

  private recentEntries(): DatabaseRow[] {
    return this.database
      .prepare(
        `SELECT thread_entries.*, threads.title AS thread_title
         FROM thread_entries JOIN threads ON threads.id = thread_entries.thread_id
         WHERE ${ENTRY_VISIBLE}
         ORDER BY thread_entries.updated_at DESC, thread_entries.id DESC LIMIT ?`,
      )
      .all(SEARCH_RECENT_PER_KIND);
  }

  private matchNotes(pattern: string): DatabaseRow[] {
    return this.database
      .prepare(
        `SELECT * FROM notes WHERE ${NOTE_VISIBLE} AND (
           title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR EXISTS (
             SELECT 1 FROM note_tags JOIN tags ON tags.id = note_tags.tag_id
             WHERE note_tags.note_id = notes.id AND tags.name LIKE ? ESCAPE '\\'
           )) ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, PER_KIND_LIMIT + 1);
  }

  private matchTopics(pattern: string): DatabaseRow[] {
    return this.database
      .prepare(
        `SELECT * FROM topics WHERE ${TOPIC_VISIBLE} AND (
           title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\'
         ) ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, pattern, PER_KIND_LIMIT + 1);
  }

  private matchThreads(pattern: string): DatabaseRow[] {
    // 归档事务照常参与检索：归档只影响默认列表。
    return this.database
      .prepare(
        `SELECT * FROM threads WHERE ${THREAD_VISIBLE} AND (
           title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
         ) ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, PER_KIND_LIMIT + 1);
  }

  private matchEntries(pattern: string): DatabaseRow[] {
    return this.database
      .prepare(
        `SELECT thread_entries.*, threads.title AS thread_title
         FROM thread_entries JOIN threads ON threads.id = thread_entries.thread_id
         WHERE ${ENTRY_VISIBLE} AND (
           thread_entries.summary LIKE ? ESCAPE '\\' OR thread_entries.body LIKE ? ESCAPE '\\' OR EXISTS (
             SELECT 1 FROM entry_tags JOIN tags ON tags.id = entry_tags.tag_id
             WHERE entry_tags.entry_id = thread_entries.id AND tags.name LIKE ? ESCAPE '\\'
           )) ORDER BY thread_entries.updated_at DESC, thread_entries.id DESC LIMIT ?`,
      )
      .all(pattern, pattern, pattern, PER_KIND_LIMIT + 1);
  }

  private noteHit(row: DatabaseRow, keyword: string): SearchHit {
    const category = NOTE_CATEGORIES.find((item) => item.value === row.category)?.value ?? 'misc';
    const note = {
      body: stringField(row, 'body'),
      title: stringField(row, 'title'),
      category,
      tags: [] as string[],
    };
    const title = noteTitle(note);
    const bodyExcerpt = excerptOf(note.body, keyword);
    return {
      kind: 'note',
      id: stringField(row, 'id'),
      title,
      excerpt: bodyExcerpt === title ? '' : bodyExcerpt,
      context: categoryLabel(category),
      threadId: null,
      threadTitle: null,
      at: stringField(row, 'updated_at'),
    };
  }

  private topicHit(row: DatabaseRow, keyword: string): SearchHit {
    const description = stringField(row, 'description');
    return {
      kind: 'topic',
      id: stringField(row, 'id'),
      title: stringField(row, 'title'),
      excerpt: excerptOf(description, keyword),
      context: '',
      threadId: null,
      threadTitle: null,
      at: stringField(row, 'updated_at'),
    };
  }

  private threadHit(row: DatabaseRow, keyword: string): SearchHit {
    const status = row.status === 'archived' ? 'archived' : 'active';
    const summary = stringField(row, 'summary');
    const description = stringField(row, 'description');
    return {
      kind: 'thread',
      id: stringField(row, 'id'),
      title: stringField(row, 'title'),
      excerpt: excerptOf(summary || description, keyword),
      context: THREAD_STATUS_LABELS[status],
      threadId: stringField(row, 'id'),
      threadTitle: stringField(row, 'title'),
      at: stringField(row, 'updated_at'),
    };
  }

  private entryHit(row: DatabaseRow, keyword: string): SearchHit {
    const body = stringField(row, 'body');
    const summary = stringField(row, 'summary');
    return {
      kind: 'entry',
      id: stringField(row, 'id'),
      title: summary,
      excerpt: excerptOf(body, keyword),
      context: stringField(row, 'thread_title'),
      threadId: stringField(row, 'thread_id'),
      threadTitle: stringField(row, 'thread_title'),
      at: stringField(row, 'updated_at'),
    };
  }
}
