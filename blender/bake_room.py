# 用 Python 驱动 Blender：搭房间 → Cycles 分层烘焙光照 → 导出 glTF + lightmap。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/bake_room.py -- --size 2048 --samples 256
#
# 先跑 render_view.py（窗外夜景），这里会把 view_full.jpg 当成窗外的发光板，让城市的光照进屋里。
#
# 产物（assets/baked/）：
#   room.glb         静态几何（Room：烘焙物件，只有一套 lightmap UV；Glow：灯泡、灯罩、灯带，浏览器里画成自发光）
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

A = get_args(size=2048, samples=256, out='', skip_bake=0)  # --skip-bake 1：几何没变、只改了热点 / 镜头时用，沿用现有的光照贴图
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


@contextmanager
def hot(name, rot=0.0):
    """这段代码里建的面（Room、Glow 都算）属于热点 name 的一个盒子。盒子在几何建完以后统一算（hot_boxes）。"""
    global HOT_ID
    HOT_BOXES.append((name, rot))
    prev, HOT_ID = HOT_ID, len(HOT_BOXES) - 1
    yield
    HOT_ID = prev


def hot_boxes(pad=0.004):
    pts = {}
    for m in (ROOMM, GLOWM):
        for f in m.bm.faces:
            if f[m.hot]:
                pts.setdefault(f[m.hot], []).extend(v.co.copy() for v in f.verts)
    out = {}
    for i in range(1, len(HOT_BOXES)):
        name, rot = HOT_BOXES[i]
        cr, sr = math.cos(rot), math.sin(rot)
        lo, hi = [1e9] * 3, [-1e9] * 3
        for co in pts.get(i, []):
            x, y, z = co.x, co.z, -co.y                # Blender → three
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
quad(I, 2.9, 2.2, mat('rug', '#7a3a2c'), (0.0, 0.004, -0.55), (-math.pi / 2, 0, 0))
quad(I, 2.6, 1.9, mat('rug_in', '#a35a3e'), (0.0, 0.005, -0.55), (-math.pi / 2, 0, 0))

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

# CRT 显示器 + 键盘 + 鼠标（屏幕不进模型，浏览器里用 canvas 画）
beige, dark = mat('beige', '#cfc6ad'), mat('dark', '#26231f')
g = G((-0.38, TOP, -1.68))
with hot('about'):
    box(g, 0.24, 0.03, 0.22, beige, 0, 0.015, 0)
    box(g, 0.42, 0.36, 0.36, beige, 0, 0.21, 0.02)
    box(g, 0.32, 0.27, 0.1, beige, 0, 0.2, -0.2)
    box(g, 0.34, 0.26, 0.006, dark, 0, 0.215, 0.2)
    box(g, 0.06, 0.06, 0.004, mat('sticky', '#f1d36b'), 0.17, 0.33, 0.202, (0, 0, 0.12))
    box(g, 0.06, 0.06, 0.004, mat('sticky2', '#f29a7b'), -0.18, 0.09, 0.202, (0, 0, -0.08))
PC_SCREEN = dict(pos=world(g, (0, 0.215, 0.206)), size=(0.31, 0.2325))
VIEWS['about'] = dict(target=PC_SCREEN['pos'], size=(0.2, 0.16), dir=(0, 0.12, 1))
g = G((-0.38, TOP, -1.30), (0, 0.04, 0))
with hot('about', 0.04):
    box(g, 0.44, 0.025, 0.15, beige, 0, 0.0125, 0, (0.06, 0, 0))
    box(g, 0.41, 0.008, 0.12, mat('keys', '#c9c2b0'), 0, 0.027, 0.0, (0.06, 0, 0))
g = G((0.03, TOP, -1.30), (0, -0.1, 0))
box(g, 0.22, 0.003, 0.19, mat('mousepad', '#2e4058'), 0, 0.0015, 0)
with hot('about', -0.1):
    box(g, 0.058, 0.03, 0.095, beige, 0.02, 0.018, 0.01)
rod(world(g, (0.02, 0.03, -0.035)), world(g, (-0.05, 0.004, -0.4)), 0.003, dark, 4, False)

# 书桌台灯：左后方，悬臂伸到键盘上方，灯罩朝右前方
lamp_mat = mat('lamp', '#2f5246')
base = (-0.98, TOP, -1.82)
elbow = (-0.96, TOP + 0.42, -1.72)
head = (-0.78, TOP + 0.42, -1.50)
aim = Vector((-0.55, TOP, -1.28))
hv = Vector(head)
adir = (aim - hv).normalized()
LAMP_HEAD, LAMP_DIR = hv + adir * 0.05, adir
with hot('lamp'):
    cyl(I, 0.07, 0.08, 0.025, 28, lamp_mat, (base[0], TOP + 0.0125, base[2]))
    rod((base[0], TOP + 0.02, base[2]), elbow, 0.009, lamp_mat)
    ball(elbow, 0.016, lamp_mat)
