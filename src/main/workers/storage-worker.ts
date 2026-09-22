import { parentPort, workerData } from 'node:worker_threads';
import { NoteStore } from '../../storage/note-store';
import { NoteImageStore } from '../../storage/note-image-store';
import { executeStoreRequest } from '../../services/note-service';
import type { WorkerReply, WorkerRequest } from '../../shared/contracts';
import { AppError, failure, type Result } from '../../shared/errors';

const port = parentPort;
if (!port) throw new Error('存储线程必须由桌面主进程启动。');
const paths: unknown = workerData;
if (
  typeof paths !== 'object' ||
  paths === null ||
  !('dataDirectory' in paths) ||
  typeof paths.dataDirectory !== 'string' ||
  !('migrationsDirectory' in paths) ||
  typeof paths.migrationsDirectory !== 'string'
) {
  throw new Error('存储线程路径配置无效。');
}
let store: NoteStore | null = null;
let images: NoteImageStore | null = null;
let initializationFailure: Result<never> = failure(
  new AppError('UNAVAILABLE', '本地数据尚未初始化。'),
);
try {
  store = new NoteStore({
    dataDirectory: paths.dataDirectory,
    migrationsDirectory: paths.migrationsDirectory,
  });
  // 附图与手记共用同一条连接，连接的所有权仍在 NoteStore。
  images = new NoteImageStore(store.connection(), paths.dataDirectory);
} catch (error) {
  initializationFailure = failure(error);
}

// 同步处理每条消息，唯一连接只在此线程使用，所有请求天然串行。
port.on('message', (message: WorkerRequest) => {
  let reply: WorkerReply;
  try {
    reply = {
      id: message.id,
      result:
        store && images
          ? { ok: true, value: executeStoreRequest(store, images, message.request) }
          : initializationFailure,
    };
  } catch (error) {
    reply = { id: message.id, result: failure(error) };
  }
  port.postMessage(reply);
  if (!store || (message.request.operation === 'close' && reply.result.ok)) port.close();
});
