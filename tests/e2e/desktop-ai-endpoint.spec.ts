import { waitForMainWindow } from './main-window';
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
import { DEFAULT_AI_MODEL } from '../../src/shared/ai';

const officialBaseUrl = 'https://api.deepseek.com';
const customBaseUrl = 'https://gateway.example.invalid/v1';
// 只用于临时目录验收；所有供应商 HTTP 都被替换，绝不使用真实凭据或额度。
const testKey = 'test-only-desktop-custom-endpoint-key';
type RequestKind = 'connection' | 'suggestion' | 'ask' | 'review';
interface EndpointRequest {
  url: string;
  kind: RequestKind;
}
type EndpointGlobals = typeof globalThis & { memocraftEndpointRequests?: EndpointRequest[] };

/** 网络替身只允许已知两个地址；其余 UI、preload、IPC、加密与 SQLite 都是真实链路。 */
async function mockEndpoints(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    ({ net }, input) => {
      const requests: EndpointRequest[] = [];
      (globalThis as EndpointGlobals).memocraftEndpointRequests = requests;
      net.fetch = async (url, options) => {
        const address = String(url);
        if (!input.allowed.includes(address)) throw new Error('桌面验收禁止访问其他地址');
        const value: unknown = typeof options?.body === 'string' ? JSON.parse(options.body) : null;
        const body = value as {
          model?: unknown;
          messages?: Array<{ role?: unknown; content?: unknown }>;
          stream?: unknown;
        } | null;
        if (
          options?.method !== 'POST' ||
          body?.model !== input.model ||
          body.stream !== false ||
          new Headers(options.headers).get('Authorization') !== `Bearer ${input.key}` ||
          !Array.isArray(body.messages)
        )
          throw new Error('桌面验收请求未遵循已保存的 AI 配置');

        const system = body.messages.find((message) => message.role === 'system')?.content;
        const user = body.messages.find((message) => message.role === 'user')?.content;
        let kind: RequestKind;
        let content: string;
        if (body.messages.length === 1 && user === 'Reply with OK.') {
          kind = 'connection';
          content = 'OK';
        } else if (typeof system === 'string' && system.includes('"topicIds"')) {
          kind = 'suggestion';
          content = JSON.stringify({ tags: ['响应式'], topicIds: [] });
        } else if (typeof system === 'string' && system.includes('"sources"')) {
          kind = 'ask';
          content = JSON.stringify({
            answer: 'ref 通过 value 访问，reactive 直接访问属性。',
            sources: [1],
          });
        } else if (typeof system === 'string' && system.includes('"suggestions"')) {
          kind = 'review';
          content = JSON.stringify({
            summary: '- **响应式访问**：本期记录明确区分 ref 与 reactive 的访问方式。',
            pointSources: [[1]],
            suggestions: ['将两种访问方式整理成对照。'],
          });
        } else throw new Error('桌面验收收到未知 AI 业务请求');
        requests.push({ url: address, kind });
        return new Response(
          JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
    },
    {
      allowed: [`${officialBaseUrl}/chat/completions`, `${customBaseUrl}/chat/completions`],
      model: DEFAULT_AI_MODEL,
      key: testKey,
    },
  );
}

function capturedRequests(app: ElectronApplication): Promise<EndpointRequest[]> {
  return app.evaluate(() => (globalThis as EndpointGlobals).memocraftEndpointRequests ?? []);
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: /设置/ }).click();
  await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ }),
  ).toBeVisible();
}

async function goHome(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^首页/ }).first().click();
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
}

async function quit(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close');
  // 正常关闭会排空草稿与数据库写入，重启不依赖强行终止进程。
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}

