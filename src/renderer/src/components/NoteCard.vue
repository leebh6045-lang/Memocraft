<script setup lang="ts">
import { computed } from 'vue';
import { categoryLabel, noteTitle, type Note } from '../../../domain/note';
import { formatFullTime, formatTime } from '../format-time';

const props = defineProps<{
  note: Note;
  highlighted?: boolean;
  /**
   * 这条手记被收录到的归纳名字。空数组表示没被收录——卡片上不会出现任何标记。
   * 归纳详情里不必传：那里的每一条都已经在这个归纳里，标记没有信息量。
   */
  collected?: string[];
}>();
defineEmits<{ open: [id: string] }>();

const createdLabel = computed(() => formatTime(props.note.createdAt));
const fullCreatedDate = computed(() => formatFullTime(props.note.createdAt));
const collectedLabel = computed(() =>
  props.collected?.length ? `已收录到：${props.collected.join('、')}` : '',
);
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
    <span v-if="note.tags.length || collected?.length" class="card-foot">
      <span v-for="tag in note.tags" :key="tag" class="tag-chip"
        ><span class="tag-hash" aria-hidden="true">#</span>{{ tag }}</span
      >
      <!-- 「已收录」与标签同尺寸，只差颜色；收录到一个不写数字，多个才写 · N。 -->
      <span v-if="collected?.length" class="collected-pill" :title="collectedLabel"
        >已收录<span v-if="collected.length > 1" class="count">&nbsp;· {{ collected.length }}</span
        ><span class="sr-only">，{{ collectedLabel }}</span></span
      >
    </span>
  </button>
</template>
