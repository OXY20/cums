# CUMS Tauri GUI 快速启动指南

## 📦 第一步：安装开发环境

### 1. 安装 Rust

**下载地址**：https://rustup.rs/

或使用命令（推荐）：
```powershell
winget install Rustlang.Rustup
```

**验证安装**：
```powershell
rustc --version
# 应显示：rustc 1.xx.x
```

---

### 2. 安装 Node.js

**下载地址**：https://nodejs.org/（推荐 LTS 版本）

或使用命令：
```powershell
winget install OpenJS.NodeJS.LTS
```

**验证安装**：
```powershell
node --version
npm --version
```

---

### 3. 安装 Visual Studio Build Tools（Windows 必需）

**下载地址**：https://visualstudio.microsoft.com/visual-cpp-build-tools/

安装时选择：
- ✅ **Desktop development with C++**

或使用命令：
```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools;includeRecommended"
```

⏰ **预计时间**：10-30 分钟（取决于网速）

---

### 4. 安装 Tauri CLI

```powershell
npm install -g @tauri-apps/cli
```

**验证安装**：
```powershell
tauri --version
```

---

## 🚀 第二步：创建 Tauri 项目

### 方式 A：使用 npm 创建（推荐）

```powershell
# 进入 cums 项目根目录
cd C:\Users\ershi\Code\cums

# 创建 Tauri 项目
npm create tauri-app@latest

# 交互式提示：
# ✔ Enter your app name · cums-gui
# ✔ Choose your language · TypeScript / JavaScript
# ✔ Choose your package manager · npm (或其他)
# ✔ Choose your UI template · Vanilla (推荐)
#   或者选择 React/Vue 如果你想用框架
```

### 方式 B：手动创建

```powershell
# 创建项目目录
mkdir cums-gui
cd cums-gui

# 初始化 npm 项目
npm init -y

# 安装 Tauri
npm install @tauri-apps/cli

# 初始化 Tauri
npx tauri init
```

---

### 项目结构预览

```
cums-gui/
├── src/                 # 前端源码
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src-tauri/          # Rust 后端
│   ├── src/
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
└── package.json
```

---

## ⚙️ 第三步：配置和运行

### 1. 修改 Tauri 配置

编辑 `cums-gui/src-tauri/tauri.conf.json`：

```json
{
  "build": {
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build",
    "devUrl": "http://localhost:5173",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [{
      "title": "CUMS 课堂管理系统",
      "width": 1200,
      "height": 800,
      "resizable": true
    }]
  }
}
```

### 2. 添加 Rust 依赖

编辑 `cums-gui/src-tauri/Cargo.toml`：

```toml
[dependencies]
tauri = { version = "2", features = ["devtools"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.11", features = ["json"] }
anyhow = "1"
```

### 3. 开发模式运行

```powershell
# 进入 Tauri 项目目录
cd cums-gui

# 启动开发服务器
npm run tauri dev
```

🎉 **成功！** 你应该会看到一个应用窗口打开！

---

## 🧪 测试连接

### 1. 确保后端运行

在**另一个终端**中：
```powershell
cd C:\Users\ershi\Code\cums
go run main.go
```

后端会显示：`Server started at http://localhost:3000`

### 2. 测试 API 调用

在 `cums-gui/src-tauri/src/main.rs` 中添加测试命令：

```rust
#[tauri::command]
async fn test_connection() -> Result<String, String> {
    // 测试连接到 CUMS 后端
    match reqwest::get("http://localhost:3000/api/config").await {
        Ok(response) => Ok("连接成功！".to_string()),
        Err(e) => Err(format!("连接失败: {}", e)),
    }
}

// 在 main() 中注册
.invoke_handler(tauri::generate_handler![
    test_connection,
    // ... 其他命令
])
```

### 3. 在前端调用

在 `cums-gui/src/app.js` 中：

```javascript
const { invoke } = window.__TAURI__.core;

async function testConnection() {
    try {
        const result = await invoke('test_connection');
        console.log(result);
        alert(result);
    } catch (error) {
        console.error(error);
        alert(error);
    }
}

testConnection();
```

---

## 🏗️ 下一步：实施 MVP

### 最小可行产品（MVP）功能

1. ✅ **连接检查** - 检测 CUMS 后端是否运行
2. ✅ **科目列表** - 显示所有科目
3. ✅ **添加科目** - 简单的添加功能
4. ✅ **删除科目** - 删除功能

### 预计时间

- **今日**：环境搭建 + 项目创建 ✅
- **明天**：实现基础 UI + API 调用
- **后天**：完善功能 + 测试

---

## 📚 常用命令

```powershell
# 开发模式
npm run tauri dev

# 构建生产版本
npm run tauri build

# 检查 Tauri 版本
tauri --version

# 查看帮助
tauri --help
```

---

## 🆘 遇到问题？

### 问题：Rust 编译错误

```powershell
# 更新 Rust
rustup update
```

### 问题：npm install 失败

```powershell
# 清除缓存
npm cache clean --force

# 使用国内镜像
npm config set registry https://registry.npmmirror.com
```

### 问题：WebView2 缺失

```powershell
# 安装 WebView2
winget install Microsoft.EdgeWebView2Runtime
```

---

## 🎯 学习资源

- **Tauri 官方文档**：https://tauri.app/v1/guides/
- **Rust 学习**：https://www.rust-lang.org/zh-CN/learn
- **示例代码**：https://github.com/tauri-apps/tauri/tree/dev/examples

---

## 📞 获取帮助

如果遇到问题：
1. 查看 `docs/TAURI_GUI.md` 详细文档
2. 检查 Tauri 官方文档
3. 在项目仓库提 Issue

**现在开始吧！加油！** 🚀
