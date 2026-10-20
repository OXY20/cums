-- 作业提交：学生端在课程/课时页面直接上传作业文件。
--
-- 设计要点：
-- 1. 提交是「一次提交 = 多条文件」，文件本体仍存放在 resources 表，
--    通过 homework_submission_files 关联，复用既有的 SHA-256 校验与 /files 下载能力；
-- 2. 服务端记录客户端 IP 与 User-Agent，供教师后台核对；
-- 3. 同一课时 + 同一班级已有提交时，新提交置 duplicate_flag = 1 并记录被重复的提交，
--    前端据此提醒学生，后台据此筛选可疑提交。

CREATE TABLE IF NOT EXISTS homework_submissions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id      INTEGER NOT NULL REFERENCES courses(id)  ON DELETE CASCADE,
    lesson_id      INTEGER NOT NULL REFERENCES lessons(id)  ON DELETE CASCADE,
    -- 班级可为空：未发布课堂时学生可能无法确定班级
    class_id       INTEGER REFERENCES classes(id) ON DELETE SET NULL,
    session_id     INTEGER REFERENCES classroom_sessions(id) ON DELETE SET NULL,
    student_name   TEXT    NOT NULL,
    -- 服务端记录的来源信息，客户端不可伪造（不接收客户端提交的 IP）
    client_ip      TEXT    NOT NULL DEFAULT '',
    user_agent     TEXT    NOT NULL DEFAULT '',
    note           TEXT    NOT NULL DEFAULT '',
    -- 重复提交标记：0 正常，1 该课时该班级已有他人提交
    duplicate_flag INTEGER NOT NULL DEFAULT 0,
    duplicate_of   INTEGER REFERENCES homework_submissions(id) ON DELETE SET NULL,
    status         TEXT    NOT NULL DEFAULT 'submitted'
                           CHECK (status IN ('submitted', 'reviewed', 'flagged')),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_homework_lesson_class
    ON homework_submissions(lesson_id, class_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_homework_created
    ON homework_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_homework_duplicate
    ON homework_submissions(duplicate_flag, created_at DESC);

CREATE TABLE IF NOT EXISTS homework_submission_files (
    submission_id INTEGER NOT NULL REFERENCES homework_submissions(id) ON DELETE CASCADE,
    resource_id   INTEGER NOT NULL REFERENCES resources(id)           ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (submission_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_homework_files_submission
    ON homework_submission_files(submission_id, sort_order);
