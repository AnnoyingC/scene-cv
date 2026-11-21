# 窗外夜景的"照片感"后期（render_view.py 用）：Cycles 先渲出线性的高动态范围图（EXR），这里再做两件相机会做的事：
#   1. 光晕（bloom）：亮的地方往四周漫出一圈柔光——好几个尺度叠起来（窄的是镜头的眩光，宽的是雨夜空气里的散射）。
#      全景是透明底（天空在网页里画），光晕落在天空上的部分写进透明度：颜色 = 光晕 / a，a = 光晕最亮的通道。
#   2. AgX 色调映射（和 Blender 4.x 以后默认的一样）：高光慢慢压到发白，不会一刀切成一块平的颜色。
# 输入输出都是 numpy 数组 (高, 宽, 4)，第 0 行在最下面（Blender 的像素顺序）；输出是显示用的值（≈ gamma 2.2），直接存 8 位。
import numpy as np

AGX = np.array([[0.842479062253094, 0.0423282422610123, 0.0423756549057051],
                [0.0784335999999992, 0.878468636469772, 0.0784336],
                [0.0792237451477643, 0.0791661274605434, 0.879142973793104]], np.float32)
AGX_INV = np.array([[1.19687900512017, -0.0528968517574562, -0.0529716355144438],
                    [-0.0980208811401368, 1.15190312990417, -0.0980434501171241],
                    [-0.0990297440797205, -0.0989611768448433, 1.15107367264116]], np.float32)
EV_MIN, EV_MAX = -12.47393, 4.026069


def agx(rgb, exposure=0.0, punch=1.0):
    """线性 RGB → 显示值（AgX base contrast）。punch > 1 稍微提一点饱和度（AgX 偏灰）。"""
    v = np.maximum(rgb * (2.0 ** exposure), 1e-10) @ AGX
    v = np.clip((np.log2(v) - EV_MIN) / (EV_MAX - EV_MIN), 0, 1)
    x2 = v * v
    x4 = x2 * x2
    v = 15.5 * x4 * x2 - 40.14 * x4 * v + 31.96 * x4 - 6.868 * x2 * v + 0.4298 * x2 + 0.1191 * v - 0.00232
    v = np.clip(v @ AGX_INV, 0, 1)
    if punch != 1.0:
        lum = (v @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
        v = np.clip(lum + (v - lum) * punch, 0, 1)
    return v


def _box(a, r, axis):
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode='edge'), axis=axis, dtype=np.float32)
    n = a.shape[axis]
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return (hi - lo) / (2 * r + 1)


def blur(a, sigma):
    """近似高斯模糊（三遍方框模糊）；sigma 大的先缩小再放大（快）。"""
    k = 1
    while sigma / k > 12 and min(a.shape[:2]) // (k * 2) > 16:
        k *= 2
    h, w = a.shape[:2]
    b = a
    if k > 1:
        hh, ww = h // k, w // k
        b = a[:hh * k, :ww * k].reshape(hh, k, ww, k, -1).mean((1, 3))
    r = max(1, int(round(sigma / k - 0.5)))
    for _ in range(3):
        b = _box(_box(b, r, 0), r, 1)
    if k > 1:   # 放大回原尺寸（双线性）
        ys = np.clip((np.arange(h) + 0.5) / k - 0.5, 0, b.shape[0] - 1)
        xs = np.clip((np.arange(w) + 0.5) / k - 0.5, 0, b.shape[1] - 1)
        y0, x0 = ys.astype(int), xs.astype(int)
        y1, x1 = np.minimum(y0 + 1, b.shape[0] - 1), np.minimum(x0 + 1, b.shape[1] - 1)
        fy, fx = (ys - y0)[:, None, None], (xs - x0)[None, :, None]
        top = b[y0][:, x0] * (1 - fx) + b[y0][:, x1] * fx
        bot = b[y1][:, x0] * (1 - fx) + b[y1][:, x1] * fx
        b = top * (1 - fy) + bot * fy
    return b


def photo(rgba, px_per_deg, exposure=0.0, bloom=0.14, threshold=0.6, punch=1.3, sharpen=0.0):
    """rgba：Cycles 的线性结果（预乘透明度）。px_per_deg：每度多少像素（光晕的大小按角度定，不同分辨率看起来一样）。"""
    C, A = rgba[..., :3].astype(np.float32), rgba[..., 3:4].astype(np.float32)
    if sharpen:   # 反锐化蒙版（近景层）：边缘、窗格、招牌的字清楚一点
        C = np.maximum(C + sharpen * (C - blur(C, 0.9)), 0.0)
    lum = C @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    bright = C * np.clip((lum - threshold) / threshold, 0, 1)[..., None]
    glow = np.zeros_like(C)
    for deg, w in ((0.06, 0.45), (0.18, 0.3), (0.5, 0.17), (1.4, 0.08)):    # 眩光 → 雨雾里的散射
        glow += blur(bright, max(0.7, deg * px_per_deg)) * w
    glow *= bloom
    C2 = C + glow
    A2 = np.maximum(A, np.clip(glow.max(-1, keepdims=True) * 1.6, 0, 1))
    col = agx(C2 / np.maximum(A2, 1e-4), exposure, punch)
    return np.concatenate([col, A2], -1)
