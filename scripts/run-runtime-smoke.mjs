import { spawnSync } from 'node:child_process';
import electron from 'electron';

const result = spawnSync(electron, ['scripts/runtime-smoke.mjs'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
