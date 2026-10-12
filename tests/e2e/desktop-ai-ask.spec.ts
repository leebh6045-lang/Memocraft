import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

interface AskMockState {
  calls: number;
  requests: Array<{ body: string; aborted: boolean }>;
  finish?: () => void;
  status?: number;
  content?: string;
  pausedReply?: unknown;
}
type AskGlobals = typeof globalThis & { memocraftAskMock?: AskMockState };

/** 仅替换 Electron 网络栈；请求体仍由真实 DeepSeekClient 组装并经过真实 IPC。 */
async function mockAsk(
  app: ElectronApplication,
  options: { content?: string; status?: number; held?: boolean; probeRequestId?: string } = {},
) {
  await app.evaluate(({ net, BrowserWindow }, input) => {
    const state: AskMockState = {
      calls: 0,
      requests: [],
      content: input.content,
      status: input.status,
    };
    (globalThis as AskGlobals).memocraftAskMock = state;
    net.fetch = async (url, request) => {
      if (String(url) !== 'https://api.deepseek.com/chat/completions')
        throw new Error(`unexpected URL ${String(url)}`);
      state.calls += 1;
      const record = {
        body: typeof request?.body === 'string' ? request.body : '',
        aborted: false,
      };
      state.requests.push(record);
      const response = () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: input.content ?? '{"answer":"根据你的手记回答。","sources":[1]}',
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { status: input.status ?? 200, headers: { 'content-type': 'application/json' } },
        );
      if (input.held) {
        return new Promise<Response>((resolve) => {
          state.finish = () => {
            resolve(response());
            state.finish = undefined;
          };
          const abort = () => {
            record.aborted = true;
            if (input.probeRequestId) {
              void BrowserWindow.getAllWindows()[0]
                ?.webContents.executeJavaScript(
                  `Promise.all([window.memocraft.ai.loadSettings(), window.memocraft.ai.cancelAsk(${JSON.stringify(input.probeRequestId)})])`,
                )
                .then((value: unknown) => {
                  state.pausedReply = value;
                });
            }
          };
          if (request?.signal?.aborted) abort();
          else request?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return response();
    };
  }, options);
}
async function askState(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = (globalThis as AskGlobals).memocraftAskMock;
    return (
      state && { calls: state.calls, requests: state.requests, pausedReply: state.pausedReply }
    );
  });
}
async function releaseAsk(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as AskGlobals).memocraftAskMock?.finish?.());
}
async function seedNote(page: Page, body: string, title: string) {
  const editor = page.getByRole('textbox', { name: '手记正文', exact: true });
  await editor.fill(body);
  const extras = page.getByRole('button', { name: '补充', exact: true });
  if ((await extras.getAttribute('aria-expanded')) !== 'true') await extras.click();
  await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill(title);
  await page.getByRole('button', { name: '保存手记', exact: true }).click();
  await expect(editor).toHaveValue('');
  const result = await page.evaluate(() => window.memocraft?.load());
  if (!result?.ok || !result.value.notes[0]) throw new Error('手记未成功保存');
  return result.value.notes[0].id;
}
async function openSearch(page: Page) {
  await page.getByRole('button', { name: /^搜索/ }).click();
  await expect(page.getByRole('dialog', { name: '全局搜索' })).toBeVisible();
}
async function quit(app: ElectronApplication) {
  const closed = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}

