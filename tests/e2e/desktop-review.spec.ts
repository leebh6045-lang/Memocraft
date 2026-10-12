import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import type { AiContentBlock, AiPeriodSummaryInput } from '../../src/shared/ai';
import { PNG_2X3 } from '../fixtures/images';

interface ReviewMockState {
  requests: Array<{ body: string; aborted: boolean }>;
  finish?: () => void;
  pausedReply?: unknown;
}
type ReviewGlobals = typeof globalThis & { memocraftReviewMock?: ReviewMockState };
type ReviewWindow = Window & {
  reviewProbe?: Promise<unknown>;
  reviewLoadingSeen?: boolean;
  reviewUnsafeExecuted?: number;
};

interface SummaryPoint {
  title: string;
  detail: string;
}

const defaultPoints: SummaryPoint[] = [
  {
    title: 'Vue 响应式访问（重点）',
    detail:
      '本期的核心记录是 Vue 响应式的访问方式，明确区分 ref 的 value 访问与 reactive 的属性访问。记录给出了具体对象和访问边界，比只记术语更容易核对实际代码，这一部分值得重点展开并沉淀为对照。',
  },
  { title: '使用边界', detail: '正文清楚地区分了两种访问形式。' },
  { title: '积累范围', detail: '当前记录集中在一个知识点。' },
];

function summaryMarkdown(points: SummaryPoint[]): string {
  return points.map((point) => `- **${point.title}**：${point.detail}`).join('\n');
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

/** 只替身供应商网络；真实 IPC、凭据、SQLite、读图与取消排空仍参与验收。 */
async function mockReview(
  app: ElectronApplication,
  options: {
    summary?: string;
    suggestions?: string[];
    status?: number;
    held?: boolean;
    probeRequestId?: string;
  } = {},
): Promise<void> {
  await app.evaluate(
    ({ net, BrowserWindow }, input) => {
      const state: ReviewMockState = { requests: [] };
      (globalThis as ReviewGlobals).memocraftReviewMock = state;
      net.fetch = async (url, request) => {
        if (String(url) !== 'https://api.deepseek.com/chat/completions')
          throw new Error(`unexpected URL ${String(url)}`);
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
                    content: JSON.stringify({
                      summary: input.summary,
                      pointSources: input.pointSources,
                      suggestions: input.suggestions ?? [
                        '整理一份响应式访问方式的对照表。',
                        '用组件练习核对两种访问方式。',
                      ],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: input.status ?? 200, headers: { 'content-type': 'application/json' } },
          );
        if (!input.held) return response();
        // 故意不在 abort 时结算供应商 Promise，验证真实客户端仍能取消和排空。
        return new Promise<Response>((resolveResponse) => {
          state.finish = () => {
            state.finish = undefined;
            resolveResponse(response());
          };
          const abort = () => {
            record.aborted = true;
            if (input.probeRequestId) {
              void BrowserWindow.getAllWindows()[0]
                ?.webContents.executeJavaScript(
                  `Promise.all([window.memocraft.ai.loadSettings(), window.memocraft.ai.cancelPeriodSummary(${JSON.stringify(input.probeRequestId)})])`,
                )
                .then((value: unknown) => {
                  state.pausedReply = value;
                });
            }
          };
          if (request?.signal?.aborted) abort();
          else request?.signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    {
      ...options,
      // 正常供应商结果遵守新的逐点契约；没有来源仍须显式携带同数量的空组。
      summary: (options.summary ?? summaryMarkdown(defaultPoints)).startsWith('- ')
        ? (options.summary ?? summaryMarkdown(defaultPoints))
        : `- ${options.summary}`,
      pointSources: (options.summary ?? summaryMarkdown(defaultPoints))
        .split('\n')
        .filter((line) => line.trim())
        .map(() => [] as number[]),
    },
  );
}

async function mockState(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = (globalThis as ReviewGlobals).memocraftReviewMock;
    return state && { requests: state.requests, pausedReply: state.pausedReply };
  });
}

async function releaseReview(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as ReviewGlobals).memocraftReviewMock?.finish?.());
}

async function openReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '回顾', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回顾', exact: true })).toBeVisible();
}

