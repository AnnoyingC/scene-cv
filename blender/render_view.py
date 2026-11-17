# 窗外夜景：程序生成一座城市 → Cycles 渲染成两层"局部全景"（等距柱状投影），浏览器贴在两个球面上做视差，再让它动起来（js/window-view.js）。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/render_view.py -- --width 3840 --samples 64
#
# 全景的范围：左右 ±80°、上下 -40°…+55°（PANO）。镜头在屋里怎么转，透过窗户看到的方向都在这个范围里，不会看到卡片外面的黑边。
# 产物（assets/baked/）：
#   view_near.webp / view_far.webp     250 米以内 / 以外的城市，透明底（天空不渲染，网页里实时画：星星、银河、云、月亮）
#   view_near_data.png / view_far_data.png   数据图（一半分辨率，一个像素一个采样、不抗锯齿），B 通道是类别：
#       B = 0    楼：R = 这一格窗是不是亮着，G = 这扇窗的随机数（网页里决定它什么时候关灯开灯、是不是电视的蓝光）
#       B = 0.25 车道（宽带子，只用来判断车有没有被楼挡住；车灯在网页里沿 view.json 的 lanes 画）
#       B = 0.5  楼顶的航空障碍灯（网页里慢慢闪）
#       B = 1    水面（网页里加波光和雨点涟漪）
#   view_full.jpg（平面 110°、带天空和月亮的一张，烘焙房间时当作窗外的光源）、view.json（全景参数）
# 这里用 Blender 自己的坐标：相机在原点（= 窗户中心），朝 +Y 看，Z 向上，街道在 z = -离地高度。
import json
import math
import os
import random
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import HORIZON, MOON, OUT, VIEW, Nodes, clear_scene, get_args, rgba, srgb, tree, use_metal  # noqa: E402

A = get_args(width=3840, samples=64, out='', seed=11, flat=1536, flat_samples=32)
OUTD = A.out or OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
H = VIEW['height']
TAN = math.tan(math.radians(VIEW['hfov'] / 2))
PANO = dict(lon=(-80.0, 80.0), lat=(-40.0, 55.0))   # 全景的经度（左右）、纬度（上下）范围，度
TANW = math.tan(math.radians(PANO['lon'][1]))       # 城市要铺多宽：左右 80° 都看得到
XCAP = 2600.0                                         # 再宽就太多楼了（远处反正被雾吞掉）
rnd = random.Random(A.seed)
moon_dir = Vector((MOON[0], -MOON[2], MOON[1])).normalized()  # three → Blender


def fogged(name, surface_builder, fog_scale=1.0):
    """所有城市材质都套一层距离雾：越远越接近地平线的颜色。"""
    mt = bpy.data.materials.new(name)
    n = Nodes(tree(mt))
    out = n.new('ShaderNodeOutputMaterial')
    shader = surface_builder(n)
    dist = n.new('ShaderNodeCameraData').outputs['View Distance']
    fog = n.math('MULTIPLY', n.math('SUBTRACT', 1.0, n.math('EXPONENT', n.math('DIVIDE', dist, -2400.0))), 0.9 * fog_scale)
    haze = n.new('ShaderNodeEmission', {'Color': rgba(HORIZON), 'Strength': 1.0})
    mix = n.new('ShaderNodeMixShader', {'Fac': fog})
    n.put(mix.inputs[1], shader)
    n.put(mix.inputs[2], haze.outputs[0])
    n.put(out.inputs['Surface'], mix.outputs[0])
    return mt


