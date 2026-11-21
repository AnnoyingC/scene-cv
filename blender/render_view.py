# 窗外夜景：东京塔一带的真实街区（麻布十番上空 70 米，离东京塔 0.8 公里）→ Cycles 渲染成两层"局部全景"（等距柱状投影），
# 浏览器贴在两个球面上做视差，再让它动起来（js/window-view.js）。
#
#   node scripts/fetch_city.mjs            # 先下载城市数据、做好中间文件（vendor-src/，不进仓库；步骤见那个脚本）
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/render_view.py -- --width 3840 --samples 64
#
# 默认用的数据（都在 vendor-src/）：OpenStreetMap 的楼、路、店、树（osm/，© OpenStreetMap contributors，ODbL）；
# 国土交通省 PLATEAU 港区 3D 城市模型（plateau/city.npz）；楼面照片素材库（commons/windows/atlas，Wikimedia Commons 的 CC0 夜景照片）；
# 招牌图集（signs/，Noto Sans CJK 字体画的）。--osm "" 换回以前程序生成的河边城市（离地 22 米）。
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
from shared import HORIZON, MOON, OUT, ROOT, VIEW, Nodes, clear_scene, get_args, rgba, srgb, tree, use_metal  # noqa: E402

A = get_args(width=3840, samples=64, out='', seed=11, flat=1536, flat_samples=32,
             osm='vendor-src/osm', vp_lat=35.65671, vp_lon=139.73688, bearing=66.0, height=0.0, clay='',
             plateau='vendor-src/plateau/city.npz', look='', look_yaw=9.0, look_pitch=5.0, look_fov=30.0, expo=0.0,
             atlas='vendor-src/commons/windows/atlas', atlas_gain=1.1, signs='vendor-src/signs', near_scale=1.5, street=1)
for _k in ('osm', 'plateau', 'atlas', 'signs'):          # 相对路径都按仓库根目录算；--osm "" 时别的城市数据也一起不用
    _v = getattr(A, _k) if A.osm else ''
    setattr(A, _k, os.path.join(ROOT, _v) if _v and not os.path.isabs(_v) else _v)
    assert not _v or os.path.exists(getattr(A, _k)), f'没有 {getattr(A, _k)}：先运行 node scripts/fetch_city.mjs'
# --osm 目录：用 OpenStreetMap 的真实街区（blender/osm_city.py）代替程序生成的城市；视点 vp_lat/vp_lon、离地 height 米、窗户朝 bearing 度。
# --clay 路径：只渲一张没有灯光的白模全景（看视角、楼的样子），不出别的图
# --plateau 文件：PLATEAU 的楼（blender/plateau_prep.py 转好的 .npz：真实的屋顶形状、实测高度、用途、层数、地形）；
#   有它的地方用它，没有的地方（港区以外）再用 --osm 的楼补上
# --look 路径：调外观用：只渲一张对着东京塔的透视小图（look_yaw / look_pitch / look_fov 度），后期和全景一样，垫上网页里的天空
# --atlas 目录：楼面的照片素材库（blender/window_atlas.py 做的 atlas.png / atlas.json）：每栋楼按类型挑一块真实夜景照片里的楼面，
#   按层高铺在墙上（底层店面还是程序画的）；--atlas-gain 是照片当发光贴图时乘的亮度
# --signs 目录：近处的招牌（blender/sign_atlas.py 做的 signs.png / signs.json）：挂到镜头附近的商业楼、低层楼上（竖招牌、楼顶横招牌）
# --street 1/0：近处街上的细节（blender/street_detail.py：电线杆、电线、行道树、院子、居酒屋、咖啡店……；要 --plateau）
# --expo：后期的曝光（EV）。真实城市（--osm）的两层全景都先渲成 EXR，再过 postfx.py（光晕 + AgX），存 WebP
OUTD = A.out or OUT
os.makedirs(OUTD, exist_ok=True)
scene = bpy.context.scene
clear_scene()
ATLAS = None
if A.atlas:   # 楼面照片素材库：图集 + 一张 N×2 的参数小图（第 0 行：在图集里的位置；第 1 行：几层、宽几个层高、类型）
    _aj = json.load(open(os.path.join(A.atlas, 'atlas.json')))
    _img = bpy.data.images.load(os.path.abspath(os.path.join(A.atlas, 'atlas.png')))
    _img.colorspace_settings.name = 'sRGB'
    _sw = _aj['swatches']
    _N = len(_sw)
    # 每块的参数（在图集里的 x、y（从下往上）、宽、高，几层，宽几个层高）：着色器里按编号挑（块不多，直接用节点算）
    _par = [(_s['rect'][0], 1 - _s['rect'][1] - _s['rect'][3], _s['rect'][2], _s['rect'][3], _s['floors'], _s['width_floors']) for _s in _sw]
    ATLAS = dict(img=_img, params=_par, N=_N, n_off=sum(1 for _s in _sw if _s['kind'] == 'office'))
SIGNS = None
if A.signs:
    _sj = json.load(open(os.path.join(A.signs, 'signs.json')))
    _simg = bpy.data.images.load(os.path.abspath(os.path.join(A.signs, 'signs.png')))
    _simg.colorspace_settings.name = 'sRGB'
    SIGNS = dict(img=_simg, items=_sj['signs'])
H = A.height or (70.0 if A.osm else VIEW['height'])
TAN = math.tan(math.radians(VIEW['hfov'] / 2))
PANO = dict(lon=(-80.0, 80.0), lat=(-40.0, 55.0))   # 全景的经度（左右）、纬度（上下）范围，度
TANW = math.tan(math.radians(PANO['lon'][1]))       # 城市要铺多宽：左右 80° 都看得到
XCAP = 2600.0                                         # 再宽就太多楼了（远处反正被雾吞掉）
rnd = random.Random(A.seed)
moon_dir = Vector((MOON[0], -MOON[2], MOON[1])).normalized()  # three → Blender


URBAN_HAZE = '#353b47'   # 真实城市（--osm）的雾色：雨夜的青灰（网页里天空的地平线用同一个颜色，见 view.json 的 sky.horizon）


def fogged(name, surface_builder, fog_scale=1.0):
    """所有城市材质都套一层距离雾：越远越接近地平线的颜色。"""
    mt = bpy.data.materials.new(name)
    n = Nodes(tree(mt))
    out = n.new('ShaderNodeOutputMaterial')
    shader = surface_builder(n)
    dist = n.new('ShaderNodeCameraData').outputs['View Distance']
    fog = n.math('MULTIPLY', n.math('SUBTRACT', 1.0, n.math('EXPONENT', n.math('DIVIDE', dist, -2000.0 if A.osm else -2400.0))), 0.9 * fog_scale)
    haze = n.new('ShaderNodeEmission', {'Color': rgba(URBAN_HAZE if A.osm else HORIZON), 'Strength': 1.0})
    mix = n.new('ShaderNodeMixShader', {'Fac': fog})
    n.put(mix.inputs[1], shader)
    n.put(mix.inputs[2], haze.outputs[0])
    if A.osm:   # 下雨的夜里，街面上方浮着一层被路灯、店面映成暖色的雨雾：越低越浓、越远越浓
        _, _, pz = n.xyz(n.new('ShaderNodeNewGeometry').outputs['Position'])
        low = n.math('EXPONENT', n.math('DIVIDE', n.math('MAXIMUM', n.math('ADD', pz, H), 0.0), -45.0))
        far = n.math('SUBTRACT', 1.0, n.math('EXPONENT', n.math('DIVIDE', dist, -650.0)))
        mist = n.new('ShaderNodeEmission', {'Color': rgba('#5a4c46'), 'Strength': 1.0})
        mix2 = n.new('ShaderNodeMixShader', {'Fac': n.math('MULTIPLY', n.math('MULTIPLY', low, far), 0.35 * fog_scale)})
        n.put(mix2.inputs[1], mix.outputs[0])
        n.put(mix2.inputs[2], mist.outputs[0])
        mix = mix2
    n.put(out.inputs['Surface'], mix.outputs[0])
    return mt


def sel3(n, kind, a, b, c):
    """按楼的类型挑一个值：0 写字楼 → a，1 住宅 → b，2 商业 / 其他 → c（常量或节点输出）。"""
    k0 = n.math('LESS_THAN', kind, 0.5)
    k1 = n.math('LESS_THAN', n.math('ABSOLUTE', n.math('SUBTRACT', kind, 1.0)), 0.5)
    k2 = n.math('GREATER_THAN', kind, 1.5)
    return n.math('ADD', n.math('ADD', n.math('MULTIPLY', k0, a), n.math('MULTIPLY', k1, b)), n.math('MULTIPLY', k2, c))


