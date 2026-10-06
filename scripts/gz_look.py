"""Scene setup for Tianhe: units, render settings, sky + sun (one direction), Guangzhou haze, night switch, cameras.

Day/night: every emissive material (window lights, street lamps, tower lighting) reads the shared node group
`GZ Night` (one Value node, 0 = day, 1 = full night). set_time_of_day() moves the sun and sky, dims the sun,
and sets that value, so a render or the M4 day-night cycle only has to call it.
"""
import math

import bpy
from mathutils import Vector

import gz_common as c

# Guangzhou mid-autumn afternoon: sun in the SW. Sky-node convention: rotation 0 puts the sun toward +Y.
SUN_ELEV = 34.0
SUN_ROT = 140.0          # toward SSW-ish, so the north-facing CBD skyline across the river is side-lit
SUN_COLOR = (1.0, 0.86, 0.70)
SUN_ENERGY = 3.0
HAZE_DENSITY = 0.00022   # Pearl River delta haze: kilometre-scale views fade, street views stay clear
HAZE_GLOW = 6e-6         # night emission per metre of haze path (sky glow)


def sun_vector(elev=SUN_ELEV, rot=SUN_ROT):
    """Unit vector from the scene toward the sun."""
    az = math.radians(rot + 90.0)
    e = math.radians(elev)
    return Vector((math.cos(az) * math.cos(e), math.sin(az) * math.cos(e), math.sin(e)))


def night_group():
    """Shared 0..1 night value (Value node inside a shader node group)."""
    ng = bpy.data.node_groups.get('GZ Night')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('GZ Night', 'ShaderNodeTree')
    ng.interface.new_socket('Night', in_out='OUTPUT', socket_type='NodeSocketFloat')
    v = ng.nodes.new('ShaderNodeValue'); v.name = 'night'; v.outputs[0].default_value = 0.0
    o = ng.nodes.new('NodeGroupOutput')
    ng.links.new(v.outputs[0], o.inputs[0])
    return ng


