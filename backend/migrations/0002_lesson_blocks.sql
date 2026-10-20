-- 课时内容块与资源用途扩展
--
-- 背景：原先课时内容以扁平 JSON 字段（goal/intro/steps/...）保存，
-- 资源需先在资源库上传、再回课时编辑器关联，操作割裂。
-- 本迁移为「在课程管理内直接上传并内嵌」提供支撑：
--   1. courses 增加封面资源引用；
--   2. lesson_resources 增加用途字段，区分正文内嵌与附件；
--   3. lesson_blocks 保存可按顺序混排的正文块（文字/图片/视频）。

-- 课程封面：指向 resources 中的一张图片
ALTER TABLE courses ADD COLUMN cover_resource_id INTEGER
    REFERENCES resources(id) ON DELETE SET NULL;

-- 资源用途：content（正文内嵌）或 attachment（课时附件）
-- 已存在的关联默认视为附件，保持原有行为。
ALTER TABLE lesson_resources ADD COLUMN kind TEXT NOT NULL DEFAULT 'attachment'
    CHECK (kind IN ('content', 'attachment'));

CREATE INDEX IF NOT EXISTS idx_lesson_resources_kind
    ON lesson_resources(lesson_id, kind);

-- 课时正文块：支持文字与媒体按顺序混排
CREATE TABLE IF NOT EXISTS lesson_blocks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id   INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    block_type  TEXT    NOT NULL CHECK (block_type IN ('text', 'image', 'video', 'file')),
    -- 文字块使用 text_content；媒体块使用 resource_id
    text_content TEXT   NOT NULL DEFAULT '',
    title       TEXT    NOT NULL DEFAULT '',
    resource_id INTEGER REFERENCES resources(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lesson_blocks_lesson
    ON lesson_blocks(lesson_id, sort_order);