def windows(n):
    """窗格：立面上每 3.2 × 3.4 米一扇窗；每扇窗用 (列, 层, 楼号) 取随机数，决定亮不亮、什么色温。
    返回 (win 是不是窗, on 是不是亮着, 随机数节点, roof, v 离地高度, bid 楼号)，颜色和数据两种材质共用。"""
    geo = n.new('ShaderNodeNewGeometry')
    px, py, pz = n.xyz(geo.outputs['Position'])
    nx, _, nz = n.xyz(geo.outputs['Normal'])
    is_x = n.math('GREATER_THAN', n.math('ABSOLUTE', nx), 0.5)
    roof = n.math('GREATER_THAN', n.math('ABSOLUTE', nz), 0.5)
    u = n.math('ADD', px, n.math('MULTIPLY', is_x, n.math('SUBTRACT', py, px)))
    v = n.math('ADD', pz, H)
    su, sv = n.math('DIVIDE', u, 3.2), n.math('DIVIDE', v, 3.4)
    fu, fv = n.math('FRACT', su), n.math('FRACT', sv)

    def band(x, lo, hi):
        return n.math('MULTIPLY', n.math('GREATER_THAN', x, lo), n.math('LESS_THAN', x, hi))

    win = n.math('MULTIPLY', n.math('MULTIPLY', band(fu, 0.16, 0.84), band(fv, 0.3, 0.82)), n.math('SUBTRACT', 1.0, roof))
    bid = n.new('ShaderNodeAttribute', attribute_name='bid', attribute_type='GEOMETRY').outputs['Fac']
    lit = n.new('ShaderNodeAttribute', attribute_name='lit', attribute_type='GEOMETRY').outputs['Fac']
    cell = n.new('ShaderNodeCombineXYZ')
    n.put(cell.inputs[0], n.math('FLOOR', su))
    n.put(cell.inputs[1], n.math('FLOOR', sv))
    n.put(cell.inputs[2], n.math('MULTIPLY', bid, 997.0))
    wn = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    n.put(wn.inputs['Vector'], cell.outputs[0])
    on = n.math('MULTIPLY', win, n.math('LESS_THAN', wn.outputs['Value'], lit))
    return win, on, wn, roof, v, bid


def facade(n):
    win, on, wn, roof, v, bid = windows(n)
    sep = n.new('ShaderNodeSeparateColor')
    n.put(sep.inputs[0], wn.outputs['Color'])
    tint = n.ramp(sep.outputs[0], [(0.0, '#ff9e4a'), (0.45, '#ffc27a'), (0.8, '#ffe2b0'), (1.0, '#d8e6ff')])
    power = n.math('ADD', 0.6, n.math('MULTIPLY', sep.outputs[1], 2.6))
    emit = n.vec('SCALE', tint, scale=n.math('MULTIPLY', on, power))
    # 楼底被路灯照亮的一圈暖光
    glow = n.math('MULTIPLY', n.math('SUBTRACT', 1.0, roof), n.math('EXPONENT', n.math('DIVIDE', v, -5.0)))
    emit = n.vec('ADD', emit, n.vec('SCALE', srgb('#ff9a4a'), scale=n.math('MULTIPLY', glow, 0.35)))
    base = n.ramp(bid, [(0.0, '#2a2a30'), (0.5, '#3a342e'), (1.0, '#23272e')])
    base = n.vec('ADD', base, n.vec('SCALE', n.vec('SUBTRACT', srgb('#0b0d12'), base), scale=win))
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Roughness': 0.85, 'Emission Strength': 1.0})
    n.put(bsdf.inputs['Base Color'], base)
    n.put(bsdf.inputs['Emission Color'], emit)
    return bsdf.outputs[0]


def plain(color, rough=0.8):
    return lambda n: n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba(color), 'Roughness': rough}).outputs[0]


def glow(color, strength):
    return lambda n: n.new('ShaderNodeEmission', {'Color': rgba(color), 'Strength': strength}).outputs[0]


def clear(n):  # 车道的发光条：彩色图里看不见（车灯在网页里画），只在数据图里出现
    return n.new('ShaderNodeBsdfTransparent').outputs[0]


def water(n):
    # 河面：很光滑的深色反射面，加一层沿 x 拉长的波纹，城市灯光的倒影会被拉成竖条
    geo = n.new('ShaderNodeNewGeometry')
    p = n.vec('MULTIPLY', geo.outputs['Position'], (0.12, 1.4, 1.0))
    noise = n.new('ShaderNodeTexNoise', {'Scale': 1.0, 'Detail': 6.0, 'Roughness': 0.6})
    n.put(noise.inputs['Vector'], p)
    bump = n.new('ShaderNodeBump', {'Strength': 0.3, 'Distance': 0.25})
    n.put(bump.inputs['Height'], noise.outputs['Fac'])
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba('#03060a'), 'Roughness': 0.05, 'IOR': 1.33})
    n.put(bsdf.inputs['Normal'], bump.outputs['Normal'])
    return bsdf.outputs[0]