test('真实桌面：搜索问答摘要、来源、缓存、错误和现场取消', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-ai-ask-desktop-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
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
  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    const noteId = await seedNote(
      page,
      'ref 使用 value 访问，reactive 直接访问属性。',
      'Vue 响应式区别',
    );
    await seedNote(page, 'PRIVATE_UNMATCHED_NOTE_DO_NOT_SEND', '私人日记');
    expect(await page.evaluate(() => window.memocraft?.ai.loadSettings())).toMatchObject({
      ok: true,
      value: { keyConfigured: false },
    });

    // 未配置密钥时摘要行不占位，普通搜索仍然工作。
    await openSearch(page);
    const palette = page.getByRole('dialog', { name: '全局搜索' });
    const input = page.getByRole('combobox', { name: '搜索内容' });
    await input.fill('reactive');
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.locator('.ai-answer-row')).toHaveCount(0);
    await input.press('Escape');

    const savedKey = await page.evaluate(() =>
      window.memocraft?.ai.saveKey('test-only-ai-ask-key'),
    );
    expect(savedKey).toEqual({ ok: true, value: null });
    await mockAsk(app, {
      content: JSON.stringify({
        answer: 'ref 通过 value 访问，reactive 直接访问属性。',
        sources: [1],
      }),
    });

    // 3 字不触发；4 字触发并显示加载到摘要，展开后显示本地来源标题。
    await openSearch(page);
    await input.fill('Vue');
    await expect(palette.locator('.ai-answer-row')).toHaveCount(0);
    await input.fill('ref?');
    await expect(palette.locator('.ai-answer-row')).toHaveCount(1);
    await expect(palette.locator('.ai-ask[role="status"]')).toBeVisible();
    await expect(palette.locator('.ai-summary')).toContainText('ref 通过 value');
    await expect(palette.locator('.source-count')).toHaveText('1 个来源');
    const state = await askState(app);
    expect(state?.calls).toBe(1);
    expect(state?.requests[0]?.body).not.toContain(noteId);
    expect(state?.requests[0]?.body).not.toContain('PRIVATE_UNMATCHED_NOTE_DO_NOT_SEND');
    expect(state?.requests[0]?.body).not.toContain('test-only-ai-ask-key');
    expect(JSON.parse(state?.requests[0]?.body ?? '{}')).toMatchObject({
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 512,
    });
    await palette.locator('.is-result').click();
    await expect(palette.locator('.is-expanded')).toContainText('Vue 响应式区别');
    await expect(palette.locator('.is-expanded')).toContainText('ref 通过 value');
    await page.screenshot({
      path: 'test-results/ask-artifacts/ask-light.png',
      animations: 'disabled',
    });

    // 同一面板内重复查看同一词命中缓存；来源打开手记详情并关闭搜索面板。
    await input.fill('reactive');
    await expect(palette.locator('.ai-summary')).toBeVisible();
    expect((await askState(app))?.calls).toBe(2);
    await input.fill('ref?');
    await expect(palette.locator('.ai-summary')).toBeVisible();
    expect((await askState(app))?.calls).toBe(2);
    await palette.locator('.is-result').click();
    await palette.getByRole('button', { name: /\[1\] Vue 响应式区别/ }).click();
    await expect(page.getByRole('dialog', { name: '手记详情' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: '手记详情' }).getByRole('textbox', { name: '编辑手记正文' }),
    ).toHaveValue(/ref 使用 value/);
    await page
      .getByRole('dialog', { name: '手记详情' })
      .getByRole('button', { name: /^关闭/ })
      .click();

    // 无本地命中不发HTTP；所有来源越界时仍展示回答，不制造来源标题或HTML元素。
    await mockAsk(app, {
      content: '{"answer":"<img src=x onerror=alert(1)> 根据记录回答。","sources":[0,-1,99]}',
    });
    await openSearch(page);
    await input.fill('无关斑马企鹅');
    await expect(palette.locator('.ai-answer-row')).toContainText('你的手记里还没有关于这个的记录');
    expect((await askState(app))?.calls).toBe(0);
    await input.fill('reactive');
    await expect(palette.locator('.ai-summary')).toContainText('<img src=x');
    await palette.locator('.is-result').click();
    await expect(palette.locator('.source-link')).toHaveCount(0);
    await expect(palette.locator('.ai-answer-row img')).toHaveCount(0);
    await input.press('Escape');

    // 错误只显示在摘要行位置，不吞掉普通搜索结果；供应商正文不泄露。
    await mockAsk(app, { status: 500 });
    await openSearch(page);
    await input.fill('reactive');
    await expect(palette.locator('.ai-answer-row [role="alert"]')).toContainText(
      'DeepSeek 服务暂时不可用',
    );
    await expect(palette.getByRole('option')).toHaveCount(1);
    await expect(palette.locator('.ai-answer-row')).not.toContainText('private');
    await palette.locator('.ai-answer-row').getByRole('button', { name: '重试' }).click();
    await expect(palette.locator('.ai-answer-row [role="alert"]')).toBeVisible();
    await input.press('Escape');

    // 修改手记后同词重新检索，不命中旧缓存；闭面板再开也不保留问答现场。
    await openSearch(page);
    await input.fill('reactive');
    await palette.getByRole('option').first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await drawer
      .getByRole('textbox', { name: '编辑手记正文' })
      .fill('ref 与 reactive 已修改为新的记录。');
    await drawer.getByRole('button', { name: /^关闭/ }).click();
    const edited = await page.evaluate(() => window.memocraft?.load());
    expect(edited).toMatchObject({
      ok: true,
      value: {
        notes: expect.arrayContaining([expect.objectContaining({ id: noteId, revision: 2 })]),
      },
    });
    await mockAsk(app, { content: JSON.stringify({ answer: '新的记录回答。', sources: [1] }) });
    await openSearch(page);
    await input.fill('reactive');
    await expect(palette.locator('.ai-summary')).toContainText('新的记录回答');
    expect((await askState(app))?.calls).toBe(1);
    await input.press('Escape');
    await openSearch(page);
    await expect(palette.locator('.ai-answer-row')).toHaveCount(0);
    await input.fill('reactive');
    await expect(palette.locator('.ai-summary')).toContainText('新的记录回答');

    // 旧请求挂起时关闭面板，供应商收到 abort；随后打开可正常再次询问。
    await mockAsk(app, { held: true, content: '{"answer":"迟到答案","sources":[1]}' });
    await input.fill('reactive new');
    await expect.poll(async () => (await askState(app!))?.calls).toBe(1);
    await input.press('Escape');
    await expect.poll(async () => (await askState(app!))?.requests[0]?.aborted).toBe(true);
    await releaseAsk(app);
    await mockAsk(app, { content: '{"answer":"新的记录回答。","sources":[1]}' });
    await openSearch(page);
    await input.fill('reactive');
    await expect(palette.locator('.ai-summary')).toContainText('新的记录回答');

    // 主题与窄窗口下展开视图不溢出；来源和回答仍在面板内。
    await input.press('Escape');
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openSearch(page);
    await input.fill('reactive');
    await palette.locator('.is-result').click();
    await page.screenshot({
      path: 'test-results/ask-artifacts/ask-dark.png',
      animations: 'disabled',
    });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: 'test-results/ask-artifacts/ask-small.png',
      animations: 'disabled',
    });
    await expect(page.locator('.ai-answer-row')).toBeVisible();
    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

