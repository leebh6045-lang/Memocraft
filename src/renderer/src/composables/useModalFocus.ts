import { nextTick, onBeforeUnmount, onMounted, toValue, type MaybeRefOrGetter } from 'vue';

// 搜索跳转抽屉时继承最初入口，避免搜索卸载后丢失返回焦点的位置。
const origins = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 弹层挂载后聚焦，关闭后回到来源；父层通过 inert 阻止背景被访问。
 * 元素以 getter 传入时按调用当刻解析，使同一组件内的分层浮层（例如放大查看）
 * 能把 Tab 限制在当前真正可见的那一层。
 */
export function useModalFocus(element: MaybeRefOrGetter<HTMLElement | null>, preferred: string) {
  let previous: HTMLElement | null = null;
  let fallback: HTMLElement | null = null;
  const current = () => toValue(element);
  onMounted(async () => {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const parentDialog = previous?.closest<HTMLElement>('[role="dialog"]');
    fallback = parentDialog ? (origins.get(parentDialog) ?? previous) : previous;
    const host = current();
    if (host && fallback) origins.set(host, fallback);
    await nextTick();
    const target = host?.querySelector<HTMLElement>(preferred) ?? host;
    target?.focus({ preventScroll: true });
  });
  onBeforeUnmount(() => {
    // Vue 退出动画可能暂留 DOM，此时也不能让键盘进入正在关闭的面板。
    const host = current();
    if (host) host.inert = true;
    // 等父层移除 inert，再恢复到有效的来源控件。
    void nextTick(() => {
      const target = previous?.isConnected && !previous.closest('[inert]') ? previous : fallback;
      if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
  });

  function trapTab(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const host = current();
    const controls = Array.from(
      host?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ) ?? [],
    ).filter((control) => control.getClientRects().length && !control.closest('[inert]'));
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      host?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return { trapTab };
}
