import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
import type { Note } from '../../src/domain/note';

const testKey = 'test-only-review-point-sources-key';
const summary = [
  '- **网络理解**：本期梳理了网络层次与 ICMP，能够将两个主题关联起来。',
  '- **协议实践**：ICMP 的错误报告与诊断命令有独立的实践记录。',
  '- **随手记录**：未命名的记录同样提供了可分析的学习事实。',
].join('\n');
const fullBody = `ICMP 通过错误报告和查询消息辅助诊断网络。\n${'这段正文用于验证点击手记链接后读取的是完整内容，而不是发送给模型的短摘录。'.repeat(12)}\n完整正文结束标记。`;
interface SourceMockState {
  requests: string[];
  finish?: () => void;
}
type SourceGlobals = typeof globalThis & { memocraftReviewSourcesMock?: SourceMockState };
type ReviewMotionWindow = Window & { reviewLinkMotionReady?: boolean };

/** 记录真实帧和动画启动事件，确认焦点进出不会让已显示的正文重新凝结。 */
async function observeLinkMotion(page: Page, action: () => Promise<void>): Promise<void> {
  await page.evaluate(() => {
    (window as ReviewMotionWindow).reviewLinkMotionReady = false;
  });
  const recorded = page.evaluate(async () => {
    const block = document.querySelector('.review-summary-text');
    if (!(block instanceof HTMLElement)) throw new Error('缺少回顾正文动效块');
    const starts: string[] = [];
    const started = (event: AnimationEvent) => {
      if (event.target === block) starts.push(event.animationName);
    };
    block.addEventListener('animationstart', started);
    (window as ReviewMotionWindow).reviewLinkMotionReady = true;
    const frames: { opacity: number; blur: number; y: number; running: number }[] = [];
    const start = performance.now();
    try {
      while (performance.now() - start < 900) {
        await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
        const style = getComputedStyle(block);
        frames.push({
          opacity: Number.parseFloat(style.opacity),
          blur: Number.parseFloat(/^blur\(([\d.]+)px\)$/.exec(style.filter)?.[1] ?? '0'),
          y: style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m42,
          running: block.getAnimations().filter((animation) => animation.playState === 'running')
            .length,
        });
      }
      return { frames, starts };
    } finally {
      block.removeEventListener('animationstart', started);
    }
  });
  await page.waitForFunction(() => (window as ReviewMotionWindow).reviewLinkMotionReady);
  await action();
  const { frames, starts } = await recorded;
  expect(frames.length).toBeGreaterThan(2);
  expect(starts).toEqual([]);
  for (const frame of frames) expect(frame).toEqual({ opacity: 1, blur: 0, y: 0, running: 0 });
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await closed;
}

/** 仅替换供应商 HTTP；所有数据、配置、来源映射与抽屉读取均使用真实桌面链路。 */
async function mockSources(
  app: ElectronApplication,
  pointSources: number[][],
  text = summary,
  fail = false,
  held = false,
): Promise<void> {
  await app.evaluate(
    ({ net }, input) => {
      const state: SourceMockState = { requests: [] };
      (globalThis as SourceGlobals).memocraftReviewSourcesMock = state;
      net.fetch = async (url, options) => {
        if (
          String(url) !== 'https://api.deepseek.com/chat/completions' ||
          options?.method !== 'POST' ||
          new Headers(options.headers).get('Authorization') !== `Bearer ${input.key}`
        )
          throw new Error('回顾手记链接验收禁止真实外部请求或真实凭据');
        state.requests.push(typeof options.body === 'string' ? options.body : '');
        if (input.fail) return new Response('', { status: 500 });
        const response = () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: input.text,
                      pointSources: input.pointSources,
                      suggestions: ['将网络分层和诊断实践整理为对照。'],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (!input.held) return response();
        // 由测试显式释放供应商响应，让内容树恰好在手记抽屉打开期间替换。
        return new Promise<Response>((resolveResponse) => {
          state.finish = () => {
            state.finish = undefined;
            resolveResponse(response());
          };
        });
      };
    },
    { pointSources, text, fail, held, key: testKey },
  );
}

function requests(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    () => (globalThis as SourceGlobals).memocraftReviewSourcesMock?.requests ?? [],
  );
}

async function releaseSources(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as SourceGlobals).memocraftReviewSourcesMock?.finish?.());
}

