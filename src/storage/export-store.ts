import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { exportFileName, frontMatter } from '../domain/export';
import { categoryLabel, NOTE_CATEGORIES, noteTitle, type Note } from '../domain/note';
import { THREAD_STATUS_LABELS, type EntrySummary, type ThreadSummary } from '../domain/thread';
import { AppError } from '../shared/errors';
import type { ExportSummary } from '../domain/library-data';
import type { NoteStore } from './note-store';
import type { ThreadStore } from './thread-store';
import type { TopicStore } from './topic-store';

/** 导出目录结构固定，方便再次导入或脚本处理。 */
const DIRECTORIES = { notes: '手记', topics: '归纳', threads: '事务' } as const;

export type { ExportSummary } from '../domain/library-data';

function write(directory: string, fileName: string, content: string): void {
  writeFileSync(join(directory, fileName), content, 'utf8');
}

/**
 * 可读导出：把结构化数据写成 Markdown 与关系元数据。
 * 只导出仍然可见的内容（软删除的不导出），文件名带稳定 ID，
 * 标题里的平台非法字符会被清理，因此导出物可以直接放进其他笔记工具。
 * 导出不能代替备份：它不含草稿、附件二进制与数据库结构。
 */
export class ExportStore {
  constructor(
    private readonly database: DatabaseSync,
    private readonly notes: NoteStore,
    private readonly topics: TopicStore,
    private readonly threads: ThreadStore,
  ) {}

  exportTo(destination: string): ExportSummary {
    if (!destination) throw new AppError('VALIDATION', '请选择导出位置。');
    const notesDirectory = join(destination, DIRECTORIES.notes);
    const topicsDirectory = join(destination, DIRECTORIES.topics);
    const threadsDirectory = join(destination, DIRECTORIES.threads);
    // 目标已存在且不为空时拒绝：导出不清理任何已有内容，避免误删用户文件。
    if (existsSync(destination) && readdirSync(destination).length > 0)
      throw new AppError('CONFLICT', '导出位置已存在且不为空，请换一个位置。');
    for (const directory of [destination, notesDirectory, topicsDirectory, threadsDirectory])
      mkdirSync(directory, { recursive: true });

    const topics = this.topics.list();
    const threads = this.threads.list(true);
    const notes = this.notes.load().notes;

    const noteFileNames = new Map<string, string>();
    for (const note of notes) {
      const fileName = exportFileName(noteTitle(note), note.id);
      noteFileNames.set(note.id, fileName);
      write(notesDirectory, fileName, this.noteDocument(note, topics));
    }

    let entries = 0;
    for (const thread of threads) {
      const timeline = this.threads.entries(thread.id, 'oldest');
      entries += timeline.length;
      write(
        threadsDirectory,
        exportFileName(thread.title, thread.id),
        this.threadDocument(thread, timeline, noteFileNames),
      );
    }

    for (const topic of topics) {
      write(
        topicsDirectory,
        exportFileName(topic.title, topic.id),
        this.topicDocument(topic, notes, noteFileNames),
      );
    }

    write(destination, 'index.md', this.indexDocument(notes, topics, threads, entries));
    return {
      notes: notes.length,
      topics: topics.length,
      threads: threads.length,
      entries,
      destination,
    };
  }

  private noteDocument(
    note: Note,
    topics: { id: string; title: string; noteIds: string[] }[],
  ): string {
    const collectedIn = topics.filter((topic) => topic.noteIds.includes(note.id));
    const referencing = this.referencesOfNote(note.id);
    return (
      frontMatter({
        类型: '手记',
        标识: note.id,
        标题: noteTitle(note),
        分类: categoryLabel(categoryOf(note.category)),
        标签: note.tags,
        创建时间: note.createdAt,
        修改时间: note.updatedAt,
        收录于: collectedIn.map((topic) => `${topic.title}（${topic.id}）`),
        被引用于: referencing,
      }) + `${note.body.trimEnd()}\n`
    );
  }

  private topicDocument(
    topic: {
      id: string;
      title: string;
      description: string;
      noteIds: string[];
      createdAt: string;
      updatedAt: string;
    },
    notes: Note[],
    noteFileNames: Map<string, string>,
  ): string {
    const byId = new Map(notes.map((note) => [note.id, note]));
    const lines = topic.noteIds
      .map((noteId) => byId.get(noteId))
      .filter((note): note is Note => note !== undefined)
      .map((note) => `- [${noteTitle(note)}](${relativeNoteLink(noteFileNames.get(note.id))})`);
    return (
      frontMatter({
        类型: '归纳',
        标识: topic.id,
        标题: topic.title,
        创建时间: topic.createdAt,
        修改时间: topic.updatedAt,
        收录数量: String(topic.noteIds.length),
      }) + `${topic.description.trimEnd()}\n\n## 收录的手记\n\n${lines.join('\n') || '（暂无）'}\n`
    );
  }

