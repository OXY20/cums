# API 文档

## 基础信息

- **基础路径**: `/api/v1`
- **Content-Type**: `application/json` (登录/配置), `multipart/form-data` (上传)
- **编码**: UTF-8

---

## 1. 用户登录

### 接口路径
```
POST /api/v1/login
```

### 请求参数 (JSON)

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| class | string | 是 | 班级名称 |
| student_id | string | 是 | 学生学号 |
| student_name | string | 是 | 学生姓名 |

### 请求示例
```json
{
  "class": "一班",
  "student_id": "01",
  "student_name": "张三"
}
```

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| success | bool | 是否成功 |
| message | string | 提示信息 |
| data | object | 用户信息 |

### 响应示例
```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "class": "一班",
    "student_id": "01",
    "student_name": "张三"
  }
}
```

### 错误响应
```json
{
  "success": false,
  "message": "班级不存在",
  "data": null
}
```

---

## 2. 获取配置

### 接口路径
```
POST /api/v1/config
```

### 请求参数
无

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| success | bool | 是否成功 |
| data.classes | array | 班级列表 |
| data.homeworks | object | 作业配置 |

### 响应示例
```json
{
  "success": true,
  "data": {
    "classes": ["一班", "二班", "三班"],
    "homeworks": {
      "一班": {
        "数学": ["第一章作业", "第二章作业"],
        "语文": ["作文", "阅读理解"]
      },
      "二班": {
        "物理": ["实验报告"]
      }
    }
  }
}
```

---

## 3. 文件上传

### 接口路径
```
POST /api/v1/upload
```

### Content-Type
`multipart/form-data`

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| class | string | 是 | 班级名称 |
| student_id | string | 是 | 学生学号 |
| student_name | string | 是 | 学生姓名 |
| subject | string | 是 | 科目名称 |
| homework | string | 是 | 作业名称 |
| file | file | 是 | 上传的文件 |

### 请求示例 (cURL)
```bash
curl -X POST http://localhost:8080/api/v1/upload \
  -F "class=一班" \
  -F "student_id=01" \
  -F "student_name=张三" \
  -F "subject=数学" \
  -F "homework=第一章作业" \
  -F "file=@/path/to/homework.docx"
```

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| success | bool | 是否成功 |
| message | string | 提示信息 |
| filename | string | 保存的文件名 |
| filepath | string | 文件完整路径 |

### 成功响应
```json
{
  "success": true,
  "message": "上传成功",
  "filename": "第一章作业_01_张三_20240101120000.docx",
  "filepath": "uploads/一班/数学/第一章作业_01_张三_20240101120000.docx"
}
```

### 错误响应
```json
{
  "success": false,
  "message": "缺少文件参数",
  "filename": null
}
```

---

## 错误码说明

| 错误码 | 说明 |
|--------|------|
| 400 | 请求参数错误 |
| 401 | 未登录 |
| 404 | 资源不存在 |
| 500 | 服务器内部错误 |

---

## 状态码说明

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 405 | 请求方法不允许 |
| 500 | 服务器内部错误 |

---

## 4. 获取版本

### 接口路径
```
GET /api/v1/version
```

### 请求参数
无

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| success | bool | 是否成功 |
| version | string | 版本号 |

### 响应示例
```json
{
  "success": true,
  "version": "1.0.0"
}
```

---

## 5. 获取更新日志

### 接口路径
```
GET /api/v1/changelog
```

### 请求参数
无

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| success | bool | 是否成功 |
| changelog | string | 更新日志内容（Markdown格式） |

### 响应示例
```json
{
  "success": true,
  "changelog": "# 更新日志\n\n## v1.0.0 (2026-01-20)\n\n### 新增功能\n- 文件上传系统"
}
```
