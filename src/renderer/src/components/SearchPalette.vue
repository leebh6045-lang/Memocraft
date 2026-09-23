<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { SEARCH_KIND_LABELS, type SearchHit, type SearchKind } from '../../../domain/search';
import type { MemocraftApi } from '../../../shared/contracts';
import AppIcon from './AppIcon.vue';
import { useModalFocus } from '../composables/useModalFocus';
import { containsQuery, highlightMatch } from '../highlight';

const props = defineProps<{ bridge: MemocraftApi; changeVersion: number }>();
const emit = defineEmits<{ close: []; open: [hit: SearchHit]; all: [] }>();
const panel = ref<HTMLElement | null>(null);
const { trapTab } = useModalFocus(panel, 'input');
const query = ref('');
const hits = ref<SearchHit[]>([]);
const index = ref(0);
const loading = ref(false);
const error = ref('');
const hasMore = ref(false);
let requestVersion = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** 结果按对象类型分组，组名在空查询时写明「最近」，有查询时就是类型名本身。 */
const groups = computed(() => {
  const order: SearchKind[] = ['note', 'topic', 'thread', 'entry'];
  return order
    .map((kind) => ({
      kind,
      label: query.value.trim() ? SEARCH_KIND_LABELS[kind] : `最近${SEARCH_KIND_LABELS[kind]}`,
      items: hits.value.filter((hit) => hit.kind === kind),
    }))
    .filter((group) => group.items.length > 0);
});

/** 主行没显示命中位置时，右侧补一段命中上下文。 */
function secondary(hit: SearchHit): string {
  if (!containsQuery(hit.title, query.value) && hit.excerpt) return hit.excerpt;
  return hit.context;
}

async function search(version: number) {
  try {
    const response = await props.bridge.search(query.value);
    // 旧关键词的迟到响应不更新结果；卸载时也会使当前请求失效。
    if (version !== requestVersion) return;
    if (!response.ok) {
      error.value = response.error.message;
      hits.value = [];
      return;
    }
    hits.value = response.value.hits;
    hasMore.value = response.value.hasMore;
    index.value = 0;
  } catch {
    if (version === requestVersion) {
      error.value = '搜索暂时不可用，请重试。';
      hits.value = [];
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
      Math.min(hits.value.length - 1, index.value + (event.key === 'ArrowDown' ? 1 : -1)),
    );
    await nextTick();
    panel.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
    event.preventDefault();
    const hit = hits.value[index.value];
    if (hit && !loading.value) emit('open', hit);
  }
}
</script>

<template>
  <div>
    <div class="palette-blur" aria-hidden="true" />
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
          aria-label="搜索内容"
          placeholder="搜索手记、归纳、事务与动态…"
          autocomplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="search-results"
          :aria-expanded="true"
          :aria-activedescendant="
            hits[index] ? `search-${hits[index]?.kind}-${hits[index]?.id}` : undefined
          "
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
          <div id="search-results" role="listbox" aria-label="搜索结果">
            <template v-for="group in groups" :key="group.kind">
              <div class="palette-group">{{ group.label }}</div>
              <button
                v-for="hit in group.items"
                :id="`search-${hit.kind}-${hit.id}`"
                :key="`${hit.kind}-${hit.id}`"
                class="palette-item"
                role="option"
                :aria-selected="hits[index] === hit"
                @mousemove="index = hits.indexOf(hit)"
                @click="emit('open', hit)"
              >
                <span class="pi-type">{{ SEARCH_KIND_LABELS[hit.kind] }}</span>
                <span class="pi-main"
                  ><!-- 关键词先转义再高亮，见 highlight.ts -->
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <span class="pi-title" v-html="highlightMatch(hit.title, query)" />
                  <span v-if="secondary(hit)" class="pi-excerpt">{{ secondary(hit) }}</span></span
                >
                <span class="pi-ctx">{{ hit.context }}</span>
              </button>
            </template>
          </div>
          <div v-if="!hits.length" class="palette-empty">
            {{ query.trim() ? `没有匹配「${query.trim()}」的内容。` : '还没有任何内容。'
            }}<br /><button class="btn-ghost" @click="emit('all')">查看全部手记</button>
          </div>
          <p v-if="hasMore" class="palette-hint">
            结果较多，已显示前 50 条，请补充关键词缩小范围。
          </p>
        </template>
      </div>
      <footer class="palette-foot">
        <span><kbd>↑↓</kbd> 选择</span><span><kbd>↩</kbd> 打开</span
        ><span>检索手记、归纳、事务与动态；草稿与回收站不参与</span>
      </footer>
    </section>
  </div>
</template>
