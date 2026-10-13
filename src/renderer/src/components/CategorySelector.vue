<script setup lang="ts">
import { computed, useId } from 'vue';
import { NOTE_CATEGORIES, type NoteCategory } from '../../../domain/note';

const props = defineProps<{ modelValue: NoteCategory; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [category: NoteCategory] }>();
// 首页与抽屉各自拥有单选组，避免浏览器把不同编辑区的分类互相取消。
const groupName = useId();
const selectedIndex = computed(() =>
  NOTE_CATEGORIES.findIndex((item) => item.value === props.modelValue),
);
</script>

<template>
  <div
    class="seg category-selector"
    role="group"
    aria-label="手记分类"
    :class="{ 'is-disabled': disabled }"
    :style="{ '--category-count': NOTE_CATEGORIES.length }"
  >
    <span class="seg-thumb" :style="{ '--selected-index': selectedIndex }" aria-hidden="true" />
    <label v-for="category in NOTE_CATEGORIES" :key="category.value" class="category-option">
      <input
        type="radio"
        :name="groupName"
        :value="category.value"
        :checked="modelValue === category.value"
        :disabled="disabled"
        @change="emit('update:modelValue', category.value)"
      />
      <span>{{ category.label }}</span>
    </label>
  </div>
</template>
