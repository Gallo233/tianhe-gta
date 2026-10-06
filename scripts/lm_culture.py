"""Huacheng Square's culture district, rebuilt against photographs (Wikimedia Commons, 2010-2024):

  opera_house   Guangzhou Opera House (Zaha Hadid, 2010). Not domes: two low, long, faceted wedges folded from
                large planes with sharp creases. The upper faces overhang, so the glazing below leans inward
                under an eave; skin = pale grey granite in 1.5 m triangles, glass in a 2.4 m triangulated steel
                lattice (warm foyers behind it at night). Grand theatre 43 m, multi-function hall ~26 m, both
                pale -- the grand theatre a shade darker.
  museum        Guangdong Museum (Rocco Design, 2010), the "treasure box": a charcoal stone box (~38 m) floating
                over a recessed dark glass ground floor, its skin a patchwork of flush blocks whose relief
                differs a little, cut by deep slots and window recesses lined in oxblood red, and a castellated
                top edge.
  childrens_palace  Second Children's Palace: a low body with a wavy top, skinned in horizontal aluminium ribs;
                on the square side a colonnade and canopy under a huge curved LED screen (the web draws the
                screen); on the roof an inverted glass drum with a flying brim on steel brackets.
  library       Guangzhou Library (Nikken Sekkei, 2012), "beautiful books": north and south wings (the plan reads
                as 之) whose walls lean outward as they rise, skinned in courses of pale stone slats of random
                length over dark glazing, split by a glazed atrium that shows as a tall triangular cleft at the
                ends.

Detail comes from the baked tiling kits (gz_texkit.py): UVs here are metres, the material's Mapping node
scales them by 1 / tile size (exported as KHR_texture_transform).
"""
import json
import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector

import gz_common as c
import gz_materials as gm
import landmarks as L

GZ = Path(__file__).resolve().parents[1]
KIT_DIR = GZ / 'textures' / 'kit'


# ------------------------------------------------------------------ textured materials
def _gltf_output_group():
    """'glTF Material Output' node group: the exporter reads its Occlusion input as the occlusion texture."""
    ng = bpy.data.node_groups.get('glTF Material Output')
    if ng:
        return ng
    ng = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
    ng.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    ng.nodes.new('NodeGroupInput')
    return ng


def tex_mat(name, kit, glow=None, glow_k=0.0):
    """Principled material from a baked kit: albedo, tangent normals, ORM (occlusion / roughness / metal) and an
    emission mask that lights at night (`glow` colour x `glow_k`, applied by the web shader and by GZ Night)."""
    if name in gm.MATS:
        return gm.MATS[name]
    tiles = json.loads((KIT_DIR / 'kits.json').read_text())
    tu, tv = tiles[kit]['tile_m']
    m = gm.new(name)
    m['gz_tex'] = json.dumps({'kit': kit, 'tile_m': [tu, tv], 'glow': glow, 'glow_k': glow_k})
    nt = m.node_tree
    nt.nodes.clear()
    k = gm.NB(m)
    uvn = k.node('ShaderNodeUVMap', uv_map='UVMap')
    mp = k.node('ShaderNodeMapping', vector_type='POINT')
    mp.inputs['Scale'].default_value = (1 / tu, 1 / tv, 1)
    nt.links.new(uvn.outputs['UV'], mp.inputs['Vector'])

    def img(tag, non_color):
        path = KIT_DIR / kit / f'{tag}.png'
        im = bpy.data.images.load(str(path), check_existing=True)
        if non_color:
            im.colorspace_settings.name = 'Non-Color'
        n = k.node('ShaderNodeTexImage')
        n.image = im
        nt.links.new(mp.outputs['Vector'], n.inputs['Vector'])
        return n

    alb, nrm, orm = img('albedo', False), img('normal', True), img('orm', True)
    nm = k.node('ShaderNodeNormalMap')
    nt.links.new(nrm.outputs['Color'], nm.inputs['Color'])
    sep = k.node('ShaderNodeSeparateColor')
    nt.links.new(orm.outputs['Color'], sep.inputs['Color'])
    b = k.bsdf(Base_Color=alb.outputs['Color'], Normal=nm.outputs['Normal'], Roughness=sep.outputs['Green'],
               Metallic=sep.outputs['Blue'])
    g = k.node('ShaderNodeGroup'); g.node_tree = _gltf_output_group()
    nt.links.new(sep.outputs['Red'], g.inputs['Occlusion'])
    if glow:
        em = img('emit', False)
        nt.links.new(em.outputs['Color'], b.inputs['Emission Color'])
        k.put(b.inputs['Emission Strength'], k.math('MULTIPLY', k.night(), glow_k))
    m.diffuse_color = (0.6, 0.6, 0.6, 1)
    return m


