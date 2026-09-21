<script setup lang="ts">
import { computed } from 'vue';
import { categoryLabel, noteTitle, type Note } from '../../../domain/note';

const props = defineProps<{ note: Note; highlighted?: boolean }>();
defineEmits<{ open: [id: string] }>();

const createdDate = computed(() =>
  new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(
    new Date(props.note.createdAt),
  ),
);
const fullCreatedDate = computed(() => new Date(props.note.createdAt).toLocaleString('zh-CN'));
</script>

<template>
  <button
    type="button"
    class="card"
    :class="{ 'is-new': highlighted }"
    @click="$emit('open', note.id)"
  >
    <span class="card-meta">
      <span class="cat" :class="`cat-${note.category}`">{{ categoryLabel(note.category) }}</span>
      <time :datetime="note.createdAt" :title="fullCreatedDate">{{ createdDate }}</time>
    </span>
    <span class="card-title">{{ noteTitle(note) }}</span>
    <span class="card-excerpt">{{ note.body }}</span>
    <span v-if="note.tags.length" class="card-foot">
      <span v-for="tag in note.tags" :key="tag" class="tag">{{ tag }}</span>
    </span>
  </button>
</template>
