"""Guangzhou 2030s vehicle kit: parametric hard-surface vehicles for the Tianhe web demo.

    Blender --background --factory-startup --python guangzhou/scripts/gz_vehicles.py -- [--only taxi,sedan] [--no-export] [--no-preview]

Frame: forward +Y, right +X, ground z = 0, metres.

  body        lofted from stations: plan half-width w(y), deck/hood line zt(y), sill line zb(y), shaped by a
              section profile (car / box). Wheel arches are cut with Manifold booleans (the cut faces take
              the arch-liner material). Planar cuts (bmesh bisect) give exact livery, cladding and bumper
              lines; faces are then classed by position and normal.
  greenhouse  a second loft from the windshield base to the rear-glass base; each face is glass, pillar or
              roof by zone and by its place in the section (windshield / A-pillar / side glass / roof rail).
  details     light bars, lamp units, grilles, plates, door seams, handles and stripes are projected onto the
              body along BVH ray casts, so they sit on the paint whatever its curvature.
  wheels      under 'axle pivot' empties (extras spin_axis='X', radius_m), the contract of the web kit.

Materials carry extras gz_class (paint / livery / glass / metal / matte / lamp) and gz_lamp (head / drl / tail /
amber / sign / police_r / police_b); the demo folds them into its instanced part classes. Vehicles whose colours
are a fixed livery (taxi, police, bus) have gz_livery on the root.

Writes guangzhou/demo/public/assets/vehicles/gz_<slug>.glb and gz_<slug>_lod2.glb, plus previews in
guangzhou/renders/vehicles/.
"""
import json
import math
import os
import sys
import time

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'vehicles')
PREV = os.path.join(ROOT, 'renders', 'vehicles')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(k, d=None):
    return ARGS[ARGS.index(k) + 1] if k in ARGS else d


def log(*a):
    print('[veh]', *a, flush=True)


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


# ------------------------------------------------------------------------------------------ materials
MAT_KEYS = ['paint', 'livery', 'livery2', 'glass', 'pillar', 'trim', 'liner', 'chrome', 'tyre', 'rim', 'rim_dark',
            'brake', 'plate', 'seam', 'head', 'drl', 'tail', 'amber', 'sign', 'police_r', 'police_b', 'grille', 'seat']
MI = {k: i for i, k in enumerate(MAT_KEYS)}


