import {
  AI_MODELS,
  AI_ASK_INPUT_LIMIT,
  AI_ASK_MIN_QUESTION_LENGTH,
  type AiAskInput,
  AI_SUGGESTION_INPUT_LIMIT,
  type AiModel,
  type AiSuggestionInput,
  type AiPeriodSummaryInput,
  type StoredAiPeriodSummary,
  type AiPeriodType,
  type PeriodNotesQuery,
  AI_PERIOD_MAX_SUGGESTIONS,
  AI_PERIOD_SUMMARY_LIMIT,
  AI_PERIOD_SUGGESTION_MAX_LENGTH,
} from '../shared/ai';
import { isLocalDate, isFuture, localToday, periodRange } from '../domain/time-range';
import { NOTE_MAX_TAGS, NOTE_TAG_MAX_LENGTH } from '../domain/note';
import { MAX_NOTE_IMAGE_COUNT } from '../domain/note-image';
import { AppError } from '../shared/errors';
import { normalizeAiBaseUrl } from '../domain/ai-endpoint';

/** IPC 与数据库返回均须确认模型在当前白名单内，不能传任意供应商模型。 */
export function validateAiModel(value: unknown): AiModel {
  const model = AI_MODELS.find((item) => item.value === value);
  if (!model) throw new AppError('VALIDATION', '请选择受支持的 DeepSeek 模型。');
  return model.value;
}

/** 地址只描述服务根路径；兼容粘贴完整接口，拒绝把凭据或查询秘密写进配置。 */
export function validateAiBaseUrl(value: unknown): string {
  const baseUrl = normalizeAiBaseUrl(value);
  if (!baseUrl)
    throw new AppError(
      'VALIDATION',
      '请填写有效的 HTTP 或 HTTPS API 地址，不要包含账号、密码、查询参数或片段。',
    );
  return baseUrl;
}

export function validateAiKey(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', '请填写有效的 API Key。');
  const key = value.trim();
  // 拒绝内部空白与超长输入，避免非法 Authorization 头；不假设厂商前缀。
  if (!key || key.length > 512 || /\s/.test(key))
    throw new AppError('VALIDATION', 'API Key 不能为空、包含空白或超过 512 个字符。');
  return key;
}

export function validateAiRequestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new AppError('VALIDATION', 'AI 请求标识无效，请重新操作。');
  return value;
}

/** 主进程仍验证实际载荷；正文截取由调用方完成，不能依赖页面禁用按钮。 */
export function validateAiSuggestionInput(value: unknown): AiSuggestionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new AppError('VALIDATION', 'AI 建议输入格式不正确，请重新生成。');
  if (
    !('requestId' in value) ||
    !('body' in value) ||
    !('title' in value) ||
    !('existingTags' in value) ||
    !('imageIds' in value) ||
    !('draftId' in value)
  )
    throw new AppError('VALIDATION', 'AI 建议输入不完整，请重新生成。');
  const requestId = validateAiRequestId(value.requestId);
  const draftId = validateAiRequestId(value.draftId);
  if (!Array.isArray(value.imageIds) || value.imageIds.length > MAX_NOTE_IMAGE_COUNT)
    throw new AppError('VALIDATION', 'AI 建议图片列表格式不正确，最多 50 张。');
  const imageIds = [...new Set(value.imageIds.map(validateAiRequestId))];
  if (
    typeof value.body !== 'string' ||
    !value.body.trim() ||
    value.body.length > AI_SUGGESTION_INPUT_LIMIT
  )
    throw new AppError('VALIDATION', '请填写非空正文，AI 建议输入最多 4000 个字符。');
  if (typeof value.title !== 'string' || value.title.length > 300)
    throw new AppError('VALIDATION', '标题须为文本，且不能超过 300 个字符。');
  if (!Array.isArray(value.existingTags) || value.existingTags.length > NOTE_MAX_TAGS)
    throw new AppError('VALIDATION', '草稿标签格式不正确，最多 100 个标签。');
  const existingTags: string[] = [];
  for (const tag of value.existingTags) {
    if (typeof tag !== 'string' || !tag.trim() || tag.length > NOTE_TAG_MAX_LENGTH)
      throw new AppError('VALIDATION', '草稿标签须包含 1 至 100 个字符。');
    existingTags.push(tag.trim());
  }
  return {
    requestId,
    body: value.body,
    title: value.title,
    existingTags: [...new Set(existingTags)],
    draftId,
    imageIds,
  };
}