test('真实桌面：自定义 AI 地址覆盖全部业务、输入保留、官方恢复与持久化', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-ai-endpoint-desktop-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const packPath = join(root, 'backup-pack');
  const credentialPath = join(shellDirectory, 'credentials', 'deepseek.enc');
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      env: {
        ...process.env,
        MEMOCRAFT_DATA_DIR: dataDirectory,
        MEMOCRAFT_USER_DATA_DIR: shellDirectory,
      },
    });
  const attach = async (current: ElectronApplication) => {
    const page = await waitForMainWindow(current);
    page.on('pageerror', (error) => errors.push(error.message));
    expect(await current.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
    return page;
  };

  try {
    app = await launch();
    const page = await attach(app);
    expect(
      await app.evaluate(
        ({ safeStorage }) =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      ),
      '隔离桌面流程须使用真实系统密钥保护',
    ).toBe(true);
    await mockEndpoints(app);

    // 问答与回顾使用真实保存的手记，建议使用当前草稿，避免只验 UI 壳或客户端替身。
    const editor = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(editor).toBeVisible();
    await editor.fill('ref 使用 value 访问，reactive 直接访问属性。');
    await page.getByRole('button', { name: '补充', exact: true }).click();
    await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill('Vue 响应式区别');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(editor).toHaveValue('');
    expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
      ok: true,
      value: null,
    });
    expect(existsSync(credentialPath)).toBe(true);
    const encryptedKey = readFileSync(credentialPath);
    expect(encryptedKey.includes(Buffer.from(testKey))).toBe(false);

    await openSettings(page);
    const panel = page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
    const baseUrl = panel.locator('#ai-base-url');
    const saveAddress = panel.getByRole('button', { name: '保存地址', exact: true });
    const testConnection = panel.getByRole('button', { name: '测试连接', exact: true });
    await expect(baseUrl).toHaveAccessibleName(/API 地址.*Base URL/);
    await expect(baseUrl).toHaveValue(officialBaseUrl);
    await expect(panel.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');

    // 用户可粘贴完整接口；保存后的输入和主进程配置应显示同一规范化 Base URL。
    await baseUrl.fill(`  ${customBaseUrl}/chat/completions/  `);
    await saveAddress.click();
    await expect(baseUrl).toHaveValue(customBaseUrl);
    expect(await page.evaluate(() => window.memocraft?.ai.loadSettings())).toMatchObject({
      ok: true,
      value: { baseUrl: customBaseUrl, model: DEFAULT_AI_MODEL, keyConfigured: true },
    });
    await baseUrl.fill('ftp://gateway.example.invalid/v1');
    await saveAddress.click();
    await expect(panel.getByRole('alert')).toBeVisible();
    await expect(baseUrl).toHaveValue('ftp://gateway.example.invalid/v1');
    expect(await page.evaluate(() => window.memocraft?.ai.loadSettings())).toMatchObject({
      ok: true,
      value: { baseUrl: customBaseUrl },
    });
    expect(await capturedRequests(app)).toEqual([]);
    await baseUrl.fill(customBaseUrl);
    await expect(testConnection).toBeEnabled();
    await testConnection.click();
    await expect(panel.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible();

    await goHome(page);
    await editor.fill('练习 ref 的 value 访问，整理 reactive 的属性访问方式。');
    await page.getByRole('button', { name: 'AI 建议', exact: true }).click();
    const card = page.getByRole('region', { name: 'AI 建议', exact: true });
    await expect(card.getByRole('button', { name: '响应式', exact: true })).toBeVisible();
    await card.getByRole('button', { name: '关闭 AI 建议', exact: true }).click();

    await page.getByRole('button', { name: /^搜索/ }).click();
    const search = page.getByRole('dialog', { name: '全局搜索', exact: true });
    const question = search.getByRole('combobox', { name: '搜索内容', exact: true });
    await question.fill('reactive');
    await expect(search.locator('.ai-summary')).toContainText('ref 通过 value');
    await question.press('Escape');
    await expect(search).toHaveCount(0);

    await page.getByRole('button', { name: '回顾', exact: true }).click();
    await expect(page.locator('.summary-text')).toContainText('本期记录明确区分');
    expect(await capturedRequests(app)).toEqual(
      ['connection', 'suggestion', 'ask', 'review'].map((kind) => ({
        kind,
        url: `${customBaseUrl}/chat/completions`,
      })),
    );

    await openSettings(page);
    await expect(baseUrl).toHaveValue(customBaseUrl);
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: '浅色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await baseUrl.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/ai-endpoint-light.png', animations: 'disabled' });
    await page.getByRole('tab', { name: '外观', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await baseUrl.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/ai-endpoint-dark.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await baseUrl.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const addressBounds = await baseUrl.boundingBox();
    expect(addressBounds).not.toBeNull();
    if (!addressBounds) throw new Error('小窗口中的 API 地址输入框未参与布局');
    expect(addressBounds.x + addressBounds.width).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
    await page.screenshot({ path: 'test-results/ai-endpoint-small.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));

    // 地址属于库内普通配置，备份恢复需跟随；系统加密密钥仍留在独立目录。
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, packPath);
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择位置并备份', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: '备份已完成' })).toBeVisible();
    expect(existsSync(join(packPath, 'credentials'))).toBe(false);
    expect(readFileSync(join(packPath, 'memocraft.sqlite')).includes(Buffer.from(testKey))).toBe(
      false,
    );

    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await baseUrl.fill('   ');
    await saveAddress.click();
    await expect(baseUrl).toHaveValue(officialBaseUrl);
    await testConnection.click();
    await expect(panel.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible();
    expect((await capturedRequests(app)).at(-1)).toEqual({
      kind: 'connection',
      url: `${officialBaseUrl}/chat/completions`,
    });
    await baseUrl.fill(customBaseUrl);
    await saveAddress.click();
    await expect(baseUrl).toHaveValue(customBaseUrl);
    await panel.getByRole('button', { name: '恢复官方', exact: true }).click();
    await expect(baseUrl).toHaveValue(officialBaseUrl);

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, packPath);
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择备份并校验…', exact: true }).click();
    const restore = page.getByRole('dialog', { name: '从备份恢复', exact: true });
    await expect(restore).toBeVisible();
    await restore.getByRole('button', { name: '开始恢复', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: '恢复完成' })).toBeVisible();
    await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
    await expect(baseUrl).toHaveValue(customBaseUrl);
    await expect(panel.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
    expect(readFileSync(credentialPath)).toEqual(encryptedKey);

    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await attach(app);
    await mockEndpoints(app);
    await openSettings(reopened);
    const reopenedPanel = reopened.getByRole('region', {
      name: /^(?:AI 服务|为 Memocraft 接入 AI)$/,
    });
    await expect(reopenedPanel.locator('#ai-base-url')).toHaveValue(customBaseUrl);
    await expect(reopenedPanel.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
    await reopenedPanel.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(reopenedPanel.getByRole('status').filter({ hasText: '连接成功' })).toBeVisible();
    expect(await capturedRequests(app)).toEqual([
      { kind: 'connection', url: `${customBaseUrl}/chat/completions` },
    ]);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
