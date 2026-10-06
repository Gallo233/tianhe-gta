"""Quick EEVEE previews from hand-placed cameras (Blender coordinates), for photo comparisons.

    "$B" --background guangzhou/tianhe_core.blend --python guangzhou/scripts/preview_shots.py -- OUTDIR TIME name:ex,ey,ez:tx,ty,tz ...
"""
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(__file__))
import gz_look  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:]
out, tod, shots = args[0], args[1], args[2:]
sc = bpy.context.scene
gz_look.set_time_of_day(sc, tod)
sc.render.engine = 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 1280, 800
sc.render.resolution_percentage = 100
sc.eevee.taa_render_samples = 32
cam = bpy.data.objects.new('preview cam', bpy.data.cameras.new('preview cam'))
sc.collection.objects.link(cam)
cam.data.lens = 28
cam.data.clip_end = 20000
sc.camera = cam
for s in shots:
    name, e, t = s.split(':')
    eye = Vector([float(v) for v in e.split(',')]); tgt = Vector([float(v) for v in t.split(',')])
    cam.location = eye
    cam.rotation_euler = (tgt - eye).to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(out, name + '.png')
    bpy.ops.render.render(write_still=True)
    print('[shot]', sc.render.filepath, flush=True)
