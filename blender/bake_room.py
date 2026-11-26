# 用 Python 驱动 Blender：搭房间 → Cycles 分层烘焙光照 → 导出 glTF + lightmap。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/bake_room.py -- --size 2048 --samples 1024
#
# 先跑 render_view.py（窗外夜景），这里会把 view_full.jpg 当成窗外的发光板，让城市的光照进屋里。
#
# 第三方模型（电脑、电视、唱机、台灯、地毯、四盆植物、挂画、软木板、日历、摄影机、磁带）从 vendor-src/ 导入（blender/room_vendor.py），
# 和房间合成一个网格一起烘焙。植物叶片是贴图镂空的卡片：烘焙时光从镂空处漏过去，manifest.cutout 告诉浏览器哪些材质要镂空。
# 素材的来源和许可证见 assets/vendor/credits.json；manifest.vendor 记下这个场景用了哪些。
#
# 产物（assets/baked/）：
#   room.glb         静态几何（Room：烘焙物件，两套 UV：UVMap 给颜色贴图、Lightmap 给光照；Glow：灯泡、灯罩，浏览器里画成自发光）
#                    Draco 压缩，不带法线（光照是烘焙好的，用不到）
#   lm_ambient.jpg   月光 + 窗外城市光 + 电脑屏幕
#   lm_room.jpg      屋里的灯：落地灯、窗上的串灯、柜子上的台灯、照着书架的一块看不见的面光
#   lm_lamp.jpg      书桌台灯
#   lm_tv.jpg        电视（按白光烘焙，浏览器里按画面颜色染色）
#   manifest.json    每层的亮度系数、开场镜头、屏幕和发光体的位置、可点物件的热点盒子、点了之后镜头对准哪里
#
# 编码：贴图里存的是 (光照 / scale) ^ (1/3)，浏览器里用 c*c*c*scale 还原，8 位 JPG 也能存下较大的亮度范围。
# 坐标：尺寸都按 three.js 的写法（Y 向上，单位米），最后统一转成 Blender 的 Z 向上。
import json
import math
from contextlib import contextmanager
import fnmatch
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import random  # noqa: E402
from shared import BACK, MOON, OUT, ROOM, ROOT, TOP, VIEW, WIN, get_args, srgb, tree, clear_scene, use_metal  # noqa: E402
from room_vendor import Asset, clean_plastic, plain_material, screen_grid, world_points  # noqa: E402

# --skip-bake 1：几何没变、只改了热点 / 镜头时用，沿用现有的光照贴图
# --preview 目录：只搭几何，用 Workbench 从开场镜头拍几张图（几秒钟），摆位置的时候用，不烘焙也不导出
A = get_args(size=2048, samples=1024, out='', skip_bake=0, preview='')  # 1024 次采样：256 次时大面积的墙上会留下一团团的深浅（烘焙不降噪）
OUTD = A.out or OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()

# ---------- 坐标换算 ----------
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # three (x, y, z) → Blender (x, -z, y)


