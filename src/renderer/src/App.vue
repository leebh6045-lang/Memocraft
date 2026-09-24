<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Note, NoteCategory } from '../../domain/note';
import type { TopicCreate } from '../../domain/topic';
import AppIcon from './components/AppIcon.vue';
import HomePage from './pages/HomePage.vue';
import NotesPage from './pages/NotesPage.vue';
import type { SearchHit } from '../../domain/search';
import PlannedModule from './pages/PlannedModule.vue';
import SettingsPage from './pages/SettingsPage.vue';
import TrashPage from './pages/TrashPage.vue';
import TopicsPage from './pages/TopicsPage.vue';
import ThreadsPage from './pages/ThreadsPage.vue';
import NoteDrawer from './components/NoteDrawer.vue';
import SearchPalette from './components/SearchPalette.vue';
import RemovalDialog from './components/RemovalDialog.vue';
import ToastStack from './components/ToastStack.vue';
import { useLibrary } from './composables/useLibrary';
import { useNoteImages } from './composables/useNoteImages';
import { useModalLayer } from './composables/useModalLayer';
import { useTopics } from './composables/useTopics';
import { useThreads } from './composables/useThreads';
import { useTrash } from './composables/useTrash';
import { useToasts } from './composables/useToasts';
import {
  readThemePreference,
  resolveTheme,
  writeThemePreference,
  type ThemePreference,
} from './theme';
import { imageApi } from './api/bridge';
import brandMark from './assets/memocraft-mark.svg';

const api = window.memocraft;
// 普通浏览器不伪造保存能力；正式应用必须通过 preload 接入本地库。
const libraryApi = imageApi(api);
const library = useLibrary(libraryApi);
// 图集现场独立于正文编辑现场：改名字或删除图片不会触发手记版本冲突。
const noteImages = useNoteImages(libraryApi);
// 归纳列表由渲染端持有：收录数量、抽屉里的所属归纳与选择器状态都从这一份数据推导。
const topicState = useTopics(libraryApi);
// 事务列表与当前时间线同样由渲染端持有；手记的反查结果单独按需读取。
const threadState = useThreads(libraryApi);
// 回收站现场同时负责删除确认：删除一律先展示影响面，再执行。
const trashState = useTrash(libraryApi);
/** 归纳操作（收录、移出、新建）失败的原因：交给手记抽屉就地显示，不留静默失败。 */
const topicError = ref('');
const createTopicSignal = ref(0);
const openTopicSignal = ref<{ id: string; nonce: number } | null>(null);
/** 每次进入归纳模块都递增：与原型一致，点模块导航即回到列表，不停留在某条详情。 */
const topicsNavSignal = ref(0);
const createThreadSignal = ref(0);
const openThreadSignal = ref<{ id: string; entryId: string | null; nonce: number } | null>(null);
/** 每次进入长期事务模块都递增：点模块导航回到列表。 */
const threadsNavSignal = ref(0);
// 提示条报告已完成的操作；模态层计数让全局快捷键与背景 inert 让位给对话框。
const { toasts, push: pushToast, dismiss: dismissToast, clear: clearToasts } = useToasts();
const { depth: modalDepth } = useModalLayer();
const {
  notes,
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
} = library;
const pages = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'notes', label: '随手记', icon: 'notes' },
  { id: 'topics', label: '知识归纳', icon: 'topics' },
  { id: 'threads', label: '长期事务', icon: 'threads' },
] as const;
/** 设置是辅助页面，不占主导航位置，因此不进 pages 数组。 */
type Page = (typeof pages)[number]['id'] | 'settings' | 'trash';
const page = ref<Page>('home');
const filter = ref<NoteCategory | 'all'>('all');
const tag = ref('');
const focused = ref(false);
const themePreference = ref<ThemePreference>('light');
const systemPrefersDark = ref(false);
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const resolvedTheme = computed(() => resolveTheme(themePreference.value, systemPrefersDark.value));
const searchOpen = ref(false);
const reducedMotion = ref(false);
const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
function syncMotionPreference() {
  reducedMotion.value = motionPreference.matches;
}
const closing = ref(false);
const closingStore = ref(false);
const navigating = ref(false);
const banner = ref('');
const saveFeedback = ref(false);
const main = ref<HTMLElement | null>(null);
const busy = computed(() => closing.value || submitting.value || navigating.value);
const shortcut = api?.platform === 'mac' ? '⌘' : 'Ctrl';
const activeIndex = computed(() => pages.findIndex((item) => item.id === page.value));
const scrollPositions = new Map<Page, number>();
let saveFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
let themeTimer: ReturnType<typeof setTimeout> | undefined;
let closingAttempt = 0;
let removeCloseListener: () => void = () => undefined;
let removeCancelListener: () => void = () => undefined;
let removeNoticeListener: () => void = () => undefined;

