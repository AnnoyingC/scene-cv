# 窗外的真实城市：用 OpenStreetMap 的数据（© OpenStreetMap contributors，ODbL）在 Blender 里搭东京塔一带的街区，
# 给 render_view.py 用（--osm 目录）。数据用 Overpass 下载到 vendor-src/osm/（不进仓库）：
#   near.json   视点 1.6 公里以内所有的楼（out geom）
#   far.json    5 公里以内标了 height 或 building:levels 的楼（远处只要天际线）
#   roads.json  2.5 公里以内的主要道路（motorway … tertiary）
# 坐标：视点在原点、离地 H 米；窗户朝 BEARING（正北顺时针，度）方向，转到 Blender 的 +Y；X 向右，Z 向上，地面在 z = -H。
# 楼：轮廓立成多边形柱体（墙 + 平顶），高度 = height → building:levels × 3.3 + 2 → 按占地推一个；60 米以上的楼顶四角放红色航空灯。
# 东京塔：地图里只有塔基，塔身按真实比例自己搭（四条腿往上收，横梁、交叉斜撑，两层展望台，天线），夜里亮成橙色。
import json
import math
import os
import random

LANDMARK = (35.65858, 139.74543)


def load_elements(path):
    with open(path) as f:
        return json.load(f).get('elements', [])


def ring_of(el):
    """一栋楼的外轮廓（经纬度列表）；多边形关系取第一个 outer。"""
    if el.get('type') == 'way':
        return [(p['lat'], p['lon']) for p in el.get('geometry', [])]
    for m in el.get('members', []):
        if m.get('role') == 'outer' and m.get('geometry'):
            return [(p['lat'], p['lon']) for p in m['geometry']]
    return []


def parse_num(s):
    try:
        return float(str(s).replace('m', '').replace(',', '.').split(';')[0].split()[0])
    except (ValueError, IndexError):
        return None


