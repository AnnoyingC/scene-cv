# 两个 Blender 脚本（render_view.py、bake_room.py）共用的布局常量和小工具。
# 尺寸一律按 three.js 的写法：Y 向上，单位米，后墙在 z = BACK，房间朝 +z 方向延伸。
import argparse
import math
import os
import sys
import warnings

import bpy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'baked')

TOP = 0.76                                  # 桌面高度
BACK = -2.0                                 # 后墙（有窗户的那面）
ROOM = dict(x0=-1.8, x1=1.5, z1=1.0, h=2.7)  # 左右墙、前墙、墙高：3.3 × 3.0 米的小书房，东西都挨着后墙，伸手够得着
WIN = dict(x=0.34, y=1.5, w=1.8, h=1.1, depth=0.15)  # 书桌和电视后面的窗：中心、宽高、墙厚（开场镜头里窗户占满画面上半部分）
MOON = (-0.33, 0.28, -1.0)                  # 从屋里看出去，月亮在左上方（要落在窗框里）
# 窗外：从窗口中心往外渲染，水平视角 110°，宽高比 2:1；离地 22 米（七八楼）。
# split 米以内是近景卡片（带透明），以外是远景卡片（带天空）。浏览器里两张卡片分别放在窗外 near / far 米处。
VIEW = dict(hfov=110.0, aspect=2.0, height=22.0, split=250.0, near=10.0, far=40.0)
HORIZON = '#3a2a40'                         # 地平线的雾色（城市光污染），天空和建筑的雾共用


def get_args(**defaults):
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    ap = argparse.ArgumentParser()
    for k, v in defaults.items():
        ap.add_argument('--' + k.replace('_', '-'), dest=k, type=type(v), default=v)  # skip_bake → --skip-bake
    return ap.parse_args(argv)


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def rgba(h):
    return (*srgb(h), 1.0)


def tree(idblock):
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        try:
            idblock.use_nodes = True  # Blender 5 里已弃用（总是 True）
        except Exception:
            pass
    return idblock.node_tree


def clear_scene():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)


def use_metal(scene, samples):
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'METAL'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = samples


class Nodes:
    """少写点 nodes.new / links.new 的样板代码。值可以是常量，也可以是另一个节点的输出口。"""

    def __init__(self, nt):
        self.nt = nt
        nt.nodes.clear()

    def new(self, kind, inputs=None, **props):
        n = self.nt.nodes.new(kind)
        for k, v in props.items():
            setattr(n, k, v)
        for k, v in (inputs or {}).items():
            self.put(n.inputs[k], v)
        return n

    def put(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.nt.links.new(v, sock)
        else:
            sock.default_value = v

    def math(self, op, a, b=0.0):
        n = self.new('ShaderNodeMath', operation=op)
        self.put(n.inputs[0], a)
        self.put(n.inputs[1], b)
        return n.outputs[0]

    def vec(self, op, a, b=None, scale=None):
        n = self.new('ShaderNodeVectorMath', operation=op)
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        if scale is not None:
            self.put(n.inputs['Scale'], scale)
        return n.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else n.outputs['Vector']

    def ramp(self, fac, stops):
        n = self.new('ShaderNodeValToRGB')
        self.put(n.inputs[0], fac)
        els = n.color_ramp.elements
        els[0].position, els[0].color = stops[0][0], rgba(stops[0][1])
        els[1].position, els[1].color = stops[-1][0], rgba(stops[-1][1])
        for pos, col in stops[1:-1]:
            e = els.new(pos)
            e.color = rgba(col)
        return n.outputs['Color']

    def xyz(self, v):
        n = self.new('ShaderNodeSeparateXYZ')
        self.put(n.inputs[0], v)
        return n.outputs['X'], n.outputs['Y'], n.outputs['Z']


# ---------- 城堡塔楼（bake_tower.py、render_tower_view.py）----------
# 塔楼内部是正 16 边形：内切圆半径 r、墙高 h、墙厚 wall。第 0 面墙（z = -r，正对开场镜头）开一扇尖拱窗。
TOWER_OUT = os.path.join(ROOT, 'assets', 'tower')
TOWER = dict(n=16, r=3.3, h=4.2, wall=0.75)
# 尖拱窗：屋里那一侧开口宽 1 米（墙洞往外收窄，城堡窗的样子），玻璃那一侧只有 0.5 米宽、1.8 米高
TOWER_WIN = dict(w=0.5, y0=1.05, spring=2.42, inner_w=1.0, inner_y0=0.62, inner_spring=2.25)
TOWER_MOON = (-0.1, 0.62, -0.78)            # 月亮偏左、仰角约 38°：月光从窄窗斜射进来，落在窗前的地板上
# 窗外：从玻璃中心往外渲染，水平视角 70°，方图；离湖面 48 米。split 米以内是近景卡片（透明底）
TOWER_VIEW = dict(hfov=70.0, aspect=1.0, height=48.0, split=320.0, near=8.0, far=30.0)
TOWER_HORIZON = '#2a3550'                   # 远山的雾色（月夜，偏冷）
