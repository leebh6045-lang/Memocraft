import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../shared/errors';

/** 系统加密由主进程装配；此处不依赖 Electron，也不允许明文降级。 */
export interface CredentialEncryption {
  isAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** 密钥位于知识库之外；这里只向服务提供状态或解密值，不向页面暴露路径。 */
export class AiCredentialStore {
  private readonly keyPath: string;

  constructor(
    private readonly directory: string,
    private readonly encryption: CredentialEncryption,
  ) {
    this.keyPath = join(directory, 'deepseek.enc');
  }

  isEncryptionAvailable(): boolean {
    try {
      return this.encryption.isAvailable();
    } catch {
      // 系统保护接口异常与不可用具有相同语义，界面仍可执行清除。
      return false;
    }
  }

  async hasKey(): Promise<boolean> {
    try {
      const information = await fs.stat(this.keyPath);
      if (!information.isFile()) throw new Error('Credential entry is not a file');
      return true;
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw new AppError('STORAGE', '无法读取密钥配置状态，请重试。');
    }
  }

  async readKey(): Promise<string | null> {
    let encrypted: Buffer;
    try {
      encrypted = await fs.readFile(this.keyPath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new AppError('STORAGE', '无法读取已保存的密钥，请重试。');
    }

    this.requireEncryption();
    try {
      const key = this.encryption.decryptString(encrypted);
      if (!key.trim()) throw new Error('Decrypted credential is empty');
      return key;
    } catch {
      // 损坏或换机后不能解密时保留原文件，用户可主动重新保存或清除。
      throw new AppError('AI_CREDENTIAL', '已保存的密钥无法解密，请重新保存密钥。');
    }
  }

  async saveKey(key: string): Promise<void> {
    if (!key.trim()) throw new AppError('VALIDATION', '请输入 API Key。');
    this.requireEncryption();

    let encrypted: Buffer;
    try {
      encrypted = this.encryption.encryptString(key);
      if (encrypted.length === 0) throw new Error('Encrypted credential is empty');
    } catch {
      throw new AppError('AI_CREDENTIAL', '系统未能加密密钥，原密钥仍保留。请重试。');
    }

    const temporaryPath = join(this.directory, `.deepseek-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      // mkdir 的 mode 只作用于新目录；已有目录也收紧到当前用户可访问。
      await fs.chmod(this.directory, 0o700);
      await fs.writeFile(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
      // 同目录 rename 保证失败前原密钥不被改写，也不会留下半个目标文件。
      await fs.rename(temporaryPath, this.keyPath);
    } catch {
      try {
        await fs.unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isMissingFile(cleanupError)) {
          throw new AppError(
            'STORAGE',
            '密钥未保存，原密钥仍保留，但临时加密文件未能清理。请重试。',
          );
        }
      }
      throw new AppError('STORAGE', '密钥未保存，原密钥仍保留。请重试。');
    }
  }

  async clearKey(): Promise<void> {
    try {
      await fs.unlink(this.keyPath);
    } catch (error) {
      if (isMissingFile(error)) return;
      throw new AppError('STORAGE', '密钥未清除，原密钥仍保留。请重试。');
    }
  }

  private requireEncryption(): void {
    if (!this.isEncryptionAvailable()) {
      throw new AppError('AI_CREDENTIAL', '系统密钥保护不可用，无法保存或使用 AI 密钥。');
    }
  }
}
