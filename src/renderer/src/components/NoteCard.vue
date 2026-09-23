<script setup lang="ts">
import { computed } from 'vue';
import { categoryLabel, noteTitle, type Note } from '../../../domain/note';
import { formatFullTime, formatTime } from '../format-time';

const props = defineProps<{ note: Note; highlighted?: boolean; topics?: string[] }>();
defineEmits<{ open: [id: string] }>();

const createdLabel = computed(() => formatTime(props.note.createdAt));
const fullCreatedDate = computed(() => formatFullTime(props.note.createdAt));
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
      <time :datetime="note.createdAt" :title="fullCreatedDate">{{ createdLabel }}</time>
    </span>
    <span class="card-title">{{ noteTitle(note) }}</span>
    <span class="card-excerpt">{{ note.body }}</span>
    <span v-if="note.tags.length || props.topics?.length" class="card-foot">
      <span v-for="tag in note.tags" :key="tag" class="tag">{{ tag }}</span>
      <span v-if="props.topics?.length">收录于 {{ props.topics.join('、') }}</span>
    </span>
  </button>
</template>