with hot('lamp'):
    rod(elbow, head, 0.008, lamp_mat)
    rod(tuple(hv - adir * 0.04), tuple(hv + adir * 0.1), 0.02, lamp_mat, 28, False, r2=0.085)
    with glow():
        ball(tuple(LAMP_HEAD), 0.024, emit('emit.lamp.bulb', 'lamp', '#ffe2b8', 6.0), 2)

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

# 电视录像一体机 + 天线
g = G((0.62, TOP, -1.76))
with hot('work'):
    box(g, 0.44, 0.4, 0.38, mat('tv', '#2b2a2a'), 0, 0.2, 0)
    box(g, 0.33, 0.25, 0.006, mat('bezel', '#111111'), 0, 0.245, 0.19)
    box(g, 0.2, 0.012, 0.006, mat('slot', '#050505'), -0.08, 0.055, 0.19)
    for i in range(4):
        box(g, 0.022, 0.012, 0.008, mat('button', '#6e6a64'), 0.07 + i * 0.03, 0.055, 0.19)
VCR_SLOT = world(g, (-0.08, 0.055, 0.19))
# 电视和左边的录像带架一起装进画面，稍微从上往下看，看得到带子
VIEWS['work'] = dict(target=(0.47, TOP + 0.2, -1.66), size=(0.40, 0.24), dir=(-0.15, 0.35, 1))
rod(world(g, (0.05, 0.4, -0.05)), world(g, (-0.12, 0.72, -0.12)), 0.0035, mat('chrome', '#9a9a9a'), 6)
rod(world(g, (0.07, 0.4, -0.05)), world(g, (0.26, 0.68, -0.1)), 0.0035, mat('chrome', '#9a9a9a'), 6)
TV_SCREEN = dict(pos=world(g, (0, 0.245, 0.196)), size=(0.30, 0.225))

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

# ---------- 左墙：大书架（需要转头才能看到），每层下面一条灯带 ----------
K = 12
g = G((x0, 0, -0.25), (0, math.pi / 2, 0))  # 本地 +z 朝屋里（世界 +x），本地 x 沿墙（世界 -z）
shelf_hot = hot('shelf')
shelf_hot.__enter__()
sw = mat('shelf', '#5e3f25')
SH_W, SH_D, SH_H = 1.7, 0.34, 2.15
box(g, SH_W, SH_H, 0.015, sw, 0, SH_H / 2, 0.01)
for sx in (-1, 1):
    box(g, 0.03, SH_H, SH_D, sw, sx * (SH_W / 2 - 0.015), SH_H / 2, SH_D / 2)
SHELVES = [0.06, 0.47, 0.88, 1.29, 1.70, SH_H - 0.015]
for y in SHELVES:
    box(g, SH_W - 0.06, 0.03, SH_D - 0.01, sw, 0, y, SH_D / 2)
BOOKS = [mat(f'book{i}', c) for i, c in enumerate(['#7a2e2e', '#2e4a7a', '#3d6b45', '#b08a3e', '#5b3a6b', '#8a8a7a', '#a8552d', '#24384a', '#c9b48a'])]


def fill(y, a, b, lean_ok=True):
    x = a
    while True:
        w, h = 0.022 + rnd.random() * 0.035, 0.19 + rnd.random() * 0.15
        if x + w > b:
            break
        if lean_ok and rnd.random() < 0.06 and x + h < b:   # 偶尔一本斜靠着
            box(g, w, h, 0.22, rnd.choice(BOOKS), x + h * 0.35, y + 0.015 + h * 0.47, 0.13, (0, 0, -0.45))
            x += h * 0.5
            continue
        box(g, w, h, 0.2 + rnd.random() * 0.06, rnd.choice(BOOKS), x + w / 2, y + 0.015 + h / 2, 0.13)
        x += w + 0.002 + (0.05 if rnd.random() < 0.08 else 0)


x_in = SH_W / 2 - 0.035
fill(SHELVES[1], -x_in, x_in)
fill(SHELVES[2], -x_in, 0.25)
fill(SHELVES[3], -0.3, x_in)
fill(SHELVES[4], -x_in, 0.45)
# 最下层：唱片（方的、竖着放）；第三层右边：地球仪；第四层左边：相框
for i in range(18):
    box(g, 0.008, 0.31, 0.31, rnd.choice(BOOKS), -x_in + 0.02 + i * 0.012, SHELVES[0] + 0.015 + 0.155, 0.17, (0, 0, rnd.uniform(-0.03, 0.03)))
