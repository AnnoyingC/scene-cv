# 城堡塔楼书房：搭场景 → Cycles 分层烘焙光照 → 导出 glTF + lightmap。和 bake_room.py 是同一套做法，换了一个场景：
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/bake_tower.py -- --size 2048 --samples 256
#
# 先跑 render_tower_view.py（窗外的湖和远山），这里会把 view_full.jpg 当成窗外的发光板。
# 调构图时不用烘焙，加 --preview home 直接从开场镜头渲一张图（也可以 top / about / work / online / shelf）：
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/bake_tower.py -- --preview home
#
# 场景：圆形塔楼（16 边形），正对镜头是一扇窄窄的尖拱窗。正中间两级八角石台上立着一座八角石头洗礼盆（实拍扫描；作品：盆沿上的水晶 = 项目，
# 点一颗就落进水里，水面浮现项目的画面）；左边是壁炉，壁炉台正中放着水晶球（关于我）；右边是书桌，桌上的羊皮纸
# 写着联系方式。周围是扶手椅、书架、玻璃柜、棋桌、挂毯、吊灯这些陪衬，颜色压暗，不抢主角。
#
# 产物（assets/tower/）：
#   tower.glb        Room（烘焙，两套 UV：UVMap 贴图、Lightmap 光照）+ Glow（火焰、烛焰、符文，浏览器里画成自发光）
#   lm_ambient.jpg   月光 + 窗外的天光 + 屋顶一点冷色的补光 + 水晶球
#   lm_candles.jpg   蜡烛和吊灯
#   lm_fire.jpg      壁炉（浏览器里让它闪）
#   lm_basin.jpg     水盆发的光（按白光烘焙，浏览器里按项目画面的颜色染色）
#   manifest.json    每层的亮度系数、镜头、窗户、水面、水晶球、水晶、会动的棋子、热点盒子、视角、用到的第三方素材
#
# 第三方模型来自 vendor-src/polyhaven/（node scripts/fetch_assets.mjs 下载）和 vendor-src/sketchfab/<名字>/<名字>.glb（要登录，手动下载）：
# 导入 → 减面 → 只留颜色贴图（一般缩到 512）→ 摆放。
import json
import math
import os
import random
import sys
import time
from contextlib import contextmanager
from fnmatch import fnmatch

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import (ROOT, TOWER, TOWER_MOON, TOWER_OUT, TOWER_VIEW, TOWER_WIN, clear_scene, get_args,  # noqa: E402
                    srgb, tree, use_metal)

A = get_args(size=2048, samples=256, out='', skip_bake=0, preview='', pw=1280, ps=64)
OUTD = A.out or TOWER_OUT
VSRC = os.path.join(ROOT, 'vendor-src', 'polyhaven')
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
rnd = random.Random(7)
T0 = time.time()

# ---------- 坐标换算（同 bake_room.py：尺寸按 three.js 写，Y 向上；最后统一转成 Blender 的 Z 向上）----------
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
CI = C.inverted()


def M(pos=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    return Matrix.LocRotScale(Vector(pos), Euler(rot, 'ZYX'), Vector(scale))


P = M(rot=(-math.pi / 2, 0, 0))
I = Matrix.Identity(4)
G = M


def tb(v):
    return Vector((v[0], -v[2], v[1]))


def world(g, p):
    return tuple(g @ Vector(p))


# ---------- 几何 ----------
class Mesh:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uvk = self.bm.faces.layers.int.new('uvk')
        self.hot = self.bm.faces.layers.int.new('hot')
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
T = ROOMM


def _faces(verts):
    return {f for v in verts for f in v.link_faces}


def box(g, w, h, d, mi, x=0, y=0, z=0, rot=(0, 0, 0)):
    r = bmesh.ops.create_cube(T.bm, size=1.0, matrix=C @ g @ M((x, y, z), rot, (w, h, d)))
    T.tag(_faces(r['verts']), mi)


def quad(g, w, h, mi, pos, rot=(0, 0, 0)):
    m = C @ g @ M(pos, rot)
    vs = [T.bm.verts.new(m @ Vector((sx * w / 2, sy * h / 2, 0))) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    T.tag([T.bm.faces.new(vs)], mi)


def cyl(g, r_top, r_bot, h, segs, mi, pos, rot=(0, 0, 0), caps=True, flip=False):
    r = bmesh.ops.create_cone(T.bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r_bot, radius2=r_top,
                              depth=h, matrix=C @ g @ M(pos, rot) @ P)
    fs = _faces(r['verts'])
    if flip:
        bmesh.ops.reverse_faces(T.bm, faces=list(fs))
    T.tag(fs, mi)


def disc(g, r, segs, mi, pos, down=False):
    res = bmesh.ops.create_circle(T.bm, cap_ends=True, cap_tris=False, segments=segs, radius=r, matrix=C @ g @ M(pos) @ P)
    fs = _faces(res['verts'])
    if down:
        bmesh.ops.reverse_faces(T.bm, faces=list(fs))
    T.tag(fs, mi)


def ring(g, r0, r1, y, segs, mi):
    """水平的圆环（法线朝上）。"""
    pts = [(math.cos(a), math.sin(a)) for a in (i / segs * math.tau for i in range(segs))]
    for (c0, s0), (c1, s1) in zip(pts, pts[1:] + pts[:1]):
        poly([world(g, (c0 * r0, y, s0 * r0)), world(g, (c1 * r0, y, s1 * r0)), world(g, (c1 * r1, y, s1 * r1)), world(g, (c0 * r1, y, s0 * r1))],
             mi, normal=(0, 1, 0))


def along(a, b):
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


def poly(pts, mi, normal=None, toward=None):
    """几个点（three 坐标）围成一个面。给 normal（大致朝向）或 toward（面朝向哪个点）时自动调整绕向。"""
    vs = [Vector(p) for p in pts]
    n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
    if toward is not None:
        normal = Vector(toward) - sum(vs, Vector()) / len(vs)
    if normal is not None and n.dot(Vector(normal)) < 0:
        vs.reverse()
    T.tag([T.bm.faces.new([T.bm.verts.new(C @ v) for v in vs])], mi)


mat = lambda name, color: T.mat(name, color)  # noqa: E731

# 有贴图的程序化材质：墙和壁炉用 Poly Haven 的石墙 / 红砖。UV 按世界坐标投影（tile 米一张），塔墙按圆周展开不会有接缝
TEXDEF = {}


def tmat(name, img, tile, tint, mode='planar'):
    TEXDEF[name] = dict(img=img, tile=tile, tint=tint, mode=mode)
    return mat(name, tint)


STONE = os.path.join(VSRC, 'stone_wall_04', 'stone_wall_04_diff_1k.jpg')
BRICK = os.path.join(VSRC, 'medieval_red_brick', 'medieval_red_brick_diff_1k.jpg')

EMIT = {}


def emit(name, layer, color, power):
    EMIT[name] = dict(layer=layer, color=color, power=power)
    return mat(name, color)


@contextmanager
def glow():
    global T
    prev, T = T, GLOWM
    yield
    T = prev


# ---------- 热点 ----------
HOT_BOXES = [None]
HOT_PTS = {}  # 盒子编号 → 额外的点（第三方模型、浏览器里才画的水晶球）
VIEWS = {}


@contextmanager
def hot(name, rot=0.0):
    global HOT_ID
    HOT_BOXES.append((name, rot))
    prev, HOT_ID = HOT_ID, len(HOT_BOXES) - 1
    yield
    HOT_ID = prev


def hot_points(pts):
    HOT_PTS.setdefault(HOT_ID, []).extend(Vector(p) for p in pts)


BASES = [0.0]  # 物件放在这些高度的台面上时，盒子底边抬高一点，别把台面也框进去


def hot_boxes(pad=0.004):
    pts = {k: list(v) for k, v in HOT_PTS.items()}
    for m in (ROOMM, GLOWM):
        for f in m.bm.faces:
            if f[m.hot]:
                pts.setdefault(f[m.hot], []).extend(CI @ v.co for v in f.verts)
    out = {}
    for i in range(1, len(HOT_BOXES)):
        name, rot = HOT_BOXES[i]
        if not pts.get(i):
            continue
        cr, sr = math.cos(rot), math.sin(rot)
        lo, hi = [1e9] * 3, [-1e9] * 3
        for p in pts[i]:
            x, y, z = p
            q = (cr * x - sr * z, y, sr * x + cr * z)
            for k in range(3):
                lo[k], hi[k] = min(lo[k], q[k]), max(hi[k], q[k])
        base_y = lo[1]
        lo = [a - pad for a in lo]
        hi = [b + pad for b in hi]
        for base in BASES:
            if abs(base_y - base) < 0.004:
                lo[1] = base + 0.002
        c = [(a + b) / 2 for a, b in zip(lo, hi)]
        h = [(b - a) / 2 for a, b in zip(lo, hi)]
        cw = (cr * c[0] + sr * c[2], c[1], -sr * c[0] + cr * c[2])
        out.setdefault(name, []).append(dict(c=[round(v, 4) for v in cw], h=[round(v, 4) for v in h], r=round(rot, 4)))
    return out


# ---------- 第三方模型 ----------
LIB = {}     # 素材 id → {子物件名: 减过面的网格（Blender 坐标）}
PLACED = []  # 摆好的物件：{ob, uvk}
USED = []    # 用到了哪些素材（写进 manifest，网页上的致谢列表按它过滤）
TEXSIZE = {'vintage_cabinet_01': 1024, 'ArmChair_01': 1024, 'fancy_picture_frame_02': 1024}
GLASS = {'vintage_cabinet_01_glass': 0.22, 'lantern_chandelier_01_glass': 0.3}
DIM = {'potted_plant_02': (0.72, 0.55), 'ArmChair_01': (0.62, 0.85),
       # 去掉金属度以后黄铜贴图会显得发白：压暗、加饱和，看起来还是黄铜
       'brass_candleholders': (0.6, 1.5), 'brass_goblets': (0.55, 1.5), 'lantern_chandelier_01': (0.55, 1.3)}  # (亮度, 饱和度)
DIMMED = set()
EMIT['brass_candleholders_flame'] = dict(layer='candles', color='#ffcf8a', power=5.0, map=True)
EMIT['lantern_chandelier_01_lamp'] = dict(layer='candles', color='#ffc27a', power=5.0)


def principled(mt):
    return next((n for n in mt.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)


def fix_material(mt, size, dim=None):
    """烘焙只需要颜色：保留颜色贴图（缩小），断开法线、金属度、粗糙度、透明这些贴图。"""
    nt = mt.node_tree
    b = principled(mt)
    if b is None:  # glTF 的 unlit 材质（实拍扫描常见：贴图当自发光显示，不受光也不投影）：换成普通漫反射，贴图接到 Base Color
        img = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image), None)
        if img is None:
            return
        keep = img.name  # bpy 的节点每次取出来都是新的 Python 对象，只能按名字比
        for n in list(nt.nodes):
            if n.name != keep:
                nt.nodes.remove(n)
        b = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(b.outputs[0], nt.nodes.new('ShaderNodeOutputMaterial').inputs['Surface'])
        nt.links.new(nt.nodes[keep].outputs['Color'], b.inputs['Base Color'])
    diff = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image and '_diff' in n.image.name), None)
    if diff is None and b.inputs['Base Color'].links:  # Sketchfab 的贴图不叫 *_diff*：顺着 Base Color 往回找（中间可能隔一两个节点）
        n = b.inputs['Base Color'].links[0].from_node
        for _ in range(3):
            if n.type == 'TEX_IMAGE' and n.image:
                diff = n
                break
            ins = [lk.from_node for s_ in n.inputs for lk in s_.links]
            if not ins:
                break
            n = ins[0]
    for s in b.inputs:
        if s.name != 'Base Color':
            for link in list(s.links):
                nt.links.remove(link)
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Roughness'].default_value = 0.8
    b.inputs['Transmission Weight'].default_value = 0.0
    b.inputs['Emission Strength'].default_value = 0.0
    b.inputs['Alpha'].default_value = 1.0
    if diff and mt.name != 'vintage_cabinet_01_glass':
        for link in list(b.inputs['Base Color'].links):
            nt.links.remove(link)
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'UVMap'
        nt.links.new(uvn.outputs[0], diff.inputs['Vector'])
        nt.links.new(diff.outputs['Color'], b.inputs['Base Color'])
        img = diff.image
        if max(img.size) > size:
            img.scale(size, size)
        if dim and img.name not in DIMMED and mt.name not in EMIT and 'candles' not in mt.name:  # 压暗、降饱和，免得抢镜头
            DIMMED.add(img.name)
            px = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(-1, 4)
            grey = px[:, :3].mean(axis=1, keepdims=True)
            px[:, :3] = np.clip((grey + (px[:, :3] - grey) * dim[1]) * dim[0], 0, 1)
            img.pixels.foreach_set(px.ravel())
            img.update()
    else:
        diff = None
        for link in list(b.inputs['Base Color'].links):
            nt.links.remove(link)
        if 'glass' in mt.name:
            b.inputs['Base Color'].default_value = (0.05, 0.06, 0.06, 1)
    for n in list(nt.nodes):  # 用不到的贴图删掉，导出时就不会带上
        if n.type in ('TEX_IMAGE', 'NORMAL_MAP', 'SEPARATE_COLOR', 'MATH', 'MIX', 'VERTEX_COLOR') and (diff is None or n.name != diff.name):
            nt.nodes.remove(n)
    if mt.name in GLASS:
        b.inputs['Alpha'].default_value = GLASS[mt.name]
    e = EMIT.get(mt.name)
    if e:  # 预览渲染时让火焰发光（烘焙时 Glow 整个隐藏，不参与）
        if diff:
            nt.links.new(diff.outputs['Color'], b.inputs['Emission Color'])
        else:
            b.inputs['Emission Color'].default_value = (*srgb(e['color']), 1)
        b.inputs['Emission Strength'].default_value = e['power']


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def load_asset(asset, tris=None):
    if asset in LIB:
        return LIB[asset]
    before = set(bpy.data.objects)
    mats_before = set(bpy.data.materials)
    if asset.startswith('sketchfab/'):  # 和 credits.json 的 id 一样：sketchfab/<slug> → vendor-src/sketchfab/<slug>/<slug>.glb
        slug = asset.split('/', 1)[1]
        path = os.path.join(ROOT, 'vendor-src', 'sketchfab', slug, f'{slug}.glb')
    else:
        path = os.path.join(VSRC, asset, f'{asset}_1k.gltf')
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    pieces = {}
    for o in new:
        if o.type != 'MESH':
            continue
        me = o.data.copy()
        me.transform(o.matrix_world)
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[-1])
        if me.uv_layers:
            me.uv_layers[0].name = 'UVMap'
        for a in [a.name for a in me.color_attributes]:
            me.color_attributes.remove(me.color_attributes[a])
        pieces[o.name] = me
    for o in new:
        bpy.data.objects.remove(o)
    total = sum(tri_count(me) for me in pieces.values())
    if tris and total > tris:
        ratio = tris / total
        dg_ob = bpy.data.objects.new('_dec', None)
        for name, me in list(pieces.items()):
            ob = bpy.data.objects.new('_dec', me)
            scene.collection.objects.link(ob)
            mod = ob.modifiers.new('dec', 'DECIMATE')
            mod.ratio = ratio
            dg = bpy.context.evaluated_depsgraph_get()
            pieces[name] = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
            bpy.data.objects.remove(ob)
        bpy.data.objects.remove(dg_ob)
    for mt in set(bpy.data.materials) - mats_before:
        fix_material(mt, TEXSIZE.get(asset, 512), DIM.get(asset))
    print(f'[vendor] {asset}: {total} → {sum(tri_count(me) for me in pieces.values())} tris, {len(pieces)} pieces')
    LIB[asset] = pieces
    USED.append(asset)
    return pieces


