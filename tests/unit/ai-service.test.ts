import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AiService } from '../../src/main/ai-service';
import { DEFAULT_AI_BASE_URL, type AiModel } from '../../src/shared/ai';
import { AppError, type Result } from '../../src/shared/errors';
import type { StoreRequest, StoreValue } from '../../src/shared/contracts';
import type { DeepSeekClient } from '../../src/services/deepseek-client';
import {
  validateAiKey,
  validateAiBaseUrl,
  validateAiModel,
  validateAiRequestId,
} from '../../src/services/ai-validation';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('等待对象尚未初始化');
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error('等待对象尚未初始化');
  };
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 只模拟外部能力；观察公开结果、持久化快照、并发与取消，不接触真实知识库。 */
function fixture() {
  let model: AiModel = 'deepseek-flash';
  let baseUrl = DEFAULT_AI_BASE_URL;
  let key: string | null = 'fake-test-key';
  const credentials = {
    hasKey: vi.fn(async () => key !== null),
    readKey: vi.fn(async () => key),
    isEncryptionAvailable: () => true,
    saveKey: vi.fn(async (value: string) => {
      key = value;
    }),
    clearKey: vi.fn(async () => {
      key = null;
    }),
  };
  const request = vi.fn(async (input: StoreRequest): Promise<Result<StoreValue>> => {
    if (input.operation === 'saveAiModel') model = validateAiModel(input.payload);
    if (input.operation === 'saveAiBaseUrl') baseUrl = validateAiBaseUrl(input.payload);
    return { ok: true, value: { provider: 'deepseek', model, baseUrl } };
  });
  const client = { complete: vi.fn<DeepSeekClient['complete']>(async () => 'OK') };
  return { service: new AiService({ credentials, request, client }), credentials, request, client };
}

