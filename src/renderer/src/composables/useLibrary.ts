import { onScopeDispose, ref, shallowRef } from 'vue';
import {
  emptyDraft,
  type Note,
  type NoteContent,
  type NoteDraft,
  type NoteEdit,
} from '../../../domain/note';
import type { MemocraftApi } from '../../../shared/contracts';
import { AppError, type Result } from '../../../shared/errors';

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.value;
}

// 为请求截取普通数据快照，标签数组也复制，隔离之后的响应式编辑。
function contentCopy(content: NoteContent): NoteContent {
  return {
    body: content.body,
    title: content.title,
    category: content.category,
    tags: [...content.tags],
  };
}

function draftCopy(draft: NoteDraft): NoteDraft {
  return {
    ...contentCopy(draft),
    id: draft.id,
    revision: draft.revision,
    extrasOpen: draft.extrasOpen,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof AppError ? error.message : '保存未完成，输入仍在。请重试。';
}

/** 编辑现场独立于已提交列表。定时器只触发保存，不能决定成功或清空内容。 */
export function useLibrary(api: MemocraftApi) {
  const notes = ref<Note[]>([]);
  const draft = ref(emptyDraft(crypto.randomUUID()));
  const editing = ref<Note | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref('');
  const draftStatus = ref('');
  const draftError = ref('');
  const noteStatus = ref('');
  const noteError = ref('');
  const submitting = ref(false);
  const latestSavedId = ref<string | null>(null);
  const changeVersion = ref(0);
  let savedDraftRevision = 0;
  // 本地编辑计数与数据库 revision 分开，才能识别请求途中继续输入的内容。
  let editVersion = 0;
  let savedEditVersion = 0;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let draftFlight: Promise<boolean> | null = null;
  let noteFlight: Promise<boolean> | null = null;
  let pendingNoteEdit: { request: NoteEdit; version: number } | null = null;
  // 请求可能已落盘但响应丢失。先用相同操作查明结果，再提交之后输入的内容。
  let pendingCommit: { snapshot: NoteDraft; note?: Note; edit?: NoteEdit } | null = null;
  const submission = shallowRef<Promise<Note | null> | null>(null);

  function updateList(note: Note) {
    notes.value = [note, ...notes.value.filter((item) => item.id !== note.id)].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    changeVersion.value += 1;
  }

  async function initialize() {
    if (loading.value || loaded.value) return;
    await loadSnapshot();
  }

  /** 重新读取库快照；删除手记等改变集合的操作必须用它，不能用只生效一次的 initialize。 */
  async function reload() {
    if (loading.value) return;
    await loadSnapshot();
  }

  async function loadSnapshot() {
    loading.value = true;
    loadError.value = '';
    try {
      const snapshot = unwrap(await api.load());
      notes.value = snapshot.notes;
      draft.value = snapshot.draft ?? emptyDraft(crypto.randomUUID());
      savedDraftRevision = draft.value.revision;
      draftStatus.value = snapshot.draft?.body ? '已恢复上次草稿' : '';
      loaded.value = true;
    } catch (error) {
      // 加载失败不涉及保存现场；未知错误不能承诺输入已经保留。
      loadError.value = error instanceof AppError ? error.message : '知识库暂时无法读取，请重试。';
    } finally {
      loading.value = false;
    }
  }

  function changeDraft(patch: Partial<NoteContent & { extrasOpen: boolean }>) {
    if (!loaded.value || submitting.value) return;
    draft.value = { ...draft.value, ...patch, revision: draft.value.revision + 1 };
    draftStatus.value = '正在保存草稿…';
    draftError.value = '';
    clearTimeout(draftTimer);
    // 提交结果未明时先保留现场，不能向可能已转为手记的 ID 自动写草稿。
    if (pendingCommit) {
      draftStatus.value = '';
      draftError.value = '上次保存结果尚未确认，追加内容仍保留。请再次保存手记。';
      return;
    }
    draftTimer = setTimeout(() => {
      void flushDraft();
    }, 450);
  }

  async function persistDraft(): Promise<boolean> {
    try {
      // 一次只写一个快照；成功后继续追上最新输入，再报告保存完成。
      while (savedDraftRevision < draft.value.revision) {
        const snapshot = draftCopy(draft.value);
        const saved = unwrap(await api.saveDraft(snapshot));
        if (saved.revision !== snapshot.revision) {
          throw new AppError(
            'CONFLICT',
            '草稿已有其他修改，当前输入仍保留，请重新打开应用前先复制内容。',
          );
        }
        savedDraftRevision = saved.revision;
      }
      draftError.value = '';
      draftStatus.value =
        draft.value.body.trim() || draft.value.title.trim() ? '草稿已保存' : '空白草稿已保存';
      return true;
    } catch (error) {
      draftError.value = errorMessage(error);
      draftStatus.value = '';
      return false;
    }
  }

  async function flushDraft(): Promise<boolean> {
    clearTimeout(draftTimer);
    if (pendingCommit) return false;
    // 自动保存、切页和提交共享正在进行的写入，避免并行更新同一草稿。
    if (draftFlight) return draftFlight;
    if (savedDraftRevision === draft.value.revision) return true;
    draftFlight = persistDraft();
    try {
      return await draftFlight;
    } finally {
      draftFlight = null;
    }
  }

  /**
   * 确保草稿行已经落盘：图片等附属内容要归属草稿，写入之前这一行必须存在。
   * 与自动保存不同，内容没变时也要写一次——调用方要的是「归属存在」这个事实。
   */
  async function ensureDraftStored(): Promise<boolean> {
    clearTimeout(draftTimer);
    if (pendingCommit) {
      draftError.value = '上次保存结果尚未确认，当前内容仍保留；请稍后再添加图片。';
      return false;
    }
    if (draftFlight) return draftFlight;
    draftFlight = storeDraftOnce();
    try {
      return await draftFlight;
    } finally {
      draftFlight = null;
    }
  }

  async function storeDraftOnce(): Promise<boolean> {
    try {
      const snapshot = draftCopy(draft.value);
      const saved = unwrap(await api.saveDraft(snapshot));
      // 服务端返回别的版本说明草稿已被改写：不能把当前内容当成已保存。
      if (saved.revision !== snapshot.revision)
        throw new AppError('CONFLICT', '草稿已有其他修改，请重新打开后核对。');
      savedDraftRevision = Math.max(savedDraftRevision, saved.revision);
      draftError.value = '';
      return true;
    } catch (error) {
      draftError.value = errorMessage(error);
      return false;
    }
  }

  async function commit(): Promise<Note | null> {
    if (submission.value) return submission.value;
    if (!draft.value.body.trim() && !pendingCommit) {
      draftError.value = '正文还是空的，写点什么再保存。';
      return null;
    }
    submitting.value = true;
    submission.value = (async () => {
      try {
        if (!pendingCommit) {
          if (!(await flushDraft())) return null;
          pendingCommit = { snapshot: draftCopy(draft.value) };
        }
        const pending = pendingCommit;
        // 重放原请求查明结果，再保存追加输入；重试时不重新生成 ID。
        pending.note ??= unwrap(await api.commitDraft(pending.snapshot));
        if (pending.edit) {
          pending.note = unwrap(await api.updateNote(pending.edit));
          pending.edit = undefined;
        }
        const clearedAfterSubmission = !draft.value.body.trim();
        if (
          !clearedAfterSubmission &&
          JSON.stringify(contentCopy(pending.note)) !== JSON.stringify(contentCopy(draft.value))
        ) {
          pending.edit = {
            ...contentCopy(draft.value),
            id: pending.note.id,
            expectedRevision: pending.note.revision,
          };
          pending.note = unwrap(await api.updateNote(pending.edit));
          pending.edit = undefined;
        }
        const note = pending.note;
        updateList(note);
        pendingCommit = null;
        // 提交后清空正文只表示开始空白草稿，不删除刚确认保存的手记。
        const nextDraft = emptyDraft(crypto.randomUUID());
        draft.value = clearedAfterSubmission
          ? {
              ...nextDraft,
              ...contentCopy(draft.value),
              extrasOpen: draft.value.extrasOpen,
              revision: 1,
            }
          : nextDraft;
        savedDraftRevision = 0;
        latestSavedId.value = note.id;
        draftStatus.value = '已保存到手记';
        draftError.value = '';
        if (clearedAfterSubmission)
          draftTimer = setTimeout(() => {
            void flushDraft();
          }, 450);
        return note;
      } catch (error) {
        // 校验失败明确没有写入，可以修正载荷；其他失败仍保留原请求查证。
        if (error instanceof AppError && error.code === 'VALIDATION' && pendingCommit) {
          if (pendingCommit.note) pendingCommit.edit = undefined;
          else pendingCommit = null;
        }
        draftError.value = errorMessage(error);
        return null;
      } finally {
        submitting.value = false;
      }
    })();
    try {
      return await submission.value;
    } finally {
      submission.value = null;
    }
  }

  async function openNote(note: Note): Promise<boolean> {
    if (!(await flushNote())) return false;
    const latest = notes.value.find((item) => item.id === note.id) ?? note;
    editing.value = { ...latest, tags: [...latest.tags] };
    editVersion = 0;
    savedEditVersion = 0;
    noteError.value = '';
    noteStatus.value = '';
    return true;
  }

  function changeNote(patch: Partial<NoteContent>) {
    if (!editing.value) return;
    editing.value = { ...editing.value, ...patch };
    editVersion += 1;
    noteError.value = '';
    noteStatus.value = '正在保存…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      void flushNote();
    }, 450);
  }

  async function persistNote(): Promise<boolean> {
    try {
      while (editing.value && savedEditVersion < editVersion) {
        const current = editing.value;
        pendingNoteEdit ??= {
          request: { ...contentCopy(current), id: current.id, expectedRevision: current.revision },
          version: editVersion,
        };
        const saved = unwrap(await api.updateNote(pendingNoteEdit.request));
        // 保留请求途中继续输入的正文，只推进服务端版本。
        editing.value = { ...editing.value, revision: saved.revision, updatedAt: saved.updatedAt };
        savedEditVersion = pendingNoteEdit.version;
        pendingNoteEdit = null;
        updateList(saved);
      }
      noteError.value = '';
      noteStatus.value = '已保存';
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'VALIDATION') pendingNoteEdit = null;
      noteError.value = errorMessage(error);
      noteStatus.value = '';
      return false;
    }
  }

  async function flushNote(): Promise<boolean> {
    clearTimeout(noteTimer);
    if (noteFlight) return noteFlight;
    if (!editing.value || savedEditVersion === editVersion) return true;
    noteFlight = persistNote();
    try {
      return await noteFlight;
    } finally {
      noteFlight = null;
    }
  }

  async function closeNote(): Promise<boolean> {
    if (!(await flushNote())) return false;
    editing.value = null;
    return true;
  }

  async function flushAll(): Promise<boolean> {
    // 离开前先确认正式提交，再保存两个独立编辑现场；任一步失败都阻止离开。
    if (submission.value) await submission.value;
    if (pendingCommit && !(await commit())) return false;
    const draftSaved = await flushDraft();
    const noteSaved = await flushNote();
    return draftSaved && noteSaved;
  }

  onScopeDispose(() => {
    clearTimeout(draftTimer);
    clearTimeout(noteTimer);
  });
  return {
    notes,
    reload,
    draft,
    editing,
    loaded,
    loading,
    loadError,
    draftStatus,
    draftError,
    noteStatus,
    noteError,
    submitting,
    latestSavedId,
    changeVersion,
    initialize,
    changeDraft,
    flushDraft,
    ensureDraftStored,
    commit,
    openNote,
    changeNote,
    flushNote,
    closeNote,
    flushAll,
  };
}
