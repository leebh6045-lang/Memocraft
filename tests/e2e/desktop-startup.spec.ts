import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { waitForMainWindow } from './main-window';

type WindowProbe = { created: number[] };
type ProbeGlobals = typeof globalThis & { memocraftStartupProbe?: WindowProbe };

type EntrancePart = { part: string; opacity: number; transform: string; animations: number };
type EntranceFrame = { elapsed: number; parts: EntrancePart[] };
type EntranceNativeState = { mainVisible: boolean; cardExists: boolean };
type EntranceProbe = {
  states: Array<string | null>;
  frames: EntranceFrame[];
  nativeAtEntrance?: EntranceNativeState;
  nativeError?: string;
};
type EntranceGlobals = typeof globalThis & {
  memocraftEntranceProbe?: EntranceProbe;
  startupNativeState?: () => Promise<EntranceNativeState>;
};

/** 在卡片显示期间安装观察器，记录真实中间帧，不依靠自动化恰好赶上短动画。 */
function installEntranceProbe(): void {
  if (new URL(location.href).searchParams.has('startup')) return;
  const scope = globalThis as EntranceGlobals;
  if (scope.memocraftEntranceProbe) return;
  const probe: EntranceProbe = { states: [], frames: [] };
  scope.memocraftEntranceProbe = probe;
  let previous: string | null | undefined;
  let started = 0;
  const sample = () => {
    probe.frames.push({
      elapsed: performance.now() - started,
      parts: Array.from(document.querySelectorAll('[data-startup-part]')).map((element) => {
        const style = getComputedStyle(element);
        return {
          part: element.getAttribute('data-startup-part') ?? '',
          opacity: Number(style.opacity),
          transform: style.transform,
          animations: element.getAnimations().length,
        };
      }),
    });
    if (document.documentElement?.dataset.startupEntrance === 'entering') {
      requestAnimationFrame(sample);
    }
  };
  const observeState = () => {
    if (!document.documentElement) return;
    const state = document.documentElement.getAttribute('data-startup-entrance');
    if (state === previous) return;
    previous = state;
    probe.states.push(state);
    if (state !== 'entering') return;
    started = performance.now();
    if (scope.startupNativeState) {
      void scope.startupNativeState().then(
        (value) => (probe.nativeAtEntrance = value),
        (error: unknown) => (probe.nativeError = String(error)),
      );
    }
    sample();
  };
  new MutationObserver(observeState).observe(document, {
    attributes: true,
    attributeFilter: ['data-startup-entrance'],
    childList: true,
    subtree: true,
  });
  observeState();
}

async function prepareEntranceProbe(
  app: ElectronApplication,
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference',
): Promise<Page> {
  const current = app;
  await app.context().exposeBinding('startupNativeState', async () =>
    current.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const main = windows.find(
        (window) => !new URL(window.webContents.getURL()).searchParams.has('startup'),
      );
      return {
        mainVisible: main?.isVisible() ?? false,
        cardExists: windows.some((window) =>
          new URL(window.webContents.getURL()).searchParams.has('startup'),
        ),
      };
    }),
  );
  await app.context().addInitScript(installEntranceProbe);
  let main: Page | undefined;
  await expect
    .poll(
      () => {
        main = app.windows().find((page) => {
          if (page.isClosed() || !page.url() || page.url() === 'about:blank') return false;
          return !new URL(page.url()).searchParams.has('startup');
        });
        return Boolean(main);
      },
      { intervals: [10, 20, 50] },
    )
    .toBe(true);
  if (!main) throw new Error('未捕获到隐藏的主窗口。');
  await main.evaluate(installEntranceProbe);
  await main.emulateMedia({ reducedMotion });
  const nativeMain = await app.browserWindow(main);
  expect(await nativeMain.evaluate((window) => window.isVisible())).toBe(false);
  await nativeMain.dispose();
  if (reducedMotion === 'no-preference') {
    await expect(main.locator('html')).toHaveAttribute('data-startup-entrance', 'pending');
  }
  return main;
}