def windows(n):
    """立面上的窗：按楼的真实层高（fh）一层一层排，窗的样子看楼的类型（kind）：
      写字楼  每层一条横向的玻璃带（窗台下一截实墙），1.8 米一根竖梃；约三分之一是整面玻璃幕墙；
              亮不亮按"整层"决定（加班的楼层一整条亮），亮着的层里再有几段暗着
      住宅    每层下面一截阳台栏板，3 米一扇窗；亮不亮按"户"（6 米一户）决定
      商业    零散的窗，一扇一扇随机亮；底层（写字楼、商业）是一整排店面
    返回 (win 是不是窗, on 是不是亮着, 随机数节点（Value = 这扇 / 这户 / 这层的随机数）, roof, v 离楼底的高度, bid, 其余参数)。"""
    geo = n.new('ShaderNodeNewGeometry')
    px, py, pz = n.xyz(geo.outputs['Position'])
    nx, ny, nz = n.xyz(geo.outputs['Normal'])
    roof = n.math('GREATER_THAN', n.math('ABSOLUTE', nz), 0.5)
    wall = n.math('SUBTRACT', 1.0, roof)

    def attr(name):
        return n.new('ShaderNodeAttribute', attribute_name=name, attribute_type='GEOMETRY').outputs['Fac']

    bid, lit, kind, fh, base, top = (attr(k) for k in ('bid', 'lit', 'kind', 'fh', 'base', 'top'))
    u = n.math('SUBTRACT', n.math('MULTIPLY', py, nx), n.math('MULTIPLY', px, ny))   # 顺着墙的方向（墙的切线 = (-ny, nx)）
    v = n.math('SUBTRACT', pz, base)
    sv = n.math('DIVIDE', v, fh)
    fl, fv = n.math('FLOOR', sv), n.math('FRACT', sv)
    bw = sel3(n, kind, 1.8, 3.0, 2.6)
    su = n.math('DIVIDE', u, bw)
    fu = n.math('FRACT', su)
    office = n.math('LESS_THAN', kind, 0.5)
    curtain = n.math('MULTIPLY', office, n.math('GREATER_THAN', bid, 0.62))            # 玻璃幕墙的写字楼

    def band(x, lo, hi):
        return n.math('MULTIPLY', n.math('GREATER_THAN', x, lo), n.math('LESS_THAN', x, hi))

    def mix(a, b, t):
        return n.math('ADD', a, n.math('MULTIPLY', n.math('SUBTRACT', b, a), t))

    u0 = mix(sel3(n, kind, 0.04, 0.2, 0.2), 0.015, curtain)
    v0 = mix(sel3(n, kind, 0.32, 0.36, 0.28), 0.04, curtain)
    v1 = mix(sel3(n, kind, 0.93, 0.9, 0.82), 0.985, curtain)
    below_top = n.math('LESS_THAN', pz, n.math('SUBTRACT', top, 1.0))                 # 楼顶的女儿墙没有窗
    win = n.math('MULTIPLY', n.math('MULTIPLY', band(fu, u0, n.math('SUBTRACT', 1.0, u0)), band(fv, v0, v1)),
                 n.math('MULTIPLY', wall, below_top))
    # 亮不亮：写字楼一层一个随机数（单元宽 1 万米 = 一整层），住宅一户（6 米）一个，商业一扇一个
    unit = sel3(n, kind, 10000.0, 6.0, 2.6)
    cell = n.new('ShaderNodeCombineXYZ')
    n.put(cell.inputs[0], n.math('FLOOR', n.math('DIVIDE', u, unit)))
    n.put(cell.inputs[1], fl)
    n.put(cell.inputs[2], n.math('MULTIPLY', bid, 997.0))
    wn = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    n.put(wn.inputs['Vector'], cell.outputs[0])
    fcell = n.new('ShaderNodeCombineXYZ')                                             # 住宅、商业：同一层的整体倾向（有的层多亮几户）
    n.put(fcell.inputs[0], fl)
    n.put(fcell.inputs[2], n.math('MULTIPLY', bid, 991.0))
    fn = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    n.put(fn.inputs['Vector'], fcell.outputs[0])
    floor_k = mix(n.math('ADD', 0.5, fn.outputs['Value']), 1.0, office)              # 0.5 … 1.5
    on = n.math('LESS_THAN', wn.outputs['Value'], n.math('MULTIPLY', lit, floor_k))
    # 写字楼亮着的层里，沿墙有几段是暗的（那一片的人下班了）
    part_v = n.new('ShaderNodeCombineXYZ')
    n.put(part_v.inputs[0], n.math('DIVIDE', u, 15.0))
    n.put(part_v.inputs[1], n.math('ADD', n.math('MULTIPLY', fl, 3.1), n.math('MULTIPLY', bid, 57.0)))
    part = n.new('ShaderNodeTexNoise', {'Scale': 1.0, 'Detail': 1.0}, noise_dimensions='2D')
    n.put(part.inputs['Vector'], part_v.outputs[0])
    part_on = mix(1.0, n.math('GREATER_THAN', part.outputs['Fac'], 0.43), office)
    on = n.math('MULTIPLY', n.math('MULTIPLY', on, part_on), win)
    # 底层的店面、大堂（住宅除外）：一整排玻璃，多半亮着
    is_res = n.math('LESS_THAN', n.math('ABSOLUTE', n.math('SUBTRACT', kind, 1.0)), 0.5)
    gf = n.math('MULTIPLY', n.math('LESS_THAN', fl, 0.5), n.math('SUBTRACT', 1.0, is_res))
    gwin = n.math('MULTIPLY', n.math('MULTIPLY', band(fu, 0.03, 0.97), band(fv, 0.06, 0.8)), wall)
    gon = n.math('MULTIPLY', gwin, n.math('LESS_THAN', wn.outputs['Value'], 0.7))
    win = mix(win, gwin, gf)
    on = mix(on, gon, gf)
    bay = n.new('ShaderNodeCombineXYZ')                                               # 每一格窗自己的随机数（写字楼同一层里也各不相同）
    n.put(bay.inputs[0], n.math('FLOOR', su))
    n.put(bay.inputs[1], fl)
    n.put(bay.inputs[2], n.math('MULTIPLY', bid, 613.0))
    bn = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    n.put(bn.inputs['Vector'], bay.outputs[0])
    return win, on, wn, roof, v, bid, dict(kind=kind, fl=fl, fv=fv, fu=fu, u=u, sv=sv, fh=fh, u0=u0, v0=v0, v1=v1, office=office, curtain=curtain,
                                          gf=gf, fn=fn, bn=bn, wall=wall, mix=mix, top=top, base=base, pz=pz)


def photo_far(n):
    """照片墙面的权重：离镜头 280 米以内 0（程序画的窗），650 米以外 1（照片），中间平滑过渡。"""
    d = n.new('ShaderNodeCameraData').outputs['View Distance']
    return n.new('ShaderNodeMapRange', {'Value': d, 'From Min': 280.0, 'From Max': 650.0}, interpolation_type='SMOOTHSTEP').outputs[0]


def photo_wall(n, P, bid):
    """楼面照片：按楼的类型从图集里挑一块（写字楼 → 写字楼的几块、住宅 → 住宅的、商业 → 随便哪块），
    随机从第几层、横向从哪儿开始，按真实层高铺开。返回 (线性颜色, 亮度)。"""
    N, n_off = ATLAS['N'], ATLAS['n_off']
    r = n.math('FRACT', n.math('MULTIPLY', bid, 7.77))
    idx = sel3(n, P['kind'], n.math('FLOOR', n.math('MULTIPLY', r, n_off)),
               n.math('ADD', n_off, n.math('FLOOR', n.math('MULTIPLY', r, N - n_off))), n.math('FLOOR', n.math('MULTIPLY', r, N)))
    hits = [n.math('LESS_THAN', n.math('ABSOLUTE', n.math('SUBTRACT', idx, i)), 0.5) for i in range(N)]

    def param(k):   # 第 k 个参数：Σ (idx == i) × 第 i 块的值
        out = 0.0
        for i, h in enumerate(hits):
            out = n.math('ADD', out, n.math('MULTIPLY', h, float(ATLAS['params'][i][k])))
        return out

    rx, ry, rw, rh, floors, wfl = (param(k) for k in range(6))
    v_off = n.math('FLOOR', n.math('MULTIPLY', n.math('FRACT', n.math('MULTIPLY', bid, 3.3)), floors))
    fs = n.math('FRACT', n.math('DIVIDE', n.math('ADD', P['sv'], v_off), floors))
    fsu = n.math('FRACT', n.math('ADD', n.math('DIVIDE', P['u'], n.math('MULTIPLY', P['fh'], wfl)), n.math('FRACT', n.math('MULTIPLY', bid, 5.1))))
    uv = n.new('ShaderNodeCombineXYZ')
    n.put(uv.inputs[0], n.math('ADD', rx, n.math('MULTIPLY', fsu, rw)))
    n.put(uv.inputs[1], n.math('ADD', ry, n.math('MULTIPLY', fs, rh)))
    tex = n.new('ShaderNodeTexImage', interpolation='Linear', extension='EXTEND')
    tex.image = ATLAS['img']
    n.put(tex.inputs['Vector'], uv.outputs[0])
    # 照片里远处的楼被空气雾抬亮了一层灰：减掉一点黑位，暗的墙更暗、亮的窗不变
    col = n.vec('MAXIMUM', n.vec('SCALE', n.vec('SUBTRACT', tex.outputs['Color'], (0.012, 0.012, 0.014)), scale=1.1), (0.0, 0.0, 0.0))
    lum = n.vec('DOT_PRODUCT', col, (0.2126, 0.7152, 0.0722))
    return col, lum


