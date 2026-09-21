import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../shared/errors';

export const DATABASE_FILENAME = 'memocraft.sqlite';

export function transaction<T>(database: DatabaseSync, operation: () => T): T {
  // 在读改写之前取得写锁；回调须同步完成，不在事务中等待外部操作。
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function checkIntegrity(database: DatabaseSync): void {
  const integrity = database.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new AppError('STORAGE', '数据库完整性检查失败，原数据未被替换。');
  }
  if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
    throw new AppError('STORAGE', '数据库关系检查失败，原数据未被替换。');
  }
}

export function migrate(database: DatabaseSync, migrationsDirectory: string): void {
  const migrations = readdirSync(migrationsDirectory)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (migrations.length === 0)
    throw new AppError('STORAGE', '缺少数据库迁移文件，无法安全打开数据。');
  for (const [index, filename] of migrations.entries()) {
    if (Number(filename.slice(0, 3)) !== index + 1) {
      throw new AppError('STORAGE', '数据库迁移版本不连续，无法安全打开数据。');
    }
  }
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || version > migrations.length) {
    throw new AppError('STORAGE', '数据库来自更新版本的 Memocraft，请使用对应版本打开。');
  }
  if (
    version === 0 &&
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .get()
  ) {
    throw new AppError('STORAGE', '数据库缺少可识别的版本，已保留原文件。');
  }
  for (let index = version; index < migrations.length; index += 1) {
    const filename = migrations[index];
    if (!filename) throw new AppError('STORAGE', '数据库迁移文件缺失。');
    const sql = readFileSync(join(migrationsDirectory, filename), 'utf8');
    // 模式变更、版本推进和完整性检查一起提交，失败时保留迁移前状态。
    transaction(database, () => {
      database.exec(sql);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      checkIntegrity(database);
    });
  }
}
