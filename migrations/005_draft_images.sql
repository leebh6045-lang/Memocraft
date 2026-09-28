-- 草稿附图：手记保存之前，图片先归属首页草稿；保存手记时在同一事务里转成这条手记的图片。
--
-- 为什么重建表：原来 note_id 是 NOT NULL（图片必须先有手记），现在要放宽成
-- 「note_id 与 draft_id 恰有其一」，SQLite 不支持直接修改列约束。
-- 迁移在事务内执行，失败时保留迁移前的表。

CREATE TABLE note_images_next (
  id TEXT PRIMARY KEY NOT NULL,
  note_id TEXT REFERENCES notes(id),
  -- 指向草稿槽位里的稳定 ID；保存手记时先转成 note_id，再删除草稿行。
  draft_id TEXT REFERENCES note_drafts(id),
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
  -- 恰有其一：既不属于手记也不属于草稿的图片不存在。
  CHECK ((note_id IS NULL) <> (draft_id IS NULL)),
  -- 序号在各自的归属里唯一；SQLite 的 UNIQUE 把 NULL 视为互不相同，
  -- 因此两个约束分别管住手记图片与草稿图片，互不干扰。
  UNIQUE (note_id, position),
  UNIQUE (draft_id, position)
) STRICT;

INSERT INTO note_images_next
  (id, note_id, draft_id, relative_path, mime_type, byte_size, width, height, display_name, original_name, position, created_at, deleted_at)
SELECT
  id, note_id, NULL, relative_path, mime_type, byte_size, width, height, display_name, original_name, position, created_at, deleted_at
FROM note_images;

DROP TABLE note_images;

ALTER TABLE note_images_next RENAME TO note_images;

CREATE INDEX note_images_note_id ON note_images(note_id);
CREATE INDEX note_images_draft_id ON note_images(draft_id);
