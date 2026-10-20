-- 设备识别：用于判断「这台机器是否已经交过本节课作业」。
--
-- 机房场景下多台机器共用同一出口 IP 的情况不存在（每台机器独立 IP），
-- 但同一台机器可能被多名学生轮流使用。记录前端生成的设备标识后，
-- 学生端可以在打开上传窗口时直接提示「当前设备已提交过」，
-- 而不必把「班里谁最早交」这种教师视角的信息暴露给学生。
--
-- 该列允许为空：早期的提交记录没有设备标识，按 IP 退化识别。
ALTER TABLE homework_submissions ADD COLUMN device_id TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_homework_device
    ON homework_submissions(lesson_id, client_ip, device_id);
