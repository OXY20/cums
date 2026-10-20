use actix_files::NamedFile;
use actix_multipart::Multipart;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use chrono::Local;
use futures_util::StreamExt;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::{Cursor, Read, Seek, Write};
use std::path::PathBuf;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::ZipArchive;

use crate::config::AppState;
use crate::models::*;
use crate::utils::*;

// ==================== 通用管理员验证 ====================

/// 验证管理员权限，返回 Ok(()) 或错误响应
fn check_admin(state: &web::Data<AppState>, req: &HttpRequest) -> Result<(), HttpResponse> {
    {
        let config = state.config.read().unwrap();
        if !config.admin_enabled {
            return Err(HttpResponse::Forbidden().json(ApiResponse::error("管理员功能未启用")));
        }
    }
    let token = req
        .headers()
        .get("X-Admin-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !state.validate_admin_token(token) {
        return Err(HttpResponse::Unauthorized().json(ApiResponse::error("未授权访问")));
    }
    Ok(())
}

// ==================== 登录 ====================

/// POST /api/v1/login - 学生登录（姓名+密码）
pub async fn login(state: web::Data<AppState>, req: web::Json<LoginRequest>) -> impl Responder {
    let config = state.config.read().unwrap();
    // 按姓名查找学生
    let student_entry = config.students.iter().find(|(_, s)| s.name == req.name);
    let (student_id, student) = match student_entry {
        Some(entry) => entry,
        None => {
            return HttpResponse::Unauthorized()
                .json(ApiResponse::error("姓名不存在，请联系老师导入名单"))
        }
    };
    if req.password.is_empty() || !password_matches(&req.password, &student.password_hash) {
        return HttpResponse::Unauthorized().json(ApiResponse::error(
            "密码错误；默认密码为000000，忘记密码请联系老师重置",
        ));
    }

    let token = format!("student_{}", uuid::Uuid::new_v4());
    state.student_tokens.write().unwrap().insert(
        token.clone(),
        (
            student_id.clone(),
            Local::now() + chrono::Duration::hours(24),
        ),
    );
    HttpResponse::Ok().json(ApiResponse::with_message(
        "登录成功",
        serde_json::json!({
            "token": token,
            "class": student.class,
            "student_id": student_id,
            "student_name": student.name,
            "force_password_change": student.force_password_change,
        }),
    ))
}

fn password_matches(password: &str, stored: &str) -> bool {
    if stored == password {
        return true;
    }
    stored == hash_password(password)
}

/// POST /api/v1/student/password - 学生修改密码
pub async fn student_change_password(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<StudentPasswordChangeRequest>,
) -> impl Responder {
    let token = req
        .headers()
        .get("X-Student-Token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let student_id = match state.validate_student_token(token) {
        Some(student_id) => student_id,
        None => {
            return HttpResponse::Unauthorized().json(ApiResponse::error("登录已过期，请重新登录"))
        }
    };
    if body.new_password.len() < 6 {
        return HttpResponse::BadRequest().json(ApiResponse::error("新密码至少需要6位"));
    }

    let mut config = state.config.write().unwrap();
    let student = match config.students.get_mut(&student_id) {
        Some(student) => student,
        None => return HttpResponse::Unauthorized().json(ApiResponse::error("学生信息不存在")),
    };
    if !password_matches(&body.old_password, &student.password_hash) {
        return HttpResponse::BadRequest().json(ApiResponse::error("当前密码错误"));
    }
    student.password_hash = hash_password(&body.new_password);
    student.force_password_change = false;
    if let Err(error) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError().json(ApiResponse::error(&error));
    }
    state.log_operation("学生修改密码", &format!("学生 {} 修改了密码", student_id));
    HttpResponse::Ok().json(ApiResponse::with_message(
        "密码修改成功",
        serde_json::json!({}),
    ))
}

// ==================== 公开课程 API ====================

/// GET /api/v1/courses - 获取所有课程列表
pub async fn courses(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    let mut courses: Vec<CourseInfo> = Vec::new();
    for (subject, sub_config) in &config.subjects {
        let total_lessons: usize = sub_config.homeworks.iter().map(|h| h.lessons.len()).sum();
        courses.push(CourseInfo {
            subject: subject.clone(),
            description: sub_config.description.clone(),
            cover_image: sub_config.cover_image.clone(),
            major: sub_config.major.clone(),
            status: sub_config.status.clone(),
            total_lessons,
        });
    }
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::to_value(courses).unwrap_or_default()))
}

/// GET /api/v1/current-course - 获取当前进行中课程
pub async fn current_course(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    match &config.current_course {
        Some(cc) => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
            "subject": cc.subject,
            "class": cc.class
        }))),
        None => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!(null))),
    }
}

/// GET /api/v1/lesson/public - 公开获取课时内容
pub async fn lesson_public(
    state: web::Data<AppState>,
    query: web::Query<LessonPublicQuery>,
) -> impl Responder {
    let config = state.config.read().unwrap();
    let subject_config = match config.subjects.get(&query.subject) {
        Some(sc) => sc,
        None => return HttpResponse::NotFound().json(ApiResponse::error("科目不存在")),
    };
    let homework = match subject_config.homeworks.iter().find(|h| h.name == query.homework) {
        Some(hw) => hw,
        None => return HttpResponse::NotFound().json(ApiResponse::error("作业不存在")),
    };
    let lesson = match homework.lessons.iter().find(|l| l.name == query.lesson) {
        Some(l) => l,
        None => return HttpResponse::NotFound().json(ApiResponse::error("课时不存在")),
    };

    let lesson_path = state
        .base_dir
        .join("lessons")
        .join(&query.subject)
        .join(&query.homework)
        .join(format!("{}.md", &query.lesson));

    let content = match std::fs::read_to_string(&lesson_path) {
        Ok(c) => c,
        Err(_) => String::new(),
    };

    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "content": content,
        "description": lesson.description,
    })))
}

// ==================== 学生名单管理 ====================

const DEFAULT_STUDENT_PASSWORD: &str = "000000";

fn student_admin_item(student_id: &str, student: &StudentConfig) -> StudentAdminItem {
    StudentAdminItem {
        student_id: student_id.to_string(),
        name: student.name.clone(),
        class: student.class.clone(),
        force_password_change: student.force_password_change,
    }
}

fn read_zip_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
) -> Result<Vec<u8>, String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("XLSX 缺少文件：{name}"))?;
    let mut data = Vec::new();
    entry
        .read_to_end(&mut data)
        .map_err(|error| format!("读取 XLSX 文件失败：{error}"))?;
    Ok(data)
}

