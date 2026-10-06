"""Tianhe landmarks, hand-modelled for recognisability (replacing the OSM footprints tagged `landmark`).

Each landmark is built in its own local frame (origin at the base centre, measured from OSM) and placed with
object location/rotation, so Object coordinates in shaders are "height above the landmark's base".

  canton_tower      Canton Tower, 600 m: 24 straight columns between an 80x60 m base ellipse and a 54x40.5 m
                    top ellipse (454 m) turned +135 deg -> the hyperboloid waist falls out; 46 ring beams,
                    diagonals, elliptical core, five enclosed zones, top deck, bubble-tram ring, 146 m mast.
                    Twist sign checked against the OSM 25 m slices (base -44 deg, top -89 deg).
  west_tower        Guangzhou IFC, 440 m: bulged rounded-triangle plan, cigar profile, white diagrid (8 x 54 m).
  east_tower        CTF Finance Centre, 530 m: square plan with corner notches that deepen at each of four
                    setbacks, vertical terracotta piers, crown fins; podium from OSM.
  opera_house, museum, library   see lm_culture.py (rebuilt against photographs, baked texture kits).
  childrens_palace  Second Children's Palace: white banded volume.
  + Liede Bridge pylon/cables and Haixin Bridge arch (superstructure over the generated decks).
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math

import bmesh
import bpy
from mathutils import Vector

import gz_city
import gz_common as c
import gz_materials as gm
from gz_materials import NB

BUILDERS = {}


def builder(key):
    def deco(fn):
        BUILDERS[key] = fn
        return fn
    return deco


# ------------------------------------------------------------------ helpers
def resample(ring, n):
    """n points evenly spaced by arclength around a closed ring."""
    pts = list(ring) + [ring[0]]
    s = [0.0]
    for a, b in zip(pts, pts[1:]):
        s.append(s[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    out, j = [], 0
    for i in range(n):
        u = s[-1] * i / n
        while s[j + 1] < u: j += 1
        f = (u - s[j]) / max(1e-9, s[j + 1] - s[j])
        out.append((pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f))
    return out


def perim(ring):
    return sum(math.hypot(ring[(i + 1) % len(ring)][0] - p[0], ring[(i + 1) % len(ring)][1] - p[1]) for i, p in enumerate(ring))


def loft(bm, rings, zs, uv=None, tint=None, cap_top=True, cap_bottom=False, u_mode='param'):
    """Quads between successive rings (equal point counts, CCW) at heights zs.
    UV u: 'param' = i/n x base perimeter (vertical mullions stay vertical as the plan scales) or 'arc'."""
    n = len(rings[0])
    P0 = perim(rings[0])
    rows = [[bm.verts.new((p[0], p[1], z)) for p in r] for r, z in zip(rings, zs)]
    for k in range(len(rows) - 1):
        ua = _us(rings[k], P0, u_mode); ub = _us(rings[k + 1], P0, u_mode)
        for i in range(n):
            j = (i + 1) % n
            try:
                f = bm.faces.new((rows[k][i], rows[k][j], rows[k + 1][j], rows[k + 1][i]))
            except ValueError:
                continue
            uj_a = ua[i + 1]; uj_b = ub[i + 1]
            for lp, (u, v) in zip(f.loops, ((ua[i], zs[k]), (uj_a, zs[k]), (uj_b, zs[k + 1]), (ub[i], zs[k + 1]))):
                if uv: lp[uv].uv = (u, v)
                if tint: lp[tint[0]] = tint[1]
    if cap_top:
        c.fill_polygon(bm, rings[-1], [], zs[-1], uv=uv, tint=tint)
    if cap_bottom:
        c.fill_polygon(bm, rings[0], [], zs[0], flip=True, uv=uv, tint=tint)


def _us(ring, P0, mode):
    n = len(ring)
    if mode == 'param':
        return [P0 * i / n for i in range(n + 1)]
    s = [0.0]
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        s.append(s[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return s


def tube(bm, pts, r, sides=6, cap=True):
    """Polyline tube with rings oriented by the local tangent."""
    P = [Vector(p) for p in pts]
    if len(P) < 2:
        return
    rings = []
    ref = Vector((0, 0, 1))
    for i in range(len(P)):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        a = (ref - t * ref.dot(t))
        if a.length < 1e-3:
            a = Vector((1, 0, 0)) - t * t.x
        a.normalize(); b = t.cross(a)
        rings.append([bm.verts.new(P[i] + (a * math.cos(2 * math.pi * k / sides) + b * math.sin(2 * math.pi * k / sides)) * r)
                      for k in range(sides)])
    for q in range(len(rings) - 1):
        for k in range(sides):
            l = (k + 1) % sides
            try: bm.faces.new((rings[q][k], rings[q][l], rings[q + 1][l], rings[q + 1][k]))
            except ValueError: pass
    if cap:
        for rg in (rings[0], rings[-1][::-1]):
            try: bm.faces.new(rg[::-1])
            except ValueError: pass


def ellipse(a, b, ang, n, phase=0.0, cx=0.0, cy=0.0):
    ca, sa = math.cos(ang), math.sin(ang)
    out = []
    for i in range(n):
        t = phase + 2 * math.pi * i / n
        x, y = a * math.cos(t), b * math.sin(t)
        out.append((cx + ca * x - sa * y, cy + sa * x + ca * y))
    return out


def new_bm():
    bm = bmesh.new()
    return bm, bm.loops.layers.uv.new('UVMap'), bm.loops.layers.float_color.new('tint')


def place(name, bm, mats, col, loc, rot=0.0, key=None):
    o = c.obj_from_bmesh(name, bm, mats, col)
    o.location = (loc[0], loc[1], 0.0)
    o.rotation_euler = (0, 0, rot)
    if key: o['gz_landmark'] = key
    return o


def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def local(ring, cen, rot=0.0):
    ca, sa = math.cos(-rot), math.sin(-rot)
    return [((p[0] - cen[0]) * ca - (p[1] - cen[1]) * sa, (p[0] - cen[0]) * sa + (p[1] - cen[1]) * ca) for p in ring]


WHITE_TINT = (1, 1, 1, 0.5)


# ------------------------------------------------------------------ materials
def lm_mats():
    M = {}
    M['ifc_glass'] = gm.facade('GZ Landmark | IFC glass', wall=(0.46, 0.50, 0.51), glass=(0.12, 0.18, 0.20),
                               roof=(0.30, 0.30, 0.30), floor_h=4.3, bay=1.6, win_w=0.9, sill=0.16, head=0.97,
                               glass_rough=0.03, glass_metal=0.65, lit=0.3, warm=0.35, lit_k=3.0, floor_bias=0.7)
    M['ifc_grid'] = gm.plain_lit('GZ Landmark | IFC diagrid', (0.70, 0.71, 0.70), 0.4, 0.2, (0.8, 0.9, 1.0), 3.5)
    M['ctf'] = gm.facade('GZ Landmark | CTF terracotta piers', wall=(0.64, 0.62, 0.57), glass=(0.10, 0.13, 0.16),
                         roof=(0.32, 0.32, 0.31), floor_h=4.5, bay=4.5, win_w=0.7, sill=0.03, head=0.995,
                         glass_rough=0.04, glass_metal=0.5, lit=0.3, warm=0.3, lit_k=3.0, floor_bias=0.7)
    M['ctf_fin'] = gm.plain_lit('GZ Landmark | CTF crown fins', (0.66, 0.64, 0.60), 0.5, 0.0, (1.0, 0.95, 0.85), 5.0)
    M['podium'] = gm.building_mats()['podium']
    M['core'] = gm.plain('GZ Landmark | concrete core', (0.52, 0.52, 0.50), 0.7)
    M['ct_glass'] = gm.facade('GZ Landmark | Canton Tower glass', wall=(0.55, 0.56, 0.56), glass=(0.10, 0.13, 0.15),
                              roof=(0.55, 0.55, 0.54), floor_h=5.0, bay=3.2, win_w=0.86, sill=0.1, head=0.95,
                              glass_metal=0.5, lit=0.75, warm=0.6, lit_k=3.0)
    M['ct_steel'] = canton_steel()
    M['red'] = gm.emissive('GZ Landmark | aviation red', (1.0, 0.04, 0.02), 30.0)
    M['white'] = gm.plain_lit('GZ Landmark | white steel', (0.74, 0.74, 0.72), 0.35, 0.3, (0.85, 0.92, 1.0), 1.1)
    M['pebble_dark'] = pebble('GZ Landmark | opera dark granite', (0.055, 0.055, 0.06), (0.62, 0.62, 0.60))
    M['pebble_light'] = pebble('GZ Landmark | opera light granite', (0.46, 0.46, 0.44), (0.16, 0.16, 0.16))
    M['museum'] = treasure_box()
    M['museum_base'] = gm.facade('GZ Landmark | museum base glass', wall=(0.2, 0.2, 0.2), glass=(0.05, 0.06, 0.07),
                                 roof=(0.3, 0.3, 0.3), floor_h=9.0, bay=3.0, win_w=0.94, sill=0.02, head=0.98,
                                 glass_metal=0.5, lit=0.9, warm=0.8, lit_k=3.0)
    M['library'] = gm.facade('GZ Landmark | library stone strata', wall=(0.60, 0.56, 0.48), glass=(0.06, 0.07, 0.08),
                             roof=(0.4, 0.39, 0.36), floor_h=1.6, bay=0.95, win_w=0.5, sill=0.42, head=0.96,
                             lit=0.6, warm=0.9, lit_k=2.5)
    M['palace'] = gm.facade('GZ Landmark | children palace bands', wall=(0.74, 0.73, 0.70), glass=(0.07, 0.09, 0.11),
                            roof=(0.45, 0.45, 0.43), floor_h=4.5, bay=5.0, win_w=0.96, sill=0.5, head=0.86,
                            lit=0.5, warm=0.5, lit_k=3.0)
    return M


def canton_steel():
    """White steel; at night the famous LED skin -- a height gradient magenta -> violet -> blue -> cyan -> white."""
    name = 'GZ Landmark | Canton Tower steel LED'
    if name in gm.MATS:
        return gm.MATS[name]
    m = gm.new(name); m.diffuse_color = (0.75, 0.75, 0.73, 1)
    m['gz_led'] = json.dumps({'height': 600.0, 'stops': [[0.0, [1.0, 0.08, 0.45]], [0.3, [0.55, 0.08, 1.0]], [0.55, [0.08, 0.35, 1.0]],
                                                        [0.78, [0.05, 0.9, 0.95]], [1.0, [1, 1, 1]]], 'strength': 9.0})
    k = NB(m)
    _, _, z = k.sep(k.node('ShaderNodeTexCoord').outputs['Object'])
    ramp = k.node('ShaderNodeValToRGB')
    k.put(ramp.inputs['Fac'], k.math('DIVIDE', z, 600.0))
    els = ramp.color_ramp.elements
    stops = [(0.0, (1.0, 0.08, 0.45)), (0.3, (0.55, 0.08, 1.0)), (0.55, (0.08, 0.35, 1.0)), (0.78, (0.05, 0.9, 0.95)), (1.0, (1, 1, 1))]
    els[0].position, els[0].color = stops[0][0], (*stops[0][1], 1)
    els[1].position, els[1].color = stops[-1][0], (*stops[-1][1], 1)
    for p, col in stops[1:-1]:
        e = els.new(p); e.color = (*col, 1)
    k.bsdf(Base_Color=(0.75, 0.75, 0.73), Roughness=0.35, Metallic=0.3, Emission_Color=ramp.outputs['Color'],
           Emission_Strength=k.math('MULTIPLY', k.night(), 9.0))
    return m


def pebble(name, stone, seam):
    """Faceted granite with light seams along the triangulation and ~25 % dark glass facets (lit at night)."""
    if name in gm.MATS:
        return gm.MATS[name]
    m = gm.new(name); m.diffuse_color = (*stone, 1)
    m['gz_pebble'] = json.dumps({'stone': stone, 'seam': seam})
    k = NB(m)
    wf = k.node('ShaderNodeWireframe', use_pixel_size=False); wf.inputs['Size'].default_value = 0.45
    fac = k.node('ShaderNodeAttribute', attribute_name='facet').outputs['Fac']
    glass = k.math('LESS_THAN', fac, 0.25)
    stone_c = k.mixc(k.math('MULTIPLY', k.noise(k.node('ShaderNodeTexCoord').outputs['Object'], 0.4, 4.0), 0.5), stone,
                     tuple(min(1, s * 1.35) for s in stone))
    col = k.mixc(glass, stone_c, (0.02, 0.03, 0.035))
    col = k.mixc(wf.outputs[0], col, seam)
    rough = k.mixf(glass, 0.6, 0.04)
    metal = k.mixf(glass, 0.0, 0.6)
    k.bsdf(Base_Color=col, Roughness=rough, Metallic=metal, Emission_Color=(1.0, 0.78, 0.5),
           Emission_Strength=k.math('MULTIPLY', k.math('MULTIPLY', glass, k.night()), 1.4))
    return m


def treasure_box():
    """Dark lacquer box with irregular carved slots (random-width openings on a 7 m x 3.3 m cell grid)."""
    name = 'GZ Landmark | museum treasure box'
    if name in gm.MATS:
        return gm.MATS[name]
    m = gm.new(name); m.diffuse_color = (0.08, 0.075, 0.07, 1)
    m['gz_box'] = json.dumps({'cell': [7.0, 3.3]})
    k = NB(m)
    u, v, _ = k.sep(k.node('ShaderNodeTexCoord').outputs['UV'])
    _, _, nz = k.sep(k.node('ShaderNodeNewGeometry').outputs['Normal'])
    wallm = k.math('LESS_THAN', k.math('ABSOLUTE', nz), 0.5)
    su, sv = k.math('DIVIDE', u, 7.0), k.math('DIVIDE', v, 3.3)
    cu, cv = k.math('FLOOR', su), k.math('FLOOR', sv)
    fu, fv = k.math('FRACT', su), k.math('FRACT', sv)
    h1, hc = k.white(k.comb(cu, cv, 1.7))
    hr, hg, hb = k.sep(hc)
    w = k.math('ADD', 0.25, k.math('MULTIPLY', hr, 0.7))
    x0 = k.math('MULTIPLY', hg, k.math('SUBTRACT', 1.0, w))
    open_ = k.math('MULTIPLY', k.math('LESS_THAN', h1, 0.42),
                   k.math('MULTIPLY', k.between(fu, x0, k.math('ADD', x0, w)), k.between(fv, 0.3, 0.72)))
    open_ = k.math('MULTIPLY', open_, wallm)
    col = k.mixc(open_, (0.06, 0.055, 0.05), (0.55, 0.42, 0.24))
    k.bsdf(Base_Color=col, Roughness=k.mixf(open_, 0.45, 0.25), Metallic=k.mixf(open_, 0.2, 0.7),
           Emission_Color=(1.0, 0.72, 0.4), Emission_Strength=k.math('MULTIPLY', k.math('MULTIPLY', open_, k.night()), 2.5))
    return m


# ------------------------------------------------------------------ Canton Tower
@builder('canton_tower')
def canton_tower(blds, col):
    M = lm_mats()
    byid = {b['id']: b for b in blds}
    base_c = centroid(byid[584204634]['outer'])
    top_c = centroid(byid[905101058]['outer'])
    ang = math.radians(-44.1)
    H, N = 454.0, 24
    tdx, tdy = top_c[0] - base_c[0], top_c[1] - base_c[1]
    def col_pt(i, z):
        """Column i at height z: straight line base ellipse -> top ellipse turned +135 deg."""
        t = z / H
        th = 2 * math.pi * i / N
        ca, sa = math.cos(ang), math.sin(ang)
        bx, by = 40 * math.cos(th), 30 * math.sin(th)
        b = (ca * bx - sa * by, sa * bx + ca * by)
        a2 = ang + math.radians(135)
        c2, s2 = math.cos(a2), math.sin(a2)
        tx, ty = 27 * math.cos(th), 20.25 * math.sin(th)
        tp = (c2 * tx - s2 * ty + tdx, s2 * tx + c2 * ty + tdy)
        return (b[0] + (tp[0] - b[0]) * t, b[1] + (tp[1] - b[1]) * t, z)
    bm = bmesh.new()
    # columns (2 m tubes, sampled so they can be bent later if needed), 46 ring beams, diagonals
    for i in range(N):
        tube(bm, [col_pt(i, 0), col_pt(i, H)], 1.05, 8)
    rings_z = [H * k / 46 for k in range(1, 47)]
    for z in rings_z:
        for i in range(N):
            tube(bm, [col_pt(i, z), col_pt((i + 1) % N, z)], 0.85, 4, cap=False)
    for k in range(len(rings_z) - 1):
        for i in range(N):
            tube(bm, [col_pt(i, rings_z[k]), col_pt((i + 1) % N, rings_z[k + 1])], 0.5, 4, cap=False)
    # top deck + bubble-tram capsules on the rim
    top = [col_pt(i, H)[:2] for i in range(N)]
    c.extrude_polygon(bm, resample(top, 48), [], H - 2.5, H + 0.8)
    for i in range(16):
        p = col_pt(i * 1.5, H)
        cx, cy = tdx, tdy
        v = Vector((p[0] - cx, p[1] - cy)) * 1.04
        res = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=5, radius=1.6)
        for vv in res['verts']:
            vv.co += Vector((cx + v.x, cy + v.y, H + 2.4))
    # mast: 454 -> 600 with the 488 m open deck
    tube(bm, [(tdx, tdy, H), (tdx, tdy, 488)], 6.2, 8)
    c.extrude_polygon(bm, ellipse(9, 9, 0, 16, cx=tdx, cy=tdy), [], 487, 489)
    tube(bm, [(tdx, tdy, 488), (tdx, tdy, 560), (tdx, tdy, 600)], 3.2, 8)
    for i in range(8):  # lattice legs taper the upper mast visually
        a = 2 * math.pi * i / 8
        tube(bm, [(tdx + 4.2 * math.cos(a), tdy + 4.2 * math.sin(a), 489), (tdx + 1.0 * math.cos(a), tdy + 1.0 * math.sin(a), 598)], 0.35, 4)
    steel = place('Landmark | Canton Tower lattice + mast', bm, M['ct_steel'], col, base_c, 0, 'canton_tower')
    # core + enclosed zones
    bm, uv, tl = new_bm()
    core = []
    for z in (0, H):
        t = z / H
        core.append(ellipse(8.5, 7.0, ang, 32, cx=tdx * t, cy=tdy * t))
    loft(bm, core, [0, H], uv=uv, tint=(tl, WHITE_TINT))
    coreo = place('Landmark | Canton Tower core', bm, M['core'], col, base_c, 0, 'canton_tower')
    bm, uv, tl = new_bm()
    for z0, z1 in ((0.0, 32.8), (116.0, 160.0), (168.0, 204.0), (334.0, 375.0), (407.0, 452.0)):
        zs = [z0 + (z1 - z0) * q / max(1, int((z1 - z0) / 5)) for q in range(int((z1 - z0) / 5) + 1)]
        rings = []
        for z in zs:
            t = z / H
            cx, cy = tdx * t, tdy * t
            rings.append([(cx + (p[0] - cx) * 0.93, cy + (p[1] - cy) * 0.93) for p in (col_pt(i, z)[:2] for i in range(N))])
        rings = [resample(r, 48) for r in rings]
        loft(bm, rings, zs, uv=uv, tint=(tl, (1, 1, 1, 0.3)), cap_top=True, cap_bottom=z0 > 0)
    place('Landmark | Canton Tower enclosed zones', bm, M['ct_glass'], col, base_c, 0, 'canton_tower')
    # aviation lights
    bm = bmesh.new()
    for z in (600.0, 560.0, 520.0, 454.0):
        res = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=1.2 if z > 500 else 0.9)
        for vv in res['verts']:
            vv.co += Vector((tdx, tdy + (0 if z > 500 else 20.5), z + 0.8))
    place('Landmark | Canton Tower aviation lights', bm, M['red'], col, base_c, 0, 'canton_tower')
    # the long low entrance hall west of the tower keeps its OSM footprint
    others = [b for b in blds if b['id'] == 521222276]
    if others:
        bm, uv, tl = new_bm()
        b = others[0]
        c.extrude_polygon(bm, c.clean_ring(b['outer']), [], 0, 12.0, uv=uv, tint=(tl, WHITE_TINT))
        c.obj_from_bmesh('Landmark | Canton Tower entrance hall', bm, M['podium'], col)
    return steel


# ------------------------------------------------------------------ West Tower (Guangzhou IFC)
def ifc_ring(n, r_mid=25.5, r_corner=36.0, phi=math.radians(162)):
    """Bulged rounded triangle, corners toward phi, phi+120, phi+240 (fitted to the OSM outline)."""
    out = []
    for i in range(n):
        th = 2 * math.pi * i / n
        w = ((1 + math.cos(3 * (th - phi))) / 2) ** 1.6
        r = r_mid + (r_corner - r_mid) * w
        out.append((r * math.cos(th), r * math.sin(th)))
    return out


@builder('west_tower')
def west_tower(blds, col):
    M = lm_mats()
    b = blds[0]
    cen = centroid(b['outer'])
    H, ROOF = 440.0, 432.0
    base = ifc_ring(96)
    def s(z):
        t = min(1.0, z / ROOF)
        return 1 + 0.33 * t - 0.55 * t * t
    zs = [ROOF * q / 40 for q in range(41)]
    bm, uv, tl = new_bm()
    rings = [[(p[0] * s(z), p[1] * s(z)) for p in base] for z in zs]
    loft(bm, rings, zs, uv=uv, tint=(tl, (1, 1, 1, 0.61)), cap_top=True)
    # crown: glass screen 8 m above the roof
    top = rings[-1]
    loft(bm, [top, top], [ROOF, H], uv=uv, tint=(tl, (1, 1, 1, 0.61)), cap_top=False)
    glass = place('Landmark | West Tower (IFC) glass', bm, M['ifc_glass'], col, cen, 0, 'west_tower')
    # diagrid: 12 nodes around, node levels every 54 m, members hug the curved surface 0.7 m proud
    bm = bmesh.new()
    NN, LV = 12, 8
    dz = ROOF / LV
    def surf(tpar, z):
        th = 2 * math.pi * tpar
        # radius of the base ring at angle th, scaled by the profile
        r = ifc_ring(1, phi=math.radians(162) - th)[0][0]
        k = s(z)
        return ((r * k + 0.7) * math.cos(th), (r * k + 0.7) * math.sin(th), z)
    for k in range(LV):
        for i in range(NN):
            t0 = (i + 0.5 * (k % 2)) / NN
            for sgn in (1, -1):
                t1 = t0 + sgn * 0.5 / NN
                path = [surf(t0 + (t1 - t0) * q / 10, k * dz + dz * q / 10) for q in range(11)]
                tube(bm, path, 0.8, 6)
    for k in range(1, LV + 1):  # node rings (none at the ground: the diagonals land on the paving, as on the real tower)
        z = k * dz
        tube(bm, [surf(q / 96, z) for q in range(97)], 0.45, 4, cap=False)
    place('Landmark | West Tower (IFC) diagrid', bm, M['ifc_grid'], col, cen, 0, 'west_tower')
    return glass


# ------------------------------------------------------------------ East Tower (CTF Finance Centre)
def ctf_ring(a, n):
    """Square of half-width a with square corner notches of depth n (12 points, CCW)."""
    return [(a - n, -a), (a - n, -a + n), (a, -a + n), (a, a - n), (a - n, a - n), (a - n, a),
            (-a + n, a), (-a + n, a - n), (-a, a - n), (-a, -a + n), (-a + n, -a + n), (-a + n, -a)]


@builder('east_tower')
def east_tower(blds, col):
    M = lm_mats()
    tower = next(b for b in blds if b['h'] > 100)
    cen = centroid(tower['outer'])
    rot = math.radians(2.5)
    # (z0, z1, half-width, notch): five tiers, corner notches deepen at each setback, 8 m glazed skirts between
    tiers = [(0, 118, 32.5, 3.0), (126, 240, 31.5, 5.0), (248, 352, 30.0, 7.0), (360, 452, 28.5, 9.0), (460, 512, 27.0, 11.0)]
    rings, zs = [], []
    for z0, z1, a, n in tiers:
        rings += [ctf_ring(a, n), ctf_ring(a, n)]; zs += [z0, z1]
    bm, uv, tl = new_bm()
    loft(bm, rings, zs, uv=uv, tint=(tl, (1, 1, 1, 0.37)), cap_top=True, u_mode='arc')
    body = place('Landmark | East Tower (CTF)', bm, M['ctf'], col, cen, rot, 'east_tower')
    # crown: vertical fins continuing 18 m above the roof on every face
    bm = bmesh.new()
    a, n = 27.0, 11.0
    for side in range(4):
        ca, sa = math.cos(side * math.pi / 2), math.sin(side * math.pi / 2)
        for q in range(-7, 8):
            x, y = a + 0.2, q * 2.2
            if abs(y) > a - n: continue
            fx, fy = ca * x - sa * y, sa * x + ca * y
            h = 512 + 18 - abs(q) * 0.6
            c.extrude_polygon(bm, [(fx - 0.3 * ca + 0.25 * sa, fy - 0.3 * sa - 0.25 * ca), (fx + 0.3 * ca + 0.25 * sa, fy + 0.3 * sa - 0.25 * ca),
                                   (fx + 0.3 * ca - 0.25 * sa, fy + 0.3 * sa + 0.25 * ca), (fx - 0.3 * ca - 0.25 * sa, fy - 0.3 * sa + 0.25 * ca)], [], 505, h)
    place('Landmark | East Tower (CTF) crown fins', bm, M['ctf_fin'], col, cen, rot, 'east_tower')
    bm = bmesh.new()
    res = bmesh.ops.create_uvsphere(bm, u_segments=8, v_segments=6, radius=1.0)
    for vv in res['verts']: vv.co += Vector((0, 0, 531))
    place('Landmark | East Tower aviation light', bm, M['red'], col, cen, rot, 'east_tower')
    for p in blds:
        if p['h'] < 100:
            bm, uv, tl = new_bm()
            c.extrude_polygon(bm, c.clean_ring(p['outer']), [], 0, 30.0, uv=uv, tint=(tl, (1.05, 1.05, 1.05, 0.2)))
            c.obj_from_bmesh('Landmark | East Tower podium (K11)', bm, M['podium'], col)
    return body


# ------------------------------------------------------------------ Opera House
# ------------------------------------------------------------------ bridges (superstructure over generated decks)
def _water_run(pts):
    R = gz_city.raster()
    dense = gz_city.densify(pts, 4.0)
    wet = [i for i, p in enumerate(dense) if R.at('water', *p)]
    return dense, (wet[0], wet[-1]) if wet else None


def liede_bridge(col):
    """Self-anchored suspension bridge: one pylon in the median mid-river with a scallop-shell crown, main
    cables in the median plane falling 219 m to each side, hangers every 12 m."""
    M = lm_mats()
    rd = {r['id']: r for r in gz_city.data()['roads']}
    if 233809684 not in rd or 440897019 not in rd:
        return
    a = gz_city.densify(rd[233809684]['pts'], 5.0)
    bpts = gz_city.densify(rd[440897019]['pts'][::-1], 5.0)
    n = min(len(a), len(bpts))
    ai = [a[int(i * (len(a) - 1) / (n - 1))] for i in range(n)]
    bi = [bpts[int(i * (len(bpts) - 1) / (n - 1))] for i in range(n)]
    med = [((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) for p, q in zip(ai, bi)]
    dense, run = _water_run(med)
    if not run:
        return
    s = gz_city.arclen(dense)
    sm = (s[run[0]] + s[run[1]]) / 2
    def at(u):
        for i in range(len(s) - 1):
            if s[i + 1] >= u:
                f = (u - s[i]) / max(1e-9, s[i + 1] - s[i])
                return Vector((dense[i][0] + (dense[i + 1][0] - dense[i][0]) * f, dense[i][1] + (dense[i + 1][1] - dense[i][1]) * f))
        return Vector(dense[-1])
    P = at(sm)
    tang = (at(sm + 5) - at(sm - 5)).normalized()
    nrm = Vector((-tang.y, tang.x))
    DECK, TOP = 13.0, 104.0
    bm = bmesh.new()
    # pylon: tapered shaft, legs straddle the median
    tube(bm, [(P.x, P.y, gz_city.RIVER_CUT), (P.x, P.y, DECK - 1.5)], 7.0, 10)
    for sgn in (1, -1):
        tube(bm, [(P.x + nrm.x * sgn * 3.5, P.y + nrm.y * sgn * 3.5, DECK - 2), (P.x + nrm.x * sgn * 1.8, P.y + nrm.y * sgn * 1.8, TOP - 16)], 1.8, 8)
    # scallop-shell crown: seven blades fanning across the bridge
    for q in range(7):
        ang = math.radians(-60 + q * 20)
        d3 = Vector((nrm.x * math.sin(ang), nrm.y * math.sin(ang), math.cos(ang)))
        base = Vector((P.x, P.y, TOP - 18))
        tube(bm, [base, base + d3 * 16, base + d3 * 26 + Vector((0, 0, 3))], 1.3 - 0.08 * abs(q - 3), 6)
    rim = []
    for q in range(13):  # shell rim through the blade tips
        ang = math.radians(-60 + q * 10)
        rim.append(Vector((P.x, P.y, TOP - 15)) + Vector((nrm.x * math.sin(ang), nrm.y * math.sin(ang), math.cos(ang))) * 26)
    tube(bm, rim, 0.9, 6)
    # main cables + hangers
    L = 219.0
    for sgn in (1, -1):
        pts = []
        for q in range(41):
            u = q / 40
            d = u * L
            z = DECK + 2 + (TOP - 20 - DECK - 2) * (1 - u) ** 2
            p = at(sm + sgn * d)
            pts.append((p.x, p.y, z))
        tube(bm, pts, 0.45, 6)
        for q in range(1, int(L / 12)):
            d = q * 12.0; u = d / L
            z = DECK + 2 + (TOP - 20 - DECK - 2) * (1 - u) ** 2
            p = at(sm + sgn * d)
            tube(bm, [(p.x, p.y, DECK + 0.5), (p.x, p.y, z)], 0.08, 3, cap=False)
    o = c.obj_from_bmesh('Landmark | Liede Bridge pylon + cables', bm, M['white'], col)
    o['gz_landmark'] = 'liede_bridge'


def haixin_bridge(col):
    """Haixin footbridge (Haixinsha -> Canton Tower bank): one inclined white arch over the river, 'guqin' strings."""
    M = lm_mats()
    rd = {r['id']: r for r in gz_city.data()['roads']}
    if 1024168459 not in rd:
        return
    dense, run = _water_run(rd[1024168459]['pts'])
    if not run:
        return
    i0, i1 = run
    A, B = Vector(dense[i0]), Vector(dense[i1])
    span = (B - A).length
    tang = (B - A).normalized(); nrm = Vector((-tang.y, tang.x))
    RISE, DECK, TILT = 42.0, 9.0, math.radians(18)
    bm = bmesh.new()
    arch = []
    for q in range(49):
        u = q / 48
        p = A + (B - A) * u
        h = RISE * 4 * u * (1 - u)
        off = nrm * (math.sin(TILT) * h + 9.0)
        arch.append((p.x + off.x, p.y + off.y, DECK - 1 + math.cos(TILT) * h))
    tube(bm, arch, 1.1, 8)
    # strings from the arch to the nearest deck point
    for q in range(4, 45, 3):
        ax, ay, az = arch[q]
        best = min(dense[i0:i1 + 1], key=lambda p: (p[0] - ax) ** 2 + (p[1] - ay) ** 2)
        tube(bm, [(best[0], best[1], DECK + 0.6), (ax, ay, az)], 0.07, 3, cap=False)
    o = c.obj_from_bmesh('Landmark | Haixin Bridge arch', bm, M['white'], col)
    o['gz_landmark'] = 'haixin_bridge'


# ------------------------------------------------------------------ entry
def blockout(key, blds, col):
    FM = gm.building_mats()
    bm, uv, tl = new_bm()
    for b in blds:
        outer = c.clean_ring(b['outer'])
        if not outer:
            continue
        z0 = b['minh'] if b['part'] else 0.0
        c.extrude_polygon(bm, outer, [h for h in (c.clean_ring(h) for h in b['holes']) if h], z0, max(z0 + 2, b['h']),
                          bottom=z0 > 0.5, uv=uv, tint=(tl, (1, 1, 1, c.hash01(b['id']))))
    o = c.obj_from_bmesh('Landmark | %s (blockout)' % key, bm, FM['glass'], col)
    o['gz_landmark'] = key
    return o


def build():
    col = c.collection('50 • Landmarks')
    groups = {}
    for b in gz_city.data()['buildings']:
        if b['landmark']:
            groups.setdefault(b['landmark'], []).append(b)
    for key, blds in groups.items():
        fn = BUILDERS.get(key)
        fn(blds, col) if fn else blockout(key, blds, col)
        gz_city.log('landmark', key, 'model' if fn else 'blockout')
    liede_bridge(col)
    haixin_bridge(col)
    gz_city.log('landmarks: bridges done')


# the culture district (opera house, museum, library) is rebuilt against photographs in lm_culture.py
import lm_culture  # noqa: E402,F401  (registers its builders; imported last because it uses this module)
