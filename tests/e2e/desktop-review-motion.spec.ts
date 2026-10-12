import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import type { AiPeriodType } from '../../src/shared/ai';

interface NetworkState {
  requests: Array<{ body: string; aborted: boolean }>;
  finish?: () => void;
}
type MotionGlobals = typeof globalThis & { memocraftReviewMotion?: NetworkState };
type MotionAction = string | { periodIndex: number };

interface MotionFrame {
  elapsed: number;
  thumbX: number;
  thumbWidth: number;
  activeTabX: number;
  activeTabWidth: number;
  height: number;
  naturalHeight: number;
  width: number;
  inlineHeight: string;
  inlineOverflow: string;
  label: string;
  summary: string;
  summaryOpacity: number | null;
  summaryBlur: number | null;
  recommendationOpacity: number | null;
  recommendationBlur: number | null;
  metaOpacity: number | null;
  exposedSummaries: number;
  interactiveActions: number;
  leavingFrames: number;
  leavingFramesHidden: boolean;
  leavingId: number | null;
  leavingSummaryBlur: number | null;
  leavingRecommendationOpacity: number | null;
  entering: boolean;
}

// 文本接近常用行宽边界，最小窗口能实际增加换行，无须改写页面 DOM 或布局。
const longWeekSummary = `周回顾：${'响应式访问、事务原子性与分类事实帮助整理学习积累，'.repeat(18)}这些主题来自本期手记。可以继续用实践巩固这些知识。`;
const longSuggestions = Array.from(
  { length: 5 },
  (_, index) =>
    `建议 ${index + 1}：${'整理响应式访问和事务练习的事实，逐条对照手记并补充归纳说明，'.repeat(5)}`,
);
const shortMonthSummary = '月回顾：本月记录了响应式知识。可以继续整理已经完成的练习。';

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

/** 仅替身供应商 HTTP；缓存、周期切换、取消与 Vue/CSS 动效均由真实应用执行。 */
async function mockNetwork(
  app: ElectronApplication,
  summary: string,
  suggestions: string[] = [],
  held = false,
): Promise<void> {
  await app.evaluate(
    ({ net }, options) => {
      const state: NetworkState = { requests: [] };
      (globalThis as MotionGlobals).memocraftReviewMotion = state;
      net.fetch = async (url, request) => {
        if (String(url) !== 'https://api.deepseek.com/chat/completions')
          throw new Error(`unexpected URL ${String(url)}`);
        const captured = {
          body: typeof request?.body === 'string' ? request.body : '',
          aborted: false,
        };
        state.requests.push(captured);
        const response = () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      summary: options.summary,
                      suggestions: options.suggestions,
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        if (!options.held) return response();
        // 供应商故意忽略 abort，迟到响应也不能改写刚切回的周期或缓存。
        return new Promise<Response>((resolveResponse) => {
          state.finish = () => {
            state.finish = undefined;
            resolveResponse(response());
          };
          const abort = () => {
            captured.aborted = true;
          };
          if (request?.signal?.aborted) abort();
          else request?.signal?.addEventListener('abort', abort, { once: true });
        });
      };
    },
    { summary, suggestions, held },
  );
}

async function networkState(app: ElectronApplication) {
  return app.evaluate(() => (globalThis as MotionGlobals).memocraftReviewMotion?.requests);
}

async function releaseNetwork(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as MotionGlobals).memocraftReviewMotion?.finish?.());
}

async function seedNoteAndKey(page: Page): Promise<void> {
  const editor = page.getByRole('textbox', { name: '手记正文', exact: true });
  await expect(editor).toBeVisible();
  expect(
    await page.evaluate(() => window.memocraft?.ai.saveKey('test-only-review-motion-key')),
  ).toEqual({ ok: true, value: null });
  await editor.fill('响应式、事务与分类事实是这条周期回顾动效验收手记的主题。');
  await page.getByRole('button', { name: '保存手记', exact: true }).click();
  await expect(editor).toHaveValue('');
}

async function warmCache(
  app: ElectronApplication,
  page: Page,
  periodType: AiPeriodType,
  summary: string,
  suggestions: string[] = [],
): Promise<void> {
  await mockNetwork(app, summary, suggestions);
  const result = await page.evaluate(
    async (input) => {
      const date = new Date();
      const startDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return window.memocraft?.ai.summarizePeriod({
        requestId: input.requestId,
        periodType: input.periodType,
        startDate,
        regenerate: false,
      });
    },
    { requestId: randomUUID(), periodType },
  );
  expect(result).toMatchObject({ ok: true, value: { periodType, summary, noteCount: 1 } });
  expect(await networkState(app)).toHaveLength(1);
}

