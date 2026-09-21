<script setup lang="ts">
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
    | 'back'
    | 'chevron'
    | 'link'
    | 'retry';
}>();

const paths = {
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
  check: 'm5 12 4 4L19 6',
  x: 'm6 6 12 12M6 18 18 6',
  back: 'm12 5-7 7 7 7M5 12h14',
  chevron: 'm6 9 6 6 6-6',
  link: 'm10 13 4-4M8 15l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 9l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  retry: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
};
</script>

<template>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path :d="paths[name]" />
  </svg>
</template>