describe('AI 基础服务', () => {
  it('自定义地址规范化后进入全部调用快照，保存模型不覆盖地址，空串恢复官方', async () => {
    const { service, client } = fixture();
    await service.saveBaseUrl(' https://gateway.example/v1/chat/completions/ ');
    await service.saveModel('deepseek-v4-pro');
    const snapshot = await service.resolveCallContext();
    expect(snapshot).toEqual({
      model: 'deepseek-v4-pro',
      apiKey: 'fake-test-key',
      baseUrl: 'https://gateway.example/v1',
    });
    await service.testConnection(randomUUID());
    expect(client.complete.mock.calls[0]?.[0]).toMatchObject(snapshot);
    await service.saveBaseUrl('');
    expect((await service.loadSettings()).baseUrl).toBe(DEFAULT_AI_BASE_URL);
    expect(snapshot.baseUrl).toBe('https://gateway.example/v1');
  });

  it('换地址取消旧连接测试，迟到成功不能作为新配置验证结果', async () => {
    const { service, client } = fixture();
    const pending = deferred<string>();
    client.complete.mockReturnValueOnce(pending.promise);
    const result = service.testConnection(randomUUID());
    const cancelled = expect(result).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
    await service.saveBaseUrl('https://gateway.example/v1');
    expect(client.complete.mock.calls[0]?.[0].baseUrl).toBe(DEFAULT_AI_BASE_URL);
    expect(client.complete.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    pending.resolve('late success');
    await cancelled;
    await service.testConnection(randomUUID());
    expect(client.complete.mock.calls[1]?.[0].baseUrl).toBe('https://gateway.example/v1');
  });

  it('地址保存排队、关闭排空观察真实失败，失败后保留旧配置并可重试', async () => {
    const { service, request } = fixture();
    const pending = deferred<Result<StoreValue>>();
    request.mockReturnValueOnce(pending.promise);
    const saving = service.saveBaseUrl('https://gateway.example');
    const failed = expect(saving).rejects.toThrow('地址未保存');
    const closing = expect(service.stopAndDrain()).rejects.toThrow('地址未保存');
    pending.resolve({ ok: false, error: { code: 'STORAGE', message: '地址未保存' } });
    await failed;
    await closing;
    expect((await service.loadSettings()).baseUrl).toBe(DEFAULT_AI_BASE_URL);
    await service.saveBaseUrl('https://gateway.example');
    expect((await service.resolveCallContext()).baseUrl).toBe('https://gateway.example');
  });

  it('非法地址不进入存储或网络；损坏地址应答不能静默改投官方', async () => {
    const { service, request, client } = fixture();
    expect(() => service.saveBaseUrl('https://gateway.example?secret=key')).toThrow(
      'HTTP 或 HTTPS',
    );
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({
      ok: true,
      value: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'file:///tmp/service' },
    });
    await expect(service.testConnection(randomUUID())).rejects.toMatchObject({ code: 'STORAGE' });
    expect(client.complete).not.toHaveBeenCalled();
  });
  it('共享上下文读取等待配置写入，未配置时拒绝', async () => {
    const { service, credentials } = fixture();
    const pending = deferred<void>();
    credentials.saveKey.mockImplementationOnce(() => pending.promise);
    const saving = service.saveKey('pending-test-key');
    let resolved = false;
    const context = service.resolveCallContext().then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    pending.resolve();
    await saving;
    await expect(context).resolves.toMatchObject({ model: 'deepseek-flash' });
    await service.clearKey();
    await expect(service.resolveCallContext()).rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED' });
  });

  it('关闭排空等待连接测试真正结束，迟到成功被取消', async () => {
    const { service, client } = fixture();
    const pending = deferred<string>();
    client.complete.mockImplementationOnce(() => pending.promise);
    const flight = service.testConnection(randomUUID());
    const cancelled = expect(flight).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
    let drained = false;
    const stopping = service.stopAndDrain().then(() => {
      drained = true;
    });
    expect(client.complete.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve('late success');
    await cancelled;
    await stopping;
    expect(drained).toBe(true);
  });

  it('关闭开始后在途密钥保存失败时拒绝退出，后续仍可重试保存', async () => {
    const { service, credentials } = fixture();
    const pending = deferred<void>();
    credentials.saveKey.mockImplementationOnce(() => pending.promise);
    const saving = service.saveKey('pending-test-key');
    const saveFailed = expect(saving).rejects.toThrow('密钥写入失败');
    const closeFailed = expect(service.stopAndDrain()).rejects.toThrow('密钥写入失败');
    pending.reject(new AppError('STORAGE', '密钥写入失败'));
    await saveFailed;
    await closeFailed;
    await expect(service.saveKey('retry-test-key')).resolves.toBeNull();
  });
  it('状态和测试结果均不回传密钥，测试使用已保存模型与固定文字', async () => {
    const { service, client } = fixture();
    expect(await service.loadSettings()).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      baseUrl: DEFAULT_AI_BASE_URL,
      keyConfigured: true,
      encryptionAvailable: true,
    });
    await service.saveModel('deepseek-v4-pro');
    const result = await service.testConnection(randomUUID());
    expect(result).toEqual({
      model: 'deepseek-v4-pro',
      checkedAt: expect.any(String),
      elapsedMs: expect.any(Number),
    });
    expect(client.complete.mock.calls[0]?.[0]).toMatchObject({
      model: 'deepseek-v4-pro',
      apiKey: 'fake-test-key',
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      maxTokens: 64,
    });
    expect(JSON.stringify(result)).not.toContain('fake-test-key');
  });

  it('清除后拒绝网络请求，重新保存后恢复配置', async () => {
    const { service, client } = fixture();
    await service.clearKey();
    await expect(service.testConnection(randomUUID())).rejects.toMatchObject({
      code: 'AI_NOT_CONFIGURED',
    });
    expect(client.complete).not.toHaveBeenCalled();
    await service.saveKey('  replacement-test-key  ');
    expect((await service.loadSettings()).keyConfigured).toBe(true);
    await service.testConnection(randomUUID());
    expect(client.complete.mock.calls[0]?.[0].apiKey).toBe('replacement-test-key');
  });

  it('配置查询期间即拒绝重复测试，旧请求取消不能取消新请求', async () => {
    const { service, request, client } = fixture();
    const pending = deferred<Result<StoreValue>>();
    request.mockImplementationOnce(() => pending.promise);
    const id = randomUUID();
    const first = service.testConnection(id);
    const cancelled = expect(first).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await expect(service.testConnection(randomUUID())).rejects.toMatchObject({ code: 'CONFLICT' });
    service.cancelTest(randomUUID());
    service.cancelTest(id);
    pending.resolve({
      ok: true,
      value: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: DEFAULT_AI_BASE_URL },
    });
    await cancelled;
    expect(client.complete).not.toHaveBeenCalled();
    await expect(service.testConnection(randomUUID())).resolves.toMatchObject({
      model: 'deepseek-flash',
    });
  });

  it('改模型会取消旧测试，即使底层迟到成功也不返回验证通过', async () => {
    const { service, client } = fixture();
    const pending = deferred<string>();
    client.complete.mockImplementationOnce(() => pending.promise);
    const result = service.testConnection(randomUUID());
    const cancelled = expect(result).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalled());
    await service.saveModel('deepseek-v4-pro');
    expect(client.complete.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    pending.resolve('late success');
    await cancelled;
    expect((await service.loadSettings()).model).toBe('deepseek-v4-pro');
  });

  it('一次凭据写入失败不会阻塞后续更换，关闭会等待已提交写入', async () => {
    const { service, credentials } = fixture();
    credentials.saveKey.mockRejectedValueOnce(new AppError('STORAGE', '写入失败'));
    await expect(service.saveKey('first-test-key')).rejects.toThrow('写入失败');
    const pending = deferred<void>();
    credentials.saveKey.mockImplementationOnce(() => pending.promise);
    const saved = service.saveKey('second-test-key');
    let drained = false;
    const closing = service.stopAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    pending.resolve();
    await saved;
    await closing;
    expect(drained).toBe(true);
  });

  it('保留模型存储失败的错误，不调用网络，并拒绝损坏的配置应答', async () => {
    const { service, request, client } = fixture();
    request.mockResolvedValueOnce({ ok: false, error: { code: 'STORAGE', message: '模型未保存' } });
    await expect(service.saveModel('deepseek-v4-pro')).rejects.toThrow('模型未保存');
    request.mockResolvedValueOnce({ ok: true, value: null });
    await expect(service.testConnection(randomUUID())).rejects.toMatchObject({ code: 'STORAGE' });
    expect(client.complete).not.toHaveBeenCalled();
  });
});

