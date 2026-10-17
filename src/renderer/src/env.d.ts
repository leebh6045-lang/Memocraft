import type { MemocraftApi } from '../../shared/contracts';
import type { WindowLifecycleApi } from '../../shared/window-lifecycle';

declare global {
  interface Window {
    memocraft?: MemocraftApi;
    memocraftWindow?: WindowLifecycleApi;
  }
}
