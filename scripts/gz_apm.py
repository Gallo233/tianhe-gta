"""Zhujiang New Town APM (珠江新城旅客自动输送系统) underground: the in-map part of the line, from OSM.

    tracks()      the two running lines (west = southbound, east = northbound), chained from the OSM ways,
                  resampled every metre, straightened along each platform so trains line up with the screen doors
    stations()    广州塔 (terminus) - 海心沙 - 大剧院 - 花城大道 - 妇儿中心 (the in-map short-turn terminus): centre
                  between the tracks at the OSM platforms, tangent (north), style (column finish from photographs)
    passages()    for every entrance of an APM station (gz_metro.exits), a corridor from the end of its hall to the
                  station concourse, routed by A* on a 1 m grid round the river and the other entrances
    apm_json()    everything the demo needs (tracks with heights, stations, passages, levels)

Levels (world z): the concourse is level with the entrance halls (gz_metro.FLOOR_Z) so passages are flat; the
platform is 6 m below; the running surface 1 m below the platform (APM 100 floor height); twin single-track box
tunnels, whose roofs pass under the Pearl River bed (-7 m) without a dip.

Station frame: u along the line (north), v across (west positive); tracks at v = +-TRACK_V, an island platform
between them. Data (c) OpenStreetMap contributors, ODbL.
"""
import heapq
import json
import math
import os

import gz_metro as MX

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KERB = MX.KERB

# ------------------------------------------------------------------ levels and sizes
CONC_Z = KERB + MX.FLOOR_Z          # concourse floor = entrance hall floor (-5.85)
CONC_H = 3.5                        # concourse clear height
PLAT_Z = CONC_Z - 6.0               # platform floor (-11.85)
PLAT_H = 4.0                        # platform clear height
RAIL_Z = PLAT_Z - 1.0               # running surface (-12.85)
TUNNEL_W, TUNNEL_H = 4.4, 4.6       # single-track box, inside
TRACK_V = 5.4                       # track centre from the station centre line (OSM: 10.8 m apart)
ISLAND_V = 4.0                      # half width of the island platform
PLAT_U = 20.5                       # half length of the platform (OSM 41 m)
PSD_U = 15.0                        # half length of the screen-door run (two-car train 25.6 m)
BOX_U = 32.0                        # half length of the station box (plant rooms at the ends)
BOX_V = TRACK_V + TUNNEL_W / 2      # inner face of the trackside walls
CONC_V = 10.0                       # half width of the concourse
STAIR_TOP = 1.0                     # u where the stair + escalator leave the concourse, heading south down to the platform
STAIR_OPEN = (-7.6, STAIR_TOP)      # u range of the opening in the concourse floor (headroom over the stair)
STAIR_FOOT = -11.7                  # u of the foot of the bank on the platform (landing included)
STAIR_X = 2.1                       # half width of the bank (stair west, escalator east)
PAID_U = (-16.0, 6.0)               # the paid area between the two gate lines; passages come in at the ends
PASSAGE_W = MX.HALL[1] - MX.HALL[0] # corridors as wide as the entrance halls (4 m)

# key, name, English, OSM platform centre (approx; snapped between the tracks), column style, terminus
STATIONS = [
    ('canton_tower', '广州塔', 'Canton Tower', (-87.0, -1245.0), 'white_round', 'south'),
    ('haixinsha', '海心沙', 'Haixinsha', (-51.0, -713.0), 'blue_square', None),
    ('opera', '大剧院', 'Opera House', (-18.5, -262.0), 'white_square', None),
    ('huacheng', '花城大道', 'Huacheng Avenue', (-14.0, 122.5), 'cream_round', None),
    ('fuer', '妇儿中心', "Fu'er Zhongxin", (-9.0, 555.5), 'pink_open', 'north'),
]
NORTH_END = 760.0                   # the modelled tunnels stop here (trains turn back beyond 妇儿中心, out of sight)
SOUTH_END = -1412.0                 # end of the turnback / yard stubs south of 广州塔

