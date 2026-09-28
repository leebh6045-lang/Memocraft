<script setup lang="ts">
import { ref } from 'vue';
import { imageLabel, type NoteImage } from '../../../domain/note-image';
import { imageUrl } from '../../../shared/contracts';
import AppIcon from './AppIcon.vue';
import ImageViewer from './ImageViewer.vue';

defineProps<{
  images: NoteImage[];
  loading: boolean;
  busy: boolean;
  /** 图集自己的失败与成功文案；草稿区改用提示条反馈，因此这两项可选。 */
  error?: string;
  status?: string;
  /** 紧凑形态：只留「添加图片」与一句「支持粘贴图片」，用于首页草稿区。 */
  compact?: boolean;
}>();
const emit = defineEmits<{
  add: [];
  rename: [imageId: string, displayName: string];
  remove: [imageId: string];
}>();

const names = ref<Record<string, string>>({});
const pendingRemoval = ref('');
/** 正在放大的图片 ID；放大层自己管当前张数与焦点归还。 */
const viewingId = ref('');
let removalTimer: ReturnType<typeof setTimeout> | undefined;

const nameOf = (image: NoteImage, index: number) =>
  names.value[image.id] ?? imageLabel(image, index);

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
</script>

<template>
  <section class="gallery" :class="{ 'is-compact': compact }" aria-label="手记图片">
    <!-- 抽屉里是完整形态；草稿区（compact）只留按钮和一句提示，成功与失败由提示条反馈。 -->
    <div v-if="compact" class="gallery-compact">
      <button class="btn-quiet" :disabled="busy" @click="emit('add')">
        <AppIcon name="plus" class="icon-s" />添加图片
      </button>
      <span class="gallery-hint">（支持粘贴图片）</span>
    </div>
    <template v-else>
      <div class="gallery-head">
        <h3>图片</h3>
        <button class="btn-quiet" :disabled="busy" @click="emit('add')">
          <AppIcon name="plus" class="icon-s" />添加图片
        </button>
      </div>
      <p class="gallery-hint">可粘贴图片，单张不超过 20 MB。</p>
    </template>
    <p v-if="error" class="gallery-error" role="alert">{{ error }}</p>
    <p v-else-if="status" class="gallery-status" aria-live="polite">{{ status }}</p>
    <p v-if="loading" class="gallery-hint">正在读取图片…</p>
    <ul v-else-if="images.length" class="gallery-grid">
      <li v-for="(image, index) in images" :key="image.id" class="gallery-item">
        <button
          type="button"
          class="thumb"
          :aria-label="`放大查看 ${imageLabel(image, index)}`"
          @click="viewingId = image.id"
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
    <p v-else-if="!compact" class="gallery-hint">还没有图片。</p>

    <ImageViewer v-if="viewingId" :images="images" :start-id="viewingId" @close="viewingId = ''" />
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
/* 草稿区：按钮与提示同一行，不再有标题与空状态文案。 */
.gallery-compact {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 提示与按钮同字号、同一基线；图集通用提示的上边距在这一行里不适用。 */
.gallery-compact .gallery-hint {
  margin-top: 0;
  font-size: 13px;
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
</style>
