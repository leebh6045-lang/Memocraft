<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Note } from '../../../domain/note';
import { emptyTopicDraft } from '../../../domain/topic';
import AppDialog from '../components/AppDialog.vue';
import NoteCard from '../components/NoteCard.vue';
import NotePickerDialog from '../components/NotePickerDialog.vue';
import { formatTime } from '../format-time';
import AppIcon from '../components/AppIcon.vue';
import type { TopicState } from '../composables/useTopics';
import type { TrashState } from '../composables/useTrash';

const props = defineProps<{
  state: TopicState;
  notes: Note[];
  busy: boolean;
  /** 删除走统一的回收站流程：先取影响面确认，再执行。 */
  trash: TrashState;
  /** 首页「新建归纳」等入口通过递增该值请求打开新建对话框。 */
  createSignal: number;
  /** 手记抽屉里的归纳标签请求打开某个归纳；nonce 变化即视为一次新请求。 */
  openSignal: { id: string; nonce: number } | null;
  /** 进入模块即回到列表：值变化表示一次新的进入。 */
  navSignal: number;
}>();
const emit = defineEmits<{
  'open-note': [id: string];
  notify: [payload: { message: string; undo?: () => void }];
}>();

const topics = props.state.topics;
// state 里的 ref 提为顶层绑定：模板只对顶层 ref 解包，嵌套访问会拿到 ref 对象本身。
const topicsError = props.state.error;
const topicsLoading = props.state.loading;
const view = ref<'list' | 'detail'>('list');
const activeId = ref<string | null>(null);
const activeTopic = computed(() => topics.value.find((item) => item.id === activeId.value) ?? null);

const creating = ref(false);
const draft = ref(emptyTopicDraft());
const duplicateHint = ref('');
const pickingFor = ref<string | null>(null);

const title = ref('');
const description = ref('');
const saveStatus = ref('');
const saveError = ref('');
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let applyingRemote = false;

