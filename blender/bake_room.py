# 用 Python 驱动 Blender：搭房间 → Cycles 分层烘焙光照 → 导出 glTF + lightmap。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/bake_room.py -- --size 2048 --samples 256
#
# 先跑 render_view.py（窗外夜景），这里会把 view_full.jpg 当成窗外的发光板，让城市的光照进屋里。
#
# 第三方模型（电脑、电视、书柜、唱机、台灯、椅子、地毯）从 vendor-src/ 导入（blender/room_vendor.py），和房间合成一个网格一起烘焙。
# 素材的来源和许可证见 assets/vendor/credits.json；manifest.vendor 记下这个场景用了哪些。
#
# 产物（assets/baked/）：
#   room.glb         静态几何（Room：烘焙物件，两套 UV：UVMap 给颜色贴图、Lightmap 给光照；Glow：灯泡、灯罩、灯带，浏览器里画成自发光）
#                    Draco 压缩，不带法线（光照是烘焙好的，用不到）
#   lm_ambient.jpg   月光 + 窗外城市光 + 电脑屏幕
#   lm_room.jpg      屋里的灯：落地灯、窗上的串灯、书架灯带、柜子上的台灯
#   lm_lamp.jpg      书桌台灯
#   lm_tv.jpg        电视（按白光烘焙，浏览器里按画面颜色染色）
#   manifest.json    每层的亮度系数、开场镜头、屏幕和发光体的位置、可点物件的热点盒子、点了之后镜头对准哪里
#
# 编码：贴图里存的是 (光照 / scale) ^ (1/3)，浏览器里用 c*c*c*scale 还原，8 位 JPG 也能存下较大的亮度范围。
# 坐标：尺寸都按 three.js 的写法（Y 向上，单位米），最后统一转成 Blender 的 Z 向上。
import json
import math
from contextlib import contextmanager
import os
import random
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import BACK, MOON, OUT, ROOM, TOP, VIEW, WIN, get_args, srgb, tree, clear_scene, use_metal  # noqa: E402
from room_vendor import Asset, plain_material, screen_grid, world_points  # noqa: E402

# --skip-bake 1：几何没变、只改了热点 / 镜头时用，沿用现有的光照贴图
# --preview 目录：只搭几何，用 Workbench 从开场镜头拍几张图（几秒钟），摆位置的时候用，不烘焙也不导出
A = get_args(size=2048, samples=256, out='', skip_bake=0, preview='')
OUTD = A.out or OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
rnd = random.Random(42)

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
    T.tag(_faces(r['verts']), mi)


