"""Read-only inventory of reference .blend files; run with Blender --disable-autoexec.

Usage: blender -b --factory-startup --disable-autoexec --python scripts/inspect_reference_blend.py -- <reference-dir> <report.json>
The source files are never saved. Counts describe stored meshes, before modifiers.
"""
import bpy
import collections
import json
import pathlib
import sys

args = sys.argv[sys.argv.index('--') + 1:]
root, output = map(pathlib.Path, args)
local_files = {p.name: str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}
reports = []
for source in sorted(root.glob('*.blend')):
    bpy.ops.wm.open_mainfile(filepath=str(source.resolve()), load_ui=False, use_scripts=False)
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    modifier_counts = collections.Counter(m.type for o in meshes for m in o.modifiers)
    image_records = []
    for image in bpy.data.images:
        if image.source not in {'FILE', 'TILED'}:
            continue
        resolved = pathlib.Path(bpy.path.abspath(image.filepath))
        basename = image.filepath.replace('\\', '/').rsplit('/', 1)[-1]
        image_records.append({'name': image.name, 'size': list(image.size),
                              'packed': bool(image.packed_file), 'path_resolves': resolved.is_file(),
                              'matching_local_file': local_files.get(basename)})
    report = {
        'file': source.name,
        'objects': dict(collections.Counter(o.type for o in bpy.data.objects)),
        'stored_polygons': sum(len(o.data.polygons) for o in meshes),
        'modifiers': dict(modifier_counts),
        'materials': len(bpy.data.materials),
        'collections': [c.name for c in bpy.data.collections],
        'images': image_records,
        'meshes': [{'name': o.name, 'polygons': len(o.data.polygons),
                    'uv_layers': [u.name for u in o.data.uv_layers],
                    'dimensions': [round(v, 4) for v in o.dimensions],
                    'modifiers': [m.type for m in o.modifiers]} for o in meshes],
        'lights': [{'name': o.name, 'type': o.data.type, 'energy': o.data.energy}
                   for o in bpy.data.objects if o.type == 'LIGHT'],
    }
    reports.append(report)
    print(json.dumps({k: report[k] for k in ('file', 'objects', 'stored_polygons', 'modifiers', 'materials')}, ensure_ascii=False))
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'note': 'Read-only inventory. Stored mesh counts exclude evaluated modifiers.', 'files': reports}, ensure_ascii=False, indent=2) + '\n')
