import {
  NOTE_CATEGORIES,
  type NoteCategory,
  type NoteContent,
  type NoteDraft,
  type NoteEdit,
} from '../domain/note';
import {
  draftOwner,
  noteOwner,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_INDEX_NOTES,
  MAX_IMAGE_NAME_LENGTH,
  type ImageInput,
  type ImageOwner,
} from '../domain/note-image';
import { TRASH_KINDS, type TrashKind, type TrashRef } from '../domain/trash';
import {
  ENTRY_BODY_MAX_LENGTH,
  ENTRY_SUMMARY_MAX_LENGTH,
  MAX_REFERENCE_BATCH,
  THREAD_DESCRIPTION_MAX_LENGTH,
  THREAD_SUMMARY_MAX_LENGTH,
  THREAD_TITLE_MAX_LENGTH,
  type EntryCreate,
  type EntryEdit,
  type ThreadCreate,
  type ThreadEdit,
  type TimelineOrder,
} from '../domain/thread';
import {
  MAX_TOPIC_LINK_BATCH,
  TOPIC_DESCRIPTION_MAX_LENGTH,
  TOPIC_TITLE_MAX_LENGTH,
  type TopicCreate,
  type TopicEdit,
} from '../domain/topic';
import { isAbsolute } from 'node:path';
import { AppError } from '../shared/errors';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_COUNT_PER_REQUEST = 20;
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

/** 编辑请求基于已保存内容，版本必须从 1 起；草稿的 0 版本只适用于自动保存。 */
function editRevision(input: unknown): number {
  const value = revision(input);
  if (value < 1) invalid('内容版本不正确，请重新载入后重试。');
  return value;
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
    expectedRevision: editRevision(value.expectedRevision),
  };
}

export function validateSearch(input: unknown): string {
  if (typeof input !== 'string' || input.length > 500) invalid('搜索词不能超过 500 个字符。');
  return input.trim();
}

/** IPC 只传结构化克隆数据：Uint8Array 正常通过，普通数字数组也接受并归一化。 */
function imageBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (
    Array.isArray(input) &&
    input.every((byte) => typeof byte === 'number' && byte >= 0 && byte <= 255)
  )
    return Uint8Array.from(input as number[]);
  invalid('图片数据格式不正确，请重新选择或粘贴。');
}

function imageInput(input: unknown): ImageInput {
  const value = record(input);
  const bytes = imageBytes(value.bytes);
  if (bytes.byteLength === 0) invalid('图片内容为空，请重新选择或粘贴。');
  if (bytes.byteLength > MAX_IMAGE_BYTES)
    invalid(`单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB。`);
  if (value.originalName !== undefined && typeof value.originalName !== 'string')
    invalid('图片名称格式不正确。');
  return { bytes, originalName: (value.originalName ?? '').slice(0, 300) };
}

export function validateAddImages(input: unknown): { owner: ImageOwner; images: ImageInput[] } {
  const value = record(input);
  if (!Array.isArray(value.images) || value.images.length === 0) invalid('请选择要添加的图片。');
  if (value.images.length > MAX_IMAGE_COUNT_PER_REQUEST)
    invalid(`一次最多添加 ${MAX_IMAGE_COUNT_PER_REQUEST} 张图片。`);
  return { owner: validateImageOwner(value.owner), images: value.images.map(imageInput) };
}

/**
 * 图片归属：已保存的手记，或首页尚未保存的草稿。
 * 两者都是 UUID，但提示文案不同，避免给出误导性的报错。
 */
export function validateImageOwner(input: unknown): ImageOwner {
  const value = record(input);
  if (value.kind === 'note') return noteOwner(identifier(value.id));
  if (value.kind === 'draft') {
    if (typeof value.id !== 'string' || !UUID.test(value.id))
      invalid('草稿标识不正确，请重新打开应用后重试。');
    return draftOwner(value.id);
  }
  invalid('图片归属不正确，请重新打开页面后重试。');
}

export function validateImageId(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input))
    invalid('图片标识不正确，请重新打开手记后重试。');
  return input;
}

export function validateNoteId(input: unknown): string {
  return identifier(input);
}

/** 列表缩略图的批量读取：允许空列表（没有手记可显示），但拒绝过多参数与非法标识。 */
export function validateNoteIds(input: unknown): string[] {
  if (!Array.isArray(input)) invalid('手记标识列表不正确，请重新打开页面后重试。');
  if (input.length > MAX_IMAGE_INDEX_NOTES)
    invalid(`一次最多读取 ${MAX_IMAGE_INDEX_NOTES} 条手记的图片。`);
  return input.map(identifier);
}

