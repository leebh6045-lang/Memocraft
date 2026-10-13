<script setup lang="ts">
import { computed, ref } from 'vue';
import AppDialog from './AppDialog.vue';
import type { PickerOption } from '../picker';

/**
 * 通用选择器：手记与归纳两个方向共用，两侧的区别只在条目与文案。
 * 归纳详情用它挑要收录的手记，手记详情用它挑要收录到的归纳；
 * 已经关联的条目显示为不可选，不静默消失，省得用户怀疑列表漏了东西。
 */
const props = defineProps<{
  title: string;
  hint: string;
  options: PickerOption[];
  searchLabel: string;
  searchPlaceholder: string;
  /** 因为已经关联而未列出的条目数量，用来解释「一条都没有」的空状态。 */
  linkedCount: number;
  emptyText: string;
  /** 搜索无匹配与真正没有候选分别说明，避免误称整个知识库为空。 */
  searchEmptyText?: string;
  allLinkedText: string;
  /** 计数单位：手记是「条」，归纳是「个」。 */
  unit: string;
  confirmLabel?: string;
  /** 有值时在列表下方给出新建入口（手记抽屉用它新建归纳）。 */
  createLabel?: string;
  busy?: boolean;
}>();
const emit = defineEmits<{ confirm: [ids: string[]]; create: []; close: [] }>();

/** 选中项由调用方持有：新建的归纳要能被直接勾上。 */
const picked = defineModel<string[]>('picked', { default: () => [] });
const query = ref('');

const matched = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return props.options;
  return props.options.filter((option) => option.searchText.includes(keyword));
});
const emptyReason = computed(() => {
  if (query.value.trim()) return props.searchEmptyText ?? props.emptyText;
  return props.linkedCount > 0 ? props.allLinkedText : props.emptyText;
});

function toggle(id: string): void {
  picked.value = picked.value.includes(id)
    ? picked.value.filter((item) => item !== id)
    : [...picked.value, id];
}
</script>

<template>
  <AppDialog :title="title" :hint="hint" @close="emit('close')">
    <input
      data-autofocus
      class="picker-search"
      type="search"
      :aria-label="searchLabel"
      :placeholder="searchPlaceholder"
      :value="query"
      @input="query = ($event.target as HTMLInputElement).value"
    />
    <div v-if="!matched.length" class="empty">{{ emptyReason }}</div>
    <div v-else class="pick-list">
      <label
        v-for="option in matched"
        :key="option.id"
        class="pick"
        :class="{ 'is-linked': !!option.badge }"
      >
        <input
          type="checkbox"
          :checked="picked.includes(option.id)"
          :disabled="!!option.badge || props.busy"
          @change="toggle(option.id)"
        />
        <span class="pick-main">{{ option.title }}</span>
        <span v-if="option.badge" class="pick-badge">{{ option.badge }}</span>
        <span class="pick-meta">{{ option.meta }}</span>
      </label>
    </div>
    <button
      v-if="createLabel"
      type="button"
      class="inline-add picker-create"
      :disabled="props.busy"
      @click="emit('create')"
    >
      {{ createLabel }}
    </button>
    <template #note>已选 {{ picked.length }} {{ unit }}</template>
    <template #footer>
      <button class="btn-quiet" :disabled="props.busy" @click="emit('close')">取消</button>
      <button
        class="btn-primary"
        :disabled="props.busy || !picked.length"
        @click="emit('confirm', [...picked])"
      >
        {{ confirmLabel ?? '收录' }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.picker-search {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--bg);
  font-size: 13px;
  color: var(--text);
}
.picker-search:focus {
  outline: 0;
  border-color: var(--border-strong);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.picker-create {
  margin-top: 10px;
  align-self: flex-start;
}
</style>