def vendor(asset, at, pieces=None, scale=None, height=None, rot=(0, 0, 0), anchor=(0.5, 0.0, 0.5), uvk=8, tris=None,
           offsets=None, mats=None):
    """把素材里（名字匹配 pieces 的）子物件摆到 at（three 坐标矩阵）。anchor：包围盒上哪一点对准 at 的原点（默认底面中心）。
    scale / height 二选一；offsets 把单个子物件挪一挪（素材自己的坐标，米）；mats 给子物件换材质。"""
    lib = load_asset(asset, tris)
    names = [n for n in lib if pieces is None or any(fnmatch(n, p) for p in pieces)]
    meshes = []
    for n in names:
        me = lib[n].copy()
        if offsets and n in offsets:
            me.transform(C @ Matrix.Translation(Vector(offsets[n])) @ CI)
        meshes.append(me)
    co = np.concatenate([_co(me) for me in meshes])
    co3 = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)  # Blender → three
    lo, hi = co3.min(axis=0), co3.max(axis=0)
    size = hi - lo
    s = scale or (height / size[1] if height else 1.0)
    origin = Vector(lo + size * np.array(anchor))
    mx = C @ at @ M(rot=rot, scale=(s, s, s)) @ Matrix.Translation(-origin) @ CI
    obs = []
    for n, me in zip(names, meshes):
        me.transform(mx)
        if mats and n in mats:
            me.materials[0] = mats[n]
        ob = bpy.data.objects.new(n, me)
        scene.collection.objects.link(ob)
        PLACED.append(dict(ob=ob, uvk=uvk))
        if HOT_ID:
            HOT_PTS.setdefault(HOT_ID, []).extend(CI @ v.co for v in me.vertices if me.materials and
                                                  me.materials[0] is not None)
        obs.append(ob)
    return obs


def _co(me):
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def bbox3(obs):
    co = np.concatenate([_co(o.data) for o in obs])
    co3 = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)
    return co3.min(axis=0), co3.max(axis=0)


# =====================================================================================================
# 场景
# =====================================================================================================
N, R, H, WT = TOWER['n'], TOWER['r'], TOWER['h'], TOWER['wall']
HW = R * math.tan(math.pi / N)       # 每面墙的半宽
RC = R / math.cos(math.pi / N)       # 外接圆半径（墙角）
STEP = 360 / N


def wall_at(phi, off=0.0, y=0.0):
    """第 phi 度那面墙（0 = 正对镜头的窗户，往右为正）前 off 米处的坐标系：本地 +z 朝屋里，+x 沿墙往右，原点在地面。"""
    f = math.radians(phi)
    p = Vector((R * math.sin(f), y, -R * math.cos(f))) + Vector((-math.sin(f), 0, math.cos(f))) * off
    return G(tuple(p), (0, -f, 0))


def inward(phi):
    f = math.radians(phi)
    return Vector((-math.sin(f), 0, math.cos(f)))


# ---------- 墙、地板、天花板 ----------
stone = tmat('stone', STONE, 2.2, '#8f877c', 'tower')
for i in range(N):
    phi = i * STEP if i <= N // 2 else (i - N) * STEP
    if i == 0:
        continue
    K = 6 if abs(phi) < 100 else 3  # 身后的墙几乎看不到
    quad(wall_at(phi), 2 * HW, H, stone, (0, H / 2, 0))
K = 10


