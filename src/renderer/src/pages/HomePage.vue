<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  categoryLabel,
  noteTitle,
  type Note,
  type NoteContent,
  type NoteDraft,
} from '../../../domain/note';
import AppIcon from '../components/AppIcon.vue';
import { formatFullTime, formatTime } from '../format-time';
import CategorySelector from '../components/CategorySelector.vue';

const props = defineProps<{
  draft: NoteDraft;
  notes: Note[];
  status: string;
  error: string;
  busy: boolean;
  saved: boolean;
  shortcut: string;
  focused: boolean;
}>();
const emit = defineEmits<{
  change: [patch: Partial<NoteContent & { extrasOpen: boolean }>];
  save: [];
  retry: [];
  open: [id: string];
  navigate: [page: 'notes' | 'topics' | 'threads'];
  focus: [];
  'create-topic': [];
  'create-thread': [];
}>();
const body = ref<HTMLTextAreaElement | null>(null);
const shaking = ref(false);
let shakeTimer: ReturnType<typeof setTimeout> | undefined;
const tagsText = ref(props.draft.tags.join(', '));
watch(
  () => props.error,
  (message) => {
    // 正文为空时服务端会拒绝提交：这里给出可见反馈并把焦点送回正文，避免只留一行红字。
    if (!message || props.draft.body.trim()) return;
    shaking.value = true;
    body.value?.focus({ preventScroll: true });
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => {
      shaking.value = false;
    }, 320);
  },
);
watch(
  () => props.draft.id,
  async () => {
    tagsText.value = props.draft.tags.join(', ');
    await nextTick();
    body.value?.focus();
  },
);
onMounted(() => body.value?.focus({ preventScroll: true }));
onBeforeUnmount(() => clearTimeout(shakeTimer));
function updateTags(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  tagsText.value = event.target.value;
  emit('change', {
    tags: [
      ...new Set(
        tagsText.value
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
  });
}
</script>

<template>
  <section class="view view-home">
    <header class="page-head">
      <div>
        <h1>新手记</h1>
        <p class="sub">只需写下正文，其他都可以稍后补。</p>
      </div>
      <button class="btn-quiet" :aria-pressed="focused" @click="emit('focus')">
        <AppIcon name="focus" />专注
      </button>
    </header>
    <div class="editor" :class="{ 'is-shake': shaking }">
      <textarea
        ref="body"
        class="editor-body"
        aria-label="手记正文"
        placeholder="现在想到什么……"
        :value="draft.body"
        :disabled="busy"
        @input="emit('change', { body: ($event.target as HTMLTextAreaElement).value })"
      />
      <div class="editor-extras" :class="{ open: draft.extrasOpen }" :inert="!draft.extrasOpen">
        <div>
          <div class="extras-grid">
            <label class="field"
              >标题（可选）<input
                :value="draft.title"
                :disabled="busy"
                placeholder="留空则取正文第一行"
                @input="emit('change', { title: ($event.target as HTMLInputElement).value })"
            /></label>
            <label class="field"
              >标签（可选）<input
                :value="tagsText"
                :disabled="busy"
                placeholder="逗号分隔，如 sqlite, 备份"
                @input="updateTags"
            /></label>
            <div class="field wide">
              <span>归纳与事务关联</span
              ><span class="faint">先保存手记，再到手记详情里收录到归纳或关联事务。</span>
            </div>
          </div>
        </div>
      </div>
      <div class="editor-bar">
        <div class="editor-bar-left">
          <CategorySelector
            :model-value="draft.category"
            :disabled="busy"
            @update:model-value="emit('change', { category: $event })"
          />
          <button
            class="btn-quiet"
            :disabled="busy"
            :aria-expanded="draft.extrasOpen"
            @click="emit('change', { extrasOpen: !draft.extrasOpen })"
          >
            补充<AppIcon name="chevron" class="icon-s" />
          </button>
        </div>
        <div class="editor-bar-right">
          <kbd>{{ shortcut }} ↩</kbd
          ><button
            class="btn-primary"
            :class="{ 'is-success': saved && !busy }"
            :disabled="busy"
            :aria-label="busy ? '正在保存…' : '保存手记'"
            @click="emit('save')"
          >
            <span class="btn-label">{{ busy ? '正在保存…' : '保存手记' }}</span>
            <span class="btn-ok" aria-hidden="true"
              ><AppIcon name="check" class="icon-s" />已保存</span
            >
          </button>
        </div>
      </div>
    </div>
    <div class="draft-status" :class="{ error, 'is-empty': !status && !error }" aria-live="polite">
      <span class="dot" /><span>{{ error || status }}</span
      ><button v-if="error" class="btn-ghost" @click="emit('retry')">重试</button>
    </div>
    <div class="home-secondary" :inert="focused">
      <div class="home-links">
        <button class="btn-quiet" @click="emit('create-topic')">
          <AppIcon name="plus" class="icon-s" />新建归纳
        </button>
        <button class="btn-quiet" @click="emit('create-thread')">
          <AppIcon name="plus" class="icon-s" />新建事务
        </button>
      </div>
      <div class="section-head">
        <h2>最近手记</h2>
        <button class="btn-ghost" @click="emit('navigate', 'notes')">查看全部 →</button>
      </div>
      <div v-if="!notes.length" class="empty">还没有手记。写下第一条，它会出现在这里。</div>
      <TransitionGroup v-else name="list" tag="div" class="row-list">
        <button
          v-for="note in notes.slice(0, 4)"
          :key="note.id"
          class="row"
          @click="emit('open', note.id)"
        >
          <span class="cat" :class="`cat-${note.category}`">{{ categoryLabel(note.category) }}</span
          ><span class="row-title">{{ noteTitle(note) }}</span>
          <time :datetime="note.createdAt" :title="formatFullTime(note.createdAt)">{{
            formatTime(note.createdAt)
          }}</time>
        </button>
      </TransitionGroup>
    </div>
  </section>
</template>