  private threadDocument(
    thread: ThreadSummary,
    timeline: EntrySummary[],
    noteFileNames: Map<string, string>,
  ): string {
    const entries = timeline
      .map((entry) => {
        const references = entry.noteIds
          .map((noteId) => `- [${noteId}](${relativeNoteLink(noteFileNames.get(noteId))})`)
          .join('\n');
        return [
          `### ${entry.summary}`,
          '',
          `- 发生时间：${entry.occurredAt}`,
          entry.tags.length ? `- 标签：${entry.tags.join('、')}` : '',
          references ? `\n引用手记：\n${references}` : '',
          entry.body.trimEnd() ? `\n${entry.body.trimEnd()}` : '',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
    const directNotes = thread.noteIds
      .map((noteId) => `- [${noteId}](${relativeNoteLink(noteFileNames.get(noteId))})`)
      .join('\n');
    return (
      frontMatter({
        类型: '事务',
        标识: thread.id,
        标题: thread.title,
        状态: THREAD_STATUS_LABELS[thread.status],
        创建时间: thread.createdAt,
        修改时间: thread.updatedAt,
        动态数量: String(timeline.length),
      }) +
      `${thread.description.trimEnd()}\n\n## 当前概况\n\n${thread.summary.trimEnd() || '（暂无）'}\n\n## 动态时间线\n\n${
        entries || '（暂无动态）'
      }\n\n## 直接关联的手记\n\n${directNotes || '（暂无）'}\n`
    );
  }

  private indexDocument(
    notes: Note[],
    topics: { id: string; title: string; noteIds: string[] }[],
    threads: ThreadSummary[],
    entries: number,
  ): string {
    return (
      frontMatter({
        类型: '导出索引',
        导出时间: new Date().toISOString(),
        手记数量: String(notes.length),
        归纳数量: String(topics.length),
        事务数量: String(threads.length),
        动态数量: String(entries),
      }) +
      [
        '# Memocraft 导出',
        '',
        '这是可读导出：正文与关系元数据都在 Markdown 里，可以直接阅读或迁移。',
        '它**不是完整备份**——不含草稿、图片二进制与数据库结构，需要完整备份请在设置里选择「备份到文件夹」。',
        '',
        `- 手记：${notes.length} 条（${DIRECTORIES.notes}/）`,
        `- 归纳：${topics.length} 个（${DIRECTORIES.topics}/）`,
        `- 事务：${threads.length} 个（${DIRECTORIES.threads}/），共 ${entries} 条动态`,
        '',
      ].join('\n')
    );
  }

  /** 手记被谁引用：事务资料与动态引用分开写，便于阅读时追溯。 */
  private referencesOfNote(noteId: string): string[] {
    const threads = this.database
      .prepare(
        `SELECT threads.id AS id, threads.title AS title FROM thread_notes
         JOIN threads ON threads.id = thread_notes.thread_id
         JOIN notes ON notes.id = thread_notes.note_id
         WHERE thread_notes.note_id = ? AND notes.deleted_at IS NULL AND threads.deleted_at IS NULL`,
      )
      .all(noteId)
      .map((row) => `${row.title}（事务资料，${row.id}）`);
    const entries = this.database
      .prepare(
        `SELECT threads.title AS thread_title, thread_entries.summary AS summary, thread_entries.id AS id
         FROM entry_notes
         JOIN thread_entries ON thread_entries.id = entry_notes.entry_id
         JOIN threads ON threads.id = thread_entries.thread_id
         JOIN notes ON notes.id = entry_notes.note_id
         WHERE entry_notes.note_id = ?
           AND notes.deleted_at IS NULL AND thread_entries.deleted_at IS NULL AND threads.deleted_at IS NULL`,
      )
      .all(noteId)
      .map((row) => `${row.thread_title} · ${row.summary}（动态，${row.id}）`);
    return [...threads, ...entries];
  }
}

function relativeNoteLink(fileName: string | undefined): string {
  return fileName ? `../${DIRECTORIES.notes}/${fileName}` : '#';
}

/** 分类值来自数据库，导出时按共用分类解析；未知值退回其他。 */
function categoryOf(value: string): (typeof NOTE_CATEGORIES)[number]['value'] {
  return NOTE_CATEGORIES.find((item) => item.value === value)?.value ?? 'misc';
}
