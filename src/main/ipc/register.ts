import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { CHANNELS, type StoreRequest, type StoreValue } from '../../shared/contracts';
import { MAX_IMAGE_BYTES, type ImageInput } from '../../domain/note-image';
import { AppError, failure, type Result } from '../../shared/errors';
import type { StoreClient } from '../store-client';
import { isTrustedSender } from '../window';

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
): () => void {
  const operations = ['load', 'saveDraft', 'commitDraft', 'updateNote', 'search'] as const;
  for (const operation of operations) {
    ipcMain.handle(CHANNELS[operation], async (event, payload: unknown) => {
      if (!isTrustedSender(event, window, rendererUrl))
        return failure(new AppError('UNAVAILABLE', '请求来源无效。'));
      const request: StoreRequest = operation === 'load' ? { operation } : { operation, payload };
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
  return () => {
    for (const operation of operations) ipcMain.removeHandler(CHANNELS[operation]);
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
