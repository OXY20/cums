# CUMS Tauri GUI 实施方案

## 📋 项目概述

**目标**：为 CUMS 项目添加基于 Tauri 的桌面 GUI 界面

**技术栈**：
- **后端**：Rust (Tauri)
- **前端**：Vanilla JS / React / Vue（可选）
- **通信**：与现有 CUMS Go 后端通过 HTTP API 通信
- **目标平台**：Windows（主要）、Linux、macOS

**预期成果**：
- 打包体积：~8-15MB
- 内存占用：~40-60MB
- 开发周期：2-3周

---

## 🏗️ 架构设计

### 整体架构

```
┌─────────────────────────────────────────────────────┐
│                  CUMS Desktop App                   │
│                                                       │
│  ┌──────────────────┐      ┌──────────────────┐     │
│  │  Tauri Frontend  │◄────►│  Tauri Backend   │     │
│  │   (Web UI)       │  IPC │   (Rust)         │     │
│  └──────────────────┘      └────────┬─────────┘     │
│                                      │               │
│                                      │ HTTP API      │
│                                      ▼               │
│                          ┌──────────────────────┐    │
│                          │  CUMS Go Backend     │    │
│                          │  (现有后端服务)        │    │
│                          │  localhost:3000      │    │
│                          └──────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### 目录结构

```
cums/
├── main.go                    # 现有 Go 后端
├── config.json                # 现有配置
├── static/                    # 现有 Web 界面
│   ├── index.html
│   └── admin.html
├── cums-gui/                  # 新增：Tauri GUI 项目
│   ├── src-tauri/            # Rust 后端
│   │   ├── src/
│   │   │   ├── main.rs      # Tauri 主入口
│   │   │   ├── cmd.rs       # Tauri 命令定义
│   │   │   ├── api.rs       # HTTP API 调用逻辑
│   │   │   └── types.rs     # 数据类型定义
│   │   ├── Cargo.toml       # Rust 依赖配置
│   │   ├── tauri.conf.json  # Tauri 配置
│   │   └── icons/           # 应用图标
│   ├── src/                 # 前端代码
│   │   ├── index.html       # 主界面
│   │   ├── styles.css       # 样式
│   │   ├── app.js           # 主逻辑
│   │   └── lib/
│   │       ├── api.js       # API 调用封装
│   │       └── ui.js        # UI 组件
│   ├── package.json         # Node.js 依赖
│   └── build/               # 编译输出
│       └── cums-gui.exe     # 最终可执行文件
└── docs/
    └── TAURI_GUI.md         # 本文档
```

---

## 🚀 实施步骤

### 第一阶段：环境准备（1天）

#### 1. 安装 Rust

**Windows**:
```powershell
# 下载并运行 rustup-init.exe
# 访问：https://rustup.rs/
# 或使用 winget
winget install Rustlang.Rustup
```

**验证安装**:
```powershell
rustc --version
cargo --version
```

#### 2. 安装 Node.js（用于前端开发）

```powershell
# 访问：https://nodejs.org/
# 或使用 winget
winget install OpenJS.NodeJS.LTS
```

**验证安装**:
```powershell
node --version
npm --version
```

#### 3. 安装 Tauri CLI

```powershell
# 使用 cargo 安装
cargo install tauri-cli

# 或使用 npm（推荐）
npm install -g @tauri-apps/cli
```

**验证安装**:
```powershell
cargo tauri --version
# 或
tauri --version
```

#### 4. 安装 Visual Studio Build Tools（Windows）

Tauri 在 Windows 上需要 C++ 编译工具：

```powershell
# 访问：https://visualstudio.microsoft.com/visual-cpp-build-tools/
# 安装 "Desktop development with C++" 工作负载
```

或使用 winget：
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"
```

#### 5. 安装 WebView2（Windows 10/11）

通常已预装，如果没有：
```powershell
winget install Microsoft.EdgeWebView2Runtime
```

---

### 第二阶段：创建项目框架（1天）

#### 步骤 1：初始化 Tauri 项目

在 `cums` 根目录下创建 GUI 项目：

```powershell
# 进入项目目录
cd C:\Users\ershi\Code\cums

# 创建 Tauri 项目（使用 Vanilla JS 模板）
npm create tauri-app@latest cums-gui

# 交互式选择：
# - Template name: cums-gui
# - Choose your language: TypeScript / JavaScript
# - Choose your package manager: npm / yarn / pnpm
# - Choose your UI template: Vanilla / React / Vue
#   推荐：Vanilla（简单快速）或 React（生态丰富）
```

