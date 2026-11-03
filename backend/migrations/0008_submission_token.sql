-- 作业提交加固：访问凭证、撤回与提交总量。
--
-- 设计要点：
-- 1. 学生端没有账号，公开回读接口原本只按自增 ID 取详情，任何一串递增的数字
--    都能读到别人的提交人姓名、来源 IP 与文件清单。引入 access_token
--    （服务端生成的随机串）后，回读与撤回都必须同时提供该凭证，枚举失去意义。
-- 2. 撤回是软删除：记录保留，教师仍能看到「谁交过又撤回了」；
--    但文件资源同时降级为 staging，不再对外提供下载。
-- 3. total_bytes 冗余存一次提交的合计字节数，列表页与总量校验不必再聚合子表。
-- 4. 旧记录的 access_token 为空串，其回读与撤回一律拒绝——
--    这些记录本来就产生于没有凭证机制的版本，补发凭证没有意义。

ALTER TABLE homework_submissions ADD COLUMN access_token TEXT NOT NULL DEFAULT '';

ALTER TABLE homework_submissions ADD COLUMN withdrawn_at TEXT;

ALTER TABLE homework_submissions ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;

-- 回读与撤回都按「ID + 凭证」命中，索引让这条查询保持常数级
CREATE INDEX IF NOT EXISTS idx_homework_access_token
    ON homework_submissions(access_token);

-- 列表与统计默认排除已撤回记录，因此需要能快速过滤
CREATE INDEX IF NOT EXISTS idx_homework_withdrawn
    ON homework_submissions(withdrawn_at);