_CACHE = {}


def log(*a):
    print('[apm]', *a, flush=True)


def proj(lat, lon):
    return MX.proj(lat, lon)


# ------------------------------------------------------------------ tracks
def _ways():
    d = json.load(open(os.path.join(ROOT, 'data', 'osm', 'tianhe_core.json')))
    out = {}
    for e in d['elements']:
        t = e.get('tags', {})
        g = e.get('geometry')
        if g and t.get('railway') == 'light_rail' and t.get('tunnel') == 'yes':
            out[e['id']] = [proj(p['lat'], p['lon']) for p in g if p]
    return out


def _chain(ways, ids):
    """Join ways end to end (reversing as needed) in the order given."""
    pts = list(ways[ids[0]])
    for i in ids[1:]:
        w = ways[i]
        if math.dist(pts[-1], w[0]) < 1.0: pts += w[1:]
        elif math.dist(pts[-1], w[-1]) < 1.0: pts += w[::-1][1:]
        elif math.dist(pts[0], w[-1]) < 1.0: pts = w[:-1] + pts
        elif math.dist(pts[0], w[0]) < 1.0: pts = w[::-1][:-1] + pts
        else: raise ValueError('way %d does not connect' % i)
    return pts


def _resample(pts, step=1.0):
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + math.dist(a, b))
    out, i = [], 0
    s = 0.0
    while s <= cum[-1]:
        while i < len(cum) - 2 and cum[i + 1] < s:
            i += 1
        f = (s - cum[i]) / max(1e-9, cum[i + 1] - cum[i])
        a, b = pts[i], pts[i + 1]
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
        s += step
    return out


def _smooth(pts, k=6, passes=2):
    for _ in range(passes):
        q = []
        for i in range(len(pts)):
            a, b = max(0, i - k), min(len(pts), i + k + 1)
            q.append((sum(p[0] for p in pts[a:b]) / (b - a), sum(p[1] for p in pts[a:b]) / (b - a)))
        q[0], q[-1] = pts[0], pts[-1]
        pts = q
    return pts


def _raw_tracks():
    w = _ways()
    west = _chain(w, [620330289, 620358662, 984208236, 620358657])      # north -> south
    east = _chain(w, [620358654, 617780108, 984208235, 620358661])      # south -> north
    west = west[::-1]                                                    # both south -> north
    return [_smooth(_resample(west)), _smooth(_resample(east))]


def _nearest(pl, p):
    best, bi = 1e18, 0
    for i, q in enumerate(pl):
        d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2
        if d < best:
            best, bi = d, i
    return bi


def stations():
    if 'st' in _CACHE:
        return _CACHE['st']
    west, east = _raw_tracks()
    out = []
    for key, zh, en, c, style, term in STATIONS:
        iw, ie = _nearest(west, c), _nearest(east, c)
        pw, pe = west[iw], east[ie]
        cx, cy = (pw[0] + pe[0]) / 2, (pw[1] + pe[1]) / 2
        # tangent: along both tracks over +-25 m
        tx = (west[min(len(west) - 1, iw + 25)][0] - west[max(0, iw - 25)][0]) + (east[min(len(east) - 1, ie + 25)][0] - east[max(0, ie - 25)][0])
        ty = (west[min(len(west) - 1, iw + 25)][1] - west[max(0, iw - 25)][1]) + (east[min(len(east) - 1, ie + 25)][1] - east[max(0, ie - 25)][1])
        L = math.hypot(tx, ty)
        tx, ty = tx / L, ty / L
        out.append({'key': key, 'name': zh, 'en': en, 'x': round(cx, 3), 'y': round(cy, 3), 'tx': round(tx, 6), 'ty': round(ty, 6),
                    'yaw': round(math.atan2(-tx, ty), 6), 'style': style, 'terminus': term,
                    'spacing': round(math.dist(pw, pe), 2)})
    _CACHE['st'] = out
    return out


