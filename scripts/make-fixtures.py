"""生成演示用作业文件池。

课程演示需要「像真的」学生作业：Word 文档、Excel 表格、操作截图、
屏幕录制视频、实验报告 PDF、源码文件。这里一次性把这些文件造出来，
放到 scripts/fixtures/ 下，再由 seed-demo-data.mjs 上传。

用法：
    python scripts/make-fixtures.py

依赖：Pillow、python-docx、openpyxl，以及 PATH 中的 ffmpeg。
"""

from __future__ import annotations

import shutil
import subprocess
import zipfile
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "fixtures"

FONT_CJK = "C:/Windows/Fonts/msyh.ttc"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"

INK = (32, 36, 44)
MUTED = (110, 118, 130)
ACCENT = (43, 108, 176)
PAPER = (255, 255, 255)
DESK = (238, 241, 245)


def font(size: int, *, mono: bool = False) -> ImageFont.FreeTypeFont:
    path = FONT_MONO if mono else FONT_CJK
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def draw_mixed(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    size: int,
    fill: tuple[int, int, int],
    *,
    mono: bool = True,
) -> None:
    """逐字符混排：ASCII 用等宽字体，中文回退到黑体。

    等宽字体不含中文字形，直接整行绘制会把汉字画成方框。
    """
    ascii_font = font(size, mono=mono)
    cjk_font = font(size, mono=False)
    x, y = xy
    for ch in text:
        if ord(ch) < 128:
            draw.text((x, y), ch, font=ascii_font, fill=fill)
            x += draw.textlength(ch, font=ascii_font)
        else:
            draw.text((x, y), ch, font=cjk_font, fill=fill)
            x += draw.textlength(ch, font=cjk_font)


