// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import AiSettingsPanel from '../../src/renderer/src/components/AiSettingsPanel.vue';
import type { AiApi, AiConfiguration, AiConnectionTest, AiSettings } from '../../src/shared/ai';
import { DEFAULT_AI_BASE_URL } from '../../src/shared/ai';
import { validateAiBaseUrl } from '../../src/services/ai-validation';
import type { ErrorCode, Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function makeApi(overrides: Partial<AiSettings> = {}): AiApi {
  const settings: AiSettings = {
    provider: 'deepseek',
    model: 'deepseek-flash',
    baseUrl: DEFAULT_AI_BASE_URL,
    keyConfigured: false,
    encryptionAvailable: true,
    ...overrides,
  };
  return {
    loadSettings: vi.fn(async () => success(settings)),
    saveModel: vi.fn(async (model) =>
      success<AiConfiguration>({ provider: 'deepseek', model, baseUrl: settings.baseUrl }),
    ),
    saveBaseUrl: vi.fn(async (value) => {
      settings.baseUrl = validateAiBaseUrl(value);
      return success<AiConfiguration>({
        provider: 'deepseek',
        model: settings.model,
        baseUrl: settings.baseUrl,
      });
    }),
    saveKey: vi.fn(async () => success(null)),
    clearKey: vi.fn(async () => success(null)),
    testConnection: vi.fn(async () =>
      success<AiConnectionTest>({
        model: settings.model,
        checkedAt: '2026-10-10T10:00:00.000Z',
        elapsedMs: 850,
      }),
    ),
    suggest: vi.fn(async () => ({
      ok: true as const,
      value: { tags: [], topics: [], usedImages: 0, skippedImages: 0, imagesSupported: true },
    })),
    cancelSuggestion: vi.fn(async () => ({ ok: true as const, value: null })),
    ask: vi.fn(async () => ({
      ok: true as const,
      value: { answer: '', sources: [], matchedNotes: 0 },
    })),
    cancelAsk: vi.fn(async () => ({ ok: true as const, value: null })),
    summarizePeriod: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'UNAVAILABLE' as const, message: '此测试不生成回顾' },
    })),
    cancelPeriodSummary: vi.fn(async () => ({ ok: true as const, value: null })),
    cancelTest: vi.fn(async () => success(null)),
  };
}

