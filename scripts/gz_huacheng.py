"""Huacheng Square (花城广场) south of 花城大道, and the south court of Mall of the World (花城汇, level B1),
rebuilt against photographs (Wikimedia Commons: Category:Huacheng Square, 102 files 2012-2026; Category:Mall of the
World and its 2024 set) with the plan read off Esri World Imagery exports (2 px/m) laid over the OSM ways.

The generic build made the whole park polygon one lawn with trees scattered at random. What is there:

  promenade   south of the twin towers the axis is paved: a ~55 m band of pale granite (x -30..+25) between groves
              of fig trees -- the OSM 'grass' polygons there are lawn under a closed canopy. Across the paving runs
              a lattice of inset glass strips (pale green by day, colour-cycling LEDs at night: Surfaces 'plaza').
  between the towers  a funnel of the same paving, double rows of trees down both edges; on the axis an eye-shaped
              inlay of rings (61 x 40 m, the web draws it) and north of it the sunken court of 花城汇's south zone.
  court       32.5 x 68 m, 6 m down to the level of the APM concourse (gz_apm.CONC_Z): seating terraces in 16 rows
              with a stair down the middle from the south, then the floor (concentric rings of beige and grey stone)
              ringed on three sides by shopfronts (facade family 'mall court': lit shops, interiors, ShopLight) under
              a fascia of lit signs (the web draws them); stone coping and a glass balustrade at street level. North
              of it stands the APM 花城大道 station box -- the north wall is where the mall corridor opens (phase 2).
  canopies    two white membrane "clouds" on slender columns over escalator wells at the court's south corners.
  north half  花城大道 to 黄埔大道 (woods, the music fountain, terraced lawns) stays the generic park for now.

Hooks: gz_city.build_ground (cutters, lawn clip, the plaza overlay and the court), gz_city.build_trees (the groves
and avenues replace the random park trees here), export_web (collision proxies, huacheng.json for the web).
"""
import json
import math
import os

import bmesh
import bpy

import gz_common as c
import gz_materials as gm
import gz_mall
import gz_north

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KERB = 0.15
PARK = 243319596
NORTH = 135.0                         # 花城大道: the paved south half ends here
COURT = (-21.0, 20.0, 9.0, 88.0)     # x0, y0, x1, y1 (30 m: five 6 m shop bays across the north wall)
COURT_Z = -5.85                       # floor = APM concourse floor
TERR_Y1 = 46.0                        # terraces / stair from the south edge down to here (shops: 42 m = 7 bays a side)
STAIR = (-10.0, -2.0)                 # x range of the stair in the middle of the terraces (8 m)
ROWS = 16                             # seating terraces: 16 x 0.375 m = 6 m drop, 1.5 m deep
OVAL = (-5.5, -21.0, 30.5, 19.8)      # eye inlay: centre x, y, semi-axes
CANOPIES = [(-36.25, 12.0, 22.5, 24.0), (34.25, 11.25, 23.5, 22.5)]   # centre x, y, size x, size y
WELL = (5.6, 15.0)                    # escalator well under each canopy (across, along)
BAY = 6.0                             # shop unit width
SPAWN = (28.0, -236.0)                # Ah Jie's spawn on the promenade's east edge: kept open (his e-bike, the tests' run)
COL_NAME = '15 • Huacheng Square'


def log(*a):
    print('[huacheng]', *a, flush=True)


# ------------------------------------------------------------------ plan
def park():
    import gz_city
    return next(g for g in gz_city.data()['green'] if g['id'] == PARK)


def lawn_rect(g, rect):
    """gz_city's lawn loop: the park polygon only keeps its north half as lawn."""
    x0, y0, x1, y1 = rect
    return (x0, NORTH, x1, y1) if g['id'] == PARK else rect


def in_south(x, y):
    """inside the park polygon south of 花城大道"""
    if y >= NORTH:
        return False
    ring = park()['outer']
    inside = False
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def wells():
    """escalator wells under the canopies: (x0, y0, x1, y1), running north-south"""
    out = []
    for cx, cy, sx, sy in CANOPIES:
        w, l = WELL
        out.append((cx - w / 2, cy - l / 2, cx + w / 2, cy + l / 2))
    return out


def rect_ring(r):
    x0, y0, x1, y1 = r
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def ground_cutters():
    """[(ring, z0, z1)] the ground slab and the lawns lose: the court and the escalator wells -- 0.3 m wider
    than their walls, so the slab's own cut faces stand behind the shopfronts (coincident, they won the depth test)
    and the coping covers the gap."""
    g = lambda r, p=0.3: (r[0] - p, r[1] - p, r[2] + p, r[3] + p)
    out = [(rect_ring(g(COURT)), COURT_Z - 0.6, 3.0)]
    out += [(rect_ring(g(w)), COURT_Z - 0.6, 3.0) for w in wells()]
    return out + gz_mall.ground_cutters() + gz_north.ground_cutters()     # phase 2: 花城汇 B1; phase 3: the north court, the fountain


def water_holes():
    """Clockwise rings round the court and the wells: holes in gz_city's full-map river plane (z -2.8), which lies
    under the ground slab everywhere and showed as a flooded court through the cut."""
    g = lambda r, p=0.3: (r[0] - p, r[1] - p, r[2] + p, r[3] + p)
    return [list(reversed(rect_ring(g(r)))) for r in [COURT] + wells()] + gz_mall.water_holes() + gz_north.water_holes()


def in_oval(x, y, pad=0.0):
    cx, cy, a, b = OVAL
    return ((x - cx) / (a + pad)) ** 2 + ((y - cy) / (b + pad)) ** 2 < 1.0


def near_rect(x, y, r, pad):
    x0, y0, x1, y1 = r
    return x0 - pad < x < x1 + pad and y0 - pad < y < y1 + pad


