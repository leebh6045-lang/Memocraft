-- NULL 保留旧缓存语义；引用与总结一同替换，不给既有总结猜造手记关系。
ALTER TABLE ai_period_summaries
  ADD COLUMN point_sources TEXT CHECK (point_sources IS NULL OR json_valid(point_sources));