MATS = [
    fogged('facade', facade),
    fogged('ground', plain('#151517', 0.5)),
    fogged('lamp', glow('#ffb46b', 30), 0.45),
    fogged('head', glow('#fff3dd', 25), 0.45),
    fogged('tail', glow('#ff2a1a', 12), 0.45),
    fogged('beacon', glow('#ff2a1a', 40), 0.3),
    fogged('water', water),
    fogged('concrete', plain('#2c2b2a', 0.7)),
    fogged('lane', clear),
]
FACADE, GROUND, LAMP, HEAD, TAIL, BEACON, WATER, CONCRETE, LANE = range(9)

# ---------- 城市：楼前是一条河（RIVER），对岸起横街每 71 米一条、纵街每 86 米一条，正前方 x = 0 是一条大道 ----------
# 几何直接攒成数组再一次性建网格（bmesh.ops 每调用一次都会重算整张网格的法线，几万次会非常慢）
V, F, FM, FB, FL = [], [], [], [], []
CUBE = [(4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (3, 0, 4, 7), (1, 2, 6, 5)]  # 不要底面，法线朝外
OCTA = [(4, 0, 2), (4, 2, 1), (4, 1, 3), (4, 3, 0), (5, 2, 0), (5, 1, 2), (5, 3, 1), (5, 0, 3)]


def cube(cx, cy, z0, w, d, h, mi, bid=0.0, lit=0.0):
    x0, x1, y0, y1, z1 = cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0 + h
    o = len(V)
    V.extend([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])
    for f in CUBE:
        F.append(tuple(o + i for i in f))
        FM.append(mi)
        FB.append(bid)
        FL.append(lit)


def dot(x, y, z, r, mi):
    o = len(V)
    V.extend([(x + r, y, z), (x - r, y, z), (x, y + r, z), (x, y - r, z), (x, y, z + r), (x, y, z - r)])
    for f in OCTA:
        F.append(tuple(o + i for i in f))
        FM.append(mi)
        FB.append(0.0)
        FL.append(0.0)


def tallness(x, y):
    d1 = ((x - 180) / 420) ** 2 + ((y - 1300) / 360) ** 2      # 市中心
    d2 = ((x + 950) / 300) ** 2 + ((y - 2300) / 320) ** 2      # 远处另一簇
    return 1 + 6.5 * math.exp(-d1) + 3.5 * math.exp(-d2)


RIVER = (40.0, 255.0)                 # 河面的 y 范围（我们这岸 → 对岸）
PX, PY, Y0, MAXY = 86.0, 71.0, RIVER[1] + 20, 4200.0
G = -H
NROW = int((MAXY - Y0) / PY)
n_bld = 0
for j in range(NROW):
    y0, y1 = Y0 + j * PY, Y0 + j * PY + 51
    half = min((y1 + 60) * TANW * 1.05 + 120, XCAP)
    for i in range(int(-half / PX) - 1, int(half / PX) + 1):
        x0, x1 = i * PX + 10, i * PX + 76
        nx_, ny_ = rnd.choice([1, 2, 2, 3, 3, 4]), rnd.choice([1, 1, 2])
        for a in range(nx_):
            for b in range(ny_):
                lw, ld = (x1 - x0) / nx_, (y1 - y0) / ny_
                cx, cy = x0 + lw * (a + 0.5), y0 + ld * (b + 0.5)
                if j == 0:
                    h = rnd.uniform(8, 30)       # 沿河第一排压低，让后面的天际线露出来
                else:
                    h = rnd.lognormvariate(math.log(15), 0.5) * tallness(cx, cy)
                h = min(max(h, 7), 330)
                inset = rnd.uniform(0.6, 3.5)
                w, d = lw - inset * 2, ld - inset * 2
                lit = min(0.85, rnd.betavariate(1.3, 2.6) * (1.3 if h > 80 else 1.0))
                bid = rnd.random()
                cube(cx, cy, G, w, d, h, FACADE, bid, lit)
                if h > 55 and rnd.random() < 0.55:   # 高楼加一截收分的顶
                    k = rnd.uniform(0.55, 0.8)
                    h2 = h * rnd.uniform(0.12, 0.3)
                    cube(cx, cy, G + h, w * k, d * k, h2, FACADE, bid, lit)
                    h += h2
                if h > 90:
                    dot(cx, cy, G + h + 1.5, 0.9, BEACON)
                n_bld += 1

# 地面两块（我们这岸、对岸），中间低 2.5 米是河面；地面块的侧面就是河堤
cube(0, (RIVER[0] - 400) / 2, G - 6, 20000, RIVER[0] + 400, 6, GROUND)
cube(0, (RIVER[1] + 9000) / 2, G - 6, 20000, 9000 - RIVER[1], 6, GROUND)
cube(0, (RIVER[0] + RIVER[1]) / 2, G - 8, 20000, RIVER[1] - RIVER[0] + 2, 5.5, WATER)

# 路灯：500 米以内同时放真正的点光源照亮路面和河面，再远只画亮点
lamp_light = bpy.data.lights.new('street', 'POINT')
lamp_light.energy = 900
lamp_light.color = srgb('#ffb46b')
lamp_light.shadow_soft_size = 0.4
lamps = []


def street_lamp(x, y, z=7.0):
    dot(x, y, G + z, 0.35, LAMP)
    if y < 500:
        lamps.append((x, y, G + z - 0.4))


def in_view(x, y, pad=60):
    return abs(x) < min(y * TANW + pad, XCAP)


for yy in (RIVER[0] - 5, RIVER[1] + 4):          # 两岸的滨河路
    x = -min(yy * TANW + 60, XCAP)
    while x < min(yy * TANW + 60, XCAP):
        street_lamp(x, yy, 5.5)
        x += 24
for j in range(NROW):
    for yy in (Y0 + j * PY - 16.5, Y0 + j * PY - 3.5):
        if j == 0 and yy < RIVER[1] + 8:
            continue
        x = -min(yy * TANW + 60, XCAP) + (yy * 7.3) % 40
        while x < min(yy * TANW + 60, XCAP):
            street_lamp(x, yy)
            x += 40
for i in range(-60, 61):
    for xx in (i * PX - 7, i * PX + 7):
        y = Y0 + (i * 13.7) % 40
        while y < MAXY:
            if in_view(xx, y):
                street_lamp(xx, y)
            y += 40

# 左边一座桥：桥面、桥墩、两侧路灯、车流
BX, BW = -130.0, 18.0
cube(BX, sum(RIVER) / 2, G + 5.5, BW, RIVER[1] - RIVER[0] + 30, 1.6, CONCRETE)
for y in range(70, 250, 45):
    cube(BX, y, G - 8, 7, 4, 13.5, CONCRETE)
for y in range(int(RIVER[0]), int(RIVER[1]) + 1, 22):
    for sx in (-BW / 2 + 0.5, BW / 2 - 0.5):
        street_lamp(BX + sx, y, 13.0)

# 车道：车灯在网页里画（js/window-view.js 沿着 view.json 里的 lanes 一辆辆往前开）。这里每条车道只铺一条宽带子：
# 彩色图里透明，数据图里标成"车道"（B = 0.25），网页靠它判断某个位置的车有没有被前面的楼挡住。
# 带子越远越宽（至少 3 米，或者 0.2°），远处也能在一半分辨率的数据图里占满一两个像素。
LANES = []  # 写进 view.json：a → b 是车开的方向，toward = 朝我们开（白色车头灯）；Blender 坐标，相机在原点


def lane(axis, c, lo, hi, z, toward, segs=24):
    a, b = ((c, lo, z), (c, hi, z)) if axis == 0 else ((lo, c, z), (hi, c, z))
    if axis == 0 and toward or axis == 1 and not toward:   # 大道上朝我们开 = 从远往近；横街上两个方向随便定一个
        a, b = b, a
    LANES.append(dict(a=[round(v, 2) for v in a], b=[round(v, 2) for v in b], toward=bool(toward)))
    for k in range(segs):
        t0, t1 = k / segs, (k + 1) / segs
        p0 = [a[i] + (b[i] - a[i]) * t0 for i in range(3)]
        p1 = [a[i] + (b[i] - a[i]) * t1 for i in range(3)]
        w0 = max(3.0, math.hypot(p0[0], p0[1]) * 0.0035) / 2
        w1 = max(3.0, math.hypot(p1[0], p1[1]) * 0.0035) / 2
        if axis == 0:
            q = [(p0[0] - w0, p0[1], z), (p0[0] + w0, p0[1], z), (p1[0] + w1, p1[1], z), (p1[0] - w1, p1[1], z)]
        else:
            q = [(p0[0], p0[1] - w0, z), (p0[0], p0[1] + w0, z), (p1[0], p1[1] + w1, z), (p1[0], p1[1] - w1, z)]
        o = len(V)
        V.extend(q)
        F.append((o, o + 1, o + 2, o + 3))
        FM.append(LANE)
        FB.append(0.0)
        FL.append(0.0)


for c, toward in ((2.4, True), (5.4, True), (-2.4, False), (-5.4, False)):   # 正前方的大道：右边两条朝我们开
    lane(0, c, Y0 - 10, 2600, G + 0.7, toward)
for j in range(6):                                                            # 前几条横街
    yy = Y0 + j * PY - 10
    w = min((yy + 60) * TANW, XCAP)
    lane(1, yy - 3, -w, w, G + 0.7, True)
    lane(1, yy + 3, -w, w, G + 0.7, False)
for yy, toward in ((RIVER[0] - 8, True), (RIVER[0] - 12, False)):  # 我们这岸的滨河路（对岸那条和第一条横街重合）
    w = min(yy * TANW + 60, XCAP)
    lane(1, yy, -w, w, G + 0.7, toward)
lane(0, BX + 3.5, RIVER[0] - 30, RIVER[1] + 30, G + 7.8, True)               # 桥
lane(0, BX - 3.5, RIVER[0] - 30, RIVER[1] + 30, G + 7.8, False)

me = bpy.data.meshes.new('City')
me.from_pydata(V, [], F)
me.polygons.foreach_set('material_index', FM)
for name, vals in (('bid', FB), ('lit', FL)):
    me.attributes.new(name, 'FLOAT', 'FACE').data.foreach_set('value', vals)
me.update()
for m in MATS:
    me.materials.append(m)
city = bpy.data.objects.new('City', me)
scene.collection.objects.link(city)
for (x, y, z) in lamps:
    ob = bpy.data.objects.new('street', lamp_light)
    ob.location = (x, y, z)
    scene.collection.objects.link(ob)
print(f'[city] {n_bld} buildings, {len(me.polygons)} faces, {len(lamps)} street lights')

# ---------- 月亮、天空 ----------
mm = bpy.data.materials.new('moon')
n = Nodes(tree(mm))
n.put(n.new('ShaderNodeOutputMaterial').inputs['Surface'], n.new('ShaderNodeEmission', {'Color': rgba('#f4efdf'), 'Strength': 5.0}).outputs[0])
dist = 6000
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=dist * math.tan(math.radians(0.7)), location=moon_dir * dist)
moon = bpy.context.active_object
moon.data.materials.append(mm)
sun = bpy.data.lights.new('moonlight', 'SUN')
sun.energy = 0.25
sun.color = srgb('#b8c6ff')
sun.angle = math.radians(1.5)
sun_ob = bpy.data.objects.new('moonlight', sun)
sun_ob.visible_glossy = False  # 月光照亮楼就行，不在河面上反出一道亮条（下雨天、月亮多半在窗框外，那道光看着莫名其妙）
sun.specular_factor = 0.0
sun_ob.rotation_euler = (-moon_dir).to_track_quat('-Z', 'Y').to_euler()
scene.collection.objects.link(sun_ob)

