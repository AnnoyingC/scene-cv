# 海报做旧：把一张杂志封面做成贴在墙上很多年的海报（平贴、不翘角），给书桌房间左手边那面墙用（js/room.js，个人模式）。
# 用 Blender 自带的 Python 跑（要 numpy）：
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/age_poster.py -- \
#       --src <封面图片> --out assets/posters --name <文件名> --title "<鼠标停在海报上时的提示>"
#
# 产物（assets/posters/，不进 Git：封面有版权，只在个人模式里用）：名字.webp、posters.json（{"<key>": {"file", "title"}}，每张一项，
# key 是墙上第几张：poster 是大海报，poster_2…poster_6 是它下面的几张，见 blender/bake_room.py 的 POSTERS）。
# 论文插图（--sheet 纸的宽高比、--margin 白边）：铺在一张白纸上，像打印出来贴的；--folds 0、--age 0.5 旧得轻一点。
# 做旧的步骤：油墨褪色、整体偏暖 → 纸发黄（不均匀）→ 靠窗那一侧（右边）晒得更褪 → 对折过的一横一竖两道折痕（折痕上油墨裂开发白，
# 一边亮一边暗）→ 四边磨出细小的白色缺口、边上一圈脏 → 两三块很淡的水渍、几颗霉点 → 纸的纹理颗粒 → 四个角各压一段旧纸胶带（平的）。
import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import get_args  # noqa: E402

A = get_args(src='', out='assets/posters', name='poster', title='', seed=7, tape=0, key='poster', sheet=0.0, margin=0.0, folds=2,
             age=1.0, long=1400)   # tape 1：贴图里画旧纸胶带（房间里四角已经有真的白胶带）
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def load(path):
    img = bpy.data.images.load(os.path.abspath(path))
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()          # 第 0 行在最上面


def save(rgb, path):
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.pixels.foreach_set(np.concatenate([rgb[::-1], np.ones((h, w, 1), np.float32)], -1).ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP'
    img.save(quality=90)
    bpy.data.images.remove(img)


def blur(a, r):
    for _ in range(3):
        for ax in (0, 1):
            pad = [(0, 0)] * a.ndim
            pad[ax] = (r + 1, r)
            c = np.cumsum(np.pad(a, pad, mode='edge'), axis=ax)
            n = a.shape[ax]
            a = (np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=ax) - np.take(c, np.arange(n), axis=ax)) / (2 * r + 1)
    return a


