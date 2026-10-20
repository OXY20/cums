//! 班级学生名单与作业提交统计。
//!
//! 教师导入名单（学号 + 姓名）后，系统才能回答「这次作业谁没交」。
//! 提交记录通过 `student_no` 与名单对应；历史数据没有学号时退回姓名匹配。

use crate::error::{AppError, AppResult};
use crate::models::{
    ClassStudent, CourseHomeworkOverview, ImportStudentsResult, InvalidStudentRow,
    LessonHomeworkSummary, LessonSubmissionBoard, ListResponse, MissingStudent,
    StudentSubmissionState,
};
use crate::routes::AuthUser;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        // 班级名单
        .route(
            "/api/classes/{id}/students",
            get(list_students).post(add_student),
        )
        .route("/api/classes/{id}/students/import", post(import_students))
        .route(
            "/api/classes/{id}/students/{student_id}",
            delete(remove_student),
        )
        // 作业统计
        .route(
            "/api/courses/{id}/homework-overview",
            get(course_homework_overview),
        )
        .route(
            "/api/lessons/{id}/submission-board",
            get(lesson_submission_board),
        )
        // 作业审阅看板
        .route("/api/lessons/{id}/review-board", get(lesson_review_board))
}

// ---------------------------------------------------------------------------
// 学生名单
// ---------------------------------------------------------------------------

/// 名单列表。
async fn list_students(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(class_id): Path<i64>,
) -> AppResult<Json<ListResponse<ClassStudent>>> {
    crate::routes::classes::fetch_class(&state, class_id).await?;

    let rows = sqlx::query_as::<_, ClassStudent>(
        "SELECT id, class_id, student_no, student_name, created_at
         FROM class_students WHERE class_id = ?1
         ORDER BY student_no ASC",
    )
    .bind(class_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(ListResponse::new(rows)))
}

/// 新增单个学生。
#[derive(Debug, Deserialize)]
pub struct AddStudentRequest {
    pub student_no: String,
    pub student_name: String,
}

async fn add_student(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(class_id): Path<i64>,
    Json(payload): Json<AddStudentRequest>,
) -> AppResult<Json<ClassStudent>> {
    crate::routes::classes::fetch_class(&state, class_id).await?;

    let student_no = payload.student_no.trim();
    let student_name = payload.student_name.trim();
    if student_no.is_empty() {
        return Err(AppError::BadRequest("学号不能为空".into()));
    }
    if student_name.is_empty() {
        return Err(AppError::BadRequest("姓名不能为空".into()));
    }

    // 学号已存在时更新姓名，避免重复添加产生两条记录
    sqlx::query(
        "INSERT INTO class_students (class_id, student_no, student_name)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(class_id, student_no) DO UPDATE SET student_name = excluded.student_name",
    )
    .bind(class_id)
    .bind(student_no)
    .bind(student_name)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, ClassStudent>(
        "SELECT id, class_id, student_no, student_name, created_at
         FROM class_students WHERE class_id = ?1 AND student_no = ?2",
    )
    .bind(class_id)
    .bind(student_no)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(row))
}

/// 批量导入请求。
#[derive(Debug, Deserialize)]
pub struct ImportStudentsRequest {
    /// 多行文本，每行「学号 姓名」或「学号,姓名」或「学号\t姓名」
    pub text: String,
    /// 为真时先清空该班级原名单再导入（用于整班替换）
    #[serde(default)]
    pub replace: bool,
}

/// 批量导入名单。
///
/// 解析规则（按现实场景尽量宽容）：
/// - 每行一条，学号与姓名之间可用空格、Tab、逗号、中文逗号分隔；
/// - 忽略空行与以 `#` 开头的注释行；
/// - 自动跳过表头（首行若含「学号」「姓名」等字样）；
/// - 学号已存在时更新姓名而不是报错。
async fn import_students(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(class_id): Path<i64>,
    Json(payload): Json<ImportStudentsRequest>,
) -> AppResult<Json<ImportStudentsResult>> {
    crate::routes::classes::fetch_class(&state, class_id).await?;

    let parsed = parse_roster(&payload.text);

    if payload.replace {
        sqlx::query("DELETE FROM class_students WHERE class_id = ?1")
            .bind(class_id)
            .execute(&state.db)
            .await?;
    }

    let mut inserted = 0i64;
    let mut updated = 0i64;

    for entry in &parsed.valid {
        // 先查是否存在，用于区分「新增」与「更新」的统计口径
        let existed: Option<i64> = sqlx::query_scalar(
            "SELECT id FROM class_students WHERE class_id = ?1 AND student_no = ?2",
        )
        .bind(class_id)
        .bind(&entry.student_no)
        .fetch_optional(&state.db)
        .await?;

        sqlx::query(
            "INSERT INTO class_students (class_id, student_no, student_name)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(class_id, student_no) DO UPDATE SET student_name = excluded.student_name",
        )
        .bind(class_id)
        .bind(&entry.student_no)
        .bind(&entry.student_name)
        .execute(&state.db)
        .await?;

        if existed.is_some() {
            updated += 1;
        } else {
            inserted += 1;
        }
    }

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM class_students WHERE class_id = ?1")
        .bind(class_id)
        .fetch_one(&state.db)
        .await?;

    crate::routes::auth::audit(
        &state,
        None,
        "class.students.import",
        "class",
        &class_id.to_string(),
    )
    .await;

    Ok(Json(ImportStudentsResult {
        inserted,
        updated,
        invalid: parsed.invalid,
        total,
    }))
}