def lancet(w, y0, ys, n=8):
    """尖拱（两段半径 = 宽度的圆弧）：从左下角开始顺时针绕一圈。"""
    pts = [(-w / 2, y0), (-w / 2, ys)]
    for k in range(1, n):
        a = math.pi - (math.pi / 3) * k / n
        pts.append((w / 2 + w * math.cos(a), ys + w * math.sin(a)))
    pts.append((0, ys + w * math.sin(math.pi / 3)))
    for k in range(n - 1, 0, -1):
        a = (math.pi / 3) * k / n
        pts.append((-w / 2 + w * math.cos(a), ys + w * math.sin(a)))
    pts += [(w / 2, ys), (w / 2, y0)]
    return pts


# 窗：屋里一侧的大开口 → 往外收窄的墙洞（窗台斜着往上）→ 外面一扇窄玻璃窗，三根横铁条 + 一根竖铁条
TW = TOWER_WIN
g = wall_at(0)
inner = lancet(TW['inner_w'], TW['inner_y0'], TW['inner_spring'])
outer = lancet(TW['w'], TW['y0'], TW['spring'])
wi = TW['inner_w'] / 2
n_in = (0, 0, 1)
quad(g, HW - wi, H, stone, (-(HW + wi) / 2, H / 2, 0))
quad(g, HW - wi, H, stone, ((HW + wi) / 2, H / 2, 0))
quad(g, 2 * wi, TW['inner_y0'], stone, (0, TW['inner_y0'] / 2, 0))
arch = inner[1:-1]
for (x0, y0), (x1, y1) in zip(arch, arch[1:]):
    poly([world(g, (x0, y0, 0)), world(g, (x1, y1, 0)), world(g, (x1, H, 0)), world(g, (x0, H, 0))], stone, normal=(0, 0, 1))
axis_y = (TW['y0'] + TW['spring']) / 2
reveal = tmat('stone_reveal', STONE, 1.4, '#9b9387')
for k in range(len(inner)):
    a, b = inner[k], inner[(k + 1) % len(inner)]
    c, d = outer[(k + 1) % len(outer)], outer[k]
    pts = [world(g, (a[0], a[1], 0)), world(g, (b[0], b[1], 0)), world(g, (c[0], c[1], -WT)), world(g, (d[0], d[1], -WT))]
    poly(pts, reveal, toward=world(g, (0, axis_y, -WT / 2)))
WIN_C = world(g, (0, (TW['y0'] + TW['spring'] + TW['w'] * 0.866) / 2, -WT))
iron = mat('iron', '#1d1b1a')
gz = -WT + 0.04
box(g, 0.022, TW['spring'] + TW['w'] * 0.8 - TW['y0'], 0.022, iron, 0, (TW['y0'] + TW['spring'] + TW['w'] * 0.8) / 2, gz)
for k in range(1, 4):
    box(g, TW['w'], 0.02, 0.022, iron, 0, TW['y0'] + k * (TW['spring'] - TW['y0']) / 3.2, gz)
# 窗洞里两边各挂一小截深红色的帘子（收起来的）
for sx in (-1, 1):
    box(g, 0.1, 2.3, 0.08, mat('curtain', '#4a1416'), sx * (wi - 0.06), 0.62 + 1.2, 0.06)
rod(world(g, (-wi - 0.05, TW['inner_spring'] + 0.45, 0.1)), world(g, (wi + 0.05, TW['inner_spring'] + 0.45, 0.1)), 0.012, mat('brass', '#a8823e'), 8)


# 地板：一条条木板（每条再随机断成几截），按 16 边形的轮廓裁
def floor_x(z):
    """16 边形在深度 z 处的半宽。"""
    best = 0.0
    vs = [(RC * math.sin(math.radians((k + 0.5) * STEP)), -RC * math.cos(math.radians((k + 0.5) * STEP))) for k in range(N)]
    for (x0, z0), (x1, z1) in zip(vs, vs[1:] + vs[:1]):
        if (z0 - z) * (z1 - z) <= 0 and z0 != z1:
            best = max(best, x0 + (z - z0) / (z1 - z0) * (x1 - x0))
    return best


K = 6
PLANKS = [mat(f'plank{i}', c) for i, c in enumerate(['#4a3322', '#553a26', '#3f2b1d', '#5c412b', '#47301f', '#4f3825'])]
PW = 0.21
z = -R
while z < R - 1e-6:
    z1 = min(R, z + PW)
    xa, xb = floor_x(z + 1e-4), floor_x(z1 - 1e-4)
    cuts = sorted(rnd.uniform(-2.6, 2.6) for _ in range(2))
    xs = [-max(xa, xb)] + [c for c in cuts if abs(c) < min(xa, xb) - 0.2] + [max(xa, xb)]
    for x0, x1 in zip(xs, xs[1:]):
        # 两端按墙的斜边裁
        p0a, p0b = max(x0, -xa), max(x0, -xb)
        p1a, p1b = min(x1, xa), min(x1, xb)
        poly([(p0a, 0, z), (p1a, 0, z), (p1b, 0, z1), (p0b, 0, z1)], rnd.choice(PLANKS), normal=(0, 1, 0))
    z = z1

# 圆地毯（水盆下面）：深红底、金色圈、深色边
K = 8
BASIN = Vector((0.0, 0.0, -0.55))
gb = G(tuple(BASIN))
disc(gb, 1.45, 48, mat('rug_edge', '#2a1612'), (0, 0.004, 0))
disc(gb, 1.36, 48, mat('rug', '#5a1a1a'), (0, 0.006, 0))
ring(gb, 1.08, 1.16, 0.007, 48, mat('rug_gold', '#9a7432'))
ring(gb, 0.62, 0.66, 0.007, 40, mat('rug_gold', '#9a7432'))

# 天花板：16 边形木板 + 8 根放射状的梁 + 中间一个圆木头（导出，塔楼里抬头能看到）
K = 3
poly([(RC * math.sin(math.radians((k + 0.5) * STEP)), H, -RC * math.cos(math.radians((k + 0.5) * STEP))) for k in range(N)],
     mat('ceiling', '#2b2018'), normal=(0, -1, 0))
beam = mat('beam', '#22180f')
for k in range(8):
    f = math.radians(k * 45 + STEP / 2)
    box(G((0, H - 0.11, 0), (0, -f, 0)), 0.16, 0.22, RC * 2 - 0.1, beam, 0, 0, 0)
cyl(I, 0.32, 0.32, 0.24, 16, beam, (0, H - 0.14, 0))
K = 10

# ---------- 正中：石台上的洗礼盆（作品）----------
# 两级八角石台上立着一座 15 世纪初的八角石头洗礼盆：Sketchfab 上的实拍扫描（Laurence，St Pauls, Broadwell，CC BY 4.0）。
# 扫描带着的一块教堂地面去掉；横向加宽 1.2 倍，盆口大一点（四叶饰看不出变形）。不加符文和底光，只留水面微弱的光。
# 水面不进模型（浏览器里画）：盆沿高度、盆口大小、水位都从扫描网格里量；前沿四个小托架放水晶，按那一点的盆沿高度放
FONT = 'sketchfab/font-st-pauls-broadwell'
FONT_H, FONT_WIDE, DAIS = 0.95, 1.2, 0.2   # 盆本身高 0.95 米（不含石台）；石台两级共 0.2 米
TEXSIZE[FONT] = 2048                      # 主角：贴图留大一点（原图 8K）


def trim_floor(asset, below=0.075, ring=(0.14, 0.37)):
    """去掉扫描带着的地面：高度在总高 below 以下的面全部去掉；ring[0] 以下、离中心超过 ring[1]（都按总高算）的也去掉。"""
    for name, me in load_asset(asset).items():
        if 'custom_normal' in me.attributes:  # bmesh 处理不了这种属性（INT16_2D），后面合并、展 UV 会出错；导出本来就不带法线
            me.attributes.remove(me.attributes['custom_normal'])
        bm = bmesh.new()
        bm.from_mesh(me)
        co = np.array([v.co[:] for v in bm.verts])  # Blender 坐标，z 向上
        z0, hz = co[:, 2].min(), np.ptp(co[:, 2])
        cx, cy = (co[:, 0].min() + co[:, 0].max()) / 2, (co[:, 1].min() + co[:, 1].max()) / 2
        kill = []
        for f in bm.faces:
            c = f.calc_center_median()
            h, r = (c.z - z0) / hz, math.hypot(c.x - cx, c.y - cy) / hz
            if h < below or (h < ring[0] and r > ring[1]):
                kill.append(f)
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
        bm.to_mesh(me)
        bm.free()
        print(f'[font] {name}: 去掉 {len(kill)} 个地面的面')


trim_floor(FONT)
K = 22
dais = tmat('dais_stone', STONE, 0.9, '#9d978c')  # 不叫 basin_stone：浏览器会给 basin_stone 加一层常亮的盆光，石台要保持暗
O8 = (0, math.pi / 8, 0)                          # 八角形：一条边正对镜头
with hot('work'):
    cyl(gb, 1.02, 1.06, 0.1, 8, dais, (0, 0.05, 0), O8)
    cyl(gb, 0.8, 0.83, 0.1, 8, dais, (0, 0.15, 0), O8)
    font_obs = vendor(FONT, gb @ M((0, DAIS - 0.005, 0), scale=(FONT_WIDE, 1, FONT_WIDE)), height=FONT_H, uvk=16)
