"""Named Zhujiang New Town towers, modelled from photographs (Wikimedia Commons) instead of the generic massing.

  珠江城大厦 Pearl River Tower (SOM, 310 m)   broad faces bowed in plan and pinched in at the two wind-turbine
                                            floors (~40 % and ~66 % up), dark turbine openings there; arched roof.
  广发证券总部 GF Securities (308 m)          slender square shaft tapering a little, full-height pale corner piers
                                            that rise past the roof into an open frame crown; refuge-floor bands.
  利通广场 Leatop Plaza (303 m)                pale blue-green glass, white diagonal bracing in a zigzag up every face,
                                            the top cut by a sloping glass plane.
  广州银行大厦 Bank of Guangzhou (268 m)       dark grey skin with a regular grid of square punched windows, a plain
                                            refuge band half way up, flat top.
  富力盈凯广场 R&F Yingkai (296 m)             dark glass shaft, two setbacks and a lattice mast.

`build(b, col)` makes the geometry and returns the prisms for buildings.json (the web's near facade detail),
or [] where the form is not a prism. Data (c) OpenStreetMap contributors, ODbL.
"""
import math

import bmesh
from mathutils import Vector

import gz_common as c
import gz_materials as gm
import landmarks as L
from lm_culture import ring_axes

TOWERS = {}


def tower(name):
    def deco(fn):
        TOWERS[name] = fn
        return fn
    return deco


def handles(b):
    return (b.get('name') or '') in TOWERS and not b['part']


def build(b, col):
    return TOWERS[b['name']](b, col)


# ------------------------------------------------------------------ helpers
def _frame(b):
    """Centre, unit long axis and half extents of the footprint (world coordinates)."""
    ring = c.clean_ring(b['outer'])
    (cx, cy), ax, (ha, hc) = ring_axes(ring)
    return (cx, cy), ax, (ha, hc)


def _rect(cx, cy, ax, ha, hc):
    ux, uy = ax
    vx, vy = -uy, ux
    return [(cx + ux * a * ha + vx * s * hc, cy + uy * a * ha + vy * s * hc) for a, s in ((-1, -1), (1, -1), (1, 1), (-1, 1))]


def _loft3d(bm, uv, tl, rings, tint, cap=True):
    """Quads between rings of 3D points (same count, CCW seen from above). Facade UVs: u = arc length along the
    first ring (so mullions stay put as the plan changes), v = z."""
    n = len(rings[0])
    s = [0.0]
    for i in range(n):
        a, b_ = rings[0][i], rings[0][(i + 1) % n]
        s.append(s[-1] + math.hypot(b_[0] - a[0], b_[1] - a[1]))
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    for k in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((vs[k][i], vs[k][j], vs[k + 1][j], vs[k + 1][i]))
            for lp, (u, vv) in zip(f.loops, ((s[i], rings[k][i][2]), (s[i + 1], rings[k][j][2]),
                                            (s[i + 1], rings[k + 1][j][2]), (s[i], rings[k + 1][i][2]))):
                lp[uv].uv = (u, vv)
                lp[tl] = tint
    if cap:
        f = bm.faces.new(vs[-1])
        for lp in f.loops:
            lp[uv].uv = (lp.vert.co.x, lp.vert.co.y)
            lp[tl] = tint
    return vs


