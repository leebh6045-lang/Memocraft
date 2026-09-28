<script setup lang="ts">
import { computed, ref } from 'vue';
import { NOTE_CATEGORIES, type Note, type NoteCategory } from '../../../domain/note';
import type { NoteImageIndex, NoteImageSummary } from '../../../domain/note-image';
import type { TopicSummary } from '../../../domain/topic';
import NoteCard from '../components/NoteCard.vue';
import NoteStreamCard from '../components/NoteStreamCard.vue';
import AppIcon from '../components/AppIcon.vue';
import { formatClock } from '../format-time';
import { groupNotesByTime, timelineLabel } from '../note-timeline';
import {
  NOTES_LAYOUTS,
  TIMELINE_GRAINS,
  readNotesLayout,
  readTimelineGrain,
  writeNotesLayout,
  writeTimelineGrain,
  type NotesLayout,
  type TimelineGrain,
} from '../view-preferences';

const props = defineProps<{
  notes: Note[];
  filter: NoteCategory | 'all';
  tag: string;
  highlighted: string | null;
  /** 归纳列表：卡片据此显示「已收录」胶囊，没有收录就不显示任何标记。 */
  topics: TopicSummary[];
  /** 按手记 ID 索引的附图摘要，用于阅读流卡片的缩略图；没有附图的手记不出现。 */
  imageIndex: NoteImageIndex;
}>();
const emit = defineEmits<{
  open: [id: string];
  write: [];
  filter: [category: NoteCategory | 'all'];
  tag: [value: string];
  notify: [payload: { message: string }];
}>();
const filtered = computed(() =>
  props.notes.filter(
    (note) =>
      (props.filter === 'all' || note.category === props.filter) &&
      (!props.tag || note.tags.includes(props.tag)),
  ),
);
const tags = computed(() => [...new Set(props.notes.flatMap((note) => note.tags))].sort());
const topicsOf = (noteId: string): string[] =>
  props.topics.filter((topic) => topic.noteIds.includes(noteId)).map((topic) => topic.title);
/** 没有附图的手记在索引里不出现，这里统一补成空数组，模板不必再判空。 */
const imagesOf = (noteId: string): NoteImageSummary[] => props.imageIndex[noteId] ?? [];

// 呈现方式只改变怎么摆，不改变筛选结果与顺序；偏好存在本机，每次进入页面读取一次。
const layout = ref<NotesLayout>(readNotesLayout());
const grain = ref<TimelineGrain>(readTimelineGrain());
const UNSAVED = '偏好未能保存，重启后会回到默认呈现。';
/** 阅读流与「按时间」都按时间分段，共用同一个分段方式；只有网格不分组。 */
const grouped = computed(() => layout.value !== 'grid');

function chooseLayout(value: NotesLayout): void {
  if (layout.value === value) return;
  layout.value = value;
  if (!writeNotesLayout(value)) emit('notify', { message: `已切换呈现方式，但${UNSAVED}` });
}

function chooseGrain(event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  const value = TIMELINE_GRAINS.find((option) => option.value === target.value)?.value;
  if (!value || value === grain.value) return;
  grain.value = value;
  if (!writeTimelineGrain(value)) emit('notify', { message: `已切换分段方式，但${UNSAVED}` });
}

