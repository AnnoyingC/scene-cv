# 窗外近处街上的细节（render_view.py 用；只摆在镜头附近、而且从窗户真看得见的地方）：
#   小街小巷   OSM 的住宅区小路（vendor-src/osm/detail.json）：窄路面；沿路的电线杆（横担、变压器、防犯灯），杆和杆之间拉电线
#   店面       OSM 里附近真实的居酒屋、咖啡店、餐厅、便利店：找它旁边朝着镜头、没被挡住的那面墙，在一楼做店面——
#              居酒屋：一排红灯笼 + 门口一个大灯笼、暖橙的格子拉门、深蓝的暖帘、竖招牌；咖啡店：暖白的大玻璃窗、遮阳棚、
#              门口两盆植物、招牌；别的餐厅：暖光 + 暖帘 + 招牌；便利店：一整面很亮的白光
#   树         主干道两边的行道树、OSM 里的树、公园里的树；一户建（低矮的住宅）的院子里种一两棵小树、几丛灌木
# 坐标和 osm_city.py 一样（视点在原点，X 右、Y 前、Z 上）。所有东西通过 C（render_view.py 给的一组函数）加到场景里。
import json
import math
import os
import random

import numpy as np


def load(path):
    with open(path) as f:
        return json.load(f).get('elements', [])


