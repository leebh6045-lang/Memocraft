<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useModalFocus } from '../composables/useModalFocus';
import { useModalLayer } from '../composables/useModalLayer';

/**
 * 通用对话框：原生语义的模态层，挂在 body 上，主内容由调用方置于 inert 之后。
 * 只负责焦点范围、Esc 关闭与结构，具体字段与按钮由插槽提供。
 * 背景点击不关闭：表单里已输入的内容不能因为误点而丢失。
 */
defineProps<{ title: string; hint?: string }>();
const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
const layer = useModalLayer();
const { trapTab } = useModalFocus(panel, '[data-autofocus], input, textarea, button');

function handleKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !layer.isTop()) return;
  event.preventDefault();
  event.stopPropagation();
  emit('close');
}

onMounted(() => {
  layer.enter();
  document.addEventListener('keydown', handleKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKey, true);
  layer.leave();
});
</script>

<template>
  <Teleport to="body">
    <div class="dialog-backdrop" />
    <div
      ref="panel"
      class="dialog-panel"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      @keydown.tab="trapTab"
    >
      <div class="dialog-body">
        <h2>{{ title }}</h2>
        <p v-if="hint" class="hint">{{ hint }}</p>
        <slot />
      </div>
      <div class="dialog-foot">
        <span class="left"><slot name="note" /></span>
        <slot name="footer" />
      </div>
    </div>
  </Teleport>
</template>
