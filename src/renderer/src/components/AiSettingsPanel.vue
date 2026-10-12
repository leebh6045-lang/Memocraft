<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { AI_MODELS, DEFAULT_AI_MODEL, DEFAULT_AI_BASE_URL } from '../../../shared/ai';
import type { AiApi, AiConnectionTest, AiSettings } from '../../../shared/ai';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{ ai: AiApi; busy?: boolean; active?: boolean; embedded?: boolean }>(),
  { active: true, embedded: false },
);
const emit = defineEmits<{ notify: [payload: { message: string }] }>();

const settings = ref<AiSettings | null>(null);
const loading = ref(false);
const operation = ref<'model' | 'address' | 'key' | 'clear' | ''>('');
// 地址单独提交，编辑不改变正在使用的配置；保存失败保留输入。
const baseUrlDraft = ref(DEFAULT_AI_BASE_URL);
// 密钥仅留在当前输入现场；成功提交后清空，不从桥接接口回读。
const keyDraft = ref('');
// 保存回执放在输入现场，独立于测试提示，避免其他操作让用户误以为密钥未保存。
const showKeySavedNotice = ref(false);
const error = ref('');
const notice = ref('');
const testResult = ref<AiConnectionTest | null>(null);
const activeTest = ref<string | null>(null);
const cancelling = ref(false);
let disposed = false;
let configurationVersion = 0;

const locked = computed(
  () => !!props.busy || loading.value || !!operation.value || activeTest.value !== null,
);
const selectedModel = computed(() => settings.value?.model ?? DEFAULT_AI_MODEL);
const hasKeyDraft = computed(() => keyDraft.value.length > 0);
const hasAddressDraft = computed(
  () => baseUrlDraft.value !== (settings.value?.baseUrl ?? DEFAULT_AI_BASE_URL),
);
const canTest = computed(
  () =>
    props.active &&
    !locked.value &&
    !!settings.value?.keyConfigured &&
    !!settings.value.encryptionAvailable &&
    !hasKeyDraft.value &&
    !hasAddressDraft.value,
);
const testedModelLabel = computed(
  () => AI_MODELS.find((model) => model.value === testResult.value?.model)?.label ?? '',
);
const operationLabel = computed(() => {
  if (operation.value === 'model') return '正在保存模型…';
  if (operation.value === 'address') return '正在保存地址…';
  if (operation.value === 'key') return '正在保存密钥…';
  return '正在清除密钥…';
});

/** 每次修改现场都让旧测试失效；已配置与本次测试成功是两个独立状态。 */
function resetFeedback(): void {
  configurationVersion += 1;
  error.value = '';
  notice.value = '';
  testResult.value = null;
}