function announce(message: string, action?: { label: string; run: () => void }) {
  pushToast(message, { action });
}

async function navigate(target: Page) {
  if (busy.value || searchOpen.value) return;
  navigating.value = true;
  try {
    if (!(await library.flushAll())) {
      banner.value = '保存未完成，已留在当前页面。请重试保存后再切换。';
      return;
    }
    if (!(await library.closeNote())) return;
    // 只在保存成功后切页；动画负责呈现变化，不参与业务提交。
    scrollPositions.set(page.value, window.scrollY);
    page.value = target;
    // 归纳的一次性意图只在当次进入有效，离开时清空，避免下次进入又弹出表单。
    if (target === 'topics') topicsNavSignal.value += 1;
    else {
      createTopicSignal.value = 0;
      openTopicSignal.value = null;
    }
    if (target === 'trash') void trashState.load();
    if (target === 'threads') threadsNavSignal.value += 1;
    else {
      createThreadSignal.value = 0;
      openThreadSignal.value = null;
    }
    banner.value = '';
    document.title = `Memocraft · ${pages.find((item) => item.id === target)?.label ?? '首页'}`;
  } finally {
    navigating.value = false;
  }
}

function restorePagePosition() {
  window.scrollTo({ top: scrollPositions.get(page.value) ?? 0, behavior: 'instant' });
  if (page.value !== 'home')
    main.value?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
}

async function save() {
  if (closing.value || navigating.value || searchOpen.value || editing.value) return;
  const saved = await library.commit();
  if (saved) {
    announce('已保存到随手记');
    saveFeedback.value = true;
    clearTimeout(saveFeedbackTimer);
    saveFeedbackTimer = setTimeout(() => {
      saveFeedback.value = false;
    }, 900);
  }
}

async function openNote(id: string) {
  const note = notes.value.find((item) => item.id === id);
  if (!note || busy.value) return;
  topicError.value = '';
  if (!(await library.openNote(note))) banner.value = '当前手记尚未保存，请重试后再打开其他手记。';
}

async function openSearchNote(note: Note) {
  if (busy.value) return;
  if (await library.openNote(note)) searchOpen.value = false;
}

async function closeDrawer() {
  if (busy.value || searchOpen.value) return;
  if (!(await library.closeNote())) banner.value = '手记尚未保存，编辑内容仍保留。';
}

function toggleSearch() {
  if (!loaded.value || busy.value) return;
  searchOpen.value = !searchOpen.value;
}

async function notify(payload: { message: string; undo?: () => void }) {
  announce(payload.message, payload.undo ? { label: '撤销', run: payload.undo } : undefined);
}

/** 首页「新建归纳」：切到归纳模块并直接打开新建表单。 */
async function createTopic() {
  createTopicSignal.value += 1;
  await navigate('topics');
}

/** 收录与移出的结果提示统一在这里给出：撤销只针对当次操作，其他收录不受影响。 */
async function collectIntoTopics(topicId: string, noteIds: string[]) {
  if (!(await topicState.addNotes(topicId, noteIds))) {
    topicError.value = topicState.error.value || '收录没有完成，请重试。';
    return;
  }
  topicError.value = '';
  const name = topicState.topics.value.find((topic) => topic.id === topicId)?.title;
  notify({ message: name ? `已收录到「${name}」` : '已收录到归纳' });
}

