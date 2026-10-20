-- 作业审阅：教师对每份提交给出评价标签、分数与评语。
--
-- 设计要点：
-- 1. 标签与流程状态分离。`status` 表达「这份提交老师看过没有」，
--    `review_label` 表达「作业质量如何」。两者独立，
--    因为存在「看过了但只打了分没打标签」和「打了不通过但需要单独标记问题」的情形。
-- 2. 标签固定四类：好 / 通过 / 不通过 / 其他。用空字符串表示「尚未评价」，
--    这样 SQL 侧不需要处理 NULL 与空值的两种写法。
-- 3. 分数允许为空：多数教师只打标签不打分，强制填分会让人随手填个 0。
--    取值范围 0–100 由服务端校验，数据库侧不设 CHECK，
--    以免后续需要支持百分制之外的评分方式时要改表结构。
-- 4. 审阅信息全部可为空，旧记录迁移后即「未审阅」，语义正确。

ALTER TABLE homework_submissions ADD COLUMN review_label TEXT NOT NULL DEFAULT '';

ALTER TABLE homework_submissions ADD COLUMN review_score REAL;

ALTER TABLE homework_submissions ADD COLUMN review_comment TEXT NOT NULL DEFAULT '';

-- 最近一次审阅时间；清空审阅时一并置空
ALTER TABLE homework_submissions ADD COLUMN reviewed_at TEXT;

-- 审阅人；账号被删除后保留历史记录，因此不加外键约束
ALTER TABLE homework_submissions ADD COLUMN reviewed_by INTEGER;

-- 按课时 + 标签筛选（「只看未审」「只看不通过」是教师最高频的两个筛选）
CREATE INDEX IF NOT EXISTS idx_homework_review
    ON homework_submissions(lesson_id, review_label);
