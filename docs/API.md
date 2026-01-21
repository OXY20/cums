# API 文档

## 📡 基础信息

- **基础路径**: `/api/v1`
- **协议**: HTTP
- **编码**: UTF-8
- **架构**: 以科目为中心

### Content-Type

- **登录/配置**: `application/json`
- **文件上传**: `multipart/form-data`

---

## 🔐 1. 用户登录

### 接口信息
```
POST /api/v1/login
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `class` | string | 是 | 班级名称（从配置中自动收集） |
| `student_id` | string | 是 | 学生学号 |
| `student_name` | string | 是 | 学生姓名 |

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
| `success` | bool | 是否成功 |
| `message` | string | 提示信息 |
| `data.class` | string | 班级名称（标准化后） |
| `data.student_id` | string | 学号 |
| `data.student_name` | string | 姓名 |

### 成功响应

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

班级不存在：
```json
{
  "success": false,
  "message": "班级不存在，可选班级：一班、二班、三班",
  "data": null
}
```

学号或姓名为空：
```json
{
  "success": false,
  "message": "学号和姓名不能为空",
  "data": null
}
```

### 业务逻辑

1. 验证班级是否在配置中存在（遍历所有科目的 classes）
2. 验证学号和姓名不为空
3. 返回标准化后的班级信息（支持"1班" → "一班"转换）

---

## 📋 2. 获取配置

### 接口信息
```
POST /api/v1/config
Content-Type: application/json
```

### 请求参数
无（可发送空 JSON 对象 `{}`）

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 是否成功 |
| `data.subjects` | object | 科目配置（以科目为中心） |

### 响应结构

```json
{
  "success": true,
  "data": {
    "subjects": {
      "{科目名}": {
        "classes": ["班级1", "班级2"],
        "homeworks": ["作业1", "作业2"]
      }
    }
  }
}
```

### 响应示例

```json
{
  "success": true,
  "data": {
    "subjects": {
      "数学": {
        "classes": ["一班", "二班", "三班"],
        "homeworks": ["第一章作业", "第二章作业", "期中考试"]
      },
      "语文": {
        "classes": ["一班", "二班"],
        "homeworks": ["作文1", "阅读理解1"]
      },
      "英语": {
        "classes": ["一班", "二班", "三班"],
        "homeworks": ["听力练习", "单词测试"]
      }
    }
  }
}
```

### 前端使用

**初始化科目选择器**：
```javascript
Object.keys(configData.subjects).forEach(subject => {
    subjectSelect.add(new Option(subject, subject));
});
```

**初始化班级选择器**（登录用）：
```javascript
const classes = new Set();
Object.values(configData.subjects).forEach(sub => {
    sub.classes.forEach(c => classes.add(c));
});
classes.forEach(c => classSelect.add(new Option(c, c)));
```

**科目变更时过滤班级**：
```javascript
const selectedSubject = configData.subjects[subjectValue];
selectedSubject.classes.forEach(c => classSelect.add(new Option(c, c)));
```

---

## 📤 3. 文件上传

### 接口信息
```
POST /api/v1/upload
Content-Type: multipart/form-data
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `class` | string | 是 | 班级名称 |
| `student_id` | string | 是 | 学号 |
| `student_name` | string | 是 | 姓名 |
| `subject` | string | 是 | 科目名称 |
| `homework` | string | 是 | 作业名称 |
| `file` | file | 是 | 上传的文件 |

### 请求示例 (cURL)

```bash
curl -X POST http://localhost:3000/api/v1/upload \
  -F "class=一班" \
  -F "student_id=01" \
  -F "student_name=张三" \
  -F "subject=数学" \
  -F "homework=第一章作业" \
  -F "file=@/path/to/homework.docx"
```

### 请求示例 (JavaScript)

```javascript
const formData = new FormData();
formData.append('class', currentUser.class);
formData.append('student_id', currentUser.student_id);
formData.append('student_name', currentUser.student_name);
formData.append('subject', subjectValue);
formData.append('homework', homeworkValue);
formData.append('file', fileInput.files[0]);

fetch('/api/v1/upload', {
    method: 'POST',
    body: formData
}).then(res => res.json());
```

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 是否成功 |
| `message` | string | 提示信息 |
| `filename` | string | 保存的文件名 |
| `filepath` | string | 文件完整路径 |

### 成功响应

```json
{
  "success": true,
  "message": "上传成功",
  "filename": "第一章作业_01_张三_20260121193000.docx",
  "filepath": "C:\\Users\\ERSHI\\code\\cums\\cums\\uploads\\数学\\一班\\第一章作业\\第一章作业_01_张三_20260121193000.docx"
}
```

### 错误响应

班级不存在：
```json
{
  "success": false,
  "message": "班级不存在",
  "filename": ""
}
```

科目不存在：
```json
{
  "success": false,
  "message": "科目不存在",
  "filename": ""
}
```

班级没有该科目：
```json
{
  "success": false,
  "message": "该班级没有此科目",
  "filename": ""
}
```

作业不存在：
```json
{
  "success": false,
  "message": "作业不存在",
  "filename": ""
}
```

未选择文件：
```json
{
  "success": false,
  "message": "请选择要上传的文件",
  "filename": ""
}
```

### 业务逻辑

1. **验证参数完整性**
   - 班级、学号、姓名、科目、作业、文件缺一不可

2. **验证班级存在性**
   - 在配置的科目中查找班级

3. **验证科目存在性**
   - 检查科目是否在配置中