/** 手记抽屉里的「新建归纳」：创建成功后交给抽屉去勾选，收录仍由用户点「收录」提交。 */
async function createTopicForNote(input: TopicCreate) {
  const created = await topicState.create(input);
  if (!created) {
    return { ok: false as const, message: topicState.error.value || '归纳没有创建成功，请重试。' };
  }
  announce(`已创建归纳「${created.title}」`);
  return { ok: true as const, topic: created };
}

async function removeNoteFromTopic(topicId: string, noteId: string) {
  if (!(await topicState.removeNote(topicId, noteId))) {
    topicError.value = topicState.error.value || '移出没有完成，请重试。';
    return;
  }
  topicError.value = '';
  notify({
    message: '已从归纳移出，手记仍在随手记',
    undo: () => {
      void topicState.addNotes(topicId, [noteId]);
    },
  });
}

/** 首页「新建事务」：切到长期事务模块并直接打开新建表单。 */
async function createThread() {
  createThreadSignal.value += 1;
  await navigate('threads');
}

/** 抽屉里的引用：先保存当前手记，再切到长期事务并定位到那条动态。 */
async function openThreadReference(reference: { threadId: string; entryId: string | null }) {
  if (!(await library.closeNote())) {
    banner.value = '手记尚未保存，编辑内容仍保留。';
    return;
  }
  // 先完成导航再发意图：反过来的话意图 watcher 会先执行，随后被导航重置推回列表。
  await navigate('threads');
  openThreadSignal.value = {
    id: reference.threadId,
    entryId: reference.entryId,
    nonce: (openThreadSignal.value?.nonce ?? 0) + 1,
  };
}

/** 抽屉里的归纳标签：先保存当前手记，再切到归纳模块并打开该归纳。 */
async function openTopicFromDrawer(topicId: string) {
  if (!(await library.closeNote())) {
    banner.value = '手记尚未保存，编辑内容仍保留。';
    return;
  }
  // 与事务跳转一致：先导航再发意图，避免被模块导航的重置覆盖。
  await navigate('topics');
  openTopicSignal.value = { id: topicId, nonce: (openTopicSignal.value?.nonce ?? 0) + 1 };
}

/**
 * 删除确认后的收尾：给出提示条与撤销，并刷新受影响的列表。
 * 撤销就是恢复，删除与恢复的语义都只有存储层一份实现。
 */
async function confirmRemoval() {
  const impact = trashState.pending.value;
  const removed = await trashState.confirmRemoval();
  if (!removed || !impact) return;
  notify({
    message: '已移到回收站',
    undo: () => {
      void trashState.restore(impact.kind, impact.id);
    },
  });
  // 手记的列表来自库快照，删除后必须重新读取，否则界面上仍显示这条记录。
  await Promise.all([
    impact.kind === 'note' ? library.reload() : Promise.resolve(true),
    topicState.load(),
    threadState.load(),
  ]);
}

/** 恢复或回收站恢复都会改变数据，因此把手记、归纳、事务与回收站一起重新读取。 */
async function refreshAfterRestore() {
  await Promise.all([library.reload(), topicState.load(), threadState.load(), trashState.load()]);
}

/** 抽屉里的「移到回收站」：先保存并关闭抽屉，再走统一的删除确认。 */
async function requestNoteRemoval(noteId: string) {
  if (!(await library.closeNote())) {
    banner.value = '手记尚未保存，编辑内容仍保留。';
    return;
  }
  await trashState.requestRemoval('note', noteId);
}

/** 搜索结果的打开方式按对象类型区分：手记进抽屉，归纳与事务进各自详情，动态定位到所属事务。 */
async function openSearchHit(hit: SearchHit) {
  searchOpen.value = false;
  if (hit.kind === 'note') {
    const note = notes.value.find((item) => item.id === hit.id);
    if (note) await openSearchNote(note);
    else banner.value = '这条手记已不在当前列表中，请重新载入。';
    return;
  }
  if (hit.kind === 'topic') {
    await openTopicFromDrawer(hit.id);
    return;
  }
  await openThreadReference({
    threadId: hit.threadId ?? hit.id,
    entryId: hit.kind === 'entry' ? hit.id : null,
  });
}