def facade(n):
    win, on, wn, roof, v, bid, P = windows(n)
    kind, mix = P['kind'], P['mix']
    sep = n.new('ShaderNodeSeparateColor')
    n.put(sep.inputs[0], wn.outputs['Color'])
    r, g = sep.outputs[0], sep.outputs[1]

    def const_ramp(fac, stops):
        out = n.ramp(fac, stops)
        out.node.color_ramp.interpolation = 'CONSTANT'
        return out

    # 灯的颜色：东京的写字楼多是冷白的日光灯 / LED；住宅一半暖黄、三分之一冷白（日本家里常用的昼光色），剩下的拉着窗帘（暗、偏橙）
    off_tint = const_ramp(n.math('FRACT', n.math('MULTIPLY', bid, 13.7)), [(0.0, '#ffe2b8'), (0.3, '#fff3e0'), (0.75, '#f2f4ff'), (1.0, '#f2f4ff')])
    res_tint = const_ramp(r, [(0.0, '#ffb867'), (0.55, '#ffdcae'), (0.78, '#eef1ff'), (0.9, '#d98a50'), (1.0, '#d98a50')])
    com_tint = const_ramp(r, [(0.0, '#ffe6c0'), (0.45, '#ffcf8a'), (0.75, '#f4f4f8'), (1.0, '#f4f4f8')])
    res_pow = const_ramp(r, [(0.0, '#c8c8c8'), (0.55, '#d9d9d9'), (0.78, '#d9d9d9'), (0.9, '#4d4d4d'), (1.0, '#4d4d4d')])  # 灰度 = 亮度
    res_pow = n.math('MULTIPLY', n.xyz(res_pow)[0], 1.1)
    k0, k1 = P['office'], n.math('LESS_THAN', n.math('ABSOLUTE', n.math('SUBTRACT', kind, 1.0)), 0.5)
    k2 = n.math('GREATER_THAN', kind, 1.5)
    tint = n.vec('ADD', n.vec('ADD', n.vec('SCALE', off_tint, scale=k0), n.vec('SCALE', res_tint, scale=k1)), n.vec('SCALE', com_tint, scale=k2))
    power = n.math('ADD', n.math('ADD',
                                 n.math('MULTIPLY', k0, n.math('ADD', 0.85, n.math('MULTIPLY', P['fn'].outputs['Value'], 0.45))),
                                 n.math('MULTIPLY', k1, res_pow)),
                   n.math('MULTIPLY', k2, n.math('ADD', 0.6, n.math('MULTIPLY', g, 0.6))))
    power = mix(power, n.math('ADD', 1.1, g), P['gf'])                                   # 店面更亮
    bsep = n.new('ShaderNodeSeparateColor')
    n.put(bsep.inputs[0], P['bn'].outputs['Color'])
    b_r, b_g, b_b = bsep.outputs[0], bsep.outputs[1], bsep.outputs[2]
    power = n.math('MULTIPLY', power, n.math('EXPONENT', n.math('MULTIPLY', n.math('SUBTRACT', b_r, 0.5), 2.2)))  # ×0.33 … ×3
    blinds = n.math('MULTIPLY', P['office'], n.math('LESS_THAN', b_g, 0.3))                 # 写字楼约三成的格子拉着百叶：暗一大截
    power = n.math('MULTIPLY', power, n.math('SUBTRACT', 1.0, n.math('MULTIPLY', blinds, 0.7)))
    # 色温：同一类灯也各不相同（偏暖的白、正白、偏冷的白）
    jitter = n.ramp(b_b, [(0.0, '#ffe9cf'), (0.35, '#fff7ee'), (0.7, '#f3f6ff'), (1.0, '#dfe8ff')])
    # 窗里靠上（天花板的灯）亮、靠下暗一点
    up = n.new('ShaderNodeMapRange', {'Value': P['fv'], 'From Min': P['v0'], 'From Max': P['v1'], 'To Min': 0.6, 'To Max': 1.15},
               interpolation_type='SMOOTHSTEP').outputs[0]
    tint = n.vec('MULTIPLY', tint, jitter)
    # 窗里的细节（近处才看得清）：wu、wv 是窗里的位置（0…1）
    wu = n.math('DIVIDE', n.math('SUBTRACT', P['fu'], P['u0']), n.math('SUBTRACT', 1.0, n.math('MULTIPLY', P['u0'], 2.0)))
    wv = n.math('DIVIDE', n.math('SUBTRACT', P['fv'], P['v0']), n.math('SUBTRACT', P['v1'], P['v0']))
    def inside(x, lo, hi):
        return n.math('MULTIPLY', n.math('GREATER_THAN', x, lo), n.math('LESS_THAN', x, hi))
    glass_in = n.math('MULTIPLY', inside(wu, 0.045, 0.955), inside(wv, 0.06, 0.94))                  # 窗框
    not_office = n.math('SUBTRACT', 1.0, P['office'])
    mullion = n.math('MULTIPLY', not_office, inside(wu, 0.485, 0.515))                                # 推拉窗中间的竖框
    detail = n.math('MULTIPLY', glass_in, n.math('SUBTRACT', 1.0, mullion))
    detail = n.math('ADD', 0.55, n.math('MULTIPLY', detail, 0.45))
    # 住宅、商业：窗帘拉到一半（随机），拉上的那部分透出暗暖的光
    open_frac = n.math('ADD', 0.15, n.math('MULTIPLY', b_g, 0.85))
    curtained = n.math('MULTIPLY', not_office, n.math('GREATER_THAN', n.math('ABSOLUTE', n.math('SUBTRACT', wu, 0.5)), n.math('MULTIPLY', open_frac, 0.5)))
    detail = n.math('MULTIPLY', detail, n.math('SUBTRACT', 1.0, n.math('MULTIPLY', curtained, 0.35)))
    # 写字楼拉着百叶的格子：一条条横纹（每米 6 条）
    stripes = n.math('GREATER_THAN', n.math('FRACT', n.math('MULTIPLY', P['pz'], 6.0)), 0.45)
    detail = n.math('MULTIPLY', detail, n.math('SUBTRACT', 1.0, n.math('MULTIPLY', n.math('MULTIPLY', blinds, stripes), 0.45)))
    # 屋里的灯不在正中：一边亮一边暗
    lamp_pos = n.math('ABSOLUTE', n.math('SUBTRACT', wu, b_b))
    detail = n.math('MULTIPLY', detail, n.math('SUBTRACT', 1.12, n.math('MULTIPLY', lamp_pos, 0.25)))
    emit = n.vec('SCALE', tint, scale=n.math('MULTIPLY', n.math('MULTIPLY', n.math('MULTIPLY', on, power), up), detail))
    # 玻璃幕墙的高楼：竖向的窗框线隐约发亮（被室内的光、对面的灯映着）；一部分超高层的楼顶有一圈冷白的冠灯
    hh = n.math('SUBTRACT', P['top'], P['base'])
    mull = n.math('MULTIPLY', n.math('MULTIPLY', P['curtain'], n.math('GREATER_THAN', n.math('FRACT', n.math('MULTIPLY', bid, 3.7)), 0.4)),
                  n.math('LESS_THAN', n.math('FRACT', n.math('DIVIDE', P['u'], 3.6)), 0.07))
    emit = n.vec('ADD', emit, n.vec('SCALE', srgb('#c9d6ea'), scale=n.math('MULTIPLY', n.math('MULTIPLY', mull, P['wall']), 0.22)))
    crown = n.math('MULTIPLY', n.math('MULTIPLY', n.math('GREATER_THAN', hh, 110.0), n.math('GREATER_THAN', n.math('FRACT', n.math('MULTIPLY', bid, 5.3)), 0.55)),
                   n.math('MULTIPLY', n.math('LESS_THAN', n.math('SUBTRACT', P['top'], P['pz']), 4.0), P['wall']))
    crown_col = n.ramp(n.math('FRACT', n.math('MULTIPLY', bid, 9.1)), [(0.0, '#eaf1ff'), (0.6, '#eaf1ff'), (0.61, '#8fb4ff'), (1.0, '#8fb4ff')])
    emit = n.vec('ADD', emit, n.vec('SCALE', crown_col, scale=n.math('MULTIPLY', crown, 1.4)))
    # 墙面：每栋楼一种外墙（灰的混凝土、米色瓷砖、白墙、深灰、褐色砖、浅灰金属板）；住宅的阳台栏板偏白
    b2 = n.math('FRACT', n.math('MULTIPLY', bid, 7.13))
    albedo = const_ramp(b2, [(0.0, '#8e8a83'), (0.2, '#b2aa9b'), (0.38, '#c6c2ba'), (0.55, '#5f6064'),
                             (0.68, '#8c735f'), (0.8, '#a3a6aa'), (1.0, '#a3a6aa')])
    balcony = n.math('MULTIPLY', n.math('MULTIPLY', k1, n.math('LESS_THAN', P['fv'], P['v0'])), P['wall'])
    albedo = n.vec('ADD', albedo, n.vec('SCALE', n.vec('SUBTRACT', srgb('#cfcac0'), albedo), scale=balcony))
    albedo = n.vec('SCALE', albedo, scale=0.5)          # 夜里看楼身是暗的（只有窗亮）：外墙、阳台栏板的颜色压暗一半
    albedo = n.vec('ADD', albedo, n.vec('SCALE', n.vec('SUBTRACT', srgb('#26303a'), albedo), scale=P['curtain']))  # 幕墙：深色玻璃
    albedo = n.vec('ADD', albedo, n.vec('SCALE', n.vec('SUBTRACT', srgb('#4a4a4b'), albedo), scale=roof))          # 屋顶：深灰
    glass = n.vec('ADD', srgb('#0d1015'), n.vec('SCALE', srgb('#1b2027'), scale=P['curtain']))
    base_col = n.vec('ADD', albedo, n.vec('SCALE', n.vec('SUBTRACT', glass, albedo), scale=win))
    # 楼下几层被街灯、店面从下面照亮（暖色，越往上越弱）；只照墙，不照窗
    street = n.math('MULTIPLY', n.math('MULTIPLY', P['wall'], n.math('SUBTRACT', 1.0, win)), n.math('EXPONENT', n.math('DIVIDE', v, -7.0)))
    emit = n.vec('ADD', emit, n.vec('MULTIPLY', n.vec('SCALE', srgb('#ffb070'), scale=n.math('MULTIPLY', street, 0.18)), albedo))
    rough = n.math('ADD', 0.85, n.math('MULTIPLY', win, -0.7))
    if ATLAS:   # 墙面（底层店面、女儿墙以外）换成照片：照片本身就是这面墙夜里的样子，当发光贴图；墙本身几乎不再反光
        col, _ = photo_wall(n, P, bid)
        use = n.math('MULTIPLY', n.math('MULTIPLY', P['wall'], n.math('SUBTRACT', 1.0, P['gf'])),
                     n.math('LESS_THAN', P['pz'], n.math('SUBTRACT', P['top'], 1.0)))
        use = n.math('MULTIPLY', use, photo_far(n))
        photo = n.vec('SCALE', col, scale=A.atlas_gain)
        emit = n.vec('ADD', emit, n.vec('SCALE', n.vec('SUBTRACT', photo, emit), scale=use))
        base_col = n.vec('ADD', base_col, n.vec('SCALE', n.vec('SUBTRACT', srgb('#101012'), base_col), scale=use))
        rough = n.math('ADD', rough, n.math('MULTIPLY', n.math('SUBTRACT', 0.6, rough), use))
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Emission Strength': 1.0})
    n.put(bsdf.inputs['Base Color'], base_col)
    n.put(bsdf.inputs['Roughness'], rough)
    n.put(bsdf.inputs['Emission Color'], emit)
    return bsdf.outputs[0]


def plain(color, rough=0.8):
    return lambda n: n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba(color), 'Roughness': rough}).outputs[0]


def glow(color, strength):
    return lambda n: n.new('ShaderNodeEmission', {'Color': rgba(color), 'Strength': strength}).outputs[0]


def clear(n):  # 车道的发光条：彩色图里看不见（车灯在网页里画），只在数据图里出现
    return n.new('ShaderNodeBsdfTransparent').outputs[0]


SPIRE_BASE = {}


def spire_glow(n):
    """东京塔的「Landmark Light」：塔脚往上打的投光灯把钢架照成橙色——底下最亮最红，越往上越淡、偏金白。"""
    geo = n.new('ShaderNodeNewGeometry')
    _, _, pz = n.xyz(geo.outputs['Position'])
    base = n.new('ShaderNodeValue')
    SPIRE_BASE.setdefault('nodes', []).append(base)   # 塔脚的 z：城市建好以后再填（每个用到它的材质都有一个）
    t = n.math('DIVIDE', n.math('SUBTRACT', pz, base.outputs[0]), 333.0)
    col = n.ramp(t, [(0.0, '#ff5a00'), (0.45, '#ff6c00'), (0.75, '#ff8008'), (1.0, '#ff9a20')])
    strength = n.new('ShaderNodeMapRange', {'Value': t, 'From Min': 0.0, 'From Max': 1.0, 'To Min': 1.5, 'To Max': 1.05}).outputs[0]
    # 红白相间的涂装（大展望台以上：橙 / 白交替；天线也是）：白的几段在投光灯下是金白色、亮一点
    bands = n.ramp(t, [(0.0, '#000000')] + [(z / 333.0, c) for z0, z1 in SPIRE_WHITE for z, c in ((z0, '#ffffff'), (z1, '#000000'))]
                   + [(1.0, '#000000')])
    bands.node.color_ramp.interpolation = 'CONSTANT'
    white = n.xyz(bands)[0]
    col = n.vec('ADD', n.vec('SCALE', col, scale=n.math('SUBTRACT', 1.0, white)), n.vec('SCALE', srgb('#ffc77a'), scale=white))
    strength = n.math('MULTIPLY', strength, n.math('ADD', 1.0, n.math('MULTIPLY', white, 0.6)))
    em = n.new('ShaderNodeEmission')
    n.put(em.inputs['Color'], col)
    n.put(em.inputs['Strength'], strength)
    return em.outputs[0]


