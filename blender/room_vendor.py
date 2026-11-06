# 办公室场景专用：导入第三方模型（Sketchfab 的 glb、Poly Haven 的 gltf），整理成能和房间一起烘焙光照的网格。
# 只给 bake_room.py 用；塔楼有自己的一套（bake_tower.py），两边互不引用。
#
# 整理的内容：
#   - 每个子物件把世界变换乘进顶点，只留颜色贴图用的那套 UV（改名 UVMap），去掉顶点色
#   - 材质只留颜色贴图（缩小），金属度 0、粗糙度 0.8、不透明、不发光；名字加前缀，免得和房间的材质重名
#     例外：cutout 里的材质（植物的叶片卡片）保留贴图的透明通道，烘焙时光能从镂空处漏过去，网页里镂空的地方不画
#   - 可选：按名字丢掉子物件、按比例减面、按包围盒删掉 / 换色某些"连在一起的面"（屏幕玻璃、灯泡）
# 坐标：参数和返回值都是 three.js 的写法（Y 向上，米）；Blender 里是 Z 向上，用 C / CI 换算。
import os
from fnmatch import fnmatch

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from shared import ROOT, srgb, tree

C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))  # three (x, y, z) → Blender (x, -z, y)
CI = C.inverted()


def principled(mt):
    return next((n for n in mt.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mt and mt.node_tree else None


def base_texture(mt):
    """顺着 Base Color 往上游找第一张贴图（中间可能隔着 glTF 导入器加的乘色节点）。"""
    b = principled(mt)
    if b is None:
        return None
    todo, seen = [b.inputs['Base Color']], set()
    while todo:
        sock = todo.pop()
        for link in sock.links:
            n = link.from_node
            if n.name in seen:
                continue
            seen.add(n.name)
            if n.type == 'TEX_IMAGE' and n.image:
                return n
            todo.extend(s for s in n.inputs if s.is_linked)
    return None


def uv_name_for(mt, me):
    """颜色贴图读的是哪套 UV（UV Map 节点指定的那套，没指定就是渲染用的那套）。"""
    tex = base_texture(mt)
    if tex and tex.inputs['Vector'].is_linked:
        n = tex.inputs['Vector'].links[0].from_node
        if n.type == 'UVMAP' and n.uv_map in me.uv_layers:
            return n.uv_map
    for layer in me.uv_layers:
        if layer.active_render:
            return layer.name
    return me.uv_layers[0].name if me.uv_layers else None


def fix_material(mt, name, size, cutout=False):
    """烘焙和网页只需要颜色：保留颜色贴图（缩到 size），其它贴图、金属度、透明、发光都去掉。
    cutout：颜色贴图的透明通道接到 Alpha（叶片卡片）；glTF 导出器看到 Alpha 接了贴图，会把这张图存成带透明的 PNG。"""
    mt.name = name
    nt = mt.node_tree
    b = principled(mt)
    if b is None:
        return
    tex = base_texture(mt)
    for s in b.inputs:
        for link in list(s.links):
            nt.links.remove(link)
    b.inputs['Metallic'].default_value = 0.0
    b.inputs['Roughness'].default_value = 0.8
    b.inputs['Transmission Weight'].default_value = 0.0
    b.inputs['Emission Strength'].default_value = 0.0
    b.inputs['Alpha'].default_value = 1.0
    if tex:
        uvn = nt.nodes.new('ShaderNodeUVMap')
        uvn.uv_map = 'UVMap'
        nt.links.new(uvn.outputs[0], tex.inputs['Vector'])
        nt.links.new(tex.outputs['Color'], b.inputs['Base Color'])
        if cutout:
            nt.links.new(tex.outputs['Alpha'], b.inputs['Alpha'])
        b.inputs['Base Color'].default_value = (1, 1, 1, 1)
        img = tex.image
        if max(img.size) > size:
            img.scale(size, size)
    keep = {b.name, tex.name if tex else None}
    for n in list(nt.nodes):
        if n.type == 'OUTPUT_MATERIAL' or n.name in keep or n.type == 'UVMAP':
            continue
        nt.nodes.remove(n)
    for n in list(nt.nodes):  # 多余的 UV Map 节点（贴图删掉以后悬空的）
        if n.type == 'UVMAP' and not n.outputs[0].is_linked:
            nt.nodes.remove(n)
    out = next(n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL')
    if not out.inputs['Surface'].is_linked:
        nt.links.new(b.outputs[0], out.inputs['Surface'])
    mt.surface_render_method = 'DITHERED'


def plain_material(name, color):
    mt = bpy.data.materials.new(name)
    tree(mt)
    b = principled(mt)
    b.inputs['Base Color'].default_value = (*srgb(color), 1)
    b.inputs['Roughness'].default_value = 0.8
    b.inputs['Metallic'].default_value = 0.0
    mt.diffuse_color = (*srgb(color), 1)
    return mt


def tri_count(me):
    return sum(len(p.vertices) - 2 for p in me.polygons)


def _co3(me):
    a = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', a)
    a = a.reshape(-1, 3)
    return np.stack([a[:, 0], a[:, 2], -a[:, 1]], axis=1)  # Blender → three


def _islands(bm):
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, isl = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(isl)
    return out


class Asset:
    """一个素材文件。pieces：子物件名 → 网格（Blender 坐标，素材自己的原点和单位）。"""

    def __init__(self, source, prefix, texsize=512, drop=(), decimate=None, cutout=()):
        self.source, self.prefix = source, prefix
        path = asset_path(source)
        before, mats_before = set(bpy.data.objects), set(bpy.data.materials)
        imgs_before = set(bpy.data.images)
        bpy.ops.import_scene.gltf(filepath=path)
        new = [o for o in bpy.data.objects if o not in before]
        self.pieces, self.alias = {}, {}  # alias：子物件 → 原来的材质名（有的素材子物件名字没意义，按材质名认）
        for o in new:
            mname = o.data.materials[0].name if o.type == 'MESH' and o.data.materials and o.data.materials[0] else ''
            if o.type != 'MESH' or any(fnmatch(o.name, p) or fnmatch(mname, p) for p in drop):
                continue
            self.alias[o.name] = mname
            me = o.data.copy()
            me.transform(o.matrix_world)
            keep = uv_name_for(me.materials[0] if me.materials else None, me)
            for layer in [l.name for l in me.uv_layers if l.name != keep]:
                me.uv_layers.remove(me.uv_layers[layer])
            if me.uv_layers:
                me.uv_layers[0].name = 'UVMap'
            for a in [a.name for a in me.color_attributes]:
                me.color_attributes.remove(me.color_attributes[a])
            self.pieces[o.name] = me
        for o in new:
            bpy.data.objects.remove(o)
        self.tris0 = sum(tri_count(me) for me in self.pieces.values())
        for pat, ratio in (decimate or {}).items():
            for name in self.names([pat]):
                self.pieces[name] = self._decimate(self.pieces[name], ratio)
        used = {m for me in self.pieces.values() for m in me.materials if m}
        self.mat = {}  # 原来的材质名 → 新名字
        for i, mt in enumerate(sorted(set(bpy.data.materials) - mats_before, key=lambda m: m.name)):
            if mt in used:
                old = mt.name
                fix_material(mt, f'{prefix}.{i}', texsize, cutout=any(fnmatch(old, p) for p in cutout))
                self.mat[old] = mt.name
        self.cutout = [new for old, new in self.mat.items() if any(fnmatch(old, p) for p in cutout)]  # 写进 manifest.cutout
        if cutout and not self.cutout:
            raise SystemExit(f'[vendor] {prefix}: 没有材质匹配 cutout={cutout}（有 {list(self.mat)}）')
        for img in set(bpy.data.images) - imgs_before:  # 没被留下来的材质用到的贴图：删掉，免得导出时带上
            if img.users == 0:
                bpy.data.images.remove(img)
        print(f'[vendor] {prefix}: {self.tris0} → {self.tris} tris, {len(self.pieces)} pieces '
              f'({", ".join(self.pieces)[:120]})')

    @property
    def tris(self):
        return sum(tri_count(me) for me in self.pieces.values())

    @staticmethod
    def _decimate(me, ratio):
        ob = bpy.data.objects.new('_dec', me)
        bpy.context.scene.collection.objects.link(ob)
        mod = ob.modifiers.new('dec', 'DECIMATE')
        mod.ratio = ratio
        dg = bpy.context.evaluated_depsgraph_get()
        out = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        bpy.data.objects.remove(ob)
        return out

    def names(self, pieces=None):
        return [n for n in self.pieces if pieces is None or any(fnmatch(n, p) or fnmatch(self.alias[n], p) for p in pieces)]

    def islands(self, piece, lo, hi, material=None, delete=False):
        """子物件 piece 里，包围盒整个落在 [lo, hi]（素材自己的 three 坐标）里的"连在一起的面"：
        delete=True 删掉；给了 material 就换成这个材质。返回这些面的顶点（素材坐标，three），拿来量屏幕弧度、灯泡位置。"""
        lo, hi = np.array(lo), np.array(hi)
        pts = []
        for name in self.names([piece]):
            me = self.pieces[name]
            bm = bmesh.new()
            bm.from_mesh(me)
            hit = []
            for isl in _islands(bm):
                co = np.array([(v.co.x, v.co.z, -v.co.y) for f in isl for v in f.verts])
                if (co.min(0) >= lo).all() and (co.max(0) <= hi).all():
                    hit.extend(isl)
                    pts.extend(map(tuple, co))
            if delete:
                bmesh.ops.delete(bm, geom=hit, context='FACES')
            elif material is not None:
                if material not in list(me.materials):
                    me.materials.append(material)
                mi = list(me.materials).index(material)
                for f in hit:
                    f.material_index = mi
            bm.to_mesh(me)
            bm.free()
        if not pts:
            raise SystemExit(f'[vendor] {self.prefix}/{piece}: 在 {lo}..{hi} 里没找到面')
        return np.unique(np.array(pts), axis=0)

    def drop_faces(self, material):
        """删掉用了某个材质（原来的名字）的面，比如画框的玻璃。"""
        mt = bpy.data.materials.get(self.mat.get(material, ''))
        if mt is None:
            raise SystemExit(f'[vendor] {self.prefix}: 没有材质 {material}（有 {list(self.mat)}）')
        n = 0
        for me in self.pieces.values():
            if mt.name not in me.materials:
                continue
            mi = list(me.materials).index(mt)
            bm = bmesh.new()
            bm.from_mesh(me)
            hit = [f for f in bm.faces if f.material_index == mi]
            n += len(hit)
            bmesh.ops.delete(bm, geom=hit, context='FACES')
            bm.to_mesh(me)
            bm.free()
            me.materials.pop(index=mi)  # 后面的材质编号会自动往前挪
        print(f'[vendor] {self.prefix}: 删掉 {material} 的 {n} 个面')

    def bounds(self, pieces=None):
        co = np.concatenate([_co3(self.pieces[n]) for n in self.names(pieces)])
        return co.min(0), co.max(0)

    def place(self, at, pieces=None, scale=None, height=None, width=None, anchor=(0.5, 0.0, 0.5), material=None):
        """把（名字匹配 pieces 的）子物件摆好。at：three 坐标的矩阵（位置 + 朝向）；
        anchor：包围盒上哪一点对准 at 的原点（默认底面中心）；scale / height / width（素材 x 方向）三选一；
        material：所有面换成这个材质（不要贴图时用）。返回 (物件列表, T)，T 把素材坐标（three）换成世界坐标（three）。"""
        names = self.names(pieces)
        lo, hi = self.bounds(pieces)
        size = hi - lo
        s = scale or (height / size[1] if height else width / size[0] if width else 1.0)
        origin = Vector(lo + size * np.array(anchor))
        T = at @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation(-origin)
        mx = C @ T @ CI
        obs = []
        for n in names:
            me = self.pieces[n].copy()
            me.transform(mx)
            if material is not None:
                me.materials.clear()
                me.materials.append(material)
            ob = bpy.data.objects.new(f'{self.prefix}:{n}', me)
            bpy.context.scene.collection.objects.link(ob)
            obs.append(ob)
        return obs, T


def world_points(obs):
    """物件的顶点（世界坐标，three）。"""
    return np.concatenate([_co3(o.data) for o in obs])


def screen_grid(obs, material, frac=0.9, nx=16, ny=12, rot=0.0):
    """显像管玻璃（obs 里材质是 material 的面，摆好以后朝 +z 绕 Y 轴转 rot 的方向）→ 贴在上面的 4:3 画面：
    宽 = 玻璃宽度 × frac，中心 = 玻璃中心；在 (nx+1)×(ny+1) 个点上从正前方打射线量玻璃的深度。
    返回 pos（画面中心，在玻璃上，世界坐标）、size、grid、depth（沿屏幕自己的 z，相对 pos，按 three 的 PlaneGeometry 顶点顺序：
    从上往下一行行，每行从左到右）、normal（中心的法线，世界坐标，给屏幕光源和镜头用）、rot（浏览器把平面绕 Y 轴转这么多）。"""
    from mathutils.bvhtree import BVHTree
    R = Matrix.Rotation(rot, 3, 'Y')  # three 的绕 Y 转 rot（+z → (sin, 0, cos)）；先转回正对 +z 再量
    Ri = R.inverted()
    verts, polys = [], []
    for ob in obs:
        me = ob.data
        idx = {i for i, m in enumerate(me.materials) if m == material}
        base = len(verts)
        verts.extend(Ri @ Vector((v.co.x, v.co.z, -v.co.y)) for v in me.vertices)  # Blender → three → 屏幕自己的坐标
        polys.extend([base + k for k in p.vertices] for p in me.polygons if p.material_index in idx)
    used = np.array([tuple(verts[k]) for poly in polys for k in poly])
    if not len(used):
        raise SystemExit(f'[vendor] 没找到材质 {material.name} 的面')
    lo, hi = used.min(0), used.max(0)
    w = (hi[0] - lo[0]) * frac
    h = w * 0.75
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    bvh = BVHTree.FromPolygons(verts, polys)
    zs = np.full((ny + 1, nx + 1), np.nan)
    for j in range(ny + 1):
        for i in range(nx + 1):
            x, y = cx + (i / nx - 0.5) * w, cy + (0.5 - j / ny) * h
            hit = bvh.ray_cast(Vector((x, y, hi[2] + 1)), Vector((0, 0, -1)))[0]
            if hit is not None:
                zs[j, i] = hit.z
    miss = int(np.isnan(zs).sum())
    for j in range(ny + 1):  # 打空的点（理论上不会有）：用同一行最近的点补上
        row = zs[j]
        ok = ~np.isnan(row)
        if ok.any() and not ok.all():
            row[~ok] = np.interp(np.flatnonzero(~ok), np.flatnonzero(ok), row[ok])
    z0 = float(zs[ny // 2, nx // 2])
    dzdx = (zs[ny // 2, nx // 2 + 1] - zs[ny // 2, nx // 2 - 1]) / (2 * w / nx)
    dzdy = (zs[ny // 2 - 1, nx // 2] - zs[ny // 2 + 1, nx // 2]) / (2 * h / ny)
    normal = R @ Vector((-dzdx, -dzdy, 1)).normalized()
    pos = R @ Vector((float(cx), float(cy), z0))
    return dict(pos=tuple(pos), size=(float(w), float(h)), grid=(nx, ny), rot=float(rot),
                depth=[float(z - z0) for z in zs.ravel()], normal=tuple(normal), glass=(float(hi[0] - lo[0]), float(hi[1] - lo[1])),
                miss=miss, sag=float(z0 - np.nanmin(zs)))


def asset_path(source):
    """'sketchfab/<slug>' 或 'polyhaven/<id>'（和 assets/vendor/credits.json 里的 id 一样）→ vendor-src 里的文件。"""
    kind, slug = source.split('/')
    if kind == 'sketchfab':
        return os.path.join(ROOT, 'vendor-src', 'sketchfab', slug, f'{slug}.glb')
    return os.path.join(ROOT, 'vendor-src', 'polyhaven', slug, f'{slug}_1k.gltf')
