"""花城汇 B1, phase 2: the way in from the sunken court, through to the APM 花城大道 concourse, and the middle zone's
shopping street, after the Commons set "2024 in Mall of the World" (the corridor: polished pale floor with grey bands,
white strip-aluminium ceiling with timber-grain grille bands and downlights, black hanging signs with white text,
lightbox columns with posters, shops both sides; the station: the APM concourse opens straight off the mall).

    vestibule  the court's north portal (the bronze 花城汇 bay, now standing open) -> 2.3 m -> a door in the station
               box's south wall, into the concourse's unpaid south end (gz_apm_build cuts the door: apm_doors())
    link       the court's north-west bay on its west wall -> 5.7 m west -> the corridor
    corridor   x -36.3..-26.7 (9.6 m), y 76..148, ceiling 4.6 m: twelve 6 m shop bays a side (facade family
               'mall interior': lit shops, interiors), the link and a cross door into the concourse's north free end
               on the east side, a feature wall at the south end, an escalator well up to the park at the north end
               (the street at y 166; its collision is a ramp, like the court's stair)

Everything sits at the court's floor level (gz_huacheng.COURT_Z = the APM concourse floor). The rooms are cut from
the ground slab (ground_cutters) and the river plane (water_holes). The geometry joins the city's ground group and
collision (export_web takes 'Huacheng | mall *'); the web draws the signs, posters and the directory board from
huacheng.json 'mall'.
"""
import math

import bmesh
import bpy

import gz_common as c
import gz_materials as gm

Z = -5.85                                  # = gz_huacheng.COURT_Z = gz_apm.CONC_Z
KERB = 0.15
H_HALL = 4.6                               # corridor clear height
H_LOW = 3.6                                # vestibule, link and cross door
CORR = (-36.3, 76.0, -26.7, 148.0)         # x0, y0, x1, y1 (interior faces): 12 bays a side, the openings on bay lines
LINK = (-26.7, 82.4, -21.0, 87.6)          # court west wall bay u 36..42 -> corridor
VEST = (-8.55, 88.0, -3.45, 90.3)          # court north portal (bay u 54..60) -> concourse south door
SDOOR = (-8.0, -4.9)                       # x span of the door into the concourse (stub y 90.3 .. 91.3)
XLINK = (-26.7, 136.35, -24.6, 141.65)     # east wall bay y 136..142 -> the concourse's west door (stub x -24.6 .. -23.4)
XBAY = (136.0, 142.0)
WELL = (-34.0, 148.0, -29.0, 164.0)        # escalators to the park, street end north
BAY = 6.0
GATE = []                                  # the north gateway's sign face (filled by _north_well)
LINK_U = 39.0                              # court bay centres (gz_huacheng walls' u): the link, the portal
PORTAL_U = 57.0


def log(*a):
    print('[mall]', *a, flush=True)


# ------------------------------------------------------------------ plan
def rooms():
    """[(x0, y0, x1, y1, z1)] interior rectangles (floor at Z) and their ceiling heights."""
    return [(*CORR, Z + H_HALL), (*LINK, Z + H_LOW), (*VEST, Z + H_LOW), (*XLINK, Z + H_LOW)]


def ground_cutters():
    """[(ring, z0, z1)]: the rooms 0.3 m proud (walls stand inside the cut, as at the court), the escalator well
    open to the sky."""
    out = []
    for x0, y0, x1, y1, z1 in rooms():
        out.append(([(x0 - 0.3, y0 - 0.3), (x1 + 0.3, y0 - 0.3), (x1 + 0.3, y1 + 0.3), (x0 - 0.3, y1 + 0.3)], Z - 0.6, z1 + 0.35))
    x0, y0, x1, y1 = WELL
    out.append(([(x0 - 0.3, y0 - 0.3), (x1 + 0.3, y0 - 0.3), (x1 + 0.3, y1 + 0.3), (x0 - 0.3, y1 + 0.3)], Z - 0.6, 3.0))
    # the doorways through to the station box (its own cutter stops 0.3 m out from its walls: a sliver stood in the
    # cross door)
    out += [(ring, Z - 0.6, Z + 3.3) for ring, _ in apm_doors()]
    return out


