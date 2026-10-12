import { effectScope, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyDraft,
  type LibrarySnapshot,
  type Note,
  type NoteDraft,
  type NoteEdit,
} from '../../src/domain/note';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { NoteImageIndex, NoteImageList } from '../../src/domain/note-image';
import type { SearchResult } from '../../src/domain/search';
import type { TopicSummary } from '../../src/domain/topic';
import type { EntrySummary, NoteReference, ThreadSummary } from '../../src/domain/thread';
import type { RemovalImpact, TrashItem } from '../../src/domain/trash';
import type { BackupSummary, StagedRestore } from '../../src/storage/backup';
import type { ExportSummary } from '../../src/storage/export-store';
import type { Result } from '../../src/shared/errors';
import { useLibrary } from '../../src/renderer/src/composables/useLibrary';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';

interface Pending<Request, Response> {
  request: Request;
  resolve: (result: Result<Response>) => void;
}

function enqueue<Request, Response>(
  queue: Pending<Request, Response>[],
  request: Request,
): Promise<Result<Response>> {
  return new Promise((resolve) => {
    queue.push({ request, resolve });
  });
}

/** 归纳与事务的写入在本文件不参与用例：统一返回明确失败，避免测试替身伪造成功。 */
function unavailableTopic(): Result<TopicSummary> {
  return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入归纳写入。' } };
}

function unavailableThread(): Result<ThreadSummary> {
  return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入事务写入。' } };
}

function unavailableEntry(): Result<EntrySummary> {
  return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入动态写入。' } };
}

/** 每个写请求由测试显式应答，确保能观察真实请求之间继续输入的行为。 */
class ControlledApi implements MemocraftApi {
  readonly ai = disconnectedApi.ai;
  readonly platform = 'mac' as const;
  readonly draftWrites: Pending<NoteDraft, NoteDraft>[] = [];
  readonly commits: Pending<NoteDraft, Note>[] = [];
  readonly noteWrites: Pending<NoteEdit, Note>[] = [];

  constructor(private readonly snapshot: LibrarySnapshot = { draft: null, notes: [] }) {}