def M(pos=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return Matrix.LocRotScale(Vector(pos), Euler(rot, 'ZYX'), Vector(scale))  # three 的 Euler 'XYZ' = mathutils 'ZYX'


P = M(rot=(-math.pi / 2, 0, 0))  # 图元的 Z 轴 → three 的 Y 轴
I = Matrix.Identity(4)
G = M


def tb(v):
    return Vector((v[0], -v[2], v[1]))


# ---------- 几何：Room（烘焙）和 Glow（自发光，不烘焙）两个网格 ----------
class Mesh:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uvk = self.bm.faces.layers.int.new('uvk')  # lightmap 精度：10 = 正常，25 = 桌上的主角物件
        self.hot = self.bm.faces.layers.int.new('hot')  # 属于第几个热点盒子（0 = 不属于）
        self.mats = {}

    def mat(self, name, color):
        if name not in self.mats:
            self.mats[name] = (len(self.mats), color)
        return self.mats[name][0]

    def tag(self, faces, mi):
        for f in faces:
            f.material_index = mi
            f[self.uvk] = K
            f[self.hot] = HOT_ID


ROOMM, GLOWM = Mesh('Room'), Mesh('Glow')
K = 10
HOT_ID = 0
T = ROOMM  # 当前往哪个网格里加


def _faces(verts):
    return {f for v in verts for f in v.link_faces}


def box(g, w, h, d, mi, x=0, y=0, z=0, rot=(0, 0, 0)):
    r = bmesh.ops.create_cube(T.bm, size=1.0, matrix=C @ g @ M((x, y, z), rot, (w, h, d)))
    fs = _faces(r['verts'])
    T.tag(fs, mi)
    return fs


def quad(g, w, h, mi, pos, rot=(0, 0, 0)):
    m = C @ g @ M(pos, rot)
    vs = [T.bm.verts.new(m @ Vector((sx * w / 2, sy * h / 2, 0))) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    fs = [T.bm.faces.new(vs)]
    T.tag(fs, mi)
    return fs


def cyl(g, r_top, r_bot, h, segs, mi, pos, rot=(0, 0, 0), caps=True):
    r = bmesh.ops.create_cone(T.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r_bot, radius2=r_top,
                              depth=h, matrix=C @ g @ M(pos, rot) @ P)
    T.tag(_faces(r['verts']), mi)


def along(a, b):
    """把图元的 +Y 轴对准 a → b，返回 (中点矩阵, 长度)。"""
    a, b = Vector(a), Vector(b)
    d = b - a
    return Matrix.Translation((a + b) / 2) @ Vector((0, 1, 0)).rotation_difference(d.normalized()).to_matrix().to_4x4(), d.length


def rod(a, b, r, mi, segs=8, caps=True, r2=None):
    m, length = along(a, b)
    res = bmesh.ops.create_cone(T.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r, radius2=r if r2 is None else r2,
                                depth=length, matrix=C @ m @ P)
    T.tag(_faces(res['verts']), mi)


def ball(pos, r, mi, sub=1):
    res = bmesh.ops.create_icosphere(T.bm, subdivisions=sub, radius=r, matrix=C @ Matrix.Translation(Vector(pos)))
    T.tag(_faces(res['verts']), mi)


def world(g, p):
    return tuple(g @ Vector(p))


def solid(g, pts, faces, mi):
    """自己给顶点（g 里的本地坐标）和面（顶点编号）搭的封闭小块；面的朝向自动算成朝外。"""
    vs = [T.bm.verts.new(C @ g @ Vector(p)) for p in pts]
    fs = [T.bm.faces.new([vs[i] for i in f]) for f in faces]
    bmesh.ops.recalc_face_normals(T.bm, faces=fs)
    T.tag(fs, mi)
    return fs


def wedge(g, w, d, h0, h1, mi, pos=(0, 0, 0)):
    """前低后高的楔形块（电话机座）：底面 w × d，前沿（+z）高 h0，后沿高 h1。"""
    x, z = w / 2, d / 2
    pts = [(-x, 0, z), (x, 0, z), (-x, 0, -z), (x, 0, -z), (-x, h0, z), (x, h0, z), (-x, h1, -z), (x, h1, -z)]
    solid(g @ M(pos), pts, ((0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)), mi)


# ---------- 木纹（书桌）：程序生成的胡桃木拼板颜色贴图 + 按面朝向投影的 UV ----------
WOOD_U, WOOD_V, BOARDS = 1.24, 0.8, 3  # 一张图铺多大（米）：顺纹 × 横纹，正好一张桌面；横着三块板拼成


def _pnoise(rng, w, h, cx, cy):
    """值噪声：cx × cy 个格子铺满 w × h 像素（首尾相接）。"""
    lat = rng.random((cy, cx))
    x, y = np.arange(w) * cx / w, np.arange(h) * cy / h
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x1, y1 = (x0 + 1) % cx, (y0 + 1) % cy
    a, b, c, d = lat[np.ix_(y0, x0)], lat[np.ix_(y0, x1)], lat[np.ix_(y1, x0)], lat[np.ix_(y1, x1)]
    top, bot = a + (b - a) * fx[None, :], c + (d - c) * fx[None, :]
    return top + (bot - top) * fy[:, None]


def _fbm(rng, w, h, cx, cy, octaves=4):
    s, amp, tot = 0.0, 1.0, 0.0
    for o in range(octaves):
        s = s + amp * _pnoise(rng, w, h, cx << o, cy << o)
        tot += amp
        amp *= 0.5
    return s / tot


def _ss(a, b, t):
    t = np.clip((t - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def wood_image(name, size=1024, seed=7):
    """平切的胡桃木拼板（sRGB）：图宽 = 顺纹 WOOD_U 米，图高 = 横纹 WOOD_V 米，横着分 BOARDS 块板。
    每块板当成从原木上锯下来的：离树心的距离 d = sqrt((横向偏移)^2 + (锯口离树心的高度)^2)，
    锯口沿长度方向慢慢变高变低，年轮就在板面上画出一个个山形纹；再加顺纹的细丝、棕眼和板与板之间的拼缝。"""
    rng = np.random.default_rng(seed)
    W = H = size
    u = (np.arange(W) / W * WOOD_U)[None, :]
    v = (np.arange(H) / H * WOOD_V)[:, None]
    bw = WOOD_V / BOARDS
    k = np.minimum((v / bw).astype(int), BOARDS - 1)
    vl = v - k * bw
    warp = _fbm(rng, W, H, 3, 6, 4) - 0.5
    wob = _fbm(rng, W, H, 4, 3, 3) - 0.5
    d, tone_b = np.zeros((H, W)), np.zeros((H, 1))
    for b in range(BOARDS):
        c = bw * rng.uniform(0.3, 0.7) + rng.uniform(-0.04, 0.04) * (u - WOOD_U / 2) + wob * 0.01  # 树心在板上的横向位置
        s, q = rng.choice((-1, 1)) * rng.uniform(0.02, 0.045), rng.uniform(-0.05, 0.05)
        h = np.abs(rng.uniform(0.03, 0.07) + s * (u - WOOD_U / 2) + q * (u - WOOD_U / 2) ** 2)  # 锯口离树心多高
        m = k == b
        d = np.where(m, np.sqrt((vl - c) ** 2 + h ** 2), d)
        tone_b = np.where(m[:, :1], rng.uniform(-0.06, 0.06), tone_b)  # 每块板深浅略有不同
    spacing = 0.0055  # 年轮间距（米）
    grow = sum(a * np.sin(d / spacing * f + ph) for a, f, ph in  # 年轮有宽有窄
               zip(rng.uniform(0.25, 0.5, 3), rng.uniform(0.15, 0.45, 3), rng.uniform(0, 6.3, 3)))
    t = (d / spacing + grow + warp * 2.2) % 1.0
    late = _ss(0.55, 0.8, t) * (1 - _ss(0.84, 0.98, t))  # 晚材：深色的那道
    fiber = _fbm(rng, W, H, 6, 320, 3)  # 顺纹的细丝：顺纹方向拉得很长的噪声
    pores = _ss(0.62, 0.8, _pnoise(rng, W, H, 24, 700))  # 棕眼
    tone = _fbm(rng, W, H, 3, 4, 3) + tone_b
    light, dark, band = np.array([0.47, 0.3, 0.18]), np.array([0.36, 0.215, 0.12]), np.array([0.22, 0.115, 0.06])
    col = light + (dark - light) * np.clip(tone * 1.4 - 0.2, 0, 1)[..., None]
    col = col + (band - col) * (late * 0.65)[..., None]
    col = col * (0.88 + 0.18 * fiber)[..., None] * (1 - 0.25 * pores)[..., None]
    for j in range(1, BOARDS):  # 拼缝
        col = col * (1 - 0.45 * np.exp(-((v - j * bw) / 0.0007) ** 2))[..., None]
    px = np.ones((H, W, 4), dtype=np.float32)
    px[..., :3] = np.clip(col, 0, 1)
    img = bpy.data.images.new(name, W, H, alpha=False)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def wood_uv(faces, rnd):
    """木头面的颜色贴图 UV（UVMap，单位：一张图 = WOOD_U × WOOD_V 米）：按面朝向投影，顺纹取面上较长的方向。
    整块随机挪到图里的某处，不出图的边（贴图不是无缝的）；比一块板窄的面挪进某一块板里，不压着拼缝。"""
    uvl = T.bm.loops.layers.uv.get('UVMap') or T.bm.loops.layers.uv.new('UVMap')
    faces = list(faces)
    pts = {f: [Vector((l.vert.co.x, l.vert.co.z, -l.vert.co.y)) for l in f.loops] for f in faces}  # three 坐标
    axes = {}
    for f in faces:
        f.normal_update()
        n = Vector((abs(f.normal.x), abs(f.normal.z), abs(f.normal.y)))
        a, b = [i for i in range(3) if i != max(range(3), key=lambda i: n[i])]
        ext = lambda i: max(p[i] for p in pts[f]) - min(p[i] for p in pts[f])  # noqa: E731
        axes[f] = (a, b) if ext(a) >= ext(b) else (b, a)
    for f in faces:
        ua, va = axes[f]
        us, vs = [p[ua] for p in pts[f]], [p[va] for p in pts[f]]
        wu, wv = max(us) - min(us), max(vs) - min(vs)
        ou = rnd.uniform(0, max(WOOD_U - wu, 0)) - min(us)
        bw = WOOD_V / BOARDS
        if wv < bw - 0.01:
            ov = rnd.randrange(BOARDS) * bw + rnd.uniform(0.005, bw - wv - 0.005) - min(vs)
        else:
            ov = rnd.uniform(0, max(WOOD_V - wv, 0)) - min(vs)
        for l, p in zip(f.loops, pts[f]):
            l[uvl].uv = ((p[ua] + ou) / WOOD_U, (p[va] + ov) / WOOD_V)


def spline(pts, n=6):
    """Catmull-Rom：穿过 pts（three 世界坐标）的平滑曲线，每段 n 个点。"""
    P = [Vector(p) for p in pts]
    P = [P[0]] + P + [P[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for k in range(n):
            t = k / n
            out.append(0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t ** 3))
    out.append(P[-2])
    return out


def frames(path):
    """沿折线的切线 t 和两根法向 u、v（平行移动，不会突然拧一圈）。"""
    out, u = [], None
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        if u is None:
            u = t.cross(Vector((0, 1, 0)) if abs(t.y) < 0.9 else Vector((1, 0, 0))).normalized()
        u = (u - t * u.dot(t)).normalized()
        out.append((t, u, t.cross(u)))
    return out


def tube(path, r, mi, segs=6):
    """沿折线 path（three 世界坐标）扫一根细管（电线），两头不封口。"""
    path = [Vector(p) for p in path]
    rings = []
    for p, (t, u, v) in zip(path, frames(path)):
        rings.append([T.bm.verts.new(tb(p + (u * math.cos(a) + v * math.sin(a)) * r))
                      for a in (2 * math.pi * k / segs for k in range(segs))])
    fs = [T.bm.faces.new((a[k], a[(k + 1) % segs], b[(k + 1) % segs], b[k])) for a, b in zip(rings, rings[1:]) for k in range(segs)]
    T.tag(fs, mi)


def coil(path, R, r, pitch, mi):
    """电话的螺旋线：沿 path 绕半径 R 的螺旋（每圈前进 pitch），线粗 r。"""
    path = [Vector(p) for p in spline(path, 12)]
    pts, s = [], 0.0
    for i, (p, (t, u, v)) in enumerate(zip(path, frames(path))):
        if i:
            s += (p - path[i - 1]).length
        a = 2 * math.pi * s / pitch
        pts.append(p + (u * math.cos(a) + v * math.sin(a)) * R)
    dense = []  # 每圈至少 6 个点
    for a, b in zip(pts, pts[1:]):
        n = max(1, math.ceil((b - a).length / (2 * math.pi * R / 6)))
        dense.extend(a.lerp(b, k / n) for k in range(n))
    dense.append(pts[-1])
    tube(dense, r, mi, 4)


mat = lambda name, color: T.mat(name, color)  # noqa: E731

EMIT = {}  # Glow 网格的材质名 → 浏览器里的参数（属于哪层灯、颜色、亮度）


def emit(name, layer, color, power):
    EMIT[name] = dict(layer=layer, color=color, power=power)
    return mat(name, color)


@contextmanager
def glow():
    """这段里建的面放进 Glow 网格（自发光，不烘焙）。"""
    global T
    prev, T = T, GLOWM
    yield
    T = prev


# ---------- 热点：把一段代码新建的面框成一个盒子，浏览器拿来做点击拾取和悬停高亮 ----------
HOT = {}   # 名字 → [{c: 中心, h: 半尺寸, r: 绕 Y 轴的角度}]（three 坐标）
VIEWS = {}  # 名字 → 点进去以后镜头对准哪里：target 目标点、size 要装进画面的半宽半高、dir 从目标指向镜头的方向


HOT_BOXES = [None]  # 第 i 个盒子 = (热点名, 绕 Y 轴的角度)
HOT_PTS = {}        # 盒子编号 → 额外的点（第三方模型的顶点，three 坐标）


@contextmanager
def hot(name, rot=0.0):
    """这段代码里建的面（Room、Glow 都算）、摆的第三方模型属于热点 name 的一个盒子。盒子在几何建完以后统一算（hot_boxes）。"""
    global HOT_ID
    HOT_BOXES.append((name, rot))
    prev, HOT_ID = HOT_ID, len(HOT_BOXES) - 1
    yield
    HOT_ID = prev


def hot_boxes(pad=0.004):
    pts = {k: list(v) for k, v in HOT_PTS.items()}
    for m in (ROOMM, GLOWM):
        for f in m.bm.faces:
            if f[m.hot]:
                pts.setdefault(f[m.hot], []).extend((v.co.x, v.co.z, -v.co.y) for v in f.verts)  # Blender → three
    out = {}
    for i in range(1, len(HOT_BOXES)):
        name, rot = HOT_BOXES[i]
        cr, sr = math.cos(rot), math.sin(rot)
        lo, hi = [1e9] * 3, [-1e9] * 3
        for x, y, z in pts.get(i, []):
            q = (cr * x - sr * z, y, sr * x + cr * z)  # 转到盒子自己的坐标系
            for k in range(3):
                lo[k], hi[k] = min(lo[k], q[k]), max(hi[k], q[k])
        base_y = lo[1]
        lo = [a - pad for a in lo]
        hi = [b + pad for b in hi]
        for base in (TOP, 0.0):  # 放在桌面 / 地板上的东西：盒子底边抬高一点，别把桌面、地板也框进去
            if abs(base_y - base) < 0.003:
                lo[1] = base + 0.002
        c = [(a + b) / 2 for a, b in zip(lo, hi)]
        h = [(b - a) / 2 for a, b in zip(lo, hi)]
        cw = (cr * c[0] + sr * c[2], c[1], -sr * c[0] + cr * c[2])
        out.setdefault(name, []).append(dict(c=[round(v, 4) for v in cw], h=[round(v, 4) for v in h], r=round(rot, 4)))
    return out


# ---------- 第三方模型：导入、整理见 room_vendor.py；这里负责摆放、记热点、记用了哪些素材 ----------
PLACED = []  # (物件, lightmap 精度)
USED = []    # 素材 id（和 assets/vendor/credits.json 一样），写进 manifest.vendor
AABB = []    # (名字, lo, hi) 世界坐标，预览前查有没有叠在一起
CUTOUT = []  # 镂空的材质名（叶片），写进 manifest.cutout


def put(asset, at, uvk=10, hot_skip=(), **kw):
    """摆一个素材（参数见 Asset.place）。返回 (物件列表, T)，T：素材坐标 → 世界坐标（three）。
    hot_skip：这些零件（名字通配）不算进热点盒子，比如甩在外面的电话线：盒子框大了，悬停时会把空桌面也照亮成一块长方形"""
    obs, Tm = asset.place(at, **kw)
    PLACED.extend((ob, uvk) for ob in obs)
    pts = world_points(obs)
    if HOT_ID:
        keep = [ob for ob in obs if not any(fnmatch.fnmatch(ob.name.split(':', 1)[-1], p) for p in hot_skip)]
        HOT_PTS.setdefault(HOT_ID, []).extend(map(tuple, world_points(keep) if hot_skip else pts))
    lo, hi = pts.min(0), pts.max(0)
    AABB.append((asset.prefix, lo.copy(), hi.copy()))
    print(f'[put] {asset.prefix:10s} x {lo[0]:+.2f}..{hi[0]:+.2f}  y {lo[1]:.2f}..{hi[1]:.2f}  z {lo[2]:+.2f}..{hi[2]:+.2f}')
    if asset.source not in USED:
        USED.append(asset.source)
    CUTOUT.extend(m for m in asset.cutout if m not in CUTOUT)
    return obs, Tm


def screen_log(name, s):
    print(f"[{name}] 玻璃 {s['glass'][0]:.3f} × {s['glass'][1]:.3f}，画面 {s['size'][0]:.3f} × {s['size'][1]:.3f}，"
          f"中心到边最多往后 {s['sag'] * 1000:.0f} mm，法线 {tuple(round(v, 2) for v in s['normal'])}，没打中 {s['miss']} 个点")


def at3(Tm, p):
    """素材坐标里的一点 → 世界坐标（three）。"""
    return Tm @ Vector(tuple(p))


# ---------- 房间外壳：单面片，法线朝里（Cycles 里单面片也挡光） ----------
x0, x1, z1, RH = ROOM['x0'], ROOM['x1'], ROOM['z1'], ROOM['h']
W, Dp = x1 - x0, z1 - BACK
XC = (x0 + x1) / 2  # 房间左右的中线（左墙 -1.8、右墙 1.5，不在 x = 0）
wall = mat('wall', '#bdb3a0')
quad(I, W, Dp, mat('floor', '#6e4d34'), (XC, 0, (BACK + z1) / 2), (-math.pi / 2, 0, 0))
quad(I, Dp, RH, wall, (x0, RH / 2, (BACK + z1) / 2), (0, math.pi / 2, 0))
quad(I, Dp, RH, wall, (x1, RH / 2, (BACK + z1) / 2), (0, -math.pi / 2, 0))
K = 5  # 身后的墙几乎看不到，给少一点贴图
quad(I, W, RH, wall, (XC, RH / 2, z1), (0, math.pi, 0))
K = 10
wx0, wx1 = WIN['x'] - WIN['w'] / 2, WIN['x'] + WIN['w'] / 2
wy0, wy1 = WIN['y'] - WIN['h'] / 2, WIN['y'] + WIN['h'] / 2
dep = WIN['depth']
quad(I, wx0 - x0, RH, wall, ((x0 + wx0) / 2, RH / 2, BACK))
quad(I, x1 - wx1, RH, wall, ((x1 + wx1) / 2, RH / 2, BACK))
quad(I, WIN['w'], wy0, wall, (WIN['x'], wy0 / 2, BACK))
quad(I, WIN['w'], RH - wy1, wall, (WIN['x'], (wy1 + RH) / 2, BACK))
quad(I, dep, WIN['h'], wall, (wx0, WIN['y'], BACK - dep / 2), (0, math.pi / 2, 0))   # 窗洞内侧：和墙一样贴墙纸
quad(I, dep, WIN['h'], wall, (wx1, WIN['y'], BACK - dep / 2), (0, -math.pi / 2, 0))
quad(I, WIN['w'], dep, wall, (WIN['x'], wy1, BACK - dep / 2), (math.pi / 2, 0, 0))
sk = mat('skirting', '#3a2b20')
box(I, W, 0.09, 0.015, sk, XC, 0.045, BACK + 0.008)
box(I, 0.015, 0.09, Dp, sk, x0 + 0.008, 0.045, (BACK + z1) / 2)
box(I, 0.015, 0.09, Dp, sk, x1 - 0.008, 0.045, (BACK + z1) / 2)
# 天花板 + 一圈两层的石膏线（以前天花板只在烘焙时挡光、不导出，往上看或者竖屏时会看到黑的）
K = 6
quad(I, W, Dp, mat('ceiling', '#d8d2c6'), (XC, RH, (BACK + z1) / 2), (math.pi / 2, 0, 0))
cove = mat('cove', '#e4dfd4')
for h, d, y in ((0.10, 0.06, RH - 0.05), (0.035, 0.095, RH - 0.0175)):  # 下面一条窄而高，贴着天花板一条宽而薄
    box(I, W, h, d, cove, XC, y, BACK + d / 2)
    box(I, W, h, d, cove, XC, y, z1 - d / 2)
    box(I, d, h, Dp - 2 * d, cove, x0 + d / 2, y, (BACK + z1) / 2)
    box(I, d, h, Dp - 2 * d, cove, x1 - d / 2, y, (BACK + z1) / 2)
K = 10
# 波斯地毯：原作约 3 × 5.2 米，缩到约 1.35 × 2.35 米，长边沿 x（素材的长边沿 z，转 90°），铺在书桌前
RUG = Asset('sketchfab/persian-rug', 'rug', texsize=1024)
put(RUG, G((0.0, 0.002, -0.45), (0, math.pi / 2, 0)), uvk=8, scale=0.0045)

# 窗：一整扇白色的格子窗（Sketchfab「Window」，JeanLescano，CC BY），填满窗洞：从窗台一直到石膏线下面，没有把手。
# 素材是 SketchUp 做的：单位英寸、绕竖轴斜着转了 60.8°、方的（47.2 英寸见方）。这里先转正、换成米，再横竖分别拉到窗洞的大小。
# 玻璃换成淡灰蓝色的半透明玻璃（manifest.glass）：窗外的夜景隔着一层玻璃，不那么扎眼；烘焙时这层玻璃完全透光，
# 城市的光、月光照常进屋。窗台是一块浅色石板（比桌面高一点），上面摆着小盆栽和书
K = 12
WINDOW = Asset('sketchfab/classic-window', 'window', texsize=512)
win_glass = plain_material('window_glass', '#9fb0b8')
_wb = next(n for n in win_glass.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
_wb.inputs['Alpha'].default_value = 0.0                                      # 烘焙时透光
WIN_SIDE = 47.17 * 0.0254                                                    # 素材转正以后一边多长（米，量出来的）
_wh = WIN['h'] - 0.03                                                        # 窗台石板上面那一截
at = G((WIN['x'], wy0 + 0.03 + _wh / 2, BACK - dep + 0.06)) @ Matrix.Diagonal((WIN['w'] / WIN_SIDE, _wh / WIN_SIDE, 1.0, 1.0)) @ M(rot=(0, 1.061, 0))
win_obs, _ = put(WINDOW, at, uvk=12, scale=0.0254, anchor=(0.5, 0.5, 0.5))
for ob in win_obs:                                                           # 素材的玻璃材质换成我们的
    for k_, m_ in enumerate(ob.data.materials):
        if m_ and m_.name == WINDOW.mat.get('Glass_Crystal'):
            ob.data.materials[k_] = win_glass
box(I, WIN['w'] + 0.1, 0.03, dep + 0.05, mat('sill', '#d6d0c4'), WIN['x'], wy0 + 0.015, BACK - dep / 2 + 0.025)
K = 10
SILL = wy0 + 0.03
# 窗台上的小东西：左边一小盆十二卷（白瓷盆的多肉），右边两本书、一盆虎尾兰（扫描模型，带盆）
HAW = Asset('polyhaven/potted_plant_04', 'haworthia', texsize=512, decimate={'*': 0.3})
put(HAW, G((WIN['x'] - 0.32, SILL, BACK - 0.045), (0, 0.6, 0)), uvk=12, height=0.15)
g = G((WIN['x'] + 0.6, SILL, BACK - 0.035), (0, 0.1, 0))
# 两本书只有两三厘米厚：lightmap 精度给足。图集里的岛一多（加了电话以后），K=10 的书侧面缩到落不进一个像素中心，烘出来是黑的
K = 30
box(g, 0.2, 0.03, 0.1, mat('book_a', '#3b5a7a'), 0, 0.015, 0)
box(g, 0.18, 0.025, 0.09, mat('book_b', '#8a3b30'), 0.01, 0.0425, 0, (0, 0.12, 0))
K = 10
SNAKE = Asset('sketchfab/snake-plant-scan-lowpoly', 'snake', texsize=512)
put(SNAKE, G((WIN['x'] + 0.36, SILL, BACK - 0.06), (0, 0.4, 0)), uvk=12, height=0.4)

# 窗右边一幅拉开、收成一束的窗帘（土黄色的布，褶子越往下越松），挂在窗上方的黄铜杆上；从窗边收到右墙
CUR_Y, CUR_Z = RH - 0.14, BACK + 0.075   # 杆子挂在石膏线下面、窗顶前面
brass = mat('brass', '#b8945a')
rod((wx0 - 0.07, CUR_Y, CUR_Z), (x1 - 0.025, CUR_Y, CUR_Z), 0.011, brass, 12)
ball((wx0 - 0.085, CUR_Y, CUR_Z), 0.02, brass, 1)
for bx in (wx0 - 0.02, x1 - 0.11):
    box(I, 0.014, 0.03, CUR_Z - BACK, brass, bx, CUR_Y, (BACK + CUR_Z) / 2)
cm = mat('curtain', '#a8823f')
NX, NY, PLEATS = 72, 12, 6  # 一个褶子 12 个面：褶子是圆的，不是一块块平板
CURTAIN_UVK = 20             # 窗帘正面的 lightmap 精度：一格 1.5 厘米左右，褶子的明暗烘得出来（正面按网格整块展开，见下面 Lightmap 那段）
# t（0 = 顶，1 = 底）→ 左沿、右沿。靠窗那条边往下稍微往窗里收，靠墙那条边稍微往外散
SIDES = [lambda t: (wx1 - 0.03 - 0.025 * t, x1 - 0.035 + 0.01 * t)]
for side, back in [(sd, bk) for sd in SIDES for bk in (False, True)]:  # 正面带褶子；后面一层平的衬布（侧面看过去褶子的缝里不会露出墙）
    K = 4 if back else CURTAIN_UVK
    grid = []
    for j in range(NY + 1):
        t = j / NY
        xa, xb = side(t)
        amp = 0.02 + 0.012 * t
        row = []
        for i in range(NX + 1):
            s = i / NX
            z = CUR_Z - amp - 0.004 if back else CUR_Z + amp * math.sin(2 * math.pi * PLEATS * s + math.pi / 2)
            row.append(T.bm.verts.new(tb((xa + (xb - xa) * s, CUR_Y - 0.01 - t * (CUR_Y - 0.025), z))))
        grid.append(row)
    T.tag([T.bm.faces.new((grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1])) for j in range(NY) for i in range(NX)], cm)
K = 10

# ---------- 书桌：窗下；左头和窗台石板的左头齐平，右头和电脑都没动，电脑正对窗户中间 ----------
# 厚重的实木书桌（胡桃木拼板，木纹是颜色贴图）：5.5 厘米厚的桌面，前沿上下各倒一个角；右边三抽的抽屉柜，
# 抽屉面板凸出柜体、中间再起一块线脚，黄铜拉手；左边一整块侧板；腿下的空当后面有挡板，前面一条横档带个扁抽屉
K = 25
DESK_X = WIN['x']                  # 电脑的中线（正对窗户中间）；桌上的东西都按它摆
DESK_RX = DESK_X + 0.62            # 桌子右头（不动）
DESK_LX = WIN['x'] - (WIN['w'] + 0.1) / 2   # 左头 = 窗台石板左头
DESK_W, DESK_D, DESK_T = DESK_RX - DESK_LX, 0.8, 0.055
DESK_Z = BACK + 0.43               # 桌面中线；后沿 = DESK_Z - 深/2，前沿 = DESK_Z + 深/2
g = G(((DESK_LX + DESK_RX) / 2, 0, DESK_Z))
wood, brass = mat('desk', '#6a4428'), mat('brass', '#b8945a')
rnd_w = random.Random(11)
dx, dz, ch, yb = DESK_W / 2, DESK_D / 2, 0.008, TOP - DESK_T  # 半宽、半深、倒角、桌面底
prof = [(-dz, yb), (dz - ch, yb), (dz, yb + ch), (dz, TOP - ch), (dz - ch, TOP), (-dz, TOP)]  # 桌面截面（z, y），沿 x 拉伸
np_ = len(prof)
wood_uv(solid(g, [(sx * dx, py, pz) for sx in (-1, 1) for pz, py in prof],
              [list(range(np_)), list(range(2 * np_ - 1, np_ - 1, -1))] + [(i, (i + 1) % np_, np_ + (i + 1) % np_, np_ + i) for i in range(np_)],
              wood), rnd_w)


def wbox(w, h, d, x, y, z, mi=None):
    wood_uv(box(g, w, h, d, wood if mi is None else mi, x, y, z), rnd_w)


def pull(x, y, z, half=0.04):
    """黄铜拉手：一块小底板、两根柱、一根横杆（z = 抽屉面板的前表面）。"""
    box(g, 2 * half + 0.035, 0.026, 0.003, brass, x, y, z + 0.0015)
    for sx in (-1, 1):
        rod(world(g, (x + sx * half, y, z + 0.003)), world(g, (x + sx * half, y, z + 0.022)), 0.0035, brass, 6)
    rod(world(g, (x - half - 0.008, y, z + 0.022)), world(g, (x + half + 0.008, y, z + 0.022)), 0.005, brass, 8)


DRAW_X, PW, PD, PZ = dx - 0.21, 0.38, 0.72, -0.02  # 抽屉柜：中心 x、宽、深、中心 z（前面比桌面缩进 4 厘米）
PL, GAP = 0.07, 0.006                             # 踢脚高、抽屉之间的缝
pf = PZ + PD / 2                                  # 柜体前表面
wbox(PW, yb - PL, PD, DRAW_X, PL + (yb - PL) / 2, PZ)
box(g, PW - 0.03, PL, PD - 0.03, mat('desk_dark', '#2a1a10'), DRAW_X, PL / 2, PZ - 0.015)  # 往里缩的踢脚
hs = [0.17, 0.2]
hs.append(yb - PL - 4 * GAP - sum(hs))  # 最下面是放文件的深抽屉
y = yb - GAP
for h in hs:
    yc = y - h / 2
    wbox(PW - 2 * GAP, h, 0.02, DRAW_X, yc, pf + 0.01)                 # 抽屉面板
    wbox(PW - 2 * GAP - 0.05, h - 0.05, 0.006, DRAW_X, yc, pf + 0.023)  # 线脚
    pull(DRAW_X, yc + h / 2 - 0.045, pf + 0.026)
    y -= h + GAP
K = 12  # 桌下的板子在暗处，lightmap 给少一点
SW = 0.045
xl, xr = -dx + 0.02 + SW, DRAW_X - PW / 2  # 腿下空当的左右
wbox(SW, yb, PD, xl - SW / 2, yb / 2, PZ)                       # 左侧板
wbox(xr - xl, 0.42, 0.018, (xl + xr) / 2, yb - 0.21, -dz + 0.06)  # 后挡板
K = 25
wbox(xr - xl, 0.075, 0.02, (xl + xr) / 2, yb - 0.0375, pf - 0.01)  # 前横档
wbox(0.44, 0.052, 0.012, (xl + xr) / 2, yb - 0.0375, pf + 0.006)  # 扁抽屉
pull((xl + xr) / 2, yb - 0.0375, pf + 0.012, half=0.03)
DESK_BACK, DESK_FRONT = DESK_Z - DESK_D / 2, DESK_Z + DESK_D / 2
print(f'[desk] 左头 {DESK_LX:+.3f} 右头 {DESK_RX:+.3f} 宽 {DESK_W:.3f} 后沿 {DESK_BACK:+.3f} 前沿 {DESK_FRONT:+.3f}')
# 侧板、后挡板、前横档、扁抽屉都按 dx = DESK_W/2 从右头往左排，桌子加长以后跟着左头走

# 电脑：米色的老式台式机，显示器压在卧式主机上，软驱里插着一张软盘，显示器侧面贴着便利贴（素材自带的）。
# 素材是真实尺寸（米），正面朝 +x，转 -90° 朝屋里；子物件按父节点认：PC（机身 + 鼠标 + 鼠标线）、NOTAS（便利贴）、CD（软盘）、HOJAS（长出来的草叶，不要）。
# 屏幕是方的、四角只有一点圆角，玻璃换成深色，浏览器在上面贴一块按玻璃弧度弯过的 canvas（弧度在这里量好写进 manifest）。
# 鼠标原来在主机正前方（正好是键盘的位置），拆出来放到键盘右边；原来绕到机箱后面的鼠标线删掉，下面重新拉一根。
# 素材的污渍画得很重（废土风），洗成干净的米色（便利贴留着）；颜色贴图给 2048，点进"关于我"的时候边框就在眼前。
PC_S = 1.1  # 素材本身是真实尺寸（显示器宽 43 厘米、连主机高 52 厘米）；电脑是书桌的主角，放大一成
PC = Asset('sketchfab/old-pc', 'pc', texsize=2048, by_parent=True, drop=('HOJAS',))
clean_plastic(PC.image('PRINCIPAL'))                    # 米色外壳洗干净：污渍、画上去的脏阴影都去掉，散热孔、缝线留着（便利贴在另一张贴图上，不动）
pc_glass = plain_material('pc_glass', '#0c0f0e')
PC.islands('PC', (0.17, 0.22, -0.18), (0.21, 0.5, 0.18), material=pc_glass, test=lambda a, b: (b - a)[1] > 0.2)  # 玻璃（框里还有两条窄边，按高度分开）
PC.islands('PC', (-0.33, 0.005, -0.18), (0.3, 0.11, 0.31), delete=True, test=lambda a, b: a[0] < -0.3)  # 鼠标线：从机箱后面一直绕到鼠标
PC.islands('PC', (0.245, 0.005, -0.03), (0.375, 0.065, 0.155), into='MOUSE')
# 边框正面的两张便利贴（E=mc² 和笑脸）有一半盖在玻璃上，会挡住终端的第一行；上边框只有 4 厘米宽，挪上去会探出显示器顶上、一半陷进圆角里：删掉，
# 只留显示器左侧面的两张（爱心、月亮）
PC.islands('NOTAS', (0.19, 0.44, 0.0), (0.24, 0.52, 0.17), delete=True)
lo, hi = PC.bounds(['PC', 'NOTAS', 'CD'])
PC_BACK = BACK + 0.05  # 机箱后沿离墙 5 厘米（桌子后沿在墙前 3 厘米）
with hot('about'):
    pc_obs, T_pc = put(PC, G((DESK_X, TOP, PC_BACK + PC_S * (hi[0] - lo[0]) / 2), (0, -math.pi / 2, 0)),
                       pieces=['PC', 'NOTAS', 'CD'], uvk=25, scale=PC_S)
PC_SCREEN = screen_grid(pc_obs, pc_glass, frac=0.92)  # 玻璃是方的，只有四角一点圆角：画面占玻璃宽度的 92%
screen_log('pc', PC_SCREEN)
# 玻璃往后仰：镜头顺着玻璃的法线再稍微高一点看；装进画面的范围跟着屏幕大小走：按字的区域凑近，边框只露出窄窄一圈
VIEWS['about'] = dict(target=PC_SCREEN['pos'], size=(PC_SCREEN['size'][0] * 0.62, PC_SCREEN['size'][1] * 0.68),
                      dir=tuple(Vector(PC_SCREEN['normal']) + Vector((0, 0.08, 0))))
pc_pts = world_points(pc_obs)
PC_L, PC_R = pc_pts[:, 0].min(), pc_pts[:, 0].max()                          # 电脑左右（含侧面的便利贴）
PC_FRONT = at3(T_pc, (0.197, 0, 0)).z                                         # 机箱前面板
PC_DEPTH = at3(T_pc, (0.197, 0, 0)).z - at3(T_pc, (lo[0], 0, 0)).z


def keyboard(g, u=0.0185):
    """米色的老式键盘：前低后高的底壳，上面六排键帽（功能键一排 + 主键区五排），右边方向键区和小键盘。
    g 的原点 = 键盘底面中心，+z 朝前（朝人）。u = 一个键位的宽度。返回 (宽, 深)。"""
    rows = [  # 主键区每排：(宽度, 'a' 字母键 / 'm' 功能键)，宽度为负 = 空位
        [(1, 'm'), (-1, ''), *[(1, 'm')] * 4, (-0.5, ''), *[(1, 'm')] * 4, (-0.5, ''), *[(1, 'm')] * 4],
        [*[(1, 'a')] * 13, (2, 'm')],
        [(1.5, 'm'), *[(1, 'a')] * 12, (1.5, 'm')],
        [(1.75, 'm'), *[(1, 'a')] * 11, (2.25, 'm')],
        [(2.25, 'm'), *[(1, 'a')] * 10, (2.75, 'm')],
        [(1.5, 'm'), (-1, ''), (1.5, 'm'), (7, 'a'), (1.5, 'm'), (-1, ''), (1.5, 'm')],
    ]
    nav = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [], [-1, 1, -1], [1, 1, 1]]  # 方向键区（3 键宽）
    # 小键盘（4 键宽）：(列, 排, 宽, 高, 类型)；第 0 排的位置是三个指示灯
    pad = [(c, 1, 1, 1, 'm') for c in range(4)] + [(c, r, 1, 1, 'a') for r in (2, 3, 4) for c in range(3)]
    pad += [(3, 2, 1, 2, 'm'), (3, 4, 1, 2, 'm'), (0, 5, 2, 1, 'a'), (2, 5, 1, 1, 'a')]
    W, D = 23 * u + 0.024, 6.5 * u + 0.046
    h0, h1 = 0.02, 0.036  # 前沿、后沿的高
    sl = math.atan2(h1 - h0, D)
    ytop = lambda z: h0 + (D / 2 - z) / D * (h1 - h0)  # noqa: E731
    wedge(g, W, D, h0, h1, mat('kb_case', '#c7bd9e'))
    mi = {'a': mat('kb_key', '#dad1b8'), 'm': mat('kb_mod', '#a49b85')}
    x0, z0 = -W / 2 + 0.012, -D / 2 + 0.028  # 键区左上角（后沿留宽一点）
    zr = lambda r, n=1: z0 + (r + (0.5 if r else 0) + n / 2) * u  # noqa: E731  第 r 排（往前）n 排高的键的中心

    def key(x, r, w, n, kind):
        z = zr(r, n)
        box(g, w * u - 0.0035, 0.009, n * u - 0.0035, mi[kind], x0 + x * u + w * u / 2, ytop(z) + 0.0025, z, (sl, 0, 0))

    for r, row in enumerate(rows):
        x = 0
        for w, kind in row:
            if w > 0:
                key(x, r, w, 1, kind)
            x += abs(w)
        x = 15.5
        for w in nav[r]:
            if w > 0:
                key(x, r, w, 1, 'm')
            x += abs(w)
    for c, r, w, n, kind in pad:
        key(19 + c, r, w, n, kind)
    for i in range(3):  # 指示灯
        z = zr(0)
        box(g, 0.006, 0.002, 0.004, mat('kb_led', '#3c5a3a'), x0 + (19.6 + i * 1.2) * u, ytop(z) + 0.001, z, (sl, 0, 0))
    return W, D


# 键盘：在显示器正前方，稍微斜一点；鼠标在右边；两根线都从桌面上绕到主机后面
KB_ROT = 0          # 摆正，正对开场镜头
KB_Z = PC_FRONT + 0.155  # 往前 2 厘米：软盘探出机箱前面，键盘后沿不再插进去
g = G((DESK_X - 0.015, TOP, KB_Z), (0, KB_ROT, 0))
with hot('about', KB_ROT):
    KB_W, KB_D = keyboard(g)
cable = mat('pc_cable', '#b9b2a2')
lie = TOP + 0.004  # 线躺在桌面上时的中心高度（压在打印纸上面）
tube(spline([world(g, (-0.13, 0.03, -KB_D / 2 + 0.004)), world(g, (-0.135, 0.006, -KB_D / 2 - 0.03)),
             (PC_L - 0.015, lie, PC_FRONT + 0.02), (PC_L - 0.02, lie, PC_FRONT - 0.15), (PC_L - 0.012, lie, PC_BACK + 0.03),
             (PC_L + 0.06, TOP + 0.03, PC_BACK + 0.02)], 5), 0.0028, cable)
MOUSE_ROT = math.pi + 0.08  # 素材里鼠标线从 +z 那头（按键那头）出来：转 180° 让它朝屏幕，再往左斜一点（右手拿着的样子）
with hot('about', MOUSE_ROT):
    _, T_mouse = put(PC, G((DESK_X + KB_W / 2 + 0.06, TOP, KB_Z + 0.01), (0, MOUSE_ROT, 0)), pieces=['MOUSE'], uvk=25, scale=0.75)
plug = at3(T_mouse, (0.29, 0.016, 0.152))
back = (at3(T_mouse, (0.29, 0.016, 0.3)) - plug).normalized()
tube(spline([tuple(plug), tuple(plug + back * 0.03 + Vector((0, lie - plug.y, 0))),
             (PC_R + 0.02, lie, PC_FRONT + 0.04), (PC_R + 0.014, lie, PC_FRONT - 0.12), (PC_R + 0.01, lie, PC_BACK + 0.03),
             (PC_R - 0.06, TOP + 0.03, PC_BACK + 0.02)], 5), 0.0024, cable)
print(f'[pc] 电脑 x {PC_L:+.3f}..{PC_R:+.3f}，机箱前面 z {PC_FRONT:+.3f}，深 {PC_DEPTH:.3f}；键盘 {KB_W:.3f} × {KB_D:.3f}，中心 z {KB_Z:+.3f}')


def flat_aabb(name, x, z, w, d, yaw, y0, y1):
    """平放的盒子（绕 Y 轴 yaw）的世界包围盒，记下来和 [put] 一起查有没有叠住。"""
    cs, sn = math.cos(yaw), math.sin(yaw)
    xs, zs = [], []
    for sx in (-w / 2, w / 2):
        for sz in (-d / 2, d / 2):
            xs.append(x + cs * sx + sn * sz)
            zs.append(z - sn * sx + cs * sz)
    AABB.append((name, np.array((min(xs), y0, min(zs))), np.array((max(xs), y1, max(zs)))))


flat_aabb('kb', DESK_X - 0.015, KB_Z, KB_W, KB_D, KB_ROT, TOP, TOP + 0.05)
AABB.append(('wing', np.array((DESK_LX, 0.0, DESK_BACK)), np.array((DESK_RX - 1.50, TOP, DESK_FRONT))))  # 新加的左翼：旧左头在右头往左 1.50 米

# 开场镜头：绕着电脑转（orbit）。镜头站在电脑正前方、略微俯视，目标点在屏幕中心正上方一点：电脑在画面正中，窗户框着它；
# 右边的电视露出一半（斜着朝向镜头，看得到彩条），往右拖就整个出来；
# 视角 34°，抬头最多到平视以上一点点（看不到天花板）；左右能转 50° 上下，转到头能看到侧墙靠里的一段（书架正面、唱机、软木板）。
# box：镜头不能出这个范围（x 左右、z 最靠前、y 最低 / 最高），转到边上时自动拉近，免得钻进墙里；
# 左边界留出左墙书柜的深度（0.63 米）再多 12 厘米，往右转看唱机时镜头不会退进书柜里
CAM = dict(target=tuple(Vector(PC_SCREEN['pos']) + Vector((0, 0.08, -0.1))), dist=2.25, yaw=0.0, pitch=-0.12, fov=34,
           yawRange=(-1.0, 1.3), pitchRange=(-0.6, 0.06), distRange=(1.1, 2.4),
           box=dict(x=(x0 + 0.75, x1 - 0.25), z=z1 - 0.25, y=(0.45, RH - 0.3)))

# 按人的习惯只留这一套：台灯夹在左后角；靠窗那一排是看的东西，正面朝开场镜头；
# 手边是用的东西；音乐的东西挨着电脑左边。新加长的左边那一截，前半留空，当写字的地方。
LAMP_CLAMP_AT = (DESK_LX + 0.07, TOP - DESK_T / 2, DESK_BACK)  # 夹子咬住后沿，离左头 7 厘米
# 灯头离桌面 52 厘米、对着那摞纸和键盘之间：光铺满左半张桌子（开关一眼看得出），纸不在光斑正中心。
# 低到 38 厘米、正对着纸时，光只照亮一张纸：亮了就过曝，暗了开关又看不出区别
LAMP_HEAD_AT = (DESK_X - 0.66, TOP + 0.52, -1.58)             # 灯头中心
LAMP_AIM_AT = (DESK_X - 0.40, TOP, -1.40)                     # 灯罩口对着那摞纸右边、键盘左边
NOTE_X, NOTE_Z, NOTE_ROT = DESK_X + 0.44, -1.32, -0.06        # 记事本在键盘右边
MUG_AT = (DESK_X + 0.31, -1.58)
CAL_X, CAL_Z, DCAL_YAW = DESK_X - 0.84, -1.84, 0.30           # 万年历在台灯右边，字朝开场镜头

# 摇臂灯。发布的 glTF 是大约 88 厘米的静止姿势，没有骨骼；绑定在同一份素材的 blend 里。
# 灯夹夹在桌子左后角的后沿，灯头和灯罩口按上面的坐标去够。姿势改的是控制骨，取网格时把骨骼应用到顶点上。
LAMP_FIT = {}


def pose_desk_lamp(objects):
    """拧开钳口，再调灯臂和灯头，让灯泡落在目标、灯罩口朝向桌面上的那一点。"""
    arm = next(o for o in objects if o.type == 'ARMATURE')
    ctrl = arm.pose.bones['ctrl_top-position']
    pivot = arm.pose.bones['ctrl_lamp_base_pivot']
    rot_a = arm.pose.bones['ctrl_top_rotation_A']
    rot_b = arm.pose.bones['ctrl_top_rotation_B']
    holder = arm.pose.bones['ctrl_pivot-holder']
    holder.location.y = -0.015  # 下钳口下降约 1.5 厘米，开口接近桌面厚度
    pivot.rotation_mode = 'XYZ'
    rot_a.rotation_mode = 'XYZ'
    rot_b.rotation_mode = 'XYZ'
    state = dict(yaw=1.53, lx=-0.27, ly=0.29, bz=0.30, ay=0.42)

    def apply():
        pivot.rotation_euler = (0.0, state['yaw'], 0.0)
        ctrl.location.x = state['lx']
        ctrl.location.y = state['ly']
        rot_b.rotation_euler.z = state['bz']
        rot_a.rotation_euler.y = state['ay']
        bpy.context.view_layer.update()
        return bpy.context.evaluated_depsgraph_get()

    def sample(dg):
        o = bpy.data.objects['geo_lamp-head']
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        mi = next(i for i, m in enumerate(me.materials) if m and 'light' in m.name)
        bulb, nb = Vector(), 0
        lo_b, hi_b = Vector((1e9, 1e9, 1e9)), Vector((-1e9, -1e9, -1e9))
        shade = []
        for p in me.polygons:
            vs = [ev.matrix_world @ me.vertices[i].co for i in p.vertices]
            if p.material_index == mi:
                for v in vs:
                    bulb += v
                    nb += 1
                    lo_b = Vector((min(lo_b.x, v.x), min(lo_b.y, v.y), min(lo_b.z, v.z)))
                    hi_b = Vector((max(hi_b.x, v.x), max(hi_b.y, v.y), max(hi_b.z, v.z)))
            else:
                shade.extend(vs)
        ev.to_mesh_clear()
        bulb /= nb
        holder_ob = bpy.data.objects['geo_pivot-holder'].evaluated_get(dg)
        hme = holder_ob.to_mesh()
        z_lo = max((holder_ob.matrix_world @ v.co).z for v in hme.vertices)
        holder_ob.to_mesh_clear()
        attach = np.array(arm.matrix_world @ arm.pose.bones['def_lamp_head'].head)
        arr = np.array([(v.x, v.y, v.z) for v in shade])
        dist = np.linalg.norm(arr - attach, axis=1)
        rim = arr[dist >= np.quantile(dist, 0.9)].mean(0)
        direction = Vector(tuple(rim)) - bulb
        direction.normalize()
        radius = float(max(hi_b[i] - lo_b[i] for i in range(3))) / 2
        return bulb, direction, radius, z_lo

    dg = apply()
    _, _, _, z_lo = sample(dg)
    anchor = Vector((0.0, 0.0, z_lo + DESK_T / 2))  # 钳口高度的中点，对着桌面板中心
    # 臂长不够时，沿「夹子 → 灯头」收回来，最多 10 厘米。收回的是这份目标，罩口仍对着简历。
    goal = Vector(LAMP_HEAD_AT)
    aim_w = Vector(LAMP_AIM_AT)
    clamp_w = Vector(LAMP_CLAMP_AT)
    box = dict(pull=0.0, target=None, want=None, head=goal)
    state0 = dict(state)

    def retarget():
        along = goal - clamp_w
        box['head'] = goal if box['pull'] <= 0 else goal - along.normalized() * box['pull']
        delta = box['head'] - clamp_w
        box['target'] = anchor + Vector((delta.x, -delta.z, delta.y))  # three → Blender
        want = (aim_w - box['head']).normalized()
        box['want'] = Vector((want.x, -want.z, want.y)).normalized()

    retarget()

    def pos_err():
        bulb, _, _, _ = sample(apply())
        return (bulb - box['target']).length

    def aim_err():
        _, direction, _, _ = sample(apply())
        return (direction - box['want']).length

    def descend(keys, steps, err_fn):
        best = err_fn()
        for step in steps:
            improved, guard = True, 0
            while improved and guard < 24:
                guard += 1
                improved = False
                for key in keys:
                    for sgn in (1, -1):
                        state[key] += sgn * step
                        e = err_fn()
                        if e + 1e-4 < best:
                            best = e
                            improved = True
                            break
                        state[key] -= sgn * step
                    if improved:
                        break
        return best

    pe = 1.0
    for attempt in range(4):  # 转灯头会把灯泡带偏，所以位置和朝向交替收；够不到再把目标收回来重来
        if attempt:
            state.update(state0)
        for i in range(3):
            pe = descend(('yaw', 'lx', 'ly'), (0.08, 0.03) if i == 0 else (0.04, 0.015), pos_err)
            ae = descend(('bz', 'ay'), (0.25, 0.08), aim_err)
            print(f'[lamp] 第 {attempt + 1} 遍第 {i + 1} 轮 位置 {pe * 100:.1f} cm，朝向 {ae:.3f}，收回 {box["pull"] * 100:.1f} cm')
        if pe <= 0.02 or box['pull'] >= 0.10 - 1e-6:
            break
        box['pull'] = min(0.10, box['pull'] + float(pe))
        retarget()
        print(f'[lamp] 灯头够不到，沿夹子到灯头收回 {box["pull"] * 100:.1f} cm')
    bulb, direction, radius, z_lo = sample(apply())
    LAMP_FIT.update(anchor=anchor, bulb=bulb, direction=direction, radius=radius, target=box['target'], want=box['want'],
                    z_lo=z_lo, head_w=Vector(box['head']), pull=box['pull'])
    print(f'[lamp] 姿势：yaw {state["yaw"]:+.2f} 臂 {state["lx"]:+.2f},{state["ly"]:+.2f} 头 {state["bz"]:+.2f},{state["ay"]:+.2f}')


LAMP_BLEND = os.path.join(ROOT, 'vendor-src', 'polyhaven', 'desk_lamp_arm_01', 'desk_lamp_arm_01_1k.blend')
LAMP = Asset('polyhaven/desk_lamp_arm_01', 'lamp', texsize=512, blend=LAMP_BLEND, pose=pose_desk_lamp,
             keep=('geo_*',), drop_mats=('*light*',))
_anc = LAMP_FIT['anchor']
_anc_t = Vector((_anc.x, _anc.z, -_anc.y))
_lo, _hi = LAMP.bounds()
_frac = tuple((float(_anc_t[i]) - float(_lo[i])) / float(_hi[i] - _lo[i]) for i in range(3))
lamp_obs, T_lamp = put(LAMP, G(LAMP_CLAMP_AT), uvk=25, anchor=tuple(_frac), scale=1.0)
# 热点只框灯头（灯罩附近 14 厘米以内的顶点）：整盏灯从左后角斜伸到桌子中间，框整盏灯的盒子会把日历、随身听、
# 桌面和墙都框进去，鼠标一放上去左后角一大片一起亮
with hot('lamp'):
    _bb = LAMP_FIT['bulb']
    LAMP_HEAD = at3(T_lamp, (_bb.x, _bb.z, -_bb.y))
    _db = LAMP_FIT['direction']
    LAMP_DIR = Vector((_db.x, _db.z, -_db.y))
    _aim = Vector(LAMP_AIM_AT)
    if LAMP_DIR.dot(_aim - LAMP_HEAD) < 0:
        LAMP_DIR = -LAMP_DIR
    LAMP_DIR = LAMP_DIR.normalized()
    # 发光的灯泡留在灯泡原位、35 毫米，整个藏在灯罩里。试过的两种都会穿模：48 毫米时从灯罩细的那头侧面穿出来
    # （开场画面里一整团光晕、一条横穿窗户的光带）；顺着光的方向往灯罩口挪 5 厘米时从灯罩壁上穿出来
    # （开灯一个亮斑、关灯一个黑斑）。开灯关灯的区别靠桌上那一大圈光
    r_bulb = min(LAMP_FIT['radius'], 0.035)
    with glow():
        ball(tuple(LAMP_HEAD), r_bulb, emit('emit.lamp.bulb', 'lamp', '#ffe2b8', 4.0), 2)
    _lp = world_points(lamp_obs)
    _head = _lp[np.linalg.norm(_lp - np.array(tuple(LAMP_HEAD)), axis=1) < 0.14]
    HOT_PTS.setdefault(HOT_ID, []).extend(map(tuple, _head))
_want = LAMP_FIT['head_w']
print(f'[lamp] 灯泡 {tuple(round(v, 3) for v in LAMP_HEAD)}，目标 {tuple(round(v, 3) for v in _want)}，'
      f'偏差 {(LAMP_HEAD - _want).length * 100:.1f} cm，半径 {r_bulb * 1000:.0f} mm')
# 电线从夹子沿桌子后沿落到墙根，不放进热点（不然点击盒子会一直拖到地板）
wire = mat('wire', '#1c1a18')
_cx = LAMP_CLAMP_AT[0]
tube(spline([(_cx, TOP - DESK_T / 2, DESK_BACK + 0.004), (_cx - 0.03, TOP - 0.02, DESK_BACK),
             (_cx - 0.04, TOP - 0.06, BACK + 0.014), (_cx - 0.02, 0.04, BACK + 0.012),
             (_cx + 0.08, 0.004, BACK + 0.016)], 5), 0.0025, wire)

# 书柜上的旧磁带还用这份（外壳半透明的 02a 丢掉）。书桌上的那几摞换成下面的新素材。
CASS = Asset('sketchfab/cassette-tapes', 'cassette', texsize=512, drop=('*02a*',), decimate={'*': 0.3})


def _mesh_co(me):
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def _tape_groups(asset):
    """三盘带子。名字里的 .001 / .002 是第二、第三盘。"""
    groups = [[], [], []]
    for name in asset.pieces:
        groups[2 if '.002' in name else 1 if '.001' in name else 0].append(name)
    return groups


def _orient_tapes(asset, names, mode):
    """绕外壳中心把一盘转正，零件跟着走。返回 (变换, 长边长度)。
    stand：长边横着、短边竖着，标签朝 +z（开场镜头那面）。flat：标签朝上。
    螺丝在背面，标签朝螺丝的反方向，免得字翻过去。"""
    shell = next(n for n in names if n.startswith('Fita'))
    co = _mesh_co(asset.pieces[shell])
    c = co.mean(0)
    x = co - c
    _, evecs = np.linalg.eigh(np.cov(x.T))
    thin, mid, long = (evecs[:, i].copy() for i in range(3))  # 特征值从小到大：厚、短、长
    if float(np.dot(np.cross(long, mid), thin)) < 0:
        thin = -thin
    screws = [n for n in names if n.startswith('Parafusos')]
    if screws:
        sc = np.concatenate([_mesh_co(asset.pieces[n]) for n in screws]).mean(0)
        if float(np.dot(sc - c, thin)) > 0:
            thin, mid = -thin, -mid
    # 列是 long、mid、thin 要去的方向（Blender 坐标）
    target = np.column_stack([[1, 0, 0], [0, 0, 1], [0, -1, 0]] if mode == 'stand'
                              else [[1, 0, 0], [0, 1, 0], [0, 0, 1]])
    source = np.column_stack([long, mid, thin])
    R = target @ np.linalg.inv(source)
    M3 = Matrix((tuple(float(v) for v in R[0]), tuple(float(v) for v in R[1]), tuple(float(v) for v in R[2])))
    origin = Vector(tuple(float(v) for v in c))
    return Matrix.Translation(origin) @ M3.to_4x4() @ Matrix.Translation(-origin), float(np.ptp(x @ long))


def _place_tape(asset, names, mode, at, scale):
    xform = _orient_tapes(asset, names, mode)[0]
    saved = {}
    for n in names:
        saved[n] = asset.pieces[n]
        me = saved[n].copy()
        me.transform(xform)
        asset.pieces[n] = me
    put(asset, at, uvk=25, pieces=names, anchor=(0.5, 0.0, 0.5), scale=scale)
    for n in names:
        bpy.data.meshes.remove(asset.pieces[n])
        asset.pieces[n] = saved[n]


# 随身听立在电脑左边。耳机围在机身两边，整份一起摆。耳机网格名有乱码，按部件位置认，不靠那两个字。
# 正面小窗是半透明材质，烘焙只认登记过的玻璃，改成不透明的深色烟灰塑料。
WALK = Asset('sketchfab/sony-walkman', 'walkman', texsize=1024)
_body = next(n for n in WALK.pieces if n.startswith('Walkman'))
_win = next(n for n in WALK.pieces if n.startswith('Window'))
WALK.pieces[_win].materials.clear()
WALK.pieces[_win].materials.append(plain_material('walkman_window', '#3a3e42'))
_blo, _bhi = WALK.bounds([_body])
_lo, _hi = WALK.bounds()
_body_h = float(_bhi[1] - _blo[1])
WALK_S = 0.135 / _body_h * 1.1  # 机身按真实的 13.5 厘米，再放大 1.1 倍，字才看得清
_pivot = np.array([(_blo[0] + _bhi[0]) / 2, _lo[1], (_blo[2] + _bhi[2]) / 2])  # 机身的水平中心落在桌面上
put(WALK, G((DESK_X - 0.54, TOP, -1.78), (0, 0.23, 0)), uvk=25,
    anchor=tuple((_pivot - _lo) / (_hi - _lo)), scale=WALK_S)
print(f'[walkman] 机身 {_body_h * 100:.1f} cm × {WALK_S:.3f} → {_body_h * WALK_S * 100:.1f} cm，'
      f'中心 ({DESK_X - 0.54:+.3f}, -1.780)，转 0.23')

# 彩虹标签磁带。贴图缩到 1024，开场画面里标签才清楚。三盘轮流用。
FITA = Asset('sketchfab/cassette-tape-fita-cassete', 'fita', texsize=1024)
FITA_G = _tape_groups(FITA)
_, FITA_LONG = _orient_tapes(FITA, FITA_G[0], 'stand')
FITA_S = 0.10 * 1.15 / FITA_LONG  # 长边 10 厘米，再放大 1.15 倍
_shell = next(n for n in FITA_G[0] if n.startswith('Fita'))
_saved_shell = FITA.pieces[_shell]
_tmp = _saved_shell.copy()
_tmp.transform(_orient_tapes(FITA, FITA_G[0], 'stand')[0])
FITA.pieces[_shell] = _tmp
_slo, _shi = FITA.bounds([_shell])
FITA_SIZE = (_shi - _slo) * FITA_S  # three：宽、高、厚
bpy.data.meshes.remove(_tmp)
FITA.pieces[_shell] = _saved_shell
print(f'[fita] 外壳 {FITA_SIZE[0] * 100:.1f} × {FITA_SIZE[1] * 100:.1f} × {FITA_SIZE[2] * 100:.1f} cm（宽×高×厚），缩放 {FITA_S:.6f}')

# 两盘竖在后沿、窗台下面，标签朝开场镜头，往后仰约 11°。底边贴着桌面。
# 名义中心是 DESK_X-0.42 / -0.31。外壳放大以后宽 11.5 厘米，右沿会贴上电脑左边（x≈-0.19），
# 所以整对再往左 3.5 厘米，右沿离电脑留出 3 厘米以上。
FITA_LEAN = -math.radians(11)
for i, (dx, yaw) in enumerate(((-0.455, 0.15), (-0.345, -0.05))):
    lift = float(FITA_SIZE[2]) / 2 * abs(math.sin(FITA_LEAN))  # 绕底面中心后仰，后边会沉进桌面，抬回来
    at = G((DESK_X + dx, TOP + lift, -1.93)) @ M(rot=(FITA_LEAN, 0, 0)) @ M(rot=(0, yaw, 0))
    _place_tape(FITA, FITA_G[i], 'stand', at, FITA_S)
# 前面平放一摞三盘。固定种子，预览和烘焙是同一摞；最上面多转一截，露出标签。
_fr = random.Random(4)
for i, which in enumerate((2, 0, 1)):
    yaw = _fr.uniform(-0.04, 0.04) + (0.25 if i == 2 else 0.0)
    dx, dz = _fr.uniform(-0.004, 0.004), _fr.uniform(-0.004, 0.004)
    at = G((DESK_X - 0.36 + dx, TOP + i * float(FITA_SIZE[2]), -1.81 + dz), (0, yaw, 0))
    _place_tape(FITA, FITA_G[which], 'flat', at, FITA_S)

# 记事本 = 联系方式（浏览器在纸面上画字，材质名 notepad 的顶面），在键盘右边
g = G((NOTE_X, TOP, NOTE_Z), (0, NOTE_ROT, 0))
with hot('online', NOTE_ROT):
    box(g, 0.15, 0.012, 0.21, mat('notepad', '#ddd5c2'), 0, 0.006, 0)
    box(g, 0.15, 0.004, 0.025, mat('notepad_top', '#8b2f2f'), 0, 0.014, -0.095)
    rod(world(g, (0.062, 0.017, 0.08)), world(g, (0.07, 0.017, -0.07)), 0.0045, mat('pen', '#1f3b6e'), 8)  # 笔压在右边沿，不挡纸上的字
flat_aabb('note', NOTE_X, NOTE_Z, 0.15, 0.21, NOTE_ROT, TOP, TOP + 0.02)
# 从正上方偏一点往下看，镜头转到和本子一样的角度，纸面在画面里是正的
VIEWS['online'] = dict(target=world(g, (0, 0.012, 0.01)), size=(0.12, 0.14), dir=(math.sin(NOTE_ROT) * 0.45, 1.0, math.cos(NOTE_ROT) * 0.45))

# 录像带架：4 盘录像带（Sketchfab「VHS」，Ilgis (Dolgov) Fatykhov，CC BY）套着纸盒竖着插在架子上，纸盒的书脊朝前。
# 素材里是一摞带子 + 两个电影纸盒：只取单独放着的那一盘带子和尺寸正好的那个纸盒（电影封面不用）。
# 每盘带子的塑料壳用自己的材质（tape0 …），浏览器按材质名把它拆出来单独移动（从纸盒上口抽出来、飞进录像机）；
# 纸盒（sleeve0 …）留在架子上，网页按 HTML 里的作品画纸盒的包装（js/sleeves.js）。纸盒的 UV 重新排过：
# 一张图横着排 [封底 | 书脊 | 封面 | 背脊 | 里面]，高 = 纸盒的长（开口朝上）
RACK = (DESK_X + 0.47, TOP, -1.83)
g = G(RACK)
rack = mat('rack', '#5b3d26')
TAPE_COLORS = ['#e8b04a', '#e0577a', '#4fa3e0', '#59c27a']
VHS = Asset('sketchfab/vhs', 'vhs', texsize=1024)
VHS.islands('Plane008_09 - Default_0', (0.105, -0.01, -0.13), (0.30, 0.04, 0.13), into='cassette')  # 单独放着的那一盘
for _n in [n for n in VHS.pieces if n not in ('cassette', 'Plane008_default_0')]:
    del VHS.pieces[_n]
    del VHS.alias[_n]


def align_flat(me):
    """网格在水平面上转正（Blender 坐标，z 朝上）：最小外接矩形的长边顺着 x，中心挪到原点。"""
    co = np.array([v.co[:] for v in me.vertices])
    xy = co[:, :2] - co[:, :2].mean(0)
    area = lambda a: np.ptp(xy @ np.array([math.cos(a), math.sin(a)])) * np.ptp(xy @ np.array([-math.sin(a), math.cos(a)]))
    best = min(np.radians(np.arange(0, 180, 0.25)), key=area)
    me.transform(Matrix.Rotation(-best, 4, 'Z'))
    size = np.ptp(np.array([v.co[:] for v in me.vertices]), 0)
    if size[1] > size[0]:
        me.transform(Matrix.Rotation(math.pi / 2, 4, 'Z'))
    co = np.array([v.co[:] for v in me.vertices])
    me.transform(Matrix.Translation(Vector(tuple(-(co.min(0) + co.max(0)) / 2))))


align_flat(VHS.pieces['cassette'])
align_flat(VHS.pieces['Plane008_default_0'])
VHS.pieces['cassette'] = VHS._decimate(VHS.pieces['cassette'], 0.5)
_lo, _hi = VHS.bounds(['Plane008_default_0'])
SLEEVE = [float(v) for v in (_hi - _lo)]  # 纸盒：长、厚、宽（素材的 three 坐标 x / y / z）
print(f'[vhs] 带子 {np.round(np.ptp(np.concatenate([VHS.bounds(["cassette"])]), 0), 3)}，纸盒 {np.round(SLEEVE, 3)}')
# 素材坐标 → 带子自己的坐标：长（素材 x）竖起来朝上（纸盒开口在 +x，朝上），厚（素材 y）横着排，宽（素材 z）朝里外
STAND = Matrix(((0, 1, 0, 0), (1, 0, 0, 0), (0, 0, -1, 0), (0, 0, 0, 1)))
SLEEVE_COLS = [SLEEVE[2], SLEEVE[1], SLEEVE[2], SLEEVE[1], 0.03]  # 封底、书脊、封面、背脊、里面（米）


def sleeve_uv(ob, frame):
    """纸盒重新排 UV。frame：带子自己的坐标（three）：x = 厚，y = 长（开口朝上），z = 宽（书脊朝 +z，朝外）。
    外面的面按朝向分到封底 / 书脊 / 封面 / 背脊那一栏；朝里的面（纸板的里面）和上下两头都放到"里面"那一栏。"""
    me = ob.data
    inv = frame.inverted()
    CI = C.inverted()  # Blender → three
    loc = [inv @ (CI @ v.co) for v in me.vertices]
    lo = Vector([min(p[k] for p in loc) for k in range(3)])
    hi = Vector([max(p[k] for p in loc) for k in range(3)])
    mid = (lo + hi) / 2
    W, t, L = hi.z - lo.z, hi.x - lo.x, hi.y - lo.y
    cols = [W, t, W, t, 0.03]
    TW = sum(cols)
    start = [sum(cols[:k]) for k in range(5)]
    uvl = me.uv_layers.get('UVMap') or me.uv_layers.new(name='UVMap')
    rot = inv.to_3x3() @ CI.to_3x3()
    for poly in me.polygons:
        n = (rot @ poly.normal).normalized()
        c = sum((loc[i] for i in poly.vertices), Vector()) / len(poly.vertices)
        inner = n.dot(mid - c) > 0
        k = max(range(3), key=lambda a: abs(n[a]))
        for li in poly.loop_indices:
            p = loc[me.loops[li].vertex_index]
            v = (p.y - lo.y) / L
            if inner or k == 1:
                u = start[4] + 0.015
            elif k == 0 and n.x > 0:     # 封面：书脊在左手边
                u = start[2] + (hi.z - p.z)
            elif k == 0:                 # 封底：书脊在右手边
                u = start[0] + (p.z - lo.z)
            elif n.z > 0:                # 书脊（朝外）
                u = start[1] + (p.x - lo.x)
            else:                        # 背脊（朝里）
                u = start[3] + (hi.x - p.x)
            uvl.data[li].uv = (u / TW, v)


with hot('work'):
    box(g, 0.16, 0.015, 0.13, rack, 0, 0.0075, 0)                      # 底板
    for sx in (-1, 1):
        box(g, 0.01, 0.1, 0.13, rack, sx * 0.075, 0.015 + 0.05, 0)      # 两边的挡板，纸盒露出上半截
    box(g, 0.14, 0.05, 0.008, rack, 0, 0.015 + 0.025, -0.061)          # 后面一条矮挡板
    for i, c in enumerate(TAPE_COLORS):
        gi = g @ M((-0.051 + i * 0.034, 0.015 + SLEEVE[0] / 2 + 0.0008, 0.0))
        K = 15
        # 带子转半圈：素材里标签那条边在素材的 +z，转到朝外（插进录像机时标签朝外、带门朝里）
        obs, _ = put(VHS, gi @ M(rot=(0, math.pi, 0)) @ STAND, uvk=15, pieces=['cassette'], anchor=(0.5, 0.5, 0.5))
        for ob in obs:
            for k_, m_ in enumerate(ob.data.materials):
                m2 = m_.copy()
                m2.name = f'tape{i}'
                ob.data.materials[k_] = m2
        # 纸盒：书脊只有 3 厘米宽，精度给足（15 的时候 Project C 的书脊缩到落不进像素中心，烘成了黑的）
        obs, _ = put(VHS, gi @ STAND, uvk=35, pieces=['Plane008_default_0'], anchor=(0.5, 0.5, 0.5),
                     material=plain_material(f'sleeve{i}', c))
        for ob in obs:
            sleeve_uv(ob, gi)
        K = 10

# 马克杯（真实模型，连咖啡面和把手），高度缩到约 9.5 厘米
MUG = Asset('sketchfab/coffee-mug-school-project', 'mug', texsize=512)
put(MUG, G((MUG_AT[0], TOP, MUG_AT[1]), (0, 0.6, 0)), uvk=25, height=0.095)

# 台灯前面一座木头万年历（Sketchfab「Wooden Perpetual Desk Calendar」，3DLover89，CC BY），斜着朝镜头。
# 胡桃木底座上：两块枫木数字方块（一块 0–5，一块 0 1 2 6 7 8，6 倒过来当 9）、左边一根七棱的星期滚筒、后面三根四棱的月份条。
# 能动的六块各用自己的材质（deskcal_cubeA …），网页按材质名拆出来，转到今天的日期（js/deskcal.js）。
# 这里记下每块的转轴中心、每个面印的字（法线 + 字的"上"方向，素材坐标），网页据此算出要转多少。
DCAL = Asset('sketchfab/wooden-perpetual-desk-calendar', 'deskcal', texsize=1024)
DCAL_MOVE = {'cubeA': 'SM_CubeA', 'cubeB': 'SM_CubeB', 'roller': 'SM_DayRoller',
             'bar1': 'SM_MonthBar_01', 'bar2': 'SM_MonthBar_02', 'bar3': 'SM_MonthBar_03'}
DCAL_S = 1.25    # 素材是真实大小（19 厘米宽）；开场镜头里数字太小，放大一点。角度在上面，字朝开场镜头
_dlo, _dhi = DCAL.bounds()
_dorigin = _dlo + (_dhi - _dlo) * np.array((0.5, 0.0, 0.5))  # 整座日历的底面中心
DCAL_AT = G((CAL_X, TOP, CAL_Z), (0, DCAL_YAW, 0))


def dcal_put(names, **kw):
    """摆素材里的几块：锚点按整座日历的包围盒算，各块之间的相对位置不变。"""
    lo, hi = DCAL.bounds(names)
    return put(DCAL, DCAL_AT, uvk=25, pieces=names, anchor=tuple((_dorigin - lo) / (hi - lo)), scale=DCAL_S, **kw)


def dcal_faces(obs, T):
    """一块的各个面：按法线分组，UV 中心落在贴图的哪一行哪一格 → 印的是什么；"上"= 贴图 v 增大的方向。返回素材坐标里的 [{label, n, up}]。"""
    Ti = T.inverted()
    R = Ti.to_3x3().normalized()
    rows = [(0.917, '012345'), (0.75, '012678'), (0.628, ['JAN', 'FEB', 'MAR', 'APR']), (0.55, ['MAY', 'JUN', 'JUL', 'AUG']),
            (0.472, ['SEP', 'OCT', 'NOV', 'DEC']), (0.394, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])]
    groups = {}
    for ob in obs:
        uvl = ob.data.uv_layers[0]
        for p in ob.data.polygons:
            vs = [Vector((ob.data.vertices[i].co.x, ob.data.vertices[i].co.z, -ob.data.vertices[i].co.y)) for i in p.vertices]  # Blender → three
            uv = [uvl.data[li].uv for li in p.loop_indices]
            n = (R @ Vector((p.normal.x, p.normal.z, -p.normal.y))).normalized()
            e1, e2 = vs[1] - vs[0], vs[2] - vs[0]
            du1, dv1, du2, dv2 = uv[1].x - uv[0].x, uv[1].y - uv[0].y, uv[2].x - uv[0].x, uv[2].y - uv[0].y
            det = du1 * dv2 - du2 * dv1
            if abs(det) < 1e-12:
                continue
            dpdv = (e2 * du1 - e1 * du2) / det
            key = tuple(round(c, 2) for c in n)
            gr = groups.setdefault(key, dict(n=n, up=Vector(), u=0.0, v=0.0, a=0.0))
            a = p.area
            gr['up'] += (R @ dpdv) * a
            gr['u'] += sum(t.x for t in uv) / len(uv) * a
            gr['v'] += sum(t.y for t in uv) / len(uv) * a
            gr['a'] += a
    out = []
    for gr in groups.values():
        u, v = gr['u'] / gr['a'], gr['v'] / gr['a']
        row = next((labels for rv, labels in rows if abs(v - rv) < 0.035), None)
        if row is None:
            continue
        up = gr['up'] - gr['n'] * gr['up'].dot(gr['n'])
        out.append(dict(label=row[min(len(row) - 1, int(u * len(row)))], n=[round(c, 4) for c in gr['n']],
                        up=[round(c, 4) for c in up.normalized()]))
    return out


with hot('calendar', DCAL_YAW):
    dcal_put([n for n in DCAL.names() if n not in DCAL_MOVE.values()])  # 底座、横档、黄铜轴和脚、插月份条的两根销子
    DESKCAL = dict(pieces={}, yaw=DCAL_YAW)
    for key, name in DCAL_MOVE.items():
        obs, T_d = dcal_put([name])
        for ob in obs:
            for k_, m_ in enumerate(ob.data.materials):
                m2 = m_.copy()
                m2.name = f'deskcal_{key}'
                ob.data.materials[k_] = m2
        pts = world_points(obs)
        Ti = T_d.inverted()
        lo_l = np.min([tuple(Ti @ Vector(tuple(q))) for q in pts], axis=0)
        hi_l = np.max([tuple(Ti @ Vector(tuple(q))) for q in pts], axis=0)
        center = (lo_l + hi_l) / 2
        DESKCAL['pieces'][key] = dict(mat=f'deskcal_{key}', center=[round(float(c), 5) for c in center],
                                      faces=dcal_faces(obs, T_d))
    # 滚筒绕黄铜轴转：轴心（素材坐标）= 黄铜轴的中心
    _alo, _ahi = DCAL.bounds(['SM_Brass_Axle'])
    _ax = (np.array(_alo) + np.array(_ahi)) / 2
    _rc = DESKCAL['pieces']['roller']['center']
    DESKCAL['pieces']['roller']['center'] = [_rc[0], round(float(_ax[1]), 5), round(float(_ax[2]), 5)]
    DESKCAL['matrix'] = [round(T_d[r][c], 6) for c in range(4) for r in range(4)]  # 素材坐标 → 世界坐标（three，列主序，Matrix4.fromArray 用）
for k_, pc_ in DESKCAL['pieces'].items():
    print(f"[deskcal] {k_}: " + ', '.join(f"{f['label']} n{tuple(round(c, 1) for c in f['n'])} up{tuple(round(c, 1) for c in f['up'])}" for f in pc_['faces']))

# ---------- 桌子左头：电话 + 答录机 = Messages（热点 messages 只框答录机） ----------
# 右手写字的人电话放左手边：黑色转盘电话（Sketchfab「Western Electric 500 Vintage Rotary Telephone」，Skyice，CC BY）
# 在左前角，转盘朝人，听筒线从左边出来；米色答录机（Sketchfab「Answering machine」，aefj1032，CC BY，AT&T 实物扫描）
# 在它右后方、万年历前面，按键那头朝人、往镜头这边斜一点。电话线：电话后面 → 答录机侧面，答录机后面 → 桌子后沿落到墙根。
# MESSAGES 键旁边那条小灯在网页里闪（有没听过的留言），点答录机放留言（js/answering.js）；灯的位置写进 manifest.answering。
PHONE = Asset('sketchfab/western-electric-500-vintage-rotary-telephone', 'phone', texsize=1024, drop=('Black_Object_*',),
              decimate={'Coiled_Cord*': 0.12, 'Base_Feet*': 0.08, '*_Jack_*': 0.1, 'Handset_Western*': 0.3,
                        'Main_Body*': 0.4, '*Finger_Wheel*': 0.3, 'Dial_Number_Plate*': 0.5, '*Center_Cap*': 0.3, 'Plug_*': 0.3})
PHONE_S, PHONE_YAW = 1.08, 0.15        # 素材是真实大小；放大一点点，开场画面里认得出是电话
PHONE_AT = (DESK_X - 0.88, -1.305)      # 机身中心（听筒线在左边，往外多出 17 厘米）；往桌子中间收，右边离那摞纸十几厘米
_blo, _bhi = PHONE.bounds(['Main_Body*'])
_lo, _hi = PHONE.bounds()
_pivot = np.array([(_blo[0] + _bhi[0]) / 2, _lo[1], (_blo[2] + _bhi[2]) / 2])  # 机身的水平中心落在桌面上（不算听筒线）
with hot('phone', PHONE_YAW):  # 点电话 = 给主人留言（js/phone.js）
    _phone_obs, T_phone = put(PHONE, G((PHONE_AT[0], TOP, PHONE_AT[1]), (0, PHONE_YAW, 0)), uvk=12,  # 黑的，光照细节看不出来；岛又多（两千多个），别占太多图集
                     anchor=tuple((_pivot - _lo) / (_hi - _lo)), scale=PHONE_S,
                     hot_skip=('Coiled_Cord*', 'Plug_*', '*_Jack_*'))  # 盒子只框机身和听筒，和别的物件一样贴着东西
# 转盘（带十个指孔的那一圈）单独一个材质 phone_wheel：留言之前网页拨几位号码，转的就是它（js/dial.js）。
# 底下印数字的盘、中间的盖子、挡手指的金属片不动。转轴 = 转盘平面的法线（朝外），过转盘的圆心
_wheel = [ob for ob in _phone_obs if fnmatch.fnmatch(ob.name.split(':', 1)[-1], '*Finger_Wheel*')]
_wmat = {}
for ob in _wheel:
    for k_, m_ in enumerate(ob.data.materials):
        if m_.name not in _wmat:
            _wmat[m_.name] = m_.copy()
            _wmat[m_.name].name = 'phone_wheel' if len(_wmat) == 1 else f'phone_wheel_{len(_wmat)}'
        ob.data.materials[k_] = _wmat[m_.name]
_wp = world_points(_wheel)
_wc0 = _wp.mean(0)
_wax = np.linalg.svd(_wp - _wc0, full_matrices=False)[2]  # 前两个是转盘平面里的方向，最后一个是法线
_wn = _wax[2] if _wax[2][1] > 0 else -_wax[2]                # 转盘朝上斜着：法线取朝上的那一头
_wu, _wv = (_wp - _wc0) @ _wax[0], (_wp - _wc0) @ _wax[1]
_wcen = _wc0 + _wax[0] * (_wu.min() + _wu.max()) / 2 + _wax[1] * (_wv.min() + _wv.max()) / 2  # 指孔只占大半圈：圆心按外沿算，不按平均
PHONE_DIAL = dict(mats=[m.name for m in _wmat.values()], c=[round(float(c), 5) for c in _wcen],
                  n=[round(float(c), 5) for c in _wn], r=round(float(max(_wu.max() - _wu.min(), _wv.max() - _wv.min()) / 2), 4))
print(f'[phone] 转盘 {len(_wheel)} 块，材质 {PHONE_DIAL["mats"]}，圆心 {PHONE_DIAL["c"]}，法线 {PHONE_DIAL["n"]}，半径 {PHONE_DIAL["r"]}')

# 扫描表面一层层鼓包：用 blender/answering_prep.py 照着扫描搭的干净外壳（颜色从扫描烤过去），小灯位置也是它量好的
_AMD = os.path.join(ROOT, 'vendor-src', 'sketchfab', 'answering-machine')
if not os.path.exists(os.path.join(_AMD, 'answering-machine-clean.glb')):
    raise SystemExit('[answering] 先跑 blender/answering_prep.py（从扫描做干净的外壳）')
AM = Asset('sketchfab/answering-machine', 'answering', texsize=1024, glb=os.path.join(_AMD, 'answering-machine-clean.glb'))
with open(os.path.join(_AMD, 'answering-machine-clean.json')) as _f:
    AM_LED = json.load(_f)['led']
AM_S = 0.16 / 0.786 * 1.1              # 扫描的单位是随便的：按宽 16 厘米（深 22、高 5.7）还原，再放大一成
AM_YAW = math.pi / 2 + 0.25            # 素材里按键那头朝 -x：转 90° 朝人，再往镜头这边斜 0.25
AM_AT = (DESK_X - 0.76, -1.62)          # 右边离会议论文 6 厘米、离随身听 3 厘米
with hot('messages', AM_YAW):
    _, T_am = put(AM, G((AM_AT[0], TOP, AM_AT[1]), (0, AM_YAW, 0)), uvk=25, scale=AM_S)
# 小灯：MESSAGES 键旁边那条暗缝（素材坐标 three：中心、所在斜面的法线；长边沿素材 z）
_R = T_am.to_3x3().normalized()
_n = (_R @ Vector(AM_LED['n'])).normalized()
_along = (_R @ Vector((0.0, 0.0, 1.0))).normalized()
_r4 = lambda v: [round(float(c), 4) for c in v]  # noqa: E731（manifest 那段的 r3 在文件后面才定义）
ANSWERING = dict(led=dict(c=_r4(at3(T_am, AM_LED['c']) + _n * 0.0006), n=_r4(_n), right=_r4(_along),
                          up=_r4(_n.cross(_along)), w=round(AM_LED['w'] * AM_S, 4), h=round(AM_LED['h'] * AM_S, 4)))
print(f"[answering] 灯 {ANSWERING['led']['c']}，{ANSWERING['led']['w'] * 1000:.1f} × {ANSWERING['led']['h'] * 1000:.1f} mm")
# 电话线：电话后面的接口 → 答录机靠电话那侧；答录机后面 → 从万年历和随身听中间穿到桌子后沿，落到墙根（和台灯的线一样）
_jack = at3(T_phone, (0.048, 0.012, -0.112))
_side = at3(T_am, (-0.05, 0.03, -0.352))  # 线插在底座侧面、后面（底座比上壳往里收）
_back = at3(T_am, (0.49, 0.03, 0.0))
_y = TOP + 0.0025
tube(spline([(_jack.x, _jack.y, _jack.z), (_jack.x + 0.01, _y, _jack.z - 0.04), ((_jack.x + _side.x) / 2 - 0.03, _y, (_jack.z + _side.z) / 2),
             (_side.x - 0.02, _y, _side.z + 0.01), (_side.x, _side.y, _side.z)], 5), 0.0022, wire)
_wx = DESK_X - 0.67  # 万年历右沿（约 -0.65）和随身听左沿（约 -0.57）中间
tube(spline([(_back.x, _back.y, _back.z), (_back.x + 0.02, _y, _back.z - 0.03), (_wx, _y, _back.z - 0.07), (_wx, _y, DESK_BACK + 0.06), (_wx, _y, DESK_BACK + 0.006),
             (_wx - 0.01, TOP - 0.02, DESK_BACK - 0.004), (_wx - 0.02, TOP - 0.07, BACK + 0.014), (_wx, 0.04, BACK + 0.012),
             (_wx + 0.07, 0.004, BACK + 0.016)], 5), 0.0022, wire)

# ---------- 桌上的杂物：让桌子看起来有人在用 ----------
paper, ink = mat('mug', '#e8e2d4'), mat('rbtn', '#8a8580')

# ---------- 键盘左边那摞纸 = Papers（热点 papers，每份一个盒子，从下往上：期刊论文、会议论文、对折的报纸） ----------
# 网页里点这摞纸，三份一起拿到眼前（js/papers.js）。摆法照手里拿着的样子：期刊论文在右后，会议论文在中间压着它，
# 对折的报纸盖在两份的中下部（报纸朝上的是头版上半张，折痕朝人）。
# 纸面贴图是 index.html #papers 每份的第一页（scripts/render-papers.mjs 截到 output/papers-tex/，没有就用纯色）。
# 材质名都以 paper 开头：网页里拿起来时整摞藏起来（js/room.js 按名字找）；烘焙时不挡光（NO_SHADOW），桌面不留纸的影子。
# 纸面在台灯底下，网页里按 PAPER_TINT 压暗一档（manifest.tints），不然不悬停也是桌上最亮的一块、冒辉光。
PAPER_TEX = os.path.join(ROOT, 'output', 'papers-tex')
PAPERS = dict(  # 中心 x、z，绕竖轴转的角度 yaw，宽 w、深 d（米）；本地 -z 是纸的上沿（朝窗）
    journal=dict(x=DESK_X - 0.38, z=-1.465, yaw=-0.06, w=0.21, d=0.297),
    conference=dict(x=DESK_X - 0.49, z=-1.41, yaw=0.04, w=0.21, d=0.297),
    news=dict(x=DESK_X - 0.46, z=-1.30, yaw=0.09, w=0.28, d=0.198),  # 对折以后：宽 28 厘米、深 19.8 厘米（半张）
)
PAPER_TINT = {'paper_conference': '#e0ddd8', 'paper_journal': '#e0ddd8', 'paper_news': '#e6e3dc'}
PAPER_Y = dict(journal=(0.0004, 0.0003), conference=(0.0014, 0.0003))  # 每份最底下那张离桌面多高、一张比一张高多少
NEWS_T = 0.003  # 对折的报纸厚 3 毫米


def paper_frame(k, y=0.0):
    p = PAPERS[k]
    return G((p['x'], TOP + y, p['z']), (0, p['yaw'], 0))


def paper_local(k, x, z):
    """世界 (x, z) → 第 k 份纸的本地坐标"""
    p = PAPERS[k]
    c, s, dx, dz = math.cos(p['yaw']), math.sin(p['yaw']), x - p['x'], z - p['z']
    return c * dx - s * dz, s * dx + c * dz


def paper_material(name, color, image=None):
    mt = plain_material(name, color)
    if image and os.path.exists(image):
        nt = mt.node_tree
        tx = nt.nodes.new('ShaderNodeTexImage')
        tx.image = bpy.data.images.load(image)
        tx.extension = 'EXTEND'
        nt.links.new(tx.outputs['Color'], next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'])
    elif image:
        print(f'[warn] 没找到 {os.path.relpath(image, ROOT)}（先跑 scripts/render-papers.mjs），纸面用纯色')
    return mt


def paper_object(name, mt, verts, faces, uvs):
    """verts：three 世界坐标；faces：顶点编号（朝上的一面按需要自动翻正）；uvs：每个顶点的贴图坐标"""
    fixed = []
    for f in faces:
        a, b, c = (Vector(verts[i]) for i in f[:3])
        fixed.append(tuple(f) if (b - a).cross(c - a).y >= 0 else tuple(reversed(f)))
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(tb(v)) for v in verts], [], fixed)
    uv = me.uv_layers.new(name='UVMap')
    uv.data.foreach_set('uv', [c for f in me.polygons for li in f.loop_indices for c in uvs[me.loops[li].vertex_index]])
    me.materials.append(mt)
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    PLACED.append((ob, 25))
    return ob


def paper_sheet(k, name, mt, y, about=None, rot=0.0, shift=(0.0, 0.0)):
    """第 k 份里的一张平纸：绕 about（本地点，默认中心）在纸面里转 rot 度、再挪 shift（米）"""
    p, g = PAPERS[k], paper_frame(k)
    hw, hd = p['w'] / 2, p['d'] / 2
    ax, az = about or (0.0, 0.0)
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    vs, uvs = [], []
    for lx, lz in ((-hw, hd), (hw, hd), (hw, -hd), (-hw, -hd)):
        qx, qz = lx - ax, lz - az
        vs.append(tuple(g @ Vector((ax + c * qx + s * qz + shift[0], y, az - s * qx + c * qz + shift[1]))))
        uvs.append(((lx + hw) / p['w'], (hd - lz) / p['d']))  # 纸的上沿（本地 -z）= 贴图的上沿
    paper_object(name, mt, vs, [(0, 1, 2, 3)], uvs)
    return vs


def paper_hot(k, y1):
    p, g = PAPERS[k], paper_frame(k)
    pts = [tuple(g @ Vector((sx * p['w'] / 2, y, sz * p['d'] / 2))) for sx in (-1, 1) for sz in (-1, 1) for y in (0.0, y1)]
    HOT_PTS.setdefault(HOT_ID, []).extend(pts)
    flat_aabb('paper_' + k, p['x'], p['z'], p['w'], p['d'], p['yaw'], TOP, TOP + y1)


plain_sheet = paper_material('paper_sheet', '#d9d2c2')          # 底下几张：没有字（看得见的只是错开的一条边）
TAB_COLORS = dict(y='#f2c94c', b='#79b0d6', p='#eb8fa6')

def build_papers():
    """三份纸（局部变量都关在函数里：模块里的 x0、x1 之类是房间的尺寸，不能被盖掉）"""
    # 期刊论文：三张别着回形针，底下两张随手错开一点
    with hot('papers', PAPERS['journal']['yaw']):
        y0, dy = PAPER_Y['journal']
        paper_sheet('journal', 'paper_journal_3', plain_sheet, y0, rot=-0.7, shift=(-0.0015, 0.0025))
        paper_sheet('journal', 'paper_journal_2', plain_sheet, y0 + dy, rot=0.8, shift=(0.0018, -0.001))
        paper_sheet('journal', 'paper_journal_1', paper_material('paper_journal', '#e8e2d4', os.path.join(PAPER_TEX, 'journal.jpg')), y0 + 2 * dy)
        # 回形针：网页里那根（js/papers.js 的 CLIP_PATH，24 × 72 的格子）按 0.47 毫米一格摆在左上角，横跨纸的上沿
        _cs = 0.00047
        def _arc(cx, cy, r, a0, a1, n=8):
            return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cy + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]
        _svg = [(8, 20), (8, 56)] + _arc(12, 56, 4, math.pi, 0)[1:] + [(16, 10)] + _arc(10, 10, 6, 0, -math.pi)[1:] + [(4, 62)] + _arc(12, 62, 8, math.pi, 0)[1:] + [(20, 26)]
        _g, _p = paper_frame('journal', y0 + 2 * dy + 0.0006), PAPERS['journal']
        tube([tuple(_g @ Vector((-_p['w'] / 2 + 0.035 + (u - 12) * _cs, 0, -_p['d'] / 2 + (v - 22) * _cs))) for u, v in _svg], 0.00045, mat('paper_clip', '#b9bcc0'), segs=5)
        paper_hot('journal', y0 + 2 * dy + 0.001)

    # 会议论文：三张，左上角一颗订书钉；底下两张绕着钉子错开一点（右下角散开几毫米），第 2、3 页上贴着便利贴伸出右边
    with hot('papers', PAPERS['conference']['yaw']):
        y0, dy = PAPER_Y['conference']
        _p = PAPERS['conference']
        _corner = (-_p['w'] / 2 + 0.008, -_p['d'] / 2 + 0.008)
        paper_sheet('conference', 'paper_conference_3', plain_sheet, y0, about=_corner, rot=1.6)
        paper_sheet('conference', 'paper_conference_2', plain_sheet, y0 + dy, about=_corner, rot=0.8)
        paper_sheet('conference', 'paper_conference_1', paper_material('paper_conference', '#e8e2d4', os.path.join(PAPER_TEX, 'conference.jpg')), y0 + 2 * dy)
        _g = paper_frame('conference', y0 + 1.5 * dy)
        for _k, (_c, _top) in enumerate((('y', 0.15), ('b', 0.25), ('p', 0.35))):  # 和 index.html 的 data-tabs 一样：Fig. 2、Tab. 1、Refs
            quad(_g, 0.019, 0.011, mat('paper_tab_' + _c, TAB_COLORS[_c]), (_p['w'] / 2 + 0.0035, 0, -_p['d'] / 2 + _top * _p['d'] + 0.0055), (-math.pi / 2, 0, 0))
        _g = paper_frame('conference', y0 + 2 * dy + 0.00045)
        box(_g, 0.0125, 0.0005, 0.0011, mat('paper_staple', '#c4c7cb'), _corner[0] + 0.004, 0, _corner[1] + 0.004, (0, math.pi / 4, 0))
        paper_hot('conference', y0 + 2 * dy + 0.001)

    # 报纸：对折，朝上的是头版上半张，折痕朝人。底面顺着底下的纸搭下来：压在论文上的地方抬起来，伸出论文的地方落到桌面
    with hot('papers', PAPERS['news']['yaw']):
        _p, _g = PAPERS['news'], paper_frame('news')
        hw, hd, NX, NZ = _p['w'] / 2, _p['d'] / 2, 10, 14
        _lift = dict(journal=PAPER_Y['journal'][0] + 2 * PAPER_Y['journal'][1], conference=PAPER_Y['conference'][0] + 2 * PAPER_Y['conference'][1])

        def _support(lx, lz):  # 这一点底下垫着多高（论文的上表面，或者桌面）
            wx, wz = (_g @ Vector((lx, 0, lz))).x, (_g @ Vector((lx, 0, lz))).z
            h = 0.0002
            for k_, top_ in _lift.items():
                qx, qz = paper_local(k_, wx, wz)
                if abs(qx) <= PAPERS[k_]['w'] / 2 + 0.002 and abs(qz) <= PAPERS[k_]['d'] / 2 + 0.002:
                    h = max(h, top_ + 0.0004)
            return h

        _xs = [-hw + 2 * hw * i / NX for i in range(NX + 1)]
        _zs = [-hd + 2 * hd * j / NZ for j in range(NZ + 1)]
        _base = np.array([[max(_support(x + dx, z + dz) for dx in (-0.012, 0, 0.012) for dz in (-0.012, 0, 0.012)) for x in _xs] for z in _zs])
        for _ in range(3):  # 纸有点硬：台阶抹平成缓坡
            _pad = np.pad(_base, 1, mode='edge')
            _base = np.maximum(_base, (_pad[:-2, 1:-1] + _pad[2:, 1:-1] + _pad[1:-1, :-2] + _pad[1:-1, 2:] + 4 * _base) / 8)
        _base[-1, :] = _base[-1, :].min()  # 折痕那条边平平地落在桌面上（折边的圆柱按它算）
        vs, uvs, fs = [], [], []
        for j, z in enumerate(_zs):
            for i, x in enumerate(_xs):
                bow = 0.0012 * math.sin(math.pi * (z + hd) / (2 * hd)) * (1 - 0.3 * abs(x) / hw)  # 中间微微拱起
                vs.append(tuple(_g @ Vector((x, _base[j, i] + NEWS_T + bow, z))))
                uvs.append(((x + hw) / _p['w'], 1 - 0.5 * (z + hd) / _p['d']))  # 上半张：贴图 v 从 1（报头）到 0.5（中线）
        for j in range(NZ):
            for i in range(NX):
                a = j * (NX + 1) + i
                fs.append((a, a + 1, a + NX + 2, a + NX + 1))
        paper_object('paper_news_top', paper_material('paper_news', '#e5dabd', os.path.join(PAPER_TEX, 'news.jpg')), vs, fs, uvs)
        # 折边：半个圆柱，从上面那层绕到底下那层（落在桌面）；两侧、远处的开口边各一条窄边，看得出厚度
        _r, _fold = NEWS_T / 2, mat('paper_news_fold', '#c9bf9f')

        def _face(q, inside):  # 一块面，朝外（背对 inside 那一点）
            q = [Vector(v) for v in q]
            n_ = (q[1] - q[0]).cross(q[3] - q[0])
            if n_.dot(sum(q, Vector()) / 4 - Vector(inside)) < 0:
                q = q[::-1]
            T.tag([T.bm.faces.new([T.bm.verts.new(tb(v)) for v in q])], _fold)

        for i in range(NX):
            x0, x1, b0, b1 = _xs[i], _xs[i + 1], _base[-1, i], _base[-1, i + 1]
            ring = lambda x, b, t: _g @ Vector((x, b + _r + _r * math.sin(t), hd + _r * math.cos(t) * 0.9))  # noqa: E731
            axis = _g @ Vector(((x0 + x1) / 2, (b0 + b1) / 2 + _r, hd))
            for k in range(6):
                t0, t1 = math.pi / 2 - math.pi * k / 6, math.pi / 2 - math.pi * (k + 1) / 6
                _face([ring(x0, b0, t0), ring(x1, b1, t0), ring(x1, b1, t1), ring(x0, b0, t1)], axis)
        _mid = _g @ Vector((0, float(_base.mean()) + _r, 0))
        for idx in ([(0, i) for i in range(NX + 1)], [(j, 0) for j in range(NZ + 1)], [(j, NX) for j in range(NZ + 1)]):  # 远处、左、右
            for (j0, i0), (j1, i1) in zip(idx, idx[1:]):
                top0, top1 = Vector(vs[j0 * (NX + 1) + i0]), Vector(vs[j1 * (NX + 1) + i1])
                _face([top0, top1, top1 - Vector((0, NEWS_T, 0)), top0 - Vector((0, NEWS_T, 0))], _mid)
        paper_hot('news', float(_base.max()) + NEWS_T + 0.0015)


build_papers()
# Papers 没有 VIEWS：镜头不凑过去，网页把纸从桌上拿起来举到眼前

# ---------- 书桌右边：电视推车（黑铁架子、两层木板，带小轮子），斜着朝向开场镜头 ----------
# 上层：自己搭的薄录像机 + 上面的 CRT 电视 + 天线；下层：几盒录像带、一摞杂志。
# 电视素材自带的屏幕画面（Object_6）不要，玻璃（Object_8）换成深色，浏览器在上面贴一块弯过的 canvas
K = 12
CART_ROT = -0.4  # 正面（+z）转到世界的 (-0.39, 0, 0.92)，对着书桌前面
CART_W, CART_D, CART_H = 0.56, 0.42, 0.64
gc = G((DESK_RX + 0.4, 0, -1.6), (0, CART_ROT, 0))
metal, board = mat('cart_metal', '#2a2826'), mat('cart_shelf', '#5b3d26')
box(gc, CART_W, 0.025, CART_D, board, 0, CART_H - 0.0125, 0)
for sx in (-1, 1):
    for sz in (-1, 1):
        px, pz = sx * (CART_W / 2 - 0.0125), sz * (CART_D / 2 - 0.0125)
        box(gc, 0.022, CART_H - 0.065, 0.022, metal, px, 0.04 + (CART_H - 0.065) / 2, pz)
        ball(world(gc, (px, 0.022, pz)), 0.022, mat('caster', '#141414'), 1)
box(gc, CART_W - 0.012, 0.02, CART_D - 0.012, board, 0, 0.16, 0)
for i, (dx, c) in enumerate(((-0.14, '#1d1d1f'), (-0.12, '#24364f'), (-0.15, '#1d1d1f'))):  # 下层：三盒录像带平放成一摞
    box(gc, 0.205, 0.028, 0.12, mat(f'vhs_box{i}', c), dx, 0.17 + 0.014 + i * 0.028, 0.02, (0, (i - 1) * 0.08, 0))
for i, c in enumerate(('#c9b48a', '#8f3a2e', '#e6e0d0')):  # 杂志
    box(gc, 0.21, 0.008, 0.28, mat(f'mag{i}', c), 0.12, 0.17 + 0.004 + i * 0.008, 0.0, (0, 0.1 - i * 0.07, 0))
K = 25
TVA = Asset('sketchfab/retro-crt-tv', 'tv', texsize=1024, drop=('Object_6',))
tv_glass = plain_material('tv_glass', '#0b0d0e')
TVA.islands('Object_8', (-9, -9, -9), (9, 9, 9), material=tv_glass)
g = gc @ M((0, CART_H, -0.02))
VCR_H, VCR_D = 0.07, 0.32
with hot('work', CART_ROT):
    box(g, 0.40, VCR_H, VCR_D, mat('vcr', '#1f1e1d'), 0, VCR_H / 2, 0)
    box(g, 0.2, 0.03, 0.004, mat('slot', '#050505'), -0.07, 0.04, VCR_D / 2)  # 插口：真实尺寸的录像带（18.7 厘米长）塞得进去
    box(g, 0.06, 0.016, 0.004, mat('vcr_display', '#1d3a2b'), 0.1, 0.046, VCR_D / 2)
    for i in range(4):
        box(g, 0.02, 0.01, 0.006, mat('button', '#6e6a64'), 0.055 + i * 0.03, 0.019, VCR_D / 2)
    tv_obs, _ = put(TVA, g @ M((0, VCR_H, -0.005), (0, -math.pi / 2, 0)), uvk=25, scale=0.56)
VCR_SLOT = world(g, (-0.07, 0.04, VCR_D / 2))
TV_SCREEN = screen_grid(tv_obs, tv_glass, frac=0.94, rot=CART_ROT)
screen_log('tv', TV_SCREEN)
tv_top = float(world_points(tv_obs)[:, 1].max()) - CART_H
rod(world(g, (0.05, tv_top, -0.05)), world(g, (-0.12, tv_top + 0.3, -0.12)), 0.0035, mat('chrome', '#9a9a9a'), 6)
rod(world(g, (0.07, tv_top, -0.05)), world(g, (0.24, tv_top + 0.26, -0.1)), 0.0035, mat('chrome', '#9a9a9a'), 6)
# 录像机后面的电线：顺着推车左后腿下到地上，插在窗下墙上的插座里
K = 10
px, pz = -(CART_W / 2 - 0.0125), -(CART_D / 2 - 0.0125)
sock = (DESK_RX + 0.33, 0.27)
tube(spline([world(g, (-0.12, 0.035, -VCR_D / 2 - 0.004)), world(gc, (px + 0.02, CART_H + 0.01, pz - 0.03)),
             world(gc, (px + 0.004, CART_H - 0.12, pz - 0.016)), world(gc, (px + 0.004, 0.12, pz - 0.016)), world(gc, (px + 0.01, 0.006, pz - 0.04)),
             (sock[0] - 0.02, 0.004, BACK + 0.03), (sock[0], 0.03, BACK + 0.008), (sock[0], sock[1] - 0.03, BACK + 0.008),
             (sock[0], sock[1] - 0.012, BACK + 0.012)], 5), 0.003, wire)
box(I, 0.075, 0.075, 0.008, paper, sock[0], sock[1], BACK + 0.004)
box(I, 0.028, 0.034, 0.018, mat('remote', '#2a2a2c'), sock[0], sock[1] - 0.004, BACK + 0.017)
K = 25
# 点电视：镜头顺着屏幕的法线正对电视（不往旁边偏），稍微居高往下看；画面中心从电视往左边的录像带架挪四分之一，
# 架子上的带子还在画面左边，点得到
tv_c, rack_c = Vector(TV_SCREEN['pos']), Vector((RACK[0], TOP + 0.07, RACK[2]))
VIEWS['work'] = dict(target=tuple(tv_c * 0.75 + rack_c * 0.25 + Vector((0, -0.02, 0))), size=(0.46, 0.28),
                     dir=tuple(Vector((TV_SCREEN['normal'][0], 0, TV_SCREEN['normal'][2])).normalized() + Vector((0, 0.28, 0))))

# ---------- 真书：书单在 index.html 的 #shelf 里（和网页读的是同一份），按 data-size 的真实尺寸建模 ----------
def shelf_books():
    """读 index.html 里 #shelf 的每个 li：尺寸（米，宽 × 高 × 厚）、精装 / 平装、主色。"""
    from html.parser import HTMLParser

    class P(HTMLParser):
        def __init__(self):
            super().__init__()
            self.depth, self.out = 0, []  # depth > 0：在 #shelf 里面

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            if self.depth:
                self.depth += tag == 'section'
                if tag == 'li':
                    size = [float(v) / 1000 for v in (a.get('data-size') or '150x210x15').replace('×', 'x').split('x')]
                    self.out.append(dict(size=tuple(size), kind=a.get('data-kind', 'soft'), color=a.get('data-color') or '#8a5a2b'))
            elif tag == 'section' and a.get('id') == 'shelf':
                self.depth = 1

        def handle_endtag(self, tag):
            if self.depth and tag == 'section':
                self.depth -= 1

    p = P()
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'index.html'), encoding='utf-8') as f:
        p.feed(f.read())
    return p.out


