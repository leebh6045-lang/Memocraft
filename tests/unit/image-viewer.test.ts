// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ImageViewer from '../../src/renderer/src/components/ImageViewer.vue';
import type { ViewableImage } from '../../src/domain/note-image';

const IMAGES: ViewableImage[] = [
  { id: 'a', displayName: '架构草图', originalName: 'a.png' },
  { id: 'b', displayName: '', originalName: 'b.png' },
  { id: 'c', displayName: '', originalName: '' },
];

let wrapper: VueWrapper | undefined;

/** 放大层挂在 body 上，断言与点击都要从 document 出发。 */
function panel(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('.viewer-panel');
  if (!element) throw new Error('放大层没有渲染出来。');
  return element;
}

/**
 * 每个用例只留一个放大层：先卸载上一个，再把 body 清空。
 * 放大层是 Teleport 到 body 的，jsdom 里重复挂载时残留节点会让 document 查询
 * 命中上一次的层，事件也就派发不到当前组件上。
 */
function resetBody(): void {
  wrapper?.unmount();
  wrapper = undefined;
  document.body.innerHTML = '';
}

function mountViewer(startId = 'a', images: ViewableImage[] = IMAGES) {
  resetBody();
  wrapper = mount(ImageViewer, { props: { images, startId }, attachTo: document.body });
  return wrapper;
}

function shownImage(): HTMLImageElement {
  const image = document.body.querySelector<HTMLImageElement>('.viewer-image');
  if (!image) throw new Error('放大层里没有图片。');
  return image;
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

describe('图片放大层', () => {
  it('打开时显示指定的那张，标题按命名规则给出', () => {
    mountViewer('b');
    expect(shownImage().getAttribute('src')).toBe('memocraft-image://image/b');
    expect(shownImage().getAttribute('alt')).toBe('b.png');
  });

  it('命名优先用户输入，其次原文件名，最后按序号兜底', () => {
    mountViewer('a');
    expect(shownImage().getAttribute('alt')).toBe('架构草图');
    mountViewer('c');
    expect(shownImage().getAttribute('alt')).toBe('图片 3');
  });

  it('下一张与上一张循环，只有一张时按钮禁用', async () => {
    const view = mountViewer('a');
    const [previous, next] = panel().querySelectorAll<HTMLButtonElement>('.viewer-bar button');
    await next?.click();
    expect(shownImage().getAttribute('src')).toBe('memocraft-image://image/b');
    await previous?.click();
    expect(shownImage().getAttribute('src')).toBe('memocraft-image://image/a');
    await previous?.click();
    expect(shownImage().getAttribute('src')).toBe('memocraft-image://image/c');

    mountViewer('a', [IMAGES[0] as ViewableImage]);
    const [onlyPrevious, onlyNext] =
      panel().querySelectorAll<HTMLButtonElement>('.viewer-bar button');
    expect(onlyPrevious?.disabled).toBe(true);
    expect(onlyNext?.disabled).toBe(true);
    void view;
  });

  // 键盘翻页与 Esc 不在 jsdom 里断言：放大层是 Teleport 到 body 的，
  // 同一份合成键盘事件在这里时通时不通。这两条路径由桌面 e2e
  // （tests/e2e/desktop-images.spec.ts）在真实浏览器里按真实按键覆盖。
  it('点遮罩关闭，关闭按钮也在放大层内', async () => {
    const view = mountViewer();
    const backdrop = document.body.querySelector<HTMLElement>('.viewer-backdrop');
    await backdrop?.click();
    expect(view.emitted('close')).toHaveLength(1);
    expect(document.body.querySelector('.viewer-close')).not.toBeNull();
  });

  it('卸载后把焦点还给打开它的控件', async () => {
    // 触发器要先于放大层存在并拿到焦点：它就是 useModalFocus 记下的「来源」。
    resetBody();
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    wrapper = mount(ImageViewer, {
      props: { images: IMAGES, startId: 'a' },
      attachTo: document.body,
    });
    await nextTick();
    // 放大层接管焦点。
    expect(document.activeElement?.classList.contains('viewer-close')).toBe(true);
    wrapper.unmount();
    wrapper = undefined;
    await nextTick();
    await nextTick();
    expect(document.activeElement).toBe(trigger);
  });
});
