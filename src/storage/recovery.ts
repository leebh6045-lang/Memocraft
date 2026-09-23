import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../shared/errors';

/** 恢复进行中的标记与恢复前备份都放在数据目录内，跟随数据一起被替换或清理。 */
export const RESTORE_MARKER = '.restore-pending';
export const PRE_RESTORE_DIRECTORY = '.pre-restore';
/** 校验后的备份先展开到这里，确认无误后再搬到活动位置。 */
export const STAGING_DIRECTORY = '.restore-staging';

export type RecoveryOutcome = 'none' | 'rolled-back';

/**
 * 活动库替换式恢复的保护装置。
 *
 * 恢复是唯一会替换活动数据的操作，因此分三步：
 * 1. `beginRestore` 先把当前数据整体留一份恢复前备份，再写下进行中标记；
 * 2. 替换完成后由 `commitRestore` 清掉标记与备份；
 * 3. 任何一步失败或进程中断，都由 `rollbackRestore` 把恢复前备份放回去。
 *
 * 启动时 `recoverInterruptedRestore` 检查标记：发现未完成的恢复就回滚，
 * **绝不把半套数据当成正常库打开**。备份与标记都在数据目录内，复制时排除它们自身。
 */

/**
 * 复制数据目录内容，排除恢复保护自身的文件。
 * 逐项复制而不是整目录复制：`cpSync` 会直接拒绝「复制到自己的子目录」，
 * 而恢复前备份正位于数据目录内。
 */
function copyLibrary(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  if (!existsSync(from)) return;
  const skip = [RESTORE_MARKER, PRE_RESTORE_DIRECTORY, STAGING_DIRECTORY];
  for (const entry of readdirSync(from)) {
    if (skip.includes(entry)) continue;
    cpSync(join(from, entry), join(to, entry), { recursive: true });
  }
}

/** 删除活动数据，保留恢复前备份与标记；目录不存在时视为没有活动数据。 */
function clearActiveData(dataDirectory: string): void {
  if (!existsSync(dataDirectory)) return;
  const keep = [PRE_RESTORE_DIRECTORY, RESTORE_MARKER, STAGING_DIRECTORY].map((entry) =>
    join(dataDirectory, entry),
  );
  for (const entry of readdirSync(dataDirectory)) {
    const target = join(dataDirectory, entry);
    if (keep.includes(target)) continue;
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * 把校验后的暂存内容搬到活动位置。
 * 暂存目录就在数据目录内，因此改名即可完成，不需要跨设备复制。
 */
export function applyStagedRestore(dataDirectory: string, databaseFileName: string): void {
  const staging = join(dataDirectory, STAGING_DIRECTORY);
  if (!existsSync(join(staging, databaseFileName)))
    throw new AppError('STORAGE', '恢复暂存内容缺失，已停止替换活动数据。');
  clearActiveData(dataDirectory);
  for (const entry of readdirSync(staging)) {
    rmSync(join(dataDirectory, entry), { recursive: true, force: true });
    renameSync(join(staging, entry), join(dataDirectory, entry));
  }
  rmSync(staging, { recursive: true, force: true });
}

export function beginRestore(dataDirectory: string, backupSource: string): void {
  mkdirSync(dataDirectory, { recursive: true });
  const backupPath = join(dataDirectory, PRE_RESTORE_DIRECTORY);
  rmSync(backupPath, { recursive: true, force: true });
  copyLibrary(dataDirectory, backupPath);
  writeFileSync(
    join(dataDirectory, RESTORE_MARKER),
    JSON.stringify({ startedAt: new Date().toISOString(), backupSource }, null, 2),
    'utf8',
  );
}

export function commitRestore(dataDirectory: string): void {
  rmSync(join(dataDirectory, RESTORE_MARKER), { force: true });
  rmSync(join(dataDirectory, PRE_RESTORE_DIRECTORY), { recursive: true, force: true });
}

/** 把恢复前备份放回活动位置；备份缺失时保留标记并抛错，交由调用方提示用户。 */
export function rollbackRestore(dataDirectory: string): void {
  const backupPath = join(dataDirectory, PRE_RESTORE_DIRECTORY);
  if (!existsSync(backupPath))
    throw new AppError(
      'STORAGE',
      '检测到未完成的恢复，但恢复前备份已不存在。已停止打开数据，请从其他备份恢复。',
    );
  clearActiveData(dataDirectory);
  copyLibrary(backupPath, dataDirectory);
  commitRestore(dataDirectory);
}

/**
 * 启动检测：返回是否发生过回滚。
 * 标记存在却没有恢复前备份时抛错——宁可拒绝启动，也不打开半套数据。
 */
export function recoverInterruptedRestore(dataDirectory: string): RecoveryOutcome {
  const markerPath = join(dataDirectory, RESTORE_MARKER);
  if (!existsSync(markerPath)) return 'none';
  const started = readFileSync(markerPath, 'utf8');
  rollbackRestore(dataDirectory);
  console.log(`[Memocraft] 检测到未完成的恢复，已回滚到恢复前的数据。标记内容：${started}`);
  return 'rolled-back';
}