def metric_uv(bm, uv, faces=None):
    """Per-face planar UVs in metres: walls get (horizontal along the face, up the face), near-flat faces
    world (x, y). Panels therefore stay square to each facet, as real cladding is set out."""
    bm.normal_update()
    for f in (faces or bm.faces):
        n = f.normal
        if abs(n.z) > 0.85:
            t, b = Vector((1, 0, 0)), Vector((0, 1, 0))
        else:
            t = Vector((-n.y, n.x, 0)).normalized()
            b = n.cross(t).normalized()
            if b.z < 0:
                b = -b
        for lp in f.loops:
            p = lp.vert.co
            lp[uv].uv = (p.dot(t), p.dot(b))


def ring_axes(ring):
    """Centroid, unit long axis and half extents (along, across) of a 2D ring (PCA)."""
    cx, cy = L.centroid(ring)
    sxx = sum((p[0] - cx) ** 2 for p in ring); syy = sum((p[1] - cy) ** 2 for p in ring)
    sxy = sum((p[0] - cx) * (p[1] - cy) for p in ring)
    a = 0.5 * math.atan2(2 * sxy, sxx - syy)
    ax = (math.cos(a), math.sin(a))
    along = [(p[0] - cx) * ax[0] + (p[1] - cy) * ax[1] for p in ring]
    across = [-(p[0] - cx) * ax[1] + (p[1] - cy) * ax[0] for p in ring]
    return (cx, cy), ax, (max(map(abs, along)), max(map(abs, across)))


# ------------------------------------------------------------------ opera house
def _wedge(bm, base, H, peak_dir, overhang, seed):
    """A folded 'pebble': convex hull of an inset base ring, a wider eave ring (the overhang), a shoulder ring
    and a short ridge -- all heights lifted toward `peak_dir` so the roof slopes to one end like the real
    building (fly tower end high, foyer end low). Each vertex remembers its ring (layer 'ring')."""
    (cx, cy), _, _ = ring_axes(base)
    far = max(abs((p[0] - cx) * peak_dir[0] + (p[1] - cy) * peak_dir[1]) for p in base) or 1.0
    ring_of = bm.verts.layers.int.new('ring')
    verts = []

    def lift(x, y):
        s = ((x - cx) * peak_dir[0] + (y - cy) * peak_dir[1]) / far        # -1 (low end) .. 1 (high end)
        return 0.72 + 0.28 * (s + 1) / 2

    # few rings, big jitter on the eave: large flat facets and a hard crease, then a near-flat roof plane
    for k, (scale, zf, jit, step) in enumerate(((0.95, 0.0, 0.0, 1), (1.0 + overhang, 0.44, 0.14, 1),
                                                 (0.90, 0.93, 0.04, 2), (0.62, 1.0, 0.03, 3))):
        for i, p in enumerate(base):
            if i % step:
                continue
            j = c.hash01(i * 31 + k * 7, seed) - 0.5
            x = cx + (p[0] - cx) * (scale + jit * j * 0.5)
            y = cy + (p[1] - cy) * (scale + jit * j * 0.5)
            z = 0.0 if k == 0 else H * lift(x, y) * (zf + jit * j)
            v = bm.verts.new((x, y, z))
            v[ring_of] = k
            verts.append(v)
    bmesh.ops.convex_hull(bm, input=verts)
    for v in [v for v in bm.verts if not v.link_faces]:
        bm.verts.remove(v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)