或者使用 Cargo：
```powershell
cargo tauri init
```

#### 步骤 2：项目配置

编辑 `cums-gui/src-tauri/tauri.conf.json`：

```json
{
  "$schema": "https://schema.tauri.app/config/1",
  "productName": "CUMS 课堂管理系统",
  "version": "2.1.0",
  "identifier": "com.cums.desktop",
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "CUMS 课堂管理系统",
        "width": 1200,
        "height": 800,
        "resizable": true,
        "fullscreen": false,
        "transparent": false,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

---

### 第三阶段：开发 Tauri 后端（Rust）（3-4天）

#### 1. 添加依赖

编辑 `cums-gui/src-tauri/Cargo.toml`：

```toml
[package]
name = "cums-gui"
version = "2.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["devtools"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.11", features = ["json"] }
anyhow = "1.0"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

#### 2. 定义数据类型

创建 `cums-gui/src-tauri/src/types.rs`：

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub version: String,
    pub server_addr: String,
    pub admin_enabled: bool,
    pub admin_password: String,
    pub subjects: Vec<Subject>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Subject {
    pub name: String,
    pub classes: Vec<String>,
    pub homeworks: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct LoginRequest {
    pub class: String,
    pub student_id: String,
    pub student_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub message: Option<String>,
    pub data: Option<T>,
}
```

#### 3. 实现 API 调用逻辑

创建 `cums-gui/src-tauri/src/api.rs`：

```rust
use crate::types::*;
use anyhow::Result;
use reqwest::Client;

const CUMS_API_BASE: &str = "http://localhost:3000/api";

pub struct CumsApiClient {
    client: Client,
    base_url: String,
}

impl CumsApiClient {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.unwrap_or(CUMS_API_BASE.to_string()),
        }
    }

    /// 获取科目列表
    pub async fn get_subjects(&self) -> Result<Vec<Subject>> {
        let response = self
            .client
            .get(format!("{}/subjects", self.base_url))
            .send()
            .await?;

        let api_response: ApiResponse<Vec<Subject>> = response.json().await?;
        Ok(api_response.data.unwrap_or_default())
    }

    /// 添加科目
    pub async fn add_subject(&self, name: &str) -> Result<bool> {
        let mut map = std::collections::HashMap::new();
        map.insert("name", name);

        let response = self
            .client
            .post(format!("{}/subjects", self.base_url))
            .json(&map)
            .send()
            .await?;

        let api_response: ApiResponse<bool> = response.json().await?;
        Ok(api_response.success)
    }

    /// 添加班级
    pub async fn add_class(&self, subject: &str, class: &str) -> Result<bool> {
        let mut map = std::collections::HashMap::new();
        map.insert("subject", subject);
        map.insert("class", class);

        let response = self
            .client
            .post(format!("{}/classes", self.base_url))
            .json(&map)
            .send()
            .await?;

        let api_response: ApiResponse<bool> = response.json().await?;
        Ok(api_response.success)
    }

    /// 添加作业
    pub async fn add_homework(&self, subject: &str, homework: &str) -> Result<bool> {
        let mut map = std::collections::HashMap::new();
        map.insert("subject", subject);
        map.insert("homework", homework);

        let response = self
            .client
            .post(format!("{}/homeworks", self.base_url))
            .json(&map)
            .send()
            .await?;

        let api_response: ApiResponse<bool> = response.json().await?;
        Ok(api_response.success)
    }

    /// 删除科目
    pub async fn delete_subject(&self, name: &str) -> Result<bool> {
        let response = self
            .client
            .delete(format!("{}/subjects/{}", self.base_url, name))
            .send()
            .await?;

        let api_response: ApiResponse<bool> = response.json().await?;
        Ok(api_response.success)
    }

    /// 获取配置
    pub async fn get_config(&self) -> Result<Config> {
        let response = self
            .client
            .get(format!("{}/config", self.base_url))
            .send()
            .await?;

        let config: Config = response.json().await?;
        Ok(config)
    }
}
```

#### 4. 定义 Tauri 命令

创建 `cums-gui/src-tauri/src/cmd.rs`：

```rust
use crate::api::CumsApiClient;
use crate::types::*;
use tauri::State;

