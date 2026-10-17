import { waitForMainWindow } from './main-window';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

test('真实桌面：草稿重启、五分类、保存、搜索、抽屉编辑与安全预览', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-desktop-'));
  let app: ElectronApplication | undefined;
  const launch = async () => {
    const launched = await electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      env: { ...process.env, MEMOCRAFT_DATA_DIR: directory },
    });
    return launched;
  };
  const quit = async (current: ElectronApplication) => {
    const stopped = current.waitForEvent('close');
    await current.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await stopped;
  };
  try {
    app = await launch();
    let page = await waitForMainWindow(app);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    await expect(page.locator('.category-option span')).toHaveText([
      '收获',
      '思绪',
      '待办',
      '完成',
      '其他',
    ]);
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    // 空白提示跟随真实单选分类；只切分类不把提示写成正文。
    for (const [category, placeholder] of [
      ['收获', '现在想到什么……'],
      ['思绪', '此刻的心情或想法……'],
      ['待办', '接下来想做什么……'],
      ['完成', '记下一件做完的事……'],
      ['其他', '随手记点什么……'],
    ] as const) {
      await page.getByRole('radio', { name: category, exact: true }).check();
      await expect(body).toHaveAttribute('placeholder', placeholder);
      await expect(body).toHaveValue('');
      await page.screenshot({
        path: `test-results/ui-copy-${category}.png`,
        animations: 'disabled',
      });
    }
    // 新提示在最小深色窗口也完整可读；切回收获再输入，继续验证正文随分类改选保留。
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 700));
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('radio', { name: '思绪', exact: true }).check();
    await page.screenshot({ path: 'test-results/ui-copy-dark-small.png', animations: 'disabled' });
    await page.getByRole('button', { name: '浅色', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 900));
    await page.getByRole('radio', { name: '收获', exact: true }).check();
    await body.fill('尚未提交的中文草稿 📝\n保留第二行');
    await page.getByRole('radio', { name: '思绪', exact: true }).check();
    await expect(body).toHaveValue('尚未提交的中文草稿 📝\n保留第二行');
    await quit(app);
    app = undefined;
    app = await launch();
    page = await waitForMainWindow(app);
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      '尚未提交的中文草稿 📝\n保留第二行',
    );
    await expect(page.getByRole('radio', { name: '思绪', exact: true })).toBeChecked();
    const restoredBody = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(restoredBody).toHaveAttribute('placeholder', '此刻的心情或想法……');
    await restoredBody.fill('');
    await expect(restoredBody).toHaveAttribute('placeholder', '此刻的心情或想法……');
    await restoredBody.fill('尚未提交的中文草稿 📝\n保留第二行');
    await page.getByRole('button', { name: '补充', exact: true }).click();
    await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill('SQLite 证书记录');
    // 标签改为在右侧抽屉里点选：这里走自定义标签分支。
    await page.getByRole('button', { name: '＋ 选择标签' }).click();
    const tagDrawer = page.getByRole('dialog', { name: '选择标签' });
    await expect(tagDrawer).toBeVisible();
    await tagDrawer.getByRole('textbox', { name: '自定义标签' }).fill('SQLite, 测试');
    await tagDrawer.getByRole('textbox', { name: '自定义标签' }).press('Enter');
    await tagDrawer.getByRole('button', { name: '完成' }).click();
    await expect(tagDrawer).toHaveCount(0);
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue('');
    await expect(page.getByRole('radio', { name: '收获', exact: true })).toBeChecked();
    await page.getByRole('textbox', { name: '手记正文', exact: true }).fill('独立首页草稿');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '手记', exact: true })).toBeVisible();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.filter-group .filter-btn')).toHaveText([
      '收获0',
      '思绪1',
      '待办0',
      '完成0',
      '其他0',
    ]);
    await page.locator('.filter-group').getByRole('button', { name: /^思绪/ }).click();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card .cat')).toHaveText('思绪');
    await page.locator('.filter-group').getByRole('button', { name: /^其他/ }).click();
    await expect(page.getByText('没有符合当前筛选条件的手记。')).toBeVisible();
    await page.getByRole('button', { name: /^完成/ }).click();
    await expect(page.getByText('没有符合当前筛选条件的手记。')).toBeVisible();
    await page.getByRole('button', { name: /^全部/ }).click();
    await page.getByRole('button', { name: /^搜索/ }).click();
    const search = page.getByRole('combobox', { name: '搜索内容' });
    await search.fill('sqlite');
    await expect(page.getByRole('dialog', { name: '全局搜索' }).getByRole('option')).toHaveCount(1);
    await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toBeVisible();
    await search.press('Escape');
    await expect(page.getByRole('dialog', { name: '全局搜索' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^搜索/ })).toBeFocused();
    await page.getByRole('button', { name: /^搜索/ }).click();
    await search.fill('证书');
    await expect(page.getByRole('dialog', { name: '全局搜索' }).getByRole('option')).toHaveCount(1);
    await search.press('Enter');
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.category-option span')).toHaveText([
      '收获',
      '思绪',
      '待办',
      '完成',
      '其他',
    ]);
    await drawer.getByRole('radio', { name: '其他', exact: true }).check();
    await expect(drawer.getByText('已保存', { exact: true })).toBeVisible();
    await expect(page.locator('.card .cat')).toHaveText('其他');
    await drawer.getByRole('radio', { name: '待办', exact: true }).check();
    await expect(page.locator('.card .cat')).toHaveText('待办');
    await drawer
      .getByRole('textbox', { name: '编辑手记正文' })
      .fill('修改后的正文 100%_\\\n```sql\nSELECT 1;\n```\n<script>alert(1)</script>');
    await drawer.getByRole('radio', { name: '完成', exact: true }).check();
    await drawer.getByRole('button', { name: '预览 Markdown' }).click();
    await expect(drawer.locator('.markdown-preview script')).toHaveCount(0);
    await expect(drawer.locator('.markdown-preview code')).toHaveText('SELECT 1;\n');
    await expect(page.locator('.drawer-transition-enter-active')).toHaveCount(0);
    await expect(drawer.getByText('已保存', { exact: true })).toBeVisible();
    await page.screenshot({ path: 'test-results/desktop-drawer.png', animations: 'disabled' });
    await drawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^搜索/ })).toBeFocused();
    await page.getByRole('button', { name: /^首页/ }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      '独立首页草稿',
    );
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/desktop-home.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1000, 700);
    });
    await expect(page.getByRole('button', { name: '保存手记', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: /^搜索/ })).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: 'test-results/desktop-small.png', animations: 'disabled' });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 900);
    });
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.screenshot({ path: 'test-results/desktop-dark.png', animations: 'disabled' });
    await quit(app);
    app = undefined;
    app = await launch();
    page = await waitForMainWindow(app);
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      '独立首页草稿',
    );
    await page.getByRole('button', { name: /^搜索/ }).click();
    await page.getByRole('combobox', { name: '搜索内容' }).fill('100%_\\');
    await expect(page.getByRole('dialog', { name: '全局搜索' }).getByRole('option')).toHaveCount(1);
    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('真实写入失败：保留正文、阻止离开与关闭，修复后可重试', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-failure-'));
  const app = await electron.launch({
    executablePath: process.env.MEMOCRAFT_TEST_APP,
    args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
    env: { ...process.env, MEMOCRAFT_DATA_DIR: directory },
  });
  let stopped = false;
  const mutate = (sql: string) => {
    const database = new DatabaseSync(join(directory, 'memocraft.sqlite'));
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
  };
  try {
    const page = await waitForMainWindow(app);
    await expect(page.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    mutate(
      "CREATE TRIGGER fail_draft BEFORE INSERT ON note_drafts BEGIN SELECT RAISE(ABORT, 'isolated write failure'); END;",
    );
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('真实写入失败也不能丢失的内容');
    await expect(page.getByText(/本地数据操作未完成/)).toBeVisible();
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .click();
    await expect(page.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    await expect(page.getByText(/已留在当前页面/)).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect(page.getByText(/窗口已保留/)).toBeVisible();
    await expect(body).toHaveValue('真实写入失败也不能丢失的内容');
    await expect(body).toBeEditable();
    mutate('DROP TRIGGER fail_draft;');
    await page.locator('.draft-status').getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.getByText('草稿已保存', { exact: true })).toBeVisible();
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await closed;
    stopped = true;
    const database = new DatabaseSync(join(directory, 'memocraft.sqlite'), { readOnly: true });
    try {
      expect(database.prepare('SELECT payload FROM note_drafts').get()?.payload).toContain(
        '真实写入失败也不能丢失的内容',
      );
    } finally {
      database.close();
    }
  } finally {
    if (!stopped) {
      mutate('DROP TRIGGER IF EXISTS fail_draft;');
      await app.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
