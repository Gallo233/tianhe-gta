"""花城广场's north half (phase 3), between 花城大道 (y 135) and the woods towards 黄埔大道, after the satellite (Esri World
Imagery) and the Commons photographs of the music fountain ("花城汇 音乐喷泉", 2013: the sunken north court of 花城汇 in
front, its shops and the mall's gold letters on the far wall, a long pool of jets rising tens of metres behind it,
dense banyans either side):

    forecourt   granite over the mall's middle zone (y 136..176), a grid of trees in it; the mall's north escalators
                (gz_mall.WELL) and APM 花城大道 A (M39) come up here
    north court 花城汇 北区: a sunken court (x -18..12, y 198..246, floor at the B1 level) entered down terraces of turf
                and stone from the south -- the stepped lawn people sit on to watch the fountain -- with a stair down
                the middle; shops on three sides, the mall's portal and gold letters on the north wall
    fountain    the music fountain: a 22 x 90 m basin on the axis north of the court (y 254..344), a stone rim people sit
                on; nozzles: a line of tall jets down the middle, two lines of mid jets, two lines of arching jets leaning
                in, foggers at the ends (the web runs the shows: FountainShow)
    woods       dense fig groves either side, granite walks along the basin and the court, a paved square at the
                fountain's north end, lamp masts, benches facing the water

Hooks (gz_huacheng carries them to gz_city / export_web): ground_cutters (court, basin), lawn_cutters (everything
paved), water_holes, trees, lamps, build (into gz_huacheng's Parts), walk_lines, the json record.
"""
import math

import bmesh
import bpy

import gz_common as c
import gz_materials as gm

Z = -5.85                                   # court floor (the B1 level)
KERB = 0.15
NCOURT = (-18.0, 198.0, 12.0, 246.0)        # x0, y0, x1, y1
NTERR_Y1 = 222.0                            # terraces from the south edge down to here
NSTAIR = (-7.0, 1.0)                        # the stair's x range (8 m)
NROWS = 16
BASIN = (-11.0, 254.0, 11.0, 344.0)
RIM_W, RIM_H = 0.6, 0.45                    # the basin's stone rim: wide and low enough to sit on
WATER_Z = KERB + 0.25
FLOOR_B = KERB - 0.25                       # basin floor
PAVE = [                                    # disjoint rectangles of granite (each its own object: Manifold wants them apart)
    ('forecourt', (-40.0, 136.0, 34.0, 176.0)),
    ('apron', (-18.0, 176.0, 12.0, 198.0)),
    ('walk w', (-24.0, 176.0, -18.0, 254.0)),
    ('walk e', (12.0, 176.0, 18.0, 254.0)),
    ('strip', (-18.0, 246.0, 12.0, 254.0)),
    ('fountain w', (-16.0, 254.0, -11.0, 344.0)),
    ('fountain e', (11.0, 254.0, 16.0, 344.0)),
    ('square', (-24.0, 344.0, 18.0, 364.0)),
]
WOODS_Y = (176.0, 430.0)                    # the designed zone (the generic park's random trees give way to it)
WOODS_X = (-70.0, 66.0)
BAY = 6.0
SEATS = []                                  # terrace and bench seats for the web's plaza life
SIGNS = []


def log(*a):
    print('[north]', *a, flush=True)


def rr(r, p=0.0):
    return [(r[0] - p, r[1] - p), (r[2] + p, r[1] - p), (r[2] + p, r[3] + p), (r[0] - p, r[3] + p)]


# ------------------------------------------------------------------ plan hooks
def ground_cutters():
    """[(ring, z0, z1)]: the north court (0.3 m proud, as the south court) and the fountain basin."""
    return [(rr(NCOURT, 0.3), Z - 0.6, 3.0), (rr(BASIN, 0.02), FLOOR_B - 0.1, 3.0)]


def lawn_cutters():
    """Rings the lawn loses (everything paved, the court, the basin and its rim)."""
    return [rr(r, 0.05) for _, r in PAVE] + [rr(NCOURT, 0.5), rr(BASIN, RIM_W + 0.05)]


def water_holes():
    """Clockwise: the river plane (z -2.8) under the sunken court."""
    return [list(reversed(rr(NCOURT, 0.3)))]


def keep_off():
    """Rectangles the metro entrances and the APM passages keep clear of (the court is at the B1 level)."""
    return [NCOURT]


