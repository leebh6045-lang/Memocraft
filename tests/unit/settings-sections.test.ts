// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import SettingsPage from '../../src/renderer/src/pages/SettingsPage.vue';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from '../../src/shared/ai';
import type { AiConfiguration, AiSettings } from '../../src/shared/ai';
import type { BackupSummary, ExportSummary, StagedRestore } from '../../src/domain/library-data';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 手动完成保存或数据应答，验证切页后仍处理真实结果，不依赖动画时钟。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟桥接请求尚未初始化');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture(): MemocraftApi {
  const settings: AiSettings = {
    provider: 'deepseek',
    model: DEFAULT_AI_MODEL,
    baseUrl: DEFAULT_AI_BASE_URL,
    keyConfigured: false,
    encryptionAvailable: true,
  };
  return {
    ...disconnectedApi,
    ai: {
      ...disconnectedApi.ai,
      loadSettings: vi.fn(async () => success(settings)),
      saveBaseUrl: vi.fn(async (baseUrl) =>
        success<AiConfiguration>({ provider: 'deepseek', model: DEFAULT_AI_MODEL, baseUrl }),
      ),
      saveKey: vi.fn(async () => success(null)),
    },
    backupLibrary: vi.fn(disconnectedApi.backupLibrary),
    exportLibrary: vi.fn(disconnectedApi.exportLibrary),
    restoreLibrary: vi.fn(disconnectedApi.restoreLibrary),
    applyRestore: vi.fn(async () => success(null)),
  };
}

let wrapper: VueWrapper | undefined;
let host: HTMLElement | undefined;
const originalInert = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert');

beforeEach(() => {
  // jsdom 未实现 inert 属性反射；按浏览器布尔属性语义增删，避免把 false 误当存在。
  Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get: function (this: HTMLElement): boolean {
      return this.hasAttribute('inert');
    },
    set: function (this: HTMLElement, value: boolean): void {
      this.toggleAttribute('inert', value);
    },
  });
});

async function mountSettings(
  bridge = fixture(),
  initialSection?: 'appearance' | 'ai',
): Promise<VueWrapper> {
  host = document.createElement('div');
  document.body.append(host);
  wrapper = mount(SettingsPage, {
    attachTo: host,
    props: { theme: 'light', bridge, busy: false, initialSection },
  });
  await flushPromises();
  return wrapper;
}

function button(settings: VueWrapper, label: string): DOMWrapper<HTMLButtonElement> {
  const target = settings
    .findAll<HTMLButtonElement>('button')
    .find((item) => item.text() === label);
  if (!target) throw new Error(`未找到设置按钮：${label}`);
  return target;
}

function tab(settings: VueWrapper, label: string): DOMWrapper<HTMLButtonElement> {
  const target = settings
    .findAll<HTMLButtonElement>('[role="tab"]')
    .find((item) => item.text() === label);
  if (!target) throw new Error(`未找到设置分类：${label}`);
  return target;
}

async function choose(settings: VueWrapper, label: string): Promise<void> {
  await tab(settings, label).trigger('click');
  await flushPromises();
}

function selectedTab(settings: VueWrapper) {
  return settings.get<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
}

function expectTabsLocked(settings: VueWrapper, locked: boolean): void {
  for (const item of settings.findAll<HTMLButtonElement>('[role="tab"]'))
    expect(item.element.disabled).toBe(locked);
}

afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  await flushPromises();
  host?.remove();
  host = undefined;
  localStorage.clear();
  if (originalInert) Object.defineProperty(HTMLElement.prototype, 'inert', originalInert);
  else Reflect.deleteProperty(HTMLElement.prototype, 'inert');
  vi.restoreAllMocks();
});

