<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { categoryLabel, noteTitle, type Note } from '../../../domain/note';
import type { NoteImageIndex } from '../../../domain/note-image';
import type { TopicCreate, TopicSummary } from '../../../domain/topic';
import NoteCard from '../components/NoteCard.vue';
import PickerDialog from '../components/PickerDialog.vue';
import TopicCreateDialog from '../components/TopicCreateDialog.vue';
import TopicReadingView from '../components/TopicReadingView.vue';
import { notePickerOptions } from '../picker';
import { formatTime } from '../format-time';
import SideDrawer from '../components/SideDrawer.vue';
import type { TopicState } from '../composables/useTopics';
import type { TrashState } from '../composables/useTrash';
import { scrollContentToTop } from '../scroll';
import {
  TOPIC_DETAIL_LAYOUTS,
  TOPIC_DETAIL_ORDERS,
  TOPICS_LAYOUTS,
  readTopicDetailLayout,
  readTopicDetailOrder,
  readTopicsLayout,
  writeTopicDetailLayout,
  writeTopicDetailOrder,
  writeTopicsLayout,
  type TopicDetailLayout,
  type TopicDetailOrder,
  type TopicsLayout,
} from '../view-preferences';

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
  /** 按手记 ID 索引的附图摘要，用于连读小节与卡片里的缩略图。 */
  imageIndex: NoteImageIndex;
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
const duplicateHint = ref('');
const pickingFor = ref<string | null>(null);
/** 基础信息在右侧抽屉里编辑，页面只读展示标题。 */
const editOpen = ref(false);

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
/** noteIds 本身是手记创建时间倒序；「最早在前」只是把这份顺序反过来，两种呈现共用。 */
const orderedNotes = computed(() =>
  detailOrder.value === 'asc' ? [...activeNotes.value].reverse() : activeNotes.value,
);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 列表的排列方式：卡片（默认）或目录；偏好存在本机，只影响列表页，详情页不变。 */
const layout = ref<TopicsLayout>(readTopicsLayout());
function chooseLayout(value: TopicsLayout): void {
  if (layout.value === value) return;
  layout.value = value;
  if (!writeTopicsLayout(value)) {
    emit('notify', { message: '已切换排列方式，但偏好未能保存，重启后会回到卡片。' });
  }
}

/**
 * 详情页的呈现与顺序：连读（默认）把收录的手记连成一篇文档，网格保留卡片与「移出」。
 * 两项都只影响这一页，选择存在本机，写不进去也照常切换并提示。
 */
const detailLayout = ref<TopicDetailLayout>(readTopicDetailLayout());
const detailOrder = ref<TopicDetailOrder>(readTopicDetailOrder());
function chooseDetailLayout(value: TopicDetailLayout): void {
  if (detailLayout.value === value) return;
  detailLayout.value = value;
  if (!writeTopicDetailLayout(value)) {
    emit('notify', { message: '已切换呈现方式，但偏好未能保存，重启后会回到连读。' });
  }
}
function chooseDetailOrder(value: TopicDetailOrder): void {
  if (detailOrder.value === value) return;
  detailOrder.value = value;
  if (!writeTopicDetailOrder(value)) {
    emit('notify', { message: '已切换顺序，但偏好未能保存，重启后会回到最新在前。' });
  }
}

