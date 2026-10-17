import { waitForMainWindow } from './main-window';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 8：删除与恢复符合第 9 章规则；事务恢复不误恢复此前已删除的动态。
 * 覆盖删除前的影响面确认、回收站列表与来源上下文、恢复、以及父事务边界。
 */
test('真实桌面：删除影响面、回收站与恢复顺序', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-trash-'));
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
  const goHome = async (page: Awaited<ReturnType<ElectronApplication['firstWindow']>>) => {
    await page.getByRole('button', { name: /首页/ }).first().click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
  };

  try {
    app = await launch();
    const page = await waitForMainWindow(app);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(body).toBeVisible();
    const dialog = page.getByRole('dialog', { name: /删除/ });

    // 一条手记 + 收录它的归纳 + 引用它的事务与两条动态。
    await body.fill('会被多处引用的手记');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    await page
      .getByRole('button', { name: /新建归纳/ })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: '新建归纳' })
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('删除样例归纳');
    await page
      .getByRole('dialog', { name: '新建归纳' })
      .getByRole('button', { name: '创建' })
      .click();
    await page.locator('.detail-head').getByRole('button', { name: '收录已有手记' }).click();
    const topicPicker = page.getByRole('dialog', { name: '收录手记' });
    await topicPicker.getByRole('checkbox').first().check();
    await topicPicker.getByRole('button', { name: '收录', exact: true }).click();
    // 归纳详情默认连读；验证收录小节和真实标题，不依赖只有网格才出现的卡片。
    await expect(page.locator('.doc-sec')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: '会被多处引用的手记', exact: true }),
    ).toBeVisible();

    await goHome(page);
    await page
      .getByRole('button', { name: /新建事务/ })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: '新建事务' })
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('删除样例事务');
    await page
      .getByRole('dialog', { name: '新建事务' })
      .getByRole('button', { name: '创建' })
      .click();
    const addEntry = async (summary: string) => {
      await page.getByRole('button', { name: '＋ 记录动态' }).click();
      const drawer = page.getByRole('dialog', { name: '记录动态' });
      await drawer.getByRole('textbox', { name: '动态描述（必填）' }).fill(summary);
      await drawer.getByRole('button', { name: '记录动态' }).click();
      await expect(drawer).toHaveCount(0);
    };
    await addEntry('会被删除的动态');
    await addEntry('保留到最后的动态');
    await expect(page.locator('.timeline .entry')).toHaveCount(2);

    // 删除手记：确认框先列出受影响的收录与引用位置。
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await page.locator('.card').first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: '移到回收站' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('删除手记');
    await expect(dialog).toContainText('会从这些归纳里隐藏：删除样例归纳');
    await page.screenshot({ path: 'test-results/trash-impact.png', animations: 'disabled' });
    await dialog.getByRole('button', { name: '移到回收站' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.toast').filter({ hasText: '已移到回收站' })).toBeVisible();
    await expect(page.locator('.card')).toHaveCount(0);

    // 回收站入口在左下角「内测中」右侧，列表带来源上下文，可恢复。
    await page.getByRole('button', { name: /回收站/ }).click();
    await expect(page.getByRole('heading', { name: '回收站', exact: true })).toBeVisible();
    const rows = page.locator('.rows .row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('会被多处引用的手记');
    await expect(rows.first()).toContainText('原属归纳：删除样例归纳');
    await page.screenshot({ path: 'test-results/trash-list.png', animations: 'disabled' });
    await rows.first().getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('.rows .row')).toHaveCount(0);
    await expect(page.locator('.toast').filter({ hasText: '已恢复手记' })).toBeVisible();

    // 恢复后手记回到手记，归纳里的收录也原样回来。
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);
    await page
      .getByRole('button', { name: /主题归纳/ })
      .first()
      .click();
    await page.locator('.card.collection').first().click();
    await expect(page.locator('.doc-sec')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: '会被多处引用的手记', exact: true }),
    ).toBeVisible();

    // 事务：先单独删除一条动态，再删除事务。
    await page
      .getByRole('button', { name: /长期事务/ })
      .first()
      .click();
    await page.locator('.card.collection').first().click();
    await expect(page.locator('.timeline .entry')).toHaveCount(2);
    // 按描述精确定位要删除的那条动态，不依赖时间线排序。
    const removedSummary = '会被删除的动态';
    await page.getByRole('button', { name: `删除动态：${removedSummary}` }).click();
    await expect(dialog).toContainText('删除动态');
    await dialog.getByRole('button', { name: '移到回收站' }).click();
    await expect(page.locator('.timeline .entry')).toHaveCount(1);

    // 删除事务的入口只在编辑基础信息抽屉里。
    await page.getByRole('button', { name: '编辑基础信息' }).click();
    await page
      .getByRole('dialog', { name: '编辑基础信息' })
      .getByRole('button', { name: '移到回收站' })
      .click();
    await expect(dialog).toContainText('删除事务');
    await expect(dialog).toContainText('它的 1 条动态会一起隐藏');
    await expect(dialog).toContainText('此前单独删除的动态仍留在回收站');
    await dialog.getByRole('button', { name: '移到回收站' }).click();
    await expect(page.getByRole('heading', { name: '长期事务', exact: true })).toBeVisible();

    // 回收站里应同时有事务与那条单独删除的动态。
    await page.getByRole('button', { name: /回收站/ }).click();
    await expect(page.locator('.rows .row')).toHaveCount(2);
    await expect(page.locator('.rows')).toContainText('含 1 条动态');
    await expect(page.locator('.rows')).toContainText('（事务也在回收站）');

    // 父事务在回收站时，动态不能单独恢复。
    const entryRow = page.locator('.rows .row').filter({ hasText: removedSummary });
    await entryRow.getByRole('button', { name: '恢复' }).click();
    await expect(
      page.locator('.toast').filter({ hasText: '父事务还在回收站，请先恢复它' }),
    ).toBeVisible();
    await expect(page.locator('.rows .row')).toHaveCount(2);

    // 恢复事务：此前单独删除的动态仍留在回收站。
    // 动态行的来源上下文也含事务名，这里用只有事务行才有的「含 N 条动态」定位。
    await page
      .locator('.rows .row')
      .filter({ hasText: '含 1 条动态' })
      .getByRole('button', { name: '恢复' })
      .click();
    await expect(page.locator('.rows .row')).toHaveCount(1);
    await expect(page.locator('.rows')).toContainText(removedSummary);
    await page.screenshot({
      path: 'test-results/trash-parent-boundary.png',
      animations: 'disabled',
    });

    // 再恢复动态，时间线两条都在。
    await page.locator('.rows .row').first().getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('.rows .row')).toHaveCount(0);
    await page
      .getByRole('button', { name: /长期事务/ })
      .first()
      .click();
    await page.locator('.card.collection').first().click();
    await expect(page.locator('.timeline .entry')).toHaveCount(2);

    // 重启后回收站状态、事务与手记都保持。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await waitForMainWindow(app);
    reopened.on('pageerror', (error) => errors.push(error.message));
    await reopened.getByRole('button', { name: /回收站/ }).click();
    await expect(
      reopened.getByText('回收站是空的。删除的手记、归纳、事务与动态会留在这里。'),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
