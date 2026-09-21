import {
  NOTE_CATEGORIES,
  type NoteCategory,
  type NoteContent,
  type NoteDraft,
  type NoteEdit,
} from '../domain/note';
import { AppError } from '../shared/errors';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new AppError('VALIDATION', message);
}

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    invalid('输入格式不正确，请保留内容后重试。');
  return input as Record<string, unknown>;
}

function identifier(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input))
    invalid('手记标识不正确，请重新打开应用后重试。');
  return input;
}

function revision(input: unknown): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
    invalid('内容版本不正确，请重新载入后重试。');
  return input;
}

function category(input: unknown): NoteCategory {
  const match = NOTE_CATEGORIES.find((item) => item.value === input);
  if (!match) invalid('请选择收获、待办、完成或杂项。');
  return match.value;
}

function content(input: Record<string, unknown>, requireBody: boolean): NoteContent {
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body, 'utf8') > MAX_BODY_BYTES)
    invalid('正文须为文本，且不能超过 2 MB。');
  if (requireBody && !input.body.trim()) invalid('请先写下正文，再保存手记。');
  if (typeof input.title !== 'string' || input.title.length > 300)
    invalid('标题不能超过 300 个字符。');
  if (!Array.isArray(input.tags) || input.tags.length > 100) invalid('标签最多添加 100 个。');
  const tags: string[] = [];
  for (const tag of input.tags) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 100)
      invalid('每个标签须包含 1 至 100 个字符。');
    tags.push(tag.trim());
  }
  // 正文保留用户原文；只有标签清理两端空白并去重。
  return {
    body: input.body,
    title: input.title,
    category: category(input.category),
    tags: [...new Set(tags)],
  };
}

export function validateDraft(input: unknown, requireBody = false): NoteDraft {
  const value = record(input);
  if (typeof value.extrasOpen !== 'boolean') invalid('草稿补充区状态不正确。');
  return {
    ...content(value, requireBody),
    id: identifier(value.id),
    revision: revision(value.revision),
    extrasOpen: value.extrasOpen,
  };
}

export function validateNoteEdit(input: unknown): NoteEdit {
  const value = record(input);
  return {
    ...content(value, true),
    id: identifier(value.id),
    expectedRevision: revision(value.expectedRevision),
  };
}

export function validateSearch(input: unknown): string {
  if (typeof input !== 'string' || input.length > 500) invalid('搜索词不能超过 500 个字符。');
  return input.trim();
}
