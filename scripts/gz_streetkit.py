"""Tianhe street furniture kit for the web demo (lotus-pond standard: real bevelled parts, not boxes).

    Blender --background --factory-startup --python guangzhou/scripts/gz_streetkit.py -- [--no-preview]

Every prop is built at true size around its own origin (ground at z = 0; "front" = -Y, the side that faces
the carriageway for kerb-side props; length along X) and exported as one top-level node `kit_<name>` in
guangzhou/demo/public/assets/street/street_kit.glb. The demo instances them (world/StreetFurniture.ts).

    railing    2 m municipal guard rail: square posts with caps, round top rail, flat bottom rail, 12 balusters
    bollard    stainless bollard with a reflective band
    bench      granite plinths and hardwood slats on steel frames
    bin        two-compartment street bin (recyclable green / other grey), domed lids, ash tray
    planter    granite trough with a clipped shrub (leaf cards from the tree atlas are added in the demo)
    hydrant    red Guangzhou fire hydrant
    cabinet    grey telecom / power cabinet with louvres
    shelter    8 m bus shelter: steel frame, glass back, cantilever roof with LED strip, bench, lightbox, route pole
    grate      1.2 m cast-iron tree grate
    metro_exit   Guangzhou Metro street entrance (from photographs of Tianhenan A): a glass pavilion on a raised
                 granite platform, magenta steel columns, overhanging dark steel roof, maroon sign band (the demo
                 writes the station name on it), stairs and escalator dropping into the dark; opening at -Y
    metro_totem  the red exit pylon with the logo plate and the exit letter panel
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'street')
PREV = os.path.join(ROOT, 'renders', 'street')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


MATS = {}


def mat(key, hexc, metal=0.0, rough=0.5, emit=0.0, alpha=1.0):
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new('GZK | ' + key)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    col = srgb(hexc)
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*col, 1)
        b.inputs['Emission Strength'].default_value = emit
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    m.diffuse_color = (*col, 1)
    MATS[key] = m
    return m


class Part:
    """Accumulates bmesh geometry per material for one prop; bevels boxes for real highlights."""

    def __init__(self, name):
        self.name = name
        self.bm = {}

    def _bm(self, m):
        if m.name not in self.bm:
            self.bm[m.name] = (bmesh.new(), m)
        return self.bm[m.name][0]

    def box(self, m, c, s, bevel=0.0, rot=None, seg=2):
        bm = self._bm(m)
        r = bmesh.ops.create_cube(bm, size=1.0)
        vs = r['verts']
        M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot else Matrix.Identity(4)) @ Matrix.Diagonal((*s, 1))
        bmesh.ops.transform(bm, matrix=M, verts=vs)
        if bevel > 0:
            edges = list({e for v in vs for e in v.link_edges})
            bmesh.ops.bevel(bm, geom=edges, offset=min(bevel, min(s) * 0.45), segments=seg, affect='EDGES', profile=0.5)

    def cyl(self, m, a, b, r, seg=12, r2=None, cap=True):
        bm = self._bm(m)
        a, b = Vector(a), Vector(b)
        d = b - a
        res = bmesh.ops.create_cone(bm, cap_ends=cap, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=d.length)
        q = d.to_track_quat('Z', 'Y')
        bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4(), verts=res['verts'])

    def lathe(self, m, prof, seg=20, z0=0.0, cx=0.0, cy=0.0):
        """Surface of revolution about Z through (r, z) points."""
        bm = self._bm(m)
        rings = [[bm.verts.new((cx + r * math.cos(2 * math.pi * k / seg), cy + r * math.sin(2 * math.pi * k / seg), z0 + z)) for k in range(seg)] for r, z in prof]
        for i in range(len(rings) - 1):
            for k in range(seg):
                bm.faces.new((rings[i][k], rings[i][(k + 1) % seg], rings[i + 1][(k + 1) % seg], rings[i + 1][k]))
        if prof[-1][0] > 1e-4:
            bm.faces.new(rings[-1])
        if prof[0][0] > 1e-4:
            bm.faces.new(list(reversed(rings[0])))

    def solid(self, m, rings, cap=True):
        """Loft through rings of 3D points (same count each), capping both ends: roofs, gusset plates."""
        bm = self._bm(m)
        vs = [[bm.verts.new(p) for p in r] for r in rings]
        n = len(rings[0])
        for i in range(len(vs) - 1):
            for k in range(n):
                bm.faces.new((vs[i][k], vs[i][(k + 1) % n], vs[i + 1][(k + 1) % n], vs[i + 1][k]))
        if cap:
            bm.faces.new(list(reversed(vs[0])))
            bm.faces.new(vs[-1])

    def slab(self, m, a, b, w, t, x=0.0):
        """A slab whose top surface holds the line a -> b (points (y, z) in the YZ plane at x): stairs' strings,
        ramps, escalator balustrades; w across X, t under the top surface."""
        a3, b3 = Vector((x, a[0], a[1])), Vector((x, b[0], b[1]))
        d = (b3 - a3)
        L = d.length
        d.normalize()
        n = Vector((0, -d.z, d.y))
        R = Matrix((Vector((1, 0, 0)), d, n)).transposed()
        self.box(m, tuple((a3 + b3) / 2 - n * (t / 2)), (w, L, t), rot=R)

    def build(self, col):
        me = bpy.data.meshes.new(self.name)
        big = bmesh.new()
        mats = []
        for i, (bm, m) in enumerate(self.bm.values()):
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            for f in bm.faces:
                f.material_index = i
            tmp = bpy.data.meshes.new('tmp')
            bm.to_mesh(tmp); bm.free()
            big.from_mesh(tmp)
            bpy.data.meshes.remove(tmp)
            mats.append(m)
        big.to_mesh(me); big.free()
        for m in mats:
            me.materials.append(m)
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        o = bpy.data.objects.new('kit_' + self.name, me)
        col.objects.link(o)
        mod = o.modifiers.new('crease', 'EDGE_SPLIT'); mod.split_angle = math.radians(35)
        return o


# ------------------------------------------------------------------------------------------ props
def railing(col):
    p = Part('railing')
    white = mat('rail paint', '#e9ebe6', 0.3, 0.35)
    green = mat('rail green', '#2f6e57', 0.3, 0.4)
    L = 2.0
    for x in (-L / 2 + 0.03, L / 2 - 0.03):
        p.box(white, (x, 0, 0.5), (0.06, 0.06, 1.0), 0.006, seg=1)
        p.box(white, (x, 0, 1.015), (0.08, 0.08, 0.03))
    p.cyl(white, (-L / 2, 0, 0.95), (L / 2, 0, 0.95), 0.025, 8, cap=False)
    p.box(white, (0, 0, 0.18), (L, 0.04, 0.05))
    p.box(green, (0, 0, 0.62), (L - 0.12, 0.03, 0.08))
    for k in range(12):
        x = -L / 2 + 0.12 + k * (L - 0.24) / 11
        p.cyl(white, (x, 0, 0.2), (x, 0, 0.93), 0.01, 4, cap=False)
    return p.build(col)


def bollard(col):
    p = Part('bollard')
    steel = mat('stainless', '#c9ccd0', 1.0, 0.22)
    refl = mat('reflector', '#ffe7a0', 0.0, 0.3, emit=0.2)
    p.lathe(steel, [(0.07, 0.0), (0.07, 0.72), (0.06, 0.77), (0.0, 0.8)], 12)
    p.lathe(refl, [(0.0715, 0.6), (0.0715, 0.66)], 12)
    return p.build(col)


def bench(col):
    p = Part('bench')
    granite = mat('granite', '#8f8c86', 0.0, 0.65)
    wood = mat('hardwood', '#7a4f2f', 0.0, 0.6)
    steel = mat('bench steel', '#2e3134', 0.7, 0.35)
    for x in (-0.75, 0.75):
        p.box(granite, (x, 0, 0.21), (0.3, 0.5, 0.42), 0.02)
    for k in range(5):
        p.box(wood, (0, -0.2 + k * 0.1, 0.445), (1.9, 0.08, 0.035), 0.008)
    for x in (-0.95, 0.95):
        p.box(steel, (x, 0.05, 0.62), (0.04, 0.5, 0.04), 0.01)
        p.box(steel, (x, -0.18, 0.52), (0.04, 0.04, 0.2), 0.01)
    return p.build(col)


def street_bin(col):
    p = Part('bin')
    green = mat('bin green', '#2f7d4a', 0.1, 0.45)
    grey = mat('bin grey', '#6d7278', 0.1, 0.45)
    dark = mat('bin dark', '#1d1f21', 0.2, 0.5)
    steel = mat('stainless', '#c9ccd0', 1.0, 0.22)
    for x, m in ((-0.23, green), (0.23, grey)):
        p.box(m, (x, 0, 0.42), (0.42, 0.4, 0.8), 0.03)
        p.lathe(m, [(0.2, 0.0), (0.19, 0.04), (0.12, 0.09), (0.0, 0.1)], 16, z0=0.82, cx=x)
        p.box(dark, (x, -0.201, 0.62), (0.26, 0.01, 0.1), 0.004)
    p.box(steel, (0, 0, 0.94), (0.2, 0.2, 0.04), 0.01)
    p.box(dark, (0, 0, 0.01), (0.9, 0.44, 0.02))
    return p.build(col)


def planter(col):
    p = Part('planter')
    granite = mat('granite', '#8f8c86', 0.0, 0.65)
    soil = mat('soil', '#3b2c20', 0.0, 0.95)
    for y in (-0.36, 0.36):
        p.box(granite, (0, y, 0.3), (2.0, 0.08, 0.6), 0.015)
    for x in (-0.96, 0.96):
        p.box(granite, (x, 0, 0.3), (0.08, 0.8, 0.6), 0.015)
    p.box(granite, (0, 0, 0.61), (2.06, 0.86, 0.04), 0.012)
    p.box(soil, (0, 0, 0.52), (1.84, 0.64, 0.02))
    return p.build(col)


def hydrant(col):
    p = Part('hydrant')
    red = mat('hydrant red', '#c4161c', 0.3, 0.35)
    steel = mat('stainless', '#c9ccd0', 1.0, 0.22)
    p.lathe(red, [(0.12, 0.0), (0.12, 0.05), (0.09, 0.07), (0.09, 0.62), (0.1, 0.64), (0.1, 0.7), (0.07, 0.76), (0.03, 0.8), (0.0, 0.81)], 18)
    for ang in (0, math.pi):
        d = Vector((math.cos(ang), math.sin(ang), 0))
        p.cyl(red, Vector((0, 0, 0.45)), Vector((0, 0, 0.45)) + d * 0.17, 0.04, 12)
        p.cyl(steel, Vector((0, 0, 0.45)) + d * 0.17, Vector((0, 0, 0.45)) + d * 0.2, 0.045, 6)
    p.cyl(steel, (0, 0, 0.8), (0, 0, 0.84), 0.025, 6)
    return p.build(col)


def cabinet(col):
    p = Part('cabinet')
    grey = mat('cabinet grey', '#a3a8ab', 0.4, 0.45)
    dark = mat('bin dark', '#1d1f21', 0.2, 0.5)
    base = mat('granite', '#8f8c86', 0.0, 0.65)
    p.box(base, (0, 0, 0.08), (0.9, 0.5, 0.16), 0.01)
    p.box(grey, (0, 0, 0.8), (0.82, 0.42, 1.28), 0.012)
    p.box(grey, (0, 0, 1.46), (0.88, 0.48, 0.05), 0.01)
    for k in range(6):
        p.box(dark, (0, -0.212, 1.1 + k * 0.04), (0.5, 0.008, 0.015))
    p.box(dark, (0.3, -0.214, 0.8), (0.03, 0.01, 0.12), 0.004)
    p.box(dark, (0, -0.211, 0.8), (0.004, 0.006, 1.2))
    return p.build(col)


def shelter(col):
    p = Part('shelter')
    steel = mat('shelter steel', '#3a3f45', 0.7, 0.35)
    glass = mat('shelter glass', '#9fb4bf', 0.0, 0.05, alpha=0.35)
    roof = mat('shelter roof', '#d9dcdf', 0.5, 0.3)
    led = mat('shelter led', '#dff2ff', 0.0, 0.3, emit=3.0)
    box = mat('lightbox', '#f4f1ea', 0.0, 0.4, emit=2.0)
    wood = mat('hardwood', '#7a4f2f', 0.0, 0.6)
    L, D = 8.0, 1.8
    for x in (-L / 2 + 0.2, -L / 6, L / 6, L / 2 - 0.2):
        p.box(steel, (x, D / 2 - 0.1, 1.3), (0.12, 0.12, 2.6), 0.015)
    p.box(roof, (0, 0.1, 2.72), (L + 0.4, D + 0.6, 0.12), 0.03)
    p.box(steel, (0, D / 2 - 0.1, 2.6), (L, 0.16, 0.14), 0.01)
    p.box(led, (0, -D / 2 - 0.195, 2.68), (L + 0.3, 0.02, 0.04))
    for k in range(3):
        x0 = -L / 2 + 0.2 + k * (L - 0.4) / 3
        p.box(glass, (x0 + (L - 0.4) / 6, D / 2 - 0.1, 1.35), ((L - 0.4) / 3 - 0.14, 0.015, 2.3))
    p.box(glass, (-L / 2 + 0.2, 0.2, 1.35), (0.015, 1.2, 2.3))
    p.box(steel, (L / 2 - 0.2, 0.25, 1.3), (0.2, 1.3, 2.6), 0.02)
    p.box(box, (L / 2 - 0.2, 0.25, 1.4), (0.21, 1.1, 1.9))
    for k in range(4):
        p.box(wood, (-1.5 + 0.0, D / 2 - 0.45 - k * 0.09, 0.46), (4.0, 0.07, 0.03), 0.006)
    for x in (-3.3, 0.3):
        p.box(steel, (x, D / 2 - 0.55, 0.23), (0.05, 0.3, 0.46), 0.01)
    p.cyl(steel, (-L / 2 - 0.6, -D / 2, 0), (-L / 2 - 0.6, -D / 2, 3.2), 0.05, 10)
    p.box(box, (-L / 2 - 0.6, -D / 2 - 0.05, 2.7), (0.7, 0.06, 0.9), 0.01)
    return p.build(col)


def open_plat(M):
    """The open entrance's kerb: 0.6 m round the well's sides and back, the landing in front as at a pavilion."""
    px0, px1, py0, py1 = M.PIT
    return px0 - 0.6, px1 + 0.6, M.PLAT[2], py1 + 0.6


def metro_exit(col, open_=False):
    """Street pavilion + stair + escalator + the hall under the pavement (numbers from gz_metro).

    open_: the APM stations' entrances (Commons: 大剧院 A / B / E, 花城大道 A, 2022-2025) have no pavilion -- the
    well is open to the sky behind a granite kerb and frameless glass on three sides with a stainless top rail, a
    red-framed station map light box beside the opening (the red pylon stands as at every exit). Same stair,
    escalator, tunnel and hall, so the ground cut, the collision ramp and the demo's numbers all hold."""
    import gz_metro as M
    p = Part('metro_exit_open' if open_ else 'metro_exit')
    granite = mat('metro granite', '#8e8b85', 0.0, 0.62)
    strip = mat('metro anti-slip', '#34332f', 0.0, 0.85)
    tactile = mat('metro tactile', '#c9a227', 0.0, 0.7)
    red = mat('metro frame red', '#b52a22', 0.35, 0.38)
    hole = mat('metro frame hole', '#1c0e0c', 0.0, 0.85)
    roof = mat('metro roof blue', '#2848aa', 0.3, 0.35)
    down = mat('metro downlight', '#fff3dc', 0.0, 0.3, emit=3.0)
    glass = mat('shelter glass', '#9fb4bf', 0.0, 0.05, alpha=0.35)
    mull = mat('metro mullion', '#b9bdc1', 0.8, 0.3)
    sign = mat('metro sign maroon', '#7a1f1c', 0.0, 0.45)
    ss = mat('metro stainless', '#c9cccf', 0.9, 0.22)
    black = mat('metro escalator black', '#141414', 0.2, 0.4)
    alu = mat('metro escalator steps', '#8e9296', 0.85, 0.35)
    yellow = mat('metro step edge', '#d9b21f', 0.0, 0.5)
    wall = mat('metro wall enamel', '#e3e1da', 0.1, 0.3)
    joint = mat('metro wall joint', '#77756f', 0.0, 0.6)
    band = mat('metro wall band', '#a3262a', 0.1, 0.35)
    ceil = mat('metro ceiling', '#aab0b5', 0.7, 0.4)
    led = mat('metro led strip', '#f4f7ff', 0.0, 0.3, emit=4.0)
    hall = mat('metro hall floor', '#bdb9b0', 0.0, 0.35)
    gtop = mat('metro gate top', '#2b2e33', 0.3, 0.3)
    green = mat('metro gate arrow', '#29d17a', 0.0, 0.3, emit=3.0)
    flap = mat('metro gate flap', '#d8492e', 0.0, 0.2, alpha=0.55)
    board = mat('metro map lightbox', '#f2f2ee', 0.0, 0.3, emit=1.6)
    ad = mat('metro ad lightbox', '#fff1d8', 0.0, 0.3, emit=1.8)
    PZ, CX, RZ = M.PLAT_Z, M.COL_X, M.ROOF_Z
    px0, px1, py0, py1 = M.PIT
    ax0, ax1, ay0, ay1 = open_plat(M) if open_ else M.PLAT
    fz, se, hy1 = M.FLOOR_Z, M.STAIR_END, M.HALL[3]
    # ---- platform: two steps up, a slab round the open well, a tactile strip and a steel nosing at the stair head
    p.box(granite, (0, (M.STEPS_Y0 + ay0) / 2, -0.025), (ax1 - ax0 + 0.2, ay0 - M.STEPS_Y0, 0.35), 0.015)
    p.box(strip, (0, M.STEPS_Y0 + 0.03, 0.152), (ax1 - ax0 + 0.2, 0.04, 0.004))
    p.box(strip, (0, ay0 + 0.03, PZ + 0.002), (ax1 - ax0, 0.04, 0.004))
    for x0, x1, y0, y1 in ((ax0, px0, ay0, ay1), (px1, ax1, ay0, ay1), (px0, px1, ay0, py0), (px0, px1, py1, ay1)):
        p.box(granite, ((x0 + x1) / 2, (y0 + y1) / 2, (PZ - 0.2) / 2), (x1 - x0, y1 - y0, PZ + 0.2), 0.012)
    p.box(tactile, ((px0 + px1) / 2, py0 - 0.6, PZ + 0.003), (px1 - px0 - 0.2, 0.4, 0.006))
    for bx_, by_ in M.BOLLARDS:
        p.cyl(ss, (bx_, by_, 0.0), (bx_, by_, 0.85), 0.07, 12)
        p.cyl(ss, (bx_, by_, 0.85), (bx_, by_, 0.9), 0.07, 12, r2=0.045)
    p.box(ss, ((px0 + px1) / 2, py0 - 0.02, PZ - 0.02), (px1 - px0, 0.05, 0.05))
    if open_:
        # ---- frameless glass on the kerb round three sides of the well, stainless posts and top rail
        gz0 = PZ + 0.05
        for (xa, ya), (xb, yb) in (((px0 - 0.22, py0 - 0.05), (px0 - 0.22, py1 + 0.22)), ((px0 - 0.22, py1 + 0.22), (px1 + 0.22, py1 + 0.22)),
                                   ((px1 + 0.22, py1 + 0.22), (px1 + 0.22, py0 - 0.05))):
            L = math.hypot(xb - xa, yb - ya)
            p.box(glass, ((xa + xb) / 2, (ya + yb) / 2, gz0 + 0.52), (abs(xb - xa) + 0.02, abs(yb - ya) + 0.02, 1.0))
            p.box(ss, ((xa + xb) / 2, (ya + yb) / 2, PZ + 1.12), (abs(xb - xa) + 0.06, abs(yb - ya) + 0.06, 0.05), 0.01)
            p.box(ss, ((xa + xb) / 2, (ya + yb) / 2, PZ + 0.03), (abs(xb - xa) + 0.06, abs(yb - ya) + 0.06, 0.06))
            n = max(1, round(L / 1.4))
            for k in range(n + 1):
                x, y = xa + (xb - xa) * k / n, ya + (yb - ya) * k / n
                p.box(ss, (x, y, PZ + 0.57), (0.05, 0.05, 1.1))
        # ---- the station map light box on red legs beside the opening, facing the pavement
        bx_, by_ = px1 + 1.25, ay0 - 0.9
        for dx in (-0.48, 0.48):
            p.box(red, (bx_ + dx, by_, 0.6), (0.08, 0.08, 1.2))
        p.box(red, (bx_, by_, 1.75), (1.12, 0.14, 1.5), 0.01)
        p.box(board, (bx_, by_ - 0.075, 1.75), (0.96, 0.01, 1.34))
        p.box(board, (bx_, by_ + 0.075, 1.75), (0.96, 0.01, 1.34))
    else:
        # ---- red box-section portal frames: perforated columns, cross beams, side beams, gusset plates
        for y in M.FRAMES_Y:
            for sx in (-1, 1):
                x = sx * CX
                p.box(red, (x, y, (PZ + RZ) / 2), (0.3, 0.3, RZ - PZ), 0.012)
                p.box(red, (x, y, PZ + 0.03), (0.44, 0.44, 0.06), 0.01)                     # base plate
                for k in range(6):
                    z = PZ + 0.75 + k * 0.55
                    p.cyl(hole, (x - 0.152, y, z), (x + 0.152, y, z), 0.065, 10)
                # gussets: into the cross beam and into the side beam
                p.solid(red, [[(x - sx * 0.15, y - 0.02, RZ - 0.35), (x - sx * 0.15, y - 0.02, RZ - 1.05), (x - sx * 0.85, y - 0.02, RZ - 0.35)],
                              [(x - sx * 0.15, y + 0.02, RZ - 0.35), (x - sx * 0.15, y + 0.02, RZ - 1.05), (x - sx * 0.85, y + 0.02, RZ - 0.35)]])
                for dy in (-1, 1):
                    if (y == M.FRAMES_Y[0] and dy < 0) or (y == M.FRAMES_Y[-1] and dy > 0):
                        continue
                    p.solid(red, [[(x - 0.02, y + dy * 0.15, RZ - 0.35), (x - 0.02, y + dy * 0.15, RZ - 0.95), (x - 0.02, y + dy * 0.75, RZ - 0.35)],
                                  [(x + 0.02, y + dy * 0.15, RZ - 0.35), (x + 0.02, y + dy * 0.15, RZ - 0.95), (x + 0.02, y + dy * 0.75, RZ - 0.35)]])
            p.box(red, (0, y, RZ - 0.175), (2 * CX + 0.3, 0.3, 0.35), 0.01)
        for sx in (-1, 1):
            p.box(red, (sx * CX, (M.FRAMES_Y[0] + M.FRAMES_Y[-1]) / 2, RZ - 0.175), (0.3, M.FRAMES_Y[-1] - M.FRAMES_Y[0] + 0.3, 0.35), 0.01)
        # ---- deep blue tray roof: soffit slopes up from a thin fascia to the beams, a low hip on top
        rx0, rx1, ry0, ry1 = M.ROOF
        def rect(x0, x1, y0, y1, z):
            return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
        fy0, fy1 = M.FRAMES_Y[0] - 0.15, M.FRAMES_Y[-1] + 0.15
        p.solid(roof, [rect(-CX - 0.15, CX + 0.15, fy0, fy1, RZ + 0.1), rect(rx0, rx1, ry0, ry1, RZ - 0.3), rect(rx0, rx1, ry0, ry1, RZ - 0.18),
                       rect(rx0 + 1.4, rx1 - 1.4, ry0 + 1.6, ry1 - 1.6, RZ + 0.55)])
        p.box(roof, (0, (fy0 + fy1) / 2, RZ + 0.05), (2 * CX + 0.3, fy1 - fy0, 0.1))     # soffit over the beams
        for x in (-1.5, 0.0, 1.5):
            for y in (-3.1, -0.1, 2.9):
                p.cyl(down, (x, y, RZ - 0.012), (x, y, RZ - 0.002), 0.11, 12)
        # ---- the sign band over the open end (the demo lays the station name over its face)
        p.box(sign, (0, M.FRAMES_Y[0] - 0.06, RZ - 0.35 - 0.36), (2 * CX - 0.3, 0.18, 0.72), 0.01)
        # ---- glass on both sides and the back, silver mullions, a steel kick plate
        gz0, gz1 = PZ, RZ - 0.35
        for sx in (-1, 1):
            x = sx * (CX - 0.12)
            p.box(glass, (x, (fy0 + fy1) / 2, (gz0 + gz1) / 2), (0.02, fy1 - fy0 - 0.3, gz1 - gz0))
            p.box(ss, (x, (fy0 + fy1) / 2, PZ + 0.08), (0.04, fy1 - fy0 - 0.3, 0.16))
            for k in range(1, 6):
                y = fy0 + (fy1 - fy0) * k / 6
                p.box(mull, (x, y, (gz0 + gz1) / 2), (0.05, 0.06, gz1 - gz0))
        yb = M.FRAMES_Y[-1] + 0.05
        p.box(glass, (0, yb, (gz0 + gz1) / 2), (2 * CX - 0.3, 0.02, gz1 - gz0))
        p.box(ss, (0, yb, PZ + 0.08), (2 * CX - 0.3, 0.04, 0.16))
        for k in range(1, 4):
            p.box(mull, (-CX + 0.15 + (2 * CX - 0.3) * k / 4, yb, (gz0 + gz1) / 2), (0.06, 0.05, gz1 - gz0))
    # ---- steel balustrades along both sides of the well
    for x in (px0 + 0.06, px1 - 0.06):
        n = 7
        for k in range(n + 1):
            y = py0 + (py1 - 0.1 - py0) * k / n
            p.cyl(ss, (x, y, PZ), (x, y, PZ + 1.1), 0.025, 8)
        for z in (PZ + 1.1, PZ + 0.6):
            p.cyl(ss, (x, py0, z), (x, py1 - 0.1, z), 0.03 if z > PZ + 1 else 0.015, 8)
    # ---- the fixed stair: granite treads with dark anti-slip nosings, a wall handrail
    sx0, sx1 = M.STAIR_X
    for k in range(M.N_RISE - 1):
        zt = PZ - M.RISE * (k + 1)
        y0 = py0 + M.TREAD * k
        p.box(granite, ((sx0 + sx1) / 2, y0 + M.TREAD / 2, zt - M.RISE / 2), (sx1 - sx0, M.TREAD, M.RISE))
        p.box(strip, ((sx0 + sx1) / 2, y0 + 0.04, zt + 0.002), (sx1 - sx0, 0.05, 0.004))
    for x in (sx0 + 0.03, sx1 - 0.04):
        p.cyl(ss, (x, py0 - 0.3, PZ + 0.9), (x, se + 0.3, fz + 0.9), 0.025, 8)
    # ---- escalator: sawtooth aluminium steps with yellow edges between black balustrades with rubber handrails
    ex0, ex1 = M.ESC_X
    top_y, run = py0 + 1.0, (PZ - fz) / math.tan(math.radians(30))
    bot_y = top_y + run
    sx_, sw = (ex0 + ex1) / 2, ex1 - ex0 - 0.3
    p.box(alu, (sx_, (py0 + top_y) / 2, PZ - 0.02), (sw, top_y - py0, 0.04))
    p.box(alu, (sx_, bot_y + 0.5, fz - 0.02), (sw, 1.0, 0.04))
    ns = int(run / 0.4)
    for k in range(ns):
        y0 = top_y + run * k / ns
        zt = PZ - (PZ - fz) * (k + 1) / ns
        p.box(alu, (sx_, y0 + run / ns / 2, zt - 0.06), (sw, run / ns, 0.12))
        p.box(yellow, (sx_, y0 + 0.03, zt + 0.002), (sw, 0.04, 0.004))
    for bx in (ex0 + 0.075, ex1 - 0.075):
        pts = [(py0 - 0.3, PZ), (top_y, PZ), (bot_y, fz), (bot_y + 1.3, fz)]
        for (ya, za), (yb_, zb) in zip(pts, pts[1:]):
            p.slab(black, (ya, za + 0.28), (yb_, zb + 0.28), 0.15, 0.45, bx)          # skirt
            p.slab(glass, (ya, za + 0.98), (yb_, zb + 0.98), 0.02, 0.7, bx)           # glass balustrade
            p.slab(black, (ya, za + 1.04), (yb_, zb + 1.04), 0.1, 0.07, bx)           # handrail
        p.cyl(black, (bx, pts[0][0] - 0.04, PZ + 0.28), (bx, pts[0][0] - 0.04, PZ + 1.04), 0.05, 10)   # newels
        p.cyl(black, (bx, pts[-1][0] + 0.04, fz + 0.28), (bx, pts[-1][0] + 0.04, fz + 1.04), 0.05, 10)
    # ---- the well and tunnel walls: enamel panels with joints and a red band, the lid's header, the ceiling, LEDs
    wx0, wx1 = px0 + 0.03, px1 - 0.03
    for x in (wx0 - 0.025, wx1 + 0.025):
        p.box(wall, (x, (py0 + hy1) / 2, (fz + PZ - 0.01) / 2), (0.05, hy1 - py0, PZ - 0.01 - fz))
        ins = 1 if x < 0 else -1
        for k in range(1, int((hy1 - py0) / 1.2)):
            p.box(joint, (x + ins * 0.027, py0 + k * 1.2, (fz + PZ) / 2), (0.004, 0.012, PZ - fz))
        p.box(band, (x + ins * 0.027, (se + hy1) / 2, fz + 1.35), (0.006, hy1 - se, 0.14))
    p.box(wall, ((wx0 + wx1) / 2, py1 + 0.025, (M.LID_Z + PZ - 0.01) / 2), (wx1 - wx0 + 0.1, 0.05, PZ - 0.01 - M.LID_Z))
    # the tunnel ceiling runs parallel to the stair from the back of the well down to the hall ceiling
    hc, knee = M.HALL_CEIL, M.CEIL_KNEE
    p.slab(ceil, (py1, M.LID_Z), (knee, hc), wx1 - wx0, 0.08, (wx0 + wx1) / 2)
    p.box(ceil, ((wx0 + wx1) / 2, (knee + hy1) / 2, hc + 0.04), (wx1 - wx0, hy1 - knee, 0.08))
    for x in (-1.4, 0.6):
        p.slab(led, (py1 + 0.3, M.LID_Z - 0.15 - 0.095), (knee, hc - 0.095), 0.12, 0.01, x)
        p.box(led, (x, (knee + hy1) / 2, hc - 0.005), (0.12, hy1 - knee - 0.6, 0.01))
    # ---- the hall floor and a guide strip (the gates, the station map and the end wall are metro_gates; at the APM
    # stations the hall runs on into the passage to the concourse)
    p.box(hall, ((wx0 + wx1) / 2, (se + hy1) / 2, fz - 0.05), (wx1 - wx0, hy1 - se + 0.1, 0.1))
    p.box(tactile, (-1.3, (se + hy1) / 2, fz + 0.003), (0.3, hy1 - se - 0.4, 0.006))
    p.box(ad, (wx0 + 0.02, (se + hy1) / 2, fz + 1.9), (0.03, 1.8, 1.2))
    return p.build(col)