# 量盆沿：以盆中心为原点的 three 坐标
FP = np.concatenate([_co(o.data) for o in font_obs])
FP = np.stack([FP[:, 0], FP[:, 2], -FP[:, 1]], axis=1) - np.array([BASIN.x, 0.0, BASIN.z])
FR = np.hypot(FP[:, 0], FP[:, 2])
TOP_Y = float(FP[:, 1].max())
band = FP[:, 1] > TOP_Y - 0.04
RIM_IN, RIM_OUT = float(np.percentile(FR[band], 8)), float(np.percentile(FR[band], 92))
WATER_Y = round(TOP_Y - 0.03, 3)                  # 盆里的内壁差不多是直的：水位放到盆沿下 3 厘米
near = (np.abs(FP[:, 1] - WATER_Y) < 0.012) & (FR < RIM_IN * 1.15)
WATER_R = round(float(FR[near].min()) * 0.97 if near.any() else RIM_IN * 0.92, 3)
print(f'[font] 盆沿 {TOP_Y:.3f} 米，盆口 {RIM_IN:.3f}–{RIM_OUT:.3f}，水面半径 {WATER_R} @ {WATER_Y}')
with hot('work'):
    disc(gb, WATER_R, 48, mat('basin_water', '#0b1418'), (0, WATER_Y - 0.002, 0))


def rim_y(x, z):
    """盆沿（以盆中心为原点）x, z 那一点的高度：扫描的盆沿不平。"""
    m = (np.hypot(FP[:, 0] - x, FP[:, 2] - z) < 0.05) & (FP[:, 1] > TOP_Y - 0.08)
    return float(FP[m, 1].max()) if m.any() else TOP_Y


GEM_COLORS = ['#e8b04a', '#e0577a', '#4fa3e0', '#59c27a']
GEMS = []
brass = mat('brass', '#a8823e')
RG = (WATER_R + RIM_OUT) / 2 + 0.005
for i in range(len(GEM_COLORS)):
    a = math.radians(-48 + i * 32)          # 盆沿前面（朝镜头的一侧）
    x, z = math.sin(a) * RG, math.cos(a) * RG
    p = BASIN + Vector((x, rim_y(x, z) + 0.002, z))
    with hot('work'):
        for k in range(3):                  # 三根小爪
            b = k / 3 * math.tau
            rod(tuple(p + Vector((math.cos(b) * 0.016, 0, math.sin(b) * 0.016))), tuple(p + Vector((math.cos(b) * 0.012, 0.028, math.sin(b) * 0.012))), 0.0025, brass, 4)
        # 水晶：六棱双锥，每颗一个材质（gem0…），浏览器按材质名拆出来单独移动
        gm = mat(f'gem{i}', GEM_COLORS[i])
        c = p + Vector((0, 0.06, 0))
        cyl(I, 0.0, 0.022, 0.056, 6, gm, tuple(c + Vector((0, 0.028, 0))))
        cyl(I, 0.022, 0.0, 0.03, 6, gm, tuple(c - Vector((0, 0.015, 0))))
    GEMS.append(tuple(c))
    BASES.append(round(p.y, 4))
# 镜头框住水面（size 是半宽、半高，跟着水面大小走）
VIEWS['work'] = dict(target=tuple(BASIN + Vector((0, WATER_Y + 0.015, 0.04))), size=(WATER_R * 1.33, WATER_R * 1.12), dir=(0, 1.25, 1))
K = 10

# ---------- 左：壁炉（壁炉台正中放水晶球 = 关于我）----------
FPHI = -45
gf = wall_at(FPHI)
F_W, F_D = 1.5, 0.5
OW, OH, OB = 0.96, 0.86, 0.06
fstone = tmat('fire_stone', STONE, 1.6, '#9c9488')
brick = tmat('brick', BRICK, 1.1, '#9a8a80')
K = 9
quad(gf, (F_W - OW) / 2, H, fstone, (-(OW + F_W) / 4, H / 2, F_D))
quad(gf, (F_W - OW) / 2, H, fstone, ((OW + F_W) / 4, H / 2, F_D))
quad(gf, OW, H - OH, fstone, (0, (OH + H) / 2, F_D))
quad(gf, OW, OB, fstone, (0, OB / 2, F_D))
quad(gf, F_D, H, fstone, (-F_W / 2, H / 2, F_D / 2), (0, -math.pi / 2, 0))
quad(gf, F_D, H, fstone, (F_W / 2, H / 2, F_D / 2), (0, math.pi / 2, 0))
K = 14
fire_c = world(gf, (0, 0.4, 0.3))
with hot('fire'):
    BK = 0.06
    quad(gf, 0.8, OH - OB, brick, (0, (OB + OH) / 2, BK))
    for sx in (-1, 1):
        poly([world(gf, (sx * OW / 2, OB, F_D)), world(gf, (sx * 0.4, OB, BK)), world(gf, (sx * 0.4, OH, BK)), world(gf, (sx * OW / 2, OH, F_D))], brick, toward=fire_c)
    poly([world(gf, (-OW / 2, OH, F_D)), world(gf, (OW / 2, OH, F_D)), world(gf, (0.4, OH, BK)), world(gf, (-0.4, OH, BK))], mat('soot', '#141110'), toward=fire_c)
    poly([world(gf, (-OW / 2, OB, F_D)), world(gf, (OW / 2, OB, F_D)), world(gf, (0.4, OB, BK)), world(gf, (-0.4, OB, BK))], brick, toward=fire_c)
    for sx in (-1, 1):
        box(gf, 0.16, 1.2, 0.09, fstone, sx * (OW / 2 + 0.08), 0.6, F_D + 0.045)
    box(gf, OW + 0.32, 0.15, 0.08, fstone, 0, OH + 0.075, F_D + 0.04)
    # 柴架 + 三根木柴
    for sx in (-1, 1):
        rod(world(gf, (sx * 0.26, OB, 0.42)), world(gf, (sx * 0.26, 0.2, 0.42)), 0.012, iron, 6)
        rod(world(gf, (sx * 0.26, 0.12, 0.42)), world(gf, (sx * 0.26, 0.12, 0.12)), 0.01, iron, 6)
    bark = mat('log', '#3a2818')
    rod(world(gf, (-0.34, 0.15, 0.28)), world(gf, (0.34, 0.15, 0.3)), 0.055, bark, 10)
    rod(world(gf, (-0.3, 0.13, 0.18)), world(gf, (0.3, 0.13, 0.16)), 0.05, bark, 10)
    rod(world(gf, (-0.2, 0.2, 0.36)), world(gf, (0.18, 0.27, 0.2)), 0.045, bark, 10)
    with glow():
        box(gf, 0.6, 0.012, 0.3, emit('emit.fire.embers', 'fire', '#ff5a1e', 2.5), 0, OB + 0.02, 0.25)
    # 火苗不进模型：浏览器里在这里竖几片着色器画的火（manifest 的 fire）
FIRE = dict(pos=world(gf, (0, OB + 0.06, 0.27)), w=0.62, h=0.55)
FIRE_LIGHTS = [world(gf, (x, 0.36, 0.3)) for x in (-0.2, 0.0, 0.2)]
K = 9
box(gf, 1.8, 0.06, 0.62, mat('hearth', '#5d5852'), 0, 0.03, F_D + 0.31)
MANTEL_Y = 1.3
box(gf, 1.7, 0.08, 0.34, mat('mantel', '#7d766c'), 0, MANTEL_Y - 0.04, F_D + 0.12)
BASES.append(MANTEL_Y)
mz = F_D + 0.13
# 壁炉台上：左边单支烛台、天使像，右边高脚杯、三头烛台；正中是水晶球
with hot('candles'):
    vendor('brass_candleholders', gf @ M((-0.7, MANTEL_Y, mz)), pieces=['brass_candleholder_01'], tris=14000)
with hot('candles'):
    vendor('brass_candleholders', gf @ M((0.66, MANTEL_Y, mz), (0, 0.2, 0)), pieces=['brass_candleholder_02'])
vendor('gothic_statue', gf @ M((-0.42, MANTEL_Y, mz), (0, 0.35, 0)), height=0.34, tris=5500)
vendor('brass_goblets', gf @ M((0.38, MANTEL_Y, mz + 0.03)), pieces=['brass_goblet_01'], tris=5000)
# 水晶球：铜座 + 三根爪（球本身浏览器里画，带一点流动的雾）
ORB_R = 0.115
og = gf @ M((0, MANTEL_Y, mz))
K = 22
with hot('about'):
    cyl(og, 0.065, 0.08, 0.025, 24, brass, (0, 0.0125, 0))
    cyl(og, 0.035, 0.05, 0.03, 16, brass, (0, 0.04, 0))
    ORB = world(og, (0, 0.055 + ORB_R * 0.92, 0))
    for k in range(3):
        b = k / 3 * math.tau
        rod(world(og, (math.cos(b) * 0.03, 0.05, math.sin(b) * 0.03)), world(og, (math.cos(b) * 0.07, 0.055 + ORB_R * 0.5, math.sin(b) * 0.07)), 0.005, brass, 5)
    hot_points([Vector(ORB) + Vector((sx * ORB_R, sy * ORB_R, sz * ORB_R)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)])
FN = inward(FPHI)
ORB_TEXT = dict(pos=tuple(Vector(ORB) + Vector((0, 0.52, 0)) + FN * 0.05), size=(0.9, 0.8), dir=tuple(FN))
# 镜头要同时装下水晶球和它上方浮现的文字（球底到文字顶约 1 米；size 是半宽、半高）
VIEWS['about'] = dict(target=tuple(Vector(ORB) + Vector((0, 0.4, 0))), size=(0.5, 0.52), dir=tuple(FN + Vector((0, 0.12, 0))))
K = 10

# ---------- 左墙：扶手椅（朝着壁炉）+ 小茶几 ----------
vendor('ArmChair_01', G((-1.72, 0, -0.12), (0, math.radians(196), 0)))
vendor('throw_pillows_01', G((-1.72, 0.42, -0.12), (0, math.radians(196), 0)), pieces=['throw_pillows_01_pillow02'], scale=0.8,
       anchor=(0.5, 0, 0.5), rot=(0.15, 0, 0))
