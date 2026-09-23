import { app, dialog, Menu } from 'electron';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { StoreClient } from './store-client';
import { recoverInterruptedRestore } from '../storage/recovery';
import { CHANNELS } from '../shared/contracts';
import { createWindow, getApplicationIconPath } from './window';
import { registerStoreIpc } from './ipc/register';
import { registerImageScheme, serveImageProtocol } from './image-protocol';
import { coordinateWindowClose } from './close-window';
import { AppError } from '../shared/errors';
import { mkdirSync } from 'node:fs';

// 自定义协议必须在应用就绪前登记权限，否则界面无法加载本地图片。
registerImageScheme();

// 测试同时隔离数据库与 Chromium 外观/缓存，不污染日常开发的窗口偏好。
const isolatedDirectory = process.env.MEMOCRAFT_DATA_DIR;
if (isolatedDirectory && isAbsolute(isolatedDirectory)) {
  const shellDirectory = join(isolatedDirectory, 'shell');
  mkdirSync(shellDirectory, { recursive: true });
  app.setPath('userData', shellDirectory);
}

async function start(): Promise<void> {
  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.setIcon(getApplicationIconPath());
  const testDataDirectory = process.env.MEMOCRAFT_DATA_DIR;
  if (testDataDirectory && !isAbsolute(testDataDirectory))
    throw new Error('隔离数据目录必须使用绝对路径。');
  const dataDirectory =
    testDataDirectory ??
    join(app.getPath('userData'), ...(app.isPackaged ? ['data'] : ['development', 'data']));
  const migrationsDirectory = app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), 'migrations');
  // 启动检测：上一次恢复若被中断，先把恢复前的数据放回去，绝不打开半套数据。
  let startupNotice = '';
  try {
    if (recoverInterruptedRestore(dataDirectory) === 'rolled-back')
      startupNotice = '检测到上次恢复没有完成，已回滚到恢复前的数据。';
  } catch (error) {
    throw error instanceof AppError
      ? error
      : new AppError('STORAGE', '检测未完成的恢复时失败，已停止打开数据。');
  }
  const store = new StoreClient({ dataDirectory, migrationsDirectory });
  const initial = await store.request({ operation: 'load' });
  if (!initial.ok) throw new AppError(initial.error.code, initial.error.message);

  const menu: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  const window = createWindow();
  // 图片协议只由本窗口所属会话的存储能力应答，不注册到默认会话。
  serveImageProtocol(window.webContents.session, store);
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const rendererUrl = devUrl
    ? new URL(devUrl).href
    : pathToFileURL(fileURLToPath(new URL('../renderer/index.html', import.meta.url))).href;
  const unregister = registerStoreIpc(window, rendererUrl, store, { dataDirectory });
  coordinateWindowClose(window, rendererUrl, store);
  window.once('closed', unregister);
  app.on('second-instance', () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on('activate', () => {
    if (!window.isDestroyed()) {
      window.show();
      window.focus();
    }
  });
  await window.loadURL(rendererUrl);
  // 启动提示在界面就绪后送达：恢复回滚这类事实必须让用户看到，而不是只写日志。
  if (startupNotice) window.webContents.send(CHANNELS.appNotice, startupNotice);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch((error: unknown) => {
    dialog.showErrorBox(
      'Memocraft 无法启动',
      error instanceof AppError
        ? error.message
        : '本地数据或界面未能初始化。已有数据库未被删除。请检查数据目录访问权限、可用空间和应用资源，然后重新启动。',
    );
    app.exit(1);
  });
}