def _box(bm, uv, tl, center, u, v, w, d, h, tint):
    """Oriented box: centre (x, y, z0) of its base, axes u (width w) and v (depth d), height h."""
    x, y, z0 = center
    pts = [(x + u[0] * a * w / 2 + v[0] * s * d / 2, y + u[1] * a * w / 2 + v[1] * s * d / 2) for a, s in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    c.extrude_polygon(bm, pts, [], z0, z0 + h, uv=uv, tint=(tl, tint))


def _tint(b):
    return (1.0, 1.0, 1.0, c.hash01(b['id'], 3))


# ------------------------------------------------------------------ towers
@tower('珠江城大厦')
def pearl_river_tower(b, col):
    (cx, cy), ax, (ha, hc) = _frame(b)
    H = b['h']
    ux, uy = ax
    vx, vy = -uy, ux
    mat = gm.facade('GZ Tower | Pearl River Tower glass', wall=(0.52, 0.56, 0.60), glass=(0.10, 0.15, 0.19),
                    roof=(0.4, 0.4, 0.4), floor_h=4.0, bay=1.5, win_w=0.94, sill=0.08, head=0.97, glass_rough=0.04,
                    glass_metal=0.6, lit=0.35, warm=0.3, lit_k=4.0, tint_glass=False, floor_bias=0.8)
    dark = gm.plain('GZ Tower | Pearl River Tower turbine openings', (0.025, 0.03, 0.035), 0.5)
    pinch_z = (0.40 * H, 0.66 * H)

    def plan(z, arch=0.0):
        pinch = sum(6.5 * math.exp(-((z - pz) / 15.0) ** 2) for pz in pinch_z)
        pts = []
        # the two broad faces bow out in plan (a lens), the narrow ends are straight
        for side in (-1, 1):
            xs = [-1 + 2 * k / 10 for k in range(11)]
            if side > 0:
                xs = xs[::-1]
            for t in xs:
                a = t * ha
                bow = 2.8 * (1 - t * t)
                d = side * (hc + bow - pinch)
                zz = z - arch * t * t
                pts.append((cx + ux * a + vx * d, cy + uy * a + vy * d, zz))
        return pts

    zs = sorted(set([0.0] + [H * k / 40 for k in range(1, 40)] + [pz + o for pz in pinch_z for o in (-12, -6, 0, 6, 12)]))
    zs = [z for z in zs if z < H - 12]
    rings = [plan(z) for z in zs] + [plan(H - 4, arch=0.0), plan(H, arch=10.0)]
    # CCW check (seen from above)
    r0 = rings[0]
    if sum(r0[i][0] * r0[(i + 1) % len(r0)][1] - r0[(i + 1) % len(r0)][0] * r0[i][1] for i in range(len(r0))) < 0:
        rings = [r[::-1] for r in rings]
    bm, uv, tl = L.new_bm()
    _loft3d(bm, uv, tl, rings, _tint(b))
    o = c.obj_from_bmesh('Tower | Pearl River Tower', bm, mat, col)
    # the turbine openings: four dark slots on each broad face at both mechanical floors
    bm2, uv2, tl2 = L.new_bm()
    for pz in pinch_z:
        for side in (-1, 1):
            for k in range(4):
                t = -0.62 + k * 0.413
                a = t * ha
                d = side * (hc + 2.8 * (1 - t * t) - 6.5 + 0.3)            # on the pinched, bowed face
                _box(bm2, uv2, tl2, (cx + ux * a + vx * d, cy + uy * a + vy * d, pz - 5.0), (ux, uy), (vx, vy), 9.0, 0.8, 10.0, _tint(b))
    c.obj_from_bmesh('Tower | Pearl River Tower turbine openings', bm2, dark, col)
    return []                                            # not a prism: no near facade detail


@tower('广发证券总部')
def gf_securities(b, col):
    (cx, cy), ax, (ha, hc) = _frame(b)
    H = b['h']
    ux, uy = ax
    vx, vy = -uy, ux
    glass = gm.facade('GZ Tower | GF Securities glass', wall=(0.66, 0.69, 0.72), glass=(0.16, 0.21, 0.26),
                      roof=(0.4, 0.4, 0.4), floor_h=4.2, bay=1.5, win_w=0.93, sill=0.1, head=0.97, glass_rough=0.03,
                      glass_metal=0.65, lit=0.35, warm=0.3, lit_k=4.0, floor_bias=0.85)
    frame = gm.plain('GZ Tower | GF Securities corner piers', (0.78, 0.79, 0.80), 0.3, metal=0.6)
    top = H - 20
    h = min(ha, hc)
    rings = []
    for z in (0.0, top * 0.5, top):
        k = 1 - 0.07 * z / top                           # a slight taper
        rings.append([(p[0], p[1], z) for p in _rect(cx, cy, ax, h * k, h * k)])
    bm, uv, tl = L.new_bm()
    _loft3d(bm, uv, tl, rings, _tint(b))
    c.obj_from_bmesh('Tower | GF Securities shaft', bm, glass, col)
    bm2, uv2, tl2 = L.new_bm()
    # corner piers, full height and 20 m past the roof, following the taper
    for a, s in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        for z0, z1 in ((0.0, top * 0.5), (top * 0.5, H)):
            k = 1 - 0.07 * min(z0 + 1, top) / top
            px = cx + (ux * a + vx * s) * h * k
            py = cy + (uy * a + vy * s) * h * k
            _box(bm2, uv2, tl2, (px, py, z0), (ux, uy), (vx, vy), 3.4, 3.4, z1 - z0, _tint(b))
    # the open frame at the top and refuge-floor bands
    k = 1 - 0.07
    for z, hh in ((H - 3.0, 3.0),) + tuple((top * f, 2.4) for f in (0.2, 0.4, 0.6, 0.8)):
        kk = 1 - 0.07 * min(z, top) / top
        for (a0, s0), (a1, s1) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            p0 = Vector(((ux * a0 + vx * s0) * h * kk, (uy * a0 + vy * s0) * h * kk))
            p1 = Vector(((ux * a1 + vx * s1) * h * kk, (uy * a1 + vy * s1) * h * kk))
            mid = (p0 + p1) / 2
            dvec = (p1 - p0).normalized()
            _box(bm2, uv2, tl2, (cx + mid.x, cy + mid.y, z), (dvec.x, dvec.y), (-dvec.y, dvec.x), (p1 - p0).length, 1.2, hh, _tint(b))
    c.obj_from_bmesh('Tower | GF Securities frame', bm2, frame, col)
    return []


@tower('利通广场')
def leatop(b, col):
    (cx, cy), ax, (ha, hc) = _frame(b)
    H = b['h']
    ux, uy = ax
    vx, vy = -uy, ux
    glass = gm.facade('GZ Tower | Leatop glass', wall=(0.60, 0.68, 0.68), glass=(0.13, 0.20, 0.21),
                      roof=(0.4, 0.4, 0.4), floor_h=4.2, bay=1.5, win_w=0.95, sill=0.06, head=0.98, glass_rough=0.03,
                      glass_metal=0.6, lit=0.35, warm=0.3, lit_k=4.0, floor_bias=0.8)
    white = gm.plain('GZ Tower | Leatop bracing', (0.82, 0.83, 0.83), 0.35, metal=0.3)
    h = min(ha, hc)
    crown = 26.0
    rect = _rect(cx, cy, ax, h, h)
    body = [[(p[0], p[1], z) for p in rect] for z in (0.0, H - crown)]
    # the sloping top: a plane rising from one side to the other
    top = []
    for p in rect:
        a = ((p[0] - cx) * ux + (p[1] - cy) * uy) / h          # -1 .. 1 along the axis
        top.append((p[0], p[1], H - crown + crown * (a + 1) / 2))
    bm, uv, tl = L.new_bm()
    _loft3d(bm, uv, tl, body + [top], _tint(b))
    c.obj_from_bmesh('Tower | Leatop Plaza', bm, glass, col)
    # zigzag bracing: every face, diagonals spanning ~36 m, alternating
    bm2, uv2, tl2 = L.new_bm()
    step = 36.0
    for k in range(4):
        p0, p1 = Vector(rect[k]), Vector(rect[(k + 1) % 4])
        e = (p1 - p0)
        L_ = e.length
        e.normalize()
        n = Vector((e.y, -e.x))                                  # outward for a CCW rectangle
        z = 0.0
        flip = k % 2
        while z + step <= H - crown + 0.1:
            a, bb = (p0, p1) if flip == 0 else (p1, p0)
            A = Vector((a.x, a.y, z)) + Vector((n.x, n.y, 0)) * 0.35
            B = Vector((bb.x, bb.y, z + step)) + Vector((n.x, n.y, 0)) * 0.35
            _strip(bm2, uv2, tl2, A, B, Vector((n.x, n.y, 0)), 1.1, _tint(b))
            z += step
            flip = 1 - flip
    c.obj_from_bmesh('Tower | Leatop Plaza bracing', bm2, white, col)
    return [(c.clean_ring([(p[0], p[1]) for p in rect]), 0.0, H - crown, 'glass')]


def _strip(bm, uv, tl, A, B, n, w, tint):
    """A flat bar from A to B lying on a facade with outward normal n: w wide, 0.5 m deep."""
    d = (B - A).normalized()
    side = n.cross(d).normalized() * (w / 2)
    out = n * 0.5
    q = [A - side, B - side, B + side, A + side]
    vs = [bm.verts.new(p) for p in q] + [bm.verts.new(p + out) for p in q]
    for f in ((4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        face = bm.faces.new([vs[i] for i in f])
        for lp in face.loops:
            lp[uv].uv = (lp.vert.co.x, lp.vert.co.z)
            lp[tl] = tint
    bm.normal_update()


@tower('广州银行大厦')
def bank_of_guangzhou(b, col):
    (cx, cy), ax, (ha, hc) = _frame(b)
    H = b['h']
    skin = gm.facade('GZ Tower | Bank of Guangzhou punched grid', wall=(0.085, 0.09, 0.095), glass=(0.05, 0.07, 0.09),
                     roof=(0.3, 0.3, 0.3), floor_h=4.0, bay=3.0, win_w=0.52, sill=0.22, head=0.78, wall_rough=0.55,
                     glass_rough=0.05, glass_metal=0.5, lit=0.4, warm=0.4, lit_k=3.5, floor_bias=0.5)
    band = gm.plain('GZ Tower | Bank of Guangzhou refuge band', (0.10, 0.105, 0.11), 0.6)
    rect = c.clean_ring(_rect(cx, cy, ax, ha, hc))
    bm, uv, tl = L.new_bm()
    c.extrude_polygon(bm, rect, [], 0.0, H, uv=uv, tint=(tl, _tint(b)))
    c.extrude_polygon(bm, rect, [], H, H + 5.0, top=False, uv=uv, tint=(tl, _tint(b)))     # parapet
    c.obj_from_bmesh('Tower | Bank of Guangzhou', bm, skin, col)
    bm2, uv2, tl2 = L.new_bm()
    ring = _rect(cx, cy, ax, ha + 0.25, hc + 0.25)
    c.extrude_polygon(bm2, ring, [], H * 0.5 - 2.5, H * 0.5 + 2.5, top=True, bottom=True, uv=uv2, tint=(tl2, _tint(b)))
    c.obj_from_bmesh('Tower | Bank of Guangzhou band', bm2, band, col)
    return []                    # its punched grid is its own (3 m bays), not the office family's: no near detail


@tower('富力盈凯广场')
def rf_yingkai(b, col):
    (cx, cy), ax, (ha, hc) = _frame(b)
    H = b['h']
    glass = gm.facade('GZ Tower | R&F Yingkai dark glass', wall=(0.12, 0.13, 0.14), glass=(0.06, 0.08, 0.10),
                      roof=(0.3, 0.3, 0.3), floor_h=4.2, bay=1.5, win_w=0.9, sill=0.12, head=0.96, glass_rough=0.03,
                      glass_metal=0.7, lit=0.35, warm=0.3, lit_k=4.0, floor_bias=0.8)
    steel = gm.plain('GZ Tower | R&F Yingkai mast', (0.7, 0.71, 0.72), 0.35, metal=0.7)
    bm, uv, tl = L.new_bm()
    masses = []
    ring = c.clean_ring(_rect(cx, cy, ax, ha, hc))
    z = 0.0
    for top, inset in ((H - 22, 0.0), (H - 10, 3.0), (H, 6.0)):
        r = c.clean_ring(_rect(cx, cy, ax, ha - inset, hc - inset))
        c.extrude_polygon(bm, r, [], z, top, uv=uv, tint=(tl, _tint(b)))
        masses.append((r, z, top, 'glass'))
        z = top
    c.obj_from_bmesh('Tower | R&F Yingkai', bm, glass, col)
    bm2, uv2, tl2 = L.new_bm()
    for k, (w, zz, hh) in enumerate(((3.0, H, 18.0), (1.8, H + 18, 22.0), (0.8, H + 40, 16.0))):
        _box(bm2, uv2, tl2, (cx, cy, zz), ax, (-ax[1], ax[0]), w, w, hh, _tint(b))
    c.obj_from_bmesh('Tower | R&F Yingkai mast', bm2, steel, col)
    return masses
