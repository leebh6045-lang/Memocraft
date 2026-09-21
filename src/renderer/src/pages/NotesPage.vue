<script setup lang="ts">
import { computed } from 'vue';
import { NOTE_CATEGORIES, type Note, type NoteCategory } from '../../../domain/note';
import NoteCard from '../components/NoteCard.vue';
import AppIcon from '../components/AppIcon.vue';

const props = defineProps<{
  notes: Note[];
  filter: NoteCategory | 'all';
  tag: string;
  highlighted: string | null;
}>();
const emit = defineEmits<{
  open: [id: string];
  write: [];
  filter: [category: NoteCategory | 'all'];
  tag: [value: string];
}>();
const filtered = computed(() =>
  props.notes.filter(
    (note) =>
      (props.filter === 'all' || note.category === props.filter) &&
      (!props.tag || note.tags.includes(props.tag)),
  ),
);
const tags = computed(() => [...new Set(props.notes.flatMap((note) => note.tags))].sort());
</script>

<template>
  <section class="view">
    <header class="page-head">
      <div>
        <h1>随手记</h1>
        <p class="sub">全部有效手记，按创建时间倒序。</p>
      </div>
      <button class="btn-primary" @click="emit('write')">
        <AppIcon name="plus" class="icon-s" />写手记
      </button>
    </header>
    <div class="filters">
      <div class="filter-group" aria-label="按分类筛选">
        <button
          v-for="category in NOTE_CATEGORIES"
          :key="category.value"
          class="filter-btn"
          :aria-pressed="filter === category.value"
          @click="emit('filter', category.value)"
        >
          {{ category.label
          }}<span class="count">{{
            notes.filter((note) => note.category === category.value).length
          }}</span>
        </button>
      </div>
      <button class="filter-btn" :aria-pressed="filter === 'all'" @click="emit('filter', 'all')">
        全部<span class="count">{{ notes.length }}</span>
      </button>
    </div>
    <label
      v-if="tags.length"
      class="tag-filter field"
      style="margin-bottom: 18px; flex-direction: row; align-items: center"
      >标签
      <select
        :value="tag"
        aria-label="标签筛选"
        @change="emit('tag', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">全部标签</option>
        <option v-for="item in tags" :key="item" :value="item">{{ item }}</option>
      </select>
    </label>
    <TransitionGroup v-if="filtered.length" name="list" tag="div" class="grid">
      <NoteCard
        v-for="note in filtered"
        :key="note.id"
        :note="note"
        :highlighted="highlighted === note.id"
        @open="emit('open', $event)"
      />
    </TransitionGroup>
    <div v-else class="empty">
      <p>{{ notes.length ? '没有符合当前筛选条件的手记。' : '还没有手记，从首页写下第一条。' }}</p>
      <button class="btn-ghost" @click="emit('write')">去首页写一条</button
      ><button
        v-if="filter !== 'all' || tag"
        class="btn-ghost"
        @click="
          emit('filter', 'all');
          emit('tag', '');
        "
      >
        查看全部
      </button>
    </div>
  </section>
</template>