gt = G((-2.42, 0, -0.82), (0, 0.4, 0))
wood = mat('wood_dark', '#3a2617')
cyl(gt, 0.24, 0.24, 0.03, 24, wood, (0, 0.6, 0))
cyl(gt, 0.03, 0.045, 0.58, 10, wood, (0, 0.3, 0))
for k in range(3):
    b = k / 3 * math.tau
    rod(world(gt, (0, 0.1, 0)), world(gt, (math.cos(b) * 0.2, 0.01, math.sin(b) * 0.2)), 0.018, wood, 6)
BASES.append(0.615)
vendor('tea_set_01', gt @ M((-0.06, 0.615, 0.02)), pieces=['tea_set_01_teapot_01', 'tea_set_01_teapot_01_lid'], anchor=(0.5, 0, 0.5), tris=9000)
vendor('tea_set_01', gt @ M((0.1, 0.615, 0.1)), pieces=['tea_set_01_cup_small_01', 'tea_set_01_saucer_circular_04'], anchor=(0.5, 0, 0.5))
CANDLES = []  # 程序化蜡烛的火焰位置（three 坐标）
cand = mat('candle', '#e9e0c8')


def candle(pos, h=0.09, r=0.011):
    p = Vector(pos)
    cyl(I, r, r, h, 10, cand, tuple(p + Vector((0, h / 2, 0))))
    with glow():
        f = p + Vector((0, h + 0.018, 0))
        ball(tuple(f), 0.0075, emit('emit.candles.flame', 'candles', '#ffcf7a', 6.0), 1)
        cyl(I, 0.0, 0.0065, 0.022, 6, emit('emit.candles.flame', 'candles', '#ffcf7a', 6.0), tuple(f + Vector((0, 0.012, 0))))
    CANDLES.append(tuple(p + Vector((0, h + 0.02, 0))))


with hot('candles'):
    obs = vendor('wooden_candlestick', gt @ M((0.08, 0.615, -0.1)), tris=3500)
    lo, hi = bbox3(obs)
    candle(((lo[0] + hi[0]) / 2, hi[1] - 0.012, (lo[2] + hi[2]) / 2), 0.1, 0.012)

# ---------- 左后：书架（书单）----------
K = 12
g = wall_at(-112.5)
SH_W, SH_D, SH_H = 1.25, 0.34, 2.55
with hot('shelf'):
    sw = mat('shelf', '#3d2a1a')
    box(g, SH_W, SH_H, 0.015, sw, 0, SH_H / 2, 0.01)
    for sx in (-1, 1):
        box(g, 0.035, SH_H, SH_D, sw, sx * (SH_W / 2 - 0.0175), SH_H / 2, SH_D / 2)
    SHELVES = [0.08, 0.5, 0.92, 1.34, 1.76, 2.18, SH_H - 0.015]
    for y in SHELVES:
        box(g, SH_W - 0.07, 0.03, SH_D - 0.01, sw, 0, y, SH_D / 2)
    BOOKS = [mat(f'book{i}', c) for i, c in enumerate(['#5a1f1f', '#23344f', '#2f4a33', '#7a6030', '#3f2a4a', '#5e5a4e', '#6e3a20', '#1c2a36', '#8a7650'])]

    def fill(y, a, b):
        x = a
        while True:
            w, h = 0.025 + rnd.random() * 0.04, 0.2 + rnd.random() * 0.16
            if x + w > b:
                break
            if rnd.random() < 0.07 and x + h < b:
                box(g, w, h, 0.22, rnd.choice(BOOKS), x + h * 0.35, y + 0.015 + h * 0.47, 0.15, (0, 0, -0.45))
                x += h * 0.5
                continue
            box(g, w, h, 0.2 + rnd.random() * 0.06, rnd.choice(BOOKS), x + w / 2, y + 0.015 + h / 2, 0.15)
            x += w + 0.002 + (0.05 if rnd.random() < 0.08 else 0)

    x_in = SH_W / 2 - 0.04
    fill(SHELVES[0], -x_in, x_in)
    fill(SHELVES[1], -x_in, 0.2)
    fill(SHELVES[2], -0.25, x_in)
    fill(SHELVES[3], -x_in, x_in)
    fill(SHELVES[4], -x_in, 0.1)
    fill(SHELVES[5], -0.3, x_in)
    # 几个药瓶、一个小罐子
    for k, c in enumerate(['#3d6b5a', '#6b3d5a', '#8a7a3d']):
        cyl(g, 0.03, 0.045, 0.14, 12, mat(f'jar{k}', c), (0.25 + k * 0.11, SHELVES[1] + 0.085, 0.16))
    cyl(g, 0.08, 0.09, 0.16, 16, mat('urn', '#6a5a48'), (0.45, SHELVES[4] + 0.095, 0.16))
VIEWS['shelf'] = dict(target=world(g, (0, 1.3, SH_D)), size=(0.68, 0.95), dir=tuple(inward(-112.5) + Vector((0, 0.2, 0))))  # 稍微从高处看，扶手椅的椅背不挡书架
K = 10

# ---------- 窗两边：挂毯（深红底、金边、八角星；原创纹样）----------
for phi in (-22.5, 22.5):
    g = wall_at(phi, 0.015)
    tw_, th = 0.6, 1.75
    y0 = 1.5
    red, gold = mat('tapestry', '#5e1517'), mat('tapestry_gold', '#a07d3c')
    quad(g, tw_, th, red, (0, y0 + th / 2, 0.0))
    poly([world(g, (-tw_ / 2, y0, 0)), world(g, (0, y0 - 0.18, 0)), world(g, (0, y0, 0))], red, normal=tuple(inward(phi)))
    poly([world(g, (0, y0, 0)), world(g, (0, y0 - 0.18, 0)), world(g, (tw_ / 2, y0, 0))], red, normal=tuple(inward(phi)))
    for sx in (-1, 1):
        quad(g, 0.03, th, gold, (sx * (tw_ / 2 - 0.035), y0 + th / 2, 0.002))
    quad(g, tw_ - 0.04, 0.03, gold, (0, y0 + th - 0.05, 0.002))
    quad(g, tw_ - 0.04, 0.03, gold, (0, y0 + 0.06, 0.002))
    cy = y0 + th * 0.6
    quad(g, 0.22, 0.22, gold, (0, cy, 0.003))
    quad(g, 0.22, 0.22, gold, (0, cy, 0.003), (0, 0, math.pi / 4))
    disc(g @ M(rot=(math.pi / 2, 0, 0)), 0.085, 24, red, (0, 0.004, -cy))
    disc(g @ M(rot=(math.pi / 2, 0, 0)), 0.035, 16, gold, (0, 0.005, -cy))
    rod(world(g, (-tw_ / 2 - 0.06, y0 + th + 0.03, 0.03)), world(g, (tw_ / 2 + 0.06, y0 + th + 0.03, 0.03)), 0.012, brass, 8)

# ---------- 右：书桌（羊皮纸 = 联系方式）----------
DPHI = 45
gd = wall_at(DPHI)
DESK_TOP = 0.78
K = 12
dw = mat('desk', '#4a2f1c')
box(gd, 1.3, 0.04, 0.64, dw, 0, DESK_TOP - 0.02, 0.36)
box(gd, 1.22, 0.1, 0.58, dw, 0, DESK_TOP - 0.09, 0.36)
for sx in (-1, 1):
    for sz in (-1, 1):
        cyl(gd, 0.024, 0.03, DESK_TOP - 0.14, 10, dw, (sx * 0.58, (DESK_TOP - 0.14) / 2, 0.36 + sz * 0.26))
box(gd, 0.3, 0.06, 0.006, mat('drawer', '#5a3a22'), 0, DESK_TOP - 0.09, 0.652)
box(gd, 0.04, 0.012, 0.012, brass, 0, DESK_TOP - 0.09, 0.66)
# 桌面后面一排小格子（放卷轴）
box(gd, 1.2, 0.26, 0.02, dw, 0, DESK_TOP + 0.13, 0.06)
for x in (-0.6, -0.2, 0.2, 0.6):
    box(gd, 0.02, 0.26, 0.18, dw, x, DESK_TOP + 0.13, 0.14)
box(gd, 1.22, 0.02, 0.18, dw, 0, DESK_TOP + 0.27, 0.14)
for k in range(5):
    rod(world(gd, (-0.15 + k * 0.03, DESK_TOP + 0.03 + (k % 2) * 0.028, 0.05)), world(gd, (-0.15 + k * 0.03, DESK_TOP + 0.03 + (k % 2) * 0.028, 0.22)), 0.014,
        mat('scroll', '#cdb88e'), 10)