def frame(st, u, v, z=0.0):
    """Station frame (u north along the line, v west across) -> world (x, y, z)."""
    tx, ty = st['tx'], st['ty']
    nx, ny = -ty, tx
    return (st['x'] + tx * u + nx * v, st['y'] + ty * u + ny * v, z)


def to_frame(st, x, y):
    tx, ty = st['tx'], st['ty']
    dx, dy = x - st['x'], y - st['y']
    return dx * tx + dy * ty, dx * -ty + dy * tx


def tracks():
    """[west (southbound), east (northbound)]: south -> north polylines [(x, y, z)], 1 m apart, straight along the
    platforms (blended back into the OSM line over 20 m either side), clipped to SOUTH_END..NORTH_END."""
    if 'tr' in _CACHE:
        return _CACHE['tr']
    raw = _raw_tracks()
    sts = stations()
    out = []
    for side, pl in zip((+1, -1), raw):
        q = []
        for p in pl:
            x, y = p
            for st in sts:
                u, v = to_frame(st, x, y)
                au = abs(u)
                if au < BOX_U + 20 and abs(v) < 12:
                    ideal = frame(st, u, side * TRACK_V)
                    w = 1.0 if au <= BOX_U else 1.0 - (au - BOX_U) / 20.0
                    w = w * w * (3 - 2 * w)
                    x, y = x + (ideal[0] - x) * w, y + (ideal[1] - y) * w
            if SOUTH_END <= y <= NORTH_END:
                q.append((round(x, 3), round(y, 3), RAIL_Z))
        out.append(q)
    _CACHE['tr'] = out
    return out


def station_s(track, st):
    """Arc length of a station centre along a track polyline."""
    i = _nearest(track, (st['x'], st['y']))
    s = 0.0
    for a, b in zip(track[:i], track[1:i + 1]):
        s += math.dist(a[:2], b[:2])
    # refine by projecting onto the line through the station centre
    return s


# ------------------------------------------------------------------ passages
def apm_exits():
    names = {s['name'] for s in stations()}
    return [e for e in MX.exits() if e['kind'] == 'pavilion' and e['station'] in names]


def _river_mask():
    """Callable (x, y) -> True over river water (cut to -7 m; ponds are shallower than the passage roof)."""
    import gz_city
    R = gz_city.Raster(gz_city.bounds(), cs=1.0)
    for kind, o, hs in gz_city.water_polys():
        if kind == 'river':
            R.poly('river', [o] + list(hs))
    R.mask('river')
    R.dilate('river', 2)
    return lambda x, y: R.at('river', x, y)