const activeNotes = computed(() => {
  const topic = activeTopic.value;
  if (!topic) return [];
  const byId = new Map(props.notes.map((note) => [note.id, note]));
  return topic.noteIds.map((id) => byId.get(id)).filter((note): note is Note => note !== undefined);
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function topicsOfNote(noteId: string): string[] {
  return topics.value.filter((topic) => topic.noteIds.includes(noteId)).map((topic) => topic.title);
}

/** 列表到详情使用共享元素过渡；浏览器不支持或用户要求减少动态时直接切换。 */
function showDetail(topicId: string): void {
  const swap = () => {
    activeId.value = topicId;
    view.value = 'detail';
    syncEditingFields();
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  if (document.startViewTransition && !reducedMotion) document.startViewTransition(swap);
  else swap();
}

function backToList(): void {
  view.value = 'list';
  activeId.value = null;
  saveStatus.value = '';
  saveError.value = '';
}

function syncEditingFields(): void {
  const topic = activeTopic.value;
  applyingRemote = true;
  title.value = topic?.title ?? '';
  description.value = topic?.description ?? '';
  void nextTick(() => {
    applyingRemote = false;
  });
}

watch(activeId, syncEditingFields);

async function openCreate(): Promise<void> {
  draft.value = emptyTopicDraft();
  duplicateHint.value = '';
  creating.value = true;
}

// 页面切换带过渡，本组件可能晚于信号挂载；因此挂载时也消费一次，并记录已处理的值。
let seenCreateSignal = 0;
function consumeCreateSignal(): void {
  if (props.createSignal === seenCreateSignal) return;
  seenCreateSignal = props.createSignal;
  if (props.createSignal > 0) void openCreate();
}

let seenOpenNonce = 0;
function consumeOpenSignal(): void {
  const signal = props.openSignal;
  if (!signal || signal.nonce === seenOpenNonce) return;
  seenOpenNonce = signal.nonce;
  if (topics.value.some((topic) => topic.id === signal.id)) showDetail(signal.id);
}

let seenNavSignal = 0;
function consumeNavSignal(): void {
  if (props.navSignal === seenNavSignal) return;
  seenNavSignal = props.navSignal;
  // 与原型一致：点模块导航回到列表，不停留在上一条详情。
  if (view.value === 'detail') backToList();
}

watch(() => props.navSignal, consumeNavSignal, { immediate: true });
watch(() => props.createSignal, consumeCreateSignal, { immediate: true });
watch(() => props.openSignal?.nonce, consumeOpenSignal, { immediate: true });

async function submitCreate(confirmDuplicate = false): Promise<void> {
  const created = await props.state.create({
    title: draft.value.title,
    description: draft.value.description,
    confirmDuplicate,
  });
  if (!created) {
    // 同名不是失败：提示已有同名项，由用户确认后原样重试。
    duplicateHint.value = topicsError.value;
    return;
  }
  creating.value = false;
  duplicateHint.value = '';
  emit('notify', { message: `已创建归纳「${created.title}」` });
  showDetail(created.id);
}

/** 标题与说明就地自动保存：编辑期间不阻塞输入，失败时保留本地内容并提示。 */
function scheduleSave(): void {
  const topic = activeTopic.value;
  if (!topic || applyingRemote) return;
  clearTimeout(saveTimer);
  saveStatus.value = '正在保存…';
  saveError.value = '';
  saveTimer = setTimeout(() => {
    void saveEditing();
  }, 600);
}

async function saveEditing(): Promise<void> {
  const topic = activeTopic.value;
  if (!topic) return;
  if (title.value.trim() === topic.title && description.value === topic.description) {
    saveStatus.value = '';
    return;
  }
  const updated = await props.state.update({
    id: topic.id,
    title: title.value,
    description: description.value,
    expectedRevision: topic.revision,
  });
  if (!updated) {
    saveError.value = topicsError.value;
    saveStatus.value = '';
    return;
  }
  saveStatus.value = `已保存 ${formatTime(new Date().toISOString())}`;
}

watch([title, description], scheduleSave);

async function confirmPick(noteIds: string[]): Promise<void> {
  const topicId = pickingFor.value;
  if (!topicId) return;
  pickingFor.value = null;
  if (await props.state.addNotes(topicId, noteIds)) {
    const topic = topics.value.find((item) => item.id === topicId);
    emit('notify', {
      message: `已收录 ${noteIds.length} 条手记`,
      undo: () => {
        // 撤销只对当次收录有效：逐条移出这批手记，其他收录不受影响。
        if (!topic) return;
        void Promise.all(noteIds.map((noteId) => props.state.removeNote(topicId, noteId)));
      },
    });
  }
}

async function removeFromTopic(topicId: string, noteId: string): Promise<void> {
  if (await props.state.removeNote(topicId, noteId)) {
    emit('notify', {
      message: '已从归纳移出，手记仍在随手记',
      undo: () => {
        void props.state.addNotes(topicId, [noteId]);
      },
    });
  }
}

/** 删除归纳：确认后回到列表；手记与收录关系的保留由存储层保证。 */
async function removeTopic(topicId: string): Promise<void> {
  const removed = await props.trash.requestRemoval('topic', topicId);
  if (removed) backToList();
}

/** 归纳内的新建手记：先回到首页写一条，保存后再收录由用户决定。 */
function writeInTopic(): void {
  emit('notify', { message: '手记先保存到随手记，再回到归纳收录。' });
}
</script>

<template>
  <section class="view">
    <template v-if="view === 'list'">
      <header class="page-head">
        <div>
          <h1>知识归纳</h1>
          <p class="sub">围绕一个主题收录手记，同一条手记可以出现在多个归纳里。</p>
        </div>
        <div class="actions">
          <button class="btn-primary" :disabled="props.busy" @click="openCreate">
            <span aria-hidden="true">＋</span> 新建归纳
          </button>
        </div>
      </header>
      <div v-if="topicsError && !topics.length" class="empty" role="alert">
        {{ topicsError }}<br />
        <button class="btn-ghost" @click="props.state.load()">重试读取</button>
      </div>
      <div v-else-if="topicsLoading && !topics.length" class="empty">正在读取归纳…</div>
      <div v-else-if="!topics.length" class="empty">
        还没有归纳。<br />
        <button class="btn-ghost" @click="openCreate">新建第一个归纳</button>
      </div>
      <div v-else class="grid">
        <button
          v-for="(topic, index) in topics"
          :key="topic.id"
          class="card collection"
          @click="showDetail(topic.id)"
        >
          <span class="index">{{ String(index + 1).padStart(2, '0') }}</span>
          <h3 :style="{ viewTransitionName: `topic-${topic.id}` }">{{ topic.title }}</h3>
          <p>{{ topic.description || '还没有说明' }}</p>
          <span class="meta-line"
            ><span>{{ topic.noteIds.length }} 条手记</span
            ><span>{{ formatTime(topic.createdAt) }} 创建</span></span
          >
        </button>
      </div>
    </template>

    <template v-else-if="activeTopic">
      <button class="crumb" @click="backToList"><span aria-hidden="true">‹</span> 知识归纳</button>
      <header class="page-head">
        <div class="topic-head">
          <h1 :style="{ viewTransitionName: `topic-${activeTopic.id}` }">
            {{ activeTopic.title }}
          </h1>
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
            @click="removeTopic(activeTopic.id)"
          >
            <AppIcon name="trash" class="icon-s" />
          </button>
          <button class="btn" :disabled="props.busy" @click="pickingFor = activeTopic.id">
            收录已有手记
          </button>
        </div>
      </header>

      <div class="topic-fields">
        <label class="field"
          >标题<input
            :value="title"
            :disabled="props.busy"
            maxlength="300"
            @input="title = ($event.target as HTMLInputElement).value"
        /></label>
        <label class="field wide"
          >说明<textarea
            :value="description"
            :disabled="props.busy"
            rows="2"
            maxlength="2000"
            placeholder="这个归纳在收集什么"
            @input="description = ($event.target as HTMLTextAreaElement).value"
          />
        </label>
      </div>

      <div v-if="!activeNotes.length" class="empty">
        这个归纳还是空的。<br />
        <button class="btn-ghost" @click="pickingFor = activeTopic.id">收录已有手记</button>
        <button class="btn-ghost" @click="writeInTopic">去写一条</button>
      </div>
      <div v-else class="grid">
        <div v-for="note in activeNotes" :key="note.id" class="topic-note">
          <NoteCard
            :note="note"
            :topics="topicsOfNote(note.id)"
            @open="emit('open-note', note.id)"
          />
          <button
            class="card-remove"
            :disabled="props.busy"
            :title="`从这个归纳移出，不删除手记`"
            @click="removeFromTopic(activeTopic.id, note.id)"
          >
            移出
          </button>
        </div>
      </div>
    </template>

    <AppDialog
      v-if="creating"
      title="新建归纳"
      hint="标题必填，说明可以稍后补。允许同名，重命名不会重写已收录的关系。"
      @close="creating = false"
    >
      <label class="field"
        >标题<input
          data-autofocus
          :value="draft.title"
          maxlength="300"
          placeholder="例如：本地数据库"
          @input="draft.title = ($event.target as HTMLInputElement).value"
      /></label>
      <label class="field"
        >说明（可选）<textarea
          :value="draft.description"
          rows="2"
          maxlength="2000"
          placeholder="这个归纳收集哪一类内容"
          @input="draft.description = ($event.target as HTMLTextAreaElement).value"
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

    <NotePickerDialog
      v-if="pickingFor"
      :notes="props.notes"
      :collected-ids="topics.find((item) => item.id === pickingFor)?.noteIds ?? []"
      :busy="props.busy"
      @confirm="confirmPick"
      @close="pickingFor = null"
    />
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.topic-head {
  min-width: 0;
}
.topic-fields {
  display: grid;
  gap: 10px 14px;
  margin-bottom: 22px;
}
.topic-fields .wide {
  grid-column: 1 / -1;
}
.topic-note {
  position: relative;
}
.card-remove {
  position: absolute;
  top: 10px;
  right: 10px;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  background: var(--surface);
  color: var(--faint);
  font-size: 12px;
  opacity: 0;
  transition: opacity var(--dur-1) ease;
}
.topic-note:hover .card-remove,
.topic-note:focus-within .card-remove {
  opacity: 1;
}
.card-remove:hover {
  background: var(--surface-2);
  color: var(--text);
}
.duplicate-hint {
  color: var(--danger);
}
</style>