@L.builder('opera_house')
def opera_house(blds, col):
    b = blds[0]
    cen = L.centroid(b['outer'])
    loc = L.local(c.clean_ring(b['outer']), cen)
    granite = tex_mat('GZ Landmark | opera granite', 'opera_granite')
    glass = tex_mat('GZ Landmark | opera glass', 'opera_glass', glow=(1.0, 0.78, 0.5), glow_k=2.2)
    square = Vector((1.0, 0.3, 0)).normalized()          # the foyers face Huacheng Square (east) and the river
    objs = []
    for name, side, H, overhang, seed, n in (('grand theatre', -1, 43.0, 0.07, 3, 14),
                                             ('multi-function hall', 1, 26.0, 0.09, 9, 11)):
        pts = [p for p in loc if p[0] * side > 3]
        if len(pts) < 3:
            continue
        pts = L.resample(pts, n)
        (px, py), ax, _ = ring_axes(pts)
        # the high end is the one away from the square
        peak = Vector((-ax[0], -ax[1], 0)) if Vector((ax[0], ax[1], 0)).dot(square) > 0 else Vector((ax[0], ax[1], 0))
        bm = bmesh.new()
        _wedge(bm, pts, H, peak, overhang, seed)
        uv = bm.loops.layers.uv.new('UVMap')
        ring_of = bm.verts.layers.int['ring']
        for f in bm.faces:
            n = f.normal
            lower = all(v[ring_of] <= 1 for v in f.verts)                    # between the ground and the eave
            facing = Vector((n.x, n.y, 0)).normalized().dot(square) if abs(n.z) < 0.99 else -1
            # glazing only where the foyers are: toward the square and the river; elsewhere stone to the ground
            f.material_index = 1 if lower and facing > 0.1 else 0
        metric_uv(bm, uv)
        o = L.place('Landmark | Opera House %s' % name, bm, [granite, glass], col, cen, 0, 'opera_house')
        objs.append(o)
    return objs[0] if objs else None


# ------------------------------------------------------------------ Guangdong Museum
RED = (0.13, 0.018, 0.014)          # oxblood, dark as photographed


def _box_face(bm, uv, mats, origin, u_dir, width, z0, z1, seed, notch_top=True):
    """One elevation of the treasure box, in its own frame: origin at the bottom-left corner, u_dir along the
    face, outward normal = u_dir x up. Blocks on a row/column grid (merged randomly), each a solid of relief
    0..0.9 m standing on a core recessed 1.4 m; some joints are open slots, some blocks are window recesses."""
    tile, red, glassm, roof = mats
    up = Vector((0, 0, 1))
    out = u_dir.cross(up)                          # outward normal of a CCW plan edge
    rnd = lambda i, s=0: c.hash01(i * 97 + s * 13, seed)

    def P(u, v, d):
        return origin + u_dir * u + up * v + out * d

    def quad(a, b_, cc, dd, mi, want):
        f = bm.faces.new([bm.verts.new(x) for x in (a, b_, cc, dd)])
        f.material_index = mi
        f.normal_update()
        if f.normal.dot(want) < 0:
            f.normal_flip()
        return f

    def box(u0, u1, v0, v1, d0, d1, front, sides):
        """Solid from depth d0 (back) to d1 (front): the front face and the four returns."""
        fs = [quad(P(u0, v0, d1), P(u1, v0, d1), P(u1, v1, d1), P(u0, v1, d1), front, out)]
        fs.append(quad(P(u0, v0, d0), P(u0, v0, d1), P(u0, v1, d1), P(u0, v1, d0), sides, -u_dir))
        fs.append(quad(P(u1, v0, d1), P(u1, v0, d0), P(u1, v1, d0), P(u1, v1, d1), sides, u_dir))
        fs.append(quad(P(u0, v1, d1), P(u1, v1, d1), P(u1, v1, d0), P(u0, v1, d0), sides, up))
        fs.append(quad(P(u0, v0, d0), P(u1, v0, d0), P(u1, v0, d1), P(u0, v0, d1), sides, -up))
        return fs

    # columns and rows
    cols, u = [], 0.0
    while u < width - 1e-6:
        w = min([6.0, 7.2, 8.4, 9.6, 12.0][int(rnd(len(cols), 1) * 5)], width - u)
        if width - u - w < 3.0:
            w = width - u
        cols.append((u, u + w)); u += w
    rows, v = [], z0
    while v < z1 - 1e-6:
        h = min([3.6, 4.8, 6.0, 7.2][int(rnd(len(rows), 2) * 4)], z1 - v)
        if z1 - v - h < 2.4:
            h = z1 - v
        rows.append((v, v + h)); v += h
    # the core (recessed skin, red where it shows) and the blocks
    box(0, width, z0, z1, -1.6, -1.4, red, red)
    faces = []
    for i, (u0, u1) in enumerate(cols):
        for j, (v0, v1) in enumerate(rows):
            r = rnd(i * 31 + j, 3)
            if r < 0.07 and 0 < j < len(rows) - 1:            # a window: the block is missing, glass at the core
                faces += box(u0 + 0.3, u1 - 0.3, v0 + 0.3, v1 - 0.3, -1.45, -1.4, glassm, red)
                continue
            # slots: an open joint on the right and/or top edge of some blocks (reads as L-shaped cuts)
            gr = 0.55 if rnd(i * 31 + j, 4) < 0.22 else 0.0
            gt = 0.55 if rnd(i * 31 + j, 5) < 0.18 else 0.0
            d = [0.0, 0.25, 0.5, 0.9][int(rnd(i * 31 + j, 6) * 4)]
            top = v1
            if notch_top and j == len(rows) - 1:
                top = v1 + [0.0, 0.0, 0.9, 1.8, 2.7][int(rnd(i, 7) * 5)]     # castellated skyline
            ua = u0 - (d + 1.4 if i == 0 else 0.0)                          # corner blocks close the corner
            ub = u1 - gr + (d + 1.4 if i == len(cols) - 1 else 0.0)
            faces += box(ua, ub, v0, top - gt, -1.4, d, tile, red)
    return faces