export function validateImageName(input: unknown): string {
  if (typeof input !== 'string' || input.length > MAX_IMAGE_NAME_LENGTH)
    invalid(`图片名称不能超过 ${MAX_IMAGE_NAME_LENGTH} 个字符。`);
  return input.trim();
}

export function validateImageRename(input: unknown): { imageId: string; displayName: string } {
  const value = record(input);
  return {
    imageId: validateImageId(value.imageId),
    displayName: validateImageName(value.displayName),
  };
}

/** 归纳标识使用自己的提示文案：拿手记的校验函数会产生误导性的报错。 */
function topicIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) invalid('归纳标识不正确，请重新打开后重试。');
  return input;
}

function topicContent(value: Record<string, unknown>): { title: string; description: string } {
  if (typeof value.title !== 'string') invalid('请填写归纳标题。');
  const title = value.title.trim();
  if (!title) invalid('请填写归纳标题。');
  if (title.length > TOPIC_TITLE_MAX_LENGTH)
    invalid(`归纳标题不能超过 ${TOPIC_TITLE_MAX_LENGTH} 个字符。`);
  if (typeof value.description !== 'string') invalid('归纳说明须为文本。');
  if (value.description.length > TOPIC_DESCRIPTION_MAX_LENGTH)
    invalid(`归纳说明不能超过 ${TOPIC_DESCRIPTION_MAX_LENGTH} 个字符。`);
  return { title, description: value.description };
}

export function validateTopicCreate(input: unknown): TopicCreate {
  const value = record(input);
  if (typeof value.confirmDuplicate !== 'boolean') invalid('同名确认状态不正确。');
  return { ...topicContent(value), confirmDuplicate: value.confirmDuplicate };
}

export function validateTopicEdit(input: unknown): TopicEdit {
  const value = record(input);
  return {
    ...topicContent(value),
    id: topicIdentifier(value.id),
    expectedRevision: editRevision(value.expectedRevision),
  };
}

export function validateTopicId(input: unknown): string {
  return topicIdentifier(input);
}

export function validateTopicNotes(input: unknown): { topicId: string; noteIds: string[] } {
  const value = record(input);
  if (!Array.isArray(value.noteIds) || value.noteIds.length === 0) invalid('请选择要收录的手记。');
  if (value.noteIds.length > MAX_TOPIC_LINK_BATCH)
    invalid(`一次最多收录 ${MAX_TOPIC_LINK_BATCH} 条手记。`);
  return { topicId: topicIdentifier(value.topicId), noteIds: value.noteIds.map(identifier) };
}

export function validateTopicNote(input: unknown): { topicId: string; noteId: string } {
  const value = record(input);
  return { topicId: topicIdentifier(value.topicId), noteId: identifier(value.noteId) };
}

/** 事务标识使用自己的提示文案，避免复用手记校验时给出误导性报错。 */
function threadIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) invalid('事务标识不正确，请重新打开后重试。');
  return input;
}

function entryIdentifier(input: unknown): string {
  if (typeof input !== 'string' || !UUID.test(input)) invalid('动态标识不正确，请重新打开后重试。');
  return input;
}

function boundedText(input: unknown, max: number, message: string): string {
  if (typeof input !== 'string') invalid(message);
  if ((input as string).length > max) invalid(`${message}（上限 ${max} 个字符）`);
  return input as string;
}

function threadTitle(input: unknown): string {
  if (typeof input !== 'string') invalid('请填写事务标题。');
  const title = (input as string).trim();
  if (!title) invalid('请填写事务标题。');
  if (title.length > THREAD_TITLE_MAX_LENGTH)
    invalid(`事务标题不能超过 ${THREAD_TITLE_MAX_LENGTH} 个字符。`);
  return title;
}

function timelineOrder(input: unknown): TimelineOrder {
  if (input !== 'newest' && input !== 'oldest') invalid('时间线排序方式不正确。');
  return input;
}

function occurredAt(input: unknown): string {
  if (typeof input !== 'string' || Number.isNaN(new Date(input).getTime()))
    invalid('发生时间不正确，请重新选择。');
  return input as string;
}

/** 动态描述去空白后必须有内容；长度上限之外还要拒绝只有空白的输入。 */
function entrySummary(input: unknown): string {
  const value = boundedText(input, ENTRY_SUMMARY_MAX_LENGTH, '请填写动态描述。').trim();
  if (!value) invalid('请填写动态描述。');
  return value;
}

function entryTags(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 100) invalid('标签最多 100 个。');
  const tags: string[] = [];
  for (const tag of input as unknown[]) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > 100)
      invalid('每个标签须包含 1 至 100 个字符。');
    tags.push((tag as string).trim());
  }
  return [...new Set(tags)];
}