box(g, 0.3, 0.28, 0.28, mat('crate', '#8a6a46'), 0.45, SHELVES[0] + 0.155, 0.16)
cyl(g, 0.05, 0.06, 0.02, 20, mat('brass', '#b8945a'), (0.5, SHELVES[2] + 0.025, 0.16))
ball(world(g, (0.5, SHELVES[2] + 0.17, 0.16)), 0.12, mat('globe', '#3f6f8f'), 3)
box(g, 0.2, 0.26, 0.02, mat('photo_frame', '#2a2420'), -0.55, SHELVES[3] + 0.145, 0.14, (-0.12, 0, 0))
box(g, 0.16, 0.2, 0.004, mat('photo', '#c9a77a'), -0.55, SHELVES[3] + 0.15, 0.152, (-0.12, 0, 0))
cyl(g, 0.05, 0.07, 0.22, 20, mat('vase', '#d8d0c0'), (0.6, SHELVES[4] + 0.125, 0.15))
shelf_hot.__exit__(None, None, None)
VIEWS['shelf'] = dict(target=world(g, (0, 1.15, SH_D)), size=(0.9, 0.85), dir=(1, 0.06, 0))
SHELF_LEDS = []
for y in SHELVES[2:]:
    SHELF_LEDS.append((world(g, (0, y - 0.019, SH_D - 0.03)), SH_W - 0.08))

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
box(g, 0.42, 0.09, 0.34, mat('turntable', '#3a2a20'), -0.35, 0.765, 0.24)
cyl(g, 0.15, 0.15, 0.012, 40, mat('platter', '#1a1a1a'), (-0.4, 0.816, 0.24))
cyl(g, 0.045, 0.045, 0.002, 24, mat('record_label', '#c94c3c'), (-0.4, 0.823, 0.24))
rod(world(g, (-0.2, 0.83, 0.34)), world(g, (-0.33, 0.83, 0.17)), 0.004, mat('chrome', '#9a9a9a'), 6)
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

FLOOR_LAMP = (1.86, 1.62, -1.36)  # 离两面墙都留开一点，不然墙角会烧白
fl = FLOOR_LAMP
with hot('room'):
    cyl(I, 0.15, 0.16, 0.025, 28, mat('dark', '#26231f'), (fl[0], 0.0125, fl[2]))
    rod((fl[0], 0.02, fl[2]), (fl[0], 1.5, fl[2]), 0.011, mat('dark', '#26231f'))
    with glow():
        cyl(I, 0.17, 0.22, 0.32, 32, emit('emit.room.shade', 'room', '#ffd7a0', 1.6), (fl[0], fl[1] + 0.02, fl[2]), caps=False)

# 椅子：推到桌子和矮柜之间，侧着放（不挡开场镜头，也不挡往右看）
g = G((1.5, 0, -0.45), (0, 1.1, 0))
chm = mat('chair', '#2d3036')
box(g, 0.48, 0.07, 0.46, chm, 0, 0.47, 0)
box(g, 0.44, 0.48, 0.06, chm, 0, 0.84, 0.24, (-0.12, 0, 0))
rod(world(g, (0, 0.06, 0)), world(g, (0, 0.44, 0)), 0.025, mat('chrome', '#9a9a9a'), 12)
for i in range(5):
    a = i / 5 * math.tau
    rod(world(g, (0, 0.06, 0)), world(g, (math.cos(a) * 0.3, 0.03, math.sin(a) * 0.3)), 0.016, mat('dark', '#26231f'), 6)
    ball(world(g, (math.cos(a) * 0.3, 0.025, math.sin(a) * 0.3)), 0.025, mat('dark', '#26231f'))
for sx in (-1, 1):
    box(g, 0.05, 0.03, 0.3, chm, sx * 0.25, 0.68, 0.0)
    box(g, 0.03, 0.18, 0.03, chm, sx * 0.25, 0.58, 0.08)

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


room = build(ROOMM)
glow = build(GLOWM)
glow.hide_render = True
me = room.data
print(f'[geo] Room {len(me.polygons)} faces / {len(me.materials)} materials, Glow {len(glow.data.polygons)} faces')

