import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

/**
 * 验收场景 12：随手记可在网格、阅读流、按时间之间切换，按时间可选分段方式；
 * 知识归纳列表可在卡片与目录之间切换。选择记在本机，重启后保持；筛选、打开抽屉在各呈现下照常可用。
 * 分段的日期规则（最近一周按天、更早按月、跨年）由单元测试覆盖，这里的手记都是今天新建的。
 */
test('真实桌面：随手记三种呈现、按时间分段与归纳目录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-views-'));
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
  const openModule = async (page: Page, name: RegExp, heading: string) => {
    await page.getByRole('button', { name }).first().click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
  };

  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(body).toBeVisible();

    for (const text of [
      '呈现验收一：事务回滚\n- 先开事务\n- 失败时回滚',
      '呈现验收二：证书链排查',
      '呈现验收三：备份恢复演练',
    ]) {
      await body.fill(text);
      await page.getByRole('button', { name: '保存手记', exact: true }).click();
      await expect(body).toHaveValue('');
    }

    // 默认仍是改版前的网格；网格不分组，因此不显示分段方式。
    await openModule(page, /随手记/, '随手记');
    const layouts = page.getByRole('radiogroup', { name: '呈现方式' });
    await expect(layouts.getByRole('radio', { name: '网格' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('.grid .card')).toHaveCount(3);
    await expect(page.getByRole('combobox', { name: '按时间分段的方式' })).toHaveCount(0);

    // 标记筛选在左、呈现设置整组在右：呈现方式贴着工具栏右缘，分段方式在它左边。
    const toolbarBox = await page.locator('.list-toolbar').boundingBox();
    const layoutBox = await layouts.boundingBox();
    if (!toolbarBox || !layoutBox) throw new Error('工具栏或呈现切换没有渲染出来。');
    expect(toolbarBox.x + toolbarBox.width - (layoutBox.x + layoutBox.width)).toBeLessThan(2);

    // 阅读流：正文按 Markdown 渲染；点卡片打开同一个手记抽屉。
    await layouts.getByRole('radio', { name: '阅读流' }).click();
    const streamCard = page.locator('.stream-card').filter({ hasText: '呈现验收一' });
    await expect(page.locator('.stream-card')).toHaveCount(3);
    await expect(streamCard.locator('li')).toHaveText(['先开事务', '失败时回滚']);
    await streamCard.getByRole('button', { name: /呈现验收一/ }).click();
    const noteDrawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(noteDrawer).toBeVisible();
    await noteDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(noteDrawer).toHaveCount(0);

    // 阅读流默认按时间分段，没有开关：日期栏出现，宽卡片只写时刻，分段方式可切换。
    const grain = page.getByRole('combobox', { name: '按时间分段的方式' });
    await expect(page.getByRole('checkbox', { name: '按时间分段' })).toHaveCount(0);
    await expect(page.locator('.time-group .stream-card')).toHaveCount(3);
    await expect(page.locator('.time-group .time-mark')).toHaveText('今天');
    await expect(page.locator('.stream-card time').first()).toHaveText(/^\d{2}:\d{2}$/);
    await expect(grain).toBeVisible();
    const grainBox = await grain.boundingBox();
    if (!grainBox) throw new Error('分段方式下拉框没有渲染出来。');
    expect(Math.abs(layoutBox.x - (grainBox.x + grainBox.width))).toBeLessThan(30);

    // 按时间：今天这一段带标记，卡片只写时刻；两种分段方式都能切换。
    await layouts.getByRole('radio', { name: '按时间' }).click();
    await expect(grain).toHaveValue('recent-days');
    await expect(grain).toContainText('最近优先');
    const today = page.locator('.time-group').first();
    await expect(page.locator('.time-group')).toHaveCount(1);
    await expect(today.locator('.time-mark')).toHaveText('今天');
    await expect(today.locator('.time-count')).toHaveText('3 条');
    await expect(today.locator('.card time').first()).toHaveText(/^\d{2}:\d{2}$/);
    await grain.selectOption('days');
    await expect(page.locator('.time-group .card')).toHaveCount(3);
    await page.screenshot({
      path: 'test-results/views-notes-timeline.png',
      animations: 'disabled',
    });

    // 分类筛选在按时间下照常生效，无匹配时明确显示空结果。
    await page.getByRole('button', { name: /^待办/ }).click();
    await expect(page.getByText('没有符合当前筛选条件的手记。')).toBeVisible();
    await page.getByRole('button', { name: /^全部/ }).click();
    await expect(page.locator('.time-group .card')).toHaveCount(3);

    // 归纳：同一条手记收进两个归纳，目录里标「另见 1」。
    const createTopicWith = async (title: string, notes: string[]) => {
      await openModule(page, /知识归纳/, '知识归纳');
      await page
        .getByRole('button', { name: /新建归纳/ })
        .first()
        .click();
      const dialog = page.getByRole('dialog', { name: '新建归纳' });
      await dialog.getByRole('textbox', { name: '标题', exact: true }).fill(title);
      await dialog.getByRole('button', { name: '创建' }).click();
      await expect(page.locator('.detail-title')).toContainText(title);
      await page.locator('.detail-head').getByRole('button', { name: '收录已有手记' }).click();
      const picker = page.getByRole('dialog', { name: '收录手记' });
      for (const note of notes)
        await picker.getByRole('checkbox', { name: new RegExp(note) }).check();
      await picker.getByRole('button', { name: '收录', exact: true }).click();
      await expect(picker).toHaveCount(0);
    };
    await createTopicWith('呈现验收归纳甲', ['呈现验收一', '呈现验收二']);
    await createTopicWith('呈现验收归纳乙', ['呈现验收二']);

    await openModule(page, /知识归纳/, '知识归纳');
    const arrangement = page.getByRole('radiogroup', { name: '排列方式' });
    await expect(arrangement.getByRole('radio', { name: '卡片' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await arrangement.getByRole('radio', { name: '目录' }).click();
    // “另见”辅助文本也包含其它归纳标题，只用目录主标题定位所属行。
    const entry = page.locator('.toc-item').filter({
      has: page.getByRole('button', { name: '呈现验收归纳甲', exact: true }),
    });
    await expect(entry).toHaveCount(1);
    await expect(entry.locator('.toc-count')).toHaveText('2 条');
    await expect(entry.locator('.toc-note')).toHaveCount(2);
    await expect(entry.locator('.toc-note').filter({ hasText: '呈现验收二' })).toContainText(
      '另见 1',
    );
    await expect(entry.locator('.toc-note').filter({ hasText: '呈现验收一' })).not.toContainText(
      '另见',
    );
    await page.screenshot({ path: 'test-results/views-topics-toc.png', animations: 'disabled' });

    // 目录里点手记直接打开抽屉；点归纳名进入详情。
    await entry.locator('.toc-note').filter({ hasText: '呈现验收一' }).click();
    await expect(noteDrawer).toBeVisible();
    await noteDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(noteDrawer).toHaveCount(0);
    await entry.getByRole('button', { name: '呈现验收归纳甲', exact: true }).click();
    await expect(page.locator('.detail-title')).toContainText('呈现验收归纳甲');

    // 归纳详情默认连读：每条手记一个小节，右侧本页目录与小节一一对应。
    const detailLayouts = page.getByRole('radiogroup', { name: '呈现方式' });
    await expect(detailLayouts.getByRole('radio', { name: '连读' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.locator('.doc-sec')).toHaveCount(2);
    await expect(page.locator('.doc-toc a')).toHaveCount(2);
    // 顺序默认最新在前：先建的那条排在后面。
    await expect(page.locator('.doc-sec h2').first()).toContainText('呈现验收二');

    // 最早在前：同一份数据换个方向读。
    await page
      .getByRole('radiogroup', { name: '排列顺序' })
      .getByRole('radio', { name: '最早在前' })
      .click();
    await expect(page.locator('.doc-sec h2').first()).toContainText('呈现验收一');
    const firstSectionId = await page.locator('.doc-sec').first().getAttribute('id');
    await expect(page.locator('.doc-toc a').first()).toHaveAttribute('href', `#${firstSectionId}`);
    await page.screenshot({ path: 'test-results/views-topic-reading.png', animations: 'disabled' });

    // 连读里的「打开」进抽屉；「移出」给出可撤销的提示条。
    await page.locator('.doc-sec').first().hover();
    await page.locator('.doc-sec').first().getByRole('button', { name: '打开' }).click();
    await expect(noteDrawer).toBeVisible();
    // 编辑正文位于textarea.value，不属于抽屉textContent；核对完整原文才能证明打开正确手记。
    await expect(noteDrawer.getByRole('textbox', { name: '编辑手记正文' })).toHaveValue(
      '呈现验收一：事务回滚\n- 先开事务\n- 失败时回滚',
    );
    await noteDrawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(noteDrawer).toHaveCount(0);
    await page.locator('.doc-sec').first().hover();
    await page.locator('.doc-sec').first().getByRole('button', { name: '移出' }).click();
    await expect(page.locator('.toast').filter({ hasText: '已从归纳移出' })).toBeVisible();
    await page
      .locator('.toast')
      .filter({ hasText: '已从归纳移出' })
      .getByRole('button', { name: '撤销' })
      .click();
    await expect(page.locator('.doc-sec')).toHaveCount(2);

    // 切到网格：卡片撑满格子，同一行宽高一致（曾经按内容收缩、标签上下错开）。
    await detailLayouts.getByRole('radio', { name: '网格' }).click();
    const detailCards = page.locator('.topic-note .card');
    await expect(detailCards).toHaveCount(2);
    const firstCard = await detailCards.nth(0).boundingBox();
    const secondCard = await detailCards.nth(1).boundingBox();
    if (!firstCard || !secondCard) throw new Error('归纳内的卡片没有渲染出来。');
    expect(Math.abs(firstCard.width - secondCard.width)).toBeLessThan(2);
    expect(Math.abs(firstCard.height - secondCard.height)).toBeLessThan(2);
    // 回到连读，供重启后核对偏好。
    await detailLayouts.getByRole('radio', { name: '连读' }).click();
    await expect(page.locator('.doc-sec')).toHaveCount(2);

    // 重启后：随手记仍是按时间 + 一律按天，归纳列表仍是目录，归纳详情仍是连读 + 最早在前。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(reopened.getByRole('textbox', { name: '手记正文', exact: true })).toBeVisible();
    await openModule(reopened, /随手记/, '随手记');
    await expect(
      reopened.getByRole('radiogroup', { name: '呈现方式' }).getByRole('radio', { name: '按时间' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(reopened.getByRole('combobox', { name: '按时间分段的方式' })).toHaveValue('days');
    await expect(reopened.locator('.time-group .card')).toHaveCount(3);
    await openModule(reopened, /知识归纳/, '知识归纳');
    await expect(reopened.locator('.toc-item')).toHaveCount(2);
    await reopened.getByRole('button', { name: '呈现验收归纳甲', exact: true }).click();
    await expect(
      reopened.getByRole('radiogroup', { name: '呈现方式' }).getByRole('radio', { name: '连读' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      reopened
        .getByRole('radiogroup', { name: '排列顺序' })
        .getByRole('radio', { name: '最早在前' }),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(reopened.locator('.doc-sec h2').first()).toContainText('呈现验收一');
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
  }
});
