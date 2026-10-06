"""Guangzhou Metro street entrances from OSM (railway=subway_entrance in data/osm/tianhe_core_pois.json).

    exits()          every entrance: station, exit letter, lines, and where the street pavilion goes
    blocked(x, y)    True inside a pavilion's footprint or in front of its opening (trees and lamps keep out)
    ground_cutters() prisms the ground slab loses: the open stairwell under the pavilion and the covered stair
                     tunnel + hall behind it (the pavement stays on top as a lid)
    metro_json()     exits + station names + the layout numbers for guangzhou/demo (assets/tianhe/metro.json),
                     plus the tunnels and platforms from OSM for the underground stations to come

The pavilion follows the photographs of Tianhenan exit A (Commons, 2024 / 2025): a raised granite platform two
steps up, red box-section steel portal frames, a deep blue tray roof, glass on three sides, the maroon sign band
over the open end, and a stair beside an escalator dropping straight in. Local frame: origin on the pavement in
the middle of the column grid, x across, the opening at -Y, the stair descending toward +Y; world = rotate by
`yaw` about +Z, then translate. The kit (gz_streetkit.metro_exit) and the demo read the numbers below.

Placement: the long axis runs along the nearest carriageway (or square to it, opening toward the road, when the
pavement is deep enough); the pavilion keeps off every carriageway (behind the pavement's walking line where it
fits), buildings, water and the other exits, as close to the OSM point as that allows. Entrances OSM maps inside
the underground mall (level -1) and ones with no room get a standing totem only.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAT0, LON0 = 23.1205, 113.3192
KX = math.cos(math.radians(LAT0)) * 111_320.0
KY = 110_574.0

# ------------------------------------------------------------------ layout (local metres, z above the pavement)
COL_X = 3.0                          # column lines x = +-3.0
FRAMES_Y = (-4.6, -1.6, 1.4, 4.4)    # portal frames, front to back
PLAT = (-3.45, 3.45, -5.5, 4.75)     # platform x0, x1, y0, y1
PLAT_Z = 0.30                        # two 0.15 m steps up
STEPS_Y0 = -5.8                      # the steps run from here to PLAT y0
ROOF = (-4.2, 4.2, -6.5, 5.5)        # roof plan
ROOF_Z = 4.3                         # top of the column frames
PIT = (-2.4, 1.6, -3.4, 4.4)         # open well in the platform (the back glass stands on its far edge)
STAIR_X = (-2.3, -0.25)              # fixed stair
ESC_X = (-0.05, 1.5)                 # escalator, balustrades included
RISE, TREAD, N_RISE = 0.15, 0.30, 42
FLOOR_Z = PLAT_Z - RISE * N_RISE     # -6.0: the hall under the street, level with the APM concourses (gz_apm)
STAIR_END = PIT[2] + TREAD * (N_RISE - 1)   # y of the last riser (8.9)
HALL = (-2.4, 1.6, STAIR_END, 15.8)  # landing hall under the pavement (ticket gates + station map, or the passage on)
GATES_Y = 12.4
LID_Z = -0.6                         # underside of the pavement where the stair tunnel starts (back of the well)
HALL_CEIL = FLOOR_Z + 3.5            # the tunnel ceiling follows the stair down to this and stays there
CEIL_KNEE = PIT[3] + (LID_Z - HALL_CEIL) / (RISE / TREAD)   # y where the sloping ceiling meets the hall ceiling
TOTEM = (4.7, -6.2)                  # the red pylon beside the opening
BOLLARDS = ((-2.4, -6.4), (-0.8, -6.4), (0.8, -6.4), (2.4, -6.4))   # stainless posts before the steps: people pass, cars do not

KERB = 0.15

# station -> (English / pinyin as on the signs, lines)
STATIONS = {
    '广州塔': ('Canton Tower', ['3', 'APM']),
    '海心沙': ('Haixinsha', ['APM']),
    '大剧院': ('Opera House', ['APM']),
    '花城大道': ('Huacheng Avenue', ['APM']),
    '妇儿中心': ("Fu'er Zhongxin", ['APM']),
    '珠江新城': ('Zhujiang New Town', ['3', '5']),
    '猎德': ('Liede', ['5']),
    '潭村': ('Tancun', ['5']),
    '五羊邨': ('Wuyangcun', ['5']),
    '杨箕': ('Yangji', ['1', '5']),
    '冼村': ('Xiancun', ['18']),
    '磨碟沙': ('Modiesha', ['8', '18']),
    '赤岗': ('Chigang', ['8']),
    '赤岗塔': ('Chigang Pagoda', ['3']),
    '客村': ('Kecun', ['3', '8']),
}
ALIAS = {'杨箕东': '杨箕'}
LINE_COLOURS = {'1': '#f3d03e', '3': '#eca154', '5': '#c5003e', '8': '#008c95', '18': '#0047ba', 'APM': '#00a8e1'}

_EXITS = None


def log(*a):
    print('[metro]', *a, flush=True)


def proj(lat, lon):
    return (lon - LON0) * KX, (lat - LAT0) * KY


def rot(yaw, lx, ly):
    c, s = math.cos(yaw), math.sin(yaw)
    return lx * c - ly * s, lx * s + ly * c


def _osm_entrances():
    d = json.load(open(os.path.join(ROOT, 'data', 'osm', 'tianhe_core_pois.json')))
    out = []
    for e in d['elements']:
        t = e.get('tags', {})
        if t.get('railway') != 'subway_entrance' or 'lat' not in e:
            continue
        x, y = proj(e['lat'], e['lon'])
        name = t.get('name:zh') or t.get('name') or ''
        m = re.match(r'^(.+?)站', name)
        station = ALIAS.get(m.group(1), m.group(1)) if m else None
        ref = t.get('ref')
        if not ref:
            m2 = re.search(r'([A-Z]\d?)\s*出入口', name)
            ref = m2.group(1) if m2 else None
        out.append({'osm': e['id'], 'x': x, 'y': y, 'station': station if station in STATIONS else None, 'ref': ref,
                    'level': t.get('level')})
    # unnamed ones (and a road name standing in for the station) take the nearest named exit's station
    named = [e for e in out if e['station']]
    for e in out:
        if e['station']:
            continue
        near = min(named, key=lambda n: math.hypot(n['x'] - e['x'], n['y'] - e['y']))
        if math.hypot(near['x'] - e['x'], near['y'] - e['y']) < 300:
            e['station'] = near['station']
    # the Yangji group is mapped without a single name: the station outline next to it says 杨箕东
    for e in out:
        if not e['station'] and -1000 < e['x'] < -800 and 600 < e['y'] < 950:
            e['station'] = '杨箕'
    return [e for e in out if e['station']]


class _Site:
    """Placement tests against the prepared city (gz_city raster + at-grade carriageways)."""

    def __init__(self):
        import gz_city
        self.city = gz_city
        self.R = gz_city.raster()
        self.b = gz_city.bounds()
        self.segs = []
        for r, pts in gz_city.carriageways():
            for a, b in zip(pts, pts[1:]):
                self.segs.append((a, b, r['w'] / 2))
        self.taken = []            # [(cx, cy, yaw, rect)] of placed exits (surface and underground)

    def nearest_road(self, x, y):
        best, bd = None, 1e9
        for a, b, hw in self.segs:
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / L2))
            px, py = a[0] + dx * t, a[1] + dy * t
            d = math.hypot(x - px, y - py) - hw
            if d < bd:
                L = math.sqrt(L2)
                bd, best = d, (dx / L, dy / L, px, py, hw)
        return bd, best

    def samples(self, cx, cy, yaw, rect, step=1.0):
        x0, x1, y0, y1 = rect
        nx, ny = max(1, int(math.ceil((x1 - x0) / step))), max(1, int(math.ceil((y1 - y0) / step)))
        for i in range(nx + 1):
            for j in range(ny + 1):
                lx, ly = x0 + (x1 - x0) * i / nx, y0 + (y1 - y0) * j / ny
                dx, dy = rot(yaw, lx, ly)
                yield cx + dx, cy + dy

    def ok(self, cx, cy, yaw, clear):
        x0, y0, x1, y1 = self.b
        R, on = self.R, self.city.on_carriageway
        surf = (PLAT[0] - 0.3, PLAT[1] + 0.3, STEPS_Y0 - 0.3, PLAT[3] + 0.3)
        for x, y in self.samples(cx, cy, yaw, surf):
            if not (x0 + 5 < x < x1 - 5 and y0 + 5 < y < y1 - 5):
                return False
            if R.at('bld', x, y) or R.at('water', x, y) or on(x, y, -clear):
                return False
        for x, y in self.samples(cx, cy, yaw, ROOF, 1.4):              # the roof overhang clears the buildings
            if R.at('bld', x, y):
                return False
        for x, y in self.samples(cx, cy, yaw, (-2.5, 2.5, STEPS_Y0 - 3.0, STEPS_Y0)):   # room to walk in
            if R.at('bld', x, y) or R.at('water', x, y) or on(x, y, 0.0):
                return False
        under = (PIT[0] - 0.3, PIT[1] + 0.3, PIT[3], HALL[3] + 0.3)
        import gz_huacheng
        import gz_mall
        keep_off = [gz_huacheng.COURT] + gz_huacheng.wells() + [r[:4] for r in gz_mall.rooms()] + [gz_mall.WELL] + __import__('gz_north').keep_off()
        for x, y in self.samples(cx, cy, yaw, (ROOF[0], ROOF[1], STEPS_Y0 - 2.0, HALL[3] + 3.5)):
            # 花城汇's sunken court and escalator wells (and room for the passage to leave the hall)
            if any(r[0] - 3.0 < x < r[2] + 3.0 and r[1] - 3.0 < y < r[3] + 3.0 for r in keep_off):
                return False
        import gz_apm
        boxes = self.__dict__.setdefault('_apm', [(st, gz_apm.BOX_U + 2.5, max(gz_apm.CONC_V, gz_apm.BOX_V) + 2.5) for st in gz_apm.stations()])
        for x, y in self.samples(cx, cy, yaw, (PIT[0] - 0.3, PIT[1] + 0.3, PIT[3], HALL[3] + 3.0)):
            if R.at('water', x, y):
                return False
            for st, bu, bv in boxes:                                     # the hall must not run into an APM station box
                u, v = gz_apm.to_frame(st, x, y)
                if abs(u) < bu and abs(v) < bv:
                    return False
        for tx, ty, tyaw, _ in self.taken:                               # clear of the other exits (all of them)
            if math.hypot(tx - cx, ty - cy) > 40:
                continue
            for x, y in self.samples(cx, cy, yaw, (ROOF[0], ROOF[1], STEPS_Y0 - 2.0, HALL[3] + 0.5), 1.5):
                lx, ly = rot(-tyaw, x - tx, y - ty)
                if ROOF[0] - 0.5 < lx < ROOF[1] + 0.5 and STEPS_Y0 - 2.5 < ly < HALL[3] + 0.5:
                    return False
        return True

    def free_point(self, x, y, r=0.6):
        R = self.R
        return not (R.at('bld', x, y) or R.at('water', x, y) or self.city.on_carriageway(x, y, -r))


def _place(site, e):
    d, road = site.nearest_road(e['x'], e['y'])
    if road:
        tx, ty, px, py, hw = road
        nx, ny = e['x'] - px, e['y'] - py
        nl = math.hypot(nx, ny)
        nx, ny = (nx / nl, ny / nl) if nl > 1e-6 else (-ty, tx)
    else:
        tx, ty, nx, ny = 1.0, 0.0, 0.0, 1.0
    # local +Y (down the stair) -> world (-sin yaw, cos yaw)
    orients = [(math.atan2(-tx, ty), 0.0), (math.atan2(tx, -ty), 0.0), (math.atan2(-nx, ny), 1.5)]
    cands = []
    for clear, pen in ((3.2, 0.0), (0.8, 4.0)):
        for yaw, open_pen in orients:
            for on_ in [k * 0.5 for k in range(-12, 25)]:
                for ot in range(-8, 9):
                    cost = math.hypot(on_, ot) + pen + open_pen + (0.3 if yaw == orients[1][0] else 0.0)
                    cands.append((cost, clear, yaw, e['x'] + nx * on_ + tx * ot, e['y'] + ny * on_ + ty * ot))
    cands.sort(key=lambda c_: c_[0])
    for cost, clear, yaw, cx, cy in cands:
        if site.ok(cx, cy, yaw, clear):
            return cx, cy, yaw, clear
    return None


def exits():
    global _EXITS
    if _EXITS is not None:
        return _EXITS
    site = _Site()
    out = []
    ents = sorted(_osm_entrances(), key=lambda e: (e['station'], e['ref'] or 'Z'))
    for e in ents:
        en, lines = STATIONS[e['station']]
        rec = {'id': 'M%d' % len(out), 'station': e['station'], 'ref': e['ref'] or '', 'en': en, 'lines': lines,
               'osm': [round(e['x'], 2), round(e['y'], 2)], 'z': KERB}
        p = None if e['level'] == '-1' else _place(site, e)
        if p:
            cx, cy, yaw, clear = p
            rec.update(kind='pavilion', x=round(cx, 3), y=round(cy, 3), yaw=round(yaw, 5), moved=round(math.hypot(cx - e['x'], cy - e['y']), 1),
                       kerb_clear=clear)
            site.taken.append((cx, cy, yaw, None))
        else:
            # a standing totem: at the point if it is clear, else the nearest clear spot within 10 m
            spot = None
            for r_ in [0.0] + [0.5 * k for k in range(1, 21)]:
                for a in range(0, 360, 30 if r_ else 360):
                    x, y = e['x'] + r_ * math.cos(math.radians(a)), e['y'] + r_ * math.sin(math.radians(a))
                    if site.free_point(x, y):
                        spot = (x, y); break
                if spot: break
            if not spot:
                log('no room at all for', e['station'], e['ref']); continue
            d, road = site.nearest_road(*spot)
            yaw = math.atan2(road[0], road[1]) if road else 0.0
            rec.update(kind='totem', x=round(spot[0], 3), y=round(spot[1], 3), yaw=round(yaw, 5),
                       moved=round(math.hypot(spot[0] - e['x'], spot[1] - e['y']), 1), indoor=e['level'] == '-1')
        out.append(rec)
    _EXITS = out
    np_ = sum(r['kind'] == 'pavilion' for r in out)
    log('%d entrances: %d pavilions, %d totems; moved median %.1f m' % (len(out), np_, len(out) - np_,
        sorted(r['moved'] for r in out)[len(out) // 2] if out else 0))
    return out


def blocked(x, y, margin=0.8):
    """Inside a pavilion's surface footprint (roof, steps, the walk-in apron) or on a totem."""
    for r in exits():
        if abs(r['x'] - x) > 20 or abs(r['y'] - y) > 20:
            continue
        lx, ly = rot(-r['yaw'], x - r['x'], y - r['y'])
        if r['kind'] == 'pavilion':
            if ROOF[0] - margin < lx < ROOF[1] + margin and STEPS_Y0 - 2.5 - margin < ly < ROOF[3] + margin:
                return True
            if abs(lx - TOTEM[0]) < 0.6 + margin and abs(ly - TOTEM[1]) < 0.6 + margin:
                return True
        elif math.hypot(lx, ly) < 0.6 + margin:
            return True
    return False


