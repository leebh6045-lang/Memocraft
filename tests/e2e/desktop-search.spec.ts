import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 9：中文、英文大小写、emoji、换行、引号、代码块与普通搜索符号正确保存与查找；
 * 归档内容可搜，草稿和回收站默认不搜。四类结果都能从浮层直接打开。
 */
test('真实桌面：全对象搜索、命中高亮与结果定位', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-search-'));
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
    const palette = page.getByRole('dialog', { name: '全局搜索' });
    const input = page.getByRole('combobox', { name: '搜索内容' });
    const options = palette.getByRole('option');
    const openSearch = async () => {
      await page.getByRole('button', { name: /^搜索/ }).click();
      await expect(palette).toBeVisible();
    };

    // 一条含中文、emoji、引号、代码块与普通符号的手记。
    await body.fill('检索样例句包含 100%_\\ 与"引号"\n```sql\nSELECT 1;\n```\n🙂 emoji 收尾');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');

    // 归纳、事务与动态各一条。
    await page
      .getByRole('button', { name: /新建归纳/ })
      .first()
      .click();
    const topicDialog = page.getByRole('dialog', { name: '新建归纳' });
    await topicDialog.getByRole('textbox', { name: '标题', exact: true }).fill('检索归纳样例');
    await topicDialog
      .getByRole('textbox', { name: '说明（可选）', exact: true })
      .fill('说明里带 SQLite 备份 关键词');
    await topicDialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: '检索归纳样例', exact: true })).toBeVisible();

    await page.getByRole('button', { name: /首页/ }).first().click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await page
      .getByRole('button', { name: /新建事务/ })
      .first()
      .click();
    const threadDialog = page.getByRole('dialog', { name: '新建事务' });
    await threadDialog.getByRole('textbox', { name: '标题', exact: true }).fill('检索事务样例');
    await threadDialog.getByRole('button', { name: '创建', exact: true }).click();
    // 基础信息在抽屉里填写，动态也在抽屉里记录。
    await page.getByRole('button', { name: '编辑基础信息' }).click();
    const editDrawer = page.getByRole('dialog', { name: '编辑基础信息' });
    await editDrawer
      .getByRole('textbox', { name: /当前概况/ })
      .fill('概况里写着 证书自动续期 的状态');
    await expect(editDrawer.locator('.draft-status')).toContainText('已保存', { timeout: 8000 });
    await editDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(editDrawer).toHaveCount(0);
    await page.getByRole('button', { name: '＋ 记录动态' }).click();
    const entryDrawer = page.getByRole('dialog', { name: '记录动态' });
    await entryDrawer.getByRole('textbox', { name: '动态描述（必填）' }).fill('检索动态样例');
    await entryDrawer
      .getByRole('textbox', { name: '详细内容（可选，Markdown）' })
      .fill('错误码 NET::ERR_CERT_AUTHORITY_INVALID');
    await entryDrawer.getByRole('button', { name: '记录动态' }).click();
    await expect(page.locator('.timeline .entry')).toHaveCount(1);

    // 归档后照常可检索。
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await expect(page.getByRole('heading', { name: '长期事务', exact: true })).toBeVisible();

    // 空查询：分组名写明「最近」，四类都出现。
    await openSearch();
    await expect(palette.locator('.palette-group')).toHaveCount(4);
    await expect(palette.locator('.palette-group').first()).toHaveText('最近手记');
    await expect(palette.getByText('最近动态')).toBeVisible();
    await page.screenshot({ path: 'test-results/search-recent.png', animations: 'disabled' });

    // 中文命中四类对象，并按类型分组。
    await input.fill('检索');
    await expect(options).toHaveCount(4);
    await expect(palette.locator('.palette-group').first()).toHaveText('手记');
    for (const label of ['手记', '归纳', '事务', '动态']) {
      await expect(
        palette.locator('.palette-group').filter({ hasText: label }).first(),
      ).toBeVisible();
    }
    await expect(palette.locator('mark').first()).toHaveText('检索');
    await page.screenshot({ path: 'test-results/search-grouped.png', animations: 'disabled' });

    // 英文大小写不敏感：小写关键词命中说明与概况里的原文。
    await input.fill('sqlite');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('检索归纳样例');
    await input.fill('cert_authority');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('检索动态样例');

    // 普通符号与 emoji 按文本处理，不当成通配符。
    await input.fill('100%_\\');
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText('检索样例句');
    await input.fill('🙂');
    await expect(options).toHaveCount(1);

    // 草稿不参与搜索。
    await input.press('Escape');
    await page.getByRole('button', { name: /首页/ }).first().click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await body.fill('尚未提交的草稿独有关键词 草稿专属词');
    await openSearch();
    await input.fill('草稿专属词');
    await expect(options).toHaveCount(0);
    await expect(palette.getByText(/没有匹配/)).toBeVisible();
    await input.press('Escape');

    // 打开手记结果：进入抽屉。
    await page
      .getByRole('button', { name: /随手记/ })
      .first()
      .click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await openSearch();
    await input.fill('检索样例句');
    await options.first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: '编辑手记正文' })).toHaveValue(
      /检索样例句包含/,
    );
    await drawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(drawer).toHaveCount(0);

    // 打开归纳结果：进入归纳详情。
    await openSearch();
    await input.fill('检索归纳样例');
    await options.filter({ hasText: '检索归纳样例' }).first().click();
    await expect(page.getByRole('heading', { name: '检索归纳样例', exact: true })).toBeVisible();

    // 打开事务结果：进入事务详情（已归档状态）。
    await openSearch();
    await input.fill('检索事务样例');
    await options.filter({ hasText: '检索事务样例' }).first().click();
    await expect(page.locator('.detail-title')).toContainText('检索事务样例');
    await expect(page.locator('.status-pill').first()).toContainText('已归档');

    // 打开动态结果：定位到所属事务并高亮那条动态。
    await openSearch();
    await input.fill('检索动态样例');
    await options.first().click();
    await expect(page.locator('.timeline .entry h4').first()).toContainText('检索动态样例');
    await page.screenshot({ path: 'test-results/search-open-entry.png', animations: 'disabled' });

    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
