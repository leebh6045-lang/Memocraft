<script setup lang="ts">
import type { AiAnswer } from '../../../shared/ai';
import type { AskPhase } from '../composables/useAiAsk';
import AppIcon from './AppIcon.vue';

// 回答与来源均由父层传入；展示组件只上抛意图，不解析编号或修改手记。
defineProps<{
  phase: AskPhase;
  answer: AiAnswer | null;
  error: string;
  expanded: boolean;
}>();
defineEmits<{
  retry: [];
  expand: [];
  collapse: [];
  'open-note': [noteId: string];
}>();
</script>

<template>
  <section v-if="phase !== 'idle'" class="ai-answer-row" aria-label="AI 问答" aria-live="polite">
    <div v-if="phase === 'loading'" class="ai-ask" role="status" aria-busy="true">
      <AppIcon name="sparkle" class="icon-s" />
      <span class="hint">正在从你的手记中查找…</span>
    </div>
    <template v-else-if="phase === 'ready' && answer">
      <button
        v-if="!expanded"
        type="button"
        class="ai-ask is-result"
        aria-expanded="false"
        @click="$emit('expand')"
      >
        <AppIcon name="sparkle" class="icon-s" />
        <!-- 摘要仅在视觉上省略，展开始终展示完整正文；模型文字按纯文本渲染。 -->
        <span class="ai-summary">{{ answer.answer }}</span>
        <span v-if="answer.sources.length" class="source-count"
          >{{ answer.sources.length }} 个来源</span
        >
        <span class="ai-more">展开 →</span>
      </button>
      <div v-else class="ai-ask is-expanded">
        <div class="answer-heading"><AppIcon name="sparkle" class="icon-s" />AI 回答</div>
        <p class="ai-answer">{{ answer.answer }}</p>
        <div v-if="answer.sources.length" class="ai-sources">
          <span class="label">来源</span>
          <button
            v-for="source in answer.sources"
            :key="source.noteId"
            type="button"
            class="source-link"
            :title="source.title"
            @click="$emit('open-note', source.noteId)"
          >
            [{{ source.index }}] {{ source.title }}
          </button>
        </div>
        <button type="button" class="btn-ghost" aria-expanded="true" @click="$emit('collapse')">
          收起
        </button>
      </div>
    </template>
    <div v-else-if="phase === 'empty'" class="ai-ask" role="status">
      <AppIcon name="sparkle" class="icon-s" />
      <span class="hint">这次没找到相关手记，换个词试试。</span>
    </div>
    <div v-else-if="phase === 'error'" class="ai-ask is-error" role="alert">
      <span class="error-message">{{ error }}</span>
      <button type="button" class="btn-ghost" @click="$emit('retry')">重试</button>
    </div>
  </section>
</template>

<style scoped>
.ai-answer-row {
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.ai-ask {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px;
  border-radius: 8px;
  text-align: left;
  font-size: 13px;
  line-height: 1.5;
}
.ai-ask > .icon-s {
  flex-shrink: 0;
  color: var(--accent);
}
.hint,
.source-count {
  color: var(--muted);
}
.is-result:hover,
.source-link:hover {
  background: var(--surface-2);
}
.ai-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-more,
.source-count {
  flex-shrink: 0;
  font-size: 11px;
}
.ai-more {
  color: var(--accent);
}
.is-expanded {
  display: block;
}
.answer-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
}
.ai-answer {
  margin: 8px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ai-sources {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  margin: 10px 0 4px;
}
.label {
  color: var(--muted);
  font-size: 11px;
}
.source-link {
  max-width: 100%;
  padding: 4px 6px;
  border-radius: 4px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font-size: 12px;
}
.is-error {
  justify-content: space-between;
  color: var(--danger);
}
.error-message {
  min-width: 0;
  overflow-wrap: anywhere;
}
.is-error .btn-ghost {
  flex-shrink: 0;
}
</style>