world = bpy.data.worlds.new('Night')
scene.world = world
n = Nodes(tree(world))
dirv = n.new('ShaderNodeTexCoord').outputs['Generated']
_, _, z = n.xyz(dirv)
t = n.new('ShaderNodeMapRange', {'Value': z, 'From Min': -0.02, 'From Max': 0.6}).outputs[0]
sky = n.ramp(t, [(0.0, HORIZON), (0.05, '#2c2350'), (0.25, '#10163a'), (1.0, '#04060f')])
vor = n.new('ShaderNodeTexVoronoi', {'Scale': 260.0})
n.put(vor.inputs['Vector'], dirv)
star = n.math('MULTIPLY', n.math('LESS_THAN', vor.outputs['Distance'], 0.09), n.math('GREATER_THAN', n.xyz(vor.outputs['Color'])[0], 0.86))
star = n.math('MULTIPLY', star, n.new('ShaderNodeMapRange', {'Value': z, 'From Min': 0.1, 'From Max': 0.4}).outputs[0])
sky = n.vec('ADD', sky, n.vec('SCALE', (1.0, 0.97, 0.9), scale=n.math('MULTIPLY', star, 1.6)))
halo = n.new('ShaderNodeMapRange', {'Value': n.vec('DOT_PRODUCT', dirv, tuple(moon_dir)), 'From Min': 0.992, 'From Max': 1.0}).outputs[0]
sky = n.vec('ADD', sky, n.vec('SCALE', srgb('#8f9ad0'), scale=n.math('MULTIPLY', n.math('POWER', halo, 4.0), 0.3)))
bg = n.new('ShaderNodeBackground', {'Strength': 1.0})
n.put(bg.inputs['Color'], sky)
n.put(n.new('ShaderNodeOutputWorld').inputs['Surface'], bg.outputs[0])