async function viewAll() {
  searchOpen.value = false;
  filter.value = 'all';
  tag.value = '';
  await nextTick();
  await navigate('notes');
}

/** 切换主题时先锁定旧样式的计算值，避免文字先闪到新颜色。 */
function applyTheme() {
  clearTimeout(themeTimer);
  document.documentElement.classList.add('theme-switching');
  void document.documentElement.offsetWidth;
  document.documentElement.dataset.theme = resolvedTheme.value;
  themeTimer = setTimeout(() => {
    document.documentElement.classList.remove('theme-switching');
  }, 340);
}

/** 设置页的三选；偏好只影响界面，正文与关系始终由 SQLite 持久化。 */
function setThemePreference(preference: ThemePreference) {
  themePreference.value = preference;
  applyTheme();
  if (!writeThemePreference(preference)) announce('主题已切换，但外观偏好未能保存。');
}

/** 侧栏按钮保留为浅色与深色之间的快速切换：跟随系统时按当刻实际外观取反。 */
function toggleTheme() {
  setThemePreference(resolvedTheme.value === 'light' ? 'dark' : 'light');
}

function syncSystemTheme() {
  systemPrefersDark.value = systemTheme.matches;
  if (themePreference.value === 'system') applyTheme();
}

async function retrySave() {
  if (await library.flushAll()) banner.value = '';
}

async function requestClose() {
  if (closing.value) return;
  const attempt = ++closingAttempt;
  closing.value = true;
  banner.value = '正在保存内容并关闭…';
  const saved = await library.flushAll();
  // 取消或超时已使本次关闭失效，迟到的保存结果不能再次触发退出。
  if (attempt !== closingAttempt) return;
  if (saved) {
    closingStore.value = true;
    api?.closeReady();
  } else {
    closing.value = false;
    banner.value = '保存未完成，窗口已保留。请重试保存。';
    api?.closeCancelled();
  }
}

function cancelClose() {
  // 开始关库后不再接受取消；若关库失败，由主进程通知界面恢复编辑。
  if (!closing.value || closingStore.value) return;
  closingAttempt += 1;
  closing.value = false;
  banner.value = '已取消关闭，当前输入仍保留。';
  api?.closeCancelled();
}

function handleKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229 || closing.value) return;
  // 浮层打开时全局快捷键让位：Esc 由最上层浮层处理，避免一次按键关掉多层。
  if (modalDepth.value > 0) return;
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    toggleSearch();
    return;
  }
  if (event.key === 'Escape') {
    if (searchOpen.value) {
      event.preventDefault();
      searchOpen.value = false;
      return;
    }
    if (editing.value) {
      event.preventDefault();
      void closeDrawer();
      return;
    }
    focused.value = false;
    return;
  }
  if (searchOpen.value || editing.value) return;
  if (mod && event.key === 'Enter' && page.value === 'home') {
    event.preventDefault();
    void save();
  }
  if (mod && event.key === ',') {
    event.preventDefault();
    void navigate('settings');
    return;
  }
  if (mod && /^[1-4]$/.test(event.key)) {
    const target = pages[Number(event.key) - 1];
    if (target) {
      event.preventDefault();
      void navigate(target.id);
    }
  }
}

