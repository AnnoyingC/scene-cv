# 示例项目 Unfog 的节目带（assets/tapes/sample/unfog/show.json）用的三张图，全是代码画的，没有版权问题：
#   screen.webp           一张示意的软件界面截图（线框图：占位块代替文字，谁拿模板去用都合适；深色界面，夜里的电视上不刺眼）
#   before.webp / after.webp  前后对比：一张浑浊、偏绿、发虚的画面，和它清楚的样子（黄昏的山和湖）
# 用法：python3 scripts/make_sample_tape.py（要 numpy 和 Pillow）
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'tapes', 'sample', 'unfog')
W, H = 1024, 768
rng = np.random.default_rng(7)


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# ---------- 截图：一个应用窗口（标题栏、侧边栏、几张数字卡、一条往上走的曲线、一张表） ----------
def screen():
    im = Image.new('RGB', (W, H), '#1b1f24')
    d = ImageDraw.Draw(im)
    accent, ink, faint = hexrgb('#e8b04a'), hexrgb('#dfe3e8'), hexrgb('#3b424b')
    d.rectangle([0, 0, W, 46], fill='#111418')
    for k, c in enumerate(['#ff5f57', '#febc2e', '#28c840']):
        d.ellipse([18 + k * 24, 16, 32 + k * 24, 30], fill=c)
    d.rounded_rectangle([W / 2 - 150, 14, W / 2 + 150, 32], 6, fill='#262b31')
    d.rectangle([0, 46, 232, H], fill='#20252b')
    for k in range(8):
        y = 86 + k * 46
        if k == 2:
            d.rounded_rectangle([14, y - 12, 218, y + 22], 8, fill=(*accent,))
            d.rounded_rectangle([30, y, 30 + 120, y + 10], 5, fill='#1b1f24')
        else:
            d.rounded_rectangle([30, y, 30 + 70 + (k * 37) % 90, y + 10], 5, fill=faint)
    d.rectangle([232, 46, W, H], fill='#1b1f24')
    d.rounded_rectangle([268, 82, 268 + 300, 82 + 22], 8, fill=ink)
    d.rounded_rectangle([268, 116, 268 + 200, 116 + 10], 5, fill=faint)
    # 三张数字卡
    for k in range(3):
        x = 268 + k * 244
        d.rounded_rectangle([x, 150, x + 224, 150 + 108], 12, fill='#232830', outline='#2e343c', width=2)
        d.rounded_rectangle([x + 20, 172, x + 110, 182], 5, fill=faint)
        d.rounded_rectangle([x + 20, 200, x + 20 + 120 - k * 24, 200 + 34], 8, fill=accent if k == 0 else ink)
    # 曲线图：网格、往上走的线、线下面淡淡的一层
    x0, y0, x1, y1 = 268, 290, W - 44, 520
    d.rounded_rectangle([x0, y0, x1, y1], 12, fill='#20252b', outline='#2e343c', width=2)
    for k in range(1, 5):
        y = y0 + k * (y1 - y0) / 5
        d.line([x0 + 20, y, x1 - 20, y], fill='#2a3037', width=2)
    n = 40
    xs = np.linspace(x0 + 30, x1 - 30, n)
    trend = np.linspace(0.12, 0.86, n) ** 1.3
    wob = 0.05 * np.sin(np.linspace(0, 9, n)) + 0.03 * rng.standard_normal(n)
    ys = y1 - 24 - (y1 - y0 - 60) * np.clip(trend + wob, 0.05, 0.95)
    pts = list(zip(xs, ys))
    fill = Image.new('L', (W, H), 0)
    ImageDraw.Draw(fill).polygon(pts + [(xs[-1], y1 - 20), (xs[0], y1 - 20)], fill=55)
    im.paste(Image.new('RGB', (W, H), accent), (0, 0), fill)
    d = ImageDraw.Draw(im)
    d.line(pts, fill=accent, width=5, joint='curve')
    d.ellipse([xs[-1] - 8, ys[-1] - 8, xs[-1] + 8, ys[-1] + 8], fill=accent, outline='#1b1f24', width=3)
    # 表格
    for k in range(5):
        y = 548 + k * 40
        if k % 2 == 0:
            d.rectangle([268, y - 10, W - 44, y + 26], fill='#20252b')
        d.rounded_rectangle([288, y, 288 + 150 + (k * 53) % 110, y + 10], 5, fill=faint)
        d.rounded_rectangle([560, y, 560 + 90, y + 10], 5, fill=faint)
        d.rounded_rectangle([W - 160, y - 2, W - 64, y + 14], 7, fill=accent if k == 0 else '#2e343c')
    return im


