#!/usr/bin/env python3
"""
把 537KB 的方舟像素字体按 unicode-range 拆成若干 woff2 分片。

为什么要拆：一整份字体 24,434 个字形，首页实际渲染出来的中文只有一千来个。
浏览器对带 unicode-range 的 @font-face 只下载「页面上真的出现了的字」所在的那几份，
桌面首屏从 549KB 降到几十 KB；游戏详情页出现生僻字时再按需补一份。

分片规则：
  第 0 份 = 站点界面文案（src/locales/zh-Hans|zh-Hant|ja.ts、src/data/）+ 线上首页 /
            游戏库实际渲染的字（scripts/fonts/ark-pixel-seed.txt）+ 全部中文标点和全角符号。
            几乎每个页面都只用到这一份。
  其余    = 剩下的字形按码位排序，每 1500 个一份（约 30KB），码位相邻的字常一起出现。

产物（都要提交）：
  public/fonts/ark-pixel/split/ark-pixel-<序号>-<内容哈希>.woff2
  public/fonts/ark-pixel/split/ark-pixel-faces-<内容哈希>.css（@font-face 列表）
  index.html 里 ark-pixel-faces 标记之间那条 <link>（脚本自动改写）

@font-face 列表单独成文件而不进 src/index.css：精确的 unicode-range 有 41KB（gzip 15KB），
放进主 CSS 等于让每个手机访客在首屏关键路径上多下 15KB，而手机根本不用这个字体
（index.css 只在 hover+fine pointer 下把它放进字体栈）。单独的 <link media="(hover: hover)
and (pointer: fine)"> 在手机上不阻塞渲染，只在空闲时低优先级取回。

文件名带内容哈希：/fonts/ 是一年 immutable 缓存（server/src/cache.js CACHE.font），
内容一变名字就变，不会和旧缓存拼在一起。

依赖 fontTools + brotli，只在重新生成时需要：
  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
  /tmp/ft/bin/python scripts/fonts/split-ark-pixel.py
"""
import glob
import hashlib
import io
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SOURCE = os.path.join(ROOT, 'public/fonts/ark-pixel/ark-pixel-12px-proportional-zh_cn.otf.woff2')
OUT_DIR = os.path.join(ROOT, 'public/fonts/ark-pixel/split')
INDEX_HTML = os.path.join(ROOT, 'index.html')
MARK_START = '<!-- ark-pixel-faces:start -->'
MARK_END = '<!-- ark-pixel-faces:end -->'
SEED = os.path.join(ROOT, 'scripts/fonts/ark-pixel-seed.txt')
CHUNK_GLYPHS = 1500

# Geist Pixel 已经覆盖拉丁（index.css 里那两份 unicode-range）；这里不再给拉丁发字形，
# 否则西文页面也会因为一个空格去拉中文分片。
LATIN_END = 0x2000


def text_chars(paths):
    chars = set()
    for path in paths:
        with open(path, encoding='utf-8') as f:
            chars.update(ord(c) for c in f.read() if ord(c) >= LATIN_END)
    return chars


def ranges(codepoints, order):
    """
    [0x4e00, 0x4e01, 0x4e03] -> 'U+4E00-4E01, U+4E03'，但允许区间跨过**字体里根本没有**的码位。

    区间之间绝不能重叠：Chrome 会把 unicode-range 与页面文字有交集的分片**全部**下载，
    并不会先看后声明的那一份够不够用（实测重叠写法让只含界面文字的页面拉了 13 份）。
    可字体本身在符号区、CJK 区都有大量空码位，逐字精确写区间会让这段首屏 CSS 膨胀到 84KB；
    跨过那些空位并不会和别的分片冲突，于是只在「排序后相邻的两个字之间没有任何字形」时合并。

    order: 全部字形码位 -> 在排序表里的下标，用来判断两个字之间有没有别的字形。
    """
    out = []
    cps = sorted(codepoints)
    start = prev = cps[0]
    for cp in cps[1:] + [None]:
        if cp is not None and order[cp] == order[prev] + 1:
            prev = cp
            continue
        out.append(f'U+{start:04X}' if start == prev else f'U+{start:04X}-{prev:04X}')
        if cp is not None:
            start = prev = cp
    return ', '.join(out)


def build_chunk(codepoints):
    # 不重写 head.modified：同样的输入必须得到同样的字节，否则每跑一次脚本文件名哈希都变，
    # 玩家白白重下全部分片。
    font = TTFont(SOURCE, recalcTimestamp=False)
    options = subset.Options()
    options.flavor = 'woff2'
    # 像素字体靠字形本身对齐；hinting 和名字表里的多语言记录对它没有用
    options.hinting = False
    options.name_languages = ['*']
    options.layout_features = ['*']
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    buf = io.BytesIO()
    font.flavor = 'woff2'
    font.save(buf)
    return buf.getvalue()


