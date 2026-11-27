# 电脑的屏保：窗外那片夜景的像素画 + 刊头式的标题（js/pc.js 在没人用电脑时放它）。
# 用法：python3 scripts/make_screensaver.py [--title SCENECV] [--subtitle "STEP INTO YOUR RÉSUMÉ"] [--no-badge]
#       （要 numpy 和 Pillow；换了窗外的全景或 view.json 的 turn / moon 以后重跑一次）
#
# 景和窗外是同一片：读 assets/baked/ 的两层全景（view_far / view_near，球心在窗户中心），按 view.json 的 turn 转过的方向、
# 站在窗口正对窗外（俯仰 PITCH、水平视角 HFOV）投影成 4:3 的一张。屏保将这张图轻推近并重新取景，16:9 画面位于中间的 180 行。
# 不是把照片打马赛克：每层分开缩、分开配色——
#   天空：几档颜色用 4×4 Bayer 抖动过渡；星星一个像素；月亮一个圆盘加一圈抖动的光晕
#   标题：在城市前面，塔尖留在 E 和 N 之间；冷色的顶、被城市灯光照暖的底，1 像素深色描边与投影，从天上浮起来
#   远景：压暗、往天色里雾一点、窗光稀疏（像景深虚掉）；近景：暖色的楼身、亮着的窗是单个亮像素；塔单独用一组橙色
#   小标题和徽章：分层的点阵字和月桂，背后的景压暗一圈，不和城市灯光抢
# 输出（assets/screensaver/）：
#   saver.png        320×240，不带徽章的整张
#   saver-badge.png  徽章那一层（透明底），独立的双月桂图层，在提示点整枚出现
#   saver-fx.png     运行时的动画遮罩：R 255 = 标题（扫光），R 128 = 红色障碍灯（慢闪）；G = 星星（255 亮、128 暗，闪烁）；
#                    B = 亮着的窗（偶尔关灯 / 开灯）
#   saver.json       尺寸、标题框、徽章框、机位
import argparse, json, math
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BAKED = ROOT / 'assets/baked'
OUT = ROOT / 'assets/screensaver'
FONTS = ROOT / 'assets/fonts'

GW, GH = 320, 240          # 像素画的格子（屏幕画布 1280×960，正好 4 倍）
B = 6                      # 先按 1920×1440 算，每 6×6 并成一格
W, H = GW * B, GH * B
PITCH, HFOV = 4.8, 69.0    # 和宣传片最后一帧一样：站在窗口，正对窗外，稍微抬头
BAYER = np.array([[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]]) / 16 + 1 / 32


def hexs(*h):
    return np.array([[int(x[i:i + 2], 16) / 255 for i in (1, 3, 5)] for x in h])


# ---------- 调色板（东京夜景，三十来色） ----------
SKY_P = hexs('#0b0c1a', '#11132a', '#181c38', '#212744', '#2c304c', '#3a3550')   # 天顶 → 地平线的雾
BODY_P = hexs('#06070d', '#0b0d16', '#11141f', '#181b29', '#202435', '#2a2e42',    # 楼身，冷 → 雾
              '#1e1812', '#2c2117', '#3d2c1c')                                         # 被路灯照暖的墙
WIN_P = hexs('#6e5634', '#a8803f', '#e0b45c', '#ffe39a',                               # 暖色窗
             '#5d6f80', '#9fb6c4', '#e8f2f4',                                          # 冷色窗
             '#c23a2e', '#d95fa0', '#5fd0a0')                                          # 障碍灯 / 招牌
TOWER_P = hexs('#5c1a0e', '#a8331a', '#ee5a24', '#ff8a3d', '#fff0d8')
TITLE_STOPS = ['#8a8aa6', '#c9b49a', '#ffd79a', '#fff0c8']                             # 字：冷顶 → 暖底
BEACON = hexs('#c23a2e')[0]


