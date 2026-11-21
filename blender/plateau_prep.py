# 窗外的真实城市（精细版）：把国土交通省 PLATEAU 的 3D 城市模型（CityGML）转成 render_view.py 直接能读的一个 .npz。
# 数据：「3D都市モデル（Project PLATEAU）港区（2023年度）」CityGML v4，G 空間情報センター下载（vendor-src/plateau/，不进仓库）。
# 许可：PLATEAU サイトポリシー（政府标准利用规约 2.0，兼容 CC BY 4.0）：出处写「国土交通省 Project PLATEAU」，改过要说明。
#
#   /Applications/Blender.app/Contents/Resources/5.2/python/bin/python3.13 -I blender/plateau_prep.py \
#       --gml vendor-src/plateau/udx --out vendor-src/plateau/city.npz --vp-lat 35.65671 --vp-lon 139.73688 --bearing 66 --height 70
#
# 每栋楼取最精细的、不带窗户门洞的那一级：LOD2（屋顶、墙、底面分开，有真实的屋顶形状、退台）→ 没有就 LOD1（实测高度的柱体）。
# 属性：用途（bldg:usage）→ 写字楼 / 住宅 / 商业，地上层数 → 层高（窗户按真实楼层排），实测高度。
# 坐标：视点在原点、离地 height 米；窗户朝 bearing（正北顺时针）方向转到 +Y；X 向右，Z 向上（和 osm_city.py 一样）。
# 地形：dem/ 里的 TIN 三角网（标高）重采样成 20 米一格的网格，路、路灯、OSM 补的楼都放在地形上。
import argparse
import glob
import math
import os
import re
import sys
import xml.etree.ElementTree as ET

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument('--gml', required=True, help='解压后的 udx 目录（里面有 bldg/、dem/）')
ap.add_argument('--out', required=True)
ap.add_argument('--vp-lat', type=float, default=35.65671)
ap.add_argument('--vp-lon', type=float, default=139.73688)
ap.add_argument('--bearing', type=float, default=66.0)
ap.add_argument('--height', type=float, default=70.0)
ap.add_argument('--radius', type=float, default=6000.0, help='多远以内的楼')
ap.add_argument('--fov', type=float, default=86.0, help='左右各多少度以内的楼（全景是 ±80°）')
A = ap.parse_args()

KX = 111320.0 * math.cos(math.radians(A.vp_lat))
KY = 110574.0
CB, SB = math.cos(math.radians(A.bearing)), math.sin(math.radians(A.bearing))


def project(lat, lon):
    e, n = (lon - A.vp_lon) * KX, (lat - A.vp_lat) * KY
    return e * CB - n * SB, e * SB + n * CB


def mesh_box(code):
    """日本的三次メッシュ（8 位）→ (南, 北, 西, 东) 纬度经度。二次メッシュ（6 位）也行。"""
    p, u = int(code[0:2]), int(code[2:4])
    lat, lon = p / 1.5, u + 100.0
    q, v = int(code[4]), int(code[5])
    lat += q * (5 / 60)
    lon += v * (7.5 / 60)
    if len(code) == 6:
        return lat, lat + 5 / 60, lon, lon + 7.5 / 60
    r, w = int(code[6]), int(code[7])
    lat += r * (30 / 3600)
    lon += w * (45 / 3600)
    return lat, lat + 30 / 3600, lon, lon + 45 / 3600


def box_visible(box):
    """这一格メッシュ有没有落在视野里（四个角 + 中心有一个在 radius 以内、视角以内就算）。"""
    s, nn, w, e = box
    for la, lo in ((s, w), (s, e), (nn, w), (nn, e), ((s + nn) / 2, (w + e) / 2)):
        x, y = project(la, lo)
        d = math.hypot(x, y)
        if d < 1500 or (d < A.radius + 1500 and y > -800 and abs(math.degrees(math.atan2(x, y))) < A.fov + 15):
            return True
    return False


def local(tag):
    return tag.rsplit('}', 1)[-1]


def poslist(text):
    a = np.array(text.split(), dtype=np.float64).reshape(-1, 3)   # 纬度 经度 标高
    return a


# 用途代码（PLATEAU 的 bldg:usage）→ 0 写字楼、1 住宅、2 商业 / 其他
USAGE = {'401': 0, '421': 0, '402': 2, '403': 2, '404': 2, '422': 2, '431': 2, '441': 2, '452': 2, '454': 2,
         '411': 1, '412': 1, '413': 1, '414': 1}
SURF = {'RoofSurface': 1, 'WallSurface': 0, 'GroundSurface': 2, 'OuterCeilingSurface': 1, 'OuterFloorSurface': 2, 'ClosureSurface': 0}

verts, polys, plen, pbld, ptype = [], [], [], [], []
B = dict(kind=[], fh=[], base=[], top=[], height=[], lod=[], cx=[], cy=[], storeys=[])
nv = 0
stats = dict(files=0, lod2=0, lod1=0, skipped=0)