# ---------- 数据图用的材质：只发光、不打光，颜色就是数据（见文件开头的说明）----------
def data_material(name, build):
    mt = bpy.data.materials.new('data_' + name)
    n = Nodes(tree(mt))
    out = n.new('ShaderNodeOutputMaterial')
    em = n.new('ShaderNodeEmission', {'Strength': 1.0})
    n.put(em.inputs['Color'], build(n))
    n.put(out.inputs['Surface'], em.outputs[0])
    return mt


def d_const(r, g, b):
    return lambda n: (r, g, b, 1.0)


def d_facade(n):
    win, on, wn, roof, v, bid = windows(n)
    c = n.new('ShaderNodeCombineColor')
    n.put(c.inputs[0], on)
    n.put(c.inputs[1], wn.outputs['Value'])
    return c.outputs[0]


DATA = {FACADE: d_facade, BEACON: d_const(0, 0, 0.5), WATER: d_const(0, 0, 1.0), LANE: d_const(0, 0, 0.25)}
DATA_MATS = [data_material(m.name, DATA.get(i, d_const(0, 0, 0))) for i, m in enumerate(MATS)]
black_world = bpy.data.worlds.new('Black')
nb = Nodes(tree(black_world))
nb.put(nb.new('ShaderNodeOutputWorld').inputs['Surface'], nb.new('ShaderNodeBackground', {'Color': (0, 0, 0, 1), 'Strength': 0.0}).outputs[0])

