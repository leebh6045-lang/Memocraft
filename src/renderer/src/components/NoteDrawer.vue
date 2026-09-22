<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue';
import MarkdownIt from 'markdown-it';
import { noteTitle, type Note, type NoteContent } from '../../../domain/note';
import type { MemocraftApi } from '../../../shared/contracts';
import CategorySelector from './CategorySelector.vue';
import NoteImageGallery from './NoteImageGallery.vue';
import { useModalFocus } from '../composables/useModalFocus';
import type { NoteImageState } from '../composables/useNoteImages';

const props = defineProps<{
  note: Note;
  status: string;
  error: string;
  busy: boolean;
  bridge: MemocraftApi;
  images: NoteImageState;
}>();
const emit = defineEmits<{ change: [patch: Partial<NoteContent>]; close: []; retry: [] }>();
const panel = ref<HTMLElement | null>(null);
const { trapTab } = useModalFocus(panel, '.drawer-text');
const preview = ref(false);
const tagsText = ref(props.note.tags.join(', '));
const imageError = ref('');
const imageBusy = ref(false);
// 图集状态经计算属性摊平为普通值：模板只绑定基本类型，避免 ref 与 props 嵌套难以核对。
const galleryImages = computed(() => toValue(props.images.images));
const galleryLoading = computed(() => toValue(props.images.loading));
const galleryStatus = computed(() => toValue(props.images.status));
const galleryError = computed(() => imageError.value || toValue(props.images.error));
const galleryBusy = computed(() => imageBusy.value || toValue(props.images.busy));

watch(
  () => props.note.id,
  (noteId) => {
    tagsText.value = props.note.tags.join(', ');
    preview.value = false;
    imageError.value = '';
    // 抽屉挂载即读取图集；换手记时重新读取。
    void props.images.load(noteId);
  },
  { immediate: true },
);

async function addImages() {
  if (imageBusy.value) return;
  imageBusy.value = true;
  imageError.value = '';
  try {
    const saved = await props.images.addFromDialog(props.note.id);
    if (!saved) imageError.value = toValue(props.images.error);
  } finally {
    imageBusy.value = false;
  }
}

async function pasteImage(image: { bytes: Uint8Array; originalName: string }) {
  if (imageBusy.value || props.busy) return;
  imageBusy.value = true;
  imageError.value = '';
  try {
    const saved = await props.images.addFromClipboard(props.note.id, image);
    if (!saved) imageError.value = toValue(props.images.error);
  } finally {
    imageBusy.value = false;
  }
}

async function renameImage(imageId: string, displayName: string) {
  if (!(await props.images.rename(props.note.id, imageId, displayName)))
    imageError.value = toValue(props.images.error);
}

async function removeImage(imageId: string) {
  if (!(await props.images.remove(props.note.id, imageId)))
    imageError.value = toValue(props.images.error);
}

/** 抽屉打开时接受剪贴板图片；文本粘贴不受影响，仍由输入框默认行为处理。 */
function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;
  const file = Array.from(items)
    .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    ?.getAsFile();
  if (!file) return;
  event.preventDefault();
  void file
    .arrayBuffer()
    .then((buffer) => pasteImage({ bytes: new Uint8Array(buffer), originalName: file.name }))
    .catch(() => {
      imageError.value = '未能读取剪贴板图片，请重试或改用「添加图片」。';
    });
}

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: true });
// 手记正文不解析图片与链接：附图是独立图集，正文保留可读文字与代码。
markdown.disable(['image', 'link']);
const renderedBody = computed(() => markdown.render(props.note.body));
function updateTags(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  tagsText.value = event.target.value;
  emit('change', {
    tags: [
      ...new Set(
        tagsText.value
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ],
  });
}
onMounted(() => document.addEventListener('paste', handlePaste));
onBeforeUnmount(() => document.removeEventListener('paste', handlePaste));
</script>

<template>
  <div>
    <div class="drawer-backdrop" aria-hidden="true" @click="emit('close')" />
    <aside
      ref="panel"
      class="drawer"
      role="dialog"
      aria-modal="true"
      aria-label="手记详情"
      tabindex="-1"
      @keydown="trapTab"
    >
      <header class="drawer-head">
        <CategorySelector
          :model-value="note.category"
          :disabled="busy"
          @update:model-value="emit('change', { category: $event })"
        /><button class="btn-quiet" :disabled="busy" @click="emit('close')">
          关闭 <kbd>Esc</kbd>
        </button>
      </header>
      <div class="drawer-body">
        <input
          class="drawer-title"
          aria-label="手记标题"
          :placeholder="noteTitle(note)"
          :value="note.title"
          :disabled="busy"
          @input="emit('change', { title: ($event.target as HTMLInputElement).value })"
        />
        <button
          class="btn-quiet preview-toggle"
          :aria-pressed="preview"
          @click="preview = !preview"
        >
          {{ preview ? '编辑正文' : '预览 Markdown' }}
        </button>
        <!-- Markdown 禁用 HTML、图片与链接解析；内容经过 markdown-it 转义。 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-if="preview" class="md markdown-preview" v-html="renderedBody" />
        <textarea
          v-else
          class="drawer-text"
          aria-label="编辑手记正文"
          :value="note.body"
          :disabled="busy"
          @input="emit('change', { body: ($event.target as HTMLTextAreaElement).value })"
        />
        <div class="drawer-meta">
          <label class="field"
            >标签<input
              aria-label="编辑手记标签"
              :value="tagsText"
              :disabled="busy"
              placeholder="逗号分隔"
              @input="updateTags"
          /></label>
          <div>
            <div class="label">收录于归纳</div>
            <span class="faint">归纳与收录功能尚未开放</span>
          </div>
          <div>
            <div class="label">被引用的位置</div>
            <span class="faint">事务与引用功能尚未开放</span>
          </div>
        </div>
        <NoteImageGallery
          :images="galleryImages"
          :loading="galleryLoading"
          :busy="galleryBusy"
          :error="galleryError"
          :status="galleryStatus"
          :disabled="busy"
          @add="addImages"
          @rename="renameImage"
          @remove="removeImage"
        />
      </div>
      <footer class="drawer-foot">
        <div>
          <span>创建于 {{ new Date(note.createdAt).toLocaleString('zh-CN') }}</span>
          <p :class="{ 'error-text': error }" aria-live="polite">{{ error || status }}</p>
        </div>
        <button v-if="error" class="btn-ghost" @click="emit('retry')">重试保存</button>
      </footer>
    </aside>
  </div>
</template>

<style scoped>
.preview-toggle {
  margin: 0 0 8px -8px;
}
.markdown-preview {
  min-height: 170px;
  overflow-wrap: anywhere;
  font-size: 15px;
  line-height: 1.85;
}
.error-text {
  color: #b3473f;
}
</style>
