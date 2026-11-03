//! 作业提交接口：学生端在课程/课时页面直接上传，教师端在后台查看。
//!
//! 关键约束：
//! - 学生端无登录态，因此提交接口不要求 JWT；但**客户端不能指定 IP**，
//!   `client_ip` 一律由服务端从连接信息解析，避免伪造；
//! - 一次提交可携带多个文件，每个文件复用资源库的 SHA-256 校验与 `/files` 下载能力；
//! - 同一课时同一班级已有提交时，新提交仍然保存，但置 `duplicate_flag = 1`
//!   并记录 `duplicate_of`，供教师核对；
//! - 所有文件在事务外先完成落盘，再一次性写入数据库，避免半成品提交。

use crate::error::{AppError, AppResult};
use crate::models::{
    CreateSubmissionResponse, LessonSubmissionStatus, ListResponse, StudentAccessQuery,
    SubmissionDetailView, SubmissionFileRow, SubmissionLimits, SubmissionRow,
    WithdrawSubmissionRequest,
};
use crate::routes::resources::{create_staging_resource, infer_purpose, store_file_field};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use serde::Deserialize;
use std::net::SocketAddr;

/// 单次提交允许的文件数量上限的兜底值。
///
/// 实际上限取自 `limits.submission_max_files`，配置可调；
/// 这里只作为配置缺省时的默认值，与实际运行时上限保持一致。
const DEFAULT_MAX_FILES_PER_SUBMISSION: usize = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        // 学生端：公开接口，无需登录（与 /api/student/* 一致）
        .route(
            "/api/student/submissions",
            post(create_submission).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/student/submissions/status", get(lesson_status))
        // 静态段优先于 `{id}`：学生端撤回与回读都挂在这两个前缀下
        .route(
            "/api/student/submissions/{id}",
            get(get_public_submission).delete(withdraw_submission),
        )
        .route(
            "/api/student/submissions/{id}/withdraw",
            post(withdraw_submission_post),
        )
        // 教师端：需要登录
        .route("/api/admin/submissions", get(list_submissions))
        // 批量路由必须能被静态匹配优先命中，避免被 `{id}` 吞掉
        .route("/api/admin/submissions/batch-review", post(batch_review))
        .route("/api/admin/submissions/{id}", get(get_submission))
        .route(
            "/api/admin/submissions/{id}/review",
            post(review_submission),
        )
}

/// 一次批量审阅允许的提交份数上限。
///
/// 一个班的作业通常 30–60 份，500 足够覆盖合班上课的情况；
/// 设上限是为了挡住误传超大数组把数据库写锁占满。
const MAX_BATCH_REVIEW: usize = 500;

/// 课时提交状态查询参数。
#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    pub lesson_id: i64,
    /// 班级 ID；缺省时按全局统计（不区分班级）
    pub class_id: Option<i64>,
    /// 本设备标识（前端生成并持久化在 localStorage）；
    /// 缺省时退化为仅按 IP 识别设备
    pub device_id: Option<String>,
}

/// 学生端：查询本课时本设备的提交情况，用于上传前提醒。
///
/// 提示语义是「这台机器已经交过了」，而不是「班里谁最早交」：
/// 机房电脑多人轮用，按设备判断才能让学生确认自己是否已提交；
/// 班里其他人交没交属于教师视角的信息，学生端不指名展示。
async fn lesson_status(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<StatusQuery>,
) -> AppResult<Json<LessonSubmissionStatus>> {
    // 本班该课时提交总数：仅作为背景数字，不含姓名。
    // 学生已撤回的不计入，否则「本班已有 N 份」会虚高。
    let class_total: i64 = match query.class_id {
        Some(class_id) => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND class_id = ?2 AND withdrawn_at IS NULL",
            )
            .bind(query.lesson_id)
            .bind(class_id)
            .fetch_one(&state.db)
            .await?
        }
        None => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM homework_submissions
                 WHERE lesson_id = ?1 AND withdrawn_at IS NULL",
            )
            .bind(query.lesson_id)
            .fetch_one(&state.db)
            .await?
        }
    };

    let client_ip = resolve_client_ip(&headers, peer);
    let device = fetch_device_submission(
        &state,
        query.lesson_id,
        &client_ip,
        query.device_id.as_deref(),
    )
    .await?;

    Ok(Json(LessonSubmissionStatus {
        lesson_id: query.lesson_id,
        class_id: query.class_id,
        class_total,
        device,
        limits: current_limits(&state),
    }))
}

/// 当前服务端生效的提交限制，下发给前端做同等校验。
fn current_limits(state: &AppState) -> SubmissionLimits {
    SubmissionLimits {
        max_files: state
            .config
            .raw
            .limits
            .submission_max_files
            .clamp(1, DEFAULT_MAX_FILES_PER_SUBMISSION.max(50)),
        max_file_bytes: state.config.raw.storage.max_file_bytes,
        max_total_bytes: state.config.raw.limits.submission_max_total_bytes,
    }
}