/// 删除名单中的一个学生。
async fn remove_student(
    State(state): State<AppState>,
    _user: AuthUser,
    Path((class_id, student_id)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    let affected = sqlx::query("DELETE FROM class_students WHERE id = ?1 AND class_id = ?2")
        .bind(student_id)
        .bind(class_id)
        .execute(&state.db)
        .await?
        .rows_affected();

    if affected == 0 {
        return Err(AppError::NotFound(format!("学生 {student_id}")));
    }

    Ok(Json(serde_json::json!({ "ok": true })))
}

/// 解析后的一条有效名单。
struct ParsedStudent {
    student_no: String,
    student_name: String,
}

struct ParsedRoster {
    valid: Vec<ParsedStudent>,
    invalid: Vec<InvalidStudentRow>,
}

/// 解析粘贴进来的名单文本。
///
/// 机房场景下教师通常从 Excel 复制两列粘贴进来，分隔符可能是 Tab，
/// 也可能手动敲成空格或逗号，这里统一处理。
fn parse_roster(text: &str) -> ParsedRoster {
    let mut valid: Vec<ParsedStudent> = Vec::new();
    let mut invalid: Vec<InvalidStudentRow> = Vec::new();
    // 同一批里学号重复时只保留最后一条，避免自己和自己冲突
    let mut seen: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        // 拆分成字段：优先 Tab，其次逗号（中英文），最后按空白
        let parts: Vec<&str> = if line.contains('\t') {
            line.split('\t').collect()
        } else if line.contains(',') || line.contains('，') {
            line.split([',', '，']).collect()
        } else {
            line.split_whitespace().collect()
        };

        let fields: Vec<&str> = parts
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        // 跳过表头行
        if fields.len() >= 2
            && (fields[0].contains("学号") || fields[1].contains("姓名") || fields[0] == "no")
        {
            continue;
        }

        if fields.len() < 2 {
            invalid.push(InvalidStudentRow {
                line: line_no,
                raw: raw_line.to_string(),
                reason: "需要「学号 姓名」两列".into(),
            });
            continue;
        }

        let student_no = fields[0].to_string();
        let student_name = fields[1].to_string();

        // 学号通常是纯数字或字母数字组合，过长或含奇怪字符多半是粘错了列
        if student_no.chars().count() > 32 || student_name.chars().count() > 32 {
            invalid.push(InvalidStudentRow {
                line: line_no,
                raw: raw_line.to_string(),
                reason: "学号或姓名过长，可能粘错了列".into(),
            });
            continue;
        }

        if let Some(prev) = seen.get(&student_no) {
            // 同批次重复：覆盖前一条，并在无效列表里提示
            valid[*prev] = ParsedStudent {
                student_no: student_no.clone(),
                student_name,
            };
            invalid.push(InvalidStudentRow {
                line: line_no,
                raw: raw_line.to_string(),
                reason: "学号在本批次内重复，已采用最后一条".into(),
            });
            continue;
        }

        seen.insert(student_no.clone(), valid.len());
        valid.push(ParsedStudent {
            student_no,
            student_name,
        });
    }

    ParsedRoster { valid, invalid }
}

// ---------------------------------------------------------------------------
// 作业统计
// ---------------------------------------------------------------------------

/// 课程作业总览查询参数。
#[derive(Debug, Deserialize)]
pub struct OverviewQuery {
    /// 指定班级；缺省时跨班汇总
    pub class_id: Option<i64>,
}

