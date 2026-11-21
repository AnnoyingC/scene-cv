# 窗外楼面的"照片素材库"：从真实的东京夜景照片（Wikimedia Commons，CC0）里裁出一块块正对着的楼面（写字楼、住宅），
# 统一缩放成"一层楼 = 24 像素"，拼成一张图集，给 render_view.py（--atlas）贴到 PLATEAU 的每一栋楼上：
# 每栋楼按类型随机挑一块，按真实层高缩放、在墙上铺开——每一扇窗、每一层亮着的灯、每一片窗帘都是照片里拍到的。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/window_atlas.py -- \
#       --src vendor-src/commons/windows --out vendor-src/commons/windows/atlas
#
# 产物：atlas.png（sRGB）、atlas.json（每块在图集里的位置、几层、宽多少"层高"、类型、出处）。
# 每块：裁下来 → 楼面上红色的航空灯涂掉（不然会跟着贴图在整面墙上重复）→ 用行亮度的自相关量出一层几像素 → 缩放、只留整层。
import json
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import get_args  # noqa: E402

A = get_args(src='vendor-src/commons/windows', out='vendor-src/commons/windows/atlas', floor_px=24, size=2048)
FP = A.floor_px

# (素材, 类型, (x0, y0, x1, y1) 原图像素，y 向下, 一层大约几像素（目测；再用自相关在 ±20% 里找准）)。类型：office 写字楼、res 住宅
SWATCHES = [
    ('roppongi-from-shibuya-stream', 'office', (1155, 1340, 1395, 1960), 23),
    ('roppongi-from-shibuya-stream', 'office', (3705, 1200, 3900, 1960), 22),
    ('roppongi-from-shibuya-stream', 'office', (3940, 1200, 4060, 1960), 22),
    ('roppongi-from-shibuya-stream', 'office', (3228, 2560, 3432, 3700), 64),
    ('roppongi-from-shibuya-stream', 'office', (2802, 2560, 2952, 3700), 64),
    ('azabudai-from-roppongi-4', 'office', (140, 1640, 420, 2150), 24),
    ('roppongi-from-shibuya-stream-2024', 'office', (600, 960, 760, 1390), 19),
    ('azabudai-from-roppongi-4', 'res', (830, 1600, 1140, 2450), 24),
    ('roppongi-from-shibuya-stream-2024', 'res', (1380, 1560, 1640, 2240), 41),
    ('roppongi-from-shibuya-stream', 'res', (990, 2835, 1075, 3030), 21),
    ('azabudai-from-roppongi-4', 'res', (540, 2800, 690, 2990), 30),
    ('azabudai-from-roppongi-4', 'res', (130, 2500, 380, 2690), 30),
    ('roppongi-from-shibuya-stream-2024', 'res', (2590, 1760, 2720, 1990), 22),
    ('roppongi-from-shibuya-stream-2024', 'res', (3200, 2160, 3430, 2300), 22),
]


def load(path):
    img = bpy.data.images.load(os.path.abspath(path))
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()      # 第 0 行在最上面（和照片的坐标一样）