async function openPeriodPicker(page: Page): Promise<Locator> {
  const trigger = page.locator('.period-trigger');
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(trigger).toHaveAttribute('aria-label', /^选择回顾时间段：/);
  await expect(trigger).toHaveAttribute(
    'aria-label',
    `选择回顾时间段：${(await trigger.textContent())?.trim() ?? ''}`,
  );
  await trigger.click();
  const list = page.getByRole('listbox', { name: '选择回顾时间段', exact: true });
  await expect(list).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  return list;
}

async function choosePeriod(page: Page, startDate: string): Promise<void> {
  const list = await openPeriodPicker(page);
  await list.locator(`[role="option"][data-start-date="${startDate}"]`).click();
  await expect(list).toHaveCount(0);
  await expect(page.locator('.period-trigger')).toHaveAttribute('aria-expanded', 'false');
}

/** 真正打开列表并操作键盘，不以内部周期方法代替用户交互。 */
async function verifyPicker(page: Page, unit: 'week' | 'month') {
  const list = await openPeriodPicker(page);
  const options = list.getByRole('option');
  await expect(options).toHaveCount(12);
  await expect(options.first()).toBeFocused();
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.first()).toContainText(unit === 'week' ? '本周' : '本月');
  await expect(options.first().locator('svg')).toHaveCount(1);
  const dates = await options.evaluateAll((items) =>
    items.map((item) => item.getAttribute('data-start-date') ?? ''),
  );
  const today = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  });
  for (const [index, date] of dates.entries()) {
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(date <= today).toBe(true);
    const previous = dates[index - 1];
    if (!previous) continue;
    expect(date < previous).toBe(true);
    const newer = new Date(`${previous}T00:00:00Z`);
    const older = new Date(`${date}T00:00:00Z`);
    if (unit === 'week') expect(newer.getTime() - older.getTime()).toBe(7 * 86_400_000);
    else {
      expect(date.endsWith('-01')).toBe(true);
      expect(
        newer.getUTCFullYear() * 12 +
          newer.getUTCMonth() -
          older.getUTCFullYear() * 12 -
          older.getUTCMonth(),
      ).toBe(1);
    }
  }
  if (unit === 'month') {
    const oldest = dates.at(-1);
    if (!oldest) throw new Error('月份选项不存在');
    const oldestText = await options.last().textContent();
    if (oldest.slice(0, 4) !== today.slice(0, 4))
      expect(oldestText).toContain(`${oldest.slice(0, 4)}年`);
  }
  await options.first().press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await options.nth(1).press('ArrowUp');
  await expect(options.first()).toBeFocused();
  await options.first().press('End');
  await expect(options.last()).toBeFocused();
  await options.last().press('Home');
  await expect(options.first()).toBeFocused();
  await options.first().press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.locator('.period-trigger')).toBeFocused();
  const keyboardList = await openPeriodPicker(page);
  await keyboardList.getByRole('option').first().press('Shift+Tab');
  await expect(page.locator('.period-trigger')).toBeFocused();
  await page.locator('.period-trigger').press('ArrowDown');
  await expect(keyboardList.getByRole('option').first()).toBeFocused();
  await keyboardList.getByRole('option').first().press('Shift+Tab');
  await page.locator('.period-trigger').press('Escape');
  await expect(keyboardList).toHaveCount(0);
  const tabList = await openPeriodPicker(page);
  await tabList.getByRole('option').first().press('Tab');
  await expect(tabList).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新生成', exact: true })).toBeFocused();
  await openPeriodPicker(page);
  // 从列表外的真实坐标关闭（遮罩截获该点击），随后焦点仍还给触发按钮。
  await page.getByRole('heading', { name: '回顾', exact: true }).click({ force: true });
  await expect(page.getByRole('listbox', { name: '选择回顾时间段', exact: true })).toHaveCount(0);
  await expect(page.locator('.period-trigger')).toBeFocused();
  const [current, previous] = dates;
  if (!current || !previous) throw new Error('当前或历史周期选项不存在');
  return { current, previous };
}

