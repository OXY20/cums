//! API 请求与响应数据结构。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

/// 列表响应。
#[derive(Debug, Serialize)]
pub struct ListResponse<T> {
    pub items: Vec<T>,
    pub total: i64,
}

impl<T> ListResponse<T> {
    pub fn new(items: Vec<T>) -> Self {
        let total = items.len() as i64;
        Self { items, total }
    }
}

// ---------------------------------------------------------------------------
// 认证
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub user: UserInfo,
    /// 令牌有效期（秒）
    pub expires_in: i64,
}

#[derive(Debug, Serialize)]
pub struct UserInfo {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub role: String,
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub old_password: String,
    pub new_password: String,
}

// ---------------------------------------------------------------------------
// 课程
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct CourseRow {
    pub id: i64,
    pub title: String,
    pub description: String,
    pub cover_key: Option<String>,
    /// 封面图对应的资源 ID；为空表示未设置封面
    #[sqlx(default)]
    pub cover_resource_id: Option<i64>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    /// 课时数量（列表查询时附带）
    #[sqlx(default)]
    pub lesson_count: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateCourseRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub cover_key: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCourseRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub cover_key: Option<String>,
    pub cover_resource_id: Option<i64>,
    pub status: Option<String>,
}

// ---------------------------------------------------------------------------
// 课时
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonRow {
    pub id: i64,
    pub course_id: i64,
    pub title: String,
    pub sort_order: i64,
    pub content_json: String,
    /// 富文本正文（已清洗的 HTML）
    pub content_html: String,
    /// 正文格式：`html`（富文本）或 `blocks`（旧版块结构）
    pub content_format: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLessonRequest {
    pub title: String,
    #[serde(default)]
    pub content_json: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLessonRequest {
    pub title: Option<String>,
    pub content_json: Option<String>,
    /// 富文本正文；服务端会做白名单清洗后入库
    pub content_html: Option<String>,
    pub sort_order: Option<i64>,
}

/// 课时详情视图：附带图文块与关联资源，供编辑器一次加载。
#[derive(Debug, Serialize)]
pub struct LessonDetailView {
    #[serde(flatten)]
    pub lesson: LessonRow,
    pub blocks: Vec<LessonBlockRow>,
    pub resources: Vec<LessonResourceRow>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonStepRow {
    pub id: i64,
    pub lesson_id: i64,
    pub title: String,
    pub content: String,
    pub sort_order: i64,
}

// ---------------------------------------------------------------------------
// 资源
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ResourceRow {
    pub id: i64,
    pub name: String,
    pub storage_key: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub mime_type: String,
    pub version: i64,
    pub status: String,
    pub created_at: String,
}

/// 资源登记请求：先登记元数据，再上传文件。
#[derive(Debug, Deserialize)]
pub struct RegisterResourceRequest {
    pub name: String,
    pub size_bytes: i64,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RegisterResourceResponse {
    pub resource_id: i64,
    pub upload_token: String,
    pub storage_key: String,
}

/// 课时关联的资源，附带用途与排序信息。
///
/// `purpose` 决定前端如何呈现：`image` / `video` 内嵌展示，`attachment` 提供下载。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonResourceRow {
    pub id: i64,
    pub name: String,
    pub storage_key: String,
    pub size_bytes: i64,
    pub sha256: String,
    pub mime_type: String,
    pub version: i64,
    pub status: String,
    pub created_at: String,
    /// 用途：image / video / attachment
    pub purpose: String,
    pub required: i64,
    pub sort_order: i64,
}

/// 关联资源时的可选用途设置。
#[derive(Debug, Default, Deserialize)]
pub struct AttachResourceRequest {
    #[serde(default)]
    pub purpose: Option<String>,
}

// ---------------------------------------------------------------------------
// 课时正文块
// ---------------------------------------------------------------------------

/// 正文块：文字与媒体按 `sort_order` 混排。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LessonBlockRow {
    pub id: i64,
    pub lesson_id: i64,
    pub block_type: String,
    pub text_content: String,
    pub title: String,
    pub resource_id: Option<i64>,
    pub sort_order: i64,
    /// 关联资源的展示信息（媒体块使用）
    #[sqlx(default)]
    pub resource_name: Option<String>,
    #[sqlx(default)]
    pub resource_size: Option<i64>,
    #[sqlx(default)]
    pub resource_mime: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBlockRequest {
    /// `text` / `image` / `video` / `file`
    pub block_type: String,
    #[serde(default)]
    pub text_content: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub resource_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBlockRequest {
    pub text_content: Option<String>,
    pub title: Option<String>,
    pub resource_id: Option<i64>,
    pub sort_order: Option<i64>,
}

/// 批量重排正文块。
#[derive(Debug, Deserialize)]
pub struct ReorderBlocksRequest {
    /// 按目标顺序排列的块 ID
    pub block_ids: Vec<i64>,
}

// ---------------------------------------------------------------------------
// 班级与机房
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ClassRow {
    pub id: i64,
    pub name: String,
    pub room_name: String,
    pub is_active: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateClassRequest {
    pub name: String,
    #[serde(default)]
    pub room_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateClassRequest {
    pub name: Option<String>,
    pub room_name: Option<String>,
    pub is_active: Option<i64>,
}

// ---------------------------------------------------------------------------
// 课堂场次
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SessionRow {
    pub id: i64,
    pub class_id: i64,
    pub teacher_id: i64,
    pub lesson_id: i64,
    pub status: String,
    pub started_at: String,
    pub paused_at: Option<String>,
    pub ended_at: Option<String>,
}

/// 学生端当前课堂视图。
#[derive(Debug, Serialize)]
pub struct CurrentSessionView {
    pub session: SessionRow,
    pub class_name: String,
    pub teacher_name: String,
    pub course_title: String,
    pub lesson_title: String,
    /// 结构化文字字段（旧版块内容或快照中的 fields）
    pub lesson_content: serde_json::Value,
    /// 富文本正文（已清洗的 HTML），为空表示使用 lesson_content
    pub lesson_html: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub class_id: i64,
    pub lesson_id: i64,
}

// ---------------------------------------------------------------------------
// 作业提交
// ---------------------------------------------------------------------------

/// 一条作业提交记录。
///
/// `client_ip` 由服务端从连接信息或可信代理头解析，客户端无法指定。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubmissionRow {
    pub id: i64,
    pub course_id: i64,
    pub lesson_id: i64,
    /// 班级可为空：学生端未选择班级时只按课时归属
    pub class_id: Option<i64>,
    /// 关联的课堂场次；学生端直接访问课程页时可能为空
    pub session_id: Option<i64>,
    pub student_name: String,
    /// 学号；未导入名单或学生未提供时为空字符串
    #[sqlx(default)]
    pub student_no: String,
    pub client_ip: String,
    pub user_agent: String,
    /// 前端生成的设备标识；旧记录为空字符串
    #[sqlx(default)]
    pub device_id: String,
    pub note: String,
    /// 0 正常；1 表示该课时该班级已有其他人提交
    pub duplicate_flag: i64,
    /// 被重复的原始提交
    pub duplicate_of: Option<i64>,
    pub status: String,
    pub created_at: String,
    /// 冗余展示字段，列表查询时附带
    #[sqlx(default)]
    pub course_title: Option<String>,
    #[sqlx(default)]
    pub lesson_title: Option<String>,
    #[sqlx(default)]
    pub class_name: Option<String>,
    #[sqlx(default)]
    pub file_count: i64,
    /// 审阅标签：`''` 未评价 / `good` 好 / `pass` 通过 / `fail` 不通过 / `other` 其他
    #[sqlx(default)]
    pub review_label: String,
    /// 审阅分数 0–100；未打分为 `None`
    #[sqlx(default)]
    pub review_score: Option<f64>,
    /// 教师评语
    #[sqlx(default)]
    pub review_comment: String,
    /// 最近一次审阅时间；清空审阅后为 `None`
    #[sqlx(default)]
    pub reviewed_at: Option<String>,
}

/// 提交包含的单个文件，复用资源库的存储与校验能力。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct SubmissionFileRow {
    pub resource_id: i64,
    pub name: String,
    pub size_bytes: i64,
    pub mime_type: String,
    pub sha256: String,
    /// 用途：image / video / attachment，决定前端如何预览
    pub purpose: String,
    pub sort_order: i64,
}

/// 提交详情：记录本体 + 文件列表。
#[derive(Debug, Serialize)]
pub struct SubmissionDetailView {
    #[serde(flatten)]
    pub submission: SubmissionRow,
    pub files: Vec<SubmissionFileRow>,
    /// 被重复提交的提交人姓名，供前端提示
    pub duplicate_of_name: Option<String>,
}

/// 课时提交状态：学生端上传前先查询，用于提醒「本设备已提交过」。
///
/// 同时返回两个维度的信息：
/// - `device`：当前这台机器（按 IP + 浏览器标识识别）在本课时是否有提交，
///   这是提示学生「你已经交过了」的依据；
/// - `class_total`：本班已有多少人提交，仅作背景参考，不指名道姓。
#[derive(Debug, Serialize)]
pub struct LessonSubmissionStatus {
    pub lesson_id: i64,
    pub class_id: Option<i64>,
    /// 本班该课时提交总数（不区分设备）
    pub class_total: i64,
    /// 当前设备的提交情况；无提交时为 `None`
    pub device: Option<DeviceSubmission>,
}

/// 当前设备在本课时的提交记录摘要。
#[derive(Debug, Serialize)]
pub struct DeviceSubmission {
    /// 该设备已提交的记录数
    pub total: i64,
    /// 该设备最近一次提交
    pub latest: SubmissionRow,
}

/// 提交成功后的响应，携带重复提醒。
#[derive(Debug, Serialize)]
pub struct CreateSubmissionResponse {
    pub submission: SubmissionDetailView,
    /// 本次提交被标记为重复时给出原因
    pub duplicate_warning: Option<String>,
}

// ---------------------------------------------------------------------------
// 学生名单与作业统计
// ---------------------------------------------------------------------------

/// 班级学生名单中的一条记录。
#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ClassStudent {
    pub id: i64,
    pub class_id: i64,
    pub student_no: String,
    pub student_name: String,
    pub created_at: String,
}

/// 名单导入结果。
///
/// 教师粘贴一批名单后需要知道「哪些进了、哪些被跳过、哪些格式不对」，
/// 因此逐项统计而不是只返回成功条数。
#[derive(Debug, Serialize)]
pub struct ImportStudentsResult {
    /// 新增条数
    pub inserted: i64,
    /// 学号已存在、仅更新姓名的条数
    pub updated: i64,
    /// 解析失败的行（缺少学号或姓名）
    pub invalid: Vec<InvalidStudentRow>,
    /// 导入后该班级名单总人数
    pub total: i64,
}

/// 解析失败的名单行。
#[derive(Debug, Serialize)]
pub struct InvalidStudentRow {
    /// 原文行号（从 1 开始，方便教师对照）
    pub line: usize,
    /// 原始内容
    pub raw: String,
    /// 失败原因
    pub reason: String,
}

/// 课程作业总览：按课时汇总提交情况。
#[derive(Debug, Serialize)]
pub struct CourseHomeworkOverview {
    pub course_id: i64,
    pub course_title: String,
    /// 统计所选班级；未指定时为空，表示跨班汇总
    pub class_id: Option<i64>,
    pub class_name: Option<String>,
    /// 该班级名单人数；未指定班级时为 0
    pub roster_total: i64,
    /// 这门课实际用过的班级（有授课或提交记录）。
    ///
    /// 前端据此在「只有一个班」时自动选中，省掉一次没有意义的手动选择；
    /// 多于一个班时仍要求教师显式选择，避免把跨班数据误读成某一个班。
    pub used_class_ids: Vec<i64>,
    /// 课时维度的汇总，按课时顺序
    pub lessons: Vec<LessonHomeworkSummary>,
}

/// 单个课时的作业提交汇总。
#[derive(Debug, Serialize)]
pub struct LessonHomeworkSummary {
    pub lesson_id: i64,
    pub lesson_title: String,
    pub sort_order: i64,
    /// 该课时提交份数（含重复提交）
    pub submitted_count: i64,
    /// 去重后的提交人数（按学号，无学号时按姓名）
    pub submitter_count: i64,
    /// 被标记为重复的份数
    pub duplicate_count: i64,
    /// 名单中尚未提交的人数
    pub missing_count: i64,
}

/// 某课时的提交看板：谁交了、谁没交。
#[derive(Debug, Serialize)]
pub struct LessonSubmissionBoard {
    pub lesson_id: i64,
    pub lesson_title: String,
    pub course_id: i64,
    pub course_title: String,
    pub class_id: Option<i64>,
    pub class_name: Option<String>,
    /// 名单人数
    pub roster_total: i64,
    /// 已提交（去重后）
    pub submitted: Vec<StudentSubmissionState>,
    /// 未提交（仅当有名单时有意义）
    pub missing: Vec<MissingStudent>,
    /// 名单外的提交者：可能是临时加人，也可能是姓名填错
    pub unlisted: Vec<StudentSubmissionState>,
}

/// 名单内某个学生的提交状态。
#[derive(Debug, Serialize)]
pub struct StudentSubmissionState {
    pub student_no: String,
    pub student_name: String,
    /// 提交份数
    pub submission_count: i64,
    /// 最近一次提交时间
    pub latest_at: String,
    /// 最近一次提交的 ID，便于跳转详情
    pub latest_submission_id: i64,
    /// 是否被标记为重复
    pub has_duplicate: bool,
    /// 提交时记录的最新技术信息
    pub client_ip: String,
    /// 审核状态（最近一次）
    pub status: String,
}

/// 未提交的学生。
#[derive(Debug, Serialize)]
pub struct MissingStudent {
    pub student_no: String,
    pub student_name: String,
}

// ---------------------------------------------------------------------------
// 作业审阅
// ---------------------------------------------------------------------------

/// 审阅标签的合法取值。空字符串表示「尚未评价」。
///
/// 四类标签来自教师的实际批改习惯：多数作业是「通过」，
/// 少数特别好的是「好」，需要退回重做的是「不通过」，
/// 剩下需要单独沟通的归入「其他」。
pub const REVIEW_LABELS: [&str; 4] = ["good", "pass", "fail", "other"];

/// 判断标签是否合法（允许空字符串表示清空）。
pub fn is_valid_review_label(label: &str) -> bool {
    label.is_empty() || REVIEW_LABELS.contains(&label)
}

/// 一个课时下的审阅分布统计。
///
/// `unreviewed` 与 `missing` 是教师最关心的两个数字：
/// 前者是「交了但还没批」，后者是「压根没交」。
#[derive(Debug, Default, Clone, Serialize)]
pub struct ReviewStats {
    /// 该课时提交总份数
    pub total: i64,
    /// 标签为好
    pub good: i64,
    /// 标签为通过
    pub pass: i64,
    /// 标签为不通过
    pub fail: i64,
    /// 标签为其他
    pub other: i64,
    /// 已提交但尚未评价
    pub unreviewed: i64,
    /// 打了分数的份数
    pub scored: i64,
    /// 已打分提交的平均分；无人打分时为 `None`
    pub average_score: Option<f64>,
    /// 名单中尚未提交的人数
    pub missing: i64,
    /// 分数累加值，仅用于计算平均分，不对外输出
    #[serde(skip)]
    pub score_sum: f64,
}

impl ReviewStats {
    /// 按标签累加计数。
    pub fn count_label(&mut self, label: &str) {
        self.total += 1;
        match label {
            "good" => self.good += 1,
            "pass" => self.pass += 1,
            "fail" => self.fail += 1,
            "other" => self.other += 1,
            _ => self.unreviewed += 1,
        }
    }

    /// 写入分数累计，用于最后算平均分。
    pub fn add_score(&mut self, score: Option<f64>) {
        if let Some(value) = score {
            self.scored += 1;
            self.score_sum += value;
        }
    }

    /// 收尾：把累计分数换算成平均分，保留一位小数。
    pub fn finish(&mut self) {
        self.average_score = if self.scored > 0 {
            Some((self.score_sum / self.scored as f64 * 10.0).round() / 10.0)
        } else {
            None
        };
    }
}

/// 课时审阅看板：按提交粒度返回，供教师逐份或批量批改。
///
/// 与 [`LessonSubmissionBoard`] 的区别：那个按「学生」聚合，回答「谁没交」；
/// 这个按「提交」展开，回答「这一份给什么评价」。
/// 一个学生交了两次就是两行，教师需要分别批改。
#[derive(Debug, Serialize)]
pub struct LessonReviewBoard {
    pub lesson_id: i64,
    pub lesson_title: String,
    pub course_id: i64,
    pub course_title: String,
    pub class_id: Option<i64>,
    pub class_name: Option<String>,
    /// 名单人数；未指定班级时为 0
    pub roster_total: i64,
    pub stats: ReviewStats,
    /// 该课时的全部提交，按提交时间倒序
    pub items: Vec<SubmissionDetailView>,
}

/// 批量审阅结果。
///
/// 返回更新后的统计，前端可以直接刷新顶部数字而不必重拉整个看板。
#[derive(Debug, Serialize)]
pub struct BatchReviewResult {
    /// 实际更新的提交份数
    pub updated: i64,
    /// 更新后的统计；仅在请求带 `lesson_id` 时计算
    pub stats: Option<ReviewStats>,
}

// ---------------------------------------------------------------------------
// 监控
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
    pub database: &'static str,
    pub uptime_seconds: i64,
    pub active_sessions: i64,
    pub active_downloads: i64,
    pub objects_bytes: u64,
}
