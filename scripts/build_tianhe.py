"""Guangzhou Tianhe (Zhujiang New Town) phase-1 build. Deterministic; run with Blender --background --python.

    Blender --background --python guangzhou/scripts/build_tianhe.py -- [--stages a,b,c] [--out path.blend]

Stages: setup, ground (slab + Pearl River cut + lawns), roads (+bridges, markings), buildings (generic OSM
extrusion), trees, landmarks, backdrop (far city, river, Baiyun), cameras. Input: guangzhou/data/tianhe_core.json (prepare_osm.py).
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import os
import sys
import time

import bpy

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPTS)
sys.path.insert(0, SCRIPTS)

import gz_city  # noqa: E402
import gz_look  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


ALL_STAGES = ['setup', 'ground', 'roads', 'buildings', 'trees', 'landmarks', 'backdrop', 'cameras']
STAGES = arg('--stages', ','.join(ALL_STAGES)).split(',')
OUT = arg('--out', os.path.join(ROOT, 'tianhe_core.blend'))


def log(*a):
    print('[build]', *a, flush=True)


def stage_setup():
    return gz_look.setup_scene()


def stage_ground():
    gz_city.build_ground()


def stage_roads():
    gz_city.build_roads()


def stage_buildings():
    gz_city.build_buildings()


def stage_trees():
    gz_city.build_trees()


def stage_landmarks():
    import landmarks
    landmarks.build()


def stage_backdrop():
    import gz_backdrop
    gz_backdrop.build()


def stage_cameras():
    gz_look.cameras(gz_city.bounds())


def main():
    t0 = time.time()
    if 'setup' not in STAGES:
        bpy.ops.wm.open_mainfile(filepath=OUT)
    for st in STAGES:
        t = time.time()
        log('STAGE', st)
        globals()['stage_' + st]()
        log('DONE', st, len(bpy.data.objects), 'objects', '%.1fs' % (time.time() - t))
    scene = bpy.context.scene
    for screen in bpy.data.screens:
        for ar in screen.areas:
            if ar.type == 'VIEW_3D':
                sp = ar.spaces.active; sp.clip_end = 20000; sp.shading.type = 'MATERIAL'
    bpy.ops.wm.save_as_mainfile(filepath=OUT, compress=True)
    stats = {'objects': len(scene.objects),
             'mesh_polygons': sum(len(o.data.polygons) for o in scene.objects if o.type == 'MESH'),
             'seconds': round(time.time() - t0, 1)}
    log('BUILD_COMPLETE', json.dumps(stats))


if __name__ == '__main__':
    main()
