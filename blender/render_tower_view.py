# 塔楼窗外：月夜的湖、对岸的小村子、几层远山，左边近处是城堡的另一座尖顶塔楼。Cycles 渲染成两张卡片给浏览器做视差。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/render_tower_view.py -- --width 1536 --samples 96
#
# 产物（assets/tower/）：view_near.webp（320 米以内：邻塔、山坡上的松树，透明底）、view_far.jpg（湖、村子、远山、星空）、
# view_full.jpg（合成图，烘焙塔楼时当窗外的光源）、view.json（卡片参数，格式同 assets/baked/view.json）。
# 窗户很窄，从开场镜头只能看到正中间几度的范围，所以要紧的东西（地平线、村子的灯、邻塔的尖顶）都放在正前方。
# Blender 自己的坐标：相机在原点（= 窗户中心），朝 +Y 看，Z 向上，湖面在 z = -离湖面高度。
import json
import math
import os
import random
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import (TOWER_HORIZON, TOWER_MOON, TOWER_OUT, TOWER_VIEW, Nodes, clear_scene, get_args, rgba,  # noqa: E402
                    srgb, tree, use_metal)

A = get_args(width=1536, samples=96, out='', seed=5)
OUTD = A.out or TOWER_OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
V_ = TOWER_VIEW
H = V_['height']
Z0 = -H                      # 湖面
TAN = math.tan(math.radians(V_['hfov'] / 2))
rnd = random.Random(A.seed)
moon_dir = Vector((TOWER_MOON[0], -TOWER_MOON[2], TOWER_MOON[1])).normalized()  # three → Blender


def fogged(name, surface_builder, fog_dist=2600.0, amount=0.92):
    """距离雾：越远越接近远山的雾色。"""
    mt = bpy.data.materials.new(name)
    n = Nodes(tree(mt))
    out = n.new('ShaderNodeOutputMaterial')
    shader = surface_builder(n)
    dist = n.new('ShaderNodeCameraData').outputs['View Distance']
    fog = n.math('MULTIPLY', n.math('SUBTRACT', 1.0, n.math('EXPONENT', n.math('DIVIDE', dist, -fog_dist))), amount)
    haze = n.new('ShaderNodeEmission', {'Color': rgba(TOWER_HORIZON), 'Strength': 1.0})
    mix = n.new('ShaderNodeMixShader', {'Fac': fog})
    n.put(mix.inputs[1], shader)
    n.put(mix.inputs[2], haze.outputs[0])
    n.put(out.inputs['Surface'], mix.outputs[0])
    return mt


def plain(color, rough=0.9):
    return lambda n: n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba(color), 'Roughness': rough}).outputs[0]


def glow(color, strength):
    return lambda n: n.new('ShaderNodeEmission', {'Color': rgba(color), 'Strength': strength}).outputs[0]


def water(n):
    # 湖面：很光滑，加一层横向拉长的细波纹，灯光和山的倒影会被拉成竖条、碎开
    geo = n.new('ShaderNodeNewGeometry')
    p = n.vec('MULTIPLY', geo.outputs['Position'], (0.05, 0.9, 1.0))
    noise = n.new('ShaderNodeTexNoise', {'Scale': 1.2, 'Detail': 8.0, 'Roughness': 0.65})
    n.put(noise.inputs['Vector'], p)
    bump = n.new('ShaderNodeBump', {'Strength': 0.18, 'Distance': 0.3})
    n.put(bump.inputs['Height'], noise.outputs['Fac'])
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba('#02040a'), 'Roughness': 0.06, 'IOR': 1.33})
    n.put(bsdf.inputs['Normal'], bump.outputs['Normal'])
    return bsdf.outputs[0]


def ridge_shader(color_lo, color_hi, top):
    # 山：下面是黑的树林，往上渐渐变成被月光照到的冷灰色
    def f(n):
        geo = n.new('ShaderNodeNewGeometry')
        _, _, pz = n.xyz(geo.outputs['Position'])
        t = n.new('ShaderNodeMapRange', {'Value': pz, 'From Min': Z0, 'From Max': Z0 + top}).outputs[0]
        col = n.ramp(t, [(0.0, color_lo), (0.55, color_lo), (1.0, color_hi)])
        b = n.new('ShaderNodeBsdfPrincipled', {'Roughness': 0.95})
        n.put(b.inputs['Base Color'], col)
        return b.outputs[0]
    return f