def setup_scene(engine='CYCLES'):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.name = 'Guangzhou Tianhe'
    s.unit_settings.system = 'METRIC'; s.unit_settings.scale_length = 1
    r = s.render
    r.engine = engine
    s.cycles.samples = 128
    s.cycles.use_adaptive_sampling = True; s.cycles.adaptive_threshold = 0.01
    s.cycles.use_denoising = True; s.cycles.denoiser = 'OPENIMAGEDENOISE'
    s.cycles.max_bounces = 8; s.cycles.glossy_bounces = 4; s.cycles.transmission_bounces = 6
    s.cycles.volume_bounces = 1; s.cycles.transparent_max_bounces = 12
    s.cycles.use_light_tree = True
    try:
        pref = bpy.context.preferences.addons['cycles'].preferences
        pref.compute_device_type = 'METAL'; pref.get_devices()
        for d in pref.devices: d.use = (d.type == 'METAL')
        if any(d.type == 'METAL' for d in pref.devices): s.cycles.device = 'GPU'
    except Exception as e:
        print('GPU setup', e)
    s.eevee.taa_render_samples = 32
    s.eevee.use_shadows = True
    s.eevee.use_raytracing = True
    s.eevee.volumetric_end = 16000; s.eevee.volumetric_tile_size = '8'; s.eevee.volumetric_samples = 48
    r.resolution_x, r.resolution_y, r.resolution_percentage = 2400, 1350, 100
    r.image_settings.file_format = 'PNG'; r.image_settings.color_mode = 'RGB'; r.image_settings.color_depth = '8'
    s.view_settings.view_transform = 'AgX'
    s.view_settings.look = 'AgX - Medium High Contrast'
    s.view_settings.exposure = -0.3

    w = bpy.data.worlds.new('Tianhe sky'); s.world = w
    w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    sky = nt.nodes.new('ShaderNodeTexSky')
    sky.sky_type = 'MULTIPLE_SCATTERING'
    sky.altitude = 20; sky.air_density = 1.0; sky.aerosol_density = 2.2; sky.ozone_density = 1.0
    sky.sun_disc = False
    bg = nt.nodes.new('ShaderNodeBackground'); bg.name = 'sky strength'; bg.inputs['Strength'].default_value = 0.25
    out = nt.nodes.new('ShaderNodeOutputWorld')
    # night: the sky node goes black below the horizon; blend toward the city's light-polluted glow
    # (brighter and warmer at the horizon, deep violet-grey overhead)
    ng = nt.nodes.new('ShaderNodeGroup'); ng.node_tree = night_group()
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    ramp = nt.nodes.new('ShaderNodeValToRGB'); nt.links.new(sep.outputs['Z'], ramp.inputs['Fac'])
    ramp.color_ramp.elements[0].position = 0.0; ramp.color_ramp.elements[0].color = (5.0, 3.6, 2.6, 1)
    ramp.color_ramp.elements[1].position = 0.35; ramp.color_ramp.elements[1].color = (0.9, 0.8, 1.2, 1)
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'
    nt.links.new(ng.outputs[0], mix.inputs['Factor'])
    nt.links.new(sky.outputs['Color'], next(i for i in mix.inputs if i.name == 'A' and i.type == 'RGBA'))
    nt.links.new(ramp.outputs['Color'], next(i for i in mix.inputs if i.name == 'B' and i.type == 'RGBA'))
    nt.links.new(next(o for o in mix.outputs if o.type == 'RGBA'), bg.inputs['Color'])
    nt.links.new(bg.outputs[0], out.inputs['Surface'])

    c.collection('90 • Cameras / light')
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.angle = math.radians(0.8)
    o = bpy.data.objects.new('Sun', sun); c.COL.objects.link(o)

    # Delta haze: a homogeneous volume slab over the whole map (render-only; exclude from exports).
    hz = bpy.data.materials.new('Atmosphere | delta haze')
    hz.use_nodes = True; n = hz.node_tree.nodes; n.clear()
    pv = n.new('ShaderNodeVolumePrincipled')
    pv.inputs['Color'].default_value = (0.86, 0.89, 0.93, 1)
    pv.inputs['Absorption Color'].default_value = (0.92, 0.92, 0.92, 1)   # near-pure scattering: haze brightens, not browns
    pv.inputs['Density'].default_value = HAZE_DENSITY
    pv.inputs['Anisotropy'].default_value = 0.5
    # night sky glow: the haze itself emits a little (city light scattered back), so long horizontal paths
    # glow at the horizon and the zenith stays dark
    pv.inputs['Emission Color'].default_value = (1.0, 0.72, 0.5, 1)
    ngn = n.new('ShaderNodeGroup'); ngn.node_tree = night_group()
    mul = n.new('ShaderNodeMath'); mul.operation = 'MULTIPLY'; mul.inputs[1].default_value = HAZE_GLOW
    hz.node_tree.links.new(ngn.outputs[0], mul.inputs[0]); hz.node_tree.links.new(mul.outputs[0], pv.inputs['Emission Strength'])
    mo = n.new('ShaderNodeOutputMaterial'); hz.node_tree.links.new(pv.outputs[0], mo.inputs['Volume'])
    c.collection('00 • Atmosphere')
    me = bpy.data.meshes.new('Delta haze volume')
    import bmesh
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me); bm.free(); me.materials.append(hz)
    box = bpy.data.objects.new('Delta haze volume', me); c.COL.objects.link(box)
    box.location = (800, -700, 340); box.scale = (46000, 46000, 700)
    box.visible_shadow = False; box.visible_diffuse = False; box.visible_glossy = False
    box['gz_role'] = 'render-only atmosphere; exclude from exports'

    night_group()
    set_time_of_day(s, 'day')
    s['Project'] = 'Guangzhou | Tianhe CBD (Zhujiang New Town) phase 1'
    s['Data'] = '(c) OpenStreetMap contributors, ODbL 1.0'
    s['Units'] = 'Metres; Z up; origin Huacheng Square axis (23.1205 N, 113.3192 E), X east, Y north'
    return s