def metro_gates(col):
    """The ticket gates, end wall and station map closing a metro_exit hall (every line but the APM, whose gates
    are in the concourse)."""
    import gz_metro as M
    p = Part('metro_gates')
    ss = mat('metro stainless', '#c9cccf', 0.9, 0.22)
    wall = mat('metro wall enamel', '#e3e1da', 0.1, 0.3)
    gtop = mat('metro gate top', '#2b2e33', 0.3, 0.3)
    green = mat('metro gate arrow', '#29d17a', 0.0, 0.3, emit=3.0)
    flap = mat('metro gate flap', '#d8492e', 0.0, 0.2, alpha=0.55)
    board = mat('metro map lightbox', '#f2f2ee', 0.0, 0.3, emit=1.6)
    px0, px1 = M.PIT[0], M.PIT[1]
    wx0, wx1 = px0 + 0.03, px1 - 0.03
    fz, hy1 = M.FLOOR_Z, M.HALL[3]
    p.box(wall, ((wx0 + wx1) / 2, hy1 + 0.025, (fz + M.HALL_CEIL) / 2), (wx1 - wx0 + 0.1, 0.05, M.HALL_CEIL - fz))
    p.box(ss, (-0.4, hy1 - 0.03, fz + 2.0), (2.8, 0.04, 1.6), 0.01)
    p.box(board, (-0.4, hy1 - 0.055, fz + 2.0), (2.6, 0.02, 1.4))
    gy = M.GATES_Y
    cabs = [-2.25, -1.02, 0.21, 1.44]
    for x in cabs:
        p.box(ss, (x, gy, fz + 0.475), (0.24, 1.3, 0.95), 0.02)
        p.box(gtop, (x, gy, fz + 0.975), (0.26, 1.32, 0.05), 0.01)
        p.box(green, (x, gy - 0.55, fz + 1.002), (0.1, 0.1, 0.004))
    for a_, b_ in zip(cabs, cabs[1:]):
        for side, x in ((1, a_ + 0.12), (-1, b_ - 0.12)):
            w = (b_ - a_ - 0.24) / 2 - 0.02
            p.box(flap, (x + side * w / 2, gy, fz + 0.65), (w, 0.02, 0.6))
    return p.build(col)


