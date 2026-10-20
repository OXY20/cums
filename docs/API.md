# API 文档

## 基础信息

- 基础路径：`/api/v1`
- 默认地址：`http://localhost:3000`
- 编码：UTF-8
- 登录接口使用 `application/json`；上传接口使用 `multipart/form-data`。
- 学生接口使用 `X-Student-Token`；管理接口使用 `X-Admin-Token`。

## 学生端

### 学生登录

```http
POST /api/v1/login
Content-Type: application/json
```

```json
{
  "student_id": "2025001",
  "password": "000000"
}
```

学生必须已经由管理后台导入名单。新导入或管理员重置的学生默认密码为 `000000`，登录响应中的 `data.force_password_change` 为 `true` 时必须先改密。忘记密码时联系老师重置。

成功响应：

```json
{
  "success": true,
  "message": "登录成功",
  "data": {
    "token": "student_xxx",
    "class": "25计应",
    "student_id": "2025001",
    "student_name": "张三",
    "force_password_change": true
  }
}
```

### 修改学生密码

```http
POST /api/v1/student/password
X-Student-Token: student_xxx
Content-Type: application/json
```

```json
{
  "old_password": "000000",
  "new_password": "new-password"
}
```

新密码至少 6 位。修改成功后，原令牌仍可在有效期内使用。

### 获取公共配置

```http
GET /api/v1/config
```

返回科目、班级、作业和课时信息，不返回学生名单和密码。

### 学生上传文件

```http
POST /api/v1/upload
X-Student-Token: student_xxx
Content-Type: multipart/form-data
```

表单字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `subject` | 是 | 科目名称 |
| `homework` | 是 | 作业名称 |
| `file` | 是 | 作业文件，最大 32MB |

班级、学号和姓名由服务端从令牌读取，不能通过表单覆盖。学生完成首次改密前上传会返回 `403`。

示例：

```bash
curl -X POST http://localhost:3000/api/v1/upload \
  -H "X-Student-Token: student_xxx" \
  -F "subject=数学" \
  -F "homework=第一章作业" \
  -F "file=@/path/to/homework.docx"
```

### 获取课时内容

```http
GET /api/v1/lesson?subject=数学&homework=第一章作业&lesson=第1课时
X-Student-Token: student_xxx
```

学生只能读取自己班级开设的科目，并且必须完成首次改密。返回值中的 `data.content` 是 Markdown 正文。页面支持标题、粗体、代码、图片、普通链接和 `@[视频](URL)` 视频语法；前端仅允许 `http`、`https` 和普通链接的 `mailto` 协议。课时简介通过公共配置中的 `lessons[].description` 提供，前端在课时列表与课时内容上方展示。

### 模板、版本和更新日志

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/template?file=templates/...` | 下载教师模板 |
| `GET` | `/api/v1/version` | 获取版本号 |
| `GET` | `/api/v1/changelog` | 获取更新日志 |

## 管理端

### 管理员登录

```http
POST /api/v1/admin/login
Content-Type: application/json
```

```json
{"password":"admin123"}
```

成功响应直接返回 `token` 字段，后续请求设置 `X-Admin-Token: {token}`。

### 管理员配置

读取配置：

```http
GET /api/v1/admin/config
X-Admin-Token: admin_xxx
```

保存完整科目配置：

```http
POST /api/v1/admin/config
X-Admin-Token: admin_xxx
Content-Type: application/json
```

```json
{
  "subjects": {
    "数学": {
      "classes": ["25计应"],
      "homeworks": [
        {"name":"第一章作业", "description":"课后练习", "lessons":[{"name":"第1课时", "description":"本节课介绍函数的基本概念。"}]}
      ]
    }
  }
}
```

### 学生名单管理

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/admin/students` | 获取名单，不返回密码 |
| `POST` | `/api/v1/admin/students/import` | 导入或更新名单 |
| `POST` | `/api/v1/admin/students/{student_id}/reset` | 重置密码为 `000000` |
| `DELETE` | `/api/v1/admin/students/{student_id}` | 删除学生并使其令牌失效 |
| `GET` | `/api/v1/admin/students/template` | 下载 XLSX 名单模板 |
| `POST` | `/api/v1/admin/students/import-xlsx` | 上传 XLSX 名单并导入 |

