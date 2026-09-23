import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { CHANNELS, type StoreRequest, type StoreValue } from '../../shared/contracts';
import { MAX_IMAGE_BYTES, type ImageInput } from '../../domain/note-image';
import { AppError, failure, type Result } from '../../shared/errors';
import type { StoreClient } from '../store-client';
import { isTrustedSender } from '../window';
import {
  applyRestore,
  backupWithDialog,
  exportWithDialog,
  stageRestoreWithDialog,
  type LibraryDataDeps,
} from '../library-data';

/** 一次最多读取的图片数量；与 services 校验上限保持一致。 */
const MAX_SELECTED_FILES = 20;
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

/**
 * 主进程直接读取用户选中的文件，渲染端只提交图片 ID 与展示名称。
 * 真实类型仍由存储层按文件签名判定，这里的后缀过滤只用于尽早给出提示。
 * 导出以便对真实文件做测试：系统选图对话框本身无法自动化，但读取与限制必须可验证。
 */
export async function readSelectedImages(paths: string[]): Promise<ImageInput[]> {
  if (paths.length > MAX_SELECTED_FILES)
    throw new AppError('VALIDATION', `一次最多添加 ${MAX_SELECTED_FILES} 张图片。`);
  const images: ImageInput[] = [];
  for (const path of paths) {
    if (!ALLOWED_EXTENSIONS.has(extname(path).toLowerCase()))
      throw new AppError('VALIDATION', '只支持 PNG、JPEG、GIF 与 WebP 图片。');
    const info = await stat(path);
    if (info.size === 0) throw new AppError('VALIDATION', '选中的图片内容为空。');
    if (info.size > MAX_IMAGE_BYTES)
      throw new AppError(
        'VALIDATION',
        `单张图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB。`,
      );
    images.push({ bytes: await readFile(path), originalName: path.split(/[\\/]/).pop() ?? '' });
  }
  return images;
}

/**
 * 只处理「打开选图对话框 → 读取文件 → 请求存储」这一点逻辑，
 * 不碰 ipcMain，因此可以在测试中用假对话框与假存储验证取消、读取与转发。
 */
export async function handleAddImagesFromDialog(
  showOpenDialog: () => Promise<{ canceled: boolean; filePaths: string[] }>,
  request: (request: StoreRequest) => Promise<Result<StoreValue>>,
  noteId: unknown,
): Promise<Result<StoreValue>> {
  try {
    const selection = await showOpenDialog();
    // 用户取消不是错误：返回当前列表，界面据此不做任何改动。
    if (selection.canceled || selection.filePaths.length === 0)
      return await request({ operation: 'loadImages', payload: noteId });
    const images = await readSelectedImages(selection.filePaths);
    return await request({ operation: 'addImages', payload: { noteId, images } });
  } catch (error) {
    return failure(error);
  }
}

