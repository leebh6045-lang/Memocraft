<script setup lang="ts">
import { computed, ref } from 'vue';
import { TRASH_KIND_LABELS, TRASH_KINDS, type TrashKind } from '../../../domain/trash';
import { formatFullTime, formatTime } from '../format-time';
import type { TrashState } from '../composables/useTrash';

const props = defineProps<{ state: TrashState; busy: boolean }>();
const emit = defineEmits<{
  notify: [payload: { message: string; undo?: () => void }];
  /** 恢复会改变收录与引用关系，外壳据此刷新各模块的列表。 */
  restored: [];
}>();

const filter = ref<TrashKind | 'all'>('all');
const items = props.state.items;
const error = props.state.error;
const loading = props.state.loading;

const visible = computed(() =>
  filter.value === 'all' ? items.value : items.value.filter((item) => item.kind === filter.value),
);
const counts = computed(() => {
  const result = new Map<TrashKind, number>();
  for (const item of items.value) result.set(item.kind, (result.get(item.kind) ?? 0) + 1);
  return result;
});

const filters: { value: TrashKind | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  ...TRASH_KINDS.map((kind) => ({ value: kind, label: TRASH_KIND_LABELS[kind] })),
];

async function restore(kind: TrashKind, id: string): Promise<void> {
  if (await props.state.restore(kind, id)) {
    emit('restored');
    emit('notify', {
      message: `已恢复${TRASH_KIND_LABELS[kind]}`,
      // 撤销 = 再删一次；删除语义与别处一致，不另建恢复栈。
      undo: () => {
        void props.state.requestRemoval(kind, id).then((removed) => {
          if (removed) emit('notify', { message: '已重新移入回收站' });
        });
      },
    });
    return;
  }
  // 恢复失败要把原因说清楚（例如父事务仍在回收站），不能只留一行静默状态。
  if (error.value) emit('notify', { message: error.value });
}
</script>

<template>
  <section class="view">
    <header class="page-head">
      <div>
        <h1>回收站</h1>
        <p class="sub">删除的内容保留在这里，可以随时恢复；不提供自动清空与永久删除。</p>
      </div>
      <div class="actions">
        <div class="seg seg-sm" role="radiogroup" aria-label="内容类型">
          <button
            v-for="option in filters"
            :key="option.value"
            type="button"
            role="radio"
            :aria-checked="filter === option.value"
            @click="filter = option.value"
          >
            {{ option.label
            }}<span v-if="option.value !== 'all' && counts.get(option.value)" class="count">
              {{ counts.get(option.value) }}</span
            >
          </button>
        </div>
      </div>
    </header>

    <p class="notebar">
      <span
        >删除事务会让它的动态一起隐藏；恢复事务<b>不会</b>恢复此前单独删除的动态。回收站内容不参与搜索。</span
      >
    </p>

    <div v-if="error && !items.length" class="empty" role="alert">
      {{ error }}<br />
      <button class="btn-ghost" @click="props.state.load()">重试读取</button>
    </div>
    <div v-else-if="loading && !items.length" class="empty">正在读取回收站…</div>
    <div v-else-if="!visible.length" class="empty">
      {{
        items.length
          ? '这个类型下没有内容。'
          : '回收站是空的。删除的手记、归纳、事务与动态会留在这里。'
      }}
    </div>
    <div v-else class="rows">
      <div v-for="item in visible" :key="`${item.kind}-${item.id}`" class="row">
        <span class="type-pill">{{ TRASH_KIND_LABELS[item.kind] }}</span>
        <span class="row-main">
          <span class="row-title">{{ item.title }}</span>
          <span class="row-ctx">{{ item.context }}</span>
        </span>
        <time :datetime="item.deletedAt" :title="formatFullTime(item.deletedAt)">{{
          formatTime(item.deletedAt)
        }}</time>
        <button class="btn" :disabled="props.busy" @click="restore(item.kind, item.id)">
          恢复
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.count {
  margin-left: 5px;
  font-size: 11px;
  color: var(--faint);
}
</style>
