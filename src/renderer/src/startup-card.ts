import { readThemePreference, resolveTheme } from './theme';
import { STARTUP_DURATION_MS } from '../../shared/window-lifecycle';
import markup from './startup-card.html?raw';
import './assets/startup-card.css';

/** 独立窗口只绘制品牌卡片，不装配 Vue、知识库或 AI 能力。 */
export function mountStartupCard(): void {
  const root = document.getElementById('app');
  if (!root) throw new Error('启动卡片缺少挂载节点。');
  const theme = resolveTheme(
    readThemePreference(),
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.view = 'startup';
  root.innerHTML = markup;
  const page = document.documentElement;
  page.style.setProperty('--startup-duration', `${STARTUP_DURATION_MS}ms`);
  const lifecycle = window.memocraftWindow;
  if (lifecycle) {
    let removePresented: () => void = () => undefined;
    // 只响应首次显示；窗口恢复不重新开始加载动画。
    removePresented = lifecycle.onPresented(() => {
      removePresented();
      page.dataset.startupLoading = 'running';
    });
    window.addEventListener('pagehide', () => removePresented(), { once: true });
  } else {
    page.dataset.startupLoading = 'running';
  }
  const version = root.querySelector('.startup-version');
  if (version) version.textContent = new URLSearchParams(window.location.search).get('version');
  // 样式与节点都已挂载，再确认下一帧，避免原生窗口展示空白页面。
  requestAnimationFrame(() => window.memocraftWindow?.ready(theme));
}
