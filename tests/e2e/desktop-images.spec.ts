import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { PNG_2X3 } from '../fixtures/images';

/** 与主流程测试相同的启动/退出方式，数据目录独立，不影响其他用例。 */
test('真实桌面：粘贴图片、命名、放大查看与移出，重启后仍在', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-images-'));
  let app: ElectronApplication | undefined;
  const launch = async () =>
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
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '新手记', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '手记正文', exact: true }).fill('带图片的手记');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue('');
    await page
      .getByRole('button', { name: /随手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);
    await page.locator('.card').first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('这条手记还没有图片。')).toBeVisible();

    // 用合成粘贴事件覆盖剪贴板入口：真实剪贴板在自动化环境中不可靠。
    await page.evaluate(
      async (payload) => {
        const bytes = Uint8Array.from(atob(payload.base64), (character) => character.charCodeAt(0));
        const file = new File([bytes], '粘贴的截图.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      },
      { base64: Buffer.from(PNG_2X3).toString('base64') },
    );

    await expect(drawer.getByText('已粘贴图片')).toBeVisible();
    const thumbnail = drawer.getByRole('button', { name: '放大查看 粘贴的截图.png' });
    await expect(thumbnail).toBeVisible();
    // 图片通过自定义协议加载：onload 才能证明协议确实把字节送到了渲染进程。
    await expect
      .poll(() =>
        page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>('.gallery-item img');
          return image ? image.complete && image.naturalWidth > 0 : false;
        }),
      )
      .toBe(true);

    // 单独命名：写入数据库后才算成功，失败会保留输入并提示。
    const nameField = drawer.getByRole('textbox', { name: '图片名称' });
    await nameField.fill('架构草图');
    await nameField.press('Enter');
    await expect(drawer.getByText('名称已保存')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '放大查看 架构草图' })).toBeVisible();

    // 放大查看：模态浮层可关闭，关闭后焦点回到缩略图。
    await drawer.getByRole('button', { name: '放大查看 架构草图' }).click();
    const viewer = page.getByRole('dialog', { name: '查看图片' });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.viewer-image')).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-image-viewer.png',
      animations: 'disabled',
    });
    await viewer.getByRole('button', { name: /^关闭/ }).click();
    await expect(viewer).toHaveCount(0);
    // 关闭后焦点回到触发它的缩略图，即使列表因改名重建过节点。
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.thumb')).toBeFocused();
    await expect(drawer.getByRole('button', { name: '放大查看 架构草图' })).toBeFocused();
    await expect(drawer).toBeVisible();

    await page.screenshot({
      path: 'test-results/desktop-image-gallery.png',
      animations: 'disabled',
    });
    await drawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(drawer).toHaveCount(0);

    // 重启后图片仍在：元数据落库、文件留在附件目录。
    await quit(app);
    app = undefined;
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await page
      .getByRole('button', { name: /随手记/ })
      .first()
      .click();
    // 阅读流卡片露出附图：顶部写张数，缩略图仍按图片 ID 取图。
    const layouts = page.getByRole('radiogroup', { name: '呈现方式' });
    await layouts.getByRole('radio', { name: '阅读流' }).click();
    const streamCard = page.locator('.stream-card').first();
    await expect(streamCard).toContainText('1 张图');
    await expect(streamCard.locator('.stream-images img')).toHaveCount(1);
    await expect(streamCard.locator('.stream-images img')).toHaveAttribute('alt', '架构草图');
    await layouts.getByRole('radio', { name: '网格' }).click();
    await page.locator('.card').first().click();
    const reopened = page.getByRole('dialog', { name: '手记详情' });
    await expect(reopened.getByRole('button', { name: '放大查看 架构草图' })).toBeVisible();

    // 移出图片需要二次确认；确认后缩略图消失，但文件仍保留在附件目录。
    await reopened.getByRole('button', { name: '移出', exact: true }).click();
    await reopened.getByRole('button', { name: '确认移出', exact: true }).click();
    await expect(reopened.getByText('图片已移出这张手记')).toBeVisible();
    await expect(reopened.getByText('这条手记还没有图片。')).toBeVisible();

    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