def noise(rng, h, w, cell):
    """平滑噪声（0…1）：粗格子随机数放大后模糊。"""
    g = rng.random((h // cell + 2, w // cell + 2)).astype(np.float32)
    big = np.kron(g, np.ones((cell, cell), np.float32))[:h, :w]
    return blur(big, max(1, cell // 2))


rng = np.random.default_rng(A.seed)
img = load(A.src)
if A.sheet:   # 论文插图：等比缩放后放在一张白纸（宽高比 sheet）中间，四周至少留 margin（短边的比例）
    h0, w0 = img.shape[:2]
    Wp = A.long if A.sheet >= 1 else int(A.long * A.sheet)
    Hp = int(Wp / A.sheet)
    m = int(min(Wp, Hp) * A.margin)
    k = min((Wp - 2 * m) / w0, (Hp - 2 * m) / h0)
    nw, nh = int(w0 * k), int(h0 * k)
    ys = np.clip(((np.arange(nh) + 0.5) / k - 0.5).astype(int), 0, h0 - 1)
    xs = np.clip(((np.arange(nw) + 0.5) / k - 0.5).astype(int), 0, w0 - 1)
    sheet = np.ones((Hp, Wp, 3), np.float32) * 0.97
    oy, ox = (Hp - nh) // 2, (Wp - nw) // 2
    if k < 1:   # 缩小：先按整数倍平均，避免锯齿
        f = max(1, int(1 / k))
        small = img[:h0 // f * f, :w0 // f * f].reshape(h0 // f, f, w0 // f, f, 3).mean((1, 3))
        ys2 = np.clip(((np.arange(nh) + 0.5) / (k * f) - 0.5).astype(int), 0, small.shape[0] - 1)
        xs2 = np.clip(((np.arange(nw) + 0.5) / (k * f) - 0.5).astype(int), 0, small.shape[1] - 1)
        sheet[oy:oy + nh, ox:ox + nw] = small[ys2][:, xs2]
    else:
        sheet[oy:oy + nh, ox:ox + nw] = img[ys][:, xs]
    img = sheet
H, W = img.shape[:2]
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
u, v = xx / W, yy / H

# 1. 油墨褪色：黑位抬一点、对比和饱和度降一点、偏暖（青、品红褪得快）
lum = img @ np.array([0.299, 0.587, 0.114], np.float32)
AG = A.age
img = lum[..., None] + (img - lum[..., None]) * (1 - 0.22 * AG)
img = 0.07 * AG + img * (1 - 0.14 * AG)
img *= np.array([1 + 0.03 * AG, 1 - 0.015 * AG, 1 - 0.12 * AG], np.float32)
# 2. 纸发黄：亮的地方往旧纸色拉（深浅不均匀）
paper = np.array([0.93, 0.86, 0.70], np.float32)
yel = (0.22 + 0.18 * noise(rng, H, W, 90)) * AG
img = img * (1 - yel[..., None] * 0.6) + paper * img * yel[..., None] * 0.6 + (paper - img).clip(0) * yel[..., None] * 0.25
# 3. 靠窗的一侧（右边）晒得更褪
sun = np.clip((u - 0.35) / 0.65, 0, 1) ** 1.5
img = img + (paper * 0.95 - img) * (0.16 * AG * sun)[..., None]
# 4. 折痕：竖的在正中、横的在正中（对折过两次），油墨裂开的一道细白线 + 两边一亮一暗
for axis, pos in ((0, 0.5), (1, 0.5))[:A.folds]:
    coord = (u if axis == 0 else v) - pos
    wob = (noise(rng, H, W, 60) - 0.5) * 0.004
    d = (coord + wob) * (W if axis == 0 else H)
    crack = np.exp(-(d / 0.9) ** 2) * (0.35 + 0.65 * (noise(rng, H, W, 6) > 0.45))
    shade = np.where(d < 0, -1.0, 1.0) * np.exp(-np.abs(d) / 5.0) * 0.05
    img = img * (1 + shade[..., None]) + (paper * 1.02 - img) * (crack * 0.55)[..., None]
# 5. 四边：细小的白色缺口（纸纤维露出来）+ 一圈脏
edge = np.minimum(np.minimum(xx, W - 1 - xx), np.minimum(yy, H - 1 - yy))
nick = (noise(rng, H, W, 2) > 0.66) & (edge < 1.2 + 2.6 * noise(rng, H, W, 40))
img[nick] = img[nick] * 0.45 + paper * 1.0 * 0.55
img *= (1 - 0.1 * np.exp(-edge / 14))[..., None]
# 6. 水渍（淡淡的一圈褐色边）、霉点
for _ in range(round(3 * AG)):
    cx, cy, r = rng.uniform(0.1, 0.9) * W, rng.uniform(0.15, 0.95) * H, rng.uniform(0.05, 0.12) * W
    d = np.hypot(xx - cx, yy - cy) / r * (1 + 0.15 * (noise(rng, H, W, 25) - 0.5))
    ring = np.exp(-((d - 1) / 0.06) ** 2) * 0.10 + (d < 1) * 0.025
    img = img * (1 - ring[..., None]) + np.array([0.55, 0.40, 0.22], np.float32) * ring[..., None]
for _ in range(round(26 * AG)):
    cx, cy, r = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0.8, 2.6)
    m = np.exp(-(np.hypot(xx - cx, yy - cy) / r) ** 2) * rng.uniform(0.15, 0.4)
    img = img * (1 - m[..., None]) + np.array([0.5, 0.36, 0.2], np.float32) * m[..., None]
# 7. 纸的纹理
img *= (1 + (rng.random((H, W)).astype(np.float32) - 0.5) * 0.05 + (noise(rng, H, W, 3) - 0.5) * 0.04)[..., None]
# 8. 四个角压着旧纸胶带（半透明的米黄色、边缘毛糙，斜着贴）
tape = np.array([0.86, 0.80, 0.62], np.float32)
for cx, cy, ang in () if not A.tape else ((0, 0, 45), (W, 0, -45), (0, H, -45), (W, H, 45)):
    a = math.radians(ang + rng.uniform(-8, 8))
    ca, sa = math.cos(a), math.sin(a)
    px, py = (xx - cx) * ca + (yy - cy) * sa, -(xx - cx) * sa + (yy - cy) * ca
    tl, tw = W * 0.12, W * 0.04
    rough = (noise(rng, H, W, 3) - 0.5) * 4
    m = ((np.abs(px) < tl + rough) & (np.abs(py) < tw + rough * 0.5)).astype(np.float32)
    m = blur(m, 1) * 0.78
    img = img * (1 - m[..., None]) + tape * img.clip(0.55) * m[..., None] * 1.05 + tape * 0.0
img = np.clip(img, 0, 1).astype(np.float32)

os.makedirs(os.path.join(ROOT, A.out), exist_ok=True)
fn = A.name + '.webp'
save(img, os.path.join(ROOT, A.out, fn))
pj = os.path.join(ROOT, A.out, 'posters.json')
data = json.load(open(pj)) if os.path.exists(pj) else {}
data[A.key] = {'file': fn, 'title': A.title}
json.dump(dict(sorted(data.items())), open(pj, 'w'), ensure_ascii=False, indent=1)
print(f'[poster] {W}×{H} → {A.out}/{fn}')