BASES.append(DESK_TOP)
NOTE_ROT = -0.1
gp = gd @ M((0.02, DESK_TOP, 0.42), (0, NOTE_ROT, 0))
K = 25
with hot('online', NOTE_ROT - math.radians(DPHI)):
    box(gp, 0.3, 0.003, 0.4, mat('parchment', '#d9c49a'), 0, 0.0015, 0)
    for sz in (-1, 1):
        rod(world(gp, (-0.15, 0.011, sz * 0.2)), world(gp, (0.15, 0.011, sz * 0.2)), 0.011, mat('parchment_roll', '#c9b182'), 12)
    # 墨水瓶 + 羽毛笔（斜插在瓶里）+ 火漆
    ink = gp @ M((0.25, 0, -0.12))
    cyl(ink, 0.034, 0.038, 0.045, 14, mat('inkwell', '#1b2430'), (0, 0.0225, 0))
    cyl(ink, 0.016, 0.02, 0.018, 12, mat('inkwell', '#1b2430'), (0, 0.054, 0))
    qa, qb = world(ink, (0, 0.04, 0)), world(ink, (0.07, 0.33, -0.08))
    rod(qa, qb, 0.0025, mat('quill_shaft', '#e8dfc8'), 6, r2=0.0012)
    m_, L_ = along(world(ink, (0.025, 0.14, -0.03)), qb)
    vane = mat('quill', '#efe8d8')
    T.tag(_faces(bmesh.ops.create_cube(T.bm, size=1.0, matrix=C @ m_ @ M(scale=(0.036, L_ * 0.92, 0.002)))['verts']), vane)
    T.tag(_faces(bmesh.ops.create_cube(T.bm, size=1.0, matrix=C @ m_ @ M((0.008, 0, 0), (0, 0.6, 0), (0.024, L_ * 0.8, 0.002)))['verts']), vane)
    rod(world(gp, (-0.2, 0.008, 0.1)), world(gp, (-0.2, 0.008, 0.2)), 0.007, mat('wax', '#8a1a1a'), 8)
    cyl(gp, 0.016, 0.018, 0.04, 12, brass, (-0.21, 0.02, -0.02))
    cyl(gp, 0.026, 0.026, 0.004, 16, mat('seal', '#7a1414'), (0.21, 0.002, 0.15))
VIEWS['online'] = dict(target=world(gp, (0, 0.004, 0.01)), size=(0.2, 0.24),
                       dir=tuple(Vector((math.sin(NOTE_ROT - math.radians(DPHI)) * -0.0, 0, 0)) + inward(DPHI) * 0.42 + Vector((0, 1, 0))))
K = 12
# 桌上：左后三头大烛台、右后一摞书和一只高脚杯；墙上一幅画
with hot('candles'):
    vendor('brass_candleholders', gd @ M((-0.44, DESK_TOP, 0.28), (0, 0.4, 0)), pieces=['brass_candleholder_03'], height=0.62, uvk=12)
gs = gd @ M((0.42, DESK_TOP, 0.28), (0, -0.2, 0))
yy = 0
for k, (w, h, d, c) in enumerate([(0.24, 0.05, 0.18, '#3a1c1c'), (0.22, 0.04, 0.17, '#1f3326'), (0.2, 0.045, 0.15, '#5a4826')]):
    box(gs, w, h, d, mat(f'stack{k}', c), 0.004 * k, yy + h / 2, 0, (0, (-1) ** k * 0.07, 0))
    yy += h
vendor('brass_goblets', gd @ M((0.48, DESK_TOP, 0.55)), pieces=['brass_goblet_02'])
vendor('fancy_picture_frame_02', gd @ M((0.1, 1.42, 0.0)), scale=0.95, anchor=(0.5, 0, 0), tris=6000)
# 椅子：拉开一点、斜着放，不挡羊皮纸
gc = gd @ M((-0.62, 0, 0.98), (0, 0.75, 0))
chw = mat('chair', '#3b2616')
box(gc, 0.44, 0.04, 0.42, chw, 0, 0.46, 0)
for sx in (-1, 1):
    for sz in (-1, 1):
        box(gc, 0.035, 0.46, 0.035, chw, sx * 0.19, 0.23, sz * 0.18)
    box(gc, 0.035, 0.5, 0.035, chw, sx * 0.19, 0.73, -0.18)
for y in (0.68, 0.84, 0.96):
    box(gc, 0.38, 0.05, 0.02, chw, 0, y, -0.18)

# 吊灯：挂在书桌和水盆之间
with hot('candles'):
    obs = vendor('lantern_chandelier_01', G((BASIN.x, 3.78, BASIN.z)), anchor=(0.5, 1.0, 0.5))
lo, hi = bbox3(obs)
rod((BASIN.x, hi[1] - 0.01, BASIN.z), (BASIN.x, H - 0.25, BASIN.z), 0.007, iron, 6)

# ---------- 右墙：玻璃柜（柜顶放药瓶）、盆栽 ----------
gk = wall_at(90, 0.1)
obs = vendor('vintage_cabinet_01', gk, scale=0.78, anchor=(0.5, 0, 0.0), tris=16000)
lo, hi = bbox3(obs)
top = hi[1]
for k, (c, r, h) in enumerate([('#2f5a4a', 0.045, 0.2), ('#5a2f4a', 0.035, 0.16), ('#7a5a2a', 0.05, 0.12), ('#2a3a5a', 0.03, 0.22), ('#4a5a2a', 0.04, 0.14)]):
    x = -0.55 + k * 0.26
    cyl(gk, r, r, h, 14, mat(f'potion{k}', c), (x, top + h / 2, 0.28))
    cyl(gk, r * 0.35, r * 0.4, 0.05, 10, mat(f'potion{k}', c), (x, top + h + 0.025, 0.28))
    cyl(gk, r * 0.38, r * 0.38, 0.02, 10, mat('cork', '#8a6a44'), (x, top + h + 0.06, 0.28))
vendor('potted_plant_02', wall_at(76, 0.4), height=1.0, tris=9000)

# ---------- 右前：棋桌（两个棋子会自己走）----------
gch = G((1.6, 0, 0.12), (0, -0.55, 0))
tw = mat('table', '#3e2818')
box(gch, 0.62, 0.04, 0.62, tw, 0, 0.68, 0)
for sx in (-1, 1):
    for sz in (-1, 1):
        box(gch, 0.045, 0.66, 0.045, tw, sx * 0.26, 0.33, sz * 0.26)
for sz in (-1, 1):
    cyl(gch, 0.17, 0.17, 0.04, 20, tw, (0, 0.44, sz * 0.62))
    for k in range(3):
        b = k / 3 * math.tau + 0.3
        box(gch, 0.03, 0.42, 0.03, tw, math.cos(b) * 0.12, 0.21, sz * 0.62 + math.sin(b) * 0.12)
CH_Y = 0.70
BASES.append(CH_Y)
chess = load_asset('chess_set', 16000)
SQ = 0.058  # 原模型一格 5.8 厘米


def square(name):
    lo_, hi_ = _co(chess[name]).min(axis=0), _co(chess[name]).max(axis=0)
    c = (lo_ + hi_) / 2
    return round(c[0] / SQ + 3.5), round(-c[1] / SQ + 3.5)  # (列, 行)：白方在 -z，行 0 = 白方底线


# 开局走了几步：两边中间的兵各进两格，各出一匹马
MOVES = {(4, 1): (0, 2), (4, 6): (0, -2), (6, 0): (-1, 2), (1, 7): (1, -2)}
offsets, by_sq = {}, {}
for name in chess:
    if not name.startswith('piece_'):
        continue
    sq = square(name)
    by_sq[sq] = name
    d = MOVES.get(sq)
    if d:
        offsets[name] = (d[0] * SQ, 0, d[1] * SQ)  # three 坐标：列往 +x、行往 +z
# 会动的两个子：白方 d 列的兵（前进一格再退回来）、黑方 g 列的马（跳出去再跳回来）
movers = [(by_sq[(3, 1)], (0, 1), 0.0), (by_sq[(6, 7)], (-1, -2), 0.05)]
mover_mats = {}
for i, (name, _, _) in enumerate(movers):
    mm = chess[name].materials[0].copy()
    mm.name = f'chess_mover{i}'
    mover_mats[name] = mm
CH_S = 0.82
vendor('chess_set', gch @ M((0, CH_Y, 0)), scale=CH_S, offsets=offsets, mats=mover_mats)
CHESS = []
rot_ch = Matrix.Rotation(-0.55, 4, 'Y')
for i, (name, (df, dr), hop) in enumerate(movers):
    d = rot_ch @ Vector((df * SQ * CH_S, 0, dr * SQ * CH_S))
    CHESS.append(dict(mat=f'chess_mover{i}', delta=[round(v, 4) for v in d], hop=hop))

# ---------- 壁灯：铁背板 + 伸出来的托 + 铜碟 + 蜡烛 ----------
SCONCES = []
for phi, ox in ((-67.5, 0.0), (67.5, -0.2), (-135, 0.35), (135, -0.35)):
    g = wall_at(phi)
    with hot('candles'):
        box(g, 0.07, 0.22, 0.015, iron, ox, 2.05, 0.008)
        rod(world(g, (ox, 2.0, 0.01)), world(g, (ox, 2.06, 0.17)), 0.008, iron, 6)
        rod(world(g, (ox, 2.13, 0.01)), world(g, (ox, 2.08, 0.15)), 0.006, iron, 6)
        cyl(g, 0.055, 0.035, 0.02, 16, brass, (ox, 2.07, 0.18))
        n0 = len(CANDLES)
        candle(world(g, (ox, 2.08, 0.18)), 0.13, 0.016)
        SCONCES.append(CANDLES.pop(n0))

# ---------- 右后角：木箱 ----------
gx = wall_at(125, 0.35, )
box(gx, 0.8, 0.42, 0.45, mat('chest', '#4a3220'), 0, 0.21, 0.22)
box(gx, 0.82, 0.06, 0.47, mat('chest_lid', '#3e2a1a'), 0, 0.45, 0.22)
for x in (-0.3, 0.3):
    box(gx, 0.04, 0.49, 0.48, iron, x, 0.245, 0.22)
vendor('brass_goblets', gx @ M((0.15, 0.48, 0.22)), pieces=['brass_goblet_03'])

# ---------- 补光：书架上两支蜡烛、棋桌一角一支、柜子和木箱之间一座落地烛台（右半边和书架原来太暗）----------
# 每处单独一个热点盒子（一个 with hot 一个盒子），不然一个盒子会框住半间屋子
gsh = wall_at(-112.5)
for y, x in ((SHELVES[2], -0.42), (SHELVES[4], 0.2)):
    with hot('candles'):
        cyl(gsh, 0.03, 0.032, 0.008, 14, brass, (x, y + 0.019, 0.2))
        candle(world(gsh, (x, y + 0.023, 0.2)), 0.1, 0.013)
