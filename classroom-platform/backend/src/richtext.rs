//! 富文本 HTML 清洗。
//!
//! 教师提交的正文按白名单过滤后再入库，防止存储型 XSS：
//! - 只保留排版类标签与内联样式属性；
//! - `a[href]` 仅允许 http/https/mailto 与站内相对路径，杜绝 `javascript:`;
//! - `img[src]` / `video[src]` 只允许站内 `/files/` 路径，防止外链追踪与
//!   引用不受管的第三方内容；
//! - 移除全部事件属性（`on*`）与 `script`/`style`/`iframe` 等可执行元素。
//!
//! 清洗在服务端完成，学生端渲染时不再依赖前端过滤。

use ammonia::Builder;
use std::collections::HashSet;

/// 允许的标签集合。
///
/// 覆盖论坛式编辑器的常见排版能力：标题、字号、颜色、对齐、列表、
/// 引用、代码块、表格、链接与媒体。
const ALLOWED_TAGS: &[&str] = &[
    // 段落与标题
    "p", "br", "div", "span", "h1", "h2", "h3", "h4", "h5", "h6", "hr",
    // 行内样式
    "strong", "b", "em", "i", "u", "s", "strike", "sub", "sup", "mark", "small", "big",
    // 列表
    "ul", "ol", "li",
    // 引用与代码
    "blockquote", "pre", "code",
    // 链接与媒体
    "a", "img", "video", "source", "figure", "figcaption",
    // 表格
    "table", "thead", "tbody", "tr", "th", "td", "caption", "colgroup", "col",
];

/// 允许的属性集合。
///
/// 注意：不要包含 `rel`——它由 `Builder::link_rel` 统一注入，
/// 若同时出现在通用属性中，ammonia 会在 clean 时触发断言。
const ALLOWED_ATTRS: &[&str] = &[
    "href", "title", "target", "src", "alt", "width", "height", "controls", "preload",
    "poster", "colspan", "rowspan", "class", "style", "type",
];

/// 允许的内联样式属性。
///
/// 只保留排版相关属性，避免通过 `position`/`behavior` 等方式做视觉欺骗。
const ALLOWED_STYLES: &[&str] = &[
    "color",
    "background-color",
    "font-size",
    "font-weight",
    "font-style",
    "font-family",
    "text-align",
    "text-decoration",
    "text-indent",
    "line-height",
    "letter-spacing",
    "vertical-align",
    "margin",
    "margin-left",
    "margin-right",
    "margin-top",
    "margin-bottom",
    "padding",
    "padding-left",
    "padding-right",
    "padding-top",
    "padding-bottom",
    "border",
    "border-collapse",
    "border-color",
    "border-style",
    "border-width",
    "width",
    "height",
    "max-width",
    "max-height",
    "white-space",
    "list-style-type",
];

/// Quill 2 使用 CSS class 表达字号、对齐、缩进等排版，
/// 例如 `ql-align-center`、`ql-size-large`、`ql-indent-1`。
/// 若清洗时丢弃这些 class，教师设置的排版会在保存后全部失效，
/// 因此这里按前缀精确放行。
const ALLOWED_CLASS_PREFIXES: &[&str] = &[
    "ql-align-",
    "ql-size-",
    "ql-indent-",
    "ql-direction-",
    "ql-font-",
];

/// 需要精确匹配的 class（非前缀形式）。
const ALLOWED_CLASS_EXACT: &[&str] = &[
    "ql-syntax",
    "ql-code-block-container",
    "ql-code-block",
    "ql-video",
    "ql-table-header",
];

/// 判断某个 class 是否允许保留。
fn is_allowed_class(class: &str) -> bool {
    ALLOWED_CLASS_EXACT.contains(&class)
        || ALLOWED_CLASS_PREFIXES
            .iter()
            .any(|prefix| class.starts_with(prefix))
}

/// 规范化表格：把表头单元格统一表示为带标记的 `<td>`。
///
/// Quill 2 对 `<th>` 的支持有缺陷：回填时会把同一行的多个 `<th>`
/// 合并成一个单元格，文本被拼接，表格结构因此损坏。
/// 为保证编辑器往返不丢结构，这里把 `<th>` 转成
/// `<td class="ql-table-header">`，表头样式由前端按该标记呈现。
fn normalize_tables(html: &str) -> String {
    if !html.contains("<th") {
        return html.to_string();
    }

    // 逐单元格替换，避免影响 <thead> 等容器标签。
    let mut out = String::with_capacity(html.len() + 64);
    let mut rest = html;

    while let Some(pos) = rest.find("<th") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos..];

        // 定位开标签结束位置
        let Some(open_end) = after.find('>') else {
            out.push_str(after);
            return out;
        };
        let open_tag = &after[..open_end + 1];

        // 保留已有 class，追加表头标记
        let new_open = if let Some(class_pos) = open_tag.find("class=\"") {
            let value_start = class_pos + "class=\"".len();
            let value_end = open_tag[value_start..]
                .find('"')
                .map(|i| value_start + i)
                .unwrap_or(open_tag.len());
            let existing = &open_tag[value_start..value_end];
            let merged = if existing.split_whitespace().any(|c| c == "ql-table-header") {
                existing.to_string()
            } else {
                format!("{existing} ql-table-header")
            };
            format!(
                "{}class=\"{}\"{}",
                &open_tag[..class_pos],
                merged,
                &open_tag[value_end + 1..]
            )
        } else {
            format!(
                "<td class=\"ql-table-header\"{}",
                &open_tag["<th".len()..]
            )
        };

        out.push_str(&new_open);

        // 处理单元格内容直到 </th>
        let body = &after[open_end + 1..];
        match body.find("</th>") {
            Some(close) => {
                out.push_str(&body[..close]);
                out.push_str("</td>");
                rest = &body[close + "</th>".len()..];
            }
            None => {
                out.push_str(body);
                return out;
            }
        }
    }

    out.push_str(rest);
    out
}