/// 课程作业总览：每个课时交了多少、还差多少。
///
/// 这是教师打开课程详情时最关心的视图：一门课教了几节课、
/// 每节课的作业收齐了没有。
async fn course_homework_overview(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(course_id): Path<i64>,
    axum::extract::Query(query): axum::extract::Query<OverviewQuery>,
) -> AppResult<Json<CourseHomeworkOverview>> {
    let course_title: String = sqlx::query_scalar("SELECT title FROM courses WHERE id = ?1")
        .bind(course_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("课程 {course_id}")))?;

    let class_name = match query.class_id {
        Some(class_id) => Some(
            sqlx::query_scalar::<_, String>("SELECT name FROM classes WHERE id = ?1")
                .bind(class_id)
                .fetch_optional(&state.db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("班级 {class_id}")))?,
        ),
        None => None,
    };

    let roster_total: i64 = match query.class_id {
        Some(class_id) => {
            sqlx::query_scalar("SELECT COUNT(*) FROM class_students WHERE class_id = ?1")
                .bind(class_id)
                .fetch_one(&state.db)
                .await?
        }
        None => 0,
    };

    let lessons = sqlx::query_as::<_, (i64, String, i64)>(
        "SELECT id, title, sort_order FROM lessons WHERE course_id = ?1 ORDER BY sort_order ASC, id ASC",
    )
    .bind(course_id)
    .fetch_all(&state.db)
    .await?;

    let mut summaries = Vec::with_capacity(lessons.len());

    for (lesson_id, lesson_title, sort_order) in lessons {
        // 提交份数、去重人数、重复份数
        let (submitted_count, submitter_count, duplicate_count): (i64, i64, i64) =
            match query.class_id {
                Some(class_id) => {
                    let total: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM homework_submissions
                     WHERE lesson_id = ?1 AND class_id = ?2",
                    )
                    .bind(lesson_id)
                    .bind(class_id)
                    .fetch_one(&state.db)
                    .await?;

                    // 去重人数：有学号按学号，没有学号按姓名
                    let distinct: i64 = sqlx::query_scalar(
                        "SELECT COUNT(DISTINCT CASE
                         WHEN student_no <> '' THEN 'no:' || student_no
                         ELSE 'name:' || TRIM(student_name)
                     END)
                     FROM homework_submissions
                     WHERE lesson_id = ?1 AND class_id = ?2",
                    )
                    .bind(lesson_id)
                    .bind(class_id)
                    .fetch_one(&state.db)
                    .await?;

                    let dup: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM homework_submissions
                     WHERE lesson_id = ?1 AND class_id = ?2 AND duplicate_flag = 1",
                    )
                    .bind(lesson_id)
                    .bind(class_id)
                    .fetch_one(&state.db)
                    .await?;

                    (total, distinct, dup)
                }
                None => {
                    let total: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM homework_submissions WHERE lesson_id = ?1",
                    )
                    .bind(lesson_id)
                    .fetch_one(&state.db)
                    .await?;

                    let distinct: i64 = sqlx::query_scalar(
                        "SELECT COUNT(DISTINCT CASE
                         WHEN student_no <> '' THEN 'no:' || student_no
                         ELSE 'name:' || TRIM(student_name)
                     END)
                     FROM homework_submissions WHERE lesson_id = ?1",
                    )
                    .bind(lesson_id)
                    .fetch_one(&state.db)
                    .await?;

                    let dup: i64 = sqlx::query_scalar(
                        "SELECT COUNT(*) FROM homework_submissions
                     WHERE lesson_id = ?1 AND duplicate_flag = 1",
                    )
                    .bind(lesson_id)
                    .fetch_one(&state.db)
                    .await?;

                    (total, distinct, dup)
                }
            };

        // 未交人数：名单人数 - 名单内已交人数（只算名单内的人）
        let missing_count = if roster_total > 0 {
            let submitted_in_roster = match query.class_id {
                Some(class_id) => count_roster_submitters(&state, lesson_id, class_id).await?,
                None => 0,
            };
            (roster_total - submitted_in_roster).max(0)
        } else {
            0
        };

        summaries.push(LessonHomeworkSummary {
            lesson_id,
            lesson_title,
            sort_order,
            submitted_count,
            submitter_count,
            duplicate_count,
            missing_count,
        });
    }

    // 这门课用过的班级：授课记录与提交记录都算，去重后按 ID 排序。
    // 前端据此在只有一个班时自动选中，避免「明明只有一个班还要手选一次」。
    let used_class_ids: Vec<i64> = sqlx::query_scalar(
        "SELECT class_id FROM (
             SELECT class_id FROM homework_submissions
             WHERE course_id = ?1 AND class_id IS NOT NULL
             UNION
             SELECT cs.class_id FROM classroom_sessions cs
             JOIN lessons l ON l.id = cs.lesson_id
             WHERE l.course_id = ?1
         )
         GROUP BY class_id
         ORDER BY class_id",
    )
    .bind(course_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(CourseHomeworkOverview {
        course_id,
        course_title,
        class_id: query.class_id,
        class_name,
        roster_total,
        used_class_ids,
        lessons: summaries,
    }))
}

