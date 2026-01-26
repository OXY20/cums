# CUMS - 课堂文件上传管理系统

<p align="center">
  <img src="https://img.shields.io/badge/version-2.3.0-blue.svg" alt="version">
  <img src="https://img.shields.io/badge/Go-1.21+-00ADD8.svg" alt="Go">
  <img src="https://img.shields.io/badge/license-MIT-green.svg" alt="license">
</p>

一个简洁高效的机房文件上传系统，采�?*以科目为中心**的架构设计，专为学校机房环境优化�?

## �?功能特�?

- 🎯 **以科目为中心** - 按科目管理班级和作业，符合教师使用习�?
- 🔐 **简洁登�?* - 班级选择 + 学号姓名，无需复杂认证
- 📊 **级联选择** - 科目 �?班级 �?作业的流畅操作流�?
- 📁 **智能存储** - 文件自动�?`uploads/科目/班级/作业/` 分类存储
- 🏷�?**自动命名** - `{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}`
- 🌐 **局域网访问** - 支持学生机通过局域网地址访问
- 🔧 **Web 管理后台** - 可通过浏览器管理科目、班级、作业配�?
- 📝 **实时日志** - 控制台和文件双重日志记录
- 💻 **跨平�?* - 支持 Windows / Linux / macOS

## 🚀 快速开�?

### 下载运行

1. �?[Releases](https://github.com/OXY20/cums/releases) 下载对应平台的可执行文件
2. 双击运行或在终端执行
3. 浏览器访问控制台显示的地址（默�?http://localhost:3000�?

### 从源码编�?

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

## 📖 使用说明

### 学生�?

1. 访问系统地址，点�?登录"
2. 选择班级，输入学号和姓名
3. 选择科目 �?班级 �?作业
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

2. 重启程序后访�?`/admin` 路由
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

## ⚙️ 配置说明

配置文件 `config.json` 示例�?

```json
{
    "version": "2.3.0",
    "server_addr": ":3000",
    "admin_enabled": false,
    "admin_password": "admin123",
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

| 配置�?| 说明 | 默认�?|
|--------|------|--------|
| `server_addr` | 服务器端�?| `:3000` |
| `admin_enabled` | 是否启用管理后台 | `false` |
| `admin_password` | 管理员密�?| `""` |
| `subjects` | 科目配置 | - |

> ⚠️ 管理员密码以明文存储，请确保仅在可信网络环境使用�?

## 📂 项目结构

```
cums/
├── main.go           # 后端主程�?
├── embed.go          # 嵌入文件
├── config.json       # 配置文件
├── static/
�?  ├── index.html    # 学生端页�?
�?  └── admin.html    # 管理后台页面
├── uploads/          # 上传文件目录
├── logs/             # 日志目录
└── docs/             # 详细文档
    ├── README.md     # 详细说明
    ├── CONFIG.md     # 配置详解
    ├── API.md        # API 文档
    └── ...
```

## 📚 文档

- [详细说明](./docs/README.md)
- [配置文档](./docs/CONFIG.md)
- [API 文档](./docs/API.md)
- [架构设计](./docs/ARCHITECTURE.md)
- [开发指南](./docs/DEVELOPMENT.md)

## 📋 后期规划

- [ ] 作业模板下载功能
- [ ] 作业说明文字/图片
- [ ] 更多管理功能

## 🤝 贡献

欢迎提交 Issue �?Pull Request�?

## 📄 许可�?

[MIT License](LICENSE)

---

**版本**: v2.3.0 | **更新**: 2026-01-26
