-- 地址与模型随知识库备份恢复；已有配置升级后继续使用官方，不改密钥或手记。
ALTER TABLE ai_settings ADD COLUMN base_url TEXT NOT NULL DEFAULT 'https://api.deepseek.com'
  CHECK (length(base_url) BETWEEN 1 AND 2048);