/// 查询当前设备在某课时的提交情况。
///
/// 设备识别采用「同一 IP + 同一浏览器 User-Agent」。
/// 机房场景下每台机器 IP 固定，因此组合判断足够区分；
/// 前端额外传 `device_id`（localStorage 里的随机串）时一并作为过滤条件，
/// 让同一台机器换浏览器也能被认出是同一设备。
async fn fetch_device_submission(
    state: &AppState,
    lesson_id: i64,
    client_ip: &str,
    device_id: Option<&str>,
) -> AppResult<Option<crate::models::DeviceSubmission>> {
    let device_id = device_id.map(str::trim).filter(|text| !text.is_empty());

    // 条件按是否有 device_id 分两种，参数全部走 bind 绑定。
    // 已撤回的记录不计入「本设备已提交」，否则学生撤回后重开会一直看到旧提醒。
    let (count_sql, latest_tail) = if device_id.is_some() {
        (
            "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND device_id = ?3
               AND withdrawn_at IS NULL",
            "WHERE s.lesson_id = ?1 AND s.client_ip = ?2 AND s.device_id = ?3
               AND s.withdrawn_at IS NULL
             ORDER BY s.created_at DESC, s.id DESC LIMIT 1",
        )
    } else {
        (
            "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND withdrawn_at IS NULL",
            "WHERE s.lesson_id = ?1 AND s.client_ip = ?2 AND s.withdrawn_at IS NULL
             ORDER BY s.created_at DESC, s.id DESC LIMIT 1",
        )
    };

    let mut count_query = sqlx::query_scalar::<_, i64>(count_sql)
        .bind(lesson_id)
        .bind(client_ip);
    if let Some(device_id) = device_id {
        count_query = count_query.bind(device_id);
    }
    let total = count_query.fetch_one(&state.db).await?;

    if total == 0 {
        return Ok(None);
    }

    // submission_select_sql 返回 String，必须先绑定再取引用，
    // 否则临时值会在语句结束前被释放。
    let latest_sql = submission_select_sql(latest_tail);
    let mut latest_query = sqlx::query_as::<_, SubmissionRow>(&latest_sql)
        .bind(lesson_id)
        .bind(client_ip);
    if let Some(device_id) = device_id {
        latest_query = latest_query.bind(device_id);
    }
    let latest = latest_query.fetch_optional(&state.db).await?;

    Ok(latest.map(|row| crate::models::DeviceSubmission { total, latest: row }))
}

/// 提交列表查询参数（教师端）。
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub lesson_id: Option<i64>,
    pub class_id: Option<i64>,
    pub course_id: Option<i64>,
    /// 仅看被标记为重复的提交
    #[serde(default)]
    pub duplicate_only: bool,
    /// 按审阅标签筛选；`unreviewed` 表示「尚未评价」
    pub review_label: Option<String>,
    /// 是否把学生已撤回的记录也列出来
    ///
    /// 默认排除：撤回意味着学生不该再被要求交这份作业，
    /// 混在列表里会让教师误以为还有待批的作业。
    #[serde(default)]
    pub include_withdrawn: bool,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    200
}

