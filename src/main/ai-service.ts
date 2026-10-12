import {
  AI_MODELS,
  type AiConfiguration,
  type AiConnectionTest,
  type AiSettings,
  type AiCallContext,
} from '../shared/ai';
import { AppError, type Result } from '../shared/errors';
import type { StoreRequest, StoreValue } from '../shared/contracts';
import {
  validateAiBaseUrl,
  validateAiKey,
  validateAiModel,
  validateAiRequestId,
} from '../services/ai-validation';
import type { DeepSeekClient } from '../services/deepseek-client';
import type { AiCredentialStore } from './ai-credentials';
import { normalizeAiBaseUrl } from '../domain/ai-endpoint';

interface AiServiceDependencies {
  request(request: StoreRequest): Promise<Result<StoreValue>>;
  credentials: Pick<
    AiCredentialStore,
    'hasKey' | 'readKey' | 'saveKey' | 'clearKey' | 'isEncryptionAvailable'
  >;
  client: Pick<DeepSeekClient, 'complete'>;
}

interface ActiveTest {
  id: string;
  controller: AbortController;
}

/** 主进程只编排配置与网络；SQLite 查询始终交给已有存储线程。 */
export class AiService {
  private settingsQueue: Promise<void> = Promise.resolve();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private activeTest: ActiveTest | null = null;
  private testFlight: Promise<AiConnectionTest> | null = null;

  constructor(private readonly dependencies: AiServiceDependencies) {}

  loadSettings(): Promise<AiSettings> {
    return this.enqueue(async () => ({
      ...(await this.configuration({ operation: 'loadAiConfiguration' })),
      keyConfigured: await this.dependencies.credentials.hasKey(),
      encryptionAvailable: this.dependencies.credentials.isEncryptionAvailable(),
    }));
  }

  saveModel(value: unknown): Promise<AiConfiguration> {
    const model = validateAiModel(value);
    this.abortActiveTest();
    return this.trackWrite(
      this.enqueue(() => this.configuration({ operation: 'saveAiModel', payload: model })),
    );
  }

  saveBaseUrl(value: unknown): Promise<AiConfiguration> {
    const baseUrl = validateAiBaseUrl(value);
    this.abortActiveTest();
    return this.trackWrite(
      this.enqueue(() => this.configuration({ operation: 'saveAiBaseUrl', payload: baseUrl })),
    );
  }

  async saveKey(value: unknown): Promise<null> {
    const key = validateAiKey(value);
    this.abortActiveTest();
    await this.trackWrite(this.enqueue(() => this.dependencies.credentials.saveKey(key)));
    return null;
  }

  async clearKey(): Promise<null> {
    this.abortActiveTest();
    await this.trackWrite(this.enqueue(() => this.dependencies.credentials.clearKey()));
    return null;
  }

  async testConnection(value: unknown): Promise<AiConnectionTest> {
    const id = validateAiRequestId(value);
    if (this.activeTest)
      throw new AppError('CONFLICT', '已有连接测试正在进行，请等待或取消后重试。');
    // 查询配置前即占用槽位，准备期间也不能重复启动计费请求。
    const active: ActiveTest = { id, controller: new AbortController() };
    this.activeTest = active;
    const flight = this.runConnectionTest(active).finally(() => {
      if (this.activeTest === active) {
        this.activeTest = null;
        this.testFlight = null;
      }
    });
    this.testFlight = flight;
    return flight;
  }

  /** 配置与凭据只有这一处读取，业务服务取得快照后才执行外部调用。 */
  resolveCallContext(): Promise<AiCallContext> {
    return this.enqueue(async () => {
      const configuration = await this.configuration({ operation: 'loadAiConfiguration' });
      const key = await this.dependencies.credentials.readKey();
      if (!key) throw new AppError('AI_NOT_CONFIGURED', '请先在设置页保存 DeepSeek API Key。');
      return {
        model: configuration.model,
        baseUrl: configuration.baseUrl,
        apiKey: validateAiKey(key),
      };
    });
  }

  private async runConnectionTest(active: ActiveTest): Promise<AiConnectionTest> {
    const startedAt = Date.now();
    this.requireActive(active);
    const { model, apiKey, baseUrl } = await this.resolveCallContext();
    this.requireActive(active);
    await this.dependencies.client.complete({
      model,
      apiKey,
      baseUrl,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      maxTokens: 64,
      signal: active.controller.signal,
    });
    // 底层即使迟到成功，也不能把取消后的请求显示为验证通过。
    this.requireActive(active);
    return { model, checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt };
  }

  cancelTest(value: unknown): null {
    const id = validateAiRequestId(value);
    if (this.activeTest?.id === id) this.activeTest.controller.abort();
    return null;
  }

  /** 正常关闭先取消网络并等已提交的密钥/配置写入结束，再关闭数据库。 */
  async stopAndDrain(): Promise<void> {
    this.abortActiveTest();
    // 队列尾只保证后续操作可继续；关闭/恢复还必须观察当时在途写入的真实失败。
    const writes = [...this.pendingWrites];
    // 取消是正常收尾；配置写入失败仍须阻止关闭或恢复，且先等全部任务结算。
    const [writeResult] = await Promise.allSettled([
      Promise.all(writes),
      this.testFlight,
      this.settingsQueue,
    ]);
    if (writeResult?.status === 'rejected') throw writeResult.reason;
  }

  private abortActiveTest(): void {
    this.activeTest?.controller.abort();
  }

  private requireActive(active: ActiveTest): void {
    if (active.controller.signal.aborted) throw new AppError('AI_CANCELLED', '连接测试已取消。');
  }

  private async configuration(request: StoreRequest): Promise<AiConfiguration> {
    const result = await this.dependencies.request(request);
    if (!result.ok) throw new AppError(result.error.code, result.error.message);
    const value = result.value;
    if (
      typeof value === 'object' &&
      value !== null &&
      'model' in value &&
      'provider' in value &&
      'baseUrl' in value
    ) {
      const model = AI_MODELS.find((item) => item.value === value.model);
      if (value.provider === 'deepseek' && model) {
        // 存储返回不是用户输入；损坏地址不能静默改投默认服务。
        const baseUrl = normalizeAiBaseUrl(value.baseUrl);
        if (baseUrl && baseUrl === value.baseUrl)
          return { provider: 'deepseek', model: model.value, baseUrl };
      }
    }
    throw new AppError('STORAGE', 'AI 模型配置读取异常，请重试。');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.settingsQueue.then(operation);
    // 当前错误仍交给调用方；队列恢复可用，避免一次失败阻塞后续更换与清除。
    this.settingsQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private trackWrite<T>(result: Promise<T>): Promise<T> {
    this.pendingWrites.add(result);
    const remove = () => {
      this.pendingWrites.delete(result);
    };
    // 清理监听处理自己的拒绝；原 Promise 的失败仍交给页面及正在等待的关闭流程。
    void result.then(remove, remove);
    return result;
  }
}