def water_holes():
    """Clockwise rings (gz_city's river plane at -2.8 runs through every room): kept 5 cm apart from each other and
    from the court's hole, which a tessellator wants."""
    def ring(x0, y0, x1, y1):
        return [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
    cx0, cy0, cx1, cy1 = CORR
    out = [ring(cx0 - 0.3, cy0 - 0.3, cx1 + 0.25, cy1 - 0.05)]
    out.append(ring(LINK[0] + 0.3, LINK[1] - 0.3, LINK[2] - 0.35, LINK[3] + 0.3))         # court hole: x0 - 0.3
    out.append(ring(VEST[0] - 0.3, VEST[1] + 0.35, VEST[2] + 0.3, VEST[3] + 0.05))        # court hole: y1 + 0.3
    out.append(ring(XLINK[0] + 0.3, XLINK[1] - 0.3, XLINK[2] - 0.05, XLINK[3] + 0.3))
    x0, y0, x1, y1 = WELL
    out.append(ring(x0 - 0.3, y0 + 0.0, x1 + 0.3, y1 + 0.3))
    return out


def apm_doors():
    """Prisms gz_apm_build unions into the 花城大道 station's shell, and the face of each to delete (the doorway):
    [(ring CCW, (axis, value, lo, hi))] -- the face at axis = value spanning lo..hi on the other axis."""
    sx0, sx1 = SDOOR
    south = [(sx0, VEST[3]), (sx1, VEST[3]), (sx1, 91.3), (sx0, 91.3)]
    west = [(XLINK[2], XLINK[1] + 0.2), (-23.4, XLINK[1] + 0.2), (-23.4, XLINK[3] - 0.2), (XLINK[2], XLINK[3] - 0.2)]
    return [(south, ('y', VEST[3], sx0, sx1)), (west, ('x', XLINK[2], XLINK[1] + 0.2, XLINK[3] - 0.2))]


def court_openings():
    """The court's wall openings (gz_huacheng splits its shop walls round them): {bay u: (lo, hi)} along the wall,
    height H_LOW above the court floor."""
    return {LINK_U: (LINK[1], LINK[3]), PORTAL_U: (VEST[0], VEST[2])}


# ------------------------------------------------------------------ materials
def mats(M):
    M['mall floor'] = gm.plain('GZ Mall | floor tile', (0.80, 0.77, 0.70), rough=0.2)
    M['mall ceiling'] = gm.plain('GZ Mall | ceiling grille', (0.90, 0.90, 0.88), rough=0.6)
    M['mall stone'] = gm.plain('GZ Mall | wall stone', (0.80, 0.76, 0.68), rough=0.45)
    M['mall plaster'] = gm.plain('GZ Mall | bulkhead plaster', (0.90, 0.90, 0.88), rough=0.8)
    M['mall dark'] = gm.plain('GZ Mall | sign box', (0.05, 0.05, 0.06), rough=0.4, metal=0.4)
    M['mall glass'] = c.mat('GZ Mall | door glass', (0.62, 0.72, 0.74), 0.03, 0.1, alpha=0.2)
    M['mall shops'] = gm.facade('GZ Facade | mall interior', wall=(0.80, 0.76, 0.68), glass=(0.08, 0.10, 0.11),
                                roof=(0.5, 0.5, 0.5), floor_h=H_HALL, bay=BAY, win_w=0.86, sill=0.0, head=0.82,
                                glass_rough=0.05, glass_metal=0.3, gf_h=H_HALL, lit=0.95, warm=0.55, lit_k=4.0)
    return M


# ------------------------------------------------------------------ build
def build(P, H):
    """Into gz_huacheng's Parts `P` (H = gz_huacheng): the rooms, the shopfronts, the fittings. Returns
    (shop walls for huacheng.json, sign boxes, the 'mall' record: hanging signs, posters, directory, benches)."""
    mats(P.M)
    signs = []
    _floors_and_ceilings(P)
    walls = _walls(P)
    signs += H._shopfronts(P, walls, z0=Z, h=H_HALL)
    rec = _fittings(P)
    _north_well(P, H)
    signs += GATE
    log('corridor %d m, %d shop walls, %d sign boxes, %d hanging signs, %d posters' % (
        CORR[3] - CORR[1], len(walls), len(signs), len(rec['hang']), len(rec['posters'])))
    return walls, signs, rec


def _floors_and_ceilings(P):
    for x0, y0, x1, y1, z1 in rooms():
        P.box('mall floor', x0 - 0.05, y0 - 0.05, Z - 0.4, x1 + 0.05, y1 + 0.05, Z)
        # ceilings face down
        key = 'mall ceiling' if z1 > Z + H_HALL - 0.1 else 'mall plaster'
        P.quad(key, [(x0, y0, z1), (x0, y1, z1), (x1, y1, z1), (x1, y0, z1)], [(x0, y0), (x0, y1), (x1, y1), (x1, y0)])
    # the escalator well's floor where it meets the corridor
    x0, y0, x1, y1 = WELL
    P.box('mall floor', x0, y0 - 0.05, Z - 0.4, x1, y0 + 1.6, Z)


def _wq(P, key, a, b, z0, z1, u0=0.0, inward=None):
    """A vertical wall quad from a to b (Blender xy), z0..z1, facing to the right of a -> b (or `inward` flips)."""
    (ax, ay), (bx, by) = a, b
    L = math.hypot(bx - ax, by - ay)
    pts = [(ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1)]
    uvs = [(u0, z0 - Z), (u0 + L, z0 - Z), (u0 + L, z1 - Z), (u0, z1 - Z)]
    if inward:
        pts, uvs = pts[::-1], uvs[::-1]
    P.quad(key, pts, uvs)


def _walls(P):
    """Shop walls round the corridor (facade 'mall interior', faces into the corridor) and the stone walls of the small
    rooms. Returns the shop walls [{a, b, u0}] (the court's convention: the corridor on the right of a -> b)."""
    x0, y0, x1, y1 = CORR
    zt = Z + H_HALL
    shops = []
    def shop(a, b, u0):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        P.quad('mall shops', [(a[0], a[1], Z), (b[0], b[1], Z), (b[0], b[1], zt), (a[0], a[1], zt)],
               [(u0, 0.0), (u0 + L, 0.0), (u0 + L, H_HALL), (u0, H_HALL)])
        shops.append({'a': list(a), 'b': list(b), 'u0': u0})
    # west wall, south -> north (the corridor on its right = east)
    shop((x0, y0), (x0, y1), 0.0)
    # east wall, north -> south in three runs round the cross door and the link (both a whole bay); the facade's u
    # carries on round, so the bay lines stay on 6 m
    L0 = y1 - y0
    lb0, lb1 = LINK[1] - 0.4, LINK[3] + 0.4                       # the link's bay: y 82..88
    shop((x1, y1), (x1, XBAY[1]), L0)
    shop((x1, XBAY[0]), (x1, lb1), L0 + y1 - XBAY[0])
    shop((x1, lb0), (x1, y0), L0 + y1 - lb0)
    # the headers over the openings (door height up to the corridor ceiling) and the returns beside the narrower rooms
    for ya, yb, ra, rb in ((lb0, lb1, LINK[1], LINK[3]), (XBAY[0], XBAY[1], XLINK[1], XLINK[3])):
        _wq(P, 'mall plaster', (x1, ya), (x1, yb), Z + H_LOW, zt, inward=True)
        _wq(P, 'mall stone', (x1, ya), (x1, ra), Z, Z + H_LOW, inward=True)
        _wq(P, 'mall stone', (x1, rb), (x1, yb), Z, Z + H_LOW, inward=True)
    # the south end: a stone feature wall (the LED screen on it is the web's)
    _wq(P, 'mall stone', (x1, y0), (x0, y0), Z, zt)
    # the north end: stone either side of the well opening, a header over it up to the street
    wx0, _, wx1, _ = WELL
    _wq(P, 'mall stone', (x0, y1), (wx0, y1), Z, zt)
    _wq(P, 'mall stone', (wx1, y1), (x1, y1), Z, zt)
    _wq(P, 'mall stone', (wx0, y1), (wx1, y1), zt, KERB, inward=True)            # faces the well
    # link, vestibule, cross door: stone side walls; the vestibule's north wall round the concourse door
    lx0, ly0, lx1, ly1 = LINK
    _wq(P, 'mall stone', (lx0, ly0), (lx1, ly0), Z, Z + H_LOW, inward=True)
    _wq(P, 'mall stone', (lx0, ly1), (lx1, ly1), Z, Z + H_LOW)
    vx0, vy0, vx1, vy1 = VEST
    _wq(P, 'mall stone', (vx0, vy0), (vx0, vy1), Z, Z + H_LOW)
    _wq(P, 'mall stone', (vx1, vy0), (vx1, vy1), Z, Z + H_LOW, inward=True)
    sx0, sx1 = SDOOR
    _wq(P, 'mall stone', (vx0, vy1), (sx0, vy1), Z, Z + H_LOW)
    _wq(P, 'mall stone', (sx1, vy1), (vx1, vy1), Z, Z + H_LOW)
    _wq(P, 'mall stone', (sx0, vy1), (sx1, vy1), Z + 3.0, Z + H_LOW)              # the door's head (3 m)
    ax0, ay0, ax1, ay1 = XLINK
    _wq(P, 'mall stone', (ax0, ay0), (ax1, ay0), Z, Z + H_LOW, inward=True)
    _wq(P, 'mall stone', (ax0, ay1), (ax1, ay1), Z, Z + H_LOW)
    # door frames: stainless reveals round the concourse doors, a dark threshold
    for (xa, ya, xb, yb) in ((sx0, vy1 - 0.12, sx0 + 0.12, vy1), (sx1 - 0.12, vy1 - 0.12, sx1, vy1)):
        P.box('steel', xa, ya, Z, xb, yb, Z + 3.0)
    P.box('steel', sx0, vy1 - 0.12, Z + 2.92, sx1, vy1, Z + 3.0)
    P.box('kick', sx0, vy1 - 0.4, Z - 0.02, sx1, vy1 + 0.4, Z + 0.004)
    return shops


def _fittings(P):
    """Lightbox columns down the middle, hanging signs, benches and planters, the directory board, the feature wall's
    screen frame. Returns their faces for the web."""
    x0, y0, x1, y1 = CORR
    mx = (x0 + x1) / 2
    rec = {'hang': [], 'posters': [], 'directory': None, 'screen': None, 'benches': [], 'rect': list(CORR), 'z': Z, 'h': H_HALL,
           'vest': list(VEST), 'link': list(LINK), 'xlink': list(XLINK), 'well': list(WELL), 'sdoor': list(SDOOR)}
    # columns (0.7 m, stone) with a poster lightbox on each long face, every 18 m
    for k, y in enumerate((96.0, 114.0, 132.0)):
        P.box('mall stone', mx - 0.35, y - 0.35, Z, mx + 0.35, y + 0.35, Z + H_HALL)
        for s in (-1, 1):
            ya, yb = sorted((y + s * 0.35, y + s * 0.41))
            P.box('mall dark', mx - 0.45, ya, Z + 0.5, mx + 0.45, yb, Z + 2.5)
            rec['posters'].append({'c': [mx, y + s * 0.415, Z + 1.5], 'n': [0.0, float(s)], 'w': 0.8, 'h': 1.8, 'i': k * 2 + (s > 0)})
        # planters either side of the column
        for dx in (-1.6, 1.6):
            P.box('coping', mx + dx - 0.45, y - 0.45, Z, mx + dx + 0.45, y + 0.45, Z + 0.55)
            bm_ = P.bm('green')
            bmesh.ops.create_icosphere(bm_, subdivisions=2, radius=0.48, matrix=__import__('mathutils').Matrix.Translation((mx + dx, y, Z + 0.85)))
    # benches between the columns (timber on stone), seats both sides
    for y in (105.0, 123.0, 139.0):
        P.box('wood', mx - 1.3, y - 0.3, Z + 0.42, mx + 1.3, y + 0.3, Z + 0.48)
        for ex in (-1.0, 1.0):
            P.box('coping', mx + ex - 0.2, y - 0.3, Z, mx + ex + 0.2, y + 0.3, Z + 0.42)
        for s in (-1, 1):
            for dx in (-0.6, 0.6):
                rec['benches'].append({'p': [round(mx + dx, 2), round(y + s * 0.12, 2), round(Z + 0.48, 3)], 'f': [0.0, float(s)]})
    # hanging signs: black boxes on rods across the middle, both faces lettered (the web)
    for y, txt in ((80.0, 'south'), (110.0, 'mid'), (144.0, 'north')):
        P.box('mall dark', mx - 1.7, y - 0.08, Z + 3.45, mx + 1.7, y + 0.08, Z + 3.95)
        for dx in (-1.4, 1.4):
            P.box('steel', mx + dx - 0.015, y - 0.015, Z + 3.95, mx + dx + 0.015, y + 0.015, Z + H_HALL)
        for s in (-1, 1):
            rec['hang'].append({'c': [mx, y + s * 0.085, Z + 3.7], 'n': [0.0, float(s)], 'w': 3.3, 'h': 0.44, 'k': txt})
    # the directory board by the link (a lit map on a dark frame), facing the link
    dx_, dy_ = x1 - 1.2, LINK[3] + 1.6
    P.box('mall dark', dx_ - 0.75, dy_ - 0.1, Z, dx_ + 0.75, dy_ + 0.1, Z + 2.3)
    rec['directory'] = {'c': [dx_, dy_ - 0.105, Z + 1.3], 'n': [0.0, -1.0], 'w': 1.3, 'h': 1.8}
    # the south end's LED screen (the web plays the mall's ads on it)
    P.box('mall dark', x0 + 1.0, y0, Z + 0.9, x1 - 1.0, y0 + 0.12, Z + 4.2)
    rec['screen'] = {'c': [mx, y0 + 0.125, Z + 2.55], 'n': [0.0, 1.0], 'w': x1 - x0 - 2.3, 'h': 3.1}
    return rec


def _north_well(P, H):
    """The escalators up to the park at the north end: an open well (stone walls), two escalators climbing north to
    the street, a ramp proxy for walking them, glass round the top, a small membrane cushion over it."""
    x0, y0, x1, y1 = WELL
    top = KERB
    # walls into the well (above the corridor's ceiling at its south end: the header is _walls')
    for q in ([(x0, y0, Z), (x0, y0, top), (x0, y1, top), (x0, y1, Z)],
              [(x1, y1, Z), (x1, y1, top), (x1, y0, top), (x1, y0, Z)],
              [(x0, y1, Z), (x0, y1, top), (x1, y1, top), (x1, y1, Z)]):
        P.quad('mall stone', list(reversed(q)))
    P.box('mall floor', x0, y0, Z - 0.4, x1, y1, Z)
    # two escalators from the corridor floor (south) up to the street (north), 30 degrees
    run = (top - Z) / math.tan(math.radians(30))
    ya, yb = y0 + 1.6, y0 + 1.6 + run
    w = (x1 - x0 - 0.6) / 2
    for i in range(2):
        ex0 = x0 + 0.2 + i * (w + 0.2)
        ex1 = ex0 + w
        b_ = P.bm('escalator')
        pts = [(ex0, ya, Z + 0.05), (ex1, ya, Z + 0.05), (ex1, yb, top - 0.05), (ex0, yb, top - 0.05)]
        b_.faces.new([b_.verts.new(p) for p in pts])
        b_.faces.new([b_.verts.new((p[0], p[1], p[2] - 0.9)) for p in reversed(pts)])
        for xs in (ex0, ex1):
            P.quad('glass', [(xs, ya, Z + 0.95), (xs, yb, top + 0.9), (xs, yb, top - 0.05), (xs, ya, Z + 0.05)])
            H._rail(P, (xs, ya), (xs, yb), lambda t: Z + 0.95 + t * (top - Z), 'dark', r=0.04, n=8)
    # landing at the top, out to the park
    P.box('mall floor', x0, yb, top - 0.4, x1, y1, top)
    # stone rim, glass on three sides at the top (the north side is the way off)
    for bx in ((x0 - 0.45, y0 - 0.45, x0, y1 + 0.45), (x1, y0 - 0.45, x1 + 0.45, y1 + 0.45), (x0, y0 - 0.45, x1, y0)):
        P.box('coping', bx[0], bx[1], top - 0.2, bx[2], bx[3], top + 0.04)
    H._balustrade(P, (x0 - 0.2, y0 - 0.2), (x1 + 0.2, y0 - 0.2), top)
    H._balustrade(P, (x0 - 0.2, y0 - 0.2), (x0 - 0.2, yb), top)
    H._balustrade(P, (x1 + 0.2, yb), (x1 + 0.2, y0 - 0.2), top)
    # the top: a granite apron in the lawn round the well, a gateway over the way off with the mall's gold lettering
    # facing the park (the web letters it), and a small membrane cloud over the escalators like the court's
    for bx in ((x0 - 3.5, y0 - 3.5, x0 - 0.45, y1 + 4.0), (x1 + 0.45, y0 - 3.5, x1 + 3.5, y1 + 4.0),
               (x0 - 0.45, y0 - 3.5, x1 + 0.45, y0 - 0.45), (x0 - 0.45, y1 + 0.45, x1 + 0.45, y1 + 4.0)):
        P.box('plaza', bx[0], bx[1], top - 0.1, bx[2], bx[3], top + 0.05)
    gy = y1 + 1.2
    for gx in (x0 - 0.6, x1 + 0.6):
        P.box('frame', gx - 0.2, gy - 0.2, top, gx + 0.2, gy + 0.2, top + 3.6)
    P.box('frame', x0 - 0.8, gy - 0.25, top + 3.2, x1 + 0.8, gy + 0.25, top + 4.0)
    GATE.clear()
    GATE.append({'c': [(x0 + x1) / 2, gy + 0.26, top + 3.6], 'n': [0.0, 1.0], 'w': 5.4, 'h': 0.76, 'entrance': True})
    H._canopy(P, (x0 + x1) / 2, (y0 + y1) / 2 + 2.0, 12.0, 14.0, lay=[(6.4, [(-2.6, -2.0, 4.0), (2.6, -1.6, 3.8), (0.0, 3.2, 4.4)])])
    # the walk up (collision only)
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((x0 + 0.2, y0 + 0.6, Z), (x1 - 0.2, y0 + 0.6, Z), (x1 - 0.2, yb + 0.3, top), (x0 + 0.2, yb + 0.3, top))]
    bm.faces.new(vs)
    proxies = bpy.data.collections.get('_collision proxies')
    o = c.obj_from_bmesh('Collision | mall north ramp', bm, None, proxies)
    o.hide_render = True