onMounted(() => {
  syncMotionPreference();
  motionPreference.addEventListener('change', syncMotionPreference);
  themePreference.value = readThemePreference();
  systemPrefersDark.value = systemTheme.matches;
  systemTheme.addEventListener('change', syncSystemTheme);
  document.documentElement.dataset.theme = resolvedTheme.value;
  document.addEventListener('keydown', handleKey);
  removeCloseListener =
    api?.onCloseRequested(() => {
      void requestClose();
    }) ?? (() => undefined);
  // 启动提示（例如检测到未完成的恢复并已回滚）在界面就绪后送达。
  removeNoticeListener =
    api?.onNotice((message) => {
      banner.value = message;
    }) ?? (() => undefined);
  removeCancelListener =
    api?.onCloseCancelled(() => {
      closingAttempt += 1;
      closing.value = false;
      closingStore.value = false;
      banner.value = '关闭未完成，窗口和编辑内容已保留。请重试保存。';
    }) ?? (() => undefined);
  void library
    .initialize()
    .then(() => Promise.all([topicState.load(), threadState.load()]))
    .then(() => undefined);
  // 抽屉打开哪条手记，就读取哪条手记的引用位置；关闭时清空，避免显示上一条的结果。
  watch(
    () => editing.value?.id,
    (noteId) => {
      if (noteId) void threadState.loadReferences(noteId);
      else threadState.references.value = [];
    },
  );
});
onBeforeUnmount(() => {
  motionPreference.removeEventListener('change', syncMotionPreference);
  systemTheme.removeEventListener('change', syncSystemTheme);
  document.removeEventListener('keydown', handleKey);
  removeCloseListener();
  removeCancelListener();
  removeNoticeListener();
  clearToasts();
  clearTimeout(saveFeedbackTimer);
  clearTimeout(themeTimer);
});
</script>

