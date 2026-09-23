<script setup lang="ts">
import { computed, ref } from 'vue';
import { noteTitle, type Note } from '../../../domain/note';
import AppDialog from './AppDialog.vue';
import { formatTime } from '../format-time';

/**
 * 收录选择器：在已有手记中多选后一次提交。
 * 已在目标归纳中的手记显示为已收录且不可重复选择，避免制造无意义的重复操作。
 */
const props = defineProps<{
  notes: Note[];
  collectedIds: string[];
  busy?: boolean;
}>();
const emit = defineEmits<{ confirm: [noteIds: string[]]; close: [] }>();

const query = ref('');
const picked = ref<string[]>([]);

const collected = computed(() => new Set(props.collectedIds));
const allCollected = computed(
  () => props.notes.length > 0 && collected.value.size >= props.notes.length,
);
const candidates = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  return props.notes.filter((note) => {
    if (collected.value.has(note.id)) return false;
    if (!keyword) return true;
    return (
      noteTitle(note).toLowerCase().includes(keyword) ||
      note.body.toLowerCase().includes(keyword) ||
      note.tags.some((tag) => tag.toLowerCase().includes(keyword))
    );
  });
});

function toggle(noteId: string): void {
  picked.value = picked.value.includes(noteId)
    ? picked.value.filter((id) => id !== noteId)
    : [...picked.value, noteId];
}
</script>

<template>
  <AppDialog
    title="收录手记"
    hint="搜索并选择要收录到当前归纳的手记，可多选后一次提交。"
    @close="emit('close')"
  >
    <input
      data-autofocus
      class="picker-search"
      type="search"
      aria-label="搜索手记"
      placeholder="搜索标题、正文或标签"
      :value="query"
      @input="query = ($event.target as HTMLInputElement).value"
    />
    <div v-if="!candidates.length" class="empty">
      {{ allCollected ? '全部手记都已收录在这个归纳里。' : '没有匹配的手记，换个词或先去写一条。' }}
    </div>
    <div v-else class="pick-list">
      <label v-for="note in candidates" :key="note.id" class="pick">
        <input type="checkbox" :checked="picked.includes(note.id)" @change="toggle(note.id)" />
        <span class="pick-main">{{ noteTitle(note) }}</span>
        <time :datetime="note.createdAt">{{ formatTime(note.createdAt) }}</time>
      </label>
    </div>
    <template #note>已选 {{ picked.length }} 条</template>
    <template #footer>
      <button class="btn-quiet" :disabled="props.busy" @click="emit('close')">取消</button>
      <button
        class="btn-primary"
        :disabled="props.busy || !picked.length"
        @click="emit('confirm', [...picked])"
      >
        收录
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
</style>