describe('AI IPC 输入验证', () => {
  it.each([
    ['', DEFAULT_AI_BASE_URL],
    ['   ', DEFAULT_AI_BASE_URL],
    [' https://API.DEEPSEEK.COM/ ', DEFAULT_AI_BASE_URL],
    ['https://gateway.example/v1/', 'https://gateway.example/v1'],
    ['https://gateway.example/v1/chat/completions/', 'https://gateway.example/v1'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
    ['https://gateway.example/chat/completions', 'https://gateway.example'],
  ])('归一化 API 地址 %s', (value, expected) => {
    expect(validateAiBaseUrl(value)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    12,
    'gateway.example',
    'https:gateway.example',
    'file:///tmp/api',
    'ftp://gateway.example',
    'https://user:secret@gateway.example',
    'https://gateway.example?token=secret',
    'https://gateway.example/#fragment',
    'https://gateway.example?',
    'https://gateway.example#',
    'https://gateway.example/with space',
    'https://gateway.example/\npath',
    'https://gateway.example\\path',
    `https://gateway.example/${'x'.repeat(2048)}`,
    `https://gateway.example/${'中'.repeat(300)}`,
  ])('非法 API 地址 %# 不在错误中暴露输入', (value) => {
    expect(() => validateAiBaseUrl(value)).toThrow('HTTP 或 HTTPS API 地址');
    expect(() => validateAiBaseUrl(value)).not.toThrow('secret');
  });
  it('拒绝任意模型、空白/换行/超长密钥和非法请求 ID', () => {
    expect(() => validateAiModel('unknown-provider')).toThrow();
    for (const value of [null, '', '  ', 'key\ninjection', 'key value', 'x'.repeat(513)])
      expect(() => validateAiKey(value)).toThrow();
    for (const value of [null, '', '1', 'bad-request'])
      expect(() => validateAiRequestId(value)).toThrow();
    expect(validateAiKey('  test-key  ')).toBe('test-key');
    expect(validateAiRequestId(randomUUID())).toEqual(expect.any(String));
  });
});
