<script setup lang="ts">
import { ref } from 'vue';
import type { TopicCreate } from '../../../domain/topic';
import AppDialog from './AppDialog.vue';

/**
 * 新建归纳：标题必填，说明可稍后补。
 * 同名不静默改名——失败原因由调用方回填到 error，用户看到后可确认「仍要创建」。
 * 归纳模块与手记抽屉里的「收录到归纳」共用同一张表单。
 */
const props = defineProps<{ busy?: boolean; error?: string }>();
const emit = defineEmits<{ submit: [input: TopicCreate]; close: [] }>();

const title = ref('');
const description = ref('');
</script>

<template>
  <AppDialog
    title="新建归纳"
    hint="标题必填，说明可以稍后补。允许同名，重命名不会重写已收录的关系。"
    @close="emit('close')"
  >
    <label class="field"
      >标题<input
        data-autofocus
        :value="title"
        maxlength="300"
        placeholder="例如：本地数据库"
        @input="title = ($event.target as HTMLInputElement).value"
    /></label>
    <label class="field"
      >说明（可选）<textarea
        :value="description"
        rows="2"
        maxlength="2000"
        placeholder="这个归纳收集哪一类内容"
        @input="description = ($event.target as HTMLTextAreaElement).value"
      />
    </label>
    <p v-if="props.error" class="hint duplicate-hint" role="alert">{{ props.error }}</p>
    <template #footer>
      <button class="btn-quiet" @click="emit('close')">取消</button>
      <button
        v-if="props.error"
        class="btn-primary"
        :disabled="props.busy"
        @click="emit('submit', { title, description, confirmDuplicate: true })"
      >
        仍要创建
      </button>
      <button
        v-else
        class="btn-primary"
        :disabled="props.busy"
        @click="emit('submit', { title, description, confirmDuplicate: false })"
      >
        创建
      </button>
    </template>
  </AppDialog>
</template>
