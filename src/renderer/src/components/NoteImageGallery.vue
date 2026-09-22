<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { imageLabel, type NoteImage } from '../../../domain/note-image';
import { imageUrl } from '../../../shared/contracts';
import AppIcon from './AppIcon.vue';
import { useModalFocus } from '../composables/useModalFocus';

const props = defineProps<{
  images: NoteImage[];
  loading: boolean;
  busy: boolean;
  error: string;
  status: string;
  disabled: boolean;
}>();
const emit = defineEmits<{
  add: [];
  rename: [imageId: string, displayName: string];
  remove: [imageId: string];
}>();

const names = ref<Record<string, string>>({});
const pendingRemoval = ref('');
const viewerIndex = ref<number | null>(null);
const panel = ref<HTMLElement | null>(null);
const thumbnails = ref<HTMLButtonElement[]>([]);
let lastOpenedId: string | null = null;
// Tab 限制在当前可见层：放大层打开时锁定它，关闭后回到抽屉本身。
const { trapTab } = useModalFocus(
  () => (viewerIndex.value === null ? null : panel.value),
  '.viewer-close',
);
let removalTimer: ReturnType<typeof setTimeout> | undefined;

const viewing = computed(() =>
  viewerIndex.value === null ? null : (props.images[viewerIndex.value] ?? null),
);
const nameOf = (image: NoteImage, index: number) =>
  names.value[image.id] ?? imageLabel(image, index);
const caption = computed(() =>
  viewing.value ? imageLabel(viewing.value, viewerIndex.value ?? 0) : '',
);

function commitName(image: NoteImage, index: number) {
  const next = nameOf(image, index).trim();
  // 只有真正变化才写库，避免点开又离开也产生一次写入。
  if (next === image.displayName.trim()) {
    delete names.value[image.id];
    return;
  }
  emit('rename', image.id, next);
}

function requestRemoval(imageId: string) {
  if (pendingRemoval.value === imageId) {
    clearTimeout(removalTimer);
    pendingRemoval.value = '';
    emit('remove', imageId);
    return;
  }
  // 首次点击只进入确认状态，避免在缩略图上误删。
  pendingRemoval.value = imageId;
  clearTimeout(removalTimer);
  removalTimer = setTimeout(() => {
    pendingRemoval.value = '';
  }, 4000);
}

function openViewer(index: number) {
  lastOpenedId = props.images[index]?.id ?? null;
  viewerIndex.value = index;
  void nextTick(() => panel.value?.querySelector<HTMLElement>('.viewer-close')?.focus());
}

/**
 * 关闭放大层并把焦点还给触发它的缩略图。
 * 未命名与重命名都会让列表重渲染，因此按图片 ID 重新定位而不是保存旧引用。
 */
function closeViewer() {
  const target = lastOpenedId ? props.images.findIndex((image) => image.id === lastOpenedId) : -1;
  lastOpenedId = null;
  // 先关层再还焦点：viewerIndex 为 null 时组件不再渲染放大层。
  viewerIndex.value = null;
  void nextTick(() => {
    if (target >= 0) thumbnails.value[target]?.focus({ preventScroll: true });
  });
}

function step(delta: number) {
  if (viewerIndex.value === null || props.images.length === 0) return;
  const count = props.images.length;
  viewerIndex.value = (viewerIndex.value + delta + count) % count;
}

function onViewerKey(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    // 放大层是抽屉之上的一层：Esc 先关它，不顺手关掉整个手记详情。
    event.stopPropagation();
    closeViewer();
    return;
  }
  if (event.key === 'ArrowRight') step(1);
  if (event.key === 'ArrowLeft') step(-1);
}
</script>

<template>
  <section class="gallery" aria-label="手记图片">
    <div class="gallery-head">
      <h3>图片</h3>
      <button class="btn-quiet" :disabled="disabled || busy" @click="emit('add')">
        <AppIcon name="plus" class="icon-s" />添加图片
      </button>
    </div>
    <p v-if="disabled" class="gallery-hint">先保存这条手记，再加入图片。</p>
    <p v-else class="gallery-hint">也可以直接粘贴剪贴板里的图片。单张不超过 20 MB。</p>
    <p v-if="error" class="gallery-error" role="alert">{{ error }}</p>
    <p v-else-if="status" class="gallery-status" aria-live="polite">{{ status }}</p>
    <p v-if="loading" class="gallery-hint">正在读取图片…</p>
    <ul v-else-if="images.length" class="gallery-grid">
      <li v-for="(image, index) in images" :key="image.id" class="gallery-item">
        <button
          ref="thumbnails"
          type="button"
          class="thumb"
          :aria-label="`放大查看 ${imageLabel(image, index)}`"
          @click="openViewer(index)"
        >
          <img :src="imageUrl(image)" :alt="imageLabel(image, index)" loading="lazy" />
        </button>
        <label class="thumb-name">
          <span class="sr-only">图片名称</span>
          <input
            :value="nameOf(image, index)"
            :placeholder="imageLabel(image, index)"
            :disabled="busy"
            maxlength="200"
            @input="names[image.id] = ($event.target as HTMLInputElement).value"
            @blur="commitName(image, index)"
            @keydown.enter.prevent="commitName(image, index)"
          />
        </label>
        <button
          type="button"
          class="btn-quiet thumb-remove"
          :disabled="busy"
          @click="requestRemoval(image.id)"
        >
          {{ pendingRemoval === image.id ? '确认移出' : '移出' }}
        </button>
      </li>
    </ul>
    <p v-else class="gallery-hint">这条手记还没有图片。</p>

    <Teleport to="body">
      <div
        v-if="viewing"
        class="viewer"
        role="dialog"
        aria-modal="true"
        aria-label="查看图片"
        @keydown="onViewerKey"
      >
        <div class="viewer-backdrop" aria-hidden="true" @click="closeViewer" />
        <div ref="panel" class="viewer-panel" tabindex="-1" @keydown="trapTab">
          <img class="viewer-image" :src="imageUrl(viewing)" :alt="caption" />
          <div class="viewer-bar">
            <button class="btn-quiet" :disabled="images.length < 2" @click="step(-1)">
              上一张
            </button>
            <span class="viewer-caption">{{ caption }}</span>
            <button class="btn-quiet" :disabled="images.length < 2" @click="step(1)">下一张</button>
            <button class="viewer-close btn-quiet" @click="closeViewer">关闭 <kbd>Esc</kbd></button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.gallery {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
.gallery-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.gallery-head h3 {
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
}
.gallery-hint,
.gallery-status {
  margin-top: 6px;
  font-size: 12px;
  color: var(--faint);
}
.gallery-status {
  color: var(--c-done);
}
.gallery-error {
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
}
.gallery-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
}
.gallery-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.thumb {
  display: block;
  width: 100%;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface-2);
  overflow: hidden;
  aspect-ratio: 4 / 3;
  transition:
    border-color var(--dur-1) ease,
    transform var(--dur-1) ease;
}
.thumb:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-name input {
  width: 100%;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--bg);
  font-size: 12px;
}
.thumb-remove {
  align-self: flex-start;
  font-size: 12px;
}
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
