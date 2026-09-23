<script setup lang="ts">
import SideDrawerPanel from './SideDrawerPanel.vue';

/**
 * 通用右侧抽屉：归纳与事务的基础信息、记动态都用它。
 *
 * 挂在 body 上：抽屉打开时应用主内容会被置为 inert，
 * 若抽屉留在主内容里，它自己也会被一起禁用。
 * 遮罩与面板同属一个 .drawer-layer，进出场动效才有可挂样式的父节点；
 * 页面模板里不要再用 <Transition> 包它，否则页面根节点会变成多根片段，
 * 应用外壳的 out-in 页面过渡会卡住。
 */
defineProps<{ open: boolean; title: string; hint?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer-transition">
      <div v-if="open" class="drawer-layer">
        <div class="drawer-backdrop" aria-hidden="true" @click="emit('close')" />
        <SideDrawerPanel :title="title" :hint="hint" @close="emit('close')">
          <slot />
          <template v-if="$slots.footer" #footer><slot name="footer" /></template>
        </SideDrawerPanel>
      </div>
    </Transition>
  </Teleport>
</template>
