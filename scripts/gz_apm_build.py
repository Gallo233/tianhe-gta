"""Build and export the APM underground for the web demo.

    Blender --background --factory-startup --python guangzhou/scripts/gz_apm_build.py -- [--preview]

Writes guangzhou/demo/public/assets/apm/apm.glb and apm.json:
  kit_apm_platform / kit_apm_concourse / kit_apm_cols_<style> / kit_apm_station_col   station template (gz_apm_station),
                      placed by the demo at every station (local frame: +Y north along the line, +X east)
  apm_shell_<key>     per station, world coordinates: the concourse and the passages to its entrances as one interior
                      (floor, walls, ceiling facing inwards; the opening down to the platform; open where the passages
                      meet the entrance halls), also used for collision
  apm_shell_lights_<key>  light strips along the passages
  apm_tunnel_<n>      twin single-track box tunnels between the stations, in 200 m pieces (world coordinates)
  apm_trackbed_<n>    running pads and guide beam along both tracks, stations included
  apm_tunnel_lights_<n>  wall lights every LAMP_SP m (their positions go into apm.json 'lamps': the demo lights the
                         tunnel walls from the ones nearest the camera)
The same prisms are cut from the ground slab by gz_city (gz_apm.ground_cutters()).
"""
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import gz_apm as A  # noqa: E402
import gz_apm_station as S  # noqa: E402
import gz_apm_train as TR  # noqa: E402
import gz_metro as MX  # noqa: E402
import gz_mall  # noqa: E402
from gz_streetkit import mat  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'apm')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def log(*a):
    print('[apm-build]', *a, flush=True)


def obj_from_bm(name, bm, mats, col):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    return o


def prism(bm, ring, z0, z1):
    """Closed prism over a CCW ring."""
    b = [bm.verts.new((x, y, z0)) for x, y in ring]
    t = [bm.verts.new((x, y, z1)) for x, y in ring]
    bm.faces.new(list(reversed(b)))
    bm.faces.new(t)
    n = len(ring)
    for i in range(n):
        bm.faces.new((b[i], b[(i + 1) % n], t[(i + 1) % n], t[i]))


def ccw(ring):
    a = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
    return ring if a > 0 else ring[::-1]


def seg_rect(a, b, hw, ext=0.0):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1.0
    ux, uy = dx / L, dy / L
    nx, ny = -uy, ux
    a2 = (a[0] - ux * ext, a[1] - uy * ext)
    b2 = (b[0] + ux * ext, b[1] + uy * ext)
    return ccw([(a2[0] + nx * hw, a2[1] + ny * hw), (a2[0] - nx * hw, a2[1] - ny * hw), (b2[0] - nx * hw, b2[1] - ny * hw), (b2[0] + nx * hw, b2[1] + ny * hw)])


