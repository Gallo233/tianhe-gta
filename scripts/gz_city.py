"""Tianhe generic city from the prepared OSM data: ground + Pearl River, green, roads + bridges + markings,
buildings (non-landmark), street and park trees.

Heights / levels (metres):
  carriageways sit in channels cut into the ground: channel floor z = 0, road ribbons 0.012-0.021 by class
  (higher class wins at junctions); pavements / blocks at KERB = 0.15 with kerb faces from the cut; lawns
  KERB + 0.03..0.05; river water -2.8 in a cut down to -7 (embankment walls fall out of the Boolean);
  small ponds/creeks -0.9.
Data (c) OpenStreetMap contributors, ODbL.
"""
import heapq
import json
import math
import os
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector

import gz_common as c
import gz_materials as gm
import gz_metro

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = None
RASTER = None

RIVER_MIN_AREA = 150_000
RIVER_Z, RIVER_CUT = -2.8, -7.0
POND_Z, POND_CUT = -0.9, -2.0
TILE = 700.0

MAJOR = {'motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link'}
FOOT = {'footway', 'path', 'cycleway', 'pedestrian'}
KERB = 0.15          # pavements, blocks, lawns sit a kerb above the carriageways (roads at ~0)
# carriageway surface heights above the channel floor (z = 0): the higher class wins where ribbons overlap
Z_RANK = {'service': 0.012, 'living_street': 0.012, 'residential': 0.0135, 'unclassified': 0.015, 'tertiary': 0.0165,
          'tertiary_link': 0.0165, 'secondary': 0.018, 'secondary_link': 0.018, 'primary': 0.0195, 'primary_link': 0.0195,
          'trunk': 0.021, 'trunk_link': 0.021, 'motorway': 0.021, 'motorway_link': 0.021}
FOOT_Z = KERB + 0.008


def log(*a):
    print('[gz]', *a, flush=True)


def data():
    global D
    if D is None:
        D = json.load(open(os.path.join(ROOT, 'data', 'tianhe_core.json')))
    return D


def bounds():
    return data()['bounds_m']


def road_kind(r):
    if r['hw'] == 'steps':
        return 'steps'
    if r['hw'] in FOOT:
        return 'foot'
    return 'major' if r['hw'] in MAJOR else 'minor'


# ------------------------------------------------------------------ geometry utils
def clean_line(pts, eps=0.05):
    out = []
    for p in pts:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > eps:
            out.append((p[0], p[1]))
    return out