/// 统计名单内已提交的人数。
///
/// 匹配优先级：学号相同 → 学号为空时姓名相同。
/// 这样历史数据（没有学号）也能被正确计入，不至于把已交的人算成未交。
pub(crate) async fn count_roster_submitters(
    state: &AppState,
    lesson_id: i64,
    class_id: i64,
) -> AppResult<i64> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM class_students s
         WHERE s.class_id = ?2
           AND EXISTS (
               SELECT 1 FROM homework_submissions h
               WHERE h.lesson_id = ?1
                 AND h.class_id = ?2
                 AND (
                     (h.student_no <> '' AND h.student_no = s.student_no)
                     OR (h.student_no = '' AND TRIM(h.student_name) = TRIM(s.student_name))
                 )
           )",
    )
    .bind(lesson_id)
    .bind(class_id)
    .fetch_one(&state.db)
    .await?;

    Ok(count)
}

/// 课时提交看板查询参数。
#[derive(Debug, Deserialize)]
pub struct BoardQuery {
    pub class_id: Option<i64>,
}

/// 某课时的提交看板：谁交了、谁没交、谁是名单外的。
///
/// 教师最常用的动作是「把未交名单复制到群里催」，
/// 因此这里把三类人分开返回，前端可直接展示与复制。
async fn lesson_submission_board(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(lesson_id): Path<i64>,
    axum::extract::Query(query): axum::extract::Query<BoardQuery>,
) -> AppResult<Json<LessonSubmissionBoard>> {
    let (course_id, lesson_title): (i64, String) =
        sqlx::query_as("SELECT course_id, title FROM lessons WHERE id = ?1")
            .bind(lesson_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("课时 {lesson_id}")))?;

    let course_title: String = sqlx::query_scalar("SELECT title FROM courses WHERE id = ?1")
        .bind(course_id)
        .fetch_one(&state.db)
        .await?;

    let class_name = match query.class_id {
        Some(class_id) => Some(
            sqlx::query_scalar::<_, String>("SELECT name FROM classes WHERE id = ?1")
                .bind(class_id)
                .fetch_optional(&state.db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("班级 {class_id}")))?,
        ),
        None => None,
    };

    // 该课时的全部提交
    let submissions = sqlx::query_as::<_, crate::models::SubmissionRow>(
        "SELECT s.id, s.course_id, s.lesson_id, s.class_id, s.session_id, s.student_name,
                s.student_no, s.client_ip, s.user_agent, s.device_id, s.note,
                s.duplicate_flag, s.duplicate_of, s.status, s.created_at,
                NULL AS course_title, NULL AS lesson_title, NULL AS class_name, 0 AS file_count
         FROM homework_submissions s
         WHERE s.lesson_id = ?1
           AND (?2 IS NULL OR s.class_id = ?2)
         ORDER BY s.created_at DESC, s.id DESC",
    )
    .bind(lesson_id)
    .bind(query.class_id)
    .fetch_all(&state.db)
    .await?;

    // 名单
    let roster: Vec<ClassStudent> = match query.class_id {
        Some(class_id) => {
            sqlx::query_as::<_, ClassStudent>(
                "SELECT id, class_id, student_no, student_name, created_at
                 FROM class_students WHERE class_id = ?1 ORDER BY student_no ASC",
            )
            .bind(class_id)
            .fetch_all(&state.db)
            .await?
        }
        None => Vec::new(),
    };

    let roster_total = roster.len() as i64;

    // 把提交按「学号」或「姓名」归并到学生，取最近一次
    let mut submitted: Vec<StudentSubmissionState> = Vec::new();
    let mut missing: Vec<MissingStudent> = Vec::new();
    let mut unlisted: Vec<StudentSubmissionState> = Vec::new();

    // 已匹配到名单的学号集合
    let mut matched: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 按 key 聚合提交份数
    let mut aggregated: std::collections::HashMap<String, StudentSubmissionState> =
        std::collections::HashMap::new();

    for row in &submissions {
        let key = if row.student_no.is_empty() {
            format!("name:{}", row.student_name.trim())
        } else {
            format!("no:{}", row.student_no)
        };

        match aggregated.get_mut(&key) {
            Some(existing) => {
                existing.submission_count += 1;
                if row.duplicate_flag == 1 {
                    existing.has_duplicate = true;
                }
                // 已按时间倒序，保留第一条即为最近
            }
            None => {
                aggregated.insert(
                    key.clone(),
                    StudentSubmissionState {
                        student_no: row.student_no.clone(),
                        student_name: row.student_name.clone(),
                        submission_count: 1,
                        latest_at: row.created_at.clone(),
                        latest_submission_id: row.id,
                        has_duplicate: row.duplicate_flag == 1,
                        client_ip: row.client_ip.clone(),
                        status: row.status.clone(),
                    },
                );
            }
        }
    }

    // 名单内的人：已交进 submitted，未交进 missing
    for student in &roster {
        let by_no = format!("no:{}", student.student_no);
        let by_name = format!("name:{}", student.student_name.trim());

        if let Some(state) = aggregated.remove(&by_no) {
            matched.insert(student.student_no.clone());
            submitted.push(state);
        } else if let Some(state) = aggregated.remove(&by_name) {
            matched.insert(student.student_no.clone());
            submitted.push(state);
        } else {
            missing.push(MissingStudent {
                student_no: student.student_no.clone(),
                student_name: student.student_name.clone(),
            });
        }
    }

    // 剩下的是名单外的提交者
    unlisted.extend(aggregated.into_values());

    // 已交按学号排序，便于对照名单
    submitted.sort_by(|a, b| {
        a.student_no
            .cmp(&b.student_no)
            .then(a.student_name.cmp(&b.student_name))
    });

    Ok(Json(LessonSubmissionBoard {
        lesson_id,
        lesson_title,
        course_id,
        course_title,
        class_id: query.class_id,
        class_name,
        roster_total,
        submitted,
        missing,
        unlisted,
    }))
}