def passages():
    """{exit id: [(x, y), ...]} centre lines from the end of each APM entrance hall into its concourse."""
    if 'pa' in _CACHE:
        return _CACHE['pa']
    sts = {s['name']: s for s in stations()}
    exits = apm_exits()
    river = _river_mask()
    hw = PASSAGE_W / 2
    import gz_huacheng
    import gz_mall
    hc_rects = [gz_huacheng.COURT] + gz_huacheng.wells() + [r[:4] for r in gz_mall.rooms()] + [gz_mall.WELL] + __import__('gz_north').keep_off()
    out = {}
    for e in exits:
        st = sts[e['station']]
        # grid round the exit and the station
        hx, hy, _ = MX_local(e, (MX.HALL[0] + MX.HALL[1]) / 2, MX.HALL[3])
        ax, ay, _ = MX_local(e, (MX.HALL[0] + MX.HALL[1]) / 2, MX.HALL[3] + 3.0)
        x0 = min(ax, st['x']) - 80; x1 = max(ax, st['x']) + 80
        y0 = min(ay, st['y']) - 80; y1 = max(ay, st['y']) + 80
        nx, ny = int(x1 - x0) + 1, int(y1 - y0) + 1
        blocked = bytearray(nx * ny)
        goal = bytearray(nx * ny)
        clear = hw + 0.8
        others = [o for o in MX.exits() if o['kind'] == 'pavilion' and o['id'] != e['id']
                  and abs(o['x'] - ax) < 250 and abs(o['y'] - ay) < 250]
        other_st = [s for s in stations() if s is not st]
        for j in range(ny):
            for i in range(nx):
                x, y = x0 + i, y0 + j
                k = j * nx + i
                u, v = to_frame(st, x, y)
                if abs(u) < BOX_U and abs(v) < CONC_V:
                    # into the concourse through a wall of either unpaid end, the whole corridor clear of the corners
                    # and of the gate lines; the paid area and the corners are solid
                    zone = PAID_U[1] + hw + 1 < u < BOX_U - hw - 0.5 or -BOX_U + hw + 0.5 < u < PAID_U[0] - hw - 1
                    end = abs(u) > BOX_U - 1.5 and abs(v) < CONC_V - hw - 0.5
                    if zone or end and (u > PAID_U[1] or u < PAID_U[0]):
                        goal[k] = 1
                    else:
                        blocked[k] = 1
                    continue
                if river(x, y):
                    blocked[k] = 1; continue
                # 花城汇's sunken court and its escalator wells (gz_huacheng) stand at concourse level: go round them
                if any(r[0] - clear - 0.6 < x < r[2] + clear + 0.6 and r[1] - clear - 0.6 < y < r[3] + clear + 0.6 for r in hc_rects):
                    blocked[k] = 1; continue
                # own hall and well: only the continuation line is free
                lx, ly = MX.rot(-e['yaw'], x - e['x'], y - e['y'])
                if MX.HALL[0] - clear < lx < MX.HALL[1] + clear and MX.PIT[2] - clear < ly < MX.HALL[3] + 2.5:
                    blocked[k] = 1; continue
                for o in others:
                    lx, ly = MX.rot(-o['yaw'], x - o['x'], y - o['y'])
                    if MX.ROOF[0] - clear < lx < MX.ROOF[1] + clear and MX.STEPS_Y0 - clear < ly < MX.HALL[3] + clear:
                        blocked[k] = 1; break
                if blocked[k]:
                    continue
                for s2 in other_st:
                    u2, v2 = to_frame(s2, x, y)
                    if abs(u2) < BOX_U + clear and abs(v2) < CONC_V + clear:
                        blocked[k] = 1; break
        si, sj = int(round(ax - x0)), int(round(ay - y0))
        path = _astar(nx, ny, blocked, goal, (si, sj))
        if not path:
            log('no passage for', e['station'], e['ref']); continue
        pts = [(hx, hy), (ax, ay)] + [(x0 + i, y0 + j) for i, j in path[1:]]
        # push the last point a few metres into the concourse so the corridor opens cleanly into it
        lx_, ly_ = pts[-1]
        u, v = to_frame(st, lx_, ly_)
        u2 = max(PAID_U[1] + 4, min(BOX_U - hw - 1, u)) if u > 0 else max(-BOX_U + hw + 1, min(PAID_U[0] - 4, u))
        v2 = max(-CONC_V + hw + 1, min(CONC_V - hw - 1, v)) * 0.6
        ex, ey, _ = frame(st, u2, v2)
        pts.append((ex, ey))
        out[e['id']] = _simplify(pts, blocked, nx, ny, x0, y0)
    _CACHE['pa'] = out
    log('passages:', {k: '%d pts / %.0f m' % (len(v), sum(math.dist(a, b) for a, b in zip(v, v[1:]))) for k, v in out.items()})
    return out


def MX_local(e, lx, ly, lz=0.0):
    dx, dy = MX.rot(e['yaw'], lx, ly)
    return e['x'] + dx, e['y'] + dy, e['z'] + lz


