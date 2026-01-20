# 配置文件说明

系统使用 TOML 格式的配置文件 `config.toml` 来定义班级、科目、作业及存储路径。

## 文件位置

```
cums/
└── config.toml
```

## 全局配置

```toml
server_addr = ":8080"     # 服务监听地址
upload_dir = "uploads"    # 默认上传目录
```

## 配置格式

### 基础结构

```toml
[classes."班级名称".subjects]
科目名 = [
    { name = "作业名" },
    { name = "作业名", upload_path = "自定义路径" }
]
```

### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 作业名称 |
| `upload_path` | 否 | 自定义存储路径，不指定则使用默认路径 |

### 完整示例

```toml
server_addr = ":8080"
upload_dir = "uploads"

[classes."一班".subjects]
数学 = [
    { name = "第一章作业" },
    { name = "第二章作业", upload_path = "D:/uploads/一班/数学/第二章作业" },
    { name = "期中考试" }
]
语文 = [
    { name = "作文" },
    { name = "阅读理解" }
]
英语 = [
    { name = "听力练习" }
]

[classes."二班".subjects]
物理 = [
    { name = "实验报告", upload_path = "E:/物理实验报告" },
    { name = "课后习题" }
]
化学 = [
    { name = "实验报告" },
    { name = "方程式练习" }
]
```

## 存储路径规则

1. **未指定 `upload_path`**: 使用默认路径 `uploads/{班级}/{科目}/{作业名}/`
2. **指定 `upload_path`**: 使用自定义绝对或相对路径

### 示例

| 作业配置 | 存储路径 |
|----------|----------|
| `{ name = "第一章作业" }` | `uploads/一班/数学/第一章作业/` |
| `{ name = "第二章作业", upload_path = "D:/files" }` | `D:/files/` |

## 注意事项

1. 班级名称使用双引号包裹
2. 作业列表使用数组格式
3. `upload_path` 支持绝对路径（如 `D:/uploads`）和相对路径（如 `../shared`）
4. 自定义路径不存在时会自动创建
5. 修改配置后需要重启服务
