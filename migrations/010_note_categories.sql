-- 新增思绪（thought）；其他沿用 misc，不改写旧分类、时间或关系。
-- SQLite 无法直接放宽 CHECK，父表替换由迁移管理器在事务内执行并核对全部外键。
CREATE TABLE notes_next (
  id TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body, char(9) || char(10) || char(13) || ' ')) > 0),
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'insight' CHECK (category IN ('insight', 'thought', 'todo', 'done', 'misc')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

INSERT INTO notes_next (id, body, title, category, revision, created_at, updated_at, deleted_at)
SELECT id, body, title, category, revision, created_at, updated_at, deleted_at FROM notes;

DROP TABLE notes;
ALTER TABLE notes_next RENAME TO notes;

CREATE INDEX notes_created_at ON notes(created_at DESC, id DESC) WHERE deleted_at IS NULL;
