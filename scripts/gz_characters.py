"""Guangzhou 《准时达》 protagonists: Tripo characters -> game-ready GLBs for guangzhou/demo.

    Blender --background --factory-startup --python guangzhou/scripts/gz_characters.py -- [ajie|qiqi|qiang ...]

Same pipeline as coastal_city/v2/scripts/characters.py (which it was copied from), plus:
  * the full Tripo PBR set is kept: base colour 2k, normal 2k, roughness + metallic 1k (glTF packs the last two)
  * the extra fold_arms clip (Ah Jie, Uncle Keung) is kept as `idle_fold`
  * the GLBs are copied into guangzhou/demo/public/assets/characters/

Input (read-only): characters/incoming/_tripo_raw/<task-id>/*.fbx (Tripo v1.0 humanoid rig, 41 bones,
idle/walk/run baked at 24 fps, model normalised to ~1 m, facing +X). Delivered 2026-09-29; the user says
rig and animation are "not perfect yet, use them for now, refine later".

Per character this writes characters/<key>/:
  CH_<Name>.glb        LOD0 mesh + skeleton + clips idle / walk / run / jump (in place, metres, glTF Y-up)
  CH_<Name>_lod1.glb   decimated mesh on the same skeleton, no clips (clips bind by bone name)
  CH_<Name>.blend      the processed scene, for later edits
  T_CH_<Name>_BaseColor_2k.jpg
and characters/characters_manifest.json with heights, clip lengths and root speeds for foot sync.

Processing is data-level only (object transforms stay identity):
  * scale mesh + armature data to the design height, and every location key by the same factor
  * walk/run: remove the forward (+X) drift of the Hip bone by linear regression, keep bob and sway
  * run: Tripo's run is a 31-frame cycle exported as frames 1..31; frame 32 = frame 1 closes the loop
  * jump: Tripo gave no jump clip; the highest flight frame of run is held as a static air pose
"""
import json
import math
import os
import shutil
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

V2 = Path(__file__).resolve().parents[1]          # guangzhou/
RAW = V2 / 'characters' / 'incoming' / '_tripo_raw'
OUT = V2 / 'characters'
WEB = V2 / 'demo' / 'public' / 'assets' / 'characters'

# order matters to the web demo: index 1 is the female skeleton the procedural crowd borrows
CHARS = {
    'ajie': {'task': 'a33f8631', 'name': 'AJie', 'display': '阿杰 · 陈俊杰', 'height': 1.72},
    'qiqi': {'task': '0f2d289f', 'name': 'Qiqi', 'display': '琪琪 · 黎琪琪', 'height': 1.63},
    'qiang': {'task': '15343242', 'name': 'Qiang', 'display': '强叔 · 何志强', 'height': 1.70},
}
CLIP_NAMES = {'walk': 'walk', 'run': 'run', 'wait': 'idle', 'standing_relax': 'idle', 'fold_arms': 'idle_fold'}
LOD1_TRIS = 12000


def log(*a):
    print('[chars]', *a, flush=True)


def fcurves(action):
    """All fcurves of a (5.x layered) action."""
    out = []
    for lay in action.layers:
        for st in lay.strips:
            for cb in st.channelbags:
                out.extend(cb.fcurves)
    return out


def bind(arm, action):
    arm.animation_data.action = action
    if action.slots:
        arm.animation_data.action_slot = action.slots[0]


def mesh_world_verts(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co)
    ev.to_mesh_clear()
    co = co.reshape(-1, 3)
    M = np.array(obj.matrix_world)
    return co @ M[:3, :3].T + M[:3, 3]