def book_uv(faces, gb, w, h, t):
    """书皮的颜色贴图 UV：一张图横着排 [封底 | 书脊 | 封面]（和印刷的护封一样），宽 = 2w + t、高 = h。
    书的本地坐标：x = 厚度方向（封面朝 +x），y = 高，z = 宽（书脊朝 +z，朝屋里）。书皮的其他面（板子的边、内侧）取书脊中间那一列。"""
    uvl = T.bm.loops.layers.uv.get('UVMap') or T.bm.loops.layers.uv.new('UVMap')
    inv = (C @ gb).inverted()
    W = 2 * w + t
    for f in faces:
        loc = [inv @ l.vert.co for l in f.loops]
        n = (inv.to_3x3() @ f.normal).normalized() if f.normal.length else Vector((0, 0, 0))
        for l, q in zip(f.loops, loc):
            v = (q.y + h / 2) / h
            if n.x > 0.9 and q.x > t / 2 - 1e-4:        # 封面：书脊在左手边
                u = (w + t) / W + (w / 2 - q.z) / W
            elif n.x < -0.9 and q.x < -t / 2 + 1e-4:    # 封底：书脊在右手边
                u = (q.z + w / 2) / W
            elif n.z > 0.9:                              # 书脊（连同两块板子在书脊那头的边）
                u = w / W + (q.x + t / 2) / W
            else:
                u = (w + t / 2) / W
            l[uvl].uv = (u, v)