SPIRE_WHITE = [(176, 195), (214, 232), (256, 286), (306, 320)]   # 东京塔涂成白色的几段（离地米数）


def deck(n):
    """东京塔的展望台：一圈大玻璃窗透出暖白的光（2.5 米一根窗框，每 2.5 米一道楼板 / 窗台线是暗的）；顶和底是暗的。"""
    geo = n.new('ShaderNodeNewGeometry')
    px, py, pz = n.xyz(geo.outputs['Position'])
    nx, ny, nz = n.xyz(geo.outputs['Normal'])
    u = n.math('SUBTRACT', n.math('MULTIPLY', py, nx), n.math('MULTIPLY', px, ny))
    wall = n.math('LESS_THAN', n.math('ABSOLUTE', nz), 0.5)
    pane = n.math('LESS_THAN', n.math('FRACT', n.math('DIVIDE', u, 2.5)), 0.86)
    fv = n.math('FRACT', n.math('DIVIDE', pz, 2.5))
    row = n.math('MULTIPLY', n.math('GREATER_THAN', fv, 0.18), n.math('LESS_THAN', fv, 0.92))
    glass = n.math('MULTIPLY', pane, row)
    em = n.new('ShaderNodeEmission', {'Color': rgba('#ffe2b4')})
    n.put(em.inputs['Strength'], n.math('MULTIPLY', wall, n.math('ADD', 0.12, n.math('MULTIPLY', glass, 2.2))))
    return em.outputs[0]


def road(n):
    # 下雨天的柏油路：很暗；湿的地方光滑（倒映路灯、车灯和楼），干一点的地方粗糙——用噪声让它一块块不一样；
    # 路灯照出一圈圈的光（近处有真的点光源），整体只有一点点自发光（远处的路是暗的线，靠路灯的亮点勾出来）
    geo = n.new('ShaderNodeNewGeometry')
    wet = n.new('ShaderNodeTexNoise', {'Scale': 0.08, 'Detail': 3.0})
    n.put(wet.inputs['Vector'], geo.outputs['Position'])
    rough = n.new('ShaderNodeMapRange', {'Value': wet.outputs['Fac'], 'From Min': 0.35, 'From Max': 0.65, 'To Min': 0.12, 'To Max': 0.45}).outputs[0]
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba('#1b1b1d'), 'Emission Color': rgba('#ffd2a0'), 'Emission Strength': 0.03})
    n.put(bsdf.inputs['Roughness'], rough)
    return bsdf.outputs[0]


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
    fogged('lamp', glow('#ffdcae', 30), 0.45),
    fogged('head', glow('#fff3dd', 25), 0.45),
    fogged('tail', glow('#ff2a1a', 12), 0.45),
    fogged('beacon', glow('#ff2414', 25), 0.3),
    fogged('water', water),
    fogged('concrete', plain('#2c2b2a', 0.7)),
    fogged('lane', clear),
    fogged('spire', spire_glow, 0.35),            # 东京塔的钢架：夜里打着橙色的投光灯（见 spire_glow）
    fogged('road', road),
    fogged('deck', deck, 0.35),
    fogged('roof', plain('#3a3532', 0.8), 0.35),
    fogged('paint', plain('#c4c0b6', 0.45)),           # 车道线（白漆，被路灯、车灯照着才看得见）
    fogged('viaduct', plain('#67635d', 0.85)),         # 高架：梁的侧面、护栏、桥墩（灰白的混凝土）
]
FACADE, GROUND, LAMP, HEAD, TAIL, BEACON, WATER, CONCRETE, LANE, SPIRE, ROAD, DECK, ROOF, PAINT, VIADUCT = range(15)


def leaf(n):
    """树叶：暗绿，一团团深浅不一（夜里只有被路灯照到的那一面看得见绿色）。"""
    geo = n.new('ShaderNodeNewGeometry')
    nz = n.new('ShaderNodeTexNoise', {'Scale': 0.9, 'Detail': 4.0, 'Roughness': 0.7})
    n.put(nz.inputs['Vector'], geo.outputs['Position'])
    col = n.ramp(nz.outputs['Fac'], [(0.3, '#16231a'), (0.55, '#2a3c22'), (0.75, '#3e5129')])
    bsdf = n.new('ShaderNodeBsdfPrincipled', {'Roughness': 0.75})
    n.put(bsdf.inputs['Base Color'], col)
    return bsdf.outputs[0]


def shop_glow(color, strength, period, dark_frac, dark=0.3):
    """店里透出来的光：沿墙每 period 米一根暗的竖框（居酒屋的格子拉门、咖啡店的大玻璃窗框）。"""
    def build(n):
        geo = n.new('ShaderNodeNewGeometry')
        px, py, _ = n.xyz(geo.outputs['Position'])
        nx, ny, _ = n.xyz(geo.outputs['Normal'])
        u = n.math('SUBTRACT', n.math('MULTIPLY', py, nx), n.math('MULTIPLY', px, ny))
        bar = n.math('LESS_THAN', n.math('FRACT', n.math('DIVIDE', u, period)), dark_frac)
        em = n.new('ShaderNodeEmission', {'Color': rgba(color)})
        n.put(em.inputs['Strength'], n.math('MULTIPLY', strength, n.math('SUBTRACT', 1.0, n.math('MULTIPLY', bar, 1 - dark))))
        return em.outputs[0]
    return build


def lit_cloth(base, glow_col, glow_str):
    """暖帘：深色的布，后面的灯把它透出一点颜色。"""
    return lambda n: n.new('ShaderNodeBsdfPrincipled', {'Base Color': rgba(base), 'Roughness': 0.9,
                                                        'Emission Color': rgba(glow_col), 'Emission Strength': glow_str}).outputs[0]


_street = [('leaf', leaf, 1.0), ('bark', plain('#2a2420', 0.9), 1.0), ('pole', plain('#7a776f', 0.75), 1.0), ('wire', plain('#121212', 0.5), 1.0),
           ('lamp2', glow('#eef3ff', 22), 0.45), ('lantern', glow('#ff3a18', 4.5), 0.5),
           ('shop_warm', shop_glow('#ffa456', 2.2, 0.16, 0.3), 0.6), ('shop_cafe', shop_glow('#ffd9a8', 2.6, 1.5, 0.05, 0.1), 0.6),
           ('shop_bright', glow('#f3f7ff', 3.2), 0.6), ('noren', lit_cloth('#1b2340', '#2c3d82', 0.45), 0.8),
           ('noren_red', lit_cloth('#6e1010', '#c42222', 0.55), 0.8), ('awning', plain('#2b5a40', 0.8), 1.0)]
STREET_M = {}
for _name, _b, _fs in _street:
    MATS.append(fogged(_name, _b, _fs))
    STREET_M[_name.upper()] = len(MATS) - 1


def sign_mat(n):
    """招牌：内透光的灯箱，图集里的颜色直接当发光。"""
    tex = n.new('ShaderNodeTexImage', interpolation='Linear', extension='EXTEND')
    tex.image = SIGNS['img']
    uv = n.new('ShaderNodeUVMap', uv_map='UVMap')
    n.put(tex.inputs['Vector'], uv.outputs['UV'])
    em = n.new('ShaderNodeEmission', {'Strength': 2.0})
    n.put(em.inputs['Color'], tex.outputs['Color'])
    return em.outputs[0]


SIGN = None
if SIGNS:
    MATS.append(fogged('sign', sign_mat, 0.6))
    SIGN = len(MATS) - 1

# ---------- 城市：楼前是一条河（RIVER），对岸起横街每 71 米一条、纵街每 86 米一条，正前方 x = 0 是一条大道 ----------
# 几何直接攒成数组再一次性建网格（bmesh.ops 每调用一次都会重算整张网格的法线，几万次会非常慢）
V, F, FM, FB, FL = [], [], [], [], []
FK, FH, FZ, FT = [], [], [], []   # 楼的类型（0 写字楼、1 住宅、2 商业 / 其他）、层高、楼的地面 z、楼顶 z（每个面一份）
CUR = dict(kind=2.0, fh=3.4, base=-H, top=0.0)   # prism() 建楼时临时改成这栋楼的；别的东西（灯、杆、车道）用不到


def meta(k, bid=0.0, lit=0.0):
    FB.extend([bid] * k)
    FL.extend([lit] * k)
    FK.extend([CUR['kind']] * k)
    FH.extend([CUR['fh']] * k)
    FZ.extend([CUR['base']] * k)
    FT.extend([CUR['top']] * k)
CUBE = [(4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (3, 0, 4, 7), (1, 2, 6, 5)]  # 不要底面，法线朝外
OCTA = [(4, 0, 2), (4, 2, 1), (4, 1, 3), (4, 3, 0), (5, 2, 0), (5, 1, 2), (5, 3, 1), (5, 0, 3)]


def cube(cx, cy, z0, w, d, h, mi, bid=0.0, lit=0.0):
    x0, x1, y0, y1, z1 = cx - w / 2, cx + w / 2, cy - d / 2, cy + d / 2, z0 + h
    o = len(V)
    V.extend([(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])
    for f in CUBE:
        F.append(tuple(o + i for i in f))
        FM.append(mi)
        meta(1, bid, lit)


def dot(x, y, z, r, mi):
    o = len(V)
    V.extend([(x + r, y, z), (x - r, y, z), (x, y + r, z), (x, y - r, z), (x, y, z + r), (x, y, z - r)])
    for f in OCTA:
        F.append(tuple(o + i for i in f))
        FM.append(mi)
        meta(1, 0.0, 0.0)


def tallness(x, y):
    d1 = ((x - 180) / 420) ** 2 + ((y - 1300) / 360) ** 2      # 市中心
    d2 = ((x + 950) / 300) ** 2 + ((y - 2300) / 320) ** 2      # 远处另一簇
    return 1 + 6.5 * math.exp(-d1) + 3.5 * math.exp(-d2)


def prism(pts, z0, h, mi, bid=0.0, lit=0.0, kind=2.0, fh=3.4):
    """多边形柱体（pts 逆时针，从上往下看）：一圈墙 + 平顶，不要底。kind、fh：楼的类型、层高（窗户怎么排、什么灯）。"""
    CUR.update(kind=kind, fh=fh, base=z0, top=z0 + h)
    o, k = len(V), len(pts)
    V.extend([(x, y, z0) for x, y in pts] + [(x, y, z0 + h) for x, y in pts])
    for i in range(k):
        j = (i + 1) % k
        F.append((o + i, o + j, o + k + j, o + k + i))
    F.append(tuple(o + k + i for i in range(k)))
    FM.extend([mi] * (k + 1))
    meta(k + 1, bid, lit)


def rod(p0, p1, r, mi):
    """方截面的细杆（钢架用）：四个侧面。"""
    d = Vector(p1) - Vector(p0)
    if d.length < 1e-6:
        return
    t = d.normalized()
    a = t.cross(Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))).normalized() * r
    b = t.cross(a).normalized() * r
    o = len(V)
    for p in (p0, p1):
        p = Vector(p)
        V.extend([tuple(p + a + b), tuple(p - a + b), tuple(p - a - b), tuple(p + a - b)])
    for i in range(4):
        j = (i + 1) % 4
        F.append((o + i, o + j, o + 4 + j, o + 4 + i))
        FM.append(mi)
        meta(1, 0.0, 0.0)