# ---------- 5×7 点阵字（小标题、徽章） ----------
GLYPHS = {
    'A': '.###.|#...#|#...#|#####|#...#|#...#|#...#', 'B': '####.|#...#|#...#|####.|#...#|#...#|####.',
    'C': '.###.|#...#|#....|#....|#....|#...#|.###.', 'D': '####.|#...#|#...#|#...#|#...#|#...#|####.',
    'E': '#####|#....|#....|####.|#....|#....|#####', 'F': '#####|#....|#....|####.|#....|#....|#....',
    'G': '.###.|#...#|#....|#.###|#...#|#...#|.####', 'H': '#...#|#...#|#...#|#####|#...#|#...#|#...#',
    'I': '.###.|..#..|..#..|..#..|..#..|..#..|.###.', 'J': '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
    'K': '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', 'L': '#....|#....|#....|#....|#....|#....|#####',
    'M': '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', 'N': '#...#|#...#|##..#|#.#.#|#..##|#...#|#...#',
    'O': '.###.|#...#|#...#|#...#|#...#|#...#|.###.', 'P': '####.|#...#|#...#|####.|#....|#....|#....',
    'Q': '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', 'R': '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    'S': '.####|#....|#....|.###.|....#|....#|####.', 'T': '#####|..#..|..#..|..#..|..#..|..#..|..#..',
    'U': '#...#|#...#|#...#|#...#|#...#|#...#|.###.', 'V': '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
    'W': '#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#.', 'X': '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    'Y': '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', 'Z': '#####|....#|...#.|..#..|.#...|#....|#####',
    '0': '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', '1': '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
    '2': '.###.|#...#|....#|...#.|..#..|.#...|#####', '3': '####.|....#|....#|.###.|....#|....#|####.',
    '4': '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', '5': '#####|#....|####.|....#|....#|#...#|.###.',
    '6': '..##.|.#...|#....|####.|#...#|#...#|.###.', '7': '#####|....#|...#.|..#..|.#...|.#...|.#...',
    '8': '.###.|#...#|#...#|.###.|#...#|#...#|.###.', '9': '.###.|#...#|#...#|.####|....#|...#.|.##..',
    '#': '.#.#.|.#.#.|#####|.#.#.|#####|.#.#.|.#.#.', '·': '.....|.....|.....|..#..|.....|.....|.....',
    '-': '.....|.....|.....|.###.|.....|.....|.....', ' ': '.....|.....|.....|.....|.....|.....|.....',
}
ACCENT = {'É': 'E'}   # 带尖音符的：底下的字 + 头上两个像素


def text_bits(txt, space=1):
    """一行点阵字 → 布尔数组（上面多留 2 行给尖音符）。"""
    cols = []
    for ch in txt.upper():
        base = ACCENT.get(ch, ch)
        g = np.array([[c == '#' for c in row] for row in GLYPHS.get(base, GLYPHS[' ']).split('|')])
        g = np.vstack([np.zeros((2, 5), bool), g])
        if ch in ACCENT:
            g[0, 3] = g[1, 2] = True
        cols.append(g)
        cols.append(np.zeros((9, space), bool))
    return np.hstack(cols[:-1])


# ---------- 全景 → 一张透视图 ----------
def load_layers(width=3840):
    out = []
    for f in ('view_far.webp', 'view_near.webp'):
        im = Image.open(BAKED / f).convert('RGBA').resize((width, int(width * 95 / 160)), Image.LANCZOS)
        a = np.asarray(im).astype(np.float32) / 255
        a[..., :3] *= a[..., 3:4]   # 预乘 alpha，插值时天空不会渗到楼边上
        out.append(a)
    return out


def rays(w, h, yaw=0.0):
    """镜头的视线（x 右、y 朝外、z 上；以窗户为准，yaw 往右为正）。"""
    t = math.tan(math.radians(HFOV) / 2)
    X, Y = np.meshgrid(((np.arange(w) + .5) / w * 2 - 1) * t, (1 - (np.arange(h) + .5) / h * 2) * t * h / w)
    d = np.stack([X, np.ones_like(X), Y], -1)
    cp, sp = math.cos(math.radians(PITCH)), math.sin(math.radians(PITCH))
    d = np.stack([d[..., 0], d[..., 1] * cp - d[..., 2] * sp, d[..., 1] * sp + d[..., 2] * cp], -1)
    cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
    d = np.stack([d[..., 0] * cy + d[..., 1] * sy, -d[..., 0] * sy + d[..., 1] * cy, d[..., 2]], -1)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def sample(pano, d, lon_rng, lat_rng, turn):
    """d 是屋里的方向；城市转了 turn 度，所以全景里的经度 = 屋里的经度 + turn。"""
    PH, PW, _ = pano.shape
    lon = np.degrees(np.arctan2(d[..., 0], d[..., 1])) + turn
    lat = np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1)))
    u = np.clip((lon - lon_rng[0]) / (lon_rng[1] - lon_rng[0]) * PW - .5, 0, PW - 1.001)
    v = np.clip((lat_rng[1] - lat) / (lat_rng[1] - lat_rng[0]) * PH - .5, 0, PH - 1.001)
    u0, v0 = u.astype(int), v.astype(int)
    fu, fv = (u - u0)[..., None], (v - v0)[..., None]
    a = pano[v0, u0] * (1 - fu) + pano[v0, u0 + 1] * fu
    b = pano[v0 + 1, u0] * (1 - fu) + pano[v0 + 1, u0 + 1] * fu
    return a * (1 - fv) + b * fv