def walk_lines():
    """[(points, z_start, z_end)] for the crowd (gz_gameplay.walkways): the court's north-west corner through the link,
    down the corridor both sides of the columns, up the escalators to the park; the court portal to the concourse
    door stops at the vestibule (the station's people are the APM's)."""
    x0, y0, x1, y1 = CORR
    mx = (x0 + x1) / 2
    lane_w, lane_e = mx - 2.8, mx + 2.8
    ly = (LINK[1] + LINK[3]) / 2
    wx = WELL[0] + 0.2 + (WELL[2] - WELL[0] - 0.6) / 4     # up the west escalator (not the gap between the two)
    run = (KERB - Z) / math.tan(math.radians(30))
    return [
        ([(LINK[2] + 1.8, ly), (x1 - 1.5, ly)], Z, Z),
        ([(x1 - 1.5, ly), (lane_e, ly)], Z, Z),
        ([(lane_e, ly), (lane_e, y1 - 2.5)], Z, Z),
        ([(x1 - 1.5, ly), (lane_w, y0 + 2.5)], Z, Z),
        ([(lane_w, y0 + 2.5), (lane_w, y1 - 2.5)], Z, Z),
        ([(lane_w, y1 - 2.5), (wx, WELL[1] + 1.0)], Z, Z),
        ([(lane_e, y1 - 2.5), (wx, WELL[1] + 1.0)], Z, Z),
        ([(wx, WELL[1] + 1.0), (wx, WELL[1] + 1.6 + run + 1.0)], Z, KERB),
        ([(wx, WELL[1] + 1.6 + run + 1.0), (wx, WELL[3] + 3.0)], KERB, KERB),
    ]