fn parse_shared_strings(bytes: &[u8]) -> Result<Vec<String>, String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut in_text = false;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"si" => {
                current.clear();
                in_string = true;
            }
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" => {
                in_text = true;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"t" => {
                in_text = false;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"si" => {
                if in_string {
                    strings.push(current.clone());
                }
                in_string = false;
            }
            Ok(Event::Text(event)) if in_string && in_text => {
                let decoded = event
                    .decode()
                    .map_err(|error| format!("解析 XLSX 文本失败：{error}"))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| format!("解析 XLSX 转义文本失败：{error}"))?;
                current.push_str(&unescaped);
            }
            Ok(Event::CData(event)) if in_string && in_text => {
                current.push_str(&String::from_utf8_lossy(event.as_ref()));
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("解析 sharedStrings.xml 失败：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    Ok(strings)
}

fn spreadsheet_column_index(reference: &[u8]) -> Option<usize> {
    let mut index = 0usize;
    let mut found = false;
    for byte in reference {
        if !byte.is_ascii_alphabetic() {
            break;
        }
        found = true;
        index = index * 26 + (byte.to_ascii_uppercase() - b'A' + 1) as usize;
    }
    found.then_some(index.saturating_sub(1))
}

fn parse_worksheet_rows(
    bytes: &[u8],
    shared_strings: &[String],
) -> Result<Vec<Vec<String>>, String> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut rows = Vec::new();
    let mut current_row: Vec<String> = Vec::new();
    let mut current_cell: Option<usize> = None;
    let mut cell_type = String::new();
    let mut cell_value = String::new();
    let mut in_value = false;
    let mut in_inline_text = false;
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"row" => {
                current_row.clear();
            }
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"c" => {
                current_cell = None;
                cell_type.clear();
                cell_value.clear();
                for attribute in event.attributes().flatten() {
                    if attribute.key.as_ref() == b"r" {
                        current_cell = spreadsheet_column_index(attribute.value.as_ref());
                    } else if attribute.key.as_ref() == b"t" {
                        cell_type = String::from_utf8_lossy(attribute.value.as_ref()).to_string();
                    }
                }
            }
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"v" => {
                in_value = true;
            }
            Ok(Event::Start(event)) if event.local_name().as_ref() == b"t" => {
                in_inline_text = true;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"v" => {
                in_value = false;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"t" => {
                in_inline_text = false;
            }
            Ok(Event::Text(event)) if in_value || in_inline_text => {
                let decoded = event
                    .decode()
                    .map_err(|error| format!("解析 XLSX 单元格失败：{error}"))?;
                let unescaped = quick_xml::escape::unescape(&decoded)
                    .map_err(|error| format!("解析 XLSX 单元格转义文本失败：{error}"))?;
                cell_value.push_str(&unescaped);
            }
            Ok(Event::CData(event)) if in_value || in_inline_text => {
                cell_value.push_str(&String::from_utf8_lossy(event.as_ref()));
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"c" => {
                if let Some(index) = current_cell {
                    if current_row.len() <= index {
                        current_row.resize(index + 1, String::new());
                    }
                    current_row[index] = if cell_type == "s" {
                        cell_value
                            .parse::<usize>()
                            .ok()
                            .and_then(|value| shared_strings.get(value).cloned())
                            .unwrap_or_default()
                    } else {
                        cell_value.clone()
                    };
                }
                current_cell = None;
            }
            Ok(Event::End(event)) if event.local_name().as_ref() == b"row" => {
                rows.push(current_row.clone());
            }
            Ok(Event::Eof) => break,
            Err(error) => return Err(format!("解析 worksheet XML 失败：{error}")),
            _ => {}
        }
        buffer.clear();
    }
    Ok(rows)
}

fn parse_students_xlsx(data: &[u8]) -> Result<Vec<StudentImportItem>, String> {
    if data.is_empty() {
        return Err("XLSX 文件不能为空".to_string());
    }
    if data.len() > 10 * 1024 * 1024 {
        return Err("XLSX 文件不能超过 10MB".to_string());
    }
    let mut archive =
        ZipArchive::new(Cursor::new(data)).map_err(|error| format!("无效的 XLSX 文件：{error}"))?;
    let shared_strings = match read_zip_entry(&mut archive, "xl/sharedStrings.xml") {
        Ok(bytes) => parse_shared_strings(&bytes)?,
        Err(_) => Vec::new(),
    };
    let worksheet = read_zip_entry(&mut archive, "xl/worksheets/sheet1.xml")?;
    let rows = parse_worksheet_rows(&worksheet, &shared_strings)?;
    if rows.is_empty() {
        return Err("XLSX 中没有可导入的行".to_string());
    }
    let has_header = rows[0].iter().any(|value| {
        matches!(
            value.trim().to_lowercase().as_str(),
            "学号" | "student_id" | "id"
        )
    });
    let start = usize::from(has_header);
    let mut students = Vec::new();
    for (offset, row) in rows.iter().skip(start).enumerate() {
        if row.iter().all(|value| value.trim().is_empty()) {
            continue;
        }
        let student_id = row.first().map(String::as_str).unwrap_or("").trim();
        let name = row.get(1).map(String::as_str).unwrap_or("").trim();
        let class = row.get(2).map(String::as_str).unwrap_or("").trim();
        if student_id.is_empty() || name.is_empty() || class.is_empty() {
            return Err(format!(
                "第 {} 行必须包含学号、姓名和班级",
                offset + start + 1
            ));
        }
        students.push(StudentImportItem {
            student_id: student_id.to_string(),
            name: name.to_string(),
            class: class.to_string(),
            password: row
                .get(3)
                .map(String::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        });
    }
    if students.is_empty() {
        return Err("XLSX 中没有可导入的学生".to_string());
    }
    Ok(students)
}

fn import_students_to_config(
    state: &web::Data<AppState>,
    students: &[StudentImportItem],
) -> Result<(usize, usize), String> {
    if students.is_empty() {
        return Err("名单不能为空".to_string());
    }
    for item in students {
        if item.student_id.trim().is_empty()
            || item.name.trim().is_empty()
            || item.class.trim().is_empty()
        {
            return Err("学号、姓名和班级不能为空".to_string());
        }
    }
    let mut config = state.config.write().unwrap();
    let mut imported = 0usize;
    let mut new_students = 0usize;
    for item in students {
        let student_id = item.student_id.trim();
        let name = item.name.trim();
        let class = item.class.trim();
        if let Some(student) = config.students.get_mut(student_id) {
            student.name = name.to_string();
            student.class = class.to_string();
        } else {
            let password = item
                .password
                .as_deref()
                .filter(|value| !value.is_empty())
                .unwrap_or(DEFAULT_STUDENT_PASSWORD);
            config.students.insert(
                student_id.to_string(),
                StudentConfig {
                    name: name.to_string(),
                    class: class.to_string(),
                    password_hash: hash_password(password),
                    force_password_change: true,
                },
            );
            new_students += 1;
        }
        imported += 1;
    }
    crate::config::save_config(&config, &state.base_dir)
        .map_err(|error| format!("保存名单失败: {error}"))?;
    Ok((imported, new_students))
}

/// GET /api/v1/admin/students - 获取学生名单
pub async fn admin_students(state: web::Data<AppState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let config = state.config.read().unwrap();
    let mut students: Vec<StudentAdminItem> = config
        .students
        .iter()
        .map(|(student_id, student)| student_admin_item(student_id, student))
        .collect();
    students.sort_by(|left, right| left.student_id.cmp(&right.student_id));
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!(students)))
}

/// POST /api/v1/admin/students/import - 导入或更新学生名单
pub async fn admin_students_import(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<StudentImportRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let (imported, new_students) = match import_students_to_config(&state, &body.students) {
        Ok(result) => result,
        Err(error) => return HttpResponse::BadRequest().json(ApiResponse::error(&error)),
    };
    state.log_operation(
        "导入学生名单",
        &format!("导入 {} 条名单，新增 {} 名学生", imported, new_students),
    );
    HttpResponse::Ok().json(ApiResponse::with_message(
        "名单导入成功",
        serde_json::json!({ "imported": imported, "new_students": new_students }),
    ))
}

/// POST /api/v1/admin/students/import-xlsx - 导入 XLSX 学生名单
pub async fn admin_students_import_xlsx(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let mut data = Vec::new();
    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(field) => field,
            Err(_) => {
                return HttpResponse::BadRequest().json(ApiResponse::error("解析上传内容失败"))
            }
        };
        let filename = field
            .content_disposition()
            .and_then(|value| value.get_filename())
            .unwrap_or("")
            .to_lowercase();
        if !filename.ends_with(".xlsx") {
            return HttpResponse::BadRequest().json(ApiResponse::error("请上传 .xlsx 文件"));
        }
        while let Some(chunk) = field.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(_) => {
                    return HttpResponse::BadRequest()
                        .json(ApiResponse::error("读取 XLSX 文件失败"))
                }
            };
            data.extend_from_slice(&chunk);
            if data.len() > 10 * 1024 * 1024 {
                return HttpResponse::BadRequest()
                    .json(ApiResponse::error("XLSX 文件不能超过 10MB"));
            }
        }
    }
    let students = match parse_students_xlsx(&data) {
        Ok(students) => students,
        Err(error) => return HttpResponse::BadRequest().json(ApiResponse::error(&error)),
    };
    let (imported, new_students) = match import_students_to_config(&state, &students) {
        Ok(result) => result,
        Err(error) => return HttpResponse::BadRequest().json(ApiResponse::error(&error)),
    };
    state.log_operation(
        "导入 XLSX 学生名单",
        &format!("导入 {} 条名单，新增 {} 名学生", imported, new_students),
    );
    HttpResponse::Ok().json(ApiResponse::with_message(
        "XLSX 名单导入成功",
        serde_json::json!({ "imported": imported, "new_students": new_students }),
    ))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn student_xlsx_template() -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let files = [
        ("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>"),
        ("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"),
        ("xl/workbook.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"学生名单\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"),
        ("xl/_rels/workbook.xml.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>"),
    ];
    for (name, content) in files {
        writer
            .start_file(name, options)
            .map_err(|error| format!("生成 XLSX 模板失败：{error}"))?;
        writer
            .write_all(content.as_bytes())
            .map_err(|error| format!("生成 XLSX 模板失败：{error}"))?;
    }
    let headers = ["学号", "姓名", "班级", "密码（可选）"];
    let cells = headers
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let column = (b'A' + index as u8) as char;
            format!(
                "<c r=\"{column}1\" t=\"inlineStr\"><is><t>{}</t></is></c>",
                xml_escape(value)
            )
        })
        .collect::<String>();
    let worksheet = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\">{cells}</row></sheetData></worksheet>");
    writer
        .start_file("xl/worksheets/sheet1.xml", options)
        .map_err(|error| format!("生成 XLSX 模板失败：{error}"))?;
    writer
        .write_all(worksheet.as_bytes())
        .map_err(|error| format!("生成 XLSX 模板失败：{error}"))?;
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| format!("生成 XLSX 模板失败：{error}"))
}

