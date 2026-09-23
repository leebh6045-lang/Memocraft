import { existsSync, readdirSync } from 'node:fs';
import type { StoreRequest, StoreValue } from '../shared/contracts';
import { AppError, failure, type Result } from '../shared/errors';
import { DATABASE_FILENAME } from '../storage/database';
import {
  applyStagedRestore,
  beginRestore,
  commitRestore,
  rollbackRestore,
} from '../storage/recovery';

/**
 * 备份、恢复与导出的主进程编排。
 *
 * 三条原则：
 * 1. **路径只来自主进程对话框**：渲染端不传路径，也不获得任意路径读写能力，
 *    它只拿到用于显示的结果。
 * 2. **重活留在存储线程**：备份、导出与恢复暂存都是耗时文件操作，通过存储请求完成。
 * 3. **恢复先保护再替换**：替换活动数据前必定生成恢复前备份并写下进行中标记，
 *    失败或中断都能回到恢复前的状态。
 */

export interface LibraryDataDeps {
  dataDirectory: string;
  request: (request: StoreRequest) => Promise<Result<StoreValue>>;
  /** 关闭存储线程：恢复前必须先让持有连接的线程退出。 */
  closeStore: () => Promise<Result<StoreValue>>;
  /** 丢弃当前存储线程，使下一次请求重新开库。 */
  resetStore: () => Promise<void>;
}

/** 只处理「打开对话框 → 请求存储」这一点逻辑，便于用假对话框验证。 */
export async function withChosenPath<T>(
  showDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  onChosen: (path: string) => Promise<Result<T>>,
): Promise<Result<T | null>> {
  try {
    const selection = await showDialog();
    // 用户取消不是错误：返回空结果，界面保持原状。
    if (selection.canceled || selection.filePaths.length === 0) return { ok: true, value: null };
    const path = selection.filePaths[0];
    if (!path) return { ok: true, value: null };
    return await onChosen(path);
  } catch (error) {
    return failure(error);
  }
}

/** 备份到用户选定的位置；目标是新建的目录包，因此存在同名位置时拒绝。 */
export async function backupWithDialog(
  showDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  request: (request: StoreRequest) => Promise<Result<StoreValue>>,
): Promise<Result<StoreValue | null>> {
  return withChosenPath(showDialog, (destination) =>
    request({ operation: 'backupLibrary', payload: destination }),
  );
}

/** 导出为 Markdown：同样是长任务，同样只接受对话框给出的路径。 */
export async function exportWithDialog(
  showDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  request: (request: StoreRequest) => Promise<Result<StoreValue>>,
): Promise<Result<StoreValue | null>> {
  return withChosenPath(showDialog, (destination) =>
    request({ operation: 'exportLibrary', payload: destination }),
  );
}

/**
 * 选择备份并校验：只展开到数据目录下的暂存目录，**不改动当前数据**。
 * 校验结果（内容统计）用于让用户在替换前确认将恢复成什么。
 */
export async function stageRestoreWithDialog(
  showDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  request: (request: StoreRequest) => Promise<Result<StoreValue>>,
): Promise<Result<StoreValue | null>> {
  return withChosenPath(showDialog, (source) =>
    request({ operation: 'stageRestore', payload: source }),
  );
}

/**
 * 应用已经校验过的恢复：关库 → 保护并替换 → 重开校验 → 提交或回滚。
 * 任一步失败都会把恢复前的数据放回原位并重新打开，绝不留下半套数据。
 */
export async function applyRestore(deps: LibraryDataDeps): Promise<Result<null>> {
  const stagedDatabase = `${deps.dataDirectory}/.restore-staging/${DATABASE_FILENAME}`;
  if (!existsSync(stagedDatabase))
    return failure(new AppError('VALIDATION', '还没有待应用的恢复，请先选择备份并校验。'));
  try {
    // 关库请求排在写入队列末尾，因此这里返回时此前的编辑都已经落盘。
    const closed = await deps.closeStore();
    if (!closed.ok) return failure(new AppError(closed.error.code, closed.error.message));
    beginRestore(deps.dataDirectory, 'staged');
    applyStagedRestore(deps.dataDirectory, DATABASE_FILENAME);
    await deps.resetStore();
    const loaded = await deps.request({ operation: 'load' });
    if (!loaded.ok) throw new AppError('STORAGE', `恢复后的数据无法打开：${loaded.error.message}`);
    commitRestore(deps.dataDirectory);
    return { ok: true, value: null };
  } catch (error) {
    try {
      await deps.resetStore();
      rollbackRestore(deps.dataDirectory);
      await deps.resetStore();
      await deps.request({ operation: 'load' });
    } catch (rollbackError) {
      // 回滚本身失败时如实报告：此时恢复标记仍在，启动检测会再次尝试。
      return failure(rollbackError);
    }
    return failure(error);
  }
}

/** 数据目录里是否还有已校验待应用的恢复。 */
export function hasStagedRestore(dataDirectory: string): boolean {
  try {
    return readdirSync(`${dataDirectory}/.restore-staging`).length > 0;
  } catch {
    return false;
  }
}
