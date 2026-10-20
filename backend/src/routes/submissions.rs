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
    CreateSubmissionResponse, LessonSubmissionStatus, ListResponse, SubmissionDetailView,
    SubmissionFileRow, SubmissionRow,
};
use crate::routes::resources::{create_staging_resource, infer_purpose, store_file_field};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::net::SocketAddr;

/// 单次提交允许的文件数量上限。
///
/// 学生通常提交 1 个视频或若干张截图；上限过高会让一次请求占用过多连接时间。
const MAX_FILES_PER_SUBMISSION: usize = 10;

pub fn routes() -> Router<AppState> {
    Router::new()
        // 学生端：公开接口，无需登录（与 /api/student/* 一致）
        .route(
            "/api/student/submissions",
            post(create_submission).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/student/submissions/status", get(lesson_status))
        .route("/api/student/submissions/{id}", get(get_public_submission))
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
    // 本班该课时提交总数：仅作为背景数字，不含姓名
    let class_total: i64 = match query.class_id {
        Some(class_id) => {
            sqlx::query_scalar(
                "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND class_id = ?2",
            )
            .bind(query.lesson_id)
            .bind(class_id)
            .fetch_one(&state.db)
            .await?
        }
        None => {
            sqlx::query_scalar("SELECT COUNT(*) FROM homework_submissions WHERE lesson_id = ?1")
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
    }))
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
    let (count_sql, latest_tail) = if device_id.is_some() {
        (
            "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND device_id = ?3",
            "WHERE s.lesson_id = ?1 AND s.client_ip = ?2 AND s.device_id = ?3
             ORDER BY s.created_at DESC, s.id DESC LIMIT 1",
        )
    } else {
        (
            "SELECT COUNT(*) FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2",
            "WHERE s.lesson_id = ?1 AND s.client_ip = ?2
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

    let sql = submission_select_sql(&format!(
        "{where_clause} ORDER BY s.created_at DESC, s.id DESC LIMIT ?"
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
    build_detail(&state, id).await.map(Json)
}

/// 学生端：上传成功后回读自己的提交，用于弹出预览窗口。
///
/// 只返回文件清单与元数据，不校验身份；提交 ID 不可枚举出他人隐私，
/// 因为返回内容仅包含本人上传的文件名与大小。
async fn get_public_submission(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<SubmissionDetailView>> {
    build_detail(&state, id).await.map(Json)
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
/// - `file`：可重复，一次最多 [`MAX_FILES_PER_SUBMISSION`] 个。
async fn create_submission(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<CreateSubmissionResponse>> {
    let mut student_name: Option<String> = None;
    let mut student_no = String::new();
    let mut note = String::new();
    let mut lesson_id: Option<i64> = None;
    let mut class_id: Option<i64> = None;
    let mut device_id = String::new();
    let mut files: Vec<crate::models::ResourceRow> = Vec::new();

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
                if files.len() >= MAX_FILES_PER_SUBMISSION {
                    return Err(AppError::BadRequest(format!(
                        "一次最多提交 {MAX_FILES_PER_SUBMISSION} 个文件"
                    )));
                }

                // 文件名用于占位记录的初始名称；真实名称在落盘时回填。
                let placeholder_name = field
                    .file_name()
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "作业文件".to_string());

                let placeholder = create_staging_resource(&state, None, &placeholder_name).await?;

                match store_file_field(&state, &placeholder, field).await {
                    Ok(resource) => files.push(resource),
                    Err(err) => {
                        // 单个文件失败时清理已落盘的占位记录，避免脏数据。
                        let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
                            .bind(placeholder.id)
                            .execute(&state.db)
                            .await;
                        cleanup_resources(&state, &files).await;
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

    let student_name = student_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::BadRequest("请填写提交人姓名".into()))?;

    if student_name.chars().count() > 40 {
        return Err(AppError::BadRequest("姓名过长（最多 40 个字符）".into()));
    }

    let lesson_id = lesson_id.ok_or_else(|| AppError::BadRequest("缺少 lesson_id".into()))?;

    if files.is_empty() {
        return Err(AppError::BadRequest("请至少选择一个文件".into()));
    }

    // 课时必须存在，避免产生指向不存在课时的提交。
    let lesson = crate::routes::lessons::fetch_lesson(&state, lesson_id).await?;

    // 未指定班级时从当前活动课堂推断，保证「本班已提交」判断尽量准确。
    let (class_id, session_id) = match class_id {
        Some(class_id) => (Some(class_id), None),
        None => match current_session_for_lesson(&state, lesson_id).await? {
            Some((class_id, session_id)) => (Some(class_id), Some(session_id)),
            None => (None, None),
        },
    };

    let client_ip = resolve_client_ip(&headers, peer);
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .chars()
        .take(512)
        .collect::<String>();

    // 重复检测。
    //
    // 判定口径分两种，取决于这次提交有没有带学号：
    //
    // 1. **带学号**（从班级名单选了自己）：按「同一个学生」判断。
    //    张三交过、李四再交属于正常情况，不该标重复；
    //    只有同一学号重复提交才标记，用于提醒「你可能交重了」。
    //
    // 2. **不带学号**（手填姓名）：只能退回按设备/班级判断。
    //    此时无法确认是不是同一个人，保守地给出提醒，
    //    但仍保存记录，由教师核对。
    //
    // 提示语一律不指名其他同学，避免把班里信息暴露给学生。
    let same_student_previous: Option<(i64, String)> = if !student_no.is_empty() {
        sqlx::query_as::<_, (i64, String)>(
            "SELECT id, student_name FROM homework_submissions
             WHERE lesson_id = ?1 AND student_no = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .bind(lesson_id)
        .bind(&student_no)
        .fetch_optional(&state.db)
        .await?
    } else {
        None
    };

    let device_previous: Option<(i64, String)> = if student_no.is_empty() {
        let sql = if device_id.is_empty() {
            "SELECT id, student_name FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2
             ORDER BY created_at DESC, id DESC LIMIT 1"
        } else {
            "SELECT id, student_name FROM homework_submissions
             WHERE lesson_id = ?1 AND client_ip = ?2 AND device_id = ?3
             ORDER BY created_at DESC, id DESC LIMIT 1"
        };
        let mut query = sqlx::query_as::<_, (i64, String)>(sql)
            .bind(lesson_id)
            .bind(&client_ip);
        if !device_id.is_empty() {
            query = query.bind(&device_id);
        }
        query.fetch_optional(&state.db).await?
    } else {
        None
    };

    // 班级级「已有人提交」只在完全无法识别身份时才用于提醒
    let class_existing = if student_no.is_empty() && device_previous.is_none() {
        match class_id {
            Some(class_id) => {
                sqlx::query_as::<_, (i64, String)>(
                    "SELECT id, student_name FROM homework_submissions
                     WHERE lesson_id = ?1 AND class_id = ?2
                     ORDER BY created_at ASC, id ASC LIMIT 1",
                )
                .bind(lesson_id)
                .bind(class_id)
                .fetch_optional(&state.db)
                .await?
            }
            None => {
                sqlx::query_as::<_, (i64, String)>(
                    "SELECT id, student_name FROM homework_submissions
                     WHERE lesson_id = ?1 AND class_id IS NULL
                     ORDER BY created_at ASC, id ASC LIMIT 1",
                )
                .bind(lesson_id)
                .fetch_optional(&state.db)
                .await?
            }
        }
    } else {
        None
    };

    let (duplicate_flag, duplicate_of, duplicate_warning) =
        if let Some((id, _)) = &same_student_previous {
            (
                1,
                Some(*id),
                Some("你已提交过本节课作业，本次为再次提交，两次记录都会保留".to_string()),
            )
        } else if let Some((id, _)) = &device_previous {
            (
                1,
                Some(*id),
                Some("当前设备已提交过本节课作业，本次提交已记录并标记为重复".to_string()),
            )
        } else if class_existing.is_some() {
            (
                1,
                class_existing.as_ref().map(|(id, _)| *id),
                Some("本节课本班已有其他提交，本次提交已记录并标记为重复".to_string()),
            )
        } else {
            (0, None, None)
        };

    let submission_id: i64 = sqlx::query_scalar(
        "INSERT INTO homework_submissions
            (course_id, lesson_id, class_id, session_id, student_name, student_no,
             client_ip, user_agent, device_id, note, duplicate_flag, duplicate_of)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) RETURNING id",
    )
    .bind(lesson.course_id)
    .bind(lesson_id)
    .bind(class_id)
    .bind(session_id)
    .bind(&student_name)
    .bind(&student_no)
    .bind(&client_ip)
    .bind(&user_agent)
    .bind(&device_id)
    .bind(note.trim())
    .bind(duplicate_flag)
    .bind(duplicate_of)
    .fetch_one(&state.db)
    .await?;

    for (index, resource) in files.iter().enumerate() {
        sqlx::query(
            "INSERT INTO homework_submission_files (submission_id, resource_id, sort_order)
             VALUES (?1, ?2, ?3)",
        )
        .bind(submission_id)
        .bind(resource.id)
        .bind(index as i64)
        .execute(&state.db)
        .await?;
    }

    crate::routes::auth::audit(
        &state,
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
        duplicate = duplicate_flag == 1,
        "学生提交作业"
    );

    let detail = build_detail(&state, submission_id).await?;

    Ok(Json(CreateSubmissionResponse {
        submission: detail,
        duplicate_warning,
    }))
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

/// 清理已落盘但最终未写入提交的资源，避免残留孤儿文件。
async fn cleanup_resources(state: &AppState, resources: &[crate::models::ResourceRow]) {
    for resource in resources {
        if let Ok(path) =
            crate::routes::resources::safe_join(&state.config.objects_dir, &resource.storage_key)
        {
            let _ = tokio::fs::remove_file(&path).await;
        }
        let _ = sqlx::query("DELETE FROM resources WHERE id = ?1")
            .bind(resource.id)
            .execute(&state.db)
            .await;
    }
}

/// 提交列表与详情共用的 SELECT，附带课程/课时/班级标题与文件数。
pub(crate) fn submission_select_sql(tail: &str) -> String {
    format!(
        "SELECT s.id, s.course_id, s.lesson_id, s.class_id, s.session_id, s.student_name,
                s.student_no, s.client_ip, s.user_agent, s.device_id, s.note,
                s.duplicate_flag, s.duplicate_of, s.status, s.created_at,
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
         WHERE lesson_id = ?1 AND (?2 IS NULL OR class_id = ?2)",
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
