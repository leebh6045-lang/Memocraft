<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { categoryLabel, noteTitle, type Note } from '../../../domain/note';
import type { MemocraftApi } from '../../../shared/contracts';
import AppIcon from './AppIcon.vue';
import { useModalFocus } from '../composables/useModalFocus';

const props = defineProps<{ api: MemocraftApi; changeVersion: number }>();
const emit = defineEmits<{ close: []; open: [note: Note]; all: [] }>();
const panel = ref<HTMLElement | null>(null);
const { trapTab } = useModalFocus(panel, 'input');
const query = ref('');
const results = ref<Note[]>([]);
const index = ref(0);
const loading = ref(false);
const error = ref('');
const hasMore = ref(false);
let requestVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function search(version: number) {
  try {
    const response = await props.api.search(query.value);
    // 旧关键词的迟到响应不更新结果；卸载时也会使当前请求失效。
    if (version !== requestVersion) return;
    if (!response.ok) {
      error.value = response.error.message;
      results.value = [];
      return;
    }
    results.value = response.value.notes;
    hasMore.value = response.value.hasMore;
    index.value = 0;
  } catch {
    if (version === requestVersion) {
      error.value = '搜索暂时不可用，请重试。';
      results.value = [];
    }
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}

function scheduleSearch() {
  clearTimeout(timer);
  const version = ++requestVersion;
  loading.value = true;
  error.value = '';
  timer = setTimeout(
    () => {
      void search(version);
    },
    query.value ? 120 : 0,
  );
}
watch([query, () => props.changeVersion], scheduleSearch, { immediate: true });
onBeforeUnmount(() => {
  clearTimeout(timer);
  requestVersion += 1;
});

async function handleKeys(event: KeyboardEvent) {
  trapTab(event);
  // 中文候选字的确认与选择先交给输入法，不能误触结果导航。
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    index.value = Math.max(
      0,
      Math.min(results.value.length - 1, index.value + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    await nextTick();
    panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
    event.preventDefault();
    const note = results.value[index.value];
    if (note && !loading.value) emit('open', note);
  }
}

function snippet(note: Note): string {
  const at = note.body.toLowerCase().indexOf(query.value.trim().toLowerCase());
  return note.body.slice(Math.max(0, at - 22), Math.max(0, at - 22) + 120).replace(/\s+/g, ' ');
}
</script>

<template>
  <div>
    <div class="palette-backdrop" aria-hidden="true" @click="emit('close')" />
    <section
      ref="panel"
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-label="全局搜索"
      tabindex="-1"
      @keydown="handleKeys"
    >
      <div class="palette-input">
        <AppIcon name="search" /><input
          v-model="query"
          aria-label="搜索手记"
          placeholder="搜索手记正文、标题与标签…"
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="search-results"
          :aria-expanded="true"
          :aria-activedescendant="results[index] ? `search-${results[index]?.id}` : undefined"
        /><button class="btn-quiet" aria-label="关闭搜索" @click="emit('close')">
          <kbd>Esc</kbd>
        </button>
      </div>
      <div class="palette-results" :aria-busy="loading">
        <p v-if="error" class="palette-empty" role="alert">
          {{ error }}<button class="btn-ghost" @click="scheduleSearch">重试</button>
        </p>
        <p v-else-if="loading" class="palette-empty" role="status">正在搜索…</p>
        <template v-else>
          <div v-if="results.length" class="palette-group">
            {{ query.trim() ? '手记' : '最近手记' }}
          </div>
          <div id="search-results" role="listbox" aria-label="搜索结果">
            <button
              v-for="(note, i) in results"
              :id="`search-${note.id}`"
              :key="note.id"
              class="palette-item"
              role="option"
              :aria-selected="index === i"
              @mousemove="index = i"
              @click="emit('open', note)"
            >
              <span class="pi-type">手记</span
              ><span class="pi-main"
                ><span class="pi-title">{{ noteTitle(note) }}</span
                ><span class="pi-excerpt">{{ snippet(note) }}</span></span
              ><span class="pi-ctx">{{ categoryLabel(note.category) }}</span>
            </button>
          </div>
          <div v-if="!results.length" class="palette-empty">
            {{ query ? '没有匹配的内容。' : '还没有保存的手记。' }}<br /><button
              class="btn-ghost"
              @click="emit('all')"
            >
              查看全部手记
            </button>
          </div>
          <p v-if="hasMore" class="palette-hint">已显示前 50 条，请补充关键词缩小范围。</p>
        </template>
      </div>
      <footer class="palette-foot">
        <span><kbd>↑↓</kbd> 选择</span><span><kbd>↩</kbd> 打开</span
        ><span>当前检索手记，草稿不参与</span>
      </footer>
    </section>
  </div>
</template>