export function registerStoreIpc(
  window: BrowserWindow,
  rendererUrl: string,
  store: StoreClient,
  libraryData: { dataDirectory: string },
): () => void {
  // 无载荷与有载荷的操作走同一个分发入口；载荷由 services 校验，这里不解析内容。
  const operations = [
    'load',
    'loadTopics',
    'loadTrash',
    'saveDraft',
    'commitDraft',
    'updateNote',
    'search',
    'createTopic',
    'updateTopic',
    'loadRemovalImpact',
    'removeItem',
    'restoreItem',
    'addNotesToTopic',
    'removeNoteFromTopic',
    'loadThreads',
    'createThread',
    'updateThread',
    'archiveThread',
    'addNotesToThread',
    'removeNoteFromThread',
    'loadEntries',
    'createEntry',
    'updateEntry',
    'loadNoteReferences',
  ] as const;
  for (const operation of operations) {
    ipcMain.handle(CHANNELS[operation], async (event, payload: unknown) => {
      if (!isTrustedSender(event, window, rendererUrl))
        return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
      const request: StoreRequest =
        operation === 'load' || operation === 'loadTopics' || operation === 'loadTrash'
          ? { operation }
          : { operation, payload };
      try {
        return await store.request(request);
      } catch (error) {
        return failure(error);
      }
    });
  }
  ipcMain.handle(CHANNELS.loadImages, async (event, noteId: unknown) => {
    if (!isTrustedSender(event, window, rendererUrl))
      return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
    try {
      return await store.request({ operation: 'loadImages', payload: noteId });
    } catch (error) {
      return failure(error);
    }
  });
  ipcMain.handle(CHANNELS.addImages, async (event, payload: unknown) => {
    if (!isTrustedSender(event, window, rendererUrl))
      return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
    try {
      return await store.request({ operation: 'addImages', payload });
    } catch (error) {
      return failure(error);
    }
  });
  ipcMain.handle(CHANNELS.addImagesFromDialog, async (event, noteId: unknown) => {
    if (!isTrustedSender(event, window, rendererUrl))
      return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
    return handleAddImagesFromDialog(
      () =>
        dialog.showOpenDialog(window, {
          title: '选择图片',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        }),
      (request) => store.request(request),
      noteId,
    );
  });
  ipcMain.handle(CHANNELS.renameImage, async (event, payload: unknown) => {
    if (!isTrustedSender(event, window, rendererUrl))
      return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
    try {
      return await store.request({ operation: 'renameImage', payload });
    } catch (error) {
      return failure(error);
    }
  });
  ipcMain.handle(CHANNELS.deleteImage, async (event, imageId: unknown) => {
    if (!isTrustedSender(event, window, rendererUrl))
      return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
    try {
      return await store.request({ operation: 'deleteImage', payload: imageId });
    } catch (error) {
      return failure(error);
    }
  });
  /** 保存对话框返回单个 filePath，这里统一成与打开对话框一致的形状。 */
  const saveDialog = async (options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(window, options);
    return { canceled: result.canceled, filePaths: result.filePath ? [result.filePath] : [] };
  };
  const deps: LibraryDataDeps = {
    dataDirectory: libraryData.dataDirectory,
    request: (request) => store.request(request),
    closeStore: () => store.close(),
    resetStore: () => store.reset(),
  };
  /** 三个数据通道都先弹主进程对话框，渲染端不传路径也不接触文件系统。 */
  const guarded = (channel: string, run: () => Promise<Result<StoreValue | null>>): void => {
    ipcMain.handle(channel, async (event) => {
      if (!isTrustedSender(event, window, rendererUrl))
        return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
      return run();
    });
  };
  guarded(CHANNELS.backupLibrary, () =>
    backupWithDialog(
      () =>
        saveDialog({
          title: '选择备份位置',
          defaultPath: `Memocraft-备份-${stamp()}`,
          buttonLabel: '备份到这里',
          properties: ['createDirectory'],
        }),
      deps.request,
    ),
  );
  guarded(CHANNELS.exportLibrary, () =>
    exportWithDialog(
      () =>
        saveDialog({
          title: '选择导出位置',
          defaultPath: `Memocraft-导出-${stamp()}`,
          buttonLabel: '导出到这里',
          properties: ['createDirectory'],
        }),
      deps.request,
    ),
  );
  guarded(CHANNELS.restoreLibrary, () =>
    stageRestoreWithDialog(
      () =>
        dialog.showOpenDialog(window, {
          title: '选择备份目录包或数据库快照',
          buttonLabel: '校验这个备份',
          properties: ['openDirectory', 'openFile'],
        }),
      deps.request,
    ),
  );
  guarded(CHANNELS.applyRestore, async () => {
    const result = await applyRestore(deps);
    return result.ok ? { ok: true, value: null } : result;
  });

  return () => {
    for (const operation of operations) ipcMain.removeHandler(CHANNELS[operation]);
    for (const channel of [
      CHANNELS.backupLibrary,
      CHANNELS.exportLibrary,
      CHANNELS.restoreLibrary,
      CHANNELS.applyRestore,
    ])
      ipcMain.removeHandler(channel);
    for (const channel of [
      CHANNELS.loadImages,
      CHANNELS.addImages,
      CHANNELS.addImagesFromDialog,
      CHANNELS.renameImage,
      CHANNELS.deleteImage,
    ])
      ipcMain.removeHandler(channel);
  };
}

/** 默认名称带日期时间，便于用户区分多次备份。 */
function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