/** 按时间分段：日期栏文字随分段一起算好，模板里不再拼字符串。 */
const timeGroups = computed(() =>
  groupNotesByTime(filtered.value, grain.value).map((group) => ({
    ...group,
    label: timelineLabel(group),
  })),
);
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
    <!-- 标签筛选靠左，呈现设置整组靠右：分段方式在左、呈现方式在最右。 -->
    <div v-if="notes.length" class="list-toolbar">
      <label v-if="tags.length" class="tag-filter field"
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
      <div class="toolbar-end">
        <!-- 分段方式只对分段呈现有意义；网格不分组，不显示这一项，也不写「分段」二字。 -->
        <label v-if="grouped" class="tag-filter field">
          <select :value="grain" aria-label="按时间分段的方式" @change="chooseGrain">
            <option v-for="option in TIMELINE_GRAINS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
        </label>
        <div class="seg seg-sm" role="radiogroup" aria-label="呈现方式">
          <button
            v-for="option in NOTES_LAYOUTS"
            :key="option.value"
            type="button"
            role="radio"
            :aria-checked="layout === option.value"
            @click="chooseLayout(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="!filtered.length" class="empty">
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

    <!-- 分段：左侧日期栏随滚动吸附，右侧是网格卡片（按时间）或宽卡片（阅读流）；
         两种呈现都按时间分段，按天分出的段里卡片只写时刻。 -->
    <div
      v-else-if="grouped"
      :key="`${layout}-${grain}`"
      class="timeline layout-in"
      :class="{ 'is-stream': layout === 'stream' }"
    >
      <section v-for="group in timeGroups" :key="group.key" class="time-group">
        <div class="time-rail">
          <h2 class="time-label">
            <span class="time-primary" aria-hidden="true"
              >{{ group.label.primary
              }}<small v-if="group.label.unit">{{ group.label.unit }}</small></span
            >
            <span v-if="group.label.detail" class="time-detail" aria-hidden="true">{{
              group.label.detail
            }}</span>
            <span v-if="group.label.mark" class="time-mark" aria-hidden="true">{{
              group.label.mark
            }}</span>
            <span class="sr-only">{{ group.label.spoken }}，</span>
            <span class="time-count">{{ group.notes.length }} 条</span>
          </h2>
        </div>
        <TransitionGroup v-if="layout === 'stream'" name="list" tag="div" class="stream">
          <NoteStreamCard
            v-for="note in group.notes"
            :key="note.id"
            :note="note"
            :highlighted="highlighted === note.id"
            :collected="topicsOf(note.id)"
            :images="imagesOf(note.id)"
            :time-label="group.kind === 'day' ? formatClock(note.createdAt) : undefined"
            @open="emit('open', $event)"
          />
        </TransitionGroup>
        <TransitionGroup v-else name="list" tag="div" class="grid">
          <NoteCard
            v-for="note in group.notes"
            :key="note.id"
            :note="note"
            :highlighted="highlighted === note.id"
            :collected="topicsOf(note.id)"
            :time-label="group.kind === 'day' ? formatClock(note.createdAt) : undefined"
            @open="emit('open', $event)"
          />
        </TransitionGroup>
      </section>
    </div>

    <TransitionGroup v-else key="grid" name="list" tag="div" class="grid layout-in">
      <NoteCard
        v-for="note in filtered"
        :key="note.id"
        :note="note"
        :highlighted="highlighted === note.id"
        :collected="topicsOf(note.id)"
        @open="emit('open', $event)"
      />
    </TransitionGroup>
  </section>
</template>

<style scoped>
.list-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px 16px;
  margin-bottom: 18px;
}
/* .field 默认纵向排列；这里的标签与下拉框同一行。 */
.list-toolbar .field {
  flex-direction: row;
  align-items: center;
}
/* 呈现设置整组靠右：标签筛选留在左边，中间留白由这里撑开。 */
.toolbar-end {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-left: auto;
}

/* 切换呈现方式时列表整体淡入；系统减少动态时由全局规则压成即时。 */
.layout-in {
  animation: layout-in var(--dur-2) var(--ease) both;
}
@keyframes layout-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.stream {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.time-group {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr);
  gap: 18px;
  padding: 20px 0 26px;
  border-top: 1px solid var(--border);
}
.time-group:first-child {
  padding-top: 2px;
  border-top: 0;
}
.time-rail {
  min-width: 0;
}
/* 日期栏吸附在滚动区顶部，整段滚过后随段落离开；不连线，和长期事务的时间线区分开。 */
.time-label {
  position: sticky;
  top: 18px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0;
}
.time-primary {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.time-primary small {
  margin-left: 1px;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: 0;
}
.time-detail {
  line-height: 1.5;
  color: var(--muted);
}
.time-mark {
  margin-top: 5px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.75;
}
.time-count {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--faint);
}
@media (max-width: 900px) {
  .time-group {
    grid-template-columns: 56px minmax(0, 1fr);
    gap: 14px;
  }
}
</style>
