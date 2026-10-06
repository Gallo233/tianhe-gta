"""Gameplay data for the Tianhe web demo, derived from the OSM data and the road graph (export_web.py calls it).

  walkways(graph)  pedestrian graph: a sidewalk on each side of every road-graph edge (w/2 + 2 m from the centre
                   line, trimmed back from junctions), corner links between neighbouring sidewalks (edges sorted
                   by angle around each node), a crosswalk across every road end at junctions, and the OSM
                   footways stitched in. Pieces inside buildings or water are dropped.
  places(walk)     delivery / mission points: OSM named amenities, shops, offices, hotels, metro entrances,
                   bus stops and named towers, each snapped to the nearest walkway point. Commercial names are
                   replaced with fictional ones (house rule: real place names, parody brands).
  minimap_svg()    a dark GTA-style map (roads by width, water, parks, buildings) for the HUD minimap.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import os

import gz_city

SIDE_OFF = 2.0          # sidewalk centre line: metres beyond the carriageway edge
NO_SIDEWALK = {'service', 'motorway', 'motorway_link', 'trunk_link', 'living_street'}


def _key(p):
    return (round(p[0] * 2), round(p[1] * 2))


def _offset(pts, off):
    """Mitred offset of a 2D polyline, `off` metres to the LEFT of travel."""
    L, R = gz_city.ribbon_xy(pts, abs(off) * 2)
    return [(v.x, v.y) for v in (L if off > 0 else R)]


def _trim(pts, a, b):
    s = gz_city.arclen(pts)
    if s[-1] - a - b < 1.5:
        return None
    return gz_city._sub(pts, s, a, s[-1] - b)


def _split_blocked(pts, R):
    """Cut a polyline where it enters buildings or water; returns the clear pieces (>= 3 m)."""
    dense = gz_city.densify(pts, 2.0)
    out, cur = [], []
    import gz_huacheng
    import gz_mall
    holes = [gz_huacheng.COURT] + gz_huacheng.wells() + [gz_mall.WELL] + __import__('gz_north').keep_off() + [__import__('gz_north').BASIN]   # 花城汇's court, its escalator wells, the mall's north well: open voids
    for p in dense:
        if R.at('bld', *p) or R.at('water', *p) or any(r[0] - 1 < p[0] < r[2] + 1 and r[1] - 1 < p[1] < r[3] + 1 for r in holes):
            if len(cur) >= 2: out.append(cur)
            cur = []
        else:
            cur.append(p)
    if len(cur) >= 2: out.append(cur)
    return [gz_city.clean_line(q) for q in out if gz_city.arclen(q)[-1] >= 3 and len(gz_city.clean_line(q)) >= 2]


class Walk:
    def __init__(self):
        self.nodes, self.idx, self.edges = [], {}, []

    def node(self, p, z):
        k = _key(p)
        if k not in self.idx:
            self.idx[k] = len(self.nodes)
            self.nodes.append([round(p[0], 2), round(p[1], 2), round(z, 3)])
        return self.idx[k]

    def edge(self, pts, kind, z, **extra):
        if len(pts) < 2:
            return None
        a, b = self.node(pts[0], z), self.node(pts[-1], z)
        if a == b:
            return None
        e = {'a': a, 'b': b, 'kind': kind, 'pts': [[round(p[0], 2), round(p[1], 2)] for p in pts], **extra}
        self.edges.append(e)
        return e


def walkways(graph):
    R = gz_city.raster()
    kerb = gz_city.KERB
    nodes = graph['nodes']
    W = Walk()
    # node degree and junction radius (same rule as the traffic lanes: widest road / 2 + 3 m)
    inc = {}
    for ei, e in enumerate(graph['edges']):
        inc.setdefault(e['a'], []).append((ei, 1)); inc.setdefault(e['b'], []).append((ei, -1))
    radius = {n: max(graph['edges'][ei]['w'] for ei, _ in lst) / 2 + 3.0 for n, lst in inc.items()}
    # per edge end: the sidewalk end points on the left / right of the OUTWARD direction from that node
    # other carriageways, for dropping sidewalk stretches that would run in a median or on another road
    seg_grid = {}
    for ei, e in enumerate(graph['edges']):
        if e['bridge']:
            continue
        for a, b in zip(e['pts'], e['pts'][1:]):
            for gx in range(int(min(a[0], b[0]) // 20) - 1, int(max(a[0], b[0]) // 20) + 2):
                for gy in range(int(min(a[1], b[1]) // 20) - 1, int(max(a[1], b[1]) // 20) + 2):
                    seg_grid.setdefault((gx, gy), []).append((ei, a, b, e['w'] / 2))
    def near_other(p, own):
        for ei, a, b, hw in seg_grid.get((int(p[0] // 20), int(p[1] // 20)), ()):
            if ei == own:
                continue
            dx, dy = b[0] - a[0], b[1] - a[1]
            L2 = dx * dx + dy * dy or 1e-9
            t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
            if math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < hw + 1.2:
                return True
        return False
    def clear_pieces(line, own):
        out, cur = [], []
        for p in gz_city.densify(line, 2.0):
            if near_other(p, own):
                if len(cur) >= 2: out.append(cur)
                cur = []
            else:
                cur.append(p)
        if len(cur) >= 2: out.append(cur)
        return out
    ends = {}              # (node, edge) -> {'left': pt, 'right': pt}
    for ei, e in enumerate(graph['edges']):
        if e['hw'] in NO_SIDEWALK or e['bridge']:
            continue
        pts = [(p[0], p[1]) for p in e['pts']]
        off = e['w'] / 2 + SIDE_OFF
        ra = radius[e['a']] if len(inc[e['a']]) >= 3 else 0.0
        rb = radius[e['b']] if len(inc[e['b']]) >= 3 else 0.0
        for side, sgn in (('L', 1), ('R', -1)):
            line = _trim(_offset(pts, sgn * off), ra, rb)
            if not line:
                continue
            for clear in clear_pieces(line, ei):
                for piece in _split_blocked(clear, R):
                    W.edge(piece, 'side', kerb, road=ei)
            # record ends for corner links (outward from node a the edge's left is our L; from node b it flips)
            ends.setdefault((e['a'], ei), {})['left' if sgn > 0 else 'right'] = line[0]
            ends.setdefault((e['b'], ei), {})['right' if sgn > 0 else 'left'] = line[-1]
    ncross = ncorner = 0
    for n, lst in inc.items():
        here = []
        for ei, sgn in lst:
            end = ends.get((n, ei))
            if not end or 'left' not in end or 'right' not in end:
                continue
            e = graph['edges'][ei]
            pts = e['pts'] if sgn > 0 else e['pts'][::-1]
            ang = math.atan2(pts[1][1] - pts[0][1], pts[1][0] - pts[0][0])
            here.append((ang, ei, end))
        here.sort()
        for i in range(len(here)):
            a_ang, a_e, a_end = here[i]
            b_ang, b_e, b_end = here[(i + 1) % len(here)]
            if len(here) >= 2 and a_e != b_e:
                # the corner between outward directions a (CCW) -> b: a's left sidewalk meets b's right one
                p, q = a_end['left'], b_end['right']
                if math.dist(p, q) < 60 and not (R.at('bld', (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)):
                    W.edge([p, q], 'corner', kerb, node=n); ncorner += 1
            if len(inc[n]) >= 3:
                # crosswalk across this road's end, at the junction
                p, q = a_end['left'], a_end['right']
                W.edge([p, q], 'cross', kerb, node=n, road=a_e); ncross += 1
    # OSM footways / pedestrian ways (not along carriageways: those duplicate the generated sidewalks)
    d = gz_city.data()
    bridges = gz_city.bridge_profile(d['roads'])
    x0, y0, x1, y1 = d['bounds_m']
    ways = []
    for r in d['roads']:
        if r['drive'] or r['tunnel'] or r['area'] or r['hw'] not in ('footway', 'pedestrian', 'path', 'steps', 'cycleway'):
            continue
        for run in gz_city.clip_polyline(gz_city.clean_line(r['pts']), (x0, y0, x1, y1)):
            if sum(gz_city.on_carriageway(*p, margin=-1.0) for p in run) > len(run) * 0.5:
                continue
            ways.append(run)
    cnt = {}
    for run in ways:
        for j, p in enumerate(run):
            cnt[_key(p)] = cnt.get(_key(p), 0) + (1 if j in (0, len(run) - 1) else 2)
    nfoot = 0
    for run in ways:
        start = 0
        for j in range(1, len(run)):
            if j == len(run) - 1 or cnt.get(_key(run[j]), 0) >= 3:
                seg = run[start:j + 1]
                for piece in _split_blocked(seg, R):
                    if W.edge(piece, 'foot', kerb): nfoot += 1
                start = j
    # 花城汇's sunken court (gz_huacheng): the stair down and the loop past the shops; the head of the stair joins
    # the nearest street-level node
    import gz_huacheng
    nh = 0
    n_street = len(W.nodes)                     # the street graph's nodes (the square's own lines join only these)
    for pts, za, zb in gz_huacheng.walk_lines():
        a, b = W.node(pts[0], za), W.node(pts[-1], zb)
        W.edges.append({'a': a, 'b': b, 'kind': 'foot', 'pts': [[round(p[0], 2), round(p[1], 2)] for p in pts]}); nh += 1
    head = gz_huacheng.walk_lines()[0][0][0]
    hi = W.node(head, gz_huacheng.KERB)
    near = sorted((math.dist(head, p[:2]), i) for i, p in enumerate(W.nodes) if i != hi and abs(p[2] - gz_huacheng.KERB) < 0.5)
    if near and near[0][0] < 80:
        j = near[0][1]
        W.edges.append({'a': hi, 'b': j, 'kind': 'foot', 'pts': [list(head), W.nodes[j][:2]]}); nh += 1
    # ...and so do the top of 花城汇's north escalators (gz_mall) and the north half's walks (gz_north)
    import gz_mall, gz_north
    north_ends = [gz_mall.walk_lines()[-1][0][-1], (-21.0, 172.0), (15.0, 172.0), (-13.5, 354.0), (13.5, 354.0)]
    for top in north_ends:
        ti = W.node(top, gz_huacheng.KERB)
        near = sorted((math.dist(top, p[:2]), i) for i, p in enumerate(W.nodes[:n_street]) if abs(p[2] - gz_huacheng.KERB) < 0.5)
        if near and near[0][0] < 80:
            j = near[0][1]
            W.edges.append({'a': ti, 'b': j, 'kind': 'foot', 'pts': [list(top), W.nodes[j][:2]]}); nh += 1
    nfoot += nh
    # stitch: every dead end within 10 m of another walk node gets a link
    deg = [0] * len(W.nodes)
    for e in W.edges:
        deg[e['a']] += 1; deg[e['b']] += 1
    grid = {}
    for i, p in enumerate(W.nodes):
        grid.setdefault((int(p[0] // 10), int(p[1] // 10)), []).append(i)
    nlink = 0
    for i, p in enumerate(W.nodes):
        if deg[i] != 1:
            continue
        best, bd = None, 10.0
        for gx in range(int(p[0] // 10) - 1, int(p[0] // 10) + 2):
            for gy in range(int(p[1] // 10) - 1, int(p[1] // 10) + 2):
                for j in grid.get((gx, gy), ()):
                    if j == i: continue
                    dd = math.dist(p[:2], W.nodes[j][:2])
                    if 0.5 < dd < bd and not gz_city.on_carriageway((p[0] + W.nodes[j][0]) / 2, (p[1] + W.nodes[j][1]) / 2):
                        best, bd = j, dd
        if best is not None:
            W.edges.append({'a': i, 'b': best, 'kind': 'link', 'pts': [W.nodes[i][:2], W.nodes[best][:2]]}); nlink += 1
    stats = {'nodes': len(W.nodes), 'edges': len(W.edges), 'crosswalks': ncross, 'corners': ncorner, 'footways': nfoot, 'links': nlink}
    return {'nodes': W.nodes, 'edges': W.edges, 'stats': stats}


# ------------------------------------------------------------------ places
WORDS = ['摸鱼', '续命', '早八', '打工人', '躺平', '爆单', '五星', '满分', '秒达', '云端', '霓虹', '花城', '珠江', '羊城', '木棉',
         '老街坊', '靓仔', '阿婆', '猛火', '发财', '好彩', '大吉', '顺景', '算法', '量子', '赛博', '未来', '深夜', '通宵', '天台',
         '一哥', '街市', '高架', '电波', '极速', '九点', '零点', '半糖', '走地', '猪脚']
SURNAMES = ['陈', '李', '黄', '何', '梁', '罗', '冯', '郑', '林', '叶', '邓', '麦', '谭', '区', '欧阳']
TEMPLATES = {
    'restaurant': ['{s}记烧腊', '{w}茶餐厅', '{w}粥粉面', '{s}记云吞面', '{w}海鲜酒家', '{w}点心楼', '{s}姐煲仔饭', '{w}私房菜'],
    'fast_food': ['{w}炸鸡', '{w}汉堡', '{w}快餐', '{s}记猪脚饭', '{w}肠粉', '{w}盒饭'],
    'cafe': ['{w}咖啡', '{w}手冲', '{w}奶茶', '{w}糖水铺', '{w}Coffee'],
    'bar': ['{w}酒馆', '{w}Livehouse', '{w}精酿'],
    'bakery': ['{w}面包工坊', '{w}烘焙'],
    'convenience': ['{w}便利', '24小时{w}便利店', '{w}士多'],
    'supermarket': ['{w}超市', '{w}生鲜'],
    'mall': ['{w}汇', '{w}中心商场', '{w}天地'],
    'hotel': ['{w}酒店', '{w}公寓酒店', '{w}精品酒店'],
    'shop': ['{w}{t}'],
    'parcel_locker': ['蜂箱快柜'],
    'office': ['{w}科技', '{w}传媒', '{w}资本', '{w}网络', '{w}智能'],
}
SHOP_WORD = {'clothes': '服装', 'beauty': '美容', 'mobile_phone': '手机', 'car': '汽车展厅', 'sports': '运动', 'books': '书店',
             'variety_store': '百货', 'florist': '花店', 'hairdresser': '发廊', 'jewelry': '珠宝', 'optician': '眼镜'}


def _h(i, salt):
    return ((int(i) * 2654435761 + salt * 97531) % 100003) / 100003.0


def fake_name(el, cat):
    t = el.get('tags', {})
    tpl = TEMPLATES.get(cat, TEMPLATES['shop'])
    pick = tpl[int(_h(el['id'], 1) * len(tpl)) % len(tpl)]
    return pick.format(w=WORDS[int(_h(el['id'], 2) * len(WORDS)) % len(WORDS)],
                       s=SURNAMES[int(_h(el['id'], 3) * len(SURNAMES)) % len(SURNAMES)],
                       t=SHOP_WORD.get(t.get('shop'), '小店'))


def places(walk):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    raw = json.load(open(os.path.join(root, 'data', 'osm', 'tianhe_core_pois.json')))['elements']
    d = gz_city.data()
    x0, y0, x1, y1 = d['bounds_m']
    from prepare_osm import proj
    grid = {}
    for i, p in enumerate(walk['nodes']):
        if p[2] < -1.0:
            continue          # street level only: not the sunken court of 花城汇 (its shops are not delivery places yet)
        grid.setdefault((int(p[0] // 25), int(p[1] // 25)), []).append(i)
    def snap(x, y, reach=60.0):
        best, bd = None, reach
        for gx in range(int(x // 25) - 3, int(x // 25) + 4):
            for gy in range(int(y // 25) - 3, int(y // 25) + 4):
                for j in grid.get((gx, gy), ()):
                    dd = math.dist((x, y), walk['nodes'][j][:2])
                    if dd < bd: best, bd = j, dd
        return best
    out = []
    for el in raw:
        t = el.get('tags', {})
        c = el.get('center') or ({'lat': el['lat'], 'lon': el['lon']} if 'lat' in el else None)
        if not c:
            continue
        x, y = proj(c['lat'], c['lon'])
        if not (x0 < x < x1 and y0 < y < y1):
            continue
        am, shop, office, tour = t.get('amenity'), t.get('shop'), t.get('office'), t.get('tourism')
        if am in ('restaurant', 'fast_food', 'cafe', 'bar', 'ice_cream', 'food_court'):
            role, cat, name = 'pickup', ('cafe' if am == 'ice_cream' else 'restaurant' if am == 'food_court' else am), None
        elif shop in ('bakery', 'convenience', 'supermarket', 'mall', 'department_store'):
            role, cat, name = 'pickup', ('mall' if shop == 'department_store' else shop), None
        elif shop:
            role, cat, name = 'pickup', 'shop', None
        elif tour == 'hotel':
            role, cat, name = 'drop', 'hotel', None
        elif am == 'parcel_locker':
            role, cat, name = 'drop', 'parcel_locker', None
        elif t.get('railway') == 'subway_entrance':
            role, cat, name = 'drop', 'metro', t.get('name') or '地铁出入口'
        elif t.get('highway') == 'bus_stop':
            role, cat, name = 'drop', 'bus', (t.get('name') or '公交站') + ' 公交站'
        elif office in ('company', 'yes', 'newspaper', 'telecommunication', 'it', 'financial'):
            role, cat, name = 'drop', 'office', None
        else:
            continue
        if name is None:
            name = fake_name(el, cat)
        j = snap(x, y)
        if j is None:
            continue
        p = walk['nodes'][j]
        out.append({'name': name, 'role': role, 'cat': cat, 'door': [round(x, 1), round(y, 1)], 'pos': p})
    # named towers (real building names are place names) as drop points
    for b in d['buildings']:
        if not b['name'] or b['h'] < 60 or b['part']:
            continue
        cx, cy = gz_city.centroid(b['outer'])
        j = snap(cx, cy, 90.0)
        if j is not None:
            out.append({'name': b['name'], 'role': 'drop', 'cat': 'tower', 'door': [round(cx, 1), round(cy, 1)], 'pos': walk['nodes'][j]})
    # de-duplicate: one point per role within 12 m
    kept = []
    for p in out:
        if any(q['role'] == p['role'] and math.dist(q['pos'][:2], p['pos'][:2]) < 12 for q in kept):
            continue
        kept.append(p)
    return kept


# ------------------------------------------------------------------ minimap
def minimap_svg(path, px=3000):
    """Dark GTA-style plan: x0..x1 maps to 0..px (square, padded to the longer side)."""
    d = gz_city.data()
    x0, y0, x1, y1 = d['bounds_m']
    size = max(x1 - x0, y1 - y0)
    s = px / size
    def pt(p): return f'{(p[0] - x0) * s:.1f},{(y0 + size - p[1]) * s:.1f}'
    def poly(outer, holes, style):
        dd = 'M' + ' L'.join(pt(p) for p in outer) + ' Z' + ''.join(' M' + ' L'.join(pt(p) for p in h) + ' Z' for h in holes)
        return f'<path d="{dd}" fill-rule="evenodd" {style}/>'
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{px}" height="{px}" viewBox="0 0 {px} {px}">',
             f'<rect width="{px}" height="{px}" fill="#1b2227"/>']
    for g in d['green']: parts.append(poly(g['outer'], g['holes'], 'fill="#23402e"'))
    for w in d['water']: parts.append(poly(w['outer'], w['holes'], 'fill="#1d4f6b"'))
    for b in d['buildings']: parts.append(poly(b['outer'], b['holes'], 'fill="#3a444c"'))
    for r in sorted(d['roads'], key=lambda r: r['w']):
        if r['area'] or r['tunnel']: continue
        col = '#8d969c' if r['drive'] and r['hw'] not in ('service',) else '#5a646b'
        if r['hw'] in ('trunk', 'motorway', 'primary'): col = '#c9b27a'
        parts.append(f'<polyline points="{" ".join(pt(p) for p in r["pts"])}" fill="none" stroke="{col}" '
                     f'stroke-width="{max(1.2, r["w"] * s * 0.9):.1f}" stroke-linecap="round" stroke-linejoin="round"/>')
    parts.append('</svg>')
    with open(path, 'w') as f:
        f.write('\n'.join(parts))
    return {'x0': x0, 'y0': y0, 'size': size, 'px': px}