/// GET /api/v1/admin/students/template - 下载 XLSX 名单模板
pub async fn admin_students_template(
    state: web::Data<AppState>,
    req: HttpRequest,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    match student_xlsx_template() {
        Ok(data) => HttpResponse::Ok()
            .insert_header((
                "Content-Type",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ))
            .insert_header((
                "Content-Disposition",
                "attachment; filename=student-list-template.xlsx",
            ))
            .body(data),
        Err(error) => HttpResponse::InternalServerError().json(ApiResponse::error(&error)),
    }
}
/// POST /api/v1/admin/students/{student_id}/reset - 重置学生密码
pub async fn admin_student_reset_password(
    state: web::Data<AppState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let student_id = path.into_inner();
    let mut config = state.config.write().unwrap();
    let student = match config.students.get_mut(&student_id) {
        Some(student) => student,
        None => return HttpResponse::NotFound().json(ApiResponse::error("学生不存在")),
    };
    student.password_hash = hash_password(DEFAULT_STUDENT_PASSWORD);
    student.force_password_change = true;
    if let Err(error) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存密码失败: {}", error)));
    }
    drop(config);
    state
        .student_tokens
        .write()
        .unwrap()
        .retain(|_, (id, _)| id != &student_id);
    state.log_operation("重置学生密码", &format!("重置学生 {} 的密码", student_id));
    HttpResponse::Ok().json(ApiResponse::with_message(
        "密码已重置为 000000",
        serde_json::json!({}),
    ))
}

/// DELETE /api/v1/admin/students/{student_id} - 删除学生
pub async fn admin_student_delete(
    state: web::Data<AppState>,
    req: HttpRequest,
    path: web::Path<String>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let student_id = path.into_inner();
    let mut config = state.config.write().unwrap();
    if config.students.remove(&student_id).is_none() {
        return HttpResponse::NotFound().json(ApiResponse::error("学生不存在"));
    }
    if let Err(error) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存名单失败: {}", error)));
    }
    drop(config);
    state
        .student_tokens
        .write()
        .unwrap()
        .retain(|_, (id, _)| id != &student_id);
    state.log_operation("删除学生", &format!("删除学生 {}", student_id));
    HttpResponse::Ok().json(ApiResponse::with_message(
        "学生已删除",
        serde_json::json!({}),
    ))
}
// ==================== 科目与课时内容 ====================

fn lesson_file_path(
    base_dir: &std::path::Path,
    subject: &str,
    homework: &str,
    lesson: &str,
) -> PathBuf {
    base_dir
        .join("lessons")
        .join(sanitize_filename(subject))
        .join(sanitize_filename(homework))
        .join(format!("{}.md", sanitize_filename(lesson)))
}

fn lesson_query(query: &HashMap<String, String>) -> Result<(String, String, String), HttpResponse> {
    let subject = query
        .get("subject")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let homework = query
        .get("homework")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let lesson = query
        .get("lesson")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    match (subject, homework, lesson) {
        (Some(subject), Some(homework), Some(lesson)) => Ok((
            subject.to_string(),
            homework.to_string(),
            lesson.to_string(),
        )),
        _ => Err(HttpResponse::BadRequest().json(ApiResponse::error("缺少科目、作业或课时参数"))),
    }
}

/// POST /api/v1/admin/subjects/import - 按行导入科目、班级和作业
pub async fn admin_subjects_import(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<SubjectImportRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    if body.subjects.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("导入内容不能为空"));
    }

    for item in &body.subjects {
        if item.subject.trim().is_empty() {
            return HttpResponse::BadRequest().json(ApiResponse::error("科目名称不能为空"));
        }
    }

    let mut config = state.config.write().unwrap();
    let mut imported = 0usize;
    let mut subjects_created = 0usize;
    let mut homeworks_created = 0usize;
    for item in &body.subjects {
        let subject_name = item.subject.trim();

        let subject = config
            .subjects
            .entry(subject_name.to_string())
            .or_insert_with(|| {
                subjects_created += 1;
                SubjectConfig {
                    classes: Vec::new(),
                    homeworks: Vec::new(),
                    description: None,
                    cover_image: None,
                    major: None,
                    status: None,
                }
            });
        if let Some(class) = item
            .class
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !subject.classes.iter().any(|value| value == class) {
                subject.classes.push(class.to_string());
            }
        }
        if let Some(homework_name) = item
            .homework
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(homework) = subject
                .homeworks
                .iter_mut()
                .find(|value| value.name == homework_name)
            {
                if let Some(description) = item
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    homework.description = Some(description.to_string());
                }
            } else {
                subject.homeworks.push(HomeworkConfig {
                    name: homework_name.to_string(),
                    description: item
                        .description
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    templates: None,
                    lessons: Vec::new(),
                });
                homeworks_created += 1;
            }
        }
        imported += 1;
    }
    if let Err(error) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存科目失败: {}", error)));
    }
    drop(config);
    if let Err(error) = reinit_upload_dirs(&state) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("初始化目录失败: {}", error)));
    }
    state.log_operation(
        "导入科目",
        &format!(
            "导入 {} 行，新增 {} 个科目、{} 个作业",
            imported, subjects_created, homeworks_created
        ),
    );
    HttpResponse::Ok().json(ApiResponse::with_message(
        "科目导入成功",
        serde_json::json!({ "imported": imported, "subjects_created": subjects_created, "homeworks_created": homeworks_created }),
    ))
}