/// 教师端：提交记录列表，带课程/课时/班级标题与文件数。
async fn list_submissions(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResponse<SubmissionRow>>> {
    let limit = query.limit.clamp(1, 1000);

    // 条件组合较多，这里用固定顺序的占位参数拼装，所有值仍然走 bind 绑定。
    let mut conditions: Vec<&str> = Vec::new();
    if query.lesson_id.is_some() {
        conditions.push("s.lesson_id = ?");
    }
    if query.class_id.is_some() {
        conditions.push("s.class_id = ?");
    }
    if query.course_id.is_some() {
        conditions.push("s.course_id = ?");
    }
    if query.duplicate_only {
        conditions.push("s.duplicate_flag = 1");
    }
    // `unreviewed` 是「标签为空」的别名，其余值按原样等值匹配
    let label_filter = query
        .review_label
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if let Some(label) = label_filter {
        if label == "unreviewed" {
            conditions.push("s.review_label = ''");
        } else {
            if !crate::models::is_valid_review_label(label) {
                return Err(AppError::BadRequest(
                    "标签只能是 good / pass / fail / other / unreviewed".into(),
                ));
            }
            conditions.push("s.review_label = ?");
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    // 已撤回的提交默认不进列表：教师关心的是「手上有哪些作业要批」。
    // 需要核对撤回记录时走 include_withdrawn=true。
    let withdrawn_clause = if query.include_withdrawn {
        ""
    } else {
        if where_clause.is_empty() {
            "WHERE s.withdrawn_at IS NULL"
        } else {
            "AND s.withdrawn_at IS NULL"
        }
    };

    let sql = submission_select_sql(&format!(
        "{where_clause} {withdrawn_clause} ORDER BY s.created_at DESC, s.id DESC LIMIT ?"
    ));

    let mut statement = sqlx::query_as::<_, SubmissionRow>(&sql);
    if let Some(lesson_id) = query.lesson_id {
        statement = statement.bind(lesson_id);
    }
    if let Some(class_id) = query.class_id {
        statement = statement.bind(class_id);
    }
    if let Some(course_id) = query.course_id {
        statement = statement.bind(course_id);
    }
    if let Some(label) = label_filter {
        // `unreviewed` 已在 SQL 里写成常量，不需要绑定参数
        if label != "unreviewed" {
            statement = statement.bind(label);
        }
    }
    statement = statement.bind(limit);

    let rows = statement.fetch_all(&state.db).await?;
    Ok(Json(ListResponse::new(rows)))
}

/// 教师端：提交详情，含全部文件。
async fn get_submission(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<i64>,
) -> AppResult<Json<SubmissionDetailView>> {
    let submission = sqlx::query_as::<_, SubmissionRow>(&submission_select_sql("WHERE s.id = ?1"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("提交 {id}")))?;

    // 教师端带预览票：预览标签无法携带 Authorization 头
    build_detail_with_tickets(&state, submission, true)
        .await
        .map(Json)
}

/// 学生端：回读自己的提交，用于上传后弹窗预览。
///
/// 必须带提交时下发的 `access_token`：学生端没有账号，
/// 若只按自增 ID 取数据，任何一串递增数字都能读到别人的
/// 提交人姓名、来源 IP 与文件清单。
async fn get_public_submission(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<StudentAccessQuery>,
) -> AppResult<Json<SubmissionDetailView>> {
    let token = query
        .access_token
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or(AppError::Forbidden)?;

    ensure_submission_token(&state, id, token).await?;

    // 撤回后不再对外可读，与文件下载（403）保持同一口径。
    // 记录本身仍保留，教师端可通过 include_withdrawn=true 核对。
    let withdrawn: Option<Option<String>> =
        sqlx::query_scalar("SELECT withdrawn_at FROM homework_submissions WHERE id = ?1")
            .bind(id)
            .fetch_optional(&state.db)
            .await?;

    if withdrawn.flatten().is_some() {
        return Err(AppError::Forbidden);
    }

    build_detail(&state, id).await.map(Json)
}

/// 学生端：撤回提交（DELETE 形式，凭证走 query）。
async fn withdraw_submission(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Query(query): Query<StudentAccessQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let token = query.access_token.unwrap_or_default();
    withdraw_with_token(&state, id, token.trim()).await
}

/// 学生端：撤回提交（POST 形式，凭证走请求体）。
///
/// 与 DELETE 形式并存，是因为部分浏览器与代理会剥掉
/// DELETE 请求的 query 参数，POST + JSON 更稳妥。
async fn withdraw_submission_post(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(payload): Json<WithdrawSubmissionRequest>,
) -> AppResult<Json<serde_json::Value>> {
    withdraw_with_token(&state, id, payload.access_token.trim()).await
}

/// 校验提交凭证；不匹配一律 403，不区分「不存在」与「凭证错误」。
///
/// 区分两者会让攻击者用状态码差异判断某个 ID 是否真实存在。
async fn ensure_submission_token(
    state: &AppState,
    submission_id: i64,
    provided: &str,
) -> AppResult<()> {
    if provided.is_empty() {
        return Err(AppError::Forbidden);
    }

    let expected: Option<String> =
        sqlx::query_scalar("SELECT access_token FROM homework_submissions WHERE id = ?1")
            .bind(submission_id)
            .fetch_optional(&state.db)
            .await?;

    // 常量时间比较：凭证是随机串，普通比较的时序差异足以被逐字节试探
    match expected {
        Some(expected) if constant_time_eq(expected.as_bytes(), provided.as_bytes()) => Ok(()),
        _ => Err(AppError::Forbidden),
    }
}

/// 定长时间字符串比较，长度不同直接判不等。
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 撤回实现：校验凭证 → 校验时间窗 → 置撤回时间 → 文件资源降级。
async fn withdraw_with_token(
    state: &AppState,
    submission_id: i64,
    token: &str,
) -> AppResult<Json<serde_json::Value>> {
    ensure_submission_token(state, submission_id, token).await?;

    let row: Option<(Option<String>, String)> =
        sqlx::query_as("SELECT withdrawn_at, created_at FROM homework_submissions WHERE id = ?1")
            .bind(submission_id)
            .fetch_optional(&state.db)
            .await?;

    let (withdrawn_at, created_at) =
        row.ok_or_else(|| AppError::NotFound(format!("提交 {submission_id}")))?;

    if withdrawn_at.is_some() {
        return Err(AppError::Conflict("该提交已撤回".into()));
    }

    let window = state.config.raw.limits.submission_withdraw_secs;
    if window == 0 {
        return Err(AppError::Forbidden);
    }

    // 时间比较放到 SQLite 里做：created_at 是 UTC 无标记字符串，
    // 用 datetime('now', '-N seconds') 与它直接比较最稳妥，不受时区影响。
    let withdrawable: i64 = sqlx::query_scalar(
        "SELECT CASE WHEN created_at >= datetime('now', ?1) THEN 1 ELSE 0 END
         FROM homework_submissions WHERE id = ?2",
    )
    .bind(format!("-{} seconds", window))
    .bind(submission_id)
    .fetch_one(&state.db)
    .await?;

    if withdrawable == 0 {
        return Err(AppError::Conflict(format!(
            "已超过可撤回时限（提交后 {} 小时内）",
            window / 3600
        )));
    }

    let mut tx = state.db.begin().await?;

    sqlx::query("UPDATE homework_submissions SET withdrawn_at = datetime('now') WHERE id = ?1")
        .bind(submission_id)
        .execute(&mut *tx)
        .await?;

    // 文件资源降级为 staging：仍留在磁盘供教师核对，
    // 但 /files 的 ready 校验会让匿名下载直接失败。
    sqlx::query(
        "UPDATE resources SET status = 'staging', updated_at = datetime('now')
         WHERE id IN (
             SELECT resource_id FROM homework_submission_files WHERE submission_id = ?1
         )",
    )
    .bind(submission_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    crate::routes::auth::audit(
        state,
        None,
        "submission.withdraw",
        "submission",
        &submission_id.to_string(),
    )
    .await;

    tracing::info!(submission_id, created_at = %created_at, "学生撤回作业提交");

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 审核请求。
///
/// 四个字段都是选填，但至少要提供一个，否则请求没有意义：
/// - `status`：流程状态，`submitted` / `reviewed` / `flagged`；
/// - `label`：评价标签，`good` / `pass` / `fail` / `other`，空串表示清除标签；
/// - `score`：分数 0–100，`null` 表示清除分数；
/// - `comment`：评语，空串表示清除评语。
#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    /// `submitted` / `reviewed` / `flagged`
    pub status: Option<String>,
    /// 评价标签；`Some("")` 表示清除标签
    pub label: Option<String>,
    /// 分数 0–100。
    ///
    /// 三层语义，因此需要 `Option<Option<f64>>`：
    /// - 字段缺失 → `None`：不动分数；
    /// - 显式 `null` → `Some(None)`：清除分数；
    /// - 具体数值 → `Some(Some(v))`：写入分数。
    ///
    /// serde 默认会把 JSON `null` 折叠成外层 `None`，导致「清除分数」被当成
    /// 「不修改分数」而静默失败，所以这里必须自定义反序列化。
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub score: Option<Option<f64>>,
    /// 教师评语；`Some("")` 表示清除评语
    pub comment: Option<String>,
}

/// 区分「字段缺失」与「字段为 null」的双层 Option 反序列化。
///
/// 字段缺失时 serde 走 `#[serde(default)]`，根本不会调用这里；
/// 一旦调用，说明字段确实出现在请求体里，此时 `null` 应当表达「清除」，
/// 而不是「未提供」。
fn deserialize_double_option<'de, D>(deserializer: D) -> Result<Option<Option<f64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<f64>::deserialize(deserializer).map(Some)
}

/// 教师端：审阅单份提交（状态 / 标签 / 分数 / 评语可任选其一）。
///
/// 只更新请求里出现的字段，未出现的保持原值——
/// 教师点了「好」不应该顺手把已经打过的 95 分清成空。
async fn review_submission(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<ReviewRequest>,
) -> AppResult<Json<SubmissionDetailView>> {
    // 提交必须存在，避免静默写入无效记录。
    build_detail(&state, id).await?;

    let patch = ReviewPatch::from_request(&payload)?;
    apply_review(&state, &[id], &patch, user.id()).await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "submission.review",
        "submission",
        &id.to_string(),
    )
    .await;

    build_detail(&state, id).await.map(Json)
}

/// 批量审阅请求。
///
/// 教师在一次作业里勾选若干份提交，统一打同一个标签或分数。
#[derive(Debug, Deserialize)]
pub struct BatchReviewRequest {
    /// 要审阅的提交 ID 列表
    pub ids: Vec<i64>,
    /// 与单份审阅相同的字段
    #[serde(flatten)]
    pub review: ReviewRequest,
    /// 附带课时 ID 时，返回更新后的统计，前端可原地刷新计数
    pub lesson_id: Option<i64>,
}

/// 教师端：批量审阅多份提交。
///
/// 语义是「对所选提交施加同一套评价」，未提交的 ID 会被忽略而不是报错——
/// 教师可能在别处删掉了记录，整批失败会让人反复重试。
async fn batch_review(
    State(state): State<AppState>,
    user: AuthUser,
    Json(payload): Json<BatchReviewRequest>,
) -> AppResult<Json<crate::models::BatchReviewResult>> {
    if payload.ids.is_empty() {
        return Err(AppError::BadRequest("请至少选择一份提交".into()));
    }
    if payload.ids.len() > MAX_BATCH_REVIEW {
        return Err(AppError::BadRequest(format!(
            "单次最多批量审阅 {MAX_BATCH_REVIEW} 份"
        )));
    }

    let patch = ReviewPatch::from_request(&payload.review)?;

    // 去重后再写，避免同一 ID 重复出现导致计数虚高
    let mut ids: Vec<i64> = payload.ids.clone();
    ids.sort_unstable();
    ids.dedup();

    let updated = apply_review(&state, &ids, &patch, user.id()).await?;

    crate::routes::auth::audit(
        &state,
        Some(user.id()),
        "submission.batch_review",
        "submission",
        &format!("{} 份", updated),
    )
    .await;

    let stats = match payload.lesson_id {
        Some(lesson_id) => Some(collect_review_stats(&state, lesson_id, None).await?),
        None => None,
    };

    Ok(Json(crate::models::BatchReviewResult { updated, stats }))
}

/// 校验后的一次审阅变更。
///
/// 用 `Option` 表达「本次请求是否要改这个字段」，
/// 与「要把它改成什么」分开，避免把未提及的字段写成默认值。
#[derive(Debug, Default)]
struct ReviewPatch {
    status: Option<String>,
    label: Option<String>,
    score: Option<Option<f64>>,
    comment: Option<String>,
}

impl ReviewPatch {
    /// 从请求体构造补丁并做完整校验。
    fn from_request(payload: &ReviewRequest) -> AppResult<Self> {
        let mut patch = ReviewPatch::default();

        if let Some(status) = payload.status.as_deref() {
            if !matches!(status, "submitted" | "reviewed" | "flagged") {
                return Err(AppError::BadRequest(
                    "状态只能是 submitted / reviewed / flagged".into(),
                ));
            }
            patch.status = Some(status.to_string());
        }

        if let Some(label) = payload.label.as_deref() {
            let label = label.trim();
            if !crate::models::is_valid_review_label(label) {
                return Err(AppError::BadRequest(
                    "标签只能是 good / pass / fail / other，或留空清除".into(),
                ));
            }
            patch.label = Some(label.to_string());
        }

        if let Some(score) = payload.score {
            if let Some(value) = score {
                if !value.is_finite() || !(0.0..=100.0).contains(&value) {
                    return Err(AppError::BadRequest("分数需在 0–100 之间".into()));
                }
            }
            patch.score = Some(score);
        }

        if let Some(comment) = payload.comment.as_deref() {
            patch.comment = Some(comment.trim().chars().take(500).collect());
        }

        // 全空请求视为无效，避免无意义写库与审计噪音
        if patch.status.is_none()
            && patch.label.is_none()
            && patch.score.is_none()
            && patch.comment.is_none()
        {
            return Err(AppError::BadRequest(
                "请至少提供状态、标签、分数或评语之一".into(),
            ));
        }

        Ok(patch)
    }
}

/// 把补丁写到指定提交上，返回实际更新的行数。
///
/// 分两步更新，避免一个容易踩的坑：
/// 1. 先写 `status` / `review_label` / `review_score` / `review_comment`；
/// 2. 再根据**更新后的最终值**决定 `reviewed_at` / `reviewed_by`。
///
/// 不能合成一条 SQL，是因为 SQLite 的 SET 右侧引用的是更新前的旧值——
/// 那样「只清分数、保留标签」会被误判成「撤销审阅」，把审阅时间抹掉。
async fn apply_review(
    state: &AppState,
    ids: &[i64],
    patch: &ReviewPatch,
    reviewer: i64,
) -> AppResult<i64> {
    let touches_review = patch.label.is_some() || patch.score.is_some();
    let marks_reviewed = patch.label.as_deref().is_some_and(|l| !l.is_empty())
        || patch.score.is_some_and(|s| s.is_some());

    let mut total = 0_i64;
    let mut tx = state.db.begin().await?;

    for id in ids {
        // 第一步：写内容字段。逐条拼 SET，SQLite 不支持按需跳过参数。
        let mut sets: Vec<&str> = Vec::new();
        if patch.status.is_some() {
            sets.push("status = ?");
        }
        if patch.label.is_some() {
            sets.push("review_label = ?");
        }
        if patch.score.is_some() {
            sets.push("review_score = ?");
        }
        if patch.comment.is_some() {
            sets.push("review_comment = ?");
        }
        if marks_reviewed && patch.status.is_none() {
            // 打了标签/分数就把流程状态从「已提交」推进到「已查看」。
            //
            // 只在当前状态为 submitted 时推进：教师先前把某份标记成 flagged
            // （有问题），后来只是补了个标签，不应该把问题标记冲掉。
            // 教师显式指定 status 时同样以显式值为准。
            sets.push("status = CASE WHEN status = 'submitted' THEN 'reviewed' ELSE status END");
        }

        if !sets.is_empty() {
            let sql = format!(
                "UPDATE homework_submissions SET {} WHERE id = ?",
                sets.join(", ")
            );

            let mut query = sqlx::query(&sql);
            if let Some(status) = patch.status.as_deref() {
                query = query.bind(status);
            }
            if let Some(label) = patch.label.as_deref() {
                query = query.bind(label);
            }
            if let Some(score) = patch.score {
                query = query.bind(score);
            }
            if let Some(comment) = patch.comment.as_deref() {
                query = query.bind(comment);
            }
            query = query.bind(id);

            let result = query.execute(&mut *tx).await?;
            total += result.rows_affected() as i64;
        }

        // 第二步：按最终值修正审阅时间。
        // 标签与分数都为空才算「撤销审阅」，否则记下这次审阅的人与时间。
        if touches_review {
            sqlx::query(
                "UPDATE homework_submissions
                 SET reviewed_at = CASE
                         WHEN review_label = '' AND review_score IS NULL THEN NULL
                         ELSE datetime('now')
                     END,
                     reviewed_by = CASE
                         WHEN review_label = '' AND review_score IS NULL THEN NULL
                         ELSE ?1
                     END
                 WHERE id = ?2",
            )
            .bind(reviewer)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;
    Ok(total)
}

/// 学生端：提交作业（多文件）。
///
/// multipart 字段约定：
/// - `student_name`：必填，提交人姓名；
/// - `note`：选填备注；
/// - `lesson_id`：必填；
/// - `class_id`：选填，缺省时从当前课堂推断；
/// - `student_no`：选填，学号；从班级名单选择自己时带上，便于统计「谁没交」；
/// - `device_id`：选填，前端生成的设备标识，用于判断「本设备是否已提交」；
/// - `file`：可重复，数量上限取自配置。
///
/// 失败路径的处理原则：**任何一步失败都要把已落盘的文件清干净**。
/// 早期版本只在「单个文件落盘失败」时清理，像「姓名没填」「课时不存在」
/// 这类发生在全部文件之后的校验失败，会留下一批孤儿 staging 资源。
async fn create_submission(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<CreateSubmissionResponse>> {
    // 限流放在最前面：被限流的请求不应有机会写磁盘。
    let client_ip = resolve_client_ip(&headers, peer);
    if let Some(wait) = state.try_acquire_submission_slot(&client_ip) {
        return Err(AppError::TooManyRequests(format!(
            "提交过于频繁，请 {wait} 秒后再试"
        )));
    }

    let limits = current_limits(&state);
    let mut student_name: Option<String> = None;
    let mut student_no = String::new();
    let mut note = String::new();
    let mut lesson_id: Option<i64> = None;
    let mut class_id: Option<i64> = None;
    let mut device_id = String::new();
    let mut files: Vec<crate::models::ResourceRow> = Vec::new();
    let mut total_bytes: u64 = 0;

    // 逐字段读取：文本字段可能出现在文件之前或之后，因此先缓存文件名，
    // 真正落盘在 multipart 迭代过程中完成，避免把大文件读进内存。
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("上传解析失败：{e}")))?
    {
        match field.name() {
            Some("student_name") => {
                student_name = Some(read_text_field(field).await?);
            }
            Some("student_no") => {
                // 学号只用于名单匹配，长度做上限避免异常写入
                student_no = read_text_field(field)
                    .await?
                    .trim()
                    .chars()
                    .take(32)
                    .collect();
            }
            Some("note") => {
                note = read_text_field(field).await?;
            }
            Some("device_id") => {
                // 设备标识只用于聚合查询，长度做上限避免异常写入。
                device_id = read_text_field(field)
                    .await?
                    .trim()
                    .chars()
                    .take(64)
                    .collect();
            }
            Some("lesson_id") => {
                let text = read_text_field(field).await?;
                lesson_id = Some(
                    text.trim()
                        .parse::<i64>()
                        .map_err(|_| AppError::BadRequest("lesson_id 必须是整数".into()))?,
                );
            }
            Some("class_id") => {
                let text = read_text_field(field).await?;
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    class_id = Some(
                        trimmed
                            .parse::<i64>()
                            .map_err(|_| AppError::BadRequest("class_id 必须是整数".into()))?,
                    );
                }
            }
            Some("file") => {
                if files.len() >= limits.max_files {
                    discard_uploads(&state, &files).await;
                    return Err(AppError::BadRequest(format!(
                        "一次最多提交 {} 个文件",
                        limits.max_files
                    )));
                }

                // 文件名用于占位记录的初始名称；真实名称在落盘时回填。
                let placeholder_name = field
                    .file_name()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "作业文件".to_string());

                let placeholder = create_staging_resource(&state, None, &placeholder_name).await?;

                match store_file_field(&state, &placeholder, field).await {
                    Ok(resource) => {
                        total_bytes = total_bytes.saturating_add(resource.size_bytes.max(0) as u64);
                        files.push(resource);

                        // 单个文件已在 store_file_field 内按 max_file_bytes 校验，
                        // 这里补一道「合计大小」：一次交十个大文件会长时间占住连接。
                        if limits.max_total_bytes > 0 && total_bytes > limits.max_total_bytes {
                            discard_uploads(&state, &files).await;
                            return Err(AppError::BadRequest(format!(
                                "本次提交合计超出上限（最多 {} MiB）",
                                limits.max_total_bytes / (1024 * 1024)
                            )));
                        }
                    }
                    Err(err) => {
                        // 单个文件失败时清理已落盘的占位记录，避免脏数据。
                        crate::routes::resources::purge_resource(&state, &placeholder).await;
                        discard_uploads(&state, &files).await;
                        return Err(err);
                    }
                }
            }
            _ => {
                // 未知字段直接丢弃，避免解析阻塞。
                let _ = read_text_field(field).await;
            }
        }
    }

    // 从这里开始是「全部文件已落盘」之后的校验，任何失败都要丢弃已传内容。
    let outcome = finalize_submission(
        &state,
        &headers,
        &client_ip,
        student_name.as_deref(),
        &student_no,
        &note,
        lesson_id,
        class_id,
        &device_id,
        &files,
        total_bytes,
    )
    .await;

    match outcome {
        Ok(response) => Ok(Json(response)),
        Err(err) => {
            discard_uploads(&state, &files).await;
            Err(err)
        }
    }
}

/// 落盘完成后的收尾：校验身份信息、确定班级、判定重复、在单事务内写库。
///
/// 拆成独立函数是为了让失败清理只有一处：只要它返回错误，
/// 调用方就丢弃全部已落盘文件。
#[allow(clippy::too_many_arguments)]
async fn finalize_submission(
    state: &AppState,
    headers: &HeaderMap,
    client_ip: &str,
    student_name: Option<&str>,
    student_no: &str,
    note: &str,
    lesson_id: Option<i64>,
    requested_class_id: Option<i64>,
    device_id: &str,
    files: &[crate::models::ResourceRow],
    total_bytes: u64,
) -> AppResult<CreateSubmissionResponse> {
    let student_name = student_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::BadRequest("请填写提交人姓名".into()))?;

    if student_name.chars().count() > 40 {
        return Err(AppError::BadRequest("姓名过长（最多 40 个字符）".into()));
    }

    // 控制字符会污染日志与导出文件，也常被用来伪造显示
    if student_name.chars().any(char::is_control) {
        return Err(AppError::BadRequest("姓名包含不可见字符".into()));
    }

    let lesson_id = lesson_id.ok_or_else(|| AppError::BadRequest("缺少 lesson_id".into()))?;

    if files.is_empty() {
        return Err(AppError::BadRequest("请至少选择一个文件".into()));
    }

    // 课时必须存在，避免产生指向不存在课时的提交。
    let lesson = crate::routes::lessons::fetch_lesson(state, lesson_id).await?;

    // 作业只能交到已发布课程的课时上。草稿课程在学生端不可见，
    // 但直链仍可能被构造，因此以课程状态为准而不是信任来源页面。
    let course_status: Option<String> = sqlx::query_scalar(
        "SELECT c.status FROM lessons l JOIN courses c ON c.id = l.course_id WHERE l.id = ?1",
    )
    .bind(lesson_id)
    .fetch_optional(&state.db)
    .await?;

    if course_status.as_deref() != Some("published") {
        return Err(AppError::NotFound(format!("课时 {lesson_id}")));
    }

    // 班级与服务场次一律以服务端状态为准。
    //
    // 学生端填的 class_id 不可信：选错班、旧缓存、甚至手工构造请求都会让
    // 统计落到别的班级。这里优先取该课时正在进行的课堂，没有活动课堂时
    // 才退回请求值（同时校验该班级真实存在）。
    let (class_id, session_id) = match current_session_for_lesson(state, lesson_id).await? {
        Some((session_class_id, session_id)) => (Some(session_class_id), Some(session_id)),
        None => match requested_class_id {
            Some(class_id) => {
                crate::routes::classes::fetch_class(state, class_id).await?;
                (Some(class_id), None)
            }
            None => (None, None),
        },
    };

    // 学号必须落在本班名单里，姓名以名单为准。
    //
    // 否则学生随手填一个别人的学号，就能把自己的提交算在别人头上，
    // 或者把「未交」统计彻底打乱。学号不在名单内时丢弃学号，
    // 退回按姓名匹配，仍然保存提交（不因为名单没导入而阻断交作业）。
    let mut student_no = student_no.trim().to_string();
    let mut effective_name = student_name.to_string();
    if !student_no.is_empty() {
        match class_id {
            Some(class_id) => {
                let roster_name: Option<String> = sqlx::query_scalar(
                    "SELECT student_name FROM class_students
                     WHERE class_id = ?1 AND student_no = ?2",
                )
                .bind(class_id)
                .bind(&student_no)
                .fetch_optional(&state.db)
                .await?;

                match roster_name {
                    Some(roster_name) => effective_name = roster_name,
                    None => {
                        tracing::warn!(lesson_id, %student_no, "学号不在班级名单内，已忽略");
                        student_no.clear();
                    }
                }
            }
            None => student_no.clear(),
        }
    }

    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .chars()
        .take(512)
        .collect::<String>();

    // 重复检测：只认「同一个学生」与「同一台设备」两种情况。
    //
    // 早期版本还有一条「本班已有其他人提交就标重复」的分支，
    // 它会把一个班除了第一个交的人之外全部标成重复，标记因此失去意义，
    // 教师端筛选也就用不上。去掉后 duplicate 的含义收敛为真正的可疑情形。
    let same_student_previous: Option<i64> = if !student_no.is_empty() {
        sqlx::query_scalar(
            "SELECT id FROM homework_submissions
             WHERE lesson_id = ?1 AND student_no = ?2 AND withdrawn_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(lesson_id)
        .bind(&student_no)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    let device_previous: Option<i64> = if student_no.is_empty() {
        let sql = if device_id.is_empty() {
            "SELECT id FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND withdrawn_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT 1"
        } else {
            "SELECT id FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND device_id = ?3
               AND withdrawn_at IS NULL
             ORDER BY created_at DESC, id DESC LIMIT 1"
        };
        let mut query = sqlx::query_scalar::<_, i64>(sql)
            .bind(lesson_id)
            .bind(client_ip);
        if !device_id.is_empty() {
            query = query.bind(device_id);
        }
        query.fetch_optional(&state.db).await?
    } else {
        None
    };

    let (duplicate_flag, duplicate_of, duplicate_warning) = if let Some(id) = same_student_previous
    {
        (
            1,
            Some(id),
            Some("你已提交过本节课作业，本次为再次提交，两次记录都会保留".to_string()),
        )
    } else if let Some(id) = device_previous {
        (
            1,
            Some(id),
            Some("当前设备已提交过本节课作业，本次提交已记录并标记为重复".to_string()),
        )
    } else {
        (0, None, None)
    };

    let access_token = generate_access_token();
    let withdraw_secs = state.config.raw.limits.submission_withdraw_secs;
    let withdraw_deadline = if withdraw_secs > 0 {
        sqlx::query_scalar::<_, String>("SELECT datetime('now', ?1)")
            .bind(format!("+{} seconds", withdraw_secs))
            .fetch_one(&state.db)
            .await
            .ok()
    } else {
        None
    };

    // 主表与文件关联表必须同事务：只写一半会留下「有提交没文件」
    // 或「有文件挂不上提交」的脏数据，而两种脏数据都无法靠重试修复。
    let mut tx = state.db.begin().await?;

    let submission_id: i64 = sqlx::query_scalar(
        "INSERT INTO homework_submissions
            (course_id, lesson_id, class_id, session_id, student_name, student_no,
             client_ip, user_agent, device_id, note, duplicate_flag, duplicate_of,
             access_token, total_bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14) RETURNING id",
    )
    .bind(lesson.course_id)
    .bind(lesson_id)
    .bind(class_id)
    .bind(session_id)
    .bind(&effective_name)
    .bind(&student_no)
    .bind(client_ip)
    .bind(&user_agent)
    .bind(device_id)
    .bind(truncate_chars(note.trim(), 500))
    .bind(duplicate_flag)
    .bind(duplicate_of)
    .bind(&access_token)
    .bind(total_bytes as i64)
    .fetch_one(&mut *tx)
    .await?;

    for (index, resource) in files.iter().enumerate() {
        sqlx::query(
            "INSERT INTO homework_submission_files (submission_id, resource_id, sort_order)
             VALUES (?1, ?2, ?3)",
        )
        .bind(submission_id)
        .bind(resource.id)
        .bind(index as i64)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    crate::routes::auth::audit(
        state,
        None,
        "submission.create",
        "submission",
        &submission_id.to_string(),
    )
    .await;

    tracing::info!(
        submission_id,
        lesson_id,
        ?class_id,
        client_ip,
        files = files.len(),
        total_bytes,
        duplicate = duplicate_flag == 1,
        "学生提交作业"
    );

    let detail = build_detail(state, submission_id).await?;

    Ok(CreateSubmissionResponse {
        submission: detail,
        duplicate_warning,
        access_token,
        withdraw_deadline,
    })
}

/// 生成提交凭证：32 字节随机数的十六进制表示。
///
/// 用 CSPRNG 而不是时间戳或自增数，凭证被猜中即等于提交被他人接管。
fn generate_access_token() -> String {
    let mut buffer = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buffer);
    hex::encode(buffer)
}

/// 按字符数截断，避免把多字节字符切断。
fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

/// 丢弃本次已落盘但不会入库的文件资源。
///
/// 同时清理 objects 与 staging 两处文件并删除资源行，
/// 保证「提交失败」不会在磁盘上留下无法追踪的垃圾。
async fn discard_uploads(state: &AppState, files: &[crate::models::ResourceRow]) {
    for resource in files {
        crate::routes::resources::purge_resource(state, resource).await;
    }
}

/// 读取文本字段内容，限制长度避免异常请求占用内存。
async fn read_text_field(mut field: axum::extract::multipart::Field<'_>) -> AppResult<String> {
    const MAX_TEXT_BYTES: usize = 4096;

    let mut buffer = Vec::new();
    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| AppError::BadRequest(format!("读取表单字段失败：{e}")))?
    {
        buffer.extend_from_slice(&chunk);
        if buffer.len() > MAX_TEXT_BYTES {
            return Err(AppError::BadRequest("表单字段过长".into()));
        }
    }

    String::from_utf8(buffer).map_err(|_| AppError::BadRequest("表单字段不是合法 UTF-8".into()))
}

/// 查询该课时当前活动课堂的班级与场次。
async fn current_session_for_lesson(
    state: &AppState,
    lesson_id: i64,
) -> AppResult<Option<(i64, i64)>> {
    let row = sqlx::query_as::<_, (i64, i64)>(
        "SELECT class_id, id FROM classroom_sessions
         WHERE lesson_id = ?1 AND status IN ('running', 'paused')
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(lesson_id)
    .fetch_optional(&state.db)
    .await?;

    Ok(row)
}

/// 解析客户端 IP。
///
/// 局域网部署时通常没有反向代理，此时直接使用 TCP 对端地址。
/// 只有请求来自回环地址（即反向代理与服务同机部署）时才信任
/// `X-Forwarded-For` 的第一跳，否则任何客户端都能伪造来源地址。
fn resolve_client_ip(headers: &HeaderMap, peer: SocketAddr) -> String {
    let peer_ip = peer.ip();
    let from_loopback = match peer_ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    };

    if from_loopback {
        if let Some(value) = headers.get("x-forwarded-for") {
            if let Ok(text) = value.to_str() {
                if let Some(first) = text.split(',').next() {
                    let candidate = first.trim();
                    if !candidate.is_empty() {
                        return candidate.chars().take(64).collect();
                    }
                }
            }
        }
        if let Some(value) = headers.get("x-real-ip") {
            if let Ok(text) = value.to_str() {
                let candidate = text.trim();
                if !candidate.is_empty() {
                    return candidate.chars().take(64).collect();
                }
            }
        }
    }

    peer_ip.to_string()
}

/// 提交列表与详情共用的 SELECT，附带课程/课时/班级标题与文件数。
pub(crate) fn submission_select_sql(tail: &str) -> String {
    format!(
        "SELECT s.id, s.course_id, s.lesson_id, s.class_id, s.session_id, s.student_name,
                s.student_no, s.client_ip, s.user_agent, s.device_id, s.note,
                s.duplicate_flag, s.duplicate_of, s.status, s.created_at,
                s.total_bytes, s.withdrawn_at,
                s.review_label, s.review_score, s.review_comment, s.reviewed_at,
                c.title AS course_title,
                l.title AS lesson_title,
                cl.name AS class_name,
                (SELECT COUNT(*) FROM homework_submission_files f WHERE f.submission_id = s.id)
                    AS file_count
         FROM homework_submissions s
         JOIN courses c ON c.id = s.course_id
         JOIN lessons l ON l.id = s.lesson_id
         LEFT JOIN classes cl ON cl.id = s.class_id
         {tail}"
    )
}

/// 组装提交详情。
async fn build_detail(state: &AppState, id: i64) -> AppResult<SubmissionDetailView> {
    let submission = sqlx::query_as::<_, SubmissionRow>(&submission_select_sql("WHERE s.id = ?1"))
        .bind(id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("提交 {id}")))?;

    build_detail_from(state, submission).await
}