  async load(): Promise<Result<LibrarySnapshot>> {
    return { ok: true, value: this.snapshot };
  }
  saveDraft(request: NoteDraft): Promise<Result<NoteDraft>> {
    return enqueue(this.draftWrites, request);
  }
  commitDraft(request: NoteDraft): Promise<Result<Note>> {
    return enqueue(this.commits, request);
  }
  updateNote(request: NoteEdit): Promise<Result<Note>> {
    return enqueue(this.noteWrites, request);
  }
  async search(): Promise<Result<SearchResult>> {
    return { ok: true, value: { hits: [], hasMore: false } };
  }
  // 图集不在本文件覆盖范围内：这里只提供满足契约的空实现。
  async loadImages(): Promise<Result<NoteImageList>> {
    return { ok: true, value: { images: [], totalBytes: 0 } };
  }
  async loadImageIndex(): Promise<Result<NoteImageIndex>> {
    return { ok: true, value: {} };
  }
  async addImagesFromDialog(): Promise<Result<NoteImageList | null>> {
    return { ok: true, value: { images: [], totalBytes: 0 } };
  }
  async addImageFromClipboard(): Promise<Result<NoteImageList>> {
    return { ok: true, value: { images: [], totalBytes: 0 } };
  }
  async renameImage(): Promise<Result<NoteImageList>> {
    return { ok: true, value: { images: [], totalBytes: 0 } };
  }
  async deleteImage(): Promise<Result<NoteImageList>> {
    return { ok: true, value: { images: [], totalBytes: 0 } };
  }
  // 归纳同样不在本文件覆盖范围内：只为满足契约，读取返回空、写入返回失败，不伪造成功。
  async loadTopics(): Promise<Result<TopicSummary[]>> {
    return { ok: true, value: [] };
  }
  async createTopic(): Promise<Result<TopicSummary>> {
    return unavailableTopic();
  }
  async updateTopic(): Promise<Result<TopicSummary>> {
    return unavailableTopic();
  }
  async loadTrash(): Promise<Result<TrashItem[]>> {
    return { ok: true, value: [] };
  }
  async loadRemovalImpact(): Promise<Result<RemovalImpact>> {
    return {
      ok: false,
      error: { code: 'UNAVAILABLE', message: '测试替身未接入回收站。' },
    };
  }
  async removeItem(): Promise<Result<null>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入回收站。' } };
  }
  async restoreItem(): Promise<Result<null>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入回收站。' } };
  }
  // 备份、恢复与导出需要在真实文件系统上进行，由集成与桌面流程覆盖。
  async backupLibrary(): Promise<Result<BackupSummary>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入数据管理。' } };
  }
  async restoreLibrary(): Promise<Result<StagedRestore>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入数据管理。' } };
  }
  async applyRestore(): Promise<Result<null>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入数据管理。' } };
  }
  async exportLibrary(): Promise<Result<ExportSummary>> {
    return { ok: false, error: { code: 'UNAVAILABLE', message: '测试替身未接入数据管理。' } };
  }
  onNotice(): () => void {
    return () => undefined;
  }
  async addNotesToTopic(): Promise<Result<TopicSummary>> {
    return unavailableTopic();
  }
  async removeNoteFromTopic(): Promise<Result<TopicSummary>> {
    return unavailableTopic();
  }
  // 长期事务与动态同样不在本文件覆盖范围内。
  async loadThreads(): Promise<Result<ThreadSummary[]>> {
    return { ok: true, value: [] };
  }
  async createThread(): Promise<Result<ThreadSummary>> {
    return unavailableThread();
  }
  async updateThread(): Promise<Result<ThreadSummary>> {
    return unavailableThread();
  }
  async archiveThread(): Promise<Result<ThreadSummary>> {
    return unavailableThread();
  }
  async addNotesToThread(): Promise<Result<ThreadSummary>> {
    return unavailableThread();
  }
  async removeNoteFromThread(): Promise<Result<ThreadSummary>> {
    return unavailableThread();
  }
  async loadEntries(): Promise<Result<EntrySummary[]>> {
    return { ok: true, value: [] };
  }
  async createEntry(): Promise<Result<EntrySummary>> {
    return unavailableEntry();
  }
  async updateEntry(): Promise<Result<EntrySummary>> {
    return unavailableEntry();
  }
  async loadNoteReferences(): Promise<Result<NoteReference[]>> {
    return { ok: true, value: [] };
  }
  onCloseRequested(): () => void {
    return () => undefined;
  }
  onCloseCancelled(): () => void {
    return () => undefined;
  }
  closeReady(): void {
    return;
  }
  closeCancelled(): void {
    return;
  }
}

function pending<Request, Response>(
  queue: Pending<Request, Response>[],
  index = 0,
): Pending<Request, Response> {
  const item = queue[index];
  if (!item) throw new Error(`预期第 ${index + 1} 个写请求已经发出`);
  return item;
}

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}
function failure<T>(): Result<T> {
  return { ok: false, error: { code: 'STORAGE', message: '测试写入失败，输入仍保留。' } };
}

