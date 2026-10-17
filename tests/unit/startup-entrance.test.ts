// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { prepareStartupEntrance } from '../../src/renderer/src/startup-entrance';

/** 单元测试控制原生通知与动画完成，覆盖隐藏预备和失败后的可见性退路。 */
describe('主页面首次分层入场', () => {
  let present: (animate: boolean) => void;
  let dispose: () => void = () => undefined;
  let media: MediaQueryList;
  let remove: Mock<() => void>;
  let play: Mock<
    (
      frames: Keyframe[],
      options: KeyframeAnimationOptions,
    ) => {
      finished: Promise<void>;
      cancel: () => void;
    }
  >;
  let running: { finish: () => void; cancel: Mock<() => void> }[];
  const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    });
    document.body.innerHTML = `
      <div data-startup-part="shell"><aside data-startup-part="nav"></aside>
      <header data-startup-part="heading"></header><div data-startup-part="editor"></div>
      <div data-startup-part="status" class="is-empty"></div>
      <div data-startup-part="recent-heading"></div>
      ${'<button data-startup-part="recent-item"></button>'.repeat(4)}</div>
      <div data-startup-part="corner"></div>`;
    media = Object.assign(new EventTarget(), { matches: false }) as MediaQueryList;
    vi.stubGlobal('matchMedia', () => media);
    remove = vi.fn();
    window.memocraftWindow = {
      ready: vi.fn(),
      onPresented: (listener) => {
        present = listener;
        return remove;
      },
    };
    running = [];
    play = vi.fn(() => {
      let resolve: () => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      const finished = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const cancel = vi.fn(() => reject(new Error('animation cancelled')));
      running.push({ finish: resolve, cancel });
      return { finished, cancel };
    });
    // jsdom 没有实现 Web Animations，测试只替代这一个浏览器边界。
    Object.defineProperty(HTMLElement.prototype, 'animate', { value: play, configurable: true });
    dispose = prepareStartupEntrance();
  });

  afterEach(() => {
    dispose();
    delete window.memocraftWindow;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    if (originalAnimate) Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate);
    else Reflect.deleteProperty(HTMLElement.prototype, 'animate');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function show() {
    present(true);
    await vi.advanceTimersByTimeAsync(20);
  }

  it('隐藏时只预备，原生显示后才播放；结束清理而不留下内联变换', async () => {
    expect(document.documentElement.dataset.startupEntrance).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(play).not.toHaveBeenCalled();
    await show();
    expect(document.documentElement.dataset.startupEntrance).toBe('entering');
    expect(play).toHaveBeenCalled();
    running.forEach((animation) => animation.finish());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    expect(running.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(document.querySelector('[style]')).toBeNull();
    const count = play.mock.calls.length;
    present(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(play).toHaveBeenCalledTimes(count);
  });

  it('四条最近手记也在 360ms 内完成；空草稿状态不闪现', async () => {
    await show();
    const ends = play.mock.calls.map((call) => {
      const options = call[1] as KeyframeAnimationOptions;
      return Number(options.duration) + Number(options.delay);
    });
    expect(Math.max(...ends)).toBe(360);
    expect(play.mock.contexts).not.toContain(
      document.querySelector('[data-startup-part="status"]'),
    );
  });

  it.each(['keydown', 'pointerdown'])('%s 交互结束装饰，页面不拦截事件', async (type) => {
    await show();
    const event = new Event(type, { bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    expect(running.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('页面重载通知直接恢复完整页面，不重新入场', async () => {
    present(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(play).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
  });

  it('减少动态时直接显示；播放中启用也立即清理', async () => {
    Object.assign(media, { matches: true });
    await show();
    expect(play).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    Object.assign(media, { matches: false });
    dispose = prepareStartupEntrance();
    await show();
    Object.assign(media, { matches: true });
    media.dispatchEvent(new Event('change'));
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    expect(running.every((animation) => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it('动画创建失败或页面离开时恢复可见状态', async () => {
    const originalPlay = play.getMockImplementation();
    if (!originalPlay) throw new Error('缺少动画替身。');
    play.mockImplementationOnce(originalPlay).mockImplementationOnce(() => {
      throw new Error('animation unavailable');
    });
    await show();
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    dispose = prepareStartupEntrance();
    window.dispatchEvent(new Event('pagehide'));
    await show();
    expect(document.documentElement.dataset.startupEntrance).toBeUndefined();
    expect(remove).toHaveBeenCalled();
  });
});