/// 清洗富文本 HTML。
///
/// 空输入返回空字符串，调用方可据此判断内容是否为空。
pub fn sanitize(html: &str) -> String {
    if html.trim().is_empty() {
        return String::new();
    }

    let mut builder = Builder::default();

    builder
        .tags(HashSet::from_iter(ALLOWED_TAGS.iter().copied()))
        .generic_attributes(HashSet::from_iter(ALLOWED_ATTRS.iter().copied()));

    // 内联样式白名单：只保留排版相关属性，
    // 避免通过 position / behavior 等方式做视觉欺骗或加载外部资源。
    builder.filter_style_properties(HashSet::from_iter(ALLOWED_STYLES.iter().copied()));

    // 链接协议白名单；相对路径与锚点由 UrlRelative 策略控制。
    builder.url_schemes(HashSet::from_iter(["http", "https", "mailto"]));

    // 链接统一加 rel，防止反向标签劫持。
    builder.link_rel(Some("noopener noreferrer"));

    // 图片与视频只允许站内文件路径，避免引用外部不受控内容；
    // class 仅保留 Quill 的排版类，其余一律丢弃；
    // data-* 一律丢弃——Quill 的表格解析器会写入 data-row 之类的内部标记，
    // 这些标记没有语义价值，留在库里只会污染数据。
    builder.attribute_filter(|element, attribute, value| {
        match (element, attribute) {
            // 站内媒体路径，或内联 base64 图片
            ("img", "src") | ("video", "src") | ("source", "src") => {
                if value.starts_with("/files/") || value.starts_with("data:image/") {
                    Some(value.into())
                } else {
                    None
                }
            }
            // class 只保留排版相关的 Quill 类
            (_, "class") => {
                let kept: Vec<&str> = value.split_whitespace().filter(|c| is_allowed_class(c)).collect();
                if kept.is_empty() {
                    None
                } else {
                    Some(kept.join(" ").into())
                }
            }
            // 丢弃所有 data-* 属性
            (_, name) if name.starts_with("data-") => None,
            _ => Some(value.into()),
        }
    });

    let cleaned = builder.clean(html).to_string();
    normalize_tables(&cleaned)
}

/// 判断清洗后的 HTML 是否为空内容。
///
/// 富文本编辑器在用户清空内容后常留下 `<p><br></p>`，
/// 这种内容不应被当作有效正文。
///
/// 注意：只有图片、视频或表格的正文不算空——媒体本身就是内容。
pub fn is_effectively_empty(html: &str) -> bool {
    if html.trim().is_empty() {
        return true;
    }

    // 含媒体或表格元素时，即使没有文字也是有效内容。
    let lower = html.to_ascii_lowercase();
    const MEDIA_MARKERS: &[&str] = &[
        "<img", "<video", "<audio", "<iframe", "<table", "<hr", "<embed", "<object",
    ];
    if MEDIA_MARKERS.iter().any(|marker| lower.contains(marker)) {
        return false;
    }

    let text = html
        .replace("<p><br></p>", "")
        .replace("<p><br/></p>", "")
        .replace("<br>", "")
        .replace("<br/>", "")
        .replace("<br />", "")
        .replace("&nbsp;", "");

    // 去掉所有标签后看是否还有可见字符
    let mut visible = String::with_capacity(text.len());
    let mut inside_tag = false;
    for ch in text.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => visible.push(ch),
            _ => {}
        }
    }

    visible.trim().is_empty()
}