describe('设置页分类与编辑现场', () => {
  it('默认展示外观，分类与面板关联明确，隐藏页隔离交互和播报', async () => {
    const settings = await mountSettings();
    expect(settings.get('[role="tablist"]').attributes('aria-label')).toBe('设置分类');
    expect(settings.findAll('[role="tab"]').map((item) => item.text())).toEqual([
      '外观',
      'AI 服务',
      '数据与备份',
      '关于',
    ]);
    expect(selectedTab(settings).text()).toBe('外观');
    for (const item of settings.findAll('[role="tab"]')) {
      const panel = settings.get(`#${item.attributes('aria-controls')}`);
      const selected = item.attributes('aria-selected') === 'true';
      expect(panel.attributes('role')).toBe('tabpanel');
      expect(panel.attributes('aria-labelledby')).toBe(item.attributes('id'));
      expect(panel.attributes('aria-hidden')).toBe(String(!selected));
      expect(panel.element.hasAttribute('inert')).toBe(!selected);
      expect(panel.isVisible()).toBe(selected);
      expect(item.attributes('tabindex')).toBe(selected ? '0' : '-1');
    }
    await button(settings, '深色').trigger('click');
    expect(settings.emitted('update:theme')).toEqual([['dark']]);
    expect(settings.get('h1').text()).toBe('设置');
  });

  it('AI 引导可直接展示服务页，同一设置实例接受新的入口意图', async () => {
    const settings = await mountSettings(fixture(), 'ai');
    expect(selectedTab(settings).text()).toBe('AI 服务');
    expect(settings.get('#settings-panel-ai').isVisible()).toBe(true);
    expect(settings.get('#ai-settings-title').text()).toBe('AI 设置');
    await settings.setProps({ initialSection: 'appearance' });
    expect(selectedTab(settings).text()).toBe('外观');
    expect(settings.get('#settings-panel-ai').attributes('aria-hidden')).toBe('true');
    await settings.setProps({ initialSection: 'ai' });
    expect(selectedTab(settings).text()).toBe('AI 服务');
  });

  it('方向键循环分类并移动焦点，Home 与 End 到首尾，输入法组合不切页', async () => {
    const settings = await mountSettings();
    tab(settings, '外观').element.focus();
    const steps = [
      ['ArrowDown', 'AI 服务'],
      ['ArrowRight', '数据与备份'],
      ['End', '关于'],
      ['ArrowDown', '外观'],
      ['ArrowUp', '关于'],
      ['ArrowLeft', '数据与备份'],
      ['Home', '外观'],
    ] as const;
    for (const [key, label] of steps) {
      await selectedTab(settings).trigger('keydown', { key });
      expect(selectedTab(settings).text()).toBe(label);
      expect(document.activeElement).toBe(tab(settings, label).element);
      expect(settings.findAll('[role="tab"][tabindex="0"]')).toHaveLength(1);
    }
    await selectedTab(settings).trigger('keydown', { key: 'ArrowDown', isComposing: true });
    expect(selectedTab(settings).text()).toBe('外观');
    expect(document.activeElement).toBe(tab(settings, '外观').element);
  });

  it('切换所有分类保留同一 AI 输入节点与未保存地址、密钥', async () => {
    const settings = await mountSettings(fixture(), 'ai');
    const address = settings.get<HTMLInputElement>('#ai-base-url');
    const key = settings.get<HTMLInputElement>('#ai-key');
    await address.setValue('https://unsaved.example/v1');
    await key.setValue('test-only-unsaved-key');
    for (const label of ['关于', '外观', '数据与备份', 'AI 服务']) await choose(settings, label);
    expect(settings.get('#ai-base-url').element).toBe(address.element);
    expect(settings.get('#ai-key').element).toBe(key.element);
    expect(address.element.value).toBe('https://unsaved.example/v1');
    expect(key.element.value).toBe('test-only-unsaved-key');
    expect(button(settings, '测试连接').element.disabled).toBe(true);
  });

  it('地址保存晚到成功在隐藏页回填，返回后显示持久化结果并保留密钥草稿', async () => {
    const bridge = fixture();
    const pending = deferred<Result<AiConfiguration>>();
    vi.mocked(bridge.ai.saveBaseUrl).mockReturnValueOnce(pending.promise);
    const settings = await mountSettings(bridge, 'ai');
    const address = settings.get<HTMLInputElement>('#ai-base-url');
    await address.setValue('https://gateway.example/v1/chat/completions/');
    await settings.get('#ai-key').setValue('test-only-unsaved-key');
    await button(settings, '保存地址').trigger('click');
    expect(address.element.disabled).toBe(true);
    await choose(settings, '关于');
    expect(selectedTab(settings).text()).toBe('关于');
    pending.resolve(
      success({
        provider: 'deepseek',
        model: DEFAULT_AI_MODEL,
        baseUrl: 'https://gateway.example/v1',
      }),
    );
    await flushPromises();
    expect(selectedTab(settings).text()).toBe('关于');
    await choose(settings, 'AI 服务');
    expect(settings.get('#ai-base-url').element).toBe(address.element);
    expect(address.element.value).toBe('https://gateway.example/v1');
    expect(address.element.disabled).toBe(false);
    expect(settings.get<HTMLInputElement>('#ai-key').element.value).toBe('test-only-unsaved-key');
    expect(settings.get('#settings-panel-ai').text()).toContain('API 地址已保存');
  });

  it('密钥保存晚到失败保留输入与错误，返回后可继续重试', async () => {
    const bridge = fixture();
    const pending = deferred<Result<null>>();
    vi.mocked(bridge.ai.saveKey).mockReturnValueOnce(pending.promise);
    const settings = await mountSettings(bridge, 'ai');
    const key = settings.get<HTMLInputElement>('#ai-key');
    await key.setValue('test-only-unsaved-key');
    await button(settings, '保存密钥').trigger('click');
    await choose(settings, '外观');
    pending.resolve({
      ok: false,
      error: { code: 'AI_CREDENTIAL', message: '密钥保存失败，请重试。' },
    });
    await flushPromises();
    expect(selectedTab(settings).text()).toBe('外观');
    await choose(settings, 'AI 服务');
    expect(settings.get('#ai-key').element).toBe(key.element);
    expect(key.element.value).toBe('test-only-unsaved-key');
    expect(settings.get('#settings-panel-ai [role="alert"]').text()).toBe('密钥保存失败，请重试。');
    expect(button(settings, '保存密钥').element.disabled).toBe(false);
    expect(settings.emitted('notify')).toBeUndefined();
  });

  it('外部数据繁忙时禁止点击与键盘切页，结束后恢复分类导航', async () => {
    const settings = await mountSettings(fixture(), 'ai');
    await settings.setProps({ busy: true });
    expectTabsLocked(settings, true);
    await choose(settings, '关于');
    await selectedTab(settings).trigger('keydown', { key: 'End' });
    expect(selectedTab(settings).text()).toBe('AI 服务');
    await settings.setProps({ busy: false });
    await flushPromises();
    expectTabsLocked(settings, false);
    await choose(settings, '关于');
    expect(selectedTab(settings).text()).toBe('关于');
  });
});

