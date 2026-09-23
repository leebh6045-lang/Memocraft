<script setup lang="ts">
import type { ToastItem } from '../composables/useToasts';

// 提示条是状态区而非模态层：不抢焦点，鼠标可点其中的操作按钮。
defineProps<{ toasts: ToastItem[] }>();
const emit = defineEmits<{ dismiss: [id: number]; action: [toast: ToastItem] }>();
</script>

<template>
  <div class="toasts" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="item in toasts" :key="item.id" class="toast">
        <span>{{ item.message }}</span>
        <button
          v-if="item.action"
          type="button"
          @click="
            emit('action', item);
            emit('dismiss', item.id);
          "
        >
          {{ item.action.label }}
        </button>
        <button v-else type="button" aria-label="关闭提示" @click="emit('dismiss', item.id)">
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
