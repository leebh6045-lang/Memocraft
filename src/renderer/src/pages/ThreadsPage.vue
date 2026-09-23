<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Note } from '../../../domain/note';
import {
  emptyThreadDraft,
  THREAD_STATUS_LABELS,
  type EntrySummary,
  type TimelineOrder,
} from '../../../domain/thread';
import AppDialog from '../components/AppDialog.vue';
import AppIcon from '../components/AppIcon.vue';
import EntryFields from '../components/EntryFields.vue';
import NoteCard from '../components/NoteCard.vue';
import NotePickerDialog from '../components/NotePickerDialog.vue';
import { formatFullTime, formatTime, fromDateTimeInput, toDateTimeInput } from '../format-time';
import { renderMarkdown } from '../markdown';
import type { ThreadState } from '../composables/useThreads';
import type { TrashState } from '../composables/useTrash';

const props = defineProps<{
  state: ThreadState;
  notes: Note[];
  busy: boolean;
  /** 删除走统一的回收站流程：先取影响面确认，再执行。 */
  trash: TrashState;
  /** 首页「新建事务」等入口通过递增该值请求打开新建对话框。 */
  createSignal: number;
  /** 每次进入模块都递增：与原型一致，点模块导航回到列表。 */
  navSignal: number;
  /** 手记抽屉里的引用请求打开某个事务；带动态 ID 时定位并短暂高亮那一条。 */
  openSignal: { id: string; entryId: string | null; nonce: number } | null;
}>();
const emit = defineEmits<{
  'open-note': [id: string];
  notify: [payload: { message: string; undo?: () => void }];
}>();

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const threads = props.state.threads;
const entries = props.state.entries;
const threadsError = props.state.error;
const threadsLoading = props.state.loading;
const includeArchived = props.state.includeArchived;

const view = ref<'list' | 'detail'>('list');
const activeId = ref<string | null>(null);
const activeThread = computed(
  () => threads.value.find((item) => item.id === activeId.value) ?? null,
);
const order = ref<TimelineOrder>('newest');

const creating = ref(false);
const draft = ref(emptyThreadDraft());
const duplicateHint = ref('');

const title = ref('');
const description = ref('');
const summary = ref('');
const saveStatus = ref('');
const saveError = ref('');
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let applyingRemote = false;

// 新建动态输入区
const composer = ref({ summary: '', occurredAt: '', body: '', tagsText: '' });
const composerNoteIds = ref<string[]>([]);
const composerOpen = ref(false);
const submittingEntry = ref(false);
const composerError = ref('');

// 编辑动态
const editingEntry = ref<EntrySummary | null>(null);
const editingDraft = ref({ summary: '', occurredAt: '', body: '', tagsText: '' });
const editingError = ref('');

// 引用手记的选择器
const picking = ref<null | 'composer' | 'thread'>(null);

const directNotes = computed(() => {
  const thread = activeThread.value;
  if (!thread) return [];
  const byId = new Map(props.notes.map((note) => [note.id, note]));
  return thread.noteIds
    .map((id) => byId.get(id))
    .filter((note): note is Note => note !== undefined);
});
const noteById = (id: string): Note | undefined => props.notes.find((note) => note.id === id);

