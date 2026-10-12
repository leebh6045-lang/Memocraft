<script setup lang="ts">
import { computed } from 'vue';
import type { AiSuggestion } from '../../../shared/ai';
import type { SuggestionPhase } from '../composables/useAiSuggestion';
import AppIcon from './AppIcon.vue';

// 卡片仅展示并上抛用户意图；标签是否已采纳始终以父级草稿为准。
const props = defineProps<{
  phase: SuggestionPhase;
  suggestion: AiSuggestion | null;
  error: string;
  isStale: boolean;
  selectedTags: string[];
  busy: boolean;
}>();

// 图片是否送达以本次主进程回执为准，避免把跳过的图片描述为已发送。
const resultVisible = computed(() => props.phase === 'ready' || props.phase === 'empty');
const privacy = computed(() =>
  resultVisible.value && (props.suggestion?.usedImages ?? 0) > 0
    ? '由 DeepSeek 生成；正文前 800 字、标题、归纳候选、标签和本次纳入图片会发送给 DeepSeek。'
    : '由 DeepSeek 生成；正文前 800 字、标题、归纳候选和标签会发送给 DeepSeek。',
);

defineEmits<{
  close: [];
  retry: [];
  'apply-tag': [tag: string];
  'open-topic': [id: string];
}>();
</script>

<template>
  <section v-if="phase !== 'idle'" class="ai-suggest" aria-label="AI 建议" aria-live="polite">
    <header class="suggest-header">
      <span class="suggest-title"><AppIcon name="sparkle" class="icon-s" />AI 建议</span>
      <button
        type="button"
        class="btn-quiet close"
        aria-label="关闭 AI 建议"
        @click="$emit('close')"
      >
        <AppIcon name="x" class="icon-s" />关闭
      </button>
    </header>

    <div class="suggest-content" :aria-busy="phase === 'loading'">
      <p v-if="phase === 'loading'" class="hint" role="status">正在阅读这条手记…</p>
      <div v-else-if="phase === 'error'" class="row-error">
        <p class="error" role="alert">{{ error }}</p>
        <button type="button" class="btn" :disabled="busy" @click="$emit('retry')">重试</button>
      </div>
      <p v-else-if="phase === 'empty'" class="hint" role="status">没有找到合适的建议。</p>
      <template v-else-if="phase === 'ready' && suggestion">
        <div class="suggest-line">
          <span class="label">标签</span>
          <div v-if="suggestion.tags.length" class="chip-row">
            <button
              v-for="tag in suggestion.tags"
              :key="tag"
              type="button"
              class="chip pick"
              :class="{ on: selectedTags.includes(tag) }"
              :disabled="busy || selectedTags.includes(tag)"
              :aria-pressed="selectedTags.includes(tag)"
              @click="$emit('apply-tag', tag)"
            >
              <AppIcon v-if="selectedTags.includes(tag)" name="check" class="icon-s" />
              <span>{{ tag }}</span>
            </button>
          </div>
          <span v-else class="hint">没有合适的标签建议</span>
        </div>
        <div class="suggest-line">
          <span class="label">可归入</span>
          <div v-if="suggestion.topics.length" class="chip-row topic-row">
            <button
              v-for="topic in suggestion.topics"
              :key="topic.id"
              type="button"
              class="chip pick"
              :disabled="busy"
              @click="$emit('open-topic', topic.id)"
            >
              <span>{{ topic.title }}</span
              ><span aria-hidden="true">→</span>
            </button>
          </div>
          <span v-else class="hint">没有匹配的现有归纳</span>
        </div>
      </template>
      <p
        v-if="resultVisible && suggestion && suggestion.skippedImages > 0"
        class="hint image-feedback"
      >
        <template v-if="!suggestion.imagesSupported">
          当前模型不支持图片，建议仅依据文字；切换到 Flash 可让图片参与判断。
        </template>
        <template v-else>有 {{ suggestion.skippedImages }} 张图片未参与建议。</template>
      </p>
      <p v-if="isStale && (phase === 'ready' || phase === 'empty')" class="hint stale">
        正文或图片已修改，建议可能不再匹配。
        <button type="button" class="btn-ghost" :disabled="busy" @click="$emit('retry')">
          重新生成
        </button>
      </p>
    </div>

    <p class="privacy">{{ privacy }}</p>
  </section>
</template>

<style scoped>
.ai-suggest {
  margin-top: 12px;
  padding: 14px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.suggest-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.suggest-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
.close {
  padding: 5px 8px;
}
.suggest-content {
  min-height: 78px;
  padding: 12px 0 4px;
}
.suggest-line {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 10px;
}
.label {
  flex: 0 0 44px;
  padding-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
.chip-row {
  min-width: 0;
  margin-top: 0;
}
.chip {
  max-width: 100%;
  white-space: normal;
  text-align: left;
}
.chip span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.chip .icon-s {
  flex-shrink: 0;
}
.hint,
.error {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.hint {
  color: var(--muted);
}
.error {
  color: var(--danger);
}
.row-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.row-error .btn {
  flex-shrink: 0;
}
.image-feedback,
.stale {
  margin-top: 4px;
}
.stale .btn-ghost {
  padding-top: 4px;
  padding-bottom: 4px;
}
.privacy {
  margin: 8px 0 0;
  color: var(--faint);
  font-size: 11px;
  overflow-wrap: anywhere;
}
</style>