with hot('candles'):
    cyl(gch, 0.04, 0.045, 0.01, 14, brass, (-0.245, CH_Y + 0.005, 0.245))
    candle(world(gch, (-0.245, CH_Y + 0.01, 0.245)), 0.12, 0.014)
gcb = wall_at(107, 0.4)
with hot('candles'):
    for k in range(3):
        b = k / 3 * math.tau
        rod(world(gcb, (0, 0.2, 0)), world(gcb, (math.cos(b) * 0.2, 0.0, math.sin(b) * 0.2)), 0.01, iron, 6)
    rod(world(gcb, (0, 0.15, 0)), world(gcb, (0, 1.36, 0)), 0.014, iron, 8)
    cyl(gcb, 0.11, 0.06, 0.03, 18, iron, (0, 1.36, 0))
    for dx, dz, h in ((0, 0, 0.2), (0.065, 0.035, 0.15), (-0.06, 0.045, 0.13)):
        candle(world(gcb, (dx, 1.375, dz)), h, 0.016)

# =====================================================================================================
# 建网格
# =====================================================================================================
HOT = hot_boxes()


TEX_MAX = {STONE: 768, BRICK: 512}  # 墙面贴图缩一缩（原图 1k、将近 1 MB 一张）；缩过之后导出时会按 export_jpeg_quality 重新压缩


def load_image(path):
    for im in bpy.data.images:
        if im.filepath == path:
            return im
    im = bpy.data.images.load(path)
    s = TEX_MAX.get(path)
    if s and max(im.size) > s:
        im.scale(s, s)
    return im


RELINK = []  # 导出前把"贴图 × 色调"改回直接连贴图（色调写进 manifest，浏览器里乘）


def make_material(name, color):
    mt = bpy.data.materials.new(name)
    nt = tree(mt)
    nt.nodes.clear()
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(bsdf.outputs[0], out.inputs['Surface'])
    bsdf.inputs['Base Color'].default_value = (*srgb(color), 1)
    bsdf.inputs['Roughness'].default_value = 0.8
    mt.diffuse_color = (*srgb(color), 1)
    td = TEXDEF.get(name)
    if td:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = load_image(td['img'])
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'UVMap'
        nt.links.new(uvn.outputs[0], tex.inputs['Vector'])
        mul = nt.nodes.new('ShaderNodeVectorMath')
        mul.operation = 'MULTIPLY'
        nt.links.new(tex.outputs['Color'], mul.inputs[0])
        mul.inputs[1].default_value = srgb(td['tint'])
        nt.links.new(mul.outputs[0], bsdf.inputs['Base Color'])
        RELINK.append((nt, tex, mul, bsdf))
    e = EMIT.get(name)
    if e:
        bsdf.inputs['Emission Color'].default_value = (*srgb(e['color']), 1)
        bsdf.inputs['Emission Strength'].default_value = e['power']
    return mt


def planar_uv(me, mw):
    """贴图 UV：塔墙按圆周展开，其他面按自己的朝向投影到世界坐标上。没有贴图的面 UV 随便（全是 0）。"""
    uv = me.uv_layers.new(name='UVMap')
    np_ = len(me.polygons)
    if not np_:
        return
    mi = np.empty(np_, dtype=np.int32)
    me.polygons.foreach_get('material_index', mi)
    nrm = np.empty(np_ * 3, dtype=np.float64)
    me.polygons.foreach_get('normal', nrm)
    nrm = nrm.reshape(-1, 3)
    tot = np.empty(np_, dtype=np.int32)
    me.polygons.foreach_get('loop_total', tot)
    vi = np.empty(len(me.loops), dtype=np.int32)
    me.loops.foreach_get('vertex_index', vi)
    co = _co(me)[vi]
    lp = np.repeat(np.arange(np_), tot)
    out = np.zeros((len(me.loops), 2), dtype=np.float64)
    names = {i: n for n, (i, _) in mw.mats.items()}
    for idx, name in names.items():
        td = TEXDEF.get(name)
        if not td:
            continue
        sel = mi[lp] == idx
        p, n = co[sel], nrm[lp[sel]]
        if td['mode'] == 'tower':
            ang = np.arctan2(p[:, 0], p[:, 1])
            u, v = ang * R, p[:, 2]
        else:
            flat = np.abs(n[:, 2]) > 0.7
            t = np.stack([-n[:, 1], n[:, 0], np.zeros(len(n))], axis=1)
            t /= np.maximum(np.linalg.norm(t, axis=1, keepdims=True), 1e-9)
            u = np.where(flat, p[:, 0], (p * t).sum(axis=1))
            v = np.where(flat, p[:, 1], p[:, 2])
        out[sel, 0], out[sel, 1] = u / td['tile'], v / td['tile']
    uv.data.foreach_set('uv', out.ravel().astype(np.float32))


def build(mw):
    me = bpy.data.meshes.new(mw.name)
    mw.bm.to_mesh(me)
    mw.bm.free()
    if 'hot' in me.attributes:
        me.attributes.remove(me.attributes['hot'])
    ob = bpy.data.objects.new(mw.name, me)
    scene.collection.objects.link(ob)
    for name, (i, color) in sorted(mw.mats.items(), key=lambda kv: kv[1][0]):
        me.materials.append(make_material(name, color))
    planar_uv(me, mw)
    return ob


room = build(ROOMM)
glow_ob = build(GLOWM)

# 第三方模型里的火焰 / 灯芯挪进 Glow；其余的合并进 Room
FLAMES = []  # 第三方烛台的火焰位置


def split_glow(ob):
    me = ob.data
    idx = {i for i, m in enumerate(me.materials) if m and m.name in EMIT}
    if not idx:
        return None
    bm, gbm = bmesh.new(), bmesh.new()
    bm.from_mesh(me)
    gbm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index in idx], context='FACES')
    bmesh.ops.delete(gbm, geom=[f for f in gbm.faces if f.material_index not in idx], context='FACES')
    # 每一团连在一起的火焰面 = 一朵火焰，记下中心（放点光源）
    gbm.faces.ensure_lookup_table()
    seen = set()
    for f in gbm.faces:
        if f.index in seen:
            continue
        stack, pts = [f], []
        seen.add(f.index)
        while stack:
            x = stack.pop()
            pts.extend(v.co for v in x.verts)
            for e in x.edges:
                for y in e.link_faces:
                    if y.index not in seen:
                        seen.add(y.index)
                        stack.append(y)
        c = CI @ (sum(pts, Vector()) / len(pts))
        if not any((c - q).length < 0.02 for q in FLAMES):
            FLAMES.append(c)
    gm = me.copy()
    gbm.to_mesh(gm)
    bm.to_mesh(me)
    bm.free()
    gbm.free()
    gob = bpy.data.objects.new(ob.name + '_glow', gm)
    scene.collection.objects.link(gob)
    return gob


glow_parts = [g_ for g_ in (split_glow(p['ob']) for p in PLACED) if g_]
for p in PLACED:
    me = p['ob'].data
    a = me.attributes.new('uvk', 'INT', 'FACE')
    a.data.foreach_set('value', [p['uvk']] * len(me.polygons))


def join(target, others):
    if not others:
        return
    bpy.ops.object.select_all(action='DESELECT')
    for o in others:
        o.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()


join(room, [p['ob'] for p in PLACED])
join(glow_ob, glow_parts)
me = room.data
print(f'[geo] Room {len(me.polygons)} faces / {len(me.materials)} materials, Glow {len(glow_ob.data.polygons)} faces, '
      f'{sum(len(p.vertices) - 2 for p in me.polygons)} tris, flames {len(FLAMES)}, {time.time() - T0:.0f}s')


# =====================================================================================================
# 灯光（分四层烘焙）
# =====================================================================================================
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


def sky_plane():
    """窗外：一块贴着夜景渲染图的发光板（只发光，不挡月光）。"""
    path = os.path.join(OUTD, 'view_full.jpg')
    d = 6.0
    w = 2 * d * math.tan(math.radians(TOWER_VIEW['hfov'] / 2))
    h = w / TOWER_VIEW['aspect']
    m = bpy.data.meshes.new('sky')
    b = bmesh.new()
    mm = C @ M((WIN_C[0], WIN_C[1], WIN_C[2] - d))
    b.faces.new([b.verts.new(mm @ Vector((sx * w / 2, sy * h / 2, 0))) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    b.to_mesh(m)
    b.free()
    mt = bpy.data.materials.new('sky')
    nt = tree(mt)
    nt.nodes.clear()
    em, out = nt.nodes.new('ShaderNodeEmission'), nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], out.inputs['Surface'])
    em.inputs['Strength'].default_value = 2.0
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
        print('[warn] 没找到 view_full.jpg（先跑 render_tower_view.py），窗外用纯色代替')
        em.inputs['Color'].default_value = (*srgb('#26304c'), 1)
    m.materials.append(mt)
    ob = bpy.data.objects.new('sky', m)
    ob.visible_shadow = False
    scene.collection.objects.link(ob)
    return ob


moon_dir = Vector(TOWER_MOON).normalized()
LAMP_POS = None
for f in FLAMES:  # 吊灯的灯芯（最高的那团"火焰"）
    if f.y > 2.0 and (LAMP_POS is None or f.y > LAMP_POS.y):
        LAMP_POS = f
