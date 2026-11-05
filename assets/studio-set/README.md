# City Studio 桌面设备

用本机 Blender 程序化制作的原创桌面套装，参考现代铝合金设备的设计语言；不是厂商 CAD，也未使用付费模型。

## 文件

- `studio-set.blend`：可编辑源文件，贴图已打包。包含独立的设备集合与预览布景集合。
- `studio-set.glb`：只导出显示器、主机、键盘、鼠标，不含桌子、灯光或相机。
- `preview-front.png` / `preview-back.png`：Cycles 正面／背面渲染。
- `manifest.json`：面数、部件名称和屏幕尺寸／位置。
- `screen.png`：原创屏幕画面；`key-legends.png`：键帽字符图集。

本地互动预览：<http://localhost:5173/lab/studio-set.html>。支持旋转、缩放、键鼠特写、背面视角和终端画面切换。

## 当前比例

- 显示器外壳：宽 736 mm、高 423 mm；含玻璃的厚度约 12 mm。
- 有效显示区域：716 × 402.75 mm，16:9。
- 显示器总高：约 542 mm。支架宽 55 mm，底座 142 × 168 mm。
- 主机：约 197 × 197 × 100 mm。
- 键盘：约 294 × 119 mm；鼠标：约 59 × 109 mm。

## 重建

首次生成贴图需在具有 Pillow 的 Python 环境中运行 `blender/studio_textures.py`。已有贴图时可以直接建模：

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python blender/build_studio_set.py
```

脚本位置：项目根目录的 `blender/build_studio_set.py`，尺寸和摆放均在其中定义。运行会更新此目录下的模型和渲染。

## 接入房间

Blender 坐标使用米、Z 向上、-Y 为正面；glTF 导出后为 Y 向上、+Z 为正面。四个顶层节点是 `Display`、`Computer`、`Keyboard`、`Mouse`，各自以桌面高度为原点。

`Screen` 是独立网格，带完整 0–1 UV，可替换成实时画布材质。预览页已演示动态替换；Three.js CanvasTexture 接入此 glTF 网格时设置 `flipY = false`。

模型使用标准金属度／粗糙度材质；字符和屏幕使用贴图。尚未接入现有房间的四层烘焙光照。正式替换时需保留材质纹理、生成独立的 lightmap UV、重烘焙并重新对齐点击热点。接口和散热孔为视觉细节，不是贯通结构；适用于网页观赏，不用于制造。
