import { DatabaseSync } from 'node:sqlite';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { PNG_2X3 } from '../fixtures/images';
import { DEFAULT_AI_MODEL } from '../../src/shared/ai';

const testKey = 'test-only-vision-key';
const PRO_MODEL = 'deepseek-v4-pro';
const MAX_IMAGE_BASE64 = 8 * 1024 * 1024;

interface CapturedMessage {
  model: string;
  messages: { role?: unknown; content?: unknown }[];
  body: string;
}

interface VisionMockState {
  calls: CapturedMessage[];
  imageReads: number;
  aborted: boolean;
  finish?: () => void;
}

type MockGlobals = typeof globalThis & {
  memocraftVisionMock?: VisionMockState;
  memocraftVisionObserveInstalled?: boolean;
};
type VisionMockSnapshot = Omit<VisionMockState, 'finish'>;

function launch(directory: string, shellDirectory: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: process.env.MEMOCRAFT_TEST_APP,
    args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
    env: {
      ...process.env,
      MEMOCRAFT_DATA_DIR: directory,
      MEMOCRAFT_USER_DATA_DIR: shellDirectory,
    },
  });
}

async function quit(app: ElectronApplication): Promise<void> {
  const stopped = app.waitForEvent('close');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await stopped;
}

async function openSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: /设置/ }).first().click();
  await page.getByRole('tab', { name: 'AI 服务', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ }),
  ).toBeVisible();
  return page.getByRole('region', { name: /^(?:AI 服务|为 Memocraft 接入 AI)$/ });
}

