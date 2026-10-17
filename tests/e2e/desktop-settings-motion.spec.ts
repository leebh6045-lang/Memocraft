import { waitForMainWindow } from './main-window';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { DEFAULT_AI_MODEL } from '../../src/shared/ai';

type SettingsSection = 'appearance' | 'ai' | 'data' | 'about';
const sections: Record<SettingsSection, string> = {
  appearance: '外观',
  ai: 'AI 服务',
  data: '数据与备份',
  about: '关于',
};
// 仅用于临时目录验收；供应商请求都由主进程 HTTP 替身处理，不使用真实凭据。
const testKey = 'test-only-desktop-settings-motion-key';
const officialBaseUrl = 'https://api.deepseek.com';

interface NetworkState {
  requests: Array<{ aborted: boolean }>;
  finish?: () => void;
}
type SettingsGlobals = typeof globalThis & { memocraftSettingsMotion?: NetworkState };

interface ShellControl {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SettingsFrame {
  elapsed: number;
  selected: string;
  thumbY: number;
  tabY: number;
  opacity: number;
  translateY: number;
  exposed: string[];
  inactiveInert: boolean;
  inactiveHidden: boolean;
  animating: boolean;
}

function launch(dataDirectory: string, shellDirectory: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: process.env.MEMOCRAFT_TEST_APP,
    args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
    env: {
      ...process.env,
      MEMOCRAFT_DATA_DIR: dataDirectory,
      MEMOCRAFT_USER_DATA_DIR: shellDirectory,
    },
  });
}

async function quit(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close');
  // 正常关闭会排空设置和数据库写入，不强行终止 Electron。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}

/** 只替换供应商 HTTP；设置页、preload、IPC、加密与取消链路保持真实。 */
async function mockConnection(app: ElectronApplication, held = false): Promise<void> {
  await app.evaluate(
    ({ net }, input) => {
      const state: NetworkState = { requests: [] };
      (globalThis as SettingsGlobals).memocraftSettingsMotion = state;
      net.fetch = async (url, request) => {
        const value: unknown = typeof request?.body === 'string' ? JSON.parse(request.body) : null;
        const body = value as {
          model?: unknown;
          messages?: Array<{ role?: unknown; content?: unknown }>;
        } | null;
        if (
          String(url) !== `${input.baseUrl}/chat/completions` ||
          request?.method !== 'POST' ||
          body?.model !== input.model ||
          body.messages?.length !== 1 ||
          body.messages[0]?.role !== 'user' ||
          body.messages[0]?.content !== 'Reply with OK.' ||
          new Headers(request.headers).get('Authorization') !== `Bearer ${input.key}`
        )
          throw new Error('设置分类桌面验收禁止访问其他地址或发送其他内容');
        const captured = { aborted: false };
        state.requests.push(captured);
        const response = () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (!input.held) return response();
        // 故意忽略 abort 后仍返回成功，证明切走后的旧结果不能重新点亮 AI 页。
        return new Promise<Response>((resolveResponse) => {
          state.finish = () => {
            state.finish = undefined;
            resolveResponse(response());
          };
          const abort = () => {
            captured.aborted = true;
          };
          if (request.signal?.aborted) abort();
          else request.signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    { held, baseUrl: officialBaseUrl, model: DEFAULT_AI_MODEL, key: testKey },
  );
}

function networkState(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as SettingsGlobals).memocraftSettingsMotion?.requests);
}

async function seedKey(page: Page): Promise<void> {
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
    ok: true,
    value: null,
  });
}

function category(page: Page, section: SettingsSection) {
  return page.getByRole('tablist', { name: '设置分类', exact: true }).getByRole('tab', {
    name: sections[section],
    exact: true,
  });
}

async function selectCategory(page: Page, section: SettingsSection): Promise<void> {
  await category(page, section).click();
  await expect(category(page, section)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`#settings-panel-${section}`)).toBeVisible();
}

async function openSettings(page: Page): Promise<void> {
  await page.locator('.corner').getByRole('button', { name: /设置/ }).click();
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(category(page, 'appearance')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#settings-panel-appearance')).toBeVisible();
}

/** 比较外壳真实控件的文案与几何位置，防止设置二级菜单替换原来一级导航。 */
function shellControls(page: Page): Promise<ShellControl[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.nav .nav-item, .corner .corner-btn')).map(
      (element) => {
        const rectangle = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute('aria-label') ??
            element.querySelector('.label')?.textContent?.trim() ??
            '',
          left: rectangle.left,
          top: rectangle.top,
          width: rectangle.width,
          height: rectangle.height,
        };
      },
    ),
  );
}

