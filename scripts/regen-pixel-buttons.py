#
# 用途：从四个角切片（{tone}-top-left/top-right/bottom-left/bottom-right.svg，
# 它们各自内嵌了完整按钮画稿）重新生成 9 宫格里其余 5 块切片，并给全部切片
# 加上 preserveAspectRatio="none" 和 1 设计像素的出血(bleed)，保证拼接处
# 逐像素连续。设计师在 Illustrator 里重新导出四个角之后，跑一遍本脚本即可：
#   python3 scripts/regen-pixel-buttons.py
# 详细原因见仓库根目录《修复说明.md》的"像素按钮拼接撕裂"一节。
import re, os

D = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'ui', 'pixel-buttons'))

PLANS = {
    '{t}-top-left':    ('{t}-top-left',    (0,   0,     251.8, 223.5)),
    '{t}-top-right':   ('{t}-top-right',   (0,   0,     242.5, 223.5)),
    '{t}-bottom-left': ('{t}-bottom-left', (0,   0,     251.8, 214.2)),
    '{t}-bottom-right':('{t}-bottom-right',(0,   0,     242.5, 214.2)),
    '{t}-top':         ('{t}-top-left',    (280, 0,     18.7,  223.5)),
    '{t}-bottom':      ('{t}-bottom-left', (280, 0,     18.7,  214.2)),
    '{t}-left':        ('{t}-top-left',    (0,   214.2, 251.8, 19.8)),
    '{t}-right':       ('{t}-top-right',   (0,   214.2, 242.5, 19.8)),
    '{t}-center':      ('{t}-top-left',    (280, 214.2, 18.7,  19.8)),
}

def fmt(v):
    s = ('%.1f' % v).rstrip('0').rstrip('.')
    return s if s else '0'

def transform(src_text, region):
    x, y, w, h = region
    s = src_text
    s = re.sub(r'(<svg[^>]*?)\s*preserveAspectRatio="[^"]*"', r'\1', s, count=1)
    s = re.sub(r'viewBox="[^"]+"',
               'preserveAspectRatio="none" viewBox="%s %s %s %s"' % (fmt(x), fmt(y), fmt(w), fmt(h)),
               s, count=1)
    def rect_sub(m):
        return '<rect class="%s" x="%s" y="%s" width="%s" height="%s"/>' % (m.group(1), fmt(x), fmt(y), fmt(w), fmt(h))
    s = re.sub(r'<rect class="(st\d+)"[^/]*?/>', rect_sub, s)
    return s

for tone in ['white', 'green']:
    srcs = {}
    for corner in ['top-left', 'top-right', 'bottom-left', 'bottom-right']:
        srcs['{t}-'+corner] = open(os.path.join(D, tone+'-'+corner+'.svg')).read()
    for out_pat, (src_pat, region) in PLANS.items():
        out_name = out_pat.format(t=tone)
        open(os.path.join(D, out_name+'.svg'), 'w').write(transform(srcs[src_pat], region))
        print('wrote', out_name+'.svg')
