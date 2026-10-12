// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SettingsPage from '../../src/renderer/src/pages/SettingsPage.vue';
import { disconnectedApi } from '../../src/renderer/src/api/bridge';
import { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL } from '../../src/shared/ai';
import type { MemocraftApi } from '../../src/shared/contracts';
import type { Result } from '../../src/shared/errors';

function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

/** 延迟真实组件收到桥接应答，在恢复窗口内观察 Escape 与完成事件。 */
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('延迟桥接请求尚未初始化');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture() {
  const pending = deferred<Result<null>>();
  const applyRestore = vi.fn(() => pending.promise);
  const restoreLibrary = vi.fn(async () =>
    success({
      attachments: 2,
      databaseBytes: 4096,
      counts: { notes: 3, topics: 1, threads: 1, entries: 2 },
    }),
  );
  const bridge: MemocraftApi = {
    ...disconnectedApi,
    ai: {
      ...disconnectedApi.ai,
      loadSettings: vi.fn(async () =>
        success({
          provider: 'deepseek' as const,
          model: DEFAULT_AI_MODEL,
          baseUrl: DEFAULT_AI_BASE_URL,
          keyConfigured: false,
          encryptionAvailable: true,
        }),
      ),
    },
    restoreLibrary,
    applyRestore,
  };
  return { bridge, pending, restoreLibrary, applyRestore };
}

let wrapper: VueWrapper | undefined;
let host: HTMLElement | undefined;

async function mountSettings(bridge: MemocraftApi): Promise<VueWrapper> {
  host = document.createElement('div');
  document.body.append(host);
  wrapper = mount(SettingsPage, {
    attachTo: host,
    props: { theme: 'light', bridge, busy: false },
  });
  await flushPromises();
  // 恢复操作在二级「数据与备份」页执行，不绕过隐藏页直接点业务按钮。
  await click(wrapper.element, '数据与备份');
  return wrapper;
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const target = Array.from(root.querySelectorAll('button')).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!(target instanceof HTMLButtonElement)) throw new Error(`未找到测试按钮：${label}`);
  return target;
}

function dialog(): HTMLElement {
  const target = document.querySelector('[role="dialog"][aria-label="从备份恢复"]');
  if (!(target instanceof HTMLElement)) throw new Error('恢复确认对话框未显示');
  return target;
}

async function click(root: ParentNode, label: string): Promise<void> {
  button(root, label).click();
  await flushPromises();
}

function expectTabsLocked(settings: VueWrapper, locked: boolean): void {
  for (const tab of settings.findAll<HTMLButtonElement>('[role="tab"]'))
    expect(tab.element.disabled).toBe(locked);
}

async function escape(): Promise<void> {
  // 不替身 AppDialog：由它真正监听 document 的 Escape 并向设置页发出 close。
  document.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    }),
  );
  await flushPromises();
}

afterEach(async () => {
  wrapper?.unmount();
  wrapper = undefined;
  await flushPromises();
  host?.remove();
  host = undefined;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('设置页恢复对话框的取消边界', () => {
  it('开始恢复前 Escape 与取消按钮都可关闭确认框，不应用恢复', async () => {
    const f = fixture();
    const settings = await mountSettings(f.bridge);
    await click(settings.element, '选择备份并校验…');
    expect(dialog().textContent).toContain('手记 3 · 归纳 1 · 事务 1 · 动态 2');
    expectTabsLocked(settings, true);
    await escape();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectTabsLocked(settings, false);
    expect(f.applyRestore).not.toHaveBeenCalled();
    expect(settings.emitted('data-replaced')).toBeUndefined();
    expect(settings.emitted('notify')).toBeUndefined();

    await click(settings.element, '选择备份并校验…');
    await click(dialog(), '取消');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expectTabsLocked(settings, false);
    expect(f.restoreLibrary).toHaveBeenCalledTimes(2);
    expect(f.applyRestore).not.toHaveBeenCalled();
  });

  it('恢复中 Escape 不关闭确认框，完成后发送一次整库替换与成功通知', async () => {
    const f = fixture();
    const settings = await mountSettings(f.bridge);
    await click(settings.element, '选择备份并校验…');
    const confirmation = dialog();
    await click(confirmation, '开始恢复');
    expect(button(confirmation, '取消').disabled).toBe(true);
    expect(button(confirmation, '开始恢复').disabled).toBe(true);
    expect(button(settings.element, '选择备份并校验…').disabled).toBe(true);
    expectTabsLocked(settings, true);
    expect(settings.get('[role="status"]').text()).toContain('正在恢复');
    await escape();
    await escape();
    expect(dialog()).toBe(confirmation);
    expect(confirmation.isConnected).toBe(true);
    expect(f.applyRestore).toHaveBeenCalledTimes(1);
    expect(settings.emitted('data-replaced')).toBeUndefined();
    expect(settings.emitted('notify')).toBeUndefined();

    f.pending.resolve(success(null));
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(settings.find('[role="status"]').exists()).toBe(false);
    expect(settings.find('.data-error').exists()).toBe(false);
    expect(button(settings.element, '选择备份并校验…').disabled).toBe(false);
    expectTabsLocked(settings, false);
    expect(settings.emitted('data-replaced')).toEqual([[]]);
    expect(settings.emitted('notify')).toEqual([[{ message: '恢复完成，已重新打开数据' }]]);
    expect(settings.get('h1').text()).toBe('设置');
  });

  it('恢复失败保留设置页并显示明确错误，不发送整库替换或成功通知', async () => {
    const f = fixture();
    const settings = await mountSettings(f.bridge);
    await click(settings.element, '选择备份并校验…');
    await click(dialog(), '开始恢复');
    await escape();
    expect(dialog().isConnected).toBe(true);
    expectTabsLocked(settings, true);
    f.pending.resolve({
      ok: false,
      error: { code: 'STORAGE', message: '恢复后的数据无法打开，已回滚到恢复前的数据。' },
    });
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(settings.get('h1').text()).toBe('设置');
    expect(settings.element.isConnected).toBe(true);
    expect(settings.get('.data-error[role="alert"]').text()).toBe(
      '恢复后的数据无法打开，已回滚到恢复前的数据。',
    );
    expect(button(settings.element, '选择备份并校验…').disabled).toBe(false);
    expectTabsLocked(settings, false);
    expect(settings.find('[role="status"]').exists()).toBe(false);
    expect(settings.emitted('data-replaced')).toBeUndefined();
    expect(settings.emitted('notify')).toBeUndefined();
  });
});