def blocks(a):  # (H, W, …) → (GH, GW, B·B, …)
    s = a.shape[2:]
    return a.reshape(GH, B, GW, B, *s).swapaxes(1, 2).reshape(GH, GW, B * B, *s)


def nearest(c, pal):
    return pal[((c[..., None, :] - pal) ** 2).sum(-1).argmin(-1)]


def lum(c):
    return c[..., 0] * .3 + c[..., 1] * .59 + c[..., 2] * .11


def dither_t():
    return np.tile(BAYER, (GH // 4 + 1, GW // 4 + 1))[:GH, :GW]


def reduce_city(L, haze, litmin, dim):
    """一层全景 → 像素格上的 (颜色, 有没有楼, 是不是亮窗, 是不是塔)。
    一格里亮的像素够多就是一扇亮窗（取亮像素的平均色），不然就是楼身（取暗像素的平均色）：不会糊成一片灰黄。"""
    b = blocks(L)
    a = b[..., 3]
    rgb = b[..., :3] / np.maximum(a[..., None], 1e-4)
    lit = (lum(rgb) > 0.5) & (a > 0.5)
    tw = (rgb[..., 0] > 0.45) & (rgb[..., 0] > rgb[..., 1] * 1.55) & (rgb[..., 2] < rgb[..., 1] * 1.1) & (a > 0.3)

    def mean_where(m):
        w = (m * a)[..., None]
        return (rgb * w).sum(2) / np.maximum(w.sum(2), 1e-4)

    body = mean_where(~lit & (a > 0.5)) * 0.8 * dim
    body = body * (1 - haze) + SKY_P[3] * haze
    win = lit.mean(-1) > litmin
    col = np.where(win[..., None], nearest(mean_where(lit) * dim, WIN_P), nearest(body, BODY_P))
    tower = tw.mean(-1) > 0.10
    col[tower] = nearest(mean_where(tw)[tower] * 1.1, TOWER_P)
    return col, (a.mean(-1) > 0.5) | tower, win & ~tower, tower


def draw_sky(d, moon):
    lat = np.degrees(np.arcsin(d[..., 2]))
    th = dither_t()
    t = np.clip(1 - lat / 40, 0, 1) ** 1.25 * (len(SKY_P) - 1)
    i0 = np.floor(t).astype(int)
    img = SKY_P[np.clip(i0 + (t - i0 > th), 0, len(SKY_P) - 1)].copy()
    m = np.array(moon) / np.linalg.norm(moon)
    ang = np.degrees(np.arccos(np.clip((d * m).sum(-1), -1, 1)))
    halo = (ang < 3.2) & (ang > 1.0) & (th < np.clip((3.2 - ang) / 2.2, 0, 1) * 0.55)
    img[halo] = hexs('#4a4e6a')[0]
    img[ang < 1.05] = hexs('#c9cfd8')[0]
    img[ang < 0.8] = hexs('#f3f1e6')[0]
    stars = np.zeros((GH, GW), np.uint8)
    rng = np.random.default_rng(7)
    ys, xs, br = rng.integers(0, GH, 300), rng.integers(0, GW, 300), rng.random(300)
    for y, x, b in zip(ys, xs, br):
        if lat[y, x] > 6 and ang[y, x] > 4:
            bright = b > 0.7
            img[y, x] = hexs('#e8ecff' if bright else '#9aa3c0')[0]
            stars[y, x] = 255 if bright else 128
    return img, stars


def title_mask(txt, size, cy, track, weight):
    """1920×1440 上排好的标题（Cinzel 加粗）→ 像素格上的字（一格里盖住 42% 以上才算）。"""
    ft = ImageFont.truetype(str(FONTS / 'cinzel.woff2'), size)
    ft.set_variation_by_axes([weight])
    im = Image.new('L', (W, H))
    dr = ImageDraw.Draw(im)
    widths = [dr.textlength(ch, font=ft) for ch in txt]
    x = W / 2 - (sum(widths) + track * (len(txt) - 1)) / 2
    bb = dr.textbbox((0, 0), txt, font=ft)
    y = cy - (bb[1] + bb[3]) / 2
    for ch, w in zip(txt, widths):
        dr.text((x, y), ch, font=ft, fill=255)
        x += w + track
    m = np.asarray(im).astype(np.float32) / 255
    return blocks(m[..., None])[..., 0].mean(-1) > 0.42


def shift(m, dy, dx):
    out = np.zeros_like(m)
    ys, yd = (slice(dy, None), slice(None, -dy or None)) if dy >= 0 else (slice(None, dy), slice(-dy, None))
    xs, xd = (slice(dx, None), slice(None, -dx or None)) if dx >= 0 else (slice(None, dx), slice(-dx, None))
    out[ys, xs] = m[yd, xd]
    return out


def grow(m, r):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dy * dy + dx * dx <= r * r:
                out |= shift(m, dy, dx)
    return out


def banded(on, stops):
    """字里面：从上到下按几档颜色抖动过渡；最上面一行像素提亮一点（高光）。"""
    rows = np.nonzero(on.any(1))[0]
    y0, y1 = rows.min(), rows.max()
    st = hexs(*stops)
    k = np.clip((np.arange(GH) - y0) / max(1, y1 - y0), 0, 1)[:, None] * np.ones((1, GW)) * (len(st) - 1)
    i0 = np.floor(k).astype(int)
    fill = st[np.clip(i0 + (k - i0 > dither_t()), 0, len(st) - 1)]
    top = on & ~shift(on, 1, 0)
    fill[top] = np.minimum(1, fill[top] * 1.15 + 0.05)
    return fill


# Authored at the native CRT resolution. The five ink masks preserve the
# approved serifs, the two-cell mast clearance, and the two optical text sizes.
def centered(bits, cx, cy):
    canvas = Image.new('L', (GW, GH))
    glyphs = Image.fromarray(bits.astype('uint8'))
    canvas.paste(glyphs, (cx - glyphs.width // 2, cy - glyphs.height // 2))
    return np.asarray(canvas) != 0


def bounds(mask):
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]


def write_saver(clean, effects, args, turn):
    lettering = np.asarray(Image.open(Path(__file__).with_name('screensaver-lettering.png')))
    title, subtitle, legend, award, leaves = (lettering == i for i in range(1, 6))
    if args.title != 'SCENECV':
        title = title_mask(args.title, 200, 84 * B, 24, 760)
    if args.subtitle != 'STEP INTO YOUR RÉSUMÉ':
        subtitle = centered(text_bits(args.subtitle), 160, 108)
    if (args.rank, args.badge_line1) != ('22', 'TRENDODAY RISING'):
        legend = centered(text_bits(f'{args.badge_line1} · #{args.rank}'), 160, 185)
    if args.badge_line2 != 'TOP 25 RISING REPO OF THE DAY':
        award = centered(text_bits(args.badge_line2), 160, 195)
    if (args.rank, args.badge_line1, args.badge_line2) != ('22', 'TRENDODAY RISING', 'TOP 25 RISING REPO OF THE DAY'):
        # Give wider custom captions the gutter used by the default approved lockup.
        lettering_box = bounds(legend | award)
        if lettering_box:
            mid = np.arange(GW) < GW // 2
            left, right = leaves & mid, leaves & ~mid
            leaves = shift(left, 0, min(0, lettering_box[0] - bounds(left)[2] - 2))
            leaves |= shift(right, 0, max(0, lettering_box[2] - bounds(right)[0] + 2))

    # Same 1.06 framing as the photographic title: the mast moves from (132,60) to (140,57).
    xs = np.clip(np.rint((np.arange(GW) - 140) / 1.06 + 132).astype(int), 0, GW - 1)
    ys = np.clip(np.rint((np.arange(GH) - 57) / 1.06 + 60).astype(int), 0, GH - 1)
    city = clean[np.ix_(ys, xs)].copy()
    fx = effects[np.ix_(ys, xs)].copy()
    rim = grow(title, 1) | shift(title, 1, 1)
    city[rim] = [10, 11, 20]
    fx[rim] = 0
    if title.any():
        city[title] = np.rint(255 * banded(title, TITLE_STOPS)[title])
    fx[title, 0] = 255

    def print_ink(image, mask, color):
        rim = grow(mask, 1) | shift(mask, 1, 1)
        image[rim] = np.rint(image[rim] * .21)
        image[mask] = color
        return rim

    fx[print_ink(city, subtitle, [237, 224, 193])] = 0
    Image.fromarray(city).save(OUT / 'saver.png', optimize=True)
    Image.fromarray(fx).save(OUT / 'saver-fx.png', optimize=True)
    badge_path = OUT / 'saver-badge.png'
    badge_bounds = None
    if not args.no_badge:
        with_badge = city.copy()
        visible = np.zeros_like(title)
        for glyphs, color in [(legend, [225, 195, 133]), (award, [251, 235, 200]), (leaves, [224, 186, 117])]:
            visible |= print_ink(with_badge, glyphs, color)
        badge = np.zeros((GH, GW, 4), np.uint8)
        badge[visible, :3] = with_badge[visible]
        badge[visible, 3] = 255
        Image.fromarray(badge).save(badge_path, optimize=True)
        badge_bounds = bounds(visible)
    elif badge_path.exists():
        badge_path.unlink()
    meta = {'size': [GW, GH], 'pitch': PITCH, 'hfov': HFOV, 'turn': turn, 'band169': [30, 210],
            'title': bounds(title), 'subtitle': bounds(subtitle), 'badge': badge_bounds}
    (OUT / 'saver.json').write_text(json.dumps(meta, indent=2) + '\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--title', default='SCENECV')
    ap.add_argument('--subtitle', default='STEP INTO YOUR RÉSUMÉ')
    ap.add_argument('--rank', default='22')
    ap.add_argument('--badge-line1', default='TRENDODAY RISING')
    ap.add_argument('--badge-line2', default='TOP 25 RISING REPO OF THE DAY')
    ap.add_argument('--no-badge', action='store_true')
    args = ap.parse_args()

    view = json.loads((BAKED / 'view.json').read_text())
    pano, turn = view['pano'], float(view.get('turn', 0))
    moon3 = view.get('moon', [-0.33, 0.28, -1.0])                 # three 坐标 → 这里的 (x 右, y 朝外, z 上)
    moon = (moon3[0], -moon3[2], moon3[1])

    far, near = load_layers()
    d = rays(W, H)
    FAR = sample(far, d, pano['lon'], pano['lat'], turn)
    NEAR = sample(near, d, pano['lon'], pano['lat'], turn)
    dg = rays(GW, GH)

    clean, stars = draw_sky(dg, moon)
    fc, fp, fw, _ = reduce_city(FAR, haze=0.45, litmin=0.36, dim=0.82)
    nc, np_, nw, _ = reduce_city(NEAR, haze=0.0, litmin=0.22, dim=0.9)
    clean[fp] = fc[fp]
    clean[np_] = nc[np_]
    beacon = (np.abs(clean - BEACON).sum(-1) < 0.02) & (fp | np_)
    effects = np.zeros((GH, GW, 3), np.uint8)
    effects[beacon, 0] = 128
    effects[..., 1] = stars * ~(fp | np_)
    effects[((fw & fp) | (nw & np_)) & ~beacon, 2] = 255
    city = (np.clip(clean, 0, 1) * 255 + 0.5).astype(np.uint8)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray(city).save(OUT / 'scene.png', optimize=True)
    Image.fromarray(effects).save(OUT / 'scene-fx.png', optimize=True)
    write_saver(city, effects, args, turn)


if __name__ == '__main__':
    main()