def clip_polyline(pts, rect):
    """Liang-Barsky per segment; returns the list of runs inside rect."""
    x0, y0, x1, y1 = rect
    runs, cur = [], []
    for a, b in zip(pts, pts[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t0, t1 = 0.0, 1.0
        ok = True
        for p, q in ((-dx, a[0] - x0), (dx, x1 - a[0]), (-dy, a[1] - y0), (dy, y1 - a[1])):
            if p == 0:
                if q < 0: ok = False; break
            else:
                t = q / p
                if p < 0: t0 = max(t0, t)
                else: t1 = min(t1, t)
        if not ok or t0 > t1:
            if len(cur) >= 2: runs.append(cur)
            cur = []
            continue
        pa = (a[0] + t0 * dx, a[1] + t0 * dy); pb = (a[0] + t1 * dx, a[1] + t1 * dy)
        if not cur:
            cur = [pa]
        elif t0 > 0:
            if len(cur) >= 2: runs.append(cur)
            cur = [pa]
        cur.append(pb)
        if t1 < 1:
            if len(cur) >= 2: runs.append(cur)
            cur = []
    if len(cur) >= 2: runs.append(cur)
    return [clean_line(r) for r in runs if len(clean_line(r)) >= 2]


def densify(pts, step):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, math.ceil(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        for k in range(1, n + 1):
            out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
    return out


def ribbon_xy(pts, width):
    """Mitred left/right offsets (clamped) of a polyline, as 2D Vectors."""
    n = len(pts)
    P = [Vector((p[0], p[1])) for p in pts]
    L, R = [], []
    for i in range(n):
        if i == 0: d = P[1] - P[0]
        elif i == n - 1: d = P[-1] - P[-2]
        else:
            a = (P[i] - P[i - 1]).normalized(); b = (P[i + 1] - P[i]).normalized()
            d = a + b if (a + b).length > 1e-6 else a
        d = d.normalized()
        nrm = Vector((-d.y, d.x))
        k = 1.0
        if 0 < i < n - 1:
            a = (P[i] - P[i - 1]).normalized()
            k = 1 / max(0.35, nrm.dot(Vector((-a.y, a.x))))
        off = nrm * (width / 2 * k)
        L.append(P[i] + off); R.append(P[i] - off)
    return L, R


def arclen(pts):
    s = [0.0]
    for a, b in zip(pts, pts[1:]):
        s.append(s[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    return s


def point_in(p, ring):
    x, y = p; inside = False
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def key(p):
    return (round(p[0] * 2), round(p[1] * 2))


# ------------------------------------------------------------------ occupancy raster (2 m cells)
class Raster:
    def __init__(self, rect, cs=2.0):
        self.x0, self.y0, x1, y1 = rect
        self.cs = cs
        self.nx = int(math.ceil((x1 - self.x0) / cs)); self.ny = int(math.ceil((y1 - self.y0) / cs))
        self.m = {}

    def mask(self, name):
        if name not in self.m:
            self.m[name] = np.zeros((self.ny, self.nx), bool)
        return self.m[name]

    def poly(self, name, rings):
        """Even-odd scanline fill of rings (outer + holes)."""
        m = self.mask(name)
        seg = []
        for r in rings:
            for i in range(len(r)):
                a, b = r[i], r[(i + 1) % len(r)]
                seg.append((a[0], a[1], b[0], b[1]))
        if not seg:
            return
        E = np.array(seg)
        X1, Y1, X2, Y2 = E[:, 0], E[:, 1], E[:, 2], E[:, 3]
        cs = self.cs
        r0 = max(0, int((E[:, [1, 3]].min() - self.y0) / cs) - 1)
        r1 = min(self.ny - 1, int((E[:, [1, 3]].max() - self.y0) / cs) + 1)
        for row in range(r0, r1 + 1):
            cy = self.y0 + (row + 0.5) * cs
            sel = (Y1 > cy) != (Y2 > cy)
            if not sel.any():
                continue
            xi = np.sort(X1[sel] + (cy - Y1[sel]) * (X2[sel] - X1[sel]) / (Y2[sel] - Y1[sel]))
            for a, b in zip(xi[0::2], xi[1::2]):
                c0 = max(0, int(math.ceil((a - self.x0) / cs - 0.5)))
                c1 = min(self.nx - 1, int(math.floor((b - self.x0) / cs - 0.5)))
                if c1 >= c0:
                    m[row, c0:c1 + 1] = True

    def line(self, name, pts, w):
        m = self.mask(name)
        cs, h = self.cs, w / 2
        for a, b in zip(pts, pts[1:]):
            lo_x, hi_x = min(a[0], b[0]) - h, max(a[0], b[0]) + h
            lo_y, hi_y = min(a[1], b[1]) - h, max(a[1], b[1]) + h
            c0 = max(0, int((lo_x - self.x0) / cs)); c1 = min(self.nx - 1, int((hi_x - self.x0) / cs))
            r0 = max(0, int((lo_y - self.y0) / cs)); r1 = min(self.ny - 1, int((hi_y - self.y0) / cs))
            if c1 < c0 or r1 < r0:
                continue
            xs = self.x0 + (np.arange(c0, c1 + 1) + 0.5) * cs
            ys = self.y0 + (np.arange(r0, r1 + 1) + 0.5) * cs
            X, Y = np.meshgrid(xs, ys)
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy or 1e-9
            t = np.clip(((X - a[0]) * dx + (Y - a[1]) * dy) / L2, 0, 1)
            d2 = (X - a[0] - t * dx) ** 2 + (Y - a[1] - t * dy) ** 2
            m[r0:r1 + 1, c0:c1 + 1] |= d2 <= h * h

    def at(self, name, x, y):
        c_ = int((x - self.x0) / self.cs); r_ = int((y - self.y0) / self.cs)
        if not (0 <= c_ < self.nx and 0 <= r_ < self.ny):
            return False
        return bool(self.m[name][r_, c_])

    def dilate(self, name, cells, out=None):
        m = self.m[name].copy()
        for _ in range(cells):
            n = m.copy()
            n[1:, :] |= m[:-1, :]; n[:-1, :] |= m[1:, :]; n[:, 1:] |= m[:, :-1]; n[:, :-1] |= m[:, 1:]
            m = n
        self.m[out or name] = m


def raster():
    global RASTER
    if RASTER:
        return RASTER
    t = time.time()
    d = data()
    R = Raster(d['bounds_m'])
    for w in d['water']:
        R.poly('water', [w['outer']] + w['holes'])
    for g in d['green']:
        R.poly('green', [g['outer']] + g['holes'])
    for b in d['buildings']:
        R.poly('bld', [b['outer']] + b['holes'])
    for r in d['roads']:
        if r['tunnel'] or r['area']:
            continue
        R.line('road' if r['drive'] else 'foot', r['pts'], r['w'] + (1.0 if r['drive'] else 0.0))
    R.dilate('bld', 1, 'bld_d')
    R.dilate('road', 1, 'road_d')
    log('raster %dx%d in %.1fs' % (R.nx, R.ny, time.time() - t))
    RASTER = R
    return R


# ------------------------------------------------------------------ ground, water, green
def _prism_object(name, polys, z0, z1, col):
    bm = bmesh.new()
    for outer, holes in polys:
        c.extrude_polygon(bm, outer, holes, z0, z1, top=True, bottom=True)
    c.weld(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return c.obj_from_bmesh(name, bm, None, col)


def _clip_poly(outer, holes, rect, hole_pad):
    x0, y0, x1, y1 = rect
    o = c.clean_ring(c.clip_rect(outer, x0, y0, x1, y1))
    if not o or abs(c.ring_area(o)) < 4:
        return None
    hs = []
    for h in holes:
        hc = c.clean_ring(c.clip_rect(h, x0 + hole_pad, y0 + hole_pad, x1 - hole_pad, y1 - hole_pad))
        if hc and abs(c.ring_area(hc)) > 4:
            hs.append(hc if c.ring_area(hc) < 0 else hc[::-1])
    o = o if c.ring_area(o) > 0 else o[::-1]
    return o, hs


def _apply_boolean(obj, cutters_col, union_self=False, solver='EXACT'):
    """Apply a Boolean DIFFERENCE against every object in cutters_col. union_self merges overlapping
    pieces of obj first (overlapping coplanar lawns shadow each other black in Cycles)."""
    mod = obj.modifiers.new('water cut', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'; mod.operand_type = 'COLLECTION'; mod.collection = cutters_col
    mod.solver = solver
    if solver == 'EXACT':
        mod.use_self = union_self
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear(); obj.data = me; me.name = old.name
    bpy.data.meshes.remove(old)
    me.materials.clear()  # the Boolean result carries an empty slot from the operands


def cut_metro_wells(objs, wells=None):
    """Open the metro stairwells (gz_metro) through surfaces laid on the pavement besides the slab: lawns, footway
    ribbons, steps (or cut `wells` [(ring, z0, z1)] instead). Exact solver, hole tolerant: these are open or
    self-overlapping meshes."""
    if wells is None:
        wells = [(ring, z0, z1) for ring, z0, z1, kind in gz_metro.ground_cutters() if kind == 'well']
    if not wells:
        return
    col = bpy.data.collections.new('_metro wells')
    bpy.context.scene.collection.children.link(col)
    for i, (ring, z0, z1) in enumerate(wells):
        _prism_object('metro well %d' % i, [(ring, [])], z0, z1, col)
    for o in objs:
        n = len(o.data.polygons)
        mats = list(o.data.materials)
        mod = o.modifiers.new('metro wells', 'BOOLEAN')
        mod.operation = 'DIFFERENCE'; mod.operand_type = 'COLLECTION'; mod.collection = col
        mod.solver = 'EXACT'; mod.use_hole_tolerant = True
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        old = o.data
        o.modifiers.clear(); o.data = me; me.name = old.name
        bpy.data.meshes.remove(old)
        me.materials.clear()
        for m in mats:
            me.materials.append(m)
        log('metro wells through %s: %d -> %d faces' % (o.name, n, len(me.polygons)))
    for ob in list(col.objects):
        me = ob.data
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    bpy.data.collections.remove(col)


def water_polys():
    """[(kind, outer, holes)] -- kind 'river' or 'pond' -- clipped a little beyond the map edge."""
    x0, y0, x1, y1 = bounds()
    out = []
    for w in data()['water']:
        cp = _clip_poly(w['outer'], w['holes'], (x0 - 3, y0 - 3, x1 + 3, y1 + 3), 1.0)
        if not cp:
            continue
        kind = 'river' if abs(c.ring_area(w['outer'])) >= RIVER_MIN_AREA else 'pond'
        out.append((kind, cp[0], cp[1]))
    return out


def carriageways():
    """At-grade drivable road pieces [(road, pts)], clipped to the map. The low ends of bridge ramps (deck
    below 0.4 m) sit inside the kerb-high ground too, so they are included."""
    d = data()
    bridges = bridge_profile(d['roads'])
    out = []
    for r in d['roads']:
        if not r['drive'] or r['tunnel'] or r['area']:
            continue
        if r['id'] in bridges and max(bridges[r['id']][1]) >= 0.5:
            run = []
            for p, z in zip(*bridges[r['id']]):
                run.append(p)
                if z >= 0.4:
                    if len(run) >= 2: out.append((r, run))
                    run = []
            if len(run) >= 2: out.append((r, run))
            continue
        for run in clip_polyline(clean_line(r['pts']), bounds()):
            out.append((r, run))
    return out


def _segments_cross(a, b, c_, d):
    def orient(p, q, r_):
        return (q[0] - p[0]) * (r_[1] - p[1]) - (q[1] - p[1]) * (r_[0] - p[0])
    o1, o2, o3, o4 = orient(a, b, c_), orient(a, b, d), orient(c_, d, a), orient(c_, d, b)
    return (o1 > 0) != (o2 > 0) and (o3 > 0) != (o4 > 0) and abs(o1) > 1e-9 and abs(o2) > 1e-9


def _simple(ring):
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if _segments_cross(a, b, ring[j], ring[(j + 1) % n]):
                return False
    return True


def road_outlines(pts, w, depth=0):
    """Outline polygons (CCW) of a road ribbon; a mitred outline that folds over itself at a sharp bend is
    split there and each half outlined on its own (the halves overlap, the Boolean unions them)."""
    L, R = ribbon_xy(pts, w)
    ring = c.clean_ring([(p.x, p.y) for p in L] + [(p.x, p.y) for p in reversed(R)])
    if not ring:
        return []
    if _simple(ring):
        return [ring if c.ring_area(ring) > 0 else ring[::-1]]
    if len(pts) <= 2 or depth > 12:
        return []
    k = len(pts) // 2
    return road_outlines(pts[:k + 1], w, depth + 1) + road_outlines(pts[k:], w, depth + 1)


def _hull(points):
    pts = sorted(set((round(p[0], 3), round(p[1], 3)) for p in points))
    if len(pts) < 3:
        return None
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0: hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def junction_pads(runs):
    """Convex asphalt pads over junctions: the corners between meeting carriageways get filled (chamfered)
    instead of leaving the notches two overlapping straight ribbons would."""
    occ = {}
    for ri, (r, pts) in enumerate(runs):
        for j, p in enumerate(pts):
            occ.setdefault(key(p), []).append((ri, j))
    pads = []
    for k, lst in occ.items():
        n_ends = sum(1 if j in (0, len(runs[ri][1]) - 1) else 2 for ri, j in lst)
        if n_ends < 3:
            continue
        wmax = max(runs[ri][0]['w'] for ri, j in lst)
        reach = wmax / 2 + 3.0
        hull = []
        for ri, j in lst:
            r, pts = runs[ri]
            hw = r['w'] / 2
            for step in (1, -1):
                if not 0 <= j + step < len(pts):
                    continue
                # walk `reach` metres away from the junction along this road
                acc, i, P = 0.0, j, Vector(pts[j])
                while 0 <= i + step < len(pts):
                    Q = Vector(pts[i + step]); seg = (Q - P).length
                    if acc + seg >= reach:
                        P = P + (Q - P) * ((reach - acc) / max(seg, 1e-9)); break
                    acc += seg; P = Q; i += step
                t = (P - Vector(pts[j])).normalized()
                nrm = Vector((-t.y, t.x))
                for base in (Vector(pts[j]), P):
                    hull += [tuple(base + nrm * hw), tuple(base - nrm * hw)]
        ring = _hull(hull)
        if ring:
            pads.append(ring)
    return pads


_CARRIAGE = None


def on_carriageway(x, y, margin=0.2):
    """True if (x, y) lies on an at-grade drivable road surface (segment grid, 25 m cells)."""
    global _CARRIAGE
    if _CARRIAGE is None:
        _CARRIAGE = {}
        for r, pts in carriageways():
            hw = r['w'] / 2
            for a, b in zip(pts, pts[1:]):
                for gx in range(int(math.floor((min(a[0], b[0]) - hw) / 25)), int(math.floor((max(a[0], b[0]) + hw) / 25)) + 1):
                    for gy in range(int(math.floor((min(a[1], b[1]) - hw) / 25)), int(math.floor((max(a[1], b[1]) + hw) / 25)) + 1):
                        _CARRIAGE.setdefault((gx, gy), []).append((a, b, hw))
    for a, b, hw in _CARRIAGE.get((int(math.floor(x / 25)), int(math.floor(y / 25))), ()):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / L2))
        if math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) < hw - margin:
            return True
    return False


def road_cutters(col):
    """One closed prism per carriageway outline / junction pad, z 0..1: cutting them from the ground slab
    leaves channels whose floor is the road bed and whose walls are the kerbs."""
    runs = carriageways()
    n = 0
    for r, pts in runs:
        for ring in road_outlines(pts, r['w'] + 0.2):
            _prism_object('road cutter %d' % n, [(ring, [])], 0.0, 1.0, col); n += 1
    pads = junction_pads(runs)
    for ring in pads:
        _prism_object('junction cutter %d' % n, [(ring, [])], 0.0, 1.0, col); n += 1
    log('road cutters: %d (%d junction pads)' % (n, len(pads)))
    return n


def build_ground():
    x0, y0, x1, y1 = bounds()
    col = c.collection('10 • Ground and river')
    M = gm.ground_mats()
    wp = water_polys()
    cut_col = bpy.data.collections.new('_ground cutters')
    bpy.context.scene.collection.children.link(cut_col)
    for i, (kind, o, hs) in enumerate(wp):
        z0 = RIVER_CUT if kind == 'river' else POND_CUT
        _prism_object('cutter %d' % i, [(o, hs)], z0, 3.0, cut_col)
    road_cutters(cut_col)
    # metro entrances: the open stairwell under each pavilion, and the stair tunnel + hall under a lid of pavement
    mc = gz_metro.ground_cutters()
    for i, (ring, z0, z1, kind) in enumerate(mc):
        _prism_object('metro cutter %d' % i, [(ring, [])], z0, z1, cut_col)
    log('metro cutters: %d' % len(mc))
    import gz_apm
    ac = gz_apm.ground_cutters()
    for i, (ring, z0, z1) in enumerate(ac):
        _prism_object('apm cutter %d' % i, [(ring, [])], z0, z1, cut_col)
    log('APM cutters: %d (stations, passages, tunnels)' % len(ac))
    import gz_huacheng
    for i, (ring, z0, z1) in enumerate(gz_huacheng.ground_cutters()):
        _prism_object('huacheng cutter %d' % i, [(ring, [])], z0, z1, cut_col)
    # ground slab at kerb height: paving on top; the cut leaves road channels (floor z = 0, kerb walls),
    # quay walls and the river bed
    rect = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    slab = _prism_object('Ground | paving + kerbs + embankments', [(rect, [])], -10.0, KERB, col)
    t = time.time(); _apply_boolean(slab, cut_col, solver='MANIFOLD'); log('ground boolean %.1fs' % (time.time() - t))
    me = slab.data
    for m in (M['paving'], M['quay'], M['road_bed'], M['kerb']):
        me.materials.append(m)
    idx = []
    for p in me.polygons:
        z, nz = p.center.z, p.normal.z
        if nz > 0.7 and z > KERB - 0.05: idx.append(0)
        elif nz > 0.7 and abs(z) < 0.05: idx.append(2)
        elif abs(nz) < 0.3 and -0.02 < z < KERB + 0.02: idx.append(3)
        else: idx.append(1)
    me.polygons.foreach_set('material_index', idx)
    me.polygons.foreach_set('use_smooth', [False] * len(me.polygons))
    _planar_uv(me)
    log('ground: %d faces (%d road bed, %d kerb)' % (len(idx), idx.count(2), idx.count(3)))
    # water: one plane for the river (only visible through the cut), filled polygons for ponds
    bm = bmesh.new()
    # (with a hole under every metro entrance: the plane would otherwise show through the stairwell and hall;
    # a Boolean would cap the holes, the plane is open)
    # and under 花城汇's sunken court and escalator wells: open to the sky, the plane flooded them at -2.8 m
    c.fill_polygon(bm, [(x0 - 3, y0 - 3), (x1 + 3, y0 - 3), (x1 + 3, y1 + 3), (x0 - 3, y1 + 3)],
                   gz_metro.water_holes() + gz_huacheng.water_holes(), RIVER_Z)
    c.obj_from_bmesh('Water | Pearl River', bm, M['water'], col)
    bm = bmesh.new()
    for kind, o, hs in wp:
        if kind == 'pond':
            c.fill_polygon(bm, o, hs, POND_Z)
    c.obj_from_bmesh('Water | ponds and creeks', bm, M['pond'], col)
    # lawns: thin slabs cut by the same prisms (parks wrap their lakes; roads through parks stay open)
    gcol = c.collection('11 • Green')
    for kind_z, kinds in ((KERB + 0.03, None), (KERB + 0.045, {'pitch', 'playground', 'garden'})):
        polys = []
        for g in data()['green']:
            if (kinds is None) == (g['kind'] in {'pitch', 'playground', 'garden'}):
                continue
            # Huacheng Square's south half is paved (gz_huacheng): its park polygon keeps only the north half as lawn
            cp = _clip_poly(g['outer'], g['holes'], gz_huacheng.lawn_rect(g, (x0, y0, x1, y1)), 0.0)
            if cp: polys.append(cp)
        if not polys:
            continue
        # overlapping OSM areas (a park and a grass landuse on the same lawn) would leave exactly coplanar
        # duplicate faces, which shadow each other black in Cycles: stagger each polygon by a few mm
        bm = bmesh.new()
        for i, (outer, holes) in enumerate(polys):
            c.extrude_polygon(bm, outer, holes, -0.3, kind_z + 0.004 * (i % 5), top=True, bottom=True)
        c.weld(bm)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        o = c.obj_from_bmesh('Green | lawns %s' % ('parks' if kinds is None else 'gardens + pitches'), bm, None, gcol)
        _apply_boolean(o, cut_col, solver='MANIFOLD')
        # the Manifold solver refuses the park lawns (overlapping OSM areas weld into non-manifold edges) and
        # leaves them whole; the metro stairwells must open through them all the same
        cut_metro_wells([o])
        # 花城广场's north half (gz_north) and 花城汇's north escalators (gz_mall): paved, sunken or water -- no lawn
        import gz_north, gz_mall
        cut_metro_wells([o], wells=[(ring, -1.0, 1.0) for ring in gz_north.lawn_cutters() + [gz_huacheng.rect_ring(gz_mall.WELL)]])
        o.data.materials.append(M['grass'])
        _planar_uv(o.data)
    # the square's plaza paving and the sunken court of 花城汇 (cut by the same prisms)
    gz_huacheng.build_ground(cut_col, _apply_boolean)
    for ob in list(cut_col.objects):
        me = ob.data
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    bpy.data.collections.remove(cut_col)


def _planar_uv(me):
    uv = me.uv_layers.new(name='UVMap')
    co = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    li = np.zeros(len(me.loops), int); me.loops.foreach_get('vertex_index', li)
    uv.data.foreach_set('uv', co[li][:, :2].ravel())


# ------------------------------------------------------------------ roads
_BRIDGES = None


def bridge_profile(roads):
    """Cached: see _bridge_profile."""
    global _BRIDGES
    if _BRIDGES is None:
        _BRIDGES = _bridge_profile(roads)
    return _BRIDGES


def _bridge_profile(roads):
    """Per bridge way: densified points and deck heights. Heights ramp up from every node the bridge shares with
    a ground-level road (multi-source Dijkstra over the bridge network), so chains of bridge ways rise and fall
    as one structure. River crossings aim for 13 m, flyovers 6 m per OSM layer, footbridges 5.5 m."""
    R = raster()
    ground = set()
    for r in roads:
        if not r['bridge'] and not r['tunnel']:
            ground.update(key(p) for p in r['pts'])
    dense, graph = {}, {}
    for r in roads:
        if not r['bridge'] or r['tunnel']:
            continue
        pts = densify(clean_line(r['pts']), 8.0)
        if len(pts) < 2:
            continue
        dense[r['id']] = pts
        for a, b in zip(pts, pts[1:]):
            ka, kb = key(a), key(b)
            l = math.hypot(b[0] - a[0], b[1] - a[1])
            graph.setdefault(ka, []).append((kb, l)); graph.setdefault(kb, []).append((ka, l))
    dist = {k: 0.0 for k in graph if k in ground}
    pq = [(0.0, k) for k in dist]
    heapq.heapify(pq)
    while pq:
        d0, k = heapq.heappop(pq)
        if d0 > dist.get(k, 1e18):
            continue
        for k2, l in graph[k]:
            if d0 + l < dist.get(k2, 1e18):
                dist[k2] = d0 + l; heapq.heappush(pq, (d0 + l, k2))
    zk = {}
    per = {}
    for r in roads:
        pts = dense.get(r['id'])
        if not pts:
            continue
        over_water = sum(R.at('water', *p) for p in pts) >= 2
        foot = not r['drive']
        H = (5.5 if foot else 6.0) * max(1, r['layer'])
        if over_water:
            H = max(H, 9.0 if foot else 13.0)
        ramp = H / (0.3 if foot else 0.055)
        zs = [H * c.smoothstep(0, ramp, dist.get(key(p), 1e9)) for p in pts]
        per[r['id']] = zs
        for p, z in zip(pts, zs):
            zk[key(p)] = max(zk.get(key(p), 0.0), z)
    return {i: (dense[i], [zk[key(p)] for p in dense[i]]) for i in per}


def junction_keys(roads):
    cnt = {}
    for r in roads:
        if r['drive'] and not r['tunnel']:
            pts = r['pts']
            for j, p in enumerate(pts):
                cnt[key(p)] = cnt.get(key(p), 0) + (1 if j in (0, len(pts) - 1) else 2)
    return {k for k, v in cnt.items() if v >= 3}


def _deck(bm, L, R, zs, dz, uv=None, s=None, w=0.0):
    """Road top as quads between left/right offsets at per-vertex heights.
    uv: road-space UVs, u = metres along the road (lamp pools and dashes key off it), v = metres across."""
    lv = [bm.verts.new((p.x, p.y, z + dz)) for p, z in zip(L, zs)]
    rv = [bm.verts.new((p.x, p.y, z + dz)) for p, z in zip(R, zs)]
    for i in range(len(L) - 1):
        try: f = bm.faces.new((rv[i], rv[i + 1], lv[i + 1], lv[i]))
        except ValueError: continue
        if uv:
            for lp, co in zip(f.loops, ((s[i], 0.0), (s[i + 1], 0.0), (s[i + 1], w), (s[i], w))):
                lp[uv].uv = co


def _wall(bm, P, zb, zt, flip=False):
    """Vertical ribbon along points P (2D) between per-vertex heights zb..zt."""
    lo = [bm.verts.new((p.x, p.y, a)) for p, a in zip(P, zb)]
    hi = [bm.verts.new((p.x, p.y, b)) for p, b in zip(P, zt)]
    for i in range(len(P) - 1):
        q = (lo[i], lo[i + 1], hi[i + 1], hi[i])
        try: bm.faces.new(q[::-1] if flip else q)
        except ValueError: pass


def _wall_runs(bm, P, zb, zt, open_, flip=False):
    """_wall over the runs of consecutive vertices that are not open."""
    run = []
    for i in range(len(P)):
        if not open_[i]:
            run.append(i)
        if open_[i] or i == len(P) - 1:
            if len(run) >= 2:
                _wall(bm, [P[k] for k in run], [zb[k] for k in run], [zt[k] for k in run], flip=flip)
            run = []


def _bridge_grid(bridges, roads):
    """Deck segments of every raised bridge way on a 25 m grid: (way id, a, b, za, zb, half width)."""
    width = {r['id']: r['w'] for r in roads}
    grid = {}
    for rid, (pts, zs) in bridges.items():
        if max(zs) < 0.5:
            continue
        hw = width[rid] / 2
        for (a, b), za, zb in zip(zip(pts, pts[1:]), zs, zs[1:]):
            for gx in range(int(math.floor((min(a[0], b[0]) - hw) / 25)), int(math.floor((max(a[0], b[0]) + hw) / 25)) + 1):
                for gy in range(int(math.floor((min(a[1], b[1]) - hw) / 25)), int(math.floor((max(a[1], b[1]) + hw) / 25)) + 1):
                    grid.setdefault((gx, gy), []).append((rid, a, b, za, zb, hw))
    return grid


def _other_deck(grid, own, p, z):
    """Is point p (at deck height z) on another bridge's deck at about the same height?"""
    for rid, a, b, za, zb, hw in grid.get((int(math.floor(p[0] / 25)), int(math.floor(p[1] / 25))), ()):
        if rid == own:
            continue
        dx, dy = b[0] - a[0], b[1] - a[1]
        L2 = dx * dx + dy * dy or 1e-9
        t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
        if math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < hw + 1.0 and abs(za + (zb - za) * t - z) < 1.5:
            return True
    return False


def _box(bm, center, dirv, length, width, z0, z1):
    d = Vector((dirv[0], dirv[1])).normalized(); n = Vector((-d.y, d.x))
    cx, cy = center
    ring = [Vector((cx, cy)) + d * sx * length / 2 + n * sy * width / 2 for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    c.extrude_polygon(bm, [(p.x, p.y) for p in ring], [], z0, z1, top=True)


def _dashes(pts, s, on, off, forbid):
    """Sub-polylines of `on` metres every `on+off`, skipping arclength ranges in forbid."""
    out = []
    total = s[-1]
    t = off / 2
    def at(u):
        for i in range(len(s) - 1):
            if s[i + 1] >= u:
                f = (u - s[i]) / max(1e-9, s[i + 1] - s[i])
                return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f)
        return pts[-1]
    while t < total:
        a, b = t, min(total, t + on)
        if not any(lo < b and a < hi for lo, hi in forbid):
            seg = [at(a)] + [pts[i] for i in range(len(s)) if a < s[i] < b] + [at(b)]
            seg = clean_line(seg)
            if len(seg) >= 2:
                out.append(seg)
        t += on + off
    return out


def build_roads():
    import gz_huacheng
    d = data()
    x0, y0, x1, y1 = bounds()
    M = gm.road_mats()
    col = c.collection('20 • Roads')
    roads = d['roads']
    bridges = bridge_profile(roads)
    junc = junction_keys(roads)
    R = raster()
    bgrid = _bridge_grid(bridges, roads)
    bms = {k: bmesh.new() for k in ('major', 'minor', 'foot', 'steps', 'bridge', 'marking', 'marking_y')}
    uvs = {k: bms[k].loops.layers.uv.new('UVMap') for k in ('major', 'minor', 'foot', 'steps')}
    lamps = {'tall': [], 'short': []}
    nb = 0
    for r in roads:
        if r['tunnel'] or r['area']:
            continue
        kind = road_kind(r)
        # millimetre stagger per way: same-class ribbons overlap at junctions, and exactly coplanar overlaps
        # shadow each other in Cycles
        dz = Z_RANK.get(r['hw'], FOOT_Z) + 0.0005 * (r['id'] % 3)
        bm = bms[kind]
        if r['id'] in bridges:
            pts, zs = bridges[r['id']]
            if max(zs) < 0.5:
                zs = [0.0] * len(pts)
            else:
                if kind in ('foot', 'steps'):                   # footbridges land on the pavement, not the road
                    zs = [max(z, KERB) for z in zs]; dz = 0.008
                nb += 1
                Lr, Rr = ribbon_xy(pts, r['w'])
                _deck(bm, Lr, Rr, zs, dz, uvs[kind], arclen(pts), r['w'])
                if kind in ('major', 'minor') and r['hw'] != 'service':
                    _lamp_points(lamps, r, pts, arclen(pts), [z + dz for z in zs], [], R)
                B = bms['bridge']
                th = 0.6 if kind in ('foot', 'steps') else 1.3
                par = 1.1 if kind in ('foot', 'steps') else 0.9
                Lo, Ro = ribbon_xy(pts, r['w'] + 0.6)
                zb = [z - th for z in zs]
                zt = [z + dz for z in zs]
                zp = [z + dz + par for z in zs]
                _deck(B, Ro, Lo, [z - th for z in zs], 0.0)          # soffit (faces down)
                _wall(B, Lo, zb, zt, flip=True)                        # deck edges, below the driving surface
                _wall(B, Ro, zb, zt)
                # parapets, except where this deck merges into / splits from another one (slip roads) and
                # at the foot of a ramp: there a car must be able to drive across the edge
                for Pe, Pi, side in ((Lo, Lr, 1), (Ro, Rr, -1)):
                    open_ = [z < 0.6 or _other_deck(bgrid, r['id'], (p.x, p.y), z) for p, z in zip(Pi, zs)]
                    _wall_runs(B, Pe, zt, zp, open_, flip=side > 0)
                    _wall_runs(B, Pi, zt, zp, open_, flip=side < 0)
                s = arclen(pts)
                nxt = 12.0
                for i in range(1, len(pts) - 1):
                    if s[i] >= nxt and zs[i] > 3.5:
                        wet = R.at('water', *pts[i])
                        dv = (pts[i + 1][0] - pts[i - 1][0], pts[i + 1][1] - pts[i - 1][1])
                        _box(B, pts[i], dv, 1.8 if kind not in ('foot', 'steps') else 0.8,
                             max(1.0, r['w'] * 0.55), RIVER_CUT if wet else -0.2, zs[i] - th + 0.05)
                        nxt = s[i] + (42.0 if wet else 32.0)
                continue
        if kind in ('foot', 'steps') and sum(gz_huacheng.in_south(*p) for p in r['pts']) * 2 > len(r['pts']):
            continue          # Huacheng Square's paved half: the paths are its granite (still walkways for the crowd);
                              # OSM's steps there are the court's own stair, modelled -- drawn flat they floated across it
        for run in clip_polyline(clean_line(r['pts']), (x0, y0, x1, y1)):
            if len(run) < 2:
                continue
            srun = arclen(run)
            if kind in ('foot', 'steps'):
                # footways run on the pavement; where one crosses a carriageway it drops under the road surface
                run = densify(run, 3.0); srun = arclen(run)
                zrun = [0.0105 - FOOT_Z if on_carriageway(*p) else 0.0 for p in run]
            else:
                zrun = [0.0] * len(run)
            Lr, Rr = ribbon_xy(run, r['w'])
            _deck(bm, Lr, Rr, zrun, dz, uvs[kind], srun, r['w'])
            if kind in ('major', 'minor') and r['hw'] != 'service' and srun[-1] > 20:
                jf = [(srun[i] - 12, srun[i] + 12) for i, p in enumerate(run) if key(p) in junc]
                _lamp_points(lamps, r, run, srun, [KERB] * len(run), jf, R)
            # markings on at-grade drivable roads: yellow double centre line on two-way roads,
            # white dashed lane lines on one-way carriageways; stop 14 m short of junctions
            if kind == 'major' or (kind == 'minor' and r['w'] >= 9 and r['hw'] != 'service'):
                s = arclen(run)
                if s[-1] < 30:
                    continue
                forbid = [(s[i] - 14, s[i] + 14) for i, p in enumerate(run) if key(p) in junc or i in (0, len(run) - 1)]
                zmk = dz + 0.004
                if not r['oneway'] and r['w'] >= 9:
                    for seg in _keep_ranges(run, s, forbid):
                        for off in (0.15, -0.15):
                            ol, orr = ribbon_xy(seg, 0.3)
                            line = [(v.x, v.y) for v in (ol if off > 0 else orr)]
                            ma, mb = ribbon_xy(line, 0.15)
                            _deck(bms['marking_y'], ma, mb, [0.0] * len(ma), zmk)
                else:
                    lanes = int(r['lanes'] or max(1, round(r['w'] / 3.5)))
                    lw = r['w'] / max(1, lanes)
                    for li in range(1, lanes):
                        off = -r['w'] / 2 + li * lw
                        if abs(off) < 0.05:
                            line = list(run)
                        else:
                            ol, orr = ribbon_xy(run, abs(off) * 2)
                            line = [(v.x, v.y) for v in (ol if off > 0 else orr)]
                        for seg in _dashes(line, arclen(line), 6.0, 9.0, forbid):
                            ma, mb = ribbon_xy(seg, 0.15)
                            _deck(bms['marking'], ma, mb, [0.0] * len(ma), zmk)
    mats = {'major': M['major'], 'minor': M['minor'], 'foot': M['foot'], 'steps': M['steps'], 'bridge': M['bridge'],
            'marking': M['marking'], 'marking_y': gm.plain('GZ Road | marking yellow', (0.60, 0.42, 0.06), 0.6)}
    names = {'major': 'Roads | arterial asphalt', 'minor': 'Roads | local asphalt', 'foot': 'Roads | footways',
             'steps': 'Roads | steps', 'bridge': 'Roads | bridge structure', 'marking': 'Roads | lane lines',
             'marking_y': 'Roads | centre lines'}
    laid = []
    for k, bm in bms.items():
        o = c.obj_from_bmesh(names[k], bm, mats[k], col)
        if k not in uvs:
            _planar_uv(o.data)
        if k in ('foot', 'steps', 'minor'):
            laid.append(o)
    cut_metro_wells(laid)
    lcol = c.collection('21 • Street lamps')
    protos = lamp_protos()
    for kind, lst in lamps.items():
        if lst:
            instancer('Street lamps | %s' % kind, protos[kind], [p for p, r_ in lst], [1.0] * len(lst), [r_ for p, r_ in lst], lcol)
    # Huacheng Square's lamp masts (gz_huacheng)
    import gz_huacheng
    R_ = raster()
    masts = gz_huacheng.lamps(lambda x, y: not (R_.at('bld', x, y) or R_.at('water', x, y) or on_carriageway(x, y, 0.5) or gz_metro.blocked(x, y, 2.0)))
    if masts:
        instancer('Street lamps | mast', gz_huacheng.lamp_proto(), [(x, y, z) for x, y, z, r_ in masts], [1.0] * len(masts), [r_ for x, y, z, r_ in masts], lcol)
    log('roads: %d bridges, lamps %s' % (nb, {k: len(v) for k, v in lamps.items()}))


LAMP_SP = 30.0   # lamp spacing along a road; the road shader's night pools use the same spacing and phase


def _lamp_points(lamps, r, pts, s, zs, forbid, R):
    """Lamp posts at u = LAMP_SP * (k + 0.5) along the road -- both kerbs on wide roads, alternating on narrow
    ones -- arm pointing over the carriageway; none within 12 m of a junction or inside a building/water."""
    kind = 'tall' if road_kind(r) == 'major' else 'short'
    both = r['w'] >= 10
    k = 0
    while LAMP_SP * (k + 0.5) < s[-1]:
        u = LAMP_SP * (k + 0.5)
        k += 1
        if any(lo < u < hi for lo, hi in forbid):
            continue
        i = next(j for j in range(len(s) - 1) if s[j + 1] >= u)
        f = (u - s[i]) / max(1e-9, s[i + 1] - s[i])
        ax, ay = pts[i]; bx, by = pts[i + 1]
        px, py = ax + (bx - ax) * f, ay + (by - ay) * f
        z = zs[i] + (zs[i + 1] - zs[i]) * f
        ln = math.hypot(bx - ax, by - ay) or 1
        nx_, ny_ = -(by - ay) / ln, (bx - ax) / ln
        for side in ((1, -1) if both else ((1,) if k % 2 else (-1,))):
            off = r['w'] / 2 + (0.3 if z > 0.5 else 0.9)
            lx, ly = px + nx_ * off * side, py + ny_ * off * side
            if z < 0.5 and (R.at('bld', lx, ly) or R.at('water', lx, ly) or gz_metro.blocked(lx, ly, 0.5)):
                continue
            lamps[kind].append(((lx, ly, z), math.atan2(-ny_ * side, -nx_ * side)))


def lamp_protos():
    """Street lamps: tall double-height arterial lamp (11 m, 2.2 m arm) and a local-road lamp (7.5 m)."""
    col = bpy.data.collections.get('_protos') or c.collection('_protos')
    pole = gm.plain('GZ Street | lamp pole', (0.16, 0.17, 0.18), 0.45, 0.6)
    head = gm.emissive('GZ Street | lamp head', (1.0, 0.80, 0.55), 60.0)
    out = {}
    for name, h, arm in (('tall', 11.0, 2.2), ('short', 7.5, 1.3)):
        bm = bmesh.new()
        _cyl(bm, (0, 0, 0), (0, 0, h), 0.13, 0.08, 8)
        _cyl(bm, (0, 0, h - 0.5), (arm, 0, h - 0.1), 0.06, 0.05, 6)
        n = len(bm.faces)
        c.extrude_polygon(bm, [(arm - 0.1, -0.18), (arm + 0.8, -0.18), (arm + 0.8, 0.18), (arm - 0.1, 0.18)], [], h - 0.28, h - 0.1, bottom=True)
        for i, f in enumerate(bm.faces):
            f.material_index = 0 if i < n else 1
        out[name] = c.obj_from_bmesh('Lamp proto | %s' % name, bm, [pole, head], col)
    lc = bpy.context.view_layer.layer_collection.children.get('_protos')
    if lc: lc.exclude = True
    return out


def _keep_ranges(pts, s, forbid):
    """Continuous sub-polylines outside the forbidden arclength ranges (at least 4 m long)."""
    total = s[-1]
    keep, u = [], 0.0
    for lo, hi in sorted(forbid):
        if lo > u: keep.append((u, min(lo, total)))
        u = max(u, hi)
    if u < total: keep.append((u, total))
    out = [_sub(pts, s, a, b) for a, b in keep if b - a >= 4]
    return [o for o in out if len(o) >= 2]


def _sub(pts, s, a, b):
    def at(u):
        for i in range(len(s) - 1):
            if s[i + 1] >= u:
                f = (u - s[i]) / max(1e-9, s[i + 1] - s[i])
                return (pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f)
        return pts[-1]
    return clean_line([at(a)] + [pts[i] for i in range(len(s)) if a < s[i] < b] + [at(b)])


# ------------------------------------------------------------------ buildings
CIVIC = {'school', 'university', 'college', 'hospital', 'public', 'civic', 'government', 'public_building',
         'kindergarten', 'train_station', 'transportation', 'trn'}
INDUSTRIAL = {'industrial', 'warehouse', 'garage', 'parking', 'service', 'roof', 'hut', 'construction', 'kiosk'}
RESI = {'apartments', 'residential', 'dormitory', 'house', 'detached'}
OFFICE = {'office', 'commercial', 'hotel', 'retail', 'supermarket'}


def family(b):
    k, h, a, i = b['kind'], b['h'], b['area'], b['id']
    r = c.hash01(i, 7)
    if k in CIVIC: return 'civic'
    if k in INDUSTRIAL: return 'industrial'
    if k in RESI:
        return 'village' if (h < 36 and a < 500) else 'resi'
    if k in OFFICE:
        if h >= 90: return 'glass'
        if a > 2500 and h < 40: return 'podium'
        return 'glass' if (h > 50 and r < 0.4) else 'office'
    if h >= 110: return 'glass'
    if h >= 60: return 'glass' if r < 0.55 else 'office'
    if a < 450 and h < 36: return 'village'
    if a > 2500 and h < 45: return 'podium'
    return 'resi' if r < 0.5 else 'office'


def tint_for(b, fam):
    r1, r2, r3 = c.hash01(b['id'], 1), c.hash01(b['id'], 2), c.hash01(b['id'], 3)
    v = 0.80 + 0.38 * r1
    if fam == 'glass':
        # a few families of glass: blue-grey, green, silver, bronze
        pal = [(0.95, 1.0, 1.08), (0.9, 1.06, 1.0), (1.08, 1.08, 1.08), (1.12, 1.0, 0.86)]
        t = pal[int(r2 * 4) % 4]
        return (t[0] * v, t[1] * v, t[2] * v, r3)
    warm = (r2 - 0.5) * 0.12
    return (v * (1 + warm), v, v * (1 - warm), r3)


def _signed_area(ring):
    return 0.5 * sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))


def inset_ring(ring, d):
    """Mitred inward offset of a CCW ring by d metres; None if it folds over (edges flip, area collapses)."""
    n = len(ring)
    out = []
    for i in range(n):
        a, b, cc = ring[i - 1], ring[i], ring[(i + 1) % n]
        e1 = (b[0] - a[0], b[1] - a[1]); e2 = (cc[0] - b[0], cc[1] - b[1])
        l1 = math.hypot(*e1) or 1; l2 = math.hypot(*e2) or 1
        n1 = (-e1[1] / l1, e1[0] / l1); n2 = (-e2[1] / l2, e2[0] / l2)       # inward normals of a CCW ring
        bx, by = n1[0] + n2[0], n1[1] + n2[1]
        bl = math.hypot(bx, by)
        if bl < 1e-6:
            return None
        cos_half = (bx * n1[0] + by * n1[1]) / bl
        k = d / max(cos_half, 0.35)
        out.append((b[0] + bx / bl * k, b[1] + by / bl * k))
    for i in range(n):
        o0, o1 = ring[i], ring[(i + 1) % n]
        i0, i1 = out[i], out[(i + 1) % n]
        if (o1[0] - o0[0]) * (i1[0] - i0[0]) + (o1[1] - o0[1]) * (i1[1] - i0[1]) <= 0:
            return None
    if _signed_area(out) < 0.35 * _signed_area(ring):
        return None
    return out


def building_masses(b, fam):
    """The prisms one OSM building is built from, shared by the Blender build and buildings.json (the web's
    near facade detail must sit on exactly these): [(ring CCW, z0, z1, family)].

    Zhujiang New Town typology (from photographs): office towers over 80 m mostly stand on a 4-6 storey podium
    and end in a crown -- stepped setbacks, a lit screen crown of vertical fins, or a plant box and mast;
    residential towers carry a light roof frame. Families 'crown', 'resi_crown' and 'mast' are dressing (no
    near detail)."""
    outer = c.clean_ring(b['outer'])
    if not outer:
        return []
    if _signed_area(outer) < 0:
        outer = outer[::-1]
    z0 = b['minh'] if b['part'] else 0.0
    z1 = max(z0 + 2.5, b['h'])
    h = z1 - z0
    i = b['id']
    xs = [p[0] for p in outer]; ys = [p[1] for p in outer]
    mind = min(max(xs) - min(xs), max(ys) - min(ys))
    if fam == 'glass' and h > 80 and not b['part'] and b['area'] > 600 and len(outer) <= 24:
        out = []
        shaft, top = outer, z1
        if c.hash01(i, 31) > 0.3 and b['area'] > 1500:
            ins = inset_ring(outer, max(2.5, min(7.0, 0.1 * mind)))
            if ins:
                ph = round(16 + 8 * c.hash01(i, 32))
                out.append((outer, z0, z0 + ph, 'podium'))
                shaft, z0 = ins, z0 + ph
        kind = c.hash01(i, 33)
        if kind < 0.4:                                      # stepped setbacks
            steps = 2 + int(c.hash01(i, 34) * 2)
            sh = h * 0.045
            body_top = top - steps * sh
            out.append((shaft, z0, body_top, 'glass'))
            ring, zz = shaft, body_top
            for k in range(steps):
                nxt = inset_ring(ring, 2.2 + 1.2 * c.hash01(i, 35 + k))
                if not nxt:
                    break
                out.append((nxt, zz, zz + sh, 'glass'))
                ring, zz = nxt, zz + sh
        elif kind < 0.75:                                   # lit screen crown of fins
            out.append((shaft, z0, top, 'glass'))
            out.append((shaft, top, top + 8 + 8 * c.hash01(i, 36), 'crown'))
        else:                                               # plant box and mast
            out.append((shaft, z0, top, 'glass'))
            box = inset_ring(shaft, max(3.0, 0.18 * mind))
            if box:
                out.append((box, top, top + 7, 'office'))
                if h > 180:
                    cx, cy = centroid(box)
                    out.append(([(cx - 1, cy - 1), (cx + 1, cy - 1), (cx + 1, cy + 1), (cx - 1, cy + 1)], top + 7, top + 7 + 0.12 * h, 'mast'))
        return out
    if fam == 'resi' and h > 45 and not b['part']:
        return [(outer, z0, z1, fam), (outer, z1, z1 + 3.5 + 2 * c.hash01(i, 37), 'resi_crown')]
    return [(outer, z0, z1, fam)]


def build_buildings():
    d = data()
    x0, y0, x1, y1 = bounds()
    col = c.collection('30 • Buildings')
    FM = gm.building_mats()
    roofmat = gm.plain('GZ Roof | concrete + plant', (0.36, 0.36, 0.35), 0.85, noise=(0.3, (0.27, 0.27, 0.26), 0.6))
    blds = [b for b in d['buildings'] if not b['landmark'] and x0 <= centroid(b['outer'])[0] <= x1 and y0 <= centroid(b['outer'])[1] <= y1]
    # an outline that contains building:parts is replaced by its parts (Simple 3D Buildings rule)
    parts = [b for b in blds if b['part']]
    skip = set()
    for b in blds:
        if b['part']:
            continue
        xs = [p[0] for p in b['outer']]; ys = [p[1] for p in b['outer']]
        for p in parts:
            cx, cy = centroid(p['outer'])
            if min(xs) <= cx <= max(xs) and min(ys) <= cy <= max(ys) and point_in((cx, cy), b['outer']):
                skip.add(b['id']); break
    buckets = {}
    def bucket(name, cx, cy):
        tk = (int((cx - x0) // TILE), int((cy - y0) // TILE))
        k = (name, tk)
        if k not in buckets:
            bm = bmesh.new()
            buckets[k] = (bm, bm.loops.layers.uv.new('UVMap'), bm.loops.layers.float_color.new('tint'))
        return buckets[k]
    import lm_towers                      # named towers modelled from photographs (imported late: it uses landmarks)
    n = 0
    fams = {}
    for b in blds:
        if b['id'] in skip:
            continue
        outer = c.clean_ring(b['outer'])
        if not outer:
            continue
        if lm_towers.handles(b):
            lm_towers.build(b, col)
            n += 1
            continue
        holes = [h for h in (c.clean_ring(h) for h in b['holes']) if h]
        fam = family(b)
        fams[fam] = fams.get(fam, 0) + 1
        cx, cy = centroid(outer)
        tint = tint_for(b, fam)
        masses = building_masses(b, fam)
        simple = len(masses) == 1
        for k, (ring, z0, z1, mf) in enumerate(masses):
            bm, uv, tl = bucket(mf, cx, cy)
            # courtyard holes only on single-prism buildings; dressing (crowns, masts) has no roof of its own
            cap = mf not in ('crown', 'resi_crown')
            c.extrude_polygon(bm, ring, holes if simple else [], z0, z1, top=cap, bottom=z0 > 0.5 and k == 0,
                              uv=uv, tint=(tl, tint))
        # parapet + rooftop plant on the main roof
        top_ring, _, z_top, top_f = max((m for m in masses if m[3] not in ('crown', 'resi_crown', 'mast')), key=lambda m: m[2])
        if z_top > 12 and b['area'] > 150:
            rb, ruv, rtl = bucket('roof', cx, cy)
            ph = 3.5 if top_f == 'glass' and z_top > 100 else 1.1
            c.extrude_polygon(rb, top_ring, [], z_top, z_top + ph, top=False, uv=ruv, tint=(rtl, (1, 1, 1, 0)))
            if simple:
                _roof_plant(rb, ruv, rtl, b, outer, z_top)
        n += 1
    for (name, tk), (bm, uv, tl) in sorted(buckets.items()):
        mat = roofmat if name == 'roof' else FM[name]
        c.obj_from_bmesh('Bldg | %s %d_%d' % (name, tk[0], tk[1]), bm, mat, col)
    log('buildings: %d built, %d outlines replaced by parts, families %s' % (n, len(skip), fams))


def _roof_plant(bm, uv, tl, b, outer, z):
    """1-4 rooftop boxes (AC plant, stair cores, water tanks) inside the footprint."""
    xs = [p[0] for p in outer]; ys = [p[1] for p in outer]
    k = 1 + int(c.hash01(b['id'], 11) * min(4, b['area'] / 400))
    for j in range(k):
        for attempt in range(6):
            hx = min(xs) + (max(xs) - min(xs)) * c.hash01(b['id'], 20 + j * 7 + attempt)
            hy = min(ys) + (max(ys) - min(ys)) * c.hash01(b['id'], 21 + j * 7 + attempt)
            sx = 2.5 + 6 * c.hash01(b['id'], 22 + j); sy = 2.5 + 5 * c.hash01(b['id'], 23 + j)
            corners = [(hx - sx / 2, hy - sy / 2), (hx + sx / 2, hy - sy / 2), (hx + sx / 2, hy + sy / 2), (hx - sx / 2, hy + sy / 2)]
            if all(point_in(p, outer) for p in corners):
                h = 1.8 + 3.5 * c.hash01(b['id'], 24 + j)
                c.extrude_polygon(bm, corners, [], z, z + h, uv=uv, tint=(tl, (1, 1, 1, 0)))
                break


# ------------------------------------------------------------------ trees
def _ico(bm, center, r, sz=(1, 1, 1), subdiv=2, seed=0):
    res = bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=r)
    for v in res['verts']:
        j = 1 + 0.18 * (c.hash01(int(abs(v.co.x * 997 + v.co.y * 131 + v.co.z * 17)) + seed, 5) - 0.5)
        v.co = Vector((v.co.x * sz[0] * j + center[0], v.co.y * sz[1] * j + center[1], v.co.z * sz[2] * j + center[2]))
    return res['verts']


def _cyl(bm, p0, p1, r0, r1, seg=7):
    p0, p1 = Vector(p0), Vector(p1)
    ax = (p1 - p0).normalized()
    t = ax.orthogonal().normalized(); u = ax.cross(t)
    lo, hi = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        dv = t * math.cos(a) + u * math.sin(a)
        lo.append(bm.verts.new(p0 + dv * r0)); hi.append(bm.verts.new(p1 + dv * r1))
    for i in range(seg):
        j = (i + 1) % seg
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(hi)


def tree_protos():
    col = c.collection('_protos')
    M = gm.tree_mats()
    protos = {}
    # banyan / Chinese banyan (Ficus microcarpa): short trunk, broad dense crown ~10 m
    bm = bmesh.new()
    _cyl(bm, (0, 0, 0), (0, 0, 3.4), 0.42, 0.3)
    _cyl(bm, (0, 0, 2.8), (1.6, 0.6, 4.6), 0.18, 0.1, 5); _cyl(bm, (0, 0, 2.8), (-1.3, -1.0, 4.4), 0.18, 0.1, 5)
    trunk_faces = len(bm.faces)
    for i, (x, y, z, r) in enumerate([(0, 0, 6.2, 3.4), (2.2, 0.8, 5.4, 2.6), (-2.0, -0.9, 5.3, 2.7), (0.6, -2.1, 5.6, 2.4),
                                      (-0.8, 2.0, 5.5, 2.5), (0.3, 0.2, 7.6, 2.3)]):
        _ico(bm, (x, y, z), r, (1, 1, 0.72), 2, i * 13)
    protos['banyan'] = _proto('Tree proto | banyan', bm, trunk_faces, M['bark'], M['banyan'], col)
    # kapok (Bombax ceiba, Guangzhou's city flower): tall straight trunk, whorled branches, open irregular crown
    bm = bmesh.new()
    _cyl(bm, (0, 0, 0), (0, 0, 14.5), 0.5, 0.16)
    for zz, L in ((8.0, 3.2), (10.6, 2.6), (12.8, 1.8)):
        for k in range(3):
            a = k * 2.094 + zz
            _cyl(bm, (0, 0, zz), (math.cos(a) * L, math.sin(a) * L, zz + 1.4), 0.15, 0.06, 5)
    trunk_faces = len(bm.faces)
    for i, (x, y, zz, rr) in enumerate(((2.6, 0.6, 9.8, 2.1), (-1.6, 2.2, 10.4, 2.0), (-1.4, -2.3, 10.0, 2.2),
                                        (1.2, -1.4, 12.2, 1.9), (-0.9, 0.9, 12.9, 2.0), (0.3, 0.1, 14.6, 1.7))):
        _ico(bm, (x, y, zz), rr, (1.15, 1.15, 0.62), 2, i * 7)
    protos['kapok'] = _proto('Tree proto | kapok', bm, trunk_faces, M['bark'], M['kapok'], col)
    # royal palm (Roystonea regia): smooth grey column, green crownshaft, arching fronds
    bm = bmesh.new()
    _cyl(bm, (0, 0, 0), (0, 0, 6), 0.34, 0.40, 9); _cyl(bm, (0, 0, 6), (0, 0, 12.5), 0.40, 0.28, 9)
    trunk_faces = len(bm.faces)
    _cyl(bm, (0, 0, 12.5), (0, 0, 15.2), 0.30, 0.22, 9)
    for k in range(13):
        az = k * 2.39996; el = math.radians(55 - (k % 5) * 22)
        base = Vector((0, 0, 15.0))
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        side = Vector((-math.sin(az), math.cos(az), 0))
        prev = None
        for sgi in range(5):
            t = sgi / 4
            p = base + d * (4.6 * t) + Vector((0, 0, -2.2 * t * t))
            w = 0.9 * math.sin(math.pi * min(0.95, t * 0.9 + 0.1))
            a = bm.verts.new(p + side * w); b_ = bm.verts.new(p - side * w)
            if prev: bm.faces.new((prev[0], prev[1], b_, a))
            prev = (a, b_)
    protos['palm'] = _proto('Tree proto | royal palm', bm, trunk_faces, M['palm_trunk'], M['palm'], col)
    bpy.context.view_layer.layer_collection.children['_protos'].exclude = True
    return protos


def _proto(name, bm, n_trunk, m_trunk, m_leaf, col, smooth_leaves=True):
    for i, f in enumerate(bm.faces):
        f.material_index = 0 if i < n_trunk else 1
    o = c.obj_from_bmesh(name, bm, [m_trunk, m_leaf], col)
    me = o.data
    me.polygons.foreach_set('use_smooth', [p.material_index == 1 and smooth_leaves or p.material_index == 0 for p in me.polygons])
    return o


def scatter_ng(proto):
    name = 'GZ scatter | ' + proto.name
    ng = bpy.data.node_groups.get(name)
    if ng:
        return ng
    ng = bpy.data.node_groups.new(name, 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N, L = ng.nodes, ng.links
    gi = N.new('NodeGroupInput'); go = N.new('NodeGroupOutput')
    oi = N.new('GeometryNodeObjectInfo'); oi.inputs['Object'].default_value = proto
    sc = N.new('GeometryNodeInputNamedAttribute'); sc.data_type = 'FLOAT'; sc.inputs['Name'].default_value = 'gz_scale'
    rt = N.new('GeometryNodeInputNamedAttribute'); rt.data_type = 'FLOAT'; rt.inputs['Name'].default_value = 'gz_rot'
    cz = N.new('ShaderNodeCombineXYZ')
    L.new(rt.outputs['Attribute'], cz.inputs['Z'])
    iop = N.new('GeometryNodeInstanceOnPoints')
    L.new(gi.outputs[0], iop.inputs['Points'])
    L.new(oi.outputs['Geometry'], iop.inputs['Instance'])
    try:
        e2r = N.new('FunctionNodeEulerToRotation')
        L.new(cz.outputs[0], e2r.inputs[0]); L.new(e2r.outputs[0], iop.inputs['Rotation'])
    except RuntimeError:
        L.new(cz.outputs[0], iop.inputs['Rotation'])
    L.new(sc.outputs['Attribute'], iop.inputs['Scale'])
    L.new(iop.outputs[0], go.inputs[0])
    return ng


def instancer(name, proto, pts, scales, rots, col):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(pts))
    me.vertices.foreach_set('co', [v for p in pts for v in p])
    a = me.attributes.new('gz_scale', 'FLOAT', 'POINT'); a.data.foreach_set('value', scales)
    b = me.attributes.new('gz_rot', 'FLOAT', 'POINT'); b.data.foreach_set('value', rots)
    o = bpy.data.objects.new(name, me); col.objects.link(o)
    mod = o.modifiers.new('scatter', 'NODES'); mod.node_group = scatter_ng(proto)
    return o


def build_trees():
    import gz_huacheng
    d = data()
    R = raster()
    x0, y0, x1, y1 = bounds()
    protos = tree_protos()
    col = c.collection('40 • Trees')
    pts = {k: [] for k in protos}
    rng = np.random.default_rng(1205)
    def free(x, y, road=True):
        if not (x0 + 2 < x < x1 - 2 and y0 + 2 < y < y1 - 2):
            return False
        if R.at('bld_d', x, y) or R.at('water', x, y) or gz_metro.blocked(x, y, 1.2):
            return False
        return not (road and R.at('road_d', x, y))
    def add(kind, x, y, z, s):
        pts[kind].append(((x, y, z), s, float(rng.uniform(0, 6.283))))
    # street trees along arterials and collectors, both kerbs
    nst = 0
    for r in d['roads']:
        if r['tunnel'] or r['bridge'] or r['hw'] not in ('trunk', 'primary', 'secondary', 'tertiary', 'unclassified'):
            continue
        pl = clean_line(r['pts'])
        if len(pl) < 2:
            continue
        s = arclen(pl)
        step = 9.0 if r['hw'] != 'unclassified' else 12.0
        for side in (1, -1):
            u = float(rng.uniform(0, step))
            while u < s[-1]:
                i = next(j for j in range(len(s) - 1) if s[j + 1] >= u)
                f = (u - s[i]) / max(1e-9, s[i + 1] - s[i])
                ax, ay = pl[i]; bx, by = pl[i + 1]
                px, py = ax + (bx - ax) * f, ay + (by - ay) * f
                ln = math.hypot(bx - ax, by - ay) or 1
                nx_, ny_ = -(by - ay) / ln, (bx - ax) / ln
                off = r['w'] / 2 + 2.3
                tx, ty = px + nx_ * off * side, py + ny_ * off * side
                if free(tx, ty):
                    kind = 'kapok' if (r['hw'] in ('trunk', 'primary') and c.hash01(r['id'], 3) < 0.35) else 'banyan'
                    add(kind, tx, ty, KERB, float(rng.uniform(0.75, 1.1)))
                    nst += 1
                u += step * float(rng.uniform(0.85, 1.15))
    import gz_north
    # park trees: clumped (low-frequency field decides where groves and lawns are)
    npk = 0
    for g in d['green']:
        if g['kind'] not in ('park', 'garden', 'recreation_ground'):
            continue
        xs = [p[0] for p in g['outer']]; ys = [p[1] for p in g['outer']]
        a = abs(c.ring_area(g['outer']))
        for _ in range(int(a / 110)):
            x, y = float(rng.uniform(min(xs), max(xs))), float(rng.uniform(min(ys), max(ys)))
            if not R.at('green', x, y) or not free(x, y) or R.at('foot', x, y):
                continue
            field = math.sin(x * 0.021 + 1.3) * math.sin(y * 0.017 + 0.4) + 0.6 * math.sin(x * 0.047 - y * 0.039)
            if field < -0.15:
                continue
            h = float(rng.uniform())
            kind = 'banyan' if h < 0.5 else 'palm' if h < 0.78 else 'kapok'
            sc = float(rng.uniform(0.7, 1.15))
            if g['id'] == gz_huacheng.PARK and (y < gz_huacheng.NORTH or gz_north.designed(x, y)):
                rng.uniform(0, 6.283)    # the rotation add() would have drawn: every other tree in the city stays put
                continue                 # the paved south half gets designed groves instead (gz_huacheng.trees)
            add(kind, x, y, KERB + 0.03, sc)
            npk += 1
    for kind, x, y, z, s in gz_huacheng.trees(free, R):
        add(kind, x, y, z, s)
    for kind, lst in pts.items():
        if lst:
            instancer('Trees | %s' % kind, protos[kind], [p for p, s, r in lst], [s for p, s, r in lst], [r for p, s, r in lst], col)
    log('trees: %d street, %d park (%s)' % (nst, npk, {k: len(v) for k, v in pts.items()}))