async function loadSettings(): Promise<void> {
  if (locked.value) return;
  const previousBaseUrl = settings.value?.baseUrl;
  const retainAddressDraft = hasAddressDraft.value;
  loading.value = true;
  resetFeedback();
  try {
    const result = await props.ai.loadSettings();
    if (disposed) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    settings.value = result.value;
    // 备份/导出也会触发重读；只有存储地址确实改变时才替换尚未保存的地址草稿。
    if (!retainAddressDraft || !previousBaseUrl || result.value.baseUrl !== previousBaseUrl)
      baseUrlDraft.value = result.value.baseUrl;
    if (!result.value.keyConfigured) showKeySavedNotice.value = false;
  } catch {
    // 桥接失败不展示原始异常，避免把路径或凭据带到页面。
    if (!disposed) error.value = 'AI 设置未能加载，请重试。';
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function changeModel(event: Event): Promise<void> {
  const select = event.target;
  if (!(select instanceof HTMLSelectElement)) return;
  const option = AI_MODELS.find((model) => model.value === select.value);
  // 原生下拉已先变更 DOM；立刻恢复，只有持久化成功才显示新选择。
  select.value = selectedModel.value;
  if (!option || !settings.value || locked.value || option.value === selectedModel.value) return;
  operation.value = 'model';
  resetFeedback();
  try {
    const result = await props.ai.saveModel(option.value);
    if (disposed) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    settings.value = { ...settings.value, ...result.value };
    notice.value = '模型已保存。';
  } catch {
    if (!disposed) error.value = '模型未能保存，仍使用原来的模型。请重试。';
  } finally {
    if (!disposed) operation.value = '';
  }
}

function editBaseUrl(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (locked.value) {
    input.value = baseUrlDraft.value;
    return;
  }
  baseUrlDraft.value = input.value;
  resetFeedback();
}

async function saveBaseUrl(value = baseUrlDraft.value): Promise<void> {
  if (locked.value || !settings.value) return;
  operation.value = 'address';
  resetFeedback();
  try {
    const result = await props.ai.saveBaseUrl(value);
    if (disposed) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    settings.value = { ...settings.value, ...result.value };
    baseUrlDraft.value = result.value.baseUrl;
    notice.value =
      result.value.baseUrl === DEFAULT_AI_BASE_URL ? '已使用官方 API 地址。' : 'API 地址已保存。';
  } catch {
    if (!disposed) error.value = 'API 地址未能保存，输入仍保留，仍使用原地址。请重试。';
  } finally {
    if (!disposed) operation.value = '';
  }
}

function editKey(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (locked.value) {
    input.value = keyDraft.value;
    return;
  }
  keyDraft.value = input.value;
  showKeySavedNotice.value = false;
  resetFeedback();
}

async function saveKey(): Promise<void> {
  if (locked.value || !settings.value?.encryptionAvailable) return;
  showKeySavedNotice.value = false;
  resetFeedback();
  const key = keyDraft.value.trim();
  if (!key || /\s/.test(key) || key.length > 512) {
    error.value = '请填写有效密钥，不要包含空白，长度不能超过 512 个字符。';
    return;
  }
  operation.value = 'key';
  try {
    const result = await props.ai.saveKey(key);
    if (disposed) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    keyDraft.value = '';
    settings.value = { ...settings.value, keyConfigured: true };
    showKeySavedNotice.value = true;
    emit('notify', { message: '密钥已保存，可以测试连接。' });
  } catch {
    if (!disposed) error.value = '密钥未能保存，输入仍保留。请重试。';
  } finally {
    if (!disposed) operation.value = '';
  }
}

async function clearKey(): Promise<void> {
  if (locked.value) return;
  showKeySavedNotice.value = false;
  resetFeedback();
  operation.value = 'clear';
  try {
    const result = await props.ai.clearKey();
    if (disposed) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    keyDraft.value = '';
    if (settings.value) settings.value = { ...settings.value, keyConfigured: false };
    notice.value = settings.value ? '密钥已清除。' : '密钥已清除，请重新加载配置。';
  } catch {
    if (!disposed) error.value = '密钥未能清除，请重试。';
  } finally {
    if (!disposed) operation.value = '';
  }
}

async function testConnection(): Promise<void> {
  if (!canTest.value) return;
  resetFeedback();
  const version = configurationVersion;
  const requestId = crypto.randomUUID();
  activeTest.value = requestId;
  try {
    const result = await props.ai.testConnection(requestId);
    if (disposed || activeTest.value !== requestId || version !== configurationVersion) return;
    error.value = '';
    notice.value = '';
    if (!result.ok) {
      if (result.error.code === 'AI_CANCELLED') notice.value = '已取消连接测试。';
      else error.value = result.error.message;
      return;
    }
    if (result.value.model !== settings.value?.model) {
      error.value = '配置已变化，请重新测试连接。';
      return;
    }
    testResult.value = result.value;
  } catch {
    if (!disposed && activeTest.value === requestId) error.value = '连接测试未完成，请重试。';
  } finally {
    if (!disposed && activeTest.value === requestId) {
      activeTest.value = null;
      cancelling.value = false;
    }
  }
}

async function cancelTest(): Promise<void> {
  const requestId = activeTest.value;
  if (!requestId || cancelling.value || props.busy) return;
  cancelling.value = true;
  try {
    const result = await props.ai.cancelTest(requestId);
    if (disposed || activeTest.value !== requestId) return;
    if (!result.ok) {
      error.value = result.error.message;
      return;
    }
    // 取消成功后立即撤销本页请求身份，迟到的成功应答不能重新点亮结果。
    activeTest.value = null;
    resetFeedback();
    notice.value = '已取消连接测试。';
  } catch {
    if (!disposed && activeTest.value === requestId)
      error.value = '取消未完成，可以再次取消或等待测试结束。';
  } finally {
    if (!disposed && (activeTest.value === requestId || activeTest.value === null))
      cancelling.value = false;
  }
}

onMounted(() => void loadSettings());
watch(
  () => props.active,
  (active) => {
    const requestId = activeTest.value;
    if (active || !requestId) return;
    // 分类隐藏仍保留组件；先撤销测试身份，迟到应答不能覆盖返回后的新测试。
    activeTest.value = null;
    cancelling.value = false;
    resetFeedback();
    void props.ai.cancelTest(requestId).catch(() => {
      // 隐藏页不回显旧请求的清理异常；主进程总超时仍会释放资源。
    });
  },
);
watch(
  () => props.busy,
  (busy, previouslyBusy) => {
    // 数据恢复会改地址与模型；长任务结束后重新读取，同时保留尚未提交的密钥输入。
    if (!busy && previouslyBusy) void loadSettings();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  const requestId = activeTest.value;
  if (!requestId) return;
  activeTest.value = null;
  // 页面已销毁，清理失败无法显示；只取消自己的请求，不记录异常或凭据。
  void props.ai.cancelTest(requestId).catch(() => {
    // 主进程仍有总超时作为最后的资源释放边界。
  });
});
</script>

<template>
  <section class="panel" :class="{ embedded }" aria-labelledby="ai-settings-title">
    <h2 id="ai-settings-title">AI 设置</h2>
    <p class="panel-sub">配置保存在本机，密钥单独加密保存，不随知识库备份或导出。</p>

    <div class="panel-row">
      <span class="pr-main"><span class="pr-title">厂商</span></span>
      <span class="provider-name">DeepSeek</span>
    </div>
    <div class="panel-row">
      <label class="pr-main" for="ai-model">
        <span class="pr-title">模型</span>
        <span class="pr-hint">选择后自动保存</span>
      </label>
      <select
        id="ai-model"
        :value="selectedModel"
        :disabled="locked || !settings"
        @change="changeModel"
      >
        <option v-for="model in AI_MODELS" :key="model.value" :value="model.value">
          {{ model.label }}
        </option>
      </select>
    </div>
    <div class="panel-row key-row">
      <label class="pr-main" for="ai-base-url">
        <span class="pr-title">API 地址（Base URL）</span>
        <span id="ai-base-url-hint" class="pr-hint"
          >默认使用官方地址，也可填写带 /v1 的服务地址；留空保存恢复官方。</span
        >
      </label>
      <div class="key-controls">
        <input
          id="ai-base-url"
          type="url"
          autocomplete="off"
          spellcheck="false"
          maxlength="2048"
          :placeholder="DEFAULT_AI_BASE_URL"
          :value="baseUrlDraft"
          :disabled="locked || !settings"
          aria-describedby="ai-base-url-hint"
          @input="editBaseUrl"
        />
        <div class="key-actions">
          <button
            type="button"
            class="btn"
            :disabled="locked || !settings || !hasAddressDraft"
            @click="saveBaseUrl()"
          >
            {{ operation === 'address' ? '保存中…' : '保存地址' }}
          </button>
          <button
            type="button"
            class="btn"
            :disabled="
              locked || !settings || (!hasAddressDraft && settings.baseUrl === DEFAULT_AI_BASE_URL)
            "
            @click="saveBaseUrl(DEFAULT_AI_BASE_URL)"
          >
            恢复官方
          </button>
        </div>
      </div>
    </div>
    <div class="panel-row key-row">
      <label class="pr-main" for="ai-key">
        <span class="pr-title">API 密钥</span>
        <span class="pr-hint key-status" :class="{ 'is-configured': settings?.keyConfigured }">
          <AppIcon v-if="settings?.keyConfigured" name="check" class="status-icon" />
          {{ settings ? (settings.keyConfigured ? '已配置' : '未配置') : '配置状态待加载' }}
        </span>
      </label>
      <div class="key-controls">
        <input
          id="ai-key"
          type="password"
          autocomplete="off"
          spellcheck="false"
          maxlength="512"
          :value="keyDraft"
          :disabled="locked || !settings?.encryptionAvailable"
          :placeholder="settings?.keyConfigured ? '输入新密钥以更换' : '输入 DeepSeek API 密钥'"
          @input="editKey"
        />
        <div class="key-actions">
          <button
            type="button"
            class="btn"
            :disabled="locked || !settings?.encryptionAvailable || !keyDraft.trim()"
            @click="saveKey"
          >
            {{ operation === 'key' ? '保存中…' : '保存密钥' }}
          </button>
          <button
            type="button"
            class="btn btn-danger"
            :disabled="locked || settings?.keyConfigured === false"
            @click="clearKey"
          >
            清除密钥
          </button>
        </div>
        <div v-if="showKeySavedNotice" class="key-saved-notice" role="status" aria-live="polite">
          <AppIcon name="check" class="saved-icon" />
          <div>
            <strong>密钥已保存</strong>
            <p>输入框已清空以保护密钥，已保存的密钥可继续使用。</p>
          </div>
        </div>
      </div>
    </div>
    <p
      v-if="settings"
      class="protection-hint"
      :class="{ unavailable: !settings.encryptionAvailable }"
    >
      {{
        settings.encryptionAvailable
          ? '系统密钥保护已启用。'
          : '系统密钥保护不可用，暂不能保存或测试；仍可清除密钥。'
      }}
    </p>
    <div class="panel-row">
      <span class="pr-main">
        <span class="pr-title">测试连接</span>
        <span class="pr-hint">发送固定测试文字，会产生少量费用，不发送个人手记</span>
      </span>
      <button
        v-if="activeTest"
        type="button"
        class="btn"
        :disabled="cancelling || busy"
        @click="cancelTest"
      >
        {{ cancelling ? '正在取消…' : '取消测试' }}
      </button>
      <button v-else type="button" class="btn" :disabled="!canTest" @click="testConnection">
        测试连接
      </button>
    </div>
    <p v-if="hasKeyDraft" class="feedback hint">请先保存或清空新输入的密钥，再测试连接。</p>
    <p v-if="hasAddressDraft" class="feedback hint">请先保存地址或恢复官方，再测试连接。</p>
    <p v-if="loading" class="feedback" role="status">正在加载 AI 设置…</p>
    <p v-else-if="operation" class="feedback" role="status">{{ operationLabel }}</p>
    <p v-if="activeTest" class="feedback" role="status">正在测试连接…</p>
    <p v-if="testResult" class="feedback success" role="status">
      连接成功 · {{ testedModelLabel }} · {{ (testResult.elapsedMs / 1000).toFixed(1) }} 秒
    </p>
    <p v-if="notice" class="feedback" role="status">{{ notice }}</p>
    <p v-if="error" class="feedback error" role="alert">{{ error }}</p>
    <button
      v-if="!settings && !loading"
      type="button"
      class="btn retry"
      :disabled="locked"
      @click="loadSettings"
    >
      重新加载 AI 设置
    </button>
    <p class="privacy-note">
      使用 AI 功能时，所需的文字和图片会发送到已保存的 API 地址。自定义服务需兼容所选 DeepSeek
      模型。
    </p>
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
.panel.embedded {
  margin-bottom: 24px;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.panel.embedded h2 {
  font-size: 20px;
}
.panel-sub,
.pr-hint,
.protection-hint,
.privacy-note {
  font-size: 12px;
  color: var(--faint);
}
.panel-sub {
  margin-top: 4px;
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
.pr-title,
.provider-name {
  font-size: 14px;
}
select,
input {
  min-width: 0;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-s);
  background: var(--surface);
  font-size: 13px;
}
select {
  max-width: 100%;
}
.key-row {
  align-items: flex-start;
}
.key-controls {
  display: grid;
  gap: 8px;
  width: min(340px, 60%);
}
.key-controls input {
  width: 100%;
}
.key-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.key-status {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  gap: 4px;
}
.key-status.is-configured {
  padding: 3px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--c-done) 12%, var(--surface));
  color: var(--text);
  font-weight: 500;
}
.status-icon {
  width: 13px;
  height: 13px;
  color: var(--c-done);
}
.key-saved-notice {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 12px;
  border: 1px solid color-mix(in srgb, var(--c-done) 35%, var(--surface));
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--c-done) 9%, var(--surface));
}
.saved-icon {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--c-done);
}
.key-saved-notice strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.key-saved-notice p {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
}
.protection-hint,
.privacy-note {
  margin-top: 12px;
}
.feedback {
  margin-top: 12px;
  font-size: 12px;
  color: var(--muted);
}
.success {
  color: var(--c-done);
}
.error,
.unavailable {
  color: var(--danger);
}
.retry {
  margin-top: 12px;
}
@media (max-width: 720px) {
  .key-row {
    flex-direction: column;
  }
  .key-controls {
    width: 100%;
  }
}
/* 分类菜单占用部分宽度，按实际表单宽度换行，避免最小桌面窗口挤压输入。 */
@container (max-width: 460px) {
  .embedded .panel-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .embedded .panel-row > select,
  .embedded .panel-row > button,
  .embedded .provider-name {
    align-self: flex-end;
  }
  .embedded .key-controls {
    width: 100%;
  }
}
</style>