# 书脊的 lightmap 精度：薄书的书脊只有 8～20 毫米宽，按书的精度（15）一格贴图 2 厘米多，常常一个像素中心都落不进去、书脊烘焙成全黑
# （2026-11-23 量过：39 本里 9 本书脊是 0）。书脊这一条面积很小，给到 60 也只多占一点贴图
SPINE_UVK = 60


def real_book(g, dims, kind, mi_cover, mi_pages, pos, rot=(0, 0, 0)):
    """一本真书，pos = 书的中心。精装：封板 2.5 毫米厚、比书芯大一圈（上下、切口各 3 毫米）；平装：封面 0.7 毫米、几乎齐平。"""
    global K
    w, h, t = dims
    gb = g @ M(pos, rot)
    hard = kind == 'hard'
    bt, o = (0.0025, 0.003) if hard else (0.0007, 0.0006)
    shell = set()
    shell |= box(gb, bt, h, w, mi_cover, t / 2 - bt / 2, 0, 0)         # 封面那块板（+x）
    shell |= box(gb, bt, h, w, mi_cover, -t / 2 + bt / 2, 0, 0)        # 封底那块板
    k0, K = K, SPINE_UVK                                                 # 书脊单独给高精度（见 SPINE_UVK）
    shell |= box(gb, t - 2 * bt, h, bt, mi_cover, 0, 0, w / 2 - bt / 2)  # 书脊
    K = k0
    box(gb, t - 2 * bt, h - 2 * o, w - o - bt, mi_pages, 0, 0, (o - bt) / 2)  # 书芯（切口和上下比书皮缩进 o）
    book_uv(shell, gb, w, h, t)
    return gb


