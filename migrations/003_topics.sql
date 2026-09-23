-- 知识归纳：平级集合，一条手记可被多个归纳收录。
-- 归纳只做「主题集合」，不承担排序与层级，因此不存 position，也不建父子字段。

CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX topics_updated_at ON topics(updated_at DESC, id DESC) WHERE deleted_at IS NULL;

-- 收录关系用复合主键表达：同一配对只留一行，重复收录由约束挡住，不靠业务层先查后写。
-- 外键指向实体表；软删除与它不冲突（删除是标记时间，行仍在），因此不需要 ON DELETE 级联。
CREATE TABLE note_topics (
  note_id TEXT NOT NULL REFERENCES notes(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (note_id, topic_id)
) STRICT;

CREATE INDEX note_topics_topic_id ON note_topics(topic_id);