# ------------------------------------------------------------------ trees
def trees(free, R):
    """[(kind, x, y, z, scale)]: fig groves on the OSM lawns inside the promenade, double avenues down both edges
    between the towers, a row along each side of the court. free(x, y) is gz_city's placement test."""
    import gz_city
    rng = __import__('random').Random(2012)
    out = []
    def ok(x, y, pad=2.0):
        if not free(x, y) or R.at('foot', x, y):
            return False
        if math.hypot(x - SPAWN[0], y - SPAWN[1]) < 30.0:        # the spawn's open paving
            return False
        import gz_metro
        if gz_metro.blocked(x, y, 4.5):                             # a crown must not hang over a metro stairwell
            return False
        if near_rect(x, y, COURT, 2.5) or in_oval(x, y, 3.0):
            return False
        for cx, cy, sx, sy in CANOPIES:
            if abs(x - cx) < sx / 2 + 1 and abs(y - cy) < sy / 2 + 1:
                return False
        return True
    # groves: OSM grass polygons whose centre lies in the paved south half
    groves = 0
    for g in gz_city.data()['green']:
        if g['kind'] != 'grass':
            continue
        xs = [p[0] for p in g['outer']]; ys = [p[1] for p in g['outer']]
        if not in_south((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2):
            continue
        step = 6.8
        y = min(ys) + 2.5
        row = 0
        while y < max(ys) - 2.0:
            x = min(xs) + 2.5 + (step / 2 if row % 2 else 0.0)
            while x < max(xs) - 2.0:
                px, py = x + rng.uniform(-1.4, 1.4), y + rng.uniform(-1.4, 1.4)
                if _inside(px, py, g['outer'], 1.8) and ok(px, py):
                    h = rng.random()
                    kind = 'banyan' if h < 0.8 else 'kapok' if h < 0.94 else 'palm'
                    out.append((kind, px, py, KERB + 0.03, rng.uniform(0.85, 1.2)))
                    groves += 1
                x += step
            y += step * 0.87
            row += 1
    # avenues between the towers: two rows each side of the axis, every 7 m
    av = 0
    for xs_ in ((-46.0, -38.0), (28.0, 36.0)):
        for i, x in enumerate(xs_):
            y = -96.0 + (3.5 if i else 0.0)
            while y < NORTH - 12:
                if in_south(x, y) and ok(x, y):
                    out.append(('banyan', x + rng.uniform(-0.3, 0.3), y, KERB, rng.uniform(0.9, 1.1)))
                    av += 1
                y += 7.0
    # the court's long sides, 3 m back from the balustrade
    for x in (COURT[0] - 4.0, COURT[2] + 4.0):
        y = COURT[1] + 3.0
        while y < COURT[3] - 1:
            if free(x, y):
                out.append(('banyan', x, y, KERB, rng.uniform(0.8, 0.95)))
                av += 1
            y += 7.5
    log('trees: %d in the groves, %d in avenues' % (groves, av))
    # phase 3: the north half's woods and the forecourt's planters (gz_north)
    out += gz_north.trees(free, rng, lambda x, y: _inside(x, y, park()['outer'], 2.0))
    return out


def _inside(x, y, ring, pad):
    inside = False
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[i - 1]
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    if not inside:
        return False
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[i - 1]
        ex, ey = bx - ax, by - ay
        L2 = ex * ex + ey * ey or 1.0
        t = max(0.0, min(1.0, ((x - ax) * ex + (y - ay) * ey) / L2))
        if math.hypot(x - ax - ex * t, y - ay - ey * t) < pad:
            return False
    return True


# ------------------------------------------------------------------ lamp masts
def lamp_proto():
    """The square's lamp mast (the photos: tall white masts with a slanted blade carrying a stack of floodlights):
    a tapered pole to 14 m, a sail-shaped blade leaning out from it, six flood heads stepped up the blade."""
    import gz_city
    col = bpy.data.collections.get('_protos') or c.collection('_protos')
    white = gm.plain('GZ Huacheng | mast white', (0.82, 0.83, 0.84), 0.35, 0.4)
    head = gm.emissive('GZ Huacheng | flood head', (1.0, 0.9, 0.75), 70.0)
    bm = bmesh.new()
    gz_city._cyl(bm, (0, 0, 0), (0, 0, 14.0), 0.22, 0.11, 10)
    # the blade: a thin curved plate from 8.5 m to 15.6 m, leaning out along +x
    pts = []
    for i in range(9):
        t = i / 8
        z = 8.5 + 7.1 * t
        x = 0.1 + 1.6 * t ** 1.6
        w = 0.9 * math.sin(math.pi * min(1.0, t * 1.15)) + 0.12
        pts.append((x, w, z))
    vs = [(bm.verts.new((x, -w / 2, z)), bm.verts.new((x, w / 2, z))) for x, w, z in pts]
    for (a1, b1), (a2, b2) in zip(vs, vs[1:]):
        bm.faces.new((a1, b1, b2, a2))
    n = len(bm.faces)
    for k in range(6):
        t = 0.35 + 0.1 * k
        z = 8.5 + 7.1 * t
        x = 0.1 + 1.6 * t ** 1.6 + 0.12
        c.extrude_polygon(bm, [(x, -0.22), (x + 0.36, -0.22), (x + 0.36, 0.22), (x, 0.22)], [], z - 0.2, z + 0.12, bottom=True)
    for i, f in enumerate(bm.faces):
        f.material_index = 0 if i < n else 1
    o = c.obj_from_bmesh('Lamp proto | mast', bm, [white, head], col)
    lc = bpy.context.view_layer.layer_collection.children.get('_protos')
    if lc: lc.exclude = True
    return o


def lamps(free):
    """[(x, y, z, yaw)] mast positions: both edges of the promenade every 44 m, both sides of the funnel between
    the towers every 42 m; the blades lean in over the paving."""
    out = []
    for x, yaw in ((-31.0, 0.0), (26.0, math.pi)):
        y = -528.0
        while y < -112:
            if in_south(x, y) and free(x, y) and math.hypot(x - SPAWN[0], y - SPAWN[1]) > 24.0:
                out.append((x, y, KERB, yaw))
            y += 44.0
    for x, yaw in ((-54.0, 0.0), (44.0, math.pi)):
        y = -88.0
        while y < NORTH - 14:
            if in_south(x, y) and free(x, y) and not near_rect(x, y, COURT, 4.0):
                out.append((x, y, KERB, yaw))
            y += 42.0
    out += gz_north.lamps(free)
    log('lamp masts: %d' % len(out))
    return out


# ------------------------------------------------------------------ materials
def mats():
    M = {
        'plaza': gm.plain('GZ Huacheng | plaza granite', (0.58, 0.58, 0.56), rough=0.72),
        'court': gm.plain('GZ Huacheng | court stone', (0.62, 0.58, 0.52), rough=0.6),
        'steps': gm.plain('GZ Huacheng | steps granite', (0.56, 0.55, 0.53), rough=0.75),
        'coping': gm.plain('GZ Huacheng | coping stone', (0.70, 0.64, 0.55), rough=0.6),
        'wood': gm.plain('GZ Huacheng | bench timber', (0.36, 0.22, 0.12), rough=0.55),
        'steel': gm.plain('GZ Huacheng | stainless', (0.72, 0.73, 0.74), rough=0.25, metal=0.9),
        'white': gm.plain('GZ Huacheng | white steel', (0.86, 0.87, 0.86), rough=0.4, metal=0.2),
        'dark': gm.plain('GZ Huacheng | dark metal', (0.10, 0.11, 0.12), rough=0.45, metal=0.6),
        'glass': c.mat('GZ Huacheng | balustrade glass', (0.62, 0.74, 0.76), 0.03, 0.1, alpha=0.22),
        'membrane': gm.plain('GZ Huacheng | membrane', (0.93, 0.93, 0.91), rough=0.55),
        'membrane under': gm.plain('GZ Huacheng | membrane underside', (0.90, 0.90, 0.88), rough=0.7),
        'escalator': gm.plain('GZ Huacheng | escalator', (0.22, 0.23, 0.25), rough=0.35, metal=0.7),
    }
    M['stair'] = M['steps']                 # same stone, its own object: the stair is walked by a ramp proxy
    M['frame'] = gm.plain('GZ Huacheng | shopfront aluminium', (0.16, 0.15, 0.14), rough=0.35, metal=0.8)
    M['pilaster'] = gm.plain('GZ Huacheng | pilaster stone', (0.76, 0.70, 0.60), rough=0.55)
    M['kick'] = gm.plain('GZ Huacheng | kick granite', (0.12, 0.12, 0.13), rough=0.3)
    M['signbox'] = gm.plain('GZ Huacheng | sign box', (0.08, 0.08, 0.09), rough=0.4, metal=0.5)
    M['canvas'] = gm.plain('GZ Huacheng | umbrella canvas', (0.80, 0.74, 0.62), rough=0.85)
    M['green'] = gm.plain('GZ Huacheng | planter shrubs', (0.16, 0.30, 0.10), rough=0.9)
    M['totem'] = gm.emissive('GZ Huacheng | totem panel', (0.85, 0.92, 1.0), 2.2, night_only=False)
    # the shop walls: a facade family of their own -- the whole 6 m wall is the shop band (gf_h), 6 m bays,
    # warm beige stone between the glass (wall kit: stone), shops lit at night like every other ground floor
    M['shops'] = gm.facade('GZ Facade | mall court', wall=(0.74, 0.68, 0.58), glass=(0.08, 0.10, 0.11),
                           roof=(0.5, 0.5, 0.5), floor_h=6.0, bay=BAY, win_w=0.86, sill=0.0, head=0.82,
                           glass_rough=0.05, glass_metal=0.3, gf_h=6.0, lit=0.9, warm=0.6, lit_k=4.0)
    return M


class Parts:
    """bmesh per material; obj() makes one object per material"""
    def __init__(self, M):
        self.M = M
        self.bms = {}
        self.uv = {}
        self.tint = {}

    def bm(self, key):
        if key not in self.bms:
            b = bmesh.new()
            self.bms[key] = b
            self.uv[key] = b.loops.layers.uv.new('UVMap')
        return self.bms[key]

    def box(self, key, x0, y0, z0, x1, y1, z1):
        b = self.bm(key)
        ring = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        c.extrude_polygon(b, ring, [], z0, z1, top=True, bottom=True, uv=self.uv[key])

    def quad(self, key, pts, uvs=None):
        b = self.bm(key)
        vs = [b.verts.new(p) for p in pts]
        f = b.faces.new(vs)
        if uvs:
            for lp, uv in zip(f.loops, uvs):
                lp[self.uv[key]].uv = uv
        return f

    def objects(self, prefix, col):
        out = []
        for key, b in self.bms.items():
            out.append(c.obj_from_bmesh('%s %s' % (prefix, key), b, self.M[key], col))
        self.bms = {}
        return out


# ------------------------------------------------------------------ ground: the plaza overlay
_CUT = []


def build_ground(cut_col, apply_boolean):
    """Inside gz_city.build_ground, while its cutters (roads, metro, APM, the court) still exist: the plaza paving
    laid over the slab across the south half, and the court."""
    col = c.collection(COL_NAME)
    M = mats()
    ring = c.clean_ring(c.clip_rect(park()['outer'], -1e4, -1e4, 1e4, NORTH))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    c.extrude_polygon(bm, ring, [], -0.05, KERB + 0.006, top=True, bottom=True, uv=uv)
    c.weld(bm)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    o = c.obj_from_bmesh('Huacheng | plaza paving', bm, None, col)
    apply_boolean(o, cut_col, solver='MANIFOLD')
    o.data.materials.append(M['plaza'])               # after the Boolean (it drops the slots), as gz_city's lawns do
    # keep the top only: the sides would show as a 6 mm step at every kerb
    me = o.data
    bm = bmesh.new(); bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z < 0.7], context='FACES')
    for f in bm.faces:
        for lp in f.loops:
            lp[bm.loops.layers.uv.active].uv = (lp.vert.co.x, lp.vert.co.y)
    bm.to_mesh(me); bm.free()
    log('plaza paving: %d faces' % len(me.polygons))
    _CUT[:] = [cut_col, apply_boolean]
    build_court(col, M)