def octagon(c, r):
    R = r / math.cos(math.pi / 8)
    return [(c[0] + R * math.cos(math.pi / 8 + k * math.pi / 4), c[1] + R * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]


# ------------------------------------------------------------------ interiors (concourse + passages)
def shell(st, passages, col, mats):
    """One interior per station: union of the concourse box, the passage corridors and the stair well, turned
    inside out; the well's bottom and the passage ends at the entrance halls are left open."""
    z0, z1 = A.CONC_Z, A.CONC_Z + A.CONC_H
    hw = A.PASSAGE_W / 2
    tmp = bpy.data.collections.new('_shell tmp')
    bpy.context.scene.collection.children.link(tmp)
    pieces = []
    def add(name, ring, za, zb):
        bm = bmesh.new()
        prism(bm, ring, za, zb)
        o = obj_from_bm(name, bm, [], tmp)
        pieces.append(o)
    box = ccw([A.frame(st, u, v)[:2] for u, v in ((-A.BOX_U, -A.CONC_V), (A.BOX_U, -A.CONC_V), (A.BOX_U, A.CONC_V), (-A.BOX_U, A.CONC_V))])
    add('box', box, z0, z1)
    o0, o1 = A.STAIR_OPEN
    well = ccw([A.frame(st, u, v)[:2] for u, v in ((o0, -A.STAIR_X), (o1, -A.STAIR_X), (o1, A.STAIR_X), (o0, A.STAIR_X))])
    add('well', well, A.PLAT_Z + A.PLAT_H, z0 + 0.05)
    for eid, pl in passages:
        for i, (a, b) in enumerate(zip(pl, pl[1:])):
            add('seg', seg_rect(a, b, hw), z0, z1)
            if i > 0:
                add('joint', octagon(a, hw), z0, z1)
    # 花城汇 B1 (gz_mall): short stubs through the box walls where the mall's doors meet them (3 m doors)
    doors = gz_mall.apm_doors() if st['key'] == 'huacheng' else []
    for ring, _ in doors:
        add('door', ccw(ring), z0, z0 + 3.0)
    base = pieces[0]
    others = bpy.data.collections.new('_shell ops')
    bpy.context.scene.collection.children.link(others)
    for o in pieces[1:]:
        tmp.objects.unlink(o); others.objects.link(o)
    mod = base.modifiers.new('u', 'BOOLEAN')
    mod.operation = 'UNION'; mod.operand_type = 'COLLECTION'; mod.collection = others; mod.solver = 'MANIFOLD'
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(base.evaluated_get(dg))
    for c_ in (tmp, others):
        for o in list(c_.objects):
            m_ = o.data; bpy.data.objects.remove(o); bpy.data.meshes.remove(m_)
        bpy.data.collections.remove(c_)
    bm = bmesh.new()
    bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    # inside out
    for f in bm.faces:
        f.normal_flip()
    bm.normal_update()
    # open the well's bottom and the passage ends at the halls
    kill = []
    halls = [e for e in MX.exits() if e['id'] in dict(passages)]
    for f in bm.faces:
        c = f.calc_center_median()
        if c.z < z0 - 0.5 and f.normal.z > 0.7:
            kill.append(f); continue
        for e in halls:
            lx, ly = MX.rot(-e['yaw'], c.x - e['x'], c.y - e['y'])
            if abs(ly - MX.HALL[3]) < 0.08 and MX.HALL[0] - 0.05 < lx < MX.HALL[1] + 0.05 and abs(f.normal.z) < 0.3:
                kill.append(f); break
        else:
            # the mall's doorways: the stub's outer end
            for _, (axis, val, lo, hi) in doors:
                along, across = (c.y, c.x) if axis == 'y' else (c.x, c.y)
                if abs(along - val) < 0.05 and lo - 0.05 < across < hi + 0.05 and abs(f.normal.z) < 0.3:
                    kill.append(f); break
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    # materials: concourse tile inside the box, granite in the passages, stone walls, panel ceilings
    uv = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        c = f.calc_center_median()
        n = f.normal
        u, v = A.to_frame(st, c.x, c.y)
        inside = abs(u) < A.BOX_U - 0.01 and abs(v) < A.CONC_V - 0.01
        if n.z > 0.7:
            f.material_index = 0 if inside else 1
        elif n.z < -0.7:
            f.material_index = 3
        else:
            f.material_index = 2 if c.z > z0 - 0.3 else 4
        for lp in f.loops:
            p = lp.vert.co
            if abs(n.z) > 0.7:
                lp[uv].uv = (p.x, p.y)
            else:
                t = Vector((-n.y, n.x, 0)).normalized() if n.xy.length > 1e-6 else Vector((1, 0, 0))
                lp[uv].uv = (p.x * t.x + p.y * t.y, p.z)
    o = obj_from_bm('apm_shell_' + st['key'], bm, mats, col)
    o.data.polygons.foreach_set('use_smooth', [False] * len(o.data.polygons))
    return o


def passage_lights(st, passages, col, m):
    bm = bmesh.new()
    zc = A.CONC_Z + A.CONC_H - 0.02
    for eid, pl in passages:
        for a, b in zip(pl, pl[1:]):
            L = math.dist(a, b)
            if L < 2:
                continue
            ux, uy = (b[0] - a[0]) / L, (b[1] - a[1]) / L
            n = int(L / 3.0)
            for k in range(n):
                t = (k + 0.5) * L / n
                cx, cy = a[0] + ux * t, a[1] + uy * t
                u, v = A.to_frame(st, cx, cy)
                if abs(u) < A.BOX_U and abs(v) < A.CONC_V:
                    continue
                r = seg_rect((cx - ux * 0.6, cy - uy * 0.6), (cx + ux * 0.6, cy + uy * 0.6), 0.09)
                prism(bm, r, zc - 0.02, zc)
    return obj_from_bm('apm_shell_lights_' + st['key'], bm, [m], col)


# ------------------------------------------------------------------ tunnels and track
def near_platform(x, y, sts, margin=0.0):
    for st in sts:
        u, v = A.to_frame(st, x, y)
        if abs(u) < A.PLAT_U + margin and abs(v) < 12:
            return True
    return False


def sweep(track, section, skip, closed=False):
    """Loft `section` [(l, z)] (l = metres to the left of the direction of travel) along the polyline; skip(i) drops
    stretches (their rings are not joined). Returns [(verts ring list)] chunks."""
    rings = []
    for i, p in enumerate(track):
        a = track[max(0, i - 1)]; b = track[min(len(track) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L, dx / L
        rings.append(None if skip(i) else [(p[0] + nx * l, p[1] + ny * l, z) for l, z in section])
    return rings


def loft(bm, rings, closed=False, flip=False):
    prev = None
    for r in rings:
        if r is None:
            prev = None; continue
        vs = [bm.verts.new(p) for p in r]
        if prev:
            n = len(vs)
            for k in range(n - (0 if closed else 1)):
                q = (prev[k], prev[(k + 1) % n], vs[(k + 1) % n], vs[k])
                bm.faces.new(q[::-1] if flip else q)
        prev = vs


LAMP_SP = 10
LAMPS = []          # (x, y, z) of every tunnel wall light, filled by tunnels()


def tunnels(col, mats):
    tr = A.tracks()
    sts = A.stations()
    hw = A.TUNNEL_W / 2
    zf, zt = A.RAIL_Z - 0.35, A.RAIL_Z + A.TUNNEL_H
    # section, left to right looking along the track: left wall top -> left wall foot -> floor -> right wall -> ceiling
    sec = [(hw, zt), (hw, zf), (-hw, zf), (-hw, zt)]
    out = []
    CH = 200
    for ti, t in enumerate(tr):
        for c0 in range(0, len(t), CH):
            part = t[max(0, c0 - 1):c0 + CH + 1]
            skip = lambda i, part=part: near_platform(part[i][0], part[i][1], sts)
            bm = bmesh.new()
            loft(bm, sweep(part, sec, skip), closed=True)
            # cable trays on the outer wall (west track: west side = left when heading north), lights every LAMP_SP m
            outer = hw if ti == 0 else -hw
            s_ = 1 if ti == 0 else -1
            for zz in (A.RAIL_Z + 2.3, A.RAIL_Z + 2.7, A.RAIL_Z + 3.1):
                loft(bm, sweep(part, [(outer - s_ * 0.02, zz), (outer - s_ * 0.3, zz), (outer - s_ * 0.3, zz + 0.05), (outer - s_ * 0.02, zz + 0.05)], skip))
            if len(bm.faces):
                o = obj_from_bm('apm_tunnel_%d_%d' % (ti, c0 // CH), bm, [mats['concrete']], col)
                o.data.polygons.foreach_set('use_smooth', [False] * len(o.data.polygons))
                out.append(o)
            # lights
            bm = bmesh.new()
            for i in range(0, len(part) - 1, LAMP_SP):
                if skip(i):
                    continue
                a, b = part[i], part[i + 1]
                dx, dy = b[0] - a[0], b[1] - a[1]
                L = math.hypot(dx, dy) or 1
                nx, ny = -dy / L, dx / L
                ox = outer - s_ * 0.06
                cx, cy = a[0] + nx * ox, a[1] + ny * ox
                r = seg_rect((cx - dx / L * 0.35, cy - dy / L * 0.35), (cx + dx / L * 0.35, cy + dy / L * 0.35), 0.06)
                prism(bm, r, A.RAIL_Z + 3.5, A.RAIL_Z + 3.62)
                lx, ly = a[0] + nx * (ox - s_ * 0.2), a[1] + ny * (ox - s_ * 0.2)
                LAMPS.append((round(lx, 2), round(ly, 2), round(A.RAIL_Z + 3.4, 2)))
            if len(bm.faces):
                out.append(obj_from_bm('apm_tunnel_lights_%d_%d' % (ti, c0 // CH), bm, [mats['tunnel_light']], col))
            # running pads and guide beam, everywhere (stations too)
            bm = bmesh.new()
            never = lambda i: False
            for l in (-1.32, 1.32):
                loft(bm, sweep(part, [(l - 0.23, A.RAIL_Z - 0.3), (l - 0.23, A.RAIL_Z), (l + 0.23, A.RAIL_Z), (l + 0.23, A.RAIL_Z - 0.3)], never), flip=True)
            loft(bm, sweep(part, [(-0.06, A.RAIL_Z - 0.3), (-0.06, A.RAIL_Z + 0.22), (0.06, A.RAIL_Z + 0.22), (0.06, A.RAIL_Z - 0.3)], never), flip=True)
            out.append(obj_from_bm('apm_trackbed_%d_%d' % (ti, c0 // CH), bm, [mats['pad'], mats['steel']], col))
    # end walls at both ends of the modelled line
    bm = bmesh.new()
    for t in tr:
        for i, j in ((0, 1), (len(t) - 1, len(t) - 2)):
            a, b = t[i], t[j]
            dx, dy = a[0] - b[0], a[1] - b[1]
            L = math.hypot(dx, dy)
            r = seg_rect((a[0], a[1]), (a[0] + dx / L * 0.4, a[1] + dy / L * 0.4), hw + 0.3)
            prism(bm, r, zf - 0.2, zt + 0.2)
    out.append(obj_from_bm('apm_tunnel_ends', bm, [mats['concrete']], col))
    return out


def materials():
    return {
        'tile': mat('apm concourse tile', '#eceae6', 0.0, 0.12),
        'granite': mat('apm floor granite', '#b9b8b3', 0.0, 0.18),
        'stone': mat('apm wall stone', '#d9cfbf', 0.0, 0.85),
        'ceiling': mat('apm ceiling panel', '#eef0f1', 0.2, 0.45),
        'well': mat('apm well wall', '#9fa2a6', 0.0, 0.6),
        'light': mat('apm light strip', '#fbfdff', 0.0, 0.3, emit=5.0),
        'concrete': mat('apm tunnel concrete', '#4f5256', 0.0, 0.9),
        'pad': mat('apm running pad', '#8a8c8e', 0.0, 0.8),
        'steel': mat('apm guide beam', '#3d4247', 0.7, 0.45),
        'tunnel_light': mat('apm tunnel light', '#c9f2ea', 0.0, 0.3, emit=4.0),
    }


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('apm')
    bpy.context.scene.collection.children.link(col)
    kit = S.build_all(col) + TR.build_all(col)
    mats = materials()
    pa = A.passages()
    ex = {e['id']: e for e in A.apm_exits()}
    shells = []
    for st in A.stations():
        mine = [(eid, pl) for eid, pl in pa.items() if ex[eid]['station'] == st['name']]
        o = shell(st, mine, col, [mats['tile'], mats['granite'], mats['stone'], mats['ceiling'], mats['well']])
        shells.append(o)
        shells.append(passage_lights(st, mine, col, mats['light']))
        log('shell', st['name'], len(o.data.polygons), 'faces,', len(mine), 'passages')
    tun = tunnels(col, mats)
    log('tunnels', len(tun), 'objects', sum(len(o.data.polygons) for o in tun), 'faces')
    os.makedirs(OUT, exist_ok=True)
    data = A.apm_json()
    data['lamps'] = sorted(set(LAMPS))
    log('tunnel lamps', len(data['lamps']))
    json.dump(data, open(os.path.join(OUT, 'apm.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    bpy.ops.object.select_all(action='DESELECT')
    for o in col.objects:
        o.select_set(True)
    path = os.path.join(OUT, 'apm.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_materials='EXPORT', export_texcoords=True, export_normals=True, export_extras=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                              export_draco_position_quantization=18)
    log('->', path, os.path.getsize(path) // 1024, 'KB')
    if '--blend' in ARGS:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(ROOT, 'apm.blend'))


if __name__ == '__main__':
    main()
