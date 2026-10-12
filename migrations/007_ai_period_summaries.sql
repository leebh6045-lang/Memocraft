-- 周期总结缓存随整库备份和恢复；不存密钥或只用于当次展示的图片回执。
-- 结束日期由自然周期起点推算，不重复落库，避免缓存键与日期范围不一致。
CREATE TABLE ai_period_summaries (
  period_type TEXT NOT NULL CHECK (period_type IN ('week', 'month')),
  start_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  suggestions TEXT NOT NULL CHECK (json_valid(suggestions)),
  note_count INTEGER NOT NULL CHECK (note_count >= 0),
  generated_at TEXT NOT NULL,
  PRIMARY KEY (period_type, start_date)
) STRICT;