# 天花板：只在烘焙时挡光、反光，不导出（浏览器里看不到天花板，房间显得开阔）
CEIL = Mesh('Ceiling')
T = CEIL
quad(I, W, Dp, CEIL.mat('ceiling', '#d8d2c6'), (0, RH, (BACK + z1) / 2), (math.pi / 2, 0, 0))
ceiling = build(CEIL)

# ---------- lightmap UV：smart project → 按 uvk 放大主角物件的岛 → 重新排进一张图集 ----------
me.uv_layers.new(name='Lightmap')
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
per_loop = np.empty(len(me.loops), dtype=np.float32)
for s0, n0, kk in zip(starts, totals, k):
    per_loop[s0:s0 + n0] = kk / 10.0
uv = np.empty(len(me.loops) * 2, dtype=np.float32)
me.uv_layers['Lightmap'].data.foreach_get('uv', uv)
uv = (uv.reshape(-1, 2) * per_loop[:, None]).ravel()
me.uv_layers['Lightmap'].data.foreach_set('uv', uv)
me.attributes.remove(me.attributes['uvk'])
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')
if 'uvk' in glow.data.attributes:
    glow.data.attributes.remove(glow.data.attributes['uvk'])


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
        light('pc_screen', 'AREA', 1.2, (0.36, 1.0, 0.6), Vector(PC_SCREEN['pos']) + Vector((0, 0, 0.01)), (0, 0, 1),
              shape='RECTANGLE', size=PC_SCREEN['size'][0], size_y=PC_SCREEN['size'][1]),
    ],
    'room': [
        light('floor_lamp', 'POINT', 30, '#ffcf99', FLOOR_LAMP, shadow_soft_size=0.12),
        light('table_lamp', 'POINT', 18, '#ffcf99', (LAMP2[0], 1.1, LAMP2[2]), shadow_soft_size=0.06),
        *[light(f'bulb{i}', 'POINT', 0.7, '#ffc98a', (p[0], p[1] - 0.01, p[2] + 0.01), shadow_soft_size=0.015) for i, p in enumerate(BULBS)],
        # 不给方向 = 默认朝下（-Z），size_y 沿书架方向（three 的 z）
        *[light(f'led{i}', 'AREA', 5, '#ffd09a', (p[0] - 0.01, p[1] - 0.006, p[2]), None, shape='RECTANGLE', size=0.02, size_y=length)
          for i, (p, length) in enumerate(SHELF_LEDS)],
    ],
    'lamp': [
        light('lamp_spot', 'SPOT', 9, '#ffd2a0', tuple(LAMP_HEAD), tuple(LAMP_DIR), spot_size=math.radians(105), spot_blend=0.45, shadow_soft_size=0.025),
        light('lamp_bulb', 'POINT', 0.8, '#ffd2a0', tuple(LAMP_HEAD - LAMP_DIR * 0.02), shadow_soft_size=0.02),
    ],
    'tv': [
        light('tv_screen', 'AREA', 10, (1.0, 1.0, 1.0), Vector(TV_SCREEN['pos']) + Vector((0, 0, 0.01)), (0, 0, 1),
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
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, use_clear=True)
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
                          export_yup=True, export_apply=False, export_materials='EXPORT',
                          export_lights=False, export_cameras=False)
r3 = lambda v: [round(float(c), 4) for c in v]  # noqa: E731
manifest.update({
    'seconds': old.get('seconds') if A.skip_bake else round(time.time() - T0),
    # 开场镜头：站在桌前，略微低头看桌面，窗外的天际线和月亮在画面上方。拖动转头：左边书架、右边矮柜
    'camera': {'pos': [0.05, 1.32, -0.26], 'yaw': 0.04, 'pitch': -0.13, 'fov': 55,
               'yawRange': [-1.3, 1.3], 'pitchRange': [-0.75, 0.2]},
    'window': {'x': WIN['x'], 'y': WIN['y'], 'w': WIN['w'], 'h': WIN['h'], 'z': BACK, 'depth': WIN['depth']},
    'screens': {'pc': {'pos': r3(PC_SCREEN['pos']), 'size': list(PC_SCREEN['size'])},
                'tv': {'pos': r3(TV_SCREEN['pos']), 'size': list(TV_SCREEN['size'])}},
    'emitters': EMIT,
    'tapes': {'count': len(TAPE_COLORS), 'colors': TAPE_COLORS, 'slot': r3(VCR_SLOT)},
    'hotspots': HOT,
    'views': {k: {'target': r3(v['target']), 'size': list(v['size']), 'dir': r3(Vector(v['dir']).normalized())} for k, v in VIEWS.items()},
})
with open(os.path.join(OUTD, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print('[done]', OUTD)
