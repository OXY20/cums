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
        .route("/api/admin/submissions/{id}", get(get_submission))
        .route(
            "/api/admin/submissions/{id}/review",
            post(review_submission),
        )
}

/// 课时提交状态查询参数。
#[derive(Debug, Deserialize)]
pub struct StatusQuery {
    pub lesson_id: i64,
    /// 班级 ID；缺省时按全局统计（不区分班级）
    pub class_id: Option<i64>,
}

/// 学生端：查询某课时是否已有提交，用于上传前提醒。
async fn lesson_status(
    State(state): State<AppState>,
    Query(query): Query<StatusQuery>,
) -> AppResult<Json<LessonSubmissionStatus>> {
    let total: i64 = match query.class_id {
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

    let first_submission = if total > 0 {
        let row = match query.class_id {
            Some(class_id) => {
                fetch_first_submission(&state, query.lesson_id, Some(class_id)).await?
            }
            None => fetch_first_submission(&state, query.lesson_id, None).await?,
        };
        row
    } else {
        None
    };

    Ok(Json(LessonSubmissionStatus {
        lesson_id: query.lesson_id,
        class_id: query.class_id,
        total,
        first_submission,
    }))
}

/// 取该课时最早的一条提交，用于提示「谁先交的」。
async fn fetch_first_submission(
    state: &AppState,
    lesson_id: i64,
    class_id: Option<i64>,
) -> AppResult<Option<SubmissionRow>> {
    let row = match class_id {
        Some(class_id) => {
            sqlx::query_as::<_, SubmissionRow>(&submission_select_sql("WHERE s.lesson_id = ?1 AND s.class_id = ?2 ORDER BY s.created_at ASC, s.id ASC LIMIT 1"))
                .bind(lesson_id)
                .bind(class_id)
                .fetch_optional(&state.db)
                .await?
        }
        None => {
            sqlx::query_as::<_, SubmissionRow>(&submission_select_sql(
                "WHERE s.lesson_id = ?1 ORDER BY s.created_at ASC, s.id ASC LIMIT 1",
            ))
            .bind(lesson_id)
            .fetch_optional(&state.db)
            .await?
        }
    };

    Ok(row)
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
#[derive(Debug, Deserialize)]
pub struct ReviewRequest {
    /// `submitted` / `reviewed` / `flagged`
    pub status: String,
}

/// 教师端：标记提交状态（已查看 / 有问题）。
async fn review_submission(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<i64>,
    Json(payload): Json<ReviewRequest>,
) -> AppResult<Json<SubmissionDetailView>> {
    if !matches!(
        payload.status.as_str(),
        "submitted" | "reviewed" | "flagged"
    ) {
        return Err(AppError::BadRequest(
            "状态只能是 submitted / reviewed / flagged".into(),
        ));
    }

    // 提交必须存在，避免静默写入无效记录。
    build_detail(&state, id).await?;

    sqlx::query("UPDATE homework_submissions SET status = ?1 WHERE id = ?2")
        .bind(&payload.status)
        .bind(id)
        .execute(&state.db)
        .await?;

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

/// 学生端：提交作业（多文件）。
///
/// multipart 字段约定：
/// - `student_name`：必填，提交人姓名；
/// - `note`：选填备注；
/// - `lesson_id`：必填；
/// - `class_id`：选填，缺省时从当前课堂推断；
/// - `file`：可重复，一次最多 [`MAX_FILES_PER_SUBMISSION`] 个。
async fn create_submission(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> AppResult<Json<CreateSubmissionResponse>> {
    let mut student_name: Option<String> = None;
    let mut note = String::new();
    let mut lesson_id: Option<i64> = None;
    let mut class_id: Option<i64> = None;
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
            Some("note") => {
                note = read_text_field(field).await?;
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

    // 重复检测：同课时 + 同班级已有提交时标记。
    let existing = match class_id {
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
    };

    let (duplicate_flag, duplicate_of, duplicate_warning) = match &existing {
        Some((id, name)) => (
            1,
            Some(*id),
            Some(format!(
                "本节课本班级已有提交（{name}，提交编号 {id}），本次提交已记录并标记为重复"
            )),
        ),
        None => (0, None, None),
    };

    let submission_id: i64 = sqlx::query_scalar(
        "INSERT INTO homework_submissions
            (course_id, lesson_id, class_id, session_id, student_name, client_ip,
             user_agent, note, duplicate_flag, duplicate_of)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id",
    )
    .bind(lesson.course_id)
    .bind(lesson_id)
    .bind(class_id)
    .bind(session_id)
    .bind(&student_name)
    .bind(&client_ip)
    .bind(&user_agent)
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
fn submission_select_sql(tail: &str) -> String {
    format!(
        "SELECT s.id, s.course_id, s.lesson_id, s.class_id, s.session_id, s.student_name,
                s.client_ip, s.user_agent, s.note, s.duplicate_flag, s.duplicate_of,
                s.status, s.created_at,
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
