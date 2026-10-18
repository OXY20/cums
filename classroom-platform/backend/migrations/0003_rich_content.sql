-- 富媒体正文
--
-- 背景：原先课时正文由若干「块」组成（文字块 + 图片块 + 视频块），
-- 无法在文字中间插入图片、无法设置字号与颜色、无法插入链接，
-- 与论坛式富文本编辑器的使用习惯差距较大。
--
-- 改为保存清洗后的 HTML 正文：教师用富文本编辑器排版，
-- 服务端按白名单清洗后入库，学生端直接渲染。
--
-- lesson_blocks 表保留但不再作为主编辑方式，
-- 以兼容已产生的数据（可后续通过一次性脚本转换为 HTML）。

ALTER TABLE lessons ADD COLUMN content_html TEXT NOT NULL DEFAULT '';

-- 记录正文最后编辑方式，便于识别哪些课时仍是旧版块结构。
ALTER TABLE lessons ADD COLUMN content_format TEXT NOT NULL DEFAULT 'blocks'
    CHECK (content_format IN ('blocks', 'html'));
