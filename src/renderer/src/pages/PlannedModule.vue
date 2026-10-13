<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '../components/AppIcon.vue';

const props = defineProps<{ module: 'topics' | 'threads' }>();
const copy = computed(() => {
  if (props.module === 'topics') {
    return {
      title: '主题归纳',
      subtitle: '围绕一个主题收录手记，让零散的收获逐渐连在一起。',
      action: '新建归纳',
      heading: '归纳功能尚未开放',
      description: '本轮可创建和查找手记。主题归纳与收录关系将在后续接入。',
    };
  }
  return {
    title: '长期事务',
    subtitle: '记录一件事的经历、进展与决策。',
    action: '新建事务',
    heading: '事务功能尚未开放',
    description: '本轮可创建和查找手记。事务概况、动态时间线与引用将在后续接入。',
  };
});
</script>

<template>
  <section class="view">
    <header class="page-head">
      <div>
        <h1>{{ copy.title }}</h1>
        <p class="sub">{{ copy.subtitle }}</p>
      </div>
      <button type="button" class="btn-primary" disabled title="本轮尚未开放">
        <AppIcon name="plus" class="icon-s" />{{ copy.action }}
      </button>
    </header>
    <div class="planned-module">
      <div class="planned-icon"><AppIcon :name="module" /></div>
      <span class="status-pill">尚未开放</span>
      <h2>{{ copy.heading }}</h2>
      <p>{{ copy.description }}</p>
    </div>
  </section>
</template>