# ---------- 相机、渲染 ----------
cam_data = bpy.data.cameras.new('view')
cam = bpy.data.objects.new('view', cam_data)
cam.rotation_euler = (math.pi / 2, 0, 0)  # 朝 +Y
scene.collection.objects.link(cam)
scene.camera = cam


def pano_camera():
    cam_data.type = 'PANO'
    cam_data.panorama_type = 'EQUIRECTANGULAR'  # 图的 u：经度从左到右；v：纬度从下到上（已经拿彩色小球实测过）
    cam_data.longitude_min, cam_data.longitude_max = (math.radians(a) for a in PANO['lon'])
    cam_data.latitude_min, cam_data.latitude_max = (math.radians(a) for a in PANO['lat'])
    PW = A.width
    return PW, round(PW * (PANO['lat'][1] - PANO['lat'][0]) / (PANO['lon'][1] - PANO['lon'][0]))


def flat_camera():
    cam_data.type = 'PERSP'
    cam_data.sensor_fit = 'HORIZONTAL'
    cam_data.angle = math.radians(VIEW['hfov'])
    return A.flat, int(A.flat / VIEW['aspect'])


use_metal(scene, A.samples)
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.diffuse_bounces = 2
scene.cycles.glossy_bounces = 2
scene.cycles.transmission_bounces = 0
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.view_settings.look = 'None'
for k in dir(scene.render):  # 不往图片里写渲染时间、文件名之类的元数据（公开仓库里不要本机信息）
    if k.startswith('use_stamp'):
        setattr(scene.render, k, False)


