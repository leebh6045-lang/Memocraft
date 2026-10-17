/** 仅首次原生显示后播放；样式预备、动画与输入现场各自保持独立。 */
export function prepareStartupEntrance(): () => void {
  const lifecycle = window.memocraftWindow;
  if (!lifecycle) return () => undefined;
  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let frame: number | undefined;
  let started = false;
  let finished = false;
  let removePresented: () => void = () => undefined;
  const animations: Animation[] = [];

  function finish(): void {
    if (finished) return;
    finished = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    delete root.dataset.startupEntrance;
    // 取消填充效果即可恢复原样，不把透明度或变换写成控件的永久内联样式。
    animations.forEach((animation) => animation.cancel());
    removePresented();
    reducedMotion.removeEventListener('change', onMotionChange);
    window.removeEventListener('pointerdown', finish, true);
    window.removeEventListener('keydown', finish, true);
    window.removeEventListener('pagehide', finish);
  }

  function onMotionChange(): void {
    if (reducedMotion.matches) finish();
  }

  function animate(part: string, duration: number, delay: number, transform?: string): void {
    const targets = document.querySelectorAll<HTMLElement>(`[data-startup-part="${part}"]`);
    targets.forEach((target, index) => {
      if (part === 'status' && target.classList.contains('is-empty')) return;
      // 最近手记最多四条，只分两档延迟，整段入场仍在 360ms 内完成。
      const offset = part === 'recent-item' ? Math.min(index, 1) * 25 : 0;
      animations.push(
        target.animate(
          [
            { opacity: 0, transform: transform ?? 'none' },
            { opacity: 1, transform: 'none' },
          ],
          {
            duration,
            delay: delay + offset,
            easing: 'cubic-bezier(.22,.61,.36,1)',
            fill: 'both',
          },
        ),
      );
    });
  }

  function begin(shouldAnimate: boolean): void {
    if (started || finished) return;
    started = true;
    removePresented();
    if (!shouldAnimate || reducedMotion.matches) {
      finish();
      return;
    }
    // 输入优先于装饰：捕获阶段结束动画，再由原本的编辑与导航处理器接手。
    window.addEventListener('pointerdown', finish, true);
    window.addEventListener('keydown', finish, true);
    frame = window.requestAnimationFrame(() => {
      if (finished) return;
      root.dataset.startupEntrance = 'entering';
      try {
        animate('shell', 100, 0);
        animate('corner', 100, 0);
        animate('nav', 230, 0, 'translateX(-22px)');
        animate('heading', 240, 35, 'translateY(16px)');
        animate('editor', 260, 60, 'translateY(24px)');
        animate('status', 180, 110, 'translateY(12px)');
        animate('secondary', 180, 110, 'translateY(12px)');
        animate('recent-heading', 200, 125, 'translateY(16px)');
        animate('recent-empty', 200, 125, 'translateY(16px)');
        animate('recent-item', 210, 125, 'translateY(22px)');
      } catch {
        // 装饰能力不可用时立即恢复页面，不能留下透明且无法使用的编辑器。
        finish();
      }
      // 部分动画创建失败时也接住已有动画的取消拒绝；视觉完成不决定业务成功。
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    });
  }

  root.dataset.startupEntrance = 'pending';
  removePresented = lifecycle.onPresented(begin);
  reducedMotion.addEventListener('change', onMotionChange);
  window.addEventListener('pagehide', finish, { once: true });
  return finish;
}