MATS = [
    fogged('water', water, 5000, 0.6),
    fogged('ground', plain('#0c0f0d'), 2200),
    fogged('pine', plain('#0b130f'), 1800),
    fogged('ridge0', ridge_shader('#0a0f0d', '#1c2228', 260), 2600),
    fogged('ridge1', ridge_shader('#0d1216', '#2c3440', 520), 3000),
    fogged('ridge2', ridge_shader('#141a22', '#4a5466', 820), 3600, 0.85),
    fogged('light', glow('#ffb15a', 28), 3000, 0.5),
    fogged('stone', plain('#2b2a2c', 0.85), 2000),
    fogged('slate', plain('#1a1d24', 0.6), 2000),
    fogged('winlit', glow('#ffb86a', 6), 2000, 0.4),
]
WATER, GROUND, PINE, R0, R1, R2, LIGHT, STONE, SLATE, WINLIT = range(len(MATS))

V, F, FM = [], [], []


def face(*idx, mi):
    F.append(tuple(idx))
    FM.append(mi)


def quad_v(pts, mi):
    o = len(V)
    V.extend(pts)
    face(o, o + 1, o + 2, o + 3, mi=mi)


def dot(x, y, z, r, mi):
    o = len(V)
    V.extend([(x + r, y, z), (x - r, y, z), (x, y + r, z), (x, y - r, z), (x, y, z + r), (x, y, z - r)])
    for f in ((4, 0, 2), (4, 2, 1), (4, 1, 3), (4, 3, 0), (5, 2, 0), (5, 1, 2), (5, 3, 1), (5, 0, 3)):
        face(*(o + i for i in f), mi=mi)


def cone(x, y, z, r, h, segs, mi, z_top=None):
    o = len(V)
    V.append((x, y, z + h))
    for k in range(segs):
        a = k / segs * math.tau
        V.append((x + math.cos(a) * r, y + math.sin(a) * r, z))
    for k in range(segs):
        face(o, o + 1 + k, o + 1 + (k + 1) % segs, mi=mi)


def tube(x, y, z0, z1, r, segs, mi):
    o = len(V)
    for k in range(segs):
        a = k / segs * math.tau
        V.append((x + math.cos(a) * r, y + math.sin(a) * r, z0))
        V.append((x + math.cos(a) * r, y + math.sin(a) * r, z1))
    for k in range(segs):
        a, b = o + 2 * k, o + 2 * ((k + 1) % segs)
        face(a, b, b + 1, a + 1, mi=mi)


# ---------- 湖面、近处的山坡 ----------
quad_v([(-30000, 60, Z0), (30000, 60, Z0), (30000, 9000, Z0), (-30000, 9000, Z0)], WATER)
# 塔下的山坡：从脚下往前 140 米落到湖边（陡坡 + 树），两边一直延伸出去
for k in range(24):
    x0, x1 = -600 + k * 50, -550 + k * 50
    quad_v([(x0, -10, Z0 + 28), (x1, -10, Z0 + 28), (x1, 70, Z0 - 1), (x0, 70, Z0 - 1)], GROUND)
pines = 0
for _ in range(900):
    y = rnd.uniform(5, 75)
    x = rnd.uniform(-(y + 30) * TAN * 1.3, (y + 30) * TAN * 1.3)
    zg = Z0 + 28 - (y + 10) / 80 * 29
    h = rnd.uniform(7, 15)
    cone(x, y, zg, h * 0.28, h, 6, PINE)
    pines += 1

# ---------- 对岸：几层山脊（离得越远越高、越淡）----------
LAYERS = [(1500.0, 230.0, R0, 0.0), (2700.0, 460.0, R1, 1.7), (4800.0, 760.0, R2, 4.1)]
for D, top, mi, ph in LAYERS:
    xs = np.linspace(-D * TAN * 1.6, D * TAN * 1.6, 420)
    h = top * (0.5 + 0.22 * np.sin(xs / (D * 0.23) + ph) + 0.14 * np.sin(xs / (D * 0.071) + ph * 3)
               + 0.07 * np.sin(xs / (D * 0.023) + ph * 7) + np.array([rnd.uniform(-0.025, 0.025) for _ in xs]))
    if mi == R0:  # 最近的一层在正前方压低一些，让村子和后面的山露出来
        h *= 1 - 0.55 * np.exp(-(xs / (D * 0.22)) ** 2)
    o = len(V)
    for x, hh in zip(xs, h):
        V.append((float(x), D, Z0 - 2))
        V.append((float(x), D + hh * 0.6, Z0 + float(hh)))
    for i in range(len(xs) - 1):
        a, b = o + 2 * i, o + 2 * (i + 1)
        face(a, b, b + 1, a + 1, mi=mi)
    if mi == R0:
        R0_PROFILE = (xs, h)

# 湖对岸的小村子：一串暖色的窗灯，沿岸边、稍微往山坡上爬一点
village = 0
for _ in range(46):
    x = rnd.gauss(30, 120)
    y = 1380 + rnd.uniform(-40, 40)
    z = Z0 + 1.5 + abs(rnd.gauss(0, 7))
    dot(x, y, z, rnd.uniform(0.7, 1.3), LIGHT)
    village += 1