async function openReview(page: Page, summary: string): Promise<MotionFrame[]> {
  const frames = await observeMotion(page, ['回顾']);
  await expect(page.getByRole('heading', { name: '回顾', exact: true })).toBeVisible();
  await expect(page.locator('.summary-text')).toHaveText(summary);
  await expect(page.locator('.review-content-frame')).toHaveCount(1);
  return frames;
}

/** 点击与测量在同一 renderer 任务中启动，确保不会错过 Playwright 等待后的中间动画帧。 */
async function observeMotion(
  page: Page,
  actions: MotionAction[],
  duration = 1600,
  actionSpacing = 0,
): Promise<MotionFrame[]> {
  return page.evaluate(
    async (input) => {
      const nextFrame = () =>
        new Promise<number>((resolveFrame) => requestAnimationFrame(resolveFrame));
      // 从真实导航开始等页面挂载，第一帧就采样，覆盖启动而不只验证周/月切换。
      let actions = input.actions;
      if (actions[0] === '回顾') {
        const navigation = Array.from(
          document.querySelectorAll<HTMLButtonElement>('.nav-item'),
        ).find((button) => button.textContent?.trim() === '回顾');
        if (!navigation || navigation.disabled) throw new Error('回顾导航不可用');
        navigation.click();
        const startedAt = performance.now();
        while (!document.querySelector('.review-content') && performance.now() - startedAt < 5000)
          await nextFrame();
        actions = actions.slice(1);
      }
      const track = document.querySelector('.period-switcher');
      const thumb = track?.querySelector('.seg-thumb');
      const host = document.querySelector('.review-content');
      if (
        !(track instanceof HTMLElement) ||
        !(thumb instanceof HTMLElement) ||
        !(host instanceof HTMLElement)
      )
        throw new Error('回顾动效观察节点不存在');
      const start = performance.now();
      const leavingIds = new WeakMap<Element, number>();
      let nextLeavingId = 0;
      const exposed = (element: Element) => !element.closest('[inert], [aria-hidden="true"]');
      const opacity = (element: Element | undefined | null) =>
        element ? Number.parseFloat(getComputedStyle(element).opacity) : null;
      const blur = (element: Element | undefined | null) => {
        if (!element) return null;
        const filter = getComputedStyle(element).filter;
        if (filter === 'none') return 0;
        const value = /^blur\(([\d.]+)px\)$/.exec(filter)?.[1];
        if (!value) throw new Error(`未识别的回顾滤镜：${filter}`);
        return Number.parseFloat(value);
      };
      const snapshot = (time: number): MotionFrame => {
        const selected = track.querySelector('[role="tab"][aria-selected="true"]');
        if (!(selected instanceof HTMLElement)) throw new Error('当前回顾标签不存在');
        const trackRect = track.getBoundingClientRect();
        const thumbRect = thumb.getBoundingClientRect();
        const tabRect = selected.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const summaries = Array.from(host.querySelectorAll('.summary-text')).filter(exposed);
        const activeFrame = Array.from(host.querySelectorAll('.review-content-frame')).find(
          exposed,
        );
        const leaves = Array.from(host.querySelectorAll('.review-content-leave-active'));
        const leaving = leaves[0];
        if (leaving && !leavingIds.has(leaving)) leavingIds.set(leaving, ++nextLeavingId);
        const recommendations = activeFrame?.querySelector('.review-recommendations');
        return {
          elapsed: time - start,
          thumbX: thumbRect.left - trackRect.left,
          thumbWidth: thumbRect.width,
          activeTabX: tabRect.left - trackRect.left,
          activeTabWidth: tabRect.width,
          height: hostRect.height,
          naturalHeight: Math.max(
            host.firstElementChild?.getBoundingClientRect().height ?? 0,
            Number.parseFloat(getComputedStyle(host).minHeight) || 0,
          ),
          width: hostRect.width,
          inlineHeight: host.style.height,
          inlineOverflow: host.style.overflow,
          label:
            document
              .querySelector('.period-trigger')
              ?.getAttribute('aria-label')
              ?.replace(/^选择回顾时间段：/, '') ?? '',
          summary: summaries[0]?.textContent?.trim() ?? '',
          summaryOpacity: opacity(summaries[0]),
          summaryBlur: blur(summaries[0]),
          recommendationOpacity: opacity(recommendations),
          recommendationBlur: blur(recommendations),
          metaOpacity: opacity(activeFrame?.querySelector('.review-meta')),
          exposedSummaries: summaries.length,
          interactiveActions: Array.from(host.querySelectorAll('button')).filter(
            (button) => !button.disabled && exposed(button),
          ).length,
          leavingFrames: leaves.length,
          leavingFramesHidden: leaves.every(
            (element) =>
              element.hasAttribute('inert') && element.getAttribute('aria-hidden') === 'true',
          ),
          leavingId: leaving ? (leavingIds.get(leaving) ?? null) : null,
          leavingSummaryBlur: blur(leaving?.querySelector('.summary-text')),
          leavingRecommendationOpacity: opacity(leaving?.querySelector('.review-recommendations')),
          entering: Array.from(activeFrame?.querySelectorAll('.review-reveal') ?? []).some(
            (element) =>
              element.getAnimations().some((animation) => animation.playState === 'running'),
          ),
        };
      };
      const frames = [snapshot(start)];
      let previousAction = start;
      for (const [index, action] of actions.entries()) {
        if (index > 0) {
          while (performance.now() - previousAction < input.actionSpacing)
            frames.push(snapshot(await nextFrame()));
        }
        let target: HTMLButtonElement | undefined;
        if (typeof action === 'string') {
          target = Array.from(
            document.querySelectorAll<HTMLButtonElement>('.period-switcher button'),
          ).find((button) => button.textContent?.trim() === action);
        } else {
          const trigger = document.querySelector('.period-trigger');
          if (!(trigger instanceof HTMLButtonElement) || trigger.disabled)
            throw new Error('时间段列表触发按钮不可用');
          trigger.click();
          // 列表由 Vue 下一帧挂载，等待时继续采样，选期仍通过真实 DOM click 完成。
          let options: HTMLButtonElement[] = [];
          const openedAt = performance.now();
          while (!options.length && performance.now() - openedAt < 1000) {
            frames.push(snapshot(await nextFrame()));
            options = Array.from(
              document.querySelectorAll<HTMLButtonElement>(
                '[role="listbox"][aria-label="选择回顾时间段"] [role="option"]',
              ),
            );
          }
          const date = options[action.periodIndex]?.getAttribute('data-start-date');
          if (!date) throw new Error(`时间段列表没有第 ${action.periodIndex} 项`);
          const option = document.querySelector(`[role="option"][data-start-date="${date}"]`);
          if (option instanceof HTMLButtonElement) target = option;
        }
        if (!target || target.disabled)
          throw new Error(`周期动效测试无法点击：${JSON.stringify(action)}`);
        previousAction = performance.now();
        target.click();
        frames.push(snapshot(await nextFrame()));
      }
      while (performance.now() - start < input.duration) frames.push(snapshot(await nextFrame()));
      return frames;
    },
    { actions, duration, actionSpacing },
  );
}