def ground_cutters():
    """[(ring, z0, z1, kind)] in world coordinates: per pavilion the open 'well' (through the pavement) and the
    'tunnel' + hall under a lid of pavement."""
    out = []
    for r in exits():
        if r['kind'] != 'pavilion':
            continue
        def ring(x0, x1, y0, y1):
            return [(r['x'] + a, r['y'] + b) for a, b in (rot(r['yaw'], x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)))]
        out.append((ring(PIT[0] - 0.02, PIT[1] + 0.02, PIT[2] - 0.02, PIT[3] + 0.01), KERB + FLOOR_Z - 1.5, KERB + 1.0, 'well'))
        out.append((ring(PIT[0] - 0.02, PIT[1] + 0.02, PIT[3] - 0.05, HALL[3] + 0.02), KERB + FLOOR_Z - 1.5, KERB + LID_Z + 0.02, 'tunnel'))
    return out


def water_holes():
    """One clockwise ring per pavilion around its well, tunnel and hall (holes in the full-map river plane)."""
    out = []
    for r in exits():
        if r['kind'] != 'pavilion':
            continue
        pts = [(PIT[0] - 0.1, PIT[2] - 0.1), (PIT[0] - 0.1, HALL[3] + 0.1), (PIT[1] + 0.1, HALL[3] + 0.1), (PIT[1] + 0.1, PIT[2] - 0.1)]
        out.append([(r['x'] + a, r['y'] + b) for a, b in (rot(r['yaw'], x, y) for x, y in pts)])
    return out