function referenceIds(input: unknown): string[] {
  if (!Array.isArray(input)) invalid('手记引用格式不正确。');
  const ids = input as unknown[];
  if (ids.length > MAX_REFERENCE_BATCH) invalid(`一次最多关联 ${MAX_REFERENCE_BATCH} 条手记。`);
  return [...new Set(ids.map((id) => identifier(id)))];
}

export function validateThreadCreate(input: unknown): ThreadCreate {
  const value = record(input);
  if (typeof value.confirmDuplicate !== 'boolean') invalid('同名确认状态不正确。');
  return {
    title: threadTitle(value.title),
    description: boundedText(value.description, THREAD_DESCRIPTION_MAX_LENGTH, '事务说明过长。'),
    summary: boundedText(value.summary, THREAD_SUMMARY_MAX_LENGTH, '当前概况过长。'),
    confirmDuplicate: value.confirmDuplicate,
  };
}

export function validateThreadEdit(input: unknown): ThreadEdit {
  const value = record(input);
  return {
    id: threadIdentifier(value.id),
    title: threadTitle(value.title),
    description: boundedText(value.description, THREAD_DESCRIPTION_MAX_LENGTH, '事务说明过长。'),
    summary: boundedText(value.summary, THREAD_SUMMARY_MAX_LENGTH, '当前概况过长。'),
    expectedRevision: editRevision(value.expectedRevision),
  };
}

export function validateThreadArchive(input: unknown): {
  threadId: string;
  archived: boolean;
  expectedRevision: number;
} {
  const value = record(input);
  if (typeof value.archived !== 'boolean') invalid('归档状态不正确。');
  return {
    threadId: threadIdentifier(value.threadId),
    archived: value.archived,
    expectedRevision: revision(value.expectedRevision),
  };
}

export function validateThreadNotes(input: unknown): { threadId: string; noteIds: string[] } {
  const value = record(input);
  if (!Array.isArray(value.noteIds) || value.noteIds.length === 0) invalid('请选择要关联的手记。');
  return { threadId: threadIdentifier(value.threadId), noteIds: referenceIds(value.noteIds) };
}

export function validateThreadNote(input: unknown): { threadId: string; noteId: string } {
  const value = record(input);
  return { threadId: threadIdentifier(value.threadId), noteId: identifier(value.noteId) };
}

export function validateIncludeArchived(input: unknown): boolean {
  if (typeof input !== 'boolean') invalid('归档筛选状态不正确。');
  return input;
}

export function validateEntriesQuery(input: unknown): {
  threadId: string;
  order: TimelineOrder;
} {
  const value = record(input);
  return { threadId: threadIdentifier(value.threadId), order: timelineOrder(value.order) };
}

export function validateEntryCreate(input: unknown): EntryCreate {
  const value = record(input);
  return {
    threadId: threadIdentifier(value.threadId),
    occurredAt: occurredAt(value.occurredAt),
    summary: entrySummary(value.summary),
    body: boundedText(value.body, ENTRY_BODY_MAX_LENGTH, '动态正文过长。'),
    tags: entryTags(value.tags),
    noteIds: referenceIds(value.noteIds ?? []),
  };
}

export function validateEntryEdit(input: unknown): EntryEdit {
  const value = record(input);
  return {
    id: entryIdentifier(value.id),
    occurredAt: occurredAt(value.occurredAt),
    summary: entrySummary(value.summary),
    body: boundedText(value.body, ENTRY_BODY_MAX_LENGTH, '动态正文过长。'),
    tags: entryTags(value.tags),
    expectedRevision: editRevision(value.expectedRevision),
  };
}

export function validateNoteReferences(input: unknown): string {
  return identifier(input);
}

/** 回收站引用：类型必须是四类之一，标识必须是合法 UUID。 */
export function validateTrashRef(input: unknown): TrashRef {
  const value = record(input);
  const kind = value.kind;
  if (typeof kind !== 'string' || !TRASH_KINDS.includes(kind as TrashKind))
    invalid('回收站内容类型不正确。');
  return { kind: kind as TrashKind, id: identifier(value.id) };
}

/** 目标路径必须是非空绝对路径；调用方（主进程对话框）已保证来源可信。 */
function absolutePath(input: unknown, message: string): string {
  if (typeof input !== 'string' || !input.trim() || !isAbsolute(input)) invalid(message);
  return input;
}

export function validateDestinationPath(input: unknown): string {
  return absolutePath(input, '请选择有效的目标位置。');
}

export function validateSourcePath(input: unknown): string {
  return absolutePath(input, '请选择有效的备份位置。');
}