function finalFrame(frames: MotionFrame[]): MotionFrame {
  const final = frames.at(-1);
  if (!final) throw new Error('动效采样未产生帧');
  return final;
}

/** 观察几何位置连续变化，不以 transition 声明存在代替动画真的播放。 */
function expectInterpolated(frames: MotionFrame[], field: 'thumbX' | 'height'): void {
  const first = frames[0];
  if (!first) throw new Error('动效采样未产生起始帧');
  const from = first[field];
  const to = finalFrame(frames)[field];
  const distance = Math.abs(to - from);
  expect(distance).toBeGreaterThan(field === 'height' ? 70 : 20);
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const intermediate = frames.filter(
    (frame) => frame[field] > low + distance * 0.05 && frame[field] < high - distance * 0.05,
  );
  expect(
    new Set(intermediate.map((frame) => Math.round(frame[field] * 10))).size,
  ).toBeGreaterThanOrEqual(3);
  for (const [index, frame] of frames.entries()) {
    expect(frame[field]).toBeGreaterThanOrEqual(low - 2);
    expect(frame[field]).toBeLessThanOrEqual(high + 2);
    const previous = frames[index - 1];
    // 只有实际帧间隔足够短时才判断跳变，避免忙碌执行机漏帧被误认为布局瞬跳。
    if (previous && frame.elapsed - previous.elapsed < 45)
      expect(Math.abs(frame[field] - previous[field])).toBeLessThan(distance * 0.55 + 2);
  }
}