def designed(x, y):
    """Inside the zone whose trees are designed here (the generic park trees are dropped there)."""
    return WOODS_X[0] < x < WOODS_X[1] and WOODS_Y[0] - 40 < y < WOODS_Y[1]


def _in_rect(x, y, r, pad=0.0):
    return r[0] - pad < x < r[2] + pad and r[1] - pad < y < r[3] + pad


def trees(free, rng, in_park):
    """[(kind, x, y, z, scale)]: dense fig woods either side of the court and the fountain (5.5 m staggered grid),
    a grid of trees in planters on the forecourt."""
    out = []
    import gz_metro, gz_mall
    def ok(x, y, pad=2.0):
        if not free(x, y) or not in_park(x, y) or gz_metro.blocked(x, y, 4.0):
            return False
        if any(_in_rect(x, y, r, 1.6) for _, r in PAVE[1:]) or _in_rect(x, y, NCOURT, 3.0) or _in_rect(x, y, BASIN, 3.0):
            return False
        if _in_rect(x, y, gz_mall.WELL, 6.0):
            return False
        return True
    step = 5.5
    y, row = WOODS_Y[0] + 1.0, 0
    while y < WOODS_Y[1]:
        x = WOODS_X[0] + (step / 2 if row % 2 else 0.0)
        while x < WOODS_X[1]:
            px, py = x + rng.uniform(-1.3, 1.3), y + rng.uniform(-1.3, 1.3)
            if ok(px, py):
                h = rng.random()
                out.append(('banyan' if h < 0.84 else 'kapok' if h < 0.95 else 'palm', px, py, KERB + 0.03, rng.uniform(0.9, 1.3)))
            x += step
        y += step * 0.87
        row += 1
    nw = len(out)
    # the forecourt: rows of trees in square planters (the satellite's grid)
    for gx, gy in planters():
        out.append(('banyan', gx, gy, KERB + 0.4, rng.uniform(0.75, 0.9)))
    log('trees: %d in the woods, %d on the forecourt' % (nw, len(out) - nw))
    return out


def planters():
    """The forecourt's tree planters: an 8 m grid, clear of the mall's north well, the APM exits and the axis walk."""
    import gz_metro, gz_mall
    fx0, fy0, fx1, fy1 = PAVE[0][1]
    out = []
    for gx in range(int(fx0) + 4, int(fx1) - 2, 8):
        for gy in (142.0, 152.0, 162.0, 171.0):
            if gz_metro.blocked(gx, gy, 4.0) or _in_rect(gx, gy, gz_mall.WELL, 4.0) or abs(gx + 3.0) < 3.0:
                continue
            out.append((float(gx), gy))
    return out


def lamps(free):
    """[(x, y, z, yaw)]: masts along the fountain walks every 30 m and the court's side walks."""
    out = []
    for x, yaw in ((-15.4, 0.0), (15.4, math.pi)):
        for y in range(262, 344, 30):
            if free(x, y):
                out.append((x, float(y), KERB, yaw))
    for x, yaw in ((-23.4, 0.0), (17.4, math.pi)):
        for y in (186.0, 222.0):
            if free(x, y):
                out.append((x, y, KERB, yaw))
    return out


# ------------------------------------------------------------------ build
def build(P, H, cut_col, apply_boolean, col):
    """Into gz_huacheng's Parts: paving (booleaned against the city's cutters), the north court, the fountain, benches.
    Returns the json record."""
    SEATS.clear(); SIGNS.clear()
    M = P.M
    M['terrace lawn'] = gm.plain('GZ Huacheng | terrace lawn', (0.20, 0.36, 0.12), rough=0.9)
    M['north floor'] = gm.plain('GZ Huacheng | north court stone', (0.62, 0.58, 0.52), rough=0.6)
    M['basin'] = gm.plain('GZ Huacheng | fountain basin', (0.08, 0.10, 0.11), rough=0.5)
    M['nozzle'] = gm.plain('GZ Huacheng | fountain nozzle', (0.55, 0.56, 0.58), rough=0.3, metal=0.9)
    _paving(M, cut_col, apply_boolean, col)
    walls = _court(P, H)
    nozzles = _fountain(P)
    _benches(P)
    for gx, gy in planters():                   # the forecourt's tree planters (stone, 0.4 m)
        P.box('coping', gx - 1.1, gy - 1.1, KERB, gx + 1.1, gy + 1.1, KERB + 0.4)
        P.box('green', gx - 0.95, gy - 0.95, KERB + 0.38, gx + 0.95, gy + 0.95, KERB + 0.42)
    log('north court %d m of shopfront, fountain %d nozzles, %d seats' % (sum(math.dist(w['a'], w['b']) for w in walls), len(nozzles), len(SEATS)))
    return {'rect': list(NCOURT), 'z': Z, 'terraces_y1': NTERR_Y1, 'stair': list(NSTAIR), 'walls': walls,
            'fountain': {'basin': list(BASIN), 'water_z': WATER_Z, 'rim_h': RIM_H, 'nozzles': nozzles},
            'pave': [r for _, r in PAVE], 'planters': [list(p) for p in planters()]}


