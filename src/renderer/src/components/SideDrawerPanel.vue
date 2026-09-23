<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useModalFocus } from '../composables/useModalFocus';
import { useModalLayer } from '../composables/useModalLayer';

/**
 * 抽屉面板本体：随 open 挂载与卸载，因此焦点接管、Esc 让位、
 * 模态层计数都在「真正可见」的那段时间里生效。
 * 与手记抽屉同一套形态：右滑进入、遮罩淡入、Esc 关闭。
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
  <aside
    ref="panel"
    class="drawer"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    tabindex="-1"
    @keydown="trapTab"
  >
    <header class="drawer-head">
      <span class="drawer-kind"
        >{{ title }}<span v-if="hint" class="drawer-hint">{{ hint }}</span></span
      >
      <button class="btn-quiet" @click="emit('close')">关闭 <kbd>Esc</kbd></button>
    </header>
    <div class="drawer-body">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="drawer-foot">
      <slot name="footer" />
    </footer>
  </aside>
</template>