# 远处山腰上零星几点
for _ in range(10):
    dot(rnd.uniform(-900, 900), 2600 + rnd.uniform(-80, 80), Z0 + rnd.uniform(20, 140), 1.6, LIGHT)

# ---------- 邻塔：圆柱塔身 + 尖锥顶，塔身上一扇亮着的窗 ----------
TX, TY = -7.5, 150.0
tube(TX, TY, Z0 + 20, 2.0, 5.2, 24, STONE)
cone(TX, TY, 2.0, 6.6, 13.0, 24, SLATE)
# 塔檐下的一圈雉堞
for k in range(16):
    a = k / 16 * math.tau
    x, y = TX + math.cos(a) * 5.6, TY + math.sin(a) * 5.6
    o = len(V)
    for dz in (0.2, 1.6):
        for s in (-1, 1):
            V.append((x - math.sin(a) * 0.7 * s, y + math.cos(a) * 0.7 * s, 2.0 - 1.4 + dz))
    face(o, o + 1, o + 3, o + 2, mi=STONE)
for wz in (-6.0, -19.0):
    a = -math.pi / 2 + 0.25   # 朝着我们的一面
    cx, cy = TX + math.cos(a) * 5.25, TY + math.sin(a) * 5.25
    tx, ty = -math.sin(a), math.cos(a)
    quad_v([(cx - tx * 0.6, cy - ty * 0.6, wz), (cx + tx * 0.6, cy + ty * 0.6, wz),
            (cx + tx * 0.6, cy + ty * 0.6, wz + 2.0), (cx - tx * 0.6, cy - ty * 0.6, wz + 2.0)], WINLIT)

# 邻塔脚下一块礁石，再拉一段城墙回到左边的岸上（雉堞一格一格的）
rock_segs = 14
o = len(V)
for k in range(rock_segs):
    a = k / rock_segs * math.tau
    rr = 12 + rnd.uniform(-1.5, 1.5)
    V.append((TX + math.cos(a) * rr, TY + math.sin(a) * rr, Z0 - 1))
    V.append((TX + math.cos(a) * 6.2, TY + math.sin(a) * 6.2, Z0 + 20 + rnd.uniform(-1, 1)))
for k in range(rock_segs):
    a, b = o + 2 * k, o + 2 * ((k + 1) % rock_segs)
    face(a, b, b + 1, a + 1, mi=GROUND)
WX0, WX1, WY0, WY1, WTOP = TX - 4, -90.0, TY - 3, 95.0, Z0 + 16
for k in range(12):
    t0, t1 = k / 12, (k + 1) / 12
    xa, xb = WX0 + (WX1 - WX0) * t0, WX0 + (WX1 - WX0) * t1
    ya, yb = WY0 + (WY1 - WY0) * t0, WY0 + (WY1 - WY0) * t1
    quad_v([(xa, ya, Z0 - 1), (xb, yb, Z0 - 1), (xb, yb, WTOP), (xa, ya, WTOP)], STONE)
    xm, ym = (xa + xb) / 2, (ya + yb) / 2
    quad_v([(xa, ya, WTOP), (xm, ym, WTOP), (xm, ym, WTOP + 1.4), (xa, ya, WTOP + 1.4)], STONE)

me = bpy.data.meshes.new('Land')
me.from_pydata(V, [], F)
me.polygons.foreach_set('material_index', FM)
me.update()
for m in MATS:
    me.materials.append(m)
land = bpy.data.objects.new('Land', me)
scene.collection.objects.link(land)
print(f'[land] {len(me.polygons)} faces, {pines} pines, {village} village lights')

# ---------- 月光、天空 ----------
sun = bpy.data.lights.new('moonlight', 'SUN')
sun.energy = 0.35
sun.color = srgb('#b8c6ff')
sun.angle = math.radians(1.5)
sun_ob = bpy.data.objects.new('moonlight', sun)
sun_ob.rotation_euler = (-moon_dir).to_track_quat('-Z', 'Y').to_euler()
scene.collection.objects.link(sun_ob)
mm = bpy.data.materials.new('moon')
n = Nodes(tree(mm))
n.put(n.new('ShaderNodeOutputMaterial').inputs['Surface'], n.new('ShaderNodeEmission', {'Color': rgba('#f4efdf'), 'Strength': 5.0}).outputs[0])
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=8000 * math.tan(math.radians(0.75)), location=moon_dir * 8000)
bpy.context.active_object.data.materials.append(mm)

