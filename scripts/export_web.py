"""Export the Tianhe scene for the web demo (three.js). Opens the built .blend read-only; never saves it.

    Blender --background guangzhou/tianhe_core.blend --python guangzhou/scripts/export_web.py -- <out_dir>

Writes into <out_dir> (normally guangzhou/demo/public/assets/tianhe/):
  ground.glb      ground slab (paving, embankments), lawns, roads (road-space UVs), markings, bridge structure
  buildings.glb   generic OSM buildings, one mesh per facade family per 700 m tile (metre UVs + 'tint' colours)
  landmarks.glb   hand-built landmarks (Canton Tower, IFC, CTF, opera, museum, library, bridges)
  water.glb       river plane + ponds (the demo swaps in its own water shader)
  backdrop.glb    far city, CITIC/Tianhe Sports Centre, Baiyun Mountain (render-only skybox layer)
  props.glb       low-poly web versions of the tree and street-lamp prototypes
  instances.json  tree / lamp transforms (Blender Z-up metres, rotation about Z, uniform scale)
  roads.json      drivable road graph for traffic: nodes [x,y,z], edges with polyline, class, lanes, one-way
  footprints.json building footprints (outer ring, holes, height) for 2D collision
  collision.glb   physics proxy: ground (kerbs, channels, embankments), lawns, road + bridge surfaces,
                  buildings, landmark footprint prisms -- the demo builds its BVH from this, never from render meshes
  walkways.json   pedestrian graph: sidewalks, corners, crosswalks (with junction + road ids), footways, links
  places.json     delivery / mission points snapped to walkways (fictional commercial names)
  metro.json      Guangzhou Metro entrances (pavilion / totem placements, names, lines) + OSM tunnels and platforms
  minimap.svg     dark GTA-style plan for the HUD (rasterise with qlmanage; see HANDOFF)
  meta.json       bounds, origin, licence, material families, triangle counts
Shader parameters travel as material extras (gz_facade / gz_plain / gz_emit / gz_led / gz_pebble / gz_water ...):
the demo rebuilds the Blender looks (window grid, night lights, lamp pools) from them.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import sys
import time

import bpy

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS)
import gz_city  # noqa: E402
import gz_gameplay  # noqa: E402
import gz_metro  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:]
OUT = os.path.abspath(ARGS[0])
os.makedirs(OUT, exist_ok=True)

GROUPS = {
    'ground': ('10 • Ground and river', '11 • Green', '15 • Huacheng Square', '20 • Roads'),
    'buildings': ('30 • Buildings',),
    'landmarks': ('50 • Landmarks',),
    'backdrop': ('60 • Backdrop (far city)',),
}


def log(*a):
    print('[web]', *a, flush=True)


def simple_materials():
    """Replace node trees with a plain Principled carrying diffuse colour; keep the gz_* custom properties."""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name.startswith('Atmosphere') or 'gz_tex' in m:
            continue                                   # gz_tex: baked texture kits export as real glTF PBR
        rough, metal = 0.8, 0.0
        for key in ('gz_plain', 'gz_facade'):
            if key in m:
                p = json.loads(m[key])
                rough = p.get('rough', p.get('wall_rough', rough)); metal = p.get('metal', 0.0)
        if 'gz_water' in m:
            rough = 0.08
        nt = m.node_tree
        bs = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        alpha = bs.inputs['Alpha'].default_value if bs else 1.0     # glass (balustrades, membranes) stays see-through
        nt.nodes.clear()
        b = nt.nodes.new('ShaderNodeBsdfPrincipled')
        b.inputs['Base Color'].default_value = m.diffuse_color
        b.inputs['Roughness'].default_value = rough
        b.inputs['Metallic'].default_value = metal
        if alpha < 1.0:
            b.inputs['Alpha'].default_value = alpha
            m.surface_render_method = 'BLENDED'
        o = nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(b.outputs[0], o.inputs['Surface'])


def export(name, objs, tangents=False):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    path = os.path.join(OUT, name + '.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_materials='EXPORT', export_texcoords=True, export_normals=True, export_tangents=tangents,
        export_animations=False, export_cameras=False, export_lights=False, export_extras=True,
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=20, export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=16, export_draco_color_quantization=10,
        export_vertex_color='ACTIVE', export_image_format='JPEG', export_jpeg_quality=88)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.type == 'MESH')
    log(name, len(objs), 'objects', tris, 'tris', '%.1f MB' % (os.path.getsize(path) / 1e6))
    return tris


def objects_in(cols):
    out = []
    for cn in cols:
        c = bpy.data.collections.get(cn)
        if c:
            out += [o for o in c.all_objects if o.type == 'MESH' and not o.modifiers.get('scatter')]
    return out


def prep_mesh(o):
    """Active colour attribute = tint (exported as COLOR_0); drop faces nobody sees (slab undersides)."""
    me = o.data
    if 'tint' in me.color_attributes:
        me.color_attributes.active_color = me.color_attributes['tint']
        me.color_attributes.render_color_index = me.color_attributes.find('tint')
    if o.name.startswith(('Ground |', 'Green |', 'Backdrop | far ground')):
        import bmesh
        bm = bmesh.new(); bm.from_mesh(me)
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z < -0.5], context='FACES')
        bm.to_mesh(me); bm.free()


def instances():
    out = {}
    for o in bpy.data.objects:
        mod = o.modifiers.get('scatter')
        if not mod:
            continue
        me = o.data
        n = len(me.vertices)
        co = [0.0] * (3 * n); me.vertices.foreach_get('co', co)
        sc = [0.0] * n; me.attributes['gz_scale'].data.foreach_get('value', sc)
        rt = [0.0] * n; me.attributes['gz_rot'].data.foreach_get('value', rt)
        proto = mod.node_group.name.split(' | ', 1)[1]
        out[o.name] = {'proto': proto, 'count': n, 'pos': [round(v, 2) for v in co],
                       'rot': [round(v, 3) for v in rt], 'scale': [round(v, 3) for v in sc]}
    return out


def web_props():
    """Low-poly copies of the prototypes (decimated crowns) for InstancedMesh."""
    col = bpy.data.collections.get('_protos')
    lc = bpy.context.view_layer.layer_collection.children.get('_protos')
    if lc: lc.exclude = False
    objs = []
    for o in col.objects:
        if o.name.startswith('Tree proto'):
            d = o.modifiers.new('web lod', 'DECIMATE'); d.ratio = 0.22
        objs.append(o)
    return objs


def road_graph():
    """Drivable network split at junctions. Bridges carry their deck heights; at-grade roads their road z."""
    d = gz_city.data()
    x0, y0, x1, y1 = d['bounds_m']
    roads = d['roads']
    bridges = gz_city.bridge_profile(roads)
    ways = []
    for r in roads:
        if not r['drive'] or r['tunnel'] or r['area']:
            continue
        dz = gz_city.Z_RANK.get(r['hw'], 0.08)
        if r['id'] in bridges and max(bridges[r['id']][1]) >= 0.5:
            pts, zs = bridges[r['id']]
            ways.append((r, [(p[0], p[1], z + dz) for p, z in zip(pts, zs)]))
        else:
            for run in gz_city.clip_polyline(gz_city.clean_line(r['pts']), (x0, y0, x1, y1)):
                ways.append((r, [(p[0], p[1], dz) for p in run]))
    cnt = {}
    for r, pts in ways:
        for j, p in enumerate(pts):
            k = gz_city.key(p)
            cnt[k] = cnt.get(k, 0) + (1 if j in (0, len(pts) - 1) else 2)
    nodes, nidx, edges = [], {}, []
    def node(p):
        k = gz_city.key(p)
        if k not in nidx:
            nidx[k] = len(nodes); nodes.append([round(p[0], 2), round(p[1], 2), round(p[2], 2)])
        return nidx[k]
    for r, pts in ways:
        start = 0
        for j in range(1, len(pts)):
            if j == len(pts) - 1 or cnt.get(gz_city.key(pts[j]), 0) >= 3:
                seg = pts[start:j + 1]
                if len(seg) >= 2 and sum(math.dist(a[:2], b[:2]) for a, b in zip(seg, seg[1:])) > 0.5:
                    lanes = r['lanes']
                    if r['oneway']:
                        lf, lb = max(1, int(lanes or round(r['w'] / 3.4))), 0
                    else:
                        per = max(1, int((lanes or round(r['w'] / 3.4)) // 2))
                        lf = lb = per
                    edges.append({'a': node(seg[0]), 'b': node(seg[-1]), 'hw': r['hw'], 'w': r['w'], 'name': r['name'],
                                  'fwd': lf, 'back': lb, 'bridge': bool(r['bridge']),
                                  'pts': [[round(p[0], 2), round(p[1], 2), round(p[2], 2)] for p in seg]})
                start = j
    deg = [0] * len(nodes)
    for e in edges:
        deg[e['a']] += 1; deg[e['b']] += 1
    return {'nodes': nodes, 'edges': edges, 'stats': {'nodes': len(nodes), 'edges': len(edges),
            'junctions': sum(1 for v in deg if v >= 3), 'dead_ends': sum(1 for v in deg if v == 1)}}


def footprints():
    import lm_towers
    d = gz_city.data()
    x0, y0, x1, y1 = d['bounds_m']
    out = []
    for b in d['buildings']:
        if b['part'] and b['minh'] > 0.5:
            continue
        cx, cy = gz_city.centroid(b['outer'])
        if not (x0 <= cx <= x1 and y0 <= cy <= y1):
            continue
        out.append({'o': [[round(p[0], 1), round(p[1], 1)] for p in b['outer']],
                    'h': [[[round(p[0], 1), round(p[1], 1)] for p in h] for h in b['holes']],
                    # towers modelled from photographs count as landmarks: no parody media walls on them
                    'z': b['h'], 'lm': b['landmark'] or ('named' if lm_towers.handles(b) else None)})
    return out


def collision_objects():
    """Physics proxy objects (already in the scene) plus landmark footprint prisms built here."""
    import bmesh
    import gz_common as c
    objs = []
    for name in ('Ground | paving + kerbs + embankments', 'Green | lawns parks', 'Green | lawns gardens + pitches',
                 'Roads | arterial asphalt', 'Roads | local asphalt', 'Roads | footways', 'Roads | steps', 'Roads | bridge structure'):
        o = bpy.data.objects.get(name)
        if o: objs.append(o)
    objs += objects_in(('30 • Buildings',))
    # Huacheng Square's court: floor, terraces, walls, coping, balustrades, the escalator wells; the stair by its ramp
    objs += [o for o in objects_in(('15 • Huacheng Square',)) if o.name.startswith(('Huacheng | court', 'Huacheng | canopy', 'Huacheng | shopfront', 'Huacheng | street', 'Huacheng | mall', 'Huacheng | north'))
             and not o.name.endswith((' stair', ' membrane', ' membrane under', ' white', ' escalator', ' wood', ' canvas', ' green'))]
    for n in ('Collision | huacheng stair ramp', 'Collision | mall north ramp', 'Collision | north stair ramp'):     # walked like stairs
        o = bpy.data.objects.get(n)
        if o: objs.append(o)
    bm = bmesh.new()
    for b in gz_city.data()['buildings']:
        if not b['landmark'] or (b['part'] and b['minh'] > 0.5):
            continue
        h = 33.0 if b['id'] == 584204634 else b['h']      # Canton Tower: the enclosed base zone, not the lattice
        ring = c.clean_ring(b['outer'])
        if ring:
            c.extrude_polygon(bm, ring, [], 0.0, h, top=True, bottom=False)
    lm = c.obj_from_bmesh('Collision | landmark footprints', bm, None, bpy.context.scene.collection)
    objs.append(lm)
    return objs


def export_collision(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    path = os.path.join(OUT, 'collision.glb')
    bpy.ops.export_scene.gltf(
        filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
        export_materials='NONE', export_texcoords=False, export_normals=False, export_animations=False,
        export_cameras=False, export_lights=False, export_extras=False, export_vertex_color='NONE',
        export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
        export_draco_position_quantization=20)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    log('collision', len(objs), 'objects', tris, 'tris', '%.1f MB' % (os.path.getsize(path) / 1e6))
    return tris


def main():
    t0 = time.time()
    scene = bpy.context.scene
    for o in scene.objects:
        if o.type == 'MESH':
            prep_mesh(o)
    simple_materials()
    meta = {'origin_latlon': gz_city.data()['origin_latlon'], 'bounds_m': gz_city.data()['bounds_m'],
            'core_m': gz_city.data()['core_m'], 'license': 'Map data (c) OpenStreetMap contributors, ODbL 1.0',
            'coordinates': 'JSON files: Blender Z-up metres (x east, y north, z up); GLBs: glTF Y-up (x, z, -y)',
            'groups': {}}
    for name, cols in GROUPS.items():
        # landmarks carry normal-mapped texture kits on per-facet UVs: real tangents, or the web's derivative
        # tangents flip at every facet seam
        meta['groups'][name] = export(name, objects_in(cols), tangents=name == 'landmarks')
    water = [o for o in scene.objects if o.type == 'MESH' and o.name.startswith('Water |')]
    meta['groups']['water'] = export('water', water)
    meta['groups']['props'] = export('props', web_props())
    inst = instances()
    json.dump(inst, open(os.path.join(OUT, 'instances.json'), 'w'), separators=(',', ':'))
    meta['instances'] = {k: v['count'] for k, v in inst.items()}
    g = road_graph()
    json.dump(g, open(os.path.join(OUT, 'roads.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    meta['roads'] = g['stats']
    meta['groups']['collision'] = export_collision(collision_objects())
    walk = gz_gameplay.walkways(g)
    json.dump(walk, open(os.path.join(OUT, 'walkways.json'), 'w'), separators=(',', ':'))
    meta['walkways'] = walk['stats']
    pl = gz_gameplay.places(walk)
    json.dump(pl, open(os.path.join(OUT, 'places.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    meta['places'] = {'pickup': sum(p['role'] == 'pickup' for p in pl), 'drop': sum(p['role'] == 'drop' for p in pl)}
    mj = gz_metro.metro_json()
    json.dump(mj, open(os.path.join(OUT, 'metro.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    meta['metro'] = {'exits': len(mj['exits']), 'pavilions': sum(e['kind'] == 'pavilion' for e in mj['exits']), 'tunnels': len(mj['tunnels'])}
    meta['minimap'] = gz_gameplay.minimap_svg(os.path.join(OUT, 'minimap.svg'))
    meta['kerb'] = gz_city.KERB
    fp = footprints()
    json.dump(fp, open(os.path.join(OUT, 'footprints.json'), 'w'), separators=(',', ':'))
    meta['footprints'] = len(fp)
    json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), indent=1, ensure_ascii=False)
    log('DONE', json.dumps({k: v for k, v in meta.items() if k in ('groups', 'instances', 'roads', 'footprints', 'walkways', 'places')}, ensure_ascii=False),
        '%.1fs' % (time.time() - t0))


main()
