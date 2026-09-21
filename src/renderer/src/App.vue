<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Note, NoteCategory } from '../../domain/note';
import AppIcon from './components/AppIcon.vue';
import HomePage from './pages/HomePage.vue';
import NotesPage from './pages/NotesPage.vue';
import PlannedModule from './pages/PlannedModule.vue';
import NoteDrawer from './components/NoteDrawer.vue';
import SearchPalette from './components/SearchPalette.vue';
import { useLibrary } from './composables/useLibrary';
import type { MemocraftApi } from '../../shared/contracts';

const api = window.memocraft;
// 普通浏览器不伪造保存能力；正式应用必须通过 preload 接入本地库。
const unavailable = async () => ({
  ok: false as const,
  error: {
    code: 'UNAVAILABLE' as const,
    message: '请在 Memocraft 桌面应用中打开，本地数据连接尚未建立。',
  },
});
const disconnectedApi: MemocraftApi = {
  load: unavailable,
  saveDraft: unavailable,
  commitDraft: unavailable,
  updateNote: unavailable,
  search: unavailable,
  onCloseRequested: () => () => undefined,
  onCloseCancelled: () => () => undefined,
  closeReady: () => undefined,
  closeCancelled: () => undefined,
  platform: 'mac',
};
const library = useLibrary(api ?? disconnectedApi);
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
type Page = (typeof pages)[number]['id'];
const page = ref<Page>('home');
const filter = ref<NoteCategory | 'all'>('all');
const tag = ref('');
const focused = ref(false);
const theme = ref<'light' | 'dark'>('light');
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
const toast = ref('');
const saveFeedback = ref(false);
const main = ref<HTMLElement | null>(null);
const busy = computed(() => closing.value || submitting.value || navigating.value);
const shortcut = api?.platform === 'mac' ? '⌘' : 'Ctrl';
const activeIndex = computed(() => pages.findIndex((item) => item.id === page.value));
const scrollPositions = new Map<Page, number>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let saveFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
let themeTimer: ReturnType<typeof setTimeout> | undefined;
let closingAttempt = 0;
let removeCloseListener: () => void = () => undefined;
let removeCancelListener: () => void = () => undefined;

function announce(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = '';
  }, 3000);
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

async function viewAll() {
  searchOpen.value = false;
  filter.value = 'all';
  tag.value = '';
  await nextTick();
  await navigate('notes');
}

function toggleTheme() {
  clearTimeout(themeTimer);
  document.documentElement.classList.add('theme-switching');
  // 先让浏览器记录旧主题的计算样式，再切换变量，避免文字先闪到新颜色。
  void document.documentElement.offsetWidth;
  theme.value = theme.value === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme.value;
  themeTimer = setTimeout(() => {
    document.documentElement.classList.remove('theme-switching');
  }, 340);
  // 只存外观偏好；正文、草稿和关系始终由 SQLite 持久化。
  try {
    localStorage.setItem('memocraft-theme', theme.value);
  } catch {
    announce('主题已切换，但外观偏好未能保存。');
  }
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
  try {
    theme.value = localStorage.getItem('memocraft-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    banner.value = '外观偏好读取失败，已使用浅色主题。';
  }
  document.documentElement.dataset.theme = theme.value;
  document.addEventListener('keydown', handleKey);
  removeCloseListener =
    api?.onCloseRequested(() => {
      void requestClose();
    }) ?? (() => undefined);
  removeCancelListener =
    api?.onCloseCancelled(() => {
      closingAttempt += 1;
      closing.value = false;
      closingStore.value = false;
      banner.value = '关闭未完成，窗口和编辑内容已保留。请重试保存。';
    }) ?? (() => undefined);
  void library.initialize();
});
onBeforeUnmount(() => {
  motionPreference.removeEventListener('change', syncMotionPreference);
  document.removeEventListener('keydown', handleKey);
  removeCloseListener();
  removeCancelListener();
  clearTimeout(toastTimer);
  clearTimeout(saveFeedbackTimer);
  clearTimeout(themeTimer);
});
</script>

<template>
  <div class="titlebar" aria-hidden="true" />
  <div class="app" :class="{ focus: focused }" :inert="searchOpen || !!editing || closing">
    <aside class="nav" :inert="focused">
      <div class="nav-brand">
        <div class="brand-name">Memocraft</div>
      </div>
      <nav class="nav-list" aria-label="主导航">
        <div
          class="nav-ind"
          :style="{ transform: `translateY(${activeIndex * 46}px)`, height: '44px' }"
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
          <AppIcon :name="theme === 'light' ? 'moon' : 'sun'" /><span class="label">{{
            theme === 'light' ? '深色' : '浅色'
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
        />
        <NotesPage
          v-else-if="page === 'notes'"
          key="notes"
          :notes="notes"
          :filter="filter"
          :tag="tag"
          :highlighted="latestSavedId"
          @open="openNote"
          @write="navigate('home')"
          @filter="filter = $event"
          @tag="tag = $event"
        />
        <PlannedModule v-else :key="page" :module="page" />
      </Transition>
    </main>
  </div>
  <div class="beta">内测中</div>
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
      @change="library.changeNote"
      @close="closeDrawer"
      @retry="library.flushNote"
  /></Transition>
  <!-- 子层分别过渡，父层等待完整时长再移除，避免截断模糊退出。 -->
  <Transition name="palette-transition" :duration="reducedMotion ? 0 : 320"
    ><SearchPalette
      v-if="searchOpen && api"
      :api="api"
      :change-version="changeVersion"
      :inert="closing"
      @close="searchOpen = false"
      @open="openSearchNote"
      @all="viewAll"
  /></Transition>
  <Transition name="page"
    ><div v-if="toast" class="save-toast" role="status">
      <AppIcon name="check" />{{ toast }}
    </div></Transition
  >
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
.save-toast {
  position: fixed;
  z-index: 60;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  background: var(--text);
  color: var(--bg);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  font-size: 13px;
}
</style>