async function entranceProbe(page: Page): Promise<EntranceProbe> {
  return page.evaluate(() => {
    const probe = (globalThis as EntranceGlobals).memocraftEntranceProbe;
    if (!probe) throw new Error('启动入场观察器未安装。');
    return probe;
  });
}

function launch(directory: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: process.env.MEMOCRAFT_TEST_APP,
    args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
    // Playwright 默认模拟浅色；此专项保留系统媒体值，才能验证 Electron 的主题来源。
    colorScheme: null,
    env: {
      ...process.env,
      MEMOCRAFT_DATA_DIR: join(directory, 'data'),
      MEMOCRAFT_USER_DATA_DIR: join(directory, 'shell'),
    },
  });
}

async function quit(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) => !new URL(window.webContents.getURL()).searchParams.has('startup'),
    );
    if (!main) throw new Error('主窗口不存在。');
    main.close();
  });
  await closed;
}

/** 原生窗口的显示与 DOM 可见分别检查，防止后台已渲染被误认为用户已看到主界面。 */
async function expectStartupCard(app: ElectronApplication, theme: 'light' | 'dark'): Promise<Page> {
  let card: Page | undefined;
  // 两个渲染进程的调试连接先后不固定，不能用 firstWindow 推断原生窗口创建顺序。
  await expect
    .poll(
      () => {
        card = app.windows().find((page) => {
          if (page.isClosed() || !page.url() || page.url() === 'about:blank') return false;
          return new URL(page.url()).searchParams.get('startup') === '1';
        });
        return Boolean(card);
      },
      { intervals: [10, 20, 50, 100] },
    )
    .toBe(true);
  if (!card) throw new Error('未捕获到独立启动卡片。');
  await expect(card.locator('.startup-card')).toBeVisible();
  await expect(card.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(card.getByText('正在打开...', { exact: true })).toBeVisible();
  expect(
    await card.evaluate(() => ({
      hasLibraryAccess: Boolean(window.memocraft),
      hasLifecycleAccess: typeof window.memocraftWindow?.ready === 'function',
    })),
  ).toEqual({ hasLibraryAccess: false, hasLifecycleAccess: true });
  const nativeCard = await app.browserWindow(card);
  await expect.poll(() => nativeCard.evaluate((window) => window.isVisible())).toBe(true);
  expect(await nativeCard.evaluate((window) => window.getSize())).toEqual([530, 328]);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((window) => window.isVisible())
        .map((window) => new URL(window.webContents.getURL()).searchParams.get('startup')),
    ),
  ).toEqual(['1']);
  await nativeCard.dispose();
  return card;
}

async function expectHandoff(app: ElectronApplication, card: Page): Promise<Page> {
  const main = await waitForMainWindow(app);
  await expect.poll(() => card.isClosed()).toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await expect(main.getByRole('textbox', { name: '手记正文', exact: true })).toBeEditable();
  return main;
}