function expectExclusiveContent(frames: MotionFrame[]): void {
  expect(frames.some((frame) => frame.leavingFrames > 0)).toBe(true);
  for (const [index, frame] of frames.entries()) {
    expect(frame.exposedSummaries).toBeLessThanOrEqual(1);
    expect(frame.interactiveActions).toBeLessThanOrEqual(1);
    expect(frame.leavingFramesHidden).toBe(true);
    const previous = frames[index - 1];
    // 同一棵离场树应冻结当前模糊与分块透明度；只由父层淡出，不继续播放或瞬间亮出。
    if (frame.leavingId !== null && frame.leavingId === previous?.leavingId) {
      expect(frame.leavingSummaryBlur).toBe(previous.leavingSummaryBlur);
      expect(frame.leavingRecommendationOpacity).toBe(previous.leavingRecommendationOpacity);
    }
  }
}

function expectNaturalHeight(frame: MotionFrame): void {
  expect(['', 'auto']).toContain(frame.inlineHeight);
  expect(frame.inlineOverflow).toBe('');
  expect(Math.abs(frame.height - frame.naturalHeight)).toBeLessThan(2);
}

/** 真实像素样式须经历先显现后凝实；推荐和底部稍后出现，结束后滤镜完全释放。 */
function expectCondensation(frames: MotionFrame[], recommendations = false): void {
  const revealed = frames.filter((frame) => frame.summaryBlur !== null);
  const intermediate = revealed.filter(
    (frame) => (frame.summaryBlur ?? 0) > 0.2 && (frame.summaryBlur ?? 0) < 7.8,
  );
  expect(
    new Set(intermediate.map((frame) => Math.round((frame.summaryBlur ?? 0) * 10))).size,
  ).toBeGreaterThanOrEqual(3);
  expect(revealed.some((frame) => frame.summaryOpacity === 1 && (frame.summaryBlur ?? 0) > 1)).toBe(
    true,
  );
  if (recommendations) {
    expect(
      revealed.some(
        (frame) => (frame.summaryOpacity ?? 0) > 0.8 && frame.recommendationOpacity === 0,
      ),
    ).toBe(true);
    expect(
      revealed.some((frame) => (frame.recommendationOpacity ?? 0) > 0 && frame.metaOpacity === 0),
    ).toBe(true);
    expect(finalFrame(frames).recommendationBlur).toBe(0);
    expect(finalFrame(frames).recommendationOpacity).toBe(1);
  }
  expect(finalFrame(frames).summaryBlur).toBe(0);
  expect(finalFrame(frames).summaryOpacity).toBe(1);
  expect(finalFrame(frames).metaOpacity).toBe(1);
  expect(finalFrame(frames).entering).toBe(false);
}

function persistedSummaries(dataDirectory: string) {
  const database = new DatabaseSync(join(dataDirectory, 'memocraft.sqlite'), { readOnly: true });
  try {
    return database
      .prepare('SELECT period_type, summary FROM ai_period_summaries ORDER BY period_type')
      .all();
  } finally {
    database.close();
  }
}

