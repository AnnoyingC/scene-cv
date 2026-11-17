# 照片做旧：把照片做成放了很多年的冲印照片（带相纸白边），给书桌房间的照片墙（js/photos.js）用。
# 用 Blender 自带的 Python 跑（要 numpy，系统的 python3 没装）：
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/age_photos.py -- --src photos-src --out assets/photos
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/age_photos.py -- --demo 1 --out assets/photos-sample
#
# --src：原图文件夹（jpg / png / webp / heic，heic 等格式先用 macOS 自带的 sips 转成 jpg）；--demo 1：不读原图，生成几张空白的旧照片当样例。
# 产物：每张照片两份 webp —— 名字.webp（长边 1600）和 名字.board.webp（钉在软木板上，长边 1024），
# 重新编码保存，原图里的 EXIF（拍摄时间、GPS 位置、相机型号）一律不带过去。真实照片还会写一份 photos.json（照片列表），
# 网页有这个文件就把这些照片钉到软木板上，没有就用 index.html 里的占位照片。
# 做旧的步骤（顺序有讲究，后一步作用在前一步的结果上）：
#   裁成最接近的冲印比例（3:2、4:3、5:4、1:1、16:9）→ 整体只轻轻旧一点（黑位稍抬、略偏暖、降一点饱和）→ 轻微柔焦 → 暗角
#   → 越靠边越旧：边上褪色发黄、斑驳（褪白的块 + 浅褐色污渍）、最外一圈发褐、霉点只长在边上 —— 画面中间保持看得清
#   → 胶片颗粒 → 偶尔漏光 → 灰尘 → 发黄的相纸白边（下边宽一点，边角磨旧）→ 有的照片角上一道折痕
# 卷边不在这里做：js/photos.js 钉到板上时把照片的角真的翘起来
# 每张照片的随机效果由文件名决定：同一张图重跑结果不变。
import math
import os
import shutil
import subprocess
import sys
import tempfile
import zlib

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import get_args  # noqa: E402

A = get_args(src='photos-src', out='assets/photos', demo=0, big=1600, small=1024)
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
SRC = os.path.join(ROOT, A.src)
OUTD = os.path.join(ROOT, A.out)
EXTS = ('.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.heic', '.heif')


# ---------- 读写（Blender 的图片接口；像素是 [高, 宽, 4]，第 0 行在最下面） ----------
def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1, :, :3].copy()  # 翻成第 0 行在最上面，去掉 alpha


