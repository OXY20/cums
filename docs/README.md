# 文件上传系统

## 简介

一个简洁的机房文件上传系统，前端使用HTML，后端使用Go语言。

## 功能特性

- 简洁的登录界面（班级选择 + 学号姓名输入）
- 动态加载科目和作业列表
- 文件自动重命名：`{作业名}_{学号}_{姓名}.{扩展名}`
- 同名文件自动添加时间戳后缀
- 配置通过TOML文件管理

## 项目结构

```
cums/
├── main.go                # 后端主程序
├── config.toml            # 配置文件
├── static/
│   └── index.html         # 前端页面
├── uploads/               # 上传文件存储目录
│   └── {班级名}/{科目名}/{文件名}
└── go.mod                 # Go模块
```

## 快速开始

### 1. 初始化项目

```bash
go mod init cums
go get github.com/BurntSushi/toml
```

### 2. 配置系统

编辑 `config.toml` 文件，配置班级、科目和作业：

```toml
[classes."一班"]
subjects = { 数学 = ["第一章作业", "第二章作业"], 语文 = ["作文"] }

[classes."二班"]
subjects = { 英语 = ["听力练习"], 物理 = ["实验报告"] }
```

### 3. 运行系统

```bash
go run main.go
```

访问 http://localhost:8080

## API接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | / | 返回前端页面 |
| POST | /api/v1/login | 用户登录 |
| POST | /api/v1/config | 获取配置信息 |
| POST | /api/v1/upload | 文件上传 |

### 登录接口

请求：
```json
{
  "class": "一班",
  "student_id": "01",
  "student_name": "张三"
}
```

响应：
```json
{
  "success": true,
  "data": {
    "class": "一班",
    "student_id": "01",
    "student_name": "张三"
  }
}
```

### 配置接口

响应：
```json
{
  "success": true,
  "data": {
    "classes": ["一班", "二班"]
  },
  "homeworks": {
    "一班": {
      "数学": ["第一章作业", "第二章作业"],
      "语文": ["作文"]
    }
  }
}
```

### 上传接口

表单字段：
- `class`: 班级名
- `student_id`: 学号
- `student_name`: 姓名
- `subject`: 科目
- `homework`: 作业名
- `file`: 文件

响应：
```json
{
  "success": true,
  "message": "上传成功",
  "filename": "第一章作业_01_张三_20240101120000.docx"
}
```

## 文件命名规则

上传文件自动重命名：

```
{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}
```

示例：`第一章作业_01_张三_20240101120000.docx`

## 依赖

- Go 1.18+
- github.com/BurntSushi/toml

## 许可证

MIT
