# 答录机的干净外壳：Sketchfab 那台 AT&T 答录机是照片扫描（aefj1032，CC BY），表面一层层鼓包、底边破碎，
# 放在干净的电脑旁边像一团皱纸。这里按扫描量出来的尺寸重新搭一个规整的外壳（上壳 + 往里收的底座，圆角、上沿小倒角，
# 按键那头往前斜 15°），再用 Cycles 把扫描的颜色（按键、字、AT&T 标、喇叭格栅）烤到新外壳上。
#
#   /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/answering_prep.py
#
# 读 vendor-src/sketchfab/answering-machine/answering-machine.glb（下载的原文件，不改）
# 写 answering-machine-clean.glb（bake_room.py 用这份）和 answering-machine-clean.json（小灯在素材坐标里的位置）。
# 坐标和单位都和扫描一样（Blender，Z 向上，按键那头朝 -X，单位随意：宽 0.786 = 真实 16 厘米）。
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared import ROOT  # noqa: E402

DIR = os.path.join(ROOT, 'vendor-src', 'sketchfab', 'answering-machine')
SRC = os.path.join(DIR, 'answering-machine.glb')
OUT = os.path.join(DIR, 'answering-machine-clean.glb')
TEX = 2048

# 量出来的形状（扫描坐标）：上壳 x -0.536..0.534、y ±0.391、圆角 0.05；底座往里收：x -0.495..0.485、y ±0.347
# 上沿高度沿 x：前沿 0.183，往后斜到 x = -0.21 变成平的 0.271（按键面和盖子的分界）
SHELL = dict(x=(-0.536, 0.534), y=0.391, r=0.05, z0=0.105)
BASE = dict(x=(-0.495, 0.485), y=0.347, r=0.03, z0=0.0, z1=0.104)
FRONT_Z, FLAT_Z, KINK_X = 0.183, 0.271, -0.21
LED = (-0.360, -0.196)  # MESSAGES 键旁边那条小灯（扫描坐标 x, y）


def top_z(x):
    if x >= KINK_X:
        return FLAT_Z
    return FRONT_Z + (FLAT_Z - FRONT_Z) * (x - SHELL['x'][0]) / (KINK_X - SHELL['x'][0])


def rounded_box(bm, x0, x1, hy, r, z0, z1, cuts=()):
    """圆角长方体：竖着的四条边倒成半径 r 的圆角；cuts：在这些 x 处横着切一刀（上面按 top_z 抬高时，每段都是平面）。"""
    geom = bmesh.ops.create_cube(bm, size=1.0)['verts']
    for v in geom:
        v.co = Vector(((x0 + x1) / 2 + v.co.x * (x1 - x0), v.co.y * 2 * hy, z0 + (v.co.z + 0.5) * (z1 - z0)))
    vert_edges = [e for e in bm.edges if e.verts[0] in geom and e.verts[1] in geom
                  and abs(e.verts[0].co.z - e.verts[1].co.z) > 1e-6]
    bmesh.ops.bevel(bm, geom=vert_edges, offset=r, segments=6, affect='EDGES', profile=0.5)
    for cx in cuts:
        g = list(bm.verts) + list(bm.edges) + list(bm.faces)
        bmesh.ops.bisect_plane(bm, geom=g, plane_co=(cx, 0, 0), plane_no=(1, 0, 0))


RIM = 0.01  # 上沿倒角（扫描单位：约 2 毫米）


def self_intersections(bm):
    """互相穿过去的面有几对（共用顶点的相邻面不算）。"""
    from mathutils.bvhtree import BVHTree
    bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    bad = [(a, b) for a, b in tree.overlap(tree) if a < b and not set(bm.faces[a].verts) & set(bm.faces[b].verts)]
    for a, b in bad[:6]:
        print('[answering_prep] 穿模', *(tuple(round(c, 3) for c in bm.faces[i].calc_center_median()) for i in (a, b)))
    return len(bad)