# ------------------------------------------------------------------ the sunken court
def build_court(col, M):
    SEATS.clear()
    x0, y0, x1, y1 = COURT
    P = Parts(M)
    top = KERB
    # floor
    P.box('court', x0, TERR_Y1 - 0.01, COURT_Z - 0.4, x1, y1, COURT_Z)
    # seating terraces either side of the stair: 16 rows, 1.5 m deep, 0.375 m high; timber tops on every other row
    run = (TERR_Y1 - y0) / ROWS
    rise = (top - COURT_Z) / ROWS
    for side in ((x0, STAIR[0] - 0.6), (STAIR[1] + 0.6, x1)):
        for k in range(ROWS):
            ya, yb = y0 + k * run, y0 + (k + 1) * run
            zt = top - (k + 1) * rise
            P.box('steps', side[0], ya, COURT_Z - 0.2, side[1], yb, zt)
            if k % 2 == 1 and k < ROWS - 1:
                P.box('wood', side[0] + 0.4, ya + 0.15, zt, side[1] - 0.4, ya + 0.75, zt + 0.06)
    # the stair: 40 steps of 0.15 / 0.45 with two landings, cheek walls and stainless handrails
    P.box('stair', STAIR[0], y0 - 0.3, top - 0.4, STAIR[1], y0 + 0.6, top)     # the head of the stair, over the cut's gap
    steps, landings = 40, (13, 26)
    tread = (TERR_Y1 - y0 - 2 * 1.8 - 0.6) / steps
    y, z = y0 + 0.6, top
    for k in range(steps):
        z -= (top - COURT_Z) / steps
        P.box('stair', STAIR[0], y, COURT_Z - 0.2, STAIR[1], y + tread, z)
        y += tread
        if k + 1 in landings:
            P.box('stair', STAIR[0], y, COURT_Z - 0.2, STAIR[1], y + 1.8, z)
            y += 1.8
    for sx in (STAIR[0] - 0.6, STAIR[1]):
        _sloped_wall(P, 'coping', sx, sx + 0.6, y0, TERR_Y1, top + 0.45, COURT_Z + 0.45)
        _rail(P, (sx + 0.3, y0), (sx + 0.3, TERR_Y1), lambda t: top + 1.35 - t * (top - COURT_Z), 'steel')
    # shop walls: west (south -> north), north (west -> east), east (north -> south); u runs on round the U so the
    # facade bays are continuous; v from the court floor
    walls = [((x0, TERR_Y1), (x0, y1)), ((x0, y1), (x1, y1)), ((x1, y1), (x1, TERR_Y1))]
    shops = []
    u = 0.0
    hs = top - COURT_Z
    openings = gz_mall.court_openings()               # bay u -> the span along the wall left open (phase 2's doors)
    for a, b in walls:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        tx, ty = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        # the wall in pieces round any opening in it: full height beside it, from the door head up over it
        cuts = []
        for bu, (lo, hi) in openings.items():
            if u < bu < u + L:
                s0 = (lo - a[0]) * tx + (lo - a[1]) * ty if abs(tx) > 0.5 else (lo - a[1]) * ty
                s1 = (hi - a[0]) * tx + (hi - a[1]) * ty if abs(tx) > 0.5 else (hi - a[1]) * ty
                cuts.append((min(s0, s1), max(s0, s1)))
        runs, s_ = [], 0.0
        for c0, c1 in sorted(cuts):
            runs.append((s_, c0, 0.0)); runs.append((c0, c1, gz_mall.H_LOW)); s_ = c1
        runs.append((s_, L, 0.0))
        for sa, sb, v0 in runs:
            pa, pb = (a[0] + tx * sa, a[1] + ty * sa), (a[0] + tx * sb, a[1] + ty * sb)
            P.quad('shops', [(pa[0], pa[1], COURT_Z + v0), (pb[0], pb[1], COURT_Z + v0), (pb[0], pb[1], top), (pa[0], pa[1], top)],
                   [(u + sa, v0), (u + sb, v0), (u + sb, hs), (u + sa, hs)])          # faces into the court
        shops.append({'a': a, 'b': b, 'u0': u})
        u += L
    # the stone walls above the terraces (west and east, south of the shops) and across the south end under the stair head
    P.quad('coping', [(x0, y0, COURT_Z), (x0, TERR_Y1, COURT_Z), (x0, TERR_Y1, top), (x0, y0, top)])
    P.quad('coping', [(x1, TERR_Y1, COURT_Z), (x1, y0, COURT_Z), (x1, y0, top), (x1, TERR_Y1, top)])
    # coping round the rim, glass balustrade on it (not across the stair head)
    cw = 0.45
    P.box('coping', x0 - cw, y0, top - 0.2, x0, y1 + cw, top + 0.12)
    P.box('coping', x1, y0, top - 0.2, x1 + cw, y1 + cw, top + 0.12)
    P.box('coping', x0 - cw, y1, top - 0.2, x1 + cw, y1 + cw, top + 0.12)
    for a, b in (((x0 - cw / 2, y0), (x0 - cw / 2, y1 + cw / 2)), ((x0 - cw / 2, y1 + cw / 2), (x1 + cw / 2, y1 + cw / 2)),
                 ((x1 + cw / 2, y1 + cw / 2), (x1 + cw / 2, y0))):
        _balustrade(P, a, b, top + 0.12)
    # the south edge either side of the stair: balustrade on a low curb
    for xa, xb in ((x0 - cw / 2, STAIR[0] - 0.6), (STAIR[1] + 0.6, x1 + cw / 2)):
        P.box('coping', xa, y0 - 0.3, top - 0.2, xb, y0, top + 0.12)
        _balustrade(P, (xa, y0 - 0.15), (xb, y0 - 0.15), top + 0.12)
    objs = P.objects('Huacheng | court', col)
    # escalator wells and the membrane canopies over them
    for (wx0, wy0, wx1, wy1), (cx, cy, sx, sy) in zip(wells(), CANOPIES):
        _escalator_well(P, wx0, wy0, wx1, wy1)
        _canopy(P, cx, cy, sx, sy)
    objs += P.objects('Huacheng | canopy', col)
    # the walk down: a ramp under the stair (collision only; the player rides it like the metro stairs)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((STAIR[0], y0 - 0.5, top), (STAIR[1], y0 - 0.5, top), (STAIR[1], TERR_Y1 + 0.2, COURT_Z), (STAIR[0], TERR_Y1 + 0.2, COURT_Z))]
    bm.faces.new(vs)
    proxies = bpy.data.collections.get('_collision proxies') or bpy.data.collections.new('_collision proxies')
    if proxies.name not in bpy.context.scene.collection.children:
        bpy.context.scene.collection.children.link(proxies)
    ramp = c.obj_from_bmesh('Collision | huacheng stair ramp', bm, None, proxies)
    ramp.hide_render = True
    signs = _shopfronts(P, shops, openings=tuple(gz_mall.court_openings()))
    _furniture(P)
    objs += P.objects('Huacheng | shopfront', col)
    signs += _street(P)
    objs += P.objects('Huacheng | street', col)
    # phase 2: 花城汇 B1 -- the doors stand open, the corridor and its shops behind them
    mall_walls, mall_signs, mall = gz_mall.build(P, __import__(__name__))
    objs += P.objects('Huacheng | mall', col)
    # phase 3: the north half -- the forecourt, 花城汇's north court, the music fountain, the woods
    north = gz_north.build(P, __import__(__name__), _CUT[0], _CUT[1], col)
    objs += P.objects('Huacheng | north', col)
    SEATS.extend(gz_north.SEATS)
    _write_json(shops, signs + gz_north.SIGNS, mall_walls, mall_signs, mall, north)
    log('court: %d objects, %d m of shopfront, %d signs' % (len(objs), round(u), len(signs)))


