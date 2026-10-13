import { existsSync, readFileSync } from 'node:fs';
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
import { DEFAULT_AI_MODEL, type AiModel } from '../../src/shared/ai';

// 此字符串只用于隔离的桌面验收，不是供应商密钥；网络始终由主进程替身应答。
const testKey = 'test-only-desktop-deepseek-key';

/** 模拟供应商 HTTP，真实 UI、preload、IPC、SQLite 与系统 safeStorage 保持完整。 */
async function mockCompletion(app: ElectronApplication, model: AiModel): Promise<void> {
  await app.evaluate(({ net }, expectedModel) => {
    net.fetch = async (url, options) => {
      const input: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
      const body = input as {
        model?: unknown;
        messages?: { role?: unknown; content?: unknown }[];
        stream?: unknown;
        thinking?: { type?: unknown };
      } | null;
      // 同时证明这里只发送固定连接测试内容，且请求使用选中的官方模型。
      if (
        url !== 'https://api.deepseek.com/chat/completions' ||
        options?.method !== 'POST' ||
        body?.model !== expectedModel ||
        body.messages?.length !== 1 ||
        body.messages[0]?.role !== 'user' ||
        body.messages[0]?.content !== 'Reply with OK.' ||
        body.stream !== false ||
        body.thinking?.type !== 'disabled'
      ) {
        return new Response('', { status: 422 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
  }, model);
}

async function openSettings(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: /设置/ })).toBeVisible();
  await page.getByRole('button', { name: /设置/ }).click();
  await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ }),
  ).toBeVisible();
}