REAL = shelf_books()
REAL_BOOKS = []  # 写进 manifest.books：每本书的中心（世界坐标）、尺寸、精装 / 平装、在第几层


# ---------- 左墙：雕花木书柜（Sketchfab「Wooden bookcase」，stanislau.see，CC BY），背靠左墙、和书桌错开，开场镜头里看不到，往左转才转进来 ----------
# 书柜是一整块网格：下面一个抽屉座、中间五层开放的格子、顶上雕花的冠头。格子里摆「Elegan old book pack」（3D_for_everyone，CC BY）
# 的旧书（一排排立着、几本横着摞），真书见上面的 real_book。
# 下面这些数字是在素材自己的坐标（three：x 宽、y 高、z 深，前面朝 +z）里量的：内侧板、每层的底面 / 顶面、格子的前沿和背板
K = 12
BC_S = 0.85                                    # 原素材 2.73 米高：缩到 2.32 米（屋子 2.7 米高）
BC_IN = (0.99, 1.72)                           # 两块侧板的内侧
BC_FLOOR = (0.73, 0.95, 1.17, 1.49, 1.95)      # 五层格子的底面（隔板顶面）
BC_CEIL = (0.847, 1.125, 1.461, 1.923, 2.222)  # 每层的顶（上一块隔板的底面）
BC_FRONT, BC_BACK = -1.83, -2.06               # 格子的前沿、背板内侧
BOOKCASE = Asset('sketchfab/wooden-bookcase', 'bookcase', texsize=2048)
BOOK_COLORS = ['#6b2a26', '#2c4a3e', '#b59a5e', '#253650', '#8a5a2b', '#d6ccb4', '#4b2f46', '#3c3b38']
BOOKS = [mat(f'book{i}', c) for i, c in enumerate(BOOK_COLORS)]  # 自己搭的书（窗台上、地上那一摞）用的颜色
OLD = Asset('sketchfab/elegan-old-book-pack', 'oldbook', texsize=512)
# 旧书的 lightmap 精度：一本薄书的书脊只有 1～2 厘米宽。按普通精度（12）一格贴图有 2.7 厘米，书脊里一个像素中心都没有，
# 烘焙不到、整本是黑的（2026-11-21 桌上加了东西、整张贴图变挤以后，最上层左头那几本就这样黑了）。给到 40，书脊至少占一两格
OLD_UVK = 40
_blo, _bhi = BOOKCASE.bounds()
SH_W = float(_bhi[0] - _blo[0]) * BC_S         # 连冠头的总宽（摆龟背竹、日历要用）
SH_D = float(_bhi[2] - _blo[2]) * BC_S
# 书柜背靠左墙、正面朝屋里（+x）；BC_Z：书柜中线在墙上的位置（z）。
# 书柜和书桌错开：靠里那头对齐书桌前沿，左后墙角空出约 1 × 0.8 米，留着放装饰品
BC_ROT = math.pi / 2
BC_Z = BACK + 0.43 + DESK_D / 2 + SH_W / 2
MONSTERA_AT = (x0 + 0.36, 0, BC_Z + SH_W / 2 + 0.3)   # 书柜靠屋里那头的地上
FLOOR_STACK_AT = (x0 + SH_D + 0.2, 0, BC_Z + SH_W / 2 - 0.12)  # 书柜前面的地上，看完还没放回去
BC_R = M(rot=(0, BC_ROT, 0))                   # 书柜自己的朝向：本地 +z（正面）→ 世界 +x，本地 +x（看的人的右手）→ 世界 -z
with hot('shelf', rot=BC_ROT):
    _, T_bc = put(BOOKCASE, G((x0 + 0.005, 0, BC_Z), (0, BC_ROT, 0)), uvk=12, scale=BC_S, anchor=(0.5, 0.0, 0.0))