# (sun elevation, sun rotation, sun colour, sun energy, sky strength, night value, exposure)
TIMES = {
    'day':   (SUN_ELEV, SUN_ROT, SUN_COLOR, SUN_ENERGY, 0.22, 0.0, -0.45),
    'dusk':  (4.0, 118.0, (1.0, 0.55, 0.32), 2.2, 0.20, 0.65, 0.2),
    'night': (-12.0, 118.0, (0.6, 0.7, 1.0), 0.0, 0.015, 1.0, 0.3),
}


def set_time_of_day(scene, name):
    elev, rot, col, energy, sky_k, night, expo = TIMES[name]
    sky = next(n for n in scene.world.node_tree.nodes if n.type == 'TEX_SKY')
    sky.sun_elevation = math.radians(max(elev, -5)); sky.sun_rotation = math.radians(rot)
    scene.world.node_tree.nodes['sky strength'].inputs['Strength'].default_value = sky_k
    o = bpy.data.objects['Sun']
    o.data.color = col; o.data.energy = energy
    o.hide_render = energy <= 0
    o.rotation_euler = (-sun_vector(max(elev, 1), rot)).to_track_quat('-Z', 'Y').to_euler()
    night_group().nodes['night'].outputs[0].default_value = night
    scene.view_settings.exposure = expo
    scene['time_of_day'] = name


def camera(name, loc, target, lens=35, ortho=None):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens; cam.sensor_width = 36; cam.clip_start = 1.0; cam.clip_end = 30000
    if ortho:
        cam.type = 'ORTHO'; cam.ortho_scale = ortho
    o = bpy.data.objects.new(name, cam); c.COL.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return o


def cameras(bounds):
    """Named review cameras. Positions are scene metres (origin Huacheng Square, X east, Y north).
    Landmarks: West Tower ~(-135,-20), East Tower ~(143,-28), Canton Tower ~(-7,-1270), axis at x ~ 0."""
    c.collection('90 • Cameras / light')
    x0, y0, x1, y1 = bounds
    cams = [
        # the postcard: from Canton Tower's upper deck, straight up the axis to the twin towers
        camera('GZ 01 • Axis from Canton Tower', (40, -1180, 440), (0, 150, 90), 32),
        # across the river at the south embankment, low, looking north-west at the skyline
        camera('GZ 02 • River skyline', (520, -1060, 18), (-40, -60, 150), 30),
        # street level on the Huacheng Square axis, looking north between the towers
        camera('GZ 03 • Huacheng Square', (4, -420, 1.7), (0, 200, 90), 24),
        # high oblique from the south-east over Liede
        camera('GZ 04 • Aerial from the south-east', (1900, -2150, 1050), (150, -250, 60), 40),
        # landmark review: Canton Tower from the north bank, twin towers up the axis, opera/museum/library block
        camera('GZ 06 • Canton Tower', (330, -820, 60), (-7, -1270, 300), 26),
        camera('GZ 07 • Twin towers from Haixinsha', (-10, -640, 40), (0, -20, 250), 22),
        camera('GZ 08 • Opera House and Museum', (60, -640, 170), (-60, -290, 5), 32),
        camera('GZ 09 • Liede Bridge', (1250, -720, 40), (955, -800, 60), 30),
        # plan
        camera('GZ 05 • Plan', ((x0 + x1) / 2, (y0 + y1) / 2, 3000), ((x0 + x1) / 2, (y0 + y1) / 2 + 0.01, 0), 50,
               ortho=max(x1 - x0, y1 - y0) * 1.02),
    ]
    bpy.context.scene.camera = cams[0]
    return cams