def save(rgb, path, long_edge):
    h, w = rgb.shape[:2]
    k = long_edge / max(w, h)
    rgb = resize(rgb, max(1, round(w * k)), max(1, round(h * k)))
    h, w = rgb.shape[:2]
    img = bpy.data.images.new('out', w, h, alpha=False)
    px = np.ones((h, w, 4), dtype=np.float32)
    px[:, :, :3] = np.clip(rgb[::-1], 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP'
    sc = bpy.context.scene.render.image_settings
    sc.file_format, sc.quality, sc.color_mode = 'WEBP', 86, 'RGB'
    img.save_render(path)  # 全新的图片：不带原图的任何元数据
    bpy.data.images.remove(img)


def resize(rgb, w, h):
    """双线性缩放（缩小很多时先按整数倍取平均，不出摩尔纹）。"""
    sh, sw = rgb.shape[:2]
    f = max(1, min(sw // max(w, 1), sh // max(h, 1)))
    if f > 1:
        rgb = rgb[: sh // f * f, : sw // f * f].reshape(sh // f, f, sw // f, f, 3).mean((1, 3))
        sh, sw = rgb.shape[:2]
    ys = np.clip((np.arange(h) + 0.5) * sh / h - 0.5, 0, sh - 1)
    xs = np.clip((np.arange(w) + 0.5) * sw / w - 0.5, 0, sw - 1)
    y0, x0 = np.floor(ys).astype(int), np.floor(xs).astype(int)
    y1, x1 = np.minimum(y0 + 1, sh - 1), np.minimum(x0 + 1, sw - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    top = rgb[y0][:, x0] * (1 - fx) + rgb[y0][:, x1] * fx
    bot = rgb[y1][:, x0] * (1 - fx) + rgb[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def blur(a, r):
    """方框模糊（半径 r 像素，横竖各一遍，用累加和，任意半径都一样快）。a: [高, 宽] 或 [高, 宽, 通道]。"""
    r = int(r)
    if r < 1:
        return a
    for ax in (0, 1):
        pad = [(0, 0)] * a.ndim
        pad[ax] = (r + 1, r)
        c = np.cumsum(np.pad(a, pad, mode='edge'), axis=ax)
        a = (np.take(c, np.arange(2 * r + 1, c.shape[ax]), axis=ax) - np.take(c, np.arange(0, c.shape[ax] - 2 * r - 1), axis=ax)) / (2 * r + 1)
    return a


def noise(rng, h, w, scale):
    """低频噪声（0..1）：一张小网格的随机数放大到整张图再模糊，scale = 一块斑大概多少像素。"""
    gh, gw = max(2, int(h / scale) + 2), max(2, int(w / scale) + 2)
    g = rng.random((gh, gw))
    big = resize(np.repeat(g[:, :, None], 3, 2), w, h)[:, :, 0]
    big = blur(big, max(1, scale * 0.2))
    return (big - big.min()) / (np.ptp(big) + 1e-6)


def spots(img, rng, n, rmin, rmax, color, strength, near=None):
    """霉点：边缘软的小圆斑，往 color 的方向染（乘法），strength = 最深处染多少。near：只落在离边这么多像素以内（画面中间不长）。"""
    h, w = img.shape[:2]
    for _ in range(n):
        for _try in range(20):
            x, y = rng.uniform(0, w), rng.uniform(0, h)
            if near is None or min(x, w - x, y, h - y) < near:
                break
        r = rng.uniform(rmin, rmax)
        x0, x1, y0, y1 = int(max(0, x - 3 * r)), int(min(w, x + 3 * r)), int(max(0, y - 3 * r)), int(min(h, y + 3 * r))
        if x1 <= x0 or y1 <= y0:
            continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        k = np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * r * r)) * strength * rng.uniform(0.5, 1)
        img[y0:y1, x0:x1] *= 1 - k[:, :, None] * (1 - np.array(color))
    return img


RATIOS = (3 / 2, 4 / 3, 5 / 4, 1.0, 16 / 9)


# ---------- 做旧 ----------
def age(rgb, seed):
    rng = np.random.default_rng(seed)
    h, w = rgb.shape[:2]
    # 裁成最接近的冲印比例（竖图用倒过来的比例），居中：尽量少裁，海报、视频截图的字和画面都留得住
    q = min([*RATIOS, *(1 / r for r in RATIOS)], key=lambda r: abs(math.log(r * h / w)))
    cw, ch = min(w, round(h * q)), min(h, round(w / q))
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    c = rgb[y0:y0 + ch, x0:x0 + cw]
    k = A.big / max(cw, ch)
    c = resize(c, round(cw * k), round(ch * k))
    h, w = c.shape[:2]
    s = w / 1600  # 下面的像素尺寸都按长边 1600 写

    # 整体只轻轻旧一点（画面要看得清）：黑位稍微抬起、略偏暖、饱和度降一点；"旧"主要放在边上
    c = 0.04 + 0.9 * np.power(np.clip(c, 0, 1), 1.03)
    c = c * np.array([1.03, 1.0, 0.91])
    lum = (c * np.array([0.2126, 0.7152, 0.0722])).sum(2, keepdims=True)
    c = c + np.array([-0.008, 0.005, 0.018]) * (1 - lum) ** 2      # 暗部偏一点青
    c = lum + (c - lum) * 0.85                                      # 降一点饱和
    hi = blur(np.clip(lum[:, :, 0] - 0.7, 0, 1), 18 * s)           # 高光往外晕一点，偏红橙
    c = c + hi[:, :, None] * np.array([0.3, 0.15, 0.06])
    c = c * 0.75 + blur(c, 1.2 * s) * 0.25                          # 很轻的柔焦
    yy, xx = np.mgrid[0:h, 0:w]
    r2 = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
    c = c * (1 - 0.18 * np.clip(r2 / 2, 0, 1) ** 1.5)[:, :, None]  # 暗角
    # 越靠边旧得越厉害：E = 0（中间，不动）… 1（最边上），从边往里大约短边的 22% 开始
    E = (np.clip(1 - np.minimum.reduce([xx, w - 1 - xx, yy, h - 1 - yy]) / (0.22 * min(w, h)), 0, 1) ** 1.4)[:, :, None]
    c = c * (1 - 0.28 * E) + np.array([0.83, 0.75, 0.56]) * 0.28 * E        # 边上褪色发黄
    # 斑驳（只在边上那一圈）：一块块褪得发白发黄的地方 + 浅褐色的污渍
    m1 = np.clip((noise(rng, h, w, 200 * s) - 0.4) * 2.2, 0, 1)[:, :, None] * E
    c = c * (1 - 0.5 * m1) + np.array([0.86, 0.78, 0.57]) * 0.5 * m1
    m2 = np.clip((noise(rng, h, w, 90 * s) - 0.55) * 3.0, 0, 1)[:, :, None] * E
    c = c * (1 - m2 * np.array([0.14, 0.24, 0.42]))
    ed = np.clip(1 - np.minimum.reduce([xx, w - 1 - xx, yy, h - 1 - yy]) / (0.05 * w), 0, 1) ** 1.6  # 最外一圈发褐
    c = c * (1 - 0.3 * ed[:, :, None] * np.array([0.25, 0.5, 0.95]))
    g = rng.normal(0, 1, (h // 2 + 1, w // 2 + 1))                 # 颗粒：半分辨率的噪声放大一倍，颗粒有一点大小
    g = np.repeat(np.repeat(g, 2, 0), 2, 1)[:h, :w]
    g = blur(g, 1) * 0.9
    lum = (c * np.array([0.2126, 0.7152, 0.0722])).sum(2)
    c = c + (g * 0.028 * (0.5 + 0.8 * lum * (1 - lum) * 4) / 2)[:, :, None]
    if rng.random() < 0.5:                                          # 漏光：从一条边上进来一点暖色，用"滤色"叠上去
        cx, cy = rng.choice([0, w]), rng.uniform(0, h)
        d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / (w * rng.uniform(0.25, 0.4))
        leak = np.clip(1 - d, 0, 1) ** 2 * rng.uniform(0.25, 0.4)
        tint = np.array([1.0, rng.uniform(0.35, 0.55), rng.uniform(0.1, 0.25)])
        c = 1 - (1 - c) * (1 - leak[:, :, None] * tint)
    for _ in range(int(rng.integers(12, 30))):                     # 灰尘：很小的斑点，有亮有暗
        x, y, rr = rng.uniform(0, w), rng.uniform(0, h), rng.uniform(0.5, 1.6) * s
        m = (xx - x) ** 2 + (yy - y) ** 2 < rr * rr
        c[m] = c[m] * 0.7 if rng.random() < 0.6 else c[m] * 0.6 + 0.4 * 0.85
    for _ in range(int(rng.integers(0, 2))):                       # 偶尔一道很淡的划痕
        x = rng.uniform(0.1, 0.9) * w
        y0_, y1_ = sorted(rng.uniform(0, h, 2))
        ys_ = np.arange(int(y0_), int(y1_))
        xs_ = (x + np.sin(ys_ / h * 3 + rng.uniform(0, 6)) * 6 * s).astype(int).clip(0, w - 1)
        c[ys_, xs_] = c[ys_, xs_] * 0.75 + 0.25 * 0.85
    c = spots(c, rng, int(rng.integers(10, 26)), 1.5 * s, 7 * s, (0.62, 0.45, 0.25), 0.45, near=0.12 * min(w, h))  # 霉点：只长在边上

    # 相纸白边：四边 4%，下边 9%（冲印店的照片 / 拍立得那样）；纸是旧的：发黄、边上更黄、有几块水渍
    b, bb = round(0.04 * w), round(0.09 * w)
    H, W = h + b + bb, w + 2 * b
    paper = np.ones((H, W, 3)) * np.array([0.9, 0.84, 0.7])
    py, px_ = np.mgrid[0:H, 0:W]
    edge = np.minimum.reduce([px_, W - 1 - px_, py, H - 1 - py]) / (0.05 * W)
    paper = paper * (1 - 0.18 * np.clip(1 - edge, 0, 1) ** 2)[:, :, None] * np.array([1.0, 0.95, 0.85])
    paper = paper * (1 - 0.08 * noise(rng, H, W, 90 * s)[:, :, None] * np.array([0.3, 0.5, 0.9]))  # 纸也是斑驳的
    for _ in range(int(rng.integers(1, 4))):
        x, y, rr = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0.05, 0.15) * W
        d = np.sqrt((px_ - x) ** 2 + (py - y) ** 2) / rr
        ring = np.exp(-((d - 1) ** 2) / 0.01) * 0.06 + np.clip(1 - d, 0, 1) * 0.03
        paper = paper - ring[:, :, None] * np.array([0.3, 0.45, 0.8])
    gp = blur(rng.normal(0, 1, (H, W)), 1) * 0.012
    paper = paper + gp[:, :, None]
    paper[b:b + h, b:b + w] = c
    out = spots(paper, rng, int(rng.integers(6, 16)), 2 * s, 9 * s, (0.6, 0.44, 0.26), 0.35)
    # 四个角磨旧：角上发暗发褐，边缘一圈毛糙
    for cx, cy in ((0, 0), (W, 0), (0, H), (W, H)):
        d = np.sqrt((px_ - cx) ** 2 + (py - cy) ** 2) / (0.06 * W * rng.uniform(0.6, 1.3))
        out = out * (1 - 0.3 * np.clip(1 - d, 0, 1)[:, :, None] ** 1.5 * np.array([0.35, 0.55, 0.85]))
    rim = np.minimum.reduce([px_, W - 1 - px_, py, H - 1 - py]) < 2.5 * s * (0.5 + rng.random((H, W)))
    out[rim] *= np.array([0.8, 0.74, 0.62])
    # 一半的照片角上有一道折痕：一条亮线（折起来的棱）+ 旁边一条暗线，折过去的那一角再黄一点
    if rng.random() < 0.55:
        cx, cy = rng.choice([0, W]), rng.choice([0, H])
        a, bq = rng.uniform(0.12, 0.3) * W, rng.uniform(0.12, 0.3) * W
        p1 = np.array([abs(cx - a), cy]); p2 = np.array([cx, abs(cy - bq)])
        dv = (p2 - p1) / np.linalg.norm(p2 - p1)
        dist = (px_ - p1[0]) * dv[1] - (py - p1[1]) * dv[0]
        side = np.sign((cx - p1[0]) * dv[1] - (cy - p1[1]) * dv[0])
        dist = dist * side  # 正的一边是角那一侧
        out = out + (np.exp(-(dist / (1.4 * s)) ** 2) * 0.16)[:, :, None]
        out = out * (1 - (np.exp(-((dist + 3 * s) / (2 * s)) ** 2) * 0.14)[:, :, None])
        out = out * np.where((dist > 0)[:, :, None], np.array([0.97, 0.94, 0.86]), 1.0)
    return np.clip(out, 0, 1)


# ---------- 样例（公开仓库用的空白旧照片；真实照片放 photos-src/，不进 Git） ----------
def demo_images():
    """空白的旧照片：没有画面，只有一层很淡的底色（横的、竖的、方的各几张），做旧以后像褪了色的相纸。"""
    shapes = ((1500, 1000), (1000, 1400), (1500, 1000), (1200, 1200), (1000, 1400), (1500, 1000))
    tints = ((0.86, 0.84, 0.80), (0.82, 0.83, 0.84), (0.88, 0.85, 0.78), (0.80, 0.82, 0.83), (0.87, 0.84, 0.79), (0.84, 0.84, 0.82))
    out = {}
    for i, ((W, H), tint) in enumerate(zip(shapes, tints), 1):
        yy, xx = np.mgrid[0:H, 0:W] / np.array([H, W])[:, None, None]
        shade = 1 - 0.08 * ((xx - 0.5) ** 2 + (yy - 0.5) ** 2)  # 中间稍亮一点
        out[f'blank-{i}'] = np.clip(np.array(tint) * shade[..., None], 0, 1)
    return out


def sources():
    if A.demo:
        return demo_images()
    if not os.path.isdir(SRC):
        print(f'[photos] 没有找到原图文件夹 {SRC}')
        return {}
    out = {}
    tmp = tempfile.mkdtemp()
    for name in sorted(os.listdir(SRC)):
        stem, ext = os.path.splitext(name)
        if ext.lower() not in EXTS:
            continue
        path = os.path.join(SRC, name)
        if ext.lower() in ('.heic', '.heif', '.tif', '.tiff') and shutil.which('sips'):
            conv = os.path.join(tmp, stem + '.jpg')
            subprocess.run(['sips', '-s', 'format', 'jpeg', path, '--out', conv], check=True, capture_output=True)
            path = conv
        out[stem] = load(path)
    shutil.rmtree(tmp, ignore_errors=True)
    return out


os.makedirs(OUTD, exist_ok=True)
# 存图走场景的色彩管理：Blender 默认的 AgX 会把颜色再压一遍，改成 Standard（像素原样存）
vs = bpy.context.scene.view_settings
vs.view_transform, vs.look, vs.exposure, vs.gamma = 'Standard', 'None', 0.0, 1.0
items = sources()
for stem, rgb in items.items():
    aged = age(rgb, zlib.crc32(stem.encode()))
    save(aged, os.path.join(OUTD, stem + '.webp'), A.big)
    save(aged, os.path.join(OUTD, stem + '.board.webp'), A.small)
    print(f'[photos] {stem}: {aged.shape[1]}×{aged.shape[0]}')
if not A.demo and items:  # 照片列表：网页（js/room.js）有这份文件就用这些照片，不进 Git（和照片一起）
    import json
    rel = os.path.relpath(OUTD, ROOT).replace(os.sep, '/')
    lp = os.path.join(OUTD, 'photos.json')
    old = {}  # 已经写过的列表：保留每张照片手动加的东西（说明、在软木板上的位置 x / y / rot / order）
    if os.path.exists(lp):
        with open(lp, encoding='utf-8') as f:
            old = {it.get('alt'): it for it in json.load(f).get('photos', [])}
    with open(lp, 'w', encoding='utf-8') as f:
        json.dump({'photos': [{**old.get(k, {}), 'src': f'{rel}/{k}.webp', 'board': f'{rel}/{k}.board.webp', 'alt': k} for k in items]}, f, ensure_ascii=False, indent=1)
print(f'[photos] {len(items)} 张 → {OUTD}')