world = bpy.data.worlds.new('Night')
scene.world = world
n = Nodes(tree(world))
dirv = n.new('ShaderNodeTexCoord').outputs['Generated']
_, _, z = n.xyz(dirv)
t = n.new('ShaderNodeMapRange', {'Value': z, 'From Min': -0.02, 'From Max': 0.7}).outputs[0]
sky = n.ramp(t, [(0.0, TOWER_HORIZON), (0.06, '#1d2548'), (0.3, '#0b1030'), (1.0, '#03050d')])
vor = n.new('ShaderNodeTexVoronoi', {'Scale': 300.0})
n.put(vor.inputs['Vector'], dirv)
star = n.math('MULTIPLY', n.math('LESS_THAN', vor.outputs['Distance'], 0.085), n.math('GREATER_THAN', n.xyz(vor.outputs['Color'])[0], 0.84))
star = n.math('MULTIPLY', star, n.new('ShaderNodeMapRange', {'Value': z, 'From Min': 0.03, 'From Max': 0.25}).outputs[0])
sky = n.vec('ADD', sky, n.vec('SCALE', (1.0, 0.97, 0.9), scale=n.math('MULTIPLY', star, 1.8)))
# 月亮在画面上方外面，天上留一大片偏左上的月晕
halo = n.new('ShaderNodeMapRange', {'Value': n.vec('DOT_PRODUCT', dirv, tuple(moon_dir)), 'From Min': 0.82, 'From Max': 1.0}).outputs[0]
sky = n.vec('ADD', sky, n.vec('SCALE', srgb('#6c78b0'), scale=n.math('MULTIPLY', n.math('POWER', halo, 3.0), 0.35)))
bg = n.new('ShaderNodeBackground', {'Strength': 1.0})
n.put(bg.inputs['Color'], sky)
n.put(n.new('ShaderNodeOutputWorld').inputs['Surface'], bg.outputs[0])

# ---------- 相机、渲染（同 render_view.py）----------
cam_data = bpy.data.cameras.new('view')
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.angle = math.radians(V_['hfov'])
cam = bpy.data.objects.new('view', cam_data)
cam.rotation_euler = (math.pi / 2, 0, 0)
scene.collection.objects.link(cam)
scene.camera = cam

use_metal(scene, A.samples)
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 4
scene.cycles.diffuse_bounces = 2
scene.cycles.glossy_bounces = 2
scene.cycles.transmission_bounces = 0
scene.cycles.caustics_reflective = False
scene.cycles.caustics_refractive = False
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.render.resolution_x = A.width
scene.render.resolution_y = int(A.width / V_['aspect'])
scene.render.resolution_percentage = 100


def render(path, fmt, clip, transparent):
    cam_data.clip_start, cam_data.clip_end = clip
    scene.render.film_transparent = transparent
    s = scene.render.image_settings
    s.file_format = fmt
    s.color_mode = 'RGBA' if transparent else 'RGB'
    s.quality = 88
    scene.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'[render] {os.path.basename(path)}: {time.time() - t0:.1f}s')


formats = bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items.keys()
near_name = 'view_near.webp' if 'WEBP' in formats else 'view_near.png'
render(os.path.join(OUTD, 'view_far.jpg'), 'JPEG', (V_['split'], 30000), False)
render(os.path.join(OUTD, near_name), 'WEBP' if near_name.endswith('webp') else 'PNG', (0.5, V_['split']), True)

far = bpy.data.images.load(os.path.join(OUTD, 'view_far.jpg'))
near = bpy.data.images.load(os.path.join(OUTD, near_name))
W, Hh = far.size
fp = np.empty(W * Hh * 4, dtype=np.float32)
npx = np.empty(W * Hh * 4, dtype=np.float32)
far.pixels.foreach_get(fp)
near.pixels.foreach_get(npx)
fp, npx = fp.reshape(-1, 4), npx.reshape(-1, 4)
a = npx[:, 3:4]
fp[:, :3] = npx[:, :3] * a + fp[:, :3] * (1 - a)
fp[:, 3] = 1
full = bpy.data.images.new('view_full', W, Hh, alpha=False)
full.colorspace_settings.name = 'Non-Color'
full.pixels.foreach_set(fp.ravel())
full.filepath_raw = os.path.join(OUTD, 'view_full.jpg')
full.file_format = 'JPEG'
try:
    full.save(filepath=os.path.join(OUTD, 'view_full.jpg'), quality=88)
except TypeError:
    full.save()

with open(os.path.join(OUTD, 'view.json'), 'w') as f:
    json.dump({'hfov': V_['hfov'], 'aspect': V_['aspect'], 'cards': [
        {'file': 'view_far.jpg', 'dist': V_['far']},
        {'file': near_name, 'dist': V_['near'], 'alpha': True},
    ], 'full': 'view_full.jpg', 'built': time.strftime('%Y%m%d-%H%M%S')}, f, indent=2)
print('[done]', OUTD)