def make_mat(name, color, metal=0.0, rough=0.5, cls='matte', lamp=None, emit=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.04
    if emit:
        b.inputs['Emission Color'].default_value = (*color, 1)
        b.inputs['Emission Strength'].default_value = emit
    m['gz_class'] = cls
    if lamp:
        m['gz_lamp'] = lamp
    m.diffuse_color = (*color, 1)
    return m


def material_set(slug, paint, livery=None, livery2=None, pillar='gloss', rim='alloy'):
    """One material per MAT_KEYS entry, named 'GZV <slug> | <key>' (the web kit keys colours by name)."""
    P = lambda k: 'GZV %s | %s' % (slug, k)
    pc = srgb(paint)
    mats = {
        'paint': make_mat(P('paint'), pc, 0.55, 0.3, 'paint', coat=1.0),
        'livery': make_mat(P('livery'), srgb(livery or paint), 0.5, 0.32, 'livery', coat=1.0),
        'livery2': make_mat(P('livery2'), srgb(livery2 or livery or paint), 0.3, 0.35, 'livery'),
        'glass': make_mat(P('glass'), srgb('#0b1116'), 0.0, 0.04, 'glass'),
        'pillar': (make_mat(P('pillar'), srgb('#07090b'), 0.0, 0.12, 'glass') if pillar == 'gloss'
                   else make_mat(P('pillar'), pc, 0.55, 0.3, 'paint', coat=1.0)),
        'trim': make_mat(P('trim'), srgb('#15171a'), 0.0, 0.6, 'matte'),
        'liner': make_mat(P('liner'), srgb('#0a0a0b'), 0.0, 0.9, 'matte'),
        'chrome': make_mat(P('chrome'), srgb('#c9cdd2'), 1.0, 0.18, 'metal'),
        'tyre': make_mat(P('tyre'), srgb('#1a1b1d'), 0.0, 0.88, 'matte'),
        'rim': make_mat(P('rim'), srgb('#b9bec4') if rim == 'alloy' else srgb('#3a3d42'), 1.0, 0.28, 'metal'),
        'rim_dark': make_mat(P('rim_dark'), srgb('#24272b'), 0.9, 0.35, 'metal'),
        'brake': make_mat(P('brake'), srgb('#5a5d61'), 0.9, 0.45, 'metal'),
        'plate': make_mat(P('plate'), srgb('#7fd08a'), 0.0, 0.45, 'matte'),     # NEV plates are green
        'seam': make_mat(P('seam'), srgb('#050506'), 0.0, 0.8, 'matte'),
        'head': make_mat(P('head'), (1.0, 0.98, 0.94), 0.0, 0.2, 'lamp', 'head', emit=4.0),
        'drl': make_mat(P('drl'), (0.85, 0.93, 1.0), 0.0, 0.2, 'lamp', 'drl', emit=4.0),
        'tail': make_mat(P('tail'), (1.0, 0.02, 0.015), 0.0, 0.25, 'lamp', 'tail', emit=3.0),
        'amber': make_mat(P('amber'), (1.0, 0.35, 0.02), 0.0, 0.25, 'lamp', 'amber', emit=1.0),
        'sign': make_mat(P('sign'), (1.0, 0.55, 0.12), 0.0, 0.3, 'lamp', 'sign', emit=3.0),
        'police_r': make_mat(P('police_r'), (1.0, 0.03, 0.03), 0.0, 0.2, 'lamp', 'police_r', emit=4.0),
        'police_b': make_mat(P('police_b'), (0.05, 0.2, 1.0), 0.0, 0.2, 'lamp', 'police_b', emit=4.0),
        'grille': make_mat(P('grille'), srgb('#0d0f11'), 0.2, 0.35, 'matte'),
        'seat': make_mat(P('seat'), srgb('#1e2124'), 0.0, 0.7, 'matte'),
    }
    return [mats[k] for k in MAT_KEYS]


# ------------------------------------------------------------------------------------------ curves
def spline(pts):
    """Monotone cubic (Fritsch-Carlson) through (x, y) control points; constant outside."""
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    n = len(pts)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [d[0]] + [0.0 if d[i - 1] * d[i] <= 0 else (d[i - 1] + d[i]) / 2 for i in range(1, n - 1)] + [d[-1]]
    for i in range(n - 1):
        if d[i] == 0:
            m[i] = m[i + 1] = 0.0
            continue
        a, b = m[i] / d[i], m[i + 1] / d[i]
        s = a * a + b * b
        if s > 9:
            t = 3 / math.sqrt(s)
            m[i], m[i + 1] = t * a * d[i], t * b * d[i]

    def f(x):
        if x <= xs[0]:
            return ys[0]
        if x >= xs[-1]:
            return ys[-1]
        i = 0
        while xs[i + 1] < x:
            i += 1
        h = xs[i + 1] - xs[i]
        t = (x - xs[i]) / h
        return ((2 * t ** 3 - 3 * t ** 2 + 1) * ys[i] + (t ** 3 - 2 * t ** 2 + t) * h * m[i]
                + (-2 * t ** 3 + 3 * t ** 2) * ys[i + 1] + (t ** 3 - t ** 2) * h * m[i + 1])
    return f


def resample(prof, n):
    """n points evenly spaced by arc length along a polyline of (u, v)."""
    seg = [math.dist(prof[i], prof[i + 1]) for i in range(len(prof) - 1)]
    tot = sum(seg)
    out = []
    for k in range(n):
        s = tot * k / (n - 1)
        i = 0
        while i < len(seg) - 1 and s > seg[i]:
            s -= seg[i]
            i += 1
        t = min(1.0, s / seg[i]) if seg[i] else 0.0
        out.append((prof[i][0] + (prof[i + 1][0] - prof[i][0]) * t, prof[i][1] + (prof[i + 1][1] - prof[i][1]) * t))
    return out


# body section profiles, right half from bottom centre to top centre (u = x / w, v = (z - zb) / (zt - zb))
PROF_CAR = [(0, 0), (0.6, 0), (0.84, 0.012), (0.945, 0.07), (0.985, 0.18), (1.0, 0.34), (1.0, 0.52), (0.992, 0.66),
            (0.972, 0.78), (0.94, 0.88), (0.88, 0.95), (0.76, 0.985), (0.45, 1.0), (0, 1.0)]
PROF_SPORT = [(0, 0), (0.6, 0), (0.85, 0.02), (0.95, 0.1), (0.99, 0.25), (1.0, 0.45), (0.995, 0.7), (0.98, 0.88),
              (0.95, 0.97), (0.88, 1.0), (0.7, 0.99), (0.35, 0.955), (0, 0.95)]
PROF_SUV = [(0, 0), (0.7, 0), (0.9, 0.01), (0.975, 0.06), (1.0, 0.16), (1.0, 0.6), (0.99, 0.78), (0.965, 0.9),
            (0.92, 0.965), (0.8, 0.995), (0.45, 1.0), (0, 1.0)]
PROF_BOX = [(0, 0), (0.9, 0), (0.975, 0.008), (1.0, 0.03), (1.0, 0.95), (0.985, 0.985), (0.93, 1.0), (0, 1.0)]
# greenhouse profile: u scales from the base half-width (v = 0) to the roof half-width (v = 1)
GH_PROF = [(1.0, 0.0), (1.0, 0.07), (0.995, 0.55), (0.985, 0.8), (0.955, 0.92), (0.87, 0.98), (0.5, 1.0), (0.0, 1.0)]
GH_SEG = ['dlo', 'side', 'side', 'rail', 'edge', 'roof', 'roof']    # segment k joins GH_PROF[k] .. GH_PROF[k + 1]


# ------------------------------------------------------------------------------------------ mesh helpers
def new_obj(name, bm, mats, col, smooth=True, angle=38):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    if smooth:
        # crisp creases above `angle`, smooth elsewhere
        mod = o.modifiers.new('smooth by angle', 'EDGE_SPLIT')
        mod.split_angle = math.radians(angle)
        mod.use_edge_sharp = False
    return o


def apply_mods(o):
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def loft(bm, rings, mat_fn=None, caps=True):
    vs = [[bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for j in range(n):
            q = (vs[i][j], vs[i][(j + 1) % n], vs[i + 1][(j + 1) % n], vs[i + 1][j])
            try:
                f = bm.faces.new(q)
            except ValueError:
                continue
            if mat_fn:
                f.material_index = mat_fn(i, j)
    if caps:
        for r in (vs[0], vs[-1]):
            try:
                f = bm.faces.new(r)
                if mat_fn:
                    f.material_index = mat_fn(-1, -1)
            except ValueError:
                pass
    return vs


def tidy(bm, recalc=True):
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.dissolve_degenerate(bm, edges=bm.edges, dist=1e-5)
    if recalc:                     # only for closed shells; open surfaces keep their authored winding
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)


def box(bm, c, s, mi, rot=None):
    """Axis box centred at c with size s (optionally rotated by a Matrix)."""
    r = bmesh.ops.create_cube(bm, size=1.0)
    vs = r['verts']
    M = Matrix.Translation(Vector(c)) @ (rot.to_4x4() if rot else Matrix.Identity(4)) @ Matrix.Diagonal((*s, 1))
    bmesh.ops.transform(bm, matrix=M, verts=vs)
    for f in {f for v in vs for f in v.link_faces}:
        f.material_index = mi
    return vs


def cyl_x(bm, cx, cy, cz, r, length, mi, seg=24):
    """Cylinder along X."""
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=length)
    bmesh.ops.transform(bm, matrix=Matrix.Translation((cx, cy, cz)) @ Matrix.Rotation(math.pi / 2, 4, 'Y'), verts=res['verts'])
    for f in {f for v in res['verts'] for f in v.link_faces}:
        f.material_index = mi


def lathe_x(bm, prof, mi, seg=40, x0=0.0, side=1):
    """Surface of revolution about X through (ax, r) points, ax measured outward (side = +1 right, -1 left)."""
    rings = [[Vector((x0 + side * ax, r * math.cos(2 * math.pi * k / seg), r * math.sin(2 * math.pi * k / seg)))
              for k in range(seg)] for ax, r in prof]
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    for i in range(len(vs) - 1):
        for k in range(seg):
            q = (vs[i][k], vs[i][(k + 1) % seg], vs[i + 1][(k + 1) % seg], vs[i + 1][k])
            f = bm.faces.new(q if side > 0 else tuple(reversed(q)))
            f.material_index = mi
    return vs


# ------------------------------------------------------------------------------------------ projection
class Surface:
    """BVH over the evaluated body for projecting details onto the paint."""

    def __init__(self, obj):
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        bm = bmesh.new()
        bm.from_mesh(ev.to_mesh())
        bm.transform(obj.matrix_world)
        self.bvh = BVHTree.FromBMesh(bm)
        bm.free()
        ev.to_mesh_clear()

    def hit(self, origin, d):
        co, n, _, _ = self.bvh.ray_cast(Vector(origin), Vector(d), 20.0)
        if co is None:
            return None
        if n.dot(Vector(d)) > 0:
            n = -n
        return co, n

    def patch(self, bm, face, u0, u1, v0, v1, mi, off=0.004, nu=None, nv=None, pad=0.0):
        """A grid patch projected onto one face of the vehicle.
        face: 'front' (u = x, v = z), 'rear' (u = x, v = z), 'right'/'left' (u = y, v = z), 'top' (u = x, v = y).
        off lifts it off the surface along the normal (a slight emboss for lamps)."""
        nu = nu or max(2, int(abs(u1 - u0) / 0.025) + 1)
        nv = nv or max(2, int(abs(v1 - v0) / 0.025) + 1)
        grid = []
        for i in range(nu):
            u = u0 + (u1 - u0) * i / (nu - 1)
            row = []
            for j in range(nv):
                v = v0 + (v1 - v0) * j / (nv - 1)
                if face == 'front':
                    o, d = (u, 12, v), (0, -1, 0)
                elif face == 'rear':
                    o, d = (u, -12, v), (0, 1, 0)
                elif face == 'right':
                    o, d = (6, u, v), (-1, 0, 0)
                elif face == 'left':
                    o, d = (-6, u, v), (1, 0, 0)
                else:
                    o, d = (u, v, 8), (0, 0, -1)
                h = self.hit(o, d)
                row.append(None if h is None or h[1].dot(Vector(d)) > -0.15 else (bm.verts.new(h[0] + h[1] * off), h[1]))
            grid.append(row)
        made = 0
        for i in range(nu - 1):
            for j in range(nv - 1):
                q = [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]]
                if all(q):
                    f = bm.faces.new([p[0] for p in q])
                    f.material_index = mi
                    f.normal_update()
                    if f.normal.dot(sum((p[1] for p in q), Vector())) < 0:
                        f.normal_flip()
                    made += 1
        return made


# ------------------------------------------------------------------------------------------ wheels
def wheel(col, mats, name, x, y, r, width, style, side):
    """A wheel under an axle pivot at (x, y, r). side +1 right / -1 left (hub faces outward)."""
    piv = bpy.data.objects.new(name + ' | axle pivot', None)
    piv.empty_display_size = r
    piv.location = (x, y, r)
    piv['spin_axis'] = 'X'
    piv['radius_m'] = round(r, 4)
    col.objects.link(piv)
    bm = bmesh.new()
    hw = width / 2
    rr = r * (0.66 if style != 'bus' else 0.58)          # rim radius
    # tyre: tread with two grooves, rounded shoulders, sidewalls down to the rim
    lathe_x(bm, [(-hw * 0.82, rr * 0.99), (-hw * 0.98, rr * 1.08), (-hw, r * 0.86), (-hw * 0.93, r * 0.97),
                 (-hw * 0.75, r), (-hw * 0.3, r), (-hw * 0.26, r * 0.975), (-hw * 0.18, r * 0.975), (-hw * 0.14, r),
                 (hw * 0.14, r), (hw * 0.18, r * 0.975), (hw * 0.26, r * 0.975), (hw * 0.3, r), (hw * 0.75, r),
                 (hw * 0.93, r * 0.97), (hw, r * 0.86), (hw * 0.98, rr * 1.08), (hw * 0.82, rr * 0.99)],
            MI['tyre'], 48, side=side)
    face = hw * 0.8
    # rim lip and dished barrel
    lathe_x(bm, [(face, rr * 0.99), (face + 0.012, rr * 0.97), (face + 0.008, rr * 0.9), (face - 0.03, rr * 0.86),
                 (-hw * 0.7, rr * 0.9), (-hw * 0.8, rr * 0.99)], MI['rim'], 40, side=side)
    lathe_x(bm, [(face - 0.035, rr * 0.86), (face - 0.06, rr * 0.3), (face - 0.06, 0.0)], MI['rim_dark'], 24, side=side)
    # brake disc and caliper behind the spokes
    lathe_x(bm, [(face - 0.075, rr * 0.8), (face - 0.075, rr * 0.35), (face - 0.095, rr * 0.35), (face - 0.095, rr * 0.8), (face - 0.075, rr * 0.8)],
            MI['brake'], 32, side=side)
    # spokes: flat-ish tapered blades from hub to lip, set back from the face
    n, blade = {'aero': (5, 0.26), 'multi': (10, 0.09), 'sport': (5, 0.16), 'bus': (8, 0.08), 'steel': (6, 0.12)}[style]
    hub = rr * 0.24
    for k in range(n):
        a = 2 * math.pi * k / n
        for off in ((0.0,) if style != 'sport' else (-0.09, 0.09)):
            aa = a + off
            wa, wb = blade * (0.55 if style != 'aero' else 0.7), blade * (0.35 if style != 'aero' else 1.0)
            pts = []
            for rad, half, dx in ((hub, wa * rr * 0.5, 0.0), (rr * 0.92, wb * rr * 0.5, -0.02)):
                for s in (-1, 1):
                    t = aa + s * half / max(rad, 1e-3)
                    pts.append((rad * math.cos(t), rad * math.sin(t), dx))
            vs = []
            for depth in (0.0, -0.028):
                for (py, pz, dx) in pts:
                    vs.append(bm.verts.new(Vector((side * (face + dx + depth), py, pz))))
            idx = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 2, 6, 4), (1, 5, 7, 3), (0, 4, 5, 1), (2, 3, 7, 6)]
            fs = []
            for q in idx:
                f = bm.faces.new([vs[i] for i in q])
                f.material_index = MI['rim'] if style != 'bus' else MI['rim_dark']
                fs.append(f)
            bmesh.ops.recalc_face_normals(bm, faces=fs)
    # hub cap
    lathe_x(bm, [(face + 0.004, hub * 1.1), (face + 0.012, hub * 0.8), (face + 0.014, 0.0)], MI['rim_dark'] if style == 'aero' else MI['rim'], 24, side=side)
    tidy(bm, recalc=False)
    o = new_obj(name + ' | wheel', bm, mats, col, smooth=True, angle=50)
    o.parent = piv
    return piv


