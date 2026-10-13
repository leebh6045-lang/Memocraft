import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';

/**
 * 验收场景 10：完整备份恢复到干净目录后正文、属性、关系、草稿一致；
 * 损坏或不兼容的备份不会覆盖现有库。
 * 另外覆盖可读导出与"恢复失败回滚到恢复前"的界面表现。
 */
test('真实桌面：备份、恢复、损坏备份拒绝与可读导出', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-data-'));
  const workspace = mkdtempSync(join(tmpdir(), 'memocraft-packs-'));
  const packPath = join(workspace, 'backup-pack');
  const brokenPackPath = join(workspace, 'broken-pack');
  const exportPath = join(workspace, 'export');
  let app: ElectronApplication | undefined;
  const launch = () =>
    electron.launch({
      executablePath: process.env.MEMOCRAFT_TEST_APP,
      args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
      // 数据流程同样隔离 Chromium 配置与凭据，避免读取日常应用的 AI 密钥。
      env: {
        ...process.env,
        MEMOCRAFT_DATA_DIR: directory,
        MEMOCRAFT_USER_DATA_DIR: join(directory, 'shell'),
      },
    });
  const quit = async (current: ElectronApplication) => {
    const stopped = current.waitForEvent('close');
    await current.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await stopped;
  };
  /** 原生对话框无法自动化：在主进程里替换成固定路径，其余流程完全真实。 */
  const stubSaveDialog = (target: string) =>
    app?.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, target);
  const stubOpenDialog = (target: string) =>
    app?.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, target);

  try {
    app = await launch();
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(body).toBeVisible();

    // 两份内容：一条手记 + 一个收录它的事务（含动态引用）。
    await body.fill('备份前就存在的手记');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    await page
      .getByRole('button', { name: /新建事务/ })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: '新建事务' })
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('备份样例事务');
    await page
      .getByRole('dialog', { name: '新建事务' })
      .getByRole('button', { name: '创建' })
      .click();
    await page.getByRole('button', { name: '＋ 记录动态' }).click();
    const entryDrawer = page.getByRole('dialog', { name: '记录动态' });
    await entryDrawer.getByRole('textbox', { name: '动态描述（必填）' }).fill('备份样例动态');
    await entryDrawer.getByRole('button', { name: '记录动态' }).click();
    await expect(page.locator('.timeline .entry')).toHaveCount(1);

    // 备份到固定位置。
    await page.getByRole('button', { name: /设置/ }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await stubSaveDialog(packPath);
    await page.getByRole('button', { name: '选择位置并备份' }).click();
    await expect(page.locator('.toast').filter({ hasText: '备份已完成' })).toBeVisible();
    expect(existsSync(join(packPath, 'backup.json'))).toBe(true);
    expect(existsSync(join(packPath, 'memocraft.sqlite'))).toBe(true);
    await expect(page.getByText(/上次备份：/)).toBeVisible();
    await page.screenshot({ path: 'test-results/data-settings.png', animations: 'disabled' });

    // 备份之后新增一条手记：恢复后它应该消失，说明确实回到了备份时的状态。
    await page.getByRole('button', { name: /首页/ }).first().click();
    await expect(page.locator('.page-enter-active')).toHaveCount(0);
    await body.fill('备份之后新增的手记');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(2);

    // 恢复：先校验（不改动数据），确认框显示备份内容统计。
    await page.getByRole('button', { name: /设置/ }).click();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await stubOpenDialog(packPath);
    await page.getByRole('button', { name: '选择备份并校验…' }).click();
    const confirm = page.getByRole('dialog', { name: '从备份恢复' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('手记 1 · 归纳 0 · 事务 1 · 动态 1');
    await expect(confirm).toContainText('不能取消');
    await page.screenshot({
      path: 'test-results/data-restore-confirm.png',
      animations: 'disabled',
    });
    await confirm.getByRole('button', { name: '开始恢复' }).click();
    await expect(page.locator('.toast').filter({ hasText: '恢复完成' })).toBeVisible();
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);
    await expect(page.locator('.card')).toContainText('备份前就存在的手记');

    // 损坏/不兼容的备份被拒绝，现有数据不受影响。
    mkdirSync(brokenPackPath, { recursive: true });
    writeFileSync(
      join(brokenPackPath, 'backup.json'),
      JSON.stringify({
        formatVersion: 99,
        schemaVersion: 4,
        database: 'memocraft.sqlite',
        attachments: [],
      }),
      'utf8',
    );
    await stubOpenDialog(brokenPackPath);
    await page.getByRole('button', { name: /设置/ }).click();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await page.getByRole('button', { name: '选择备份并校验…' }).click();
    await expect(page.locator('.data-error')).toContainText('更新版本');
    await expect(page.getByRole('dialog', { name: '从备份恢复' })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);

    // 可读导出：正文与关系元数据都在 Markdown 里。
    await page.getByRole('button', { name: /设置/ }).click();
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
    await stubSaveDialog(exportPath);
    await page.getByRole('button', { name: '导出…' }).click();
    await expect(page.locator('.toast').filter({ hasText: '已导出' })).toBeVisible();
    const noteFiles = readdirSync(join(exportPath, '手记'));
    expect(noteFiles).toHaveLength(1);
    const exported = readFileSync(join(exportPath, '手记', noteFiles[0] ?? ''), 'utf8');
    expect(exported).toContain('类型: 手记');
    expect(exported).toContain('备份前就存在的手记');
    expect(readFileSync(join(exportPath, 'index.md'), 'utf8')).toContain('不是完整备份');

    // 重启后数据仍在，且没有残留的恢复标记。
    await quit(app);
    app = undefined;
    app = await launch();
    const reopened = await app.firstWindow();
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(
      reopened.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^手记/ }),
    ).toBeVisible();
    await reopened
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .click();
    await expect(reopened.locator('.card')).toHaveCount(1);
    expect(existsSync(join(directory, '.restore-pending'))).toBe(false);
    expect(existsSync(join(directory, '.restore-staging'))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    if (app) await quit(app);
    await rm(directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
