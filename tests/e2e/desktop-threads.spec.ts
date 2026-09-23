import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 6：动态级与事务级引用都能从手记反查，重复关联不产生重复项。
 * 验收场景 7：补录过去动态后时间线正确；手记修改不会覆写动态正文中的历史描述。
 */
test('真实桌面：长期事务、动态时间线与引用反查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-threads-'));
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      env: { ...process.env, MEMOCRAFT_DATA_DIR: directory },
    });
  const quit = async (current: ElectronApplication) => {
    const stopped = current.waitForEvent('close');
    await current.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await stopped;
  };

  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(body).toBeVisible();

    // 一条手记，供动态级与事务级两种引用共用。
    await body.fill('证书链排查方法：只配 cert.pem 会报 CERT_AUTHORITY_INVALID');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');

    // 首页「新建事务」应直接进入长期事务并打开新建表单。
    await page
      .getByRole('button', { name: /新建事务/ })
      .first()
      .click();
    const createDialog = page.getByRole('dialog', { name: '新建事务' });
    await expect(createDialog).toBeVisible();
    await createDialog
      .getByRole('textbox', { name: '标题', exact: true })
      .fill('个人服务器搭建与维护');
    await createDialog.getByRole('button', { name: '创建', exact: true }).click();
    // 详情页标题只读呈现（状态跟在标题后），编辑入口收进右侧抽屉。
    await expect(page.locator('.detail-title')).toContainText('个人服务器搭建与维护');

    // 基础信息在抽屉里编辑：改动后自动保存并给出状态反馈。
    await page.getByRole('button', { name: '编辑基础信息' }).click();
    const editDrawer = page.getByRole('dialog', { name: '编辑基础信息' });
    await expect(editDrawer).toBeVisible();
    await editDrawer
      .getByRole('textbox', { name: /当前概况/ })
      .fill('Ubuntu 24.04，Nginx 已上线两个站点。');
    await expect(editDrawer.locator('.draft-status')).toContainText('已保存', { timeout: 8000 });
    await editDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(editDrawer).toHaveCount(0);

    // 第一条动态：新建时即引用那条手记。
    await page.getByRole('button', { name: '＋ 记录动态' }).click();
    const entryDrawer = page.getByRole('dialog', { name: '记录动态' });
    await expect(entryDrawer).toBeVisible();
    await entryDrawer
      .getByRole('textbox', { name: '动态描述（必填）' })
      .fill('排查并修复了证书链不完整的问题');
    await entryDrawer
      .getByRole('textbox', { name: '详细内容（可选，Markdown）' })
      .fill('原因是只配了 cert.pem。');
    await page.getByRole('button', { name: '＋ 引用手记' }).click();
    const picker = page.getByRole('dialog', { name: '收录手记' });
    await expect(picker).toBeVisible();
    await picker.getByRole('checkbox').first().check();
    await picker.getByRole('button', { name: '收录', exact: true }).click();
    await expect(picker).toHaveCount(0);
    await entryDrawer.getByRole('button', { name: '记录动态' }).click();
    await expect(page.locator('.timeline .entry')).toHaveCount(1);
    await expect(page.locator('.toast').filter({ hasText: '已记录动态' })).toBeVisible();

    // 补录一条过去发生的动态：时间线默认最近在前，补录项应排在后面。
    await page.getByRole('button', { name: '＋ 记录动态' }).click();
    const backfillDrawer = page.getByRole('dialog', { name: '记录动态' });
    await backfillDrawer
      .getByRole('textbox', { name: '动态描述（必填）' })
      .fill('购买 VPS 并初始化系统');
    await backfillDrawer.getByRole('textbox', { name: '发生时间' }).fill('2026-08-01T10:00');
    await backfillDrawer.getByRole('button', { name: '记录动态' }).click();
    await expect(page.locator('.timeline .entry')).toHaveCount(2);
    await expect(page.locator('.timeline .entry h4').first()).toContainText('排查并修复了证书链');
    await expect(page.locator('.timeline .entry h4').last()).toContainText('购买 VPS');

    // 切换为最早在前：顺序翻转。
    await page.getByRole('radio', { name: '最早在前' }).click();
    await expect(page.locator('.timeline .entry h4').first()).toContainText('购买 VPS');
    await page.getByRole('radio', { name: '最近在前' }).click();
    await expect(page.locator('.timeline .entry h4').first()).toContainText('排查并修复了证书链');
    await page.screenshot({ path: 'test-results/threads-detail.png', animations: 'disabled' });

    // 事务级直接关联同一条手记：应与动态级引用并存而不重复。
    await page.getByRole('button', { name: '＋ 关联手记' }).click();
    const threadPicker = page.getByRole('dialog', { name: '收录手记' });
    await threadPicker.getByRole('checkbox').first().check();
    await threadPicker.getByRole('button', { name: '收录', exact: true }).click();
    await expect(page.locator('.thread-note .card')).toHaveCount(1);

    // 手记侧反查：动态级与事务级各一条，点动态级引用跳回并定位。
    await page
      .getByRole('button', { name: /随手记/ })
      .first()
      .click();
    await expect(page.getByRole('heading', { name: '随手记', exact: true })).toBeVisible();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await page.locator('.card').first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    const refs = drawer.locator('.drawer-meta');
    await expect(refs.getByRole('button', { name: /事务资料/ })).toHaveCount(1);
    await expect(refs.getByRole('button', { name: /排查并修复了证书链/ })).toHaveCount(1);
    await page.screenshot({ path: 'test-results/threads-references.png', animations: 'disabled' });

    // 修改手记正文不应覆写动态里的历史描述。
    await drawer
      .getByRole('textbox', { name: '编辑手记正文' })
      .fill('证书链排查方法（已更新：同时检查 fullchain.pem）');
    await expect(drawer.getByText('已保存', { exact: true })).toBeVisible();
    await refs.getByRole('button', { name: /排查并修复了证书链/ }).click();
    await expect(page.locator('.detail-title')).toContainText('个人服务器搭建与维护');
    // 详情打开后时间线是异步读取的，先等条目渲染再断言内容。
    await expect(page.locator('.timeline .entry')).toHaveCount(2);
    await expect(page.locator('.timeline .entry h4').first()).toContainText('排查并修复了证书链');
    await expect(page.locator('.entry-body').first()).toContainText('原因是只配了 cert.pem。');

    // 归档只影响默认列表：默认视图看不到，切到已归档仍可打开。
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('heading', { name: '长期事务', exact: true })).toBeVisible();
    await expect(page.locator('.card.collection')).toHaveCount(0);
    await page.getByRole('button', { name: /已归档/ }).click();
    await expect(page.locator('.card.collection')).toHaveCount(1);
    await page.locator('.card.collection').first().click();
    await expect(page.locator('.status-pill').first()).toContainText('已归档');
    await page.getByRole('button', { name: '重新启用', exact: true }).click();
    await expect(page.locator('.status-pill').first()).toContainText('进行中');

    // 重启后事务、动态与引用都应保留。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await reopened
      .getByRole('button', { name: /长期事务/ })
      .first()
      .click();
    await expect(reopened.locator('.card.collection')).toHaveCount(1);
    await reopened.locator('.card.collection').first().click();
    await expect(reopened.locator('.timeline .entry')).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