test('真实桌面：独立启动卡片、浅深主题记忆与跟随系统', async () => {
  test.setTimeout(90_000);
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-startup-theme-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(directory);
    const lightCard = await expectStartupCard(app, 'light');
    let main = await expectHandoff(app, lightCard);
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(join(directory, 'shell'));
    await main.getByRole('button', { name: '深色', exact: true }).click();
    await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
    await quit(app);
    app = undefined;

    app = await launch(directory);
    const darkCard = await expectStartupCard(app, 'dark');
    main = await expectHandoff(app, darkCard);
    await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
    await main.locator('.corner').getByRole('button', { name: /设置/ }).click();
    await main.getByRole('tab', { name: '外观', exact: true }).click();
    await main
      .getByRole('radiogroup', { name: '主题', exact: true })
      .getByRole('radio', { name: '跟随系统', exact: true })
      .click();
    // 原生主题源只改当前隔离进程，既验证系统跟随，也不改用户的 macOS 外观。
    for (const theme of ['dark', 'light'] as const) {
      await app.evaluate(({ nativeTheme }, source) => {
        nativeTheme.themeSource = source;
      }, theme);
      await expect(main.locator('html')).toHaveAttribute('data-theme', theme);
    }
    await quit(app);
    app = undefined;

    app = await launch(directory);
    const systemTheme = await app.evaluate(({ nativeTheme }) =>
      nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    );
    const systemCard = await expectStartupCard(app, systemTheme);
    main = await expectHandoff(app, systemCard);
    await expect(main.locator('html')).toHaveAttribute('data-theme', systemTheme);
    await quit(app);
    app = undefined;
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实桌面：最小化召回、激活和第二实例都不重播启动卡片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-startup-resume-'));
  let app: ElectronApplication | undefined;
  let second: ChildProcess | undefined;
  try {
    app = await launch(directory);
    const main = await waitForMainWindow(app);
    const currentApp = app;
    const mainWindow = await app.browserWindow(main);
    await app.evaluate(({ app }) => {
      const probe: WindowProbe = { created: [] };
      (globalThis as ProbeGlobals).memocraftStartupProbe = probe;
      app.on('browser-window-created', (_event, window) => probe.created.push(window.id));
    });

    await mainWindow.evaluate((window) => window.minimize());
    await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(true);
    await mainWindow.evaluate((window) => window.restore());
    await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(false);
    await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(true);

    await mainWindow.evaluate((window) => window.hide());
    await app.evaluate(({ app }) => app.emit('activate'));
    await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(true);

    await mainWindow.evaluate((window) => window.minimize());
    await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(true);
    // 第二个真实进程复用隔离配置，检查单实例锁，而非仅手动发送 second-instance 事件。
    second = spawn(app.process().spawnfile, process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')], {
      env: {
        ...process.env,
        MEMOCRAFT_DATA_DIR: join(directory, 'data'),
        MEMOCRAFT_USER_DATA_DIR: join(directory, 'shell'),
      },
      stdio: 'ignore',
    });
    const secondProcess = second;
    let spawnError: Error | undefined;
    second.on('error', (error) => {
      spawnError = error;
    });
    await expect.poll(() => secondProcess.exitCode).toBe(0);
    expect(spawnError).toBeUndefined();
    await expect.poll(() => mainWindow.evaluate((window) => window.isMinimized())).toBe(false);
    await expect.poll(() => mainWindow.evaluate((window) => window.isVisible())).toBe(true);
    expect(
      await currentApp.evaluate(() => (globalThis as ProbeGlobals).memocraftStartupProbe?.created),
    ).toEqual([]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    await expect(main.getByRole('textbox', { name: '手记正文', exact: true })).toBeEditable();
    await mainWindow.dispose();
    await quit(app);
    app = undefined;
  } finally {
    if (second && second.exitCode === null) second.kill();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实桌面：卡片交接后主页面分层显现，恢复、导航、主题与重载都不重播', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-startup-entrance-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(directory);
    const main = await prepareEntranceProbe(app);
    const errors: string[] = [];
    main.on('pageerror', (error) => errors.push(error.message));
    await expect(main.locator('[data-startup-part="shell"]')).toHaveCSS('opacity', '0');
    await waitForMainWindow(app);
    await expect(main.locator('html')).not.toHaveAttribute('data-startup-entrance');
    await expect
      .poll(async () => (await entranceProbe(main)).nativeAtEntrance)
      .toEqual({
        mainVisible: true,
        cardExists: false,
      });
    const initial = await entranceProbe(main);
    expect(initial.nativeError).toBeUndefined();
    expect(initial.states).toEqual(expect.arrayContaining(['pending', 'entering', null]));
    const hasMiddleFrame = (part: string) =>
      initial.frames.some((frame) =>
        frame.parts.some(
          (item) =>
            item.part === part &&
            item.opacity > 0 &&
            item.opacity < 1 &&
            item.transform !== 'none' &&
            item.animations > 0,
        ),
      );
    expect(hasMiddleFrame('nav')).toBe(true);
    expect(hasMiddleFrame('heading')).toBe(true);
    expect(hasMiddleFrame('editor')).toBe(true);
    expect(hasMiddleFrame('recent-empty')).toBe(true);
    // 同一真实帧里侧栏先显现、编辑区随后跟上，证明入场具有可见的层次。
    expect(
      initial.frames.some((frame) => {
        const nav = frame.parts.find((part) => part.part === 'nav');
        const editor = frame.parts.find((part) => part.part === 'editor');
        return nav && editor && nav.opacity > 0.15 && nav.opacity > editor.opacity + 0.1;
      }),
    ).toBe(true);
    for (const selector of ['.app', '.nav', '.page-head', '.editor', '.empty']) {
      await expect(main.locator(selector)).toHaveCSS('opacity', '1');
      await expect(main.locator(selector)).toHaveCSS('transform', 'none');
    }

    const body = main.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('入场之后的草稿保持完整\n第二行也要保留。');
    await expect(main.getByText('草稿已保存', { exact: true })).toBeVisible();
    const nativeMain = await app.browserWindow(main);
    await nativeMain.evaluate((window) => window.minimize());
    await expect.poll(() => nativeMain.evaluate((window) => window.isMinimized())).toBe(true);
    await nativeMain.evaluate((window) => window.restore());
    await expect.poll(() => nativeMain.evaluate((window) => window.isVisible())).toBe(true);
    await nativeMain.evaluate((window) => window.hide());
    await app.evaluate(({ app }) => app.emit('activate'));
    await expect.poll(() => nativeMain.evaluate((window) => window.isVisible())).toBe(true);
    await nativeMain.dispose();
    const navigation = main.getByRole('navigation', { name: '主导航' });
    await navigation.getByRole('button', { name: /^手记/ }).click();
    await expect(main.getByRole('heading', { name: '手记', exact: true })).toBeVisible();
    await navigation.getByRole('button', { name: /^首页/ }).click();
    await expect(body).toHaveValue('入场之后的草稿保持完整\n第二行也要保留。');
    await main.getByRole('button', { name: '深色', exact: true }).click();
    await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect((await entranceProbe(main)).states).toEqual(initial.states);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // 页面重载仍走有限 ready 握手，但原生窗口已经显示，不应重演首次入场或遗留透明页。
    await main.reload();
    await expect(body).toHaveValue('入场之后的草稿保持完整\n第二行也要保留。');
    await expect(main.locator('html')).not.toHaveAttribute('data-startup-entrance');
    await expect(main.locator('.editor')).toHaveCSS('opacity', '1');
    await expect(main.locator('.editor')).toHaveCSS('transform', 'none');
    await expect(body).toBeEditable();
    const reloaded = await entranceProbe(main);
    expect(reloaded.states).not.toContain('entering');
    expect(reloaded.frames).toEqual([]);
    await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实桌面：减少动态时主页面直接可用，不遗留透明控件或延迟输入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-startup-entrance-reduced-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launch(directory);
    const main = await prepareEntranceProbe(app, 'reduce');
    await waitForMainWindow(app);
    await expect(main.locator('html')).not.toHaveAttribute('data-startup-entrance');
    expect(await main.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    const probe = await entranceProbe(main);
    expect(probe.states).not.toContain('entering');
    expect(probe.frames).toEqual([]);
    for (const selector of ['.app', '.nav', '.page-head', '.editor', '.empty']) {
      await expect(main.locator(selector)).toHaveCSS('opacity', '1');
      await expect(main.locator(selector)).toHaveCSS('transform', 'none');
    }
    const body = main.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('减少动态时可以立即书写');
    await expect(body).toHaveValue('减少动态时可以立即书写');
    await expect(main.getByText('草稿已保存', { exact: true })).toBeVisible();
    await quit(app);
    app = undefined;
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