/// POST /api/v1/admin/lesson/media - 上传课时图片、视频或附件
pub async fn admin_lesson_media_upload(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let mut subject = String::new();
    let mut homework = String::new();
    let mut lesson = String::new();
    let mut filename = String::new();
    let mut data = Vec::new();
    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(field) => field,
            Err(_) => {
                return HttpResponse::BadRequest().json(ApiResponse::error("解析上传内容失败"))
            }
        };
        let disposition = field.content_disposition();
        let field_name = disposition
            .map(|value| value.get_name().unwrap_or(""))
            .unwrap_or("")
            .to_string();
        let uploaded_name = disposition
            .and_then(|value| value.get_filename())
            .unwrap_or("")
            .to_string();
        let mut value = Vec::new();
        while let Some(chunk) = field.next().await {
            match chunk {
                Ok(chunk) => value.extend_from_slice(&chunk),
                Err(_) => {
                    return HttpResponse::BadRequest().json(ApiResponse::error("读取上传内容失败"))
                }
            }
        }
        if !uploaded_name.is_empty() {
            filename = uploaded_name;
            data = value;
        } else {
            let field_value = String::from_utf8_lossy(&value).trim().to_string();
            match field_name.as_str() {
                "subject" => subject = field_value,
                "homework" => homework = field_value,
                "lesson" => lesson = field_value,
                _ => {}
            }
        }
    }
    if subject.is_empty() || homework.is_empty() || lesson.is_empty() || filename.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目、作业、课时或文件"));
    }
    {
        let config = state.config.read().unwrap();
        let valid = config
            .subjects
            .get(&subject)
            .and_then(|subject_config| {
                subject_config
                    .homeworks
                    .iter()
                    .find(|homework_config| homework_config.name == homework)
            })
            .map(|homework_config| {
                homework_config
                    .lessons
                    .iter()
                    .any(|lesson_config| lesson_config.name == lesson)
            })
            .unwrap_or(false);
        if !valid {
            return HttpResponse::NotFound().json(ApiResponse::error("科目、作业或课时不存在"));
        }
    }
    if data.len() > 64 * 1024 * 1024 {
        return HttpResponse::BadRequest().json(ApiResponse::error("媒体文件不能超过 64MB"));
    }
    let extension = PathBuf::from(&filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let extension = format!(".{extension}");
    if !is_allowed_lesson_media_type(&extension) {
        return HttpResponse::BadRequest().json(ApiResponse::error("不支持的媒体文件类型"));
    }
    let safe_name = format!(
        "{}{}",
        sanitize_filename(filename.trim_end_matches(&extension)),
        extension
    );
    let directory = state
        .base_dir
        .join("lesson_media")
        .join(sanitize_filename(&subject))
        .join(sanitize_filename(&homework))
        .join(sanitize_filename(&lesson));
    if let Err(error) = std::fs::create_dir_all(&directory) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("创建媒体目录失败: {error}")));
    }
    let path = directory.join(&safe_name);
    if let Err(error) = std::fs::write(&path, data) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存媒体文件失败: {error}")));
    }
    let url = format!(
        "/lesson-media/{}/{}/{}/{}",
        sanitize_filename(&subject),
        sanitize_filename(&homework),
        sanitize_filename(&lesson),
        safe_name
    );
    state.log_operation("上传课时媒体", &format!("上传媒体 {}", url));
    HttpResponse::Ok().json(ApiResponse::with_message(
        "媒体上传成功",
        serde_json::json!({ "url": url }),
    ))
}

/// GET /api/v1/lesson/media/list - 获取课时附件列表
pub async fn lesson_media_list(
    state: web::Data<AppState>,
    query: web::Query<LessonPublicQuery>,
) -> impl Responder {
    let config = state.config.read().unwrap();
    if !config.subjects.contains_key(&query.subject) {
        return HttpResponse::NotFound().json(ApiResponse::error("科目不存在"));
    }
    let media_dir = state
        .base_dir
        .join("lesson_media")
        .join(sanitize_filename(&query.subject))
        .join(sanitize_filename(&query.homework))
        .join(sanitize_filename(&query.lesson));
    let mut files: Vec<serde_json::Value> = Vec::new();
    if media_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&media_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let url = format!(
                        "/lesson-media/{}/{}/{}/{}",
                        sanitize_filename(&query.subject),
                        sanitize_filename(&query.homework),
                        sanitize_filename(&query.lesson),
                        name
                    );
                    files.push(serde_json::json!({ "name": name, "size": size, "url": url }));
                }
            }
        }
    }
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({ "files": files })))
}

/// GET /api/v1/lesson - 学生读取课时 Markdown 内容
pub async fn lesson_content(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    let token = req
        .headers()
        .get("X-Student-Token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let student_id = match state.validate_student_token(token) {
        Some(student_id) => student_id,
        None => return HttpResponse::Unauthorized().json(ApiResponse::error("请先登录")),
    };
    let (subject, homework, lesson) = match lesson_query(&query) {
        Ok(values) => values,
        Err(response) => return response,
    };
    {
        let config = state.config.read().unwrap();
        let student = match config.students.get(&student_id) {
            Some(student) => student,
            None => return HttpResponse::Unauthorized().json(ApiResponse::error("学生信息不存在")),
        };
        if student.force_password_change {
            return HttpResponse::Forbidden().json(ApiResponse::error("请先修改初始密码"));
        }
        let subject_config = match config.subjects.get(&subject) {
            Some(subject_config) => subject_config,
            None => return HttpResponse::NotFound().json(ApiResponse::error("科目不存在")),
        };
        if !subject_config.classes.contains(&student.class) {
            return HttpResponse::Forbidden().json(ApiResponse::error("无权查看该科目"));
        }
        let homework_config = match subject_config
            .homeworks
            .iter()
            .find(|value| value.name == homework)
        {
            Some(homework_config) => homework_config,
            None => return HttpResponse::NotFound().json(ApiResponse::error("作业不存在")),
        };
        if !homework_config
            .lessons
            .iter()
            .any(|value| value.name == lesson)
        {
            return HttpResponse::NotFound().json(ApiResponse::error("课时不存在"));
        }
    }
    let path = lesson_file_path(&state.base_dir, &subject, &homework, &lesson);
    match std::fs::read_to_string(path) {
        Ok(content) => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({ "subject": subject, "homework": homework, "lesson": lesson, "content": content }))),
        Err(_) => HttpResponse::NotFound().json(ApiResponse::error("课时内容不存在")),
    }
}

/// GET /api/v1/admin/lesson - 管理员读取课时内容
pub async fn admin_lesson_content(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let (subject, homework, lesson) = match lesson_query(&query) {
        Ok(values) => values,
        Err(response) => return response,
    };
    let path = lesson_file_path(&state.base_dir, &subject, &homework, &lesson);
    match std::fs::read_to_string(path) {
        Ok(content) => {
            HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({ "content": content })))
        }
        Err(_) => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({ "content": "" }))),
    }
}

/// POST /api/v1/admin/lesson - 管理员保存课时 Markdown 内容
pub async fn admin_lesson_save(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<LessonSaveRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let subject_name = body.subject.trim();
    let homework_name = body.homework.trim();
    let lesson_name = body.lesson.trim();
    if subject_name.is_empty() || homework_name.is_empty() || lesson_name.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("科目、作业和课时名称不能为空"));
    }
    if body.content.len() > 4 * 1024 * 1024 {
        return HttpResponse::BadRequest().json(ApiResponse::error("Markdown 内容不能超过 4MB"));
    }
    {
        let config = state.config.read().unwrap();
        let subject = match config.subjects.get(subject_name) {
            Some(subject) => subject,
            None => return HttpResponse::NotFound().json(ApiResponse::error("科目不存在")),
        };
        if !subject
            .homeworks
            .iter()
            .any(|value| value.name == homework_name)
        {
            return HttpResponse::NotFound().json(ApiResponse::error("作业不存在"));
        }
    }

    let path = lesson_file_path(&state.base_dir, subject_name, homework_name, lesson_name);
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            return HttpResponse::InternalServerError()
                .json(ApiResponse::error(&format!("创建课时目录失败: {}", error)));
        }
    }
    if let Err(error) = std::fs::write(&path, body.content.as_bytes()) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存课时内容失败: {}", error)));
    }

    let mut config = state.config.write().unwrap();
    let subject = config.subjects.get_mut(subject_name).unwrap();
    let homework = subject
        .homeworks
        .iter_mut()
        .find(|value| value.name == homework_name)
        .unwrap();
    let description = body
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(lesson) = homework
        .lessons
        .iter_mut()
        .find(|value| value.name == lesson_name)
    {
        lesson.description = description;
    } else {
        homework.lessons.push(LessonConfig {
            name: lesson_name.to_string(),
            description,
        });
    }
    if let Err(error) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存课时配置失败: {}", error)));
    }
    drop(config);
    state.log_operation(
        "保存课时内容",
        &format!(
            "保存 {} / {} / {}",
            subject_name, homework_name, lesson_name
        ),
    );
    HttpResponse::Ok().json(ApiResponse::with_message(
        "课时内容已保存",
        serde_json::json!({}),
    ))
}
// ==================== 配置 ====================

/// GET /api/v1/config - 获取配置信息
pub async fn get_config(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    let subjects = &config.subjects;
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "subjects": subjects,
        "current_course": config.current_course,
    })))
}

// ==================== 版本 ====================