_i0, _i1 = at3(T_bc, (BC_IN[0], 0, BC_FRONT)), at3(T_bc, (BC_IN[1], 0, BC_FRONT))
SH_IN = (_i1 - _i0).length                     # 内宽
SH_DEPTH = (at3(T_bc, (0, 0, BC_FRONT)) - at3(T_bc, (0, 0, BC_BACK))).length  # 格子深
_o = (_i0 + _i1) / 2
g = Matrix.Translation(Vector((_o.x, 0, _o.z))) @ BC_R  # 格子坐标：x 横着（-SH_IN/2 … SH_IN/2），y 世界高度，z = 0 是格子前沿、往里是负的
SHG = g
SH_OUT = BC_R @ Vector((0, 0, 1))              # 书柜正面朝哪（世界）：网页里把书往这个方向抽出来
SHELF_FLOOR = [at3(T_bc, (0, y, 0)).y for y in BC_FLOOR]
SHELF_CEIL = [at3(T_bc, (0, y, 0)).y for y in BC_CEIL]
SH_RIGHT = SH_IN / 2 - 0.006
print(f'[bookcase] 宽 {SH_W:.2f}、深 {SH_D:.2f}、内宽 {SH_IN:.3f}、格子深 {SH_DEPTH:.3f}；每层净高 ' +
      ', '.join(f'{c - f:.3f}' for f, c in zip(SHELF_FLOOR, SHELF_CEIL)))
UPRIGHT = M(rot=(0, -math.pi / 2, 0))          # 旧书素材里书脊朝 +x：转到朝屋里（+z），一排书顺着 x 排开
# 横着放：书的高度方向顺着格子、厚度朝上，书脊（素材的 +x）朝屋里
FLAT = Matrix(((0, 1, 0, 0), (0, 0, 1, 0), (1, 0, 0, 0), (0, 0, 0, 1)))
L = -SH_IN / 2 + 0.004                        # 每层左头从哪里开始摆


def old_books(piece, level, x0, flat=False, y0=0.0, nudge=0.0, rot_y=0.0):
    """在第 level 层摆一组旧书（素材里的一个 Book_pack_N 或 Book_N，连书页），左边从 x0 开始；返回 (占了多宽, 多高)。
    立着的按这一层的净高缩放（最多 0.82 倍）；横着放的按 0.82 倍，y0 = 摞在下面那些书的总厚度。
    书脊都在素材的 +x（在预览图里核对过），转到朝屋里。nudge：往外探出多少；rot_y：随手放歪一点。"""
    names = [f'{piece}_*']
    lo, hi = OLD.bounds(names)
    size = hi - lo
    f, c = SHELF_FLOOR[level], SHELF_CEIL[level]
    if flat:
        s = 0.82
        length, depth = size[1] * s, size[0] * s
        at = g @ M((x0 + length / 2, f + y0, -depth / 2 + nudge), (0, rot_y, 0)) @ FLAT
        put(OLD, at, pieces=names, scale=s, uvk=OLD_UVK, anchor=(0.5, 0.5, 0.0))
        return length, size[2] * s
    s = min(0.82, (c - f - 0.014) / size[1])
    length, depth = size[2] * s, size[0] * s
    at = g @ M((x0 + length / 2, f, -min(depth, SH_DEPTH) / 2 + nudge), (0, rot_y, 0)) @ UPRIGHT
    put(OLD, at, pieces=names, scale=s, uvk=OLD_UVK)
    return length, size[1] * s


def old_len(piece, level):
    """一组旧书立在第 level 层时有多宽（不摆，只量；缩放和 old_books 一样）。"""
    lo, hi = OLD.bounds([f'{piece}_*'])
    size = hi - lo
    return float(size[2]) * min(0.82, (SHELF_CEIL[level] - SHELF_FLOOR[level] - 0.014) / float(size[1]))


# 真书分到哪一层：书单（index.html，按划线多少排）从前往后，先放第 4 层（视线高度、最高的一格），满了放第 3 层、再放第 5 层。
# 每层左头 / 右头先留出旧书和别的摆设的位置：第 3 层右头是那台 8 毫米摄影机，第 5 层右头是绿萝
GAP = 0.0015
SHELF_PLAN = {3: dict(left=[], right=['Book_9', 'Book_13'], keep=0.0),
              2: dict(left=[], right=[], keep=0.19),
              4: dict(left=['Book_pack_6'], right=[], keep=0.13)}
FILL = ['Book_pack_3', 'Book_pack_1', 'Book_12', 'Book_7', 'Book_pack_6', 'Book_9', 'Book_13']  # 真书摆完还空着的地方，塞旧书
_room = {lv: (SH_RIGHT - sp['keep']) - L - 0.01 - sum(old_len(q, lv) + 0.003 for q in sp['left'] + sp['right'])
         for lv, sp in SHELF_PLAN.items()}
_fits = lambda b, lv: b['size'][1] < SHELF_CEIL[lv] - SHELF_FLOOR[lv] - 0.01
_tall = {bi for bi, b in enumerate(REAL) if _fits(b, 3) and not _fits(b, 2) and not _fits(b, 4)}  # 只放得进第 4 层的高书：先给它们留位置
_room[3] -= sum(REAL[bi]['size'][2] + GAP for bi in _tall)
REAL_SLOTS = []
for bi, b in enumerate(REAL):
    need = b['size'][2] + GAP
    if bi in _tall:
        lv = 3
    else:
        lv = next((lv for lv in (3, 2, 4) if _fits(b, lv) and _room[lv] >= need), None)
        if lv is None:
            print(f'[books] 书柜放不下第 {bi + 1} 本真书了（{b["size"]}）')
            continue
        _room[lv] -= need
    REAL_SLOTS.append(dict(b, i=bi, level=lv))
print('[books] 每层真书：' + '，'.join(f'第 {lv + 1} 层 {sum(1 for b in REAL_SLOTS if b["level"] == lv)} 本、剩 {_room[lv]:.3f} m'
                                    for lv in (2, 3, 4)))


def real_row(level, x):
    """把分到这一层的真书从 x 开始挨着立起来（书脊朝屋里），返回排到了哪里。"""
    global K
    for b in [b for b in REAL_SLOTS if b['level'] == level]:
        bw, bh, bth = b['size']
        bw = min(bw, SH_DEPTH + 0.02)          # 比格子深的书往外探一点点（只影响模型，翻开的书照真实尺寸）
        pos = (x + bth / 2, SHELF_FLOOR[level] + bh / 2, -bw / 2 + 0.01)
        K = 15
        real_book(g, (bw, bh, bth), b['kind'], mat(f'realbook{b["i"]}', b['color']), mat(f'realbook{b["i"]}_pages', '#ece3cc'), pos)
        K = 12
        REAL_BOOKS.append(dict(i=b['i'], pos=world(g, pos), size=(bw, bh, bth), kind=b['kind'], level=level))
        x += bth + 0.0015
    return x


with hot('shelf'):
    # 第 3、4、5 层：左头的旧书 → 真书 → 空出来的地方塞旧书 → 右头的旧书；右头再留出摄影机（第 3 层）、绿萝（第 5 层）的位置
    for lv in (4, 3, 2):
        sp = SHELF_PLAN[lv]
        x = L
        for q in sp['left']:
            x += old_books(q, lv, x)[0] + 0.003
        x = real_row(lv, x + 0.004) + 0.003
        end = SH_RIGHT - sp['keep'] - sum(old_len(q, lv) + 0.003 for q in sp['right'])
        for q in FILL:
            if x + old_len(q, lv) <= end:
                x += old_books(q, lv, x)[0] + 0.003
        x = max(x, end)
        for q in sp['right']:
            x += old_books(q, lv, x)[0] + 0.003
    # 第 2 层（矮）：左头空出一截（以前平放着一本本子）、一摞横放的旧书，右头三盘磁带
    sh_ = 0.21
    K = 12
    x, yy = L + sh_ + 0.035, 0.0
    for p, a in (('Book_3', 0.04), ('Book_11', -0.03), ('Book_6', 0.07)):
        yy += old_books(p, 1, x, flat=True, y0=yy, rot_y=a)[1]
    # 第 1 层（最矮，抽屉上面那一格）：两本横放的薄书
    x = L + 0.02
    for p in ('Book_5', 'Book_2'):
        x += old_books(p, 0, x, flat=True)[0] + 0.03
    # 第 3 层右头：一台老的 8 毫米摄影机，镜头朝右前方；第 2 层右头：三盘随手摞着的磁带
    CAMERA = Asset('sketchfab/retro-camera', 'camera', texsize=512)
    put(CAMERA, g @ M((SH_RIGHT - 0.1, SHELF_FLOOR[2], -0.09), (0, 1.1, 0)), uvk=15, height=0.15)
    # 书柜这三盘仍是旧素材（半透明外壳的已经丢掉）；书桌上的换成新的了
    for k, (name, a, dx) in enumerate((('Object_8', 0.12, 0.0), ('Object_11', -0.14, 0.006), ('Object_14', 0.32, -0.004))):
        put(CASS, g @ M((SH_RIGHT - 0.075 + dx, SHELF_FLOOR[1] + k * 0.0102, -0.07), (0, a, 0)), uvk=15, pieces=[name], scale=1.0)
# 点书架：正对着书柜中间那几层、稍微从右边看
VIEWS['shelf'] = dict(target=world(g, (0, 1.22, 0)), size=(0.42, 0.62), dir=tuple(BC_R @ Vector((-0.3, 0.08, 1))))

# 书柜靠屋里那头：落地龟背竹（盆下面是木脚架）。叶片是镂空的卡片；气根减面
MONSTERA = Asset('sketchfab/monstera-deliciosa-potted-mid-century-plant', 'monstera', texsize=512,  # 叶片贴图是带透明的 PNG，1024 要 1 MB
                 cutout=('Mat.1*',), decimate={'*root*': 0.5})
put(MONSTERA, G(MONSTERA_AT, (0, 0.6, 0)), uvk=6, height=1.0)

# 书桌左边的地上：一摞看完还没放回去的书，最上面一本杂志
g = G(FLOOR_STACK_AT, (0, 0.3, 0))
y = 0
for k, (w, h, d, ci, a) in enumerate(((0.25, 0.036, 0.18, 3, 0.0), (0.22, 0.042, 0.16, 0, 0.12), (0.2, 0.028, 0.15, 5, -0.08), (0.23, 0.03, 0.165, 6, 0.2))):
    box(g, w, h, d, BOOKS[ci], 0.006 * k, y + h / 2, 0, (0, a, 0))
    y += h
box(g, 0.21, 0.006, 0.28, mat('mag1', '#8f3a2e'), 0.012, y + 0.003, 0.02, (0, -0.28, 0))

