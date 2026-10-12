<script setup lang="ts">
import { computed, ref } from 'vue';
import { isoWeekNumber } from '../../../domain/time-range';
import type { AiPeriodType } from '../../../shared/ai';
import type { ReviewState } from '../composables/useReview';
import { formatFullTime, formatTime } from '../format-time';
import { renderMarkdown } from '../markdown';
import ReviewPeriodPicker from '../components/ReviewPeriodPicker.vue';

const props = defineProps<{ state: ReviewState; busy?: boolean }>();
const emit = defineEmits<{ navigate: [target: 'settings'] }>();
// 取消归父层导航与作用域负责，避免 out-in 过渡里旧页面卸载取消新一轮请求。
const { phase, periodType, startDate, endDate, summary, error, errorCode, availablePeriods } =
  props.state;
const weekTab = ref<HTMLButtonElement>();
const monthTab = ref<HTMLButtonElement>();
const contentHost = ref<HTMLElement>();
const actionBusy = computed(() => props.busy || props.state.busy.value);
// 复用关闭 HTML、图片和链接的渲染器；展示主题分点与加粗标题，也兼容已有段落缓存。
const summaryHtml = computed(() => renderMarkdown(summary.value?.summary ?? ''));
const periodKey = computed(() => `${periodType.value}:${startDate.value}`);
// 刷新时保留原正文；新结果、周期和空/错误状态各自完整过渡，快速缓存命中跳过中间帧。
const contentKey = computed(() => {
  const content = summary.value
    ? `${phase.value === 'error' ? 'error:' : ''}summary:${summary.value.generatedAt}`
    : phase.value;
  return `${periodKey.value}:${content}`;
});
let heightChanging = false;

function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function releaseContentHeight(): void {
  contentHost.value?.style.removeProperty('height');
  contentHost.value?.style.removeProperty('overflow');
  heightChanging = false;
}

/** 保持旧内容的实际高度，离场节点只作视觉过渡，不再响应操作或重复播报。 */
function holdContentHeight(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
  const host = contentHost.value;
  if (!host || reducedMotion()) return;
  // 补间时裁掉尚未展开的段落，结算后恢复自然高度，让长正文与窗口换行完整显示。
  host.style.overflow = 'clip';
  host.style.height = `${host.getBoundingClientRect().height}px`;
  heightChanging = false;
}

/** 新内容挂载后再量高度；动画只影响布局，生成和取消不等待动效结束。 */
function resizeContentHeight(element: Element): void {
  const host = contentHost.value;
  if (!host || !(element instanceof HTMLElement)) return;
  if (reducedMotion()) {
    releaseContentHeight();
    return;
  }
  const previousHeight = host.getBoundingClientRect().height;
  const minimumHeight = Number.parseFloat(window.getComputedStyle(host).minHeight) || 0;
  const nextHeight = Math.max(element.getBoundingClientRect().height, minimumHeight);
  host.style.height = `${previousHeight}px`;
  void host.offsetHeight;
  heightChanging = Math.abs(nextHeight - previousHeight) > 1;
  host.style.height = `${nextHeight}px`;
}

function finishContentEnter(): void {
  // 分块凝结独立播放；须等 320ms 高度补间结算后才恢复自然布局。
  if (!heightChanging || reducedMotion()) releaseContentHeight();
}

function finishContentHeight(event: TransitionEvent): void {
  // 快速切换重定向高度时继续补间；中途启用减少动态则立即释放被取消的高度与裁切。
  if (event.propertyName === 'height' && (event.type === 'transitionend' || reducedMotion()))
    releaseContentHeight();
}

function cancelContentLeave(element: Element): void {
  if (element instanceof HTMLElement) {
    element.inert = false;
    element.removeAttribute('aria-hidden');
  }
  releaseContentHeight();
}

