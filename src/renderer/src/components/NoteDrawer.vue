<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue';
import { noteTitle, type Note, type NoteContent } from '../../../domain/note';
import type { MemocraftApi } from '../../../shared/contracts';
import type { NoteReference } from '../../../domain/thread';
import type { TopicCreate, TopicSummary } from '../../../domain/topic';
import CategorySelector from './CategorySelector.vue';
import NoteImageGallery from './NoteImageGallery.vue';
import PickerDialog from './PickerDialog.vue';
import TopicCreateDialog from './TopicCreateDialog.vue';
import { useModalFocus } from '../composables/useModalFocus';
import { renderMarkdown } from '../markdown';
import { topicPickerOptions } from '../picker';
import type { NoteImageState } from '../composables/useNoteImages';

/** 新建归纳的结果：失败原因直接展示在表单里，成功则把新归纳交给调用方继续处理。 */
export type CreateTopicResult = { ok: true; topic: TopicSummary } | { ok: false; message: string };

const props = defineProps<{
  note: Note;
  status: string;
  error: string;
  busy: boolean;
  bridge: MemocraftApi;
  images: NoteImageState;
  /** 全部归纳与全部手记：收录状态由渲染端持有的同一份数据推导。 */
  topics: TopicSummary[];
  notes: Note[];
  /** 引用这条手记的事务与动态，打开抽屉时按手记 ID 读取。 */
  references: NoteReference[];
  /** 归纳操作失败的原因（收录、移出、新建）：显示在「收录于归纳」下方，不留静默失败。 */
  topicError?: string;
  /** 抽屉里的「新建归纳」：由应用外壳创建，返回结果供表单继续显示或勾选。 */
  createTopic: (input: TopicCreate) => Promise<CreateTopicResult>;
}>();
const emit = defineEmits<{
  change: [patch: Partial<NoteContent>];
  close: [];
  retry: [];
  collect: [topicId: string, noteIds: string[]];
  'remove-topic': [topicId: string, noteId: string];
  'open-topic': [topicId: string];
  'open-reference': [reference: NoteReference];
  'remove-note': [noteId: string];
}>();

const collecting = ref(false);
const creatingTopic = ref(false);
const createError = ref('');
/** 选择器里的勾选由抽屉持有：新建的归纳要能被直接勾上，和已选的归纳一起提交。 */
const pickedTopicIds = ref<string[]>([]);
const noteTopics = computed(() =>
  props.topics.filter((topic) => topic.noteIds.includes(props.note.id)),
);
const collectedIds = computed(() => noteTopics.value.map((topic) => topic.id));
/** 这条手记能收录到哪些归纳：全部列出，已经收录的带标记且不可重复选择。 */
const topicOptions = computed(() => topicPickerOptions(props.topics, collectedIds.value));

function openPicker(): void {
  pickedTopicIds.value = [];
  collecting.value = true;
}

function openCreateTopic(): void {
  createError.value = '';
  creatingTopic.value = true;
}

async function submitNewTopic(input: TopicCreate): Promise<void> {
  const result = await props.createTopic(input);
  if (!result.ok) {
    createError.value = result.message;
    return;
  }
  createError.value = '';
  creatingTopic.value = false;
  // 新建的归纳直接勾上，用户接着点「收录」一次提交。
  pickedTopicIds.value = [...pickedTopicIds.value, result.topic.id];
}

/** 收录与移出只上报事件，结果提示与撤销由应用外壳统一给出。 */
function confirmCollect(topicIds: string[]): void {
  collecting.value = false;
  for (const topicId of topicIds) emit('collect', topicId, [props.note.id]);
}
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

// 手记正文不解析图片与链接：附图是独立图集，正文保留可读文字与代码。
const renderedBody = computed(() => renderMarkdown(props.note.body));
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
            <div class="chip-row">
              <span v-for="topic in noteTopics" :key="topic.id" class="chip on"
                ><button class="chip-label" @click="emit('open-topic', topic.id)">
                  {{ topic.title }}</button
                ><button
                  class="chip-x"
                  :disabled="busy"
                  :aria-label="`从「${topic.title}」移出`"
                  @click="emit('remove-topic', topic.id, props.note.id)"
                >
                  ×
                </button></span
              >
              <button class="inline-add" :disabled="busy" @click="openPicker">＋ 收录到归纳</button>
            </div>
            <p v-if="props.topicError" class="hint error-text" role="alert">
              {{ props.topicError }}
            </p>
          </div>
          <div>
            <div class="label">被引用的位置</div>
            <span v-if="!props.references.length" class="faint">还没有被任何事务引用。</span>
            <div v-else class="entry-refs">
              <button
                v-for="(reference, index) in props.references"
                :key="`${reference.threadId}-${reference.entryId ?? 'thread'}-${index}`"
                class="ref-chip"
                @click="emit('open-reference', reference)"
              >
                {{ reference.threadTitle }} ·
                {{ reference.entrySummary ?? '事务资料' }}
              </button>
            </div>
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
        <button
          v-else
          class="btn-quiet btn-danger"
          :disabled="busy"
          @click="emit('remove-note', props.note.id)"
        >
          移到回收站
        </button>
      </footer>
    </aside>
    <PickerDialog
      v-if="collecting"
      v-model:picked="pickedTopicIds"
      title="收录到归纳"
      hint="选择要把这条手记收录到的归纳，可多选后一次提交；已经收录的归纳会标出来。"
      search-label="搜索归纳"
      search-placeholder="搜索归纳标题或说明"
      :options="topicOptions"
      :linked-count="0"
      empty-text="还没有归纳，先新建一个再收录。"
      all-linked-text="这条手记已经收录在全部归纳里了。"
      unit="个"
      create-label="＋ 新建归纳"
      :busy="busy"
      @confirm="confirmCollect"
      @create="openCreateTopic"
      @close="collecting = false"
    />
    <TopicCreateDialog
      v-if="creatingTopic"
      :busy="busy"
      :error="createError"
      @submit="submitNewTopic"
      @close="creatingTopic = false"
    />
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
.chip-label {
  color: inherit;
  font: inherit;
}
.chip-label:hover {
  text-decoration: underline;
}
</style>
