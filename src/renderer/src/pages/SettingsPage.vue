<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MemocraftApi } from '../../../shared/contracts';
import type { BackupSummary, StagedRestore } from '../../../domain/library-data';
import AppDialog from '../components/AppDialog.vue';
import AppIcon from '../components/AppIcon.vue';
import type { ThemePreference } from '../theme';

const props = defineProps<{ theme: ThemePreference; bridge: MemocraftApi; busy: boolean }>();
const emit = defineEmits<{
  'update:theme': [ThemePreference];
  notify: [payload: { message: string }];
  /** 活动库被整体替换后，外壳需要重新读取所有列表。 */
  'data-replaced': [];
}>();

const options: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
];

/** 进行中的长任务：如实说明「不能取消」，不显示假进度。 */
const running = ref('');
const error = ref('');
const lastBackup = ref(readLastBackup());
const staged = ref<StagedRestore | null>(null);

function readLastBackup(): BackupSummary | null {
  try {
    const stored = localStorage.getItem('memocraft-last-backup');
    return stored ? (JSON.parse(stored) as BackupSummary) : null;
  } catch {
    return null;
  }
}

const lastBackupLabel = computed(() => {
  const backup = lastBackup.value;
  if (!backup) return '还没有备份过；备份包含数据库快照、图片附件与校验清单';
  return `上次备份：${new Date(backup.createdAt).toLocaleString('zh-CN')} · ${formatBytes(backup.bytes)} · 附件 ${backup.attachments} 个`;
});