/// GET /api/v1/version - 获取版本信息
pub async fn version(state: web::Data<AppState>) -> impl Responder {
    let config = state.config.read().unwrap();
    HttpResponse::Ok().json(VersionResponse {
        success: true,
        version: config.version.clone(),
    })
}

// ==================== 更新日志 ====================

/// GET /api/v1/changelog - 获取更新日志
pub async fn changelog(state: web::Data<AppState>) -> impl Responder {
    let changelog_path = state.base_dir.join("CHANGELOG.md");
    match std::fs::read_to_string(&changelog_path) {
        Ok(content) => HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
            "content": content,
        }))),
        Err(_) => HttpResponse::Ok().json(ApiResponse::error("无法读取更新日志")),
    }
}

// ==================== 文件上传 ====================

/// POST /api/v1/upload - 学生上传文件
pub async fn upload(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    let token = req
        .headers()
        .get("X-Student-Token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let student_id = match state.validate_student_token(token) {
        Some(student_id) => student_id,
        None => {
            return HttpResponse::Unauthorized().json(UploadResponse {
                success: false,
                message: "请先登录后再上传".to_string(),
                filename: None,
            })
        }
    };
    let config = state.config.read().unwrap();
    let student = match config.students.get(&student_id) {
        Some(student) => student,
        None => {
            return HttpResponse::Unauthorized().json(UploadResponse {
                success: false,
                message: "学生信息不存在，请重新登录".to_string(),
                filename: None,
            })
        }
    };
    if student.force_password_change {
        return HttpResponse::Forbidden().json(UploadResponse {
            success: false,
            message: "请先修改初始密码后再上传".to_string(),
            filename: None,
        });
    }
    let class = student.class.clone();
    let student_name = student.name.clone();
    let mut subject = String::new();
    let mut homework = String::new();
    let mut saved_filename: Option<String> = None;

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(f) => f,
            Err(e) => {
                log::error!("解析 multipart 字段失败: {}", e);
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "解析请求失败".to_string(),
                    filename: None,
                });
            }
        };

        let content_disposition = field.content_disposition();
        let field_name = content_disposition
            .map(|cd| cd.get_name().unwrap_or(""))
            .unwrap_or("")
            .to_string();

        let filename = content_disposition
            .and_then(|cd| cd.get_filename())
            .map(|f: &str| f.to_string());

        if filename.is_some() {
            let fname = filename.unwrap();
            let ext = std::path::Path::new(&fname)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            let ext_with_dot = format!(".{}", ext);

            if !is_allowed_file_type(&ext_with_dot) {
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "不支持的文件类型".to_string(),
                    filename: None,
                });
            }

            if class.is_empty()
                || student_id.is_empty()
                || student_name.is_empty()
                || subject.is_empty()
                || homework.is_empty()
            {
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "缺少必要参数".to_string(),
                    filename: None,
                });
            }

            let sub_config = match config.subjects.get(&subject) {
                Some(c) => c,
                None => {
                    return HttpResponse::BadRequest().json(UploadResponse {
                        success: false,
                        message: "科目不存在".to_string(),
                        filename: None,
                    });
                }
            };

            if !sub_config.classes.contains(&class) {
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "该班级没有此科目".to_string(),
                    filename: None,
                });
            }

            let homework_exists = sub_config.homeworks.iter().any(|hw| hw.name == homework);
            if !homework_exists {
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "作业不存在".to_string(),
                    filename: None,
                });
            }

            let timestamp = Local::now().format("%Y%m%d%H%M%S").to_string();
            let new_filename = format!(
                "{}_{}_{}_{}{}",
                sanitize_filename(&homework),
                sanitize_filename(&student_id),
                sanitize_filename(&student_name),
                timestamp,
                ext_with_dot
            );

            let save_path = state
                .upload_dir
                .join(sanitize_filename(&subject))
                .join(sanitize_filename(&class))
                .join(sanitize_filename(&homework));

            if let Err(e) = std::fs::create_dir_all(&save_path) {
                log::error!("创建目录失败: {}", e);
                return HttpResponse::InternalServerError().json(UploadResponse {
                    success: false,
                    message: "创建目录失败".to_string(),
                    filename: None,
                });
            }

            let full_path = save_path.join(&new_filename);

            let mut file_data = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!("读取文件数据失败: {}", e);
                        return HttpResponse::InternalServerError().json(UploadResponse {
                            success: false,
                            message: "读取文件数据失败".to_string(),
                            filename: None,
                        });
                    }
                };
                file_data.extend_from_slice(&data);
            }

            if file_data.len() > 32 * 1024 * 1024 {
                return HttpResponse::BadRequest().json(UploadResponse {
                    success: false,
                    message: "文件大小超过限制(32MB)".to_string(),
                    filename: None,
                });
            }

            if let Err(e) = std::fs::write(&full_path, &file_data) {
                log::error!("保存文件失败: {}", e);
                return HttpResponse::InternalServerError().json(UploadResponse {
                    success: false,
                    message: "保存文件失败".to_string(),
                    filename: None,
                });
            }

            let client_ip = get_client_ip(&req);
            let log_msg = format!(
                "[{}] {} {} {} 提交 {}-{} IP:{}",
                Local::now().format("%Y-%m-%d %H:%M:%S"),
                class,
                student_id,
                student_name,
                subject,
                homework,
                client_ip
            );
            println!("{}", log_msg);
            write_log(&state.base_dir, &log_msg);

            saved_filename = Some(new_filename.clone());

            // 记录提交
            let mut submissions = load_submissions(&state.base_dir);
            // 移除同一学生同一作业的旧记录
            submissions.retain(|s| {
                !(s.student_id == student_id && s.subject == subject && s.homework == homework)
            });
            submissions.push(SubmissionRecord {
                student_id: student_id.clone(),
                student_name: student_name.clone(),
                class: class.clone(),
                subject: subject.clone(),
                homework: homework.clone(),
                filename: new_filename.clone(),
                filepath: full_path.to_string_lossy().to_string(),
                filesize: file_data.len() as u64,
                submitted_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                review_status: None,
                review_comment: None,
                reviewed_at: None,
            });
            save_submissions(&state.base_dir, &submissions);
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(_) => break,
                };
                value.extend_from_slice(&data);
            }

            let value_str = String::from_utf8_lossy(&value).to_string();
            match field_name.as_str() {
                "subject" => subject = value_str,
                "homework" => homework = value_str,
                _ => {}
            }
        }
    }

    match saved_filename {
        Some(fname) => HttpResponse::Ok().json(UploadResponse {
            success: true,
            message: "上传成功".to_string(),
            filename: Some(fname),
        }),
        None => HttpResponse::BadRequest().json(UploadResponse {
            success: false,
            message: "请选择要上传的文件".to_string(),
            filename: None,
        }),
    }
}

// ==================== 模板下载 ====================

/// GET /api/v1/template?file=... - 下载模板文件
pub async fn template_download(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<HashMap<String, String>>,
) -> HttpResponse {
    let file_path = match query.get("file") {
        Some(f) => f.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少文件参数")),
    };

    if !is_safe_template_path(&file_path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&file_path);

    let templates_dir = state.base_dir.join("templates");
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => return HttpResponse::NotFound().json(ApiResponse::error("文件不存在")),
    };
    let abs_templates = match std::fs::canonicalize(&templates_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_templates) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match NamedFile::open_async(&abs_full).await {
        Ok(file) => {
            let filename = abs_full
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("download");
            file.set_content_disposition(actix_web::http::header::ContentDisposition::attachment(
                urlencoding::encode(filename).to_string(),
            ))
            .into_response(&req)
        }
        Err(_) => HttpResponse::NotFound().json(ApiResponse::error("文件不存在")),
    }
}

// ==================== 管理员登录 ====================

