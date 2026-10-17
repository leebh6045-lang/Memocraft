/** 生命周期桥接与知识库能力分离；卡片只使用就绪和显示通知。 */
export const WINDOW_CONTENT_READY = 'window:content-ready';
export const WINDOW_PRESENTED = 'window:presented';
export const STARTUP_WINDOW_ARGUMENT = '--memocraft-startup';
// 卡片停留与加载短线的一轮共用时长，调整启动节奏时保持同步。
export const STARTUP_DURATION_MS = 500;

export interface WindowLifecycleApi {
  ready(theme: 'light' | 'dark'): void;
  /** true 用于初次显示；主页面重载收到 false。 */
  onPresented(listener: (animate: boolean) => void): () => void;
}
