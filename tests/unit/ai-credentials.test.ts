import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCredentialStore, type CredentialEncryption } from '../../src/main/ai-credentials';

// 使用真实认证加密检查磁盘行为；这些固定字符串仅是测试样本，不是供应商密钥。
const firstKey = 'test-only-deepseek-key-first';
const secondKey = 'test-only-deepseek-key-second';

function createEncryption(): CredentialEncryption {
  const protectionKey = randomBytes(32);
  return {
    isAvailable: () => true,
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', protectionKey, nonce);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', protectionKey, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

describe('AI 本机加密密钥', () => {
  let temporaryRoot: string;
  let directory: string;
  let encryption: CredentialEncryption;
  let store: AiCredentialStore;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(join(tmpdir(), 'memocraft-ai-credentials-'));
    directory = join(temporaryRoot, 'credentials');
    encryption = createEncryption();
    store = new AiCredentialStore(directory, encryption);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  it('缺少目录或文件表示未配置，清除可重复执行', async () => {
    expect(await store.hasKey()).toBe(false);
    expect(await store.readKey()).toBeNull();
    await store.clearKey();
    await store.clearKey();
    expect(await store.hasKey()).toBe(false);
  });

  it('仅保存密文，并可由重建实例读取；目录与文件限制当前用户访问', async () => {
    await store.saveKey(firstKey);
    expect(await store.hasKey()).toBe(true);
    expect(await new AiCredentialStore(directory, encryption).readKey()).toBe(firstKey);
    const contents = await fs.readFile(join(directory, 'deepseek.enc'));
    expect(contents.includes(Buffer.from(firstKey))).toBe(false);
    expect(await fs.readdir(directory)).toEqual(['deepseek.enc']);
    if (process.platform !== 'win32') {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(join(directory, 'deepseek.enc'))).mode & 0o777).toBe(0o600);
    }
  });

  it('更换密钥后只保留新值，清除后重建实例仍未配置', async () => {
    await store.saveKey(firstKey);
    await store.saveKey(secondKey);
    expect(await store.readKey()).toBe(secondKey);
    expect(await fs.readdir(directory)).toEqual(['deepseek.enc']);
    await store.clearKey();
    expect(await new AiCredentialStore(directory, encryption).hasKey()).toBe(false);
  });

  it('空密钥被拒绝，原密钥不变', async () => {
    await store.saveKey(firstKey);
    await expect(store.saveKey(' \n ')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await store.readKey()).toBe(firstKey);
  });

  it('加密不可用时拒绝保存和读取，但允许查看配置和清除', async () => {
    await store.saveKey(firstKey);
    const unavailable = new AiCredentialStore(directory, {
      ...encryption,
      isAvailable: () => false,
    });
    expect(unavailable.isEncryptionAvailable()).toBe(false);
    expect(await unavailable.hasKey()).toBe(true);
    await expect(unavailable.saveKey(secondKey)).rejects.toMatchObject({ code: 'AI_CREDENTIAL' });
    await expect(unavailable.readKey()).rejects.toMatchObject({ code: 'AI_CREDENTIAL' });
    expect(await store.readKey()).toBe(firstKey);
    await unavailable.clearKey();
    expect(await unavailable.readKey()).toBeNull();
  });

  it('系统加密接口异常按不可用处理，不泄露其原始异常', async () => {
    const failing = new AiCredentialStore(directory, {
      ...encryption,
      isAvailable() {
        throw new Error(`failure at ${directory}`);
      },
    });
    expect(failing.isEncryptionAvailable()).toBe(false);
    await expect(failing.saveKey(firstKey)).rejects.toMatchObject({
      code: 'AI_CREDENTIAL',
      message: '系统密钥保护不可用，无法保存或使用 AI 密钥。',
    });
    expect(await store.hasKey()).toBe(false);
  });

  it('加密失败不会触碰原密文或泄露底层错误', async () => {
    await store.saveKey(firstKey);
    const failing = new AiCredentialStore(directory, {
      ...encryption,
      encryptString() {
        throw new Error(`Cannot encrypt ${secondKey} in ${directory}`);
      },
    });
    await expect(failing.saveKey(secondKey)).rejects.toMatchObject({
      code: 'AI_CREDENTIAL',
      message: '系统未能加密密钥，原密钥仍保留。请重试。',
    });
    expect(await store.readKey()).toBe(firstKey);
    expect(await fs.readdir(directory)).toEqual(['deepseek.enc']);
  });

  it('密文损坏或无法解密时保留文件，并给出重新保存提示', async () => {
    await store.saveKey(firstKey);
    const encryptedPath = join(directory, 'deepseek.enc');
    const original = await fs.readFile(encryptedPath);
    const cannotDecrypt = new AiCredentialStore(directory, createEncryption());
    await expect(cannotDecrypt.readKey()).rejects.toMatchObject({
      code: 'AI_CREDENTIAL',
      message: '已保存的密钥无法解密，请重新保存密钥。',
    });
    expect(await fs.readFile(encryptedPath)).toEqual(original);
    await fs.writeFile(encryptedPath, Buffer.from('damaged-ciphertext'));
    await expect(store.readKey()).rejects.toMatchObject({ code: 'AI_CREDENTIAL' });
    expect(await store.hasKey()).toBe(true);
  });

  it('原子替换失败后仍可读取旧密钥，并清理临时密文', async () => {
    await store.saveKey(firstKey);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      new Error(`Cannot replace ${directory} with ${secondKey}`),
    );
    await expect(store.saveKey(secondKey)).rejects.toMatchObject({
      code: 'STORAGE',
      message: '密钥未保存，原密钥仍保留。请重试。',
    });
    expect(await store.readKey()).toBe(firstKey);
    expect(await fs.readdir(directory)).toEqual(['deepseek.enc']);
  });

  it('文件访问失败转换为安全存储错误，不误报未配置或清除成功', async () => {
    await fs.mkdir(join(directory, 'deepseek.enc'), { recursive: true });
    await expect(store.hasKey()).rejects.toMatchObject({ code: 'STORAGE' });
    await expect(store.readKey()).rejects.toMatchObject({ code: 'STORAGE' });
    await expect(store.clearKey()).rejects.toMatchObject({ code: 'STORAGE' });
  });
});
