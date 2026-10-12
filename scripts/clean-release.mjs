#!/usr/bin/env node
/**
 * release/ 产物清理：打包前运行，避免每轮功能验证都留下一整份约 320MB 的 .app。
 *
 * 只作用于本仓库的 release/ 目录，规则如下：
 *   1. release/mac-arm64：未封装的目录包，每次打包都会重新生成，删除旧包；
 *      旧目录包本来就不能再用于包内验证（见 docs/V2实施规划.md）。
 *   2. release/<功能>/：功能隔离预览包，只保留最近修改的一份，其余整目录删除。
 *      保留最近一份是为了不误删正在使用的手写启动器（隔离预览.command），它不由打包生成。
 *   3. release/ 根目录下文件名不含当前版本号的 dmg/zip/exe/blockmap：旧版本安装包，删除。
 *
 * 删除前逐个打印路径与体积；--dry-run 只报告不删除。任何一项删除失败都如实报错并以非零码退出。
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = join(repositoryRoot, 'release');
const dryRun = process.argv.includes('--dry-run');

/** 递归求体积用于报告；符号链接不跟随，避免重复计数或成环。 */
async function measureSize(targetPath) {
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const child of await readdir(targetPath)) {
      total += await measureSize(join(targetPath, child));
    }
    return total;
  } catch (error) {
    // 体积只用于报告：读不到时如实告警并按 0 计，不因为统计失败就跳过清理。
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`体积统计失败（按 0 计）：${targetPath}\n  ${message}`);
    return 0;
  }
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 功能隔离预览目录的识别特征：打包产物或手写启动器，二者任一存在即可。 */
async function isPreviewDirectory(targetPath) {
  const names = await readdir(targetPath);
  const markers = [
    'mac-arm64',
    'builder-debug.yml',
    'builder-effective-config.yaml',
    '隔离预览.command',
  ];
  return markers.some((marker) => names.includes(marker));
}

/** 删除前校验目标确实位于 release/ 之内，避免路径写错时误删仓库其他内容。 */
function assertInsideRelease(targetPath) {
  if (!targetPath.startsWith(releaseDirectory + sep)) {
    throw new Error(`拒绝删除 release/ 之外的路径：${targetPath}`);
  }
}

/** 汇总本轮要删除的产物，并返回要保留的预览包（没有则为 null）。 */
async function collectRemovals() {
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const currentVersion = packageJson.version;
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  const removals = [];
  const previewDirectories = [];

  for (const entry of entries) {
    const fullPath = join(releaseDirectory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'mac-arm64') {
        removals.push({ path: fullPath, reason: '未封装的目录包，打包会重新生成' });
      } else if (await isPreviewDirectory(fullPath)) {
        previewDirectories.push({ path: fullPath, modifiedAt: (await lstat(fullPath)).mtimeMs });
      }
      continue;
    }
    const isArtifact = /\.(dmg|zip|exe|blockmap)$/i.test(entry.name);
    if (isArtifact && !entry.name.includes(currentVersion)) {
      removals.push({ path: fullPath, reason: `旧版本产物（当前版本 ${currentVersion}）` });
    }
  }

  // 最近修改的预览包视为「正在用的那一份」，保留；其余是历史轮次留下的整包。
  previewDirectories.sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const stale of previewDirectories.slice(1)) {
    removals.push({ path: stale.path, reason: '历史功能预览包（只保留最近一份）' });
  }
  return { removals, keptPreview: previewDirectories[0]?.path ?? null };
}

if (!existsSync(releaseDirectory)) {
  console.log('release/ 不存在，无需清理。');
  process.exit(0);
}

const { removals, keptPreview } = await collectRemovals();

console.log(dryRun ? '清理预览（--dry-run，不实际删除）：' : '清理 release/ 产物：');
if (keptPreview !== null) {
  console.log(`  保留  ${keptPreview.replace(repositoryRoot + sep, '')}  最近一份功能预览包`);
}
for (const removal of removals) {
  const size = await measureSize(removal.path);
  const shown = removal.path.replace(repositoryRoot + sep, '');
  console.log(`  删除  ${shown}  ${formatMegabytes(size)}  ${removal.reason}`);
}

if (removals.length === 0) {
  console.log('没有需要清理的产物。');
  process.exit(0);
}

let freedBytes = 0;
let failed = false;
for (const removal of removals) {
  assertInsideRelease(removal.path);
  freedBytes += await measureSize(removal.path);
  if (dryRun) continue;
  try {
    await rm(removal.path, { recursive: true, force: true });
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`删除失败：${removal.path}\n  ${message}`);
  }
}

console.log(
  `${dryRun ? '预计释放' : '已释放'} ${formatMegabytes(freedBytes)}，共 ${removals.length} 项。`,
);
if (failed) process.exitCode = 1;