def build():
    """上壳和底座分开搭（切上壳的刀不能切到底座：切出来的底座顶点会被当成上壳的顶，一起抬到盖子的高度，从盖子里戳出来），最后合成一个网格。"""
    # 上壳：先做成平顶，横着切几刀，再把顶上的点按 top_z 放下来
    sb = bmesh.new()
    cuts = [SHELL['x'][0] + (KINK_X - SHELL['x'][0]) * k / 4 for k in range(1, 4)] + [KINK_X]
    rounded_box(sb, *SHELL['x'], SHELL['y'], SHELL['r'], SHELL['z0'], FLAT_Z, cuts)
    for v in sb.verts:
        if v.co.z > SHELL['z0'] + 1e-4:
            v.co.z = top_z(v.co.x)
    # 上沿一圈小倒角：顶面和侧面之间的边。圆角那里一条条边很短（比倒角宽度还短）：不夹住的话倒出来的面会叠在一起
    sb.normal_update()
    rim = [e for e in sb.edges if len(e.link_faces) == 2 and sum(1 for f in e.link_faces if f.normal.z > 0.7) == 1
           and min(v.co.z for v in e.verts) > SHELL['z0'] + 0.01]
    bmesh.ops.bevel(sb, geom=rim, offset=RIM, segments=3, affect='EDGES', profile=0.5, clamp_overlap=True)
    # 底座：顶面比上壳的底面低一点点，两块不碰在一起
    bb = bmesh.new()
    rounded_box(bb, *BASE['x'], BASE['y'], BASE['r'], BASE['z0'], BASE['z1'])
    me = bpy.data.meshes.new('answering_clean')
    tmp = bpy.data.meshes.new('_part')
    bm = bmesh.new()
    for part in (sb, bb):
        bmesh.ops.triangulate(part, faces=[f for f in part.faces if len(f.verts) > 4])
        part.to_mesh(tmp)
        bm.from_mesh(tmp)
        part.free()
    bpy.data.meshes.remove(tmp)
    bad = self_intersections(bm)
    if bad:
        raise SystemExit(f'[answering_prep] 外壳有 {bad} 对面互相穿过去')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('answering_clean', me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
    scan = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
    clean = build()
    # 展 UV
    bpy.context.view_layer.objects.active = clean
    for o in bpy.context.scene.objects:
        o.select_set(o == clean)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(50), island_margin=0.01)
    bpy.ops.object.mode_set(mode='OBJECT')
    # 新贴图 + 材质（贴图节点设为当前的：烘焙写到它上面）
    img = bpy.data.images.new('answering_clean', TEX, TEX)
    mt = bpy.data.materials.new('answering_clean')
    nt = mt.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.6
    nt.nodes.active = tex  # 烤完再把贴图接到颜色上：烤的时候接着会"自己读自己"，烤出来全黑
    clean.data.materials.append(mt)
    # 扫描的材质换成"发光 = 颜色贴图"，烤 EMIT 拿到的就是原样的颜色（原材质是不受光的扫描材质，烤 DIFFUSE 是全黑）
    smt = scan.data.materials[0]
    simg = next(n.image for n in smt.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image)
    snt = smt.node_tree
    snt.nodes.clear()
    st = snt.nodes.new('ShaderNodeTexImage')
    st.image = simg
    em = snt.nodes.new('ShaderNodeEmission')
    so = snt.nodes.new('ShaderNodeOutputMaterial')
    snt.links.new(st.outputs['Color'], em.inputs['Color'])
    snt.links.new(em.outputs[0], so.inputs['Surface'])
    # 从扫描烤颜色：扫描选中、新外壳是当前物件
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = 8
    sc.cycles.device = 'CPU'
    scan.select_set(True)
    clean.select_set(True)
    bpy.context.view_layer.objects.active = clean
    bk = sc.render.bake
    bk.use_selected_to_active = True
    bk.cage_extrusion = 0.03
    bk.max_ray_distance = 0.08
    bk.margin = 8
    bpy.ops.object.bake(type='EMIT')
    px = img.pixels[:]
    lit = sum(1 for i in range(0, len(px), 4 * 97) if px[i] + px[i + 1] + px[i + 2] > 0.05)
    print(f'[answering_prep] 烤到颜色的像素（抽样）：{lit} / {len(px) // (4 * 97)}')
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    img.file_format = 'JPEG'
    img.filepath_raw = os.path.join(DIR, 'answering-machine-clean.jpg')
    img.save()
    # 只导出新外壳
    for o in bpy.context.scene.objects:
        o.select_set(o == clean)
    bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB', export_image_format='JPEG')
    # 小灯：在按键面上，法线垂直于斜面；转成 three 坐标（x, z, -y）给 bake_room.py
    a = math.atan2(FLAT_Z - FRONT_Z, KINK_X - SHELL['x'][0])
    led = dict(c=[LED[0], round(top_z(LED[0]), 4), -LED[1]], n=[round(-math.sin(a), 4), round(math.cos(a), 4), 0.0],
               w=0.031, h=0.011)
    with open(os.path.join(DIR, 'answering-machine-clean.json'), 'w') as f:
        json.dump({'led': led}, f, indent=1)
    print(f'[answering_prep] {len(clean.data.polygons)} 面 → {OUT}；小灯 {led}')


main()
