import { app, dialog, Menu, net, safeStorage } from 'electron';
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
import { AiCredentialStore } from './ai-credentials';
import { AiService } from './ai-service';
import { AiSuggestionService } from './ai-suggestion-service';
import { AiAskService } from './ai-ask-service';
import { AiPeriodSummaryService } from './ai-period-summary-service';
import { AiImageReader } from './ai-image-reader';
import { DeepSeekClient } from '../services/deepseek-client';
import { registerAiIpc } from './ipc/ai';
import { registerHelpIpc } from './ipc/help';
import { StartupWindow } from './startup-window';

let startup: StartupWindow | undefined;

// 从终端启动后若终端被关闭，写 stdout/stderr 会失败（EIO/EPIPE）。Electron 内部也会写日志
// （例如向已销毁的界面发消息时 console.error），没有监听就会变成"主进程未捕获异常"弹窗。
// 日志写不出去不影响数据与界面，只忽略这两类写入错误，其他错误照常抛出。
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EIO' || error.code === 'EPIPE') return;
    throw error;
  });
}

// 自定义协议必须在应用就绪前登记权限，否则界面无法加载本地图片。
registerImageScheme();

// 测试同时隔离数据库与 Chromium 外观/缓存，不污染日常开发的窗口偏好。
const isolatedDirectory = process.env.MEMOCRAFT_DATA_DIR;
if (isolatedDirectory && isAbsolute(isolatedDirectory)) {
  // AI 恢复测试把 shell 与知识库设为兄弟目录，避免整库替换删除测试凭据。
  const shellDirectory = process.env.MEMOCRAFT_USER_DATA_DIR ?? join(isolatedDirectory, 'shell');
  if (isAbsolute(shellDirectory)) {
    mkdirSync(shellDirectory, { recursive: true });
    app.setPath('userData', shellDirectory);
  }
}

async function start(): Promise<void> {
  await app.whenReady();
  if (process.platform === 'darwin') app.dock?.setIcon(getApplicationIconPath());
  const testDataDirectory = process.env.MEMOCRAFT_DATA_DIR;
  if (testDataDirectory && !isAbsolute(testDataDirectory))
    throw new Error('隔离数据目录必须使用绝对路径。');
  if (
    process.env.MEMOCRAFT_USER_DATA_DIR &&
    (!testDataDirectory || !isAbsolute(process.env.MEMOCRAFT_USER_DATA_DIR))
  )
    throw new Error('隔离应用配置目录必须配合隔离数据目录并使用绝对路径。');
  const dataDirectory =
    testDataDirectory ??
    join(app.getPath('userData'), ...(app.isPackaged ? ['data'] : ['development', 'data']));
  const migrationsDirectory = app.isPackaged
    ? join(process.resourcesPath, 'migrations')
    : join(app.getAppPath(), 'migrations');
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  const rendererUrl = devUrl
    ? new URL(devUrl).href
    : pathToFileURL(fileURLToPath(new URL('../renderer/index.html', import.meta.url))).href;
  startup = new StartupWindow(rendererUrl);
  // 监听覆盖整个初始化阶段，重复启动或 Dock 激活也不能提前显示隐藏主窗口。
  app.on('second-instance', () => startup?.activate());
  app.on('activate', () => startup?.activate());
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

  // Windows/Linux 的菜单是画在窗口里的，留着会在标题栏下方多出一条 Edit / Window 菜单，
  // 与 macOS 的呈现（菜单在系统菜单栏，窗口内干净）不一致，因此这两个平台不注册应用菜单。
  // 菜单角色只提供展示入口，撤销/复制/粘贴等由 Chromium 原生处理，不受影响；DevTools
  // 改为通过 --remote-debugging-port、环境变量或源码调试，不再依赖菜单项。
  if (process.platform === 'darwin') {
    const menu: Electron.MenuItemConstructorOptions[] = [
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  } else {
    Menu.setApplicationMenu(null);
  }
  const window = createWindow();
  startup.attachMainWindow(window);
  // 图片协议只由本窗口所属会话的存储能力应答，不注册到默认会话。
  serveImageProtocol(window.webContents.session, store);
  // 凭据在知识库目录之外；开发、正式与隔离测试各自使用对应 userData。
  const credentialDirectory = join(
    app.getPath('userData'),
    ...(app.isPackaged || testDataDirectory ? [] : ['development']),
    'credentials',
  );
  const credentials = new AiCredentialStore(credentialDirectory, {
    isAvailable: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value),
  });
  const client = new DeepSeekClient((url, init) => net.fetch(url, init));
  const ai = new AiService({
    request: (request) => store.request(request),
    credentials,
    // Chromium 网络栈沿用系统代理配置，避免 Node fetch 绕过桌面网络设置。
    client,
  });
  const imageReader = new AiImageReader({ request: (request) => store.request(request) });
  const suggestions = new AiSuggestionService({
    request: (request) => store.request(request),
    resolveCallContext: () => ai.resolveCallContext(),
    images: imageReader,
    client,
  });
  const asks = new AiAskService({
    request: (request) => store.request(request),
    resolveCallContext: () => ai.resolveCallContext(),
    client,
  });
  let aiPaused = false;
  const periods = new AiPeriodSummaryService({
    request: (request) => store.request(request),
    resolveCallContext: () => ai.resolveCallContext(),
    images: imageReader,
    client,
  });
  async function pauseAndDrainAi(): Promise<void> {
    aiPaused = true;
    const results = await Promise.allSettled([
      periods.stopAndDrain(),
      asks.stopAndDrain(),
      suggestions.stopAndDrain(),
      ai.stopAndDrain(),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  }
  const resumeAi = () => {
    aiPaused = false;
  };
  const unregister = registerStoreIpc(window, rendererUrl, store, {
    dataDirectory,
    beforeRestore: pauseAndDrainAi,
    afterRestore: resumeAi,
  });
  const unregisterAi = registerAiIpc(
    window,
    rendererUrl,
    ai,
    suggestions,
    asks,
    periods,
    () => aiPaused,
  );
  const unregisterHelp = registerHelpIpc(window, rendererUrl);
  coordinateWindowClose(window, rendererUrl, store, pauseAndDrainAi, resumeAi);
  window.once('closed', unregister);
  window.once('closed', unregisterAi);
  window.once('closed', unregisterHelp);
  await Promise.all([
    window.loadURL(rendererUrl).then(() => {
      // 恢复回滚这类事实必须让用户看到；不等待卡片退场才发送。
      if (startupNotice) window.webContents.send(CHANNELS.appNotice, startupNotice);
    }),
    // 页面加载与启动超时并行观察，加载卡住时也能立即走失败清理。
    startup.completion,
  ]);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void start().catch((error: unknown) => {
    startup?.dispose();
    dialog.showErrorBox(
      'Memocraft 无法启动',
      error instanceof AppError
        ? error.message
        : '本地数据或界面未能初始化。已有数据库未被删除。请检查数据目录访问权限、可用空间和应用资源，然后重新启动。',
    );
    app.exit(1);
  });
}