导入请求：

```json
{
  "students": [
    {"student_id":"2025001", "name":"张三", "class":"25计应"},
    {"student_id":"2025002", "name":"李四", "class":"25计应", "password":"optional-password"}
  ]
}
```

已有学生导入只更新姓名和班级，不覆盖已修改的密码；新学生默认密码为 `000000`。

XLSX 导入使用 `multipart/form-data` 的 `file` 字段，第一张工作表按列读取：`学号`、`姓名`、`班级`、`密码（可选）`。首行为表头时自动跳过；密码列为空时使用默认密码 `000000`。

### 科目、班级和作业导入

```http
POST /api/v1/admin/subjects/import
X-Admin-Token: admin_xxx
Content-Type: application/json
```

```json
{
  "subjects": [
    {"subject":"数学", "class":"25计应", "homework":"第一章作业", "description":"课后练习"},
    {"subject":"数学", "class":"25幼托", "homework":"第一章作业"}
  ]
}
```

同一科目、班级和作业会自动去重；`class`、`homework`、`description` 为可选字段，科目名称必填。

### 课时 Markdown

读取课时：

```http
GET /api/v1/admin/lesson?subject=数学&homework=第一章作业&lesson=第1课时
X-Admin-Token: admin_xxx
```

保存课时：

```http
POST /api/v1/admin/lesson
X-Admin-Token: admin_xxx
Content-Type: application/json
```

```json
{
  "subject":"数学",
  "homework":"第一章作业",
  "lesson":"第1课时",
  "content":"# 函数\n\n本课时内容。",
  "description":"本节课介绍函数的基本概念。"
}
```

Markdown 文件保存在 `lessons/{科目}/{作业}/{课时}.md`。保存时课时不存在会自动追加到对应作业；科目和作业必须已存在，正文最大 4MB。`description` 为课时简介（相关介绍），可选，保存后写入配置，在学生端课时列表和课时内容上方展示。

### 课时媒体上传

```http
POST /api/v1/admin/lesson/media
X-Admin-Token: admin_xxx
Content-Type: multipart/form-data
```

表单字段为 `subject`、`homework`、`lesson`、`file`。文件最大 64MB，仅允许图片、音视频、常见 Office/PDF 和压缩附件。媒体保存到 `lesson_media/{科目}/{作业}/{课时}/`，成功响应中的 `data.url` 可直接写入 Markdown：

```markdown
![课程图片](/lesson-media/数学/第一章作业/第1课时/图片.png)
@[视频](/lesson-media/数学/第一章作业/第1课时/讲解.mp4)
[下载附件](/lesson-media/数学/第一章作业/第1课时/资料.pdf)
```

媒体目录由服务端配置为程序目录下的 `lesson_media`，部署时需与程序一起保留。

### 其他管理接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/admin/template/upload` | 上传作业模板 |
| `GET` | `/api/v1/admin/template/list?subject=数学` | 获取模板列表 |
| `POST` | `/api/v1/admin/template/delete` | 删除模板 |
| `GET` | `/api/v1/admin/files` | 查询学生上传文件 |
| `POST` | `/api/v1/admin/files/delete` | 删除学生上传文件 |
| `GET` | `/api/v1/admin/stats` | 获取统计数据 |
| `GET` | `/api/v1/admin/submissions` | 获取提交记录 |
| `POST` | `/api/v1/admin/password` | 修改管理员密码 |
| `GET` | `/api/v1/admin/logs` | 获取操作日志 |

所有管理接口都要求 `X-Admin-Token`。模板和上传文件删除接口会校验路径必须位于对应目录内。

## 错误处理

成功响应使用 `success: true`；业务错误使用 `success: false` 和 `message`。常见状态码：

| 状态码 | 含义 |
|---|---|
| `200` | 请求成功 |
| `400` | 参数或文件格式错误 |
| `401` | 登录失败、令牌缺失或令牌过期 |
| `403` | 无权访问、管理功能关闭或首次改密未完成 |
| `404` | 资源不存在 |
| `500` | 服务端错误 |