// 挂起网络故意忽略abort；真实客户端的取消与主进程排空仍须让恢复和关闭完成。
test('真实桌面：恢复暂停、取消白名单、失败回滚和关闭排空问答', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-ai-ask-lifecycle-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const packPath = join(root, 'backup-pack');
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
  try {
    app = await launch();
    const firstApp = app;
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    const noteId = await seedNote(page, 'SQLite 事务用于保持原子性。', 'SQLite 知识');
    expect(
      await page.evaluate(() => window.memocraft?.ai.saveKey('test-only-ask-lifecycle-key')),
    ).toEqual({ ok: true, value: null });
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

    const requestId = randomUUID();
    await mockAsk(app, { held: true, probeRequestId: requestId });
    await page.evaluate((id) => {
      const state = window as Window & { askProbe?: Promise<unknown> };
      state.askProbe = window.memocraft?.ai.ask({ requestId: id, question: 'SQLite' });
    }, requestId);
    await expect.poll(async () => (await askState(firstApp))?.calls).toBe(1);
    expect(await page.evaluate(() => window.memocraft?.applyRestore())).toEqual({
      ok: true,
      value: null,
    });
    await expect.poll(async () => (await askState(firstApp))?.requests[0]?.aborted).toBe(true);
    await expect
      .poll(async () => (await askState(firstApp))?.pausedReply)
      .toEqual([
        {
          ok: false,
          error: { code: 'UNAVAILABLE', message: '正在关闭或恢复知识库，请稍后重试。' },
        },
        { ok: true, value: null },
      ]);
    expect(
      await page.evaluate(() => (window as Window & { askProbe?: Promise<unknown> }).askProbe),
    ).toMatchObject({ ok: false, error: { code: 'AI_CANCELLED' } });
    await releaseAsk(app);
    expect(await page.evaluate(() => window.memocraft?.load())).toMatchObject({
      ok: true,
      value: { notes: [expect.objectContaining({ id: noteId })] },
    });

    // 已校验的暂存库损坏时回滚，窗口保留，恢复后问答入口重新可用。
    expect(await page.evaluate(() => window.memocraft?.restoreLibrary())).toMatchObject({
      ok: true,
    });
    await writeFile(
      join(dataDirectory, '.restore-staging', 'memocraft.sqlite'),
      'invalid staged SQLite',
    );
    expect(await page.evaluate(() => window.memocraft?.applyRestore())).toMatchObject({
      ok: false,
    });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await page.evaluate(() => window.memocraft?.load())).toMatchObject({
      ok: true,
      value: { notes: [expect.objectContaining({ id: noteId })] },
    });
    await mockAsk(app, { content: '{"answer":"事务保持原子性。","sources":[1]}' });
    expect(
      await page.evaluate(
        (id) => window.memocraft?.ai.ask({ requestId: id, question: 'SQLite' }),
        randomUUID(),
      ),
    ).toMatchObject({ ok: true, value: { sources: [expect.objectContaining({ noteId })] } });

    // 正常窗口关闭也要取消在途问答，重新打开不会留下旧搜索现场。
    let stdout = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await app.evaluate(({ app }) => {
      app.once('will-quit', () => {
        const state = (globalThis as AskGlobals).memocraftAskMock;
        console.info(
          `MEMOCRAFT_ASK_QUIT:${JSON.stringify({ calls: state?.calls, aborted: state?.requests[0]?.aborted })}`,
        );
      });
    });
    await mockAsk(app, { held: true });
    await openSearch(page);
    await page.getByRole('combobox', { name: '搜索内容' }).fill('SQLite');
    await expect.poll(async () => (await askState(firstApp))?.calls).toBe(1);
    await quit(app);
    app = undefined;
    expect(stdout).toContain('MEMOCRAFT_ASK_QUIT:{"calls":1,"aborted":true}');
    expect(errors).toEqual([]);
    app = await launch();
    const reopened = await app.firstWindow();
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await expect(reopened.getByRole('dialog', { name: '全局搜索' })).toHaveCount(0);
    await expect(reopened.locator('.ai-answer-row')).toHaveCount(0);
    expect(await reopened.evaluate(() => window.memocraft?.load())).toMatchObject({
      ok: true,
      value: { notes: [expect.objectContaining({ id: noteId })] },
    });
    await quit(app);
    app = undefined;
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
