import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';

// 用 Electron 的内置 Node 运行，证明驱动与已构建 worker 的实际兼容性。
const directory = await mkdtemp(join(tmpdir(), 'memocraft-runtime-'));
const worker = new Worker(resolve('out/main/storage-worker.js'), {
  workerData: { dataDirectory: directory, migrationsDirectory: resolve('migrations') },
});
let sequence = 0;
const request = (message) =>
  new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      worker.off('message', receive);
      reject(new Error('存储线程超时'));
    }, 10_000);
    const receive = (reply) => {
      if (reply.id !== id) return;
      clearTimeout(timeout);
      worker.off('message', receive);
      if (!reply.result.ok) reject(new Error(reply.result.error.message));
      else resolveRequest(reply.result.value);
    };
    worker.on('message', receive);
    worker.postMessage({ id, request: message });
  });
try {
  assert.deepEqual(await request({ operation: 'load' }), { notes: [], draft: null });
  const draft = {
    id: randomUUID(),
    body: '实际运行时 中文 100%_',
    title: '',
    category: 'thought',
    tags: [],
    revision: 1,
    extrasOpen: false,
  };
  await request({ operation: 'saveDraft', payload: draft });
  const saved = await request({ operation: 'commitDraft', payload: draft });
  assert.equal(saved.category, 'thought');
  // 全对象搜索：普通符号按文本匹配，草稿不参与，因此只应命中刚提交的那条手记。
  const found = await request({ operation: 'search', payload: '100%_' });
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0].kind, 'note');
  assert.equal(found.hasMore, false);
  await request({ operation: 'close' });
  const database = new DatabaseSync(join(directory, 'memocraft.sqlite'));
  try {
    database.exec(
      "CREATE TEMP TABLE rollback_probe (value TEXT); BEGIN; INSERT INTO rollback_probe VALUES ('temporary'); ROLLBACK;",
    );
    assert.equal(database.prepare('SELECT count(*) AS count FROM rollback_probe').get().count, 0);
    await backup(database, join(directory, 'snapshot.sqlite'));
  } finally {
    database.close();
  }
  const snapshot = new DatabaseSync(join(directory, 'snapshot.sqlite'), { readOnly: true });
  try {
    await backup(snapshot, join(directory, 'restored.sqlite'));
  } finally {
    snapshot.close();
  }
  const restored = new DatabaseSync(join(directory, 'restored.sqlite'), { readOnly: true });
  try {
    assert.equal(
      restored.prepare('SELECT body FROM notes WHERE id = ?').get(draft.id).body,
      draft.body,
    );
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    restored.close();
  }
  console.log(
    JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      sqlite: process.versions.sqlite,
      architecture: process.arch,
      result: 'passed',
    }),
  );
} finally {
  await worker.terminate();
  await rm(directory, { recursive: true, force: true });
}
