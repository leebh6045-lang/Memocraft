import type { Result } from './errors';
import type { NoteCategory } from '../domain/note';

/** 显示名称与官方请求标识分开；首版仅接受这两个模型。
 * 官方模型与价格（2026-10-10 核验）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 */
export const AI_MODELS = [
  { value: 'deepseek-flash', label: 'DeepSeek V4.1 Flash', supportsImages: true },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', supportsImages: false },
] as const;
export type AiModel = (typeof AI_MODELS)[number]['value'];
export const DEFAULT_AI_MODEL: AiModel = 'deepseek-flash';
export const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';

/** 视觉能力随模型清单维护，建议与后续业务使用同一来源。 */
export function modelSupportsImages(model: AiModel): boolean {
  return AI_MODELS.some((item) => item.value === model && item.supportsImages);
}

export interface AiConfiguration {
  provider: 'deepseek';
  model: AiModel;
  /** 规范化的服务根地址，可含 /v1 等子路径；请求统一追加 /chat/completions。 */
  baseUrl: string;
}

/** 一次调用取得的完整快照；不在客户端共享可变地址，避免配置变化改投旧请求。 */
export interface AiCallContext {
  model: AiModel;
  apiKey: string;
  baseUrl: string;
}

/** 状态不包含密钥；已配置只表示本机已有凭据，能否生成由连接测试确认。 */
export interface AiSettings extends AiConfiguration {
  keyConfigured: boolean;
  encryptionAvailable: boolean;
}

export interface AiConnectionTest {
  model: AiModel;
  checkedAt: string;
  elapsedMs: number;
}

/** 建议只提示，采纳动作由用户触发；归纳标题始终来自本地候选。 */
export interface AiSuggestedTopic {
  id: string;
  title: string;
}

export interface AiSuggestion {
  tags: string[];
  topics: AiSuggestedTopic[];
  usedImages: number;
  skippedImages: number;
  imagesSupported: boolean;
}

export interface AiSuggestionInput {
  requestId: string;
  body: string;
  title: string;
  existingTags: string[];
  /** 仅传草稿身份与图片 ID，主进程验证归属后自行读取字节。 */
  draftId: string;
  imageIds: string[];
}

// 输入和 prompt 分别限长：跨进程最多 4000 字，实际只分析前 800 字。
export const AI_SUGGESTION_INPUT_LIMIT = 4_000;
export const AI_SUGGESTION_PROMPT_BODY_LIMIT = 800;
export const AI_SUGGESTION_TOPIC_LIMIT = 30;
export const AI_SUGGESTION_TAG_POOL_LIMIT = 40;
// 3–5 个、10 字是生成目标；以下是越界时整份拒绝的技术上限。
export const AI_SUGGESTION_MAX_TAGS = 8;
export const AI_SUGGESTION_MAX_TOPICS = 3;
export const AI_SUGGESTION_TAG_MAX_LENGTH = 30;

// 张数限制是实际纳入预算；输入包含完整图集，才能报告未参与数量。
export const AI_SUGGESTION_MAX_IMAGES = 4;
export const AI_SUGGESTION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const AI_SUGGESTION_IMAGE_TIMEOUT_MS = 60_000;

/** 图片只出现在 user 消息中，system/assistant 保持纯文字。 */
export type AiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };
export type AiMessage =
  | { role: 'system' | 'assistant'; content: string }
  | { role: 'user'; content: string | AiContentBlock[] };

/** 来源编号仅用于展示；真实 ID 和标题由主进程按本次候选回填。 */
export interface AiAnswerSource {
  index: number;
  noteId: string;
  title: string;
}

export interface AiAnswer {
  answer: string;
  sources: AiAnswerSource[];
  matchedNotes: number;
}

export interface AiAskInput {
  requestId: string;
  question: string;
}

// 问答按搜索现场触发，限制问题、检索与输出规模，避免每次输入放大全库上下文。
export const AI_ASK_MIN_QUESTION_LENGTH = 4;
export const AI_ASK_INPUT_LIMIT = 200;
export const AI_ASK_MAX_TERMS = 8;
export const AI_ASK_TERM_CANDIDATE_LIMIT = 20;
export const AI_ASK_CONTEXT_LIMIT = 8;
export const AI_ASK_EXCERPT_LIMIT = 300;
export const AI_ASK_ANSWER_LIMIT = 400;

export type AiPeriodType = 'week' | 'month';

/** 缓存的完整内容；时间、计数来自本地，结束日期在读出时按周期推算。 */
export interface StoredAiPeriodSummary {
  periodType: AiPeriodType;
  startDate: string;
  endDate: string;
  summary: string;
  /** 按总结顶层分点排列的本地手记引用；旧缓存无此字段，空组表示该点无可跳转手记。 */
  pointSources?: AiAnswerSource[][];
  suggestions: string[];
  noteCount: number;
  generatedAt: string;
}

/** 展示响应可在缓存内容上附加当次图片回执；缓存命中不携带这些字段。 */
export interface AiPeriodSummary extends StoredAiPeriodSummary {
  usedImages?: number;
  skippedImages?: number;
  imagesSupported?: boolean;
}

export interface AiPeriodSummaryInput {
  requestId: string;
  periodType: AiPeriodType;
  /** 允许周期内的合法锚点日期；主进程返回自然周期起点，并自行推算结束日期。 */
  startDate: string;
  regenerate: boolean;
}

export interface PeriodNote {
  id: string;
  title: string;
  category: NoteCategory;
  body: string;
  createdAt: string;
  firstImageId: string | null;
}

export interface PeriodNotesResult {
  notes: PeriodNote[];
  /** 未采样的本期有效手记数量，与 notes.length 一致；采样上限只约束模型输入。 */
  total: number;
  stats: {
    staleTodoCount: number;
    activeTopics: { id: string; title: string; noteCount: number }[];
  };
}

/** 查询采用 UTC 半开区间，待办龄期截至请求时刻，由主进程统一计算。 */
export interface PeriodNotesQuery {
  startAt: string;
  endBefore: string;
  staleBefore: string;
}

export const AI_PERIOD_CONTEXT_LIMIT = 20;
export const AI_PERIOD_CATEGORY_LIMIT = 5;
export const AI_PERIOD_EXCERPT_LIMIT = 200;
export const AI_PERIOD_SUMMARY_LIMIT = 600;
export const AI_PERIOD_MAX_POINTS = 6;
export const AI_PERIOD_MAX_SUGGESTIONS = 5;
export const AI_PERIOD_SUGGESTION_MAX_LENGTH = 200;
export const AI_PERIOD_MAX_IMAGES = 4;
export const AI_PERIOD_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface AiApi {
  loadSettings(): Promise<Result<AiSettings>>;
  saveModel(model: AiModel): Promise<Result<AiConfiguration>>;
  saveBaseUrl(baseUrl: string): Promise<Result<AiConfiguration>>;
  saveKey(key: string): Promise<Result<null>>;
  clearKey(): Promise<Result<null>>;
  testConnection(requestId: string): Promise<Result<AiConnectionTest>>;
  cancelTest(requestId: string): Promise<Result<null>>;
  suggest(input: AiSuggestionInput): Promise<Result<AiSuggestion>>;
  cancelSuggestion(requestId: string): Promise<Result<null>>;
  ask(input: AiAskInput): Promise<Result<AiAnswer>>;
  cancelAsk(requestId: string): Promise<Result<null>>;
  summarizePeriod(input: AiPeriodSummaryInput): Promise<Result<AiPeriodSummary>>;
  cancelPeriodSummary(requestId: string): Promise<Result<null>>;
}
