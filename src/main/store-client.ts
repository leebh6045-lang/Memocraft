import { Worker } from 'node:worker_threads';
import type { StoreRequest, StoreValue, WorkerReply } from '../shared/contracts';
import { AppError, failure, type Result } from '../shared/errors';

interface PendingRequest {
  resolve: (result: Result<StoreValue>) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 超时后终止失联线程，再次请求重新开库；稳定草稿 ID 使不确定提交可以安全重试。 */
export class StoreClient {
  private worker: Worker | null = null;
  private termination: Promise<number> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;
  private closing = false;

  constructor(private readonly paths: { dataDirectory: string; migrationsDirectory: string }) {}

  async request(request: StoreRequest): Promise<Result<StoreValue>> {
    if (this.closing && request.operation !== 'close')
      return failure(new AppError('UNAVAILABLE', '正在关闭数据服务，请稍后重试。'));
    if (this.closed)
      return failure(new AppError('UNAVAILABLE', '数据服务已关闭，请重新打开应用。'));
    // 等旧线程真正退出后再开库，避免重试期间出现两条存储连接。
    if (this.termination) await this.termination;
    const worker = this.worker ?? this.start();
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.fail(worker, '数据操作超时，结果尚未确认。内容仍在编辑区，请重试。'),
        30_000,
      );
      this.pending.set(id, { resolve, timer });
      try {
        worker.postMessage({ id, request });
      } catch {
        this.fail(worker, '数据服务暂时不可用，内容仍在编辑区，请重试。');
      }
    });
  }

  async close(): Promise<Result<StoreValue>> {
    this.closing = true;
    try {
      const result = await this.request({ operation: 'close' });
      if (result.ok) {
        this.closed = true;
        // 成功响应只会在 SQLite 已关闭后发出，worker 随后自行关闭消息端口退出。
        this.worker = null;
      }
      return result;
    } finally {
      this.closing = false;
    }
  }

  private start(): Worker {
    const worker = new Worker(new URL('./storage-worker.js', import.meta.url), {
      workerData: this.paths,
    });
    this.worker = worker;
    worker.on('message', (reply: WorkerReply) => {
      // 已被替换的线程即使迟到回信，也不能结束新线程的请求。
      if (this.worker !== worker) return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      pending.resolve(reply.result);
    });
    worker.on('error', () =>
      this.fail(worker, '本地数据服务未能运行。内容仍在编辑区，请重试；持续失败时请检查数据目录。'),
    );
    worker.on('exit', () => {
      if (this.worker !== worker) return;
      this.worker = null;
      if (this.pending.size) this.failPending('本地数据服务意外停止，内容仍在编辑区，请重试。');
    });
    return worker;
  }

  private fail(worker: Worker, message: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.failPending(message);
    this.termination = worker.terminate().finally(() => {
      this.termination = null;
    });
  }

  private failPending(message: string): void {
    const result = failure(new AppError('UNAVAILABLE', message));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(result);
    }
    this.pending.clear();
  }
}
