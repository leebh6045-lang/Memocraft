import type { DatabaseSync } from 'node:sqlite';
import { AI_MODELS, type AiConfiguration, type AiModel } from '../shared/ai';
import { AppError } from '../shared/errors';
import { normalizeAiBaseUrl } from '../domain/ai-endpoint';

/** 与知识库共用唯一连接；密钥从不进入这张配置表。 */
export class AiSettingsStore {
  constructor(private readonly database: DatabaseSync) {}

  load(): AiConfiguration {
    const row = this.database
      .prepare('SELECT provider, model, base_url FROM ai_settings WHERE id = 1')
      .get();
    const model = AI_MODELS.find((item) => item.value === row?.model);
    if (row?.provider !== 'deepseek' || !model)
      throw new AppError('STORAGE', 'AI 模型配置无法读取，请检查数据完整性。');
    const baseUrl = normalizeAiBaseUrl(row.base_url);
    if (!baseUrl || baseUrl !== row.base_url)
      throw new AppError('STORAGE', 'AI 服务地址无法读取，请检查数据完整性。');
    return { provider: 'deepseek', model: model.value, baseUrl };
  }

  saveModel(model: AiModel): AiConfiguration {
    const result = this.database
      .prepare('UPDATE ai_settings SET model = ? WHERE id = 1')
      .run(model);
    if (result.changes !== 1) throw new AppError('STORAGE', 'AI 模型配置未保存，请重试。');
    return this.load();
  }

  saveBaseUrl(value: string): AiConfiguration {
    const baseUrl = normalizeAiBaseUrl(value);
    if (!baseUrl) throw new AppError('VALIDATION', '请填写有效的 HTTP 或 HTTPS API 地址。');
    const result = this.database
      .prepare('UPDATE ai_settings SET base_url = ? WHERE id = 1')
      .run(baseUrl);
    if (result.changes !== 1) throw new AppError('STORAGE', 'AI 服务地址未保存，请重试。');
    return this.load();
  }
}
