<script setup lang="ts">
/**
 * 动态字段组：描述、发生时间、正文与标签。
 * 新建（时间线输入区）与编辑（对话框）共用同一份字段，避免两处规则漂移。
 */
defineProps<{
  summary: string;
  occurredAt: string;
  body: string;
  tagsText: string;
  disabled?: boolean;
  textareaRows?: number;
  /** 时间线的输入区已有描述字段，那里不再重复渲染一次。 */
  showSummary?: boolean;
}>();
const emit = defineEmits<{
  'update:summary': [value: string];
  'update:occurredAt': [value: string];
  'update:body': [value: string];
  'update:tagsText': [value: string];
}>();
</script>

<template>
  <label v-if="showSummary !== false" class="field wide"
    >动态描述（必填）<input
      :value="summary"
      :disabled="disabled"
      maxlength="300"
      placeholder="做了什么、想到什么、决定了什么"
      @input="emit('update:summary', ($event.target as HTMLInputElement).value)"
  /></label>
  <div class="entry-fields">
    <label class="field"
      >发生时间<input
        type="datetime-local"
        :value="occurredAt"
        :disabled="disabled"
        @input="emit('update:occurredAt', ($event.target as HTMLInputElement).value)"
    /></label>
    <label class="field"
      >标签（可选）<input
        :value="tagsText"
        :disabled="disabled"
        placeholder="逗号分隔"
        @input="emit('update:tagsText', ($event.target as HTMLInputElement).value)"
    /></label>
  </div>
  <label class="field wide"
    >详细内容（可选，Markdown）<textarea
      :value="body"
      :disabled="disabled"
      :rows="textareaRows ?? 3"
      placeholder="补上背景、判断依据或结论"
      @input="emit('update:body', ($event.target as HTMLTextAreaElement).value)"
    />
  </label>
</template>

<style scoped>
.entry-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}
</style>