def metro_exit_col(col, open_=False):
    """Collision proxy for metro_exit (the demo adds it to the static BVH): walkable platform, steps, one ramp down
    the stair + escalator, the hall floor; walls, glass, the gate line and the roof (camera). open_: the APM
    entrances' open well -- the kerb and its glass on three sides instead of the pavilion."""
    import gz_metro as M
    p = Part('metro_exit_open_col' if open_ else 'metro_exit_col')
    m = mat('metro collision', '#ff00ff', 0.0, 1.0)
    PZ = M.PLAT_Z
    px0, px1, py0, py1 = M.PIT
    ax0, ax1, ay0, ay1 = open_plat(M) if open_ else M.PLAT
    fz, se, hy1 = M.FLOOR_Z, M.STAIR_END, M.HALL[3]
    def bx(x0, x1, y0, y1, z0, z1):
        p.box(m, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0))
    bx(ax0, ax1, M.STEPS_Y0, ay0, -0.3, 0.15)
    for x0, x1, y0, y1 in ((ax0, px0, ay0, ay1), (px1, ax1, ay0, ay1), (px0, px1, ay0, py0), (px0, px1, py1, ay1)):
        bx(x0, x1, y0, y1, -0.3, PZ)
    p.slab(m, (py0, PZ), (se, fz), px1 - px0, 0.2, (px0 + px1) / 2)
    bx(px0, px1, se - 0.3, hy1 + 0.1, fz - 0.2, fz)
    bx(px0 - 0.05, px0 + 0.03, py0, hy1 + 0.1, fz - 0.2, PZ + 1.1)                  # well walls + balustrades
    bx(px1 - 0.03, px1 + 0.05, py0, hy1 + 0.1, fz - 0.2, PZ + 1.1)
    bx(px0, px1, py1, M.CEIL_KNEE, M.LID_Z - 0.1, PZ)                                 # header + tunnel ceiling
    p.slab(m, (py1, M.LID_Z), (M.CEIL_KNEE, M.HALL_CEIL), px1 - px0, 0.3, (px0 + px1) / 2)
    bx(px0, px1, M.CEIL_KNEE, hy1 + 0.1, M.HALL_CEIL, M.HALL_CEIL + 0.3)
    if open_:                                                                         # the kerb's glass
        bx(px0 - 0.26, px0 - 0.18, py0 - 0.05, py1 + 0.26, PZ, PZ + 1.15)
        bx(px1 + 0.18, px1 + 0.26, py0 - 0.05, py1 + 0.26, PZ, PZ + 1.15)
        bx(px0 - 0.26, px1 + 0.26, py1 + 0.18, py1 + 0.26, PZ, PZ + 1.15)
        bx(px1 + 0.7, px1 + 1.8, ay0 - 1.0, ay0 - 0.8, 0.0, 2.5)                       # the map board
        return p.build(col)
    for sx in (-1, 1):                                                                # side glass + columns
        bx(sx * M.COL_X - 0.16, sx * M.COL_X + 0.16, M.FRAMES_Y[0] - 0.15, M.FRAMES_Y[-1] + 0.15, PZ, M.ROOF_Z)
    bx(-M.COL_X, M.COL_X, M.FRAMES_Y[-1] - 0.05, M.FRAMES_Y[-1] + 0.15, PZ, M.ROOF_Z)
    rx0, rx1, ry0, ry1 = M.ROOF
    bx(rx0, rx1, ry0, ry1, M.ROOF_Z - 0.2, M.ROOF_Z + 0.3)
    return p.build(col)


