<script setup lang="ts">
import { useId } from 'vue';

defineProps<{
  name:
    | 'home'
    | 'notes'
    | 'topics'
    | 'threads'
    | 'search'
    | 'focus'
    | 'sun'
    | 'moon'
    | 'plus'
    | 'check'
    | 'x'
    | 'chevron'
    | 'settings'
    | 'trash'
    | 'sparkle'
    | 'calendar';
  colorful?: boolean;
}>();

// 渐变只用于显式指定的 AI 标识，每个实例独立 ID，避免多图标引用串色。
const gradientId = `icon-gradient-${useId()}`;

const paths = {
  // 回顾日历采用用户提供的 rili.svg 原始路径；保留 1024 坐标与填充轮廓，颜色跟随主题。
  calendar:
    'M896 448H128v447.957333l477.738667 0.021334L896 895.957333V448z m0-42.666667V192.042667C896 192 768 192 768 192V149.333333h128.042667A42.666667 42.666667 0 0 1 938.666667 192.042667v703.914666A42.624 42.624 0 0 1 896.064 938.666667H127.936A42.666667 42.666667 0 0 1 85.333333 895.957333V192.042667C85.333333 168.469333 104.256 149.333333 127.957333 149.333333H256v42.666667l-128 0.042667V405.333333h768zM298.666667 85.333333h42.666666v170.666667h-42.666666V85.333333z m384 0h42.666666v170.666667h-42.666666V85.333333zM384 149.333333h256v42.666667H384V149.333333z',
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-6v-8h-4v8H4a1 1 0 0 1-1-1Z',
  notes:
    'M13 3H6a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M2 7h4M2 11h4M2 15h4M2 19h4M19 2l3 3-8 8-4 1 1-4Z',
  topics: 'M4 4v16M8 8v12M12 6v14M16 6l4 14',
  threads:
    'M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  search: 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0m-2.3 5.7L21 21',
  focus:
    'M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6 19 19M5 19l1.4-1.4M17.6 6.4 19 5',
  moon: 'M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z',
  plus: 'M12 5v14M5 12h14',
  sparkle: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z',
  check: 'm5 12 4 4L19 6',
  x: 'm6 6 12 12M6 18 18 6',
  chevron: 'm6 9 6 6 6-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4',
  trash:
    'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6',
};
</script>

<template>
  <svg
    class="icon"
    :viewBox="name === 'calendar' ? '0 0 1024 1024' : '0 0 24 24'"
    aria-hidden="true"
    focusable="false"
  >
    <defs v-if="colorful">
      <linearGradient :id="gradientId" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#4f8df7" />
        <stop offset="35%" stop-color="#9b5de5" />
        <stop offset="70%" stop-color="#ec5fad" />
        <stop offset="100%" stop-color="#f5a544" />
      </linearGradient>
    </defs>
    <path v-if="name === 'calendar'" :d="paths.calendar" fill="currentColor" stroke="none" />
    <path v-else :d="paths[name]" :stroke="colorful ? `url(#${gradientId})` : undefined" />
  </svg>
</template>
