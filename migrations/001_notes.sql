CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body, char(9) || char(10) || char(13) || ' ')) > 0),
  title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'insight' CHECK (category IN ('insight', 'todo', 'done', 'misc')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX notes_created_at ON notes(created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE note_drafts (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE note_tags (
  note_id TEXT NOT NULL REFERENCES notes(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (note_id, tag_id),
  UNIQUE (note_id, position)
) STRICT;

CREATE INDEX note_tags_tag_id ON note_tags(tag_id);