def metro_gates_col(col):
    """Collision for metro_gates: the gate line and the end wall."""
    import gz_metro as M
    p = Part('metro_gates_col')
    m = mat('metro collision', '#ff00ff', 0.0, 1.0)
    px0, px1 = M.PIT[0], M.PIT[1]
    fz, hy1 = M.FLOOR_Z, M.HALL[3]
    p.box(m, ((px0 + px1) / 2, hy1 + 0.05, (fz - 0.2 + M.HALL_CEIL) / 2), (px1 - px0, 0.1, M.HALL_CEIL - fz + 0.2))
    p.box(m, ((px0 + px1) / 2, M.GATES_Y, fz + 0.5), (px1 - px0, 1.3, 1.0))
    return p.build(col)


def metro_totem(col):
    """The red pylon: logo plate and exit letter plate on both faces (the demo lays the letter over them)."""
    p = Part('metro_totem')
    red = mat('metro frame red', '#b52a22', 0.35, 0.38)
    white = mat('metro totem plate', '#f3f1ea', 0.0, 0.4, emit=0.9)
    granite = mat('metro granite', '#8e8b85', 0.0, 0.62)
    p.box(granite, (0, 0, 0.05), (0.8, 0.46, 0.1), 0.01)
    p.box(red, (0, 0, 1.8), (0.62, 0.3, 3.4), 0.03)
    for s_ in (-1, 1):
        p.box(white, (0, s_ * 0.152, 2.95), (0.5, 0.01, 0.5), 0.004)
        p.box(white, (0, s_ * 0.152, 2.35), (0.5, 0.01, 0.5), 0.004)
    return p.build(col)