def window_frame(width: int, height: int, title: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    """画一个带标题栏的窗口，让截图看起来像真截的屏。"""
    img = Image.new("RGB", (width, height), DESK)
    draw = ImageDraw.Draw(img)

    # 标题栏
    draw.rectangle([0, 0, width, 44], fill=(247, 249, 252))
    draw.line([(0, 44), (width, 44)], fill=(214, 219, 227), width=1)
    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 22 + i * 22
        draw.ellipse([cx - 6, 16, cx + 6, 28], fill=color)
    draw.text((110, 13), title, font=font(17), fill=MUTED)

    # 内容区底板
    draw.rectangle([0, 45, width, height], fill=PAPER)
    return img, draw


def wrap(draw: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, limit: int) -> list[str]:
    """按像素宽度折行，中文逐字判断。"""
    lines: list[str] = []
    current = ""
    for ch in text:
        probe = current + ch
        if draw.textlength(probe, font=f) > limit:
            lines.append(current)
            current = ch
        else:
            current = probe
    if current:
        lines.append(current)
    return lines


def word_screenshot(title: str, paragraphs: list[str], table: list[list[str]] | None) -> Image.Image:
    """Word 图文混排作业截图。"""
    width, height = 1280, 720
    img, draw = window_frame(width, height, f"{title} - Word")
    left, right = 150, 1130

    y = 96
    draw.text((left, y), title, font=font(30), fill=INK)
    y += 52
    draw.line([(left, y), (right, y)], fill=(226, 230, 236), width=1)
    y += 28

    # 图片占位固定在右上角，正文折行宽度相应收窄，避免文字被压住
    pic_left = right - 240
    body_width = pic_left - left - 32
    for text in paragraphs:
        for line in wrap(draw, text, font(18), body_width):
            draw.text((left, y), line, font=font(18), fill=INK)
            y += 32
        y += 10

    if table:
        col_w = (right - left) / max(len(table[0]), 1)
        y += 6
        for r, row in enumerate(table):
            for c, cell in enumerate(row):
                x0 = left + c * col_w
                draw.rectangle([x0, y, x0 + col_w, y + 38], outline=(180, 188, 198))
                draw.text((x0 + 12, y + 9), cell, font=font(16), fill=INK)
            if r == 0:
                draw.rectangle(
                    [left, y, right, y + 38], fill=(240, 244, 250)
                )
                for c, cell in enumerate(row):
                    x0 = left + c * col_w
                    draw.rectangle([x0, y, x0 + col_w, y + 38], outline=(180, 188, 198))
                    draw.text((x0 + 12, y + 9), cell, font=font(16), fill=INK)
            y += 38

    # 右下角的图片占位，示意「插入了图片」
    draw.rectangle(
        [pic_left, 96, right, 236], fill=(226, 233, 242), outline=(186, 196, 208)
    )
    draw.text((pic_left + 40, 156), "已插入图片", font=font(17), fill=MUTED)
    return img


def sheet_screenshot(title: str, headers: list[str], rows: list[list[str]]) -> Image.Image:
    """Excel 表格作业截图。"""
    width, height = 1280, 720
    img, draw = window_frame(width, height, f"{title} - Excel")

    left, top = 90, 100
    row_h = 34
    col_w = 150
    # 列标
    draw.rectangle([left, top, left + col_w * len(headers), top + 26], fill=(240, 243, 248))
    for c, name in enumerate(headers):
        x0 = left + c * col_w
        draw.rectangle([x0, top, x0 + col_w, top + 26], outline=(196, 203, 212))
        draw.text((x0 + 10, top + 5), name, font=font(14), fill=MUTED)

    for r, row in enumerate(rows):
        y0 = top + 26 + r * row_h
        for c, cell in enumerate(row):
            x0 = left + c * col_w
            draw.rectangle([x0, y0, x0 + col_w, y0 + row_h], outline=(214, 220, 228))
            draw.text((x0 + 10, y0 + 8), cell, font=font(15), fill=INK)

    total_y = top + 26 + len(rows) * row_h + 20
    draw.text((left, total_y), "合计 = SUM(D2:D%d)" % (len(rows) + 1), font=font(15), fill=ACCENT)
    return img


def slide_screenshot(title: str, bullets: list[str]) -> Image.Image:
    """PowerPoint 幻灯片截图。"""
    width, height = 1280, 720
    img, draw = window_frame(width, height, f"{title} - PowerPoint")

    draw.rectangle([120, 90, 1160, 640], fill=(252, 253, 255), outline=(220, 226, 234))
    draw.rectangle([120, 90, 1160, 186], fill=(43, 108, 176))
    draw.text((164, 116), title, font=font(34), fill=(255, 255, 255))

    y = 226
    for item in bullets:
        draw.ellipse([168, y + 9, 180, y + 21], fill=ACCENT)
        for line in wrap(draw, item, font(20), 900):
            draw.text((200, y), line, font=font(20), fill=INK)
            y += 36
        y += 14
    return img


def code_screenshot(title: str, filename: str, lines: list[str]) -> Image.Image:
    """编辑器截图，深色主题。"""
    width, height = 1280, 720
    img = Image.new("RGB", (width, height), (30, 34, 42))
    draw = ImageDraw.Draw(img)

    draw.rectangle([0, 0, width, 40], fill=(38, 43, 52))
    draw.text((20, 10), filename, font=font(16), fill=(150, 160, 175))
    draw.text((width - 200, 10), title, font=font(15), fill=(120, 130, 145))

    y = 62
    for i, line in enumerate(lines, start=1):
        draw.text((20, y), str(i).rjust(3), font=font(15, mono=True), fill=(90, 100, 115))
        color = (200, 208, 220)
        stripped = line.strip()
        if stripped.startswith("#"):
            color = (110, 150, 120)
        elif stripped.startswith(("def ", "class ", "import ", "from ")):
            color = (198, 148, 226)
        elif stripped.startswith(("if ", "for ", "while ", "return ", "else", "elif")):
            color = (226, 170, 110)
        draw_mixed(draw, (70, y), line, 15, color)
        y += 24
    return img


def photo(width: int, height: int, seed: int) -> Image.Image:
    """造一张有层次的图片，当作学生拍的实物照片。"""
    img = Image.new("RGB", (width, height))
    px = img.load()
    for y in range(height):
        for x in range(width):
            r = (x * 255 // width + seed * 37) % 256
            g = (y * 255 // height + seed * 91) % 256
            b = ((x + y) * 255 // (width + height) + seed * 53) % 256
            px[x, y] = (60 + r // 2, 70 + g // 2, 90 + b // 2)
    draw = ImageDraw.Draw(img)
    for i in range(6):
        x0 = 40 + i * (width // 8)
        y0 = 40 + i * (height // 10)
        draw.ellipse(
            [x0, y0, x0 + width // 6, y0 + height // 6],
            fill=((i * 40 + seed * 20) % 200 + 40, 120, 190 - i * 18),
        )
    draw.text((40, height - 60), "实训拍摄", font=font(28), fill=(245, 248, 255))
    return img


def report_pdf(title: str, sections: list[tuple[str, str]]) -> list[Image.Image]:
    """实验报告页面，稍后合并成 PDF。"""
    pages = []
    width, height = 1240, 1754  # A4 @150dpi 近似
    img = Image.new("RGB", (width, height), PAPER)
    draw = ImageDraw.Draw(img)
    left, right = 110, width - 110

    y = 120
    draw.text((left, y), title, font=font(40), fill=INK)
    y += 80
    draw.line([(left, y), (right, y)], fill=(210, 216, 224), width=2)
    y += 46

    for heading, body in sections:
        if y > height - 220:
            pages.append(img)
            img = Image.new("RGB", (width, height), PAPER)
            draw = ImageDraw.Draw(img)
            y = 120

        draw.text((left, y), heading, font=font(26), fill=ACCENT)
        y += 44
        for line in wrap(draw, body, font(20), right - left):
            draw.text((left, y), line, font=font(20), fill=INK)
            y += 34
        y += 26

    pages.append(img)
    return pages


def make_docx(path: Path, title: str, paragraphs: list[str], rows: list[list[str]]) -> None:
    doc = Document()
    heading = doc.add_heading(title, level=1)
    heading.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for text in paragraphs:
        p = doc.add_paragraph(text)
        p.paragraph_format.first_line_indent = Pt(24)
        p.paragraph_format.line_spacing = 1.5

    table = doc.add_table(rows=len(rows), cols=len(rows[0]))
    table.style = "Table Grid"
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            table.cell(r, c).text = cell

    doc.add_paragraph("")
    doc.add_paragraph("提交人签名：________________　　日期：________________")
    doc.save(path)


def make_xlsx(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "成绩表"

    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", fgColor="2B6CB0")
    thin = Side(style="thin", color="C8D0DC")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    ws.append(headers)
    for cell in ws[1]:
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center")
        cell.border = border

    for row in rows:
        ws.append(row)
        for cell in ws[ws.max_row]:
            cell.border = border

    for i, width in enumerate([14, 16, 12, 12, 14], start=1):
        ws.column_dimensions[chr(64 + i)].width = width

    last = ws.max_row
    ws.append(["", "", "平均", f"=AVERAGE(D2:D{last})", ""])
    wb.save(path)


def make_video(path: Path, seconds: int, label: str) -> bool:
    """用 ffmpeg 造一段操作录屏风格的视频。"""
    if shutil.which("ffmpeg") is None:
        return False

    # drawtext 里的路径要转义冒号，Windows 上尤其容易踩坑
    font_escaped = "C\\:/Windows/Fonts/msyh.ttc"
    vf = (
        "drawbox=x=0:y=0:w=iw:h=ih:color=0x1f2733@1:t=fill,"
        "drawgrid=w=64:h=64:t=1:c=0x2f3a4a@0.6,"
        f"drawtext=fontfile='{font_escaped}':text='{label}':"
        "fontcolor=0xE6EDF7:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2,"
        f"drawtext=fontfile='{font_escaped}':text='%{{pts\\:hms}}':"
        "fontcolor=0x7FB3E8:fontsize=28:x=48:y=h-80"
    )
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "lavfi", "-i", f"testsrc2=size=1280x720:rate=24:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=420:duration={seconds}",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "48k",
        "-shortest", str(path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except subprocess.CalledProcessError:
        return False
    return path.exists()


PY_SCRIPT = '''"""学生提交的 Python 作业：{title}"""


def {func}({args}):
    """{doc}"""
{body}


if __name__ == "__main__":
    print({func}({call_args}))
'''


def course_cover(title: str, subtitle: str, palette: tuple[int, int, int]) -> Image.Image:
    """课程封面：纯色渐变 + 几何装饰。

    不放文字——卡片下方已经有课程名，图里再写一遍会显得重复。
    """
    width, height = 640, 360
    base = Image.new("RGB", (width, height))
    px = base.load()
    r0, g0, b0 = palette
    for y in range(height):
        # 纵向渐变：从稍亮的顶部过渡到稍暗的底部
        t = y / height
        r = int(r0 * (1 - t * 0.35))
        g = int(g0 * (1 - t * 0.35))
        b = int(b0 * (1 - t * 0.25))
        for x in range(width):
            # 横向再加一点点变化，避免纯色显得呆板
            k = 1 - (x / width) * 0.12
            px[x, y] = (int(r * k), int(g * k), int(b * k))

    draw = ImageDraw.Draw(base)

    # 右下角两层装饰圆，做出一点层次
    draw.ellipse([width - 200, height - 200, width + 60, height + 60], fill=(255, 255, 255))
    draw.ellipse([width - 120, height - 120, width + 20, height + 20], fill=(255, 255, 255))

    # 左上角斜向细线，避免整块纯色
    for i in range(5):
        x0 = 40 + i * 26
        draw.line([(x0, 40), (x0 + 120, 160)], fill=(255, 255, 255), width=1)

    return base


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    # ---- 文档类 ----
    make_docx(
        OUT / "图文混排作业.docx",
        "我的家乡 · 图文混排练习",
        [
            "我的家乡位于江南水乡，河道纵横，桥梁众多。本次作业按照课程要求，"
            "完成了一份图文混排的自我介绍文档。",
            "文档正文使用小四号宋体，行距设置为 1.5 倍，首行缩进两个字符。"
            "标题使用黑体二号并居中显示，与正文形成明显的层次对比。",
            "插入的图片采用四周型环绕方式，与文字自然贴合，没有出现拉伸变形。"
            "图片下方补充了题注，说明拍摄地点与时间。",
        ],
        [
            ["项目", "要求", "完成情况"],
            ["标题格式", "黑体二号居中", "已完成"],
            ["正文字体", "宋体小四", "已完成"],
            ["图片环绕", "四周型", "已完成"],
            ["页眉页脚", "页码居中", "已完成"],
        ],
    )
    make_docx(
        OUT / "读书笔记.docx",
        "《计算机是怎样跑起来的》读书笔记",
        [
            "这本书用非常浅显的语言解释了计算机内部的工作过程，"
            "从二进制开始，一路讲到操作系统和编程语言。",
            "让我印象最深的是关于 CPU 只做四件事的论述：读取指令、解释指令、"
            "执行运算、写回结果。看似简单的循环，构成了所有软件的基础。",
            "读完之后我重新理解了为什么变量需要类型、为什么内存要分区域，"
            "这些以前只是死记硬背的概念，现在有了来龙去脉。",
        ],
        [
            ["章节", "核心概念", "我的理解"],
            ["第一章", "二进制", "用开关表示状态"],
            ["第三章", "CPU 与内存", "指令与数据的搬运"],
            ["第五章", "编程语言", "对机器指令的抽象"],
        ],
    )
    make_docx(
        OUT / "实训总结.docx",
        "机房实训周总结",
        [
            "本周实训共完成四个任务：系统安装与配置、办公软件综合应用、"
            "网络共享设置、以及机房设备的日常维护。",
            "在系统安装环节，我第一次独立完成了操作系统的全新安装与驱动配置，"
            "遇到网卡驱动缺失的问题，通过查看设备管理器中的硬件 ID 解决了。",
            "综合应用环节暴露出我在表格公式上的薄弱，后续需要多加练习。",
        ],
        [
            ["任务", "耗时", "自评"],
            ["系统安装", "2 课时", "良好"],
            ["办公软件", "3 课时", "通过"],
            ["网络共享", "1 课时", "良好"],
            ["设备维护", "1 课时", "通过"],
        ],
    )

    # ---- 表格类 ----
    make_xlsx(
        OUT / "班级成绩表.xlsx",
        ["学号", "姓名", "平时成绩", "期末成绩", "总评"],
        [
            ["20250101", "陈一", "88", "91", "=C2*0.4+D2*0.6"],
            ["20250102", "林二", "76", "82", "=C3*0.4+D3*0.6"],
            ["20250103", "黄三", "92", "95", "=C4*0.4+D4*0.6"],
            ["20250104", "刘四", "65", "58", "=C5*0.4+D5*0.6"],
            ["20250105", "蔡五", "81", "79", "=C6*0.4+D6*0.6"],
            ["20250106", "杨六", "90", "87", "=C7*0.4+D7*0.6"],
        ],
    )
    make_xlsx(
        OUT / "机房设备台账.xlsx",
        ["机位号", "主机型号", "内存", "购置年份", "状态"],
        [
            ["A-01", "联想 启天 M428", "16G", "2023", "正常"],
            ["A-02", "联想 启天 M428", "16G", "2023", "正常"],
            ["A-03", "戴尔 OptiPlex 7080", "8G", "2021", "待维修"],
            ["A-04", "戴尔 OptiPlex 7080", "8G", "2021", "正常"],
            ["A-05", "惠普 ProDesk 400", "16G", "2022", "正常"],
        ],
    )

    # ---- 截图类 ----
    word_screenshot(
        "我的家乡 · 图文混排练习",
        [
            "我的家乡位于江南水乡，河道纵横，桥梁众多。本次作业按照课程要求，"
            "完成了一份图文混排的自我介绍文档。",
            "文档正文使用小四号宋体，行距 1.5 倍，首行缩进两个字符。"
            "标题使用黑体二号并居中显示。",
            "插入的图片采用四周型环绕方式，与文字自然贴合，没有拉伸变形。",
        ],
        [
            ["项目", "要求", "完成情况"],
            ["标题格式", "黑体二号居中", "已完成"],
            ["正文字体", "宋体小四", "已完成"],
            ["图片环绕", "四周型", "已完成"],
        ],
    ).save(OUT / "图文混排截图.png")

    word_screenshot(
        "读书笔记 · 计算机是怎样跑起来的",
        [
            "这本书用非常浅显的语言解释了计算机内部的工作过程，从二进制开始，"
            "一路讲到操作系统和编程语言。",
            "让我印象最深的是 CPU 只做四件事：读取指令、解释指令、执行运算、写回结果。",
            "读完之后我重新理解了为什么变量需要类型、为什么内存要分区域。",
        ],
        [
            ["章节", "核心概念", "我的理解"],
            ["第一章", "二进制", "用开关表示状态"],
            ["第三章", "CPU 与内存", "指令与数据的搬运"],
        ],
    ).save(OUT / "读书笔记截图.png")

    word_screenshot(
        "实训总结 · 第一周",
        [
            "本周实训共完成四个任务：系统安装与配置、办公软件综合应用、"
            "网络共享设置、机房设备日常维护。",
            "在系统安装环节，我第一次独立完成了操作系统的全新安装与驱动配置。",
        ],
        None,
    ).save(OUT / "实训总结截图.png")

    sheet_screenshot(
        "班级成绩表",
        ["学号", "姓名", "平时成绩", "期末成绩", "总评"],
        [
            ["20250101", "陈一", "88", "91", "89.8"],
            ["20250102", "林二", "76", "82", "79.6"],
            ["20250103", "黄三", "92", "95", "93.8"],
            ["20250104", "刘四", "65", "58", "60.8"],
            ["20250105", "蔡五", "81", "79", "79.8"],
        ],
    ).save(OUT / "成绩表截图.png")

    sheet_screenshot(
        "机房设备台账",
        ["机位号", "主机型号", "内存", "购置年份", "状态"],
        [
            ["A-01", "联想 启天 M428", "16G", "2023", "正常"],
            ["A-02", "联想 启天 M428", "16G", "2023", "正常"],
            ["A-03", "戴尔 OptiPlex 7080", "8G", "2021", "待维修"],
            ["A-04", "戴尔 OptiPlex 7080", "8G", "2021", "正常"],
        ],
    ).save(OUT / "台账截图.png")

    slide_screenshot(
        "我的专业与未来规划",
        [
            "专业方向：计算机应用技术，主修办公自动化与基础网络运维",
            "本学期目标：通过计算机等级考试二级，熟练掌握 Excel 数据透视表",
            "三年规划：夯实基础 → 参加技能竞赛 → 进入企业实习",
            "职业方向：机房运维、技术支持、办公文员",
        ],
    ).save(OUT / "演示文稿截图.png")

    slide_screenshot(
        "机房网络拓扑说明",
        [
            "核心交换机：华为 S5720，划分三个 VLAN 分别承载教学、办公与管理流量",
            "接入层：每台机柜一台 24 口交换机，上行千兆光纤",
            "出口：防火墙 + 路由器，教学区限速 200Mbps",
            "地址规划：192.168.10.0/24 教学区，192.168.20.0/24 办公区",
        ],
    ).save(OUT / "网络拓扑截图.png")

    code_screenshot(
        "循环结构练习",
        "score_stats.py",
        [
            "# 统计成绩：最高分、最低分、平均分",
            "scores = [88, 76, 92, 65, 81, 90, 73]",
            "",
            "def summarize(values):",
            "    total = sum(values)",
            "    count = len(values)",
            "    return max(values), min(values), total / count",
            "",
            "if __name__ == '__main__':",
            "    high, low, avg = summarize(scores)",
            "    print(f'最高分 {high}，最低分 {low}，平均分 {avg:.1f}')",
        ],
    ).save(OUT / "代码截图.png")

    code_screenshot(
        "分支结构练习",
        "grade.py",
        [
            "# 根据分数判定等级",
            "def grade(score):",
            "    if score >= 90:",
            "        return '优秀'",
            "    elif score >= 80:",
            "        return '良好'",
            "    elif score >= 60:",
            "        return '及格'",
            "    else:",
            "        return '不及格'",
            "",
            "print(grade(88))",
        ],
    ).save(OUT / "分支代码截图.png")

    # ---- 照片 ----
    photo(1280, 960, 3).save(OUT / "实训现场照片.jpg", quality=82)
    photo(1280, 960, 7).save(OUT / "机房全景照片.jpg", quality=82)

    # ---- PDF 实验报告 ----
    report_pdf(
        "实训报告：办公软件综合应用",
        [
            ("一、实训目的", "掌握文字处理、电子表格与演示文稿的综合运用，能够独立完成一份完整的汇报材料。"),
            ("二、实训环境", "机房 A 区，Windows 10 专业版，Office 2019，每人一台独立主机。"),
            ("三、实训内容", "1. 使用 Word 完成图文混排的自我介绍文档；2. 使用 Excel 制作班级成绩表并使用公式统计；3. 使用 PowerPoint 制作不少于六页的汇报演示文稿。"),
            ("四、遇到的问题", "表格公式中的相对引用与绝对引用混淆，导致拖动填充后统计结果错误。查阅帮助文档后改用 $ 符号锁定列，问题解决。"),
            ("五、实训小结", "本次实训让我意识到，办公软件真正的难点不在界面操作，而在于数据组织方式。表格结构设计得好，后续统计几乎不用写公式。"),
        ],
    )[0].save(OUT / "实训报告.pdf", "PDF", resolution=110)

    pages = report_pdf(
        "实验报告：网络共享与权限配置",
        [
            ("一、实验目的", "掌握 Windows 局域网文件共享的配置方法，理解共享权限与 NTFS 权限的叠加规则。"),
            ("二、实验步骤", "1. 在主机 A 上创建共享文件夹，设置共享权限为「读取」；2. 设置 NTFS 权限为「修改」；3. 从主机 B 访问共享路径，验证最终有效权限。"),
            ("三、实验结果", "主机 B 只能读取不能写入，说明共享权限与 NTFS 权限取交集，限制更严格的一方生效。"),
            ("四、实验结论", "配置共享时应遵循最小权限原则，先设共享权限再设 NTFS 权限，避免权限过大导致数据被误删。"),
        ],
    )
    pages[0].save(OUT / "网络实验报告.pdf", "PDF", resolution=110, save_all=True, append_images=pages[1:])

    # ---- 源码类 ----
    (OUT / "成绩统计.py").write_text(
        PY_SCRIPT.format(
            title="成绩统计",
            func="summarize",
            args="values",
            doc="返回最高分、最低分与平均分",
            body="    total = sum(values)\n    return max(values), min(values), total / len(values)",
            call_args="[88, 76, 92, 65, 81]",
        ),
        encoding="utf-8",
    )
    (OUT / "等级判定.py").write_text(
        PY_SCRIPT.format(
            title="等级判定",
            func="grade",
            args="score",
            doc="按分数返回等级",
            body=(
                "    if score >= 90:\n        return '优秀'\n"
                "    if score >= 80:\n        return '良好'\n"
                "    if score >= 60:\n        return '及格'\n"
                "    return '不及格'"
            ),
            call_args="88",
        ),
        encoding="utf-8",
    )
    (OUT / "九九乘法表.py").write_text(
        PY_SCRIPT.format(
            title="九九乘法表",
            func="table",
            args="n=9",
            doc="打印 n 行乘法表",
            body=(
                "    rows = []\n"
                "    for i in range(1, n + 1):\n"
                "        rows.append(' '.join(f'{j}x{i}={i * j}' for j in range(1, i + 1)))\n"
                "    return '\\n'.join(rows)"
            ),
            call_args="",
        ),
        encoding="utf-8",
    )
    (OUT / "素数筛选.py").write_text(
        PY_SCRIPT.format(
            title="素数筛选",
            func="primes",
            args="limit",
            doc="埃氏筛法求 limit 以内的素数",
            body=(
                "    flags = [True] * (limit + 1)\n"
                "    flags[0:2] = [False, False]\n"
                "    for i in range(2, int(limit ** 0.5) + 1):\n"
                "        if flags[i]:\n"
                "            flags[i * i::i] = [False] * len(flags[i * i::i])\n"
                "    return [i for i, ok in enumerate(flags) if ok]"
            ),
            call_args="50",
        ),
        encoding="utf-8",
    )

    # ---- 文本类 ----
    (OUT / "剪辑思路.md").write_text(
        "# 短视频剪辑思路\n\n"
        "## 素材整理\n\n"
        "- 按拍摄时间分组，先粗剪掉明显废片\n"
        "- 统一帧率到 25fps，避免时间线错位\n\n"
        "## 节奏设计\n\n"
        "1. 开场三秒内给出冲突画面，抓住注意力\n"
        "2. 中段每 4–6 秒切换一次景别\n"
        "3. 结尾留白两秒，配合音乐收尾\n\n"
        "## 转场与字幕\n\n"
        "- 场景切换用叠化，动作衔接用硬切\n"
        "- 字幕统一黑体 48 号，底部留 80px 安全边距\n",
        encoding="utf-8",
    )
    (OUT / "快捷键备忘.md").write_text(
        "# 剪辑软件快捷键备忘\n\n"
        "| 操作 | 快捷键 |\n"
        "| --- | --- |\n"
        "| 切割 | Ctrl + K |\n"
        "| 撤销 | Ctrl + Z |\n"
        "| 导出 | Ctrl + M |\n"
        "| 放大时间线 | = |\n"
        "| 缩小时间线 | - |\n",
        encoding="utf-8",
    )

    # ---- 压缩包 ----
    with zipfile.ZipFile(OUT / "素材包.zip", "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("说明.txt", "本素材包包含作业所需的原始图片与音频，请解压后使用。\n")
        zf.writestr("清单.csv", "文件名,用途\nbgm.mp3,背景音乐\nlogo.png,片头标志\n")
        for i in range(3):
            zf.writestr(f"占位素材-{i + 1}.txt", f"素材 {i + 1}：示例内容\n" * 20)

    # ---- 课程封面 ----
    course_cover("计算机应用基础", "Windows · Word · Excel · PowerPoint", (43, 108, 176)).save(
        OUT / "封面-计算机应用基础.png"
    )
    course_cover("程序设计基础", "Python 变量 · 分支 · 循环", (56, 142, 120)).save(
        OUT / "封面-程序设计基础.png"
    )
    course_cover("视频剪辑", "时间线 · 转场 · 导出", (150, 92, 168)).save(
        OUT / "封面-视频剪辑.png"
    )
    course_cover("计算机网络技术", "体系结构 · IP 规划 · 交换机", (196, 118, 62)).save(
        OUT / "封面-计算机网络技术.png"
    )

    # ---- 视频 ----
    videos = [
        ("操作演示.mp4", 14, "机房操作演示 · 图文混排"),
        ("剪辑成品.mp4", 12, "短视频成品 · 转场练习"),
    ]
    made = [make_video(OUT / name, secs, label) for name, secs, label in videos]

    # ---- 汇总 ----
    total = 0
    print(f"生成目录：{OUT}")
    for path in sorted(OUT.iterdir()):
        size = path.stat().st_size
        total += size
        print(f"  {path.name:<24} {size / 1024:8.1f} KiB")
    print(f"共 {len(list(OUT.iterdir()))} 个文件，{total / 1024 / 1024:.2f} MiB")
    if not all(made):
        print("提示：ffmpeg 不可用或转码失败，视频文件未生成")


if __name__ == "__main__":
    main()
