import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 11：创建手记时用「选择标签」抽屉点选预设标签与自定义标签；
 * 卡片上的标签是独立胶囊，「已收录」用同尺寸蓝色胶囊表示（一个归纳不带数字、多个带 · N）；
 * 详情里仍然只能手写标签，卡片上的「收录于 X」已取消。
 */
test('真实桌面：选择标签抽屉、卡片标签胶囊与「已收录」标记', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-tags-'));
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
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(body).toBeVisible();

    // 补充区里的标签入口：一行，点开右侧抽屉。
    await body.fill('只配 cert.pem 会报 CERT_AUTHORITY_INVALID');
    await page.getByRole('button', { name: '补充', exact: true }).click();
    await page.getByRole('button', { name: '＋ 选择标签' }).click();
    const drawer = page.getByRole('dialog', { name: '选择标签' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('选几个标签，也可以先跳过。')).toBeVisible();

    // 跨组点两个预设标签：点标签不关抽屉，可以连续多选。
    await drawer.getByRole('button', { name: '踩坑', exact: true }).click();
    await drawer.getByRole('button', { name: '方法流程', exact: true }).click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('已选 2 个 · 也可以自己加标签')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '踩坑', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // 自定义标签：回车添加，也可以逗号分隔；预设与自定义在同一份标签里。
    const customInput = drawer.getByRole('textbox', { name: '自定义标签' });
    await customInput.fill('sqlite, 备份');
    await customInput.press('Enter');
    await expect(drawer.getByText('已选 4 个 · 也可以自己加标签')).toBeVisible();

    // 再点一次取消一个预设标签。
    await drawer.getByRole('button', { name: '方法流程', exact: true }).click();
    await expect(drawer.getByText('已选 3 个 · 也可以自己加标签')).toBeVisible();
    await drawer.getByRole('button', { name: '方法流程', exact: true }).click();
    await expect(drawer.getByText('已选 4 个 · 也可以自己加标签')).toBeVisible();

    // 完成：抽屉关闭，补充区显示已选胶囊，可以直接 × 移除。
    await drawer.getByRole('button', { name: '完成' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: '移除标签：踩坑' })).toBeVisible();
    await expect(page.getByRole('button', { name: '移除标签：备份' })).toBeVisible();
    await page.getByRole('button', { name: '移除标签：备份' }).click();
    await expect(page.getByRole('button', { name: '移除标签：备份' })).toHaveCount(0);

    await page.getByRole('textbox', { name: '标题（可选）', exact: true }).fill('证书链排查记录');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');

    // 卡片：三个标签胶囊，「已收录」只跟一个归纳时写「已收录」而不是 ×1。
    const openNotes = async () => {
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: /^手记/ })
        .first()
        .click();
      await expect(page.getByRole('heading', { name: '手记', exact: true })).toBeVisible();
      await expect(page.locator('.page-enter-active')).toHaveCount(0);
    };
    await openNotes();
    const card = page.locator('.card').filter({ hasText: '证书链排查记录' });
    await expect(card.locator('.tag-chip')).toHaveCount(3);
    await expect(card.locator('.tag-chip').filter({ hasText: '踩坑' })).toHaveCount(1);
    await expect(card.locator('.tag-chip').filter({ hasText: '方法流程' })).toHaveCount(1);
    await expect(card.locator('.tag-chip').filter({ hasText: 'sqlite' })).toHaveCount(1);
    await expect(card.locator('.collected-pill')).toHaveCount(0);
    await expect(card).not.toContainText('收录于');
    await page.screenshot({ path: 'test-results/tags-card-tags.png', animations: 'disabled' });

    // 收录到一个归纳：卡片出现「已收录」（不带数字）。
    const collectInto = async (topicTitle: string) => {
      await goHome(page);
      await page
        .getByRole('button', { name: /新建归纳/ })
        .first()
        .click();
      await page
        .getByRole('dialog', { name: '新建归纳' })
        .getByRole('textbox', { name: '标题（必填）', exact: true })
        .fill(topicTitle);
      await page
        .getByRole('dialog', { name: '新建归纳' })
        .getByRole('button', { name: '创建' })
        .click();
      await expect(page.locator('.detail-title')).toContainText(topicTitle);
      await page.locator('.detail-head').getByRole('button', { name: '收录已有手记' }).click();
      const picker = page.getByRole('dialog', { name: '收录手记' });
      await expect(picker).toBeVisible();
      await picker.getByRole('checkbox', { name: '证书链排查记录' }).check();
      await picker.getByRole('button', { name: '收录', exact: true }).click();
      await expect(picker).toHaveCount(0);
    };
    await collectInto('标签验收甲');
    await openNotes();
    await expect(card.locator('.collected-pill')).toHaveText(/已收录/);
    await expect(card.locator('.collected-pill')).not.toContainText('·');
    await expect(card.locator('.collected-pill')).toHaveAttribute('title', '已收录到：标签验收甲');

    // 再收录到第二个归纳：变成「已收录 · 2」。
    await collectInto('标签验收乙');
    await openNotes();
    await expect(card.locator('.collected-pill')).toContainText('已收录 · 2');
    // 归纳列表按最近创建在前，名字顺序不固定：这里只断言两个名字都出现。
    await expect(card.locator('.collected-pill')).toHaveAttribute(
      'title',
      /^已收录到：标签验收[甲乙]、标签验收[甲乙]$/,
    );
    await page.screenshot({ path: 'test-results/tags-card-collected.png', animations: 'disabled' });

    // 详情里仍然只有逗号分隔的输入框：手写补一个标签，卡片跟着更新。
    await card.click();
    const noteDrawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(noteDrawer).toBeVisible();
    const noteTags = noteDrawer.getByRole('textbox', { name: '编辑手记标签' });
    // 标签顺序就是点选顺序：踩坑 → 自定义 sqlite → 方法流程（中途取消过一次，排到了后面）。
    await expect(noteTags).toHaveValue('踩坑, sqlite, 方法流程');
    await noteTags.fill('踩坑, 方法流程, sqlite, 证书');
    await expect(noteDrawer.getByText('已保存')).toBeVisible();
    await noteDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(noteDrawer).toHaveCount(0);
    await openNotes();
    await expect(
      page.locator('.card').filter({ hasText: '证书链排查记录' }).locator('.tag-chip'),
    ).toHaveCount(4);

    // 重启后标签与「已收录 · 2」都还在。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await reopened
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    const reopenedCard = reopened.locator('.card').filter({ hasText: '证书链排查记录' });
    await expect(reopenedCard.locator('.tag-chip')).toHaveCount(4);
    await expect(reopenedCard.locator('.collected-pill')).toContainText('已收录 · 2');
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