/// 提取 HTML 中引用的站内资源 ID。
///
/// 富文本里的图片与视频以 `/files/{id}` 形式引用资源；
/// 保存时需要把这些引用同步到课时资源关联表，否则：
/// - 资源库清理时可能删掉仍被正文引用的文件；
/// - 学生端无法在附件列表里看到它们。
pub fn referenced_resource_ids(html: &str) -> Vec<i64> {
    let mut ids = Vec::new();
    let bytes = html.as_bytes();
    let marker = b"/files/";
    let mut index = 0;

    while index + marker.len() < bytes.len() {
        if &bytes[index..index + marker.len()] == marker {
            let start = index + marker.len();
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > start {
                if let Ok(id) = html[start..end].parse::<i64>() {
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
            }
            index = end.max(start);
        } else {
            index += 1;
        }
    }

    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 移除脚本标签() {
        let cleaned = sanitize("<p>正常</p><script>alert(1)</script>");
        assert!(!cleaned.contains("script"));
        assert!(cleaned.contains("正常"));
    }

    #[test]
    fn 移除事件属性() {
        let cleaned = sanitize(r#"<p onclick="alert(1)">点击</p>"#);
        assert!(!cleaned.contains("onclick"));
        assert!(cleaned.contains("点击"));
    }

    #[test]
    fn 拒绝_javascript_链接() {
        let cleaned = sanitize(r#"<a href="javascript:alert(1)">链接</a>"#);
        assert!(!cleaned.contains("javascript:"));
    }

    #[test]
    fn 保留正常链接() {
        let cleaned = sanitize(r#"<a href="https://example.com">示例</a>"#);
        assert!(cleaned.contains("https://example.com"));
        assert!(cleaned.contains("noopener"));
    }

    #[test]
    fn 保留字号与颜色() {
        let cleaned = sanitize(r#"<span style="font-size: 20px; color: #ff0000">大号红字</span>"#);
        assert!(cleaned.contains("font-size"));
        assert!(cleaned.contains("color"));
    }

    #[test]
    fn 拒绝危险样式() {
        let cleaned = sanitize(r#"<span style="position: fixed; behavior: url(x)">x</span>"#);
        assert!(!cleaned.contains("position"));
        assert!(!cleaned.contains("behavior"));
    }

    #[test]
    fn 保留_quill_排版类() {
        // Quill 2 用 class 表达字号与对齐，必须保留
        let cleaned = sanitize(r#"<p class="ql-align-center">居中</p>"#);
        assert!(cleaned.contains("ql-align-center"), "{cleaned}");

        let cleaned = sanitize(r#"<span class="ql-size-large">大字</span>"#);
        assert!(cleaned.contains("ql-size-large"));

        let cleaned = sanitize(r#"<p class="ql-indent-2">缩进</p>"#);
        assert!(cleaned.contains("ql-indent-2"));
    }

    #[test]
    fn 拒绝非白名单类() {
        // 任意 class 不得透传，避免通过类名引入外部样式
        let cleaned = sanitize(r#"<p class="evil-class ql-align-right">x</p>"#);
        assert!(!cleaned.contains("evil-class"), "{cleaned}");
        assert!(cleaned.contains("ql-align-right"));
    }

    #[test]
    fn 表头单元格转为带标记的_td() {
        // Quill 2 回填多个 <th> 时会合并单元格，因此统一转成 td + class
        let html = r#"<table><tbody><tr><th>参数</th><th>取值</th></tr><tr><td>宽度</td><td>8cm</td></tr></tbody></table>"#;
        let cleaned = sanitize(html);
        assert!(cleaned.contains(r#"<td class="ql-table-header">参数</td>"#), "{cleaned}");
        assert!(cleaned.contains(r#"<td class="ql-table-header">取值</td>"#), "{cleaned}");
        assert!(!cleaned.contains("<th"), "{cleaned}");
        // 数据行保持普通 td
        assert!(cleaned.contains("<td>宽度</td>"), "{cleaned}");
    }

    #[test]
    fn 表头标记不会被重复添加() {
        let html = r#"<table><tbody><tr><th class="ql-table-header">表头</th></tr></tbody></table>"#;
        let cleaned = sanitize(html);
        assert_eq!(cleaned.matches("ql-table-header").count(), 1, "{cleaned}");
    }

    #[test]
    fn 丢弃所有_data_属性() {
        let cleaned = sanitize(r#"<p data-foo="bar">内容</p>"#);
        assert!(!cleaned.contains("data-foo"), "{cleaned}");
        assert!(cleaned.contains("内容"));
    }

    #[test]
    fn 只允许站内图片() {
        let allowed = sanitize(r#"<img src="/files/12" alt="图">"#);
        assert!(allowed.contains("/files/12"));

        let rejected = sanitize(r#"<img src="https://evil.example/x.png">"#);
        assert!(!rejected.contains("evil.example"));
    }

    #[test]
    fn 空内容判定() {
        assert!(is_effectively_empty(""));
        assert!(is_effectively_empty("<p><br></p>"));
        assert!(is_effectively_empty("<p>&nbsp;</p>"));
        assert!(!is_effectively_empty("<p>有内容</p>"));

        // 只有媒体的正文不算空
        assert!(!is_effectively_empty(r#"<p><img src="/files/1"></p>"#));
        assert!(!is_effectively_empty(r#"<video src="/files/2"></video>"#));
        assert!(!is_effectively_empty("<table><tr><td>x</td></tr></table>"));
    }

    #[test]
    fn 提取正文引用的资源() {
        let html = r#"<p><img src="/files/12" alt="a"></p><video src="/files/34"></video>"#;
        assert_eq!(referenced_resource_ids(html), vec![12, 34]);

        // 重复引用只保留一次
        let html = r#"<img src="/files/7"><img src="/files/7">"#;
        assert_eq!(referenced_resource_ids(html), vec![7]);

        // 非数字路径不提取
        assert!(referenced_resource_ids(r#"<a href="/files/abc">x</a>"#).is_empty());
    }
}
