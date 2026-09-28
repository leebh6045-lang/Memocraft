<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toValue, watch } from 'vue';
import {
  categoryLabel,
  noteTitle,
  type Note,
  type NoteContent,
  type NoteDraft,
} from '../../../domain/note';
import { draftOwner } from '../../../domain/note-image';
import AppIcon from '../components/AppIcon.vue';
import { formatFullTime, formatTime } from '../format-time';
import CategorySelector from '../components/CategorySelector.vue';
import NoteImageGallery from '../components/NoteImageGallery.vue';
import TagPickerDrawer from '../components/TagPickerDrawer.vue';
import type { NoteImageState } from '../composables/useNoteImages';

const props = defineProps<{
  draft: NoteDraft;
  notes: Note[];
  status: string;
  error: string;
  busy: boolean;
  saved: boolean;
  shortcut: string;
  focused: boolean;
  /** 草稿图集现场：与手记详情共用同一套加载、添加、命名与删除。 */
  draftImages: NoteImageState;
  /** 图片归属草稿，写入前先确认草稿行已经落盘；返回 false 表示保存没成功。 */
  ensureDraftStored: () => Promise<boolean>;
}>();
const emit = defineEmits<{
  change: [patch: Partial<NoteContent & { extrasOpen: boolean }>];
  save: [];
  retry: [];
  open: [id: string];
  navigate: [page: 'notes' | 'topics' | 'threads'];
  focus: [];
  'create-topic': [];
  'create-thread': [];
  /** 图集操作的结果用提示条反馈：草稿区不铺文字说明。 */
  notify: [payload: { message: string }];
}>();
const body = ref<HTMLTextAreaElement | null>(null);
const shaking = ref(false);
/** 标签在右侧抽屉里点选：补充区只留已选胶囊与入口，永远一行。 */
const tagOpen = ref(false);
let shakeTimer: ReturnType<typeof setTimeout> | undefined;

const owner = computed(() => draftOwner(props.draft.id));
// 图集状态摊平为普通值：模板只绑定基本类型，与手记详情里的做法一致。
const galleryImages = computed(() => toValue(props.draftImages.images));
const galleryLoading = computed(() => toValue(props.draftImages.loading));
const galleryBusy = computed(() => toValue(props.draftImages.busy));

/**
 * 图集操作前先确保草稿已经存在（图片的归属是草稿行，外键不允许提前写入），
 * 结果只用一句提示条反馈：草稿区保持简洁，不再铺限制说明与成功文案。
 */
async function runImageAction(action: () => Promise<boolean>, failure: string): Promise<void> {
  if (!(await props.ensureDraftStored())) {
    emit('notify', { message: '草稿还没有保存成功，图片没有添加。' });
    return;
  }
  if (!(await action())) emit('notify', { message: failure });
}

function addImages(): void {
  void runImageAction(() => props.draftImages.addFromDialog(owner.value), '添加图片失败');
}

function renameImage(imageId: string, displayName: string): void {
  void runImageAction(
    () => props.draftImages.rename(owner.value, imageId, displayName),
    '改名失败',
  );
}

function removeImage(imageId: string): void {
  void runImageAction(() => props.draftImages.remove(owner.value, imageId), '移出失败');
}

/** 在编辑区里粘贴剪贴板图片；纯文本粘贴不受影响，仍由输入框默认行为处理。 */
function handlePaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items;
  if (!items) return;
  const file = Array.from(items)
    .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    ?.getAsFile();
  if (!file) return;
  event.preventDefault();
  void runImageAction(async () => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return await props.draftImages.addFromClipboard(owner.value, {
        bytes,
        originalName: file.name,
      });
    } catch {
      // 读不出剪贴板内容与写入失败一样：按同一次失败处理。
      return false;
    }
  }, '粘贴失败');
}

watch(
  () => props.error,
  (message) => {
    // 正文为空时服务端会拒绝提交：这里给出可见反馈并把焦点送回正文，避免只留一行红字。
    if (!message || props.draft.body.trim()) return;
    shaking.value = true;
    body.value?.focus({ preventScroll: true });
    clearTimeout(shakeTimer);
    shakeTimer = setTimeout(() => {
      shaking.value = false;
    }, 320);
  },
);
watch(
  () => props.draft.id,
  async (id) => {
    tagOpen.value = false;
    // 每次进入的是当前草稿的图集：保存手记后会换一个新草稿，这里随之重新读取。
    void props.draftImages.load(draftOwner(id));
    await nextTick();
    body.value?.focus();
  },
  { immediate: true },
);
onMounted(() => body.value?.focus({ preventScroll: true }));
onBeforeUnmount(() => clearTimeout(shakeTimer));
function setTags(tags: string[]): void {
  emit('change', { tags });
}

function removeTag(tag: string): void {
  emit('change', { tags: props.draft.tags.filter((item) => item !== tag) });
}
</script>

