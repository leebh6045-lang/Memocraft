import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_CONTENT_READY, WINDOW_PRESENTED } from '../../src/shared/window-lifecycle';

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    mainFrame = { url: '' };
    session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    };
    setWindowOpenHandler = vi.fn();
    send = vi.fn();
  }
  class Window extends EventEmitter {
    static instances: Window[] = [];
    webContents = new Contents();
    destroyed = false;
    visible = false;
    minimized = false;
    show = vi.fn(() => {
      this.visible = true;
    });
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    focus = vi.fn();
    restore = vi.fn(() => {
      this.minimized = false;
    });
    setBackgroundColor = vi.fn();
    loadURL = vi.fn(async (url: string) => {
      this.webContents.mainFrame.url = url;
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
      // Electron 没有 window-all-closed 订阅者时会在最后一个窗口关闭后自动退出。
      if (Window.instances.every((window) => window.isDestroyed())) {
        if (!app.emit('window-all-closed')) app.emit('will-quit');
      }
    });
    constructor() {
      super();
      Window.instances.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    isMinimized() {
      return this.minimized;
    }
  }
  const app = Object.assign(new EventEmitter(), { getVersion: () => '0.2.0' });
  return { BrowserWindow: Window, app, ipcMain: new EventEmitter() };
});

vi.mock('electron', () => electron);
const { StartupWindow } = await import('../../src/main/startup-window');
const { BrowserWindow } = await import('electron');
const url = 'file:///app/renderer/index.html';

