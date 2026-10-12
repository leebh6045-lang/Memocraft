export type ErrorCode =
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'STORAGE'
  | 'UNAVAILABLE'
  | 'AI_NOT_CONFIGURED'
  | 'AI_CREDENTIAL'
  | 'AI_AUTH'
  | 'AI_BALANCE'
  | 'AI_RATE_LIMIT'
  | 'AI_NETWORK'
  | 'AI_TIMEOUT'
  | 'AI_CANCELLED'
  | 'AI_RESPONSE';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export type Result<T> =
  { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } };

// 已知业务错误保留可操作提示；未知异常不把底层路径或 SQL 暴露给界面。
export function failure(error: unknown): Result<never> {
  if (error instanceof AppError)
    return { ok: false, error: { code: error.code, message: error.message } };
  return {
    ok: false,
    error: { code: 'STORAGE', message: '本地数据操作未完成，内容仍保留在编辑区。请重试。' },
  };
}
