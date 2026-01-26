# CUMS v2.3.0 Release

## 📝 版本简�?

CUMS (Classroom Upload Management System) v2.3.0 是一个专为机房环境设计的文件上传系统，采�?*以科目为中心**的架构设计，支持多班级、多科目、多作业的上传管理�?

**v2.3.0 是版本升级更�?*，继承了 v2.0.0 的所有功能�?

## 🎉 主要特�?

### 核心功能
- 🎯 **以科目为中心** - 按科目管理班级和作业，符合教师使用习�?
- 🔐 **简洁登�?* - 班级选择 + 学号姓名，无需复杂认证
- 📊 **级联选择** - 科目 �?班级 �?作业的流畅操作流�?
- 📁 **智能存储** - 文件自动�?`uploads/科目/班级/作业/` 分类存储
- 🏷�?**自动命名** - `{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}`
- 🌐 **局域网访问** - 支持学生机通过局域网地址访问
- 📝 **实时日志** - 控制台和文件双重日志记录，包含IP和主机名
- 💻 **跨平�?* - 支持 Windows / Linux / macOS

### v2.0.0 新增功能

#### 🔧 Web 管理后台
- 通过浏览器管理科目、班级、作业配�?
- 访问地址: `http://localhost:3000/admin`
- 配置实时生效，无需重启
- 支持在线添加、修改配�?

#### 📊 客户端主机名记录
- 上传日志中自动记录客户端主机�?
- 通过反向DNS查询获取
- 日志格式: `[时间] 班级 学号姓名 提交 科目-作业 IP:xxx 主机�?hostname`

#### 🚀 架构优化
- 代码�?900+ 行精简�?664 �?
- 目录结构简化，配置文件位于根目�?
- 版本号统一�?`config.json` 读取

## 🚀 快速开�?

### 方式一：直接运�?

```bash
# Windows
cums_2.3.0_20260126.exe

# Linux
chmod +x cums_2.3.0_20260126
./cums_2.3.0_20260126

# macOS
chmod +x cums_2.3.0_20260126
./cums_2.3.0_20260126
```

### 方式二：从源码编�?

```bash
# 克隆仓库
git clone https://github.com/OXY20/cums.git
cd cums

# 运行
go run main.go

# 或编译后运行
go build -o cums.exe .
./cums.exe
```

## ⚙️ 配置说明

### 基础配置

编辑根目录下�?`config.json`�?

```json
{
    "version": "2.3.0",
    "server_addr": ":3000",
    "admin_enabled": false,
    "admin_password": "",
    "subjects": {
        "数学": {
            "classes": ["一�?, "二班"],
            "homeworks": ["第一章作�?, "第二章作�?]
        },
        "语文": {
            "classes": ["一�?],
            "homeworks": ["作文", "阅读理解"]
        }
    }
}
```

### 启用管理后台

```json
{
    "version": "2.3.0",
    "server_addr": ":3000",
    "admin_enabled": true,
    "admin_password": "your_secure_password",
    "subjects": {
        "数学": {
            "classes": ["一�?, "二班"],
            "homeworks": ["第一章作�?, "第二章作�?]
        }
    }
}
```

然后访问 `http://localhost:3000/admin` 进行管理�?

| 配置�?| 说明 | 默认�?| 必填 |
|--------|------|--------|------|
| `version` | 版本�?| `"2.3.0"` | �?|
| `server_addr` | 服务器端�?| `":3000"` | �?|
| `admin_enabled` | 是否启用管理后台 | `false` | �?|
| `admin_password` | 管理员密�?| `""` | 启用管理后台时必�?|
| `subjects` | 科目配置 | - | �?|

> ⚠️ **安全提示**: 管理员密码以明文存储，请确保仅在可信网络环境使用�?

## 📁 目录结构

```
cums/
├── main.go              # 后端主程�?
├── embed.go             # 嵌入文件
├── config.json          # 配置文件（根目录�?
├── static/
�?  ├── index.html       # 学生端页�?
�?  └── admin.html       # 管理后台页面
├── uploads/              # 上传文件目录
�?  ├── 数学/
�?  �?  ├── 一�?
�?  �?  �?  └── 第一章作�?
�?  �?  └── 二班/
�?  └── 语文/
├── logs/
�?  └── cums.log         # 上传日志
└── docs/                 # 详细文档
```

## 📖 使用说明

### 学生�?

1. 访问系统地址（默�?`http://localhost:3000`�?
2. 点击"登录"，选择班级，输入学号和姓名
3. 选择科目 �?选择作业
4. 选择文件并上�?

### 教师�?

#### 方式一：Web 管理后台（推荐）

1. 编辑 `config.json`，启用管理功能：
```json
{
    "admin_enabled": true,
    "admin_password": "your_password"
}
```