def render(path, fmt, clip, transparent, size, samples, data=False):
    cam_data.clip_start, cam_data.clip_end = clip
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = transparent
    scene.cycles.samples = samples
    scene.cycles.use_denoising = not data
    scene.cycles.filter_width = 0.01 if data else 1.5      # 数据图：一个像素只采中心一点，类别不会在边上混在一起
    scene.view_settings.view_transform = 'Raw' if data else 'Standard'  # 数据图存原值，不做 sRGB 编码
    scene.world = black_world if data else world
    for i, m in enumerate(me.materials):
        me.materials[i] = (DATA_MATS if data else MATS)[MATS.index(m) if m in MATS else DATA_MATS.index(m)]
    s = scene.render.image_settings
    s.file_format = fmt
    s.color_mode = 'RGBA' if transparent else 'RGB'
    s.color_depth = '8'
    s.quality = 86
    s.compression = 90
    scene.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'[render] {os.path.basename(path)} {size[0]}×{size[1]}: {time.time() - t0:.1f}s')


formats = bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items.keys()
assert 'WEBP' in formats, '这个 Blender 存不了 WebP'
split = VIEW['split']
# 全景两层（天空、月亮不渲染：网页里画）
moon.hide_render = True
size = pano_camera()
dsize = (size[0] // 2, size[1] // 2)
render(os.path.join(OUTD, 'view_far.webp'), 'WEBP', (split, 20000), True, size, A.samples)
render(os.path.join(OUTD, 'view_near.webp'), 'WEBP', (0.5, split), True, size, A.samples)
render(os.path.join(OUTD, 'view_far_data.png'), 'PNG', (split, 20000), False, dsize, 1, data=True)
render(os.path.join(OUTD, 'view_near_data.png'), 'PNG', (0.5, split), False, dsize, 1, data=True)
# 平面一张带天空和月亮的：烘焙房间时当作窗外的光源
moon.hide_render = False
render(os.path.join(OUTD, 'view_full.jpg'), 'JPEG', (0.5, 20000), False, flat_camera(), A.flat_samples)

with open(os.path.join(OUTD, 'view.json'), 'w') as f:
    json.dump({
        # 平面的 view_full.jpg 的参数（烘焙脚本用）；cards 留空：房间不再用平面卡片（js/baked.js 看到空的就不建）
        'hfov': VIEW['hfov'], 'aspect': VIEW['aspect'], 'cards': [], 'full': 'view_full.jpg',
        # 全景：球心在窗户中心，far / near 两层分别贴在 dist 米远的球面上
        'pano': {'lon': list(PANO['lon']), 'lat': list(PANO['lat']), 'split': VIEW['split'], 'lanes': LANES, 'layers': [
            {'file': 'view_far.webp', 'data': 'view_far_data.png', 'dist': VIEW['far']},
            {'file': 'view_near.webp', 'data': 'view_near_data.png', 'dist': VIEW['near']},
        ]},
        'built': time.strftime('%Y%m%d-%H%M%S'),
    }, f, indent=2)
print('[done]', OUTD)