const timestamp = '2026-09-20T10:00:00.000Z';
function note(overrides: Partial<Note> = {}): Note {
  return {
    id: crypto.randomUUID(),
    title: '',
    body: '原有手记',
    category: 'insight',
    tags: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
function committed(draft: NoteDraft): Note {
  return note({
    id: draft.id,
    title: draft.title,
    body: draft.body,
    category: draft.category,
    tags: [...draft.tags],
  });
}
function updated(edit: NoteEdit): Note {
  return note({
    id: edit.id,
    title: edit.title,
    body: edit.body,
    category: edit.category,
    tags: [...edit.tags],
    revision: edit.expectedRevision + 1,
    updatedAt: '2026-09-20T10:01:00.000Z',
  });
}

const scopes: EffectScope[] = [];
async function setup(snapshot?: LibrarySnapshot) {
  const api = new ControlledApi(snapshot);
  const scope = effectScope();
  scopes.push(scope);
  const library = scope.run(() => useLibrary(api));
  if (!library) throw new Error('Vue 作用域未创建');
  await library.initialize();
  return { api, library };
}

// API 应答需依次穿过 persist、flush 和提交协调器；不推进防抖时钟。
async function settleResponses(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  vi.useRealTimers();
});

describe('首页草稿并发与提交', () => {
  it('保存期间继续输入不会被旧应答覆盖，flush 等到最新版本落盘', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '第一段', tags: ['原标签'] });
    const flushing = library.flushDraft();
    const first = pending(api.draftWrites);
    library.changeDraft({ body: '第一段，以及继续输入', tags: ['新标签'] });
    expect(api.draftWrites).toHaveLength(1);
    expect(first.request.body).toBe('第一段');
    first.resolve(success(first.request));
    await settleResponses();
    expect(library.draft.value.body).toBe('第一段，以及继续输入');
    expect(library.draft.value.tags).toEqual(['新标签']);
    const second = pending(api.draftWrites, 1);
    expect(second.request.revision).toBe(first.request.revision + 1);
    expect(second.request.body).toBe(library.draft.value.body);
    let finished = false;
    void flushing.then(() => {
      finished = true;
    });
    await settleResponses();
    expect(finished).toBe(false);
    second.resolve(success(second.request));
    expect(await flushing).toBe(true);
    expect(library.draftStatus.value).toBe('草稿已保存');
  });

  it('保存失败保留正文和版本，重试发送同一份草稿并清除错误', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '必须保留的内容', category: 'todo' });
    const firstFlush = library.flushDraft();
    const first = pending(api.draftWrites);
    first.resolve(failure());
    expect(await firstFlush).toBe(false);
    expect(library.draft.value).toEqual(first.request);
    expect(library.draftError.value).toContain('测试写入失败');
    const retry = library.flushDraft();
    const second = pending(api.draftWrites, 1);
    expect(second.request).toEqual(first.request);
    second.resolve(success(second.request));
    expect(await retry).toBe(true);
    expect(library.draftError.value).toBe('');
  });

  it('清空已恢复草稿保留 ID 并提高 revision，真实发送空载荷', async () => {
    const restored = { ...emptyDraft(crypto.randomUUID()), body: '旧内容', revision: 7 };
    const { api, library } = await setup({ draft: restored, notes: [] });
    library.changeDraft({ body: '', title: '', tags: [] });
    await vi.advanceTimersByTimeAsync(450);
    const write = pending(api.draftWrites);
    expect(write.request.id).toBe(restored.id);
    expect(write.request.revision).toBe(8);
    expect(write.request.body).toBe('');
    write.resolve(success(write.request));
    expect(await library.flushDraft()).toBe(true);
    expect(library.draft.value.id).toBe(restored.id);
    expect(library.draftStatus.value).toBe('空白草稿已保存');
  });

  it('连续提交只生成一次 API 请求，成功后再清空并创建新 ID', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '保存为正式手记' });
    const originalId = library.draft.value.id;
    const firstCommit = library.commit();
    const duplicateCommit = library.commit();
    expect(library.submitting.value).toBe(true);
    expect(api.draftWrites).toHaveLength(1);
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    expect(api.commits).toHaveLength(1);
    expect(library.draft.value.body).toBe('保存为正式手记');
    const commit = pending(api.commits);
    const saved = committed(commit.request);
    commit.resolve(success(saved));
    expect(await firstCommit).toEqual(saved);
    expect(await duplicateCommit).toEqual(saved);
    expect(library.notes.value).toEqual([saved]);
    expect(library.draft.value.body).toBe('');
    expect(library.draft.value.id).not.toBe(originalId);
    expect(library.submitting.value).toBe(false);
  });

  it('提交失败保留已持久化草稿，重试沿用 ID 且不重复创建列表项', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '失败仍保留的手记' });
    const firstCommit = library.commit();
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    const first = pending(api.commits);
    first.resolve(failure());
    expect(await firstCommit).toBeNull();
    expect(library.draft.value).toEqual(first.request);
    expect(library.notes.value).toEqual([]);
    expect(library.draftError.value).toContain('测试写入失败');
    const retry = library.commit();
    await settleResponses();
    expect(api.draftWrites).toHaveLength(1);
    const second = pending(api.commits, 1);
    expect(second.request).toEqual(first.request);
    const saved = committed(second.request);
    second.resolve(success(saved));
    expect(await retry).toEqual(saved);
    expect(library.notes.value).toEqual([saved]);
  });

  it('提交实际成功但响应失败后继续编辑，重试确认原结果并保存追加内容', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '第一份正式提交内容' });
    const initialCommit = library.commit();
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    const initialSubmission = pending(api.commits);
    const storedNote = committed(initialSubmission.request);
    // 数据库已成功提交；这里模拟连接中断导致客户端只收到失败。
    initialSubmission.resolve(failure());
    expect(await initialCommit).toBeNull();
    library.changeDraft({ body: '第一份正式提交内容，失败提示后又追加了一段' });
    const retry = library.commit();
    await settleResponses();
    expect(api.commits).toHaveLength(2);
    expect(api.draftWrites).toHaveLength(1);
    const confirmation = pending(api.commits, 1);
    expect(confirmation.request).toEqual(initialSubmission.request);
    confirmation.resolve(success(storedNote));
    await settleResponses();
    expect(library.draft.value.body).toBe('第一份正式提交内容，失败提示后又追加了一段');
    const additionalEdit = pending(api.noteWrites);
    expect(additionalEdit.request.id).toBe(storedNote.id);
    expect(additionalEdit.request.expectedRevision).toBe(storedNote.revision);
    expect(additionalEdit.request.body).toBe('第一份正式提交内容，失败提示后又追加了一段');
    const saved = updated(additionalEdit.request);
    additionalEdit.resolve(success(saved));
    expect(await retry).toEqual(saved);
    expect(library.notes.value).toEqual([saved]);
    expect(library.draft.value.body).toBe('');
    expect(library.draft.value.id).not.toBe(storedNote.id);
  });

  it('追加更新的响应也不确定时，先重放确定快照，再保存最新输入', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '原始提交' });
    const firstCommit = library.commit();
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    const submission = pending(api.commits);
    const originalNote = committed(submission.request);
    submission.resolve(failure());
    expect(await firstCommit).toBeNull();

    library.changeDraft({ body: '原始提交加第一次追加' });
    await vi.advanceTimersByTimeAsync(450);
    expect(api.draftWrites).toHaveLength(1);
    const retry = library.commit();
    await settleResponses();
    const confirmation = pending(api.commits, 1);
    confirmation.resolve(success(originalNote));
    await settleResponses();
    const firstEdit = pending(api.noteWrites);
    const alreadyUpdatedNote = updated(firstEdit.request);
    firstEdit.resolve(failure());
    expect(await retry).toBeNull();
    expect(library.draft.value.body).toBe('原始提交加第一次追加');

    library.changeDraft({ body: '原始提交加第一次追加，再加第二次追加' });
    await vi.advanceTimersByTimeAsync(450);
    expect(api.draftWrites).toHaveLength(1);
    const finalRetry = library.commit();
    await settleResponses();
    expect(api.commits).toHaveLength(2);
    const editConfirmation = pending(api.noteWrites, 1);
    expect(editConfirmation.request).toEqual(firstEdit.request);
    editConfirmation.resolve(success(alreadyUpdatedNote));
    await settleResponses();
    expect(library.draft.value.body).toBe('原始提交加第一次追加，再加第二次追加');
    const finalEdit = pending(api.noteWrites, 2);
    expect(finalEdit.request.expectedRevision).toBe(alreadyUpdatedNote.revision);
    expect(finalEdit.request.body).toBe('原始提交加第一次追加，再加第二次追加');
    const finalNote = updated(finalEdit.request);
    finalEdit.resolve(success(finalNote));
    expect(await finalRetry).toEqual(finalNote);
    expect(library.notes.value).toEqual([finalNote]);
    expect(library.draft.value.body).toBe('');
  });

  it('未确认提交后清空正文，关闭前确认旧手记并持久化新的空白草稿', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '已经保存但尚未确认的旧正文' });
    const firstCommit = library.commit();
    const initialDraftWrite = pending(api.draftWrites);
    initialDraftWrite.resolve(success(initialDraftWrite.request));
    await settleResponses();
    const submission = pending(api.commits);
    const storedNote = committed(submission.request);
    submission.resolve(failure());
    expect(await firstCommit).toBeNull();

    library.changeDraft({
      body: '',
      title: '准备写下一条',
      category: 'misc',
      tags: ['下一条'],
      extrasOpen: true,
    });
    const clearedInput = { ...library.draft.value, tags: [...library.draft.value.tags] };
    let finished = false;
    const flushing = library.flushAll().then((result) => {
      finished = true;
      return result;
    });
    await settleResponses();
    const confirmation = pending(api.commits, 1);
    expect(confirmation.request).toEqual(submission.request);
    confirmation.resolve(success(storedNote));
    await settleResponses();
    expect(api.noteWrites).toHaveLength(0);
    expect(library.notes.value).toEqual([storedNote]);
    expect(library.draft.value.body).toBe('');
    expect(library.draft.value.id).not.toBe(storedNote.id);
    expect(library.draft.value.revision).toBe(1);
    const newDraftWrite = pending(api.draftWrites, 1);
    expect(newDraftWrite.request).toEqual({
      ...clearedInput,
      id: library.draft.value.id,
      revision: 1,
    });
    expect(finished).toBe(false);
    newDraftWrite.resolve(success(newDraftWrite.request));
    expect(await flushing).toBe(true);
    expect(library.draft.value).toEqual(newDraftWrite.request);
    expect(library.draftError.value).toBe('');
  });

  it('提交前草稿保存失败时停止正式提交，输入仍可重试', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '尚未落盘' });
    const commit = library.commit();
    pending(api.draftWrites).resolve(failure());
    expect(await commit).toBeNull();
    expect(api.commits).toHaveLength(0);
    expect(library.draft.value.body).toBe('尚未落盘');
    expect(library.submitting.value).toBe(false);
  });
});

