// 本文件刻意不包含 import，使模块声明处于全局作用域；
// 普通 tsc 不解析 SFC，需要它才能把 .vue 导入视为组件类型。
declare module '*.vue' {
  import type { DefineComponent } from 'vue';

  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
