<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { categoryLabel, noteExcerpt, noteTitle, type Note } from '../../../domain/note';
import { imageLabel, type NoteImageIndex, type NoteImageSummary } from '../../../domain/note-image';
import type { TopicSummary } from '../../../domain/topic';
import { formatFullTime, formatTime } from '../format-time';
import { renderMarkdown } from '../markdown';
import { imageUrl } from '../../../shared/contracts';
import { contentScroller } from '../scroll';
import ImageViewer from './ImageViewer.vue';

/**
 * 连读：把一个归纳里收录的手记连成一篇文档，每条手记是一个小节。
 * 右侧「本页目录」随滚动高亮当前小节，悬停或键盘聚焦小节时出现「打开」与「移出」。
 * 只负责呈现与定位，收录关系的变化由页面处理。
 */
const props = defineProps<{
  /** 当前归纳，用于算出「另见」的其他归纳。 */
  topicId: string;
  /** 已经按当前顺序排好的手记；本组件不再排序。 */
  notes: Note[];
  /** 全部归纳，仅用于「另见」；不含关系的计算放在这里，页面不必再传函数。 */
  topics: TopicSummary[];
  imageIndex: NoteImageIndex;
}>();
const emit = defineEmits<{
  open: [id: string];
  remove: [id: string];
  'open-topic': [id: string];
}>();

const root = ref<HTMLElement | null>(null);
const activeId = ref('');
/** 正在放大的图片：连同它所在小节的整组图片一起交给放大层，可翻上一张 / 下一张。 */
const viewing = ref<{ images: NoteImageSummary[]; startId: string } | null>(null);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 小节内容一次算好：模板里不再重复渲染 Markdown，也不反复过滤归纳关系。 */
const sections = computed(() =>
  props.notes.map((note, index) => {
    const body = noteExcerpt(note);
    return {
      note,
      number: String(index + 1).padStart(2, '0'),
      title: noteTitle(note),
      bodyHtml: body ? renderMarkdown(body) : '',
      images: props.imageIndex[note.id] ?? [],
      others: props.topics.filter(
        (topic) => topic.id !== props.topicId && topic.noteIds.includes(note.id),
      ),
    };
  }),
);

const sectionId = (noteId: string): string => `doc-${noteId}`;

/**
 * 滚动高亮：取视口上方一条基线，最后一个越过基线的小节算当前；
 * 已经滚到底时直接高亮最后一节，否则最后一节永远点不亮。
 */
function syncActive(): void {
  const element = root.value;
  if (!element) return;
  const nodes = element.querySelectorAll<HTMLElement>('.doc-sec');
  if (!nodes.length) return;
  const scroller = contentScroller();
  const line = (scroller?.getBoundingClientRect().top ?? 0) + 96;
  let current = nodes[0];
  for (const node of nodes) if (node.getBoundingClientRect().top <= line) current = node;
  if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4)
    current = nodes[nodes.length - 1];
  activeId.value = current?.dataset.section ?? '';
}

/** 目录跳转交给浏览器滚动最近的滚动容器，并给固定标题栏留出偏移（见 .doc-sec 的 scroll-margin）。 */
function jumpTo(noteId: string): void {
  document.getElementById(sectionId(noteId))?.scrollIntoView({
    behavior: reducedMotion ? 'instant' : 'smooth',
    block: 'start',
  });
}

let scrollTarget: EventTarget | null = null;
onMounted(() => {
  scrollTarget = contentScroller() ?? window;
  scrollTarget.addEventListener('scroll', syncActive, { passive: true });
  void nextTick(syncActive);
});
onBeforeUnmount(() => scrollTarget?.removeEventListener('scroll', syncActive));
// 手记增删或换顺序后小节位置随即变化，重新判断当前小节。
watch(
  () => props.notes,
  () => void nextTick(syncActive),
);
</script>