async function setKey(page: Page): Promise<void> {
  const panel = await openSettings(page);
  const key = panel.locator('#ai-key');
  if ((await panel.locator('label[for="ai-key"] .pr-hint').textContent()) !== '已配置') {
    await key.fill(testKey);
    await panel.getByRole('button', { name: '保存密钥', exact: true }).click();
    await expect(panel.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
  }
  await page.getByRole('button', { name: /^首页/ }).first().click();
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
}

async function chooseModel(page: Page, model: string): Promise<void> {
  const panel = await openSettings(page);
  const select = panel.getByRole('combobox', { name: /模型/ });
  await select.selectOption(model);
  await expect(select).toHaveValue(model);
  await page.getByRole('button', { name: /^首页/ }).first().click();
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
}

async function mockSuggestion(
  app: ElectronApplication,
  content: string,
  held = false,
): Promise<void> {
  await app.evaluate(
    ({ net }, input) => {
      const globals = globalThis as MockGlobals;
      const state: VisionMockState = { calls: [], imageReads: 0, aborted: false };
      globals.memocraftVisionMock = state;
      // 观察真实 storage worker 的读图请求，既不代替存储也不改写应答。
      if (!globals.memocraftVisionObserveInstalled) {
        const { Worker } = process.getBuiltinModule('node:worker_threads');
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message: unknown, transferList) {
          if (
            typeof message === 'object' &&
            message !== null &&
            'request' in message &&
            typeof message.request === 'object' &&
            message.request !== null &&
            'operation' in message.request &&
            message.request.operation === 'readImage'
          ) {
            const active = (globalThis as MockGlobals).memocraftVisionMock;
            if (active) active.imageReads += 1;
          }
          post.call(this, message, transferList);
        };
        globals.memocraftVisionObserveInstalled = true;
      }
      net.fetch = async (_url, options) => {
        const body = typeof options?.body === 'string' ? options.body : '';
        const parsed = JSON.parse(body) as {
          model?: unknown;
          messages?: { role?: unknown; content?: unknown }[];
        };
        state.calls.push({
          model: typeof parsed.model === 'string' ? parsed.model : '',
          messages: parsed.messages ?? [],
          body,
        });
        const response = () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: input.content }, finish_reason: 'stop' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (!input.held) return response();
        return new Promise<Response>((resolveResponse) => {
          state.finish = () => {
            state.finish = undefined;
            resolveResponse(response());
          };
          const abort = () => {
            state.aborted = true;
          };
          if (options?.signal?.aborted) abort();
          else options?.signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    { content, held },
  );
}

async function mockState(app: ElectronApplication): Promise<VisionMockSnapshot | undefined> {
  return app.evaluate(() => {
    const state = (globalThis as MockGlobals).memocraftVisionMock;
    return state && { calls: state.calls, imageReads: state.imageReads, aborted: state.aborted };
  });
}

async function addImages(app: ElectronApplication, page: Page, paths: string[]): Promise<void> {
  const count = await page.locator('.gallery-item').count();
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
  await page.getByRole('button', { name: '添加图片', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(count + paths.length);
}

async function removeImage(page: Page, index: number): Promise<void> {
  const count = await page.locator('.gallery-item').count();
  const item = page.locator('.gallery-item').nth(index);
  await item.getByRole('button', { name: '移出', exact: true }).click();
  await item.getByRole('button', { name: '确认移出', exact: true }).click();
  await expect(page.locator('.gallery-item')).toHaveCount(count - 1);
}

async function generate(page: Page): Promise<Locator> {
  const card = page.getByRole('region', { name: 'AI 建议', exact: true });
  await page.getByRole('button', { name: 'AI 建议', exact: true }).click();
  await expect(card).toBeVisible();
  return card;
}

async function screenshotCard(page: Page, card: Locator, path: string): Promise<void> {
  for (const dismiss of await page.getByRole('button', { name: '关闭提示', exact: true }).all())
    await dismiss.click();
  await expect(page.locator('.toast')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path, animations: 'disabled' });
}

function userContent(state: VisionMockSnapshot | undefined): unknown {
  return state?.calls[0]?.messages.find((message) => message.role === 'user')?.content;
}

function imageUrls(state: VisionMockSnapshot | undefined): string[] {
  const content = userContent(state);
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (
      typeof block !== 'object' ||
      block === null ||
      !('type' in block) ||
      block.type !== 'image_url' ||
      !('image_url' in block) ||
      typeof block.image_url !== 'object' ||
      block.image_url === null ||
      !('url' in block.image_url) ||
      typeof block.image_url.url !== 'string'
    )
      return [];
    return [block.image_url.url];
  });
}

function snapshot(directory: string): unknown {
  const database = new DatabaseSync(join(directory, 'memocraft.sqlite'), { readOnly: true });
  try {
    return ['notes', 'note_drafts', 'note_images', 'tags', 'note_tags'].map((name) => ({
      name,
      rows: database.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
    }));
  } finally {
    database.close();
  }
}

function pngVariant(index: number): Uint8Array {
  return Uint8Array.from([...PNG_2X3, index]);
}

function largePng(): Uint8Array {
  const bytes = new Uint8Array((MAX_IMAGE_BASE64 * 3) / 4);
  bytes.set(PNG_2X3);
  return bytes;
}

function oversizedPng(): Uint8Array {
  const bytes = Uint8Array.from(PNG_2X3);
  new DataView(bytes.buffer).setUint32(16, 8193);
  return bytes;
}

test('真实桌面：Flash 视觉建议顺序、预算提示、stale 与 Pro 降级', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-ai-vision-desktop-'));
  const directory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const screenshotDirectory = join(process.cwd(), 'test-results', 'vision-artifacts');
  await mkdir(screenshotDirectory, { recursive: true });
  const fixturePaths = Array.from({ length: 5 }, (_, index) => {
    const path = join(root, `vision-${index + 1}.png`);
    writeFileSync(path, pngVariant(index + 1));
    return path;
  });
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(directory, shellDirectory);
    const protectedStorage = await app.evaluate(
      ({ safeStorage }) =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    );
    expect(protectedStorage, '视觉验收需要真实系统密钥保护').toBe(true);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await setKey(page);
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('这条手记包含五张截图，需要识别图片中的工作内容。');
    await addImages(app, page, fixturePaths);
    await expect(page.locator('.gallery-item')).toHaveCount(5);

    await mockSuggestion(app, JSON.stringify({ tags: ['图片', '工作', '截图'], topicIds: [] }));
    const before = snapshot(directory);
    let card = await generate(page);
    await expect(card.getByText('有 1 张图片未参与建议。', { exact: true })).toBeVisible();
    await expect(card).not.toContainText('当前模型不支持图片');
    let state = await mockState(app);
    expect(state?.calls).toHaveLength(1);
    expect(state?.calls[0]?.model).toBe(DEFAULT_AI_MODEL);
    const firstUrls = imageUrls(state);
    expect(firstUrls).toHaveLength(4);
    expect(firstUrls).toEqual(
      fixturePaths
        .slice(0, 4)
        .map(
          (_, index) =>
            `data:image/png;base64,${Buffer.from(pngVariant(index + 1)).toString('base64')}`,
        ),
    );
    expect(firstUrls.every((url) => url.includes(';base64,'))).toBe(true);
    expect(firstUrls.every((url) => url.startsWith('data:image/png;base64,'))).toBe(true);
    expect(state?.calls[0]?.body).not.toContain(directory);
    expect(snapshot(directory)).toEqual(before);
    await screenshotCard(page, card, join(screenshotDirectory, 'ai-vision-flash-skip.png'));

    // 删除第五张必须立即让已返回建议变成 stale。
    await removeImage(page, 4);
    await expect(card.locator('.stale')).toBeVisible();
    await card.getByRole('button', { name: '关闭 AI 建议', exact: true }).click();
    await mockSuggestion(app, JSON.stringify({ tags: ['图片', '工作', '截图'], topicIds: [] }));
    card = await generate(page);
    await expect(card.locator('.stale')).toHaveCount(0);

    // 新增第五张同样使已经生成的四图建议 stale。
    const fifthPath = fixturePaths[4];
    if (!fifthPath) throw new Error('第五张图片样例缺失');
    await addImages(app, page, [fifthPath]);
    await expect(card.locator('.stale')).toBeVisible();

    // Pro 明确选择后仍保留模型选择，但请求正文不得携带任何图片块。
    await chooseModel(page, PRO_MODEL);
    for (const thumbnail of await page.locator('.gallery-item .thumb').all()) {
      await thumbnail.scrollIntoViewIfNeeded();
      await expect
        .poll(() => thumbnail.locator('img').evaluate((image: HTMLImageElement) => image.complete))
        .toBe(true);
    }
    await mockSuggestion(app, JSON.stringify({ tags: ['文字'], topicIds: [] }));
    card = await generate(page);
    await expect(
      card.getByText('当前模型不支持图片，建议仅依据文字；切换到 Flash 可让图片参与判断。', {
        exact: true,
      }),
    ).toBeVisible();
    state = await mockState(app);
    expect(state?.calls).toHaveLength(1);
    expect(state?.calls[0]?.model).toBe(PRO_MODEL);
    expect(imageUrls(state)).toEqual([]);
    expect(state?.imageReads).toBe(0);
    expect(typeof userContent(state)).toBe('string');
    expect(await page.evaluate(() => window.memocraft?.ai.loadSettings())).toMatchObject({
      ok: true,
      value: { model: PRO_MODEL },
    });
    await screenshotCard(page, card, join(screenshotDirectory, 'ai-vision-pro.png'));

    // Pro 无图片时仍然是正常文字建议，不显示「图片不支持」错误提示。
    while ((await page.locator('.gallery-item').count()) > 0) await removeImage(page, 0);
    await expect(page.locator('.gallery-item')).toHaveCount(0);
    await mockSuggestion(app, JSON.stringify({ tags: ['文字'], topicIds: [] }));
    card = await generate(page);
    await expect(card.getByRole('alert')).toHaveCount(0);
    await expect(card.locator('.image-feedback')).toHaveCount(0);
    await expect(card.getByRole('button', { name: '文字', exact: true })).toBeVisible();
    expect(imageUrls(await mockState(app))).toEqual([]);

    // 带图在途请求关闭卡片、切页与关闭应用时都应被中止。
    await chooseModel(page, DEFAULT_AI_MODEL);
    const firstPath = fixturePaths[0];
    if (!firstPath) throw new Error('第一张图片样例缺失');
    await addImages(app, page, [firstPath]);
    await mockSuggestion(app, JSON.stringify({ tags: ['取消'], topicIds: [] }), true);
    card = await generate(page);
    const currentApp = app;
    await expect.poll(async () => (await mockState(currentApp))?.calls.length).toBe(1);
    expect(imageUrls(await mockState(app))).toHaveLength(1);
    await card.getByRole('button', { name: '关闭 AI 建议', exact: true }).click();
    await expect.poll(async () => (await mockState(currentApp))?.aborted).toBe(true);
    await expect(card).toHaveCount(0);
    await app.evaluate(() => (globalThis as MockGlobals).memocraftVisionMock?.finish?.());
    await expect(page.getByRole('button', { name: 'AI 建议', exact: true })).toBeEnabled();

    await mockSuggestion(app, JSON.stringify({ tags: ['切页'], topicIds: [] }), true);
    await generate(page);
    await expect.poll(async () => (await mockState(currentApp))?.calls.length).toBe(1);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect.poll(async () => (await mockState(currentApp))?.aborted).toBe(true);
    await app.evaluate(() => (globalThis as MockGlobals).memocraftVisionMock?.finish?.());
    await page.getByRole('button', { name: /^首页/ }).first().click();
    await expect(card).toHaveCount(0);

    let stdout = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await app.evaluate(({ app }) => {
      app.once('will-quit', () => {
        const state = (globalThis as MockGlobals).memocraftVisionMock;
        console.info(
          `MEMOCRAFT_VISION_QUIT:${JSON.stringify({ count: state?.calls.length, aborted: state?.aborted })}`,
        );
      });
    });
    await mockSuggestion(app, JSON.stringify({ tags: ['关闭'], topicIds: [] }), true);
    await generate(page);
    await expect.poll(async () => (await mockState(currentApp))?.calls.length).toBe(1);
    await quit(app);
    app = undefined;
    expect(stdout).toContain('MEMOCRAFT_VISION_QUIT:{"count":1,"aborted":true}');
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：图片尺寸、8 MiB base64 预算与缺失附件安全跳过', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-ai-vision-budget-'));
  const directory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const screenshotDirectory = join(process.cwd(), 'test-results', 'vision-artifacts');
  await mkdir(screenshotDirectory, { recursive: true });
  const oversizedPath = join(root, 'oversized.png');
  const normalPath = join(root, 'normal.png');
  const largePath = join(root, 'large.png');
  const missingPath = join(root, 'missing.png');
  writeFileSync(oversizedPath, oversizedPng());
  writeFileSync(normalPath, PNG_2X3);
  writeFileSync(largePath, largePng());
  writeFileSync(missingPath, pngVariant(99));
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(directory, shellDirectory);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await setKey(page);
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('检查图片尺寸与预算，不能泄露附件路径。');
    await addImages(app, page, [oversizedPath, normalPath]);
    await mockSuggestion(app, JSON.stringify({ tags: ['预算', '截图', '检查'], topicIds: [] }));
    let card = await generate(page);
    await expect(card.getByText('有 1 张图片未参与建议。', { exact: true })).toBeVisible();
    let state = await mockState(app);
    expect(imageUrls(state)).toEqual([
      `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
    ]);
    await screenshotCard(page, card, join(screenshotDirectory, 'ai-vision-size-skip.png'));

    // 用两张图验证精确 8 MiB base64 边界：大图正好纳入，后续图片因预算停止读取。
    while ((await page.locator('.gallery-item').count()) > 0) await removeImage(page, 0);
    await addImages(app, page, [largePath, normalPath]);
    await mockSuggestion(app, JSON.stringify({ tags: ['大图', '预算', '边界'], topicIds: [] }));
    card = await generate(page);
    await expect(card.getByText('有 1 张图片未参与建议。', { exact: true })).toBeVisible();
    state = await mockState(app);
    expect(imageUrls(state)).toHaveLength(1);
    expect(imageUrls(state)[0]).toBe(
      `data:image/png;base64,${Buffer.from(largePng()).toString('base64')}`,
    );

    // 缺失附件仍不阻断后续图片；绝对路径不得进入错误、请求或页面文本。
    while ((await page.locator('.gallery-item').count()) > 0) await removeImage(page, 0);
    await addImages(app, page, [missingPath, normalPath]);
    const imageRows = new DatabaseSync(join(directory, 'memocraft.sqlite'));
    let missingRelativePath = '';
    try {
      const row = imageRows
        .prepare(
          "SELECT relative_path FROM note_images WHERE original_name = 'missing.png' AND deleted_at IS NULL",
        )
        .get();
      if (typeof row?.relative_path !== 'string') throw new Error('缺失附件测试行不存在');
      missingRelativePath = row.relative_path;
    } finally {
      imageRows.close();
    }
    rmSync(join(directory, missingRelativePath), { force: true });
    await mockSuggestion(app, JSON.stringify({ tags: ['缺失', '预算', '安全'], topicIds: [] }));
    card = await generate(page);
    await expect(card.getByText('有 1 张图片未参与建议。', { exact: true })).toBeVisible();
    state = await mockState(app);
    expect(imageUrls(state)).toHaveLength(1);
    expect(state?.calls[0]?.body).not.toContain(directory);
    expect(await page.locator('body').textContent()).not.toContain(directory);
    expect(await page.locator('body').textContent()).not.toContain(missingRelativePath);
    await expect(card.getByRole('alert')).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();

    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