function showDetail(threadId: string): void {
  const swap = () => {
    activeId.value = threadId;
    view.value = 'detail';
    composerNoteIds.value = [];
    composerOpen.value = false;
    composer.value = {
      summary: '',
      occurredAt: toDateTimeInput(new Date().toISOString()),
      body: '',
      tagsText: '',
    };
    syncEditingFields();
    void refreshEntries();
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  swap();
}

function backToList(): void {
  view.value = 'list';
  activeId.value = null;
  saveStatus.value = '';
  saveError.value = '';
  void props.state.load();
}

function syncEditingFields(): void {
  const thread = activeThread.value;
  applyingRemote = true;
  title.value = thread?.title ?? '';
  description.value = thread?.description ?? '';
  summary.value = thread?.summary ?? '';
  void nextTick(() => {
    applyingRemote = false;
  });
}

async function refreshEntries(): Promise<void> {
  const thread = activeThread.value;
  if (!thread) return;
  await props.state.loadEntries(thread.id, order.value);
}

async function openCreate(): Promise<void> {
  draft.value = emptyThreadDraft();
  duplicateHint.value = '';
  creating.value = true;
}

// 一次性意图：先声明状态与处理函数，再注册 watcher。
// immediate 回调在注册当刻同步执行，若声明写在后面会因暂时性死区而抛错。
let seenCreateSignal = 0;
function consumeCreateSignal(): void {
  if (props.createSignal === seenCreateSignal) return;
  seenCreateSignal = props.createSignal;
  if (props.createSignal > 0) void openCreate();
}

let seenOpenNonce = 0;
async function consumeOpenSignal(): Promise<void> {
  const signal = props.openSignal;
  if (!signal || signal.nonce === seenOpenNonce) return;
  seenOpenNonce = signal.nonce;
  if (!threads.value.some((item) => item.id === signal.id)) await props.state.load();
  if (!threads.value.some((item) => item.id === signal.id)) {
    // 目标可能是已归档事务：默认列表不含归档项，这里显式切到已归档再定位。
    await props.state.setIncludeArchived(true);
  }
  if (!threads.value.some((item) => item.id === signal.id)) return;
  showDetail(signal.id);
  if (!signal.entryId) return;
  // 等时间线渲染完成再滚动与高亮，避免定位到尚未出现的节点。
  await nextTick();
  const target = document.querySelector<HTMLElement>(`[data-entry-id="${signal.entryId}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'instant' : 'smooth' });
  target.classList.add('is-hl');
  setTimeout(() => target.classList.remove('is-hl'), 1800);
}

let seenNavSignal = 0;
function consumeNavSignal(): void {
  if (props.navSignal === seenNavSignal) return;
  seenNavSignal = props.navSignal;
  if (view.value === 'detail') backToList();
}

// 注册顺序即消费顺序：导航重置先执行，随后的创建／打开意图才能覆盖它。
// 反过来会让「从抽屉点引用跳进某条事务详情」被重置回列表。
watch(() => props.navSignal, consumeNavSignal, { immediate: true });
watch(() => props.createSignal, consumeCreateSignal, { immediate: true });
watch(() => props.openSignal?.nonce, consumeOpenSignal, { immediate: true });

async function submitCreate(confirmDuplicate = false): Promise<void> {
  const created = await props.state.create({
    title: draft.value.title,
    description: draft.value.description,
    summary: draft.value.summary,
    confirmDuplicate,
  });
  if (!created) {
    duplicateHint.value = threadsError.value;
    return;
  }
  creating.value = false;
  duplicateHint.value = '';
  emit('notify', { message: `已创建事务「${created.title}」` });
  showDetail(created.id);
}

/** 事务字段就地自动保存：编辑期间不阻塞输入，失败保留本地内容并提示。 */
function scheduleSave(): void {
  if (!activeThread.value || applyingRemote) return;
  clearTimeout(saveTimer);
  saveStatus.value = '正在保存…';
  saveError.value = '';
  saveTimer = setTimeout(() => {
    void saveEditing();
  }, 600);
}

async function saveEditing(): Promise<void> {
  const thread = activeThread.value;
  if (!thread) return;
  if (
    title.value.trim() === thread.title &&
    description.value === thread.description &&
    summary.value === thread.summary
  ) {
    saveStatus.value = '';
    return;
  }
  const updated = await props.state.update({
    id: thread.id,
    title: title.value,
    description: description.value,
    summary: summary.value,
    expectedRevision: thread.revision,
  });
  if (!updated) {
    saveError.value = threadsError.value;
    saveStatus.value = '';
    return;
  }
  saveStatus.value = `已保存 ${formatTime(new Date().toISOString())}`;
}

watch([title, description, summary], scheduleSave);

async function toggleArchive(): Promise<void> {
  const thread = activeThread.value;
  if (!thread) return;
  const updated = await props.state.setArchived(
    thread.id,
    thread.status === 'active',
    thread.revision,
  );
  if (!updated) {
    saveError.value = threadsError.value;
    return;
  }
  emit('notify', {
    message: updated.status === 'archived' ? '已归档，仍可搜索与查看' : '已重新启用',
  });
  if (updated.status === 'archived' && !includeArchived.value) backToList();
}

function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

async function submitEntry(): Promise<void> {
  const thread = activeThread.value;
  if (!thread || submittingEntry.value) return;
  const occurredAt = fromDateTimeInput(composer.value.occurredAt);
  if (!occurredAt) {
    composerError.value = '发生时间不正确，请重新选择。';
    return;
  }
  submittingEntry.value = true;
  composerError.value = '';
  try {
    const created = await props.state.createEntry({
      threadId: thread.id,
      occurredAt,
      summary: composer.value.summary,
      body: composer.value.body,
      tags: parseTags(composer.value.tagsText),
      noteIds: [...composerNoteIds.value],
    });
    if (!created) {
      composerError.value = threadsError.value;
      return;
    }
    // 提交成功后清空输入区并刷新时间线；计数与排序都由服务端结果决定。
    composer.value = {
      summary: '',
      occurredAt: toDateTimeInput(new Date().toISOString()),
      body: '',
      tagsText: '',
    };
    composerNoteIds.value = [];
    composerOpen.value = false;
    await refreshEntries();
    await props.state.load();
    emit('notify', { message: '已记录动态' });
  } finally {
    submittingEntry.value = false;
  }
}

/** 删除事务：确认后回到列表；动态与引用手记的处置由存储层保证。 */
async function removeThread(threadId: string): Promise<void> {
  const removed = await props.trash.requestRemoval('thread', threadId);
  if (removed) backToList();
}

/** 删除动态：确认后刷新时间线，引用手记不受影响。 */
async function removeEntry(entryId: string): Promise<void> {
  const removed = await props.trash.requestRemoval('entry', entryId);
  if (removed) {
    await refreshEntries();
    await props.state.load();
  }
}

function openEntryEditor(entry: EntrySummary): void {
  editingEntry.value = entry;
  editingError.value = '';
  editingDraft.value = {
    summary: entry.summary,
    occurredAt: toDateTimeInput(entry.occurredAt),
    body: entry.body,
    tagsText: entry.tags.join(', '),
  };
}

async function submitEntryEdit(): Promise<void> {
  const entry = editingEntry.value;
  if (!entry) return;
  const occurredAt = fromDateTimeInput(editingDraft.value.occurredAt);
  if (!occurredAt) {
    editingError.value = '发生时间不正确，请重新选择。';
    return;
  }
  const updated = await props.state.updateEntry({
    id: entry.id,
    occurredAt,
    summary: editingDraft.value.summary,
    body: editingDraft.value.body,
    tags: parseTags(editingDraft.value.tagsText),
    expectedRevision: entry.revision,
  });
  if (!updated) {
    editingError.value = threadsError.value;
    return;
  }
  editingEntry.value = null;
  emit('notify', { message: '动态已更新' });
}

async function switchOrder(next: TimelineOrder): Promise<void> {
  order.value = next;
  await refreshEntries();
}

async function confirmPick(noteIds: string[]): Promise<void> {
  const target = picking.value;
  picking.value = null;
  if (target === 'composer') {
    composerNoteIds.value = [...new Set([...composerNoteIds.value, ...noteIds])];
    return;
  }
  const thread = activeThread.value;
  if (!thread) return;
  if (await props.state.addNotes(thread.id, noteIds)) {
    emit('notify', {
      message: `已关联 ${noteIds.length} 条手记`,
      undo: () => {
        for (const noteId of noteIds) void props.state.removeNote(thread.id, noteId);
      },
    });
  }
}

async function removeDirectNote(noteId: string): Promise<void> {
  const thread = activeThread.value;
  if (!thread) return;
  if (await props.state.removeNote(thread.id, noteId)) {
    emit('notify', {
      message: '已取消关联，手记仍在随手记',
      undo: () => {
        void props.state.addNotes(thread.id, [noteId]);
      },
    });
  }
}

onBeforeUnmount(() => clearTimeout(saveTimer));
</script>

<template>
  <section class="view">
    <template v-if="view === 'list'">
      <header class="page-head">
        <div>
          <h1>长期事务</h1>
          <p class="sub">记录一件事的经历、进展与决策。</p>
        </div>
        <div class="actions">
          <button
            class="filter-btn"
            :aria-pressed="includeArchived"
            @click="props.state.setIncludeArchived(!includeArchived)"
          >
            已归档
          </button>
          <button class="btn-primary" :disabled="props.busy" @click="openCreate">
            <span aria-hidden="true">＋</span> 新建事务
          </button>
        </div>
      </header>

      <div v-if="threadsError && !threads.length" class="empty" role="alert">
        {{ threadsError }}<br />
        <button class="btn-ghost" @click="props.state.load()">重试读取</button>
      </div>
      <div v-else-if="threadsLoading && !threads.length" class="empty">正在读取事务…</div>
      <div v-else-if="!threads.length" class="empty">
        {{ includeArchived ? '还没有事务。' : '还没有进行中的事务。' }}<br />
        <button class="btn-ghost" @click="openCreate">新建第一个事务</button>
      </div>
      <div v-else class="grid">
        <button
          v-for="thread in threads"
          :key="thread.id"
          class="card collection"
          :class="{ archived: thread.status === 'archived' }"
          @click="showDetail(thread.id)"
        >
          <span class="status-pill" :class="{ active: thread.status === 'active' }">{{
            THREAD_STATUS_LABELS[thread.status]
          }}</span>
          <h3>{{ thread.title }}</h3>
          <p>{{ thread.summary || thread.description || '还没有概况' }}</p>
          <span class="meta-line"
            ><span>{{ thread.entryCount }} 条动态</span
            ><span>{{ formatTime(thread.updatedAt) }}</span></span
          >
        </button>
      </div>
    </template>

    <template v-else-if="activeThread">
      <button class="crumb" @click="backToList"><span aria-hidden="true">‹</span> 长期事务</button>
      <header class="page-head">
        <div class="thread-head">
          <h1>
            <input
              class="thread-title"
              aria-label="事务标题"
              :value="title"
              :disabled="props.busy"
              maxlength="300"
              @input="title = ($event.target as HTMLInputElement).value"
            />
            <span class="status-pill" :class="{ active: activeThread.status === 'active' }">{{
              THREAD_STATUS_LABELS[activeThread.status]
            }}</span>
          </h1>
          <input
            class="thread-desc"
            aria-label="事务说明"
            :value="description"
            :disabled="props.busy"
            maxlength="2000"
            placeholder="一句话说明这件事"
            @input="description = ($event.target as HTMLInputElement).value"
          />
          <div class="draft-status" :class="{ error: saveError }" aria-live="polite">
            <span v-if="saveError">{{ saveError }}</span>
            <span v-else-if="saveStatus">{{ saveStatus }}</span>
          </div>
        </div>
        <div class="actions">
          <button
            class="btn-quiet btn-danger"
            :disabled="props.busy"
            title="移到回收站"
            aria-label="移到回收站"
            @click="removeThread(activeThread.id)"
          >
            <AppIcon name="trash" class="icon-s" />
          </button>
          <button class="btn" :disabled="props.busy" @click="toggleArchive">
            {{ activeThread.status === 'active' ? '归档' : '重新启用' }}
          </button>
        </div>
      </header>

      <div class="summary-box">
        <label for="thread-summary">当前概况 · 由你维护，动态只记录历史</label>
        <textarea
          id="thread-summary"
          :value="summary"
          :disabled="props.busy"
          maxlength="4000"
          rows="2"
          placeholder="现在处于什么状态"
          @input="summary = ($event.target as HTMLTextAreaElement).value"
        />
      </div>

      <section v-if="activeThread.status === 'active'" class="composer">
        <input
          class="composer-summary"
          aria-label="动态描述"
          :value="composer.summary"
          :disabled="props.busy || submittingEntry"
          maxlength="300"
          placeholder="记一条动态：做了什么、想到什么、决定了什么…"
          @input="composer.summary = ($event.target as HTMLInputElement).value"
          @focus="composerOpen = true"
        />
        <div v-show="composerOpen" class="composer-more">
          <EntryFields
            v-model:summary="composer.summary"
            v-model:occurred-at="composer.occurredAt"
            v-model:body="composer.body"
            v-model:tags-text="composer.tagsText"
            :disabled="props.busy || submittingEntry"
            :show-summary="false"
          />
          <div class="composer-row">
            <div class="chip-row">
              <span v-for="noteId in composerNoteIds" :key="noteId" class="chip on"
                ><button class="chip-label" @click="emit('open-note', noteId)">
                  {{ noteById(noteId)?.title || '无标题手记' }}</button
                ><button
                  class="chip-x"
                  aria-label="取消引用"
                  @click="composerNoteIds = composerNoteIds.filter((id) => id !== noteId)"
                >
                  ×
                </button></span
              >
              <button class="inline-add" @click="picking = 'composer'">＋ 引用手记</button>
            </div>
            <button class="btn-primary" :disabled="submittingEntry" @click="submitEntry">
              {{ submittingEntry ? '正在记录…' : '记录动态' }}
            </button>
          </div>
        </div>
        <p v-if="composerError" class="composer-error" role="alert">{{ composerError }}</p>
      </section>

      <div class="timeline-head">
        <h2>动态 {{ activeThread.entryCount }}</h2>
        <div class="seg seg-sm">
          <button
            type="button"
            role="radio"
            :aria-checked="order === 'newest'"
            @click="switchOrder('newest')"
          >
            最近在前
          </button>
          <button
            type="button"
            role="radio"
            :aria-checked="order === 'oldest'"
            @click="switchOrder('oldest')"
          >
            最早在前
          </button>
        </div>
      </div>
      <ol v-if="!entries.length" class="empty">
        还没有动态。写下第一条，发生时间默认是现在。
      </ol>
      <ol v-else class="timeline">
        <li v-for="entry in entries" :key="entry.id" class="entry" :data-entry-id="entry.id">
          <button
            class="entry-remove"
            :disabled="props.busy"
            title="移到回收站"
            :aria-label="`删除动态：${entry.summary}`"
            @click="removeEntry(entry.id)"
          >
            <AppIcon name="trash" class="icon-s" />
          </button>
          <time :datetime="entry.occurredAt" :title="formatFullTime(entry.occurredAt)">{{
            formatTime(entry.occurredAt)
          }}</time>
          <h4>
            <button class="entry-title" @click="openEntryEditor(entry)">{{ entry.summary }}</button>
          </h4>
          <!-- 动态正文按 Markdown 安全渲染：关闭 HTML、图片与链接。 -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-if="entry.body" class="entry-body md" v-html="renderMarkdown(entry.body)" />
          <div v-if="entry.tags.length || entry.noteIds.length" class="entry-refs">
            <span v-if="entry.tags.length" class="tag">{{ entry.tags.join(' #') }}</span>
            <template v-if="entry.noteIds.length">
              <span>引用</span>
              <button
                v-for="noteId in entry.noteIds"
                :key="noteId"
                class="ref-chip"
                @click="emit('open-note', noteId)"
              >
                {{ noteById(noteId)?.title || '无标题手记' }}
              </button>
            </template>
          </div>
        </li>
      </ol>

      <section class="subsection">
        <div class="section-head"><h2>直接关联的手记</h2></div>
        <div class="chip-row">
          <button class="inline-add" :disabled="props.busy" @click="picking = 'thread'">
            ＋ 关联手记
          </button>
        </div>
        <p v-if="!directNotes.length" class="faint small">
          整个事务的参考资料放这里，不必为它虚构一条动态。
        </p>
        <div v-else class="grid">
          <div v-for="note in directNotes" :key="note.id" class="thread-note">
            <NoteCard :note="note" @open="emit('open-note', note.id)" />
            <button
              class="card-remove"
              :disabled="props.busy"
              title="取消关联，不删除手记"
              @click="removeDirectNote(note.id)"
            >
              移出
            </button>
          </div>
        </div>
      </section>
    </template>

    <AppDialog
      v-if="creating"
      title="新建事务"
      hint="标题必填，说明与当前概况可以稍后补。允许同名，稳定 ID 才是标识。"
      @close="creating = false"
    >
      <label class="field"
        >标题<input
          data-autofocus
          :value="draft.title"
          maxlength="300"
          placeholder="例如：个人服务器搭建与维护"
          @input="draft.title = ($event.target as HTMLInputElement).value"
      /></label>
      <label class="field"
        >说明（可选）<textarea
          :value="draft.description"
          rows="2"
          maxlength="2000"
          placeholder="这件事大概是什么"
          @input="draft.description = ($event.target as HTMLTextAreaElement).value"
        />
      </label>
      <label class="field"
        >当前概况（可选）<textarea
          :value="draft.summary"
          rows="2"
          maxlength="4000"
          placeholder="现在处于什么状态"
          @input="draft.summary = ($event.target as HTMLTextAreaElement).value"
        />
      </label>
      <p v-if="duplicateHint" class="hint duplicate-hint" role="alert">{{ duplicateHint }}</p>
      <template #footer>
        <button class="btn-quiet" @click="creating = false">取消</button>
        <button
          v-if="duplicateHint"
          class="btn-primary"
          :disabled="props.busy"
          @click="submitCreate(true)"
        >
          仍要创建
        </button>
        <button v-else class="btn-primary" :disabled="props.busy" @click="submitCreate(false)">
          创建
        </button>
      </template>
    </AppDialog>

    <AppDialog
      v-if="editingEntry"
      title="编辑动态"
      hint="改动只影响这条动态；被引用的手记内容不会被改写。"
      @close="editingEntry = null"
    >
      <EntryFields
        v-model:summary="editingDraft.summary"
        v-model:occurred-at="editingDraft.occurredAt"
        v-model:body="editingDraft.body"
        v-model:tags-text="editingDraft.tagsText"
        :textarea-rows="4"
      />
      <p v-if="editingError" class="hint duplicate-hint" role="alert">{{ editingError }}</p>
      <template #footer>
        <button class="btn-quiet" @click="editingEntry = null">取消</button>
        <button class="btn-primary" @click="submitEntryEdit">保存</button>
      </template>
    </AppDialog>

    <NotePickerDialog
      v-if="picking"
      :notes="props.notes"
      :collected-ids="picking === 'thread' ? (activeThread?.noteIds ?? []) : composerNoteIds"
      :busy="props.busy"
      @confirm="confirmPick"
      @close="picking = null"
    />
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.card.archived {
  opacity: 0.7;
}
.thread-head {
  min-width: 0;
}
.thread-title {
  width: 100%;
  border: 0;
  background: transparent;
  font-family: var(--font-head);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
  padding: 0;
}
.thread-title:focus,
.thread-desc:focus,
.composer-summary:focus {
  outline: 0;
}
.thread-desc {
  width: 100%;
  margin-top: 6px;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 14px;
  padding: 0;
}
.summary-box {
  margin: 0 0 18px;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--surface-2);
}
.summary-box label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--muted);
}
.summary-box textarea {
  display: block;
  width: 100%;
  min-height: 48px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.7;
  resize: none;
}
.summary-box textarea:focus {
  outline: 0;
}
.composer {
  margin-bottom: 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.composer:focus-within {
  border-color: var(--border-strong);
  box-shadow:
    var(--shadow),
    0 0 0 4px var(--accent-soft);
}
.composer-summary {
  display: block;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 15px;
}
.composer-more {
  display: grid;
  gap: 10px;
  padding: 0 16px 12px;
  border-top: 1px solid var(--border);
}
.composer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.composer-error {
  margin: 0;
  padding: 0 16px 12px;
  color: var(--danger);
  font-size: 12px;
}
.timeline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.timeline-head h2 {
  font-size: 15px;
}
.timeline {
  list-style: none;
  margin: 0;
  padding: 4px 0 0 22px;
  border-left: 1px solid var(--border);
}
.entry {
  position: relative;
  padding: 0 0 26px 22px;
}
.entry::before {
  content: '';
  position: absolute;
  left: -27px;
  top: 8px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
  background: var(--surface);
  transition: border-color var(--dur-2) ease;
}
.entry:hover::before {
  border-color: var(--accent);
}
.entry-remove {
  position: absolute;
  top: 2px;
  right: 0;
  padding: 4px 6px;
  border-radius: var(--radius-s);
  color: var(--faint);
  opacity: 0;
  transition: opacity var(--dur-1) ease;
}
.entry:hover .entry-remove,
.entry:focus-within .entry-remove {
  opacity: 1;
}
.entry-remove:hover {
  background: var(--surface-2);
  color: var(--text);
}
.entry time {
  font-size: 12px;
  color: var(--faint);
}
.entry h4 {
  margin: 3px 0 0;
  font-size: 15px;
}
.entry-title {
  color: inherit;
  font: inherit;
  text-align: left;
}
.entry-title:hover {
  color: var(--accent);
}
.entry-body {
  margin-top: 4px;
  font-size: 14px;
  color: var(--muted);
  line-height: 1.7;
}
.entry-refs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--faint);
}
.subsection {
  margin-top: 36px;
}
.thread-note {
  position: relative;
}
.duplicate-hint {
  color: var(--danger);
}
</style>