# 左后墙角放什么（试摆用的开关，定下来以后去掉）：studio = 画室画架 + 莫奈，easel = 自己搭的窄画架 + 莫奈，globe = 落地地球仪
CORNER = os.environ.get('CORNER', 'studio')
ART_TITLE = ''
if CORNER == 'studio':
    # 画室画架（Sketchfab「Easel | Мольберт | Easel with painting」里中间那个空画架，Every_3D，CC BY），托板上放金框的莫奈。
    # 只管镜头看到的样子：画架横向压到 0.72、前后压到 0.6（腿收窄、站得浅，托板右头不伸进开场画面），左前腿脚底戳进书柜背面一点（那一面镜头看不到）。
    # 画框中心离左墙 0.4 米、离后墙 0.55 米，正面转向往左转过来的镜头；又刚好在开场画面的左边界外面
    K = 12
    STUDIO = Asset('sketchfab/easel-with-painting', 'easel', texsize=1024)
    ST_YAW, ST_S = 1.17, (0.72, 1.0, 0.6)                                     # 朝向；横、竖、前后的缩放
    ST_AT = G((-1.6, 0, -1.6), (0, ST_YAW, 0)) @ Matrix.Diagonal((*ST_S, 1.0))
    # 画架本身不算热点：2 米高的盒子会把墙角、地板一起框进去，鼠标放上去一大片发亮；能点的只是上面那幅画
    put(STUDIO, ST_AT, uvk=20, pieces=['Easel_Easel_0'], scale=1.0)  # 压窄以后托板很细，光照贴图给多一点，不然发黑
    # 素材里量的（以底面中心为原点，three 坐标，未缩放）：托板顶面 0.766 米；0.77 米高处立杆前面在 z = 0.263；立杆往后仰 0.265 / 1.58
    _tilt = math.atan(0.265 * ST_S[2] / (1.58 * ST_S[1]))
    # 画（试摆用的开关）：sunrise = 莫奈《印象·日出》（1872，横幅，金框转成横放），parasol = 莫奈《撑阳伞的女人》（1875，竖幅）
    PICS = {'sunrise': ('monet-impression-sunrise', True, 'Claude Monet · Impression, Sunrise, 1872'),
            'parasol': ('monet-woman-with-a-parasol', False, 'Claude Monet · Woman with a Parasol, 1875')}
    ART_PIC = os.environ.get('ART_PIC', 'sunrise')
    _pic, _wide, ART_TITLE = PICS[ART_PIC]
    ART = Asset('polyhaven/fancy_picture_frame_02', 'artframe', texsize=1024)
    ART_S = 0.72 if _wide else 0.8                                            # 竖放 0.53 × 0.62 米；横放 0.55 × 0.48 米（再大右头就伸进开场画面）
    _flo, _fhi = ART.bounds()
    _fh, _fd = float(_fhi[0 if _wide else 1] - _flo[0 if _wide else 1]) * ART_S, float(_fhi[2] - _flo[2]) * ART_S
    _up = Vector((0, math.cos(_tilt), -math.sin(_tilt)))
    _fb = Vector((0, 0.766 * ST_S[1] + 0.005, 0.263 * ST_S[2] + 0.01 + _fd / 2))   # 画框底边中心：坐在托板上，背面贴着立杆前面
    _fc = _fb + _up * (_fh / 2)
    _st = G((-1.6, 0, -1.6), (0, ST_YAW, 0))                                  # 不带缩放的画架坐标
    with hot('art', ST_YAW):
        art_obs, _ = put(ART, _st @ M(tuple(_fc), (-_tilt, 0, 0)) @ M(rot=(0, 0, math.pi / 2 if _wide else 0)), uvk=15, scale=ART_S,
                         anchor=(0.5, 0.5, 0.5))
    monet = bpy.data.images.load(os.path.join(ROOT, 'vendor-src', 'commons', _pic, _pic + '.jpg'))
    monet.scale(*((1024, 794) if _wide else (820, 1024)))
    art_mat = plain_material('art_monet', '#ffffff')
    _an = art_mat.node_tree
    _at = _an.nodes.new('ShaderNodeTexImage')
    _at.image = monet
    _an.links.new(_at.outputs['Color'], next(n for n in _an.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'])
    for ob in art_obs:                                                        # 画布：换成莫奈，UV 拉满整张画
        if 'canvas' not in ob.name:
            continue
        ob.data.materials.clear()
        ob.data.materials.append(art_mat)
        uvl = ob.data.uv_layers[0].data
        us, vs = [d.uv.x for d in uvl], [d.uv.y for d in uvl]
        u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
        for d in uvl:
            un, vn = (d.uv.x - u0) / (u1 - u0), (d.uv.y - v0) / (v1 - v0)
            d.uv = (1 - vn, un) if _wide else (un, vn)                    # 画框横放（转了 90°）：画也跟着转回正
        print(f'[art] 画布换成莫奈：{ob.name}')
# ---------- 左手边那面墙（墙角画架和窗户之间）：海报和几张论文插图 ----------
# 海报的纸面和胶带共用同一套几何：网页按模式加载公开样图或个人海报的贴图。
# 它们和墙一起烘焙光照（窗外的城市、台灯、房间灯开关都跟着变），但对阴影、反弹的光线是透明的（见下面烘焙前的 poster* 材质）：
# 墙上不会烘出它们的影子。
# 每张：key（材质名、热点名，也是 assets/posters/posters.json 里的键）、宽、高（米）、中心 x、离地 y、在墙面里转几度。
# 大海报右边离窗洞 8 厘米；下面一小片墙（画架的画框右边、窗台左头上面）错落着贴几张打印的插图和一张杂志封面
_A5 = 1.414
POSTERS = [
    dict(key='poster', w=0.48, h=0.48 / 0.761, x=WIN['x'] - WIN['w'] / 2 - 0.08 - 0.24, y=1.56, rot=0.0),   # 杂志封面的比例
    dict(key='poster_2', w=0.165, h=0.165 / 0.761, x=-1.425, y=1.110, rot=1.0),     # 杂志封面
    dict(key='poster_3', w=0.17, h=0.17 / _A5, x=-1.215, y=1.158, rot=1.2),         # 打印的插图（A5 横放的比例）
    dict(key='poster_6', w=0.17, h=0.17 / _A5, x=-1.190, y=1.024, rot=-1.3),
    dict(key='poster_4', w=0.17, h=0.17 / _A5, x=-1.235, y=0.892, rot=0.8),
    dict(key='poster_5', w=0.155, h=0.155 / _A5, x=-1.430, y=0.890, rot=-1.6),
]
_pimg = bpy.data.images.new('poster_blank', 32, 32, alpha=False)                     # 占位：一张空白的旧纸
_pimg.pixels.foreach_set(np.tile(np.array([*srgb('#d9cdb0'), 1.0], np.float32), 32 * 32))
_pimg.pack()
_tr = random.Random(5)
_tv, _tf = [], []
for _i, _P in enumerate(POSTERS):
    _pz = BACK + 0.004 + _i * 0.0012                                                  # 后贴的压在前面的上面
    _ca, _sa = math.cos(math.radians(_P['rot'])), math.sin(math.radians(_P['rot']))

    def _at(lx, ly, z, _P=_P, _ca=_ca, _sa=_sa):                                      # 纸面局部坐标 → three 坐标（墙面上转 rot 度）
        return (_P['x'] + lx * _ca - ly * _sa, _P['y'] + lx * _sa + ly * _ca, z)

    _hw, _hh = _P['w'] / 2, _P['h'] / 2
    _corners = [_at(sx * _hw, sy * _hh, _pz) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    with hot(_P['key']):
        _pm = bpy.data.meshes.new(_P['key'])
        _pm.from_pydata([tuple(tb(c)) for c in _corners], [], [(0, 1, 2, 3)])
        _pm.uv_layers.new(name='UVMap').data.foreach_set('uv', [0, 0, 1, 0, 1, 1, 0, 1])
        _pmat = plain_material(_P['key'], '#ffffff')
        _pt = _pmat.node_tree.nodes.new('ShaderNodeTexImage')
        _pt.image = _pimg
        _pmat.node_tree.links.new(_pt.outputs['Color'], next(n for n in _pmat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'])
        _pm.materials.append(_pmat)
        _pob = bpy.data.objects.new(_P['key'], _pm)
        scene.collection.objects.link(_pob)
        PLACED.append((_pob, 25))
        HOT_PTS.setdefault(HOT_ID, []).extend(_corners + [(x, y, _pz - 0.01) for x, y, _ in _corners])
    xs, ys = [c[0] for c in _corners], [c[1] for c in _corners]
    print(f"[poster] {_P['key']:9s} x {min(xs):+.3f}..{max(xs):+.3f}  y {min(ys):.3f}..{max(ys):.3f}")
    # 四个角各一段白胶带：斜着压过角（一半在纸上、一半在墙上），两头是撕开的锯齿；长短跟着纸的大小
    _size = max(_P['w'], _P['h'])
    for _sx, _sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        _ang = math.atan2(_sx, -_sy) + math.radians(_P['rot'] + _tr.uniform(-9, 9))       # 长边垂直于角的对角线
        _ux, _uy = math.cos(_ang), math.sin(_ang)
        _L = _tr.uniform(0.14, 0.17) * _size / 2                                    # 大海报上约 9.5 厘米，小图上约 3.5 厘米
        _Wt = max(0.0055, _tr.uniform(0.038, 0.046) * _size / 2)
        _in = 0.006 if _size > 0.4 else 0.003
        _ccx, _ccy, _ = _at(_sx * (_hw - _in), _sy * (_hh - _in), 0)                      # 中线稍微往纸里偏一点
        _pts = []
        for _end in (1, -1):                                                          # 一头：上沿 → 三个锯齿 → 下沿
            _e = [(_end * _L, _end * _Wt)]
            for _k in (1, 2, 3):
                _j = 0.004 if _size > 0.4 else 0.0018                                      # 锯齿的深浅
                _e.append((_end * (_L + (_j if _k % 2 else -_j / 2) + _tr.uniform(-_j / 2, _j / 2)), _end * _Wt * (1 - _k / 2)))
            _e.append((_end * _L, -_end * _Wt))
            _pts += _e
        for _mi, (_k, _dx, _dy, _dz) in enumerate(((1.0, 0.0, 0.0, 0.0030), (1.06, 0.0012, -0.0018, 0.0018))):   # 胶带、它底下一圈淡淡的影子
            _o = len(_tv)
            for _a, _b in _pts:
                _tv.append(tuple(tb((_ccx + _dx + _ux * _a * _k - _uy * _b * _k, _ccy + _dy + _uy * _a * _k + _ux * _b * _k, _pz + _dz))))
            _tf.append((tuple(range(_o, _o + len(_pts))[::-1]), _mi))
_tm = bpy.data.meshes.new('poster_tape')
_tm.from_pydata(_tv, [], [f for f, _ in _tf])
_tm.materials.append(plain_material('poster_tape', '#fdfcf7'))
_tm.materials.append(plain_material('poster_tape_shadow', '#000000'))             # 半透明（manifest.glass）
_tm.polygons.foreach_set('material_index', [mi for _, mi in _tf])
_tob = bpy.data.objects.new('poster_tape', _tm)
scene.collection.objects.link(_tob)
PLACED.append((_tob, 25))

if CORNER == 'globe':
    # 落地地球仪（Sketchfab「Floor Globe」，ctorre，CC BY）：素材 1.38 米高，缩到 0.95 米；摆在墙角里开场镜头看不到、往左转又不被书柜挡住的那一小块
    GLOBE = Asset('sketchfab/floor-globe', 'globe', texsize=1024)
    with hot('art', 0.0):
        put(GLOBE, G((-1.5, 0, -1.7), (0, 1.0, 0)), uvk=15, height=0.95)
if CORNER == 'easel':
    # 左后墙角：一个橡木展示画架，架着一幅金色雕花画框（Poly Haven「Fancy Picture Frame 02」，CC0）里的莫奈《撑阳伞的女人》
    # （1875，公有领域，原作在美国国家美术馆；图从 Wikimedia Commons 取，放在 vendor-src/commons/）。
    # 画架：两条前腿往后仰 0.2 弧度、顶上并到一起，一根后腿撑地，前腿前面一块托板托住画框，画框靠在前腿上。
    # 斜着（约 47°）横在墙角里：画框两头分别贴近左墙和后墙，和墙角围成一个三角形，正面朝屋里；几乎立直（后仰 0.05），顶上不戳进墙。
    # 开场镜头看得到墙角靠里的一部分、往左转的镜头从右前方看过来时靠书柜那一段又被书柜挡住，这样摆两头都顾得到；
    # 往左转到头时镜头站在书桌左前方看过来（room.js 的 TURN.shelf）
    K = 12
    EASEL_AT = G((-1.585, 0, -1.77), (0, 0.83, 0))
    EASEL_TILT, EASEL_H, LEDGE_Y = 0.05, 1.7, 0.85
    ewood = mat('easel_wood', '#9a7044')
    _top = Vector((0, EASEL_H * math.cos(EASEL_TILT), -EASEL_H * math.sin(EASEL_TILT)))
    for sx in (-1, 1):
        rod(world(EASEL_AT, (sx * 0.2, 0, 0)), world(EASEL_AT, (sx * 0.035, _top.y, _top.z)), 0.016, ewood, 8)   # 前腿
    rod(world(EASEL_AT, (0, _top.y + 0.04, _top.z)), world(EASEL_AT, (0, 0, -0.3)), 0.015, ewood, 8)            # 后腿，脚落在墙角里
    _lz = -LEDGE_Y * math.tan(EASEL_TILT)
    box(EASEL_AT, 0.4, 0.025, 0.13, ewood, 0, LEDGE_Y, _lz + 0.075, (-EASEL_TILT, 0, 0))                        # 托板
    box(EASEL_AT, 0.4, 0.035, 0.01, ewood, 0, LEDGE_Y + 0.02, _lz + 0.145, (-EASEL_TILT, 0, 0))                # 托板前沿的挡条
    box(EASEL_AT, 0.32, 0.03, 0.03, ewood, 0, LEDGE_Y * 0.45, -LEDGE_Y * 0.45 * math.tan(EASEL_TILT), (-EASEL_TILT, 0, 0))  # 下面一根横撑
    ART = Asset('polyhaven/fancy_picture_frame_02', 'artframe', texsize=1024)
    ART_S = 0.8                                                                   # 画框 0.53 × 0.62 米，画心 0.31 × 0.4 米：墙角的三角形里放得下
    _flo, _fhi = ART.bounds()
    _fh = float(_fhi[1] - _flo[1]) * ART_S
    _up = Vector((0, math.cos(EASEL_TILT), -math.sin(EASEL_TILT)))               # 画框顺着前腿往后仰
    _fc = Vector((0, LEDGE_Y + 0.03, _lz + 0.08)) + _up * (_fh / 2)            # 画框背面贴着前腿的前面
    with hot('art', 0.83):
        art_obs, _ = put(ART, EASEL_AT @ M(tuple(_fc), (-EASEL_TILT, 0, 0)), uvk=15, scale=ART_S, anchor=(0.5, 0.5, 0.5))
    monet = bpy.data.images.load(os.path.join(ROOT, 'vendor-src', 'commons', 'monet-woman-with-a-parasol', 'monet-woman-with-a-parasol.jpg'))
    monet.scale(820, 1024)
    art_mat = plain_material('art_monet', '#ffffff')
    _an = art_mat.node_tree
    _at = _an.nodes.new('ShaderNodeTexImage')
    _at.image = monet
    _an.links.new(_at.outputs['Color'], next(n for n in _an.nodes if n.type == 'BSDF_PRINCIPLED').inputs['Base Color'])
    for ob in art_obs:                                                            # 画布：换成莫奈，UV 拉满整张画
        if not any('canvas' in (m.name if m else '') for m in ob.data.materials) and 'canvas' not in ob.name:
            continue
        ob.data.materials.clear()
        ob.data.materials.append(art_mat)
        uvl = ob.data.uv_layers[0].data
        us, vs = [d.uv.x for d in uvl], [d.uv.y for d in uvl]
        u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
        for d in uvl:
            d.uv = ((d.uv.x - u0) / (u1 - u0), (d.uv.y - v0) / (v1 - v0))
        print(f'[art] 画布换成莫奈：{ob.name}')


# ---------- 右墙：矮柜 + 唱机 + 唱片 + 台灯，墙上一幅画、靠里一块软木板；右前角一盏落地灯 ----------
K = 10
SB_L = 1.4
g = G((x1, 0, -0.56), (0, -math.pi / 2, 0))  # 本地 +z 朝屋里（世界 -x），本地 x 沿墙（世界 +z）；本地 x = -0.7 那头挨着电视推车
cab = mat('sideboard', '#6a4a30')
box(g, SB_L, 0.6, 0.45, cab, 0, 0.42, 0.24)
for sx in (-1, 1):
    for sz in (-1, 1):
        rod(world(g, (sx * (SB_L / 2 - 0.07), 0.12, 0.24 + sz * 0.18)), world(g, (sx * (SB_L / 2 - 0.05), 0.0, 0.24 + sz * 0.2)), 0.015, mat('dark', '#26231f'), 8)
for xx in (-SB_L / 4, SB_L / 4):
    box(g, SB_L / 2 - 0.05, 0.54, 0.005, mat('sideboard_door', '#7a5838'), xx, 0.42, 0.468)
    box(g, 0.012, 0.1, 0.02, mat('brass', '#b8945a'), xx + (SB_L / 4 - 0.095) * (1 if xx < 0 else -1), 0.45, 0.475)
# 唱机：Yamaha TT-300（单位厘米），去掉掀起来的防尘盖；唱臂和机身减面。唱盘上放一张自己搭的黑胶（盖住素材的商标）
TT = Asset('sketchfab/yamaha-tt-300-record-player', 'tt', texsize=1024, drop=('*Cover*',),
           decimate={'*Tone_Arm_#*': 0.15, '*Yamaha_TT-300*': 0.45})
_, T_tt = put(TT, g @ M((-0.4, 0.72, 0.24)), uvk=15, scale=0.01)
rec = at3(T_tt, (-4.826, 5.79, -3.445))  # 唱盘垫的中心和高度（素材坐标里量的）
cyl(I, 0.148, 0.148, 0.002, 48, mat('record', '#111111'), (rec.x, rec.y + 0.001, rec.z))
cyl(I, 0.045, 0.045, 0.001, 24, mat('record_label', '#c94c3c'), (rec.x, rec.y + 0.0025, rec.z))
for i, c in enumerate(['#2e4a7a', '#d8a53a', '#7a2e2e']):
    box(g, 0.31, 0.31, 0.006, mat(f'lp{i}', c), 0.3 + i * 0.01, 0.72 + 0.155, 0.08 + i * 0.012, (-0.16, 0, 0))
# 唱机旁边一盆绿萝，带木脚的小花盆，叶子垂下来一点
POTHOS = Asset('sketchfab/free-pothos-potted-plant-money-plant', 'pothos', texsize=512,
               cutout=('POTHOS_Mat*',), decimate={'*WOODEN_LEGS*': 0.4})
_, T_po = put(POTHOS, g @ M((0.03, 0.72, 0.245), (0, 0.5, 0)), uvk=8, height=0.32)
# 书架第五层右头：同一种绿萝，只要叶子（叶子往外垂），配一个自己搭的陶土盆
lo, hi = POTHOS.bounds(['POT_WOOD*'])
llo, lhi = POTHOS.bounds(['POTHOS_POTHOS*'])
rim = np.array(((lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2))  # 原来花盆的盆口中心：叶子从这里长出来
pot = SHG @ Vector((SH_RIGHT - 0.07, SHELF_FLOOR[4], -0.1))
cyl(I, 0.05, 0.04, 0.075, 16, mat('pot_clay', '#9a5a3c'), (pot.x, pot.y + 0.0375, pot.z))
with hot('shelf'):
    put(POTHOS, G((pot.x, pot.y + 0.07, pot.z), (0, 2.4, 0)), uvk=8, pieces=['POTHOS_POTHOS*'], scale=T_po.to_scale()[0] * 0.8,
        anchor=tuple((rim - llo) / (lhi - llo)))
print(f'[pothos] 原来花盆 {np.round((hi - lo) * T_po.to_scale()[0], 3)}，叶子 {np.round((lhi - llo) * T_po.to_scale()[0] * 0.8, 3)}')
LAMP2 = world(g, (0.58, 0.72, 0.24))
with hot('room'):
    cyl(g, 0.06, 0.07, 0.02, 20, mat('brass', '#b8945a'), (0.58, 0.73, 0.24))
    rod(world(g, (0.58, 0.74, 0.24)), world(g, (0.58, 1.02, 0.24)), 0.008, mat('brass', '#b8945a'))
    with glow():
        cyl(I, 0.09, 0.11, 0.16, 24, emit('emit.room.shade', 'room', '#ffd7a0', 1.6), (LAMP2[0], 1.1, LAMP2[2]), caps=False)
# 墙上的画：Poly Haven 的挂画（油画风的建筑），去掉玻璃（不反光，留着只会挡住画）
FRAME = Asset('polyhaven/hanging_picture_frame_02', 'frame', texsize=1024)
FRAME.drop_faces('hanging_picture_frame_02_glass')
put(FRAME, g @ M((0.15, 1.62, 0)), uvk=12, width=0.8, anchor=(0.5, 0.5, 0.0))

# 矮柜前头（右前角）的落地灯：镜头很少转到这里，主要把屋子前半边、矮柜和画照暖
FLOOR_LAMP = (x1 - 0.32, 1.62, 0.5)
fl = FLOOR_LAMP
with hot('room'):
    cyl(I, 0.15, 0.16, 0.025, 28, mat('dark', '#26231f'), (fl[0], 0.0125, fl[2]))
    rod((fl[0], 0.02, fl[2]), (fl[0], 1.5, fl[2]), 0.011, mat('dark', '#26231f'))
    with glow():
        cyl(I, 0.17, 0.22, 0.32, 32, emit('emit.room.shade', 'room', '#ffd7a0', 1.6), (fl[0], fl[1] + 0.02, fl[2]), caps=False)

# 右墙靠里、电视推车上方的软木板（照片墙）：90 厘米宽，占满后墙到挂画之间；图钉的面太多，整体减到 12%
CORK_C = (1.5, -1.39)  # 板中心的高度、沿墙位置（z）
CORK = Asset('sketchfab/cork-board', 'cork', texsize=1024, decimate={'*': 0.12})
with hot('photos'):  # 照片墙：点它镜头凑到板前（网页按 manifest.photos 把做旧的照片钉在板上）
    cork_obs, _ = put(CORK, G((x1, CORK_C[0], CORK_C[1]), (0, -math.pi / 2, 0)), uvk=12, width=0.9, anchor=(0.5, 0.5, 0.0))
_cp = world_points(cork_obs)
_front = float(np.percentile(_cp[:, 0], 8))  # 板面（朝屋里，-x）：取靠前的一小撮点，图钉头那几个不算
CORK_FRAME = dict(center=(_front, float((_cp[:, 1].min() + _cp[:, 1].max()) / 2), float((_cp[:, 2].min() + _cp[:, 2].max()) / 2)),
                  size=(float(np.ptp(_cp[:, 2])), float(np.ptp(_cp[:, 1]))))
print(f"[cork] 板面 x = {_front:.3f}，中心 {tuple(round(v, 3) for v in CORK_FRAME['center'])}，宽 × 高 {CORK_FRAME['size'][0]:.3f} × {CORK_FRAME['size'][1]:.3f}")
# size 在 room.js 的 focusPose 里按半宽 / 半高算：给板子一半大小再留一点边，镜头凑近到板子占满画面八成多
VIEWS['photos'] = dict(target=CORK_FRAME['center'], size=(CORK_FRAME['size'][0] * 0.56, CORK_FRAME['size'][1] * 0.56), dir=(-1, 0.03, 0.08))

# 软木板上面一只圆挂钟（黑框、米白表盘），指着十一点四十；本地 +z 朝屋里，+x 是看的人的右手边
K = 12
gk = G((x1, 1.9, CORK_C[1]), (0, -math.pi / 2, 0))
UPR = (math.pi / 2, 0, 0)  # 圆柱的轴转到本地 z
cyl(gk, 0.125, 0.125, 0.04, 32, mat('dark', '#26231f'), (0, 0, 0.02), UPR)
cyl(gk, 0.108, 0.108, 0.002, 32, paper, (0, 0, 0.041), UPR)
for i in range(12):
    a, L = i * math.pi / 6, (0.018 if i % 3 == 0 else 0.01)
    box(gk, 0.004 if i % 3 == 0 else 0.0025, L, 0.001, wire, math.sin(a) * (0.095 - L / 2), math.cos(a) * (0.095 - L / 2), 0.0425, (0, 0, -a))
for a, L, w in ((2 * math.pi * (11 + 40 / 60) / 12, 0.056, 0.006), (2 * math.pi * 40 / 60, 0.082, 0.004)):  # 时针、分针
    box(gk, w, L + 0.015, 0.0015, wire, math.sin(a) * (L / 2 - 0.0075), math.cos(a) * (L / 2 - 0.0075), 0.0435 + w / 4, (0, 0, -a))
cyl(gk, 0.006, 0.006, 0.004, 12, wire, (0, 0, 0.045), UPR)
# （软木板和画之间原来贴着三张拍立得，照片墙只放自己的照片，去掉了）
K = 10

# （窗上原来挂着一串 12 个小灯泡，正对着开场镜头太晃眼，去掉了：灯泡、电线和它们的光都没有了）

# ---------- Glow：灯泡、灯罩。不参与烘焙（光由下面的灯光对象负责），浏览器里画成自发光 ----------
# （台灯灯泡、落地灯和柜上台灯的灯罩已经在上面跟着各自的灯建好了）
T, K = GLOWM, 10
# 书架隔板下面原来有一条条灯带，看着刺眼，去掉了；书架改由前面一块看不见的面光照亮（见下面 'room' 层的 shelf_fill）。
# 书架上换成浅色封面的真书以后，这块光从 9 W 降到 4 W，不然白书脊会亮到泛光


# ---------- 建网格 ----------
HOT = hot_boxes()


def build(mesh_wrap, principled=True):
    me = bpy.data.meshes.new(mesh_wrap.name)
    mesh_wrap.bm.to_mesh(me)
    mesh_wrap.bm.free()
    if 'hot' in me.attributes:
        me.attributes.remove(me.attributes['hot'])
    ob = bpy.data.objects.new(mesh_wrap.name, me)
    scene.collection.objects.link(ob)
    for name, (i, color) in sorted(mesh_wrap.mats.items(), key=lambda kv: kv[1][0]):
        mt = bpy.data.materials.new(name)
        nt = tree(mt)
        nt.nodes.clear()
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
        bsdf.inputs['Base Color'].default_value = (*srgb(color), 1)
        bsdf.inputs['Roughness'].default_value = 0.8
        mt.diffuse_color = (*srgb(color), 1)
        me.materials.append(mt)
    return ob


def join(target, others):
    bpy.ops.object.select_all(action='DESELECT')
    for o in others:
        o.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()


# 墙纸、窗帘：Poly Haven 的布料照片（CC0）只取底色贴图，去色后按目标颜色重新上色、压低对比；按真实大小平铺（UV 单位：米 / 一格多大）
WALLPAPER = dict(src='polyhaven/hessian_380', color='#ddd6c8', contrast=0.3, tile=0.27)   # 暖白色麻布墙纸（细细的编织纹）
CURTAIN = dict(src='polyhaven/rough_linen', color='#cdbfa5', contrast=0.6, tile=0.27)     # 燕麦色亚麻窗帘


def tile_uv(mesh_wrap, name, tile, axis=None):
    """材质 name 的面：按面朝向投影成平铺的 UV（UVMap），一格 = tile 米。axis=0：一律从正面投影（窗帘的褶子朝向各不相同）。"""
    if name not in mesh_wrap.mats:
        return
    mi = mesh_wrap.mats[name][0]
    bm = mesh_wrap.bm
    uvl = bm.loops.layers.uv.get('UVMap') or bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        if f.material_index != mi:
            continue
        f.normal_update()
        n = f.normal                                   # Blender 坐标（z 向上）
        ax = axis if axis is not None else 1 if abs(n.x) > max(abs(n.y), abs(n.z)) else 0 if abs(n.y) >= abs(n.z) else -1
        for l in f.loops:
            c = l.vert.co
            if ax == 1:                                 # 朝 ±x 的墙：沿墙是 y
                l[uvl].uv = (c.y / tile, c.z / tile)
            elif ax == 0:                               # 朝 ±y（后墙、前墙、窗帘）
                l[uvl].uv = (c.x / tile, c.z / tile)
            else:                                       # 朝上 / 朝下
                l[uvl].uv = (c.x / tile, c.y / tile)


def recolor_image(spec, name, size=512):
    """底色贴图 → 亮度（除以平均值）→ 压对比 → 乘目标颜色。"""
    folder = os.path.join(ROOT, 'vendor-src', spec['src'])
    if spec['src'] not in USED:
        USED.append(spec['src'])                   # 记进 manifest.vendor（网站的素材致谢按它生成）
    path = next(os.path.join(folder, f) for f in sorted(os.listdir(folder)) if '_diff_' in f)
    src = bpy.data.images.load(path)
    src.scale(size, size)
    px = np.empty(size * size * 4, dtype=np.float32)
    src.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    k = 1 + (lum / max(float(lum.mean()), 1e-4) - 1) * spec['contrast']
    c = np.array([int(spec['color'][i:i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float32)  # 8 位图的像素存的就是 sRGB 值
    out = np.clip(np.outer(np.clip(k, 0, 2), c), 0, 1)
    img = bpy.data.images.new(name, size, size)
    img.pixels.foreach_set(np.concatenate([out, np.ones((len(out), 1), dtype=np.float32)], axis=1).ravel())
    img.pack()
    bpy.data.images.remove(src)
    return img


tile_uv(ROOMM, 'wall', WALLPAPER['tile'])
tile_uv(ROOMM, 'curtain', CURTAIN['tile'], axis=0)
room = build(ROOMM)
glow = build(GLOWM)
glow.hide_render = True
me = room.data
# 两套 UV：UVMap（第一套）给第三方模型的颜色贴图，房间自己搭的面用不到（全是 0）；Lightmap（第二套）下面再展
if 'UVMap' not in me.uv_layers:
    me.uv_layers.new(name='UVMap')
# 书桌的木纹贴图（书桌的面在上面 wood_uv 里已经写好了 UVMap）
mt = me.materials['desk']
nt = mt.node_tree
bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
tex, uvn = nt.nodes.new('ShaderNodeTexImage'), nt.nodes.new('ShaderNodeUVMap')
tex.image, uvn.uv_map = wood_image('desk_wood'), 'UVMap'
nt.links.new(uvn.outputs[0], tex.inputs['Vector'])
nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
for name, spec in (('wall', WALLPAPER), ('curtain', CURTAIN)):
    mt = me.materials[name]
    nt = mt.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    tex, uvn = nt.nodes.new('ShaderNodeTexImage'), nt.nodes.new('ShaderNodeUVMap')
    tex.image, uvn.uv_map = recolor_image(spec, f'{name}_tex'), 'UVMap'
    nt.links.new(uvn.outputs[0], tex.inputs['Vector'])
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    mt.diffuse_color = (*srgb(spec['color']), 1)
for ob, uvk in PLACED:
    a = ob.data.attributes.new('uvk', 'INT', 'FACE')
    a.data.foreach_set('value', [uvk] * len(ob.data.polygons))
join(room, [ob for ob, _ in PLACED])
me = room.data
print(f'[geo] Room {len(me.polygons)} faces / {sum(len(p.vertices) - 2 for p in me.polygons)} tris / {len(me.materials)} materials, '
      f'Glow {len(glow.data.polygons)} faces；素材 {len(USED)} 个')


def orbit_pose(yaw, pitch, dist):
    """开场镜头（绕目标点转）：镜头朝向 f、位置 = 目标点 - f × 距离；出了 CAM['box'] 就拉近。和 room.js 的 orbitPose 一样。"""
    f = Vector((-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)))
    t, bx = Vector(CAM['target']), CAM['box']
    for k, (lo, hi) in ((0, bx['x']), (1, bx['y']), (2, (-1e9, bx['z']))):
        if -f[k] > 1e-6:
            dist = min(dist, (hi - t[k]) / -f[k])
        elif -f[k] < -1e-6:
            dist = min(dist, (lo - t[k]) / -f[k])
    return t - f * dist, f


def report_overlaps():
    """桌上的东西、以及新加长的左翼，包围盒交到一起就记一笔。"""
    def hit(a, b, pad):
        return all(a[0][i] < b[1][i] - pad and b[0][i] < a[1][i] - pad for i in range(3))

    n = 0
    for i in range(len(AABB)):
        ni, lo, hi = AABB[i]
        for nj, lo2, hi2 in AABB[i + 1:]:
            pad = 0.008 if ni == nj else 0.003
            if hit((lo, hi), (lo2, hi2), pad):
                print(f'[overlap] {ni} × {nj}  x {max(lo[0], lo2[0]):+.2f}..{min(hi[0], hi2[0]):+.2f}'
                      f'  z {max(lo[2], lo2[2]):+.2f}..{min(hi[2], hi2[2]):+.2f}')
                n += 1
    print(f'[overlap] {n} 对')


def preview_shots(out):
    """Workbench 快速预览：从开场镜头和左右转、低头、抬头到头的几个角度拍（颜色贴图 + 简单光照，不是烘焙效果）。"""
    report_overlaps()
    os.makedirs(out, exist_ok=True)
    me.uv_layers.active = me.uv_layers['UVMap']
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light, sh.color_type = 'STUDIO', 'TEXTURE'
    sh.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 1280, 800
    cd = bpy.data.cameras.new('cam')
    cd.sensor_fit, cd.angle_y = 'VERTICAL', math.radians(CAM['fov'])
    cd.clip_start = 0.02
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    y0, p0, d0 = CAM['yaw'], CAM['pitch'], CAM['dist']
    (ya, yb), (pa, pb) = CAM['yawRange'], CAM['pitchRange']
    for name, yaw, pitch, dist in (('home', y0, p0, d0), ('left', yb, p0, d0), ('right', ya, p0, d0),
                                   ('down', y0, pa, d0), ('up', y0, pb, d0), ('far', y0, p0, CAM['distRange'][1])):
        pos, f = orbit_pose(yaw, pitch, dist)
        cam.location = tb(pos)
        cam.rotation_euler = tb(f).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print('[preview]', name, 'cam', tuple(round(v, 2) for v in pos))
    tv = math.tan(math.radians(CAM['fov']) / 2)
    shots = {f'v_{k}': (v['target'], v['dir'], max(v['size'][1] / tv, v['size'][0] / (tv * 1.6))) for k, v in VIEWS.items()}  # 点进去以后的镜头
    for name, (t, d, dist) in shots.items():
        f = -Vector(d).normalized()
        cam.location = tb(Vector(t) - f * dist)
        cam.rotation_euler = tb(f).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out, f'{name}.png')
        bpy.ops.render.render(write_still=True)
    # 俯视：正交，从正上方装下整张桌子，前后再各留 10 厘米
    cd.type = 'ORTHO'
    cd.sensor_fit = 'HORIZONTAL'
    aspect = scene.render.resolution_x / scene.render.resolution_y
    cd.ortho_scale = max(DESK_W + 0.18, (DESK_D + 0.20) * aspect)
    cx, cz = (DESK_LX + DESK_RX) / 2, DESK_Z
    cam.location = tb((cx, RH - 0.35, cz))  # 在天花板下面，从房间里往下看；架到屋外会被天花板挡住
    cam.rotation_euler = tb(Vector((0, -1, 0))).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = os.path.join(out, 'top.png')
    bpy.ops.render.render(write_still=True)
    print('[preview] top', 'ortho', round(cd.ortho_scale, 2), 'center', (round(cx, 2), round(cz, 2)))


if A.preview:
    preview_shots(A.preview)
    sys.exit(0)

# ---------- lightmap UV：smart project → 按 uvk 放大主角物件的岛 → 重新排进一张图集 ----------
T0 = time.time()
lm = me.uv_layers.new(name='Lightmap')
me.uv_layers.active = lm
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = room
room.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
bpy.ops.object.mode_set(mode='OBJECT')
# 窗帘正面：smart_project 按法线把褶子切成一条条竖的小岛，一条只有几毫米宽，里面落不进一个像素中心，烘出来是一道道黑条。
# 改成按网格整块展开：u = 沿着褶子量的弧长，v = 往下量的高度，米 → UV 的比例和别的岛一样（之后照常乘 uvk、一起 pack）。
# 正面 / 衬布按 uvk 分（衬布是 4）
_bm = bmesh.new()
_bm.from_mesh(me)
_uvl, _kl = _bm.loops.layers.uv['Lightmap'], _bm.faces.layers.int['uvk']
_ci = next(i for i, m in enumerate(me.materials) if m and m.name == 'curtain')
_uva = lambda f: abs(sum(a[_uvl].uv.x * b[_uvl].uv.y - b[_uvl].uv.x * a[_uvl].uv.y for a, b in zip(f.loops, list(f.loops)[1:] + [f.loops[0]]))) / 2
_d = math.sqrt(sum(_uva(f) for f in _bm.faces) / sum(f.calc_area() for f in _bm.faces))  # 平均每米多少 UV
_front = [f for f in _bm.faces if f.material_index == _ci and f[_kl] != 4]
_rows = {}
for v in {v for f in _front for v in f.verts}:
    _rows.setdefault(round(v.co.z, 4), []).append(v)
_top, _s = max(_rows), {}
for z, vs in _rows.items():
    vs.sort(key=lambda v: v.co.x)
    acc = 0.0
    for k, v in enumerate(vs):
        acc += (v.co - vs[k - 1].co).length if k else 0.0
        _s[v] = acc
for f in _front:
    for l in f.loops:
        l[_uvl].uv = (_s[l.vert] * _d, (_top - l.vert.co.z) * _d)
_bm.to_mesh(me)
_bm.free()
print(f'[curtain] 正面 {len(_front)} 个面按网格展开，{len(_rows)} 行')
lm = me.uv_layers['Lightmap']  # 进出编辑模式以后网格数据重建过，之前拿到的 UV 层引用会失效，按名字重新取
npoly = len(me.polygons)
k = np.empty(npoly, dtype=np.int32)
me.attributes['uvk'].data.foreach_get('value', k)
starts = np.empty(npoly, dtype=np.int32)
totals = np.empty(npoly, dtype=np.int32)
me.polygons.foreach_get('loop_start', starts)
me.polygons.foreach_get('loop_total', totals)
per_loop = np.repeat(k / 10.0, totals).astype(np.float32)  # 每个面的 loop 是连续存的
uv = np.empty(len(me.loops) * 2, dtype=np.float32)
lm.data.foreach_get('uv', uv)
uv = (uv.reshape(-1, 2) * per_loop[:, None]).ravel()
lm.data.foreach_set('uv', uv)
me.attributes.remove(me.attributes['uvk'])
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')
if 'uvk' in glow.data.attributes:
    glow.data.attributes.remove(glow.data.attributes['uvk'])
me.uv_layers['UVMap'].active_render = True  # 导出时 UVMap 是第一套（TEXCOORD_0），Lightmap 第二套
print(f'[uv] {time.time() - T0:.0f}s')


# ---------- 灯光（分四层烘焙） ----------
def light(name, kind, energy, color, pos, direction=None, **kw):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = srgb(color) if isinstance(color, str) else color
    for kk, v in kw.items():
        setattr(ld, kk, v)
    ob = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(ob)
    ob.location = tb(pos)
    if direction is not None:
        ob.rotation_euler = tb(direction).to_track_quat('-Z', 'Y').to_euler()
    return ob


def city_plane():
    """窗外：一块贴着夜景渲染图的发光板（只发光，不挡月光）。"""
    path = os.path.join(OUTD, 'view_full.jpg')
    d = 5.0
    w = 2 * d * math.tan(math.radians(VIEW['hfov'] / 2))
    h = w / VIEW['aspect']
    m = bpy.data.meshes.new('city')
    b = bmesh.new()
    mm = C @ M((WIN['x'], WIN['y'], BACK - d))
    b.faces.new([b.verts.new(mm @ Vector((sx * w / 2, sy * h / 2, 0))) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    b.to_mesh(m)
    b.free()
    mt = bpy.data.materials.new('city')
    nt = tree(mt)
    nt.nodes.clear()
    em, out = nt.nodes.new('ShaderNodeEmission'), nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    em.inputs['Strength'].default_value = 1.6
    if os.path.exists(path):
        tc = nt.nodes.new('ShaderNodeTexCoord')
        sep = nt.nodes.new('ShaderNodeSeparateXYZ')
        comb = nt.nodes.new('ShaderNodeCombineXYZ')
        img = nt.nodes.new('ShaderNodeTexImage')
        img.image = bpy.data.images.load(path)
        img.extension = 'EXTEND'
        nt.links.new(tc.outputs['Generated'], sep.inputs[0])
        nt.links.new(sep.outputs['X'], comb.inputs['X'])
        nt.links.new(sep.outputs['Z'], comb.inputs['Y'])
        nt.links.new(comb.outputs[0], img.inputs['Vector'])
        nt.links.new(img.outputs['Color'], em.inputs['Color'])
    else:
        print('[warn] 没找到 view_full.jpg（先跑 render_view.py），窗外用纯色代替')
        em.inputs['Color'].default_value = (*srgb('#3a2f66'), 1)
    m.materials.append(mt)
    ob = bpy.data.objects.new('city', m)
    ob.visible_shadow = False
    scene.collection.objects.link(ob)
    return ob


moon_dir = Vector(MOON).normalized()
LAYERS = {
    'ambient': [
        light('moon', 'SUN', 1.4, '#a9b8ff', (0, 5, -6), tuple(-moon_dir), angle=math.radians(1.5)),
        city_plane(),
        # 电脑屏幕：比原来的大一半，再亮一点，绿光能照到键盘和桌面上
        light('pc_screen', 'AREA', 2.4, (0.36, 1.0, 0.6), Vector(PC_SCREEN['pos']) + Vector(PC_SCREEN['normal']) * 0.01, PC_SCREEN['normal'],
              shape='RECTANGLE', size=PC_SCREEN['size'][0], size_y=PC_SCREEN['size'][1]),
    ],
    'room': [
        light('floor_lamp', 'POINT', 30, '#ffcf99', FLOOR_LAMP, shadow_soft_size=0.12),
        light('table_lamp', 'POINT', 18, '#ffcf99', (LAMP2[0], 1.1, LAMP2[2]), shadow_soft_size=0.06),
        # 窗上沿一条看不见的暖色长条面光，斜着往下照进屋里：顶替原来那串小灯泡照在墙上、桌上的光，但画面里没有发亮的灯泡
        light('window_fill', 'AREA', 14, '#ffc98a', (WIN['x'], wy1 - 0.08, BACK + 0.12), (0, -0.55, 1), shape='RECTANGLE', size=WIN['w'] - 0.2, size_y=0.12),
        # 书架前 75 厘米、稍高处一块看不见的暖色面光，朝着书架：书脊看得清，又没有一条条发亮的灯带
        light('shelf_fill', 'AREA', 4, '#ffd6a8', world(SHG, (0, 1.35, 0.6)), tuple(BC_R @ Vector((0, -0.2, -1))), shape='RECTANGLE', size=0.9, size_y=1.6),
    ],
    # 摇臂灯：灯头离桌面 52 厘米，光圈开到 120°、边缘放软，11 W 铺满左半张桌子（开关前后看得出区别），
    # 纸离灯约 60 厘米、在光斑偏左，不会照成死白（8 W 时开关只差一点点）
    'lamp': [
        light('lamp_spot', 'SPOT', 11, '#ffd2a0', tuple(LAMP_HEAD), tuple(LAMP_DIR), spot_size=math.radians(120), spot_blend=0.6, shadow_soft_size=0.025),
        light('lamp_bulb', 'POINT', 0.8, '#ffd2a0', tuple(LAMP_HEAD - LAMP_DIR * 0.02), shadow_soft_size=0.02),
    ],
    'tv': [
        light('tv_screen', 'AREA', 10, (1.0, 1.0, 1.0), Vector(TV_SCREEN['pos']) + Vector(TV_SCREEN['normal']) * 0.01, TV_SCREEN['normal'],
              shape='RECTANGLE', size=TV_SCREEN['size'][0], size_y=TV_SCREEN['size'][1]),
    ],
}
# area light 默认朝自己的 -Z 发光，上面 direction 已经对准
wd = bpy.data.worlds.new('Night')
scene.world = wd
wnt = tree(wd)
wnt.nodes.clear()
bg = wnt.nodes.new('ShaderNodeBackground')
wnt.links.new(bg.outputs[0], wnt.nodes.new('ShaderNodeOutputWorld').inputs['Surface'])
bg.inputs['Color'].default_value = (*srgb('#1a2040'), 1)

# ---------- Cycles ----------
use_metal(scene, A.samples)
scene.cycles.max_bounces = 4
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 0
scene.cycles.transmission_bounces = 0
scene.cycles.transparent_max_bounces = 12  # 光要穿过好几层镂空的叶片
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.render.bake.margin = 8
scene.render.bake.use_clear = True
scene.render.bake.use_pass_direct = True
scene.render.bake.use_pass_indirect = True
scene.render.bake.use_pass_color = False

S = A.size
bake_img = bpy.data.images.new('bake', S, S, alpha=False, float_buffer=True)
img_nodes = []
for mt in me.materials:
    n = mt.node_tree.nodes.new('ShaderNodeTexImage')
    n.image = bake_img
    mt.node_tree.nodes.active = n
    img_nodes.append((mt, n))


def save_encoded(img, path):
    px = np.empty(S * S * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    rgb = np.clip(px.reshape(-1, 4)[:, :3], 0, None)
    lum = rgb.max(axis=1)
    used = lum[lum > 1e-6]
    scale = float(np.percentile(used, 99.7)) if used.size else 1.0
    enc = np.ones((S * S, 4), dtype=np.float32)
    enc[:, :3] = np.clip(rgb / scale, 0, 1) ** (1 / 3)
    out = bpy.data.images.new(os.path.basename(path), S, S, alpha=False)
    out.colorspace_settings.name = 'Non-Color'
    out.pixels.foreach_set(enc.ravel())
    out.filepath_raw = path
    out.file_format = 'JPEG'
    try:
        out.save(filepath=path, quality=90)
    except TypeError:
        out.save()
    stats = {p: round(float(np.percentile(used, p)), 4) for p in (50, 90, 99)} if used.size else {}
    return scale, stats


_poster_restore = []
# 桌上那摞纸（材质名以 paper 开头）：网页里拿起来时藏起来，桌面上不能留它的影子
for _pmn in [m.name for m in me.materials if m.name.startswith('poster') or m.name.startswith('paper')]:  # 海报、胶带不挡光、不反光：墙上不留影子
    _nt = me.materials[_pmn].node_tree
    _out = next(n for n in _nt.nodes if n.type == 'OUTPUT_MATERIAL')
    _bsdf = next(n for n in _nt.nodes if n.type == 'BSDF_PRINCIPLED')
    _lp, _trn, _mx = _nt.nodes.new('ShaderNodeLightPath'), _nt.nodes.new('ShaderNodeBsdfTransparent'), _nt.nodes.new('ShaderNodeMixShader')
    _nt.links.new(_lp.outputs['Is Camera Ray'], _mx.inputs['Fac'])
    _nt.links.new(_trn.outputs[0], _mx.inputs[1])
    _nt.links.new(_bsdf.outputs[0], _mx.inputs[2])
    _nt.links.new(_mx.outputs[0], _out.inputs['Surface'])
    _poster_restore.append((_nt, _out, _bsdf, (_lp, _trn, _mx)))
bpy.ops.object.select_all(action='DESELECT')
room.select_set(True)
bpy.context.view_layer.objects.active = room
manifest = {'size': S, 'samples': A.samples, 'blender': bpy.app.version_string, 'built': time.strftime('%Y%m%d-%H%M%S'), 'layers': {}}
T0 = time.time()
all_lights = [ob for obs in LAYERS.values() for ob in obs]
old = {}
if A.skip_bake:
    with open(os.path.join(OUTD, 'manifest.json')) as f:
        old = json.load(f)
    manifest.update({k: old[k] for k in ('size', 'samples', 'built', 'layers')})
    print('[bake] 跳过烘焙，沿用', old['built'])
for layer, obs in ([] if A.skip_bake else LAYERS.items()):
    for ob in all_lights:
        ob.hide_render = ob not in obs
    bg.inputs['Strength'].default_value = 0.3 if layer == 'ambient' else 0.0
    t0 = time.time()
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True, uv_layer='Lightmap')
    file = f'lm_{layer}.jpg'
    scale, stats = save_encoded(bake_img, os.path.join(OUTD, file))
    manifest['layers'][layer] = {'file': file, 'scale': scale}
    print(f'[bake] {layer}: {time.time() - t0:.1f}s, scale={scale:.4f}, percentiles={stats}')

# ---------- 导出 ----------
for mt, n in img_nodes:
    mt.node_tree.nodes.remove(n)
for _nt, _out, _bsdf, _extra in _poster_restore:  # 海报、胶带的材质恢复成普通的纸（导出器认得出贴图）
    _nt.links.new(_bsdf.outputs[0], _out.inputs['Surface'])
    for _n in _extra:
        _nt.nodes.remove(_n)
glow.hide_render = False
bpy.ops.object.select_all(action='DESELECT')
room.select_set(True)
glow.select_set(True)
bpy.context.view_layer.objects.active = room
bpy.ops.export_scene.gltf(filepath=os.path.join(OUTD, 'room.glb'), export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=False, export_materials='EXPORT', export_normals=False,
                          export_vertex_color='NONE', export_image_format='JPEG', export_jpeg_quality=82,
                          export_lights=False, export_cameras=False,
                          # Draco 压缩几何（浏览器里用 three 的 DRACOLoader 解）。UV 给 14 位：2048 的光照贴图要精确到半个像素
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=14, export_draco_texcoord_quantization=14,
                          export_draco_normal_quantization=10, export_draco_generic_quantization=12)
r3 = lambda v: [round(float(c), 4) for c in v]  # noqa: E731
manifest.update({
    'seconds': old.get('seconds') if A.skip_bake else round(time.time() - T0),
    # 开场镜头：绕着电脑转（target = 转的中心，dist = 离它多远，yaw / pitch = 从哪个方向看过去）。
    # 拖动在 yawRange / pitchRange 里转，滚轮在 distRange 里拉近拉远；box = 镜头不能出去的范围（x 左右、z 最靠前、y 最低最高）
    'camera': {'target': r3(CAM['target']), 'dist': CAM['dist'], 'yaw': CAM['yaw'], 'pitch': CAM['pitch'], 'fov': CAM['fov'],
               'yawRange': list(CAM['yawRange']), 'pitchRange': list(CAM['pitchRange']), 'distRange': list(CAM['distRange']),
               'box': {'x': r3(CAM['box']['x']), 'z': round(CAM['box']['z'], 4), 'y': r3(CAM['box']['y'])}},
    'window': {'x': WIN['x'], 'y': WIN['y'], 'w': WIN['w'], 'h': WIN['h'], 'z': BACK, 'depth': WIN['depth']},
    # 屏幕：pos = 画面中心（在玻璃上），size = canvas 宽高；显像管是鼓的，grid / depth 是在 (nx+1)×(ny+1) 个点上量的玻璃深度
    # （沿屏幕自己的 z，按 PlaneGeometry 的顶点顺序），浏览器把平面弯成这样贴着玻璃；rot = 平面绕 Y 轴转多少（电视斜着放）
    'screens': {k: {'pos': r3(s['pos']), 'size': r3(s['size']), 'grid': list(s['grid']), 'depth': r3(s['depth']), 'rot': round(s['rot'], 4)}
                for k, s in (('pc', PC_SCREEN), ('tv', TV_SCREEN))},
    'emitters': EMIT,
    'cutout': CUTOUT,
    'tints': PAPER_TINT,  # 有贴图的材质在网页里再乘的颜色（桌上那摞纸在台灯底下，压暗一档）
    'deskcal': DESKCAL,
    'phone': {'wheel': PHONE_DIAL},  # 电话转盘：材质、圆心、法线（朝外）、半径，网页拨号时绕法线转（js/dial.js）
    'answering': ANSWERING,  # 桌子左头的答录机：MESSAGES 键旁边那条小灯（中心、法线、长边方向、宽高），网页里画成会闪的红灯
    'art': {'title': ART_TITLE},  # 墙角那幅画的名字（鼠标停在画上时的提示）
    'glass': {'window_glass': 0.16, 'poster_tape_shadow': 0.22},  # 窗玻璃：淡淡一层，窗外隔着玻璃；海报胶带底下的影子
    'vendor': USED,
    'tapes': {'count': len(TAPE_COLORS), 'colors': TAPE_COLORS, 'slot': r3(VCR_SLOT), 'yaw': CART_ROT,  # yaw = 录像机绕 Y 轴转了多少
              'sleeve': {'cols': r3(SLEEVE_COLS), 'len': round(SLEEVE[0], 4)}},  # 纸盒包装的版面：各栏宽、高（米）
    # 书架上的真书（顺序 = index.html 里 #shelf 的 li）：材质 realbook{i}（书皮，UVMap = [封底 | 书脊 | 封面]）+ realbook{i}_pages；
    # pos = 书的中心，size = 宽 × 高 × 厚（米）。书都立着、书脊朝 +z、封面朝 +x
    # 照片墙（软木板）：center = 板面中心（板面朝 -x，看的人的右手边是 +z），size = 宽 × 高
    'photos': {'center': r3(CORK_FRAME['center']), 'size': r3(CORK_FRAME['size']), 'normal': [-1, 0, 0], 'right': [0, 0, 1]},
    'books': {'items': [dict(b, pos=r3(b['pos']), size=r3(b['size'])) for b in REAL_BOOKS], 'yaw': round(BC_ROT, 4)},  # yaw：书柜朝向（书往哪抽）
    'hotspots': HOT,
    'views': {k: {'target': r3(v['target']), 'size': list(v['size']), 'dir': r3(Vector(v['dir']).normalized())} for k, v in VIEWS.items()},
})
with open(os.path.join(OUTD, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print('[done]', OUTD)