def _astar(nx, ny, blocked, goal, start):
    """8-connected A* with a turn penalty, stopping on the first goal cell."""
    si, sj = start
    if not (0 <= si < nx and 0 <= sj < ny):
        return None
    dirs = [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    INF = 1e18
    best = {}
    heap = [(0.0, 0.0, si, sj, -1)]
    prev = {}
    gi = [(i, j) for j in range(ny) for i in range(nx) if goal[j * nx + i]]
    gcx = sum(i for i, j in gi) / max(1, len(gi)); gcy = sum(j for i, j in gi) / max(1, len(gi))
    while heap:
        f, g, i, j, d = heapq.heappop(heap)
        key = (i, j, d)
        if best.get(key, INF) < g:
            continue
        if goal[j * nx + i]:
            path = [(i, j)]
            while key in prev:
                key = prev[key]
                path.append((key[0], key[1]))
            return path[::-1]
        for nd, (di, dj) in enumerate(dirs):
            a, b = i + di, j + dj
            if not (0 <= a < nx and 0 <= b < ny) or blocked[b * nx + a]:
                continue
            step = 1.4142 if di and dj else 1.0
            turn = 0.0 if d in (-1, nd) else 4.0
            ng = g + step + turn
            k2 = (a, b, nd)
            if ng < best.get(k2, INF):
                best[k2] = ng
                prev[k2] = key
                h = math.hypot(a - gcx, b - gcy) * 0.9
                heapq.heappush(heap, (ng + h, ng, a, b, nd))
    return None


def _simplify(pts, blocked, nx, ny, x0, y0):
    """Keep the first two points (straight out of the hall); then greedy line of sight over the free grid."""
    def free(a, b):
        L = math.dist(a, b)
        n = max(2, int(L * 2))
        for k in range(n + 1):
            x = a[0] + (b[0] - a[0]) * k / n; y = a[1] + (b[1] - a[1]) * k / n
            i, j = int(round(x - x0)), int(round(y - y0))
            if 0 <= i < nx and 0 <= j < ny and blocked[j * nx + i]:
                return False
        return True
    out = pts[:2]
    i = 1
    while i < len(pts) - 1:
        j = len(pts) - 1
        while j > i + 1 and not free(pts[i], pts[j]):
            j -= 1
        out.append(pts[j])
        i = j
    return [(round(x, 3), round(y, 3)) for x, y in out]


# ------------------------------------------------------------------ ground slab
def ground_cutters():
    """[(ring, z0, z1)] world prisms the ground slab loses: the station boxes (both levels), the passages, the
    tunnels (in 20 m pieces, their tops under the Pearl River bed)."""
    out = []
    def rect_uv(st, u0, u1, v0, v1):
        return [frame(st, u, v)[:2] for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
    top = CONC_Z + CONC_H + 0.3
    V = max(CONC_V, BOX_V) + 0.3
    for st in stations():
        out.append((rect_uv(st, -BOX_U - 0.3, BOX_U + 0.3, -V, V), -25.0, top))
    hw = PASSAGE_W / 2 + 0.2
    for pl in passages().values():
        for a, b in zip(pl, pl[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / L * hw, dx / L * hw
            out.append(([(a[0] + nx, a[1] + ny), (a[0] - nx, a[1] - ny), (b[0] - nx, b[1] - ny), (b[0] + nx, b[1] + ny)], CONC_Z - 1.0, top))
        for c in pl[1:-1]:
            out.append(([(c[0] + hw * math.cos(k * math.pi / 4), c[1] + hw * math.sin(k * math.pi / 4)) for k in range(8)], CONC_Z - 1.0, top))
    th = TUNNEL_W / 2 + 0.3
    for t in tracks():
        for i in range(0, len(t) - 1, 20):
            a, b = t[i], t[min(len(t) - 1, i + 21)]
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / L * th, dx / L * th
            out.append(([(a[0] + nx, a[1] + ny), (a[0] - nx, a[1] - ny), (b[0] - nx, b[1] - ny), (b[0] + nx, b[1] + ny)], -25.0, RAIL_Z + TUNNEL_H + 0.6))
    # every ring counter-clockwise
    fixed = []
    for ring, z0, z1 in out:
        a = sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
        fixed.append((ring if a > 0 else ring[::-1], z0, z1))
    return fixed


# ------------------------------------------------------------------ export
def apm_json():
    sts = stations()
    tr = tracks()
    for st in sts:
        st['s'] = [round(station_s(t, st), 2) for t in tr]
    return {
        'levels': {'concourse': CONC_Z, 'concourse_h': CONC_H, 'platform': PLAT_Z, 'platform_h': PLAT_H, 'rail': RAIL_Z,
                   'tunnel_w': TUNNEL_W, 'tunnel_h': TUNNEL_H},
        'frame': {'track_v': TRACK_V, 'island_v': ISLAND_V, 'plat_u': PLAT_U, 'psd_u': PSD_U, 'box_u': BOX_U, 'box_v': BOX_V,
                  'conc_v': CONC_V, 'stair_top': STAIR_TOP, 'stair_open': STAIR_OPEN, 'stair_foot': STAIR_FOOT, 'stair_x': STAIR_X,
                  'paid_u': PAID_U, 'passage_w': PASSAGE_W},
        'stations': sts,
        'tracks': {'west': tr[0], 'east': tr[1]},
        'passages': passages(),
        'exits': [e['id'] for e in apm_exits()],
        'license': 'Data (c) OpenStreetMap contributors, ODbL',
    }


def plan_svg(path, window=None, S=0.5):
    """Debug plan: tracks, station boxes, entrances, passages, river (window = (x0, y0, x1, y1), S px per metre)."""
    import gz_city
    sts = stations(); tr = tracks(); pa = passages()
    xs = [p[0] for t in tr for p in t]; ys = [p[1] for t in tr for p in t]
    x0, x1, y0, y1 = min(xs) - 250, max(xs) + 250, min(ys) - 60, max(ys) + 60
    if window:
        x0, y0, x1, y1 = window
    W, H = (x1 - x0) * S, (y1 - y0) * S
    def P(x, y): return '%.1f,%.1f' % ((x - x0) * S, (y1 - y) * S)
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" style="background:#10151a">' % (W, H)]
    for kind, o, hs in gz_city.water_polys():
        out.append('<polygon points="%s" fill="%s"/>' % (' '.join(P(*p) for p in o), '#1d4a6a' if kind == 'river' else '#2a5a5a'))
    for t, c in zip(tr, ('#ff8a3d', '#3dd6ff')):
        out.append('<polyline points="%s" fill="none" stroke="%s" stroke-width="1.5"/>' % (' '.join(P(p[0], p[1]) for p in t), c))
    for st in sts:
        box = [frame(st, u, v) for u, v in ((-BOX_U, -CONC_V), (BOX_U, -CONC_V), (BOX_U, CONC_V), (-BOX_U, CONC_V))]
        out.append('<polygon points="%s" fill="none" stroke="#fff" stroke-width="1"/>' % ' '.join(P(p[0], p[1]) for p in box))
        out.append('<text x="%s" y="%s" fill="#fff" font-size="14">%s</text>' % (*P(st['x'] + 14, st['y']).split(','), st['name']))
    for b_ in gz_city.data()['buildings']:
        out.append('<polygon points="%s" fill="#2c3036"/>' % ' '.join(P(*p) for p in b_['outer']))
    for e in MX.exits():
        if e['kind'] != 'pavilion':
            continue
        ring = [MX_local(e, x, y) for x, y in ((MX.HALL[0], MX.STEPS_Y0), (MX.HALL[1], MX.STEPS_Y0), (MX.HALL[1], MX.HALL[3]), (MX.HALL[0], MX.HALL[3]))]
        out.append('<polygon points="%s" fill="#b52a22"/>' % ' '.join(P(p[0], p[1]) for p in ring))
    for k, pl in pa.items():
        out.append('<polyline points="%s" fill="none" stroke="#9fe6a0" stroke-width="%.1f" stroke-opacity="0.7"/>' % (' '.join(P(*p) for p in pl), PASSAGE_W * S))
    out.append('</svg>')
    open(path, 'w').write('\n'.join(out))