# ---------- 前后对比：黄昏的山和湖；"之前"是同一张蒙上一层偏绿的雾、发虚、有噪点 ----------
def ridge(n, base, amp, seed, rough=4):
    r = np.random.default_rng(seed)
    x = np.linspace(0, 1, n)
    y = np.zeros(n)
    for k in range(1, rough + 1):
        y += np.sin(x * np.pi * (1.3 * k ** 1.6) + r.uniform(0, 6.3)) / k ** 1.1
    y = (y - y.min()) / (y.max() - y.min())
    return base - amp * y


def after():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    hz = int(H * 0.62)  # 地平线（湖面）
    top, mid, low = np.array(hexrgb('#1b2c4f')), np.array(hexrgb('#a4628f')), np.array(hexrgb('#f6b26b'))
    k = np.clip(yy / hz, 0, 1)[..., None]
    sky = np.where(k < 0.6, top + (mid - top) * (k / 0.6), mid + (low - mid) * ((k - 0.6) / 0.4))
    img = sky.copy()
    sx, sy = W * 0.62, hz - 150
    dist = np.sqrt((xx - sx) ** 2 + (yy - sy) ** 2)[..., None]
    img += np.array([255, 214, 150]) * np.exp(-dist / 90) * 0.9  # 太阳的光晕
    img = np.where(dist < 34, np.array([255, 236, 196]), img)
    layers = [(hz - 70, 150, '#5d4a78', 3), (hz - 25, 120, '#3b3157', 11), (hz + 2, 80, '#1f1c33', 23)]
    for base, amp, col, seed in layers:
        r = ridge(W, base, amp, seed)
        mask = (yy >= r[None, :])[..., None] & (yy <= hz)[..., None]
        img = np.where(mask, np.array(hexrgb(col)), img)
    # 湖：上面整张倒过来、压暗，加几道横向的波纹
    rows = np.arange(hz, H)
    src = np.clip(2 * hz - rows - 1, 0, hz - 1)
    lake = img[src, :, :] * 0.62 + np.array(hexrgb('#101828')) * 0.25
    ripple = (np.sin(rows[:, None] * 0.9 + np.sin(xx[hz:] * 0.02) * 3) > 0.97)[..., None]
    lake = np.where(ripple, lake * 1.25, lake)
    img[hz:] = lake
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))


def before(clear):
    a = np.asarray(clear.filter(ImageFilter.GaussianBlur(2.6))).astype(np.float32)
    haze = np.array(hexrgb('#6f8a73'), dtype=np.float32)
    a = a * 0.5 + haze * 0.5  # 一层偏绿的雾，对比度掉一半
    a *= np.array([0.86, 1.0, 0.92])  # 红光被吃掉
    a += rng.normal(0, 9, a.shape)
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


os.makedirs(OUT, exist_ok=True)
screen().save(os.path.join(OUT, 'screen.webp'), quality=82, method=6)
clear = after()
clear.save(os.path.join(OUT, 'after.webp'), quality=82, method=6)
before(clear).save(os.path.join(OUT, 'before.webp'), quality=80, method=6)
print('wrote', [f for f in os.listdir(OUT) if f.endswith('.webp')])