def grate(col):
    p = Part('grate')
    iron = mat('cast iron', '#2a2826', 0.6, 0.6)
    s = 1.2
    for k in range(4):
        a = k * math.pi / 2
        p.box(iron, (math.cos(a) * (s / 2 - 0.04), math.sin(a) * (s / 2 - 0.04), 0.01), (0.08 if k % 2 == 0 else s, s if k % 2 == 0 else 0.08, 0.02))
    for k in range(8):
        a = k / 8 * 2 * math.pi
        d = Vector((math.cos(a), math.sin(a), 0))
        p.box(iron, tuple(d * 0.42 + Vector((0, 0, 0.012))), (0.25, 0.025, 0.02), rot=Matrix.Rotation(a, 3, 'Z'))
    p.lathe(iron, [(0.3, 0.005), (0.3, 0.02), (0.27, 0.02), (0.27, 0.005)], 12)
    return p.build(col)


# ------------------------------------------------------------------------------------------ main
def preview(objs):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 24
    sc.render.resolution_x, sc.render.resolution_y = 1600, 700
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.6, 0.65, 0.7, 1)
    sc.world = w
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.5; sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    sc.collection.objects.link(sun)
    x = 0.0
    for o in objs:
        dims = o.dimensions
        o.location.x = x + dims.x / 2
        x += dims.x + 0.8
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 35
    sc.collection.objects.link(cam)
    cx = x / 2
    cam.location = (cx, -14, 3.2)
    cam.rotation_euler = ((Vector((cx, 0, 0.9)) - cam.location).to_track_quat('-Z', 'Y').to_euler())
    sc.camera = cam
    gm = bpy.data.meshes.new('g'); bmg = bmesh.new(); bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=60); bmg.to_mesh(gm); bmg.free()
    gm.materials.append(mat('ground', '#77777a', 0, 0.8))
    g = bpy.data.objects.new('ground', gm); sc.collection.objects.link(g)
    os.makedirs(PREV, exist_ok=True)
    sc.render.filepath = os.path.join(PREV, 'kit.png')
    bpy.ops.render.render(write_still=True)
    for o in objs:
        o.location.x = 0
    bpy.data.objects.remove(g); bpy.data.objects.remove(cam); bpy.data.objects.remove(sun)