function monthDay(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

const periodLabel = computed(() => {
  if (periodType.value === 'month') {
    const [year, month] = startDate.value.split('-');
    return `${Number(year)}年${Number(month)}月`;
  }
  const { year, week } = isoWeekNumber(startDate.value);
  return `${year}年第${week}周（${monthDay(startDate.value)}–${monthDay(endDate.value)}）`;
});

function chooseTab(type: AiPeriodType): void {
  if (!props.busy) props.state.setPeriodType(type);
}

/** 两个标签采用自动激活与单个 Tab 停靠点，方向键切换后同步焦点。 */
function tabKeydown(event: KeyboardEvent): void {
  if (event.isComposing || props.busy) return;
  let type: AiPeriodType;
  if (event.key === 'Home') type = 'week';
  else if (event.key === 'End') type = 'month';
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    type = periodType.value === 'week' ? 'month' : 'week';
  else return;
  event.preventDefault();
  chooseTab(type);
  (type === 'week' ? weekTab.value : monthTab.value)?.focus();
}
</script>

<template>
  <section class="view review-page">
    <header class="page-head">
      <div>
        <h1 tabindex="-1">回顾</h1>
        <p class="sub">回看一段时间的手记积累，找出值得继续推进的事。</p>
      </div>
      <div class="seg period-switcher" role="tablist" aria-label="回顾周期" @keydown="tabKeydown">
        <span
          class="seg-thumb"
          :style="{ '--selected-index': periodType === 'week' ? 0 : 1 }"
          aria-hidden="true"
        />
        <button
          id="review-week-tab"
          ref="weekTab"
          type="button"
          role="tab"
          :aria-selected="periodType === 'week'"
          aria-controls="review-period-panel"
          :tabindex="periodType === 'week' ? 0 : -1"
          :disabled="props.busy"
          @click="chooseTab('week')"
        >
          按周
        </button>
        <button
          id="review-month-tab"
          ref="monthTab"
          type="button"
          role="tab"
          :aria-selected="periodType === 'month'"
          aria-controls="review-period-panel"
          :tabindex="periodType === 'month' ? 0 : -1"
          :disabled="props.busy"
          @click="chooseTab('month')"
        >
          按月
        </button>
      </div>
    </header>

    <div
      id="review-period-panel"
      class="review-period-panel"
      role="tabpanel"
      :aria-labelledby="periodType === 'week' ? 'review-week-tab' : 'review-month-tab'"
    >
      <ReviewPeriodPicker
        :start-date="startDate"
        :label="periodLabel"
        :period-type="periodType"
        :options="availablePeriods"
        :disabled="props.busy"
        @select="props.state.jumpToPeriod($event)"
      />
      <div class="section-divider" aria-hidden="true" />

      <div
        ref="contentHost"
        class="review-content"
        aria-live="polite"
        @transitionend.self="finishContentHeight"
        @transitioncancel.self="finishContentHeight"
      >
        <Transition
          name="review-content"
          mode="out-in"
          @before-leave="holdContentHeight"
          @enter="resizeContentHeight"
          @after-enter="finishContentEnter"
          @leave-cancelled="cancelContentLeave"
        >
          <div :key="contentKey" class="review-content-frame">
            <div
              v-if="phase === 'loading' && !summary"
              class="review-section review-skeleton review-reveal"
              role="status"
              aria-busy="true"
              aria-label="正在生成回顾"
            >
              <h2 class="review-section-title">总结</h2>
              <div class="review-skeleton-text" aria-hidden="true">
                <div class="skeleton-line skeleton-long" />
                <div class="skeleton-line skeleton-medium" />
                <div class="skeleton-line skeleton-short" />
              </div>
            </div>

            <p v-if="phase === 'empty'" class="review-empty review-reveal">这段时间没有新手记。</p>
            <div
              v-else-if="phase === 'error' && errorCode === 'AI_NOT_CONFIGURED'"
              class="review-notice review-reveal"
            >
              <p>请先在设置页配置 DeepSeek API Key，才能生成回顾。</p>
              <button
                type="button"
                class="btn"
                :disabled="props.busy"
                @click="emit('navigate', 'settings')"
              >
                前往设置
              </button>
            </div>
            <div v-else-if="phase === 'error'" class="review-error review-reveal" role="alert">
              <p>{{ error }}</p>
              <p v-if="summary" class="review-retained">以下保留上次生成的回顾。</p>
              <button type="button" class="btn" :disabled="actionBusy" @click="props.state.retry()">
                重试
              </button>
            </div>

            <template v-if="summary">
              <section class="review-section">
                <h2 class="review-section-title review-reveal">总结</h2>
                <!-- 仅插入 renderMarkdown 的安全输出，原始 HTML、链接与图片均不执行。 -->
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div class="review-summary-text summary-text review-reveal" v-html="summaryHtml" />
              </section>
              <template v-if="summary.suggestions.length">
                <div
                  class="section-divider review-summary-divider review-reveal"
                  aria-hidden="true"
                />
                <section class="review-section review-recommendations review-reveal">
                  <h2 class="review-section-title">推荐</h2>
                  <ul class="review-suggestions">
                    <li v-for="(item, index) in summary.suggestions" :key="index">{{ item }}</li>
                  </ul>
                </section>
              </template>
              <footer class="review-meta summary-meta review-reveal">
                <div>
                  <span>覆盖 {{ summary.noteCount }} 条手记</span>
                  <span aria-hidden="true"> · </span>
                  <span class="summary-generated">
                    上次生成于
                    <time
                      :datetime="summary.generatedAt"
                      :title="formatFullTime(summary.generatedAt)"
                      >{{ formatTime(summary.generatedAt) }}</time
                    >
                  </span>
                </div>
                <button
                  type="button"
                  class="btn-ghost"
                  :disabled="actionBusy"
                  @click="props.state.regenerate()"
                >
                  {{ phase === 'loading' ? '正在生成…' : '重新生成' }}
                </button>
              </footer>
              <p
                v-if="(summary.skippedImages ?? 0) > 0 && summary.imagesSupported === false"
                class="review-image-receipt review-reveal"
              >
                当前模型不支持图片，本次回顾仅使用文字。
              </p>
              <p v-else-if="summary.skippedImages" class="review-image-receipt review-reveal">
                有 {{ summary.skippedImages }} 张图片未参与本次回顾。
              </p>
            </template>
          </div>
        </Transition>
      </div>
    </div>
  </section>
</template>

<style scoped>
.period-switcher {
  display: inline-grid;
  grid-template-columns: repeat(2, 64px);
  flex-shrink: 0;
}
.period-switcher .seg-thumb {
  left: 3px;
  width: 64px;
  transform: translateX(calc(var(--selected-index) * 66px));
}
.period-switcher button[aria-selected='true'] {
  color: var(--text);
  font-weight: 500;
}
.section-divider {
  height: 1px;
  margin: 28px 0;
  background: var(--border);
}
.review-content {
  min-height: 320px;
  transition: height var(--dur-3) var(--ease);
}
.review-content-frame {
  display: flow-root;
}
/* 回顾入口仅由内容分块凝结，不叠加应用外壳的整体淡入和上移。 */
.review-page.page-enter-active {
  transition: none;
}
.review-page.page-enter-from {
  opacity: 1;
  transform: none;
}
.review-page.page-leave-active,
.review-content-leave-active {
  transition: opacity var(--dur-1) ease;
}
.review-page.page-leave-to,
.review-content-leave-to {
  opacity: 0;
  transform: none;
}
/* 透明度先显现，模糊线性收敛；仅 5px 位移，按原型从总结到推荐、元信息依次凝实。 */
.review-reveal {
  animation:
    review-condense-opacity var(--review-duration, 450ms) ease backwards,
    review-condense-blur var(--review-duration, 450ms) linear backwards;
  animation-delay: var(--review-delay, 0ms);
}
.review-summary-text {
  --review-delay: 120ms;
  --review-duration: 550ms;
}
.review-summary-divider {
  --review-delay: 500ms;
  --review-duration: 400ms;
}
.review-recommendations {
  --review-delay: 620ms;
  --review-duration: 500ms;
}
.review-meta {
  --review-delay: 800ms;
  --review-duration: 500ms;
}
.review-image-receipt {
  --review-delay: 900ms;
  --review-duration: 500ms;
}
/* 中途切走时冻结当前凝结进度再淡出，避免未显现的区块突然跳到完成态。 */
.review-content-leave-active .review-reveal,
.page-leave-active .review-reveal {
  animation-play-state: paused;
}
/* 键盘先进入尚未显现的按钮时立即清晰，避免焦点落在透明内容上。 */
.review-reveal:focus-within {
  animation: none;
}
@keyframes review-condense-opacity {
  from {
    opacity: 0;
  }
  55%,
  to {
    opacity: 1;
  }
}
@keyframes review-condense-blur {
  from {
    filter: blur(8px);
    transform: translateY(5px);
  }
  to {
    filter: blur(0);
    transform: translateY(0);
  }
}
.review-section-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 14px;
}
.review-suggestions li {
  white-space: pre-wrap;
}
.summary-text,
.review-suggestions li {
  overflow-wrap: anywhere;
}
.summary-text {
  font-size: 15px;
  line-height: 1.9;
  color: var(--text);
}
.summary-text :deep(ul),
.summary-text :deep(ol) {
  margin: 0;
  padding-left: 22px;
}
.summary-text :deep(li + li),
.summary-text :deep(p + p) {
  margin-top: 14px;
}
.summary-text :deep(li p + p) {
  margin-top: 6px;
}
.summary-text :deep(strong) {
  font-weight: 600;
}
.summary-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 24px;
  color: var(--muted);
  font-size: 12px;
}
.summary-generated {
  display: inline-block;
}
.review-image-receipt {
  margin-top: 8px;
  color: var(--muted);
  font-size: 12px;
}
.review-suggestions {
  margin: 0;
  padding-left: 22px;
  list-style: disc;
}
.review-suggestions li {
  line-height: 1.65;
}
.review-suggestions li + li {
  margin-top: 10px;
}
.review-empty,
.review-notice {
  padding: 64px 0;
  text-align: center;
  color: var(--muted);
}
.review-notice .btn {
  margin-top: 16px;
}
.review-error {
  margin-bottom: 28px;
  color: var(--danger);
}
.review-error .btn {
  margin-top: 12px;
}
.review-retained {
  margin-top: 6px;
  color: var(--muted);
  font-size: 13px;
}
.review-skeleton-text {
  display: grid;
  gap: 14px;
  padding: 7px 0;
}
.skeleton-line {
  height: 14px;
  border-radius: 4px;
  background: var(--surface-2);
  animation: review-pulse 1.6s ease-in-out infinite;
}
.skeleton-long {
  width: 94%;
}
.skeleton-medium {
  width: 82%;
}
.skeleton-short {
  width: 61%;
}
@keyframes review-pulse {
  50% {
    opacity: 0.45;
  }
}
@media (prefers-reduced-motion: reduce) {
  .period-switcher .seg-thumb,
  .review-content,
  .review-page.page-leave-active,
  .review-content-leave-active {
    transition: none;
  }
  .review-page.page-leave-to,
  .review-content-leave-to {
    opacity: 1;
    transform: none;
  }
  .review-reveal,
  .skeleton-line {
    animation: none;
  }
}
@media (max-width: 720px) {
  .summary-meta {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
