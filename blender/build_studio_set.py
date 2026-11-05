"""Original contemporary desktop set, metres, Blender Z-up, front facing -Y.

Blender -b --factory-startup --python blender/build_studio_set.py
Outputs editable .blend, web-ready .glb, manifest and two Cycles previews.
This models a visual approximation, not manufacturer CAD or a purchased asset.
"""
from pathlib import Path
import json
import math
import sys
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets' / 'studio-set'
OUT.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(ROOT / 'blender'))
from shared import srgb, tree, use_metal

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
asset_collection = bpy.data.collections.new('CITY STUDIO | export assets')
scene.collection.children.link(asset_collection)
stage_collection = bpy.data.collections.new('Preview stage | not exported')
scene.collection.children.link(stage_collection)
current_collection = asset_collection

def add(ob):
    for c in list(ob.users_collection):
        c.objects.unlink(ob)
    current_collection.objects.link(ob)
    return ob

def material(name, color, metal=0, rough=.4):
    mat = bpy.data.materials.new(name)
    nt = tree(mat)
    bs = nt.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*srgb(color), 1)
    bs.inputs['Metallic'].default_value = metal
    bs.inputs['Roughness'].default_value = rough
    mat.diffuse_color = (*srgb(color), 1)
    return mat

silver = material('Satin aluminium', '#bbc1c7', .82, .29)
edge = material('Machined aluminium edge', '#d5d9df', .9, .21)
dark = material('Graphite polymer', '#171b20', .05, .46)
glass = material('Black display bezel', '#070b10', .12, .21)
rubber = material('Soft black rubber', '#131519', 0, .8)
keymat = material('Porcelain keycaps', '#e3e5e4', .02, .36)
mousemat = material('Pearl mouse shell', '#ededeb', .08, .22)
portmat = material('Port interior', '#07090b', 0, .6)
blue = material('Camera lens', '#1d4861', .55, .12)
led = material('Status light', '#e4f9ef', 0, .3)
bs = led.node_tree.nodes.get('Principled BSDF')
bs.inputs['Emission Color'].default_value = (*srgb('#c3ffe5'), 1)
bs.inputs['Emission Strength'].default_value = 2

def image_material(name, file, emit=False, alpha=False):
    mat = material(name, '#ffffff', 0, .38)
    nt = mat.node_tree
    bs = nt.nodes.get('Principled BSDF')
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(str(OUT / file), check_existing=True)
    nt.links.new(tex.outputs['Color'], bs.inputs['Base Color'])
    if emit:
        nt.links.new(tex.outputs['Color'], bs.inputs['Emission Color'])
        bs.inputs['Emission Strength'].default_value = .65
        bs.inputs['Roughness'].default_value = .42
    if alpha:
        nt.links.new(tex.outputs['Alpha'], bs.inputs['Alpha'])
        mat.surface_render_method = 'DITHERED'
    return mat

screenmat = image_material('Screen | replace with live canvas', 'screen.png', emit=True)
legendmat = image_material('Keyboard legends atlas', 'key-legends.png', alpha=True)