test('真实桌面：AI 加密配置、两个模型、取消、备份恢复与重启', async () => {
  test.setTimeout(120_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'memocraft-ai-desktop-'));
  const directory = join(temporaryRoot, 'data');
  const shellDirectory = join(temporaryRoot, 'shell');
  const credentialPath = join(shellDirectory, 'credentials', 'deepseek.enc');
  const packs = await mkdtemp(join(tmpdir(), 'memocraft-ai-packs-'));
  const packPath = join(packs, 'backup-pack');
  const errors: string[] = [];
  let app: ElectronApplication | undefined;

  const launch = () =>
    electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      env: {
        ...process.env,
        MEMOCRAFT_DATA_DIR: directory,
        MEMOCRAFT_USER_DATA_DIR: shellDirectory,
      },
    });
  const quit = async (current: ElectronApplication) => {
    const stopped = current.waitForEvent('close');
    await current.evaluate(({ BrowserWindow }) => {
      // 走现有正常关闭握手，保证模型、密钥和数据库写入排空。
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await stopped;
  };
  const attachPage = async (current: ElectronApplication) => {
    const page = await current.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    expect(await current.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
    return page;
  };

  try {
    app = await launch();
    const page = await attachPage(app);
    // 不能用加密替身掩盖系统环境不支持；不可用时此验收明确失败。
    const protectedStorage = await app.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    );
    expect(protectedStorage, '桌面验收需要真实可用的系统密钥保护').toBe(true);
    await mockCompletion(app, DEFAULT_AI_MODEL);
    await openSettings(page);
    const panel = page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
    const model = panel.getByRole('combobox', { name: /模型/ });
    const key = panel.locator('#ai-key');
    const configured = panel.locator('label[for="ai-key"] .pr-hint');

    await expect(model).toHaveValue(DEFAULT_AI_MODEL);
    await expect(configured).toHaveText('未配置');
    await expect(panel.getByText('DeepSeek', { exact: true })).toBeVisible();
    await expect(panel.getByText('系统密钥保护已启用。', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();

    await key.fill(testKey);
    await panel.getByRole('button', { name: '保存密钥', exact: true }).click();
    await expect(key).toHaveValue('');
    await expect(configured).toHaveText('已配置');
    await expect(panel.locator('.key-saved-notice')).toContainText('密钥已保存');
    await expect(panel.locator('.key-saved-notice')).toContainText('输入框已清空以保护密钥');
    await expect(page.locator('.toast').filter({ hasText: '密钥已保存' })).toBeVisible();
    await page.screenshot({ path: 'test-results/ai-key-saved.png', animations: 'disabled' });
    expect(existsSync(credentialPath)).toBe(true);
    const encrypted = readFileSync(credentialPath);
    expect(encrypted.includes(Buffer.from(testKey))).toBe(false);
    expect(readFileSync(join(directory, 'memocraft.sqlite')).includes(Buffer.from(testKey))).toBe(
      false,
    );

    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: '连接成功' })).toContainText(
      'DeepSeek V4.1 Flash',
    );
    await expect(panel.locator('.key-saved-notice')).toBeVisible();
    await model.selectOption('deepseek-v4-pro');
    await expect(model).toHaveValue('deepseek-v4-pro');
    await expect(panel.locator('.key-saved-notice')).toBeVisible();
    await expect(panel.getByRole('status').filter({ hasText: '模型已保存' })).toBeVisible();
    await mockCompletion(app, 'deepseek-v4-pro');
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: '连接成功' })).toContainText(
      'DeepSeek V4 Pro',
    );
    await page.screenshot({ path: 'test-results/ai-settings.png', animations: 'disabled' });

    await app.evaluate(({ net }) => {
      net.fetch = async () => new Response('do-not-show-vendor-body', { status: 401 });
    });
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('密钥无效或没有调用权限');
    await expect(panel.getByText('do-not-show-vendor-body')).toHaveCount(0);
    await expect(configured).toHaveText('已配置');

    await app.evaluate(({ net }) => {
      const state = globalThis as typeof globalThis & {
        memocraftAiRequestStarted?: boolean;
        memocraftAiRequestAborted?: boolean;
      };
      state.memocraftAiRequestStarted = false;
      state.memocraftAiRequestAborted = false;
      net.fetch = async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          state.memocraftAiRequestStarted = true;
          const abort = () => {
            state.memocraftAiRequestAborted = true;
            reject(new DOMException('Test request aborted', 'AbortError'));
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
    });
    await panel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: '正在测试连接' })).toBeVisible();
    await expect
      .poll(() =>
        app?.evaluate(() => {
          return (globalThis as typeof globalThis & { memocraftAiRequestStarted?: boolean })
            .memocraftAiRequestStarted;
        }),
      )
      .toBe(true);
    await panel.getByRole('button', { name: '取消测试', exact: true }).click();
    await expect(panel.getByRole('status').filter({ hasText: '已取消连接测试' })).toBeVisible();
    await expect
      .poll(() =>
        app?.evaluate(() => {
          return (globalThis as typeof globalThis & { memocraftAiRequestAborted?: boolean })
            .memocraftAiRequestAborted;
        }),
      )
      .toBe(true);
    await expect(panel.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
    await expect(panel.getByRole('status').filter({ hasText: '连接成功' })).toHaveCount(0);

    // 备份只携带模型，恢复需要保留本机密钥并重新读取恢复后的配置。
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, packPath);
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择位置并备份', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: '备份已完成' })).toBeVisible();
    expect(existsSync(join(packPath, 'credentials'))).toBe(false);
    expect(readFileSync(join(packPath, 'memocraft.sqlite')).includes(Buffer.from(testKey))).toBe(
      false,
    );
    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await model.selectOption(DEFAULT_AI_MODEL);
    await expect(model).toHaveValue(DEFAULT_AI_MODEL);
    await expect(panel.getByRole('status').filter({ hasText: '模型已保存' })).toBeVisible();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, packPath);
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择备份并校验…', exact: true }).click();
    const restore = page.getByRole('dialog', { name: '从备份恢复', exact: true });
    await expect(restore).toBeVisible();
    await restore.getByRole('button', { name: '开始恢复', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: '恢复完成' })).toBeVisible();
    expect(readFileSync(credentialPath)).toEqual(encrypted);
    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await expect(model).toHaveValue('deepseek-v4-pro');
    await expect(configured).toHaveText('已配置');

    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await attachPage(app);
    await openSettings(reopened);
    const reopenedPanel = reopened.getByRole('region', {
      name: /^(?:AI 服务|为 Memocraft 接入 AI)$/,
    });
    await expect(reopenedPanel.getByRole('combobox', { name: /模型/ })).toHaveValue(
      'deepseek-v4-pro',
    );
    await expect(reopenedPanel.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
    await expect(reopenedPanel.locator('#ai-key')).toHaveValue('');
    await expect(reopenedPanel.getByRole('status').filter({ hasText: '连接成功' })).toHaveCount(0);
    // 重启后能真正解密旧密文，而不只是判断文件存在。
    await mockCompletion(app, 'deepseek-v4-pro');
    await reopenedPanel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(reopenedPanel.getByRole('status').filter({ hasText: '连接成功' })).toContainText(
      'DeepSeek V4 Pro',
    );
    await reopenedPanel.getByRole('button', { name: '清除密钥', exact: true }).click();
    await expect(reopenedPanel.locator('label[for="ai-key"] .pr-hint')).toHaveText('未配置');
    expect(existsSync(credentialPath)).toBe(false);

    await quit(app);
    app = undefined;
    app = await launch();
    const cleared = await attachPage(app);
    await openSettings(cleared);
    const clearedPanel = cleared.getByRole('region', {
      name: /^(?:AI 服务|为 Memocraft 接入 AI)$/,
    });
    await expect(clearedPanel.locator('label[for="ai-key"] .pr-hint')).toHaveText('未配置');
    await expect(clearedPanel.getByRole('combobox', { name: /模型/ })).toHaveValue(
      'deepseek-v4-pro',
    );
    await expect(
      clearedPanel.getByRole('button', { name: '测试连接', exact: true }),
    ).toBeDisabled();
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(packs, { recursive: true, force: true });
  }
});