/** 检索和网络共用问句上限；低于门槛的请求拒绝，不能靠界面保护计费入口。 */
export function validateAiAskInput(value: unknown): AiAskInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('requestId' in value) ||
    !('question' in value)
  )
    throw new AppError('VALIDATION', 'AI 问答输入不完整，请重新搜索。');
  const requestId = validateAiRequestId(value.requestId);
  if (
    typeof value.question !== 'string' ||
    value.question.length > AI_ASK_INPUT_LIMIT ||
    value.question.trim().length < AI_ASK_MIN_QUESTION_LENGTH
  )
    throw new AppError('VALIDATION', 'AI 问答需输入 4 至 200 个字符。');
  return { requestId, question: value.question.trim() };
}

/** 周期起点归一化后再判未来；结束日期始终由本地日历规则推算。 */
export function validateAiPeriodSummaryInput(
  value: unknown,
  now = new Date(),
): AiPeriodSummaryInput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('requestId' in value) ||
    !('periodType' in value) ||
    !('startDate' in value) ||
    !('regenerate' in value) ||
    (value.periodType !== 'week' && value.periodType !== 'month') ||
    !isLocalDate(value.startDate) ||
    typeof value.regenerate !== 'boolean'
  )
    throw new AppError('VALIDATION', '回顾的周期输入无效，请重新选择。');
  const requestId = validateAiRequestId(value.requestId);
  // 接受周期内的合法锚点，并在返回值中改写为起点，保证查询范围与缓存键一致。
  const { startDate } = periodRange(value.periodType, value.startDate);
  if (isFuture(startDate, localToday(now)))
    throw new AppError('VALIDATION', '还不能回顾未来的时间段。');
  return { requestId, periodType: value.periodType, startDate, regenerate: value.regenerate };
}

/** 内部存储边界也校验 UTC 语义，日期字符串不能冒充查询时间戳。 */
export function validatePeriodNotesQuery(value: unknown): PeriodNotesQuery {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('startAt' in value) ||
    !('endBefore' in value) ||
    !('staleBefore' in value) ||
    !isUtcTimestamp(value.startAt) ||
    !isUtcTimestamp(value.endBefore) ||
    !isUtcTimestamp(value.staleBefore) ||
    value.endBefore <= value.startAt
  )
    throw new AppError('VALIDATION', '回顾的查询时间范围无效。');
  return { startAt: value.startAt, endBefore: value.endBefore, staleBefore: value.staleBefore };
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function validatePeriodSummaryKey(value: unknown): {
  periodType: AiPeriodType;
  startDate: string;
} {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('periodType' in value) ||
    !('startDate' in value) ||
    (value.periodType !== 'week' && value.periodType !== 'month') ||
    !isLocalDate(value.startDate) ||
    periodRange(value.periodType, value.startDate).startDate !== value.startDate
  )
    throw new AppError('VALIDATION', '回顾缓存的周期无效。');
  return { periodType: value.periodType, startDate: value.startDate };
}

/** 写入只接受完整缓存字段，瞬时图片回执不会形成另一份持久化状态。 */
export function validateStoredPeriodSummary(value: unknown): StoredAiPeriodSummary {
  const key = validatePeriodSummaryKey(value);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('summary' in value) ||
    !('suggestions' in value) ||
    !('endDate' in value) ||
    !('noteCount' in value) ||
    !('generatedAt' in value) ||
    value.endDate !== periodRange(key.periodType, key.startDate).endDate ||
    typeof value.summary !== 'string' ||
    !value.summary.trim() ||
    value.summary.length > AI_PERIOD_SUMMARY_LIMIT + 1 ||
    !Array.isArray(value.suggestions) ||
    value.suggestions.length > AI_PERIOD_MAX_SUGGESTIONS ||
    typeof value.noteCount !== 'number' ||
    !Number.isSafeInteger(value.noteCount) ||
    value.noteCount <= 0 ||
    !isUtcTimestamp(value.generatedAt)
  )
    throw new AppError('VALIDATION', '回顾缓存内容无效，原结果未被替换。');
  const suggestions: string[] = [];
  for (const item of value.suggestions) {
    if (typeof item !== 'string' || !item.trim() || item.length > AI_PERIOD_SUGGESTION_MAX_LENGTH)
      throw new AppError('VALIDATION', '回顾建议内容无效，原结果未被替换。');
    suggestions.push(item);
  }
  return {
    ...key,
    endDate: value.endDate,
    summary: value.summary,
    suggestions,
    noteCount: value.noteCount,
    generatedAt: value.generatedAt,
  };
}