def build(C):
    r = random.Random(57)
    proj, gz, M = C.proj, C.gz, C.mats
    stats = dict(poles=0, wires=0, trees=0, shrubs=0, izakaya=0, cafe=0, eatery=0, konbini=0)
    els = load(os.path.join(C.osm, 'detail.json'))

    def in_view(x, y, near=40.0, far=520.0):
        d = math.hypot(x, y)
        return near < d < far and y > 0 and abs(math.degrees(math.atan2(x, y))) < 84

    # ---------- 树 ----------
    def tree(x, y, size=1.0, shrub=False):
        g = gz(x, y)
        if shrub:                                          # 灌木：贴地的两三团
            for _ in range(r.randint(2, 3)):
                C.sphere((x + r.uniform(-0.5, 0.5), y + r.uniform(-0.5, 0.5), g + 0.45 * size), r.uniform(0.45, 0.7) * size, M['LEAF'], 0.8)
            stats['shrubs'] += 1
            return
        trunk = 2.4 * size
        C.rod((x, y, g), (x, y, g + trunk + 0.6), 0.14 * size, M['BARK'])
        for _ in range(r.randint(2, 4)):                   # 树冠：几团叠在一起
            C.sphere((x + r.uniform(-0.9, 0.9) * size, y + r.uniform(-0.9, 0.9) * size, g + trunk + r.uniform(1.0, 2.2) * size),
                     r.uniform(1.4, 2.2) * size, M['LEAF'], r.uniform(0.75, 0.95))
        stats['trees'] += 1

    # 行道树：主干道（trunk / primary / secondary / tertiary）两边，每 11 米一棵，种在人行道上
    for el in load(os.path.join(C.osm, 'roads.json')):
        t = el.get('tags', {})
        kind = t.get('highway', '')
        if kind not in ('trunk', 'primary', 'secondary', 'tertiary') or t.get('bridge') or t.get('tunnel'):
            continue
        pts = [proj(p['lat'], p['lon']) for p in el.get('geometry') or []]
        if len(pts) < 2 or not any(in_view(x, y, 60, 380) for x, y in pts):
            continue
        lanes = float(t.get('lanes', '4' if kind in ('trunk', 'primary') else '2').split(';')[0] or 2)
        off = lanes * 3.2 / 2 + 2.0
        acc = 0.0
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg < 0.5:
                continue
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            s = (11.0 - acc) % 11.0
            while s < seg:
                for side in (1, -1):
                    x, y = x0 + ux * s - uy * off * side, y0 + uy * s + ux * off * side
                    if in_view(x, y, 60, 380) and not C.occupied(x, y):
                        tree(x, y, r.uniform(0.8, 1.05))
                s += 11.0
            acc = (acc + seg) % 11.0

    # OSM 里单独标了的树、公园里的树
    for el in els:
        t = el.get('tags', {})
        if el['type'] == 'node' and t.get('natural') == 'tree':
            x, y = proj(el['lat'], el['lon'])
            if in_view(x, y) and not C.occupied(x, y):
                tree(x, y, r.uniform(1.0, 1.3))
        elif el['type'] == 'way' and (t.get('leisure') in ('park', 'garden') or t.get('landuse') == 'grass'):
            ring = [proj(p['lat'], p['lon']) for p in el.get('geometry') or []]
            if len(ring) < 4:
                continue
            xs, ys = [p[0] for p in ring], [p[1] for p in ring]
            area = abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1] for i in range(len(ring)))) / 2
            n = min(260, int(area / 70))
            for _ in range(n):
                x, y = r.uniform(min(xs), max(xs)), r.uniform(min(ys), max(ys))
                if in_view(x, y) and point_in(ring, x, y) and not C.occupied(x, y):
                    tree(x, y, r.uniform(0.9, 1.4))

    # 一户建的院子：低矮的住宅（PLATEAU 用途 = 住宅、10 米以下、占地小），房子旁边的空地上种一两棵小树、几丛灌木
    for (cx, cy, h, kind, area, walls) in C.buildings(60, 420):
        if kind != 1 or h > 10.5 or area > 260 or r.random() > 0.7:
            continue
        for _ in range(r.randint(1, 3)):
            a, c, nrm = walls[r.randrange(len(walls))][:3]
            p = a + (c - a) * r.uniform(0.2, 0.8) + nrm * r.uniform(1.4, 2.6)
            if not C.occupied(p[0], p[1]):
                if r.random() < 0.55:
                    tree(p[0], p[1], r.uniform(0.55, 0.8))
                else:
                    tree(p[0], p[1], r.uniform(0.9, 1.3), shrub=True)

    # ---------- 小街小巷：路面、电线杆、电线 ----------
    WIDTH = {'residential': 4.6, 'unclassified': 5.4, 'living_street': 4.0, 'pedestrian': 5.0, 'service': 3.4}
    for el in els:
        t = el.get('tags', {})
        kind = t.get('highway')
        if el['type'] != 'way' or kind not in WIDTH or t.get('tunnel') or t.get('area') == 'yes':
            continue
        pts = [proj(p['lat'], p['lon']) for p in el.get('geometry') or []]
        if len(pts) < 2 or not any(in_view(x, y, 30, 520) for x, y in pts):
            continue
        w = WIDTH[kind]
        C.road([(x, y, gz(x, y)) for x, y in pts], w)
        if kind == 'service':
            continue
        # 电线杆：沿路一侧每 30 米一根（路的左边），杆顶两道横担，每三根挂一个变压器；朝路的一侧挂一盏防犯灯
        poles, acc = [], 0.0
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg < 0.5:
                continue
            ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
            s = (30.0 - acc) % 30.0
            while s < seg:
                x, y = x0 + ux * s - uy * (w / 2 + 0.35), y0 + uy * s + ux * (w / 2 + 0.35)
                poles.append((x, y, ux, uy))
                s += 30.0
            acc = (acc + seg) % 30.0
        tops = []
        for k, (x, y, ux, uy) in enumerate(poles):
            if not in_view(x, y, 45, 460):
                tops.append(None)
                continue
            g = gz(x, y)
            C.rod((x, y, g), (x, y, g + 11.5), 0.17, M['POLE'])
            nx, ny = -uy, ux                                  # 横担沿着路的法线方向
            arms = []
            for z, half in ((10.6, 0.85), (9.6, 0.6)):
                p0, p1 = (x - nx * half, y - ny * half, g + z), (x + nx * half, y + ny * half, g + z)
                C.rod(p0, p1, 0.06, M['POLE'])
                arms += [p0, (x, y, g + z + 0.12), p1]
            if k % 3 == 1:                                    # 变压器（圆柱的罐子）
                C.cube(x + nx * 0.45, y + ny * 0.45, g + 7.2, 0.55, 0.55, 1.2, M['POLE'])
            lx, ly = x - nx * 1.0, y - ny * 1.0                # 防犯灯：伸向路中间
            C.rod((x, y, g + 5.6), (lx, ly, g + 5.9), 0.04, M['POLE'])
            C.dot(lx, ly, g + 5.8, 0.22, M['LAMP2'])
            C.light(lx, ly, g + 5.5, 'pole')
            arms.append((x, y, g + 6.6))                      # 通信线（粗一点、低一点）
            tops.append(arms)
            stats['poles'] += 1
        for a_, b_ in zip(tops, tops[1:]):                    # 相邻两根杆之间拉线（中间垂下来一点）
            if not a_ or not b_:
                continue
            for p0, p1 in zip(a_, b_):
                thick = 0.05 if p0 is a_[-1] else 0.03
                prev = p0
                for i in range(1, 7):
                    f = i / 6
                    q = (p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f - 0.45 * 4 * f * (1 - f))
                    C.rod(prev, q, thick, M['WIRE'])
                    prev = q
                stats['wires'] += 1

    # ---------- 店面 ----------
    caps = dict(izakaya=10, cafe=8, eatery=8, konbini=3)
    used_walls, placed = set(), []
    for el in sorted((e for e in els if e['type'] == 'node' and (e.get('tags', {}).get('amenity') or e.get('tags', {}).get('shop') == 'convenience')),
                     key=lambda e: e['id']):
        t = el['tags']
        am, cu = t.get('amenity'), (t.get('cuisine') or '')
        if t.get('shop') == 'convenience':
            style = 'konbini'
        elif am == 'cafe':
            style = 'cafe'
        elif am in ('bar', 'pub', 'izakaya') or (am == 'restaurant' and (not cu or 'japanese' in cu or 'izakaya' in cu or 'yakitori' in cu)):
            style = 'izakaya'
        elif am in ('restaurant', 'fast_food'):
            style = 'eatery'
        else:
            continue
        if stats[style] >= caps[style]:
            continue
        x, y = proj(el['lat'], el['lon'])
        if not in_view(x, y, 70, 330):
            continue
        wall = C.wall_near(x, y, 22.0, used_walls)           # 旁边朝着镜头、一楼看得见的那面墙
        if not wall:
            continue
        key, a, c, nrm, zb = wall
        if any(np.hypot(*((a + c) / 2 - (p0 + p1) / 2)) < 12 for _, p0, p1, _ in placed):   # 同一面墙附近已经有店了
            continue
        used_walls.add(key)
        storefront(C, r, style, a, c, nrm, zb, cu)
        stats[style] += 1
        placed.append((style, a, c, zb))
    # 地图里的店大多藏在楼后面、从窗户看不见：再在镜头附近看得见的一楼临街墙上补几家（一个街区里居酒屋、咖啡店本来就多）
    want = dict(izakaya=7, cafe=4, eatery=3)
    order = ['izakaya', 'cafe', 'izakaya', 'eatery', 'izakaya', 'cafe', 'izakaya', 'eatery', 'izakaya', 'cafe', 'izakaya', 'eatery', 'izakaya']
    cand = []
    for (cx, cy, h, kind, area, walls) in C.buildings(85, 300):
        if h < 6 or kind == 0 and h > 60:
            continue
        for (a, c, nrm, zb, zt, L, k) in walls:
            if L < 6:
                continue
            mid = (a + c) / 2
            cand.append((float(np.hypot(*mid)) + r.uniform(0, 60), mid))
    cand.sort(key=lambda t: t[0])
    for _, mid in cand:
        need = [s_ for s_ in order if stats[s_] < want.get(s_, 0)]
        if not need:
            break
        wall = C.wall_near(float(mid[0]), float(mid[1]), 1.5, used_walls)
        if not wall:
            continue
        key, a, c, nrm, zb = wall
        if any(np.hypot(*((a + c) / 2 - (p0 + p1) / 2)) < 25 for _, p0, p1, _ in placed):   # 别挤在一起
            continue
        used_walls.add(key)
        style = need[0]
        storefront(C, r, style, a, c, nrm, zb, '')
        stats[style] += 1
        placed.append((style, a, c, zb))
    print('[street] ' + '，'.join(f'{k} {v}' for k, v in stats.items()))
    for style, a, c, zb in placed:                          # 店在窗外的哪个方向（方便对着看）
        m = (a + c) / 2
        print(f'[street]   {style:8s} 偏 {math.degrees(math.atan2(m[0], m[1])):+.1f}°，俯角 {math.degrees(math.atan2(-zb, float(np.hypot(*m)))):.1f}°，'
              f'{float(np.hypot(*m)):.0f} 米')
    return stats