def add_ring(ring_ll, btype):
    """一圈经纬度 → 视点坐标（z 先存标高，最后统一减去眼睛的标高）。"""
    global nv
    if len(ring_ll) > 3 and np.allclose(ring_ll[0], ring_ll[-1]):
        ring_ll = ring_ll[:-1]
    if len(ring_ll) < 3:
        return
    x, y = project(ring_ll[:, 0], ring_ll[:, 1])
    verts.append(np.stack([x, y, ring_ll[:, 2]], 1))
    k = len(ring_ll)
    polys.append(np.arange(nv, nv + k, dtype=np.int32))
    plen.append(k)
    pbld.append(len(B['kind']))
    ptype.append(btype)
    nv += k


def polygons_in(el):
    """el 下面所有 gml:Polygon 的外圈（posList）。"""
    out = []
    for poly in el.iter():
        if local(poly.tag) != 'Polygon':
            continue
        for ext in poly:
            if local(ext.tag) != 'exterior':
                continue
            for pl in ext.iter():
                if local(pl.tag) == 'posList' and pl.text:
                    out.append(poslist(pl.text))
    return out


def handle_building(b):
    attrs = {}
    for c in b.iter():
        t = local(c.tag)
        if t in ('measuredHeight', 'storeysAboveGround', 'usage') and c.text and t not in attrs:
            attrs[t] = c.text.strip()
    # 先找 LOD2 的面（boundedBy 下的 Roof / Wall / Ground…Surface → lod2MultiSurface）
    lod2 = []
    for c in b.iter():
        t = local(c.tag)
        if t in SURF:
            for ms in c:
                if local(ms.tag) == 'lod2MultiSurface':
                    lod2.extend((r, SURF[t]) for r in polygons_in(ms))
    rings = lod2
    lod = 2
    if not rings:
        lod = 1
        for c in b.iter():
            if local(c.tag) == 'lod1Solid':
                rings = [(r, -1) for r in polygons_in(c)]
                break
    if not rings:
        stats['skipped'] += 1
        return
    allp = np.concatenate([r for r, _ in rings])
    cx, cy = project(allp[:, 0].mean(), allp[:, 1].mean())
    d = math.hypot(cx, cy)
    if d < 45 or d > A.radius or (d > 120 and (cy < 0 or abs(math.degrees(math.atan2(cx, cy))) > A.fov)):
        return
    zmin, zmax = float(allp[:, 2].min()), float(allp[:, 2].max())
    h = float(attrs.get('measuredHeight', zmax - zmin) or (zmax - zmin))
    if h <= 0 or h > 900:
        h = zmax - zmin
    st = attrs.get('storeysAboveGround')
    try:
        st = int(float(st)) if st else 0
    except ValueError:
        st = 0
    if st >= 9999 or st < 0:
        st = 0
    kind = USAGE.get(attrs.get('usage', ''), -1)
    for r, t in rings:
        if t == -1:   # LOD1：按法线分屋顶 / 墙 / 底
            xy = np.stack(project(r[:, 0], r[:, 1]), 1)
            p3 = np.concatenate([xy, r[:, 2:3]], 1)
            nrm = np.cross(p3[1] - p3[0], p3[2] - p3[0]) if len(p3) >= 3 else np.zeros(3)
            # 用 Newell 法算法线（多边形不一定是三角形）
            nx = ny = nz = 0.0
            for i in range(len(p3)):
                a, c = p3[i], p3[(i + 1) % len(p3)]
                nx += (a[1] - c[1]) * (a[2] + c[2])
                ny += (a[2] - c[2]) * (a[0] + c[0])
                nz += (a[0] - c[0]) * (a[1] + c[1])
            L = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            t = 0 if abs(nz / L) < 0.5 else (1 if nz > 0 else 2)
        if t == 2:
            continue      # 底面看不见，不要
        add_ring(r, t)
    B['kind'].append(kind)
    B['storeys'].append(st)
    B['fh'].append(h / st if st else 0.0)
    B['base'].append(zmin)
    B['top'].append(zmin + h if lod == 1 else zmax)
    B['height'].append(h)
    B['lod'].append(lod)
    B['cx'].append(cx)
    B['cy'].append(cy)
    stats['lod%d' % lod] += 1


def parse_bldg(path):
    ctx = ET.iterparse(path, events=('start', 'end'))
    depth_member = 0
    for ev, el in ctx:
        t = local(el.tag)
        if ev == 'start':
            if t == 'cityObjectMember':
                depth_member += 1
            continue
        if t == 'Building' and depth_member:
            handle_building(el)
            el.clear()
        elif t == 'cityObjectMember':
            depth_member -= 1
            el.clear()


bfiles = sorted(glob.glob(os.path.join(A.gml, 'bldg', '*_bldg_*.gml')))
for f in bfiles:
    code = re.match(r'(\d+)_', os.path.basename(f)).group(1)
    if not box_visible(mesh_box(code)):
        continue
    n0 = len(B['kind'])
    parse_bldg(f)
    stats['files'] += 1
    print(f'[plateau] {os.path.basename(f)}: {len(B["kind"]) - n0} 栋', flush=True)