def mesh(name, verts, faces, mat, parent=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    ob = bpy.data.objects.new(name, data)
    current_collection.objects.link(ob)
    data.materials.append(mat)
    ob.parent = parent
    return ob

def group(name, loc):
    ob = bpy.data.objects.new(name, None)
    current_collection.objects.link(ob)
    ob.location = loc
    ob['asset_role'] = name
    return ob

def outline(w, d, r, steps=8):
    pts = []
    for cx, cy, start in [(w/2-r, d/2-r, 0), (-w/2+r, d/2-r, 90), (-w/2+r, -d/2+r, 180), (w/2-r, -d/2+r, 270)]:
        for j in range(steps + 1):
            a = math.radians(start + j * 90 / steps)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts

def rounded(name, dims, pos, radius, mat, parent=None, bevel=.0007, rot=None, steps=8):
    w, d, h = dims
    b = min(bevel, h / 3, radius / 2)
    layers = [(b, -h/2), (0, -h/2+b), (0, h/2-b), (b, h/2)]
    verts = []
    for inset, z in layers:
        verts.extend((x, y, z) for x, y in outline(w - 2*inset, d - 2*inset, max(.00001, radius-inset), steps))
    n = len(verts) // 4
    faces = [tuple(reversed(range(n))), tuple(range(3*n, 4*n))]
    for k in range(3):
        for i in range(n):
            j = (i+1) % n
            faces.append((k*n+i, k*n+j, (k+1)*n+j, (k+1)*n+i))
    ob = mesh(name, verts, faces, mat, parent)
    ob.location = pos
    if rot:
        ob.rotation_euler = rot
    for p in ob.data.polygons:
        p.use_smooth = len(p.vertices) == 4
    norm = ob.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    norm.keep_sharp = True
    return ob

def cylinder(name, radius, depth, pos, mat, parent=None, rot=None, vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=pos)
    ob = add(bpy.context.object)
    ob.name = name
    ob.parent = parent
    if rot:
        ob.rotation_euler = rot
    ob.data.materials.append(mat)
    for p in ob.data.polygons:
        p.use_smooth = len(p.vertices) == 4
    return ob

def uvquad(name, verts, mat, parent=None, uv=None):
    ob = mesh(name, verts, [(0, 1, 2, 3)], mat, parent)
    layer = ob.data.uv_layers.new(name='UVMap')
    uv = uv or [(0, 0), (1, 0), (1, 1), (0, 1)]
    for i, xy in enumerate(uv):
        layer.data[i].uv = xy
    return ob

display = group('Display', (0, .11, 0))
display['dimensions_note'] = '736 x 423 mm panel; approx 12 mm overall thickness; 542 mm overall height'
RX = (math.pi/2, 0, 0)
rounded('Display / rear aluminium housing', (.736, .423, .010), (0, 0, .330), .012, silver, display, .00065, RX)
rounded('Display / polished perimeter', (.735, .422, .0012), (0, -.0051, .330), .0115, edge, display, .0002, RX)
rounded('Display / black glass bezel', (.733, .420, .001), (0, -.0060, .330), .0105, glass, display, .00015, RX)
sw, sh, sy, sz = .716, .40275, -.0066, .330
screen = uvquad('Screen', [(-sw/2, sy, sz-sh/2), (sw/2, sy, sz-sh/2), (sw/2, sy, sz+sh/2), (-sw/2, sy, sz+sh/2)], screenmat, display)
screen['purpose'] = 'Replace material with live CanvasTexture; retain this UV and screen geometry.'
cylinder('Display / webcam', .0017, .0004, (0, -.0066, .536), portmat, display, RX)
cylinder('Display / lens reflection', .0008, .0005, (0, -.0067, .536), blue, display, RX)
# Sculptural foot and angled stem, kept as separate editable parts.
rounded('Display / base', (.142, .168, .005), (0, .007, .0055), .014, silver, display, .0008)
rounded('Display / underside pad', (.129, .151, .0025), (0, .009, .0018), .012, rubber, display)
stem = rounded('Display / stand', (.055, .010, .241), (0, .031, .125), .004, silver, display, .00065)
stem.rotation_euler.x = .13
cylinder('Display / tilt hinge', .011, .053, (0, .015, .244), silver, display, (0, math.pi/2, 0), 32)
# Rear service panel, exhaust and ports, visible in the second preview.
rounded('Display / rear inset', (.080, .060, .001), (0, .0055, .270), .008, silver, display, .0002, RX)
for i in range(38):
    rounded(f'Display / vent {i:02}', (.005, .0015, .001), ((i-18.5)*.011, .0055, .133), .0005, dark, display, .0001, RX, 3)
for i in range(4):
    rounded(f'Display / USB-C {i+1}', (.0084, .0030, .001), (.155+i*.018, .0055, .142), .0014, portmat, display, .0001, RX, 4)

computer = group('Computer', (-.455, .075, 0))
rounded('Computer / base', (.184, .184, .007), (0, 0, .005), .03, rubber, computer, .001)
rounded('Computer / aluminium body', (.197, .197, .091), (0, 0, .0525), .034, silver, computer, .002, steps=12)
rounded('Computer / top machining line', (.192, .192, .0014), (0, 0, .0984), .031, edge, computer, .0002, steps=12)
for x in [-.058, -.035]:
    rounded('Computer / front USB-C', (.009, .0034, .001), (x, -.0989, .052), .0015, portmat, computer, .0001, RX, 4)
rounded('Computer / card slot', (.026, .0022, .001), (.002, -.0989, .052), .0007, portmat, computer, .0001, RX, 4)
cylinder('Computer / status LED', .0012, .001, (.061, -.099, .052), led, computer, RX, 16)
for row in range(4):
    for col in range(19):
        cylinder('Computer / rear cooling aperture', .0017, .001, ((col-9)*.0075, .0987, .073+row*.005), dark, computer, RX, 8)
for i, w in enumerate([.013, .013, .009, .009, .016]):
    rounded('Computer / rear I/O', (w, .007, .001), (-.064+i*.026, .099, .033), .0012, portmat, computer, .0001, RX, 4)

keyboard = group('Keyboard', (-.045, -.238, 0))
rounded('Keyboard / rubber underside', (.288, .113, .003), (0, 0, .002), .009, rubber, keyboard)
rounded('Keyboard / aluminium tray', (.294, .119, .007), (0, 0, .0065), .011, silver, keyboard, .001, steps=10)
rounded('Keyboard / dark key well', (.284, .109, .001), (0, 0, .0102), .007, dark, keyboard, .0002)
keys = json.loads((OUT/'keys.json').read_text())
pitch = .0187
for row in range(6):
    rk = [k for k in keys if k['row'] == row]
    length = sum(k['width'] for k in rk)*pitch
    x = -length/2
    y = .044 - row*.0177
    for key in rk:
        w = key['width']*pitch
        cx = x+w/2
        height = .010 if row == 0 else .0146
        rounded('Key / '+(key['label'] or 'space'), (w-.0023, height, .0035), (cx, y, .0125), .0022, keymat, keyboard, .0005, steps=3)
        if key['label']:
            tile = key['tile']
            u0, u1 = tile % 16 / 16, (tile % 16 + 1)/16
            v0, v1 = 1 - (tile//16 + 1)/8, 1 - tile//16/8
            q = .0063 if row else .0046
            uvquad('Legend / '+key['label'], [(cx-q, y-q, .01432), (cx+q, y-q, .01432), (cx+q, y+q, .01432), (cx-q, y+q, .01432)], legendmat, keyboard, [(u0,v0),(u1,v0),(u1,v1),(u0,v1)])
        x += w
rounded('Keyboard / rear charging port', (.008, .0026, .001), (0, .0597, .006), .0012, portmat, keyboard, .0001, RX, 4)

mouse = group('Mouse', (.224, -.242, 0))
rounded('Mouse / lower edge', (.059, .109, .005), (0, 0, .005), .025, silver, mouse, .0008, steps=12)
rounded('Mouse / underside', (.051, .095, .0025), (0, 0, .0016), .021, rubber, mouse, .0005)
# Low, continuous ellipsoidal touch surface rather than a rounded cube.
verts, faces = [], []
N = 64
for r, z in [(1, .007), (.99, .010), (.94, .0145), (.84, .019), (.65, .0235), (.38, .026), (.08, .027)]:
    for i in range(N):
        a = i*math.tau/N
        # Superellipse gives a full, soft rectangular outline.
        c, s = math.cos(a), math.sin(a)
        verts.append((.0295*r*math.copysign(abs(c)**.78,c), .0545*r*math.copysign(abs(s)**.78,s), z))
for k in range(6):
    for i in range(N):
        j = (i+1)%N
        faces.append((k*N+i, k*N+j, (k+1)*N+j, (k+1)*N+i))
faces.append(tuple(range(6*N,7*N)))
shell = mesh('Mouse / continuous touch shell', verts, faces, mousemat, mouse)
for p in shell.data.polygons:
    p.use_smooth = True

# Consolidate repeated details by material within each device for fewer draw calls.
# Preserve the interactive screen as its own named mesh.
for root in [display, computer, keyboard, mouse]:
    buckets = {}
    for ob in list(root.children):
        if ob.type == 'MESH' and ob != screen:
            buckets.setdefault(ob.data.materials[0].name, []).append(ob)
    for matname, obs in buckets.items():
        for ob in obs:
            bpy.ops.object.select_all(action='DESELECT')
            ob.select_set(True)
            bpy.context.view_layer.objects.active = ob
            for mod in list(ob.modifiers):
                bpy.ops.object.modifier_apply(modifier=mod.name)
        if len(obs) > 1:
            bpy.ops.object.select_all(action='DESELECT')
            for ob in obs:
                ob.select_set(True)
            bpy.context.view_layer.objects.active = obs[0]
            bpy.ops.object.join()
        obs[0].name = root.name+' / '+matname

bpy.ops.object.select_all(action='DESELECT')
for ob in asset_collection.objects:
    ob.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT/'studio-set.glb'), export_format='GLB', use_selection=True,
                          export_yup=True, export_apply=True, export_materials='EXPORT',
                          export_cameras=False, export_lights=False, export_extras=True)
