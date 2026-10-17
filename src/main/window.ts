import { app, BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function getApplicationIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'brand', 'memocraft-app-icon.png')
    : fileURLToPath(new URL('../../resources/brand/memocraft-app-icon.png', import.meta.url));
}

export function createWindow(): BrowserWindow {
  // 开发与打包共用同一份品牌资源；相对当前模块解析，避免依赖启动目录。
  const applicationIcon = getApplicationIconPath();
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    title: 'Memocraft',
    icon: applicationIcon,
    backgroundColor: '#f5f4f1',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  // 初次显示交由启动协调器处理，防止 activate 或首帧事件提前露出主窗口。
  return window;
}

export function isTrustedSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow,
  rendererUrl: string,
): boolean {
  // 同时核对窗口、顶层 frame 与完整地址，不能只凭 IPC 通道名信任请求。
  return (
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame.url === rendererUrl
  );
}