/** 观察窗口显示与销毁，不用定时器伪装内容就绪。 */
describe('独立启动窗口交接', () => {
  let startup: InstanceType<typeof StartupWindow>;
  let main: InstanceType<typeof electron.BrowserWindow>;
  let card: InstanceType<typeof electron.BrowserWindow>;

  function notify(window: typeof main, theme = 'light', frameUrl?: string) {
    const frame = frameUrl ? { url: frameUrl } : window.webContents.mainFrame;
    electron.ipcMain.emit(
      WINDOW_CONTENT_READY,
      { sender: window.webContents, senderFrame: frame },
      theme,
    );
  }

  function cardReady() {
    card.emit('ready-to-show');
    notify(card);
  }

  function mainReady() {
    main.emit('ready-to-show');
    notify(main, 'dark');
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    electron.BrowserWindow.instances = [];
    startup = new StartupWindow(url);
    const first = electron.BrowserWindow.instances[0];
    if (!first) throw new Error('没有创建启动卡片。');
    card = first;
    const mainWindow = new BrowserWindow({ show: false });
    const createdMain = electron.BrowserWindow.instances.at(-1);
    if (!createdMain) throw new Error('没有创建主窗口。');
    main = createdMain;
    main.webContents.mainFrame.url = url;
    startup.attachMainWindow(mainWindow);
  });

  afterEach(() => {
    startup.dispose();
    electron.app.removeAllListeners();
    electron.ipcMain.removeAllListeners();
    vi.useRealTimers();
  });

  it('实际显示起算 500 毫秒，且首帧与内容必须全部就绪', async () => {
    await vi.advanceTimersByTimeAsync(200);
    notify(card);
    expect(card.isVisible()).toBe(false);
    expect(card.webContents.send).not.toHaveBeenCalled();
    // 加载短线必须在原生窗口可见后才收到起跑通知。
    card.webContents.send.mockImplementation(() => expect(card.isVisible()).toBe(true));
    card.emit('ready-to-show');
    expect(card.isVisible()).toBe(true);
    expect(card.webContents.send).toHaveBeenCalledExactlyOnceWith(WINDOW_PRESENTED, true);
    main.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(499);
    expect(main.isVisible()).toBe(false);
    notify(main, 'dark');
    expect(main.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await startup.completion;
    expect(main.isVisible()).toBe(true);
    expect(card.isDestroyed()).toBe(true);
    expect(main.setBackgroundColor).toHaveBeenCalledWith('#17181c');
    // 保留最小就绪监听，供渲染器重载释放预备状态；主窗口关闭才解除。
    expect(electron.ipcMain.listenerCount(WINDOW_CONTENT_READY)).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('真实初始化较慢时继续等待，不在准备好后再追加 500 毫秒', async () => {
    cardReady();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(main.isVisible()).toBe(false);
    mainReady();
    await startup.completion;
    expect(main.isVisible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('启动期间激活不提前显示，启动后只恢复已有窗口', async () => {
    cardReady();
    mainReady();
    startup.activate();
    expect(main.isVisible()).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    main.visible = false;
    main.minimized = true;
    startup.activate();
    expect(main.restore).toHaveBeenCalledOnce();
    expect(main.isVisible()).toBe(true);
    expect(electron.BrowserWindow.instances).toHaveLength(2);
    expect(card.showInactive).toHaveBeenCalledTimes(2);
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith(WINDOW_PRESENTED, true);
  });

  it('先销毁卡片并显示原生主窗口，再通知入场；页面重载不重播', async () => {
    cardReady();
    mainReady();
    main.webContents.send.mockImplementation(() => {
      expect(card.isDestroyed()).toBe(true);
      expect(main.isVisible()).toBe(true);
    });
    expect(main.webContents.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(main.webContents.send).toHaveBeenLastCalledWith(WINDOW_PRESENTED, true);
    main.webContents.send.mockClear();
    notify(main);
    expect(main.webContents.send).toHaveBeenCalledExactlyOnceWith(WINDOW_PRESENTED, false);
    main.destroy();
    expect(electron.ipcMain.listenerCount(WINDOW_CONTENT_READY)).toBe(0);
    expect(electron.app.listenerCount('will-quit')).toBe(0);
  });

  it('忽略外来 frame 和无效主题，合法通知仍可继续启动', async () => {
    card.emit('ready-to-show');
    notify(card, 'dark', 'file:///untrusted.html');
    notify(card, 'midnight');
    expect(card.isVisible()).toBe(false);
    notify(card);
    expect(card.isVisible()).toBe(true);
    mainReady();
    await vi.advanceTimersByTimeAsync(500);
    expect(main.isVisible()).toBe(true);
  });

  it('卡片加载失败降级到主窗口，清理卡片和计时器', async () => {
    mainReady();
    card.webContents.emit('render-process-gone');
    await startup.completion;
    expect(card.isDestroyed()).toBe(true);
    expect(main.isVisible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('卡片长时间不就绪时降级，不因装饰锁住主窗口', async () => {
    mainReady();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(main.isVisible()).toBe(true);
    expect(card.isDestroyed()).toBe(true);
  });

  it('主窗口尚未创建时卡片失败，仍保留进程继续初始化', async () => {
    startup.dispose();
    electron.BrowserWindow.instances = [];
    startup = new StartupWindow(url);
    const onlyWindow = electron.BrowserWindow.instances[0];
    if (!onlyWindow) throw new Error('没有创建启动卡片。');
    card = onlyWindow;
    card.webContents.emit('render-process-gone');
    expect(card.isDestroyed()).toBe(true);
    expect(electron.ipcMain.listenerCount(WINDOW_CONTENT_READY)).toBe(1);

    const mainWindow = new BrowserWindow({ show: false });
    const createdMain = electron.BrowserWindow.instances.at(-1);
    if (!createdMain) throw new Error('没有创建主窗口。');
    main = createdMain;
    main.webContents.mainFrame.url = url;
    startup.attachMainWindow(mainWindow);
    mainReady();
    await startup.completion;
    expect(main.isVisible()).toBe(true);
    expect(electron.app.listenerCount('window-all-closed')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('主界面超时会报告失败并关闭卡片', async () => {
    cardReady();
    const failed = expect(startup.completion).rejects.toThrow('规定时间');
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(card.isDestroyed()).toBe(true);
    expect(main.isVisible()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('主界面崩溃会报告失败并关闭卡片', async () => {
    cardReady();
    const failed = expect(startup.completion).rejects.toThrow('意外退出');
    main.webContents.emit('render-process-gone');
    await failed;
    expect(card.isDestroyed()).toBe(true);
    expect(main.isVisible()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('退出被保存握手取消时仍能继续显示和召回主窗口', async () => {
    cardReady();
    mainReady();
    electron.app.emit('before-quit');
    await vi.advanceTimersByTimeAsync(500);
    expect(main.isVisible()).toBe(true);
    main.visible = false;
    main.minimized = true;
    startup.activate();
    expect(main.isVisible()).toBe(true);
    expect(main.isMinimized()).toBe(false);
  });

  it('卡片被意外关闭后，交接不再访问已销毁的原生内容对象', async () => {
    cardReady();
    card.destroy();
    Object.defineProperty(card, 'webContents', {
      get() {
        throw new Error('Object has been destroyed');
      },
    });
    mainReady();
    await startup.completion;
    expect(main.isVisible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('退出时关闭卡片，迟到的计时回调不能再显示主窗口', async () => {
    cardReady();
    mainReady();
    electron.app.emit('will-quit');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(main.isVisible()).toBe(false);
    expect(card.isDestroyed()).toBe(true);
    expect(electron.ipcMain.listenerCount(WINDOW_CONTENT_READY)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
