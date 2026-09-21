import type { MemocraftApi } from '../../shared/contracts';

declare global {
  interface Window {
    memocraft?: MemocraftApi;
  }
}