def lane_ab(a, b, segs=12):
    """一条车道：a → b（Blender 坐标），彩色图里透明，数据图里是"车道"带子（越远越宽）。"""
    LANES.append(dict(a=[round(v, 2) for v in a], b=[round(v, 2) for v in b], toward=bool(math.hypot(b[0], b[1]) < math.hypot(a[0], a[1]))))
    L = math.hypot(b[0] - a[0], b[1] - a[1])
    nx_, ny_ = -(b[1] - a[1]) / L, (b[0] - a[0]) / L
    for k in range(segs):
        p0 = [a[i] + (b[i] - a[i]) * k / segs for i in range(3)]
        p1 = [a[i] + (b[i] - a[i]) * (k + 1) / segs for i in range(3)]
        w0 = max(3.0, math.hypot(p0[0], p0[1]) * 0.0035) / 2
        w1 = max(3.0, math.hypot(p1[0], p1[1]) * 0.0035) / 2
        o = len(V)
        V.extend([(p0[0] - nx_ * w0, p0[1] - ny_ * w0, p0[2]), (p0[0] + nx_ * w0, p0[1] + ny_ * w0, p0[2]),
                  (p1[0] + nx_ * w1, p1[1] + ny_ * w1, p1[2]), (p1[0] - nx_ * w1, p1[1] - ny_ * w1, p1[2])])
        F.append((o, o + 1, o + 2, o + 3))
        FM.append(LANE)
        meta(1, 0.0, 0.0)