class Projector:
    """经纬度 → 视点为原点的米（东、北）→ 转到窗户朝向（Blender：X 右、Y 前）。"""

    def __init__(self, lat0, lon0, bearing):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110574.0
        b = math.radians(bearing)
        self.cb, self.sb = math.cos(b), math.sin(b)

    def __call__(self, lat, lon):
        e, n = (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky
        return e * self.cb - n * self.sb, e * self.sb + n * self.cb


def guess_height(tags, area, rnd):
    h = parse_num(tags.get('height'))
    if h:
        return h
    lv = parse_num(tags.get('building:levels'))
    if lv:
        return lv * 3.3 + 2
    kind = tags.get('building', 'yes')
    if kind in ('house', 'detached', 'residential', 'garage', 'shed', 'hut', 'roof'):
        return rnd.uniform(6, 10)
    if area < 120:
        return rnd.uniform(7, 13)
    if area < 500:
        return rnd.lognormvariate(math.log(16), 0.35)
    return rnd.lognormvariate(math.log(26), 0.4)


RES = ('apartments', 'residential', 'house', 'detached', 'terrace', 'dormitory', 'semidetached_house')
COM = ('commercial', 'retail', 'hotel', 'hospital', 'school', 'university', 'college', 'public', 'civic', 'government',
       'train_station', 'kindergarten', 'temple', 'shrine', 'church')


def guess_kind(tags, h, rnd):
    """楼的类型：0 写字楼、1 住宅、2 商业 / 其他（决定窗户的样子和灯的颜色）；没标的按高度猜。"""
    k = tags.get('building', 'yes')
    if k in RES:
        return 1
    if k == 'office':
        return 0
    if k in COM:
        return 2
    x = rnd.random()
    if h >= 50:
        return 0 if x < 0.6 else 1
    if h >= 20:
        return 1 if x < 0.45 else 0 if x < 0.75 else 2
    return 1 if x < 0.55 else 2


def floor_height(tags, h, kind):
    lv = parse_num(tags.get('building:levels'))
    if lv and lv >= 1 and h:
        return min(4.6, max(2.8, h / lv))
    return (4.0, 3.0, 3.5)[kind]


def build(add_prism, add_rod, add_dot, add_lane, add_lamp, mats, H, args, add_road=None, ground=None, covered=None):
    """ground(x, y)：地面的 z（默认平地 -H）；covered(x, y)：这里已经有 PLATEAU 的楼了（OSM 的就不要）。"""
    gz = ground or (lambda x, y: -H)
    """mats：材质编号（FACADE、BEACON、SPIRE、DECK、LAMP、LANE、ROAD 等）。args：osm、vp_lat、vp_lon、bearing。"""
    rnd = random.Random(23)
    proj = Projector(args.vp_lat, args.vp_lon, args.bearing)
    tx, ty = proj(*LANDMARK)
    G = -H
    seen, n_bld = set(), 0

    def visible(x, y, pad=60.0):
        return y > -pad and abs(math.atan2(x, max(y, 1e-3))) < math.radians(84) or math.hypot(x, y) < pad

    def add_building(el, far):
        nonlocal n_bld
        ring = ring_of(el)
        if len(ring) < 4:
            return
        pts = [proj(la, lo) for la, lo in ring]
        if pts[0] == pts[-1]:
            pts = pts[:-1]
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        d = math.hypot(cx, cy)
        if d < 45 or not visible(cx, cy):               # 我们自己站的这栋楼、身后的楼
            return
        if covered and covered(cx, cy):
            return
        tags = el.get('tags', {})
        area2 = sum(pts[i][0] * pts[(i + 1) % len(pts)][1] - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
        area = abs(area2) / 2
        h = guess_height(tags, area, rnd)
        if math.hypot(cx - tx, cy - ty) < 70 and h > 60:   # 地图里东京塔本身：不要，下面自己搭
            return
        if far and h < 30:
            return
        if area2 < 0:                                       # 统一成逆时针（从上往下看），墙的法线朝外
            pts = pts[::-1]
        lit = min(0.9, rnd.betavariate(2.2, 2.4) * (1.15 if h > 60 else 1.0))
        bid = rnd.random()
        kind = guess_kind(tags, h, rnd)
        g0 = gz(cx, cy)
        add_prism(pts, g0, h, mats['FACADE'], bid, lit, kind, floor_height(tags, h, kind))
        if h > 60:                                         # 高楼楼顶四角（最多 4 个角）的红色航空灯
            step = max(1, len(pts) // 2)
            for p in pts[::step][:2]:
                add_dot(p[0], p[1], g0 + h + 1.0, 0.5 + d * 0.0004, mats['BEACON'])
        n_bld += 1

    for name, far in (('near.json', False), ('far.json', True)):
        for el in load_elements(os.path.join(args.osm, name)):
            key = (el.get('type'), el.get('id'))
            if key in seen:
                continue
            seen.add(key)
            add_building(el, far)

    # ---------- 道路：路面、高架、路灯、车流 ----------
    # 宽度按真实车道数（lanes，一个方向的路就是这个方向的车道数）；bridge + layer 决定架多高（首都高的高架、立交一层叠一层）；
    # 隧道（tunnel、layer < 0）在地下，不画。路面、车道线、高架的梁和桥墩在 render_view.py 的 road_geom 里搭。
    n_lamp, n_lane = 0, 0
    MAJOR = ('motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link')
    LANES = {'motorway': 2, 'motorway_link': 1, 'trunk': 4, 'trunk_link': 1, 'primary': 4, 'secondary': 2, 'tertiary': 2}
    for el in load_elements(os.path.join(args.osm, 'roads.json')):
        tags = el.get('tags', {})
        kind = tags.get('highway', '')
        geo = el.get('geometry') or []
        if len(geo) < 2:
            continue
        layer = parse_num(tags.get('layer')) or 0.0
        if tags.get('tunnel') in ('yes', 'building_passage') or layer < 0:
            continue
        pts = [proj(p['lat'], p['lon']) for p in geo]
        bridge = tags.get('bridge') not in (None, 'no')
        express = kind.startswith(('motorway', 'trunk'))
        lift = (6.0 + 6.0 * max(layer, 1.0)) if (bridge and express) else (5.0 * max(layer, 1.0) if bridge else 0.0)
        oneway = tags.get('oneway') == 'yes' or kind.startswith('motorway')
        lanes = int(parse_num(tags.get('lanes')) or LANES.get(kind, 2))
        width = lanes * (3.5 if express else 3.2) + (1.5 if oneway else 2.0)
        near = min(math.hypot(x, y) for x, y in pts) < 900
        if add_road:
            add_road([(x, y, gz(x, y) + lift) for x, y in pts], width, lift, lanes, oneway, near)
        # 路灯：沿路每 32 米一盏（单向的路只在一边，双向的两边交错），高架上的灯装在护栏上
        acc, side = 0.0, 1
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg < 0.5:
                continue
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            t = (32.0 - acc) % 32.0
            while t < seg:
                off = (width / 2 + 0.4) * (1 if oneway else side)
                px, py = x0 + ux * t - uy * off, y0 + uy * t + ux * off
                if visible(px, py, 20) and math.hypot(px, py) > 30:
                    add_lamp(px, py, gz(px, py) + lift + (8.0 if lift else 7.0))
                    n_lamp += 1
                side = -side
                t += 32.0
            acc = (acc + seg) % 32.0
        # 车流：主干道、高速路 1.6 公里以内，按 120 米以上的直线段拆开；单向的路只有这一个方向
        if kind in MAJOR:
            run = [pts[0]]
            for p in pts[1:]:
                run.append(p)
                if math.hypot(p[0] - run[0][0], p[1] - run[0][1]) < 120 and p is not pts[-1]:
                    continue
                (ax, ay), (bx, by) = run[0], run[-1]
                if math.hypot(ax, ay) < 1600 and visible(ax, ay, 0) and visible(bx, by, 0):
                    L = math.hypot(bx - ax, by - ay)
                    if L > 60:
                        nx_, ny_ = -(by - ay) / L, (bx - ax) / L
                        if oneway:
                            offs = [(((k + 0.5) / lanes - 0.5) * (width - 1.5), True) for k in range(min(lanes, 2))]
                        else:
                            offs = [(width * 0.22, True), (-width * 0.22, False)]
                        for off, fwd in offs:
                            a = (ax + nx_ * off, ay + ny_ * off, gz(ax, ay) + lift + 0.7)
                            b = (bx + nx_ * off, by + ny_ * off, gz(bx, by) + lift + 0.7)
                            add_lane(a, b) if fwd else add_lane(b, a)
                            n_lane += 1
                run = [p]

    # ---------- 东京塔 ----------
    build_landmark(add_rod, add_prism, add_dot, mats, tx, ty, gz(tx, ty))
    print(f'[osm] {n_bld} 栋楼，{n_lamp} 盏路灯，{n_lane} 条车道；东京塔在 ({tx:.0f}, {ty:.0f})，'
          f'{math.hypot(tx, ty):.0f} 米外、偏 {math.degrees(math.atan2(tx, ty)):.1f}°')
    return n_bld


def build_landmark(add_rod, add_prism, add_dot, mats, tx, ty, G):
    """东京塔，333 米（照着真塔的设计捏的，正面对着窗户）：
      塔身  四条腿从 80 米见方的塔基往上收（轮廓 prof：塔基 → 大展望台 → 顶层展望台）；每条腿本身是一根格构柱
            （四根弦杆 + 之字形缀条，下面 7 米见方、往上收细）；每一节的四个面有横梁和双交叉斜撑，越往上节间越密
      塔脚  每个面两腿之间一道拱形桁架（拱顶约 42 米），拱下面是空的（底下是 Foot Town，PLATEAU 里有）；拱顶上一圈水平桁架带
      展望台 145–155 米的大展望台（两层，一圈大窗）+ 屋顶板；247–253 米的顶层展望台
      天线  253–290 米一段格构桅杆，往上是一节节收细的杆子，到 333 米
      航空灯 塔顶、300 米、两层展望台的四角
    颜色（红白相间的涂装、夜里的投光灯）在 render_view.py 的 spire_glow：按高度分段，白色的几段发金白光、橙色的几段发深橙光。"""
    prof = [(0, 40), (25, 31), (55, 22.5), (90, 16.5), (120, 13.2), (150, 11.2), (190, 8.6), (220, 7.0), (250, 5.0)]
    T = mats['SPIRE']

    def half(z):
        for (z0, w0), (z1, w1) in zip(prof, prof[1:]):
            if z <= z1:
                return w0 + (w1 - w0) * (z - z0) / (z1 - z0)
        return prof[-1][1]

    SX = ((-1, -1), (1, -1), (1, 1), (-1, 1))

    def corner(z, i, inset=0.0):
        w = half(z) - inset
        sx, sy = SX[i]
        return (tx + sx * w, ty + sy * w, G + z)

    def lerp(a, b, t):
        return tuple(a[k] + (b[k] - a[k]) * t for k in range(3))

    def leg_w(z):            # 腿（格构柱）的宽度
        return max(1.4, 7.0 - z * 0.035) if z < 150 else max(1.0, 1.8 - (z - 150) * 0.006)

    def chords(z, i):
        """第 i 条腿在高度 z 的四根弦杆：从外角往塔里退 leg_w。"""
        sx, sy = SX[i]
        w, lw = half(z), leg_w(z)
        return [(tx + sx * (w - dx), ty + sy * (w - dy), G + z) for dx, dy in ((0, 0), (lw, 0), (lw, lw), (0, lw))]

    levels, z = [0.0], 0.0
    while z < 250:
        z = min(250.0, z + (8.0 if z < 60 else 7.0 if z < 150 else 6.0))
        levels.append(z)
    ARCH = 42.0
    # ---- 四条腿：每条四根弦杆 + 朝外两个面的之字形缀条 ----
    for i in range(4):
        for k, (z0, z1) in enumerate(zip(levels, levels[1:])):
            c0, c1 = chords(z0, i), chords(z1, i)
            rr = 0.42 if z0 < 150 else 0.28
            for a, b in zip(c0, c1):
                add_rod(a, b, rr, T)
            for f0, f1 in ((0, 1), (0, 3)):                          # 朝外的两个面
                if k % 2 == 0:
                    add_rod(c0[f0], c1[f1], rr * 0.45, T)
                else:
                    add_rod(c0[f1], c1[f0], rr * 0.45, T)
            add_rod(c1[0], c1[2], rr * 0.4, T)                       # 腿里的横隔
    # ---- 每一节、每个面：横梁 + 双交叉斜撑（拱下面是空的）----
    for z0, z1 in zip(levels, levels[1:]):
        r = 0.32 if z0 < 150 else 0.22
        for i in range(4):
            j = (i + 1) % 4
            a1, b1 = corner(z1, i, leg_w(z1) * 0.5), corner(z1, j, leg_w(z1) * 0.5)
            if z1 >= ARCH:
                add_rod(a1, b1, r * 1.2, T)
            if z0 < ARCH + 6:
                continue
            a0, b0 = corner(z0, i, leg_w(z0) * 0.5), corner(z0, j, leg_w(z0) * 0.5)
            m0, m1 = lerp(a0, b0, 0.5), lerp(a1, b1, 0.5)
            for p, q in ((a0, m1), (m0, a1), (b0, m1), (m0, b1)):
                add_rod(p, q, r, T)
    # ---- 塔脚的拱：每个面一道两层的拱形桁架，中间之字形腹杆 ----
    for i in range(4):
        j = (i + 1) % 4
        N = 18
        lo, hi = [], []
        for k in range(N + 1):
            t = k / N
            zt = ARCH * math.sin(math.pi * t) ** 0.55                     # 拱：两头陡、顶上平
            lo.append(lerp(corner(zt, i, leg_w(zt) * 0.5), corner(zt, j, leg_w(zt) * 0.5), t))
            zt2 = min(ARCH + 6.0, zt + 3.5 + 2.5 * math.sin(math.pi * t))
            hi.append(lerp(corner(zt2, i, leg_w(zt2) * 0.5), corner(zt2, j, leg_w(zt2) * 0.5), t))
        for k in range(N):
            add_rod(lo[k], lo[k + 1], 0.5, T)
            add_rod(hi[k], hi[k + 1], 0.4, T)
            add_rod(lo[k], hi[k + 1] if k % 2 == 0 else hi[k], 0.22, T)
            add_rod(lo[k + 1], hi[k + 1], 0.22, T)
    # ---- 拱顶上的水平桁架带（42–48 米）：两圈 + 斜腹杆 ----
    for i in range(4):
        j = (i + 1) % 4
        for zz in (ARCH, ARCH + 6.0):
            add_rod(corner(zz, i), corner(zz, j), 0.45, T)
        for k in range(10):
            p0 = lerp(corner(ARCH, i), corner(ARCH, j), k / 10)
            p1 = lerp(corner(ARCH + 6.0, i), corner(ARCH + 6.0, j), (k + 1) / 10)
            add_rod(p0, p1, 0.22, T)

    # ---- 展望台 ----
    def box(z0, z1, w, mi, bid=0.9, lit=0.95):
        add_prism([(tx - w, ty - w), (tx + w, ty - w), (tx + w, ty + w), (tx - w, ty + w)], G + z0, z1 - z0, mi, bid, lit, 0, 3.6)

    box(145.0, 150.0, 15.5, mats['DECK'])                        # 大展望台：两层
    box(150.0, 155.0, 16.2, mats['DECK'])
    box(155.0, 156.5, 14.0, mats['ROOF'])                         # 屋顶板
    box(247.0, 253.0, 6.2, mats['DECK'])                          # 顶层展望台
    box(253.0, 254.0, 5.2, mats['ROOF'])
    # ---- 天线：格构桅杆（253–290 米），上面一节节收细的杆子 ----
    mz = [253.0 + k * 3.7 for k in range(11)]
    for z0, z1 in zip(mz, mz[1:]):
        w0, w1 = 2.2 - (z0 - 253) * 0.025, 2.2 - (z1 - 253) * 0.025
        q0 = [(tx + sx * w0, ty + sy * w0, G + z0) for sx, sy in SX]
        q1 = [(tx + sx * w1, ty + sy * w1, G + z1) for sx, sy in SX]
        for i in range(4):
            add_rod(q0[i], q1[i], 0.3, T)
            add_rod(q0[i], q1[(i + 1) % 4], 0.12, T)
            add_rod(q1[i], q1[(i + 1) % 4], 0.12, T)
    for z0, z1, r in ((290, 304, 0.9), (304, 318, 0.65), (318, 328, 0.45), (328, 333, 0.25)):
        add_rod((tx, ty, G + z0), (tx, ty, G + z1), r, T)
    # ---- 航空灯 ----
    add_dot(tx, ty, G + 333.6, 1.2, mats['BEACON'])
    for sx, sy in SX:
        add_dot(tx + sx * 1.3, ty + sy * 1.3, G + 300, 0.8, mats['BEACON'])
        add_dot(tx + sx * 6.2, ty + sy * 6.2, G + 254.5, 0.9, mats['BEACON'])
        add_dot(tx + sx * 14.0, ty + sy * 14.0, G + 157.0, 1.0, mats['BEACON'])
