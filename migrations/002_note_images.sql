-- V1.5：手记附图。图片是手记的独立图集，不进入 Markdown 正文。
-- relative_path 由 CHECK 限定在 attachments/ 之下且不含上跳，数据库本身拒绝逃逸路径。
CREATE TABLE note_images (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT NOT NULL REFERENCES notes(id),
  relative_path TEXT NOT NULL UNIQUE CHECK (
    relative_path LIKE 'attachments/%' AND relative_path NOT LIKE '%..%'
  ),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  display_name TEXT NOT NULL DEFAULT '',
  original_name TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (note_id, position)
) STRICT;

CREATE INDEX note_images_note_id ON note_images(note_id);
