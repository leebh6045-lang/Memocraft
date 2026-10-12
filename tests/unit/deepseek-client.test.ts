import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekClient } from '../../src/services/deepseek-client';
import {
  AI_MODELS,
  DEFAULT_AI_BASE_URL,
  modelSupportsImages,
  type AiMessage,
} from '../../src/shared/ai';
import { AppError } from '../../src/shared/errors';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const input = {
  baseUrl: DEFAULT_AI_BASE_URL,
  model: 'deepseek-flash' as const,
  apiKey: 'test-secret-key',
  messages: [{ role: 'user' as const, content: 'Reply with OK.' }],
};

function answer(content: unknown = 'OK.', finishReason: unknown = 'stop'): Response {
  return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeepSeek 文本客户端', () => {
  it('同一客户端的并行调用各自使用地址快照，保留子路径且禁止重定向', async () => {
    const fetcher = vi.fn<Fetcher>(async () => answer());
    const client = new DeepSeekClient(fetcher);
    await Promise.all([
      client.complete({ ...input, baseUrl: 'https://gateway.example/v1/chat/completions/' }),
      client.complete(input),
      client.complete({ ...input, baseUrl: 'http://127.0.0.1:1234/proxy/v1' }),
    ]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://gateway.example/v1/chat/completions',
      `${DEFAULT_AI_BASE_URL}/chat/completions`,
      'http://127.0.0.1:1234/proxy/v1/chat/completions',
    ]);
    for (const [, init] of fetcher.mock.calls) expect(init.redirect).toBe('error');
  });

  it('非法目的地址在请求前拒绝；重定向不尝试第二个地址或暴露凭据', async () => {
    const fetcher = vi.fn<Fetcher>(
      async () =>
        new Response('redirect-secret', {
          status: 307,
          headers: { Location: 'https://other.example/chat/completions' },
        }),
    );
    const client = new DeepSeekClient(fetcher);
    await expect(
      client.complete({ ...input, baseUrl: 'https://user:secret@gateway.example' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetcher).not.toHaveBeenCalled();
    const redirected = client.complete(input);
    await expect(redirected).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    await expect(redirected).rejects.not.toThrow('redirect-secret');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(AI_MODELS)('通过 $label 调用官方接口并返回完整文字', async ({ value: model }) => {
    const fetcher = vi.fn<Fetcher>(async () => answer('  OK.\n'));
    const result = await new DeepSeekClient(fetcher).complete({ ...input, model, maxTokens: 32 });

    expect(result).toBe('  OK.\n');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret-key' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({
      model,
      messages: input.messages,
      thinking: { type: 'disabled' },
      stream: false,
      max_tokens: 32,
    });
  });

  it('Flash 正确发送 user 图片块，Pro 拒绝带图且不发请求', async () => {
    const messages: AiMessage[] = [
      { role: 'system', content: '根据文字和图片给建议' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '手记正文' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,dGVzdA==', detail: 'auto' },
          },
        ],
      },
    ];
    const fetcher = vi.fn<Fetcher>(async () => answer());
    const client = new DeepSeekClient(fetcher);
    await client.complete({ ...input, messages });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body)).messages).toEqual(messages);
    await expect(
      client.complete({ ...input, model: 'deepseek-v4-pro', messages }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(modelSupportsImages('deepseek-flash')).toBe(true);
    expect(modelSupportsImages('deepseek-v4-pro')).toBe(false);
  });

  it('图片不能出现在系统消息，运行时也拒绝错误角色', async () => {
    const message: AiMessage = {
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } }],
    };
    Reflect.set(message, 'role', 'system');
    const fetcher = vi.fn<Fetcher>(async () => answer());
    await expect(
      new DeepSeekClient(fetcher).complete({ ...input, messages: [message] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('带图可显式使用60秒，30秒后仍在等待，超时与取消保留原有语义', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<Fetcher>(() => new Promise<Response>(() => {}));
    const result = new DeepSeekClient(fetcher).complete({ ...input, timeoutMs: 60_000 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('未指定输出上限时使用有限默认值，并清理完成后的定时器和外部监听', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const fetcher = vi.fn<Fetcher>(async () => answer());
    await new DeepSeekClient(fetcher).complete({ ...input, signal: controller.signal });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toHaveProperty('max_tokens', 1_024);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort('private reason');
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(false);
  });

  it.each([
    [401, 'AI_AUTH'],
    [403, 'AI_AUTH'],
    [402, 'AI_BALANCE'],
    [429, 'AI_RATE_LIMIT'],
    [500, 'AI_NETWORK'],
    [503, 'AI_NETWORK'],
    [400, 'AI_RESPONSE'],
    [404, 'AI_RESPONSE'],
    [422, 'AI_RESPONSE'],
  ])('HTTP %i 给出安全错误 %s，且不会自动重试', async (status, code) => {
    const fetcher = vi.fn(async () => new Response('供应商原始错误 test-secret-key', { status }));
    const result = new DeepSeekClient(fetcher).complete(input);
    await expect(result).rejects.toBeInstanceOf(AppError);
    await expect(result).rejects.toMatchObject({ code });
    await expect(result).rejects.not.toThrow('test-secret-key');
    await expect(result).rejects.not.toThrow('供应商原始错误');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    [400, '请求格式不正确'],
    [422, '请求参数不正确'],
    [404, '未找到请求的模型或服务接口'],
    [405, '未能处理请求'],
  ])(
    'HTTP %i 的提示说明失败类型及状态码，不统一要求用户重新选模型',
    async (status, explanation) => {
      const fetcher = vi.fn(async () => new Response('私密供应商正文 test-secret-key', { status }));
      const result = new DeepSeekClient(fetcher).complete(input);
      await expect(result).rejects.toThrow(explanation);
      await expect(result).rejects.toThrow(`HTTP ${status}`);
      await expect(result).rejects.not.toThrow('检查所选模型');
      await expect(result).rejects.not.toThrow('test-secret-key');
      await expect(result).rejects.not.toThrow('私密供应商正文');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    [],
    {},
    { choices: [] },
    { choices: [null] },
    { choices: [{ finish_reason: 'stop' }] },
    { choices: [{ message: null, finish_reason: 'stop' }] },
  ])('拒绝非法响应结构 %#', async (body) => {
    const client = new DeepSeekClient(async () => Response.json(body));
    await expect(client.complete(input)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
  });

  it.each(['', '  \n\t', null, 42, ['OK.']])('拒绝空回答或非文本内容 %#', async (content) => {
    const client = new DeepSeekClient(async () => answer(content));
    await expect(client.complete(input)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
  });

  it.each(['length', 'content_filter', 'tool_calls', null])(
    '未完整结束的回答不能显示成功：%s',
    async (finishReason) => {
      const client = new DeepSeekClient(async () => answer('未完成的正文', finishReason));
      await expect(client.complete(input)).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    },
  );

  it('非法 JSON 不携带供应商正文，且失败后释放资源', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const client = new DeepSeekClient(async () => new Response('private-test-secret-key'));
    const result = client.complete({ ...input, signal: controller.signal });
    await expect(result).rejects.toMatchObject({ code: 'AI_RESPONSE' });
    await expect(result).rejects.not.toThrow('private-test-secret-key');
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('网络异常转为安全提示，不泄露原因且不重试', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('Authorization test-secret-key private request');
    });
    const result = new DeepSeekClient(fetcher).complete(input);
    await expect(result).rejects.toMatchObject({ code: 'AI_NETWORK' });
    await expect(result).rejects.not.toThrow('test-secret-key');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('读取响应时的连接断开给出网络错误', async () => {
    const response = answer();
    vi.spyOn(response, 'text').mockRejectedValue(new Error('private body error'));
    const result = new DeepSeekClient(async () => response).complete(input);
    await expect(result).rejects.toMatchObject({ code: 'AI_NETWORK' });
    await expect(result).rejects.not.toThrow('private body error');
  });

  it('默认 30 秒超时，中止底层请求并释放定时器', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<Fetcher>(() => new Promise<Response>(() => {}));
    const result = new DeepSeekClient(fetcher).complete(input);
    const rejected = expect(result).rejects.toMatchObject({ code: 'AI_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('超时包括读取 body，底层不响应 abort 时也能结束等待', async () => {
    vi.useFakeTimers();
    const response = answer();
    vi.spyOn(response, 'text').mockImplementation(() => new Promise<string>(() => {}));
    const fetcher = vi.fn<Fetcher>(async () => response);
    const result = new DeepSeekClient(fetcher, 50).complete(input);
    const rejected = expect(result).rejects.toMatchObject({ code: 'AI_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(response.text).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('开始前取消不发请求，也不暴露取消原因', async () => {
    const controller = new AbortController();
    controller.abort('private test-secret-key');
    const fetcher = vi.fn(async () => answer());
    const result = new DeepSeekClient(fetcher).complete({ ...input, signal: controller.signal });
    await expect(result).rejects.toMatchObject({ code: 'AI_CANCELLED' });
    await expect(result).rejects.not.toThrow('test-secret-key');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'body'])('进行中的 %s 取消中止底层，并释放监听与定时器', async (phase) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const response = answer();
    vi.spyOn(response, 'text').mockImplementation(() => new Promise<string>(() => {}));
    const fetcher = vi.fn<Fetcher>(() =>
      phase === 'fetch' ? new Promise<Response>(() => {}) : Promise.resolve(response),
    );
    const result = new DeepSeekClient(fetcher).complete({ ...input, signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'AI_CANCELLED' });

    await Promise.resolve();
    controller.abort('private reason');
    await rejected;
    expect(fetcher.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