function expectShellUnchanged(before: ShellControl[], after: ShellControl[]): void {
  expect(after.map((control) => control.label)).toEqual(before.map((control) => control.label));
  for (const [index, control] of after.entries()) {
    const original = before[index];
    if (!original) throw new Error('缺少一级导航原始位置');
    for (const field of ['left', 'top', 'width', 'height'] as const)
      expect(
        Math.abs(control[field] - original[field]),
        `${control.label} 的 ${field}`,
      ).toBeLessThan(0.5);
  }
}

/** click 和 rAF 采样在同一渲染任务启动，保留滑块和新页面真实中间帧。 */
function observeMotion(
  page: Page,
  actions: SettingsSection[],
  duration = 900,
  spacing = 0,
): Promise<SettingsFrame[]> {
  return page.evaluate(
    async (input) => {
      const track = document.querySelector('[role="tablist"][aria-label="设置分类"]');
      const thumb = document.querySelector('.settings-tab-thumb');
      if (!(track instanceof HTMLElement) || !(thumb instanceof HTMLElement))
        throw new Error('设置分类滑块不存在');
      const nextFrame = () =>
        new Promise<number>((resolveFrame) => requestAnimationFrame(resolveFrame));
      const start = performance.now();
      const snapshot = (time: number): SettingsFrame => {
        const selected = track.querySelector('[role="tab"][aria-selected="true"]');
        if (!(selected instanceof HTMLElement)) throw new Error('当前设置分类不存在');
        const id = selected.getAttribute('aria-controls');
        const panel = id ? document.getElementById(id) : null;
        if (!(panel instanceof HTMLElement)) throw new Error('当前设置分类未关联内容');
        const panes = Array.from(document.querySelectorAll<HTMLElement>('.settings-subpage'));
        const inactive = panes.filter((pane) => pane !== panel);
        const trackRect = track.getBoundingClientRect();
        const style = getComputedStyle(panel);
        return {
          elapsed: time - start,
          selected: panel.id,
          thumbY: thumb.getBoundingClientRect().top - trackRect.top,
          tabY: selected.getBoundingClientRect().top - trackRect.top,
          opacity: Number.parseFloat(style.opacity),
          translateY: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m42,
          exposed: panes
            .filter((pane) => !pane.closest('[inert], [aria-hidden="true"]'))
            .map((pane) => pane.id),
          inactiveInert: inactive.every((pane) => pane.hasAttribute('inert')),
          inactiveHidden: inactive.every((pane) => pane.getAttribute('aria-hidden') === 'true'),
          animating:
            thumb.getAnimations().some((animation) => animation.playState === 'running') ||
            panel.getAnimations().some((animation) => animation.playState === 'running'),
        };
      };
      const frames = [snapshot(start)];
      let previousAction = start;
      for (const [index, name] of input.actions.entries()) {
        if (index > 0)
          while (performance.now() - previousAction < input.spacing)
            frames.push(snapshot(await nextFrame()));
        const tab = Array.from(track.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
          (element) => element.textContent?.trim() === input.labels[name],
        );
        if (!tab || tab.disabled) throw new Error(`设置分类不可用：${name}`);
        previousAction = performance.now();
        tab.click();
        frames.push(snapshot(await nextFrame()));
      }
      while (performance.now() - start < input.duration) frames.push(snapshot(await nextFrame()));
      return frames;
    },
    { actions, duration, spacing, labels: sections },
  );
}

function finalFrame(frames: SettingsFrame[]): SettingsFrame {
  const last = frames.at(-1);
  if (!last) throw new Error('设置动效未产生采样帧');
  return last;
}

function expectExclusivePanes(frames: SettingsFrame[]): void {
  for (const frame of frames) {
    expect(frame.exposed).toEqual([frame.selected]);
    expect(frame.inactiveInert).toBe(true);
    expect(frame.inactiveHidden).toBe(true);
  }
}

function expectSettled(frame: SettingsFrame, section: SettingsSection): void {
  expect(frame.selected).toBe(`settings-panel-${section}`);
  expect(frame.opacity).toBe(1);
  expect(frame.translateY).toBe(0);
  expect(frame.animating).toBe(false);
  expect(Math.abs(frame.thumbY - frame.tabY)).toBeLessThan(2);
}