def point_in(ring, x, y):
    inside = False
    for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0 + 1e-12) + x0:
            inside = not inside
    return inside


def storefront(C, r, style, a, c, nrm, zb, cuisine):
    """在墙 a → c（地面高度 zb，朝外法线 nrm）的一楼做一个店面。"""
    M = C.mats
    L = float(np.hypot(*(c - a)))
    t = (c - a) / L
    W = min(L * 0.8, {'izakaya': 5.5, 'cafe': 6.5, 'eatery': 5.0, 'konbini': 9.0}[style])
    m = (a + c) / 2 + t * r.uniform(-1, 1) * max(0.0, (L - W) / 2 - 0.5)
    e0, e1 = m - t * W / 2, m + t * W / 2

    def onwall(p, out, z):
        return (p[0] + nrm[0] * out, p[1] + nrm[1] * out, zb + z)

    glow = {'izakaya': M['SHOP_WARM'], 'cafe': M['SHOP_CAFE'], 'eatery': M['SHOP_WARM'], 'konbini': M['SHOP_BRIGHT']}[style]
    top = 3.6 if style == 'konbini' else 2.8
    C.quad(onwall(e0, 0.08, 0.2), onwall(e1, 0.08, 0.2), onwall(e1, 0.08, top), onwall(e0, 0.08, top), glow)     # 店里透出来的光
    lp = onwall(m, 2.0, 2.4)
    C.light(lp[0], lp[1], lp[2], 'shop_white' if style == 'konbini' else 'shop')
    right = np.array([-nrm[1], nrm[0]])
    flip = float(np.dot(t, right)) < 0
    if style == 'izakaya':
        # 屋檐下一排红灯笼 + 门口一个大灯笼
        k = max(3, int(W / 0.9))
        for i in range(k):
            p = e0 + t * (W * (i + 0.5) / k)
            C.sphere(onwall(p, 0.45, 3.15), 0.4, M['LANTERN'], 1.35)
        C.sphere(onwall(e0 + t * 0.4, 0.7, 2.3), 0.6, M['LANTERN'], 1.4)
        # 暖帘：门的位置，深蓝的一块
        d0, d1 = m - t * 0.9, m + t * 0.9
        C.quad(onwall(d0, 0.3, 1.9), onwall(d1, 0.3, 1.9), onwall(d1, 0.3, 2.75), onwall(d0, 0.3, 2.75), M['NOREN'])
        # 竖招牌：靠墙的一头伸出来
        C.sign_vertical(r.choice(['居酒屋', '酒場', '焼肉', '定食']), e1 + t * 0.3, t, nrm, zb + 3.4, 3.6)
    elif style == 'cafe':
        # 遮阳棚：从墙上 3 米斜着伸出来 1.4 米
        C.quad(onwall(e0, 0.05, 3.1), onwall(e1, 0.05, 3.1), onwall(e1, 1.45, 2.55), onwall(e0, 1.45, 2.55), M['AWNING'])
        for p in (e0 - t * 0.5, e1 + t * 0.5):                 # 门口两盆植物
            C.sphere(onwall(p, 0.6, 0.55), 0.5, M['LEAF'], 1.1)
        C.sign_flat(r.choice(['CAFE', '珈琲', '喫茶']), m, t, nrm, zb + 3.3, min(W * 0.6, 4.0), flip)
    elif style == 'eatery':
        d0, d1 = m - t * 1.0, m + t * 1.0
        C.quad(onwall(d0, 0.3, 1.9), onwall(d1, 0.3, 1.9), onwall(d1, 0.3, 2.75), onwall(d0, 0.3, 2.75),
               M['NOREN_RED'] if ('ramen' in cuisine or 'chinese' in cuisine or 'noodle' in cuisine) else M['NOREN'])
        word = 'ラーメン' if 'ramen' in cuisine or 'noodle' in cuisine else '中華' if 'chinese' in cuisine else r.choice(['定食', '寿司', '焼肉'])
        if word in ('ラーメン',):
            C.sign_flat(word, m, t, nrm, zb + 3.1, min(W * 0.7, 4.0), flip)
        else:
            C.sign_vertical(word, e1 + t * 0.3, t, nrm, zb + 3.2, 3.2)
    else:   # 便利店：屋檐上一条白色的灯箱
        C.quad(onwall(e0, 0.12, 3.7), onwall(e1, 0.12, 3.7), onwall(e1, 0.12, 4.4), onwall(e0, 0.12, 4.4), M['SHOP_BRIGHT'])
