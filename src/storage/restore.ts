import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { AppError } from '../shared/errors';
import { checkIntegrity, DATABASE_FILENAME } from './database';
import { NoteStore } from './note-store';

/** 仅恢复数据库快照到干净目录；不会替换活动知识库，也不包含附件。 */
export async function restoreDatabaseBackup(
  sourcePath: string,
  targetDirectory: string,
  migrationsDirectory: string,
): Promise<void> {
  if (!existsSync(sourcePath)) throw new AppError('NOT_FOUND', '备份文件不存在。');
  mkdirSync(targetDirectory, { recursive: true });
  if (readdirSync(targetDirectory).length !== 0)
    throw new AppError('CONFLICT', '恢复目录必须为空，已有数据不会被覆盖。');
  const stagingDirectory = mkdtempSync(join(targetDirectory, '.restore-'));
  try {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      checkIntegrity(source);
      const version = source.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version !== 'number' || version < 1)
        throw new AppError('STORAGE', '备份缺少有效的 Memocraft 数据库版本。');
      await sqliteBackup(source, join(stagingDirectory, DATABASE_FILENAME));
    } finally {
      source.close();
    }
    // 在副本中验证版本、迁移和内容，失败不会改写原备份。
    const staged = new NoteStore({ dataDirectory: stagingDirectory, migrationsDirectory });
    try {
      staged.load();
    } finally {
      staged.close();
    }
    linkSync(join(stagingDirectory, DATABASE_FILENAME), join(targetDirectory, DATABASE_FILENAME));
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