/** 真实数值必须连续变化；CSS 声明存在不代表动效实际运行。 */
function expectSmoothMotion(frames: SettingsFrame[], section: SettingsSection): void {
  const first = frames[0];
  if (!first) throw new Error('设置动效缺少初始帧');
  const last = finalFrame(frames);
  const distance = Math.abs(last.thumbY - first.thumbY);
  expect(distance).toBeGreaterThan(40);
  const low = Math.min(first.thumbY, last.thumbY);
  const high = Math.max(first.thumbY, last.thumbY);
  const intermediate = frames.filter(
    (frame) => frame.thumbY > low + distance * 0.05 && frame.thumbY < high - distance * 0.05,
  );
  expect(
    new Set(intermediate.map((frame) => Math.round(frame.thumbY * 10))).size,
  ).toBeGreaterThanOrEqual(3);
  const entering = frames.filter(
    (frame) =>
      frame.selected === `settings-panel-${section}` &&
      frame.opacity > 0.05 &&
      frame.opacity < 0.95,
  );
  expect(
    new Set(entering.map((frame) => Math.round(frame.opacity * 100))).size,
  ).toBeGreaterThanOrEqual(3);
  expect(entering.some((frame) => frame.translateY > 0.2 && frame.translateY < 8)).toBe(true);
  for (const [index, frame] of frames.entries()) {
    expect(frame.thumbY).toBeGreaterThanOrEqual(low - 1);
    expect(frame.thumbY).toBeLessThanOrEqual(high + 1);
    const previous = frames[index - 1];
    // 忙碌执行机漏帧不能当作布局瞬跳，只比较足够短的连续实际帧。
    if (previous && frame.elapsed - previous.elapsed < 45)
      expect(Math.abs(frame.thumbY - previous.thumbY)).toBeLessThan(distance * 0.55 + 2);
  }
  expectExclusivePanes(frames);
  expectSettled(last, section);
}