def _paving(M, cut_col, apply_boolean, col):
    for name, r in PAVE:
        bm = bmesh.new()
        uv = bm.loops.layers.uv.new('UVMap')
        c.extrude_polygon(bm, rr(r), [], -0.05, KERB + 0.006, top=True, bottom=True, uv=uv)
        c.weld(bm)                                       # a closed prism, or Manifold refuses it (and cuts nothing)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        o = c.obj_from_bmesh('Huacheng | north paving %s' % name, bm, None, col)
        apply_boolean(o, cut_col, solver='MANIFOLD')
        o.data.materials.clear()
        o.data.materials.append(M['plaza'])
        me = o.data
        b2 = bmesh.new(); b2.from_mesh(me)
        bmesh.ops.delete(b2, geom=[f for f in b2.faces if f.normal.z < 0.7], context='FACES')
        lay = b2.loops.layers.uv.active or b2.loops.layers.uv.new('UVMap')
        for f in b2.faces:
            for lp in f.loops:
                lp[lay].uv = (lp.vert.co.x, lp.vert.co.y)
        b2.to_mesh(me); b2.free()


def _court(P, H):
    """The north court: turf-and-stone terraces down from the south edge (every other row turf), a stair down the
    middle with landings and handrails, shops on three sides (the north wall's middle bay the mall's portal), stone
    coping and glass round the rim. Seats on the turf rows face north, toward the fountain."""
    x0, y0, x1, y1 = NCOURT
    top = KERB
    P.box('north floor', x0, NTERR_Y1 - 0.01, Z - 0.4, x1, y1, Z)
    run = (NTERR_Y1 - y0) / NROWS
    rise = (top - Z) / NROWS
    s0, s1 = NSTAIR
    for side in ((x0, s0 - 0.6), (s1 + 0.6, x1)):
        for k in range(NROWS):
            ya, yb = y0 + k * run, y0 + (k + 1) * run
            zt = top - (k + 1) * rise
            P.box('steps', side[0], ya, Z - 0.2, side[1], yb, zt)
            if k % 2 == 1 and k < NROWS - 1:
                P.box('terrace lawn', side[0] + 0.05, ya + 0.02, zt, side[1] - 0.05, yb - 0.25, zt + 0.06)
                for sx in range(int(side[0] + 1.2), int(side[1] - 0.8), 2):
                    SEATS.append({'p': [float(sx) + 0.4, round(ya + 0.75, 2), round(zt + 0.06, 3)], 'f': [0.0, 1.0], 'terrace': True})
    P.box('stair', s0, y0 - 0.3, top - 0.4, s1, y0 + 0.6, top)
    steps, landings = 40, (13, 26)
    tread = (NTERR_Y1 - y0 - 2 * 1.8 - 0.6) / steps
    y, z = y0 + 0.6, top
    for k in range(steps):
        z -= (top - Z) / steps
        P.box('stair', s0, y, Z - 0.2, s1, y + tread, z)
        y += tread
        if k + 1 in landings:
            P.box('stair', s0, y, Z - 0.2, s1, y + 1.8, z)
            y += 1.8
    for sx in (s0 - 0.6, s1):
        H._sloped_wall(P, 'coping', sx, sx + 0.6, y0, NTERR_Y1, top + 0.45, Z + 0.45)
        H._rail(P, (sx + 0.3, y0), (sx + 0.3, NTERR_Y1), lambda t: top + 1.35 - t * (top - Z), 'steel')
    # the walk down (collision only)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((s0, y0 - 0.5, top), (s1, y0 - 0.5, top), (s1, NTERR_Y1 + 0.2, Z), (s0, NTERR_Y1 + 0.2, Z))]
    bm.faces.new(vs)
    o = c.obj_from_bmesh('Collision | north stair ramp', bm, None, bpy.data.collections.get('_collision proxies'))
    o.hide_render = True
    # shop walls round the U, the stone walls above the terraces
    walls_ = [((x0, NTERR_Y1), (x0, y1)), ((x0, y1), (x1, y1)), ((x1, y1), (x1, NTERR_Y1))]
    walls, u = [], 0.0
    for a, b in walls_:
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        P.quad('shops', [(a[0], a[1], Z), (b[0], b[1], Z), (b[0], b[1], top), (a[0], a[1], top)],
               [(u, 0.0), (u + L, 0.0), (u + L, top - Z), (u, top - Z)])
        walls.append({'a': list(a), 'b': list(b), 'u0': u})
        u += L
    P.quad('coping', [(x0, y0, Z), (x0, NTERR_Y1, Z), (x0, NTERR_Y1, top), (x0, y0, top)])
    P.quad('coping', [(x1, NTERR_Y1, Z), (x1, y0, Z), (x1, y0, top), (x1, NTERR_Y1, top)])
    SIGNS.extend(H._shopfronts(P, walls, z0=Z, h=6.0, portals=(39.0,)))
    cw = 0.45
    P.box('coping', x0 - cw, y0, top - 0.2, x0, y1 + cw, top + 0.12)
    P.box('coping', x1, y0, top - 0.2, x1 + cw, y1 + cw, top + 0.12)
    P.box('coping', x0 - cw, y1, top - 0.2, x1 + cw, y1 + cw, top + 0.12)
    for a, b in (((x0 - cw / 2, y0), (x0 - cw / 2, y1 + cw / 2)), ((x0 - cw / 2, y1 + cw / 2), (x1 + cw / 2, y1 + cw / 2)),
                 ((x1 + cw / 2, y1 + cw / 2), (x1 + cw / 2, y0))):
        H._balustrade(P, a, b, top + 0.12)
    for xa, xb in ((x0 - cw / 2, s0 - 0.6), (s1 + 0.6, x1 + cw / 2)):
        P.box('coping', xa, y0 - 0.3, top - 0.2, xb, y0, top + 0.12)
        H._balustrade(P, (xa, y0 - 0.15), (xb, y0 - 0.15), top + 0.12)
    # planters and two benches on the floor
    for px in (x0 + 2.0, x1 - 2.0):
        P.box('coping', px - 0.8, y1 - 2.4, Z, px + 0.8, y1 - 0.8, Z + 0.6)
        bm_ = P.bm('green')
        bmesh.ops.create_icosphere(bm_, subdivisions=2, radius=0.75, matrix=__import__('mathutils').Matrix.Translation((px, y1 - 1.6, Z + 0.95)))
    return walls


