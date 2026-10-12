import { DEFAULT_AI_BASE_URL } from '../shared/ai';

/** 地址只描述服务根路径；纯规则供主进程、存储与界面共同校验，不读取运行环境。 */
export function normalizeAiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  if (!address) return DEFAULT_AI_BASE_URL;
  if (
    address.length > 2048 ||
    !/^https?:\/\//i.test(address) ||
    /[\s\\?#]/u.test(address) ||
    [...address].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    return null;
  // 兼容粘贴完整接口，不重复拼接 /chat/completions，保留 /v1 等子路径。
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const baseUrl = url.toString().replace(/\/+$/, '');
  // Unicode 路径编码后会变长，最终入库值也须满足同一长度上限。
  return baseUrl.length <= 2048 ? baseUrl : null;
}
