"""Generate original screen artwork and the keyboard legend atlas. Requires Pillow."""
from pathlib import Path
import json
import math
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / 'assets' / 'studio-set'
OUT.mkdir(parents=True, exist_ok=True)
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'

# Key widths use standard keyboard units. Rows run from back to front.
ROWS = [
    [('esc', 1.25)] + [(f'F{i}', 1) for i in range(1, 13)] + [('power', 1.25)],
    [(x, 1) for x in ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']] + [('delete', 1.5)],
    [('tab', 1.5)] + [(x, 1) for x in list('QWERTYUIOP') + ['[', ']', '\\']],
    [('caps', 1.75)] + [(x, 1) for x in list('ASDFGHJKL') + [';', "'"]] + [('return', 1.75)],
    [('shift', 2.25)] + [(x, 1) for x in list('ZXCVBNM') + [',', '.', '/']] + [('shift', 2.25)],
    [('fn', 1), ('ctrl', 1), ('opt', 1), ('cmd', 1.25), ('', 5.5), ('cmd', 1.25), ('opt', 1), ('<', 1), ('^', 1), ('>', 1)],
]
atlas = Image.new('RGBA', (2048, 1024), (0, 0, 0, 0))
d = ImageDraw.Draw(atlas)
keys = []
for ri, row in enumerate(ROWS):
    for label, width in row:
        idx = len(keys)
        col, line = idx % 16, idx // 16
        size = 40 if len(label) < 3 else 25
        f = ImageFont.truetype(FONT, size)
        if label:
            d.text((col * 128 + 64, line * 128 + 64), label, font=f, fill=(37, 42, 46, 255), anchor='mm')
        keys.append(dict(label=label, width=width, row=ri, tile=idx))
atlas.save(OUT / 'key-legends.png')
(OUT / 'keys.json').write_text(json.dumps(keys, indent=2))

# Authored gradient wallpaper, independent of any third-party product artwork.
W, H = 1600, 900
im = Image.new('RGB', (W, H))
pixels = im.load()
for y in range(H):
    for x in range(W):
        u, v = x / W, y / H
        arc = math.exp(-((v - (0.74 - 0.35 * math.sin(u * 3.4))) / 0.08) ** 2)
        glow = math.exp(-((u - .8) ** 2 / .17 + (v - .38) ** 2 / .12))
        pixels[x, y] = (int(12 + 18 * glow + 16 * arc), int(20 + 42 * glow + 50 * arc), int(30 + 52 * glow + 54 * arc))
d = ImageDraw.Draw(im)
d.text((95, 75), 'C I T Y   /   S T U D I O', font=ImageFont.truetype(BOLD, 25), fill='#8da7b2')
d.text((90, 300), 'Make room', font=ImageFont.truetype(FONT, 106), fill='#eef0e8')
d.text((90, 420), 'for ideas.', font=ImageFont.truetype(FONT, 106), fill='#eef0e8')
d.line((95, 750, 1505, 750), fill='#4d606a', width=1)
d.text((95, 785), 'A QUIET PLACE TO BUILD.', font=ImageFont.truetype(FONT, 21), fill='#98a7ad')
d.text((1505, 785), '01 / AFTER HOURS', font=ImageFont.truetype(FONT, 21), fill='#98a7ad', anchor='ra')
im.save(OUT / 'screen.png')
print(OUT)
