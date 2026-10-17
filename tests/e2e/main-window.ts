import { expect, type ElectronApplication, type Page } from '@playwright/test';

/** 启动卡片也是独立窗口；桌面业务用例只在主界面可见后继续操作。 */
export async function waitForMainWindow(app: ElectronApplication): Promise<Page> {
  let mainWindow: Page | undefined;
  await expect
    .poll(async () => {
      for (const page of app.windows()) {
        if (page.isClosed() || !page.url() || page.url() === 'about:blank') continue;
        if (new URL(page.url()).searchParams.get('startup') === '1') continue;
        const isShown = await app.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows().some(
              (window) => window.webContents.getURL() === url && window.isVisible(),
            ),
          page.url(),
        );
        if (isShown && (await page.locator('.app').isVisible())) {
          mainWindow = page;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  if (!mainWindow) throw new Error('Memocraft 主窗口未就绪。');
  return mainWindow;
}