def process(key):
    spec = CHARS[key]
    name = spec['name']
    dst = OUT / key
    dst.mkdir(parents=True, exist_ok=True)
    fbx = next((RAW / spec['task']).glob('*.fbx'))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 24
    bpy.ops.import_scene.fbx(filepath=str(fbx))
    arm = next(o for o in sc.objects if o.type == 'ARMATURE')
    body = next(o for o in sc.objects if o.type == 'MESH')
    for o in (arm, body):
        dev = max(abs(o.matrix_world[i][j] - (1.0 if i == j else 0.0)) for i in range(4) for j in range(4))
        assert dev < 1e-5, (o.name, [list(r) for r in o.matrix_world])
    assert len(arm.data.bones) == 41, len(arm.data.bones)

    # --- names
    arm.name = f'CH_{name}'; arm.data.name = f'CH_{name}_Skeleton'
    body.name = f'CH_{name}_Body'; body.data.name = f'CH_{name}_Body'
    for act in list(bpy.data.actions):
        short = act.name.split('|')[-1].split('.')[0]
        act.name = CLIP_NAMES[short]
    assert {'idle', 'run', 'walk'} <= {a.name for a in bpy.data.actions}, [a.name for a in bpy.data.actions]

    # --- material: Tripo's PBR set (base colour, normal, roughness, metallic), resized for the web
    mat = body.active_material; mat.name = f'M_CH_{name}'
    nt = mat.node_tree
    bs = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    def linked_image(sock):
        """The image texture feeding a socket (through a normal-map / separate node if needed)."""
        stack = [sock]
        while stack:
            s_ = stack.pop()
            for l in s_.links:
                n = l.from_node
                if n.type == 'TEX_IMAGE':
                    return n
                stack.extend(i for i in n.inputs if i.is_linked)
        return None
    sc.render.image_settings.quality = 90
    src_size = None
    for sock, tag, px in (('Base Color', 'BaseColor', 2048), ('Normal', 'Normal', 2048), ('Roughness', 'Roughness', 1024), ('Metallic', 'Metallic', 1024)):
        node = linked_image(bs.inputs[sock])
        if not node:
            log(name, 'no texture on', sock)
            continue
        img = node.image
        if tag == 'BaseColor':
            src_size = tuple(img.size)
        if max(img.size) > px:
            img.scale(px, px)
        tex = dst / f'T_CH_{name}_{tag}.jpg'
        img.filepath_raw = str(tex); img.file_format = 'JPEG'
        img.save(filepath=str(tex), quality=90)
        img.name = f'T_CH_{name}_{tag}'
    if not linked_image(bs.inputs['Roughness']):
        bs.inputs['Roughness'].default_value = 0.78
    if not linked_image(bs.inputs['Metallic']):
        bs.inputs['Metallic'].default_value = 0.0

    # --- scale to design height (data level, keys included)
    co = np.zeros(len(body.data.vertices) * 3); body.data.vertices.foreach_get('co', co)
    rest_h = float(co.reshape(-1, 3)[:, 2].max())
    k = spec['height'] / rest_h
    S = Matrix.Scale(k, 4)
    body.data.transform(S)
    arm.data.transform(S)
    for act in bpy.data.actions:
        for fc in fcurves(act):
            if fc.data_path.endswith('.location'):
                for kp in fc.keyframe_points:
                    kp.co[1] *= k; kp.handle_left[1] *= k; kp.handle_right[1] *= k
    bpy.context.view_layer.update()

    clips = {}
    hip = arm.pose.bones['Hip']
    for act in bpy.data.actions:
        bind(arm, act)
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
        frames = list(range(f0, f1 + 1))
        info = {'frames': [f0, f1]}
        if act.name in ('walk', 'run'):
            # forward drift of the Hip in armature space (character faces +X)
            P = []
            for f in frames:
                sc.frame_set(f); P.append(hip.matrix.translation.copy())
            xs = np.array([p.x for p in P]); fs = np.array(frames, float)
            slope = float(np.polyfit(fs, xs, 1)[0])            # metres per frame
            info['root_speed_mps'] = round(slope * sc.render.fps, 4)
            for f, p in zip(frames, P):
                sc.frame_set(f)
                M = hip.matrix.copy()
                M.translation = Vector((p.x - slope * (f - f0), p.y, p.z))
                hip.matrix = M
                hip.keyframe_insert('location', frame=f, group='Hip')
        if act.name == 'run':
            # close the loop: frame f1+1 repeats frame f0 on every channel
            for fc in fcurves(act):
                fc.keyframe_points.insert(f1 + 1, fc.evaluate(f0), options={'FAST'})
            act.use_frame_range = True; act.frame_start = f0; act.frame_end = f1 + 1
            info['frames'] = [f0, f1 + 1]
            info['loop_fix'] = 'appended frame %d = frame %d (31-frame cycle)' % (f1 + 1, f0)
        for fc in fcurves(act): fc.update()
        info['duration_s'] = round((info['frames'][1] - info['frames'][0]) / sc.render.fps, 4)
        clips[act.name] = info

    # --- jump: hold the run frame with the highest lowest-foot (flight phase), in place
    run = bpy.data.actions['run']; bind(arm, run)
    best = None
    for f in range(int(run.frame_start), int(run.frame_end)):
        sc.frame_set(f)
        low = min((arm.matrix_world @ arm.pose.bones[b].head).z for b in ('L_ToeBase', 'R_ToeBase', 'L_Foot', 'R_Foot'))
        if best is None or low > best[0]: best = (low, f)
    sc.frame_set(best[1])
    snap = {pb.name: (pb.location.copy(), pb.rotation_quaternion.copy(), pb.scale.copy()) for pb in arm.pose.bones}
    jump = bpy.data.actions.new('jump'); arm.animation_data.action = jump
    for f in (1, 2):
        for pb in arm.pose.bones:
            loc, rot, scl = snap[pb.name]
            pb.location, pb.rotation_quaternion, pb.scale = loc, rot, scl
            for path in ('location', 'rotation_quaternion', 'scale'):
                pb.keyframe_insert(path, frame=f, group=pb.name)
    jump.use_frame_range = True; jump.frame_start = 1; jump.frame_end = 2
    clips['jump'] = {'frames': [1, 2], 'duration_s': round(1 / sc.render.fps, 4),
                     'source': 'run frame %d held (flight phase, lowest foot %.3f m)' % (best[1], best[0])}
    for act in bpy.data.actions: act.use_fake_user = True
    bind(arm, bpy.data.actions['idle'])
    sc.frame_set(1)

    # --- LOD1 on the same skeleton
    body.select_set(False)
    lod = body.copy(); lod.data = body.data.copy(); sc.collection.objects.link(lod)
    lod.name = f'CH_{name}_Body_LOD1'; lod.data.name = lod.name
    tris0 = sum(len(p.vertices) - 2 for p in body.data.polygons)
    dec = lod.modifiers.new('LOD1 decimate', 'DECIMATE'); dec.ratio = LOD1_TRIS / tris0
    dec.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = lod
    for m in list(lod.modifiers):
        if m.type == 'DECIMATE':
            with bpy.context.temp_override(object=lod, active_object=lod):
                bpy.ops.object.modifier_move_to_index(modifier=m.name, index=0)
                bpy.ops.object.modifier_apply(modifier=m.name)
    tris1 = sum(len(p.vertices) - 2 for p in lod.data.polygons)

    # --- export
    def export(path, objs, animations):
        bpy.ops.object.select_all(action='DESELECT')
        for o in objs: o.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.export_scene.gltf(
            filepath=str(path), export_format='GLB', use_selection=True,
            export_yup=True, export_apply=False, export_skins=True, export_all_influences=False,
            export_animations=animations, export_animation_mode='ACTIONS', export_force_sampling=True,
            export_frame_step=1, export_optimize_animation_size=False, export_anim_single_armature=True,
            export_reset_pose_bones=True, export_def_bones=False, export_morph=False,
            export_image_format='JPEG', export_jpeg_quality=90, export_materials='EXPORT',
            export_texcoords=True, export_normals=True, export_tangents=False, export_cameras=False,
            export_lights=False, export_extras=True)
    lod.hide_set(True); lod.hide_render = True
    glb0 = dst / f'CH_{name}.glb'; glb1 = dst / f'CH_{name}_lod1.glb'
    export(glb0, [arm, body], True)
    lod.hide_set(False); body.hide_set(True)
    export(glb1, [arm, lod], False)
    body.hide_set(False); lod.hide_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=str(dst / f'CH_{name}.blend'), compress=True)
    WEB.mkdir(parents=True, exist_ok=True)
    for f in (glb0, glb1):
        shutil.copy2(f, WEB / f.name)
    rec = {'display': spec['display'], 'height_m': spec['height'], 'scale_from_tripo': round(k, 5),
           'source_fbx': str(fbx.relative_to(V2)), 'texture_source_px': list(src_size or ()), 'texture_px': {'base': 2048, 'normal': 2048, 'rough_metal': 1024},
           'bones': len(arm.data.bones), 'finger_bones': False, 'tris_lod0': tris0, 'tris_lod1': tris1,
           'forward_axis_blender': '+X', 'clips': clips,
           'files': {'lod0': str(glb0.relative_to(V2)), 'lod1': str(glb1.relative_to(V2)),
                     'blend': str((dst / f'CH_{name}.blend').relative_to(V2))},
           'glb_bytes': {'lod0': glb0.stat().st_size, 'lod1': glb1.stat().st_size}}
    log('DONE', key, json.dumps(rec, ensure_ascii=False))
    return rec


def main():
    keys = [a for a in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []) if a in CHARS] or list(CHARS)
    man_path = OUT / 'characters_manifest.json'
    manifest = json.loads(man_path.read_text()) if man_path.exists() else {}
    for key in keys:
        manifest[key] = process(key)
    man_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
    shutil.copy2(man_path, WEB / 'characters_manifest.json')
    log('MANIFEST', man_path)


if __name__ == '__main__':
    main()
