import { parentPort, workerData } from 'node:worker_threads';
import { NoteStore } from '../../storage/note-store';
import { NoteImageStore } from '../../storage/note-image-store';
import { TopicStore } from '../../storage/topic-store';
import { TagStore } from '../../storage/tag-store';
import { ThreadStore } from '../../storage/thread-store';
import { SearchStore } from '../../storage/search-store';
import { NoteSearchStore } from '../../storage/note-search-store';
import { TrashStore } from '../../storage/trash-store';
import { ExportStore } from '../../storage/export-store';
import { AiSettingsStore } from '../../storage/ai-settings-store';
import { PeriodSummaryStore } from '../../storage/period-summary-store';
import { SCHEMA_VERSION } from '../../storage/schema';
import { executeStoreRequest, type StoreContext } from '../../services/note-service';
import type { WorkerReply, WorkerRequest } from '../../shared/contracts';
import { AppError, failure, type Result } from '../../shared/errors';

const parent = parentPort;
if (!parent) throw new Error('存储线程必须由桌面主进程启动。');
const port: NonNullable<typeof parentPort> = parent;
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
/** 路径在启动时校验过一次，这里取出来作为字符串常量使用。 */
const dataDirectory = workerData.dataDirectory as string;
const migrationsDirectory = workerData.migrationsDirectory as string;

let store: NoteStore | null = null;
let images: NoteImageStore | null = null;
let topics: TopicStore | null = null;
let tags: TagStore | null = null;
let threads: ThreadStore | null = null;
let search: SearchStore | null = null;
let noteSearch: NoteSearchStore | null = null;
let trash: TrashStore | null = null;
let exporter: ExportStore | null = null;
let aiSettings: AiSettingsStore | null = null;
let periodSummaries: PeriodSummaryStore | null = null;
let initializationFailure: Result<never> = failure(
  new AppError('UNAVAILABLE', '本地数据尚未初始化。'),
);
try {
  store = new NoteStore({
    dataDirectory,
    migrationsDirectory,
    // 期望的模式版本来自应用常量，不由迁移目录的文件个数推算。
    expectedSchemaVersion: SCHEMA_VERSION,
  });
  // 附图、归纳、事务与手记共用同一条连接，连接的所有权仍在 NoteStore。
  images = new NoteImageStore(store.connection(), dataDirectory);
  topics = new TopicStore(store.connection());
  tags = new TagStore(store.connection());
  threads = new ThreadStore(store.connection());
  search = new SearchStore(store.connection());
  noteSearch = new NoteSearchStore(store.connection());
  // 回收站的删除委托给各实体存储，因此在这里注入它们。
  trash = new TrashStore(store.connection(), store, topics, threads);
  exporter = new ExportStore(store.connection(), store, topics, threads);
  aiSettings = new AiSettingsStore(store.connection());
  periodSummaries = new PeriodSummaryStore(store.connection());
} catch (error) {
  initializationFailure = failure(error);
}

function context(): StoreContext | null {
  if (
    !store ||
    !images ||
    !topics ||
    !tags ||
    !threads ||
    !search ||
    !noteSearch ||
    !trash ||
    !exporter ||
    !aiSettings ||
    !periodSummaries
  )
    return null;
  return {
    notes: store,
    images,
    topics,
    tags,
    threads,
    search,
    noteSearch,
    trash,
    exporter,
    aiSettings,
    periodSummaries,
    dataDirectory,
    migrationsDirectory,
  };
}

/**
 * 同步处理每条消息，唯一连接只在此线程使用，请求天然串行。
 * 备份、导出与恢复暂存是异步文件操作，因此这里 await 后再回信；
 * 串行性由「一次只处理一条消息」保证——消息处理期间不会有第二条被取出。
 */
async function handle(message: WorkerRequest): Promise<void> {
  const stores = context();
  let reply: WorkerReply;
  try {
    reply = {
      id: message.id,
      result: stores
        ? { ok: true, value: await executeStoreRequest(stores, message.request) }
        : initializationFailure,
    };
  } catch (error) {
    reply = { id: message.id, result: failure(error) };
  }
  port.postMessage(reply);
  if (!store || (message.request.operation === 'close' && reply.result.ok)) port.close();
}

port.on('message', (message: WorkerRequest) => {
  void handle(message);
});