/** 平铺正文应完整参与布局；背景/边框/阴影不再把内容包成卡片。 */
async function verifyFlatContent(page: Page): Promise<void> {
  await expect(
    page.locator('.review-card, .summary-card, .suggestions-card, .skeleton-card'),
  ).toHaveCount(0);
  const styles = await page.locator('.review-content-frame').evaluate((frame) => {
    const selectors = [
      '.review-section',
      '.review-summary-text',
      '.review-suggestions',
      '.summary-meta',
    ];
    return selectors
      .flatMap((selector) => Array.from(frame.querySelectorAll<HTMLElement>(selector)))
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          shadow: style.boxShadow,
          background: style.backgroundColor,
          borders: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
        };
      });
  });
  expect(styles.length).toBeGreaterThanOrEqual(3);
  for (const style of styles) {
    expect(style.shadow).toBe('none');
    expect(style.background).toMatch(/(?:rgba\(0, 0, 0, 0\)|transparent)/);
    // 元信息允许单条细分隔线，不能出现四边围合的卡片边框。
    expect(style.borders.some((width) => Number.parseFloat(width) === 0)).toBe(true);
  }
  const prose = await page.locator('.review-summary-text').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      clamp: style.webkitLineClamp,
      height: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(['none', '']).toContain(prose.clamp);
  expect(prose.scrollHeight).toBeLessThanOrEqual(prose.height + 1);
  await expect(page.locator('.review-suggestions')).toHaveCSS('list-style-type', 'disc');
  const suggestions = await page.locator('.review-suggestions').evaluate((list) => ({
    indent: Number.parseFloat(getComputedStyle(list).paddingInlineStart),
    lines: Array.from(list.querySelectorAll('li')).map(
      (item) => getComputedStyle(item).borderBottomWidth,
    ),
  }));
  expect(suggestions.indent).toBeGreaterThan(0);
  expect(suggestions.lines.length).toBeGreaterThan(0);
  for (const border of suggestions.lines) expect(Number.parseFloat(border)).toBe(0);
}

/** 断言实际安全渲染的主题列表与强调层级，首要主题需要展开而非等权罗列。 */
async function verifyThemedSummary(page: Page, points: SummaryPoint[]): Promise<void> {
  const summary = page.locator('.summary-text');
  await expect(summary.locator(':scope > ul')).toHaveCount(1);
  const items = summary.locator(':scope > ul > li');
  await expect(items).toHaveCount(points.length);
  for (const [index, point] of points.entries()) {
    await expect(items.nth(index).locator('strong')).toHaveText(point.title);
    await expect(items.nth(index)).toContainText(point.detail);
  }
  const details = await items.evaluateAll((rows) =>
    rows.map(
      (item) =>
        (item.textContent?.trim().length ?? 0) -
        (item.querySelector('strong')?.textContent?.length ?? 0),
    ),
  );
  const [main, ...secondary] = details;
  if (main === undefined || !secondary.length) throw new Error('主题测试需要首要与次要积累');
  expect(main).toBeGreaterThan(secondary.reduce((total, length) => total + length, 0));
}

async function seedNote(
  page: Page,
  title: string,
  body: string,
  app?: ElectronApplication,
  imagePaths: string[] = [],
): Promise<string> {
  const editor = page.getByRole('textbox', { name: '手记正文', exact: true });
  await editor.fill(body);
  const extras = page.getByRole('button', { name: '补充', exact: true });
  if ((await extras.getAttribute('aria-expanded')) !== 'true') await extras.click();
  await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill(title);
  if (imagePaths.length) {
    if (!app) throw new Error('添加测试图片需要 Electron 应用');
    await app.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
    }, imagePaths);
    await page.getByRole('button', { name: '添加图片', exact: true }).click();
    await expect(page.locator('.gallery-item')).toHaveCount(imagePaths.length);
  }
  await page.getByRole('button', { name: '保存手记', exact: true }).click();
  await expect(editor).toHaveValue('');
  const result = await page.evaluate(() => window.memocraft?.load());
  const saved = result?.ok ? result.value.notes.find((note) => note.title === title) : undefined;
  if (!saved) throw new Error('测试手记未成功保存');
  return saved.id;
}

async function currentInput(page: Page, regenerate = false): Promise<AiPeriodSummaryInput> {
  // 取桌面进程的本地日历日期，不用执行机 UTC 日期代替用户所在周期。
  const startDate = await page.evaluate(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  });
  return { requestId: randomUUID(), periodType: 'week', startDate, regenerate };
}

function cacheRows(dataDirectory: string) {
  const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT * FROM ai_period_summaries ORDER BY period_type, start_date')
      .all();
  } finally {
    database.close();
  }
}

