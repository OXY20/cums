-- 机房教学资源平台 - 初始数据库结构
-- 依据《机房教学资源平台建设方案》第六章「数据库设计」实现。
-- 设计原则：课程模板与授课场次分离；资源与课时多对多；资源路径由服务端生成。

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 用户与权限
-- ---------------------------------------------------------------------------

-- 管理员与教师账号
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('admin', 'teacher')),
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 班级与机房
CREATE TABLE IF NOT EXISTS classes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    room_name  TEXT    NOT NULL DEFAULT '',
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 教师授课班级授权
CREATE TABLE IF NOT EXISTS teacher_classes (
    teacher_id INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (teacher_id, class_id)
);

-- ---------------------------------------------------------------------------
-- 课程与课时（可复用模板）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS courses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    cover_key   TEXT,
    status      TEXT    NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'published', 'archived')),
    created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id    INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    title        TEXT    NOT NULL,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    content_json TEXT    NOT NULL DEFAULT '{}',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (course_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_lessons_course ON lessons(course_id, sort_order);

-- 课时内的结构化操作步骤
CREATE TABLE IF NOT EXISTS lesson_steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL DEFAULT '',
    content    TEXT    NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (lesson_id, sort_order)
);

CREATE INDEX IF NOT EXISTS idx_lesson_steps_lesson ON lesson_steps(lesson_id, sort_order);

-- ---------------------------------------------------------------------------
-- 资源库
-- ---------------------------------------------------------------------------

-- 资源元数据：不保存文件本体，只保存服务端生成的 storage_key
CREATE TABLE IF NOT EXISTS resources (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    storage_key TEXT    NOT NULL UNIQUE,
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    sha256      TEXT    NOT NULL,
    mime_type   TEXT    NOT NULL DEFAULT 'application/octet-stream',
    version     INTEGER NOT NULL DEFAULT 1,
    status      TEXT    NOT NULL DEFAULT 'ready'
                        CHECK (status IN ('staging', 'ready', 'missing', 'corrupt')),
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resources_sha256 ON resources(sha256);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);

-- 课时与资源多对多关联
CREATE TABLE IF NOT EXISTS lesson_resources (
    lesson_id   INTEGER NOT NULL REFERENCES lessons(id)   ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    purpose     TEXT    NOT NULL DEFAULT '',
    required    INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lesson_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_lesson_resources_lesson ON lesson_resources(lesson_id, sort_order);

-- 资源包与清单
CREATE TABLE IF NOT EXISTS resource_bundles (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    lesson_id     INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
    manifest_json TEXT    NOT NULL DEFAULT '[]',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 授课场次（一次真实课堂）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS classroom_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id          INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
    teacher_id        INTEGER NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
    lesson_id         INTEGER NOT NULL REFERENCES lessons(id) ON DELETE RESTRICT,
    status            TEXT    NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'paused', 'ended')),
    -- 课程内容快照：模板后续修改不影响历史课堂
    lesson_snapshot   TEXT    NOT NULL DEFAULT '{}',
    started_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    paused_at         TEXT,
    ended_at          TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 同一班级同一时间只允许一个活动课堂（由数据库约束保证，不依赖前端禁用）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_session_per_class
    ON classroom_sessions(class_id)
    WHERE status IN ('running', 'paused');

CREATE INDEX IF NOT EXISTS idx_sessions_class ON classroom_sessions(class_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_teacher ON classroom_sessions(teacher_id, started_at DESC);

-- 课堂事件记录（用于 SSE 补偿与审计）
CREATE TABLE IF NOT EXISTS session_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER REFERENCES classroom_sessions(id) ON DELETE CASCADE,
    event_type   TEXT    NOT NULL,
    payload_json TEXT    NOT NULL DEFAULT '{}',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, id);

-- ---------------------------------------------------------------------------
-- 下载汇总（只记录必要事件，不写高频进度）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS download_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER REFERENCES classroom_sessions(id) ON DELETE SET NULL,
    client_id   TEXT    NOT NULL,
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'downloading', 'completed', 'failed')),
    bytes_sent  INTEGER NOT NULL DEFAULT 0,
    started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_download_jobs_resource ON download_jobs(resource_id, status);

-- ---------------------------------------------------------------------------
-- 审计日志
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT    NOT NULL,
    target_type TEXT    NOT NULL DEFAULT '',
    target_id   TEXT    NOT NULL DEFAULT '',
    detail_json TEXT    NOT NULL DEFAULT '{}',
    client_ip   TEXT    NOT NULL DEFAULT '',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id, created_at DESC);