def _sloped_wall(P, key, xa, xb, ya, yb, za, zb):
    """a solid wall from the court floor up to a top sloping from za (at ya) to zb (at yb)"""
    b_ = P.bm(key)
    lo = [b_.verts.new(p) for p in ((xa, ya, COURT_Z - 0.2), (xb, ya, COURT_Z - 0.2), (xb, yb, COURT_Z - 0.2), (xa, yb, COURT_Z - 0.2))]
    hi = [b_.verts.new(p) for p in ((xa, ya, za), (xb, ya, za), (xb, yb, zb), (xa, yb, zb))]
    for i in range(4):
        j = (i + 1) % 4
        b_.faces.new((lo[i], lo[j], hi[j], hi[i]))
    b_.faces.new(hi)
    bmesh.ops.recalc_face_normals(b_, faces=b_.faces[-5:])


def _rail(P, a, b, zfun, key, r=0.025, n=12):
    """a handrail from a to b, height zfun(t) along it (t 0..1), as a chain of thin boxes"""
    for i in range(n):
        t0, t1 = i / n, (i + 1) / n
        xa, ya = a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0
        xb, yb = a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1
        za, zb = zfun(t0), zfun(t1)
        b_ = P.bm(key)
        dx, dy = xb - xa, yb - ya
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L * r, dx / L * r
        pts = [(xa + nx, ya + ny, za - r), (xb + nx, yb + ny, zb - r), (xb - nx, yb - ny, zb - r), (xa - nx, ya - ny, za - r)]
        lo = [b_.verts.new(p) for p in pts]
        hi = [b_.verts.new((p[0], p[1], p[2] + 2 * r)) for p in pts]
        for j in range(4):
            k = (j + 1) % 4
            b_.faces.new((lo[j], lo[k], hi[k], hi[j]))


def _balustrade(P, a, b, z0, h=1.1, post=1.5):
    """frameless glass on a steel shoe, a stainless handrail on top, a post every `post` metres"""
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy)
    if L < 0.2:
        return
    tx, ty = dx / L, dy / L
    nx, ny = -ty * 0.012, tx * 0.012
    P.quad('glass', [(a[0], a[1], z0 + 0.06), (b[0], b[1], z0 + 0.06), (b[0], b[1], z0 + h - 0.06), (a[0], a[1], z0 + h - 0.06)])
    _bar(P, 'dark', a, b, z0, z0 + 0.08, 0.05)
    _bar(P, 'steel', a, b, z0 + h - 0.02, z0 + h + 0.04, 0.03)
    n = max(1, int(L / post))
    for i in range(n + 1):
        px, py = a[0] + tx * L * i / n, a[1] + ty * L * i / n
        P.box('steel', px - 0.025, py - 0.025, z0, px + 0.025, py + 0.025, z0 + h)