<template>
  <div ref="root" class="doc">
    <div class="doc-main">
      <section
        v-for="section in sections"
        :id="sectionId(section.note.id)"
        :key="section.note.id"
        class="doc-sec"
        :data-section="section.note.id"
      >
        <h2>
          <span class="doc-no" aria-hidden="true">{{ section.number }}</span>
          <span>{{ section.title }}</span>
        </h2>
        <div class="doc-sub">
          <span class="cat" :class="`cat-${section.note.category}`">{{
            categoryLabel(section.note.category)
          }}</span>
          <time
            :datetime="section.note.createdAt"
            :title="formatFullTime(section.note.createdAt)"
            >{{ formatTime(section.note.createdAt) }}</time
          >
          <span v-if="section.note.tags.length" class="doc-tags">
            <span v-for="tag in section.note.tags" :key="tag" class="tag-chip"
              ><span class="tag-hash" aria-hidden="true">#</span>{{ tag }}</span
            >
          </span>
          <span v-if="section.others.length" class="doc-also"
            >另见<button
              v-for="other in section.others"
              :key="other.id"
              type="button"
              class="btn-ghost inline"
              @click="emit('open-topic', other.id)"
            >
              「{{ other.title }}」
            </button></span
          >
        </div>
        <!-- 正文由 markdown-it 渲染：禁用 HTML、图片与链接，输出已转义，不是用户提供的 HTML。 -->
        <!-- eslint-disable vue/no-v-html -->
        <div v-if="section.bodyHtml" class="doc-body md" v-html="section.bodyHtml" />
        <!-- eslint-enable vue/no-v-html -->
        <div v-if="section.images.length" class="doc-imgs">
          <!-- 点图放大：与抽屉图集共用同一层，可翻上一张 / 下一张，Esc 只关这一层。 -->
          <button
            v-for="(image, index) in section.images"
            :key="image.id"
            type="button"
            class="doc-thumb"
            :aria-label="`放大查看 ${imageLabel(image, index)}`"
            @click="viewing = { images: section.images, startId: image.id }"
          >
            <img
              :src="imageUrl(image)"
              :alt="imageLabel(image, index)"
              :title="imageLabel(image, index)"
              loading="lazy"
              decoding="async"
              width="120"
              height="84"
            />
          </button>
        </div>
        <div class="doc-actions">
          <button type="button" class="btn-quiet" @click="emit('open', section.note.id)">
            打开
          </button>
          <button type="button" class="btn-quiet" @click="emit('remove', section.note.id)">
            移出
          </button>
        </div>
      </section>
    </div>
    <nav class="doc-toc" aria-label="本页目录">
      <div class="doc-toc-h">本页目录</div>
      <a
        v-for="section in sections"
        :key="section.note.id"
        :href="`#${sectionId(section.note.id)}`"
        :class="{ active: activeId === section.note.id }"
        :aria-current="activeId === section.note.id ? 'true' : undefined"
        @click.prevent="jumpTo(section.note.id)"
      >
        <span class="n" aria-hidden="true">{{ section.number }}</span>
        <span>{{ section.title }}</span>
      </a>
    </nav>

    <ImageViewer
      v-if="viewing"
      :images="viewing.images"
      :start-id="viewing.startId"
      @close="viewing = null"
    />
  </div>
</template>

<style scoped>
.doc {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 164px;
  gap: 40px;
  align-items: start;
}
.doc-main {
  min-width: 0;
}
.doc-sec {
  position: relative;
  margin-bottom: 30px;
  padding-bottom: 30px;
  border-bottom: 1px solid var(--border);
  /* 目录跳转后给固定的标题栏留出位置。 */
  scroll-margin-top: 78px;
}
.doc-sec:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: 0;
}
.doc-sec h2 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-right: 130px;
  font-size: 18px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.doc-no {
  flex: none;
  font-size: 13px;
  font-weight: 500;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.doc-sub {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  margin: 6px 0 12px 23px;
  font-size: 12px;
  color: var(--faint);
}
.doc-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}
.doc-body {
  margin-left: 23px;
  font-size: 15px;
  line-height: 1.85;
  overflow-wrap: anywhere;
}
.doc-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0 0 23px;
}
/* 缩略图本身是按钮：点它放大查看，因此去掉按钮默认样式并给出悬停反馈。 */
.doc-thumb {
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  overflow: hidden;
  transition:
    border-color var(--dur-1) ease,
    transform var(--dur-1) ease;
}
.doc-thumb:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.doc-imgs img {
  display: block;
  width: 120px;
  height: 84px;
  object-fit: cover;
}
/* 小节动作只在悬停或键盘聚焦时出现，平时让位给正文。 */
.doc-actions {
  position: absolute;
  top: -3px;
  right: 0;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--dur-1) ease;
}
.doc-actions .btn-quiet {
  padding: 5px 9px;
  font-size: 12px;
}
.doc-sec:hover .doc-actions,
.doc-sec:focus-within .doc-actions {
  opacity: 1;
}
.doc-toc {
  position: sticky;
  top: 18px;
  display: flex;
  flex-direction: column;
  font-size: 12.5px;
}
.doc-toc-h {
  margin-bottom: 8px;
  font-size: 11.5px;
  letter-spacing: 0.06em;
  color: var(--faint);
}
.doc-toc a {
  display: flex;
  gap: 7px;
  padding: 5px 0 5px 11px;
  border-left: 2px solid var(--border);
  line-height: 1.45;
  color: var(--muted);
  transition:
    color var(--dur-1) ease,
    border-color var(--dur-2) ease;
}
.doc-toc a:hover {
  color: var(--text);
}
.doc-toc a.active {
  border-left-color: var(--accent);
  color: var(--text);
}
.doc-toc a .n {
  flex: none;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.doc-toc a span:last-child {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 窄窗口放不下右侧目录：隐藏目录后正文单列，连读仍然可用。 */
@media (max-width: 900px) {
  .doc {
    grid-template-columns: minmax(0, 1fr);
  }
  .doc-toc {
    display: none;
  }
}
</style>