<template>
  <div class="titlebar" aria-hidden="true" />
  <div
    class="app"
    :class="{ focus: focused }"
    :inert="searchOpen || !!editing || closing || modalDepth > 0"
  >
    <aside class="nav" :inert="focused">
      <div class="nav-brand">
        <img class="brand-mark" :src="brandMark" alt="" aria-hidden="true" />
        <div class="brand-name">Memocraft</div>
      </div>
      <nav class="nav-list" aria-label="主导航">
        <div
          v-show="activeIndex >= 0"
          class="nav-ind"
          :style="{ transform: `translateY(${Math.max(activeIndex, 0) * 46}px)`, height: '44px' }"
        />
        <button
          v-for="(item, i) in pages"
          :key="item.id"
          class="nav-item"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :disabled="busy"
          @click="navigate(item.id)"
        >
          <AppIcon :name="item.icon" /><span class="label">{{ item.label }}</span
          ><kbd class="nav-key">{{ shortcut }}{{ i + 1 }}</kbd>
        </button>
      </nav>
      <div class="nav-tools">
        <button class="nav-item" :disabled="!loaded || busy" @click="toggleSearch">
          <AppIcon name="search" /><span class="label">搜索</span
          ><kbd class="nav-key">{{ shortcut }}K</kbd>
        </button>
        <button class="nav-item" :aria-pressed="focused" @click="focused = !focused">
          <AppIcon name="focus" /><span class="label">专注模式</span><kbd class="nav-key">Esc</kbd>
        </button>
        <button class="nav-item" @click="toggleTheme">
          <AppIcon :name="resolvedTheme === 'light' ? 'moon' : 'sun'" /><span class="label">{{
            resolvedTheme === 'light' ? '深色' : '浅色'
          }}</span>
        </button>
      </div>
    </aside>
    <main ref="main" class="main">
      <div v-if="!loaded" class="view loading-view">
        <h1>{{ loading ? '正在打开知识库…' : '知识库暂时无法打开' }}</h1>
        <p role="alert">{{ loadError }}</p>
        <button v-if="!loading" class="btn-primary" @click="library.initialize">重试打开</button>
      </div>
      <Transition v-else name="page" mode="out-in" @after-enter="restorePagePosition">
        <HomePage
          v-if="page === 'home'"
          key="home"
          :draft="draft"
          :notes="notes"
          :status="draftStatus"
          :error="draftError"
          :busy="busy"
          :saved="saveFeedback"
          :shortcut="shortcut"
          :focused="focused"
          @change="library.changeDraft"
          @save="save"
          @retry="retrySave"
          @open="openNote"
          @navigate="navigate"
          @focus="focused = !focused"
          @create-topic="createTopic"
          @create-thread="createThread"
        />
        <NotesPage
          v-else-if="page === 'notes'"
          key="notes"
          :notes="notes"
          :filter="filter"
          :tag="tag"
          :highlighted="latestSavedId"
          :topics="topicState.topics.value"
          @open="openNote"
          @write="navigate('home')"
          @filter="filter = $event"
          @tag="tag = $event"
        />
        <TopicsPage
          v-else-if="page === 'topics'"
          key="topics"
          :state="topicState"
          :notes="notes"
          :busy="busy"
          :trash="trashState"
          :create-signal="createTopicSignal"
          :open-signal="openTopicSignal"
          :nav-signal="topicsNavSignal"
          @open-note="openNote"
          @notify="notify"
        />
        <ThreadsPage
          v-else-if="page === 'threads'"
          key="threads"
          :state="threadState"
          :notes="notes"
          :busy="busy"
          :trash="trashState"
          :create-signal="createThreadSignal"
          :nav-signal="threadsNavSignal"
          :open-signal="openThreadSignal"
          @open-note="openNote"
          @notify="notify"
        />
        <TrashPage
          v-else-if="page === 'trash'"
          key="trash"
          :state="trashState"
          :busy="busy"
          @notify="notify"
          @restored="refreshAfterRestore"
        />
        <SettingsPage
          v-else-if="page === 'settings'"
          key="settings"
          :theme="themePreference"
          :bridge="libraryApi"
          :busy="busy"
          @update:theme="setThemePreference"
          @notify="notify"
          @data-replaced="refreshAfterRestore"
        />
        <PlannedModule v-else :key="page" :module="page" />
      </Transition>
    </main>
  </div>
  <div class="corner">
    <span class="beta">内测中</span>
    <button
      type="button"
      class="corner-btn"
      :class="{ active: page === 'trash' }"
      title="回收站"
      :aria-label="`回收站（当前 ${trashState.items.value.length} 项）`"
      @click="navigate('trash')"
    >
      <AppIcon name="trash" class="icon-s" />
    </button>
    <button
      type="button"
      class="corner-btn"
      :class="{ active: page === 'settings' }"
      title="设置"
      :aria-label="`设置（${shortcut},）`"
      @click="navigate('settings')"
    >
      <AppIcon name="settings" class="icon-s" />
    </button>
  </div>
  <div v-if="banner" class="app-banner" role="status">
    <button v-if="closing && !closingStore" class="btn-ghost" @click="cancelClose">取消关闭</button>
    {{ banner }}<button v-if="!closing" class="btn-ghost" @click="retrySave">重试保存</button
    ><button v-if="!closing" class="btn-quiet" aria-label="关闭提示" @click="banner = ''">×</button>
  </div>
  <Transition name="drawer-transition"
    ><NoteDrawer
      v-if="editing"
      :key="editing.id"
      :note="editing"
      :status="noteStatus"
      :error="noteError"
      :busy="closing"
      :inert="searchOpen || closing"
      :bridge="libraryApi"
      :images="noteImages"
      :topics="topicState.topics.value"
      :notes="notes"
      :references="threadState.references.value"
      :topic-error="topicError"
      :create-topic="createTopicForNote"
      @change="library.changeNote"
      @close="closeDrawer"
      @retry="library.flushNote"
      @collect="collectIntoTopics"
      @remove-topic="removeNoteFromTopic"
      @open-topic="openTopicFromDrawer"
      @open-reference="openThreadReference"
      @remove-note="requestNoteRemoval"
  /></Transition>
  <!-- 子层分别过渡，父层等待完整时长再移除，避免截断模糊退出。 -->
  <Transition name="palette-transition" :duration="reducedMotion ? 0 : 320"
    ><SearchPalette
      v-if="searchOpen"
      :bridge="libraryApi"
      :change-version="changeVersion"
      :inert="closing"
      @close="searchOpen = false"
      @open="openSearchHit"
      @all="viewAll"
  /></Transition>
  <RemovalDialog
    v-if="trashState.pending.value"
    :impact="trashState.pending.value"
    :busy="busy"
    @confirm="confirmRemoval"
    @close="trashState.cancelRemoval()"
  />
  <ToastStack :toasts="toasts" @dismiss="dismissToast" @action="(item) => item.action?.run()" />
</template>

<style scoped>
.nav-list .nav-item {
  height: 44px;
}
.app-banner {
  position: fixed;
  z-index: 80;
  top: 38px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(720px, 90vw);
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
}
</style>
