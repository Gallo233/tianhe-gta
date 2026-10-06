"""Render the Tianhe review cameras.

    Blender --background guangzhou/tianhe_core.blend --python guangzhou/scripts/render_tianhe.py -- \
        [--engine eevee|cycles] [--samples N] [--pct P] [--cams 01,02] [--time day|dusk|night] [--tag name]

Writes guangzhou/renders/<tag>/<camera>.png (tag defaults to engine_time). Does not save the .blend.
"""
import os
import sys

import bpy

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
sys.path.insert(0, SCRIPTS)
import gz_look  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


s = bpy.context.scene
engine = arg('--engine', 'eevee')
tod = arg('--time', 'day')
s.render.engine = 'BLENDER_EEVEE' if engine == 'eevee' else 'CYCLES'
if engine == 'cycles':
    s.cycles.samples = int(arg('--samples', 128))
else:
    s.eevee.taa_render_samples = int(arg('--samples', 32))
haze = bpy.data.objects.get('Delta haze volume')
if haze:
    haze.hide_render = arg('--haze', 'on') == 'off'
s.render.resolution_percentage = int(arg('--pct', 50))
gz_look.set_time_of_day(s, tod)
out = os.path.join(ROOT, 'renders', arg('--tag', '%s_%s' % (engine, tod)))
os.makedirs(out, exist_ok=True)
want = arg('--cams')
cams = sorted((o for o in s.objects if o.type == "CAMERA"), key=lambda o: o.name)
for cam in cams:
    num = cam.name.split(' ')[1]
    if want and num not in want.split(','):
        continue
    s.camera = cam
    s.render.filepath = os.path.join(out, cam.name.split(' • ')[0].replace(' ', '_') + '_' + cam.name.split(' • ')[1].replace(' ', '_') + '.png')
    bpy.ops.render.render(write_still=True)
    print('[render] saved', s.render.filepath, flush=True)
