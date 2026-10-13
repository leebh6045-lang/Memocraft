<script setup lang="ts">
import { ref, watch } from 'vue';
import SideDrawer from './SideDrawer.vue';
import { TAG_GROUPS, mergeTags, parseTagInput, toggleTag } from '../tag-presets';

/**
 * 选择标签：创建手记时用右侧抽屉点选预设标签，也可以随手加自定义的。
 *
 * 用抽屉而不是就地铺开：应用里已经有三个右拉抽屉，形态与开合不用重新学；
 * 补充区因此永远只有一行，标签以后加到多少个都不会变高。
 * 点标签不关抽屉（多选），「完成」或 Esc 关闭。
 */
const props = defineProps<{
  open: boolean;
  /** 抽屉标题右侧的来处说明：这里放正在写的手记标题。 */
  hint?: string;
  modelValue: string[];
  busy?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [tags: string[]]; close: [] }>();

const customText = ref('');
/** 已输入但还没回车的自定义标签也要算进去，否则点「完成」会把它丢掉。 */
function commitPending(): void {
  const parsed = parseTagInput(customText.value);
  if (!parsed.length) return;
  customText.value = '';
  emit('update:modelValue', mergeTags(props.modelValue, parsed));
}
function close(): void {
  commitPending();
  emit('close');
}
function toggle(tag: string): void {
  emit('update:modelValue', toggleTag(props.modelValue, tag));
}
function remove(tag: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => item !== tag),
  );
}

// 每次重新打开都是一次新的选择：清掉上一次残留的半截输入。
watch(
  () => props.open,
  (open) => {
    if (open) customText.value = '';
  },
);
</script>

<template>
  <SideDrawer :open="open" title="选择标签" :hint="hint" @close="close">
    <div>
      <div class="label">已选</div>
      <div class="chip-row">
        <span v-for="tag in modelValue" :key="tag" class="chip on"
          >{{ tag
          }}<button
            class="chip-x"
            :disabled="props.busy"
            :aria-label="`移除标签：${tag}`"
            @click="remove(tag)"
          >
            ×
          </button></span
        >
        <span v-if="!modelValue.length" class="faint small">选几个标签，也可以先跳过。</span>
      </div>
    </div>

    <div v-for="group in TAG_GROUPS" :key="group.name" class="tag-group">
      <div class="label">{{ group.name }}</div>
      <div class="chip-row">
        <button
          v-for="tag in group.tags"
          :key="tag"
          type="button"
          class="chip pick"
          :class="{ on: modelValue.includes(tag) }"
          :disabled="props.busy"
          :aria-pressed="modelValue.includes(tag)"
          @click="toggle(tag)"
        >
          <span class="tag-hash" aria-hidden="true">#</span>{{ tag }}
        </button>
      </div>
    </div>

    <label class="field"
      >自定义标签<input
        :value="customText"
        :disabled="props.busy"
        placeholder="回车添加，或逗号分隔，如 sqlite, 备份"
        @input="customText = ($event.target as HTMLInputElement).value"
        @keydown.enter="
          (event: KeyboardEvent) => {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            commitPending();
          }
        "
    /></label>

    <template #footer>
      <span>已选 {{ modelValue.length }} 个 · 也可以自己加标签</span>
      <button class="btn-primary" :disabled="props.busy" @click="close">完成</button>
    </template>
  </SideDrawer>
</template>
