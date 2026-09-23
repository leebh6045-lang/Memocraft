import { ref } from 'vue';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  action?: ToastAction;
}

/** 与基准一致：提示条默认约 3.6 秒后自动消失。 */
const DEFAULT_DURATION = 3600;
/** 同屏最多保留的提示条数量：连续操作时不能铺满屏幕，超出时丢弃最旧的一条。 */
const MAX_VISIBLE = 3;

/**
 * 提示条现场：报告已经完成的操作，可携带一个操作按钮。
 * 带撤销按钮的提示条同样按时自动消失（悬停不暂停），因此撤销只在提示条存续期间有效；
 * 过期后的恢复走回收站流程，不依赖这条提示。
 */
export function useToasts() {
  const toasts = ref<ToastItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function dismiss(id: number): void {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }

  function push(
    message: string,
    options: { action?: ToastAction; duration?: number } = {},
  ): number {
    const id = nextId;
    nextId += 1;
    const kept = toasts.value.slice(-(MAX_VISIBLE - 1));
    for (const dropped of toasts.value.slice(0, Math.max(0, toasts.value.length - kept.length))) {
      const timer = timers.get(dropped.id);
      if (timer) clearTimeout(timer);
      timers.delete(dropped.id);
    }
    toasts.value = [...kept, { id, message, action: options.action }];
    timers.set(
      id,
      setTimeout(() => dismiss(id), options.duration ?? DEFAULT_DURATION),
    );
    return id;
  }

  function clear(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts.value = [];
  }

  return { toasts, push, dismiss, clear };
}

export type ToastStack = ReturnType<typeof useToasts>;
