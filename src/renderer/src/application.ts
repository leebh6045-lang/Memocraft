import { createApp } from 'vue';
import App from './App.vue';
import { readThemePreference, resolveTheme } from './theme';
import { prepareStartupEntrance } from './startup-entrance';
import './assets/theme.css';
import './assets/startup-entrance.css';

// 首次绘制前恢复外观，隐藏主窗口也不经历浅色到深色的闪变。
document.documentElement.dataset.theme = resolveTheme(
  readThemePreference(),
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);
const disposeEntrance = prepareStartupEntrance();
const application = createApp(App);
application.onUnmount(disposeEntrance);
application.mount('#app');