async function seedNote(page: Page, title: string, body: string): Promise<Note> {
  const editor = page.getByRole('textbox', { name: '手记正文', exact: true });
  await expect(editor).toBeVisible();
  await editor.fill(body);
  const extras = page.getByRole('button', { name: '补充', exact: true });
  if ((await extras.getAttribute('aria-expanded')) !== 'true') await extras.click();
  await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill(title);
  await page.getByRole('button', { name: '保存手记', exact: true }).click();
  await expect(editor).toHaveValue('');
  const snapshot = await page.evaluate(() => window.memocraft?.load());
  const saved = snapshot?.ok ? snapshot.value.notes.find((note) => note.body === body) : undefined;
  if (!saved) throw new Error('来源验收手记未保存');
  return saved;
}

async function attach(
  app: ElectronApplication,
  shellDirectory: string,
  errors: string[],
): Promise<Page> {
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(shellDirectory);
  await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
  return page;
}

async function openReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '回顾', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回顾', exact: true })).toBeVisible();
}

function cachedSummary(dataDirectory: string) {
  const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'), { readOnly: true });
  try {
    return database.prepare("SELECT * FROM ai_period_summaries WHERE period_type = 'week'").get();
  } finally {
    database.close();
  }
}

/** 大标题跟随主文字主题色，深浅主题均保持可读对比，不在深色主题硬编码黑色。 */
async function verifyHeadings(page: Page): Promise<void> {
  for (const name of ['总结', '推荐']) {
    const heading = page.getByRole('heading', { name, exact: true });
    await expect(heading).toHaveCSS('font-size', '20px');
    await expect(heading).toHaveCSS('font-weight', '700');
    const contrast = await heading.evaluate((element) => {
      const color = getComputedStyle(element).color;
      const bodyStyle = getComputedStyle(document.body);
      const luminance = (value: string) => {
        const components = value
          .match(/\d+(?:\.\d+)?/g)
          ?.slice(0, 3)
          .map(Number);
        if (!components || components.length !== 3) throw new Error('主题颜色不是 RGB');
        const linear = components.map((component) => {
          const channel = component / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return (linear[0] ?? 0) * 0.2126 + (linear[1] ?? 0) * 0.7152 + (linear[2] ?? 0) * 0.0722;
      };
      const foreground = luminance(color);
      const background = luminance(bodyStyle.backgroundColor);
      return {
        color,
        textColor: bodyStyle.color,
        ratio:
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      };
    });
    expect(contrast.color).toBe(contrast.textColor);
    expect(contrast.ratio).toBeGreaterThan(7);
  }
}

test('真实桌面：逐点手记链接、无标题过滤、完整正文、主题与缓存备份恢复', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-point-sources-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const packPath = join(root, 'backup-pack');
  const artifacts = join(process.cwd(), 'test-results', 'review-source-artifacts');
  await mkdir(artifacts, { recursive: true });
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launch(dataDirectory, shellDirectory);
    let page = await attach(app, shellDirectory, errors);
    const osi = await seedNote(page, '网络分层模型', 'OSI 七层与 TCP/IP 四层的对应关系。');
    const icmp = await seedNote(page, 'ICMP 诊断实践', fullBody);
    const untitled = await seedNote(page, '', '未命名的路由练习仍应参与模型分析。');
    const blankTitle = await seedNote(page, '   ', '只有空白标题的分层练习仍应参与模型分析。');
    expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
      ok: true,
      value: null,
    });
    const sortedNotes = [osi, icmp, untitled, blankTitle].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const indexOf = (note: Note) =>
      sortedNotes.findIndex((candidate) => candidate.id === note.id) + 1;
    const sourceGroups = [
      [indexOf(osi), indexOf(icmp), indexOf(osi), 0, -1, 21, 999],
      [indexOf(icmp)],
      [indexOf(untitled), indexOf(blankTitle)],
    ];
    await mockSources(app, sourceGroups);
    await openReview(page);
    const points = page.locator('.review-summary-points > .review-summary-point');
    await expect(points).toHaveCount(3);
    const expectedTitles = sortedNotes
      .filter((note) => note.title.trim())
      .map((note) => note.title);
    await expect(points.nth(0).locator('.review-note-link')).toHaveText(expectedTitles);
    await expect(points.nth(1).locator('.review-note-link')).toHaveText(['ICMP 诊断实践']);
    await expect(points.nth(2).locator('.review-point-notes')).toHaveCount(0);
    await expect(points.nth(2).locator('.review-point-text')).toContainText('未命名的记录同样');
    await expect(page.locator('.review-content')).not.toContainText('来源');
    const prose = points.locator('.review-point-text');
    await expect(prose.locator('button, a')).toHaveCount(0);
    for (const text of await prose.allTextContents()) expect(text).not.toMatch(/\[\d+\]/);
    await expect(page.locator('.review-note-link')).toHaveCount(3);
    const [body] = await requests(app);
    expect(body).toContain('未命名的路由练习仍应参与模型分析');
    expect(body).toContain('只有空白标题的分层练习仍应参与模型分析');
    expect(body).not.toContain('完整正文结束标记');
    expect(body).not.toContain(testKey);
    expect(await requests(app)).toHaveLength(1);
    const row = cachedSummary(dataDirectory);
    expect(row?.summary).toBe(summary);
    const expectedSources = [
      sortedNotes
        .filter((note) => note.title.trim())
        .map((note) => ({ index: indexOf(note), noteId: note.id, title: note.title })),
      [{ index: indexOf(icmp), noteId: icmp.id, title: icmp.title }],
      [],
    ];
    expect(typeof row?.point_sources).toBe('string');
    expect(JSON.parse(String(row?.point_sources))).toEqual(expectedSources);

    // 侧栏按钮文案表示目标主题，默认已浅色时无需点击不存在的「浅色」按钮。
    if ((await page.locator('html').getAttribute('data-theme')) !== 'light')
      await page.getByRole('button', { name: '浅色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await verifyHeadings(page);
    await page.screenshot({
      path: join(artifacts, 'review-sources-light.png'),
      animations: 'disabled',
    });
    const selectedPeriod = await page.locator('.period-trigger').textContent();
    await points.nth(1).getByRole('button', { name: 'ICMP 诊断实践', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '手记详情', exact: true });
    await expect(drawer.getByRole('textbox', { name: '编辑手记正文', exact: true })).toHaveValue(
      fullBody,
    );
    await expect(drawer.getByRole('textbox', { name: '手记标题', exact: true })).toHaveValue(
      icmp.title,
    );
    await drawer.getByRole('button', { name: /关闭/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.period-trigger')).toHaveText(selectedPeriod ?? '');
    expect(await requests(app)).toHaveLength(1);
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await verifyHeadings(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await points.nth(1).locator('.review-note-link').scrollIntoViewIfNeeded();
    const bounds = await points.nth(1).locator('.review-note-link').boundingBox();
    expect(bounds).not.toBeNull();
    if (!bounds) throw new Error('小窗口手记链接没有可点击区域');
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
    await page.screenshot({
      path: join(artifacts, 'review-sources-dark-small.png'),
      animations: 'disabled',
    });

    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, packPath);
    expect(await page.evaluate(() => window.memocraft?.backupLibrary())).toMatchObject({
      ok: true,
    });
    const backupDatabase = new DatabaseSync(join(packPath, 'memocraft.sqlite'), { readOnly: true });
    try {
      expect(
        backupDatabase.prepare('SELECT point_sources FROM ai_period_summaries').get()
          ?.point_sources,
      ).toBe(row?.point_sources);
    } finally {
      backupDatabase.close();
    }

    await quit(app);
    app = undefined;
    app = await launch(dataDirectory, shellDirectory);
    page = await attach(app, shellDirectory, errors);
    await mockSources(app, [], summary, true);
    await openReview(page);
    await expect(page.locator('.review-note-link')).toHaveCount(3);
    expect(await requests(app)).toEqual([]);
    await page.locator('.review-summary-point').nth(1).locator('.review-note-link').click();
    const reopenedDrawer = page.getByRole('dialog', { name: '手记详情', exact: true });
    await expect(
      reopenedDrawer.getByRole('textbox', { name: '编辑手记正文', exact: true }),
    ).toHaveValue(fullBody);
    await reopenedDrawer.getByRole('button', { name: '移到回收站', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '删除手记', exact: true });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '移到回收站', exact: true }).click();
    await expect(reopenedDrawer).toHaveCount(0);
    await page.locator('.review-summary-point').nth(1).locator('.review-note-link').click();
    await expect(
      page.locator('.toast').filter({ hasText: '这条手记已不存在或已移到回收站。' }),
    ).toBeVisible();
    await expect(page.getByRole('dialog', { name: '手记详情', exact: true })).toHaveCount(0);
    expect(await requests(app)).toEqual([]);

    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, packPath);
    await page.getByRole('button', { name: /设置/ }).click();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择备份并校验…', exact: true }).click();
    const restore = page.getByRole('dialog', { name: '从备份恢复', exact: true });
    await expect(restore).toBeVisible();
    await restore.getByRole('button', { name: '开始恢复', exact: true }).click();
    await expect(page.locator('.toast').filter({ hasText: '恢复完成' })).toBeVisible();
    await openReview(page);
    await expect(page.locator('.review-note-link')).toHaveCount(3);
    expect(cachedSummary(dataDirectory)?.point_sources).toBe(row?.point_sources);
    expect(await requests(app)).toEqual([]);
    await page.locator('.review-summary-point').nth(1).locator('.review-note-link').click();
    await expect(
      page
        .getByRole('dialog', { name: '手记详情', exact: true })
        .getByRole('textbox', { name: '编辑手记正文', exact: true }),
    ).toHaveValue(fullBody);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：版本 8 旧段落缓存升级保留，主动生成后获得逐点链接', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-sources-migration-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const errors: string[] = [];
  const legacySummary = '旧版回顾用一段文字记录了网络层次与诊断练习。';
  let app: ElectronApplication | undefined;
  try {
    app = await launch(dataDirectory, shellDirectory);
    const page = await attach(app, shellDirectory, errors);
    const note = await seedNote(page, '网络分层模型', 'OSI 七层与 TCP/IP 四层的对应关系。');
    expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
      ok: true,
      value: null,
    });
    await mockSources(app, [[1]], '- **网络理解**：已记录网络层次。');
    await openReview(page);
    await expect(page.locator('.review-note-link')).toHaveText('网络分层模型');
    await quit(app);
    app = undefined;

    // 离线还原真实版本 8 表结构和段落缓存，重启由应用执行新增迁移。
    const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      database.exec('ALTER TABLE ai_period_summaries DROP COLUMN point_sources');
      database.exec('PRAGMA user_version = 8');
      database.prepare('UPDATE ai_period_summaries SET summary = ?').run(legacySummary);
    } finally {
      database.close();
    }
    app = await launch(dataDirectory, shellDirectory);
    const reopened = await attach(app, shellDirectory, errors);
    await mockSources(app, [[1]], '- **网络理解**：重新生成后分点展示网络层次。');
    await openReview(reopened);
    await expect(reopened.locator('.summary-text > p')).toHaveText(legacySummary);
    await expect(reopened.locator('.review-note-link')).toHaveCount(0);
    expect(cachedSummary(dataDirectory)?.point_sources).toBeNull();
    expect(await requests(app)).toEqual([]);
    await reopened.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(reopened.locator('.review-point-text')).toContainText(
      '重新生成后分点展示网络层次',
    );
    await expect(reopened.locator('.review-note-link')).toHaveText('网络分层模型');
    expect(JSON.parse(String(cachedSummary(dataDirectory)?.point_sources))).toEqual([
      [{ index: 1, noteId: note.id, title: note.title }],
    ]);
    expect(await requests(app)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：点击与键盘查看手记、返回和移开焦点均不重播回顾凝结', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-link-motion-'));
  const shellDirectory = join(root, 'shell');
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launch(join(root, 'data'), shellDirectory);
    const page = await attach(app, shellDirectory, errors);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const note = await seedNote(page, 'ICMP 诊断实践', fullBody);
    expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
      ok: true,
      value: null,
    });
    await mockSources(app, [[1]], '- **协议实践**：记录了诊断原理与命令。');
    await openReview(page);
    const block = page.locator('.review-summary-text');
    await expect
      .poll(() =>
        block.evaluate(
          (element) =>
            element.getAnimations().filter((animation) => animation.playState === 'running').length,
        ),
      )
      .toBe(0);
    const original = await block.elementHandle();
    if (!original) throw new Error('缺少原正文节点');
    const link = page.locator(`.review-note-link[data-note-id="${note.id}"]`);
    const drawer = page.getByRole('dialog', { name: '手记详情', exact: true });
    const editor = drawer.getByRole('textbox', { name: '编辑手记正文', exact: true });
    await observeLinkMotion(page, async () => {
      await link.click();
      await expect(editor).toHaveValue(fullBody);
    });
    await observeLinkMotion(page, async () => {
      await editor.press('Escape');
      await expect(drawer).toHaveCount(0);
      await expect(link).toBeFocused();
    });
    await observeLinkMotion(page, async () => {
      await page.getByRole('heading', { name: '回顾', exact: true }).focus();
      await link.focus();
      await link.press('Enter');
      await expect(editor).toHaveValue(fullBody);
    });
    await observeLinkMotion(page, async () => {
      await editor.press('Escape');
      await expect(drawer).toHaveCount(0);
      await page.getByRole('heading', { name: '回顾', exact: true }).focus();
    });
    expect(await original.evaluate((element) => element.isConnected)).toBe(true);
    expect(await requests(app)).toHaveLength(1);
    expect(errors).toEqual([]);
    await original.dispose();
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：回顾刷新期间键盘查看旧链接，关闭抽屉后找回新树焦点', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-source-focus-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const errors: string[] = [];
  let app: ElectronApplication | undefined;
  try {
    app = await launch(dataDirectory, shellDirectory);
    const runningApp = app;
    const page = await attach(app, shellDirectory, errors);
    const osi = await seedNote(page, '网络分层模型', 'OSI 与 TCP/IP 分层关系。');
    const icmp = await seedNote(page, 'ICMP 诊断实践', fullBody);
    const sorted = [osi, icmp].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const osiIndex = sorted.findIndex((note) => note.id === osi.id) + 1;
    const icmpIndex = sorted.findIndex((note) => note.id === icmp.id) + 1;
    expect(await page.evaluate((key) => window.memocraft?.ai.saveKey(key), testKey)).toEqual({
      ok: true,
      value: null,
    });
    const initialSummary = '- **网络层次**：已记录分层关系。\n- **诊断实践**：已练习 ICMP。';
    await mockSources(app, [[osiIndex], [icmpIndex]], initialSummary);
    await openReview(page);
    const sourceLink = page.locator(`button.review-note-link[data-note-id="${icmp.id}"]`);
    await expect(sourceLink).toHaveCount(1);
    const firstGeneratedAt = await page.locator('.summary-generated time').getAttribute('datetime');
    if (!firstGeneratedAt) throw new Error('初始回顾未显示生成时间');

    const refreshedSummary =
      '- **网络层次**：第一次刷新仍保留分层。\n- **诊断实践**：第一次刷新仍引用 ICMP。';
    await mockSources(app, [[osiIndex], [icmpIndex]], refreshedSummary, false, true);
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect.poll(async () => (await requests(runningApp)).length).toBe(1);
    const originalElement = await sourceLink.elementHandle();
    if (!originalElement) throw new Error('原手记链接没有真实节点');
    // 真实 Enter 激活手记、Escape 关闭；不得用组件事件替身绕过浏览器焦点行为。
    await sourceLink.focus();
    await sourceLink.press('Enter');
    const drawer = page.getByRole('dialog', { name: '手记详情', exact: true });
    const editor = drawer.getByRole('textbox', { name: '编辑手记正文', exact: true });
    await expect(editor).toHaveValue(fullBody);
    await releaseSources(app);
    await expect(page.locator('.review-point-text').last()).toContainText('第一次刷新仍引用 ICMP');
    await expect(page.locator('.review-content-leave-active')).toHaveCount(0);
    await expect(page.locator('.summary-generated time')).not.toHaveAttribute(
      'datetime',
      firstGeneratedAt,
    );
    await expect.poll(() => originalElement.evaluate((element) => element.isConnected)).toBe(false);
    await editor.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(sourceLink).toBeFocused();
    await originalElement.dispose();

    const secondGeneratedAt = await page
      .locator('.summary-generated time')
      .getAttribute('datetime');
    if (!secondGeneratedAt) throw new Error('第一次刷新未显示生成时间');
    const withoutIcmp = '- **网络层次**：第二次刷新只保留网络分层，取消 ICMP 引用。';
    await mockSources(app, [[osiIndex]], withoutIcmp, false, true);
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect.poll(async () => (await requests(runningApp)).length).toBe(1);
    await sourceLink.focus();
    await sourceLink.press('Enter');
    await expect(editor).toHaveValue(fullBody);
    await releaseSources(app);
    await expect(page.locator('.review-point-text').last()).toContainText(
      '第二次刷新只保留网络分层',
    );
    await expect(page.locator('.review-content-leave-active')).toHaveCount(0);
    await expect(page.locator('.summary-generated time')).not.toHaveAttribute(
      'datetime',
      secondGeneratedAt,
    );
    await expect(sourceLink).toHaveCount(0);
    await editor.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '回顾', exact: true })).toBeFocused();
    expect(await requests(app)).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