<template>
  <section class="view view-home">
    <header class="page-head">
      <div>
        <h1>新手记</h1>
        <p class="sub">只需写下正文，其他都可以稍后补。</p>
      </div>
      <button class="btn-quiet" :aria-pressed="focused" @click="emit('focus')">
        <AppIcon name="focus" />专注
      </button>
    </header>
    <div class="editor" :class="{ 'is-shake': shaking }" @paste="handlePaste">
      <textarea
        ref="body"
        class="editor-body"
        aria-label="手记正文"
        placeholder="现在想到什么……"
        :value="draft.body"
        :disabled="busy"
        @input="emit('change', { body: ($event.target as HTMLTextAreaElement).value })"
      />
      <!-- 图片在保存手记之前就能加：直接粘贴剪贴板图片，或从文件选择；保存后自动归属这条手记。 -->
      <div class="editor-images">
        <NoteImageGallery
          compact
          :images="galleryImages"
          :loading="galleryLoading"
          :busy="galleryBusy || busy"
          @add="addImages"
          @rename="renameImage"
          @remove="removeImage"
        />
      </div>
      <div class="editor-extras" :class="{ open: draft.extrasOpen }" :inert="!draft.extrasOpen">
        <div>
          <div class="extras-grid">
            <label class="field"
              >标题（可选）<input
                :value="draft.title"
                :disabled="busy"
                placeholder="留空则取正文第一行"
                @input="emit('change', { title: ($event.target as HTMLInputElement).value })"
            /></label>
            <div class="field">
              <span>标签（可选）</span>
              <div class="chip-row">
                <span v-for="tag in draft.tags" :key="tag" class="chip on"
                  >{{ tag
                  }}<button
                    class="chip-x"
                    :disabled="busy"
                    :aria-label="`移除标签：${tag}`"
                    @click="removeTag(tag)"
                  >
                    ×
                  </button></span
                >
                <button class="inline-add" :disabled="busy" @click="tagOpen = true">
                  ＋ 选择标签
                </button>
              </div>
            </div>
            <div class="field wide">
              <span>归纳与事务关联</span
              ><span class="faint">先保存手记，再到手记详情里收录到归纳或关联事务。</span>
            </div>
          </div>
        </div>
      </div>
      <div class="editor-bar">
        <div class="editor-bar-left">
          <CategorySelector
            :model-value="draft.category"
            :disabled="busy"
            @update:model-value="emit('change', { category: $event })"
          />
          <button
            class="btn-quiet"
            :disabled="busy"
            :aria-expanded="draft.extrasOpen"
            @click="emit('change', { extrasOpen: !draft.extrasOpen })"
          >
            补充<AppIcon name="chevron" class="icon-s" />
          </button>
        </div>
        <div class="editor-bar-right">
          <kbd>{{ shortcut }} ↩</kbd
          ><button
            class="btn-primary"
            :class="{ 'is-success': saved && !busy }"
            :disabled="busy"
            :aria-label="busy ? '正在保存…' : '保存手记'"
            @click="emit('save')"
          >
            <span class="btn-label">{{ busy ? '正在保存…' : '保存手记' }}</span>
            <span class="btn-ok" aria-hidden="true"
              ><AppIcon name="check" class="icon-s" />已保存</span
            >
          </button>
        </div>
      </div>
    </div>
    <div class="draft-status" :class="{ error, 'is-empty': !status && !error }" aria-live="polite">
      <span class="dot" /><span>{{ error || status }}</span
      ><button v-if="error" class="btn-ghost" @click="emit('retry')">重试</button>
    </div>
    <div class="home-secondary" :inert="focused">
      <div class="home-links">
        <button class="btn-quiet" @click="emit('create-topic')">
          <AppIcon name="plus" class="icon-s" />新建归纳
        </button>
        <button class="btn-quiet" @click="emit('create-thread')">
          <AppIcon name="plus" class="icon-s" />新建事务
        </button>
      </div>
      <div class="section-head">
        <h2>最近手记</h2>
        <button class="btn-ghost" @click="emit('navigate', 'notes')">查看全部 →</button>
      </div>
      <div v-if="!notes.length" class="empty">还没有手记。写下第一条，它会出现在这里。</div>
      <TransitionGroup v-else name="list" tag="div" class="row-list">
        <button
          v-for="note in notes.slice(0, 4)"
          :key="note.id"
          class="row"
          @click="emit('open', note.id)"
        >
          <span class="cat" :class="`cat-${note.category}`">{{ categoryLabel(note.category) }}</span
          ><span class="row-title">{{ noteTitle(note) }}</span>
          <time :datetime="note.createdAt" :title="formatFullTime(note.createdAt)">{{
            formatTime(note.createdAt)
          }}</time>
        </button>
      </TransitionGroup>
    </div>

    <TagPickerDrawer
      :open="tagOpen"
      :hint="draft.title.trim() || '新手记'"
      :model-value="draft.tags"
      :busy="busy"
      @update:model-value="setTags"
      @close="tagOpen = false"
    />
  </section>
</template>