def quad(g, w, h, mi, pos, rot=(0, 0, 0)):
    m = C @ g @ M(pos, rot)
    vs = [T.bm.verts.new(m @ Vector((sx * w / 2, sy * h / 2, 0))) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    T.tag([T.bm.faces.new(vs)], mi)


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


def put(asset, at, uvk=10, **kw):
    """摆一个素材（参数见 Asset.place）。返回 (物件列表, T)，T：素材坐标 → 世界坐标（three）。"""
    obs, Tm = asset.place(at, **kw)
    PLACED.extend((ob, uvk) for ob in obs)
    if HOT_ID:
        HOT_PTS.setdefault(HOT_ID, []).extend(map(tuple, world_points(obs)))
    if asset.source not in USED:
        USED.append(asset.source)
    return obs, Tm


def screen_log(name, s):
    print(f"[{name}] 玻璃 {s['glass'][0]:.3f} × {s['glass'][1]:.3f}，画面 {s['size'][0]:.3f} × {s['size'][1]:.3f}，"
          f"中心到边最多往后 {s['sag'] * 1000:.0f} mm，法线 {tuple(round(v, 2) for v in s['normal'])}，没打中 {s['miss']} 个点")


def at3(Tm, p):
    """素材坐标里的一点 → 世界坐标（three）。"""
    return Tm @ Vector(tuple(p))


# ---------- 房间外壳：单面片，法线朝里（Cycles 里单面片也挡光）。天花板单独做成只挡光的物件，不导出 ----------
x0, x1, z1, RH = ROOM['x0'], ROOM['x1'], ROOM['z1'], ROOM['h']
W, Dp = x1 - x0, z1 - BACK
wall = mat('wall', '#bdb3a0')
quad(I, W, Dp, mat('floor', '#6e4d34'), (0, 0, (BACK + z1) / 2), (-math.pi / 2, 0, 0))
quad(I, Dp, RH, wall, (x0, RH / 2, (BACK + z1) / 2), (0, math.pi / 2, 0))
quad(I, Dp, RH, wall, (x1, RH / 2, (BACK + z1) / 2), (0, -math.pi / 2, 0))
K = 5  # 身后的墙几乎看不到，给少一点贴图
quad(I, W, RH, wall, (0, RH / 2, z1), (0, math.pi, 0))
K = 10
wx0, wx1 = WIN['x'] - WIN['w'] / 2, WIN['x'] + WIN['w'] / 2
wy0, wy1 = WIN['y'] - WIN['h'] / 2, WIN['y'] + WIN['h'] / 2
dep = WIN['depth']
quad(I, wx0 - x0, RH, wall, ((x0 + wx0) / 2, RH / 2, BACK))
quad(I, x1 - wx1, RH, wall, ((x1 + wx1) / 2, RH / 2, BACK))
quad(I, WIN['w'], wy0, wall, (WIN['x'], wy0 / 2, BACK))
quad(I, WIN['w'], RH - wy1, wall, (WIN['x'], (wy1 + RH) / 2, BACK))
quad(I, dep, WIN['h'], wall, (wx0, WIN['y'], BACK - dep / 2), (0, math.pi / 2, 0))
quad(I, dep, WIN['h'], wall, (wx1, WIN['y'], BACK - dep / 2), (0, -math.pi / 2, 0))
quad(I, WIN['w'], dep, wall, (WIN['x'], wy1, BACK - dep / 2), (math.pi / 2, 0, 0))
sk = mat('skirting', '#3a2b20')
box(I, W, 0.09, 0.015, sk, 0, 0.045, BACK + 0.008)
box(I, 0.015, 0.09, Dp, sk, x0 + 0.008, 0.045, (BACK + z1) / 2)
box(I, 0.015, 0.09, Dp, sk, x1 - 0.008, 0.045, (BACK + z1) / 2)
# 波斯地毯：原作约 3 × 5.2 米，缩到约 1.6 × 2.8 米，长边沿 x（素材的长边沿 z，转 90°）
RUG = Asset('sketchfab/persian-rug', 'rug', texsize=1024)
put(RUG, G((0.0, 0.002, -0.5), (0, math.pi / 2, 0)), uvk=8, scale=0.0054)

# 窗：黑色细钢框，三扇竖分 + 上面一条横档；窗台是一块浅色石板
fr = mat('frame', '#24211e')
g = G((WIN['x'], WIN['y'], BACK - dep + 0.035))
t, td = 0.05, 0.05
box(g, WIN['w'], t, td, fr, 0, WIN['h'] / 2 - t / 2, 0)
box(g, WIN['w'], t, td, fr, 0, -WIN['h'] / 2 + t / 2, 0)
box(g, t, WIN['h'], td, fr, -WIN['w'] / 2 + t / 2, 0, 0)
box(g, t, WIN['h'], td, fr, WIN['w'] / 2 - t / 2, 0, 0)
for x in (-0.5, 0.5):
    box(g, 0.035, WIN['h'], 0.04, fr, x, 0, 0)
box(g, WIN['w'], 0.035, 0.04, fr, 0, 0.42, 0)
box(I, WIN['w'] + 0.1, 0.03, dep + 0.05, mat('sill', '#d6d0c4'), WIN['x'], wy0 + 0.015, BACK - dep / 2 + 0.025)
# 窗台上的小东西：多肉、两本书
g = G((-1.15, wy0 + 0.03, BACK - 0.035))
cyl(g, 0.045, 0.035, 0.07, 16, mat('pot', '#a5603f'), (0, 0.035, 0))
for i in range(7):
    a = i / 7 * math.tau
    box(g, 0.025, 0.04, 0.012, mat('leaf', '#4f7a45'), math.cos(a) * 0.022, 0.085, math.sin(a) * 0.022, (0.5 * math.sin(a), a, 0.5 * math.cos(a)))
g = G((1.2, wy0 + 0.03, BACK - 0.035), (0, 0.1, 0))
box(g, 0.2, 0.03, 0.1, mat('book_a', '#3b5a7a'), 0, 0.015, 0)
box(g, 0.18, 0.025, 0.09, mat('book_b', '#8a3b30'), 0.01, 0.0425, 0, (0, 0.12, 0))

# ---------- 书桌：窗下，宽 2.3 米 ----------
K = 25
g = G((0, 0, BACK + 0.43))
wood = mat('desk', '#7a5536')
box(g, 2.3, 0.04, 0.8, wood, 0, TOP - 0.02, 0)
box(g, 0.42, TOP - 0.04, 0.74, wood, 0.9, (TOP - 0.04) / 2, 0)        # 右边抽屉柜
for y in (0.18, 0.42, 0.62):
    box(g, 0.38, 0.005, 0.01, mat('desk_line', '#4a3220'), 0.9, y, 0.372)
    box(g, 0.09, 0.012, 0.015, mat('brass', '#b8945a'), 0.9, y + 0.08, 0.378)
for sz in (-1, 1):
    box(g, 0.045, TOP - 0.04, 0.045, wood, -1.1, (TOP - 0.04) / 2, sz * 0.35)
box(g, 0.03, 0.06, 0.66, wood, -1.1, 0.12, 0)

# 电脑：黑色复古一体机（底座前面自带小键盘）。素材正面朝 +x，转 -90° 朝屋里。
# 屏幕玻璃换成深色，浏览器在上面贴一块按玻璃弧度弯过的 canvas（弧度在这里量好写进 manifest）。
PC = Asset('sketchfab/retro-computer', 'pc', texsize=1024, decimate={'Part2': 0.3, 'Part1': 0.6})
pc_glass = plain_material('pc_glass', '#0c0f0e')
PC.islands('Part1', (0.06, -0.21, -0.52), (0.215, 0.66, 0.52), material=pc_glass)
with hot('about'):
    pc_obs, _ = put(PC, G((-0.38, TOP, -1.66), (0, -math.pi / 2, 0)), uvk=25, scale=0.31)
PC_SCREEN = screen_grid(pc_obs, pc_glass, frac=0.82)  # 玻璃四角是圆的，边上往后卷：画面占玻璃宽度的 82%
screen_log('pc', PC_SCREEN)
# 玻璃往后仰：镜头顺着玻璃的法线再稍微高一点看
VIEWS['about'] = dict(target=PC_SCREEN['pos'], size=(0.175, 0.14), dir=tuple(Vector(PC_SCREEN['normal']) + Vector((0, 0.08, 0))))
# 键盘、轨迹球是电脑素材自带的，原来的键盘、鼠标、鼠标垫和线都不要了

# 书桌台灯：银行家台灯，放在左后方，灯罩朝右前方（键盘、记事本）。
# 素材里的灯泡面删掉，原地放一个 Glow 小球；灯光（spot + 点光）也放在灯泡那里，往前下方照
LAMP = Asset('sketchfab/victorian-desk-lamp', 'lamp', texsize=512)
bulb = LAMP.islands('*', (-243.6, 67.0, -13.6), (-238.0, 72.6, -8.2), delete=True)
LAMP_ROT = -0.95  # 素材正面（+x）转到世界的 (0.58, 0, 0.81)
with hot('lamp'):
    _, T_lamp = put(LAMP, G((-0.93, TOP, -1.80), (0, LAMP_ROT, 0)), uvk=25, height=0.42)
    LAMP_HEAD = at3(T_lamp, bulb.mean(0))
    fwd = Vector((math.cos(LAMP_ROT), 0, -math.sin(LAMP_ROT)))
    LAMP_DIR = (fwd * 0.55 + Vector((0, -1, 0))).normalized()
    r_bulb = float((bulb.max(0) - bulb.min(0)).max()) / 2 * T_lamp.to_scale()[0]
    with glow():
        ball(tuple(LAMP_HEAD), r_bulb, emit('emit.lamp.bulb', 'lamp', '#ffe2b8', 6.0), 2)
print(f'[lamp] 灯泡 {tuple(round(v, 3) for v in LAMP_HEAD)}，半径 {r_bulb * 1000:.0f} mm')

# 书堆、记事本、笔、笔筒
g = G((-0.79, TOP, -1.60), (0, 0.18, 0))
y = 0
for i, (w, h, d, c) in enumerate([(0.24, 0.035, 0.17, '#5a2e2e'), (0.22, 0.03, 0.16, '#2f4a3d'), (0.2, 0.04, 0.15, '#b49a62')]):
    box(g, w, h, d, mat(f'stack{i}', c), 0.005 * i, y + h / 2, 0, (0, (-1) ** i * 0.06, 0))
    y += h
NOTE_ROT = 0.28  # 记事本 = 联系方式（浏览器在纸面上画字，材质名 notepad 的顶面）
g = G((-0.86, TOP, -1.34), (0, NOTE_ROT, 0))
with hot('online', NOTE_ROT):
    box(g, 0.15, 0.012, 0.21, mat('notepad', '#ddd5c2'), 0, 0.006, 0)
    box(g, 0.15, 0.004, 0.025, mat('notepad_top', '#8b2f2f'), 0, 0.014, -0.095)
    rod(world(g, (0.062, 0.017, 0.08)), world(g, (0.07, 0.017, -0.07)), 0.0045, mat('pen', '#1f3b6e'), 8)  # 笔压在右边沿，不挡纸上的字
# 从正上方偏一点往下看，镜头转到和本子一样的角度，纸面在画面里是正的
VIEWS['online'] = dict(target=world(g, (0, 0.012, 0.01)), size=(0.12, 0.14), dir=(math.sin(NOTE_ROT) * 0.45, 1.0, math.cos(NOTE_ROT) * 0.45))
g = G((-0.05, TOP, -1.80))
cyl(g, 0.035, 0.035, 0.1, 16, mat('pencup', '#3d4a52'), (0, 0.05, 0))
for i, c in enumerate(['#d8a53a', '#c94c3c', '#3a6db0']):
    a = i * 2.1
    rod(world(g, (math.cos(a) * 0.012, 0.03, math.sin(a) * 0.012)), world(g, (math.cos(a) * 0.03, 0.18, math.sin(a) * 0.03)), 0.0035, mat(f'pencil{i}', c), 6)

# 录像带架（4 盘带子，侧标朝前）
# 每盘带子用自己的材质（tape0 / label0 …），浏览器按材质名把它们拆出来单独移动；侧标颜色在网页里按 HTML 的 data-color 换
g = G((0.18, TOP, -1.80))
rack = mat('rack', '#5b3d26')
TAPE_COLORS = ['#e8b04a', '#e0577a', '#4fa3e0', '#59c27a']
with hot('work'):
    box(g, 0.16, 0.015, 0.21, rack, 0, 0.0075, 0)
    for sx in (-1, 1):
        box(g, 0.01, 0.12, 0.21, rack, sx * 0.075, 0.06, 0)
    for i, c in enumerate(TAPE_COLORS):
        x = -0.0525 + i * 0.035
        box(g, 0.026, 0.103, 0.187, mat(f'tape{i}', '#141414'), x, 0.015 + 0.0515, 0)
        box(g, 0.02, 0.08, 0.002, mat(f'label{i}', c), x, 0.015 + 0.0515, 0.0945)

# 录像机 + 上面的 CRT 电视 + 天线。电视素材自带的屏幕画面（Object_6）不要，玻璃（Object_8）换成深色，
# 浏览器在上面贴一块弯过的 canvas；素材没有录像带口，所以下面垫一台自己搭的薄录像机
TVA = Asset('sketchfab/retro-crt-tv', 'tv', texsize=1024, drop=('Object_6',))
tv_glass = plain_material('tv_glass', '#0b0d0e')
TVA.islands('Object_8', (-9, -9, -9), (9, 9, 9), material=tv_glass)
g = G((0.62, TOP, -1.76))
VCR_H, VCR_D = 0.07, 0.32
with hot('work'):
    box(g, 0.40, VCR_H, VCR_D, mat('vcr', '#1f1e1d'), 0, VCR_H / 2, 0)
    box(g, 0.13, 0.03, 0.004, mat('slot', '#050505'), -0.07, 0.04, VCR_D / 2)
    box(g, 0.06, 0.016, 0.004, mat('vcr_display', '#1d3a2b'), 0.1, 0.046, VCR_D / 2)
    for i in range(4):
        box(g, 0.02, 0.01, 0.006, mat('button', '#6e6a64'), 0.055 + i * 0.03, 0.019, VCR_D / 2)
    tv_obs, _ = put(TVA, g @ M((0, VCR_H, -0.005), (0, -math.pi / 2, 0)), uvk=25, scale=0.56)
VCR_SLOT = world(g, (-0.07, 0.04, VCR_D / 2))
TV_SCREEN = screen_grid(tv_obs, tv_glass, frac=0.94)
screen_log('tv', TV_SCREEN)
tv_top = float(world_points(tv_obs)[:, 1].max()) - TOP
rod(world(g, (0.05, tv_top, -0.05)), world(g, (-0.12, tv_top + 0.32, -0.12)), 0.0035, mat('chrome', '#9a9a9a'), 6)
rod(world(g, (0.07, tv_top, -0.05)), world(g, (0.26, tv_top + 0.28, -0.1)), 0.0035, mat('chrome', '#9a9a9a'), 6)
# 电视和左边的录像带架一起装进画面，稍微从上往下看，看得到带子
VIEWS['work'] = dict(target=(0.46, TOP + 0.23, -1.66), size=(0.40, 0.27), dir=(-0.15, 0.35, 1))

# 咖啡杯、眼镜、遥控器
g = G((0.24, TOP, -1.50))
cup = mat('mug', '#e8e2d4')
cyl(g, 0.042, 0.04, 0.095, 24, cup, (0, 0.0475, 0))
cyl(g, 0.037, 0.037, 0.002, 24, mat('coffee', '#2a160c'), (0, 0.085, 0))
box(g, 0.012, 0.055, 0.035, cup, 0.05, 0.05, 0)
g = G((0.40, TOP, -1.32), (0, 0.35, 0))
gm = mat('glasses', '#1a1a1a')
for sx in (-1, 1):
    cyl(g, 0.026, 0.026, 0.004, 20, mat('lens', '#5d6d72'), (sx * 0.032, 0.026, 0), (math.pi / 2 - 0.25, 0, 0))
    box(g, 0.004, 0.004, 0.13, gm, sx * 0.058, 0.008, -0.06, (0, sx * 0.12, 0))
box(g, 0.016, 0.004, 0.004, gm, 0, 0.034, 0.004)
g = G((0.82, TOP, -1.38), (0, -0.5, 0))
box(g, 0.05, 0.02, 0.17, mat('remote', '#2a2a2c'), 0, 0.01, 0)
for i in range(6):
    box(g, 0.01, 0.004, 0.01, mat('rbtn', '#8a8580'), (i % 2 - 0.5) * 0.02, 0.021, -0.05 + (i // 2) * 0.03)
box(g, 0.014, 0.004, 0.014, mat('rbtn_red', '#b83a2e'), 0, 0.021, 0.055)

# 盆栽（桌子右端）
g = G((1.0, TOP, -1.80))
cyl(g, 0.08, 0.06, 0.13, 20, mat('pot', '#a5603f'), (0, 0.065, 0))
cyl(g, 0.072, 0.072, 0.004, 20, mat('soil', '#2b1d14'), (0, 0.12, 0))
leaf = mat('leaf', '#4f7a45')
leaf2 = mat('leaf2', '#36603a')
for i in range(14):
    a = i * 2.4 + rnd.uniform(-0.2, 0.2)
    tilt = rnd.uniform(0.15, 0.6)
    L = rnd.uniform(0.22, 0.36)
    box(g, 0.035, L, 0.006, leaf if i % 2 else leaf2, math.cos(a) * 0.03, 0.12 + L / 2 * math.cos(tilt), math.sin(a) * 0.03,
        (tilt * math.sin(a), -a, tilt * math.cos(a)))

# ---------- 左墙：大书柜（需要转头才能看到），每一格的隔板下面一段灯带 ----------
# 素材：四列六层，下面一排柜门，书是素材自带的（贴图）。原作 4.5 米高，缩到 2.15 米
K = 12
BOOKCASE = Asset('sketchfab/antique-wooden-bookcase-game-model', 'shelf', texsize=1024)
g = G((x0 + 0.017, 0, -0.22), (0, math.pi / 2, 0))  # 本地 +z 朝屋里（世界 +x），本地 x 沿墙（世界 -z）；背板让开踢脚线
with hot('shelf'):
    _, T_sh = put(BOOKCASE, g, uvk=12, height=2.15, anchor=(0.5, 0.0, 0.0))
SH_S = T_sh.to_scale()[0]
# 素材坐标里量好的：每层隔板的底面高度、隔板前沿、四列的中心（每格内宽 0.81）
SH_UNDER = [1.489, 2.033, 2.577, 3.123, 3.667, 4.209]
SH_FRONT, SH_COLS, SH_CELL = 0.373, (-1.35, -0.45, 0.45, 1.35), 0.81
SHELF_LEDS = []
for yu in SH_UNDER:
    for cx in SH_COLS:
        SHELF_LEDS.append((tuple(at3(T_sh, (cx, yu - 0.012, SH_FRONT - 0.03))), (SH_CELL - 0.06) * SH_S))
VIEWS['shelf'] = dict(target=tuple(at3(T_sh, (0, 2.6, 0.68))), size=(0.96, 0.86), dir=(1, 0.06, 0))

# 书架旁边的落地大盆栽（左后角）
g = G((-2.08, 0, -1.6))
cyl(g, 0.2, 0.16, 0.42, 24, mat('planter', '#3c3a36'), (0, 0.21, 0))
cyl(g, 0.19, 0.19, 0.005, 24, mat('soil', '#2b1d14'), (0, 0.4, 0))
rod((-2.08, 0.4, -1.6), (-2.04, 1.25, -1.55), 0.018, mat('trunk', '#5a4330'))
for i in range(46):
    u, v = rnd.uniform(0, math.tau), rnd.uniform(-0.9, 1)
    r = 0.38 * math.sqrt(1 - v * v) + 0.05
    p = Vector((-2.04 + math.cos(u) * r, 1.3 + v * 0.42, -1.55 + math.sin(u) * r * 0.85))
    box(I, 0.17, 0.01, 0.12, leaf if i % 3 else leaf2, *p, (rnd.uniform(-0.9, 0.9), u, rnd.uniform(-0.6, 0.6)))

# ---------- 右墙：矮柜 + 唱机 + 唱片 + 台灯，墙上一幅画；右后角一盏落地灯 ----------
K = 10
g = G((x1, 0, 0.15), (0, -math.pi / 2, 0))  # 本地 +z 朝屋里（世界 -x），本地 x 沿墙（世界 +z）
cab = mat('sideboard', '#6a4a30')
box(g, 1.7, 0.6, 0.45, cab, 0, 0.42, 0.24)
for sx in (-1, 1):
    for sz in (-1, 1):
        rod(world(g, (sx * 0.78, 0.12, 0.24 + sz * 0.18)), world(g, (sx * 0.8, 0.0, 0.24 + sz * 0.2)), 0.015, mat('dark', '#26231f'), 8)
for xx in (-0.42, 0.42):
    box(g, 0.8, 0.54, 0.005, mat('sideboard_door', '#7a5838'), xx, 0.42, 0.468)
    box(g, 0.012, 0.1, 0.02, mat('brass', '#b8945a'), xx + (0.33 if xx < 0 else -0.33), 0.45, 0.475)
# 唱机：Yamaha TT-300（单位厘米），去掉掀起来的防尘盖；唱臂和机身减面。唱盘上放一张自己搭的黑胶（盖住素材的商标）
TT = Asset('sketchfab/yamaha-tt-300-record-player', 'tt', texsize=1024, drop=('*Cover*',),
           decimate={'*Tone_Arm_#*': 0.15, '*Yamaha_TT-300*': 0.45})
_, T_tt = put(TT, g @ M((-0.35, 0.72, 0.24)), uvk=15, scale=0.01)
rec = at3(T_tt, (-4.826, 5.79, -3.445))  # 唱盘垫的中心和高度（素材坐标里量的）
cyl(I, 0.148, 0.148, 0.002, 48, mat('record', '#111111'), (rec.x, rec.y + 0.001, rec.z))
cyl(I, 0.045, 0.045, 0.001, 24, mat('record_label', '#c94c3c'), (rec.x, rec.y + 0.0025, rec.z))
for i, c in enumerate(['#2e4a7a', '#d8a53a', '#7a2e2e']):
    box(g, 0.31, 0.31, 0.006, mat(f'lp{i}', c), 0.25 + i * 0.01, 0.72 + 0.155, 0.08 + i * 0.012, (-0.16, 0, 0))
LAMP2 = world(g, (0.62, 0.72, 0.24))
with hot('room'):
    cyl(g, 0.06, 0.07, 0.02, 20, mat('brass', '#b8945a'), (0.62, 0.73, 0.24))
    rod(world(g, (0.62, 0.74, 0.24)), world(g, (0.62, 1.02, 0.24)), 0.008, mat('brass', '#b8945a'))
    with glow():
        cyl(I, 0.09, 0.11, 0.16, 24, emit('emit.room.shade', 'room', '#ffd7a0', 1.6), (LAMP2[0], 1.1, LAMP2[2]), caps=False)
# 墙上的画：三块色块的抽象画
box(g, 0.92, 0.68, 0.03, mat('frame_pic', '#2a2420'), 0, 1.62, 0.015)
quad(g, 0.84, 0.6, mat('canvas', '#e6dcc8'), (0, 1.62, 0.031))
for (x, y, w, h, c) in [(-0.18, 1.7, 0.36, 0.3, '#c2553a'), (0.16, 1.52, 0.4, 0.22, '#2f5a7a'), (0.24, 1.78, 0.18, 0.18, '#e0b04a')]:
    quad(g, w, h, mat(f'paint_{c}', c), (x, y, 0.032))

FLOOR_LAMP = (2.05, 1.62, -0.92)  # 椅子后面、餐边柜前面；离右墙 0.45 m，不然墙会烧白
fl = FLOOR_LAMP
with hot('room'):
    cyl(I, 0.15, 0.16, 0.025, 28, mat('dark', '#26231f'), (fl[0], 0.0125, fl[2]))
    rod((fl[0], 0.02, fl[2]), (fl[0], 1.5, fl[2]), 0.011, mat('dark', '#26231f'))
    with glow():
        cyl(I, 0.17, 0.22, 0.32, 32, emit('emit.room.shade', 'room', '#ffd7a0', 1.6), (fl[0], fl[1] + 0.02, fl[2]), caps=False)

# 扶手椅：右前方墙角的阅读角，斜着朝屋里，落地灯在它旁边（不挡开场镜头，也不挡往右看唱机）
CHAIR = Asset('polyhaven/GreenChair_01', 'chair', texsize=512)
put(CHAIR, G((1.75, 0, -1.5), (0, -0.64, 0)), uvk=10)

# ---------- 窗上的串灯：两段下垂的弧线，16 个小灯泡 ----------
BULBS = []
N_B = 16
for i in range(N_B):
    s = i / (N_B - 1)
    x = -1.72 + 3.44 * s
    seg = (s * 2) % 1 if s < 1 else 1
    y = wy1 + 0.12 - 0.11 * math.sin(math.pi * seg)
    BULBS.append((x, y, BACK + 0.03))
wire = mat('wire', '#1c1a18')
for a, b in zip(BULBS, BULBS[1:]):
    rod(a, b, 0.0025, wire, 4, False)

# ---------- Glow：灯泡、灯罩、灯带。不参与烘焙（光由下面的灯光对象负责），浏览器里画成自发光 ----------
# （台灯灯泡、落地灯和柜上台灯的灯罩已经在上面跟着各自的灯建好了）
T, K = GLOWM, 10
for p in BULBS:
    ball(p, 0.017, emit('emit.room.bulbs', 'room', '#ffc98a', 5.0), 1)
for (p, length) in SHELF_LEDS:
    box(I, 0.012, 0.006, length, emit('emit.room.led', 'room', '#ffd09a', 3.0), p[0], p[1], p[2])


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


room = build(ROOMM)
glow = build(GLOWM)
glow.hide_render = True
me = room.data
# 两套 UV：UVMap（第一套）给第三方模型的颜色贴图，房间自己搭的面用不到（全是 0）；Lightmap（第二套）下面再展
me.uv_layers.new(name='UVMap')
for ob, uvk in PLACED:
    a = ob.data.attributes.new('uvk', 'INT', 'FACE')
    a.data.foreach_set('value', [uvk] * len(ob.data.polygons))
join(room, [ob for ob, _ in PLACED])
me = room.data
print(f'[geo] Room {len(me.polygons)} faces / {sum(len(p.vertices) - 2 for p in me.polygons)} tris / {len(me.materials)} materials, '
      f'Glow {len(glow.data.polygons)} faces；素材 {len(USED)} 个')


def preview_shots(out):
    """Workbench 快速预览：从开场镜头的几个角度拍，看第三方模型摆得对不对（颜色贴图 + 简单光照，不是烘焙效果）。"""
    os.makedirs(out, exist_ok=True)
    me.uv_layers.active = me.uv_layers['UVMap']
    scene.render.engine = 'BLENDER_WORKBENCH'
    sh = scene.display.shading
    sh.light, sh.color_type = 'STUDIO', 'TEXTURE'
    sh.show_shadows = True
    scene.render.resolution_x, scene.render.resolution_y = 1280, 800
    ceiling_ob = bpy.data.objects.get('Ceiling')
    if ceiling_ob:
        ceiling_ob.hide_render = True
    cd = bpy.data.cameras.new('cam')
    cd.sensor_fit, cd.angle_y = 'VERTICAL', math.radians(55)
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    pos = Vector((0.05, 1.32, -0.26))
    for name, yaw, pitch in (('home', 0.04, -0.13), ('left', 1.25, -0.15), ('right', -1.25, -0.2), ('down', 0.1, -0.7)):
        d = Vector((-math.sin(yaw) * math.cos(pitch), math.sin(pitch), -math.cos(yaw) * math.cos(pitch)))
        cam.location = tb(pos)
        cam.rotation_euler = tb(d).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out, f'{name}.png')
        bpy.ops.render.render(write_still=True)
        print('[preview]', scene.render.filepath)

# 天花板：只在烘焙时挡光、反光，不导出（浏览器里看不到天花板，房间显得开阔）
CEIL = Mesh('Ceiling')
T = CEIL
quad(I, W, Dp, CEIL.mat('ceiling', '#d8d2c6'), (0, RH, (BACK + z1) / 2), (math.pi / 2, 0, 0))
ceiling = build(CEIL)
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
        light('pc_screen', 'AREA', 1.2, (0.36, 1.0, 0.6), Vector(PC_SCREEN['pos']) + Vector(PC_SCREEN['normal']) * 0.01, PC_SCREEN['normal'],
              shape='RECTANGLE', size=PC_SCREEN['size'][0], size_y=PC_SCREEN['size'][1]),
    ],
    'room': [
        light('floor_lamp', 'POINT', 30, '#ffcf99', FLOOR_LAMP, shadow_soft_size=0.12),
        light('table_lamp', 'POINT', 18, '#ffcf99', (LAMP2[0], 1.1, LAMP2[2]), shadow_soft_size=0.06),
        *[light(f'bulb{i}', 'POINT', 0.7, '#ffc98a', (p[0], p[1] - 0.01, p[2] + 0.01), shadow_soft_size=0.015) for i, p in enumerate(BULBS)],
        # 不给方向 = 默认朝下（-Z），size_y 沿书架方向（three 的 z）。每格一段（原来一层一条 1.6 米 5 W，按长度折算再亮一点）
        *[light(f'led{i}', 'AREA', 1.4, '#ffd09a', (p[0] - 0.01, p[1] - 0.006, p[2]), None, shape='RECTANGLE', size=0.02, size_y=length)
          for i, (p, length) in enumerate(SHELF_LEDS)],
    ],
    'lamp': [
        light('lamp_spot', 'SPOT', 9, '#ffd2a0', tuple(LAMP_HEAD), tuple(LAMP_DIR), spot_size=math.radians(105), spot_blend=0.45, shadow_soft_size=0.025),
        light('lamp_bulb', 'POINT', 0.8, '#ffd2a0', tuple(LAMP_HEAD - LAMP_DIR * 0.02), shadow_soft_size=0.02),
    ],
    'tv': [
        light('tv_screen', 'AREA', 10, (1.0, 1.0, 1.0), Vector(TV_SCREEN['pos']) + Vector(TV_SCREEN['normal']) * 0.01, TV_SCREEN['normal'],
              shape='RECTANGLE', size=TV_SCREEN['size'][0], size_y=TV_SCREEN['size'][1]),
    ],
}
# area light 默认朝自己的 -Z 发光，上面 direction 已经对准；LED 灯带朝下
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
scene.cycles.transparent_max_bounces = 2
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
    # 开场镜头：站在桌前，略微低头看桌面，窗外的天际线和月亮在画面上方。拖动转头：左边书架、右边矮柜
    'camera': {'pos': [0.05, 1.32, -0.26], 'yaw': 0.04, 'pitch': -0.13, 'fov': 55,
               'yawRange': [-1.3, 1.3], 'pitchRange': [-0.75, 0.2]},
    'window': {'x': WIN['x'], 'y': WIN['y'], 'w': WIN['w'], 'h': WIN['h'], 'z': BACK, 'depth': WIN['depth']},
    # 屏幕：pos = 画面中心（在玻璃上），size = canvas 宽高；显像管是鼓的，grid / depth 是在 (nx+1)×(ny+1) 个点上量的玻璃深度
    # （相对 pos.z，按 PlaneGeometry 的顶点顺序），浏览器把平面弯成这样贴着玻璃
    'screens': {k: {'pos': r3(s['pos']), 'size': r3(s['size']), 'grid': list(s['grid']), 'depth': r3(s['depth'])}
                for k, s in (('pc', PC_SCREEN), ('tv', TV_SCREEN))},
    'emitters': EMIT,
    'glass': {},
    'vendor': USED,
    'tapes': {'count': len(TAPE_COLORS), 'colors': TAPE_COLORS, 'slot': r3(VCR_SLOT)},
    'hotspots': HOT,
    'views': {k: {'target': r3(v['target']), 'size': list(v['size']), 'dir': r3(Vector(v['dir']).normalized())} for k, v in VIEWS.items()},
})
with open(os.path.join(OUTD, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print('[done]', OUTD)
