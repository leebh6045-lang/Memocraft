// 两个原生窗口共用同一入口地址和主题偏好，卡片无需加载整个业务界面。
if (new URLSearchParams(window.location.search).get('startup') === '1') {
  void import('./startup-card').then(({ mountStartupCard }) => mountStartupCard());
} else {
  void import('./application');
}