/** 手动完成桥接请求，观察保存中与迟到应答，不依赖计时器或网络。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟请求尚未初始化');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

let wrapper: VueWrapper | undefined;

async function mountPanel(ai: AiApi, busy = false) {
  wrapper = mount(AiSettingsPanel, { props: { ai, busy } });
  await flushPromises();
  return wrapper;
}

function button(panel: VueWrapper, label: string) {
  const result = panel.findAll('button').find((item) => item.text() === label);
  if (!result) throw new Error(`没有找到按钮：${label}`);
  return result;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.restoreAllMocks();
});

describe('AI 设置与测试连接', () => {
  it('配置未知时保持通用标题，读取到无密钥配置才引导接入', async () => {
    const ai = makeApi();
    const pending = deferred<Result<AiSettings>>();
    vi.mocked(ai.loadSettings).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(ai);
    expect(panel.get('#ai-settings-title').text()).toBe('AI 服务');
    pending.resolve(
      success({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: DEFAULT_AI_BASE_URL,
        keyConfigured: false,
        encryptionAvailable: true,
      }),
    );
    await flushPromises();
    expect(panel.get('#ai-settings-title').text()).toBe('为 Memocraft 接入 AI');
    expect(panel.find('.feedback.success').exists()).toBe(false);
  });

  it('默认官方地址，保存后规范化回填，空串保存与恢复官方均可用', async () => {
    const ai = makeApi({ keyConfigured: true });
    const panel = await mountPanel(ai);
    const input = panel.get<HTMLInputElement>('#ai-base-url');
    expect(input.element.value).toBe(DEFAULT_AI_BASE_URL);
    expect(input.attributes('aria-describedby')).toBe('ai-base-url-hint');
    await input.setValue('https://gateway.example/v1/chat/completions/');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    expect(input.element.value).toBe('https://gateway.example/v1');
    expect(button(panel, '测试连接').attributes('disabled')).toBeUndefined();
    await input.setValue('');
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    expect(input.element.value).toBe(DEFAULT_AI_BASE_URL);
    await input.setValue('https://gateway.example/v1');
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    await button(panel, '恢复官方').trigger('click');
    await flushPromises();
    expect(ai.saveBaseUrl).toHaveBeenLastCalledWith(DEFAULT_AI_BASE_URL);
    expect(input.element.value).toBe(DEFAULT_AI_BASE_URL);
  });

  it('地址保存失败保留输入及原地址，保存中禁用配置，模型保存不抹掉地址草稿', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<AiConfiguration>>();
    vi.mocked(ai.saveBaseUrl).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(ai);
    await panel.get('#ai-base-url').setValue('https://gateway.example');
    await button(panel, '保存地址').trigger('click');
    expect(panel.get('#ai-base-url').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-model').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    pending.resolve(failure('STORAGE', '地址写入失败'));
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://gateway.example',
    );
    expect(panel.get('[role="alert"]').text()).toBe('地址写入失败');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    await panel.get('#ai-model').setValue('deepseek-v4-pro');
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://gateway.example',
    );
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    vi.mocked(ai.saveBaseUrl).mockRejectedValueOnce(new Error('secret-url'));
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toContain('仍使用原地址');
    expect(panel.text()).not.toContain('secret-url');
  });

  it('编辑地址清除旧成功回执，测试期间锁定地址，恢复完成重载已保存地址', async () => {
    const ai = makeApi({ keyConfigured: true });
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('连接成功');
    await panel.get('#ai-base-url').setValue('https://gateway.example');
    expect(panel.text()).not.toContain('连接成功');
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    const pending = deferred<Result<AiConnectionTest>>();
    vi.mocked(ai.testConnection).mockReturnValueOnce(pending.promise);
    await button(panel, '测试连接').trigger('click');
    expect(panel.get('#ai-base-url').attributes('disabled')).toBeDefined();
    expect(button(panel, '保存地址').attributes('disabled')).toBeDefined();
    expect(button(panel, '恢复官方').attributes('disabled')).toBeDefined();
    await button(panel, '取消测试').trigger('click');
    await flushPromises();
    vi.mocked(ai.loadSettings).mockResolvedValueOnce(
      success({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: 'https://restored.example/v1',
        keyConfigured: true,
        encryptionAvailable: true,
      }),
    );
    await panel.setProps({ busy: true });
    await panel.setProps({ busy: false });
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://restored.example/v1',
    );
    expect(panel.text()).not.toContain('连接成功');
  });

  it('备份或导出结束后重读同一配置，不抹掉未保存或保存失败的地址输入', async () => {
    const ai = makeApi({ keyConfigured: true });
    const panel = await mountPanel(ai);
    await panel.get('#ai-base-url').setValue('https://unsaved.example/v1');
    await panel.setProps({ busy: true });
    await panel.setProps({ busy: false });
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://unsaved.example/v1',
    );
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    vi.mocked(ai.saveBaseUrl).mockResolvedValueOnce(failure('STORAGE', '未保存'));
    await button(panel, '保存地址').trigger('click');
    await flushPromises();
    await panel.setProps({ busy: true });
    await panel.setProps({ busy: false });
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://unsaved.example/v1',
    );
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
  });
  it('首次加载显示厂商、默认模型与未配置状态，密钥不会回填', async () => {
    const panel = await mountPanel(makeApi());
    expect(panel.text()).toContain('DeepSeek');
    expect(panel.text()).toContain('未配置');
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-flash');
    expect(panel.get<HTMLInputElement>('#ai-key').element.value).toBe('');
    expect(panel.get('#ai-key').attributes('type')).toBe('password');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    expect(panel.text()).toContain('会产生少量费用，不发送个人手记');
  });

  it('加载失败提供重试与清除密钥入口，恢复后使用持久化模型', async () => {
    const ai = makeApi({ model: 'deepseek-v4-pro', keyConfigured: true });
    vi.mocked(ai.loadSettings).mockResolvedValueOnce(
      failure('AI_CREDENTIAL', '密钥无法读取，请重新保存。'),
    );
    const panel = await mountPanel(ai);
    expect(panel.get('[role="alert"]').text()).toContain('密钥无法读取');
    expect(button(panel, '清除密钥').attributes('disabled')).toBeUndefined();
    await button(panel, '清除密钥').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('密钥已清除，请重新加载配置');
    await button(panel, '重新加载 AI 设置').trigger('click');
    await flushPromises();
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-v4-pro');
    expect(panel.find('[role="alert"]').exists()).toBe(false);
  });

  it('桥接加载拒绝只显示安全提示，可重新加载', async () => {
    const ai = makeApi();
    vi.mocked(ai.loadSettings).mockRejectedValueOnce(new Error('private-test-key'));
    const panel = await mountPanel(ai);
    expect(panel.get('[role="alert"]').text()).toBe('AI 设置未能加载，请重试。');
    expect(panel.text()).not.toContain('private-test-key');
    await button(panel, '重新加载 AI 设置').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('未配置');
  });

  it('密钥保存失败保留输入，成功清空输入并允许用已保存配置测试', async () => {
    const ai = makeApi();
    vi.mocked(ai.saveKey).mockResolvedValueOnce(failure('AI_CREDENTIAL', '密钥保存失败，请重试。'));
    const panel = await mountPanel(ai);
    await panel.get('#ai-key').setValue('test-secret');
    expect(panel.text()).toContain('请先保存或清空');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    await button(panel, '保存密钥').trigger('click');
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-key').element.value).toBe('test-secret');
    expect(panel.text()).toContain('未配置');
    expect(panel.get('[role="alert"]').text()).toBe('密钥保存失败，请重试。');
    expect(panel.find('.key-saved-notice').exists()).toBe(false);
    expect(panel.emitted('notify')).toBeUndefined();
    await button(panel, '保存密钥').trigger('click');
    await flushPromises();
    expect(panel.get<HTMLInputElement>('#ai-key').element.value).toBe('');
    expect(panel.text()).toContain('已配置');
    expect(panel.get('#ai-settings-title').text()).toBe('AI 服务');
    expect(panel.find('.feedback.success').exists()).toBe(false);
    expect(panel.get('.key-controls .key-saved-notice').text()).toContain('密钥已保存');
    expect(panel.get('.key-saved-notice').text()).toContain('输入框已清空以保护密钥');
    expect(panel.get('.key-status').classes()).toContain('is-configured');
    expect(panel.emitted('notify')).toEqual([[{ message: '密钥已保存，可以测试连接。' }]]);
    expect(button(panel, '测试连接').attributes('disabled')).toBeUndefined();

    // 测试和恢复后的配置重读不能让刚完成的保存回执消失。
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.get('.key-saved-notice').text()).toContain('密钥已保存');
    vi.mocked(ai.loadSettings).mockResolvedValueOnce(
      success({
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: DEFAULT_AI_BASE_URL,
        keyConfigured: true,
        encryptionAvailable: true,
      }),
    );
    await panel.setProps({ busy: true });
    await panel.setProps({ busy: false });
    await flushPromises();
    expect(panel.get('.key-saved-notice').text()).toContain('密钥已保存');
    await panel.get('#ai-key').setValue('replacement-secret');
    expect(panel.find('.key-saved-notice').exists()).toBe(false);
  });

  it('拒绝的密钥保存不泄露异常、保留现场；保存中禁用其他配置操作', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<null>>();
    vi.mocked(ai.saveKey)
      .mockReturnValueOnce(pending.promise)
      .mockRejectedValueOnce(new Error('test-secret'));
    const panel = await mountPanel(ai);
    await panel.get('#ai-key').setValue('test-secret');
    await button(panel, '保存密钥').trigger('click');
    expect(button(panel, '保存中…').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-model').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    expect(button(panel, '清除密钥').attributes('disabled')).toBeDefined();
    pending.resolve(failure('AI_CREDENTIAL', '未保存'));
    await flushPromises();
    await button(panel, '保存密钥').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toBe('密钥未能保存，输入仍保留。请重试。');
    expect(panel.get<HTMLInputElement>('#ai-key').element.value).toBe('test-secret');
    expect(panel.text()).not.toContain('test-secret');
  });

  it('模型持久化失败恢复旧选择，成功后才显示新模型', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<AiConfiguration>>();
    vi.mocked(ai.saveModel).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(ai);
    await panel.get('#ai-model').setValue('deepseek-v4-pro');
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-flash');
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    pending.resolve(failure('STORAGE', '模型保存失败'));
    await flushPromises();
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-flash');
    expect(panel.get('[role="alert"]').text()).toBe('模型保存失败');
    await panel.get('#ai-model').setValue('deepseek-v4-pro');
    await flushPromises();
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-v4-pro');
  });

  it('模型保存的桥接拒绝恢复选择并给出可重试提示', async () => {
    const ai = makeApi();
    vi.mocked(ai.saveModel).mockRejectedValueOnce(new Error('internal details'));
    const panel = await mountPanel(ai);
    await panel.get('#ai-model').setValue('deepseek-v4-pro');
    await flushPromises();
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-flash');
    expect(panel.get('[role="alert"]').text()).toContain('仍使用原来的模型');
    expect(panel.text()).not.toContain('internal details');
  });

  it('测试成功显示模型与耗时，编辑密钥或切换模型会清空结果', async () => {
    const ai = makeApi({ keyConfigured: true });
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('连接成功 · DeepSeek V4.1 Flash · 0.8 秒');
    const firstId = vi.mocked(ai.testConnection).mock.calls[0]?.[0];
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    await panel.get('#ai-key').setValue('new-test-key');
    expect(panel.text()).not.toContain('连接成功');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    await panel.get('#ai-key').setValue('');
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(vi.mocked(ai.testConnection).mock.calls[1]?.[0]).not.toBe(firstId);
    await panel.get('#ai-model').setValue('deepseek-v4-pro');
    await flushPromises();
    expect(panel.text()).not.toContain('连接成功');
  });

  it('测试失败呈现业务错误，桥接拒绝使用安全提示，不自动重试', async () => {
    const ai = makeApi({ keyConfigured: true });
    vi.mocked(ai.testConnection)
      .mockResolvedValueOnce(failure('AI_BALANCE', '余额不足，请充值后重试。'))
      .mockRejectedValueOnce(new Error('private-test-key'));
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toBe('余额不足，请充值后重试。');
    expect(panel.text()).not.toContain('连接成功');
    expect(ai.testConnection).toHaveBeenCalledTimes(1);
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toBe('连接测试未完成，请重试。');
    expect(panel.text()).not.toContain('private-test-key');
  });

  it('测试期间配置不可修改，取消自己的请求后忽略迟到成功', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<AiConnectionTest>>();
    vi.mocked(ai.testConnection).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    expect(panel.text()).toContain('正在测试连接');
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-model').attributes('disabled')).toBeDefined();
    await button(panel, '取消测试').trigger('click');
    await flushPromises();
    expect(ai.cancelTest).toHaveBeenCalledWith(vi.mocked(ai.testConnection).mock.calls[0]?.[0]);
    expect(panel.text()).toContain('已取消连接测试');
    pending.resolve(
      success({ model: 'deepseek-flash', checkedAt: '2026-10-10T10:00:00.000Z', elapsedMs: 10 }),
    );
    await flushPromises();
    expect(panel.text()).not.toContain('连接成功');
    expect(button(panel, '测试连接').attributes('disabled')).toBeUndefined();
  });

  it('取消失败保留活动测试，可以再次取消', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<AiConnectionTest>>();
    vi.mocked(ai.testConnection).mockReturnValueOnce(pending.promise);
    vi.mocked(ai.cancelTest).mockRejectedValueOnce(new Error('internal details'));
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await button(panel, '取消测试').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toContain('可以再次取消或等待测试结束');
    expect(button(panel, '取消测试').attributes('disabled')).toBeUndefined();
    await button(panel, '取消测试').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('已取消连接测试');
  });

  it('旧取消应答不会改变新测试的取消状态', async () => {
    const ai = makeApi({ keyConfigured: true });
    const firstTest = deferred<Result<AiConnectionTest>>();
    const secondTest = deferred<Result<AiConnectionTest>>();
    const firstCancel = deferred<Result<null>>();
    const secondCancel = deferred<Result<null>>();
    vi.mocked(ai.testConnection)
      .mockReturnValueOnce(firstTest.promise)
      .mockReturnValueOnce(secondTest.promise);
    vi.mocked(ai.cancelTest)
      .mockReturnValueOnce(firstCancel.promise)
      .mockReturnValueOnce(secondCancel.promise);
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await button(panel, '取消测试').trigger('click');
    firstTest.resolve(
      success({
        model: 'deepseek-flash',
        checkedAt: '2026-10-10T10:00:00.000Z',
        elapsedMs: 10,
      }),
    );
    await flushPromises();
    await button(panel, '测试连接').trigger('click');
    await button(panel, '取消测试').trigger('click');
    firstCancel.resolve(success(null));
    await flushPromises();
    expect(button(panel, '正在取消…').attributes('disabled')).toBeDefined();
    secondCancel.resolve(success(null));
    await flushPromises();
    expect(panel.text()).toContain('已取消连接测试');
  });

  it('应答模型与当前已保存配置不同，不展示测试成功', async () => {
    const ai = makeApi({ keyConfigured: true });
    vi.mocked(ai.testConnection).mockResolvedValueOnce(
      success({
        model: 'deepseek-v4-pro',
        checkedAt: '2026-10-10T10:00:00.000Z',
        elapsedMs: 10,
      }),
    );
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    expect(panel.get('[role="alert"]').text()).toBe('配置已变化，请重新测试连接。');
    expect(panel.text()).not.toContain('连接成功');
  });

  it('分类隐藏取消自己的测试，旧成功与取消应答不覆盖返回后的新测试', async () => {
    const ai = makeApi({ keyConfigured: true });
    const first = deferred<Result<AiConnectionTest>>();
    const second = deferred<Result<AiConnectionTest>>();
    const cancellation = deferred<Result<null>>();
    vi.mocked(ai.testConnection)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.mocked(ai.cancelTest).mockReturnValueOnce(cancellation.promise);
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    const requestId = vi.mocked(ai.testConnection).mock.calls[0]?.[0];
    await panel.setProps({ active: false });
    expect(ai.cancelTest).toHaveBeenCalledExactlyOnceWith(requestId);
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    await panel.setProps({ active: true });
    expect(ai.loadSettings).toHaveBeenCalledTimes(1);
    await button(panel, '测试连接').trigger('click');
    first.resolve(
      success({ model: 'deepseek-flash', checkedAt: '2026-10-10T10:00:00.000Z', elapsedMs: 5 }),
    );
    cancellation.resolve(success(null));
    await flushPromises();
    expect(panel.text()).not.toContain('连接成功');
    expect(button(panel, '取消测试').exists()).toBe(true);
    second.resolve(
      success({ model: 'deepseek-flash', checkedAt: '2026-10-10T10:00:00.000Z', elapsedMs: 20 }),
    );
    await flushPromises();
    expect(panel.text()).toContain('连接成功');
  });

  it('无测试时分类隐藏保留输入、保存回执与已完成测试结果', async () => {
    const ai = makeApi();
    const panel = await mountPanel(ai);
    await panel.get('#ai-key').setValue('test-only-settings-key');
    await button(panel, '保存密钥').trigger('click');
    await flushPromises();
    await button(panel, '测试连接').trigger('click');
    await flushPromises();
    await panel.setProps({ active: false });
    await panel.setProps({ active: true });
    expect(panel.find('.key-saved-notice').exists()).toBe(true);
    expect(panel.text()).toContain('连接成功');
    await panel.get('#ai-base-url').setValue('https://draft.example/v1');
    await panel.get('#ai-key').setValue('unsaved-test-key');
    await panel.setProps({ active: false });
    await panel.setProps({ active: true });
    expect(panel.get<HTMLInputElement>('#ai-base-url').element.value).toBe(
      'https://draft.example/v1',
    );
    expect(panel.get<HTMLInputElement>('#ai-key').element.value).toBe('unsaved-test-key');
    expect(ai.loadSettings).toHaveBeenCalledTimes(1);
    expect(ai.cancelTest).not.toHaveBeenCalled();
  });

  it('卸载取消自己的请求，迟到结果不会更新新组件', async () => {
    const ai = makeApi({ keyConfigured: true });
    const pending = deferred<Result<AiConnectionTest>>();
    vi.mocked(ai.testConnection).mockReturnValueOnce(pending.promise);
    const panel = await mountPanel(ai);
    await button(panel, '测试连接').trigger('click');
    const requestId = vi.mocked(ai.testConnection).mock.calls[0]?.[0];
    panel.unmount();
    wrapper = undefined;
    expect(ai.cancelTest).toHaveBeenCalledWith(requestId);
    const newPanel = await mountPanel(ai);
    pending.resolve(
      success({ model: 'deepseek-flash', checkedAt: '2026-10-10T10:00:00.000Z', elapsedMs: 5 }),
    );
    await flushPromises();
    expect(newPanel.text()).not.toContain('连接成功');
    expect(button(newPanel, '测试连接').attributes('disabled')).toBeUndefined();
  });

  it('清除失败保留已配置状态，成功后禁用测试并保留模型', async () => {
    const ai = makeApi({ keyConfigured: true, model: 'deepseek-v4-pro' });
    vi.mocked(ai.clearKey).mockResolvedValueOnce(failure('AI_CREDENTIAL', '清除失败'));
    const panel = await mountPanel(ai);
    await button(panel, '清除密钥').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('已配置');
    await button(panel, '清除密钥').trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('未配置');
    expect(panel.get('#ai-settings-title').text()).toBe('为 Memocraft 接入 AI');
    expect(panel.get<HTMLSelectElement>('#ai-model').element.value).toBe('deepseek-v4-pro');
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
  });

  it('密钥保护不可用拒绝保存和测试，但仍允许清除', async () => {
    const ai = makeApi({ keyConfigured: true, encryptionAvailable: false });
    const panel = await mountPanel(ai);
    expect(panel.text()).toContain('系统密钥保护不可用');
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    expect(button(panel, '保存密钥').attributes('disabled')).toBeDefined();
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    expect(button(panel, '清除密钥').attributes('disabled')).toBeUndefined();
  });

  it('外部繁忙状态禁止修改与测试', async () => {
    const ai = makeApi({ keyConfigured: true });
    const panel = await mountPanel(ai);
    await panel.setProps({ busy: true });
    expect(panel.get('#ai-model').attributes('disabled')).toBeDefined();
    expect(panel.get('#ai-key').attributes('disabled')).toBeDefined();
    expect(button(panel, '清除密钥').attributes('disabled')).toBeDefined();
    expect(button(panel, '测试连接').attributes('disabled')).toBeDefined();
    expect(ai.saveKey).not.toHaveBeenCalled();
    expect(ai.saveModel).not.toHaveBeenCalled();
    expect(ai.testConnection).not.toHaveBeenCalled();
  });
});