def _underground():
    """Tunnels and platforms from the OSM dump (for the underground stations to come)."""
    d = json.load(open(os.path.join(ROOT, 'data', 'osm', 'tianhe_core.json')))
    lines, plats = [], []
    for e in d['elements']:
        t = e.get('tags', {})
        g = e.get('geometry')
        if not g:
            continue
        pts = [[round(v, 2) for v in proj(p['lat'], p['lon'])] for p in g if p]
        kind = t.get('railway')
        if kind in ('subway', 'light_rail') and t.get('tunnel') == 'yes':
            lines.append({'name': t.get('name'), 'layer': int(t.get('layer', '-1')), 'pts': pts})
        elif kind == 'platform' and t.get('level', t.get('layer')):
            plats.append({'name': t.get('name'), 'level': t.get('level', t.get('layer')), 'pts': pts})
    return lines, plats


def metro_json():
    lines, plats = _underground()
    return {
        'exits': exits(),
        'stations': {k: {'en': v[0], 'lines': v[1]} for k, v in STATIONS.items()},
        'line_colours': LINE_COLOURS,
        'layout': {'col_x': COL_X, 'frames_y': FRAMES_Y, 'plat': PLAT, 'plat_z': PLAT_Z, 'steps_y0': STEPS_Y0,
                   'roof': ROOF, 'roof_z': ROOF_Z, 'pit': PIT, 'stair_x': STAIR_X, 'esc_x': ESC_X, 'floor_z': FLOOR_Z,
                   'stair_end': STAIR_END, 'hall': HALL, 'gates_y': GATES_Y, 'lid_z': LID_Z, 'hall_ceil': HALL_CEIL, 'totem': TOTEM,
                   'bollards': BOLLARDS},
        'tunnels': lines,
        'platforms': plats,
        'license': 'Data (c) OpenStreetMap contributors, ODbL',
    }
