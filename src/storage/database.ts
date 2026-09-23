import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../shared/errors';

export const DATABASE_FILENAME = 'memocraft.sqlite';

/** 迁移文件命名契约：三位数字顺序号加小写名称，迁移管理器与统计共用同一正则。 */
export const MIGRATION_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

/** 返回按顺序排列的迁移文件名；调用方据此核对连续性、推算模式版本。 */
export function listMigrations(migrationsDirectory: string): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => MIGRATION_PATTERN.test(name))
    .sort();
}

/**
 * 迁移文件数量必须与应用声明的模式版本一致。
 * 缺文件时要在这里给出可定位的原因，而不是让后续的版本核对把「安装不完整」
 * 说成「数据库来自更新版本」——两种情况的处置完全不同。
 */
export function assertMigrationCount(
  migrationsDirectory: string,
  expectedSchemaVersion: number,
): void {
  const count = listMigrations(migrationsDirectory).length;
  if (count !== expectedSchemaVersion)
    throw new AppError(
      'STORAGE',
      `迁移文件数量与应用版本不一致（需要 ${expectedSchemaVersion} 个，实际 ${count} 个），已停止打开数据库。请确认安装完整，或改用与数据匹配的版本。`,
    );
}

/** 读取当前库的实际模式版本；备份清单据此声明包内数据库的版本。 */
export function readSchemaVersion(database: DatabaseSync): number {
  const version = database.prepare('PRAGMA user_version').get()?.user_version;
  if (typeof version !== 'number' || version < 1)
    throw new AppError('STORAGE', '数据库缺少可识别的模式版本，已停止操作。');
  return version;
}

/**
 * 确认磁盘上的实际模式版本与期望版本一致。
 * 迁移管理器在打开库时已执行同样检查；需要按版本分支建表的存储实现再核对一次，
 * 避免「先按新结构准备语句、后才发现版本不符」的半途失败。
 */
export function requireMigrationVersion(database: DatabaseSync, expected: number): void {
  if (readSchemaVersion(database) !== expected)
    throw new AppError('STORAGE', '数据库模式版本与当前应用不一致，原数据未被修改。');
}

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
  const migrations = listMigrations(migrationsDirectory);
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