test('真实桌面：回顾引导、自动生成、持久缓存、周期导航与失败重试', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-desktop-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const artifacts = join(process.cwd(), 'test-results', 'review-artifacts');
  await mkdir(artifacts, { recursive: true });
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(dataDirectory, shellDirectory);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await mockReview(app);
    await page.evaluate(() => {
      const state = window as ReviewWindow;
      state.reviewLoadingSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[role="status"][aria-label="正在生成回顾"]'))
          state.reviewLoadingSeen = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
    await openReview(page);
    await expect(page.getByRole('button', { name: '前往设置', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: '正在生成回顾' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as ReviewWindow).reviewLoadingSeen)).toBe(false);
    expect((await mockState(app))?.requests).toHaveLength(0);

    await page.getByRole('button', { name: '前往设置', exact: true }).click();
    const settings = page.getByRole('region', { name: 'AI 设置', exact: true });
    await settings.locator('#ai-key').fill('test-only-period-review-key');
    await settings.getByRole('button', { name: '保存密钥', exact: true }).click();
    await expect(settings.locator('label[for="ai-key"] .pr-hint')).toHaveText('已配置');
    await page.getByRole('button', { name: /^首页/ }).first().click();
    await seedNote(page, 'Vue 响应式访问', 'ref 使用 value 访问，reactive 直接访问属性。');
    const before = await page.evaluate(() => window.memocraft?.load());

    await mockReview(app, { held: true });
    const firstApp = app;
    await openReview(page);
    await expect(page.getByRole('status', { name: '正在生成回顾' })).toBeVisible();
    await expect.poll(async () => (await mockState(firstApp))?.requests.length).toBe(1);
    await releaseReview(app);
    await expect(page.locator('.summary-text')).toContainText('本期的核心记录是 Vue 响应式');
    await expect(page.getByRole('heading', { name: '总结', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '推荐', exact: true })).toBeVisible();
    await verifyThemedSummary(page, defaultPoints);
    await expect(page.locator('.review-suggestions li').first()).toContainText(
      '整理一份响应式访问方式的对照表',
    );
    await expect(page.getByRole('button', { name: /^(上一|下一)(周|月)$/ })).toHaveCount(0);
    const weekPeriods = await verifyPicker(page, 'week');
    await verifyFlatContent(page);
    const firstTime = await page.locator('.summary-generated time').getAttribute('datetime');
    expect(cacheRows(dataDirectory)).toHaveLength(1);
    const initialBody = (await mockState(app))?.requests[0]?.body ?? '';
    expect(initialBody).toContain('Vue 响应式访问');
    expect(initialBody).not.toContain('test-only-period-review-key');
    expect(JSON.parse(initialBody)).toMatchObject({
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 1024,
    });
    await page.screenshot({ path: join(artifacts, 'review-light.png'), animations: 'disabled' });
    const previewList = await openPeriodPicker(page);
    // toBeVisible 不检查透明度；截图等真实进场完成，避免保存仍为透明的首帧。
    await expect(previewList).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: join(artifacts, 'review-period-picker-light.png'),
      animations: 'disabled',
    });
    await previewList.getByRole('option').first().press('Escape');

    const refreshedPoints: SummaryPoint[] = [
      {
        title: '响应式访问方式（重点）',
        detail: `重新生成后归纳了响应式访问方式。${'这些知识来自实际练习，可以逐条对照手记并整理差异。'.repeat(12)}正文结束处仍应完整展示。`,
      },
      { title: '使用边界', detail: 'ref 与 reactive 的访问形式已分别记录。' },
      { title: '后续积累', detail: '现有知识点可以在实践中继续核对。' },
    ];
    const refreshed = summaryMarkdown(refreshedPoints);
    await mockReview(app, {
      summary: refreshed,
      suggestions: ['写一个 ref 与 reactive 的对照示例。', '把两种访问方式与现有手记逐条核对。'],
    });
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await verifyThemedSummary(page, refreshedPoints);
    const refreshedTime = await page.locator('.summary-generated time').getAttribute('datetime');
    expect(refreshedTime).not.toBe(firstTime);
    expect(cacheRows(dataDirectory)).toMatchObject([
      { summary: refreshed, generated_at: refreshedTime, note_count: 1 },
    ]);
    expect(await page.evaluate(() => window.memocraft?.load())).toEqual(before);
    await verifyFlatContent(page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await expect(page.locator('.review-summary-text')).toContainText('正文结束处仍应完整展示。');
    await page.screenshot({
      path: join(artifacts, 'review-flat-long-light-small.png'),
      animations: 'disabled',
    });

    // 切页与重启都保留同一缓存；设置为失败网络以证明没有重新生成。
    await mockReview(app, { status: 500 });
    const selectedPeriod = await page.locator('.period-trigger').textContent();
    await page.getByRole('button', { name: /^首页/ }).first().click();
    await openReview(page);
    await expect(page.locator('.period-trigger')).toHaveText(selectedPeriod ?? '');
    await verifyThemedSummary(page, refreshedPoints);
    expect((await mockState(app))?.requests).toHaveLength(0);
    await quit(app);
    app = undefined;
    app = await launch(dataDirectory, shellDirectory);
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await mockReview(app, { status: 500 });
    await openReview(reopened);
    await verifyThemedSummary(reopened, refreshedPoints);
    await expect(reopened.locator('.summary-generated time')).toHaveAttribute(
      'datetime',
      refreshedTime ?? '',
    );
    expect((await mockState(app))?.requests).toHaveLength(0);

    // 刷新失败保留旧结果和生成时间；重试先查持久缓存，不额外发 HTTP。
    await reopened.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(reopened.getByRole('alert')).toContainText('DeepSeek 服务暂时不可用');
    await verifyThemedSummary(reopened, refreshedPoints);
    await expect(reopened.locator('.summary-generated time')).toHaveAttribute(
      'datetime',
      refreshedTime ?? '',
    );
    expect((await mockState(app))?.requests).toHaveLength(1);
    await mockReview(app, { status: 500 });
    await reopened.getByRole('button', { name: '重试', exact: true }).click();
    await expect(reopened.getByRole('alert')).toHaveCount(0);
    await verifyThemedSummary(reopened, refreshedPoints);
    expect((await mockState(app))?.requests).toHaveLength(0);

    const weekList = await openPeriodPicker(reopened);
    await weekList.getByRole('option').first().press('ArrowDown');
    await expect(weekList.getByRole('option').nth(1)).toBeFocused();
    await weekList.getByRole('option').nth(1).press('Enter');
    await expect(weekList).toHaveCount(0);
    await expect(reopened.locator('.period-trigger')).toBeFocused();
    await expect(reopened.getByText('这段时间没有新手记。', { exact: true })).toBeVisible();
    await expect(reopened.getByRole('status', { name: '正在生成回顾' })).toHaveCount(0);
    expect((await mockState(app))?.requests).toHaveLength(0);
    expect(cacheRows(dataDirectory)).toHaveLength(1);
    const previousPeriod = await reopened.locator('.period-trigger').textContent();
    await reopened.getByRole('button', { name: /^首页/ }).first().click();
    await openReview(reopened);
    await expect(reopened.locator('.period-trigger')).toHaveText(previousPeriod ?? '');
    await expect(reopened.getByText('这段时间没有新手记。', { exact: true })).toBeVisible();
    expect((await mockState(app))?.requests).toHaveLength(0);
    const selectedList = await openPeriodPicker(reopened);
    await expect(selectedList.getByRole('option').first()).toBeFocused();
    await expect(
      selectedList.locator(`[role="option"][data-start-date="${weekPeriods.previous}"]`),
    ).toHaveAttribute('aria-selected', 'true');
    await selectedList.locator(`[role="option"][data-start-date="${weekPeriods.current}"]`).click();
    await verifyThemedSummary(reopened, refreshedPoints);
    expect((await mockState(app))?.requests).toHaveLength(0);

    // 旧版缓存可以是段落且没有逐点来源，不能用新供应商响应伪装兼容数据。
    const monthStart = await reopened.evaluate(() => {
      const today = new Date();
      return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
    });
    const legacyDatabase = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'));
    try {
      legacyDatabase
        .prepare(
          `INSERT INTO ai_period_summaries
            (period_type, start_date, summary, suggestions, note_count, generated_at, point_sources)
           VALUES ('month', ?, ?, '[]', 1, ?, NULL)`,
        )
        .run(
          monthStart,
          '本月集中记录了 Vue 的响应式知识。可以继续整理访问规则。',
          new Date().toISOString(),
        );
    } finally {
      legacyDatabase.close();
    }
    await reopened.getByRole('tab', { name: '按月', exact: true }).click();
    await expect(reopened.getByRole('tab', { name: '按月', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(reopened.locator('.summary-text')).toContainText('本月集中记录');
    // 已有段落式结果照常渲染，不要求重新计费才能读取旧缓存。
    await expect(reopened.locator('.summary-text > p')).toHaveCount(1);
    await expect(reopened.locator('.summary-text > ul')).toHaveCount(0);
    await expect(reopened.locator('.period-trigger')).toHaveText(/^\d{4}年\d{1,2}月$/);
    const monthPeriods = await verifyPicker(reopened, 'month');
    expect((await mockState(app))?.requests).toHaveLength(0);
    expect(cacheRows(dataDirectory)).toHaveLength(2);
    await reopened.getByRole('button', { name: '深色', exact: true }).click();
    await expect(reopened.locator('html')).toHaveAttribute('data-theme', 'dark');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    // 长概要按周缓存完整呈现，暗色小窗同样无卡片、无行数限制。
    await reopened.getByRole('tab', { name: '按周', exact: true }).click();
    await verifyThemedSummary(reopened, refreshedPoints);
    await verifyFlatContent(reopened);
    expect(
      await reopened.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await reopened.screenshot({
      path: join(artifacts, 'review-flat-long-dark-small.png'),
      animations: 'disabled',
    });
    await reopened.getByRole('tab', { name: '按月', exact: true }).click();
    await expect(reopened.locator('.summary-text')).toContainText('本月集中记录');
    await choosePeriod(reopened, monthPeriods.previous);
    await expect(reopened.getByText('这段时间没有新手记。', { exact: true })).toBeVisible();
    expect((await mockState(app))?.requests).toHaveLength(0);

    // Markdown 只格式化文字：供应商原始 HTML、图片与危险链接都不能获得执行能力。
    await choosePeriod(reopened, monthPeriods.current);
    await expect(reopened.locator('.summary-text')).toContainText('本月集中记录');
    const unsafePoints: SummaryPoint[] = [
      {
        title: '安全显示（重点）',
        detail:
          '原始供应商文本须作为记录呈现：<img src=x onerror="window.reviewUnsafeExecuted=1"> <script>window.reviewUnsafeExecuted=2</script> [危险链接](javascript:window.reviewUnsafeExecuted=3) <https://example.invalid> ![外部图片](https://example.invalid/private.png)。这些内容只供阅读，不应执行。',
      },
      { title: '记录边界', detail: '只阅读本地手记提供的事实。' },
    ];
    await reopened.evaluate(() => {
      (window as ReviewWindow).reviewUnsafeExecuted = 0;
    });
    await mockReview(app, { summary: summaryMarkdown(unsafePoints) });
    await reopened.getByRole('button', { name: '重新生成', exact: true }).click();
    await verifyThemedSummary(reopened, unsafePoints);
    await expect(
      reopened.locator(
        '.summary-text img, .summary-text script, .summary-text a, .summary-text iframe',
      ),
    ).toHaveCount(0);
    expect(await reopened.evaluate(() => (window as ReviewWindow).reviewUnsafeExecuted)).toBe(0);
    expect((await mockState(app))?.requests).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

// 不借助 renderer API 替身：旧供应商响应迟到也不能落库，恢复与关闭都需完成排空。
test('真实桌面：回顾切页取消、恢复白名单、失败回滚与关闭排空', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-lifecycle-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const packPath = join(root, 'backup-pack');
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(dataDirectory, shellDirectory);
    const firstApp = app;
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    const noteId = await seedNote(page, 'SQLite 事务知识', 'SQLite 事务用于保持原子性。');
    expect(
      await page.evaluate(() => window.memocraft?.ai.saveKey('test-only-review-lifecycle-key')),
    ).toEqual({ ok: true, value: null });
    await mockReview(app, { held: true, summary: '切页后的迟到结果不得写入缓存。' });
    await openReview(page);
    await expect.poll(async () => (await mockState(firstApp))?.requests.length).toBe(1);
    await page.getByRole('button', { name: /^首页/ }).first().click();
    await expect.poll(async () => (await mockState(firstApp))?.requests[0]?.aborted).toBe(true);
    await releaseReview(app);
    expect(cacheRows(dataDirectory)).toEqual([]);

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
    const input = await currentInput(page);
    await mockReview(app, {
      held: true,
      probeRequestId: input.requestId,
      summary: '恢复前旧库的迟到结果。',
    });
    await page.evaluate((request) => {
      (window as ReviewWindow).reviewProbe = window.memocraft?.ai.summarizePeriod(request);
    }, input);
    await expect.poll(async () => (await mockState(firstApp))?.requests.length).toBe(1);
    expect(await page.evaluate(() => window.memocraft?.applyRestore())).toEqual({
      ok: true,
      value: null,
    });
    await expect.poll(async () => (await mockState(firstApp))?.requests[0]?.aborted).toBe(true);
    await expect
      .poll(async () => (await mockState(firstApp))?.pausedReply)
      .toEqual([
        {
          ok: false,
          error: { code: 'UNAVAILABLE', message: '正在关闭或恢复知识库，请稍后重试。' },
        },
        { ok: true, value: null },
      ]);
    expect(await page.evaluate(() => (window as ReviewWindow).reviewProbe)).toMatchObject({
      ok: false,
      error: { code: 'AI_CANCELLED' },
    });
    await releaseReview(app);
    expect(cacheRows(dataDirectory)).toEqual([]);
    expect(await page.evaluate(() => window.memocraft?.load())).toMatchObject({
      ok: true,
      value: { notes: [expect.objectContaining({ id: noteId })] },
    });

    // 暂存库在校验后损坏仍应回滚并保留窗口，回顾入口恢复可用。
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
    await mockReview(app, {
      summary: '恢复失败后仍能回顾 SQLite 事务。可以整理事务的原子性保证。',
    });
    expect(
      await page.evaluate(
        (request) => window.memocraft?.ai.summarizePeriod(request),
        await currentInput(page),
      ),
    ).toMatchObject({ ok: true, value: { noteCount: 1 } });
    const stableCache = cacheRows(dataDirectory);
    expect(stableCache).toHaveLength(1);

    let stdout = '';
    app.process().stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    await app.evaluate(({ app }) => {
      app.once('will-quit', () => {
        const state = (globalThis as ReviewGlobals).memocraftReviewMock;
        console.info(
          `MEMOCRAFT_REVIEW_QUIT:${JSON.stringify({ calls: state?.requests.length, aborted: state?.requests[0]?.aborted })}`,
        );
      });
    });
    await mockReview(app, { held: true, summary: '关闭窗口后的迟到结果。' });
    await openReview(page);
    await expect(page.locator('.summary-text')).toContainText('恢复失败后仍能回顾');
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect.poll(async () => (await mockState(firstApp))?.requests.length).toBe(1);
    await quit(app);
    app = undefined;
    expect(stdout).toContain('MEMOCRAFT_REVIEW_QUIT:{"calls":1,"aborted":true}');
    expect(cacheRows(dataDirectory)).toEqual(stableCache);
    app = await launch(dataDirectory, shellDirectory);
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await mockReview(app, { status: 500 });
    await openReview(reopened);
    await expect(reopened.locator('.summary-text')).toContainText('恢复失败后仍能回顾');
    expect((await mockState(app))?.requests).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：Flash 回顾图片紧跟所属手记，缺失跳过与 Pro 文字回顾', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-images-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const firstPath = join(root, 'first.png');
  const ignoredPath = join(root, 'second-in-same-note.png');
  const otherPath = join(root, 'other.png');
  const missingPath = join(root, 'missing.png');
  const otherBytes = Uint8Array.from([...PNG_2X3, 42]);
  const ignoredBytes = Uint8Array.from([...PNG_2X3, 99]);
  await writeFile(firstPath, PNG_2X3);
  await writeFile(ignoredPath, ignoredBytes);
  await writeFile(otherPath, otherBytes);
  await writeFile(missingPath, Uint8Array.from([...PNG_2X3, 7]));
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(dataDirectory, shellDirectory);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => window.memocraft?.ai.saveKey('test-only-review-images-key')),
    ).toEqual({ ok: true, value: null });
    const firstId = await seedNote(page, '第一条图文手记', '第一幅截图说明 ref 使用方式。', app, [
      firstPath,
      ignoredPath,
    ]);
    await seedNote(page, '纯文字补充手记', 'reactive 直接访问属性，不包含图片。');
    const otherId = await seedNote(page, '第二条图文手记', '第二幅截图说明事务原子性。', app, [
      otherPath,
    ]);
    await seedNote(page, '缺失图片手记', '附件缺失仍保留文字事实。', app, [missingPath]);
    const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'), { readOnly: true });
    let missingRelativePath = '';
    try {
      const row = database
        .prepare(
          "SELECT relative_path FROM note_images WHERE original_name = 'missing.png' AND deleted_at IS NULL",
        )
        .get();
      if (typeof row?.relative_path !== 'string') throw new Error('缺失图片测试附件不存在');
      missingRelativePath = row.relative_path;
    } finally {
      database.close();
    }
    await rm(join(dataDirectory, missingRelativePath));
    const before = await page.evaluate(() => window.memocraft?.load());
    await mockReview(app, {
      summary: '本期截图记录了响应式访问与事务原子性。可以结合文字整理知识。',
    });
    await openReview(page);
    await expect(page.locator('.summary-text')).toContainText('本期截图记录了响应式访问');
    await expect(page.getByText('有 1 张图片未参与本次回顾。', { exact: true })).toBeVisible();
    const flash = (await mockState(app))?.requests[0]?.body ?? '';
    const flashRequest = JSON.parse(flash) as {
      model: string;
      messages: Array<{ role: string; content: string | AiContentBlock[] }>;
    };
    expect(flashRequest.model).toBe('deepseek-flash');
    const content = flashRequest.messages.find((message) => message.role === 'user')?.content;
    if (!Array.isArray(content)) throw new Error('Flash 图文请求必须包含内容块');
    const associations = content.flatMap((block, index) => {
      if (block.type !== 'image_url') return [];
      const previous = content[index - 1];
      if (!previous || previous.type !== 'text') throw new Error('图片必须紧跟对应手记文字');
      return [{ text: previous.text, image: block.image_url }];
    });
    expect(associations).toHaveLength(2);
    expect(associations).toEqual(
      expect.arrayContaining([
        {
          text: expect.stringContaining('第一条图文手记'),
          image: {
            url: `data:image/png;base64,${Buffer.from(PNG_2X3).toString('base64')}`,
            detail: 'auto',
          },
        },
        {
          text: expect.stringContaining('第二条图文手记'),
          image: {
            url: `data:image/png;base64,${Buffer.from(otherBytes).toString('base64')}`,
            detail: 'auto',
          },
        },
      ]),
    );
    expect(flash).not.toContain(Buffer.from(ignoredBytes).toString('base64'));
    expect(flash).not.toContain(dataDirectory);
    expect(flash).not.toContain(missingRelativePath);
    expect(flash).not.toContain(firstId);
    expect(flash).not.toContain(otherId);
    expect(flash).not.toContain('test-only-review-images-key');
    expect(cacheRows(dataDirectory)).toMatchObject([{ note_count: 4 }]);
    const cached = await page.evaluate(
      (request) => window.memocraft?.ai.summarizePeriod(request),
      await currentInput(page),
    );
    if (!cached?.ok) throw new Error('图文回顾缓存未正常读取');
    expect(cached.value.skippedImages).toBeUndefined();
    expect(cached.value.usedImages).toBeUndefined();
    expect(cached.value.imagesSupported).toBeUndefined();
    await page.getByRole('button', { name: /^首页/ }).first().click();
    await openReview(page);
    await expect(page.getByText('有 1 张图片未参与本次回顾。', { exact: true })).toBeVisible();
    expect((await mockState(app))?.requests).toHaveLength(1);

    expect(
      await page.evaluate(() => window.memocraft?.ai.saveModel('deepseek-v4-pro')),
    ).toMatchObject({ ok: true });
    await mockReview(app, {
      summary: 'Pro 根据手记文字整理了响应式和事务知识。可以继续补充归纳说明。',
    });
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await expect(page.locator('.summary-text')).toContainText('Pro 根据手记文字');
    await expect(
      page.getByText('当前模型不支持图片，本次回顾仅使用文字。', { exact: true }),
    ).toBeVisible();
    const pro = (await mockState(app))?.requests[0]?.body ?? '';
    const proRequest = JSON.parse(pro) as {
      model: string;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(proRequest.model).toBe('deepseek-v4-pro');
    expect(typeof proRequest.messages.find((message) => message.role === 'user')?.content).toBe(
      'string',
    );
    expect(pro).not.toContain('image_url');
    expect(pro).not.toContain(dataDirectory);
    expect(await page.evaluate(() => window.memocraft?.load())).toEqual(before);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