/// 全局状态：API 客户端
pub struct AppState {
    pub api_client: CumsApiClient,
}

/// Tauri 命令：获取所有科目
#[tauri::command]
pub async fn get_subjects(
    state: State<'_, AppState>,
) -> Result<Vec<Subject>, String> {
    state
        .api_client
        .get_subjects()
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：添加科目
#[tauri::command]
pub async fn add_subject(
    name: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .api_client
        .add_subject(&name)
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：添加班级
#[tauri::command]
pub async fn add_class(
    subject: String,
    class: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .api_client
        .add_class(&subject, &class)
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：添加作业
#[tauri::command]
pub async fn add_homework(
    subject: String,
    homework: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .api_client
        .add_homework(&subject, &homework)
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：删除科目
#[tauri::command]
pub async fn delete_subject(
    name: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    state
        .api_client
        .delete_subject(&name)
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：获取完整配置
#[tauri::command]
pub async fn get_config(
    state: State<'_, AppState>,
) -> Result<Config, String> {
    state
        .api_client
        .get_config()
        .await
        .map_err(|e| e.to_string())
}

/// Tauri 命令：检查后端连接
#[tauri::command]
pub async fn check_connection(
    state: State<'_, AppState>,
) -> Result<bool, String> {
    // 简单的连接检查
    match state.api_client.get_config().await {
        Ok(_) => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
```

#### 5. 主入口文件

编辑 `cums-gui/src-tauri/src/main.rs`：

```rust
// Prevents additional console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;
mod cmd;
mod types;

use api::CumsApiClient;
use cmd::AppState;

fn main() {
    // 初始化 API 客户端
    let api_client = CumsApiClient::new(None);

    tauri::Builder::default()
        // 设置全局状态
        .manage(AppState { api_client })
        // 注册 Tauri 命令
        .invoke_handler(tauri::generate_handler![
            cmd::get_subjects,
            cmd::add_subject,
            cmd::add_class,
            cmd::add_homework,
            cmd::delete_subject,
            cmd::get_config,
            cmd::check_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

### 第四阶段：开发前端界面（3-4天）

#### 1. 主界面 HTML

创建 `cums-gui/src/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CUMS 课堂管理系统</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div class="app-container">
        <!-- 侧边栏 -->
        <aside class="sidebar">
            <div class="logo">
                <h2>CUMS</h2>
                <p>课堂管理系统</p>
            </div>
            <nav class="nav-menu">
                <button class="nav-item active" data-view="dashboard">
                    <span class="icon">📊</span>
                    <span>概览</span>
                </button>
                <button class="nav-item" data-view="subjects">
                    <span class="icon">📚</span>
                    <span>科目管理</span>
                </button>
                <button class="nav-item" data-view="classes">
                    <span class="icon">👥</span>
                    <span>班级管理</span>
                </button>
                <button class="nav-item" data-view="homeworks">
                    <span class="icon">📝</span>
                    <span>作业管理</span>
                </button>
                <button class="nav-item" data-view="settings">
                    <span class="icon">⚙️</span>
                    <span>系统设置</span>
                </button>
            </nav>
            <div class="server-status">
                <span id="status-indicator" class="status-dot offline"></span>
                <span id="status-text">未连接</span>
            </div>
        </aside>

        <!-- 主内容区 -->
        <main class="main-content">
            <!-- 顶部栏 -->
            <header class="top-bar">
                <h1 id="page-title">概览</h1>
                <div class="top-bar-actions">
                    <button id="refresh-btn" class="btn-icon">🔄</button>
                    <button id="settings-btn" class="btn-icon">⚙️</button>
                </div>
            </header>

            <!-- 内容视图 -->
            <div id="content-area">
                <!-- 概览视图 -->
                <section id="dashboard-view" class="view active">
                    <div class="stats-grid">
                        <div class="stat-card">
                            <div class="stat-icon">📚</div>
                            <div class="stat-info">
                                <div class="stat-value" id="stat-subjects">-</div>
                                <div class="stat-label">科目数量</div>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-icon">👥</div>
                            <div class="stat-info">
                                <div class="stat-value" id="stat-classes">-</div>
                                <div class="stat-label">班级数量</div>
                            </div>
                        </div>
                        <div class="stat-card">
                            <div class="stat-icon">📝</div>
                            <div class="stat-info">
                                <div class="stat-value" id="stat-homeworks">-</div>
                                <div class="stat-label">作业数量</div>
                            </div>
                        </div>
                    </div>

                    <div class="quick-actions">
                        <h3>快速操作</h3>
                        <div class="action-buttons">
                            <button class="btn-primary" onclick="showAddSubjectModal()">
                                ➕ 添加科目
                            </button>
                            <button class="btn-secondary" onclick="showView('subjects')">
                                📚 管理科目
                            </button>
                        </div>
                    </div>
                </section>

                <!-- 科目管理视图 -->
                <section id="subjects-view" class="view">
                    <div class="view-header">
                        <h2>科目管理</h2>
                        <button class="btn-primary" onclick="showAddSubjectModal()">
                            ➕ 添加科目
                        </button>
                    </div>
                    <div id="subjects-list" class="items-list">
                        <!-- 动态生成 -->
                    </div>
                </section>

                <!-- 班级管理视图 -->
                <section id="classes-view" class="view">
                    <div class="view-header">
                        <h2>班级管理</h2>
                    </div>
                    <div id="classes-list" class="items-list">
                        <!-- 动态生成 -->
                    </div>
                </section>

                <!-- 作业管理视图 -->
                <section id="homeworks-view" class="view">
                    <div class="view-header">
                        <h2>作业管理</h2>
                    </div>
                    <div id="homeworks-list" class="items-list">
                        <!-- 动态生成 -->
                    </div>
                </section>

                <!-- 设置视图 -->
                <section id="settings-view" class="view">
                    <h2>系统设置</h2>
                    <div class="settings-form">
                        <div class="form-group">
                            <label>服务器地址</label>
                            <input type="text" id="server-url" value="http://localhost:3000">
                        </div>
                        <button class="btn-primary" onclick="saveSettings()">保存设置</button>
                    </div>
                </section>
            </div>
        </main>
    </div>

    <!-- 模态框：添加科目 -->
    <div id="modal-add-subject" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h3>添加科目</h3>
                <button class="modal-close" onclick="closeModal('modal-add-subject')">&times;</button>
            </div>
            <form onsubmit="handleAddSubject(event)">
                <div class="form-group">
                    <label for="subject-name">科目名称</label>
                    <input type="text" id="subject-name" required placeholder="例如：数学">
                </div>
                <div class="modal-actions">
                    <button type="button" class="btn-secondary" onclick="closeModal('modal-add-subject')">取消</button>
                    <button type="submit" class="btn-primary">添加</button>
                </div>
            </form>
        </div>
    </div>

    <!-- 通知提示 -->
    <div id="toast-container"></div>

    <script type="module" src="app.js"></script>
</body>
</html>
```

#### 2. 样式文件

创建 `cums-gui/src/styles.css`：

```css
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

:root {
    --primary-color: #2563eb;
    --primary-hover: #1d4ed8;
    --bg-color: #f8fafc;
    --sidebar-bg: #1e293b;
    --sidebar-text: #e2e8f0;
    --card-bg: #ffffff;
    --text-color: #0f172a;
    --border-color: #e2e8f0;
    --success-color: #22c55e;
    --danger-color: #ef4444;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    background: var(--bg-color);
    color: var(--text-color);
    height: 100vh;
    overflow: hidden;
}

.app-container {
    display: flex;
    height: 100vh;
}

/* 侧边栏 */
.sidebar {
    width: 250px;
    background: var(--sidebar-bg);
    color: var(--sidebar-text);
    display: flex;
    flex-direction: column;
}

.logo {
    padding: 2rem 1.5rem;
    border-bottom: 1px solid rgba(255,255,255,0.1);
}

.logo h2 {
    font-size: 2rem;
    margin-bottom: 0.25rem;
}

.logo p {
    font-size: 0.875rem;
    opacity: 0.7;
}

.nav-menu {
    flex: 1;
    padding: 1rem 0;
}

.nav-item {
    width: 100%;
    padding: 0.75rem 1.5rem;
    background: transparent;
    border: none;
    color: var(--sidebar-text);
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    transition: background 0.2s;
}

.nav-item:hover {
    background: rgba(255,255,255,0.05);
}

.nav-item.active {
    background: var(--primary-color);
}

.server-status {
    padding: 1rem 1.5rem;
    border-top: 1px solid rgba(255,255,255,0.1);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
}

.status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}

.status-dot.online {
    background: var(--success-color);
}

.status-dot.offline {
    background: var(--danger-color);
}

/* 主内容区 */
.main-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.top-bar {
    height: 64px;
    background: var(--card-bg);
    border-bottom: 1px solid var(--border-color);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 2rem;
}

.top-bar h1 {
    font-size: 1.5rem;
}

.top-bar-actions {
    display: flex;
    gap: 0.5rem;
}

.btn-icon {
    width: 40px;
    height: 40px;
    border: 1px solid var(--border-color);
    background: white;
    border-radius: 8px;
    cursor: pointer;
    font-size: 1.25rem;
    transition: all 0.2s;
}

.btn-icon:hover {
    background: var(--bg-color);
}

/* 内容区域 */
#content-area {
    flex: 1;
    overflow-y: auto;
    padding: 2rem;
}

.view {
    display: none;
}

.view.active {
    display: block;
}

/* 统计卡片 */
.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1.5rem;
    margin-bottom: 2rem;
}

.stat-card {
    background: var(--card-bg);
    padding: 1.5rem;
    border-radius: 12px;
    display: flex;
    align-items: center;
    gap: 1rem;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.stat-icon {
    font-size: 2.5rem;
}

.stat-value {
    font-size: 2rem;
    font-weight: bold;
    color: var(--primary-color);
}

.stat-label {
    font-size: 0.875rem;
    color: #64748b;
}

/* 快速操作 */
.quick-actions {
    background: var(--card-bg);
    padding: 1.5rem;
    border-radius: 12px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.quick-actions h3 {
    margin-bottom: 1rem;
}

.action-buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
}

/* 按钮样式 */
.btn-primary {
    padding: 0.625rem 1.25rem;
    background: var(--primary-color);
    color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    transition: background 0.2s;
}

.btn-primary:hover {
    background: var(--primary-hover);
}

.btn-secondary {
    padding: 0.625rem 1.25rem;
    background: white;
    color: var(--text-color);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
}

.btn-secondary:hover {
    background: var(--bg-color);
}

/* 列表视图 */
.view-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
}

.items-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}

.item-card {
    background: var(--card-bg);
    padding: 1rem 1.5rem;
    border-radius: 8px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}

.item-title {
    font-weight: 500;
    font-size: 1.125rem;
}

.item-meta {
    font-size: 0.875rem;
    color: #64748b;
    margin-top: 0.25rem;
}

.item-actions {
    display: flex;
    gap: 0.5rem;
}

/* 表单 */
.form-group {
    margin-bottom: 1rem;
}

.form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
}

.form-group input {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    font-size: 1rem;
}

/* 模态框 */
.modal {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    z-index: 1000;
    align-items: center;
    justify-content: center;
}

.modal.active {
    display: flex;
}

.modal-content {
    background: white;
    padding: 1.5rem;
    border-radius: 12px;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1);
}

.modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
}

.modal-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
}

.modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1.5rem;
}

/* 通知 */
#toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 1001;
}

.toast {
    background: white;
    padding: 1rem 1.5rem;
    border-radius: 8px;
    margin-bottom: 0.5rem;
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
    animation: slideIn 0.3s ease;
}

@keyframes slideIn {
    from {
        transform: translateX(400px);
        opacity: 0;
    }
    to {
        transform: translateX(0);
        opacity: 1;
    }
}

.toast.success {
    border-left: 4px solid var(--success-color);
}

.toast.error {
    border-left: 4px solid var(--danger-color);
}
```

#### 3. 主逻辑文件

创建 `cums-gui/src/app.js`：

```javascript
// 导入 Tauri API
const { invoke } = window.__TAURI__.core;

// 应用状态
let currentConfig = null;

// 初始化应用
async function init() {
    await checkConnection();
    await loadDashboard();
    setupEventListeners();
}

// 检查连接状态
async function checkConnection() {
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');

    try {
        await invoke('check_connection');
        statusIndicator.classList.remove('offline');
        statusIndicator.classList.add('online');
        statusText.textContent = '已连接';
        showToast('后端服务已连接', 'success');
    } catch (error) {
        statusIndicator.classList.remove('online');
        statusIndicator.classList.add('offline');
        statusText.textContent = '未连接';
        showToast('无法连接到后端服务', 'error');
    }
}

// 加载概览数据
async function loadDashboard() {
    try {
        const config = await invoke('get_config');
        currentConfig = config;

        // 计算统计数据
        const subjectCount = config.subjects?.length || 0;
        let classCount = 0;
        let homeworkCount = 0;

        if (config.subjects) {
            config.subjects.forEach(subject => {
                classCount += subject.classes?.length || 0;
                homeworkCount += subject.homeworks?.length || 0;
            });
        }

        document.getElementById('stat-subjects').textContent = subjectCount;
        document.getElementById('stat-classes').textContent = classCount;
        document.getElementById('stat-homeworks').textContent = homeworkCount;
    } catch (error) {
        console.error('加载概览失败:', error);
        showToast('加载数据失败: ' + error, 'error');
    }
}

// 加载科目列表
async function loadSubjects() {
    try {
        const subjects = await invoke('get_subjects');
        const container = document.getElementById('subjects-list');

        if (!subjects || subjects.length === 0) {
            container.innerHTML = '<p class="empty-state">暂无科目</p>';
            return;
        }

        container.innerHTML = subjects.map(subject => `
            <div class="item-card">
                <div>
                    <div class="item-title">${subject.name}</div>
                    <div class="item-meta">
                        ${subject.classes?.length || 0} 个班级 ·
                        ${subject.homeworks?.length || 0} 个作业
                    </div>
                </div>
                <div class="item-actions">
                    <button class="btn-secondary" onclick="deleteSubject('${subject.name}')">
                        🗑️ 删除
                    </button>
                </div>
            </div>
        `).join('');
    } catch (error) {
        console.error('加载科目失败:', error);
        showToast('加载科目失败: ' + error, 'error');
    }
}

// 添加科目
async function handleAddSubject(event) {
    event.preventDefault();

    const nameInput = document.getElementById('subject-name');
    const name = nameInput.value.trim();

    if (!name) {
        showToast('请输入科目名称', 'error');
        return;
    }

    try {
        await invoke('add_subject', { name });
        showToast('科目添加成功', 'success');
        closeModal('modal-add-subject');
        nameInput.value = '';
        await loadSubjects();
        await loadDashboard();
    } catch (error) {
        console.error('添加科目失败:', error);
        showToast('添加科目失败: ' + error, 'error');
    }
}

// 删除科目
async function deleteSubject(name) {
    if (!confirm(`确定要删除科目 "${name}" 吗？`)) {
        return;
    }

    try {
        await invoke('delete_subject', { name });
        showToast('科目删除成功', 'success');
        await loadSubjects();
        await loadDashboard();
    } catch (error) {
        console.error('删除科目失败:', error);
        showToast('删除科目失败: ' + error, 'error');
    }
}

// 视图切换
function showView(viewName) {
    // 隐藏所有视图
    document.querySelectorAll('.view').forEach(view => {
        view.classList.remove('active');
    });

    // 移除所有导航项的 active 状态
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    // 显示目标视图
    const targetView = document.getElementById(`${viewName}-view`);
    if (targetView) {
        targetView.classList.add('active');
    }

    // 激活对应导航项
    const navItem = document.querySelector(`.nav-item[data-view="${viewName}"]`);
    if (navItem) {
        navItem.classList.add('active');
    }

    // 更新标题
    const titles = {
        dashboard: '概览',
        subjects: '科目管理',
        classes: '班级管理',
        homeworks: '作业管理',
        settings: '系统设置'
    };
    document.getElementById('page-title').textContent = titles[viewName] || viewName;

    // 加载对应数据
    if (viewName === 'dashboard') {
        loadDashboard();
    } else if (viewName === 'subjects') {
        loadSubjects();
    }
}

// 模态框操作
function showAddSubjectModal() {
    document.getElementById('modal-add-subject').classList.add('active');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('active');
}

// 显示通知
function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // 3秒后自动移除
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// 设置事件监听
function setupEventListeners() {
    // 导航菜单
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const viewName = item.dataset.view;
            showView(viewName);
        });
    });

    // 刷新按钮
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        await checkConnection();
        await loadDashboard();
        showToast('已刷新', 'success');
    });

    // 点击模态框背景关闭
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.remove('active');
            }
        });
    });
}

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
```

#### 4. 配置 Tauri 允许的 API

在 `cums-gui/src-tauri/tauri.conf.json` 中添加权限配置（如果使用 Tauri v2）：

```json
{
  "tauri": {
    "allowlist": {
      "all": false,
      "shell": {
        "all": false,
        "open": true
      },
      "http": {
        "all": true,
        "request": true,
        "scope": ["http://localhost:3000/*"]
      }
    }
  }
}
```

---

### 第五阶段：集成和测试（2天）

#### 1. 确保 CUMS 后端运行

```powershell
# 在一个终端窗口中启动 CUMS 后端
cd C:\Users\ershi\Code\cums
go run main.go
```

#### 2. 开发模式下运行 Tauri GUI

```powershell
# 在另一个终端窗口中
cd C:\Users\ershi\Code\cums\cums-gui
npm run tauri dev
```

这将：
- 启动前端开发服务器
- 打开 Tauri 应用窗口
- 支持热重载

#### 3. 测试功能

- [ ] 连接状态检查
- [ ] 加载概览数据
- [ ] 添加科目
- [ ] 删除科目
- [ ] 视图切换
- [ ] 错误处理

---

### 第六阶段：打包和分发（1天）

#### 1. 构建生产版本

```powershell
cd C:\Users\ershi\Code\cums\cums-gui
npm run tauri build
```

构建完成后，可执行文件位于：
- `cums-gui/src-tauri/target/release/cums-gui.exe`
- 或 `cums-gui/src-tauri/target/release/bundle/nsis/CUMS-课堂管理系统_2.1.0_x64-setup.exe`（安装程序）

#### 2. 分发方案

**方案 A：独立可执行文件**
- 只需分发 `cums-gui.exe`（~10MB）
- 用户需要先运行 CUMS 后端

**方案 B：一键启动包**
- 创建批处理文件 `start-cums.bat`：
```batch
@echo off
start "" cums.exe
timeout /t 2 /nobreak > nul
start "" cums-gui.exe
```

**方案 C：完整安装包**
- 使用 NSIS 或 Inno Setup 创建安装程序
- 同时安装后端和 GUI
- 配置自动启动

---

## 📚 API 扩展建议

基于你的 CUMS 项目，你可能需要在 Go 后端添加以下 API：

### 现有 API（需要确认）
- `GET /api/config` - 获取配置
- `POST /api/subjects` - 添加科目
- `DELETE /api/subjects/{name}` - 删除科目
- `POST /api/classes` - 添加班级
- `POST /api/homeworks` - 添加作业

### 可能需要新增的 API
- `GET /api/subjects` - 获取科目列表（带班级和作业）
- `PUT /api/subjects/{name}` - 更新科目
- `GET /api/stats` - 获取统计数据
- `GET /api/uploads` - 获取上传文件列表

---

## 🐛 常见问题排查

### 问题 1：Tauri 无法连接到后端

**原因**：CORS 或后端未启动

**解决**：
1. 确保后端已启动（`go run main.go`）
2. 在 Go 后端添加 CORS 支持
3. 检查端口是否正确（默认 3000）

### 问题 2：打包后体积过大

**原因**：包含了调试符号

**解决**：
```powershell
# 使用 --release 标志
cargo tauri build --release
```

### 问题 3：Windows Defender 报警

**原因**：未签名可执行文件

**解决**：
- 添加数字签名（需要代码签名证书）
- 或告知用户添加信任

---

## 📚 学习资源

**Tauri 官方文档**：
- https://tauri.app/
- https://tauri.app/v1/guides/

**Rust 学习**：
- https://www.rust-lang.org/learn
- 《Rust 程序设计语言》

**示例项目**：
- https://github.com/tauri-apps/tauri/tree/dev/examples

---

## 🎯 下一步行动

**立即开始**：
1. ✅ 安装 Rust 和 Node.js
2. ✅ 创建 Tauri 项目骨架
3. ✅ 实现基础的 API 调用
4. ✅ 开发简单的管理界面

**预期时间线**：
- 第 1 周：环境搭建 + 基础框架
- 第 2 周：核心功能开发
- 第 3 周：测试和优化

---

**审阅意见**:
- **用户意见**: [待反馈]
- **追加建议**:
  - 建议先实现 MVP（最小可行产品），只包含科目管理功能
  - 逐步迭代添加班级、作业管理等功能
  - 考虑添加系统托盘图标，让应用最小化到托盘
- **实施状态**: [ ] 待实施