@L.builder('museum')
def museum(blds, col):
    b = blds[0]
    ring = c.clean_ring(b['outer'])
    cen = L.centroid(ring)
    loc = L.local(ring, cen)
    (cx, cy), ax, (ha, hc) = ring_axes(loc)
    # the box: the footprint's oriented bounding rectangle, a little inside it
    ux, uy = ax
    vx, vy = -uy, ux
    ha, hc = ha - 1.0, hc - 1.0
    corners = [Vector((cx + ux * a * ha + vx * s * hc, cy + uy * a * ha + vy * s * hc, 0)) for a, s in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    tile = tex_mat('GZ Landmark | museum stone', 'museum_tile')
    red = gm.plain('GZ Landmark | museum oxblood reveal', RED, 0.55)
    glass = gm.facade('GZ Landmark | museum recess glass', wall=(0.06, 0.06, 0.07), glass=(0.05, 0.06, 0.07), roof=(0.2, 0.2, 0.2),
                  floor_h=4.2, bay=1.5, win_w=0.96, sill=0.02, head=0.98, glass_metal=0.5, lit=0.85, warm=0.8, lit_k=3.0)
    roofm = gm.plain('GZ Landmark | museum roof', (0.34, 0.34, 0.33), 0.85)
    Z0, Z1 = 6.0, 38.0
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    faces = []
    for k in range(4):
        a, bb = corners[k], corners[(k + 1) % 4]
        d = bb - a
        faces += _box_face(bm, uv, (0, 1, 2, 3), a, d.normalized(), d.length, Z0, Z1, 11 + k)
    # underside of the floating box and the roof
    inner = [corners[k] + (Vector((cx, cy, 0)) - corners[k]).normalized() * 1.5 for k in range(4)]
    for z, flip in ((Z0, True), (Z1, False)):
        vs = [bm.verts.new((p.x, p.y, z)) for p in inner]
        f = bm.faces.new(vs[::-1] if flip else vs)
        f.material_index = 3 if not flip else 1
        faces.append(f)
    metric_uv(bm, uv)
    o = L.place('Landmark | Guangdong Museum treasure box', bm, [tile, red, glass, roofm], col, cen, 0, 'museum')
    # the recessed glass ground floor under the box
    base = [(p.x + (cx - p.x) * 0.1, p.y + (cy - p.y) * 0.1) for p in corners]
    bm2, uv2, tl = L.new_bm()
    c.extrude_polygon(bm2, base, [], 0.0, Z0, top=False, uv=uv2, tint=(tl, L.WHITE_TINT))
    L.place('Landmark | Guangdong Museum glass base', bm2, L.lm_mats()['museum_base'], col, cen, 0, 'museum')
    return o


# ------------------------------------------------------------------ Guangzhou Library
def _clip_half(ring, axis, cut, keep_above):
    """Clip a ring by the line {p . axis = cut}, keeping the side above (or below)."""
    def side(p):
        s = p[0] * axis[0] + p[1] * axis[1] - cut
        return s >= 0 if keep_above else s <= 0
    out = []
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        ia, ib = side(a), side(b)
        if ia:
            out.append(a)
        if ia != ib:
            sa = a[0] * axis[0] + a[1] * axis[1] - cut
            sb = b[0] * axis[0] + b[1] * axis[1] - cut
            t = sa / (sa - sb)
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def _line_span(ring, across, val, ax):
    """Along-axis extent (min, max) of the stretch of the line {p . across = val} inside the ring."""
    hits = []
    n = len(ring)
    for i in range(n):
        p, q = ring[i], ring[(i + 1) % n]
        sp = p[0] * across[0] + p[1] * across[1] - val
        sq = q[0] * across[0] + q[1] * across[1] - val
        if (sp < 0) != (sq < 0):
            t = sp / (sp - sq)
            x, y = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
            hits.append(x * ax[0] + y * ax[1])
    return (min(hits), max(hits)) if len(hits) >= 2 else None


@L.builder('library')
def library(blds, col):
    b = blds[0]
    ring = c.clean_ring(b['outer'])
    cen = L.centroid(ring)
    loc = L.local(ring, cen)
    if sum(loc[i][0] * loc[(i + 1) % len(loc)][1] - loc[(i + 1) % len(loc)][0] * loc[i][1] for i in range(len(loc))) < 0:
        loc = loc[::-1]                      # counter-clockwise, so wall faces point out
    (cx, cy), ax, (ha, hc) = ring_axes(loc)
    across = (-ax[1], ax[0])                 # the atrium runs along the long axis, between the two wings
    H, GAP, LEAN = 48.0, 20.0, 5.0
    stone = tex_mat('GZ Landmark | library stone louvers', 'library_louver', glow=(1.0, 0.86, 0.62), glow_k=1.6)
    glass = gm.facade('GZ Landmark | library atrium glass', wall=(0.55, 0.56, 0.56), glass=(0.10, 0.13, 0.15),
                      roof=(0.4, 0.4, 0.4), floor_h=4.8, bay=1.8, win_w=0.93, sill=0.03, head=0.97,
                      glass_metal=0.5, lit=0.8, warm=0.8, lit_k=3.0)
    roof = gm.plain('GZ Landmark | library roof', (0.46, 0.45, 0.42), 0.85)
    c0 = cx * across[0] + cy * across[1]
    objs = []
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    for name, sgn in (('north wing', 1), ('south wing', -1)):
        half = _clip_half(loc, across, c0 + sgn * GAP / 2, sgn > 0)
        half = c.clean_ring(half, 0.5)
        if len(half) < 3:
            continue
        # top ring: outer walls lean out by LEAN, atrium walls lean in to nearly close the cleft
        top = []
        for p in half:
            s = (p[0] * across[0] + p[1] * across[1] - c0) * sgn          # distance from the atrium axis (>= GAP/2)
            far = hc
            t = max(0.0, min(1.0, (s - GAP / 2) / max(1.0, far - GAP / 2)))
            shift = (-GAP / 2 + 0.8) * (1 - t) + LEAN * t                 # atrium side in, outside out
            a = p[0] * ax[0] + p[1] * ax[1]
            end_lean = 2.0 * (a - (cx * ax[0] + cy * ax[1])) / max(1.0, ha)   # the ends lean a little too
            top.append((p[0] + across[0] * shift * sgn + ax[0] * end_lean, p[1] + across[1] * shift * sgn + ax[1] * end_lean))
        n = len(half)
        lo = [bm.verts.new((p[0], p[1], 0.0)) for p in half]
        hi = [bm.verts.new((p[0], p[1], H)) for p in top]
        for i in range(n):
            j = (i + 1) % n
            try:
                f = bm.faces.new((lo[i], lo[j], hi[j], hi[i])); f.material_index = 0
            except ValueError:
                pass
        try:
            f = bm.faces.new(hi); f.material_index = 2
        except ValueError:
            pass
    metric_uv(bm, uv)
    objs.append(L.place('Landmark | Guangzhou Library wings', bm, [stone, glass, roof], col, cen, 0, 'library'))
    # the atrium: glass end walls closing the cleft and a glazed roof strip along the ridge. The cleft runs
    # only where both wings have their atrium wall (the plan is irregular, so not over the whole long axis):
    # from the later of the two walls' starts to the earlier of their ends, a little inside.
    ac = cx * ax[0] + cy * ax[1]
    spans = [_line_span(loc, across, c0 + s_ * GAP / 2, ax) for s_ in (-1, 1)]
    if None in spans:
        return objs[0]
    a_lo = max(spans[0][0], spans[1][0]) + 0.3
    a_hi = min(spans[0][1], spans[1][1]) - 0.3
    lean = lambda a: 2.0 * (a - ac) / max(1.0, ha)          # the wings' ends lean out along the axis (above)
    bm2, uv2, tl = L.new_bm()
    for end, a0 in ((-1, a_lo), (1, a_hi)):
        base_l = (ax[0] * a0 + across[0] * (c0 - GAP / 2), ax[1] * a0 + across[1] * (c0 - GAP / 2))
        base_r = (ax[0] * a0 + across[0] * (c0 + GAP / 2), ax[1] * a0 + across[1] * (c0 + GAP / 2))
        apex = (ax[0] * a0 + across[0] * c0, ax[1] * a0 + across[1] * c0)
        dl = lean(a0)
        vs = [bm2.verts.new((base_l[0], base_l[1], 0)), bm2.verts.new((base_r[0], base_r[1], 0)),
              bm2.verts.new((apex[0] + across[0] * 0.8 + ax[0] * dl, apex[1] + across[1] * 0.8 + ax[1] * dl, H)),
              bm2.verts.new((apex[0] - across[0] * 0.8 + ax[0] * dl, apex[1] - across[1] * 0.8 + ax[1] * dl, H))]
        f = bm2.faces.new(vs)
        f.normal_update()
        if f.normal.dot(Vector((ax[0] * end, ax[1] * end, 0))) < 0:
            f.normal_flip()
        for lp in f.loops:
            p = lp.vert.co
            lp[uv2].uv = (p.x * ax[1] - p.y * ax[0], p.z)
            lp[tl] = L.WHITE_TINT
    # glazed ridge over the atrium, between the two wing tops
    a0, a1 = a_lo + lean(a_lo), a_hi + lean(a_hi)
    q = [(a0, -0.9), (a1, -0.9), (a1, 0.9), (a0, 0.9)]
    vs = [bm2.verts.new((ax[0] * a + across[0] * (c0 + w), ax[1] * a + across[1] * (c0 + w), H - 0.3)) for a, w in q]
    f = bm2.faces.new(vs)
    f.normal_update()
    if f.normal.z < 0:
        f.normal_flip()
    for lp in f.loops:
        lp[uv2].uv = (lp.vert.co.x, lp.vert.co.y)
        lp[tl] = L.WHITE_TINT
    objs.append(L.place('Landmark | Guangzhou Library atrium glass', bm2, glass, col, cen, 0, 'library'))
    return objs[0]


# ------------------------------------------------------------------ Second Children's Palace
@L.builder('childrens_palace')
def childrens_palace(blds, col):
    import lm_towers as T
    b = blds[0]
    ring = c.clean_ring(b['outer'])
    if sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring))) < 0:
        ring = ring[::-1]
    ring = L.resample(ring, 72)
    ribs = tex_mat('GZ Landmark | palace aluminium ribs', 'metal_ribs')
    roof = gm.plain('GZ Landmark | palace roof', (0.42, 0.42, 0.41), 0.8)
    glass = gm.facade('GZ Landmark | palace glass drum', wall=(0.72, 0.74, 0.76), glass=(0.30, 0.36, 0.40),
                      roof=(0.5, 0.5, 0.5), floor_h=4.5, bay=2.4, win_w=0.95, sill=0.04, head=0.97,
                      glass_rough=0.05, glass_metal=0.4, lit=0.8, warm=0.7, lit_k=3.0, floor_bias=1.0)
    steel = gm.plain('GZ Landmark | palace white steel', (0.80, 0.80, 0.79), 0.35, metal=0.5)
    pink = gm.plain('GZ Landmark | palace pink band', (0.62, 0.36, 0.36), 0.4)
    (cx, cy) = L.centroid(ring)
    # the wavy parapet: 20..27 m, two slow waves round the building
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    n = len(ring)
    lo = [bm.verts.new((p[0], p[1], 0.0)) for p in ring]
    hi = []
    for i, p in enumerate(ring):
        a = math.atan2(p[1] - cy, p[0] - cx)
        hi.append(bm.verts.new((p[0], p[1], 23.5 + 3.5 * math.sin(2 * a + 0.6))))
    for i in range(n):
        j = (i + 1) % n
        f = bm.faces.new((lo[i], lo[j], hi[j], hi[i])); f.material_index = 0
    f = bm.faces.new([bm.verts.new((p[0], p[1], 20.0)) for p in ring]); f.material_index = 1
    metric_uv(bm, uv)
    L.place('Landmark | Children\'s Palace body', bm, [ribs, roof], col, (0, 0), 0, 'childrens_palace')
    # the square side: the facade edge facing +x (toward the axis); colonnade and canopy in front of it
    best, bi = -2, 0
    for i in range(n):
        p0, p1 = ring[i], ring[(i + 1) % n]
        e = Vector((p1[0] - p0[0], p1[1] - p0[1], 0)).normalized()
        nrm = Vector((e.y, -e.x, 0))
        if nrm.x > best:
            best, bi = nrm.x, i
    p0, p1 = Vector((*ring[bi], 0)), Vector((*ring[(bi + 1) % n], 0))
    mid = (p0 + p1) / 2
    e = (p1 - p0).normalized()
    nrm = Vector((e.y, -e.x, 0))
    bm2, uv2, tl2 = L.new_bm()
    for k in range(4):
        q = mid + e * (-15 + k * 10) + nrm * 4.0
        L.tube(bm2, [(q.x, q.y, 0.0), (q.x, q.y, 9.0)], 0.9, 12)
    q = mid + nrm * 3.0
    T._box(bm2, uv2, tl2, (q.x, q.y, 9.0), (e.x, e.y), (nrm.x, nrm.y), 44.0, 8.0, 1.0, L.WHITE_TINT)
    # the drum on the roof, inverted cone, with its brim on brackets
    dc = Vector((cx, cy, 0)) - nrm * 22.0
    rings, zs = [], []
    for z, ra, rb in ((20.0, 13.0, 9.5), (27.0, 15.5, 11.5), (37.0, 18.5, 13.5)):
        rings.append(L.ellipse(ra, rb, math.atan2(e.y, e.x), 40, cx=dc.x, cy=dc.y)); zs.append(z)
    bm3, uv3, tl3 = L.new_bm()
    L.loft(bm3, rings, zs, uv=uv3, tint=(tl3, L.WHITE_TINT), cap_top=True)
    L.place('Landmark | Children\'s Palace glass drum', bm3, glass, col, (0, 0), 0, 'childrens_palace')
    bm4, uv4, tl4 = L.new_bm()
    brim_in = L.ellipse(15.5, 11.5, math.atan2(e.y, e.x), 40, cx=dc.x, cy=dc.y)
    brim_out = L.ellipse(21.0, 16.5, math.atan2(e.y, e.x), 40, cx=dc.x, cy=dc.y)
    L.loft(bm4, [brim_out, brim_out], [26.6, 27.4], uv=uv4, tint=(tl4, L.WHITE_TINT), cap_top=False)
    for k in range(40):
        a, b_ = brim_in[k], brim_out[k]
        c2, d2 = brim_in[(k + 1) % 40], brim_out[(k + 1) % 40]
        for z, flip in ((27.4, False), (26.6, True)):
            vs = [bm4.verts.new((x, y, z)) for x, y in (a, b_, d2, c2)]
            bm4.faces.new(vs[::-1] if flip else vs)
        if k % 4 == 0:
            L.tube(bm4, [(a[0], a[1], 23.0), (b_[0], b_[1], 26.6)], 0.18, 6)
    bm5, uv5, tl5 = L.new_bm()
    # on the drum's surface (it widens 0.3 m per metre up), a hair proud of the glass
    band = [L.ellipse(16.25, 12.05, math.atan2(e.y, e.x), 40, cx=dc.x, cy=dc.y), L.ellipse(17.15, 12.85, math.atan2(e.y, e.x), 40, cx=dc.x, cy=dc.y)]
    L.loft(bm5, band, [29.0, 32.0], uv=uv5, tint=(tl5, L.WHITE_TINT), cap_top=False)
    c.obj_from_bmesh('Landmark | Children\'s Palace colonnade', bm2, steel, col)['gz_landmark'] = 'childrens_palace'
    c.obj_from_bmesh('Landmark | Children\'s Palace brim', bm4, steel, col)['gz_landmark'] = 'childrens_palace'
    c.obj_from_bmesh('Landmark | Children\'s Palace pink band', bm5, pink, col)['gz_landmark'] = 'childrens_palace'
    return None
