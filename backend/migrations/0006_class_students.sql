-- 班级学生名单：教师导入学号与姓名，用于判断作业「谁没交」。
--
-- 设计要点：
-- 1. 名单按**班级**维护而不是按课程：课程是模板，同一门课会被多个班级使用，
--    「谁该交」取决于具体班级，因此名单挂在 classes 上。
-- 2. 学号在同一班级内唯一，作为学生的稳定标识；姓名只用于显示。
--    重名在学生名单里很常见，靠学号才能准确判断是否已交。
-- 3. 删除班级时名单一并清理（ON DELETE CASCADE），避免残留孤儿数据。
CREATE TABLE IF NOT EXISTS class_students (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    class_id     INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_no   TEXT    NOT NULL,
    student_name TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 同一班级内学号唯一：重复导入同一条时更新姓名而不是产生两条
CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_student_no
    ON class_students(class_id, student_no);

CREATE INDEX IF NOT EXISTS idx_class_students_class
    ON class_students(class_id);

-- 提交记录补充学号。
--
-- 允许为空字符串：一是兼容既有历史记录（当时没有名单概念），
-- 二是学生没在名单里时仍可提交（老师可能临时加人）。
-- 未交名单的判定会先按学号匹配，学号为空时退回姓名匹配。
ALTER TABLE homework_submissions ADD COLUMN student_no TEXT NOT NULL DEFAULT '';

-- 按学号聚合提交情况时用到
CREATE INDEX IF NOT EXISTS idx_homework_lesson_student_no
    ON homework_submissions(lesson_id, student_no);