# ------------------------------------------------------------------------------------------ vehicle
class Vehicle:
    def __init__(self, slug, spec):
        self.slug, self.s = slug, spec
        self.col = bpy.data.collections.new('VEH ' + slug)
        bpy.context.scene.collection.children.link(self.col)
        self.mats = material_set(slug, spec['paint'], spec.get('livery'), spec.get('livery2'),
                                 spec.get('pillar', 'gloss'), spec.get('rim', 'alloy'))
        self.root = bpy.data.objects.new(slug + ' | vehicle root', None)
        self.col.objects.link(self.root)
        self.root['gz_vehicle'] = slug
        if spec.get('fixed_livery'):
            self.root['gz_livery'] = 1
        s = spec
        self.w = spline(s['plan'])
        self.zt = spline(s['top'])
        self.zb = spline(s['bottom'])
        self.parts = []

    # ---- body
    def body(self):
        s = self.s
        L = s['L']
        prof = resample(s.get('profile', PROF_CAR), s.get('ring', 26))
        y0, y1 = s.get('span', (-L / 2, L / 2))
        ns = s.get('stations', 90)
        ys = sorted(set([round(y0 + (y1 - y0) * k / ns, 5) for k in range(ns + 1)]))
        rings = []
        for y in ys:
            w, zb, zt = self.w(y), self.zb(y), self.zt(y)
            right = [Vector((u * w, y, zb + v * (zt - zb))) for u, v in prof]
            left = [Vector((-u * w, y, zb + v * (zt - zb))) for u, v in reversed(prof[1:-1])]
            rings.append(right + left)
        bm = bmesh.new()
        loft(bm, rings, lambda i, j: MI['paint'])
        tidy(bm)
        o = new_obj(self.slug + ' | body', bm, self.mats, self.col, smooth=True, angle=s.get('crease', 40))
        o.modifiers.clear()
        # wheel arches
        liner = bpy.data.materials['GZV %s | liner' % self.slug]
        for (y, r) in self.axles():
            bm2 = bmesh.new()
            cyl_x(bm2, 0, y, r + s.get('arch_lift', 0.03), r + s.get('arch_gap', 0.06), s['W'] + 0.4, 0, 48)
            # never cut above the fender line: flatten the cutter's top a little under the shoulder
            zcap = self.zb(y) + 0.86 * (self.zt(y) - self.zb(y)) - 0.02
            for vv in bm2.verts:
                vv.co.z = min(vv.co.z, zcap)
            me = bpy.data.meshes.new('arch cutter')
            bm2.to_mesh(me); bm2.free()
            me.materials.append(liner)
            cut = bpy.data.objects.new('arch cutter', me)
            self.col.objects.link(cut)
            mod = o.modifiers.new('arch', 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'MANIFOLD'
            mod.object = cut
            try:
                mod.material_mode = 'TRANSFER'
            except (AttributeError, TypeError):
                pass
            apply_mods(o)
            bpy.data.objects.remove(cut)
        # planar cuts for livery / cladding lines, then class faces
        bm = bmesh.new()
        bm.from_mesh(o.data)
        for z in s.get('cuts_z', []):
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, z), plane_no=(0, 0, 1))
        for y in s.get('cuts_y', []):
            geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
            bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, y, 0), plane_no=(0, 1, 0))
        rule = s.get('body_rule')
        liner_i = MI['liner']
        for f in bm.faces:
            if f.material_index == liner_i or o.data.materials[f.material_index] == liner:
                f.material_index = liner_i
                continue
            c, n = f.calc_center_median(), f.normal
            k = rule(self, c, n) if rule else None
            f.material_index = MI[k] if k else MI['paint']
        bm.to_mesh(o.data)
        bm.free()
        # materials were appended in MAT_KEYS order, but the boolean may have added the liner as an extra slot
        while len(o.data.materials) > len(MAT_KEYS):
            o.data.materials.pop()
        mod = o.modifiers.new('smooth by angle', 'EDGE_SPLIT')
        mod.split_angle = math.radians(s.get('crease', 40))
        self.body_obj = o
        self.parts.append(o)
        return o

    def axles(self):
        s = self.s
        return [(y, s['r']) for y in s['axles']]

    # ---- greenhouse
    def greenhouse(self):
        s = self.s
        g = s.get('gh')
        if not g:
            return None
        yC, yC2, yA2, yA = g['yC'], g['yC2'], g['yA2'], g['yA']
        H = s['H']
        crown = g.get('crown', 0.03)
        roof = spline([(yC, self.zt(yC) - 0.03), (yC + (yC2 - yC) * 0.55, H - crown - (H - self.zt(yC)) * g.get('rear_curve', 0.18)),
                       (yC2, H - crown * 0.8), ((yC2 + yA2) / 2, H), (yA2, H - crown), (yA2 + (yA - yA2) * 0.5, H - crown - (H - self.zt(yA)) * 0.52),
                       (yA, self.zt(yA) - 0.03)])
        base_in = g.get('base_in', 0.1)
        tumble = g.get('tumble', 0.2)
        keys = {yC, yC2, yA2, yA} | set(g.get('extra_y', []))
        n = 70
        ys = sorted(keys | {yC + (yA - yC) * k / n for k in range(1, n)})
        prof = GH_PROF
        rings, meta = [], []
        for y in ys:
            wb = self.w(y) * (1 - base_in)
            wr = max(0.1, wb - tumble)
            z0 = self.zt(y) - 0.012
            z1 = max(z0 + 0.002, roof(y))
            right = [Vector((u * (wb + (wr - wb) * v), y, z0 + v * (z1 - z0))) for u, v in prof]
            left = [Vector((-u * (wb + (wr - wb) * v), y, z0 + v * (z1 - z0))) for u, v in reversed(prof[:-1])]
            rings.append(right + left)
            meta.append(y)
        npr = len(prof)
        segs = GH_SEG + list(reversed(GH_SEG)) + ['base']      # ring: right half, left half, then back to start

        def mat_fn(i, j):
            if i < 0:
                return MI['pillar']
            yc = (meta[i] + meta[i + 1]) / 2
            seg = segs[j] if j < len(segs) else 'base'
            return MI[self.gh_zone(yc, seg)]
        bm = bmesh.new()
        loft(bm, rings, mat_fn)
        tidy(bm)
        o = new_obj(self.slug + ' | greenhouse', bm, self.mats, self.col, smooth=True, angle=30)
        self.parts.append(o)
        self.roof = roof
        return o

    def gh_zone(self, y, seg):
        g = self.s['gh']
        roofm = g.get('roof', 'pillar')
        if seg == 'base':
            return 'trim'
        if seg == 'dlo':                        # bright or black strip where the glass meets the body
            return g.get('dlo', 'chrome') if (g['yC'] + 0.05 < y < g['yA'] - 0.05) else 'pillar'
        if y > g['yA2']:                        # windshield zone
            if seg in ('edge', 'roof'):
                return 'glass'
            if seg == 'rail':
                return 'pillar'
            return 'glass' if y < g.get('glass_front', g['yA'] - 0.1) else 'pillar'
        if y < g['yC2']:                        # rear glass zone
            if seg in ('edge', 'roof'):
                return 'glass' if g.get('rear_glass', True) else roofm
            if seg == 'rail':
                return 'pillar'
            return 'glass' if y > g.get('glass_rear', g['yC2']) else 'pillar'
        if seg == 'roof':
            return roofm
        if seg in ('rail', 'edge'):
            return g.get('rail', roofm if seg == 'edge' else 'pillar')
        for (y0, y1) in g.get('pillars', []):
            if y0 <= y <= y1:
                return 'pillar'
        if y > g.get('glass_front', 99) or y < g.get('glass_rear', -99):
            return 'pillar'
        return 'glass'

    # ---- details
    def details(self):
        s = self.s
        surf = Surface(self.body_obj)
        bm = bmesh.new()
        for d in s.get('decals', []):
            face, u0, u1, v0, v1, key = d[:6]
            off = d[6] if len(d) > 6 else 0.004
            if face in ('side',):
                for sd in ('right', 'left'):
                    surf.patch(bm, sd, u0, u1, v0, v1, MI[key], off)
            elif face in ('front', 'rear') and len(d) > 7 and d[7] == 'mirror':
                surf.patch(bm, face, u0, u1, v0, v1, MI[key], off)
                surf.patch(bm, face, -u1, -u0, v0, v1, MI[key], off)
            else:
                surf.patch(bm, face, u0, u1, v0, v1, MI[key], off)
        extra = s.get('extra')
        if extra:
            extra(self, bm, surf)
        # inner wheelhouse walls: the arch cut runs through the whole body, so close it behind each tyre
        tw = s.get('tyre_w', 0.235)
        xw = s.get('track', s['W'] - tw - 0.04) / 2 - tw / 2 - 0.05
        for (y, r) in ([] if s.get('no_wheelhouse') else self.axles()):
            ra = r + s.get('arch_gap', 0.06)
            top = min(r + s.get('arch_lift', 0.03) + ra * 0.95, self.zb(y) + 0.78 * (self.zt(y) - self.zb(y)) - 0.03)
            bot = r * 0.4
            for sd in (1, -1):
                box(bm, (sd * xw, y, (top + bot) / 2), (0.02, ra * 2, top - bot), MI['liner'])
        tidy(bm, recalc=False)
        o = new_obj(self.slug + ' | details', bm, self.mats, self.col, smooth=True, angle=35)
        self.parts.append(o)

    def wheels(self):
        s = self.s
        tw = s.get('tyre_w', 0.235)
        x = s.get('track', s['W'] - tw - 0.04) / 2
        self.pivots = []
        for k, (y, r) in enumerate(self.axles()):
            if s.get('single_track'):
                piv = wheel(self.col, self.mats, '%s %s centre' % (self.slug, 'front' if y > 0 else 'rear'), 0.0, y, r, tw, s.get('wheel', 'aero'), 1)
                piv.parent = self.root
                self.pivots.append(piv)
                continue
            for side in (1, -1):
                xs = [x] if not (s.get('dual_rear') and k == 0) else [x - 0.02]
                for xx in xs:
                    piv = wheel(self.col, self.mats, '%s %s %s' % (self.slug, 'front' if y > 0 else 'rear', 'right' if side > 0 else 'left'),
                                side * xx, y, r, tw * (1.6 if s.get('dual_rear') and k == 0 else 1.0), s.get('wheel', 'aero'), side)
                    piv.parent = self.root
                    self.pivots.append(piv)

    def build(self):
        t = time.time()
        self.body()
        self.greenhouse()
        self.details()
        self.wheels()
        for o in self.parts:
            apply_mods(o)
            o.parent = self.root
        # merge body parts into one mesh (keeps export small; the web kit re-merges by class anyway)
        bpy.ops.object.select_all(action='DESELECT')
        for o in self.parts:
            o.select_set(True)
        bpy.context.view_layer.objects.active = self.parts[0]
        bpy.ops.object.join()
        self.body_obj = bpy.context.view_layer.objects.active
        self.body_obj.name = self.slug + ' | body'
        tris = sum(len(p.vertices) - 2 for p in self.body_obj.data.polygons)
        wt = sum(sum(len(p.vertices) - 2 for p in c.data.polygons) for pv in self.pivots for c in pv.children)
        log('%s built in %.1fs: body %d tris, wheels %d tris' % (self.slug, time.time() - t, tris, wt))
        self.tris = tris + wt
        return self

    # ---- export
    def objects(self):
        out = [self.root, self.body_obj]
        for p in self.pivots:
            out += [p] + list(p.children)
        return out

    def export(self):
        os.makedirs(OUT, exist_ok=True)
        path = os.path.join(OUT, 'gz_%s.glb' % self.slug)
        bpy.ops.object.select_all(action='DESELECT')
        for o in self.objects():
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                                  export_materials='EXPORT', export_texcoords=False, export_normals=True, export_extras=True,
                                  export_animations=False, export_cameras=False, export_lights=False,
                                  export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
        # far LOD: everything merged, collapse-decimated
        dg = bpy.context.evaluated_depsgraph_get()
        bm = bmesh.new()
        for o in [self.body_obj] + [c for p in self.pivots for c in p.children]:
            me = o.evaluated_get(dg).to_mesh()
            tmp = bmesh.new()
            tmp.from_mesh(me)
            tmp.transform(o.matrix_world)
            m2 = bpy.data.meshes.new('tmp')
            tmp.to_mesh(m2); tmp.free()
            bm.from_mesh(m2)
            bpy.data.meshes.remove(m2)
            o.evaluated_get(dg).to_mesh_clear()
        me = bpy.data.meshes.new(self.slug + ' lod2')
        bm.to_mesh(me); bm.free()
        for m in self.mats:
            me.materials.append(m)
        lod = bpy.data.objects.new('vehicle_lod2', me)
        self.col.objects.link(lod)
        dec = lod.modifiers.new('lod', 'DECIMATE')
        dec.ratio = self.s.get('lod_ratio', 0.14)
        apply_mods(lod)
        lpath = os.path.join(OUT, 'gz_%s_lod2.glb' % self.slug)
        bpy.ops.object.select_all(action='DESELECT')
        lod.select_set(True)
        bpy.ops.export_scene.gltf(filepath=lpath, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                                  export_materials='EXPORT', export_texcoords=False, export_normals=True, export_extras=True,
                                  export_animations=False, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
        lt = sum(len(p.vertices) - 2 for p in lod.data.polygons)
        bpy.data.objects.remove(lod)
        log('%s -> %s (%d KB), lod2 %d tris (%d KB)' % (self.slug, os.path.basename(path), os.path.getsize(path) // 1024, lt, os.path.getsize(lpath) // 1024))
        return {'file': os.path.basename(path), 'lod2': os.path.basename(lpath), 'tris': self.tris, 'lod2_tris': lt,
                'length': self.s['L'], 'width': self.s['W'], 'height': self.s['H']}


# ------------------------------------------------------------------------------------------ extras
def mirrors(v, bm, y, z, x_out=0.1):
    """Door mirrors: a stalk from the door top at the front of the side glass, housing, glass, repeater."""
    body = MI['pillar'] if v.s.get('pillar', 'gloss') == 'gloss' else MI['paint']
    for sd in (1, -1):
        x0 = v.w(y) * 0.9
        box(bm, (sd * (x0 + 0.06), y, z - 0.06), (0.14, 0.05, 0.035), MI['trim'])
        xh = x0 + 0.12 + x_out * 0.5
        box(bm, (sd * xh, y - 0.01, z), (x_out + 0.08, 0.09, 0.105), body)
        box(bm, (sd * xh, y - 0.057, z), (x_out + 0.06, 0.004, 0.085), MI['glass'])
        box(bm, (sd * (xh + 0.02), y + 0.036, z - 0.035), (x_out + 0.02, 0.02, 0.012), MI['amber'])


def wipers(v, bm, y, z, span):
    for x0 in (-span * 0.55, span * 0.05):
        a = math.radians(-12)
        box(bm, (x0 + span * 0.25, y, z), (span * 0.5, 0.018, 0.012), MI['trim'], Matrix.Rotation(a, 3, 'Z'))


def roof_rails(v, bm, y0, y1, x, h=0.06):
    for sd in (1, -1):
        for y in (y0, y1):
            box(bm, (sd * x, y, v.roof(y) + h * 0.5), (0.04, 0.06, h), MI['trim'])
        n = 12
        for k in range(n):
            ya, yb = y0 + (y1 - y0) * k / n, y0 + (y1 - y0) * (k + 1) / n
            box(bm, (sd * x, (ya + yb) / 2, (v.roof(ya) + v.roof(yb)) / 2 + h), (0.035, abs(yb - ya) + 0.002, 0.03), MI['chrome'])


def front_plate(v, bm, surf, z=0.45):
    surf.patch(bm, 'front', -0.22, 0.22, z - 0.07, z + 0.07, MI['plate'], 0.006, 5, 3)


def rear_plate(v, bm, surf, z=0.62):
    surf.patch(bm, 'rear', -0.22, 0.22, z - 0.07, z + 0.07, MI['plate'], 0.006, 5, 3)


# ------------------------------------------------------------------------------------------ specs
def sedan_rule(v, c, n):
    z = c.z
    if z < 0.3 and abs(n.z) < 0.9:
        return 'trim'
    if n.y > 0.55 and z < 0.4:
        return 'grille'
    if n.y < -0.55 and z < 0.44:
        return 'trim'
    return None


def sedan_extra(v, bm, surf):
    s = v.s
    mirrors(v, bm, s['gh'].get('glass_front', s['gh']['yA']) - 0.02, v.zt(s['gh']['yA']) + 0.12)
    wipers(v, bm, s['gh']['yA'] - 0.08, v.zt(s['gh']['yA']) + 0.005, 1.25)
    front_plate(v, bm, surf, 0.36)
    rear_plate(v, bm, surf, 0.58)


def taxi_rule(v, c, n):
    t = sedan_rule(v, c, n)
    if t:
        return t
    return 'livery' if c.z < 0.74 else None


def taxi_extra(v, bm, surf):
    sedan_extra(v, bm, surf)
    y = -0.25
    z = v.roof(y)
    box(bm, (0, y, z + 0.02), (0.1, 0.36, 0.05), MI['trim'])
    box(bm, (0, y, z + 0.1), (0.58, 0.2, 0.12), MI['sign'])
    box(bm, (0, y, z + 0.17), (0.6, 0.22, 0.02), MI['livery'])


def police_rule(v, c, n):
    z = c.z
    if z < 0.4 and abs(n.z) < 0.95:
        return 'trim'
    if n.y > 0.5 and z < 0.5:
        return 'trim'
    if abs(n.x) > 0.4 and 0.6 < z < 0.84:
        return 'livery'
    if abs(n.x) > 0.4 and 0.84 < z < 0.875:
        return 'livery2'
    return None


def police_extra(v, bm, surf):
    s = v.s
    g = s['gh']
    mirrors(v, bm, g.get('glass_front', g['yA']) - 0.02, v.zt(g['yA']) + 0.13, 0.12)
    wipers(v, bm, g['yA'] - 0.08, v.zt(g['yA']) + 0.005, 1.35)
    front_plate(v, bm, surf, 0.52)
    rear_plate(v, bm, surf, 0.7)
    roof_rails(v, bm, g['yC2'] + 0.1, g['yA2'] - 0.1, v.w(0) * 0.62, 0.05)
    # light bar across the roof, red on the left, blue on the right, a white centre
    y = g['yA2'] - 0.35
    z = v.roof(y) + 0.02
    box(bm, (0, y, z + 0.03), (1.2, 0.3, 0.05), MI['trim'])
    for k in range(6):
        x = -0.55 + k * 0.22
        box(bm, (x, y, z + 0.1), (0.2, 0.26, 0.09), MI['police_r'] if x < -0.05 else MI['police_b'] if x > 0.05 else MI['head'])
    # push bar
    fy = s['L'] / 2 + 0.06
    for x in (-0.45, 0.45):
        box(bm, (x, fy, 0.55), (0.06, 0.06, 0.45), MI['trim'])
    box(bm, (0, fy + 0.02, 0.72), (1.05, 0.06, 0.06), MI['trim'])
    box(bm, (0, fy + 0.02, 0.4), (1.05, 0.06, 0.06), MI['trim'])


def suv_rule(v, c, n):
    z = c.z
    if z < 0.42 and abs(n.z) < 0.95:
        return 'trim'
    if n.y > 0.5 and z < 0.52:
        return 'grille'
    if n.y < -0.5 and z < 0.5:
        return 'trim'
    return None


def suv_extra(v, bm, surf):
    s = v.s
    g = s['gh']
    mirrors(v, bm, g.get('glass_front', g['yA']) - 0.02, v.zt(g['yA']) + 0.13, 0.12)
    wipers(v, bm, g['yA'] - 0.08, v.zt(g['yA']) + 0.005, 1.35)
    front_plate(v, bm, surf, 0.5)
    rear_plate(v, bm, surf, 0.7)
    roof_rails(v, bm, g['yC2'] + 0.1, g['yA2'] - 0.1, v.w(0) * 0.62)


def sport_rule(v, c, n):
    z = c.z
    if z < 0.22 and abs(n.z) < 0.95:
        return 'trim'
    if n.y > 0.5 and z < 0.32:
        return 'grille'
    if n.y < -0.4 and z < 0.4:
        return 'grille'
    return None


def sport_extra(v, bm, surf):
    s = v.s
    g = s['gh']
    mirrors(v, bm, g.get('glass_front', g['yA']) - 0.02, v.zt(g['yA']) + 0.1, 0.1)
    front_plate(v, bm, surf, 0.3)
    rear_plate(v, bm, surf, 0.5)
    # ducktail spoiler lip and a rear diffuser with fins
    y = -s['L'] / 2 + 0.12
    box(bm, (0, y, v.zt(y) + 0.02), (1.5, 0.12, 0.025), MI['grille'])
    for x in (-0.45, -0.15, 0.15, 0.45):
        box(bm, (x, -s['L'] / 2 + 0.2, 0.2), (0.012, 0.35, 0.12), MI['grille'])


def mpv_rule(v, c, n):
    z = c.z
    if z < 0.36 and abs(n.z) < 0.95:
        return 'trim'
    if n.y > 0.5 and z < 0.46:
        return 'trim'
    if n.y < -0.5 and z < 0.46:
        return 'trim'
    return None


def mpv_extra(v, bm, surf):
    s = v.s
    g = s['gh']
    mirrors(v, bm, g.get('glass_front', g['yA']) - 0.02, v.zt(g['yA']) + 0.13, 0.12)
    wipers(v, bm, g['yA'] - 0.06, v.zt(g['yA']) + 0.005, 1.3)
    front_plate(v, bm, surf, 0.46)
    rear_plate(v, bm, surf, 0.78)
    roof_rails(v, bm, g['yC2'] + 0.15, g['yA2'] - 0.05, v.w(0) * 0.66, 0.05)
    # chrome grille bars between the lamps
    for k in range(3):
        surf.patch(bm, 'front', -0.42, 0.42, 0.62 + k * 0.045, 0.64 + k * 0.045, MI['chrome'], 0.008, 12, 2)
    # sliding-door rail under the rear side glass
    for sd in ('right', 'left'):
        surf.patch(bm, sd, -1.25, 0.1, v.zt(-0.5) - 0.06, v.zt(-0.5) - 0.04, MI['trim'], 0.006, 20, 2)


def bus_rule(v, c, n):
    z = c.z
    L = v.s['L']
    if z < 0.32 and abs(n.z) < 0.95:
        return 'trim'
    if abs(n.z) > 0.8 and z > 3.0:
        return 'livery2'                                  # roof (battery pods sit here)
    if n.y > 0.6:                                         # front
        if z > 1.05:
            return 'glass'
        return 'livery' if z < 0.5 else None
    if n.y < -0.6:                                        # rear
        if 1.6 < z < 2.7:
            return 'glass'
        return 'livery' if z < 0.5 else None
    if abs(n.x) > 0.6:
        y = c.y
        if 0.55 < z < 0.95:
            return 'livery'                                # emerald band
        if 1.2 < z < 2.85:
            # window pillars every ~1.35 m, doors are solid glass
            door = (L / 2 - 1.6 < y < L / 2 - 0.35) or (-0.9 < y < 0.45)
            if door and c.x > 0:
                return 'glass'
            ph = (y + 20) % 1.35
            return 'pillar' if ph < 0.12 else 'glass'
        if door_zone(v, c):
            return 'glass'
    return None


def door_zone(v, c):
    L = v.s['L']
    return c.x > 0 and 0.35 < c.z < 2.85 and ((L / 2 - 1.6 < c.y < L / 2 - 0.35) or (-0.9 < c.y < 0.45))


def bus_extra(v, bm, surf):
    s = v.s
    L = s['L']
    # destination display and a route number panel
    surf.patch(bm, 'front', -0.9, 0.9, 2.62, 2.92, MI['sign'], 0.012, 20, 4)
    surf.patch(bm, 'rear', -0.3, 0.3, 2.72, 2.92, MI['sign'], 0.012, 8, 3)
    surf.patch(bm, 'side', L / 2 - 3.2, L / 2 - 1.9, 2.55, 2.75, MI['sign'], 0.01)
    # door frames
    for (y0, y1) in ((L / 2 - 1.6, L / 2 - 0.35), (-0.9, 0.45)):
        for y in (y0, (y0 + y1) / 2, y1):
            surf.patch(bm, 'right', y - 0.03, y + 0.03, 0.35, 2.85, MI['trim'], 0.01, 2, 12)
    # mirrors on arms, wipers, battery pods on the roof
    for sd in (1, -1):
        box(bm, (sd * 1.38, L / 2 + 0.15, 2.3), (0.05, 0.05, 0.5), MI['trim'])
        box(bm, (sd * 1.42, L / 2 + 0.25, 2.05), (0.12, 0.08, 0.35), MI['trim'])
    for x0 in (-0.6, 0.3):
        box(bm, (x0, L / 2 + 0.03, 1.15), (0.9, 0.02, 0.02), MI['trim'], Matrix.Rotation(math.radians(10), 3, 'Y'))
    box(bm, (0, 0.8, 3.3), (1.9, 4.2, 0.22), MI['livery2'])
    box(bm, (0, -3.8, 3.28), (1.7, 1.8, 0.18), MI['livery2'])
    front_plate(v, bm, surf, 0.42)
    rear_plate(v, bm, surf, 0.5)


def headlamps(y_front, z, w_in, w_out, h=0.07, bar=True):
    """Decals: two lamp units at the corners and (optionally) a full-width DRL bar."""
    d = [('front', w_in, w_out, z - h, z, 'head', 0.008, 'mirror')]
    if bar:
        d.append(('front', -w_out + 0.02, w_out - 0.02, z + 0.012, z + 0.03, 'drl', 0.009))
    return d


def taillamps(z, w, h=0.06, bar=True):
    d = [('rear', w * 0.55, w - 0.03, z - h, z, 'tail', 0.008, 'mirror')]
    if bar:
        d.append(('rear', -w + 0.04, w - 0.04, z - 0.022, z - 0.004, 'tail', 0.009))
    return d


def door_lines(ys, z0, z1):
    return [('side', y - 0.004, y + 0.004, z0, z1, 'seam', 0.003) for y in ys]


def handles(ys, z):
    return [('side', y - 0.09, y + 0.09, z - 0.014, z + 0.014, 'chrome', 0.006) for y in ys]


SPECS = {}

# V5 electric family sedan: fastback greenhouse, floating black roof, full-width light bars
SPECS['sedan'] = dict(
    L=4.8, W=1.86, H=1.45, r=0.345, axles=(-1.43, 1.47), paint='#c5c9cc', wheel='aero',
    plan=[(-2.4, 0.62), (-2.36, 0.76), (-2.2, 0.88), (-1.8, 0.925), (0, 0.93), (1.7, 0.925), (2.15, 0.88), (2.34, 0.76), (2.4, 0.58)],
    top=[(-2.4, 0.7), (-2.34, 0.86), (-2.12, 0.955), (-1.6, 0.975), (-0.6, 0.965), (0.6, 0.955), (1.05, 0.93),
         (1.6, 0.86), (2.1, 0.77), (2.33, 0.69), (2.4, 0.6)],
    bottom=[(-2.4, 0.46), (-2.28, 0.32), (-1.95, 0.25), (1.95, 0.24), (2.28, 0.3), (2.4, 0.4)],
    gh=dict(yC=-1.82, yC2=-0.92, yA2=0.12, yA=1.05, tumble=0.2, base_in=0.1, glass_front=0.72, glass_rear=-1.25,
            pillars=[(-0.2, -0.12)], extra_y=[-0.2, -0.12], rear_curve=0.26),
    body_rule=sedan_rule, extra=sedan_extra, cuts_z=[0.3], crease=42,
    decals=headlamps(2.4, 0.66, 0.5, 0.88) + taillamps(0.9, 0.9) + door_lines([1.02, -0.16, -1.36], 0.33, 0.93)
    + handles([0.1, -1.0], 0.86),
)

# V1 Guangzhou taxi: compact notchback, turquoise lower body, white upper, roof sign
SPECS['taxi'] = dict(
    L=4.7, W=1.8, H=1.5, r=0.33, axles=(-1.38, 1.38), paint='#f2f2ee', livery='#12a89a', fixed_livery=True,
    wheel='multi', pillar='paint',
    plan=[(-2.35, 0.6), (-2.3, 0.74), (-2.1, 0.86), (-1.7, 0.9), (0, 0.9), (1.7, 0.9), (2.1, 0.86), (2.3, 0.74), (2.35, 0.58)],
    top=[(-2.35, 0.72), (-2.28, 0.88), (-2.0, 0.97), (-1.35, 0.98), (-0.8, 0.97), (0.9, 0.95), (1.4, 0.88), (2.0, 0.79),
         (2.28, 0.72), (2.35, 0.64)],
    bottom=[(-2.35, 0.44), (-2.22, 0.31), (-1.9, 0.24), (1.9, 0.24), (2.22, 0.3), (2.35, 0.4)],
    gh=dict(yC=-1.45, yC2=-0.85, yA2=0.2, yA=1.0, tumble=0.18, base_in=0.1, glass_front=0.72, glass_rear=-1.0,
            pillars=[(-0.3, -0.21)], extra_y=[-0.3, -0.21], roof='paint', rail='paint', rear_curve=0.3),
    body_rule=taxi_rule, extra=taxi_extra, cuts_z=[0.3, 0.74],
    decals=headlamps(2.35, 0.7, 0.48, 0.84, 0.08, bar=False) + taillamps(0.92, 0.87, 0.07, bar=False)
    + door_lines([0.98, -0.25, -1.3], 0.32, 0.95) + handles([0.05, -1.05], 0.88),
)

# V3 police SUV: white, blue side band, reflective line, light bar, push bar
SPECS['police'] = dict(
    L=4.9, W=1.95, H=1.72, r=0.38, axles=(-1.45, 1.47), paint='#f4f5f2', livery='#15356e', livery2='#c7e84a', fixed_livery=True,
    wheel='multi', rim='dark', profile=PROF_SUV,
    plan=[(-2.45, 0.7), (-2.4, 0.84), (-2.2, 0.95), (-1.8, 0.975), (0, 0.975), (1.8, 0.975), (2.2, 0.95), (2.4, 0.84), (2.45, 0.7)],
    top=[(-2.45, 0.9), (-2.38, 1.04), (-2.2, 1.1), (-1.5, 1.12), (0.9, 1.1), (1.4, 1.03), (2.0, 0.97), (2.35, 0.9), (2.45, 0.8)],
    bottom=[(-2.45, 0.5), (-2.3, 0.38), (-1.95, 0.32), (1.95, 0.32), (2.3, 0.38), (2.45, 0.46)],
    gh=dict(yC=-2.3, yC2=-2.0, yA2=0.45, yA=1.12, tumble=0.16, base_in=0.08, glass_front=0.88, glass_rear=-1.75,
            pillars=[(-0.25, -0.15), (-1.35, -1.25)], extra_y=[-0.25, -0.15, -1.35, -1.25], roof='paint', rail='paint', crown=0.02, rear_curve=0.05),
    body_rule=police_rule, extra=police_extra, cuts_z=[0.4, 0.6, 0.84, 0.875],
    decals=headlamps(2.45, 0.92, 0.55, 0.92, 0.06) + taillamps(1.02, 0.95, 0.12, bar=False)
    + door_lines([1.1, -0.2, -1.3], 0.42, 1.1) + handles([0.15, -1.05], 1.03),
)

# V6 electric SUV: graphite, floating black roof, rails, black cladding
SPECS['suv'] = dict(
    L=4.9, W=1.95, H=1.7, r=0.39, axles=(-1.47, 1.48), paint='#4a4f55', wheel='sport', profile=PROF_SUV,
    plan=[(-2.45, 0.72), (-2.4, 0.85), (-2.2, 0.955), (-1.8, 0.975), (0, 0.975), (1.8, 0.975), (2.2, 0.95), (2.4, 0.84), (2.45, 0.68)],
    top=[(-2.45, 0.92), (-2.38, 1.05), (-2.2, 1.1), (-1.5, 1.12), (0.9, 1.1), (1.4, 1.04), (2.0, 0.96), (2.36, 0.88), (2.45, 0.8)],
    bottom=[(-2.45, 0.52), (-2.3, 0.4), (-1.95, 0.33), (1.95, 0.33), (2.3, 0.4), (2.45, 0.48)],
    gh=dict(yC=-2.25, yC2=-1.85, yA2=0.42, yA=1.12, tumble=0.18, base_in=0.08, glass_front=0.86, glass_rear=-1.6,
            pillars=[(-0.25, -0.15)], extra_y=[-0.25, -0.15], crown=0.025, rear_curve=0.12),
    body_rule=suv_rule, extra=suv_extra, cuts_z=[0.42],
    decals=headlamps(2.45, 0.9, 0.58, 0.92, 0.05) + taillamps(1.02, 0.95, 0.05) + door_lines([1.1, -0.2, -1.32], 0.44, 1.1)
    + handles([0.12, -1.05], 1.03),
)

# V7 electric sports car: low wide wedge, black canopy
SPECS['sports'] = dict(
    L=4.6, W=2.0, H=1.2, r=0.35, axles=(-1.35, 1.35), paint='#b0141e', wheel='sport', rim='dark', profile=PROF_SPORT,
    plan=[(-2.3, 0.72), (-2.25, 0.88), (-2.0, 0.99), (-1.35, 1.0), (-0.4, 0.95), (0.6, 0.94), (1.5, 0.99), (2.05, 0.93), (2.25, 0.8), (2.3, 0.62)],
    top=[(-2.3, 0.64), (-2.24, 0.8), (-2.0, 0.88), (-1.4, 0.9), (-0.9, 0.87), (0.4, 0.84), (1.0, 0.84), (1.5, 0.82), (1.9, 0.72), (2.15, 0.6), (2.3, 0.5)],
    bottom=[(-2.3, 0.36), (-2.1, 0.2), (-1.8, 0.16), (1.8, 0.16), (2.15, 0.2), (2.3, 0.3)],
    gh=dict(yC=-1.55, yC2=-0.55, yA2=0.1, yA=1.05, tumble=0.26, base_in=0.14, glass_front=0.72, glass_rear=-0.75,
            crown=0.02, rear_curve=0.35, roof='pillar'),
    body_rule=sport_rule, extra=sport_extra, cuts_z=[0.22], crease=36,
    decals=headlamps(2.3, 0.54, 0.62, 0.9, 0.035) + taillamps(0.78, 0.96, 0.03)
    + door_lines([1.0, -0.62], 0.24, 0.85) + [('side', -1.1, -0.8, 0.42, 0.6, 'grille', 0.004)],
    lod_ratio=0.16,
)

# Uncle Keung's older electric MPV: tall, boxy, champagne, chrome grille bars, sliding doors
SPECS['mpv'] = dict(
    L=4.95, W=1.85, H=1.82, r=0.34, axles=(-1.5, 1.52), paint='#c9b48a', wheel='multi', pillar='gloss', profile=PROF_SUV,
    plan=[(-2.475, 0.7), (-2.43, 0.84), (-2.25, 0.915), (-1.8, 0.925), (0, 0.925), (1.8, 0.925), (2.2, 0.9), (2.42, 0.8), (2.475, 0.64)],
    top=[(-2.475, 0.95), (-2.42, 1.02), (-2.3, 1.05), (-1.0, 1.06), (1.2, 1.05), (1.6, 0.98), (2.1, 0.86), (2.42, 0.8), (2.475, 0.7)],
    bottom=[(-2.475, 0.5), (-2.35, 0.36), (-2.0, 0.3), (2.0, 0.3), (2.35, 0.36), (2.475, 0.44)],
    gh=dict(yC=-2.42, yC2=-2.3, yA2=0.55, yA=1.45, tumble=0.12, base_in=0.08, glass_front=1.08, glass_rear=-2.1,
            pillars=[(0.08, 0.18), (-1.3, -1.2)], extra_y=[0.08, 0.18, -1.3, -1.2], crown=0.02, rear_curve=0.02, roof='paint', rail='paint'),
    body_rule=mpv_rule, extra=mpv_extra, cuts_z=[0.36],
    decals=headlamps(2.475, 0.78, 0.5, 0.86, 0.1, bar=False) + taillamps(1.3, 0.9, 0.22, bar=False)
    + door_lines([1.4, 0.13, -1.25], 0.38, 1.05) + handles([0.25, -0.2], 0.95),
)

# V2 12 m low-floor electric bus: white, emerald band, glass sides, LED route displays
SPECS['bus'] = dict(
    L=12.0, W=2.55, H=3.2, r=0.5, axles=(-2.2, 3.7), paint='#f1f2ee', livery='#0f8a5f', livery2='#d8dadc', fixed_livery=True,
    wheel='bus', rim='dark', profile=PROF_BOX, tyre_w=0.3, dual_rear=False, stations=160, ring=30,
    plan=[(-6.0, 1.18), (-5.9, 1.26), (-5.6, 1.275), (5.6, 1.275), (5.9, 1.26), (6.0, 1.2)],
    top=[(-6.0, 3.05), (-5.85, 3.16), (-5.4, 3.2), (5.4, 3.2), (5.85, 3.14), (6.0, 3.0)],
    bottom=[(-6.0, 0.5), (-5.8, 0.36), (-5.2, 0.3), (5.2, 0.3), (5.8, 0.34), (6.0, 0.42)],
    body_rule=bus_rule, extra=bus_extra, arch_gap=0.07, arch_lift=0.0,
    cuts_z=[0.32, 0.5, 0.55, 0.95, 1.05, 1.2, 1.6, 2.7, 2.85, 3.0],
    decals=[('front', 0.72, 1.12, 0.62, 0.78, 'head', 0.01, 'mirror'), ('front', -1.1, 1.1, 0.8, 0.83, 'drl', 0.01),
            ('rear', 0.85, 1.15, 0.7, 1.3, 'tail', 0.01, 'mirror')],
    crease=30, lod_ratio=0.2,
)


# ------------------------------------------------------------------------------------------ scooter
def rbox(bm, c, size, r, mi, rot=None, seg=3):
    """Box with rounded edges (bevelled cube)."""
    vs = box(bm, c, size, mi, rot)
    edges = list({e for v in vs for e in v.link_edges})
    bmesh.ops.bevel(bm, geom=edges, offset=min(r, min(size) * 0.45), segments=seg, affect='EDGES', profile=0.5)
    return vs


def tube(bm, a, b, r, mi, seg=10):
    """Cylinder between two points."""
    a, b = Vector(a), Vector(b)
    d = b - a
    res = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=d.length)
    q = d.to_track_quat('Z', 'Y')
    bmesh.ops.transform(bm, matrix=Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4(), verts=res['verts'])
    for f in {f for v in res['verts'] for f in v.link_faces}:
        f.material_index = mi


def arc_strip(bm, cy, cz, r, a0, a1, width, thick, mi, n=16):
    """A curved fender: an arc of radius r about the axle (angles from +Y toward +Z), `width` across."""
    rows = []
    for k in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * k / n)
        rows.append([bm.verts.new((x, cy + rr * math.cos(a), cz + rr * math.sin(a))) for rr in (r, r + thick) for x in (-width / 2, width / 2)])
    for k in range(n):
        A, B = rows[k], rows[k + 1]
        for q in ((A[2], A[3], B[3], B[2]), (A[1], A[0], B[0], B[1]), (A[0], A[2], B[2], B[0]), (A[3], A[1], B[1], B[3])):
            f = bm.faces.new(q)
            f.material_index = mi
    for R in (rows[0], rows[-1]):
        f = bm.faces.new((R[0], R[1], R[3], R[2]))
        f.material_index = mi
    return rows


def scooter_rule(v, c, n):
    y, z = c.y, c.z
    if z < 0.29 and abs(n.z) < 0.95:
        return 'trim'
    if n.z > 0.75 and -0.12 < y < 0.3 and z < 0.4:
        return 'trim'                                     # rubber floor mat
    if y > 0.28 and n.y > 0.35:
        return 'livery'                                   # front apron
    if y < -0.2 and abs(n.x) > 0.55 and z > 0.42:
        return 'livery'                                   # rear side covers
    return None


def scooter_extra(v, bm, surf):
    L = 'livery'
    # seat: a rounded loft on the rear body
    ys = [(-0.8 + 0.64 * k / 24) for k in range(25)]
    prof = resample([(0, 0), (0.85, 0), (1.0, 0.25), (0.95, 0.75), (0.7, 1.0), (0, 1.0)], 12)
    rings = []
    for y in ys:
        w = 0.14 * min(1, (y + 0.82) / 0.08) * min(1, (-0.12 - y) / 0.12 + 0.35)
        z0 = v.zt(y) - 0.02
        z1 = z0 + 0.09 + 0.02 * math.sin((y + 0.8) / 0.64 * math.pi)
        right = [Vector((u * w, y, z0 + t * (z1 - z0))) for u, t in prof]
        left = [Vector((-u * w, y, z0 + t * (z1 - z0))) for u, t in reversed(prof[1:-1])]
        rings.append(right + left)
    loft(bm, rings, lambda i, j: MI['seat'])
    # steering column leaning back, head cowl with the lamp, handlebar, grips, levers, mirrors, phone mount
    top = Vector((0, 0.38, 1.02))
    tube(bm, (0, 0.5, 0.62), top, 0.028, MI['trim'])
    rbox(bm, (0, 0.44, 1.0), (0.22, 0.16, 0.13), 0.04, MI['livery'])
    rbox(bm, (0, 0.525, 1.0), (0.15, 0.02, 0.07), 0.015, MI['head'])
    rbox(bm, (0, 0.52, 1.045), (0.18, 0.012, 0.012), 0.004, MI['drl'])
    tube(bm, (-0.3, 0.38, 1.06), (0.3, 0.38, 1.06), 0.013, MI['trim'])
    for sd in (1, -1):
        tube(bm, (sd * 0.24, 0.38, 1.06), (sd * 0.35, 0.38, 1.06), 0.02, MI['seat'])
        tube(bm, (sd * 0.2, 0.4, 1.07), (sd * 0.3, 0.46, 1.05), 0.006, MI['chrome'])
        tube(bm, (sd * 0.17, 0.38, 1.07), (sd * 0.24, 0.36, 1.26), 0.007, MI['chrome'])
        rbox(bm, (sd * 0.26, 0.355, 1.29), (0.11, 0.025, 0.07), 0.012, MI['trim'])
        rbox(bm, (sd * 0.26, 0.342, 1.29), (0.095, 0.004, 0.058), 0.002, MI['glass'])
        rbox(bm, (sd * 0.2, 0.5, 0.95), (0.05, 0.02, 0.03), 0.006, MI['amber'])
    rbox(bm, (0, 0.36, 1.12), (0.09, 0.03, 0.16), 0.01, MI['trim'], Matrix.Rotation(math.radians(-20), 3, 'X'))
    rbox(bm, (0, 0.352, 1.125), (0.075, 0.006, 0.14), 0.004, MI['glass'], Matrix.Rotation(math.radians(-20), 3, 'X'))
    # front fork, fender and a small front plate
    for sd in (1, -1):
        tube(bm, (sd * 0.07, 0.64, 0.24), (sd * 0.06, 0.53, 0.62), 0.022, MI['chrome'])
    arc_strip(bm, 0.64, 0.24, 0.285, 15, 150, 0.13, 0.012, MI[L])
    # swing arm with the hub motor, rear fender, tail lamp, plate
    rbox(bm, (0.1, -0.42, 0.28), (0.05, 0.42, 0.08), 0.02, MI['trim'])
    arc_strip(bm, -0.62, 0.24, 0.285, 95, 200, 0.12, 0.01, MI['paint'])
    rbox(bm, (0, -0.87, 0.6), (0.16, 0.05, 0.06), 0.015, MI['tail'])
    rbox(bm, (0, -0.86, 0.45), (0.15, 0.01, 0.09), 0.005, MI['plate'])
    # Zhunshida delivery box on a chrome rack
    for sd in (1, -1):
        tube(bm, (sd * 0.12, -0.3, v.zt(-0.3)), (sd * 0.12, -0.52, 0.8), 0.012, MI['chrome'])
    rbox(bm, (0, -0.55, 0.8), (0.3, 0.3, 0.025), 0.008, MI['chrome'])
    rbox(bm, (0, -0.55, 1.04), (0.44, 0.44, 0.44), 0.05, MI[L])
    rbox(bm, (0, -0.55, 1.27), (0.455, 0.455, 0.035), 0.015, MI['livery2'])
    for sd in (1, -1):
        rbox(bm, (sd * 0.222, -0.55, 0.98), (0.004, 0.32, 0.03), 0.001, MI['chrome'])
    rbox(bm, (0, -0.772, 0.98), (0.32, 0.004, 0.03), 0.001, MI['chrome'])
    rbox(bm, (0, -0.772, 1.1), (0.14, 0.004, 0.05), 0.001, MI['livery2'])
    # side stand and footboard edge trim
    tube(bm, (-0.1, -0.12, 0.26), (-0.2, -0.2, 0.02), 0.012, MI['trim'])
    for sd in (1, -1):
        tube(bm, (sd * 0.15, -0.12, 0.345), (sd * 0.15, 0.3, 0.345), 0.008, MI['chrome'])


SPECS['scooter'] = dict(
    L=1.8, W=0.7, H=1.4, r=0.24, axles=(-0.62, 0.64), paint='#2a2d31', livery='#c6f03c', livery2='#1b1d1f',
    fixed_livery=True, wheel='sport', rim='dark', tyre_w=0.11, single_track=True, no_wheelhouse=True,
    profile=resample([(0, 0), (0.6, 0), (0.9, 0.05), (1.0, 0.25), (1.0, 0.6), (0.95, 0.85), (0.8, 0.97), (0.45, 1.0), (0, 1.0)], 14),
    plan=[(-0.88, 0.05), (-0.78, 0.13), (-0.5, 0.17), (-0.2, 0.165), (0.0, 0.15), (0.28, 0.15), (0.4, 0.165), (0.47, 0.155), (0.52, 0.1)],
    top=[(-0.88, 0.6), (-0.72, 0.7), (-0.4, 0.72), (-0.18, 0.66), (-0.08, 0.36), (0.26, 0.34), (0.33, 0.52), (0.4, 0.86), (0.46, 0.96), (0.52, 0.9)],
    bottom=[(-0.88, 0.5), (-0.72, 0.4), (-0.4, 0.32), (-0.1, 0.24), (0.3, 0.24), (0.42, 0.36), (0.52, 0.55)],
    span=(-0.88, 0.52), arch_gap=0.035, arch_lift=0.01, body_rule=scooter_rule, extra=scooter_extra, stations=70, ring=26, crease=50, cuts_z=[0.29, 0.42],
    decals=[], lod_ratio=0.35,
)


# ------------------------------------------------------------------------------------------ preview
def preview(vehicles):
    os.makedirs(PREV, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 32
    sc.render.resolution_x, sc.render.resolution_y = 1400, 800
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('studio')
    w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    bg.inputs['Strength'].default_value = 0.9
    sc.world = w
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4.0
    sun.data.angle = math.radians(3)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    sc.collection.objects.link(sun)
    gm = bpy.data.meshes.new('ground')
    bmg = bmesh.new()
    bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=60)
    bmg.to_mesh(gm); bmg.free()
    gmat = make_mat('ground', srgb('#6a6b6d'), 0, 0.8)
    gm.materials.append(gmat)
    g = bpy.data.objects.new('ground', gm)
    sc.collection.objects.link(g)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 50
    sc.collection.objects.link(cam)
    sc.camera = cam
    # line the vehicles up and shoot each at 3/4 front and 3/4 rear
    for v in vehicles:
        for o in bpy.data.collections['VEH ' + v.slug].objects:
            o.hide_render = True
    for v in vehicles:
        objs = list(bpy.data.collections['VEH ' + v.slug].objects)
        for o in objs:
            o.hide_render = o.type == 'MESH' and o.name == 'vehicle_lod2'
        L = v.s['L']
        dist = max(6.5, L * 1.45) if L > 3 else 3.6
        for tag, az, el in (('front', 38, 14), ('rear', 215, 18)):
            a = math.radians(az)
            cam.location = (dist * math.sin(a), dist * math.cos(a), dist * math.tan(math.radians(el)) + 0.4)
            d = Vector((0, 0, v.s.get('H', 1.5) * 0.45)) - cam.location
            cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
            sc.render.filepath = os.path.join(PREV, '%s_%s.png' % (v.slug, tag))
            bpy.ops.render.render(write_still=True)
        for o in objs:
            o.hide_render = True
    log('previews in', PREV)


def main():
    t0 = time.time()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    only = arg('--only')
    names = only.split(',') if only else list(SPECS)
    vehicles = []
    for n in names:
        v = Vehicle(n, SPECS[n]).build()
        vehicles.append(v)
    report = {}
    if '--no-export' not in ARGS:
        for v in vehicles:
            report[v.slug] = Vehicle.export(v)
        man = os.path.join(OUT, 'gz_vehicles.json')
        old = json.load(open(man)) if os.path.exists(man) else {}
        old.update(report)
        json.dump(old, open(man, 'w'), indent=1)
    if '--no-preview' not in ARGS:
        preview(vehicles)
    if arg('--save'):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(arg('--save')))
    log('done in %.1fs' % (time.time() - t0))


main()