4. **验证班级-科目关系**
   - 确认该班级是否开设此科目

5. **验证作业存在性**
   - 检查作业是否在该科目的作业列表中

6. **生成文件名**
   - 格式：`{作业名}_{学号}_{姓名}_{时间戳}.{扩展名}`
   - 时间戳格式：`20060121150405`

7. **确定存储路径**
   - 路径：`uploads/{科目}/{班级}/{作业}/`

8. **保存文件**
   - 创建目录（如不存在）
   - 写入文件

9. **记录日志**
   - 控制台：`[时间] 班级 学号姓名提交作业作业`
   - 文件：`cums/logs/cums.log`

---

## 📊 4. 获取版本

### 接口信息
```
GET /api/v1/version
```

### 请求参数
无

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 是否成功 |
| `version` | string | 版本号 |

### 响应示例

```json
{
  "success": true,
  "version": "1.0.3"
}
```

---

## 📝 5. 获取更新日志

### 接口信息
```
GET /api/v1/changelog
```

### 请求参数
无

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 是否成功 |
| `changelog` | string | 更新日志内容（Markdown格式） |

### 响应示例

```json
{
  "success": true,
  "changelog": "# 更新日志\n\n## v1.0.3 (2026-01-21)\n\n### 新增功能\n- 以科目为中心的配置架构\n- 班级下拉选择\n- 启动时显示详细配置信息\n\n### 特性\n- 简洁的登录界面\n- 文件自动重命名\n- 跨平台支持（Windows/Linux/Mac）"
}
```

---

## ⚠️ 错误处理

### HTTP 状态码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 405 | 请求方法不允许 |
| 500 | 服务器内部错误 |

### 业务错误码

所有接口统一使用 `success` 字段标识业务成功/失败：

```json
{
  "success": false,  // 业务失败
  "message": "具体错误信息"
}
```

### 常见错误信息

| 错误信息 | 原因 | 解决方案 |
|---------|------|----------|
| "班级不存在" | 配置中没有该班级 | 检查配置文件 |
| "科目不存在" | 配置中没有该科目 | 检查配置文件 |
| "该班级没有此科目" | 班级未开设该科目 | 检查科目配置 |
| "作业不存在" | 科目中没有该作业 | 检查作业配置 |
| "学号和姓名不能为空" | 未填写完整 | 填写完整信息 |
| "缺少必要参数" | 参数缺失 | 检查请求参数 |
| "请选择要上传的文件" | 未选择文件 | 选择文件后上传 |

---

## 🔧 使用示例

### 完整的上传流程

```javascript
// 1. 加载配置
const configRes = await fetch('/api/v1/config', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'}
});
const configData = (await configRes.json()).data;

// 2. 用户登录
const loginRes = await fetch('/api/v1/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
        class: '一班',
        student_id: '01',
        student_name: '张三'
    })
});
const currentUser = (await loginRes.json()).data;

// 3. 上传文件
const formData = new FormData();
formData.append('class', currentUser.class);
formData.append('student_id', currentUser.student_id);
formData.append('student_name', currentUser.student_name);
formData.append('subject', '数学');
formData.append('homework', '第一章作业');
formData.append('file', fileInput.files[0]);

const uploadRes = await fetch('/api/v1/upload', {
    method: 'POST',
    body: formData
});
const result = await uploadRes.json();

if (result.success) {
    console.log('上传成功:', result.filename);
} else {
    console.error('上传失败:', result.message);
}
```

---

## 🔒 6. 管理员登录

### 接口信息
```
POST /api/v1/admin/login
Content-Type: application/json
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `password` | string | 是 | 管理员密码 |

### 请求示例

```json
{
  "password": "admin123"
}
```

### 响应参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `success` | bool | 是否成功 |
| `message` | string | 提示信息 |
| `token` | string | 管理员令牌（成功时返回） |

### 成功响应

```json
{
  "success": true,
  "message": "登录成功",
  "token": "admin_session_xxxxx"
}
```

### 错误响应

功能未启用：
```json
{
  "success": false,
  "message": "管理员功能未启用"
}
```

密码错误：
```json
{
  "success": false,
  "message": "密码错误"
}
```

---

## 🛠️ 7. 获取完整配置（管理员）

### 接口信息
```
GET /api/v1/admin/config
Header: X-Admin-Token: {token}
```

### 响应示例

```json
{
  "success": true,
  "data": {
    "subjects": {
      "数学": {
        "classes": ["一班", "二班"],
        "homeworks": ["第一章作业", "第二章作业"]
      }
    }
  }
}
```

---

## ✏️ 8. 更新配置（管理员）

### 接口信息
```
POST /api/v1/admin/config
Content-Type: application/json
Header: X-Admin-Token: {token}
```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `subjects` | object | 是 | 完整的科目配置 |

### 请求示例

```json
{
  "subjects": {
    "数学": {
      "classes": ["一班", "二班", "三班"],
      "homeworks": ["第一章作业", "第二章作业", "期中测试"]
    },
    "语文": {
      "classes": ["一班"],
      "homeworks": ["作文"]
    }
  }
}
```

### 响应示例

```json
{
  "success": true,
  "message": "配置已更新"
}
```

---

## 📚 相关文档

- [配置说明](./CONFIG.md)
- [快速开始](./README.md)
- [系统架构](./ARCHITECTURE.md)

---

**文档版本**: v2.0.0
**更新日期**: 2026-01-22
**架构**: 以科目为中心
