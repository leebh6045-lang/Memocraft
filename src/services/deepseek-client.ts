import { modelSupportsImages, type AiMessage, type AiCallContext } from '../shared/ai';
import { AppError } from '../shared/errors';
import { validateAiBaseUrl } from './ai-validation';

interface CompletionInput extends AiCallContext {
  messages: AiMessage[];
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅完整的文本生成算成功，不能把截断回答或供应商错误正文当作结果。 */
function responseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices))
    throw new AppError('AI_RESPONSE', 'DeepSeek 返回格式异常，请稍后重试。');
  const choice: unknown = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message))
    throw new AppError('AI_RESPONSE', 'DeepSeek 返回格式异常，请稍后重试。');
  if (choice.finish_reason === 'length')
    throw new AppError(
      'AI_RESPONSE',
      'DeepSeek 回答达到输出上限，未能完整生成。请调整请求后重试。',
    );
  if (choice.finish_reason !== 'stop')
    throw new AppError('AI_RESPONSE', 'DeepSeek 未能完整生成回答，请稍后重试。');
  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim())
    throw new AppError('AI_RESPONSE', 'DeepSeek 未返回有效文字，请稍后重试。');
  return content;
}

function httpFailure(status: number): AppError {
  // 请求构造失败不能统一归因于用户选模型；仅保留状态码，不暴露供应商正文。
  if (status === 400)
    return new AppError(
      'AI_RESPONSE',
      'DeepSeek 请求格式不正确（HTTP 400），请更新应用或反馈此错误。',
    );
  if (status === 422)
    return new AppError(
      'AI_RESPONSE',
      'DeepSeek 请求参数不正确（HTTP 422），请更新应用或反馈此错误。',
    );
  if (status === 404)
    return new AppError(
      'AI_RESPONSE',
      'DeepSeek 未找到请求的模型或服务接口（HTTP 404），请检查 API 地址和模型。',
    );
  if (status === 401 || status === 403)
    return new AppError('AI_AUTH', 'DeepSeek 密钥无效或没有调用权限，请检查密钥。');
  if (status === 402) return new AppError('AI_BALANCE', 'DeepSeek 账户余额不足，请充值后重试。');
  if (status === 429) return new AppError('AI_RATE_LIMIT', 'DeepSeek 请求过于频繁，请稍后重试。');
  if (status >= 500) return new AppError('AI_NETWORK', 'DeepSeek 服务暂时不可用，请稍后重试。');
  return new AppError(
    'AI_RESPONSE',
    `DeepSeek 未能处理请求（HTTP ${status}），请稍后重试或反馈此错误。`,
  );
}

/** 与 Electron 装配解耦；一次调用只发一个请求，失败不自动重试，避免重复计费。 */
export class DeepSeekClient {
  constructor(
    private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async complete(input: CompletionInput): Promise<string> {
    if (input.signal?.aborted) throw new AppError('AI_CANCELLED', 'AI 请求已取消。');
    const endpoint = `${validateAiBaseUrl(input.baseUrl)}/chat/completions`;
    // 即使未来调用方传错类型，图片也不能进入系统消息或不支持视觉的模型。
    const imageMessages = input.messages.filter((message) => Array.isArray(message.content));
    if (
      imageMessages.some((message) => message.role !== 'user') ||
      (!modelSupportsImages(input.model) &&
        imageMessages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'image_url'),
        ))
    )
      throw new AppError('VALIDATION', '当前模型或消息类型不接受图片输入。');
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new AppError('VALIDATION', 'AI 请求超时设置无效。');

    const controller = new AbortController();
    let abortError: AppError | null = null;
    let rejectAborted: ((error: AppError) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const abort = (error: AppError) => {
      if (abortError) return;
      abortError = error;
      controller.abort();
      rejectAborted?.(error);
    };
    const cancel = () => abort(new AppError('AI_CANCELLED', 'AI 请求已取消。'));
    input.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(
      () => abort(new AppError('AI_TIMEOUT', 'DeepSeek 请求超时，请检查网络后重试。')),
      timeoutMs,
    );

    try {
      // 限制覆盖取得响应和读取正文；即使底层未及时响应 abort，也能结束上层等待。
      return await Promise.race([this.request(input, endpoint, controller.signal), aborted]);
    } catch (error) {
      // HTTP 失败时不读取供应商正文，并中止尚未消费的响应流。
      controller.abort();
      if (abortError) throw abortError;
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', cancel);
    }
  }

  private async request(
    input: CompletionInput,
    endpoint: string,
    signal: AbortSignal,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: 'POST',
        // 只向用户保存的目的地址发送凭据和手记，不自动跟随服务端重定向。
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${input.apiKey}`,
        },
        // 两个 V4 模型均支持此开关且默认开启；短文本调用显式关闭，避免额外思考耗时。
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          thinking: { type: 'disabled' },
          stream: false,
          max_tokens: input.maxTokens ?? 1_024,
        }),
        signal,
      });
    } catch {
      // 不携带原始原因，网络异常可能包含认证信息或用户发送的文本。
      throw new AppError('AI_NETWORK', '无法连接 DeepSeek，请检查网络后重试。');
    }
    if (signal.aborted) throw new AppError('AI_CANCELLED', 'AI 请求已取消。');
    if (!response.ok) throw httpFailure(response.status);

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new AppError('AI_NETWORK', '读取 DeepSeek 回答失败，请检查网络后重试。');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new AppError('AI_RESPONSE', 'DeepSeek 返回格式异常，请稍后重试。');
    }
    return responseContent(value);
  }
}
