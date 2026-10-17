import { waitForMainWindow } from './main-window';
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
import { PNG_2X3 } from '../fixtures/images';

/** 每个用例一个独立的临时数据目录，互不影响。 */
async function launchApp(directory: string): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: process.env.MEMOCRAFT_TEST_APP,
    args: process.env.MEMOCRAFT_TEST_APP ? [] : [resolve('.')],
    env: { ...process.env, MEMOCRAFT_DATA_DIR: directory },
  });
}

async function quitApp(current: ElectronApplication): Promise<void> {
  const stopped = current.waitForEvent('close');
  await current.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });
  await stopped;
}

/**
 * 用合成粘贴事件覆盖剪贴板入口：真实剪贴板在自动化环境中不可靠。
 * 事件派发在传入的元素上，再从那里向上冒泡到各自的粘贴处理位置。
 */
async function pasteImage(page: Page, selector: string, fileName: string): Promise<void> {
  await page.evaluate(
    async ({ target, name, base64 }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const file = new File([bytes], name, { type: 'image/png' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document
        .querySelector(target)
        ?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
    },
    { target: selector, name: fileName, base64: Buffer.from(PNG_2X3).toString('base64') },
  );
}

/** 与主流程测试相同的启动/退出方式，数据目录独立，不影响其他用例。 */
test('真实桌面：粘贴图片、命名、放大查看与移出，重启后仍在', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-images-'));
  let app: ElectronApplication | undefined;
  const launch = () => launchApp(directory);
  const quit = quitApp;
  try {
    app = await launch();
    let page = await waitForMainWindow(app);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await expect(page.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: '手记正文', exact: true }).fill('带图片的手记');
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '手记正文', exact: true })).toHaveValue('');
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);
    await page.locator('.card').first().click();
    const drawer = page.getByRole('dialog', { name: '手记详情' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('还没有图片。')).toBeVisible();

    // 抽屉打开时在文档上粘贴：手记详情的粘贴入口监听整个文档。
    await pasteImage(page, 'body', '粘贴的截图.png');

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
    let viewer = page.getByRole('dialog', { name: '查看图片' });
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.viewer-image')).toBeVisible();
    // 键盘路径在真实浏览器里断言：Esc 只关放大层，抽屉仍然在。
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.screenshot({
      path: 'test-results/desktop-image-viewer.png',
      animations: 'disabled',
    });
    await drawer.getByRole('button', { name: '放大查看 架构草图' }).click();
    await expect(viewer).toBeVisible();
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

    // 不重启也要立刻可见：列表缩略图的摘要在图集变化后必须失效重读。
    await drawer.getByRole('button', { name: /^关闭/ }).click();
    await expect(drawer).toHaveCount(0);
    const streamLayouts = page.getByRole('radiogroup', { name: '呈现方式' });
    await streamLayouts.getByRole('radio', { name: '阅读流' }).click();
    await expect(page.locator('.stream-card').first()).toContainText('1 张图');
    await expect(page.locator('.stream-card').first().locator('.stream-images img')).toHaveCount(1);
    await streamLayouts.getByRole('radio', { name: '网格' }).click();
    await expect(drawer).toHaveCount(0);

    // 重启后图片仍在：元数据落库、文件留在附件目录。
    await quit(app);
    app = undefined;
    app = await launch();
    page = await waitForMainWindow(app);
    // 重启后的窗口是新的 Page，不能继续用已关闭页面的放大层定位器。
    viewer = page.getByRole('dialog', { name: '查看图片' });
    page.on('pageerror', (error) => errors.push(error.message));
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
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

    // 归纳连读里点同一张附图也能放大查看：与图集共用同一层。
    await page
      .getByRole('button', { name: /主题归纳/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: /新建归纳/ })
      .first()
      .click();
    const createTopic = page.getByRole('dialog', { name: '新建归纳' });
    await createTopic
      .getByRole('textbox', { name: '标题（必填）', exact: true })
      .fill('图片验收归纳');
    await createTopic.getByRole('button', { name: '创建' }).click();
    await page.locator('.detail-head').getByRole('button', { name: '收录已有手记' }).click();
    const imagePicker = page.getByRole('dialog', { name: '收录手记' });
    await imagePicker.getByRole('checkbox', { name: /带图片的手记/ }).check();
    await imagePicker.getByRole('button', { name: '收录', exact: true }).click();
    await expect(imagePicker).toHaveCount(0);
    await expect(page.locator('.doc-sec')).toHaveCount(1);
    await page.locator('.doc-thumb').first().click();
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    // 关掉的只是放大层：连读小节还在。
    await expect(viewer).toHaveCount(0);
    await expect(page.locator('.doc-sec')).toHaveCount(1);

    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await page.locator('.card').first().click();
    const reopened = page.getByRole('dialog', { name: '手记详情' });
    await expect(reopened.getByRole('button', { name: '放大查看 架构草图' })).toBeVisible();

    // 移出图片需要二次确认；确认后缩略图消失，但文件仍保留在附件目录。
    await reopened.getByRole('button', { name: '移出', exact: true }).click();
    await reopened.getByRole('button', { name: '确认移出', exact: true }).click();
    await expect(reopened.getByText('图片已移出这张手记')).toBeVisible();
    await expect(reopened.getByText('还没有图片。')).toBeVisible();

    // 移出同样要立刻反映到列表：摘要缓存不能留着已经移出的图片。
    await reopened.getByRole('button', { name: /^关闭/ }).click();
    await expect(reopened).toHaveCount(0);
    await layouts.getByRole('radio', { name: '阅读流' }).click();
    const emptied = page.locator('.stream-card').first();
    await expect(emptied).not.toContainText('张图');
    await expect(emptied.locator('.stream-images img')).toHaveCount(0);

    expect(errors).toEqual([]);
    await quit(app);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/** 首页草稿就能加图片：不必先保存一条手记，保存后图片自动归属这条手记。 */
test('真实桌面：首页草稿粘贴图片，保存后成为这条手记的图片', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memocraft-draft-images-'));
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(directory);
    const page = await waitForMainWindow(app);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const body = page.getByRole('textbox', { name: '手记正文', exact: true });
    await expect(page.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    // 草稿区的图集只有「添加图片」与一句提示，添加时自动先保存草稿。
    await expect(page.getByRole('button', { name: '添加图片' })).toBeVisible();
    await expect(page.getByText('（支持粘贴图片）')).toBeVisible();
    await expect(page.locator('.gallery-grid')).toHaveCount(0);
    await body.fill('草稿阶段就带图片的手记');

    await pasteImage(page, 'textarea[aria-label="手记正文"]', '首页粘贴.png');
    await expect(page.getByRole('button', { name: '放大查看 首页粘贴.png' })).toBeVisible();
    const thumb = page.getByRole('button', { name: '放大查看 首页粘贴.png' });
    await expect(thumb).toBeVisible();

    // 草稿里的图片同样能放大查看，Esc 只关放大层。
    await thumb.click();
    const viewer = page.getByRole('dialog', { name: '查看图片' });
    await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    await expect(thumb).toBeFocused();

    // 保存手记：图片随同归属到这条手记，首页换成没有图片的新草稿。
    await page.getByRole('button', { name: '保存手记', exact: true }).click();
    await expect(body).toHaveValue('');
    await expect(page.locator('.gallery-grid')).toHaveCount(0);

    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(page.locator('.card')).toHaveCount(1);
    await page
      .getByRole('radiogroup', { name: '呈现方式' })
      .getByRole('radio', { name: '阅读流' })
      .click();
    const streamCard = page.locator('.stream-card').first();
    await expect(streamCard).toContainText('1 张图');
    await expect(streamCard.locator('.stream-images img')).toHaveCount(1);

    // 重启后图片仍在，说明草稿附图真正落了盘而不是只留在内存里。
    await quitApp(app);
    app = undefined;
    app = await launchApp(directory);
    const reopened = await waitForMainWindow(app);
    reopened.on('pageerror', (error) => errors.push(error.message));
    await expect(reopened.getByRole('heading', { name: '新建手记', exact: true })).toBeVisible();
    await reopened
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: /^手记/ })
      .first()
      .click();
    await expect(reopened.locator('.card').first()).toBeVisible();
    await reopened.locator('.card').first().click();
    await expect(
      reopened.getByRole('dialog', { name: '手记详情' }).getByRole('button', {
        name: '放大查看 首页粘贴.png',
      }),
    ).toBeVisible();

    expect(errors).toEqual([]);
    await quitApp(app);
    app = undefined;
  } finally {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