def _bar(P, key, a, b, z0, z1, hw):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / L * hw, dx / L * hw
    bm = P.bm(key)
    ring = [(a[0] + nx, a[1] + ny), (a[0] - nx, a[1] - ny), (b[0] - nx, b[1] - ny), (b[0] + nx, b[1] + ny)]
    if c.ring_area(ring) < 0:
        ring.reverse()
    c.extrude_polygon(bm, ring, [], z0, z1, top=True, bottom=True, uv=P.uv[key])


def _escalator_well(P, x0, y0, x1, y1):
    """an open well with stone walls, two escalators down to the court level running north, glass round the top"""
    top = KERB
    for q in ([(x0, y0, COURT_Z), (x0, y0, top), (x0, y1, top), (x0, y1, COURT_Z)],
              [(x1, y1, COURT_Z), (x1, y1, top), (x1, y0, top), (x1, y0, COURT_Z)],
              [(x1, y0, COURT_Z), (x1, y0, top), (x0, y0, top), (x0, y0, COURT_Z)],
              [(x0, y1, COURT_Z), (x0, y1, top), (x1, y1, top), (x1, y1, COURT_Z)]):
        P.quad('coping', list(reversed(q)))                  # faces into the well
    P.box('court', x0, y0, COURT_Z - 0.3, x1, y1, COURT_Z)
    # escalators: a truss from the street at the south end down to the floor at the north end
    w = (x1 - x0 - 0.6) / 2
    for i in range(2):
        ex0 = x0 + 0.2 + i * (w + 0.2)
        ex1 = ex0 + w
        ya, yb = y0 + 0.6, y1 - 0.6
        b_ = P.bm('escalator')
        for (xa, xb) in ((ex0, ex1),):
            pts = [(xa, ya, top - 0.05), (xb, ya, top - 0.05), (xb, yb, COURT_Z + 0.05), (xa, yb, COURT_Z + 0.05)]
            vs = [b_.verts.new(p) for p in pts]
            b_.faces.new(vs)
            vs2 = [b_.verts.new((p[0], p[1], p[2] - 0.9)) for p in pts]
            b_.faces.new(list(reversed(vs2)))
        for xs in (ex0, ex1):
            P.quad('glass', [(xs, ya, top + 0.9), (xs, yb, COURT_Z + 0.95), (xs, yb, COURT_Z + 0.05), (xs, ya, top - 0.05)])
            _rail(P, (xs, ya), (xs, yb), lambda t: top + 0.95 - t * (top - COURT_Z), 'dark', r=0.04, n=8)
    # a stone rim over the slab's cut, glass round the top on three sides (the south side is the way on)
    for bx in ((x0 - 0.45, y0 - 0.45, x0, y1 + 0.45), (x1, y0 - 0.45, x1 + 0.45, y1 + 0.45),
               (x0, y1, x1, y1 + 0.45), (x0, y0 - 0.45, x1, y0)):
        P.box('coping', bx[0], bx[1], top - 0.2, bx[2], bx[3], top + 0.04)
    _balustrade(P, (x0, y1), (x1, y1), top)
    _balustrade(P, (x0, y0 + 0.6), (x0, y1), top)
    _balustrade(P, (x1, y1), (x1, y0 + 0.6), top)


# The canopies' cushions, read off the satellite (each canopy is three overlapping layers stepping down to the
# south like roof scales, the north one largest; the east canopy's north layer is heart-shaped): per layer the rim
# height and the puffs (x, y offset from the canopy centre, radius) whose union is its outline.
CUSHIONS = [
    [(8.8, [(-6.0, 6.2, 5.6), (0.0, 6.6, 6.0), (6.0, 6.2, 5.6)]),
     (7.6, [(-5.6, -1.6, 4.0), (0.0, -1.4, 4.2), (5.8, -1.6, 4.0)]),
     (6.5, [(-5.2, -7.8, 4.2), (0.0, -7.9, 4.3), (4.4, -7.8, 4.0)])],
    [(8.8, [(-5.2, 6.6, 6.2), (5.4, 6.8, 6.0), (0.0, 2.6, 5.4)]),
     (7.6, [(-7.4, -2.6, 4.0), (-1.8, -2.4, 4.2), (4.2, -2.6, 4.0)]),
     (6.5, [(-6.6, -7.9, 3.6), (-1.3, -8.0, 3.8), (3.9, -7.9, 3.6)])],
]


def _canopy(P, cx, cy, sx, sy, rings=16, seg=80, lay=None):
    """A white membrane "cloud" over an escalator well (the satellite: soft white blobs at the court's south
    corners, each three cushions overlapping like scales). Every cushion is a closed pillow: its outline the smooth
    union of round puffs, the top domed (steep at the rim, so it reads puffy from the street) with a lump over each
    puff and a valley between, the underside bellied a little; a slim white edge cable round the rim. Two slender
    white columns per cushion, clear of the well, branch into struts up to its belly."""
    lay = lay or CUSHIONS[0 if cx < 0 else 1]
    k_ = 4.0
    for zr, puffs in lay:
        PF = [(cx + ox, cy + oy, r) for ox, oy, r in puffs]
        def field(x, y):        # = exp(-4) on the rim of a lone puff; overlapping puffs merge with a soft waist
            return sum(math.exp(-k_ * ((x - ox) ** 2 + (y - oy) ** 2) / (r * r)) for ox, oy, r in PF)
        def puff(x, y):         # 0..1: how far inside the nearest puff's dome (a smooth max over the puffs)
            s = [max(0.0, 1.0 - ((x - ox) ** 2 + (y - oy) ** 2) / (r * r)) ** 0.5 for ox, oy, r in PF]
            return sum(v ** 4 for v in s) ** 0.25
        ax = sum(p[0] * p[2] ** 2 for p in PF) / sum(p[2] ** 2 for p in PF)
        ay = sum(p[1] * p[2] ** 2 for p in PF) / sum(p[2] ** 2 for p in PF)
        edge = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            r = 0.5
            while r < 30 and field(ax + math.cos(a) * r, ay + math.sin(a) * r) > math.exp(-k_):
                r += 0.1
            edge.append(r)
        edge = [(edge[k - 1] + 2 * edge[k] + edge[(k + 1) % seg]) / 4 for k in range(seg)]
        rmax = max(r for *_, r in PF)
        H, Hb = 0.8 + 0.2 * rmax, 0.45 + 0.13 * rmax        # a fat lens (the big north cushion stands tallest)
        def roll(t):            # a superellipse section: the edge rolls over like a pillow's, not a plate's knife edge
            return (1.0 - t ** 3) ** (1.0 / 3.0)
        def top(x, y, t):       # a lump on every puff (they fade out toward the roll of the edge)
            return zr + H * roll(t) * (0.35 + 0.65 * (puff(x, y) * (1.0 - t ** 4) + t ** 4 * 0.5))
        def belly(x, y, t):     # seen from the street: the puffs bulge down, valleys between them
            return zr - Hb * roll(t) * (0.3 + 0.7 * (puff(x, y) * (1.0 - t ** 4) + t ** 4 * 0.5))
        for key, fz, flip in (('membrane', top, False), ('membrane under', belly, True)):
            b_ = P.bm(key)
            grid = []
            for i in range(rings + 1):
                t = 1.0 - (1.0 - i / rings) ** 2           # rings crowd toward the rim, where the edge rolls over
                if i == 0:
                    grid.append([b_.verts.new((ax, ay, fz(ax, ay, 0.0)))] * seg)
                    continue
                row = []
                for k in range(seg):
                    a = 2 * math.pi * k / seg
                    x, y = ax + math.cos(a) * edge[k] * t, ay + math.sin(a) * edge[k] * t
                    row.append(b_.verts.new((x, y, fz(x, y, t))))
                grid.append(row)
            for i in range(rings):
                for k in range(seg):
                    q = [grid[i][k], grid[i + 1][k], grid[i + 1][(k + 1) % seg], grid[i][(k + 1) % seg]]
                    if i == 0:
                        q = q[1:]                          # the centre ring is one point: triangles
                    try:
                        b_.faces.new(list(reversed(q)) if flip else q)
                    except ValueError:
                        pass
            if key == 'membrane':
                rim = [g.co.copy() for g in grid[-1]]
        # the edge cable round the rim
        for k in range(seg):
            p1, p2 = rim[k], rim[(k + 1) % seg]
            _rail(P, (p1.x, p1.y), (p2.x, p2.y), lambda t_, z1=p1.z, z2=p2.z: z1 + (z2 - z1) * t_, 'white', r=0.06, n=1)
        def t_at(x, y):         # 0 at the cushion's middle .. 1 on its rim
            kk = round((math.atan2(y - ay, x - ax) % (2 * math.pi)) / (2 * math.pi) * seg) % seg
            return min(0.97, math.hypot(x - ax, y - ay) / edge[kk])
        # two columns, clear of the escalator well under the canopy's middle, each branching into three struts
        w0, w1 = WELL[0] / 2 + 1.0, WELL[1] / 2 + 1.0
        for side in (-1, 1):
            ox = ax + side * max(w0 + 0.5, 0.3 * (max(p[0] + p[2] for p in PF) - min(p[0] - p[2] for p in PF)))
            oy = ay
            if abs(ox - cx) < w0 and abs(oy - cy) < w1:
                continue
            hz = belly(ox, oy, t_at(ox, oy))
            P.box('white', ox - 0.12, oy - 0.12, KERB, ox + 0.12, oy + 0.12, hz - 1.9)
            P.box('white', ox - 0.2, oy - 0.2, KERB, ox + 0.2, oy + 0.2, KERB + 0.35)      # plinth
            for j in range(3):
                a = j * 2.094 + (0.5 if side > 0 else 1.55)
                ex, ey = ox + math.cos(a) * 2.6, oy + math.sin(a) * 2.6
                _strut(P, (ox, oy, hz - 1.9), (ex, ey, belly(ex, ey, t_at(ex, ey)) - 0.05), 0.06)