2. 重启程序后访�?`http://localhost:3000/admin`
3. 输入密码登录，即可管理科目、班级、作�?

#### 方式二：直接编辑配置文件

编辑 `config.json` 文件，修改后重启程序生效�?

### 查看上传的文�?

```
uploads/
├── 数学/
�?  ├── 一�?
�?  �?  └── 第一章作�?
�?  �?      └── 第一章作业_01_张三_20260122.docx
�?  └── 二班/
├── 语文/
└── 英语/
```

### 查看日志

日志文件位于 `logs/cums.log`，格式示例：

```
[2026-01-22 10:30:45] 25计应 1号张�?提交 文字处理-WPS21 IP:192.168.3.33 主机�?DESKTOP-ABC123
[2026-01-22 10:31:20] 25计应 2号李�?提交 文字处理-WT19 IP:192.168.3.34 主机�?未知主机
```

## 📊 功能特性对�?

| 功能 | v1.0.4 | v2.0.0 |
|------|--------|--------|
| 管理后台 | �?| �?Web界面 |
| 主机名记�?| �?| �?反向DNS查询 |
| 代码行数 | 900+ | 664 |
| 目录结构 | `cums/` 子目�?| 根目�?|
| 版本管理 | 硬编�?| 配置文件 |
| 启动信息 | 基础 | 详细指南 |

## 🔄 �?v1.0.4 升级

### 升级步骤

1. **备份数据**
   ```bash
   # 备份旧版本数�?
   cp -r cums/uploads uploads_backup
   cp cums/config.json config_backup.json
   ```

2. **停止旧版本服�?*

3. **下载新版�?*
   - �?[Releases](https://github.com/OXY20/cums/releases) 下载 v2.0.0
   - 或从源码编译

4. **迁移配置**
   - �?`cums/config.json` 复制到根目录
   - 更新版本号为 `"2.0.0"`
   - 如需启用管理后台，添�?`admin_enabled` �?`admin_password`

5. **迁移数据**（可选）
   - �?`cums/uploads/` 复制到根目录 `uploads/`
   - �?`cums/logs/` 复制到根目录 `logs/`

6. **启动新版�?*

### 配置变更

**v1.0.4 配置**:
```json
{
    "version": "1.0.4",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "subjects": { ... }
}
```

**v2.0.0 配置**:
```json
{
    "version": "2.3.0",
    "server_addr": ":3000",
    "admin_enabled": false,
    "admin_password": "",
    "subjects": { ... }
}
```

**变更说明**:
- �?移除 `upload_dir`（统一使用 `uploads/`�?
- �?新增 `admin_enabled`（管理后台开关）
- �?新增 `admin_password`（管理员密码�?

## 📋 更新日志

### v2.0.0 (2026-01-22)

#### 新增功能
- �?Web 管理后台
- �?客户端主机名记录
- �?启动信息优化

#### 架构优化
- �?代码简化（900+ �?664 行）
- �?目录结构优化（移除子目录�?
- �?版本号从配置文件读取

#### 功能改进
- �?科目过滤（只显示包含当前班级的科目）
- �?班级快速选择
- �?配置验证

### v1.0.4 (2026-01-21)
- �?架构重构：以科目为中�?
- �?灵活登录：支持多班级共用
- �?启动信息优化

### v1.0.2 (2026-01-20)
- �?局域网访问支持
- �?端口自动检�?

### v1.0.1 (2026-01-20)
- �?文件上传日志记录

### v1.0.0 (2026-01-20)
- 🎉 初始版本发布

## 🔒 注意事项

1. **首次运行**会自动创建必要的目录结构
2. **日志文件**会自动创建在 `logs/` 目录
3. **管理后台密码**以明文存储，请确保仅在可信网络环境使�?
4. **修改配置**后需要重启服�?
5. **主机名查�?*可能失败（局域网IP通常无法查询），会显�?未知主机"

## 📦 下载文件

| 平台 | 文件�?| 大小 |
|------|--------|------|
| Windows | cums_2.3.0_20260126.exe | ~6.5 MB |
| Linux | cums_2.3.0_20260126 | ~6.2 MB |
| macOS | cums_2.3.0_20260126 | ~6.3 MB |

## 📚 文档

- [README.md](./README.md) - 项目介绍和快速开�?
- [CHANGELOG.md](./CHANGELOG.md) - 详细更新日志
- [docs/CONFIG.md](./docs/CONFIG.md) - 配置详解
- [docs/API.md](./docs/API.md) - API 文档
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) - 架构设计

## 📞 联系方式

- **GitHub**: https://github.com/OXY20/cums
- **Issues**: https://github.com/OXY20/cums/issues
- **Releases**: https://github.com/OXY20/cums/releases

---

**CUMS v2.3.0** - 让机房文件上传更简单！

**发布日期**: 2026-01-26
**版本**: v2.3.0
**许可�?*: MIT