def resize(a, w, h):
    """双线性缩放（先按整数倍平均缩小，避免锯齿）。"""
    H, W = a.shape[:2]
    k = max(1, int(min(H / h, W / w)))
    if k > 1:
        a = a[:H // k * k, :W // k * k].reshape(H // k, k, W // k, k, -1).mean((1, 3))
        H, W = a.shape[:2]
    ys = np.clip((np.arange(h) + 0.5) * H / h - 0.5, 0, H - 1)
    xs = np.clip((np.arange(w) + 0.5) * W / w - 0.5, 0, W - 1)
    y0, x0 = ys.astype(int), xs.astype(int)
    y1, x1 = np.minimum(y0 + 1, H - 1), np.minimum(x0 + 1, W - 1)
    fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
    return (a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx) * (1 - fy) + (a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx) * fy


def remove_red(a):
    """红色的航空灯（很红、很亮的一团，连同一圈光晕）：从边上往里一圈一圈地用周围的颜色补上（不留黑洞）。"""
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    red = (r > 0.3) & (g < r * 0.38) & (b < r * 0.45)      # 只认很红的（暖黄、橙色的窗 g/r 在 0.5 以上，不算）
    n = int(red.sum())
    if not n:
        return a, 0
    m = red.copy()
    for _ in range(8):                                   # 往外扩 8 圈（光晕、过曝发白的灯芯）
        p = np.pad(m, 1)
        m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    out = a.copy()
    known = ~m
    for _ in range(400):                                 # 洞里每个像素 = 已知的上下左右邻居的平均，一圈圈往里推
        if known.all():
            break
        pk = np.pad(known, 1)
        po = np.pad(out * known[..., None], ((1, 1), (1, 1), (0, 0)))
        cnt = pk[:-2, 1:-1].astype(np.float32) + pk[2:, 1:-1] + pk[1:-1, :-2] + pk[1:-1, 2:]
        tot = po[:-2, 1:-1] + po[2:, 1:-1] + po[1:-1, :-2] + po[1:-1, 2:]
        new = (~known) & (cnt > 0)
        out[new] = tot[new] / cnt[new][:, None]
        known = known | new
    return out, n


def floor_pitch(a, guess):
    """一层几像素：每一行的平均亮度做自相关，在目测值的 ±20% 里找最高的那个峰（找不到明显的峰就用目测值）。"""
    lo, hi = max(4, int(guess * 0.8)), int(guess * 1.2) + 1
    lum = (a @ np.array([0.2126, 0.7152, 0.0722], np.float32)).mean(1)
    lum = lum - lum.mean()
    cs = {p: float((lum[:-p] * lum[p:]).mean()) for p in range(lo, min(hi, len(lum) // 2))}
    if not cs:
        return float(guess)
    arg = max(cs, key=cs.get)
    if arg in (lo, hi - 1):          # 峰在边上：不可信
        return float(guess)
    return float(arg)


tiles, meta = [], []
for slug, kind, (x0, y0, x1, y1), guess in SWATCHES:
    src = load(os.path.join(A.src, slug, slug + '.jpg'))
    crop = src[y0:y1, x0:x1]
    crop, nred = remove_red(crop)
    p = floor_pitch(crop, guess)
    floors = int((y1 - y0) / p)
    s = FP / p
    h_px = floors * FP
    w_px = max(8, int(round((x1 - x0) * s)))
    tile = resize(crop[:int(floors * p)], w_px, h_px)
    tiles.append(tile)
    meta.append(dict(src=slug, kind=kind, box=[x0, y0, x1, y1], pitch=round(p, 1), floors=floors, width_floors=round(w_px / FP, 3), red_px=nred))
    print(f'[atlas] {slug} {kind} {x1 - x0}×{y1 - y0}: 一层 {p:.0f} px，{floors} 层，宽 {w_px / FP:.1f} 层高，涂掉红灯 {nred} px')

# 装箱：按高度从高到低一排一排放
S = A.size
atlas = np.zeros((S, S, 3), np.float32)
order = sorted(range(len(tiles)), key=lambda i: -tiles[i].shape[0])
x = y = row_h = 0
for i in order:
    t = tiles[i]
    h, w = t.shape[:2]
    if x + w > S:
        x, y, row_h = 0, y + row_h + 2, 0
    assert y + h <= S, '图集放不下：调大 --size'
    atlas[y:y + h, x:x + w] = t
    meta[i]['rect'] = [x / S, y / S, w / S, h / S]          # 归一化（y 从上往下）
    x += w + 2
    row_h = max(row_h, h)
used_h = y + row_h
print(f'[atlas] 用了 {S}×{used_h}')

os.makedirs(A.out, exist_ok=True)
img = bpy.data.images.new('atlas', S, S, alpha=False)
img.pixels.foreach_set(np.concatenate([atlas[::-1], np.ones((S, S, 1), np.float32)], -1).ravel())
img.filepath_raw = os.path.abspath(os.path.join(A.out, 'atlas.png'))
img.file_format = 'PNG'
img.save()
json.dump({'floor_px': FP, 'size': S, 'swatches': meta}, open(os.path.join(A.out, 'atlas.json'), 'w'), ensure_ascii=False, indent=1)
print('[atlas] →', A.out)
