# 窗外夜景：程序生成一座城市 → Cycles 渲染成两张卡片（近景带透明、远景带天空），给浏览器做视差。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/render_view.py -- --width 3072 --samples 128
#
# 产物（assets/baked/）：view_near.webp（250 米以内，透明底）、view_far.jpg（250 米以外 + 天空 + 月亮）、
# view_full.jpg（两张合成，烘焙房间时当作窗外的光源）、view.json（卡片参数）。
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

A = get_args(width=3072, samples=128, out='', seed=11)
OUTD = A.out or OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
H = VIEW['height']
TAN = math.tan(math.radians(VIEW['hfov'] / 2))
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


def facade(n):
    # 窗格：立面上每 3.2 × 3.4 米一扇窗；每扇窗用 (列, 层, 楼号) 取随机数，决定亮不亮、什么色温
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
]
FACADE, GROUND, LAMP, HEAD, TAIL, BEACON, WATER, CONCRETE = range(8)

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
    half = (y1 + 60) * TAN * 1.05 + 120
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
    return abs(x) < y * TAN + pad


for yy in (RIVER[0] - 5, RIVER[1] + 4):          # 两岸的滨河路
    x = -(yy * TAN + 60)
    while x < yy * TAN + 60:
        street_lamp(x, yy, 5.5)
        x += 24
for j in range(NROW):
    for yy in (Y0 + j * PY - 16.5, Y0 + j * PY - 3.5):
        if j == 0 and yy < RIVER[1] + 8:
            continue
        x = -(yy * TAN + 60) + (yy * 7.3) % 40
        while x < yy * TAN + 60:
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
for _ in range(16):
    y = rnd.uniform(RIVER[0], RIVER[1])
    lane = rnd.choice([-1, 1])
    for sx in (-0.75, 0.75):
        dot(BX + lane * 3.5 + sx, y, G + 7.8, 0.22, HEAD if lane > 0 else TAIL)

# 车：对岸大道上和前几条横街上，白色车头灯 / 红色尾灯
for _ in range(240):
    y = rnd.uniform(Y0, 2600)
    lane = rnd.choice([-1, 1])
    x = lane * rnd.uniform(1.8, 5.5)
    mi = HEAD if lane > 0 else TAIL  # 右侧车道朝我们开来（车头灯），左侧离开（尾灯）
    for sx in (-0.75, 0.75):
        dot(x + sx, y, G + 0.7, 0.22, mi)
for j in range(6):
    yy = Y0 + j * PY - 10
    for _ in range(14):
        x = rnd.uniform(-(yy + 60) * TAN, (yy + 60) * TAN)
        mi, lane = rnd.choice([(HEAD, -3), (TAIL, 3)])
        for sx in (-0.75, 0.75):
            dot(x + sx, yy + lane, G + 0.7, 0.22, mi)

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

# ---------- 相机、渲染 ----------
cam_data = bpy.data.cameras.new('view')
cam_data.sensor_fit = 'HORIZONTAL'
cam_data.angle = math.radians(VIEW['hfov'])
cam = bpy.data.objects.new('view', cam_data)
cam.rotation_euler = (math.pi / 2, 0, 0)  # 朝 +Y
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
scene.render.resolution_y = int(A.width / VIEW['aspect'])
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
render(os.path.join(OUTD, 'view_far.jpg'), 'JPEG', (VIEW['split'], 20000), False)
render(os.path.join(OUTD, near_name), 'WEBP' if near_name.endswith('webp') else 'PNG', (0.5, VIEW['split']), True)

# 合成一张完整的（烘焙房间时当作窗外的光源用）
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
    json.dump({'hfov': VIEW['hfov'], 'aspect': VIEW['aspect'], 'cards': [
        {'file': 'view_far.jpg', 'dist': VIEW['far']},
        {'file': near_name, 'dist': VIEW['near'], 'alpha': True},
    ], 'full': 'view_full.jpg', 'built': time.strftime('%Y%m%d-%H%M%S')}, f, indent=2)
print('[done]', OUTD)
