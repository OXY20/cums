# 配置文件说明

系统使用 JSON 格式的配置文件 `config.json` 来定义班级、科目、作业及存储路径。

## 文件位置

```
cums/
└── config.json
```

## 全局配置

```json
{
    "version": "1.0.0",       // 版本号
    "server_addr": ":3000",    // 服务监听地址
    "upload_dir": "uploads"    // 默认上传目录
}
```

## 配置格式

### 基础结构

```json
{
    "version": "1.0.0",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "classes": {
        "班级名称": {
            "subjects": {
                "科目名": [
                    { "name": "作业名" },
                    { "name": "作业名", "upload_path": "自定义路径" }
                ]
            }
        }
    }
}
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `version` | 是 | 版本号（语义化版本，如 1.0.0） |
| `server_addr` | 是 | 服务监听地址（如 :3000） |
| `upload_dir` | 是 | 默认上传目录 |
| `name` | 是 | 作业名称 |
| `upload_path` | 否 | 自定义存储路径，不指定则使用默认路径 |

### 完整示例

```json
{
    "version": "1.0.0",
    "server_addr": ":3000",
    "upload_dir": "uploads",
    "classes": {
        "一班": {
            "subjects": {
                "数学": [
                    { "name": "第一章作业" },
                    { "name": "第二章作业", "upload_path": "D:/uploads/一班/数学/第二章作业" },
                    { "name": "期中考试" }
                ],
                "语文": [
                    { "name": "作文" },
                    { "name": "阅读理解" }
                ],
                "英语": [
                    { "name": "听力练习" }
                ]
            }
        },
        "二班": {
            "subjects": {
                "物理": [
                    { "name": "实验报告", "upload_path": "E:/物理实验报告" },
                    { "name": "课后习题" }
                ],
                "化学": [
                    { "name": "实验报告" },
                    { "name": "方程式练习" }
                ]
            }
        }
    }
}
```

## 存储路径规则

1. **未指定 `upload_path`**: 使用默认路径 `uploads/{班级}/{科目}/{作业名}/`
2. **指定 `upload_path`**: 使用自定义绝对或相对路径

### 示例

| 作业配置 | 存储路径 |
|----------|----------|
| `{ "name": "第一章作业" }` | `uploads/一班/数学/第一章作业/` |
| `{ "name": "第二章作业", "upload_path": "D:/files" }` | `D:/files/` |

## 版本号规范

使用语义化版本 (Semantic Versioning): `主版本.次版本.修订号`

- **主版本 (MAJOR)**: 不兼容的 API 变更
- **次版本 (MINOR)**: 向后兼容的功能新增
- **修订号 (PATCH)**: 向后兼容的问题修复

## 注意事项

1. 修改配置后需要重启服务
2. `upload_path` 支持绝对路径（如 `D:/uploads`）和相对路径（如 `../shared`）
3. 自定义路径不存在时会自动创建
4. 班级输入支持"一班"、"1班"等格式

## 首次运行

首次运行时，程序会自动创建以下目录结构：

```
cums/
├── static/              # 前端文件目录
│   └── index.html      # 主页面
├── uploads/            # 上传文件目录
└── config.json         # 配置文件
```

如果 `config.json` 不存在，程序会尝试在以下位置查找：
1. `./config.json`
2. `./cums/config.json`

## 路径查找规则

程序按以下顺序查找配置文件和静态文件：

| 类型 | 查找顺序 |
|------|----------|
| 配置文件 | `./config.json` → `./cums/config.json` |
| 静态文件 | `./static/` → `./cums/static/` |
| 上传目录 | `./uploads/` → `./cums/uploads/` |
