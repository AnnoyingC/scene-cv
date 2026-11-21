# 窗外近处的招牌：东京的街上，楼侧面伸出来的竖招牌（袖看板）和楼顶的横招牌。这里用 Blender 自带的开源字体
# Noto Sans CJK（SIL OFL）把一批常见的、不是任何品牌的字（居酒屋、歯科、薬局、駐車場……）画成内透光的灯箱，拼成一张图集，
# 给 render_view.py（--signs）挂到镜头附近的商业楼、低层楼上。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/sign_atlas.py -- --out vendor-src/signs
#
# 产物：signs.png（sRGB）、signs.json（每块在图集里的位置、竖的还是横的）。
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import get_args, srgb  # noqa: E402

A = get_args(out='vendor-src/signs')
FONT = os.path.join(os.path.dirname(bpy.app.binary_path), '..', 'Resources', '%d.%d' % bpy.app.version[:2], 'datafiles', 'fonts',
                    'Noto Sans CJK Regular.woff2')

# 底色、字色（灯箱：白、黄的底最亮；红、蓝、绿、黑底的字亮）
COLORS = {
    'red': ('#c8102e', '#fff8ee'), 'white': ('#f4f1e8', '#c8102e'), 'whiteb': ('#f4f1e8', '#1d2a6b'), 'yellow': ('#f5c400', '#161616'),
    'blue': ('#1f4fa0', '#ffffff'), 'green': ('#1b7f3b', '#ffffff'), 'black': ('#141414', '#f5c400'), 'orange': ('#e8620e', '#ffffff'),
    'blackw': ('#141414', '#f4f1e8'),
}
VERTICAL = [('居酒屋', 'red'), ('焼肉', 'black'), ('寿司', 'white'), ('歯科', 'whiteb'), ('薬局', 'green'), ('不動産', 'blue'),
            ('カラオケ', 'orange'), ('中華', 'red'), ('珈琲', 'blackw'), ('美容室', 'white'), ('整骨院', 'whiteb'), ('喫茶', 'yellow'),
            ('蕎麦', 'blackw'), ('酒場', 'red'), ('学習塾', 'blue'), ('眼科', 'whiteb'), ('内科', 'green'), ('定食', 'yellow'),
            ('鍼灸', 'white'), ('ホテル', 'black')]
HORIZONTAL = [('駐車場', 'blue'), ('BAR', 'black'), ('24H', 'red'), ('ラーメン', 'yellow'), ('クリニック', 'whiteb'), ('英会話', 'orange'),
              ('CAFE', 'blackw'), ('HOTEL', 'white')]
VW, VH = 72, 256        # 竖招牌（宽 : 高 ≈ 1 : 3.5）
HW, HH = 256, 64        # 横招牌（4 : 1）

scene = bpy.context.scene
for ob in list(scene.objects):
    bpy.data.objects.remove(ob)
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.light = 'FLAT'
scene.display.shading.color_type = 'OBJECT'
scene.display.render_aa = '16'
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.render.film_transparent = False
scene.world = bpy.data.worlds.new('w')
for k in dir(scene.render):
    if k.startswith('use_stamp'):
        setattr(scene.render, k, False)
font = bpy.data.fonts.load(os.path.abspath(FONT))
cam_data = bpy.data.cameras.new('c')
cam_data.type = 'ORTHO'
cam = bpy.data.objects.new('c', cam_data)
cam.location = (0, 0, 10)
scene.collection.objects.link(cam)
scene.camera = cam
bg_me = bpy.data.meshes.new('bg')
bg_me.from_pydata([(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)], [], [(0, 1, 2, 3)])
bg = bpy.data.objects.new('bg', bg_me)
scene.collection.objects.link(bg)
cu = bpy.data.curves.new('t', 'FONT')
cu.font = font
cu.align_x, cu.align_y = 'CENTER', 'CENTER'
txt = bpy.data.objects.new('t', cu)
txt.location.z = 0.01
scene.collection.objects.link(txt)
os.makedirs(A.out, exist_ok=True)
tmp = os.path.join(A.out, '_tmp.png')


def render_sign(text, color, vertical):
    w, h = (VW, VH) if vertical else (HW, HH)
    aspect = h / w
    bgc, fgc = COLORS[color]
    bg.scale = (1.0, aspect, 1.0)
    bg.color = (*srgb(bgc), 1.0)
    txt.color = (*srgb(fgc), 1.0)
    cu.body = '\n'.join(text) if vertical else text
    cu.space_line = 0.92
    # 字的大小：先按 1 量出来，再缩到招牌里（四周留一点边）
    cu.size = 1.0
    bpy.context.view_layer.update()
    dims = txt.dimensions
    k = min(0.78 / max(dims.x, 1e-3), aspect * 0.86 / max(dims.y, 1e-3))
    cu.size = k
    bpy.context.view_layer.update()
    cam_data.ortho_scale = max(1.0, aspect)
    scene.render.resolution_x, scene.render.resolution_y = w, h
    scene.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(tmp)
    px = list(img.pixels)
    bpy.data.images.remove(img)
    return w, h, px


signs, tiles = [], []
for items, vertical in ((VERTICAL, True), (HORIZONTAL, False)):
    for text, color in items:
        w, h, px = render_sign(text, color, vertical)
        tiles.append((w, h, px))
        signs.append(dict(text=text, color=color, vertical=vertical))
os.remove(tmp)
# 拼图集：竖的一排、横的一排
S_W = max(len(VERTICAL) * (VW + 2), 4 * (HW + 2))
S_H = VH + 2 + ((len(HORIZONTAL) + 3) // 4) * (HH + 2)
atlas = [0.0] * (S_W * S_H * 4)
x = y = 0
for i, (w, h, px) in enumerate(tiles):
    if signs[i]['vertical']:
        ox, oy = i * (VW + 2), 0
    else:
        j = i - len(VERTICAL)
        ox, oy = (j % 4) * (HW + 2), VH + 2 + (j // 4) * (HH + 2)
    for r in range(h):                       # Blender 的像素从下往上：图集里第 oy 行（从上数）= 底下数 S_H - 1 - oy
        dst_row = S_H - 1 - (oy + (h - 1 - r))
        s0 = r * w * 4
        d0 = (dst_row * S_W + ox) * 4
        atlas[d0:d0 + w * 4] = px[s0:s0 + w * 4]
    signs[i]['rect'] = [ox / S_W, 1 - (oy + h) / S_H, w / S_W, h / S_H]   # 归一化，y 从下往上（Blender 的 UV）
img = bpy.data.images.new('signs', S_W, S_H, alpha=False)
img.pixels.foreach_set(atlas)
img.filepath_raw = os.path.abspath(os.path.join(A.out, 'signs.png'))
img.file_format = 'PNG'
img.save()
json.dump({'size': [S_W, S_H], 'signs': signs, 'font': 'Noto Sans CJK (SIL Open Font License 1.1), bundled with Blender'},
          open(os.path.join(A.out, 'signs.json'), 'w'), ensure_ascii=False, indent=1)
print(f'[signs] {len(signs)} 块 → {A.out}（{S_W}×{S_H}）')
