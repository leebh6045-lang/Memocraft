import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 失败截图与 JSON 报告都落在已忽略的 test-results 中，便于交付时核对本次实际执行。
  outputDir: './test-results/artifacts',
  reporter: [['list'], ['json', { outputFile: './test-results/e2e-report.json' }]],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