/// POST /api/v1/admin/login - 管理员登录
pub async fn admin_login(
    state: web::Data<AppState>,
    req: web::Json<AdminLoginRequest>,
) -> impl Responder {
    let config = state.config.read().unwrap();

    if !config.admin_enabled {
        return HttpResponse::Forbidden().json(AdminLoginResponse {
            success: false,
            message: "管理员功能未启用".to_string(),
            token: None,
        });
    }

    if req.password != config.admin_password {
        return HttpResponse::Unauthorized().json(AdminLoginResponse {
            success: false,
            message: "密码错误".to_string(),
            token: None,
        });
    }

    let token = generate_admin_token();
    let expiry = Local::now() + chrono::Duration::hours(24);
    state
        .admin_tokens
        .write()
        .unwrap()
        .insert(token.clone(), expiry);

    state.log_operation("管理员登录", "管理员登录成功");

    HttpResponse::Ok().json(AdminLoginResponse {
        success: true,
        message: "登录成功".to_string(),
        token: Some(token),
    })
}

// ==================== 管理员配置 ====================

/// GET /api/v1/admin/config - 获取管理员配置
/// POST /api/v1/admin/config - 更新管理员配置
pub async fn admin_config(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: Option<web::Json<AdminConfigRequest>>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    match req.method() {
        &actix_web::http::Method::GET => {
            let config = state.config.read().unwrap();
            HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
                "subjects": config.subjects,
                "current_course": config.current_course,
            })))
        }
        &actix_web::http::Method::POST => {
            let body = match body {
                Some(b) => b,
                None => return HttpResponse::BadRequest().json(ApiResponse::error("请求格式错误")),
            };

            {
                let mut cfg = state.config.write().unwrap();
                cfg.subjects = body.subjects.clone();
            }

            let config = state.config.read().unwrap();
            if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
            }

            if let Err(e) = reinit_upload_dirs(&state) {
                return HttpResponse::InternalServerError()
                    .json(ApiResponse::error(&format!("初始化目录失败 {}", e)));
            }

            state.log_operation("更新配置", "管理员更新了科目配置");

            HttpResponse::Ok().json(ApiResponse::with_message(
                "配置已更新",
                serde_json::json!({}),
            ))
        }
        _ => HttpResponse::MethodNotAllowed().json(ApiResponse::error("请求方法错误")),
    }
}

/// 重新初始化上传目录
fn reinit_upload_dirs(state: &web::Data<AppState>) -> Result<(), String> {
    let config = state.config.read().unwrap();
    for (subject, sub_config) in &config.subjects {
        for class in &sub_config.classes {
            for hw in &sub_config.homeworks {
                let dir = state
                    .upload_dir
                    .join(sanitize_filename(subject))
                    .join(sanitize_filename(class))
                    .join(sanitize_filename(&hw.name));
                std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {}", e))?;
            }
        }
    }
    Ok(())
}

// ==================== 模板上传（管理端） ====================

/// POST /api/v1/admin/template/upload - 上传模板文件
pub async fn template_upload(
    state: web::Data<AppState>,
    req: HttpRequest,
    mut payload: Multipart,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let mut subject = String::new();
    let mut homework = String::new();
    let mut filename: Option<String> = None;
    let mut file_data = Vec::new();

    while let Some(item) = payload.next().await {
        let mut field = match item {
            Ok(f) => f,
            Err(e) => {
                log::error!("解析 multipart 失败: {}", e);
                return HttpResponse::BadRequest().json(ApiResponse::error("解析请求失败"));
            }
        };

        let content_disposition = field.content_disposition();
        let field_name = content_disposition
            .map(|cd| cd.get_name().unwrap_or(""))
            .unwrap_or("")
            .to_string();
        let uploaded_filename = content_disposition
            .and_then(|cd| cd.get_filename())
            .map(|f: &str| f.to_string());

        if let Some(fname) = uploaded_filename {
            filename = Some(fname);
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(e) => {
                        log::error!("读取文件数据失败: {}", e);
                        return HttpResponse::InternalServerError()
                            .json(ApiResponse::error("读取文件数据失败"));
                    }
                };
                file_data.extend_from_slice(&data);
            }
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.next().await {
                let data = match chunk {
                    Ok(d) => d,
                    Err(_) => break,
                };
                value.extend_from_slice(&data);
            }
            let value_str = String::from_utf8_lossy(&value).to_string();
            match field_name.as_str() {
                "subject" => subject = value_str,
                "homework" => homework = value_str,
                _ => {}
            }
        }
    }

    let fname = match filename {
        Some(name) => name,
        None => return HttpResponse::BadRequest().json(ApiResponse::error("请选择要上传的文件")),
    };
    if subject.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目参数"));
    }
    if homework.is_empty() {
        return HttpResponse::BadRequest().json(ApiResponse::error("缺少作业参数"));
    }

    let config = state.config.read().unwrap();
    let subject_config = match config.subjects.get(&subject) {
        Some(config) => config,
        None => return HttpResponse::BadRequest().json(ApiResponse::error("科目不存在")),
    };
    if !subject_config
        .homeworks
        .iter()
        .any(|item| item.name == homework)
    {
        return HttpResponse::BadRequest().json(ApiResponse::error("作业不存在"));
    }
    drop(config);

    let ext = PathBuf::from(&fname)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let ext_with_dot = format!(".{}", ext);
    if !is_allowed_file_type(&ext_with_dot) {
        return HttpResponse::BadRequest().json(ApiResponse::error("不支持的文件类型"));
    }

    let safe_name = sanitize_filename(fname.trim_end_matches(&ext_with_dot)) + &ext_with_dot;
    let subject_dir = state
        .base_dir
        .join("templates")
        .join(sanitize_filename(&subject));
    if let Err(e) = std::fs::create_dir_all(&subject_dir) {
        log::error!("创建目录失败: {}", e);
        return HttpResponse::InternalServerError().json(ApiResponse::error("创建目录失败"));
    }

    let full_path = subject_dir.join(&safe_name);
    if let Err(e) = std::fs::write(&full_path, &file_data) {
        log::error!("保存文件失败: {}", e);
        return HttpResponse::InternalServerError().json(ApiResponse::error("保存文件失败"));
    }

    let path = format!("templates/{}/{}", sanitize_filename(&subject), safe_name);
    state.log_operation("上传模板", &format!("上传模板文件: {}", path));
    HttpResponse::Ok().json(ApiResponse::with_message(
        "上传成功",
        serde_json::json!({ "path": path }),
    ))
}

/// GET /api/v1/admin/template/list?subject=xxx - 获取模板列表
pub async fn template_list(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<HashMap<String, String>>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let subject = match query.get("subject") {
        Some(value) if !value.is_empty() => value,
        _ => return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目参数")),
    };
    let subject_dir = state
        .base_dir
        .join("templates")
        .join(sanitize_filename(subject));
    let mut templates = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&subject_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                    templates.push(format!("templates/{}/{}", sanitize_filename(subject), name));
                }
            }
        }
    }
    templates.sort();
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!(templates)))
}

// ==================== 模板删除（管理端） ====================

/// POST /api/v1/admin/template/delete - 删除模板文件
pub async fn template_delete(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<TemplateDeleteRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    if !is_safe_template_path(&body.path) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(&body.path);

    let templates_dir = state.base_dir.join("templates");
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => {
            return HttpResponse::Ok().json(ApiResponse::with_message(
                "文件已删除",
                serde_json::json!({}),
            ))
        }
    };
    let abs_templates = match std::fs::canonicalize(&templates_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_templates) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match std::fs::remove_file(&abs_full) {
        Ok(_) => {
            state.log_operation("删除模板", &format!("删除模板文件: {}", body.path));
            HttpResponse::Ok().json(ApiResponse::with_message(
                "文件已删除",
                serde_json::json!({}),
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HttpResponse::Ok().json(
            ApiResponse::with_message("文件已删除", serde_json::json!({})),
        ),
        Err(e) => {
            log::error!("删除文件失败: {}", e);
            HttpResponse::InternalServerError().json(ApiResponse::error("删除文件失败"))
        }
    }
}

// ==================== 文件管理（管理端 v2 新增） ====================

/// GET /api/v1/admin/files - 获取文件列表
pub async fn admin_file_list(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<FileListQuery>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let upload_dir = &state.upload_dir;

    // 构建扫描路径
    let scan_path = if let Some(ref subject) = query.subject {
        let mut p = upload_dir.join(sanitize_filename(subject));
        if let Some(ref class) = query.class {
            p = p.join(sanitize_filename(class));
            if let Some(ref homework) = query.homework {
                p = p.join(sanitize_filename(homework));
            }
        }
        p
    } else {
        upload_dir.clone()
    };

    let mut files: Vec<FileInfo> = Vec::new();

    // 递归扫描文件
    fn scan_dir(dir: &std::path::Path, upload_dir: &std::path::Path, files: &mut Vec<FileInfo>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    scan_dir(&path, upload_dir, files);
                } else if path.is_file() {
                    if let Ok(metadata) = path.metadata() {
                        let name = path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let relative = path
                            .strip_prefix(upload_dir)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        let modified = metadata
                            .modified()
                            .map(|t| {
                                let dt: chrono::DateTime<chrono::Local> = t.into();
                                dt.format("%Y-%m-%d %H:%M:%S").to_string()
                            })
                            .unwrap_or_default();
                        files.push(FileInfo {
                            name,
                            size: metadata.len(),
                            modified,
                            path: format!("uploads/{}", relative),
                        });
                    }
                }
            }
        }
    }

    if scan_path.exists() {
        scan_dir(&scan_path, upload_dir, &mut files);
    }

    // 按修改时间倒序
    files.sort_by(|a, b| b.modified.cmp(&a.modified));

    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!({
        "files": files,
    })))
}

