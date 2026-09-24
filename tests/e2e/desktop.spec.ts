import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

test('真实桌面：草稿重启、四分类、保存、搜索、抽屉编辑与安全预览', async () => {
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
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '新手记', exact: true })).toBeVisible();
    await page
      .getByRole('textbox', { name: '手记正文', exact: true })
      .fill('尚未提交的中文草稿 📝\n保留第二行');
    await page.getByRole('radio', { name: '待办', exact: true }).check();
    await quit(app);
    app = undefined;
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue(
      '尚未提交的中文草稿 📝\n保留第二行',
    );
    await expect(page.getByRole('radio', { name: '待办', exact: true })).toBeChecked();
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
      .getByRole('button', { name: /随手记/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '随手记', exact: true })).toBeVisible();
    await expect(page.locator('.card')).toHaveCount(1);
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
    page = await app.firstWindow();
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
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '新手记', exact: true })).toBeVisible();
    mutate(
      "CREATE TRIGGER fail_draft BEFORE INSERT ON note_drafts BEGIN SELECT RAISE(ABORT, 'isolated write failure'); END;",
    );
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await body.fill('真实写入失败也不能丢失的内容');
    await expect(page.getByText(/本地数据操作未完成/)).toBeVisible();
    await page.getByRole('button', { name: /^随手记/ }).click();
    await expect(page.getByRole('heading', { name: '新手记', exact: true })).toBeVisible();
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
