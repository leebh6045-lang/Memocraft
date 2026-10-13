import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

type HelpProbe = { urls: string[]; finishOpening?: () => void };

test('真实桌面：帮助固定网址、来源校验、失败重试与草稿保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-help-'));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      env: {
        ...process.env,
        MEMOCRAFT_DATA_DIR: directory,
        MEMOCRAFT_USER_DATA_DIR: join(directory, 'shell'),
      },
    });
  const quit = async (current: ElectronApplication) => {
    const stopped = current.waitForEvent('close');
    await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await stopped;
  };

  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    const help = page.getByRole('button', { name: '帮助（在浏览器打开新手指南）', exact: true });
    await expect(body).toBeVisible();
    await expect(help).toHaveAttribute('title', '帮助');
    expect(
      await page
        .locator('.corner button')
        .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('title'))),
    ).toEqual(['回收站', '帮助', '设置']);

    await body.fill('打开教程时仍保留的草稿');
    await page.getByRole('radio', { name: '思绪', exact: true }).check();
    const rendererUrl = page.url();
    // 在真实主进程替换系统浏览器启动，只截获打开意图；IPC 和 preload 仍实际运行。
    await app.evaluate(({ shell }) => {
      const state = globalThis as typeof globalThis & { helpProbe: HelpProbe };
      state.helpProbe = { urls: [] };
      shell.openExternal = async (url) => {
        state.helpProbe.urls.push(url);
        await new Promise<void>((finish) => {
          state.helpProbe.finishOpening = finish;
        });
      };
    });
    await help.click();
    await expect(help).toBeDisabled();
    await help.evaluate((button) => (button as HTMLButtonElement).click());
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { helpProbe: HelpProbe }).helpProbe.urls,
      ),
    ).toEqual(['http://47.119.177.34/memocraft/help/']);
    await app.evaluate(() => {
      const probe = (globalThis as typeof globalThis & { helpProbe: HelpProbe }).helpProbe;
      if (!probe.finishOpening) throw new Error('帮助打开请求未开始');
      probe.finishOpening();
    });
    await expect(help).toBeEnabled();
    expect(page.url()).toBe(rendererUrl);
    await expect(body).toHaveValue('打开教程时仍保留的草稿');
    await expect(page.getByRole('radio', { name: '思绪', exact: true })).toBeChecked();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw new Error('系统浏览器启动失败');
      };
    });
    await help.click();
    await expect(
      page.locator('.toast').filter({ hasText: '无法打开新手指南，请检查默认浏览器后重试。' }),
    ).toBeVisible();
    await expect(help).toBeEnabled();
    await body.fill('打开失败后继续编辑的草稿');
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { helpProbe: HelpProbe }).helpProbe.urls.push(url);
      };
    });
    await help.click();
    await expect(help).toBeEnabled();
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { helpProbe: HelpProbe }).helpProbe.urls,
      ),
    ).toEqual(Array(2).fill('http://47.119.177.34/memocraft/help/'));

    // 非原窗口复用相同 preload 也不能启动浏览器，检验实际 IPC 来源边界。
    const preloadPath = join(
      await app.evaluate(({ app: desktopApp }) => desktopApp.getAppPath()),
      'out',
      'preload',
      'index.cjs',
    );
    const rejected = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const main = BrowserWindow.getAllWindows()[0];
      if (!main) throw new Error('主窗口不存在');
      const probe = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      try {
        await probe.loadURL('about:blank');
        const result: unknown = await probe.webContents.executeJavaScript(
          'window.memocraft.openHelp()',
        );
        return result;
      } finally {
        probe.destroy();
      }
    }, preloadPath);
    expect(rejected).toEqual({
      ok: false,
      error: { code: 'UNAVAILABLE', message: '请求来源无效。' },
    });
    expect(
      await app.evaluate(
        () => (globalThis as typeof globalThis & { helpProbe: HelpProbe }).helpProbe.urls.length,
      ),
    ).toBe(2);
    await expect(body).toHaveValue('打开失败后继续编辑的草稿');

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await expect(help).toBeInViewport();
    await page.screenshot({ path: 'test-results/help-entry-light.png', animations: 'disabled' });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(help).toBeInViewport();
    await page.screenshot({ path: 'test-results/help-entry-dark.png', animations: 'disabled' });
    await page.getByRole('button', { name: /专注模式/ }).click();
    await expect(page.locator('.app')).toHaveClass(/focus/);
    await expect(help).toBeInViewport();
    await help.click();
    await expect(help).toBeEnabled();
    await expect(body).toHaveValue('打开失败后继续编辑的草稿');
    await page.screenshot({ path: 'test-results/help-entry-focus.png', animations: 'disabled' });

    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      '打开失败后继续编辑的草稿',
    );
    await expect(reopened.getByRole('radio', { name: '思绪', exact: true })).toBeChecked();
    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
