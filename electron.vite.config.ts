import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'storage-worker': resolve('src/main/workers/storage-worker.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
        external: ['node:sqlite', 'electron'],
      },
    },
  },
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: { plugins: [vue()] },
});