def _strut(P, a, b, r):
    """a square tube from a to b (3D)"""
    import mathutils
    A, B = mathutils.Vector(a), mathutils.Vector(b)
    d = (B - A)
    if d.length < 1e-3:
        return
    d.normalize()
    u = d.cross(mathutils.Vector((0, 0, 1)))
    if u.length < 1e-3:
        u = mathutils.Vector((1, 0, 0))
    u.normalize(); v = d.cross(u)
    bm_ = P.bm('white')
    ring = [u * r + v * r, -u * r + v * r, -u * r - v * r, u * r - v * r]
    lo = [bm_.verts.new(A + o) for o in ring]
    hi = [bm_.verts.new(B + o) for o in ring]
    for i in range(4):
        j = (i + 1) % 4
        bm_.faces.new((lo[i], lo[j], hi[j], hi[i]))


def _shopfronts(P, walls, z0=COURT_Z, h=6.0, openings=(), portals=()):
    """Per 6 m bay round a run of shop walls (the court's U, the mall corridor's sides): stone pilasters on the bay
    lines, a black granite kick, dark aluminium mullions every 1.5 m and a transom, a pair of glass doors in the
    middle, a sign box on the fascia. z0: floor, h: wall height (the shop band's head at h - 0.9, the fascia above).
    `openings`: bay centres (u) that are open doorways (phase 2: the court's north portal and its west link) -- a
    bronze portal round the opening, a header at door height, no glass; the north one carries the mall's gold
    lettering (the web), the west one 中区.
    Returns the sign boxes [{c: [x, y, z], n: [nx, ny], w, h, entrance}] for the web."""
    signs = []
    win0, win1 = 0.35, h - 0.9                       # the facade shader's shop window (gf_h - 0.9)
    door = 3.55
    for w in walls:
        (ax, ay), (bx, by) = w['a'], w['b']
        L = math.hypot(bx - ax, by - ay)
        tx, ty = (bx - ax) / L, (by - ay) / L
        nx, ny = ty, -tx                             # into the room (the walls run with the room on their right)
        nb = int(round(L / BAY))
        for k in range(nb + 1):                      # pilasters on every bay line, corners included
            s_ = k * BAY
            cx, cy = ax + tx * s_, ay + ty * s_
            _ob(P, 'pilaster', cx, cy, tx, ty, nx, ny, -0.35, 0.35, 0.0, 0.16, z0, z0 + h - 0.05)
        for k in range(nb):
            s0 = k * BAY
            u = w['u0'] + s0
            uc = u + BAY / 2
            def at(s_):
                return ax + tx * s_, ay + ty * s_
            dm = s0 + BAY / 2
            opening = next((o for o in openings if abs(uc - o) < 1.0), None)
            if opening is not None:
                # a bronze portal standing proud of the shopfronts round the open doorway, a header beam at door height
                for side in (-1, 1):
                    _ob(P, 'frame', *at(dm + side * 2.55), tx, ty, nx, ny, -0.22, 0.22, 0.0, 0.6, z0, z0 + h - 0.8)
                _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -2.77, 2.77, 0.0, 0.6, z0 + h - 1.15, z0 + h - 0.75)
                _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -2.4, 2.4, -0.1, 0.12, z0 + 3.5, z0 + 3.62)
                # the sliding leaves parked open either side, a dark threshold
                for side in (-1, 1):
                    _ob(P, 'glass', *at(dm + side * 2.05), tx, ty, nx, ny, -0.3, 0.3, -0.04, -0.02, z0 + 0.02, z0 + 3.5)
                _ob(P, 'kick', *at(dm), tx, ty, nx, ny, -2.3, 2.3, -0.4, 0.4, z0 - 0.02, z0 + 0.004)
                c_ = at(dm)
                signs.append({'c': [c_[0], c_[1], z0 + h - 0.45], 'n': [nx, ny], 'w': 5.4, 'h': 0.8, 'entrance': True if abs(opening - 57.0) < 1 else 'link'})
                continue
            g0, g1 = s0 + 0.3, s0 + BAY - 0.3          # the glass between the pilasters
            # kick plate and the head of the glass
            _ob(P, 'kick', *at(dm), tx, ty, nx, ny, -(BAY / 2 - 0.35), BAY / 2 - 0.35, 0.0, 0.06, z0, z0 + win0)
            _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -(BAY / 2 - 0.35), BAY / 2 - 0.35, 0.0, 0.1, z0 + win1 - 0.06, z0 + win1 + 0.06)
            # mullions every 1.5 m, a transom over the doors
            for j in range(1, 4):
                _ob(P, 'frame', *at(g0 + j * (g1 - g0) / 4), tx, ty, nx, ny, -0.03, 0.03, 0.0, 0.09, z0 + win0, z0 + win1)
            _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -(BAY / 2 - 0.35), BAY / 2 - 0.35, 0.0, 0.09, z0 + door, z0 + door + 0.08)
            # doors: the middle two panes, framed heavier, stainless pull bars
            for side in (-1, 1):
                _ob(P, 'frame', *at(dm + side * 1.5), tx, ty, nx, ny, -0.05, 0.05, 0.0, 0.12, z0 + win0, z0 + door)
                _ob(P, 'steel', *at(dm + side * 0.18), tx, ty, nx, ny, -0.02, 0.02, 0.1, 0.16, z0 + 0.9, z0 + 2.1)
            _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -0.04, 0.04, 0.0, 0.12, z0 + win0, z0 + door)
            if any(abs(uc - o) < 1.0 for o in portals):
                # the mall's own doors (north court): the bronze portal round them and the gold letters, no sign box
                for side in (-1, 1):
                    _ob(P, 'frame', *at(dm + side * 2.55), tx, ty, nx, ny, -0.22, 0.22, 0.0, 0.6, z0, z0 + h - 0.8)
                _ob(P, 'frame', *at(dm), tx, ty, nx, ny, -2.77, 2.77, 0.0, 0.6, z0 + h - 1.15, z0 + h - 0.75)
                c_ = at(dm)
                signs.append({'c': [c_[0], c_[1], z0 + h - 0.45], 'n': [nx, ny], 'w': 5.4, 'h': 0.8, 'entrance': True})
                continue
            # the sign box on the fascia
            _ob(P, 'signbox', *at(dm), tx, ty, nx, ny, -2.3, 2.3, 0.0, 0.18, z0 + h - 0.78, z0 + h - 0.12)
            c_ = at(dm)
            signs.append({'c': [c_[0] + nx * 0.185, c_[1] + ny * 0.185, z0 + h - 0.45], 'n': [nx, ny], 'w': 4.5, 'h': 0.58, 'entrance': False})
    return signs