def bake_card(o, path):
    """Front orthographic render of a prop (colour + alpha) for a far-LOD card: 2.0 x 1.05 m -> 512 x 256."""
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 16
    w = bpy.data.worlds.new('card light'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    sc.world = w
    others = [x for x in bpy.data.objects if x != o and x.type == 'MESH']
    for x in others: x.hide_render = True
    cam = bpy.data.objects.new('card cam', bpy.data.cameras.new('card cam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 2.0
    sc.collection.objects.link(cam)
    cam.location = (0, -5, 0.525); cam.rotation_euler = (math.pi / 2, 0, 0)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 512, 269
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGBA'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for x in others: x.hide_render = False
    bpy.data.objects.remove(cam)
    print('[kit] card ->', path, flush=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col = bpy.data.collections.new('street kit')
    bpy.context.scene.collection.children.link(col)
    objs = [f(col) for f in (railing, bollard, bench, street_bin, planter, hydrant, cabinet, shelter, grate, metro_exit, metro_totem, metro_exit_col, metro_gates, metro_gates_col)]
    objs += [metro_exit(col, open_=True), metro_exit_col(col, open_=True)]
    for o in objs:
        tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
        print('[kit]', o.name, tris, 'tris', flush=True)
    if '--no-preview' not in ARGS:
        preview(objs)
    os.makedirs(OUT, exist_ok=True)
    bake_card(objs[0], os.path.join(OUT, 'railing_card.png'))
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    path = os.path.join(OUT, 'street_kit.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_materials='EXPORT', export_texcoords=False, export_normals=True, export_extras=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
    print('[kit] ->', path, os.path.getsize(path) // 1024, 'KB', flush=True)


if __name__ == '__main__':
    main()
