import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 3：一条手记被两个归纳收录，编辑正文后两处一致；
 * 移出或删除一个归纳不丢失手记与另一处关联。
 */
test('真实桌面：新建归纳、多重收录、抽屉反查与移出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-topics-'));
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

    // 两条手记：分别提交，草稿在提交后重新开始。
    await body.fill('归纳验收样例一：事务回滚');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    await body.fill('归纳验收样例二：证书链排查');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');

    // 首页「新建归纳」应直接进入归纳模块并打开新建表单。
    await page
      .getByRole('button', { name: /新建归纳/ })
      .first()
      .click();
    const createDialog = page.getByRole('dialog', { name: '新建归纳' });
    await expect(createDialog).toBeVisible();
    await createDialog
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('本地数据库');
    await createDialog
      .getByRole('textbox', { name: '说明（可选）', exact: true })
      .fill('事务、备份与查询');
    await createDialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: '本地数据库', exact: true })).toBeVisible();
    // 基础信息在右侧抽屉里编辑：改动后自动保存并给出状态反馈。
    await page.getByRole('button', { name: '编辑基础信息' }).click();
    const editDrawer = page.getByRole('dialog', { name: '编辑基础信息' });
    await expect(editDrawer).toBeVisible();
    await editDrawer
      .getByRole('textbox', { name: '说明', exact: true })
      .fill('事务、备份与查询（已核对）');
    await expect(editDrawer.locator('.draft-status')).toContainText('已保存', { timeout: 8000 });
    // 关掉再打开，说明应已落库。
    await editDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(editDrawer).toHaveCount(0);
    await page.getByRole('button', { name: '编辑基础信息' }).click();
    await expect(
      page
        .getByRole('dialog', { name: '编辑基础信息' })
        .getByRole('textbox', { name: '说明', exact: true }),
    ).toHaveValue('事务、备份与查询（已核对）');
    await page
      .getByRole('dialog', { name: '编辑基础信息' })
      .getByRole('button', { name: /^关闭/ })
      .click();
    await expect(page.getByRole('dialog', { name: '编辑基础信息' })).toHaveCount(0);

    // 第二个归纳：从列表页新建。
    await page
      .getByRole('button', { name: /主题归纳/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: /新建归纳/ })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: '新建归纳' })
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('服务器运维');
    await page
      .getByRole('dialog', { name: '新建归纳' })
      .getByRole('button', { name: '创建' })
      .click();
    await expect(page.getByRole('heading', { name: '服务器运维', exact: true })).toBeVisible();

    // 收录第一条手记：选择器里勾选后一次提交。
    // 详情页页头与空状态各有一个同名入口，这里固定用页头那个。
    const collectButton = page
      .locator('.detail-head')
      .getByRole('button', { name: '收录已有手记' });
    const collectInto = async (noteTitleText: string) => {
      await collectButton.click();
      const picker = page.getByRole('dialog', { name: '收录手记' });
      await expect(picker).toBeVisible();
      await picker.getByRole('checkbox', { name: noteTitleText }).check();
      await expect(picker.getByText('已选 1 条')).toBeVisible();
      await picker.getByRole('button', { name: '收录', exact: true }).click();
      await expect(picker).toHaveCount(0);
    };
    await collectInto('归纳验收样例一：事务回滚');
    // 归纳详情默认连读：收录进来的手记成为一个小节，目录同步。
    await expect(page.locator('.doc-sec')).toHaveCount(1);
    await expect(page.locator('.doc-toc a')).toHaveCount(1);
    await expect(page.getByText('已收录 1 条手记')).toBeVisible();

    // 切到网格：卡片撑满格子，标签贴底，卡片不会再按内容收缩。
    const detailLayouts = page.getByRole('radiogroup', { name: '呈现方式' });
    await detailLayouts.getByRole('radio', { name: '网格' }).click();
    const detailCard = page.locator('.topic-note .card');
    await expect(detailCard).toHaveCount(1);
    const noteBox = await detailCard.first().boundingBox();
    const wrapperBox = await page.locator('.topic-note').first().boundingBox();
    if (!noteBox || !wrapperBox) throw new Error('归纳内的卡片没有渲染出来。');
    expect(Math.abs(noteBox.width - wrapperBox.width)).toBeLessThan(2);
    await detailLayouts.getByRole('radio', { name: '连读' }).click();

    // 第二个归纳也收录同一条手记。
    await page
      .getByRole('button', { name: /主题归纳/ })
      .first()
      .click();
    // 集合卡片的可读名称带序号，按文本定位更稳。
    await page.locator('.card.collection').filter({ hasText: '本地数据库' }).click();
    await expect(page.getByRole('heading', { name: '本地数据库', exact: true })).toBeVisible();
    await collectInto('归纳验收样例一：事务回滚');

    await page.screenshot({ path: 'test-results/topics-detail.png', animations: 'disabled' });

    // 反方向：在手记详情里把这手记收录到一个已有归纳。
    // 选择器这时必须列归纳（而不是手记），并且把已经收录的归纳标出来。
    const openNoteDrawer = async (noteTitleText: string) => {
      await page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name: /^手记/ })
        .first()
        .click();
      await expect(page.getByRole('heading', { name: '手记', exact: true })).toBeVisible();
      await expect(page.locator('.page-enter-active')).toHaveCount(0);
      await page.locator('.card').filter({ hasText: noteTitleText }).click();
      const panel = page.getByRole('dialog', { name: '手记详情' });
      await expect(panel).toBeVisible();
      return panel;
    };

    let noteDrawer = await openNoteDrawer('归纳验收样例二：证书链排查');
    await noteDrawer.getByRole('button', { name: '＋ 收录到归纳' }).click();
    const topicPicker = page.getByRole('dialog', { name: '收录到归纳' });
    await expect(topicPicker).toBeVisible();
    await expect(topicPicker.getByRole('checkbox', { name: '本地数据库' })).toBeEnabled();
    await expect(topicPicker.getByRole('checkbox', { name: '服务器运维' })).toBeEnabled();
    await expect(topicPicker.getByText('已选 0 个')).toBeVisible();
    await topicPicker.getByRole('checkbox', { name: '本地数据库' }).check();
    await expect(topicPicker.getByText('已选 1 个')).toBeVisible();
    await topicPicker.getByRole('button', { name: '收录', exact: true }).click();
    await expect(topicPicker).toHaveCount(0);
    await expect(
      page.locator('.toast').filter({ hasText: '已收录到「本地数据库」' }),
    ).toBeVisible();
    await expect(
      noteDrawer.locator('.drawer-meta').getByRole('button', { name: '本地数据库', exact: true }),
    ).toBeVisible();

    // 再打开：刚收录的归纳要带「已收录」标记且不可重复选择。
    await noteDrawer.getByRole('button', { name: '＋ 收录到归纳' }).click();
    await expect(page.getByRole('dialog', { name: '收录到归纳' })).toBeVisible();
    await expect(
      page
        .getByRole('dialog', { name: '收录到归纳' })
        .getByRole('checkbox', { name: '本地数据库' }),
    ).toBeDisabled();
    await expect(
      page.getByRole('dialog', { name: '收录到归纳' }).getByText('已收录'),
    ).toBeVisible();

    // 抽屉里直接新建归纳：新建后自动勾上，和已有选择一起提交。
    await page
      .getByRole('dialog', { name: '收录到归纳' })
      .getByRole('button', { name: '＋ 新建归纳' })
      .click();
    const newTopicDialog = page.getByRole('dialog', { name: '新建归纳' });
    await expect(newTopicDialog).toBeVisible();
    await newTopicDialog
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('归档与检索');
    await newTopicDialog.getByRole('button', { name: '创建', exact: true }).click();
    await expect(newTopicDialog).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '收录到归纳' })).toBeVisible();
    await expect(
      page
        .getByRole('dialog', { name: '收录到归纳' })
        .getByRole('checkbox', { name: '归档与检索' }),
    ).toBeChecked();
    await expect(page.getByText('已选 1 个')).toBeVisible();
    await page
      .getByRole('dialog', { name: '收录到归纳' })
      .getByRole('button', { name: '收录', exact: true })
      .click();
    await expect(
      page.locator('.toast').filter({ hasText: '已收录到「归档与检索」' }),
    ).toBeVisible();
    await expect(
      noteDrawer.locator('.drawer-meta').getByRole('button', { name: '归档与检索', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: 'test-results/topics-collect-from-note.png',
      animations: 'disabled',
    });
    await noteDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(noteDrawer).toHaveCount(0);

    // 抽屉反查：手记应显示所属的两个归纳。
    noteDrawer = await openNoteDrawer('归纳验收样例一：事务回滚');
    const drawer = noteDrawer;
    const collectSection = drawer.locator('.drawer-meta');
    await expect(
      collectSection.getByRole('button', { name: '本地数据库', exact: true }),
    ).toBeVisible();
    await expect(
      collectSection.getByRole('button', { name: '服务器运维', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/topics-drawer.png', animations: 'disabled' });

    // 改正文后两个归纳仍然收录同一条手记。
    await drawer
      .getByRole('textbox', { name: '编辑手记正文' })
      .fill('归纳验收样例一：事务回滚（已核对）');
    await expect(drawer.getByText('已保存', { exact: true })).toBeVisible();

    // 从抽屉移出一个归纳：手记仍在「手记」列表，另一个归纳的收录不受影响。
    await collectSection.getByRole('button', { name: '从「本地数据库」移出', exact: true }).click();
    await expect(
      collectSection.getByRole('button', { name: '本地数据库', exact: true }),
    ).toHaveCount(0);
    await expect(
      collectSection.getByRole('button', { name: '服务器运维', exact: true }),
    ).toBeVisible();
    // 连续操作会有多条提示条，按文案定位当次那一条。
    const toast = page.locator('.toast').filter({ hasText: '已从归纳移出' });
    await expect(toast).toBeVisible();
    await page.screenshot({ path: 'test-results/topics-undo-toast.png', animations: 'disabled' });

    // 撤销只在提示条存续期间有效：这里点撤销应恢复收录。
    await toast.getByRole('button', { name: '撤销' }).click();
    await expect(
      collectSection.getByRole('button', { name: '本地数据库', exact: true }),
    ).toBeVisible();

    await drawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(drawer).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(2);

    // 重启后归纳、收录关系与手记都应保留。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await reopened
      .getByRole('button', { name: /主题归纳/ })
      .first()
      .click();
    await expect(reopened.locator('.card.collection')).toHaveCount(3);
    await expect(reopened.getByText('1 条手记').first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