const stagedLabel = computed(() => {
  const counts = staged.value?.counts;
  if (!counts) return '';
  return `手记 ${counts.notes} · 归纳 ${counts.topics} · 事务 ${counts.threads} · 动态 ${counts.entries} · 附件 ${staged.value?.attachments ?? 0} 个`;
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function backup(): Promise<void> {
  running.value = '正在备份';
  error.value = '';
  try {
    const result = await props.bridge.backupLibrary();
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    // 用户取消时返回空结果：既不提示成功，也不改动任何显示。
    if (!result.value) return;
    lastBackup.value = result.value;
    try {
      localStorage.setItem('memocraft-last-backup', JSON.stringify(result.value));
    } catch {
      // 记不住「上次备份」不影响备份本身，降级为仅本次会话可见。
    }
    emit('notify', { message: `已备份 ${result.value.attachments} 个附件` });
  } finally {
    running.value = '';
  }
}

/** 第一步：选择备份并校验内容，只展开到暂存目录，不动当前数据。 */
async function chooseBackup(): Promise<void> {
  running.value = '正在校验备份';
  error.value = '';
  try {
    const result = await props.bridge.restoreLibrary();
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    if (!result.value) return;
    staged.value = result.value;
  } finally {
    running.value = '';
  }
}

/** 第二步：用户确认后才替换活动数据；失败会回滚到恢复前。 */
async function confirmRestore(): Promise<void> {
  running.value = '正在恢复';
  error.value = '';
  try {
    const result = await props.bridge.applyRestore();
    staged.value = null;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    emit('data-replaced');
    emit('notify', { message: '恢复完成，已重新打开数据' });
  } finally {
    running.value = '';
  }
}

async function exportData(): Promise<void> {
  running.value = '正在导出';
  error.value = '';
  try {
    const result = await props.bridge.exportLibrary();
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    if (!result.value) return;
    emit('notify', {
      message: `已导出 ${result.value.notes} 条手记、${result.value.threads} 个事务`,
    });
  } finally {
    running.value = '';
  }
}
</script>

<template>
  <section class="view">
    <header class="page-head">
      <div>
        <h1>设置</h1>
        <p class="sub">外观、数据与关于。正文与关系始终保存在本地数据库。</p>
      </div>
    </header>

    <section class="panel">
      <h2>外观</h2>
      <p class="panel-sub">偏好保存在本机，重启后保持。侧栏开关仍可在浅色与深色之间快速切换。</p>
      <div class="panel-row">
        <span class="pr-main">
          <span class="pr-title">主题</span>
          <span class="pr-hint">跟随系统时，随系统外观自动切换</span>
        </span>
        <div class="seg" role="radiogroup" aria-label="主题">
          <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="radio"
            :aria-checked="props.theme === option.value"
            @click="emit('update:theme', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>数据</h2>
      <p class="panel-sub">
        备份包含数据库快照、图片附件与校验清单；导出只用于阅读与迁移参考，不能代替备份。
      </p>
      <div class="panel-row">
        <span class="pr-main">
          <span class="pr-title">备份到文件夹</span>
          <span class="pr-hint">{{ lastBackupLabel }}</span>
        </span>
        <button class="btn" :disabled="props.busy || !!running" @click="backup">
          选择位置并备份
        </button>
      </div>
      <div class="panel-row">
        <span class="pr-main">
          <span class="pr-title">从备份恢复</span>
          <span class="pr-hint">会替换当前全部数据；开始前自动把当前数据备份到数据目录</span>
        </span>
        <button class="btn btn-danger" :disabled="props.busy || !!running" @click="chooseBackup">
          选择备份并校验…
        </button>
      </div>
      <div class="panel-row">
        <span class="pr-main">
          <span class="pr-title">导出为 Markdown</span>
          <span class="pr-hint">导出正文与关系元数据，文件名含稳定 ID</span>
        </span>
        <button class="btn" :disabled="props.busy || !!running" @click="exportData">导出…</button>
      </div>
      <div v-if="running" class="progress-line" role="status">
        <span>{{ running }}</span>
        <span class="progress-track"><span class="progress-fill is-indeterminate" /></span>
        <span>进行中 · 不能取消</span>
      </div>
      <p v-if="error" class="data-error" role="alert">{{ error }}</p>
    </section>

    <section class="panel">
      <h2>关于</h2>
      <p class="panel-sub">开发阶段应用固定显示「内测中」，不展示虚构的发布版本。</p>
      <dl class="kv">
        <dt>发行标识</dt>
        <dd>内测中</dd>
        <dt>数据库</dt>
        <dd>SQLite（应用内置驱动）· 结构化数据唯一主存储</dd>
        <dt>图片</dt>
        <dd>保存在应用用户数据目录的 attachments/，随备份一起复制</dd>
      </dl>
    </section>

    <p class="settings-note">
      <AppIcon
        name="check"
        class="icon-s"
      />数据位置由应用数据目录派生，不写入安装目录，也不在界面展示本机绝对路径。
    </p>

    <AppDialog
      v-if="staged"
      title="从备份恢复"
      hint="将使用所选备份替换当前全部数据"
      @close="staged = null"
    >
      <p class="restore-counts">{{ stagedLabel }}</p>
      <p class="restore-warning">
        当前的手记、归纳、事务、动态与草稿都会被替换。恢复开始后<b>不能取消</b>，期间请不要关闭应用；开始前会自动把当前数据备份到数据目录，失败时会回滚到现在的状态。
      </p>
      <template #footer>
        <button class="btn-quiet" :disabled="!!running" @click="staged = null">取消</button>
        <button class="btn-primary" :disabled="!!running" @click="confirmRestore">开始恢复</button>
      </template>
    </AppDialog>
  </section>
</template>

<style scoped>
.panel {
  margin-bottom: 18px;
  padding: 20px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.panel h2 {
  font-size: 15px;
}
.panel-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--faint);
}
.panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.pr-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.pr-title {
  font-size: 14px;
}
.pr-hint {
  font-size: 12px;
  color: var(--faint);
}
.progress-line {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--muted);
}
.progress-track {
  flex: 1;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--surface-3);
}
.progress-fill.is-indeterminate {
  display: block;
  width: 40%;
  height: 100%;
  background: var(--accent);
  animation: data-progress 1.4s ease-in-out infinite;
}
@keyframes data-progress {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}
.data-error {
  margin: 12px 0 0;
  color: var(--danger);
  font-size: 12px;
}
.restore-counts {
  margin: 0;
  font-size: 13px;
}
.restore-warning {
  margin: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
}
.kv {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 8px 14px;
  margin: 16px 0 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.kv dt {
  color: var(--faint);
}
.kv dd {
  margin: 0;
}
.settings-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--faint);
}
</style>