/// POST /api/v1/admin/files/delete - 删除上传的文件
pub async fn admin_file_delete(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<FileDeleteRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let path = &body.path;

    // 安全检查：只允许删除 uploads 目录下的文件
    if path.contains("..") || !path.starts_with("uploads/") {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    let full_path = state.base_dir.join(path);

    // 验证路径在 uploads 目录下
    let abs_full = match std::fs::canonicalize(&full_path) {
        Ok(p) => p,
        Err(_) => {
            return HttpResponse::Ok().json(ApiResponse::with_message(
                "文件已删除",
                serde_json::json!({}),
            ))
        }
    };
    let abs_uploads = match std::fs::canonicalize(&state.upload_dir) {
        Ok(p) => p,
        Err(_) => return HttpResponse::Forbidden().json(ApiResponse::error("非法路径")),
    };

    if !abs_full.starts_with(&abs_uploads) {
        return HttpResponse::Forbidden().json(ApiResponse::error("非法路径"));
    }

    match std::fs::remove_file(&abs_full) {
        Ok(_) => {
            state.log_operation("删除文件", &format!("删除上传文件: {}", path));
            HttpResponse::Ok().json(ApiResponse::with_message(
                "文件已删除",
                serde_json::json!({}),
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => HttpResponse::Ok().json(
            ApiResponse::with_message("文件已删除", serde_json::json!({})),
        ),
        Err(e) => {
            log::error!("删除文件失败: {}", e);
            HttpResponse::InternalServerError().json(ApiResponse::error("删除文件失败"))
        }
    }
}

// ==================== 统计仪表盘（管理端 v2 新增） ====================

/// GET /api/v1/admin/stats - 获取统计数据
pub async fn admin_stats(state: web::Data<AppState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let config = state.config.read().unwrap();
    let upload_dir = &state.upload_dir;

    let mut total_files = 0usize;
    let mut total_size = 0u64;
    let mut subject_stats = Vec::new();
    let mut all_recent: Vec<RecentUpload> = Vec::new();

    for (subject, sub_config) in &config.subjects {
        let mut s_files = 0usize;
        let mut s_size = 0u64;

        for class in &sub_config.classes {
            for hw in &sub_config.homeworks {
                let dir = upload_dir
                    .join(sanitize_filename(subject))
                    .join(sanitize_filename(class))
                    .join(sanitize_filename(&hw.name));
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            if let Ok(meta) = path.metadata() {
                                s_files += 1;
                                s_size += meta.len();
                                total_files += 1;
                                total_size += meta.len();

                                // 收集最近上传
                                let modified = meta
                                    .modified()
                                    .map(|t| {
                                        let dt: chrono::DateTime<chrono::Local> = t.into();
                                        dt.format("%Y-%m-%d %H:%M:%S").to_string()
                                    })
                                    .unwrap_or_default();
                                let filename = path
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("")
                                    .to_string();
                                let relative = path
                                    .strip_prefix(upload_dir)
                                    .unwrap_or(&path)
                                    .to_string_lossy()
                                    .replace('\\', "/");
                                all_recent.push(RecentUpload {
                                    filename,
                                    path: format!("uploads/{}", relative),
                                    size: meta.len(),
                                    modified,
                                });
                            }
                        }
                    }
                }
            }
        }

        subject_stats.push(SubjectStat {
            name: subject.clone(),
            file_count: s_files,
            total_size: s_size,
            class_count: sub_config.classes.len(),
            homework_count: sub_config.homeworks.len(),
        });
    }

    // 按修改时间倒序，取最近 20 条
    all_recent.sort_by(|a, b| b.modified.cmp(&a.modified));
    all_recent.truncate(20);

    let stats = DashboardStats {
        total_files,
        total_size,
        total_subjects: config.subjects.len(),
        total_classes: config.subjects.values().map(|s| s.classes.len()).sum(),
        total_homeworks: config.subjects.values().map(|s| s.homeworks.len()).sum(),
        subject_stats,
        recent_uploads: all_recent,
    };

    HttpResponse::Ok().json(ApiResponse::ok(
        serde_json::to_value(stats).unwrap_or_default(),
    ))
}

// ==================== 作业提交情况（管理端 v2 新增） ====================

/// GET /api/v1/admin/submissions?subject=xxx&class=xxx&homework=xxx
pub async fn admin_submissions(
    state: web::Data<AppState>,
    req: HttpRequest,
    query: web::Query<FileListQuery>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let subject = match &query.subject {
        Some(s) => s.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少科目参数")),
    };
    let class_name = match &query.class {
        Some(c) => c.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少班级参数")),
    };
    let homework = match &query.homework {
        Some(h) => h.clone(),
        None => return HttpResponse::BadRequest().json(ApiResponse::error("缺少作业参数")),
    };

    let config = state.config.read().unwrap();
    let sub_config = match config.subjects.get(&subject) {
        Some(c) => c,
        None => return HttpResponse::BadRequest().json(ApiResponse::error("科目不存在")),
    };

    if !sub_config.classes.contains(&class_name) {
        return HttpResponse::BadRequest().json(ApiResponse::error("班级不存在"));
    }

    let hw_exists = sub_config.homeworks.iter().any(|hw| hw.name == homework);
    if !hw_exists {
        return HttpResponse::BadRequest().json(ApiResponse::error("作业不存在"));
    }

    // 扫描上传目录获取已提交文件
    let dir = state
        .upload_dir
        .join(sanitize_filename(&subject))
        .join(sanitize_filename(&class_name))
        .join(sanitize_filename(&homework));

    let mut submitted: Vec<String> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    submitted.push(name.to_string());
                }
            }
        }
    }

    submitted.sort();

    let status = SubmissionStatus {
        homework_name: homework,
        subject,
        class: class_name,
        submitted,
        not_submitted: vec!["未在系统中记录".to_string()], // 学生名单不在配置中
    };

    HttpResponse::Ok().json(ApiResponse::ok(
        serde_json::to_value(status).unwrap_or_default(),
    ))
}

// ==================== 密码修改（管理端 v2 新增） ====================

/// POST /api/v1/admin/password - 修改管理员密码
pub async fn admin_change_password(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<ChangePasswordRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    // 验证旧密码
    {
        let config = state.config.read().unwrap();
        if config.admin_password != body.old_password {
            return HttpResponse::BadRequest().json(ApiResponse::error("旧密码错误"));
        }
    }

    if body.new_password.is_empty() || body.new_password.len() < 4 {
        return HttpResponse::BadRequest().json(ApiResponse::error("新密码长度至少4位"));
    }

    // 更新密码
    {
        let mut config = state.config.write().unwrap();
        config.admin_password = body.new_password.clone();
    }

    // 保存到文件
    let config = state.config.read().unwrap();
    if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
        return HttpResponse::InternalServerError()
            .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
    }

    state.log_operation("修改密码", "管理员修改了密码");

    HttpResponse::Ok().json(ApiResponse::with_message(
        "密码修改成功",
        serde_json::json!({}),
    ))
}