def _fountain(P):
    """The basin: dark tiled floor, a stone rim to sit on, the water surface (an object of its own: the web's water),
    the nozzles. Returns [[x, y, kind, lean x]] for the web's shows."""
    x0, y0, x1, y1 = BASIN
    P.box('basin', x0, y0, FLOOR_B - 0.3, x1, y1, FLOOR_B)
    # inner walls (dark), the rim
    for q in ([(x0, y0, FLOOR_B), (x0, y1, FLOOR_B), (x0, y1, KERB + RIM_H), (x0, y0, KERB + RIM_H)],
              [(x1, y1, FLOOR_B), (x1, y0, FLOOR_B), (x1, y0, KERB + RIM_H), (x1, y1, KERB + RIM_H)],
              [(x1, y0, FLOOR_B), (x0, y0, FLOOR_B), (x0, y0, KERB + RIM_H), (x1, y0, KERB + RIM_H)],
              [(x0, y1, FLOOR_B), (x1, y1, FLOOR_B), (x1, y1, KERB + RIM_H), (x0, y1, KERB + RIM_H)]):
        P.quad('basin', q)
    for bx in ((x0 - RIM_W, y0 - RIM_W, x0, y1 + RIM_W), (x1, y0 - RIM_W, x1 + RIM_W, y1 + RIM_W),
               (x0, y0 - RIM_W, x1, y0), (x0, y1, x1, y1 + RIM_W)):
        P.box('coping', bx[0], bx[1], KERB - 0.1, bx[2], bx[3], KERB + RIM_H)
    # the water surface
    bm = bmesh.new()
    c.fill_polygon(bm, rr(BASIN), [], WATER_Z)
    import gz_materials as gm_
    col = bpy.data.collections.get('15 • Huacheng Square')
    c.obj_from_bmesh('Water | music fountain', bm, gm_.ground_mats()['pond'], col)
    # nozzles
    nz = []
    for k in range(15):                                    # the tall jets down the middle
        nz.append([0.0, y0 + 3.0 + k * 6.0, 'tall', 0.0])
    for x in (-4.5, 4.5):                                  # mid jets
        for k in range(29):
            nz.append([x, y0 + 3.0 + k * 3.0, 'mid', 0.0])
    for x, lean in ((-8.6, 1.0), (8.6, -1.0)):             # arching jets leaning in over the middle
        for k in range(20):
            nz.append([x, y0 + 4.5 + k * 4.4, 'arc', lean])
    for y in (y0 + 1.2, y1 - 1.2):                         # foggers across the ends
        for k in range(9):
            nz.append([x0 + 2.2 + k * (x1 - x0 - 4.4) / 8, y, 'fog', 0.0])
    for x, y, kind, lean in nz:
        r = 0.16 if kind == 'tall' else 0.09
        P.box('nozzle', x - r, y - r, FLOOR_B, x + r, y + r, WATER_Z - 0.02)
    return [[round(x, 2), round(y, 2), k, lean] for x, y, k, lean in nz]


