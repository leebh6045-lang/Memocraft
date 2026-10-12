-- 模型是知识库内的普通配置；机器绑定的加密密钥只存于独立凭据目录。
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL CHECK (provider = 'deepseek'),
  model TEXT NOT NULL CHECK (model IN ('deepseek-flash', 'deepseek-v4-pro'))
) STRICT;

INSERT INTO ai_settings (id, provider, model) VALUES (1, 'deepseek', 'deepseek-flash');