// ==================== 操作日志（管理端 v2 新增） ====================

/// GET /api/v1/admin/logs - 获取操作日志
pub async fn admin_logs(state: web::Data<AppState>, req: HttpRequest) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }

    let logs = state.get_op_logs(100);
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::json!(logs)))
}

// ==================== 静态页面 ====================

/// GET / - 学生端首页
pub async fn index_page(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let index_path = state.base_dir.join("static").join("index.html");
    if index_path.exists() {
        match NamedFile::open_async(&index_path).await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::NotFound().body("静态文件不存在"),
        }
    } else {
        HttpResponse::NotFound().body("静态文件不存在，请确保 static/index.html 与程序在同一目录")
    }
}

/// GET /admin - 管理员页面
pub async fn admin_page(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let config = state.config.read().unwrap();
    if !config.admin_enabled {
        return HttpResponse::Forbidden().body("管理员功能未启用");
    }

    let admin_path = state.base_dir.join("static").join("admin.html");
    if admin_path.exists() {
        match NamedFile::open_async(&admin_path).await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::NotFound().body("管理员页面不存在"),
        }
    } else {
        HttpResponse::NotFound().body("管理员页面不存在")
    }
}

/// GET /favicon.svg - 站点图标
pub async fn favicon(state: web::Data<AppState>, req: HttpRequest) -> HttpResponse {
    let icon_path = state.base_dir.join("static").join("icon.svg");
    if icon_path.exists() {
        match NamedFile::open_async(&icon_path).await {
            Ok(file) => file.into_response(&req),
            Err(_) => HttpResponse::NotFound().body("图标不存在"),
        }
    } else {
        HttpResponse::NotFound().body("图标不存在")
    }
}

// ==================== 管理端：当前课程设置 ====================

/// POST /api/v1/admin/current-course - 设置当前进行中课程
pub async fn admin_current_course(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<CurrentCourseConfig>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    {
        let mut config = state.config.write().unwrap();
        config.current_course = Some(body.into_inner());
        if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
            return HttpResponse::InternalServerError()
                .json(ApiResponse::error(&format!("保存配置失败: {}", e)));
        }
    }
    state.log_operation("设置当前课程", "管理员更新了当前进行中课程");
    HttpResponse::Ok().json(ApiResponse::with_message("当前课程已设置", serde_json::json!({})))
}

/// POST /api/v1/admin/course-meta/{subject} - 更新课程元数据
pub async fn admin_course_meta(
    state: web::Data<AppState>,
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<CourseMetaRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let subject = path.into_inner();
    {
        let mut config = state.config.write().unwrap();
        let subj = match config.subjects.get_mut(&subject) {
            Some(s) => s,
            None => return HttpResponse::NotFound().json(ApiResponse::error("科目不存在")),
        };
        if let Some(desc) = &body.description {
            subj.description = Some(desc.clone());
        }
        if let Some(cover) = &body.cover_image {
            subj.cover_image = Some(cover.clone());
        }
        if let Some(major) = &body.major {
            subj.major = Some(major.clone());
        }
        if let Err(e) = crate::config::save_config(&config, &state.base_dir) {
            return HttpResponse::InternalServerError()
                .json(ApiResponse::error(&format!("保存失败: {}", e)));
        }
    }
    state.log_operation("更新课程信息", &format!("更新了课程 {} 的元数据", subject));
    HttpResponse::Ok().json(ApiResponse::with_message("课程信息已更新", serde_json::json!({})))
}

// ==================== 学生提交记录与进度 ====================

/// 提交记录文件路径
fn submissions_file(base_dir: &std::path::Path) -> std::path::PathBuf {
    base_dir.join("uploads").join("_submissions.json")
}

/// 加载提交记录
fn load_submissions(base_dir: &std::path::Path) -> Vec<SubmissionRecord> {
    let path = submissions_file(base_dir);
    match std::fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// 保存提交记录
fn save_submissions(base_dir: &std::path::Path, records: &[SubmissionRecord]) {
    let path = submissions_file(base_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(records).unwrap_or_default());
}

/// GET /api/v1/student/progress - 获取学生进度
pub async fn student_progress(
    state: web::Data<AppState>,
    req: HttpRequest,
) -> impl Responder {
    let token = req.headers().get("X-Student-Token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let student_id = match state.validate_student_token(token) {
        Some(id) => id,
        None => return HttpResponse::Unauthorized().json(ApiResponse::error("登录已过期")),
    };
    let config = state.config.read().unwrap();
    let student = match config.students.get(&student_id) {
        Some(s) => s.clone(),
        None => return HttpResponse::NotFound().json(ApiResponse::error("学生不存在")),
    };
    let submissions = load_submissions(&state.base_dir);
    let mut progress_list: Vec<StudentProgress> = Vec::new();
    for (subject, subj) in &config.subjects {
        if !subj.classes.contains(&student.class) {
            continue;
        }
        let mut total = 0usize;
        let mut completed = 0usize;
        let mut issues = 0usize;
        let mut statuses: Vec<LessonStatusInfo> = Vec::new();
        for hw in &subj.homeworks {
            for lesson in &hw.lessons {
                total += 1;
                let sub = submissions.iter().find(|s| {
                    s.student_id == student_id && s.subject == *subject && s.homework == hw.name
                });
                let (status, submitted_at, comment) = match sub {
                    Some(s) => match s.review_status.as_deref() {
                        Some("passed") => {
                            completed += 1;
                            ("completed", Some(s.submitted_at.clone()), s.review_comment.clone())
                        }
                        Some("rejected") => {
                            issues += 1;
                            ("rejected", Some(s.submitted_at.clone()), s.review_comment.clone())
                        }
                        _ => {
                            ("pending", Some(s.submitted_at.clone()), None)
                        }
                    },
                    None => ("pending", None, None),
                };
                statuses.push(LessonStatusInfo {
                    homework_name: hw.name.clone(),
                    lesson_name: lesson.name.clone(),
                    status: status.to_string(),
                    submitted_at,
                    review_comment: comment,
                });
            }
        }
        progress_list.push(StudentProgress {
            subject: subject.clone(),
            total_lessons: total,
            completed_lessons: completed,
            has_issues: issues,
            lesson_statuses: statuses,
        });
    }
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::to_value(progress_list).unwrap_or_default()))
}

/// GET /api/v1/student/submissions - 获取学生提交记录
pub async fn student_submissions(
    state: web::Data<AppState>,
    req: HttpRequest,
) -> impl Responder {
    let token = req.headers().get("X-Student-Token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let student_id = match state.validate_student_token(token) {
        Some(id) => id,
        None => return HttpResponse::Unauthorized().json(ApiResponse::error("登录已过期")),
    };
    let submissions = load_submissions(&state.base_dir);
    let mine: Vec<&SubmissionRecord> = submissions.iter().filter(|s| s.student_id == student_id).collect();
    HttpResponse::Ok().json(ApiResponse::ok(serde_json::to_value(mine).unwrap_or_default()))
}

/// POST /api/v1/admin/review - 管理员评审作业
pub async fn admin_review(
    state: web::Data<AppState>,
    req: HttpRequest,
    body: web::Json<ReviewRequest>,
) -> impl Responder {
    if let Err(resp) = check_admin(&state, &req) {
        return resp;
    }
    let mut submissions = load_submissions(&state.base_dir);
    let idx = submissions.iter().position(|s| {
        s.student_id == body.student_id && s.subject == body.subject && s.homework == body.homework
    });
    match idx {
        Some(i) => {
            submissions[i].review_status = Some(body.status.clone());
            submissions[i].review_comment = body.comment.clone();
            submissions[i].reviewed_at = Some(Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
            let name = submissions[i].student_name.clone();
            save_submissions(&state.base_dir, &submissions);
            state.log_operation(
                "评审作业",
                &format!("{} {} {} {} -> {}", body.subject, body.homework, body.student_id, name, body.status),
            );
            HttpResponse::Ok().json(ApiResponse::with_message("评审完成", serde_json::json!({})))
        }
        None => HttpResponse::NotFound().json(ApiResponse::error("未找到该学生的提交记录")),
    }
}