tris = 0
for ob in asset_collection.objects:
    if ob.type == 'MESH':
        ob.data.calc_loop_triangles()
        tris += len(ob.data.loop_triangles)
manifest = dict(name='City Studio desktop set', units='metres', blender_front='-Y', gltf_front='+Z',
                original_procedural_model=True, triangles=tris,
                meshes=sum(o.type=='MESH' for o in asset_collection.objects),
                groups=['Display','Computer','Keyboard','Mouse'], screen_mesh='Screen',
                screen_size=[sw,sh], screen_center_gltf=[0,sz,-(.11+sy)],
                note='Standalone assets, no baked room lightmaps. Use PBR or rebake when integrating.')
(OUT/'manifest.json').write_text(json.dumps(manifest, indent=2))
print('[studio-set]', json.dumps(manifest), flush=True)

# Separate preview stage: walnut surface and a restrained blue/warm studio environment.
current_collection = stage_collection
wood = material('Stage / dark walnut', '#493020', 0, .38)
nt = wood.node_tree
bs = nt.nodes.get('Principled BSDF')
coords = nt.nodes.new('ShaderNodeTexCoord')
mapping = nt.nodes.new('ShaderNodeVectorMath'); mapping.operation='MULTIPLY'
mapping.inputs[1].default_value=(3,180,5)
nt.links.new(coords.outputs['Generated'],mapping.inputs[0])
noise=nt.nodes.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value=2.5
noise.inputs['Detail'].default_value=2
nt.links.new(mapping.outputs['Vector'],noise.inputs['Vector'])
ramp=nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color=(*srgb('#241910'),1)
ramp.color_ramp.elements[1].color=(*srgb('#6a4730'),1)
nt.links.new(noise.outputs['Fac'],ramp.inputs[0]); nt.links.new(ramp.outputs[0],bs.inputs['Base Color'])
rounded('Stage / walnut desktop', (2.2, 1.35, .045), (0, 0, -.027), .025, wood, bevel=.004)
padmat=material('Stage / charcoal desk mat','#20272b',0,.9)
rounded('Stage / felt desk mat', (.66,.26,.002), (-.015,-.225,-.0001),.022,padmat,bevel=.0003)
ground=material('Stage / background','#121c26',0,.85)
rounded('Stage / floor',(200,200,.02),(0,0,-.065),.01,ground)