/// 用已有的提交行组装详情（批量场景避免重复查询主表）。
pub(crate) async fn build_detail_from(
    state: &AppState,
    submission: SubmissionRow,
) -> AppResult<SubmissionDetailView> {
    build_detail_with_tickets(state, submission, false).await
}

/// 组装详情，可选择附带教师端预览票。
///
/// 预览票只发给已认证的教师端：`<img>` / `<video>` / `<iframe>`
/// 不会带 `Authorization` 头，没有票的话预览必然 403。
/// 学生端回读走 `submission_token`，不需要也不应该拿到票。
pub(crate) async fn build_detail_with_tickets(
    state: &AppState,
    submission: SubmissionRow,
    with_preview_tickets: bool,
) -> AppResult<SubmissionDetailView> {
    let id = submission.id;

    let files = sqlx::query_as::<_, SubmissionFileRow>(
        "SELECT r.id AS resource_id, r.name, r.size_bytes, r.mime_type, r.sha256,
                'attachment' AS purpose, f.sort_order
         FROM homework_submission_files f
         JOIN resources r ON r.id = f.resource_id
         WHERE f.submission_id = ?1
         ORDER BY f.sort_order ASC, r.id ASC",
    )
    .bind(id)
    .fetch_all(&state.db)
    .await?;

    // 用途按实际文件名与 MIME 现算，历史数据也能正确预览。
    let files: Vec<SubmissionFileRow> = files
        .into_iter()
        .map(|mut row| {
            row.purpose = infer_purpose(&row.mime_type, &row.name).to_string();
            if with_preview_tickets {
                row.preview_ticket =
                    crate::auth::issue_preview_ticket(&state.config, row.resource_id).ok();
            }
            row
        })
        .collect();

    let duplicate_of_name = match submission.duplicate_of {
        Some(original) => {
            sqlx::query_scalar::<_, String>(
                "SELECT student_name FROM homework_submissions WHERE id = ?1",
            )
            .bind(original)
            .fetch_optional(&state.db)
            .await?
        }
        None => None,
    };

    Ok(SubmissionDetailView {
        submission,
        files,
        duplicate_of_name,
    })
}

