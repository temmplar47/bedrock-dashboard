"""Render the WeChat article diagrams (architecture + panel mockup) as PNGs.

Output: docs/img/architecture.png, docs/img/panel-demo.png (2x for retina).
"""
from PIL import Image, ImageDraw, ImageFont

ROOT = r'C:\Users\Administrator\.qclaw\workspace\bedrock-dashboard'
FONT = r'C:\Windows\Fonts\msyh.ttc'
FONT_B = r'C:\Windows\Fonts\msyhbd.ttc'

# palette
DARK = (35, 47, 62)
DARK2 = (55, 71, 90)
WHITE = (255, 255, 255)
ORANGE = (255, 153, 0)
GRAY = (138, 148, 166)
BLUE = (54, 162, 235)
RED = (255, 99, 132)
TEAL = (45, 212, 191)
AMBER = (255, 159, 64)
MUTED = (90, 101, 114)


def f(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


def center(dr, xy, text, font, fill, spacing=6):
    x, y = xy
    lines = text.split('\n')
    heights = []
    for ln in lines:
        bb = dr.textbbox((0, 0), ln, font=font)
        heights.append(bb[3] - bb[1])
    total = sum(heights) + spacing * (len(lines) - 1)
    cy = y - total / 2
    for ln, h in zip(lines, heights):
        bb = dr.textbbox((0, 0), ln, font=font)
        w = bb[2] - bb[0]
        dr.text((x - w / 2 - bb[0], cy - bb[1]), ln, font=font, fill=fill)
        cy += h + spacing


def rounded_box(dr, box, radius, fill, outline=None, width=2):
    dr.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def arrow_down(dr, x, y1, y2, color, label=None, label_font=None):
    dr.line([(x, y1), (x, y2 - 14)], fill=color, width=5)
    dr.polygon([(x - 12, y2 - 18), (x + 12, y2 - 18), (x, y2)], fill=color)
    if label and label_font:
        bb = dr.textbbox((0, 0), label, font=label_font)
        w = bb[2] - bb[0]
        dr.text((x - w / 2, (y1 + y2) / 2 - 26), label, font=label_font, fill=color)


# ================= 1. architecture.png =================
W, H = 1344, 1460
img = Image.new('RGB', (W, H), DARK)
dr = ImageDraw.Draw(img)

center(dr, (W / 2, 84), 'ARCHITECTURE · 架构一图流', f(40, True), (143, 163, 184))
center(dr, (W / 2, 150), '1 个 IAM Role · 1 个 Lambda · 1 个 Permission · 1 个 HTTP API —— 月成本约等于 $0',
       f(30), (200, 210, 222))

bw, bh = 1040, 150  # main box size
bx = (W - bw) / 2
y = 230


def main_box(y, title, sub, accent=ORANGE):
    rounded_box(dr, (bx, y, bx + bw, y + bh), 22, WHITE)
    center(dr, (W / 2, y + 56), title, f(36, True), DARK)
    center(dr, (W / 2, y + 112), sub, f(26), GRAY)


main_box(y, '浏览器（密钥仅存于本机）', 'Browser — credentials live locally only')
arrow_down(dr, W / 2, y + bh + 8, y + bh + 78, ORANGE, 'GET 页面 / POST 查询', f(26, True))
y += bh + 86
main_box(y, 'API Gateway HTTP API（$default 阶段）', 'No API key · no stage config · same-origin')
arrow_down(dr, W / 2, y + bh + 8, y + bh + 78, ORANGE)
y += bh + 86
main_box(y, 'Lambda × 1（页面 + 查询代理）', 'Serves the page AND proxies queries')
arrow_down(dr, W / 2, y + bh + 8, y + bh + 78, ORANGE, '用请求体里上传的密钥调用', f(26, True))
y += bh + 100

# three service boxes
sw = (bw - 2 * 36) / 3
sh = 250
labels = [
    ('CloudWatch', 'GetMetricData', 'Token / 调用次数 / 延迟', BLUE),
    ('Cost Explorer', 'GetCostAndUsage', '成本（含 Marketplace 订阅）', RED),
    ('Service Quotas', 'GetServiceQuota', '配额 / 账户健康探测', TEAL),
]
for i, (t1, t2, t3, c) in enumerate(labels):
    sx = bx + i * (sw + 36)
    rounded_box(dr, (sx, y, sx + sw, y + sh), 22, DARK2, outline=c, width=3)
    center(dr, (sx + sw / 2, y + 64), t1, f(32, True), WHITE)
    center(dr, (sx + sw / 2, y + 128), t2, f(24), (200, 210, 222))
    center(dr, (sx + sw / 2, y + 190), t3, f(22, True), c)

center(dr, (W / 2, H - 70), '所有查询使用调用方上传的密钥执行 · 服务端不保存任何凭证', f(26), (143, 163, 184))
img.save(ROOT + r'\docs\img\architecture.png')

# ================= 2. panel-demo.png =================
W2, H2 = 1344, 1150
img2 = Image.new('RGB', (W2, H2), (251, 252, 253))
dr = ImageDraw.Draw(img2)

# header
rounded_box(dr, (40, 40, W2 - 40, 150), 24, DARK)
center(dr, (W2 / 2, 95), 'Amazon Bedrock 多账户监控面板（示意）', f(40, True), WHITE)

# summary cards
cards = [
    ('总成本（本窗口）', '$2,847.62', (238, 246, 255), (26, 115, 232)),
    ('总 Token 数', '8.6 亿', (238, 250, 243), (24, 133, 82)),
    ('总调用次数', '27.4 万', (255, 246, 238), (192, 80, 0)),
    ('活跃模型数', '4', (245, 239, 255), (118, 73, 200)),
]
cw = (W2 - 80 - 3 * 24) / 4
ch = 170
for i, (t, v, bg, fg) in enumerate(cards):
    cx = 40 + i * (cw + 24)
    rounded_box(dr, (cx, 190, cx + cw, 190 + ch), 20, bg)
    center(dr, (cx + cw / 2, 235), t, f(26), MUTED)
    center(dr, (cx + cw / 2, 300), v, f(44, True), fg)

# chart card
cx0, cy0, cx1, cy1 = 40, 400, W2 - 40, 1010
rounded_box(dr, (cx0, cy0, cx1, cy1), 24, WHITE, outline=(227, 231, 236), width=2)
dr.text((cx0 + 36, cy0 + 28), '各模型调用次数 · Invocations by model', font=f(30, True), fill=DARK)
dr.text((cx0 + 36, cy0 + 76), '每个模型自动分配独立配色', font=f(24), fill=GRAY)

# bars
base = cy1 - 90
maxh = 420
bars = [
    ('claude-opus-4-8', 96, BLUE),
    ('claude-opus-5', 70, RED),
    ('claude-opus-4-7', 28, TEAL),
    ('claude-fable-5', 8, AMBER),
]
region = cx1 - cx0 - 160
bwid = 150
gap = (region - 4 * bwid) / 5
for i, (name, hp, c) in enumerate(bars):
    bx0 = cx0 + 80 + gap + i * (bwid + gap)
    h = maxh * hp / 100
    rounded_box(dr, (bx0, base - h, bx0 + bwid, base), 10, c)
    bb = dr.textbbox((0, 0), name, font=f(23))
    nw = bb[2] - bb[0]
    dr.text((bx0 + bwid / 2 - nw / 2, base + 18), name, font=f(23), fill=MUTED)
dr.line([(cx0 + 60, base), (cx1 - 40, base)], fill=(200, 205, 214), width=3)

center(dr, (W2 / 2, H2 - 60), '（示意数据 · illustrative data — 实际面板还含 Token / 延迟 / 成本 / 配额 / 健康探测）',
       f(24), GRAY)
img2.save(ROOT + r'\docs\img\panel-demo.png')

print('OK: docs/img/architecture.png', img.size)
print('OK: docs/img/panel-demo.png', img2.size)