test('真实桌面：设置分类丝滑切换、草稿和滚动保留、一级控件原位、键盘与深浅主题', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-settings-motion-'));
  const shellDirectory = join(root, 'shell');
  const artifacts = join(process.cwd(), 'test-results', 'settings-motion-artifacts');
  await mkdir(artifacts, { recursive: true });
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(join(root, 'data'), shellDirectory);
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
    const page = await waitForMainWindow(app);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedKey(page);
    // 等真实窗口创建完再调整尺寸，避免启动早期的可选调用被跳过而仍测试默认大窗。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1000, 700]);
    await mockConnection(app);
    const originalShell = await shellControls(page);
    expect(originalShell.map((control) => control.label)).toEqual([
      '首页',
      '手记',
      '主题归纳',
      '长期事务',
      '回顾',
      '搜索',
      '专注模式',
      '深色',
      '回收站（当前 0 项）',
      expect.stringContaining('设置'),
    ]);
    await openSettings(page);
    expectShellUnchanged(originalShell, await shellControls(page));
    await expect(page.getByRole('tablist', { name: '设置分类' }).getByRole('tab')).toHaveCount(4);
    await expect(
      page.getByRole('heading', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ }),
    ).not.toBeVisible();
    await observeMotion(page, []);

    const toAi = await observeMotion(page, ['ai']);
    expectSmoothMotion(toAi, 'ai');
    const panel = page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
    const address = panel.locator('#ai-base-url');
    const key = panel.locator('#ai-key');
    await expect(address).toHaveValue(officialBaseUrl);
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
    await address.fill('https://draft.example.invalid/v1');
    await key.fill('unsaved-only-settings-key');
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();

    // 最小桌面尺寸使用真实滚轮，将底部连接与隐私控件滚入可见范围。
    const scroll = page.locator('#settings-panel-ai .settings-pane-scroll');
    await scroll.hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeInViewport();
    await expect(panel.locator('.privacy-note')).toBeInViewport();
    const aiScroll = await scroll.evaluate((element) => element.scrollTop);
    const toData = await observeMotion(page, ['data']);
    expectSmoothMotion(toData, 'data');
    await expect(page.getByRole('button', { name: '选择位置并备份', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '选择备份并校验…', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '导出…', exact: true })).toBeVisible();
    expectShellUnchanged(originalShell, await shellControls(page));
    await selectCategory(page, 'ai');
    await expect(address).toHaveValue('https://draft.example.invalid/v1');
    await expect(key).toHaveValue('unsaved-only-settings-key');
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(aiScroll);
    expect(await page.evaluate(() => window.memocraft?.ai.loadSettings())).toMatchObject({
      ok: true,
      value: { baseUrl: officialBaseUrl, keyConfigured: true },
    });
    expect(await networkState(app)).toEqual([]);

    const rapid = await observeMotion(page, ['about', 'appearance', 'data', 'ai'], 1200, 70);
    expectExclusivePanes(rapid);
    expectSettled(finalFrame(rapid), 'ai');
    await expect(address).toHaveValue('https://draft.example.invalid/v1');
    await expect(key).toHaveValue('unsaved-only-settings-key');

    // 二级标签遵循同一键盘模型，焦点和选中同步；隐藏页面不能进入 Tab 焦点序列。
    await category(page, 'ai').focus();
    await page.keyboard.press('ArrowDown');
    await expect(category(page, 'data')).toBeFocused();
    await expect(category(page, 'data')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(category(page, 'about')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(category(page, 'appearance')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(category(page, 'about')).toBeFocused();
    await page.keyboard.press('Tab');
    expect(
      await page.evaluate(() => !document.activeElement?.closest('[inert], [aria-hidden="true"]')),
    ).toBe(true);

    await selectCategory(page, 'appearance');
    const theme = page.getByRole('radiogroup', { name: '主题', exact: true });
    await theme.getByRole('radio', { name: '浅色', exact: true }).click();
    await selectCategory(page, 'ai');
    await observeMotion(page, []);
    await page.screenshot({ path: join(artifacts, 'settings-ai-light-1000x700.png') });
    await selectCategory(page, 'appearance');
    await theme.getByRole('radio', { name: '深色', exact: true }).click();
    await selectCategory(page, 'ai');
    await observeMotion(page, []);
    await page.screenshot({ path: join(artifacts, 'settings-ai-dark-1000x700.png') });
    expect(
      await page.evaluate(() => {
        const active = document.querySelector('.settings-subpage:not([inert])');
        const scroll = active?.querySelector('.settings-pane-scroll');
        return (
          document.documentElement.scrollWidth <= window.innerWidth &&
          scroll instanceof HTMLElement &&
          scroll.scrollWidth <= scroll.clientWidth &&
          scroll.getBoundingClientRect().bottom <= window.innerHeight
        );
      }),
    ).toBe(true);
    await selectCategory(page, 'appearance');
    await theme.getByRole('radio', { name: '浅色', exact: true }).click();
    expectShellUnchanged(originalShell, await shellControls(page));
    await page.getByRole('button', { name: /^首页/ }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    expectShellUnchanged(originalShell, await shellControls(page));
    await writeFile(
      join(artifacts, 'settings-motion-frames.json'),
      JSON.stringify({ toAi, toData, rapid }, null, 2),
    );
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：切出 AI 分类取消连接测试、迟到不回写、减少动态立即清晰', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-settings-reduced-motion-'));
  const shellDirectory = join(root, 'shell');
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(join(root, 'data'), shellDirectory);
    const currentApp = app;
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
    const page = await waitForMainWindow(app);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedKey(page);
    await mockConnection(app, true);
    await openSettings(page);
    await selectCategory(page, 'ai');
    const panel = page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect.poll(async () => (await networkState(currentApp))?.length).toBe(1);
    await expect(panel.getByRole('button', { name: '取消测试', exact: true })).toBeVisible();
    const cancelled = await observeMotion(page, ['data']);
    expectExclusivePanes(cancelled);
    expectSettled(finalFrame(cancelled), 'data');
    await expect.poll(async () => (await networkState(currentApp))?.[0]?.aborted).toBe(true);
    await expect(panel.getByRole('button', { name: '取消测试', exact: true })).not.toBeVisible();
    await app.evaluate(() => (globalThis as SettingsGlobals).memocraftSettingsMotion?.finish?.());
    await selectCategory(page, 'ai');
    await observeMotion(page, []);
    await expect(panel).not.toContainText('连接成功');
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();

    // 动效中途开启减少动态，当前分类仍正确显示，不能停留在透明或偏移状态。
    await category(page, 'about').click();
    await page.waitForFunction(() => {
      const panel = document.getElementById('settings-panel-about');
      if (!panel) return false;
      const opacity = Number.parseFloat(getComputedStyle(panel).opacity);
      return opacity > 0.05 && opacity < 0.95;
    });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const interrupted = await observeMotion(page, [], 180);
    expectExclusivePanes(interrupted);
    expectSettled(finalFrame(interrupted), 'about');

    const reduced = await observeMotion(page, ['appearance', 'ai', 'data', 'about'], 350, 50);
    expectExclusivePanes(reduced);
    for (const frame of reduced) {
      expect(frame.opacity).toBe(1);
      expect(frame.translateY).toBe(0);
      expect(frame.animating).toBe(false);
      expect(Math.abs(frame.thumbY - frame.tabY)).toBeLessThan(2);
    }
    expectSettled(finalFrame(reduced), 'about');
    await expect(page.locator('.settings-subpage')).toHaveCount(4);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
