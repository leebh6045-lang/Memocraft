import { app, BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  STARTUP_DURATION_MS,
  STARTUP_WINDOW_ARGUMENT,
  WINDOW_CONTENT_READY,
  WINDOW_PRESENTED,
} from '../shared/window-lifecycle';
import { isTrustedSender } from './window';

const CARD_READY_TIMEOUT_MS = 3_000;
const MAIN_READY_TIMEOUT_MS = 30_000;

/** 只在进程初次启动时创建；恢复已有窗口不会重新创建或重新计时。 */
export class StartupWindow {
  private readonly card: BrowserWindow;
  private readonly cardUrl: string;
  private readonly mainUrl: string;
  private main: BrowserWindow | undefined;
  private cardPainted = false;
  private cardContentReady = false;
  private mainPainted = false;
  private mainContentReady = false;
  private shownAt: number | undefined;
  private skipped = false;
  private completed = false;
  private disposed = false;
  private cardTimeout: ReturnType<typeof setTimeout> | undefined;
  private mainTimeout: ReturnType<typeof setTimeout> | undefined;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveCompletion: () => void = () => undefined;
  private rejectCompletion: (error: Error) => void = () => undefined;
  readonly completion: Promise<void>;

  constructor(rendererUrl: string) {
    this.mainUrl = rendererUrl;
    const url = new URL(rendererUrl);
    url.searchParams.set('startup', '1');
    url.searchParams.set('version', app.getVersion());
    this.cardUrl = url.href;
    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    // 启动装配尚未 await 时也可能失败，先处理拒绝，调用方仍会收到原始失败。
    void this.completion.catch(() => undefined);
    this.card = new BrowserWindow({
      width: 530,
      height: 328,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      title: 'Memocraft 启动',
      webPreferences: {
        preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
        additionalArguments: [STARTUP_WINDOW_ARGUMENT],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    this.card.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.card.webContents.on('will-navigate', (event) => event.preventDefault());
    this.card.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    this.card.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.card.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    this.card.webContents.session.setPermissionCheckHandler(() => false);
    this.card.once('ready-to-show', this.onCardPainted);
    this.card.once('closed', this.skipCard);
    this.card.webContents.once('render-process-gone', this.skipCard);
    ipcMain.on(WINDOW_CONTENT_READY, this.onContentReady);
    // 存储尚未就绪时卡片可能是唯一窗口；装饰失败不能触发 Electron 默认退出。
    app.on('window-all-closed', this.keepAliveDuringStartup);
    // before-quit 可能被草稿保存握手取消；只有确认退出才释放启动交接。
    app.once('will-quit', this.dispose);
    this.cardTimeout = setTimeout(this.skipCard, CARD_READY_TIMEOUT_MS);
    void this.card.loadURL(this.cardUrl).catch(this.skipCard);
  }

  attachMainWindow(window: BrowserWindow): void {
    this.main = window;
    window.once('ready-to-show', this.onMainPainted);
    window.once('closed', this.dispose);
    window.webContents.once('render-process-gone', this.onMainCrashed);
    this.mainTimeout = setTimeout(() => {
      this.fail(new Error('主界面未能在规定时间内完成启动。请重新打开应用。'));
    }, MAIN_READY_TIMEOUT_MS);
  }

  /** 激活和第二实例只能恢复已有窗口，不能跳过启动条件或重播卡片。 */
  activate = (): void => {
    if (this.disposed) return;
    if (!this.completed) {
      if (!this.card.isDestroyed() && this.card.isVisible()) this.card.showInactive();
      return;
    }
    if (!this.main || this.main.isDestroyed()) return;
    if (this.main.isMinimized()) this.main.restore();
    this.main.show();
    this.main.focus();
  };

  private onContentReady = (event: IpcMainEvent, theme: unknown): void => {
    if (theme !== 'light' && theme !== 'dark') return;
    if (!this.card.isDestroyed() && isTrustedSender(event, this.card, this.cardUrl)) {
      this.cardContentReady = true;
      this.showCardWhenReady();
    } else if (this.main && isTrustedSender(event, this.main, this.mainUrl)) {
      this.main.setBackgroundColor(theme === 'dark' ? '#17181c' : '#f7f6f3');
      if (this.completed) {
        // 渲染器重载仍会通知就绪，但只释放预备状态，不能再播放启动入场。
        this.main.webContents.send(WINDOW_PRESENTED, false);
        return;
      }
      this.mainContentReady = true;
      this.revealWhenReady();
    }
  };

  private onCardPainted = (): void => {
    this.cardPainted = true;
    this.showCardWhenReady();
  };

  private onMainPainted = (): void => {
    this.mainPainted = true;
    this.revealWhenReady();
  };

  private showCardWhenReady(): void {
    if (
      this.disposed ||
      this.skipped ||
      this.shownAt !== undefined ||
      !this.cardPainted ||
      !this.cardContentReady
    )
      return;
    clearTimeout(this.cardTimeout);
    this.card.showInactive();
    this.shownAt = performance.now();
    // 短线在卡片实际显示后才起跑，避免隐藏预渲染时提前滑过。
    this.card.webContents.send(WINDOW_PRESENTED, true);
    this.revealWhenReady();
  }

  private revealWhenReady(): void {
    if (
      this.disposed ||
      this.completed ||
      !this.mainPainted ||
      !this.mainContentReady ||
      (!this.skipped && this.shownAt === undefined)
    )
      return;
    clearTimeout(this.revealTimer);
    const remaining = this.skipped
      ? 0
      : Math.max(0, STARTUP_DURATION_MS - (performance.now() - (this.shownAt ?? 0)));
    if (remaining > 0) {
      this.revealTimer = setTimeout(() => this.revealWhenReady(), Math.ceil(remaining));
      return;
    }
    this.completed = true;
    this.cleanupHandoff();
    if (!this.card.isDestroyed()) this.card.destroy();
    if (this.main && !this.main.isDestroyed()) {
      this.main.show();
      this.main.focus();
      // 主页面隐藏时只预备动画；卡片销毁、原生窗口显示后才通知真正入场。
      this.main.webContents.send(WINDOW_PRESENTED, true);
    }
    this.resolveCompletion();
  }

  /** 装饰加载失败直接降级到主窗口，不能把用户锁在启动画面。 */
  private skipCard = (): void => {
    if (this.disposed || this.completed || this.skipped) return;
    this.skipped = true;
    clearTimeout(this.cardTimeout);
    if (!this.card.isDestroyed()) this.card.destroy();
    this.revealWhenReady();
  };

  private onMainCrashed = (): void => {
    this.fail(new Error('主界面在启动时意外退出。请重新打开应用。'));
  };

  private keepAliveDuringStartup = (): void => undefined;

  private fail(error: Error): void {
    this.rejectCompletion(error);
    this.dispose();
  }

  private cleanupHandoff(): void {
    clearTimeout(this.cardTimeout);
    clearTimeout(this.mainTimeout);
    clearTimeout(this.revealTimer);
    app.removeListener('window-all-closed', this.keepAliveDuringStartup);
    this.card.removeListener('ready-to-show', this.onCardPainted);
    this.card.removeListener('closed', this.skipCard);
    if (!this.card.isDestroyed())
      this.card.webContents.removeListener('render-process-gone', this.skipCard);
    this.main?.removeListener('ready-to-show', this.onMainPainted);
    if (this.main && !this.main.isDestroyed())
      this.main.webContents.removeListener('render-process-gone', this.onMainCrashed);
  }

  private cleanup(): void {
    this.cleanupHandoff();
    // 交接后仍应答主页面重载；生命周期结束才释放这组最小监听。
    ipcMain.removeListener(WINDOW_CONTENT_READY, this.onContentReady);
    app.removeListener('will-quit', this.dispose);
    this.main?.removeListener('closed', this.dispose);
  }

  dispose = (): void => {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup();
    if (!this.card.isDestroyed()) this.card.destroy();
    this.resolveCompletion();
  };
}