/// 统计某课时的审阅分布。
///
/// `class_id` 为 `None` 时跨班统计。`missing` 只在指定班级且该班有名单时才有意义，
/// 无名单时保持 0，避免前端把「没名单」显示成「全班都没交」。
pub(crate) async fn collect_review_stats(
    state: &AppState,
    lesson_id: i64,
    class_id: Option<i64>,
) -> AppResult<crate::models::ReviewStats> {
    let rows: Vec<(String, Option<f64>)> = sqlx::query_as(
        "SELECT review_label, review_score FROM homework_submissions
         WHERE lesson_id = ?1 AND (?2 IS NULL OR class_id = ?2)
           AND withdrawn_at IS NULL",
    )
    .bind(lesson_id)
    .bind(class_id)
    .fetch_all(&state.db)
    .await?;

    let mut stats = crate::models::ReviewStats::default();
    for (label, score) in rows {
        stats.count_label(&label);
        stats.add_score(score);
    }

    // 未交人数复用名单统计口径：按学号匹配，无学号时按姓名
    if let Some(class_id) = class_id {
        let roster_total: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM class_students WHERE class_id = ?1")
                .bind(class_id)
                .fetch_one(&state.db)
                .await?;
        if roster_total > 0 {
            let submitted: i64 =
                crate::routes::students::count_roster_submitters(state, lesson_id, class_id)
                    .await?;
            stats.missing = (roster_total - submitted).max(0);
        }
    }

    stats.finish();
    Ok(stats)
}
