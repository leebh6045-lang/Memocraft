import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { AppError } from '../shared/errors';
import { checkIntegrity, DATABASE_FILENAME, readSchemaVersion } from './database';
import { NoteStore } from './note-store';
import { ATTACHMENTS_DIRECTORY, NoteImageStore } from './note-image-store';
import { SCHEMA_VERSION } from './schema';
import { ENTRY_VISIBLE } from './visibility';
import type { BackupSummary, LibraryCounts, StagedRestore } from '../domain/library-data';

/** 备份清单：格式版本随包结构变化，模式版本用于核对数据库与迁移的兼容性。 */
const MANIFEST_FILENAME = 'backup.json';
const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  formatVersion: number;
  schemaVersion: number;
  createdAt: string;
  database: string;
  attachments: { relativePath: string; byteSize: number; sha256: string }[];
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 拼接包内路径并拒绝逃逸出根目录的条目；包内路径不可信。 */
function safeJoin(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep))
    throw new AppError('STORAGE', '备份包内路径不合法，已停止处理。');
  return target;
}

/**
 * 生成包含数据库快照与附件目录的一致备份目录。
 * 顺序：数据库快照 → 附件复制 → 清单 → 逐项校验 → 原子改名发布。
 * 任一步失败都删除临时目录，不覆盖已有备份，也不留下半套结果。
 * 清单里的模式版本取自库自身的实际版本，不按迁移目录的文件数推算。
 */