# ---------- 地形：TIN → 20 米一格的标高网格（视点坐标） ----------
G_STEP = 20.0
gx0, gx1, gy0, gy1 = -A.radius * 1.1, A.radius * 1.1, -1500.0, A.radius * 1.1
NX, NY = int((gx1 - gx0) / G_STEP) + 1, int((gy1 - gy0) / G_STEP) + 1
dem = np.full((NY, NX), np.nan, np.float32)
for f in sorted(glob.glob(os.path.join(A.gml, 'dem', '*.gml'))):
    code = re.match(r'(\d+)_', os.path.basename(f)).group(1)
    if not box_visible(mesh_box(code)):
        continue
    tris = []
    for ev, el in ET.iterparse(f, events=('end',)):
        if local(el.tag) == 'Triangle':
            for pl in el.iter():
                if local(pl.tag) == 'posList' and pl.text:
                    tris.append(poslist(pl.text)[:3])
            el.clear()
    if not tris:
        continue
    T = np.array(tris)                                         # (n, 3, 3) 纬度 经度 标高
    xs, ys = project(T[..., 0], T[..., 1])
    zs = T[..., 2]
    # 每个三角形：在它的包围盒里的格点上做重心插值
    for k in range(len(T)):
        x, y, z = xs[k], ys[k], zs[k]
        i0 = max(0, int(math.floor((x.min() - gx0) / G_STEP)))
        i1 = min(NX - 1, int(math.ceil((x.max() - gx0) / G_STEP)))
        j0 = max(0, int(math.floor((y.min() - gy0) / G_STEP)))
        j1 = min(NY - 1, int(math.ceil((y.max() - gy0) / G_STEP)))
        if i1 < i0 or j1 < j0:
            continue
        gi, gj = np.meshgrid(np.arange(i0, i1 + 1), np.arange(j0, j1 + 1))
        px, py = gx0 + gi * G_STEP, gy0 + gj * G_STEP
        det = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(det) < 1e-9:
            continue
        l1 = ((y[1] - y[2]) * (px - x[2]) + (x[2] - x[1]) * (py - y[2])) / det
        l2 = ((y[2] - y[0]) * (px - x[2]) + (x[0] - x[2]) * (py - y[2])) / det
        l3 = 1 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        dem[gj[inside], gi[inside]] = (l1 * z[0] + l2 * z[1] + l3 * z[2])[inside]
    print(f'[plateau] {os.path.basename(f)}: 地形 {len(T)} 个三角形', flush=True)

# 眼睛的标高：视点所在的地面 + height
base = np.array(B['base'], np.float64)
cx, cy = np.array(B['cx']), np.array(B['cy'])
j, i = int(round((0 - gy0) / G_STEP)), int(round((0 - gx0) / G_STEP))
ground_vp = float(dem[j, i]) if not np.isnan(dem[j, i]) else float(np.median(base[np.hypot(cx, cy) < 200]))
eye = ground_vp + A.height
print(f'[plateau] 视点地面标高 {ground_vp:.1f} m，眼睛 {eye:.1f} m')
if np.isnan(dem).all():
    dem[:] = ground_vp
else:   # 没有数据的格子（港区外面）：填最近的已知值（逐行、逐列往外推几轮，剩下的填视点地面）
    for _ in range(60):
        m = np.isnan(dem)
        if not m.any():
            break
        p = np.pad(dem, 1, constant_values=np.nan)
        nb = np.stack([p[:-2, 1:-1], p[2:, 1:-1], p[1:-1, :-2], p[1:-1, 2:]])
        fill = np.nanmean(np.where(np.isnan(nb), np.nan, nb), 0) if not np.isnan(nb).all() else None
        dem = np.where(m & ~np.isnan(fill), fill, dem)
    dem = np.where(np.isnan(dem), ground_vp, dem)

V = np.concatenate(verts).astype(np.float64)
V[:, 2] -= eye
np.savez_compressed(
    A.out, V=V.astype(np.float32), P=np.concatenate(polys), Plen=np.array(plen, np.int32), Pb=np.array(pbld, np.int32),
    Pt=np.array(ptype, np.int8), **{'B_' + k: np.array(v, np.float32) for k, v in B.items()},
    dem=(dem - eye).astype(np.float32), dem_box=np.array([gx0, gy0, G_STEP], np.float32), eye=np.float32(eye),
    vp=np.array([A.vp_lat, A.vp_lon, A.bearing, A.height], np.float64))
print(f'[plateau] {stats["files"]} 个文件，{len(B["kind"])} 栋（LOD2 {stats["lod2"]}，LOD1 {stats["lod1"]}），'
      f'{len(plen)} 个面，{len(V)} 个顶点 → {A.out}')
