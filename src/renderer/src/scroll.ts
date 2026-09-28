/**
 * 主内容区才是实际滚动容器（窗口本身不滚动），回到顶部与滚动联动都针对它，
 * 因此这里集中一处，避免各页面各自猜 window 还是容器。
 */
export function contentScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.main');
}

export function scrollContentToTop(): void {
  contentScroller()?.scrollTo({ top: 0, behavior: 'instant' });
}