describe('设置页数据操作的分类锁定', () => {
  it('备份进行中锁定分类，失败后留在数据页显示错误并解锁', async () => {
    const bridge = fixture();
    const pending = deferred<Result<BackupSummary>>();
    vi.mocked(bridge.backupLibrary).mockReturnValueOnce(pending.promise);
    const settings = await mountSettings(bridge);
    await choose(settings, '数据与备份');
    await button(settings, '选择位置并备份').trigger('click');
    expectTabsLocked(settings, true);
    expect(settings.get('#settings-panel-data [role="status"]').text()).toContain('正在备份');
    await choose(settings, 'AI 服务');
    await selectedTab(settings).trigger('keydown', { key: 'Home' });
    expect(selectedTab(settings).text()).toBe('数据与备份');
    pending.resolve({ ok: false, error: { code: 'STORAGE', message: '备份没有完成，请重试。' } });
    await flushPromises();
    expectTabsLocked(settings, false);
    expect(settings.get('#settings-panel-data [role="alert"]').text()).toBe(
      '备份没有完成，请重试。',
    );
    expect(settings.emitted('notify')).toBeUndefined();
    await choose(settings, 'AI 服务');
    expect(selectedTab(settings).text()).toBe('AI 服务');
  });

  it('导出进行中锁定分类，成功后发出真实通知并解锁', async () => {
    const bridge = fixture();
    const pending = deferred<Result<ExportSummary>>();
    vi.mocked(bridge.exportLibrary).mockReturnValueOnce(pending.promise);
    const settings = await mountSettings(bridge);
    await choose(settings, '数据与备份');
    await button(settings, '导出…').trigger('click');
    expectTabsLocked(settings, true);
    expect(settings.get('#settings-panel-data [role="status"]').text()).toContain('正在导出');
    pending.resolve(
      success({ notes: 3, topics: 1, threads: 2, entries: 4, destination: 'test-export' }),
    );
    await flushPromises();
    expectTabsLocked(settings, false);
    expect(settings.emitted('notify')).toEqual([[{ message: '已导出 3 条手记、2 个事务' }]]);
    await choose(settings, '关于');
    expect(selectedTab(settings).text()).toBe('关于');
  });

  it('备份校验与恢复确认期间锁定分类，取消确认后解锁且不应用恢复', async () => {
    const bridge = fixture();
    const pending = deferred<Result<StagedRestore>>();
    vi.mocked(bridge.restoreLibrary).mockReturnValueOnce(pending.promise);
    const settings = await mountSettings(bridge);
    await choose(settings, '数据与备份');
    await button(settings, '选择备份并校验…').trigger('click');
    expectTabsLocked(settings, true);
    expect(settings.get('#settings-panel-data [role="status"]').text()).toContain('正在校验备份');
    pending.resolve(
      success({
        attachments: 2,
        databaseBytes: 4096,
        counts: { notes: 3, topics: 1, threads: 1, entries: 2 },
      }),
    );
    await flushPromises();
    const confirmation = document.querySelector('[role="dialog"][aria-label="从备份恢复"]');
    if (!(confirmation instanceof HTMLElement)) throw new Error('恢复确认对话框未显示');
    expectTabsLocked(settings, true);
    await selectedTab(settings).trigger('keydown', { key: 'End' });
    expect(selectedTab(settings).text()).toBe('数据与备份');
    const cancel = Array.from(confirmation.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === '取消',
    );
    if (!(cancel instanceof HTMLButtonElement)) throw new Error('恢复确认未提供取消按钮');
    cancel.click();
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectTabsLocked(settings, false);
    expect(bridge.applyRestore).not.toHaveBeenCalled();
    expect(settings.emitted('data-replaced')).toBeUndefined();
    await choose(settings, '关于');
    expect(selectedTab(settings).text()).toBe('关于');
  });
});
