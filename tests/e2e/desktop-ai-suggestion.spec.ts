import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { DEFAULT_AI_MODEL } from '../../src/shared/ai';

// 仅用于隔离验收，供应商网络始终被替换，不使用真实密钥或额度。
const testKey = 'test-only-desktop-suggestion-key';
interface MockState {
  started: boolean;
  aborted: boolean;
  request: { url: string; method: string | undefined; body: string } | null;
  finish?: () => void;
  pausedReply?: unknown;
}
type MockGlobals = typeof globalThis & {
  memocraftSuggestionMock?: MockState;
  memocraftSuggestionLate?: () => void;
};

/** 只替换供应商；挂起应答故意忽略 abort，证明取消不依赖供应商及时结束。 */
async function mockSupplier(
  app: ElectronApplication,
  content: string,
  held = false,
  probePause = false,
): Promise<void> {
  await app.evaluate(
    ({ net, BrowserWindow }, input) => {
      const globals = globalThis as MockGlobals;
      if (globals.memocraftSuggestionMock?.finish)
        globals.memocraftSuggestionLate = globals.memocraftSuggestionMock.finish;
      const state: MockState = { started: false, aborted: false, request: null };
      globals.memocraftSuggestionMock = state;
      const response = () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: input.content }, finish_reason: 'stop' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      net.fetch = async (url, options) => {
        state.started = true;
        state.request = {
          url: String(url),
          method: options?.method,
          body: typeof options?.body === 'string' ? options.body : '',
        };
        if (!input.held) return response();
        return new Promise<Response>((resolve) => {
          state.finish = () => {
            resolve(response());
            state.finish = undefined;
          };
          const abort = () => {
            state.aborted = true;
            // 从真正的渲染 frame 发起桥接读取，观察恢复期间入口暂停。
            if (input.probePause) {
              void BrowserWindow.getAllWindows()[0]
                ?.webContents.executeJavaScript('window.memocraft.ai.loadSettings()')
                .then((reply: unknown) => {
                  state.pausedReply = reply;
                });
            }
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    { content, held, probePause },
  );
}

async function supplierState(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = (globalThis as MockGlobals).memocraftSuggestionMock;
    return (
      state && {
        started: state.started,
        aborted: state.aborted,
        request: state.request,
        pausedReply: state.pausedReply,
      }
    );
  });
}
async function releaseSupplier(app: ElectronApplication, older = false) {
  await app.evaluate((_electron, late) => {
    const globals = globalThis as MockGlobals;
    if (late) {
      globals.memocraftSuggestionLate?.();
      globals.memocraftSuggestionLate = undefined;
    } else globals.memocraftSuggestionMock?.finish?.();
  }, older);
}
async function goHome(page: Page) {
  await page.getByRole('button', { name: /^首页/ }).first().click();
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
  await expect(page.locator('.page-enter-active')).toHaveCount(0);
}
async function addDraftTag(page: Page, tag: string) {
  const extras = page.getByRole('button', { name: '＋ 选择标签', exact: true });
  const toggle = page.getByRole('button', { name: '补充', exact: true });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(extras).toBeVisible();
  await extras.click();
  const picker = page.getByRole('dialog', { name: '选择标签', exact: true });
  const custom = picker.getByRole('textbox', { name: '自定义标签', exact: true });
  await custom.fill(tag);
  await custom.press('Enter');
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  await expect(picker).toHaveCount(0);
}

/** 只读连接检查实际磁盘内容，含 SQLite 的 WAL；不与应用争用写连接。 */
function databaseSnapshot(directory: string) {
  const database = new DatabaseSync(join(directory, 'memocraft.sqlite'), { readOnly: true });
  try {
    return ['notes', 'note_drafts', 'tags', 'note_tags', 'topics', 'note_topics'].map((name) => ({
      name,
      rows: database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    }));
  } finally {
    database.close();
  }
}

test('真实桌面：归纳建议采纳、过期、取消、恢复和正常关闭', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-suggestion-desktop-'));
  const directory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const packPath = join(root, 'backup-pack');
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
    await current.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await stopped;
  };
  const attach = async (current: ElectronApplication) => {
    const page = await current.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    expect(await current.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
    return page;
  };

  try {
    app = await launch();
    const firstApp = app;
    const page = await attach(app);
    expect(
      await app.evaluate(
        ({ safeStorage }) =>
          safeStorage.isEncryptionAvailable() &&
          (process.platform !== 'linux' ||
            safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      ),
      '必须使用真实系统加密，不能通过替身掩盖不可用环境',
    ).toBe(true);
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    const generate = page.getByRole('button', { name: 'AI 建议', exact: true });
    const card = page.getByRole('region', { name: 'AI 建议', exact: true });
    const saved = () => expect(page.locator('.draft-status')).toContainText('草稿已保存');
    await expect(body).toBeVisible();
    await expect(generate).toBeDisabled();
    await body.fill('没有配置密钥时需要设置提示。');
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(card.getByRole('alert')).toContainText('API Key');
    await page.locator('.toast').getByRole('button', { name: '前往设置', exact: true }).click();
    const settings = page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
    await expect(settings).toBeVisible();
    await expect(card).toHaveCount(0);
    await settings.locator('#ai-key').fill(testKey);
    await settings.getByRole('button', { name: '保存密钥', exact: true }).click();
    await expect(settings.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
    expect(existsSync(join(shellDirectory, 'credentials', 'deepseek.enc'))).toBe(true);
    expect(
      readFileSync(join(shellDirectory, 'credentials', 'deepseek.enc')).includes(
        Buffer.from(testKey),
      ),
    ).toBe(false);
    await goHome(page);

    // 创建一条无关手记来验证隐私和标签池，当前草稿始终由 UI 持有。
    const privateBody = '其他手记私密正文，不应发给建议模型。';
    await body.fill(privateBody);
    await addDraftTag(page, '时间管理');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    const created = await page.evaluate(async () => {
      if (!window.memocraft) throw new Error('preload 桥接未注入');
      return window.memocraft.createTopic({
        title: '事务管理',
        description: '归纳私密说明不应发送',
        confirmDuplicate: false,
      });
    });
    if (!created.ok) throw new Error(created.error.message);
    const topic = created.value;
    const result = JSON.stringify({
      tags: ['已选', '时间管理', '规划'],
      topicIds: [topic.id, randomUUID()],
      topics: [{ id: topic.id, title: '供应商编造标题' }],
    });
    const draftBody = '把长期事务拆成每日任务，安排时间并逐一跟进。';
    await body.fill(draftBody);
    await addDraftTag(page, '已选');
    await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill('今日规划');
    await saved();
    const before = databaseSnapshot(directory);
    await mockSupplier(app, result);
    await generate.click();
    await expect(card.getByRole('button', { name: '规划', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: '已选', exact: true })).toBeDisabled();
    await expect(card.getByRole('button', { name: '已选', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(card.locator('.topic-row button')).toHaveCount(1);
    await expect(card.locator('.topic-row button')).toContainText(topic.title);
    await expect(card).not.toContainText('供应商编造标题');
    expect(databaseSnapshot(directory)).toEqual(before);
    const captured = (await supplierState(app))?.request;
    expect(captured).toMatchObject({
      url: 'https://api.deepseek.com/chat/completions',
      method: 'POST',
    });
    const requestBody: unknown = JSON.parse(captured?.body ?? '{}');
    expect(requestBody).toMatchObject({
      model: DEFAULT_AI_MODEL,
      max_tokens: 512,
      thinking: { type: 'disabled' },
      stream: false,
    });
    expect(captured?.body).toContain(draftBody);
    expect(captured?.body).not.toContain(privateBody);
    expect(captured?.body).not.toContain('归纳私密说明不应发送');
    await card.getByRole('button', { name: '时间管理', exact: true }).click();
    await expect(card.getByRole('button', { name: '时间管理', exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '移除标签：时间管理', exact: true }),
    ).toBeVisible();
    await saved();
    const accepted = await page.evaluate(async () => window.memocraft?.load());
    expect(accepted).toMatchObject({
      ok: true,
      value: {
        draft: { body: draftBody, tags: ['已选', '时间管理'] },
        notes: [{ body: privateBody }],
      },
    });

    // 同一张卡片在浅色、深色和最小窗口下实际渲染，截图供独立视觉核验。
    await page.screenshot({ path: 'test-results/ai-suggestion-light.png', animations: 'disabled' });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/ai-suggestion-dark.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await card.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/ai-suggestion-small.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));

    // 请求时仍可编辑正文，结果回来时明确提示旧建议。
    await mockSupplier(app, result, true);
    await generate.click();
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    await expect(page.getByRole('button', { name: '正在生成…', exact: true })).toBeDisabled();
    const editedBody = `${draftBody}正文在生成期间修改。`;
    await body.fill(editedBody);
    await releaseSupplier(app);
    await expect(card.getByText('内容改了，建议可能不再适用。', { exact: false })).toBeVisible();
    await saved();

    // 关闭在途卡片后立即可重生；旧响应晚到不会覆盖新结果。
    await mockSupplier(app, result, true);
    await generate.click();
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    await card.getByRole('button', { name: '关闭 AI 建议', exact: true }).click();
    await expect.poll(async () => (await supplierState(firstApp))?.aborted).toBe(true);
    await expect(card).toHaveCount(0);
    await mockSupplier(app, result);
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(card.getByRole('button', { name: '规划', exact: true })).toBeVisible();
    await releaseSupplier(app, true);
    await expect(card.getByRole('button', { name: '规划', exact: true })).toBeVisible();
    await expect(card.locator('.stale')).toHaveCount(0);

    // 点击归纳只导航并保存草稿，不提交手记、不自动收录。
    await card.locator('.topic-row button').click();
    await expect(page.locator('.detail-title')).toContainText(topic.title);
    await expect(card).toHaveCount(0);
    const navigated = await page.evaluate(async () => ({
      library: await window.memocraft?.load(),
      topics: await window.memocraft?.loadTopics(),
    }));
    expect(navigated.library).toMatchObject({
      ok: true,
      value: {
        draft: { body: editedBody, tags: ['已选', '时间管理'] },
        notes: [{ body: privateBody }],
      },
    });
    expect(navigated.topics).toMatchObject({ ok: true, value: [{ id: topic.id, noteIds: [] }] });
    await goHome(page);

    await mockSupplier(app, result, true);
    await generate.click();
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect.poll(async () => (await supplierState(firstApp))?.aborted).toBe(true);
    await releaseSupplier(app);
    await goHome(page);
    await expect(card).toHaveCount(0);
    await expect(body).toHaveValue(editedBody);

    // 错误建议不改任何持久数据，错误正文不作为标签采纳。
    const beforeInvalid = databaseSnapshot(directory);
    await mockSupplier(app, 'invalid supplier JSON');
    await generate.click();
    await expect(card.getByRole('alert')).toContainText('格式异常');
    expect(databaseSnapshot(directory)).toEqual(beforeInvalid);
    await card.getByRole('button', { name: '关闭 AI 建议', exact: true }).click();

    // 直接走同一个 preload 验证服务端防重与取消 ID 匹配，不能只依靠按钮禁用。
    await mockSupplier(app, result, true);
    const probeId = randomUUID();
    await page.evaluate((requestId) => {
      if (!window.memocraft) throw new Error('preload 桥接未注入');
      const state = window as Window & { suggestionProbe?: Promise<unknown> };
      state.suggestionProbe = window.memocraft.ai.suggest({
        requestId,
        body: '事务规划',
        title: '',
        existingTags: [],
        draftId: crypto.randomUUID(),
        imageIds: [],
      });
    }, probeId);
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    expect(
      await page.evaluate(
        (requestId) =>
          window.memocraft?.ai.suggest({
            requestId,
            body: '事务规划',
            title: '',
            existingTags: [],
            draftId: crypto.randomUUID(),
            imageIds: [],
          }),
        randomUUID(),
      ),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(
      await page.evaluate((id) => window.memocraft?.ai.cancelSuggestion(id), randomUUID()),
    ).toEqual({ ok: true, value: null });
    expect((await supplierState(app))?.aborted).toBe(false);
    expect(await page.evaluate((id) => window.memocraft?.ai.cancelSuggestion(id), probeId)).toEqual(
      { ok: true, value: null },
    );
    expect(
      await page.evaluate(
        () => (window as Window & { suggestionProbe?: Promise<unknown> }).suggestionProbe,
      ),
    ).toMatchObject({ ok: false, error: { code: 'AI_CANCELLED' } });
    await releaseSupplier(app);

    // 整库恢复取消旧候选的在途请求，暂停入口，并在完成后恢复调用能力。
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, packPath);
    expect(await page.evaluate(() => window.memocraft?.backupLibrary())).toMatchObject({
      ok: true,
    });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, packPath);
    expect(await page.evaluate(() => window.memocraft?.restoreLibrary())).toMatchObject({
      ok: true,
    });
    await mockSupplier(app, result, true, true);
    await generate.click();
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    expect(await page.evaluate(() => window.memocraft?.applyRestore())).toEqual({
      ok: true,
      value: null,
    });
    expect((await supplierState(app))?.aborted).toBe(true);
    await expect
      .poll(async () => (await supplierState(firstApp))?.pausedReply)
      .toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    await releaseSupplier(app);
    await expect(card).toHaveCount(0);
    await mockSupplier(app, result);
    await generate.click();
    await expect(card.getByRole('button', { name: '规划', exact: true })).toBeVisible();

    // 正常关闭必须先保存最后一次输入，并在真正退出时已中止网络。
    let stdout = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await app.evaluate(({ app }) => {
      app.once('will-quit', () => {
        const state = (globalThis as MockGlobals).memocraftSuggestionMock;
        console.info(
          `MEMOCRAFT_SUGGESTION_QUIT:${JSON.stringify({ started: state?.started, aborted: state?.aborted })}`,
        );
      });
    });
    await mockSupplier(app, result, true);
    await generate.click();
    await expect.poll(async () => (await supplierState(firstApp))?.started).toBe(true);
    const closingBody = `${editedBody}关闭前的最后输入。`;
    await body.fill(closingBody);
    await quit(app);
    app = undefined;
    expect(stdout).toContain('MEMOCRAFT_SUGGESTION_QUIT:{"started":true,"aborted":true}');
    app = await launch();
    const reopened = await attach(app);
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      closingBody,
    );
    await expect(reopened.getByRole('region', { name: 'AI 建议', exact: true })).toHaveCount(0);
    const reopenedLibrary = await reopened.evaluate(() => window.memocraft?.load());
    expect(reopenedLibrary).toMatchObject({
      ok: true,
      value: {
        draft: { body: closingBody, tags: ['已选', '时间管理'] },
        notes: [{ body: privateBody }],
      },
    });
    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
