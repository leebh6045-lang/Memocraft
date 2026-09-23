<script setup lang="ts">
import { TRASH_KIND_LABELS, type RemovalImpact } from '../../../domain/trash';
import AppDialog from './AppDialog.vue';

/**
 * 删除确认：把影响面逐条列给用户，确认后才真正删除。
 * 只负责呈现与确认，删除本身由回收站现场执行。
 */
defineProps<{ impact: RemovalImpact; busy?: boolean }>();
const emit = defineEmits<{ confirm: []; close: [] }>();
</script>

<template>
  <AppDialog
    :title="`删除${TRASH_KIND_LABELS[impact.kind]}`"
    :hint="impact.title"
    @close="emit('close')"
  >
    <ul class="impact">
      <li v-for="effect in impact.effects" :key="effect">{{ effect }}</li>
    </ul>
    <template #note>删除后仍可在回收站恢复</template>
    <template #footer>
      <button class="btn-quiet" :disabled="busy" @click="emit('close')">取消</button>
      <button class="btn-danger btn" :disabled="busy" @click="emit('confirm')">移到回收站</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.impact {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 6px;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.6;
}
</style>
