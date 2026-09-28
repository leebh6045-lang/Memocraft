<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { categoryLabel, noteExcerpt, noteTitle, type Note } from '../../../domain/note';
import { imageLabel, type NoteImageSummary } from '../../../domain/note-image';
import { formatFullTime, formatTime } from '../format-time';
import { renderMarkdown } from '../markdown';
import { imageUrl } from '../../../shared/contracts';

/**
 * 阅读流里的一条手记：单列宽卡片，正文按 Markdown 直接渲染，超过高度上限淡出，
 * 完整内容与编辑仍在手记抽屉里。标签与「已收录」规则与网格卡片一致。
 */
const props = defineProps<{
  note: Note;
  highlighted?: boolean;
  /** 被收录到的归纳名字；空数组不显示标记。 */
  collected?: string[];
  /** 替换时间文字；叠加按时间分段、且按天分段时传入时刻。 */
  timeLabel?: string;
  /** 这条手记的附图摘要；列表里最多露出前三张，其余只报数量。 */
  images?: NoteImageSummary[];
}>();
const emit = defineEmits<{ open: [id: string] }>();

/** 列表里的缩略图上限：再多也只是重复同一批缩小图，数量写在卡片顶部。 */
const MAX_THUMBNAILS = 3;
const thumbnails = computed(() => (props.images ?? []).slice(0, MAX_THUMBNAILS));
const hiddenImageCount = computed(() => Math.max((props.images?.length ?? 0) - MAX_THUMBNAILS, 0));

const createdLabel = computed(() => props.timeLabel ?? formatTime(props.note.createdAt));
const fullCreatedDate = computed(() => formatFullTime(props.note.createdAt));
const collectedLabel = computed(() =>
  props.collected?.length ? `已收录到：${props.collected.join('、')}` : '',
);
/** 摘要跳过被当作标题的首行（见 domain/note.ts），阅读流把正文整段摊开，不再重复这一行。 */
const excerpt = computed(() => noteExcerpt(props.note));
// 与抽屉预览同一份渲染器：禁用 HTML、图片与链接，内容经 markdown-it 转义。
const renderedBody = computed(() => (excerpt.value ? renderMarkdown(excerpt.value) : ''));

// 只有真的超出高度上限才加淡出；宽度变化会改变折行，所以随尺寸重新测量。
// 正文区只在有内容时渲染，编辑后可能出现或消失，因此跟着元素本身挂接观察器。
const body = ref<HTMLElement | null>(null);
const clamped = ref(false);
function measure(): void {
  const element = body.value;
  clamped.value = element !== null && element.scrollHeight > element.clientHeight + 1;
}
const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
watch(
  body,
  (element, previous) => {
    if (previous) observer?.unobserve(previous);
    if (element) observer?.observe(element);
    measure();
  },
  { flush: 'post' },
);
// 首次挂载时模板 ref 已就位；重复 observe 同一元素不会叠加回调。
onMounted(() => {
  if (body.value) observer?.observe(body.value);
  measure();
});
watch(renderedBody, () => void nextTick(measure));
onBeforeUnmount(() => observer?.disconnect());

/** 整张卡片都可点；拖选正文复制时不打开抽屉。标题按钮的点击会冒泡到这里，只处理一次。 */
function open(): void {
  if (window.getSelection()?.toString()) return;
  emit('open', props.note.id);
}
</script>

<template>
  <article class="card stream-card" :class="{ 'is-new': highlighted }" @click="open">
    <div class="stream-meta">
      <span class="cat" :class="`cat-${note.category}`">{{ categoryLabel(note.category) }}</span>
      <time :datetime="note.createdAt" :title="fullCreatedDate">{{ createdLabel }}</time>
      <!-- 有附图时先说明张数，缩略图只露出前三张。 -->
      <template v-if="images?.length">
        <span class="sep" aria-hidden="true">·</span>
        <span>{{ images.length }} 张图</span>
      </template>
    </div>
    <h2 class="stream-title">
      <!-- 键盘入口：整张卡片不是按钮（内含段落与列表），标题按钮承担可读名称与焦点。 -->
      <button type="button">{{ noteTitle(note) }}</button>
    </h2>
    <!-- 正文由 markdown-it 渲染：禁用 HTML、图片与链接，输出已转义，不是用户提供的 HTML。
         元素跨多行时 eslint-disable-next-line 落到属性之外，因此这里用区段开关。 -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="renderedBody"
      ref="body"
      class="stream-body md"
      :class="{ 'is-clamped': clamped }"
      v-html="renderedBody"
    />
    <!-- eslint-enable vue/no-v-html -->
    <!-- 缩略图按 ID 走自定义协议取图；懒加载避免一次解码整列图片，失败时由浏览器留下占位。 -->
    <div v-if="thumbnails.length" class="stream-images">
      <img
        v-for="(image, index) in thumbnails"
        :key="image.id"
        :src="imageUrl(image)"
        :alt="imageLabel(image, index)"
        :title="imageLabel(image, index)"
        loading="lazy"
        decoding="async"
        width="120"
        height="84"
      />
      <span v-if="hiddenImageCount" class="image-more">+{{ hiddenImageCount }}</span>
    </div>
    <div v-if="note.tags.length || collected?.length" class="card-foot">
      <span v-for="tag in note.tags" :key="tag" class="tag-chip"
        ><span class="tag-hash" aria-hidden="true">#</span>{{ tag }}</span
      >
      <span v-if="collected?.length" class="collected-pill" :title="collectedLabel"
        >已收录<span v-if="collected.length > 1" class="count">&nbsp;· {{ collected.length }}</span
        ><span class="sr-only">，{{ collectedLabel }}</span></span
      >
    </div>
  </article>
</template>

<style scoped>
.stream-card {
  gap: 10px;
  padding: 20px 24px 18px;
}
.stream-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--faint);
}
.stream-title {
  font-size: 16px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.stream-title button {
  display: block;
  width: 100%;
  text-align: left;
  font-weight: 600;
  letter-spacing: -0.01em;
}
/* 约 8 行正文；超出部分淡出，提示点开看全文。 */
.stream-body {
  max-height: 202px;
  overflow: hidden;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.8;
}
.stream-body.is-clamped {
  -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent);
  mask-image: linear-gradient(to bottom, #000 62%, transparent);
}
.stream-body :deep(ul),
.stream-body :deep(ol) {
  margin: 0 0 8px;
  padding-left: 1.3em;
}
.stream-body :deep(pre) {
  margin: 6px 0 8px;
}
.stream-body :deep(h1),
.stream-body :deep(h2),
.stream-body :deep(h3) {
  margin: 0 0 6px;
  font-size: 15px;
}
/* 附图缩略图：与手记图集同一裁切比例，多出来的只报数量，不铺满整列。 */
.stream-images {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.stream-images img {
  width: 120px;
  height: 84px;
  object-fit: cover;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-2);
}
.image-more {
  font-size: 12px;
  color: var(--faint);
}
</style>
