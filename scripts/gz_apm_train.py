"""Bombardier Innovia APM 100 car as run on the Zhujiang New Town APM (from the Commons photographs: the car end is
one wrap-round window over a pale body with a thin gold line, round white and amber lamps either side, a black
skirt; inside: cream walls, a beige floor, silver poles, grab rails with red straps, red seats at the ends).

Car frame: +Y along the track (either end is a cab end), X across, Z up from the running surface. Two cars make a
train (the demo couples them 13.0 m apart). The door leaves are a separate prototype the demo slides open.

    apm_car     body shell with window openings, glazing, ends, roof, skirt, lamps, floor and interior fittings
    apm_leaf    one door leaf (0.75 m): lower panel, window, frame; hinge-less, slides along +-Y
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

from gz_streetkit import Part, mat  # noqa: E402

HL = 6.3            # half length of the body
HW = 1.425          # half width
FLOOR = 1.0         # floor above the running surface (= platform height)
WAIST = 1.95        # bottom of the side windows
EAVE = 3.05         # top of the walls
ROOF = 3.38
SKIRT = 0.3
DOORS = (-3.2, 3.2)  # door centres along the car
DOOR_W = 1.5
DOOR_TOP = 3.0
CORNER = 0.42       # plan radius of the car-end corners
END_WIN = 1.55      # bottom of the wrap-round end window


def mats():
    return {
        'body': mat('apm car body', '#ebe8df', 0.2, 0.3),
        'gold': mat('apm car gold line', '#b58a3a', 0.6, 0.35),
        'skirt': mat('apm car skirt', '#1e1f21', 0.2, 0.6),
        'glass': mat('apm car glass', '#3d4a52', 0.0, 0.05, alpha=0.32),
        'roof': mat('apm car roof', '#d6d6d2', 0.3, 0.5),
        'floor': mat('apm car floor', '#b9ab8c', 0.0, 0.7),
        'inner': mat('apm car interior', '#efece4', 0.0, 0.45),
        'ss': mat('apm car stainless', '#c7cacd', 0.9, 0.2),
        'red': mat('apm car seat red', '#c23a2f', 0.0, 0.5),
        'strap': mat('apm car strap', '#d2402f', 0.0, 0.5),
        'light': mat('apm car light', '#fffdf4', 0.0, 0.3, emit=4.0),
        'head': mat('apm car headlamp', '#fffbe8', 0.0, 0.2, emit=6.0),
        'tail': mat('apm car taillamp', '#ff6a1a', 0.0, 0.2, emit=5.0),
        'black': mat('apm car black', '#111213', 0.3, 0.4),
        'screen': mat('apm car screen', '#0f1a24', 0.2, 0.3, emit=1.4),
    }


def end_contour(sign, n=6):
    """Plan contour of one car end, from the right side (x=+HW) round to the left (x=-HW): side, rounded corner,
    straight end, corner, side. sign=+1 for the +Y end."""
    pts = []
    y0 = sign * (HL - CORNER)
    for k in range(n + 1):
        a = (math.pi / 2) * k / n
        pts.append((HW - CORNER + CORNER * math.cos(a), y0 + sign * CORNER * math.sin(a)))
    for k in range(n + 1):
        a = math.pi / 2 + (math.pi / 2) * k / n
        pts.append((-HW + CORNER + CORNER * math.cos(a), y0 + sign * CORNER * math.sin(a)))
    return pts


def strip(bm, contour, z0, z1):
    """Vertical faces along a plan contour."""
    lo = [bm.verts.new((x, y, z0)) for x, y in contour]
    hi = [bm.verts.new((x, y, z1)) for x, y in contour]
    for i in range(len(contour) - 1):
        bm.faces.new((lo[i], lo[i + 1], hi[i + 1], hi[i]))


def car(col):
    p = Part('apm_car')
    m = mats()
    bms = {}
    def B(k):
        if k not in bms:
            bms[k] = bmesh.new()
        return bms[k]
    # ---- sides: below the floor continuous; body panels round the door openings; windows between pillars
    y_end = HL - CORNER
    def side(a, b, s):
        return [(s * HW, a), (s * HW, b)] if s > 0 else [(s * HW, b), (s * HW, a)]
    for s in (-1, 1):
        x = s * HW
        spans = [(-y_end, DOORS[0] - DOOR_W / 2), (DOORS[0] + DOOR_W / 2, DOORS[1] - DOOR_W / 2), (DOORS[1] + DOOR_W / 2, y_end)]
        strip(B('skirt'), side(-y_end, y_end, s), SKIRT, 0.62)
        strip(B('body'), side(-y_end, y_end, s), 0.62, FLOOR)
        for a, b in spans:
            strip(B('body'), side(a, b, s), FLOOR, WAIST)
            # window band: pillars 0.18 at each end of the span, glass between, and a mid pillar on the long span
            cuts = [a, a + 0.18]
            if b - a > 5:
                mid = (a + b) / 2
                cuts += [mid - 0.09, mid + 0.09]
            cuts += [b - 0.18, b]
            for i in range(0, len(cuts) - 1):
                seg = (cuts[i], cuts[i + 1])
                if i % 2 == 0:
                    strip(B('body'), side(seg[0], seg[1], s), WAIST, EAVE)
                else:
                    strip(B('glass'), side(seg[0], seg[1], s), WAIST, EAVE - 0.08)
                    strip(B('body'), side(seg[0], seg[1], s), EAVE - 0.08, EAVE)
        for d in DOORS:                                               # door headers over the openings
            strip(B('body'), side(d - DOOR_W / 2, d + DOOR_W / 2, s), DOOR_TOP, EAVE)
        # the gold line and a door-status lamp over each door
        p.box(m['gold'], (x + s * 0.004, 0, FLOOR + 0.3), (0.008, 2 * y_end, 0.045))
        for d in DOORS:
            p.box(m['tail'], (x + s * 0.01, d, DOOR_TOP + 0.02), (0.02, 0.2, 0.03))
    # ---- ends: skirt, lower end wall with lamps, the wrap-round window, a thin roof band
    for sign in (-1, 1):
        c = end_contour(sign) if sign > 0 else end_contour(sign)[::-1]
        strip(B('skirt'), c, SKIRT, 0.62)
        strip(B('body'), c, 0.62, END_WIN)
        strip(B('glass'), c, END_WIN, EAVE - 0.05)
        strip(B('body'), c, EAVE - 0.05, EAVE)
        yf = sign * HL
        for xl, col_ in ((-0.95, 'head'), (-0.62, 'tail'), (0.62, 'tail'), (0.95, 'head')):
            p.cyl(m[col_], (xl, yf - sign * 0.02, FLOOR + 0.25), (xl, yf + sign * 0.01, FLOOR + 0.25), 0.09, 14)
            p.cyl(m['black'], (xl, yf - sign * 0.03, FLOOR + 0.25), (xl, yf, FLOOR + 0.25), 0.12, 14)
        p.box(m['gold'], (0, yf + sign * 0.004, FLOOR + 0.3), (1.2, 0.008, 0.045))
        p.box(m['black'], (0, yf - sign * 0.05, SKIRT + 0.15), (2 * HW - 0.4, 0.14, 0.3))
    # ---- roof: a low vault over the whole plan (rounded ends), sides from the eave
    ring = end_contour(1) + end_contour(-1)[::-1]
    bm = B('roof')
    levels = [(1.0, EAVE), (0.97, EAVE + 0.16), (0.9, EAVE + 0.27), (0.78, ROOF)]
    rings = [[bm.verts.new((x * k, y * (1 - (1 - k) * 0.35), z)) for x, y in ring] for k, z in levels]
    for a, b in zip(rings, rings[1:]):
        n = len(a)
        for i in range(n):
            bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]))
    bm.faces.new(rings[-1])
    # ---- floor, interior ceiling with light strips, end bulkheads
    fl = end_contour(1) + end_contour(-1)[::-1]
    bmf = B('floor')
    vs = [bmf.verts.new((x * 0.985, y * 0.99, FLOOR)) for x, y in fl]
    bmf.faces.new(vs)
    bmc = B('inner')
    vs = [bmc.verts.new((x * 0.97, y * 0.98, EAVE - 0.12)) for x, y in fl]
    bmc.faces.new(list(reversed(vs)))
    for xl in (-0.55, 0.55):
        p.box(m['light'], (xl, 0, EAVE - 0.135), (0.32, 2 * HL - 1.6, 0.02))
    # ---- interior: poles at the doors and down the aisle, grab rails with red straps, seats at both ends
    for d in DOORS:
        for xl in (-0.5, 0.5):
            p.cyl(m['ss'], (xl, d, FLOOR), (xl, d, EAVE - 0.12), 0.02, 10)
    for yy in (-5.0, 0.0, 5.0):
        p.cyl(m['ss'], (0, yy, FLOOR), (0, yy, EAVE - 0.12), 0.02, 10)
    for xl in (-0.85, 0.85):
        p.cyl(m['ss'], (xl, -HL + 0.8, EAVE - 0.35), (xl, HL - 0.8, EAVE - 0.35), 0.016, 8)
        for k in range(22):
            yy = -HL + 1.0 + k * (2 * HL - 2.0) / 21
            if any(abs(yy - d) < 0.5 for d in DOORS):
                continue
            p.box(m['strap'], (xl, yy, EAVE - 0.5), (0.02, 0.025, 0.26))
            for dz, h in ((-0.64, 0.02), (-0.8, 0.02)):              # a hollow triangle-ish handle: two bars and sides
                p.box(m['strap'], (xl, yy, EAVE + dz), (0.022, 0.13, h))
            for dy in (-0.055, 0.055):
                p.box(m['strap'], (xl, yy + dy, EAVE - 0.72), (0.022, 0.02, 0.18))
    for sign in (-1, 1):
        ys = sign * (HL - 1.0)
        for s in (-1, 1):
            p.box(m['red'], (s * (HW - 0.3), ys, FLOOR + 0.45), (0.5, 1.3, 0.1), 0.02)
            p.box(m['red'], (s * (HW - 0.08), ys, FLOOR + 0.75), (0.08, 1.3, 0.55), 0.02)
            p.box(m['ss'], (s * (HW - 0.3), ys, FLOOR + 0.2), (0.4, 1.2, 0.4))
        p.box(m['screen'], (0, sign * (HL - 0.5), EAVE - 0.3), (0.9, 0.04, 0.22))
    # merge the strips into the Part's per-material meshes
    for k, bm in bms.items():
        mm = m[k]
        tgt = p._bm(mm)
        tmp = bpy.data.meshes.new('t')
        bm.to_mesh(tmp); bm.free()
        tgt.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    return p.build(col)


def leaf(col):
    """One door leaf, centred on the origin: 0.75 m along Y, from the floor to the door head."""
    p = Part('apm_leaf')
    m = mats()
    w, h = DOOR_W / 2, DOOR_TOP - FLOOR
    zc = FLOOR + h / 2
    p.box(m['body'], (0, 0, FLOOR + 0.55), (0.04, w - 0.02, 1.1))
    p.box(m['glass'], (0, 0, FLOOR + 1.1 + (h - 1.1) / 2), (0.02, w - 0.14, h - 1.2))
    for yy in (-(w / 2 - 0.035), w / 2 - 0.035):
        p.box(m['body'], (0, yy, zc), (0.045, 0.07, h))
    p.box(m['body'], (0, 0, DOOR_TOP - 0.05), (0.045, w - 0.02, 0.1))
    p.box(m['black'], (0, 0, FLOOR + 1.05), (0.05, w - 0.02, 0.03))
    return p.build(col)


def build_all(col):
    objs = [car(col), leaf(col)]
    for o in objs:
        print('[apm-train]', o.name, sum(len(f.vertices) - 2 for f in o.data.polygons), 'tris', flush=True)
    return objs
