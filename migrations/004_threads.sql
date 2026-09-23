-- 长期事务与动态：事务是一件事的经历与决策，动态是它的时间线。
-- 引用关系各存一份：entry_notes 表动态引用手记，thread_notes 表事务直接引用手记（参考资料，不必虚构动态）。

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL DEFAULT '',
  -- 当前概况由用户维护；动态只记录历史，不自动改写它。
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX threads_updated_at ON threads(updated_at DESC, id DESC) WHERE deleted_at IS NULL;

-- 动态必属于一个事务；发生时间可补录，排序与创建时间、ID 一起构成稳定顺序。
CREATE TABLE thread_entries (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  body TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX thread_entries_timeline
  ON thread_entries(thread_id, occurred_at DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE entry_notes (
  entry_id TEXT NOT NULL REFERENCES thread_entries(id),
  note_id TEXT NOT NULL REFERENCES notes(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (entry_id, note_id)
) STRICT;

CREATE INDEX entry_notes_note_id ON entry_notes(note_id);

CREATE TABLE thread_notes (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  note_id TEXT NOT NULL REFERENCES notes(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, note_id)
) STRICT;

CREATE INDEX thread_notes_note_id ON thread_notes(note_id);

-- 动态标签沿用 tags 表；同一配对唯一，位置与手记标签一致地顺序排列。
CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES thread_entries(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (entry_id, tag_id),
  UNIQUE (entry_id, position)
) STRICT;

CREATE INDEX entry_tags_tag_id ON entry_tags(tag_id);