def main():
    cmap = TTFont(SOURCE).getBestCmap()
    available = {cp for cp in cmap if cp >= LATIN_END}

    ui_sources = [
        os.path.join(ROOT, 'src/locales/zh-Hans.ts'),
        os.path.join(ROOT, 'src/locales/zh-Hant.ts'),
        os.path.join(ROOT, 'src/locales/ja.ts'),
        SEED,
        *glob.glob(os.path.join(ROOT, 'src/data/**/*.ts'), recursive=True),
    ]
    # 只收正文里真会出现的标点：通用标点（破折号、引号、省略号）、CJK 标点、全角符号。
    # 整个 U+2000-30FF 有一千八百多个字形（箭头、制表符、几何图形），塞进第 0 份会让它翻倍。
    punctuation = {
        cp for cp in available
        if 0x2010 <= cp <= 0x2027 or 0x3000 <= cp <= 0x303F or 0xFF00 <= cp <= 0xFFEF
    }
    ui_text = text_chars(ui_sources)
    first = (ui_text | punctuation) & available
    rest = sorted(available - first)
    tail = [rest[i:i + CHUNK_GLYPHS] for i in range(0, len(rest), CHUNK_GLYPHS)]
    # 最后一份太碎时并进前一份，免得为几十个字单独多一次请求
    if len(tail) > 1 and len(tail[-1]) < CHUNK_GLYPHS // 4:
        tail[-2].extend(tail.pop())
    chunks = [sorted(first)] + tail

    os.makedirs(OUT_DIR, exist_ok=True)
    for old in glob.glob(os.path.join(OUT_DIR, '*.woff2')) + glob.glob(os.path.join(OUT_DIR, '*.css')):
        os.remove(old)

    # 界面里用到、字体却没有的字（实测「拳」就不在这份字体里）也要挡住区间合并：
    # 否则它落进某一份的合并区间，浏览器会为它白下那一份，下完才发现没有这个字形。
    order = {cp: i for i, cp in enumerate(sorted(available | ui_text))}
    faces = []
    total = 0
    for index, cps in enumerate(chunks):
        data = build_chunk(cps)
        digest = hashlib.sha256(data).hexdigest()[:10]
        name = f'ark-pixel-{index:02d}-{digest}.woff2'
        with open(os.path.join(OUT_DIR, name), 'wb') as f:
            f.write(data)
        total += len(data)
        faces.append(
            '@font-face {\n'
            "  font-family: 'Ark Pixel';\n"
            f"  src: url('/fonts/ark-pixel/split/{name}') format('woff2');\n"
            '  font-weight: 400;\n'
            '  font-style: normal;\n'
            '  font-display: optional;\n'
            f'  unicode-range: {ranges(cps, order)};\n'
            '}\n'
        )
        print(f'{name}: {len(cps)} glyphs, {len(data) / 1024:.1f}KB')

    css = (
        '/* 由 scripts/fonts/split-ark-pixel.py 生成，不要手改。\n'
        ' * 浏览器只下载页面上实际出现的字所在的分片；第 0 份是界面文案，几乎每页都只用到它。\n'
        ' * font-display: optional 与拆分前一致：慢网保留系统中文字体，不在加载完后整页换字。 */\n'
        + '\n'.join(faces)
    ).encode('utf-8')
    css_name = f'ark-pixel-faces-{hashlib.sha256(css).hexdigest()[:10]}.css'
    with open(os.path.join(OUT_DIR, css_name), 'wb') as f:
        f.write(css)

    with open(INDEX_HTML, encoding='utf-8') as f:
        html = f.read()
    head, rest_html = html.split(MARK_START, 1)
    _, tail_html = rest_html.split(MARK_END, 1)
    link = (
        f'{MARK_START}\n'
        f'    <link rel="stylesheet" href="/fonts/ark-pixel/split/{css_name}" media="(hover: hover) and (pointer: fine)" />\n'
        f'    {MARK_END}'
    )
    with open(INDEX_HTML, 'w', encoding='utf-8') as f:
        f.write(head + link + tail_html)
    print(f'{len(chunks)} chunks, {total / 1024:.0f}KB total, faces CSS {len(css) / 1024:.0f}KB -> {css_name}')

if __name__ == '__main__':
    sys.exit(main())