def _ob(P, key, cx, cy, tx, ty, nx, ny, s0, s1, d0, d1, z0, z1):
    """a box in a wall's frame: along (t) s0..s1, out from the wall (n) d0..d1, z0..z1, round (cx, cy)"""
    pts = [(cx + tx * s + nx * d, cy + ty * s + ny * d) for s, d in ((s0, d0), (s1, d0), (s1, d1), (s0, d1))]
    if c.ring_area(pts) < 0:
        pts.reverse()
    c.extrude_polygon(P.bm(key), pts, [], z0, z1, top=True, bottom=False, uv=P.uv[key])


def _furniture(P):
    """the court's life: a cafe's umbrellas and tables by the east shops, sign totems, planters at the corners,
    timber benches down the middle"""
    x0, y0, x1, y1 = COURT
    z = COURT_Z
    # cafe: three square umbrellas (3 m), each over a round table and four stools
    for i, cy in enumerate((54.0, 62.0, 70.0)):
        cx = x1 - 4.2
        P.box('steel', cx - 0.04, cy - 0.04, z, cx + 0.04, cy + 0.04, z + 2.6)
        b_ = P.bm('canvas')
        apex = b_.verts.new((cx, cy, z + 2.95))
        ring = [b_.verts.new((cx + dx * 1.5, cy + dy * 1.5, z + 2.35)) for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        for j in range(4):
            b_.faces.new((ring[j], ring[(j + 1) % 4], apex))
        for j in range(4):                                    # the valance
            a_, c_ = ring[j].co, ring[(j + 1) % 4].co
            vs = [b_.verts.new(p) for p in ((a_.x, a_.y, a_.z), (c_.x, c_.y, c_.z), (c_.x, c_.y, c_.z - 0.18), (a_.x, a_.y, a_.z - 0.18))]
            b_.faces.new(vs)
        P.box('dark', cx - 0.35, cy - 0.35, z + 0.72, cx + 0.35, cy + 0.35, z + 0.76)
        P.box('dark', cx - 0.04, cy - 0.04, z, cx + 0.04, cy + 0.04, z + 0.72)
        for dx, dy in ((-0.75, 0), (0.75, 0), (0, -0.75), (0, 0.75)):
            SEATS.append({'p': [round(cx + dx, 2), round(cy + dy, 2), round(z + 0.46, 3)], 'f': [-dx / 0.75, -dy / 0.75], 'cafe': True})
            P.box('dark', cx + dx - 0.18, cy + dy - 0.18, z + 0.42, cx + dx + 0.18, cy + dy + 0.18, z + 0.46)
            P.box('dark', cx + dx - 0.03, cy + dy - 0.03, z, cx + dx + 0.03, cy + dy + 0.03, z + 0.42)
    # two sign totems at the foot of the terraces: a dark column with a lit panel on each face
    for tx_ in (x0 + 3.0, x1 - 3.0):
        P.box('signbox', tx_ - 0.35, TERR_Y1 + 1.2, z, tx_ + 0.35, TERR_Y1 + 1.5, z + 3.4)
        P.box('totem', tx_ - 0.3, TERR_Y1 + 1.17, z + 0.6, tx_ + 0.3, TERR_Y1 + 1.53, z + 3.2)
    # planters with clipped shrubs at the north corners and either side of the entrance
    for px, py in ((x1 - 1.6, y1 - 1.6), (-10.5, y1 - 1.4), (-1.5, y1 - 1.4)):     # (none at the north-west corner: the link)
        P.box('coping', px - 0.8, py - 0.8, z, px + 0.8, py + 0.8, z + 0.6)
        b_ = P.bm('green')
        bmesh.ops.create_icosphere(b_, subdivisions=2, radius=0.75, matrix=__import__('mathutils').Matrix.Translation((px, py, z + 0.95)))
    # benches down the middle, clear of the cafe
    for by_ in (56.0, 64.0, 72.0):
        bx_ = x0 + 6.0
        P.box('wood', bx_ - 1.2, by_ - 0.25, z + 0.42, bx_ + 1.2, by_ + 0.25, z + 0.48)
        for dx in (-0.6, 0.6):
            SEATS.append({'p': [round(bx_ + dx, 2), by_, round(z + 0.48, 3)], 'f': [0.0, -1.0 if dx < 0 else 1.0]})
        for ex in (-0.9, 0.9):
            P.box('coping', bx_ + ex - 0.15, by_ - 0.25, z, bx_ + ex + 0.15, by_ + 0.25, z + 0.42)


SEATS = []                            # every bench / stool seat (gz_huacheng.json 'seats': the web's plaza life sits people there)

KIOSKS = [((-27.0, -300.0), 0.0, '花城冰室', '雪糕 · 冻柠茶', '#e8f4ff', '#1a5aa8'),
          ((21.5, -392.0), math.pi, '万花筒邮局', '明信片 · 纪念章', '#2f6b3a', '#ffffff'),
          ((-27.0, -168.0), 0.0, '羊城通充值', '地铁 · APM · 公交', '#e8b923', '#1d1d1d')]


def _rgb(hexs):
    """'#rrggbb' -> linear rgb"""
    v = [int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in v)


def _street(P):
    """The promenade's furniture: timber benches on stone blocks along both grove edges every 15 m (a bin by every
    third), three kiosks with an awning and a lit sign (their signs go to the web with the court's). The spawn's
    stretch stays open. Returns the kiosk signs."""
    import gz_city, gz_metro
    R = gz_city.raster()
    def free(x, y, r=1.5):
        return (in_south(x, y) and not R.at('bld', x, y) and not R.at('water', x, y) and not gz_city.on_carriageway(x, y, 1.0)
                and not gz_metro.blocked(x, y, r) and math.hypot(x - SPAWN[0], y - SPAWN[1]) > 30.0)
    nb = 0
    for x, face in ((-28.6, 1.0), (23.2, -1.0)):
        y, k = -520.0, 0
        while y < -118:
            if free(x, y) and not any(abs(y - ky) < 6 and abs(x - kx) < 6 for (kx, ky), *_ in KIOSKS):
                P.box('wood', x - 0.25, y - 1.1, KERB + 0.42, x + 0.25, y + 1.1, KERB + 0.48)
                for dy in (-0.8, 0.8):
                    P.box('coping', x - 0.25, y + dy - 0.15, KERB, x + 0.25, y + dy + 0.15, KERB + 0.42)
                P.box('wood', x - face * 0.22 - 0.03, y - 1.1, KERB + 0.48, x - face * 0.22 + 0.03, y + 1.1, KERB + 0.9)   # back rail
                for dy in (-0.55, 0.55):
                    SEATS.append({'p': [round(x + face * 0.04, 2), round(y + dy, 2), round(KERB + 0.48, 3)], 'f': [face, 0.0]})
                if k % 3 == 0 and free(x, y + 1.8):
                    P.box('dark', x - 0.22, y + 1.55, KERB, x + 0.22, y + 1.95, KERB + 0.85)
                nb += 1
                k += 1
            y += 15.0
    signs = []
    for (kx, ky), yaw, name, sub, bg, fg in KIOSKS:
        ca, sa = math.cos(yaw), math.sin(yaw)
        def W(lx, ly):                 # kiosk local (x across the front, y out of it) -> world
            return kx + lx * ca - ly * sa, ky + lx * sa + ly * ca
        def kbox(key, x0, y0, x1, y1, z0, z1):
            pts = [W(x0, y0), W(x1, y0), W(x1, y1), W(x0, y1)]
            if c.ring_area(pts) < 0:
                pts.reverse()
            c.extrude_polygon(P.bm(key), pts, [], z0, z1, top=True, bottom=False, uv=P.uv[key])
        # the booth faces +x (local) toward the promenade's middle: its own colour, a service window with a counter,
        # a striped awning raking out over it, a sign band all along the top
        body = 'kiosk %s' % name
        P.M[body] = gm.plain('GZ Huacheng | kiosk %s' % name, _rgb(bg), rough=0.45, metal=0.1)
        kbox(body, -0.9, -1.3, 0.9, 1.3, KERB, KERB + 2.45)
        kbox('dark', 0.9, -1.0, 0.95, 1.0, KERB + 0.95, KERB + 2.0)               # the service window
        kbox('steel', 0.9, -1.15, 1.3, 1.15, KERB + 0.92, KERB + 0.98)            # counter
        kbox('white', -1.0, -1.4, 1.0, 1.4, KERB + 2.45, KERB + 3.05)             # sign band core
        kbox('dark', -1.05, -1.45, 1.05, 1.45, KERB + 3.05, KERB + 3.12)          # roof edge
        stripes = 6
        for j in range(stripes):                                                  # awning: alternating stripes
            ya, yb = -1.3 + 2.6 * j / stripes, -1.3 + 2.6 * (j + 1) / stripes
            b_ = P.bm('canvas' if j % 2 else body)
            pts = [(*W(0.95, ya), KERB + 2.4), (*W(0.95, yb), KERB + 2.4), (*W(1.95, yb), KERB + 2.05), (*W(1.95, ya), KERB + 2.05)]
            b_.faces.new([b_.verts.new(p) for p in pts])                          # both faces: seen from under and above
            b_.faces.new([b_.verts.new((x, y, z + 0.01)) for x, y, z in reversed(pts)])
        cx_, cy_ = W(1.01, 0.0)
        signs.append({'c': [cx_, cy_, KERB + 2.75], 'n': [ca, sa], 'w': 2.7, 'h': 0.56, 'entrance': False, 'name': name, 'sub': sub, 'bg': bg, 'fg': fg})
    log('promenade: %d benches, %d kiosks' % (nb, len(KIOSKS)))
    return signs


def walk_lines():
    """[(points, z_start, z_end)] the crowd's paths through the court (gz_gameplay.walkways stitches them in): the
    stair from the street down, then a loop along the shopfronts 1.6 m off the glass (clear of the cafe, the planters
    and the totems)."""
    x0, y0, x1, y1 = COURT
    sx = (STAIR[0] + STAIR[1]) / 2
    top, foot, ring_y = (sx, y0 - 4.0), (sx, TERR_Y1 + 0.5), TERR_Y1 + 3.0
    a, b, c_, d = (x0 + 1.6, ring_y), (x0 + 1.6, y1 - 3.4), (x1 - 1.6, y1 - 3.4), (x1 - 1.6, ring_y)
    m = (sx, ring_y)
    z = COURT_Z
    # 花城汇 B1: from the loop's north-west corner through the link into the corridor, and on up to the park
    into = [([b, (gz_mall.LINK[2] + 1.8, (gz_mall.LINK[1] + gz_mall.LINK[3]) / 2)], z, z)]
    return ([([top, foot], KERB, z), ([foot, m], z, z), ([m, a], z, z), ([a, b], z, z), ([b, c_], z, z), ([c_, d], z, z), ([d, m], z, z)]
            + into + gz_mall.walk_lines() + gz_north.walk_lines())


def _write_json(shops, signs, mall_walls=(), mall_signs=(), mall=None, north=None):
    """huacheng.json for the web: the court's shop walls (ShopLight edges), the sign boxes, the plan's key shapes; the
    mall's (phase 2) shop walls, sign boxes, hanging signs, posters, directory and screen"""
    if mall is not None:
        mall = dict(mall, walls=list(mall_walls), signs=list(mall_signs))
        SEATS.extend(dict(b, mall=True) for b in mall.pop('benches', []))
    out = {
        'court': {'rect': COURT, 'z': COURT_Z, 'terraces_y1': TERR_Y1, 'stair': STAIR, 'bay': BAY, 'walls': shops, 'signs': signs},
        'mall': mall,
        'north_half': north,                       # phase 3 (gz_north); 'north' below is the paved half's edge (y 135)
        'oval': OVAL, 'canopies': CANOPIES, 'north': NORTH, 'spawn': SPAWN,
        'seats': SEATS, 'kiosks': [[k[0][0], k[0][1]] for k in KIOSKS], 'wells': wells(),
    }
    path = os.path.join(ROOT, 'demo', 'public', 'assets', 'tianhe', 'huacheng.json')
    with open(path, 'w') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