flame_pts = [f for f in FLAMES if f is not LAMP_POS] + [Vector(c) for c in CANDLES]
LAYERS = {
    'ambient': [
        light('moon', 'SUN', 3.2, '#a9b8ff', (0, 5, -6), tuple(-moon_dir), angle=math.radians(1.2)),
        sky_plane(),
        light('fill', 'AREA', 28, '#5a6a9a', (0, H - 0.3, 0), (0, -1, 0), shape='DISK', size=3.5),
        light('orb', 'POINT', 2.5, '#a9b4ff', ORB, shadow_soft_size=ORB_R * 0.8),
        light('door', 'AREA', 14, '#c9a27a', (0, 1.3, R - 0.05), (0, -0.15, -1), shape='RECTANGLE', size=0.9, size_y=2.0),
    ],
    'candles': [
        *[light(f'flame{i}', 'POINT', 2.2, '#ffb466', tuple(p), shadow_soft_size=0.01) for i, p in enumerate(flame_pts)],
        *([light('lantern', 'POINT', 16, '#ffb466', tuple(LAMP_POS), shadow_soft_size=0.04)] if LAMP_POS else []),
        *[light(f'sconce{i}', 'POINT', 8, '#ffb466', p, shadow_soft_size=0.015) for i, p in enumerate(SCONCES)],
    ],
    'fire': [
        *[light(f'fire{i}', 'POINT', 38, '#ff8a3a', p, shadow_soft_size=0.12) for i, p in enumerate(FIRE_LIGHTS)],
        light('fire_mouth', 'AREA', 25, '#ff9a4a', world(gf, (0, 0.45, F_D - 0.02)), tuple(FN), shape='RECTANGLE', size=OW - 0.1, size_y=OH - 0.15),
    ],
    'basin': [
        light('basin_disc', 'AREA', 28, (1, 1, 1), tuple(BASIN + Vector((0, WATER_Y + 0.004, 0))), (0, 1, 0), shape='DISK', size=WATER_R * 2),
        light('basin_up', 'POINT', 4, (1, 1, 1), tuple(BASIN + Vector((0, WATER_Y + 0.12, 0))), shadow_soft_size=0.15),
    ],
}
print(f'[lights] flames {len(flame_pts)}, lantern {LAMP_POS is not None}')
wd = bpy.data.worlds.new('Night')
scene.world = wd
wnt = tree(wd)
wnt.nodes.clear()
bg = wnt.nodes.new('ShaderNodeBackground')
wnt.links.new(bg.outputs[0], wnt.nodes.new('ShaderNodeOutputWorld').inputs['Surface'])
bg.inputs['Color'].default_value = (*srgb('#1a2040'), 1)
bg.inputs['Strength'].default_value = 0.3

# 开场镜头：站在门口附近，水盆在正中偏下，窗户在正后方，左边壁炉、右边书桌
CAMERA = {'pos': [0.0, 1.62, 2.25], 'yaw': 0.0, 'pitch': -0.13, 'fov': 55, 'yawRange': [-1.25, 1.25], 'pitchRange': [-0.7, 0.3]}

# =====================================================================================================
# 预览：不烘焙，直接从某个镜头渲一张（调构图用）
# =====================================================================================================
use_metal(scene, A.samples)
scene.cycles.max_bounces = 4
scene.cycles.diffuse_bounces = 4
scene.cycles.glossy_bounces = 0
scene.cycles.transmission_bounces = 0
scene.cycles.transparent_max_bounces = 4
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False

if A.preview:
    cd = bpy.data.cameras.new('cam')
    cam = bpy.data.objects.new('cam', cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cd.sensor_fit = 'VERTICAL'
    W_, H_ = A.pw, int(A.pw * 9 / 16)
    if A.preview == 'top':
        cd.type = 'ORTHO'
        cd.ortho_scale = 7.2
        cam.matrix_world = C @ M((0, 7, 0), (-math.pi / 2, 0, 0))
        H_ = A.pw
    else:
        if A.preview == 'home':
            pos, yaw, pitch, fov = Vector(CAMERA['pos']), CAMERA['yaw'], CAMERA['pitch'], CAMERA['fov']
        else:
            v = VIEWS[A.preview]
            d = Vector(v['dir']).normalized()
            fov = 44
            tv_ = math.tan(math.radians(fov / 2))
            dist = max(v['size'][0] / (tv_ * 16 / 9), v['size'][1] / tv_) * 1.15
            pos = Vector(v['target']) + d * dist
            yaw, pitch = math.atan2(d.x, d.z), math.asin(-d.y)
        cd.angle = math.radians(fov)
        cam.matrix_world = C @ Matrix.Translation(pos) @ Euler((pitch, yaw, 0), 'ZXY').to_matrix().to_4x4()  # = three 的 'YXZ'
    cd.clip_start = 3.15 if A.preview == 'top' else 0.02  # 俯视图从天花板下面开始看
    scene.render.resolution_x, scene.render.resolution_y = W_, H_
    scene.cycles.samples = A.ps
    scene.cycles.use_denoising = True
    scene.render.image_settings.file_format = 'PNG'
    scene.view_settings.view_transform = 'AgX'
    path = os.path.join(OUTD, f'preview_{A.preview}.png')
    scene.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'[preview] {path} {time.time() - t0:.1f}s')
    sys.exit(0)

# =====================================================================================================
# lightmap UV：smart project → 按 uvk 放大主角物件 → 重新排进一张图集
# =====================================================================================================
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
per_loop = np.repeat(k / 10.0, totals).astype(np.float32)
uv = np.empty(len(me.loops) * 2, dtype=np.float32)
lm.data.foreach_get('uv', uv)
uv = (uv.reshape(-1, 2) * per_loop[:, None]).ravel()
lm.data.foreach_set('uv', uv)
me.attributes.remove(me.attributes['uvk'])
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.pack_islands(rotate=True, margin=0.002)
bpy.ops.object.mode_set(mode='OBJECT')
for a in ('uvk',):
    if a in glow_ob.data.attributes:
        glow_ob.data.attributes.remove(glow_ob.data.attributes[a])
me.uv_layers['UVMap'].active_render = True
print(f'[uv] {time.time() - T0:.0f}s')

# =====================================================================================================
# 烘焙
# =====================================================================================================
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
        out.save(filepath=path, quality=88)
    except TypeError:
        out.save()
    stats = {p: round(float(np.percentile(used, p)), 4) for p in (50, 90, 99)} if used.size else {}
    return scale, stats


glow_ob.hide_render = True
bpy.ops.object.select_all(action='DESELECT')
room.select_set(True)
bpy.context.view_layer.objects.active = room
manifest = {'size': S, 'samples': A.samples, 'blender': bpy.app.version_string, 'built': time.strftime('%Y%m%d-%H%M%S'),
            'layers': {}, 'layerOrder': list(LAYERS)}
all_lights = [ob for obs in LAYERS.values() for ob in obs]
old = {}
if A.skip_bake:
    with open(os.path.join(OUTD, 'manifest.json')) as f:
        old = json.load(f)
    manifest.update({k: old[k] for k in ('size', 'samples', 'built', 'layers')})
    print('[bake] 跳过烘焙，沿用', old['built'])
TB = time.time()
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

# =====================================================================================================
# 导出
# =====================================================================================================
for mt, n in img_nodes:
    mt.node_tree.nodes.remove(n)
for nt, tex, mul, bsdf in RELINK:
    nt.nodes.remove(mul)
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
glow_ob.hide_render = False
bpy.ops.object.select_all(action='DESELECT')
room.select_set(True)
glow_ob.select_set(True)
bpy.context.view_layer.objects.active = room
bpy.ops.export_scene.gltf(filepath=os.path.join(OUTD, 'tower.glb'), export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=False, export_materials='EXPORT', export_normals=False,
                          export_vertex_color='NONE', export_image_format='JPEG', export_jpeg_quality=82,
                          export_lights=False, export_cameras=False,
                          # Draco 压缩几何（浏览器里用 three 的 DRACOLoader 解）。UV 给 14 位：2048 的光照贴图要精确到半个像素
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                          export_draco_position_quantization=14, export_draco_texcoord_quantization=14,
                          export_draco_normal_quantization=10, export_draco_generic_quantization=12)
r3 = lambda v: [round(float(c), 4) for c in v]  # noqa: E731
manifest.update({
    'seconds': old.get('seconds') if A.skip_bake else round(time.time() - TB),
    'camera': CAMERA,
    'window': {'x': WIN_C[0], 'y': WIN_C[1], 'z': WIN_C[2], 'w': TW['w'], 'h': TW['spring'] + TW['w'] * 0.866 - TW['y0']},
    'screens': {
        'water': {'pos': r3(BASIN + Vector((0, WATER_Y, 0))), 'r': WATER_R},
        'orb': {'pos': r3(ORB), 'r': ORB_R, 'text': {'pos': r3(ORB_TEXT['pos']), 'size': list(ORB_TEXT['size']), 'dir': r3(Vector(ORB_TEXT['dir']).normalized())}},
    },
    'emitters': EMIT,
    'tints': {k: v['tint'] for k, v in TEXDEF.items()},
    'glass': GLASS,
    'fire': {'pos': r3(FIRE['pos']), 'dir': r3(FN), 'w': FIRE['w'], 'h': FIRE['h']},
    'gems': {'count': len(GEMS), 'colors': GEM_COLORS, 'holders': [r3(p) for p in GEMS], 'water': r3(BASIN + Vector((0, WATER_Y, 0)))},
    'chess': CHESS,
    'hotspots': HOT,
    'views': {k: {'target': r3(v['target']), 'size': list(v['size']), 'dir': r3(Vector(v['dir']).normalized())} for k, v in VIEWS.items()},
    'vendor': [a if a.startswith('sketchfab/') else f'polyhaven/{a}' for a in USED] + ['polyhaven/stone_wall_04', 'polyhaven/medieval_red_brick'],
})
with open(os.path.join(OUTD, 'manifest.json'), 'w') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
print(f'[done] {OUTD} {time.time() - T0:.0f}s')
