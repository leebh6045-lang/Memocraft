import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import {
  imageLabel,
  type ImageOwner,
  type NoteImage,
  type NoteImageList,
} from '../../../domain/note-image';
import type { MemocraftApi } from '../../../shared/contracts';
import { AppError, type Result } from '../../../shared/errors';

/** 选图可能返回 null（用户取消），因此这里保留泛型：调用方自己判断空值。 */
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.value;
}

function message(error: unknown): string {
  return error instanceof AppError ? error.message : '图片操作未完成，请重试。';
}

/** 图集现场只需要这几个能力：按归属读取、添加、命名与移出。 */
export type ImageApi = Pick<
  MemocraftApi,
  'loadImages' | 'addImagesFromDialog' | 'addImageFromClipboard' | 'renameImage' | 'deleteImage'
>;

/** 归属在界面上的稳定身份：切换归属时用它判断是否需要重新读取。 */
function ownerKey(owner: ImageOwner): string {
  return `${owner.kind}:${owner.id}`;
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
  load: (owner: ImageOwner) => Promise<void>;
  addFromDialog: (owner: ImageOwner) => Promise<boolean>;
  addFromClipboard: (
    owner: ImageOwner,
    image: { bytes: Uint8Array; originalName: string },
  ) => Promise<boolean>;
  rename: (owner: ImageOwner, imageId: string, displayName: string) => Promise<boolean>;
  remove: (owner: ImageOwner, imageId: string) => Promise<boolean>;
  label: typeof imageLabel;
}

/**
 * 一处图集现场：已保存的手记与首页草稿共用同一套加载、添加、命名与删除，
 * 都以服务端返回的列表为准，不做本地乐观插入，避免保存失败时界面显示并不存在的图片。
 *
 * `onNoteImagesChanged` 在成功的增删改名之后调用，且只针对手记：
 * 图集不属于手记集合，列表缩略图的摘要缓存只能靠这里知道该重读哪条手记。
 */
export function useNoteImages(
  api: ImageApi,
  onNoteImagesChanged?: (noteId: string) => void,
): NoteImageState {
  const images = shallowRef<NoteImage[]>([]);
  const totalBytes = ref(0);
  const loading = ref(false);
  const busy = ref(false);
  const error = ref('');
  const status = ref('');
  let loadedKey: string | null = null;

  function apply(list: NoteImageList): void {
    images.value = list.images;
    totalBytes.value = list.totalBytes;
  }

  async function load(owner: ImageOwner): Promise<void> {
    const key = ownerKey(owner);
    if (loadedKey === key && images.value.length > 0) return;
    if (loadedKey !== key) {
      // 换归属时先清空，避免上一条手记的图片短暂出现在新记录下。
      images.value = [];
      totalBytes.value = 0;
      status.value = '';
      error.value = '';
    }
    loading.value = true;
    try {
      apply(unwrap(await api.loadImages(owner)));
      loadedKey = key;
      error.value = '';
    } catch (caught) {
      error.value = message(caught);
    } finally {
      loading.value = false;
    }
  }

  async function run(
    owner: ImageOwner,
    action: () => Promise<Result<NoteImageList | null>>,
    done: string,
  ): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    status.value = '';
    error.value = '';
    try {
      const list = unwrap(await action());
      // null 表示用户取消了选图：什么都没有发生，既不提示成功也不改图集。
      if (!list) return true;
      apply(list);
      loadedKey = ownerKey(owner);
      status.value = done;
      // 图集已变：手记的列表缩略图要重读这条手记的摘要；草稿没有列表缩略图。
      if (owner.kind === 'note') onNoteImagesChanged?.(owner.id);
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
    addFromDialog: (owner: ImageOwner) =>
      run(owner, () => api.addImagesFromDialog(owner), '图片已添加'),
    addFromClipboard: (owner: ImageOwner, image: { bytes: Uint8Array; originalName: string }) =>
      run(owner, () => api.addImageFromClipboard(owner, image), '已粘贴图片'),
    rename: (owner: ImageOwner, imageId: string, displayName: string) =>
      run(owner, () => api.renameImage(imageId, displayName), '名称已保存'),
    remove: (owner: ImageOwner, imageId: string) =>
      run(owner, () => api.deleteImage(imageId), '图片已移出这张手记'),
    /** 供界面提示使用：显示名称缺失时按序号兜底。 */
    label: imageLabel,
  };
}
