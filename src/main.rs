mod config;
mod handlers;
mod models;
mod utils;

use actix_web::{web, App, HttpServer};
use config::AppState;
use std::sync::Arc;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // 初始化日志
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    println!();
    println!("╔════════════════════════════════════════════════════════════╗");
    println!("│          CUMS - 课堂文件上传管理系统 (Rust)               │");
    println!("╚════════════════════════════════════════════════════════════╝");
    println!();

    // 加载配置
    let app_config = match config::load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("❌ 错误: {}", e);
            std::process::exit(1);
        }
    };

    // 初始化应用状态
    let state = Arc::new(AppState::new(app_config.clone()));

    // 启动令牌清理定时任务
    let cleanup_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            cleanup_state.clean_expired_tokens();
        }
    });

    let addr = if app_config.server_addr.is_empty() {
        ":3000".to_string()
    } else {
        app_config.server_addr.clone()
    };

    let port: u16 = addr
        .trim_start_matches(':')
        .parse()
        .unwrap_or(3000);

    // 智能端口检测
    let final_port = if utils::is_port_available(port) {
        port
    } else {
        println!("⚠️ 端口 {} 已被占用，尝试下一个端口", port);
        let mut found_port = None;
        for p in (port + 1)..=(port + 10) {
            if utils::is_port_available(p) {
                println!("✅ 找到可用端口: {}", p);
                found_port = Some(p);
                break;
            }
        }
        match found_port {
            Some(p) => p,
            None => {
                eprintln!("❌ 已尝试 10 个端口，均被占用");
                std::process::exit(1);
            }
        }
    };

    let local_ip = utils::get_local_ip();
    let bind_addr = format!("0.0.0.0:{}", final_port);

    println!();
    println!("🌐 访问地址");
    println!("────────────────────────────────────────");
    println!("   学生端:   http://localhost:{}", final_port);
    println!("   局域网:   http://{}:{}", local_ip, final_port);
    println!();
    println!("📖 使用说明");
    println!("────────────────────────────────────────");
    println!("   1. 学生访问上方地址，登录后上传作业");
    println!("   2. 文件保存在 uploads/科目/班级/作业/ 目录");
    println!("   3. 通过管理后台可添加科目、班级、作业");
    println!("   4. 修改 config.json 后需重启程序生效");
    println!();
    println!("════════════════════════════════════════════════════════════");
    println!("🚀 服务器已启动在端口 {}，按 Ctrl+C 停止", final_port);
    println!("════════════════════════════════════════════════════════════");
    println!();

    let state_data = web::Data::from(state);
    HttpServer::new(move || {
        App::new()
            .app_data(state_data.clone())
            // 静态页面
            .route("/", web::get().to(handlers::index_page))
            .route("/admin", web::get().to(handlers::admin_page))
            // API 路由
            .route("/api/v1/login", web::post().to(handlers::login))
            .route("/api/v1/config", web::get().to(handlers::get_config))
            .route("/api/v1/upload", web::post().to(handlers::upload))
            .route("/api/v1/version", web::get().to(handlers::version))
            .route("/api/v1/changelog", web::get().to(handlers::changelog))
            .route("/api/v1/template", web::get().to(handlers::template_download))
            // 管理员 API
            .route("/api/v1/admin/login", web::post().to(handlers::admin_login))
            .route("/api/v1/admin/config", web::route().to(handlers::admin_config))
            .route("/api/v1/admin/template/upload", web::post().to(handlers::template_upload))
            .route("/api/v1/admin/template/delete", web::post().to(handlers::template_delete))
            // 管理员 API v2
            .route("/api/v1/admin/files", web::get().to(handlers::admin_file_list))
            .route("/api/v1/admin/files/delete", web::post().to(handlers::admin_file_delete))
            .route("/api/v1/admin/stats", web::get().to(handlers::admin_stats))
            .route("/api/v1/admin/submissions", web::get().to(handlers::admin_submissions))
            .route("/api/v1/admin/password", web::post().to(handlers::admin_change_password))
            .route("/api/v1/admin/logs", web::get().to(handlers::admin_logs))
            // 静态文件服务（uploads 目录）
            .service(
                actix_files::Files::new("/uploads", "./uploads")
                    .show_files_listing()
            )
    })
    .bind(&bind_addr)?
    .run()
    .await
}