<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { imageLabel, type ViewableImage } from '../../../domain/note-image';
import { imageUrl } from '../../../shared/contracts';
import { useModalFocus } from '../composables/useModalFocus';
import { useModalLayer } from '../composables/useModalLayer';

/**
 * 图片放大层：抽屉图集与归纳连读共用同一层。
 *
 * 只负责这一层自己：当前张数、上一张 / 下一张、Tab 范围与 Esc。
 * 挂载时接管焦点、卸载时把焦点还给打开它的那个缩略图（useModalFocus 负责），
 * 调用方只需要记住「打开的是哪张图片」。
 */
const props = defineProps<{
  images: ViewableImage[];
  /** 打开时先显示这张；它已经不在列表里时退回第一张。 */
  startId: string;
}>();
const emit = defineEmits<{ close: [] }>();

const index = ref(
  Math.max(
    props.images.findIndex((image) => image.id === props.startId),
    0,
  ),
);
const viewing = computed(() => props.images[index.value] ?? null);
const caption = computed(() => (viewing.value ? imageLabel(viewing.value, index.value) : ''));
const panel = ref<HTMLElement | null>(null);
// 放大层压在抽屉之上：进入模态层后全局快捷键与下层抽屉的 Esc 都让位。
const layer = useModalLayer();
const { trapTab } = useModalFocus(panel, '.viewer-close');

function step(delta: number): void {
  if (props.images.length === 0) return;
  const count = props.images.length;
  index.value = (index.value + delta + count) % count;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    // Esc 只关这一层，不顺手关掉背后的抽屉或退出专注模式。
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key === 'ArrowRight') step(1);
  if (event.key === 'ArrowLeft') step(-1);
}

onMounted(() => {
  // 焦点由 useModalFocus 接管：挂载后聚焦关闭按钮，卸载后还给打开它的控件。
  layer.enter();
});
onBeforeUnmount(() => layer.leave());
</script>

<template>
  <Teleport to="body">
    <div
      v-if="viewing"
      class="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="查看图片"
      @keydown="onKey"
    >
      <div class="viewer-backdrop" aria-hidden="true" @click="emit('close')" />
      <div ref="panel" class="viewer-panel" tabindex="-1" @keydown="trapTab">
        <img class="viewer-image" :src="imageUrl(viewing)" :alt="caption" />
        <div class="viewer-bar">
          <button class="btn-quiet" :disabled="images.length < 2" @click="step(-1)">上一张</button>
          <span class="viewer-caption">{{ caption }}</span>
          <button class="btn-quiet" :disabled="images.length < 2" @click="step(1)">下一张</button>
          <button class="viewer-close btn-quiet" @click="emit('close')">关闭 <kbd>Esc</kbd></button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: grid;
  place-items: center;
  padding: 40px 24px;
}
.viewer-backdrop {
  position: absolute;
  inset: 0;
  background: var(--backdrop);
}
.viewer-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: min(1100px, 92vw);
  max-height: 100%;
}
.viewer-panel:focus {
  outline: 0;
}
.viewer-image {
  max-width: 100%;
  max-height: calc(100vh - 140px);
  object-fit: contain;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
}
.viewer-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
  font-size: 13px;
}
.viewer-caption {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.viewer-close {
  margin-left: auto;
}
</style>