def strip(pts, width, mi):
    """沿折线（(x, y, z) 的列表）铺一条带子（路面）：每段一个四边形。"""
    w = width / 2
    for (x0, y0, z0), (x1, y1, z1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        if L < 0.3:
            continue
        nx_, ny_ = -(y1 - y0) / L * w, (x1 - x0) / L * w
        o = len(V)
        V.extend([(x0 - nx_, y0 - ny_, z0), (x1 - nx_, y1 - ny_, z1), (x1 + nx_, y1 + ny_, z1), (x0 + nx_, y0 + ny_, z0)])
        F.append((o, o + 1, o + 2, o + 3))
        FM.append(mi)
        meta(1)


def offset_line(pts, off):
    """折线往左偏 off 米（每个点按前后两段的平均方向）。"""
    out = []
    for i, (x, y, z) in enumerate(pts):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        L = math.hypot(b[0] - a[0], b[1] - a[1]) or 1.0
        out.append((x - (b[1] - a[1]) / L * off, y + (b[0] - a[0]) / L * off, z))
    return out


def band(pts_a, pts_b, mi, dz_a=0.0, dz_b=0.0):
    """两条折线之间铺四边形（竖着的面：同一条线、两个高度）。"""
    for (p0, p1), (q0, q1) in zip(zip(pts_a, pts_a[1:]), zip(pts_b, pts_b[1:])):
        o = len(V)
        V.extend([(p0[0], p0[1], p0[2] + dz_a), (p1[0], p1[1], p1[2] + dz_a), (q1[0], q1[1], q1[2] + dz_b), (q0[0], q0[1], q0[2] + dz_b)])
        F.append((o, o + 1, o + 2, o + 3))
        FM.append(mi)
        meta(1)


def dashes(pts, length, gap):
    """把折线切成一段段（虚线）。"""
    out, cur, acc, on = [], [pts[0]], 0.0, True
    for p0, p1 in zip(pts, pts[1:]):
        seg = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
        t = 0.0
        while seg - t > 1e-6:
            step = min((length if on else gap) - acc, seg - t)
            t += step
            acc += step
            q = tuple(p0[k] + (p1[k] - p0[k]) * t / seg for k in range(3))
            if on:
                cur.append(q)
            if acc >= (length if on else gap) - 1e-6:
                if on and len(cur) > 1:
                    out.append(cur)
                on, acc, cur = not on, 0.0, [q]
    if on and len(cur) > 1:
        out.append(cur)
    return out


def road_geom(pts, width, lift, lanes, oneway, near):
    """一条路（pts：路中线 (x, y, 路面 z)）：路面；近处画车道线（两边实线、车道之间 6 米一段的虚线）；
    高架（lift > 0）再加两侧梁的侧面（路面以下 1.8 米）、护栏（路面以上 1.1 米）和每 35 米一个桥墩。"""
    w = width / 2
    strip([(x, y, z + 0.05) for x, y, z in pts], width, ROAD)
    if near:
        lifted = [(x, y, z + 0.08) for x, y, z in pts]
        for off in (w - 0.5, -(w - 0.5)):
            strip(offset_line(lifted, off), 0.18, PAINT)
        n_l = max(1, int(lanes)) * (1 if oneway else 2)
        for k in range(1, n_l):
            off = -w + 0.5 + k * (width - 1.0) / n_l
            solid = (not oneway) and k == n_l // 2                       # 双向路中间：实线
            for d in ([offset_line(lifted, off)] if solid else dashes(offset_line(lifted, off), 6.0, 6.0)):
                strip(d, 0.14, PAINT)
    if lift > 0:
        for side in (1, -1):
            edge = offset_line(pts, side * w)                             # 梁的外侧面（朝外）+ 护栏外侧
            if side > 0:
                band(edge, edge, VIADUCT, 1.1, -1.8)
            else:
                band(edge, edge, VIADUCT, -1.8, 1.1)
            inner = offset_line(pts, side * (w - 0.35))                   # 护栏的里面（朝路）
            if side > 0:
                band(inner, inner, VIADUCT, 0.0, 1.1)
            else:
                band(inner, inner, VIADUCT, 1.1, 0.0)
        acc = 0.0
        for p0, p1 in zip(pts, pts[1:]):
            seg = math.hypot(p1[0] - p0[0], p1[1] - p0[1])
            if seg < 0.3:
                continue
            t = (35.0 - acc) % 35.0
            while t < seg:
                x, y = p0[0] + (p1[0] - p0[0]) * t / seg, p0[1] + (p1[1] - p0[1]) * t / seg
                zt = p0[2] + (p1[2] - p0[2]) * t / seg
                g = ground_z(x, y)
                if zt - 1.8 > g + 1:
                    cube(x, y, g, 2.4, 2.4, zt - 1.8 - g, VIADUCT)
                t += 35.0
            acc = (acc + seg) % 35.0


def sphere(c, rad, mi, zs=1.0, seg=8, rings=5):
    """低面数的球（树冠、灯笼）：zs 是竖直方向的拉伸。"""
    o = len(V)
    V.append((c[0], c[1], c[2] + rad * zs))
    for i in range(1, rings):
        th = math.pi * i / rings
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            V.append((c[0] + rad * math.sin(th) * math.cos(ph), c[1] + rad * math.sin(th) * math.sin(ph), c[2] + rad * zs * math.cos(th)))
    V.append((c[0], c[1], c[2] - rad * zs))
    bot = len(V) - 1
    for j in range(seg):
        F.append((o, o + 1 + j, o + 1 + (j + 1) % seg))
    for i in range(rings - 2):
        a0, a1 = o + 1 + i * seg, o + 1 + (i + 1) * seg
        for j in range(seg):
            F.append((a0 + j, a1 + j, a1 + (j + 1) % seg, a0 + (j + 1) % seg))
    last = o + 1 + (rings - 2) * seg
    for j in range(seg):
        F.append((last + (j + 1) % seg, last + j, bot))
    k = seg * rings                      # 顶上一圈三角 + 中间 rings-2 圈四边形 + 底下一圈三角
    FM.extend([mi] * k)
    meta(k)


def quad3(c0, c1, c2, c3, mi):
    o = len(V)
    V.extend([c0, c1, c2, c3])
    F.append((o, o + 1, o + 2, o + 3))
    FM.append(mi)
    meta(1)


def osm_lamp(x, y, z):
    dot(x, y, z, 0.35, LAMP)
    if math.hypot(x, y) < 450:
        lamps.append((x, y, z - 0.4))


lamp_light = bpy.data.lights.new('street', 'POINT')
lamp_light.energy = 900
lamp_light.color = srgb('#ffd6a4')
lamp_light.shadow_soft_size = 0.4
lamps = []
EXTRA_LIGHTS = []        # (x, y, z, 种类)：电线杆上的防犯灯、店门口的光
LANES = []
PL = None
if A.plateau:
    PL = dict(np.load(A.plateau))
    assert abs(float(PL['vp'][0]) - A.vp_lat) < 1e-6 and abs(float(PL['vp'][1]) - A.vp_lon) < 1e-6 \
        and abs(float(PL['vp'][2]) - A.bearing) < 1e-6 and abs(float(PL['vp'][3]) - (A.height or VIEW['height'])) < 1e-6, \
        'npz 的视点和这次的参数不一样：重跑 plateau_prep.py'
    DEM, (DX0, DY0, DSTEP) = PL['dem'], PL['dem_box']


def ground_z(x, y):
    """(x, y) 处的地面 z（有 PLATEAU 地形就查地形，没有就是平地 -H）。"""
    if PL is None:
        return -H
    i = min(max((x - DX0) / DSTEP, 0), DEM.shape[1] - 1.001)
    j = min(max((y - DY0) / DSTEP, 0), DEM.shape[0] - 1.001)
    i0, j0 = int(i), int(j)
    fx, fy = i - i0, j - j0
    d = DEM
    return float((d[j0, i0] * (1 - fx) + d[j0, i0 + 1] * fx) * (1 - fy) + (d[j0 + 1, i0] * (1 - fx) + d[j0 + 1, i0 + 1] * fx) * fy)


def plateau_mesh():
    """PLATEAU 的楼：一个单独的网格（几十万个面，用 numpy 一次塞进去）。返回 (网格, 楼数, 覆盖范围的判断函数)。"""
    Vp, P, Plen, Pb, Pt = PL['V'], PL['P'], PL['Plen'], PL['Pb'], PL['Pt']
    nb = len(PL['B_kind'])
    r = random.Random(29)
    kind, fh = PL['B_kind'].astype(np.float64).copy(), PL['B_fh'].astype(np.float64).copy()
    height, base, top = PL['B_height'], PL['B_base'] - float(PL['eye']), PL['B_top'] - float(PL['eye'])
    bid = np.array([r.random() for _ in range(nb)])
    lit = np.zeros(nb)
    tx, ty = osm_city.Projector(A.vp_lat, A.vp_lon, A.bearing)(*osm_city.LANDMARK)
    keep_b = np.ones(nb, bool)
    for b in range(nb):
        h = float(height[b])
        if kind[b] < 0:                                       # 用途没写：按高度猜
            x = r.random()
            kind[b] = (0 if x < 0.6 else 1) if h >= 50 else ((1 if x < 0.45 else 0 if x < 0.75 else 2) if h >= 20 else (1 if x < 0.55 else 2))
        dflt = (4.0, 3.0, 3.5)[int(kind[b])]
        fh[b] = dflt if not (2.6 <= fh[b] <= 6.0) else fh[b]
        lit[b] = min(0.9, r.betavariate(2.2, 2.4) * (1.15 if h > 60 else 1.0))
        if math.hypot(PL['B_cx'][b] - tx, PL['B_cy'][b] - ty) < 60 and h > 100:   # 东京塔本身：自己搭（或用模型）
            keep_b[b] = False
    keep = keep_b[Pb]
    starts = np.concatenate([[0], np.cumsum(Plen)[:-1]])
    Plen_k, starts_k, Pb_k = Plen[keep], starts[keep], Pb[keep]
    idx = np.concatenate([P[s:s + k] for s, k in zip(starts_k, Plen_k)])
    used, inv = np.unique(idx, return_inverse=True)
    m = bpy.data.meshes.new('Plateau')
    m.vertices.add(len(used))
    m.vertices.foreach_set('co', Vp[used].astype(np.float32).ravel())
    m.loops.add(len(idx))
    m.loops.foreach_set('vertex_index', inv.astype(np.int32))
    m.polygons.add(len(Plen_k))
    m.polygons.foreach_set('loop_start', np.concatenate([[0], np.cumsum(Plen_k)[:-1]]).astype(np.int32))
    m.polygons.foreach_set('loop_total', Plen_k.astype(np.int32))
    m.update(calc_edges=True)
    m.validate(clean_customdata=False)
    m.polygons.foreach_set('material_index', np.full(len(m.polygons), FACADE, np.int32))
    for name, vals in (('bid', bid), ('lit', lit), ('kind', kind), ('fh', fh), ('base', base), ('top', top)):
        m.attributes.new(name, 'FLOAT', 'FACE').data.foreach_set('value', vals[Pb_k].astype(np.float32))
    # 高楼（60 米以上）楼顶的航空障碍灯：楼顶最高的那圈点里，取最靠外的四个
    vstart = np.full(nb, -1)
    vend = np.full(nb, -1)
    for b, s0, k in zip(Pb, starts, Plen):
        if vstart[b] < 0:
            vstart[b] = P[s0]
        vend[b] = max(vend[b], P[s0 + k - 1])
    for b in np.nonzero(keep_b & (height > 60))[0]:
        pts = Vp[vstart[b]:vend[b] + 1]
        roof = pts[pts[:, 2] > pts[:, 2].max() - 0.8]
        for p in {tuple(roof[roof[:, 0].argmin()]), tuple(roof[roof[:, 0].argmax()])}:
            dot(p[0], p[1], p[2] + 1.0, 0.5 + math.hypot(p[0], p[1]) * 0.0004, BEACON)
    # 覆盖范围：50 米一格，哪些格子里有 PLATEAU 的楼（OSM 的楼落在这些格子里就不要了）
    cov = set(zip((PL['B_cx'] // 50).astype(int), (PL['B_cy'] // 50).astype(int)))
    cov |= {(a + da, b + db) for a, b in cov for da in (-1, 0, 1) for db in (-1, 0, 1)}
    return m, int(keep_b.sum()), (lambda x, y: (int(x // 50), int(y // 50)) in cov)


class SignBuilder:
    """带 UV 的招牌网格：楼上的招牌、街边店面的招牌都往这里加，最后一起建成一个网格。"""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.fm = [], [], [], []
        self.vert = [s for s in SIGNS['items'] if s['vertical']]
        self.hori = [s for s in SIGNS['items'] if not s['vertical']]

    def find(self, text):
        for s in SIGNS['items']:
            if s['text'] == text:
                return s
        return None

    def quad(self, c0, c1, c2, c3, rect, mi, flip=False):
        o = len(self.verts)
        self.verts.extend([c0, c1, c2, c3])
        self.faces.append((o, o + 1, o + 2, o + 3))
        x, y, w, h = rect
        us = (1, 0, 0, 1) if flip else (0, 1, 1, 0)
        self.uvs.extend([(x + us[0] * w, y), (x + us[1] * w, y), (x + us[2] * w, y + h), (x + us[3] * w, y + h)])
        self.fm.append(mi)

    def perpendicular(self, rect, p0, t, nrm, z0, z1, W):
        """垂直伸出墙外的招牌（两面都是字，从哪一面看都是正的）。"""
        for side in (1, -1):
            q = p0 + t * 0.15 * side
            e0, e1 = q + nrm * 0.2, q + nrm * (0.2 + W)
            right = np.array([-side * t[1], side * t[0]])
            self.quad((*e0, z0), (*e1, z0), (*e1, z1), (*e0, z1), rect, SIGN, flip=float(np.dot(nrm, right)) < 0)

    def mesh(self):
        me_s = bpy.data.meshes.new('Signs')
        me_s.from_pydata(self.verts, [], self.faces)
        uvl = me_s.uv_layers.new(name='UVMap')
        uvl.data.foreach_set('uv', np.array(self.uvs, np.float32).ravel())
        me_s.polygons.foreach_set('material_index', np.array(self.fm, np.int32))
        me_s.update()
        return me_s


def plateau_signs(SB):
    """镜头附近（60–480 米）、看得见的楼：商业楼大多挂一块竖招牌（低层楼三成、别的高楼偶尔），挂在朝着镜头的那面墙靠一头的地方，
    从三楼往上、垂直伸出墙外；一部分商业楼的楼顶前沿再立一块横招牌。返回一个带 UV 的网格（正面是招牌、背面是暗的）。"""
    Vp, P, Plen, Pb, Pt = PL['V'], PL['P'], PL['Plen'], PL['Pb'], PL['Pt']
    nb = len(PL['B_kind'])
    starts = np.concatenate([[0], np.cumsum(Plen)[:-1]])
    first, last = np.searchsorted(Pb, np.arange(nb)), np.searchsorted(Pb, np.arange(nb), side='right')
    vert, hori, quad = SB.vert, SB.hori, SB.quad
    r = random.Random(41)
    tx, ty = osm_city.Projector(A.vp_lat, A.vp_lon, A.bearing)(*osm_city.LANDMARK)

    n_v = n_h = n_w = 0
    for b in range(nb):
        cx, cy = float(PL['B_cx'][b]), float(PL['B_cy'][b])
        d = math.hypot(cx, cy)
        if d < 60 or d > 480 or cy <= 0 or abs(math.degrees(math.atan2(cx, cy))) > 85 or math.hypot(cx - tx, cy - ty) < 70:
            continue
        kind, h = int(PL['B_kind'][b]), float(PL['B_height'][b])
        if r.random() > (0.9 if kind == 2 else 0.45 if h < 40 else 0.15) or h < 7:
            continue
        best = None
        for k in range(first[b], last[b]):
            if Pt[k] != 0:
                continue
            pts = Vp[P[starts[k]:starts[k] + Plen[k]]]
            zmin = float(pts[:, 2].min())
            low = pts[pts[:, 2] < zmin + 0.5]
            if len(low) < 2:
                continue
            dvec = low[:, :2] - low[0, :2]
            j = int(np.argmax((dvec ** 2).sum(1)))
            a, c = low[0, :2].astype(float), low[j, :2].astype(float)
            L = float(np.hypot(*(c - a)))
            if L < 5:
                continue
            t = (c - a) / L
            nrm = np.array([-t[1], t[0]])
            mid = (a + c) / 2
            if np.dot(nrm, mid - (cx, cy)) < 0:
                nrm = -nrm
            face = -float(np.dot(nrm, mid)) / max(1.0, float(np.hypot(*mid)))
            if face > 0.3 and (best is None or face * L > best[0]):
                best = (face * L, a, c, t, nrm, zmin, float(pts[:, 2].max()), L)
        if not best:
            continue
        _, a, c, t, nrm, zb, zt, L = best
        # 竖招牌：靠墙的一头，伸出墙外 0.2 → 0.2 + 宽；高 = 3.5 × 宽
        H = min(max(0.38 * (zt - zb), 4.0), 11.0)
        W = H / 3.5
        z0 = zb + min(7.0, (zt - zb) * 0.3)
        z1 = min(zt - 0.4, z0 + H)
        if z1 - z0 > 2.0:
            s = vert[r.randrange(len(vert))]['rect']
            p0 = a + (c - a) * (0.1 if r.random() < 0.5 else 0.9)
            SB.perpendicular(s, p0, t, nrm, z0, z1, W)
            n_v += 1
        # 贴在墙上、正对着镜头的招牌（楼名、店名）：宽的墙横着挂在上面几层，窄的墙竖着挂
        if r.random() < (0.6 if kind == 2 else 0.25):
            m = (a + c) / 2 + nrm * 0.25 + t * (L * r.uniform(-0.18, 0.18))
            right = np.array([-nrm[1], nrm[0]])
            flip = float(np.dot(t, right)) < 0
            if L > 9:
                Wf = min(L * 0.55, 10.0)
                Hf = Wf / 4
                z1f = zt - 1.0 - r.uniform(0, max(0.0, (zt - zb) * 0.3))
                s = hori[r.randrange(len(hori))]['rect']
            else:
                Hf = min(max(0.3 * (zt - zb), 3.0), 8.0)
                Wf = Hf / 3.5
                z1f = zt - 1.0
                s = vert[r.randrange(len(vert))]['rect']
            if z1f - Hf > zb + 3.0:
                e0, e1 = m - t * Wf / 2, m + t * Wf / 2
                quad((*e0, z1f - Hf), (*e1, z1f - Hf), (*e1, z1f), (*e0, z1f), s, SIGN, flip=flip)
                n_w += 1
        # 楼顶的横招牌（商业楼、不太高的楼）
        if kind == 2 and zt - zb < 60 and r.random() < 0.45:
            Wb = min(L * 0.8, 14.0)
            Hb = Wb / 4
            m = (a + c) / 2 - nrm * 0.8
            e0, e1 = m - t * Wb / 2, m + t * Wb / 2
            zb0 = zt + 0.6
            s = hori[r.randrange(len(hori))]['rect']
            right = np.array([-nrm[1], nrm[0]])          # 站在楼外（nrm 那一侧）看招牌时的右手边
            quad((*e0, zb0), (*e1, zb0), (*e1, zb0 + Hb), (*e0, zb0 + Hb), s, SIGN, flip=float(np.dot(t, right)) < 0)
            quad((*e1, zb0), (*e0, zb0), (*e0, zb0 + Hb), (*e1, zb0 + Hb), (0, 0, 0, 0), ROOF)
            n_h += 1
    print(f'[signs] 竖招牌 {n_v} 块、墙上的招牌 {n_w} 块、楼顶横招牌 {n_h} 块')


def street_context_build():
    """给 street_detail.build 准备一组函数：几何（杆、球、四边形、路面、招牌、灯）、"这里是不是在楼里"、"这面墙从窗户看不看得见"。"""
    import types
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    import street_detail
    Vp, P, Plen, Pb, Pt = PL['V'], PL['P'], PL['Plen'], PL['Pb'], PL['Pt']
    nb = len(PL['B_kind'])
    starts = np.concatenate([[0], np.cumsum(Plen)[:-1]])
    first, last = np.searchsorted(Pb, np.arange(nb)), np.searchsorted(Pb, np.arange(nb), side='right')
    bd = np.hypot(PL['B_cx'], PL['B_cy'])
    # 700 米以内的楼做一棵射线检测树（BVH）
    sel = np.nonzero(bd[Pb] < 700)[0]
    idx = [P[starts[k]:starts[k] + Plen[k]] for k in sel]
    used, inv = np.unique(np.concatenate(idx), return_inverse=True)
    polys, o = [], 0
    for a in idx:
        polys.append(tuple(inv[o:o + len(a)].tolist()))
        o += len(a)
    bvh = BVHTree.FromPolygons([tuple(v) for v in Vp[used].tolist()], polys, all_triangles=False)

    def occupied(x, y):
        hit = bvh.ray_cast(Vector((x, y, 400.0)), Vector((0, 0, -1)))
        return hit[0] is not None and hit[0].z > ground_z(x, y) + 0.8

    def seen(p):
        d = Vector(p)
        L = d.length
        hit = bvh.ray_cast(Vector((0, 0, 0)), d.normalized(), L)
        return hit[0] is None or hit[3] > L - 0.8

    walls_cache = {}

    def walls(b):
        if b not in walls_cache:
            out = []
            for k in range(first[b], last[b]):
                if Pt[k] != 0:
                    continue
                pts = Vp[P[starts[k]:starts[k] + Plen[k]]]
                zmin = float(pts[:, 2].min())
                low = pts[pts[:, 2] < zmin + 0.5]
                if len(low) < 2:
                    continue
                j = int(np.argmax(((low[:, :2] - low[0, :2]) ** 2).sum(1)))
                a, c = low[0, :2].astype(float), low[j, :2].astype(float)
                L = float(np.hypot(*(c - a)))
                if L < 2.5:
                    continue
                t = (c - a) / L
                nrm = np.array([-t[1], t[0]])
                if np.dot(nrm, (a + c) / 2 - (PL['B_cx'][b], PL['B_cy'][b])) < 0:
                    nrm = -nrm
                out.append((a, c, nrm, zmin, float(pts[:, 2].max()), L, k))
            walls_cache[b] = out
        return walls_cache[b]

    def buildings(dmin, dmax):
        for b in np.nonzero((bd > dmin) & (bd < dmax) & (PL['B_cy'] > 0))[0]:
            w = walls(b)
            if not w:
                continue
            xy = np.array([p for ww in w for p in (ww[0], ww[1])])
            area = 0.5 * abs(float(np.sum(xy[:-1, 0] * xy[1:, 1] - xy[1:, 0] * xy[:-1, 1])))
            yield (float(PL['B_cx'][b]), float(PL['B_cy'][b]), float(PL['B_height'][b]), int(PL['B_kind'][b]), area, w)

    def wall_near(x, y, radius, used):
        best = None
        for b in np.nonzero(np.hypot(PL['B_cx'] - x, PL['B_cy'] - y) < radius + 40)[0]:
            for (a, c, nrm, zb, zt, L, k) in walls(b):
                if L < 4 or (b, k) in used:
                    continue
                mid = (a + c) / 2
                if zb > ground_z(mid[0] + nrm[0] * 2, mid[1] + nrm[1] * 2) + 1.5:   # 退台上面那段墙（墙脚在下一层的屋顶上）：不是一楼
                    continue
                if -float(np.dot(nrm, mid)) / max(1.0, float(np.hypot(*mid))) < 0.15:     # 不朝着镜头
                    continue
                t = (c - a) / L
                s = float(np.clip(np.dot(np.array((x, y)) - a, t), 0, L))
                d = float(np.hypot(*((a + t * s) - np.array((x, y)))))
                if d > radius:
                    continue
                if not seen((mid[0] + nrm[0] * 0.6, mid[1] + nrm[1] * 0.6, zb + 1.8)):
                    continue
                if best is None or d < best[0]:
                    best = (d, (int(b), k), a, c, nrm, zb)
        return best[1:] if best else None

    def sign_vertical(text, p, t, nrm, z0, H):
        s = SB.find(text) or SB.vert[0]
        SB.perpendicular(s['rect'], p, t, nrm, z0, z0 + H, H / 3.5)

    def sign_flat(text, m, t, nrm, z0, W, flip):
        s = SB.find(text) or SB.hori[0]
        Wf, Hf = (W, W / 4) if not s['vertical'] else (W * 0.3, W * 0.3 * 3.5)
        q = m + nrm * 0.12
        e0, e1 = q - t * Wf / 2, q + t * Wf / 2
        SB.quad((*e0, z0), (*e1, z0), (*e1, z0 + Hf), (*e0, z0 + Hf), s['rect'], SIGN, flip=flip)

    C = types.SimpleNamespace(
        proj=osm_city.Projector(A.vp_lat, A.vp_lon, A.bearing), gz=ground_z, osm=A.osm, mats=dict(STREET_M, LAMP=LAMP),
        rod=rod, dot=dot, cube=cube, sphere=sphere, quad=quad3,
        road=lambda pts, w: strip([(x, y, z + 0.04) for x, y, z in pts], w, ROAD),
        light=lambda x, y, z, k: EXTRA_LIGHTS.append((x, y, z, k)) if math.hypot(x, y) < 520 else None,
        occupied=occupied, buildings=buildings, wall_near=wall_near,
        sign_vertical=sign_vertical if SB else (lambda *a, **k: None), sign_flat=sign_flat if SB else (lambda *a, **k: None))
    street_detail.build(C)


if A.osm:
    import osm_city
    pl_mesh, pl_n, covered = (plateau_mesh() if PL is not None else (None, 0, None))
    SB = SignBuilder() if (PL is not None and SIGNS) else None
    if SB:
        plateau_signs(SB)
    n_bld = pl_n + osm_city.build(prism, rod, dot, lane_ab, osm_lamp,
                           dict(FACADE=FACADE, BEACON=BEACON, SPIRE=SPIRE, DECK=DECK, ROOF=ROOF, LAMP=LAMP, LANE=LANE, ROAD=ROAD), H, A,
                           add_road=road_geom, ground=ground_z if PL is not None else None, covered=covered)
    _tx, _ty = osm_city.Projector(A.vp_lat, A.vp_lon, A.bearing)(*osm_city.LANDMARK)
    for nd in SPIRE_BASE['nodes']:
        nd.outputs[0].default_value = ground_z(_tx, _ty)
    if PL is None:
        cube(0, 4000, -H - 6, 30000, 9000, 6, GROUND)   # 地面（东京没有河，平地一块）
    else:                                               # 地形：PLATEAU 的标高网格（港区以外是推出来的）
        ny_, nx_ = DEM.shape
        o = len(V)
        V.extend((DX0 + i * DSTEP, DY0 + j * DSTEP, float(DEM[j, i]) - 0.3) for j in range(ny_) for i in range(nx_))
        for j in range(ny_ - 1):
            for i in range(nx_ - 1):
                a = o + j * nx_ + i
                F.append((a, a + 1, a + nx_ + 1, a + nx_))
        FM.extend([GROUND] * ((ny_ - 1) * (nx_ - 1)))
        meta((ny_ - 1) * (nx_ - 1))
    if PL is not None and A.street:
        street_context_build()
    sign_mesh = SB.mesh() if SB else None
else:
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
            meta(1, 0.0, 0.0)


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
for name, vals in (('bid', FB), ('lit', FL), ('kind', FK), ('fh', FH), ('base', FZ), ('top', FT)):
    me.attributes.new(name, 'FLOAT', 'FACE').data.foreach_set('value', vals)
me.update()
for m in MATS:
    me.materials.append(m)
city = bpy.data.objects.new('City', me)
scene.collection.objects.link(city)
MESHES = [me]
if A.osm and pl_mesh is not None:
    for mt in MATS:
        pl_mesh.materials.append(mt)
    scene.collection.objects.link(bpy.data.objects.new('Plateau', pl_mesh))
    MESHES.append(pl_mesh)
if A.osm and sign_mesh is not None:
    for mt in MATS:
        sign_mesh.materials.append(mt)
    scene.collection.objects.link(bpy.data.objects.new('Signs', sign_mesh))
    MESHES.append(sign_mesh)
_kinds = {'pole': ('#eef2ff', 260), 'shop': ('#ffae66', 420), 'shop_white': ('#f2f6ff', 900)}
_ldata = {}
for (x, y, z, k) in EXTRA_LIGHTS:
    if k not in _ldata:
        _ldata[k] = bpy.data.lights.new('light_' + k, 'POINT')
        _ldata[k].color, _ldata[k].energy, _ldata[k].shadow_soft_size = srgb(_kinds[k][0]), _kinds[k][1], 0.3
    ob = bpy.data.objects.new('light_' + k, _ldata[k])
    ob.location = (x, y, z)
    scene.collection.objects.link(ob)
for (x, y, z) in lamps:
    ob = bpy.data.objects.new('street', lamp_light)
    ob.location = (x, y, z)
    scene.collection.objects.link(ob)
print(f'[city] {n_bld} buildings, {sum(len(m.polygons) for m in MESHES) if A.osm else len(me.polygons)} faces, {len(lamps)} street lights')

if A.clay:  # 白模：所有面一种灰白色，一盏斜着的太阳光，渲窗户前方 ±60° 的一截全景，看视角和楼的样子
    clay = bpy.data.materials.new('clay')
    nc = Nodes(tree(clay))
    nc.put(nc.new('ShaderNodeOutputMaterial').inputs['Surface'], nc.new('ShaderNodeBsdfDiffuse', {'Color': rgba('#d9d6cf')}).outputs[0])
    scene.view_layers[0].material_override = clay
    sun_c = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun_c.data.energy = 3.0
    sun_c.rotation_euler = (math.radians(50), 0, math.radians(-30))
    scene.collection.objects.link(sun_c)
    for ob in [o for o in scene.objects if o.type == 'LIGHT' and o.data.type == 'POINT']:
        bpy.data.objects.remove(ob)
    wc = bpy.data.worlds.new('clay')
    nw = Nodes(tree(wc))
    nw.put(nw.new('ShaderNodeOutputWorld').inputs['Surface'], nw.new('ShaderNodeBackground', {'Color': rgba('#9fb3c8'), 'Strength': 0.6}).outputs[0])
    scene.world = wc
    cd = bpy.data.cameras.new('clay')
    cd.type, cd.panorama_type = 'PANO', 'EQUIRECTANGULAR'
    cd.longitude_min, cd.longitude_max = math.radians(-60), math.radians(60)
    cd.latitude_min, cd.latitude_max = math.radians(-25), math.radians(35)
    cd.clip_start, cd.clip_end = 0.5, 20000
    cc = bpy.data.objects.new('clay', cd)
    cc.rotation_euler = (math.pi / 2, 0, 0)
    scene.collection.objects.link(cc)
    scene.camera = cc
    use_metal(scene, 32)
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = 2400, 1200
    scene.render.image_settings.file_format = 'PNG'
    scene.render.filepath = A.clay
    bpy.ops.render.render(write_still=True)
    print('[clay]', A.clay)
    sys.exit(0)

# ---------- 月亮、天空 ----------
mm = bpy.data.materials.new('moon')
n = Nodes(tree(mm))
n.put(n.new('ShaderNodeOutputMaterial').inputs['Surface'], n.new('ShaderNodeEmission', {'Color': rgba('#f4efdf'), 'Strength': 5.0}).outputs[0])
dist = 6000
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=dist * math.tan(math.radians(0.7)), location=moon_dir * dist)
moon = bpy.context.active_object
moon.data.materials.append(mm)
sun = bpy.data.lights.new('moonlight', 'SUN')
sun.energy = 0.06 if A.osm else 0.25   # 下雨的阴天：月光只剩一点点
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
sky = n.ramp(t, [(0.0, HORIZON), (0.05, '#2c2350'), (0.25, '#10163a'), (1.0, '#04060f')]) if not A.osm else \
    n.ramp(t, [(0.0, '#454a55'), (0.12, '#30343e'), (0.5, '#1d2028'), (1.0, '#14161c')])
vor = n.new('ShaderNodeTexVoronoi', {'Scale': 260.0})
n.put(vor.inputs['Vector'], dirv)
star = n.math('MULTIPLY', n.math('LESS_THAN', vor.outputs['Distance'], 0.09), n.math('GREATER_THAN', n.xyz(vor.outputs['Color'])[0], 0.86))
star = n.math('MULTIPLY', star, n.new('ShaderNodeMapRange', {'Value': z, 'From Min': 0.1, 'From Max': 0.4}).outputs[0])
sky = n.vec('ADD', sky, n.vec('SCALE', (1.0, 0.97, 0.9), scale=n.math('MULTIPLY', star, 1.6)))
halo = n.new('ShaderNodeMapRange', {'Value': n.vec('DOT_PRODUCT', dirv, tuple(moon_dir)), 'From Min': 0.992, 'From Max': 1.0}).outputs[0]
sky = n.vec('ADD', sky, n.vec('SCALE', srgb('#8f9ad0'), scale=n.math('MULTIPLY', n.math('POWER', halo, 4.0), 0.3)))
bg = n.new('ShaderNodeBackground', {'Strength': 1.4 if A.osm else 1.0})
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
    win, on, wn, roof, v, bid, P = windows(n)
    if ATLAS:   # 照片墙面：照片里亮的地方就是"亮着的窗"
        _, lum = photo_wall(n, P, bid)
        use = n.math('MULTIPLY', n.math('MULTIPLY', P['wall'], n.math('SUBTRACT', 1.0, P['gf'])),
                     n.math('LESS_THAN', P['pz'], n.math('SUBTRACT', P['top'], 1.0)))
        use = n.math('GREATER_THAN', n.math('MULTIPLY', use, photo_far(n)), 0.5)
        on = n.math('ADD', on, n.math('MULTIPLY', n.math('SUBTRACT', n.math('GREATER_THAN', lum, 0.12), on), use))
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


def strip_png_text(path):
    """Cycles 会把采样数、渲染用时写进 PNG 的文字块（tEXt / eXIf…）：去掉（公开仓库的图片里不留本机信息，audit:public 也查这个）。"""
    import struct
    d = open(path, 'rb').read()
    out, pos = [d[:8]], 8
    while pos + 12 <= len(d):
        n = struct.unpack_from('>I', d, pos)[0]
        if d[pos + 4:pos + 8] not in (b'tEXt', b'zTXt', b'iTXt', b'eXIf'):
            out.append(d[pos:pos + n + 12])
        pos += n + 12
    open(path, 'wb').write(b''.join(out))


def load_float(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def save_raw(arr, path, fmt, quality=86):
    """显示值（0…1）直接存成 8 位图（不再过 Blender 的色彩管理）。"""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(arr, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    img.save(quality=quality)
    bpy.data.images.remove(img)


def render_photo(path, clip, size, samples, near=False):
    """渲 EXR（线性、高动态范围）→ postfx.photo（光晕 + AgX）→ WebP。近景层：光晕少一点、再轻轻锐化（近处清楚、远处柔）。"""
    import postfx
    tmp = os.path.join(OUTD, '.tmp_' + os.path.basename(path) + '.exr')
    render(tmp, 'OPEN_EXR', clip, True, size, samples)
    out = postfx.photo(load_float(tmp), size[0] / (PANO['lon'][1] - PANO['lon'][0]), exposure=A.expo,
                       bloom=0.08 if near else 0.14, sharpen=0.45 if near else 0.0)
    os.remove(tmp)
    save_raw(out, path, 'WEBP')


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
    for mesh in MESHES:
        for i, m in enumerate(mesh.materials):
            mesh.materials[i] = (DATA_MATS if data else MATS)[MATS.index(m) if m in MATS else DATA_MATS.index(m)]
    s = scene.render.image_settings
    s.file_format = fmt
    s.color_mode = 'RGBA' if transparent else 'RGB'
    s.color_depth = '16' if fmt == 'OPEN_EXR' else '8'
    s.quality = 86
    s.compression = 90
    scene.render.filepath = path
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    if fmt == 'PNG':
        strip_png_text(path)
    print(f'[render] {os.path.basename(path)} {size[0]}×{size[1]}: {time.time() - t0:.1f}s')


if A.look:
    import postfx
    moon.hide_render = True
    cam_data.type, cam_data.sensor_fit = 'PERSP', 'HORIZONTAL'
    cam_data.angle = math.radians(A.look_fov)
    cam.rotation_euler = (math.pi / 2 + math.radians(A.look_pitch), 0, -math.radians(A.look_yaw))
    LW, LH = 1600, 1200
    tmp = A.look + '.exr'
    render(tmp, 'OPEN_EXR', (0.5, 20000), True, (LW, LH), A.samples)
    out = postfx.photo(load_float(tmp), LW / A.look_fov, exposure=A.expo)
    os.remove(tmp)
    # 垫上网页里那样的天空：地平线是雾色，往上变暗
    vf = math.degrees(2 * math.atan(math.tan(math.radians(A.look_fov) / 2) * LH / LW))
    lat = A.look_pitch + (np.arange(LH) + 0.5 - LH / 2) / LH * vf
    t = np.clip((np.radians(lat) + 0.02) / 0.62, 0, 1)[:, None]
    hz = np.array(srgb(URBAN_HAZE)[:3], np.float32)
    skyl = hz * np.where(t < 0.05, 1 - 0.28 * t / 0.05, np.where(t < 0.25, 0.72 - 0.3 * (t - 0.05) / 0.2, 0.42 - 0.17 * (t - 0.25) / 0.75))
    skyd = postfx.agx(skyl[:, None, :] * np.ones((1, LW, 1), np.float32), A.expo)
    a = out[..., 3:4]
    save_raw(np.concatenate([out[..., :3] * a + skyd * (1 - a), np.ones_like(a)], -1), A.look, 'PNG')
    print('[look]', A.look)
    sys.exit(0)

formats = bpy.types.ImageFormatSettings.bl_rna.properties['file_format'].enum_items.keys()
assert 'WEBP' in formats, '这个 Blender 存不了 WebP'
split = VIEW['split']
# 全景两层（天空、月亮不渲染：网页里画）
moon.hide_render = True
size = pano_camera()
dsize = (size[0] // 2, size[1] // 2)
if A.osm:
    nsize = (round(size[0] * A.near_scale), round(size[1] * A.near_scale))     # 近景层分辨率高一些：近处的窗、招牌更清楚
    render_photo(os.path.join(OUTD, 'view_far.webp'), (split, 20000), size, A.samples)
    render_photo(os.path.join(OUTD, 'view_near.webp'), (0.5, split), nsize, A.samples, near=True)
else:
    render(os.path.join(OUTD, 'view_far.webp'), 'WEBP', (split, 20000), True, size, A.samples)
    render(os.path.join(OUTD, 'view_near.webp'), 'WEBP', (0.5, split), True, size, A.samples)
render(os.path.join(OUTD, 'view_far_data.png'), 'PNG', (split, 20000), False, dsize, 1, data=True)
render(os.path.join(OUTD, 'view_near_data.png'), 'PNG', (0.5, split), False,
       (nsize[0] // 2, nsize[1] // 2) if A.osm else dsize, 1, data=True)
# 平面一张带天空和月亮的：烘焙房间时当作窗外的光源
moon.hide_render = False
render(os.path.join(OUTD, 'view_full.jpg'), 'JPEG', (0.5, 20000), False, flat_camera(), A.flat_samples)

VIEW_VENDOR = []
if A.osm:
    VIEW_VENDOR.append('data/openstreetmap')
if PL is not None:
    VIEW_VENDOR.append('data/plateau-minato-2023')
if ATLAS:
    VIEW_VENDOR += ['commons/' + s_ for s_ in dict.fromkeys(sw['src'] for sw in _sw)]
if SIGNS:
    VIEW_VENDOR.append('font/noto-sans-cjk')
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
        # 网页里的天空：真实的东京（--osm）是下雨的城市夜空——低云压满、没有银河；程序生成的城市是原来的星空
        **({'sky': {'cover': 0.93, 'urban': 1, 'horizon': [round(c, 4) for c in srgb(URBAN_HAZE)[:3]]}} if A.osm else {}),
        # 用到的数据和素材（assets/vendor/credits.json 里的 id；网站的素材致谢按它和房间的 manifest.vendor 一起生成）
        'vendor': VIEW_VENDOR,
    }, f, indent=2)
print('[done]', OUTD)