def _benches(P):
    """Benches on the fountain walks facing the water (every 12 m), and on the square at its north end."""
    for x, face in ((-15.0, 1.0), (15.0, -1.0)):
        for y in range(260, 344, 12):
            yb = float(y) + 6.0
            P.box('wood', x - 0.25, yb - 1.1, KERB + 0.42, x + 0.25, yb + 1.1, KERB + 0.48)
            for dy in (-0.8, 0.8):
                P.box('coping', x - 0.25, yb + dy - 0.15, KERB, x + 0.25, yb + dy + 0.15, KERB + 0.42)
            P.box('wood', x - face * 0.22 - 0.03, yb - 1.1, KERB + 0.48, x - face * 0.22 + 0.03, yb + 1.1, KERB + 0.9)
            for dy in (-0.55, 0.55):
                SEATS.append({'p': [round(x + face * 0.04, 2), round(yb + dy, 2), round(KERB + 0.48, 3)], 'f': [face, 0.0]})


def walk_lines():
    """[(points, z_start, z_end)]: the court's stair and a loop in it, the walks either side of the court and the
    fountain, the square at its north end, joined to the forecourt."""
    x0, y0, x1, y1 = NCOURT
    sx = (NSTAIR[0] + NSTAIR[1]) / 2
    top, foot = (sx, y0 - 4.0), (sx, NTERR_Y1 + 0.5)
    ry = NTERR_Y1 + 3.0
    a, b, c_, d = (x0 + 1.6, ry), (x0 + 1.6, y1 - 3.4), (x1 - 1.6, y1 - 3.4), (x1 - 1.6, ry)
    m = (sx, ry)
    wl, wr = -21.0, 15.0                   # the court's side walks
    fl, fr = -13.5, 13.5                   # the fountain walks
    sq = 354.0
    return [
        ([top, foot], KERB, Z), ([foot, m], Z, Z), ([m, a], Z, Z), ([a, b], Z, Z), ([b, c_], Z, Z), ([c_, d], Z, Z), ([d, m], Z, Z),
        ([(sx, 172.0), top], KERB, KERB),
        ([(wl, 172.0), (wl, 250.0)], KERB, KERB), ([(wr, 172.0), (wr, 250.0)], KERB, KERB),
        ([(wl, 250.0), (fl, 250.0)], KERB, KERB), ([(wr, 250.0), (fr, 250.0)], KERB, KERB), ([(fl, 250.0), (fr, 250.0)], KERB, KERB),
        ([(fl, 250.0), (fl, sq)], KERB, KERB), ([(fr, 250.0), (fr, sq)], KERB, KERB), ([(fl, sq), (fr, sq)], KERB, KERB),
        ([(wl, 172.0), (sx, 172.0)], KERB, KERB), ([(sx, 172.0), (wr, 172.0)], KERB, KERB),
    ]