/// 课时审阅看板：按提交粒度展开，供教师逐份或批量批改。
///
/// 与 [`lesson_submission_board`] 的分工：
/// - 提交看板回答「谁没交」，按学生聚合，一个学生只出现一次；
/// - 审阅看板回答「这一份打什么标签」，按提交展开，交两次就是两行。
///
/// 一个学生多次提交时，教师需要分别评价，因此这里**不做聚合**。
async fn lesson_review_board(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(lesson_id): Path<i64>,
    axum::extract::Query(query): axum::extract::Query<BoardQuery>,
) -> AppResult<Json<crate::models::LessonReviewBoard>> {
    let (course_id, lesson_title): (i64, String) =
        sqlx::query_as("SELECT course_id, title FROM lessons WHERE id = ?1")
            .bind(lesson_id)
            .fetch_optional(&state.db)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("课时 {lesson_id}")))?;

    let course_title: String = sqlx::query_scalar("SELECT title FROM courses WHERE id = ?1")
        .bind(course_id)
        .fetch_one(&state.db)
        .await?;

    let class_name = match query.class_id {
        Some(class_id) => Some(
            sqlx::query_scalar::<_, String>("SELECT name FROM classes WHERE id = ?1")
                .bind(class_id)
                .fetch_optional(&state.db)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("班级 {class_id}")))?,
        ),
        None => None,
    };

    let roster_total = match query.class_id {
        Some(class_id) => {
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM class_students WHERE class_id = ?1")
                .bind(class_id)
                .fetch_one(&state.db)
                .await?
        }
        None => 0,
    };

    // 复用提交列表的 SELECT，保证字段与详情接口完全一致
    let rows = sqlx::query_as::<_, crate::models::SubmissionRow>(
        &crate::routes::submissions::submission_select_sql(
            "WHERE s.lesson_id = ?1 AND (?2 IS NULL OR s.class_id = ?2)
             ORDER BY s.created_at DESC, s.id DESC",
        ),
    )
    .bind(lesson_id)
    .bind(query.class_id)
    .fetch_all(&state.db)
    .await?;

    // 逐份补文件清单：教师批改时要直接看到内容，不能只给文件名
    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        items.push(crate::routes::submissions::build_detail_from(&state, row).await?);
    }

    let stats =
        crate::routes::submissions::collect_review_stats(&state, lesson_id, query.class_id).await?;

    Ok(Json(crate::models::LessonReviewBoard {
        lesson_id,
        lesson_title,
        course_id,
        course_title,
        class_id: query.class_id,
        class_name,
        roster_total,
        stats,
        items,
    }))
}
