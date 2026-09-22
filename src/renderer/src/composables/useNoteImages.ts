import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import { imageLabel, type NoteImage, type NoteImageList } from '../../../domain/note-image';
import type { MemocraftApi } from '../../../shared/contracts';
import { AppError, type Result } from '../../../shared/errors';

function unwrap(result: Result<NoteImageList>): NoteImageList {
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.value;
}

function message(error: unknown): string {
  return error instanceof AppError ? error.message : '图片操作未完成，请重试。';
}

/** 图集现场；字段是 ref，模板可直接绑定，脚本内读当前值用 Vue 的 unwrap。 */
export interface NoteImageState {
  images: ShallowRef<NoteImage[]>;
  totalBytes: Ref<number>;
  loading: Ref<boolean>;
  busy: Ref<boolean>;
  error: Ref<string>;
  status: Ref<string>;
  apply: (list: NoteImageList) => void;
  load: (noteId: string) => Promise<void>;
  addFromDialog: (noteId: string) => Promise<boolean>;
  addFromClipboard: (
    noteId: string,
    image: { bytes: Uint8Array; originalName: string },
  ) => Promise<boolean>;
  rename: (noteId: string, imageId: string, displayName: string) => Promise<boolean>;
  remove: (noteId: string, imageId: string) => Promise<boolean>;
  label: typeof imageLabel;
}

/**
 * 单条手记的图集现场：加载、添加、命名与删除都以服务端返回的列表为准，
 * 不做本地乐观插入，避免保存失败时界面显示并不存在的图片。
 */
export function useNoteImages(api: MemocraftApi): NoteImageState {
  const images = shallowRef<NoteImage[]>([]);
  const totalBytes = ref(0);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const status = ref('');
  let loadedNoteId: string | null = null;

  function apply(list: NoteImageList): void {
    images.value = list.images;
    totalBytes.value = list.totalBytes;
  }

  async function load(noteId: string): Promise<void> {
    if (loadedNoteId === noteId && images.value.length > 0) return;
    if (loadedNoteId !== noteId) {
      // 换手记时先清空，避免上一条的图片短暂出现在新记录下。
      images.value = [];
      totalBytes.value = 0;
      status.value = '';
      error.value = '';
    }
    loading.value = true;
    try {
      apply(unwrap(await api.loadImages(noteId)));
      loadedNoteId = noteId;
      error.value = '';
    } catch (caught) {
      error.value = message(caught);
    } finally {
      loading.value = false;
    }
  }

  async function run(
    noteId: string,
    action: () => Promise<Result<NoteImageList>>,
    done: string,
  ): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    status.value = '';
    error.value = '';
    try {
      apply(unwrap(await action()));
      loadedNoteId = noteId;
      status.value = done;
      return true;
    } catch (caught) {
      // 失败保留当前列表与输入；界面只提示原因，不伪装成功。
      error.value = message(caught);
      return false;
    } finally {
      busy.value = false;
    }
  }

  return {
    images,
    totalBytes,
    loading,
    busy,
    error,
    status,
    apply,
    load,
    addFromDialog: (noteId: string) =>
      run(noteId, () => api.addImagesFromDialog(noteId), '图片已添加'),
    addFromClipboard: (noteId: string, image: { bytes: Uint8Array; originalName: string }) =>
      run(noteId, () => api.addImageFromClipboard(noteId, image), '已粘贴图片'),
    rename: (noteId: string, imageId: string, displayName: string) =>
      run(noteId, () => api.renameImage(imageId, displayName), '名称已保存'),
    remove: (noteId: string, imageId: string) =>
      run(noteId, () => api.deleteImage(imageId), '图片已移出这张手记'),
    /** 供界面提示使用：显示名称缺失时按序号兜底。 */
    label: imageLabel,
  };
}
