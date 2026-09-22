import { protocol, type Session } from 'electron';
import { IMAGE_PROTOCOL, type ImageBytes } from '../shared/contracts';
import type { StoreClient } from './store-client';

/**
 * 自定义协议在应用就绪前注册：standard 让 URL 具备正常来源语义，
 * secure 使它不被当作不安全内容拦截。必须在 app.whenReady 之前调用。
 */
export function registerImageScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMAGE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 处理 memocraft-image://image/<id>。
 * URL 只携带图片 ID，路径与文件是否存在都由存储层校验，渲染端无法读取任意文件。
 * 协议只注册在本窗口所属会话上，且不按来源做白名单——开发模式界面来自 http://localhost，
 * 打包后来自 file://，按来源限定会误伤开发环境；访问控制由下面的 ID 校验承担。
 */
export function serveImageProtocol(session: Session, store: StoreClient): void {
  session.protocol.handle(IMAGE_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'image') return new Response(null, { status: 404 });
    const imageId = url.pathname.replace(/^\/+/, '');
    if (!UUID.test(imageId)) return new Response(null, { status: 400 });
    const result = await store.request({ operation: 'readImage', payload: imageId });
    if (!result.ok) return new Response(null, { status: 404 });
    const payload = result.value as ImageBytes | null;
    if (!payload) return new Response(null, { status: 404 });
    return new Response(payload.bytes as unknown as BodyInit, {
      headers: {
        'content-type': payload.mimeType,
        // 图片内容不可变（ID 对应一次写入），可长期缓存。
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      },
    });
  });
}