describe('已有手记编辑与离开前保存', () => {
  it('手记编辑和关闭抽屉不覆盖或清空首页草稿', async () => {
    const home = {
      ...emptyDraft(crypto.randomUUID()),
      body: '首页草稿',
      revision: 3,
      tags: ['首页'],
    };
    const existing = note({ tags: ['原标签'] });
    const { api, library } = await setup({ draft: home, notes: [existing] });
    expect(await library.openNote(existing)).toBe(true);
    library.changeNote({ body: '抽屉新正文', tags: ['新标签'] });
    expect(library.notes.value[0]).toEqual(existing);
    const closing = library.closeNote();
    const write = pending(api.noteWrites);
    write.resolve(success(updated(write.request)));
    expect(await closing).toBe(true);
    expect(library.editing.value).toBeNull();
    expect(library.draft.value).toEqual(home);
    expect(api.draftWrites).toHaveLength(0);
    expect(library.notes.value[0]?.body).toBe('抽屉新正文');
  });

  it('已有手记请求途中继续编辑，串行保存并使用上次成功的 revision', async () => {
    const existing = note({ revision: 4 });
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '第一版修改' });
    const flushing = library.flushNote();
    const first = pending(api.noteWrites);
    expect(first.request.expectedRevision).toBe(4);
    library.changeNote({ body: '第一版后继续输入', category: 'done' });
    expect(api.noteWrites).toHaveLength(1);
    first.resolve(success(updated(first.request)));
    await settleResponses();
    expect(library.editing.value?.body).toBe('第一版后继续输入');
    expect(library.editing.value?.category).toBe('done');
    const second = pending(api.noteWrites, 1);
    expect(second.request.expectedRevision).toBe(5);
    expect(second.request.body).toBe('第一版后继续输入');
    expect(library.notes.value[0]?.body).toBe('第一版修改');
    second.resolve(success(updated(second.request)));
    expect(await flushing).toBe(true);
    expect(library.editing.value?.revision).toBe(6);
    expect(library.notes.value[0]?.body).toBe('第一版后继续输入');
  });

  it('已有手记保存失败不能关闭，重试保留正文与 expectedRevision', async () => {
    const existing = note();
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '修改但未保存' });
    const closing = library.closeNote();
    const first = pending(api.noteWrites);
    first.resolve(failure());
    expect(await closing).toBe(false);
    expect(library.editing.value?.body).toBe('修改但未保存');
    expect(library.noteError.value).toContain('测试写入失败');
    const retry = library.closeNote();
    const second = pending(api.noteWrites, 1);
    expect(second.request).toEqual(first.request);
    second.resolve(success(updated(second.request)));
    expect(await retry).toBe(true);
    expect(library.editing.value).toBeNull();
  });

  it('抽屉更新响应不确定后继续输入，先确认旧更新再写入最新正文', async () => {
    const existing = note();
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '数据库已经保存的修改' });
    const firstFlush = library.flushNote();
    const first = pending(api.noteWrites);
    const stored = updated(first.request);
    first.resolve(failure());
    expect(await firstFlush).toBe(false);
    library.changeNote({ body: '数据库已经保存的修改，加上新输入' });
    const retry = library.flushNote();
    const confirmation = pending(api.noteWrites, 1);
    expect(confirmation.request).toEqual(first.request);
    confirmation.resolve(success(stored));
    await settleResponses();
    expect(library.editing.value?.body).toBe('数据库已经保存的修改，加上新输入');
    const finalWrite = pending(api.noteWrites, 2);
    expect(finalWrite.request.expectedRevision).toBe(stored.revision);
    expect(finalWrite.request.body).toBe('数据库已经保存的修改，加上新输入');
    finalWrite.resolve(success(updated(finalWrite.request)));
    expect(await retry).toBe(true);
    expect(library.notes.value[0]?.body).toBe('数据库已经保存的修改，加上新输入');
  });

  it('抽屉空正文校验明确失败后，重新输入可以保存而不重放无效正文', async () => {
    const existing = note();
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '' });
    const invalidFlush = library.flushNote();
    pending(api.noteWrites).resolve({
      ok: false,
      error: { code: 'VALIDATION', message: '正文不能为空' },
    });
    expect(await invalidFlush).toBe(false);
    library.changeNote({ body: '重新输入的有效正文' });
    const retry = library.flushNote();
    const corrected = pending(api.noteWrites, 1);
    expect(corrected.request.body).toBe('重新输入的有效正文');
    expect(corrected.request.expectedRevision).toBe(existing.revision);
    corrected.resolve(success(updated(corrected.request)));
    expect(await retry).toBe(true);
    expect(library.noteError.value).toBe('');
  });

  it('flushAll 查证未确认提交仍失败时返回 false，不能报告关闭前保存成功', async () => {
    const { api, library } = await setup();
    library.changeDraft({ body: '未确认的提交内容' });
    const firstCommit = library.commit();
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    const submission = pending(api.commits);
    submission.resolve(failure());
    expect(await firstCommit).toBeNull();
    const flushing = library.flushAll();
    await settleResponses();
    const confirmation = pending(api.commits, 1);
    expect(confirmation.request).toEqual(submission.request);
    confirmation.resolve(failure());
    expect(await flushing).toBe(false);
    expect(library.draft.value.body).toBe('未确认的提交内容');
    expect(api.draftWrites).toHaveLength(1);
  });

  it('flushAll 等待正在提交的手记及抽屉编辑完成后才报告成功', async () => {
    const existing = note();
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '同时修改已有手记' });
    library.changeDraft({ body: '同时提交新手记' });
    const commit = library.commit();
    let flushed = false;
    const flushing = library.flushAll().then((result) => {
      flushed = true;
      return result;
    });
    const draftWrite = pending(api.draftWrites);
    draftWrite.resolve(success(draftWrite.request));
    await settleResponses();
    expect(flushed).toBe(false);
    const submission = pending(api.commits);
    submission.resolve(success(committed(submission.request)));
    await commit;
    await settleResponses();
    expect(flushed).toBe(false);
    const noteWrite = pending(api.noteWrites);
    noteWrite.resolve(success(updated(noteWrite.request)));
    expect(await flushing).toBe(true);
    expect(library.notes.value).toHaveLength(2);
    expect(library.notes.value.find((item) => item.id === existing.id)?.body).toBe(
      '同时修改已有手记',
    );
  });

  it('flushAll 等待编辑请求途中追加内容，且保存失败返回 false', async () => {
    const existing = note();
    const { api, library } = await setup({ draft: null, notes: [existing] });
    await library.openNote(existing);
    library.changeNote({ body: '第一次修改' });
    const editFlush = library.flushNote();
    const allFlush = library.flushAll();
    library.changeNote({ body: '请求途中继续修改' });
    const first = pending(api.noteWrites);
    first.resolve(success(updated(first.request)));
    await settleResponses();
    const second = pending(api.noteWrites, 1);
    second.resolve(failure());
    expect(await editFlush).toBe(false);
    expect(await allFlush).toBe(false);
    expect(library.editing.value?.body).toBe('请求途中继续修改');
    expect(library.noteError.value).toContain('测试写入失败');
  });
});