export async function backupLibrary(
  store: NoteStore,
  images: NoteImageStore,
  destination: string,
): Promise<BackupSummary> {
  if (existsSync(destination))
    throw new AppError('CONFLICT', '备份目标已存在，请选择新位置，避免覆盖已有备份。');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(temporary, { recursive: true });
  try {
    await sqliteBackup(store.connection(), join(temporary, DATABASE_FILENAME));
    const verification = new DatabaseSync(join(temporary, DATABASE_FILENAME), { readOnly: true });
    try {
      checkIntegrity(verification);
    } finally {
      verification.close();
    }
    // 附件与数据库来自同一状态；allFiles 在文件缺失时抛错，从而中止备份。
    const files = images.allFiles();
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: readSchemaVersion(store.connection()),
      createdAt: new Date().toISOString(),
      database: DATABASE_FILENAME,
      attachments: files.map((file) => ({
        relativePath: file.relativePath,
        byteSize: file.bytes.byteLength,
        sha256: checksum(file.bytes),
      })),
    };
    for (const file of files) {
      const target = safeJoin(temporary, file.relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    writeFileSync(join(temporary, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
    // 发布前核对包内每个附件的校验值，避免把不完整的结果当成成功备份。
    verifyManifest(temporary, manifest);
    // 目录改名在同一文件系统内是原子的：失败时目标仍不存在。
    renameSync(temporary, destination);
    return {
      destination,
      createdAt: manifest.createdAt,
      attachments: files.length,
      bytes:
        statSync(join(destination, DATABASE_FILENAME)).size +
        files.reduce((total, file) => total + file.bytes.byteLength, 0),
    };
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function readManifest(directory: string): BackupManifest {
  const path = join(directory, MANIFEST_FILENAME);
  if (!existsSync(path)) throw new AppError('STORAGE', '备份包缺少清单文件，无法确认内容完整。');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AppError('STORAGE', '备份清单无法解析，已停止恢复。');
  }
  if (typeof parsed !== 'object' || parsed === null)
    throw new AppError('STORAGE', '备份清单格式异常。');
  const manifest = parsed as Partial<BackupManifest>;
  if (
    typeof manifest.formatVersion !== 'number' ||
    typeof manifest.schemaVersion !== 'number' ||
    typeof manifest.database !== 'string' ||
    !Array.isArray(manifest.attachments)
  )
    throw new AppError('STORAGE', '备份清单字段缺失，无法恢复。');
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION)
    throw new AppError('STORAGE', '备份来自更新版本的 Memocraft，请使用对应版本打开。');
  return manifest as BackupManifest;
}

function verifyManifest(directory: string, manifest: BackupManifest): void {
  for (const entry of manifest.attachments) {
    if (typeof entry?.relativePath !== 'string' || typeof entry.sha256 !== 'string')
      throw new AppError('STORAGE', '备份清单中的附件条目不完整。');
    const path = safeJoin(directory, entry.relativePath);
    if (!existsSync(path)) throw new AppError('STORAGE', '备份包缺少清单登记的附件文件。');
    const bytes = readFileSync(path);
    if (bytes.byteLength !== entry.byteSize || checksum(bytes) !== entry.sha256)
      throw new AppError('STORAGE', '备份包中的附件与清单不一致，已停止恢复。');
  }
}

/** 恢复暂存目录名与恢复保护共用一处定义，避免两处常量漂移。 */
export { STAGING_DIRECTORY } from './recovery';

/** 数据形状定义在 domain，这里只做转发，保证存储与界面用同一份类型。 */
export type { BackupSummary, LibraryCounts, StagedRestore } from '../domain/library-data';

/** 用一条只读连接统计内容数量；同样遵守可见性规则（软删除的不计入）。 */
export function libraryCounts(database: DatabaseSync): LibraryCounts {
  const count = (sql: string): number => {
    const row = database.prepare(sql).get() as { total?: unknown } | undefined;
    return typeof row?.total === 'number' ? row.total : 0;
  };
  return {
    notes: count('SELECT count(*) AS total FROM notes WHERE deleted_at IS NULL'),
    topics: count('SELECT count(*) AS total FROM topics WHERE deleted_at IS NULL'),
    threads: count('SELECT count(*) AS total FROM threads WHERE deleted_at IS NULL'),
    entries: count(
      `SELECT count(*) AS total FROM thread_entries
       JOIN threads ON threads.id = thread_entries.thread_id
       WHERE ${ENTRY_VISIBLE}`,
    ),
  };
}

/**
 * 校验备份并展开到指定暂存目录（目录会被清空重建）。
 * 只读取备份、只写暂存目录，**不触碰活动数据**；任何失败都不留下半套结果。
 * 支持两种来源：本轮及以后生成的备份目录包，以及早期只含数据库文件的快照。
 */
/** 校验备份来源：目录包读清单并逐项核对校验值，裸快照只确认文件存在。 */
export function validateBackup(sourcePath: string): { manifest: BackupManifest | null } {
  if (!existsSync(sourcePath)) throw new AppError('NOT_FOUND', '备份不存在。');
  const isDirectory = existsSync(join(sourcePath, MANIFEST_FILENAME));
  const manifest = isDirectory ? readManifest(sourcePath) : null;
  if (manifest) verifyManifest(sourcePath, manifest);
  return { manifest };
}

export async function stageRestoreInto(
  sourcePath: string,
  stagingDirectory: string,
  migrationsDirectory: string,
): Promise<StagedRestore> {
  const { manifest } = validateBackup(sourcePath);
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  try {
    const sourceDatabase = manifest ? join(sourcePath, manifest.database) : sourcePath;
    if (!existsSync(sourceDatabase)) throw new AppError('STORAGE', '备份中缺少数据库文件。');
    const source = new DatabaseSync(sourceDatabase, { readOnly: true });
    try {
      checkIntegrity(source);
      const version = source.prepare('PRAGMA user_version').get()?.user_version;
      if (typeof version !== 'number' || version < 1)
        throw new AppError('STORAGE', '备份缺少有效的 Memocraft 数据库版本。');
      if (manifest && version > manifest.schemaVersion)
        throw new AppError('STORAGE', '备份的模式版本高于清单声明，已停止恢复。');
      await sqliteBackup(source, join(stagingDirectory, DATABASE_FILENAME));
    } finally {
      source.close();
    }
    // 附件先落到暂存目录，再与数据库一起发布，避免出现只有一半的恢复结果。
    const sourceAttachments = join(sourcePath, ATTACHMENTS_DIRECTORY);
    let attachments = 0;
    if (manifest && existsSync(sourceAttachments)) {
      cpSync(sourceAttachments, join(stagingDirectory, ATTACHMENTS_DIRECTORY), { recursive: true });
      attachments = manifest.attachments.length;
    }
    // 在副本中验证版本、迁移与内容；失败不会改写原备份，也不影响活动库。
    const staged = new NoteStore({
      dataDirectory: stagingDirectory,
      migrationsDirectory,
      expectedSchemaVersion: SCHEMA_VERSION,
    });
    try {
      staged.load();
    } finally {
      staged.close();
    }
    // 迁移可能更新了副本，重新取一次字节数用于汇报；统计用只读连接，不影响暂存内容。
    const databaseBytes = statSync(join(stagingDirectory, DATABASE_FILENAME)).size;
    const verification = new DatabaseSync(join(stagingDirectory, DATABASE_FILENAME), {
      readOnly: true,
    });
    try {
      return { attachments, databaseBytes, counts: libraryCounts(verification) };
    } finally {
      verification.close();
    }
  } catch (error) {
    rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * 恢复到干净目录：目标必须为空，用于"恢复到别处查看"与自动化验证。
 * 校验与展开都在目标目录内的临时子目录完成，失败不会留下半套数据。
 */
export async function restoreDatabaseBackup(
  sourcePath: string,
  targetDirectory: string,
  migrationsDirectory: string,
): Promise<void> {
  // 校验全部通过后才创建目标目录：被拒绝的恢复不在磁盘上留下任何痕迹。
  validateBackup(sourcePath);
  mkdirSync(targetDirectory, { recursive: true });
  if (readdirSync(targetDirectory).length !== 0)
    throw new AppError('CONFLICT', '恢复目录必须为空，已有数据不会被覆盖。');
  const stagingDirectory = mkdtempSync(join(targetDirectory, '.restore-'));
  try {
    await stageRestoreInto(sourcePath, stagingDirectory, migrationsDirectory);
    // 数据库最后落位：硬链接不会覆盖并发创建的目标。
    const stagedAttachments = join(stagingDirectory, ATTACHMENTS_DIRECTORY);
    if (existsSync(stagedAttachments))
      cpSync(stagedAttachments, join(targetDirectory, ATTACHMENTS_DIRECTORY), { recursive: true });
    linkSync(join(stagingDirectory, DATABASE_FILENAME), join(targetDirectory, DATABASE_FILENAME));
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