test('真实桌面：凝结入场与周月切换、彩色星芒、滑块和高度补间、快速连点', async () => {
  test.setTimeout(150_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-motion-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  const artifacts = join(process.cwd(), 'test-results', 'review-motion-artifacts');
  await mkdir(artifacts, { recursive: true });
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(dataDirectory, shellDirectory);
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedNoteAndKey(page);
    await warmCache(app, page, 'week', longWeekSummary, longSuggestions);
    await warmCache(app, page, 'month', shortMonthSummary);
    await mockNetwork(app, '缓存切换不应访问这个 HTTP 替身。');
    const entrance = await openReview(page, longWeekSummary);
    expectCondensation(entrance, true);
    const marker = page
      .getByRole('button', { name: '回顾', exact: true })
      .locator('.review-ai-mark');
    await expect(marker).toHaveAttribute('aria-hidden', 'true');
    const markerPlacement = await marker.evaluate((element) => {
      const button = element.closest('button');
      const label = button?.querySelector('.label');
      if (!button || !label) throw new Error('回顾星芒缺少所属控件');
      const gradient = element.querySelector('linearGradient');
      return {
        rightInset: button.getBoundingClientRect().right - element.getBoundingClientRect().right,
        gapAfterLabel: element.getBoundingClientRect().left - label.getBoundingClientRect().right,
        colors: Array.from(element.querySelectorAll('stop')).map((stop) =>
          stop.getAttribute('stop-color'),
        ),
        gradientMatches:
          element.querySelector('path')?.getAttribute('stroke') === `url(#${gradient?.id})`,
      };
    });
    expect(markerPlacement.rightInset).toBeCloseTo(12, 0);
    expect(markerPlacement.gapAfterLabel).toBeGreaterThan(20);
    expect(new Set(markerPlacement.colors).size).toBeGreaterThanOrEqual(3);
    expect(markerPlacement.gradientMatches).toBe(true);
    await page.screenshot({ path: join(artifacts, 'review-week-before.png'), animations: 'allow' });

    const toMonth = await observeMotion(page, ['按月']);
    expectInterpolated(toMonth, 'thumbX');
    expectInterpolated(toMonth, 'height');
    expectExclusiveContent(toMonth);
    expectCondensation(toMonth);
    const monthEnd = finalFrame(toMonth);
    expect(monthEnd.summary).toBe(shortMonthSummary);
    expect(monthEnd.label).toMatch(/^\d{4}年\d{1,2}月$/);
    expect(Math.abs(monthEnd.thumbX - monthEnd.activeTabX)).toBeLessThan(2);
    expect(Math.abs(monthEnd.thumbWidth - monthEnd.activeTabWidth)).toBeLessThan(2);
    expectNaturalHeight(monthEnd);
    expect(await networkState(app)).toHaveLength(0);
    await page.screenshot({ path: join(artifacts, 'review-month-after.png'), animations: 'allow' });

    const toWeek = await observeMotion(page, ['按周']);
    expectInterpolated(toWeek, 'thumbX');
    expectInterpolated(toWeek, 'height');
    expectExclusiveContent(toWeek);
    expectCondensation(toWeek, true);
    expect(finalFrame(toWeek).summary).toBe(longWeekSummary);
    const toEmpty = await observeMotion(page, [{ periodIndex: 1 }]);
    expectInterpolated(toEmpty, 'height');
    expectExclusiveContent(toEmpty);
    await expect(page.getByText('这段时间没有新手记。', { exact: true })).toBeVisible();
    expect(finalFrame(toEmpty).summary).toBe('');
    expectNaturalHeight(finalFrame(toEmpty));
    expect(await networkState(app)).toHaveLength(0);
    await observeMotion(page, [{ periodIndex: 0 }]);
    await expect(page.locator('.summary-text')).toHaveText(longWeekSummary);

    // 补间结算后释放显式高度，窗口改变宽度时长文仍能按自然布局重新换行。
    // 使用真正缓存的长概要与建议，不改 DOM 文本制造布局差异。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1500, 900));
    const wide = finalFrame(await observeMotion(page, [], 450));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    const narrow = finalFrame(await observeMotion(page, [], 450));
    await writeFile(
      join(artifacts, 'review-reflow.json'),
      JSON.stringify({ wide, narrow }, null, 2),
    );
    expect(narrow.width).toBeLessThan(wide.width);
    expectNaturalHeight(wide);
    expectNaturalHeight(narrow);
    expect(narrow.height).toBeGreaterThan(wide.height + 20);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    const rapid = await observeMotion(page, ['按月', '按周', '按月']);
    expectExclusiveContent(rapid);
    expect(finalFrame(rapid).summary).toBe(shortMonthSummary);
    expect(finalFrame(rapid).label).toMatch(/^\d{4}年\d{1,2}月$/);
    expectNaturalHeight(finalFrame(rapid));
    await expect(page.getByRole('tab', { name: '按月', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.locator('.period-trigger')).toHaveCount(1);
    await expect(page.locator('.review-content-frame')).toHaveCount(1);
    await expect(page.locator('.summary-text')).toHaveText(shortMonthSummary);
    expect(await networkState(app)).toHaveLength(0);

    // 每次相隔 210ms，后续点击发生在淡入与高度补间中段，而非全部落在旧树离场时。
    await observeMotion(page, ['按周']);
    const interrupted = await observeMotion(page, ['按月', '按周', '按月'], 2200, 210);
    expectExclusiveContent(interrupted);
    expect(interrupted.some((frame) => frame.entering && frame.inlineHeight !== '')).toBe(true);
    expect(
      interrupted.some(
        (frame) => frame.leavingSummaryBlur === 8 && frame.leavingRecommendationOpacity === 0,
      ),
    ).toBe(true);
    expect(finalFrame(interrupted).summary).toBe(shortMonthSummary);
    expectNaturalHeight(finalFrame(interrupted));
    await expect(page.locator('.review-content-frame')).toHaveCount(1);
    expect(await networkState(app)).toHaveLength(0);
    await page.getByRole('button', { name: /首页/, exact: false }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    const returned = await openReview(page, shortMonthSummary);
    expectCondensation(returned);
    expect(await networkState(app)).toHaveLength(0);
    await writeFile(
      join(artifacts, 'review-motion-frames.json'),
      JSON.stringify(
        { entrance, returned, toMonth, toWeek, toEmpty, rapid, interrupted, wide, narrow },
        null,
        2,
      ),
    );
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});

test('真实桌面：周期动效不阻塞取消，减少动态效果立即切换且释放高度', async () => {
  test.setTimeout(120_000);
  const root = await mkdtemp(join(tmpdir(), 'memocraft-review-reduced-motion-'));
  const dataDirectory = join(root, 'data');
  const shellDirectory = join(root, 'shell');
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await launch(dataDirectory, shellDirectory);
    const firstApp = app;
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await seedNoteAndKey(page);
    await warmCache(app, page, 'week', longWeekSummary, longSuggestions);
    await mockNetwork(app, '迟到的旧月回顾必须被取消。', [], true);
    await openReview(page, longWeekSummary);
    await observeMotion(page, []);
    await page.getByRole('tab', { name: '按月', exact: true }).click();
    await expect.poll(async () => (await networkState(firstApp))?.length).toBe(1);
    await expect(page.getByRole('status', { name: '正在生成回顾' })).toBeVisible();
    const cancelled = await observeMotion(page, ['按周']);
    await expect.poll(async () => (await networkState(firstApp))?.[0]?.aborted).toBe(true);
    expect(finalFrame(cancelled).summary).toBe(longWeekSummary);
    await releaseNetwork(app);
    await observeMotion(page, [], 450);
    await expect(page.locator('.summary-text')).toHaveText(longWeekSummary);
    await expect(page.locator('.review-content')).not.toContainText('迟到的旧月回顾');
    expect(persistedSummaries(dataDirectory)).toEqual([
      { period_type: 'week', summary: longWeekSummary },
    ]);

    await warmCache(app, page, 'month', shortMonthSummary);
    await mockNetwork(app, '减少动态效果切换仍须读取缓存。');

    // 凝结与高度补间中途更改系统偏好，取消后立即清晰，并释放内联高度与裁切。
    await page.getByRole('tab', { name: '按月', exact: true }).click();
    await page.waitForFunction(
      (expected) => {
        const host = document.querySelector('.review-content');
        const summary = host?.querySelector('.summary-text');
        const blur = summary ? Number.parseFloat(getComputedStyle(summary).filter.slice(5)) : 0;
        return (
          host instanceof HTMLElement &&
          host.style.height !== '' &&
          blur > 0 &&
          blur < 8 &&
          host.querySelector('.summary-text')?.textContent?.trim() === expected
        );
      },
      shortMonthSummary,
      { polling: 'raf' },
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expectNaturalHeight(finalFrame(await observeMotion(page, [], 300)));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await observeMotion(page, ['按周']);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
      true,
    );
    const reduced = await observeMotion(page, ['按月'], 300);
    // 下一真实绘制帧直接对齐目标标签，没有滑块或高度动画的中间位置残留。
    for (const frame of reduced.slice(1)) {
      expect(Math.abs(frame.thumbX - frame.activeTabX)).toBeLessThan(2);
      expectNaturalHeight(frame);
      expect(frame.interactiveActions).toBeLessThanOrEqual(1);
      if (frame.summary === shortMonthSummary) {
        expect(frame.summaryOpacity).toBe(1);
        expect(frame.summaryBlur).toBe(0);
        expect(frame.metaOpacity).toBe(1);
        expect(frame.entering).toBe(false);
      }
    }
    expect(finalFrame(reduced).summary).toBe(shortMonthSummary);
    expect(finalFrame(reduced).label).toMatch(/^\d{4}年\d{1,2}月$/);
    await expect(page.locator('.review-content-frame')).toHaveCount(1);
    expect(await networkState(app)).toHaveLength(0);
    const reducedEmpty = await observeMotion(page, [{ periodIndex: 1 }], 300);
    for (const frame of reducedEmpty.slice(1)) expectNaturalHeight(frame);
    await expect(page.getByText('这段时间没有新手记。', { exact: true })).toBeVisible();
    expect(finalFrame(reducedEmpty).summary).toBe('');
    expect(await networkState(app)).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(root, { recursive: true, force: true });
  }
});
