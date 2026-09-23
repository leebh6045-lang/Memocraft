import { ref } from 'vue';

/**
 * 模态层栈：每次打开对话框或浮层压入一层，关闭时弹出。
 * 全局快捷键据此让位（Esc 先关最上层浮层、再退出专注模式），
 * 应用外壳据此对主内容加 inert，避免背景仍可被键盘访问。
 */
const stack: number[] = [];
const depth = ref(0);
let nextId = 1;

export function useModalLayer() {
  let id = 0;
  return {
    depth,
    enter(): void {
      id = nextId;
      nextId += 1;
      stack.push(id);
      depth.value = stack.length;
    },
    leave(): void {
      const index = stack.indexOf(id);
      if (index >= 0) stack.splice(index, 1);
      depth.value = stack.length;
    },
    /** 只有最上层浮层响应 Esc，避免一次按键关掉多层。 */
    isTop(): boolean {
      return stack.at(-1) === id;
    },
  };
}