/** 目录每个归纳露出的手记条数；更多的由「查看全部」进入详情。 */
const TOC_PREVIEW_COUNT = 3;
const noteMap = computed(() => new Map(props.notes.map((note) => [note.id, note])));
/** 目录用：归纳收录的有效手记，顺序沿用 noteIds（手记创建时间倒序）。 */
function notesOf(topic: TopicSummary): Note[] {
  return topic.noteIds
    .map((id) => noteMap.value.get(id))
    .filter((note): note is Note => note !== undefined);
}
/** 目录的每一项：归纳本身、最新一条手记与要露出的几条，模板里不再反复计算。 */
const tocEntries = computed(() =>
  topics.value.map((topic) => {
    const notes = notesOf(topic);
    return { topic, latest: notes[0], preview: notes.slice(0, TOC_PREVIEW_COUNT) };
  }),
);
/** 同一条手记被几个归纳收录：目录里据此标「另见 N」，N 不含当前归纳。 */
const collectedCount = computed(() => {
  const counts = new Map<string, number>();
  for (const topic of topics.value) {
    for (const id of topic.noteIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
});
function otherTopicTitles(noteId: string, topicId: string): string {
  return topics.value
    .filter((topic) => topic.id !== topicId && topic.noteIds.includes(noteId))
    .map((topic) => topic.title)
    .join('、');
}

/** 列表到详情使用共享元素过渡；浏览器不支持或用户要求减少动态时直接切换。 */
function showDetail(topicId: string): void {
  const swap = () => {
    activeId.value = topicId;
    view.value = 'detail';
    syncEditingFields();
    // 主内容区才是滚动容器：进详情要回到顶部，否则会停在列表滚到的位置。
    scrollContentToTop();
  };
  if (document.startViewTransition && !reducedMotion) document.startViewTransition(swap);
  else swap();
}

function backToList(): void {
  editOpen.value = false;
  view.value = 'list';
  activeId.value = null;
  saveStatus.value = '';
  saveError.value = '';
  scrollContentToTop();
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

async function submitCreate(input: TopicCreate): Promise<void> {
  const created = await props.state.create(input);
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

/** 选择器条目：已在当前归纳里的手记不列出，只在空状态里说明数量。 */
const pickerOptions = computed(() =>
  notePickerOptions(
    props.notes,
    topics.value.find((item) => item.id === pickingFor.value)?.noteIds ?? [],
  ),
);

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
          <div v-if="topics.length" class="seg seg-sm" role="radiogroup" aria-label="排列方式">
            <button
              v-for="option in TOPICS_LAYOUTS"
              :key="option.value"
              type="button"
              role="radio"
              :aria-checked="layout === option.value"
              @click="chooseLayout(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
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
      <!-- 目录：没有卡片框，序号、标题、点线与条数，下面直接露出最新几条手记。 -->
      <ol v-else-if="layout === 'toc'" class="toc">
        <li
          v-for="({ topic, latest, preview }, index) in tocEntries"
          :key="topic.id"
          class="toc-item"
        >
          <span class="toc-no" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
          <div class="toc-main">
            <div class="toc-head">
              <button class="toc-title" @click="showDetail(topic.id)">
                <span :style="{ viewTransitionName: `topic-${topic.id}` }">{{ topic.title }}</span
                ><span class="toc-go" aria-hidden="true">→</span>
              </button>
              <span class="toc-leader" aria-hidden="true" />
              <span class="toc-count">{{ topic.noteIds.length }} 条</span>
            </div>
            <p v-if="topic.description" class="toc-desc">{{ topic.description }}</p>
            <p class="toc-meta">
              {{ formatTime(topic.createdAt) }} 创建<template v-if="latest">
                · 最新一条 {{ formatTime(latest.createdAt) }}</template
              >
            </p>
            <ul v-if="preview.length" class="toc-notes" :aria-label="`${topic.title} 最新的手记`">
              <li v-for="note in preview" :key="note.id">
                <button class="toc-note" @click="emit('open-note', note.id)">
                  <span class="toc-dot" :class="`cat-${note.category}`" aria-hidden="true" />
                  <span class="sr-only">{{ categoryLabel(note.category) }}：</span>
                  <span class="toc-note-title">{{ noteTitle(note) }}</span>
                  <span
                    v-if="(collectedCount.get(note.id) ?? 0) > 1"
                    class="toc-also"
                    :title="`也收录在：${otherTopicTitles(note.id, topic.id)}`"
                    >另见 {{ (collectedCount.get(note.id) ?? 0) - 1
                    }}<span class="sr-only"
                      >个归纳：{{ otherTopicTitles(note.id, topic.id) }}</span
                    ></span
                  >
                  <span class="toc-fill" />
                  <time :datetime="note.createdAt">{{ formatTime(note.createdAt) }}</time>
                </button>
              </li>
            </ul>
            <p v-else class="toc-empty">还没有收录手记。</p>
            <button
              v-if="topic.noteIds.length > TOC_PREVIEW_COUNT"
              class="toc-more"
              @click="showDetail(topic.id)"
            >
              查看全部 {{ topic.noteIds.length }} 条
            </button>
          </div>
        </li>
      </ol>
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
      <div class="detail-head">
        <div class="head-main">
          <h1 class="detail-title">
            <span :style="{ viewTransitionName: `topic-${activeTopic.id}` }">{{
              activeTopic.title
            }}</span>
          </h1>
        </div>
        <div class="actions">
          <button class="btn" :disabled="props.busy" @click="editOpen = true">编辑基础信息</button>
          <button class="btn-primary" :disabled="props.busy" @click="pickingFor = activeTopic.id">
            收录已有手记
          </button>
        </div>
      </div>

      <div v-if="!activeNotes.length" class="empty">
        这个归纳还是空的。<br />
        <button class="btn-ghost" @click="pickingFor = activeTopic.id">收录已有手记</button>
        <button class="btn-ghost" @click="writeInTopic">去写一条</button>
      </div>

      <template v-else>
        <!-- 详情页头：说明作为导语只读显示，右侧是顺序与呈现方式，两项都只影响这一页。 -->
        <div class="doc-bar">
          <p class="doc-meta">
            <span v-if="activeTopic.description" class="lede">{{ activeTopic.description }}</span>
            {{ orderedNotes.length }} 条手记 · 创建于 {{ formatTime(activeTopic.createdAt) }}
          </p>
          <div class="toolbar-end">
            <div class="seg seg-sm" role="radiogroup" aria-label="排列顺序">
              <button
                v-for="option in TOPIC_DETAIL_ORDERS"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="detailOrder === option.value"
                @click="chooseDetailOrder(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <div class="seg seg-sm" role="radiogroup" aria-label="呈现方式">
              <button
                v-for="option in TOPIC_DETAIL_LAYOUTS"
                :key="option.value"
                type="button"
                role="radio"
                :aria-checked="detailLayout === option.value"
                @click="chooseDetailLayout(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
          </div>
        </div>

        <TopicReadingView
          v-if="detailLayout === 'doc'"
          :topic-id="activeTopic.id"
          :notes="orderedNotes"
          :topics="topics"
          :image-index="props.imageIndex"
          @open="emit('open-note', $event)"
          @remove="removeFromTopic(activeTopic.id, $event)"
          @open-topic="showDetail"
        />
        <div v-else class="grid">
          <div v-for="note in orderedNotes" :key="note.id" class="topic-note">
            <NoteCard :note="note" @open="emit('open-note', note.id)" />
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
    </template>

    <TopicCreateDialog
      v-if="creating"
      :busy="props.busy"
      :error="duplicateHint"
      @submit="submitCreate"
      @close="creating = false"
    />

    <PickerDialog
      v-if="pickingFor"
      title="收录手记"
      hint="搜索并选择要收录到当前归纳的手记，可多选后一次提交。"
      search-label="搜索手记"
      search-placeholder="搜索标题、正文或标签"
      :options="pickerOptions.options"
      :linked-count="pickerOptions.linkedCount"
      empty-text="没有匹配的手记，换个词或先去写一条。"
      all-linked-text="全部手记都已收录在这个归纳里。"
      unit="条"
      :busy="props.busy"
      @confirm="confirmPick"
      @close="pickingFor = null"
    />
    <SideDrawer v-if="activeTopic" :open="editOpen" title="编辑基础信息" @close="editOpen = false">
      <label class="field"
        >标题<input
          data-autofocus
          :value="title"
          :disabled="props.busy"
          maxlength="300"
          @input="title = ($event.target as HTMLInputElement).value"
      /></label>
      <label class="field"
        >说明<textarea
          :value="description"
          :disabled="props.busy"
          rows="4"
          maxlength="2000"
          placeholder="这个归纳在收集什么"
          @input="description = ($event.target as HTMLTextAreaElement).value"
        />
      </label>
      <p class="draft-status" :class="{ error: saveError }" aria-live="polite">
        <span v-if="saveError">{{ saveError }}</span>
        <span v-else-if="saveStatus">{{ saveStatus }}</span>
      </p>
      <template #footer>
        <span>改动会自动保存</span>
        <button
          class="btn-quiet btn-danger"
          :disabled="props.busy"
          @click="removeTopic(activeTopic.id)"
        >
          移到回收站
        </button>
      </template>
    </SideDrawer>
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
/* 详情页头：左边是说明导语与条数，右边是顺序与呈现方式。 */
.doc-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}
.doc-meta {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--faint);
}
.doc-meta .lede {
  display: block;
  font-size: 14px;
  color: var(--muted);
}
.toolbar-end {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topic-note {
  position: relative;
} /*
 * 网格只拉伸这一层 div，卡片本身是 button，默认按内容收缩；
 * 不撑满格子时，收录的手记一多，同一行的卡片就宽高不齐，「移出」按钮也会浮到卡片外面。
 */
.topic-note > .card {
  width: 100%;
  height: 100%;
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

/* 目录：只有序号、标题、引导点线和细分隔线，与随手记的卡片网格一眼分开。 */
.toc {
  margin: 0;
  padding: 0;
  list-style: none;
}
.toc-item {
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr);
  padding: 22px 0 18px;
  border-top: 1px solid var(--border);
}
.toc-item:first-child {
  padding-top: 4px;
  border-top: 0;
}
.toc-no {
  font-size: 27px;
  font-weight: 300;
  line-height: 1.1;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--faint);
}
.toc-main {
  min-width: 0;
}
.toc-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.toc-title {
  flex: 0 1 auto;
  min-width: 0;
  text-align: left;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.4;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
  transition: color var(--dur-1) ease;
}
.toc-title:hover {
  color: var(--accent);
}
.toc-go {
  display: inline-block;
  margin-left: 6px;
  font-weight: 400;
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity var(--dur-1) ease,
    transform var(--dur-2) var(--ease);
}
.toc-title:hover .toc-go,
.toc-title:focus-visible .toc-go {
  opacity: 1;
  transform: none;
}
.toc-leader {
  flex: 1 1 24px;
  min-width: 24px;
  border-bottom: 1.5px dotted var(--border-strong);
  transform: translateY(-5px);
}
.toc-count {
  flex: none;
  font-size: 13px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.toc-desc {
  margin-top: 3px;
  font-size: 13px;
  color: var(--muted);
}
.toc-meta {
  margin-top: 2px;
  font-size: 12px;
  color: var(--faint);
}
.toc-notes {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.toc-note {
  display: flex;
  align-items: center;
  gap: 10px;
  width: calc(100% + 16px);
  margin: 0 -8px;
  padding: 6px 8px;
  border-radius: var(--radius-s);
  text-align: left;
  font-size: 13.5px;
  transition: background-color var(--dur-1) ease;
}
.toc-note:hover {
  background: var(--surface-2);
}
.toc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--cat-color, var(--faint));
}
.toc-note-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toc-also {
  flex: none;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.7;
  color: var(--faint);
  white-space: nowrap;
}
.toc-fill {
  flex: 1;
}
.toc-note time {
  flex: none;
  font-size: 12px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.toc-more {
  margin-top: 4px;
  padding: 3px 0;
  font-size: 12.5px;
  color: var(--accent);
}
.toc-more:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.toc-empty {
  margin-top: 8px;
  font-size: 13px;
  color: var(--faint);
}
</style>