def area(name, pos, target, color, power, size, size_y=None):
    data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.color=color
    data.shape='RECTANGLE'; data.size=size; data.size_y=size_y or size
    ob=bpy.data.objects.new(name,data); stage_collection.objects.link(ob)
    ob.location=pos; ob.rotation_euler=(Vector(target)-ob.location).to_track_quat('-Z','Y').to_euler()
    return ob

area('Key / warm softbox',(-.8,-.7,1.4),(0,0,.2),(1,.84,.69),100,1.1)
area('Rim / city blue',(.65,.55,1.05),(0,0,.2),(.55,.74,1),120,.7,1.3)
area('Front / broad reflection',(0,-1.3,.75),(0,0,.24),(.88,.94,1),35,1.8,.8)
world=bpy.data.worlds.new('Midnight studio')
scene.world=world
world.color=(.12,.12,.12)
nt=tree(world)
nt.nodes.get('Background').inputs[0].default_value=(.15,.19,.26,1)
nt.nodes.get('Background').inputs[1].default_value=.25
use_metal(scene,32)
scene.cycles.use_denoising=True
scene.render.resolution_x=1600
scene.render.resolution_y=1100
scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
camera_data=bpy.data.cameras.new('Preview Camera')
camera=bpy.data.objects.new('Preview Camera',camera_data)
stage_collection.objects.link(camera)
scene.camera=camera
camera_data.type='ORTHO'; camera_data.ortho_scale=1.46
def aim(pos,target):
    camera.location=pos
    camera.rotation_euler=(Vector(target)-camera.location).to_track_quat('-Z','Y').to_euler()
aim((.95,-1.65,.95),(-.085,-.015,.245))
for image in bpy.data.images:
    if image.source=='FILE':
        image.pack()
    if image.source == 'FILE':
        image.filepath = '//' + Path(image.filepath).name
        for packed in image.packed_files:
            packed.filepath = '//' + Path(packed.filepath).name
# Do not embed the local .blend filename or render-machine details in PNG metadata.
scene.render.use_stamp = False
scene.render.use_stamp_note = False
scene.render.stamp_note_text = ''
for prop in scene.render.bl_rna.properties:
    if prop.identifier.startswith('use_stamp') and prop.type == 'BOOLEAN':
        setattr(scene.render, prop.identifier, False)
scene.render.filepath=str(OUT/'preview-front.png')
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'studio-set.blend'))
bpy.ops.render.render(write_still=True)
aim((-.9,1.45,.95),(-.12,.01,.20))
scene.render.filepath=str(OUT/'preview-back.png')
bpy.ops.render.render(write_still=True)
print('[studio-set] FINISHED',flush=True)
