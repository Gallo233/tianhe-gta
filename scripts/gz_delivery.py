"""Where the delivery game happens in the city -> demo/public/assets/tianhe/delivery.json

    "$B" --background --factory-startup --python guangzhou/scripts/gz_delivery.py

Reads the building footprints (data/tianhe_core.json), the exported walkway graph and places.json, and finds for
every order point a spot on a real facade that faces the pavement:

  shops    one per pickup place: a shopfront bay (4 m) on the ground floor of the nearest building, the courier's
           standing point in front of its takeaway window. Kinds: restaurant, tea (cafe, bakery, bar), convenience,
           mall (a pickup-locker point), shop.
  lobbies  office towers, offices and hotels that are drop points: the lobby door, where the guard and the food
           locker go.
  homes    new drop points: residential buildings (real names where OSM has one), a door on the facade nearest the
           pavement. 'unit' = an apartment block's entrance, 'village' = an urban-village house (冼村, 石牌村, 猎德村)
           with its steel gate -- where the courier leaves the bag and takes the photo.

Every anchor: a (facade point, Blender x y z), n (outward normal, x y), stand (where the courier stands, x y z),
plus the edge's usable half-width. Deterministic. Coordinates are Blender metres like places.json.
"""
import json
import math
import os
import re
import sys

SCRIPTS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS)
import gz_city  # noqa: E402
from prepare_osm import proj  # noqa: E402

ROOT = os.path.dirname(SCRIPTS)
WEB = os.path.join(ROOT, 'demo', 'public', 'assets', 'tianhe')

SHOP_KIND = {'restaurant': 'restaurant', 'fast_food': 'restaurant', 'cafe': 'tea', 'bakery': 'tea', 'bar': 'tea',
             'convenience': 'convenience', 'supermarket': 'convenience', 'mall': 'mall', 'shop': 'shop'}
VILLAGES = [('冼村', 23.1296, 113.3255), ('石牌村', 23.1290, 113.3340)]
WORDS = ['翠竹', '锦绣', '金穗', '海滨', '华庭', '云景', '荔湾', '棠下', '天誉', '雅居', '汇景', '逸景']


def _h(i, salt):
    return ((int(i) * 2654435761 + salt * 97531) % 100003) / 100003.0


def signed_area(ring):
    return 0.5 * sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))


def main():
    d = gz_city.data()
    walk = json.load(open(os.path.join(WEB, 'walkways.json')))
    places = json.load(open(os.path.join(WEB, 'places.json')))
    nodes = walk['nodes']
    # buildings standing on the ground, big enough to carry a ground floor
    blds = [b for b in d['buildings'] if not b['landmark'] and b['h'] >= 5 and (not b['part'] or b.get('minh', 0) <= 0.5)]
    rings = [b['outer'] for b in blds]
    # facade segments with outward normals, on a 20 m grid
    grid = {}
    for bi, b in enumerate(blds):
        ring = b['outer'][:-1] if b['outer'][0] == b['outer'][-1] else b['outer']
        ccw = signed_area(ring) > 0
        for a, c in zip(ring, ring[1:] + ring[:1]):
            dx, dy = c[0] - a[0], c[1] - a[1]
            L = math.hypot(dx, dy)
            if L < 1:
                continue
            n = (dy / L, -dx / L) if ccw else (-dy / L, dx / L)
            seg = (a, c, L, n, bi)
            for gx in range(int(min(a[0], c[0]) // 20) - 1, int(max(a[0], c[0]) // 20) + 2):
                for gy in range(int(min(a[1], c[1]) // 20) - 1, int(max(a[1], c[1]) // 20) + 2):
                    grid.setdefault((gx, gy), []).append(seg)

    def inside_any(x, y):
        for gx, gy in ((int(x // 20), int(y // 20)),):
            for a, c, L, n, bi in grid.get((gx, gy), ()):
                if gz_city.point_in((x, y), rings[bi]):
                    return True
        return False

    used = []   # (x, y) of anchors taken

    def anchor(p, reach, half, stand, near=None):
        """The facade point nearest p (or near) that fits a bay of +-half, faces p and has a walkable stand point."""
        q = near or p
        cands = []
        seen = set()
        for gx in range(int(q[0] // 20) - 2, int(q[0] // 20) + 3):
            for gy in range(int(q[1] // 20) - 2, int(q[1] // 20) + 3):
                for seg in grid.get((gx, gy), ()):
                    if id(seg) in seen:
                        continue
                    seen.add(id(seg))
                    a, c, L, n, bi = seg
                    if L < 2 * half + 0.6:
                        continue
                    ux, uy = (c[0] - a[0]) / L, (c[1] - a[1]) / L
                    t = (q[0] - a[0]) * ux + (q[1] - a[1]) * uy
                    t = min(max(t, half + 0.3), L - half - 0.3)
                    fx, fy = a[0] + ux * t, a[1] + uy * t
                    dist = math.hypot(q[0] - fx, q[1] - fy)
                    if dist > reach or (p[0] - fx) * n[0] + (p[1] - fy) * n[1] < 0.5:
                        continue
                    cands.append((dist, fx, fy, n, ux, uy, t, L, bi))
        cands.sort(key=lambda c: c[0])
        for dist, fx, fy, n, ux, uy, t, L, bi in cands:
            # slide along the facade off anchors already taken
            for shift in (0, 5, -5, 10, -10):
                tt = t + shift
                if tt < half + 0.3 or tt > L - half - 0.3:
                    continue
                x, y = fx + ux * shift, fy + uy * shift
                if any(math.hypot(x - u[0], y - u[1]) < 2 * half + 1.0 for u in used):
                    continue
                sx, sy = x + n[0] * stand, y + n[1] * stand
                if gz_city.on_carriageway(sx, sy, 0.0) or inside_any(sx, sy) or inside_any(x + n[0] * 0.6, y + n[1] * 0.6):
                    continue
                used.append((x, y))
                return {'a': [round(x, 2), round(y, 2)], 'n': [round(n[0], 4), round(n[1], 4)], 's': [round(sx, 2), round(sy, 2)],
                        'span': round(min(tt, L - tt), 1), 'b': bi}
        return None

    shops, lobbies, homes = [], [], []
    miss = {'shop': 0, 'lobby': 0}
    for p in places:
        pos = p['pos']
        if p['role'] == 'pickup':
            an = anchor(pos, 26, 2.0, 1.7, near=None)
            if not an:
                miss['shop'] += 1
                continue
            an.pop('b')
            shops.append({'name': p['name'], 'cat': p['cat'], 'kind': SHOP_KIND.get(p['cat'], 'shop'), 'z': round(pos[2], 2), **an})
        elif p['cat'] in ('tower', 'office', 'hotel'):
            an = anchor(pos, 40, 2.6, 3.2, near=p.get('door'))
            if not an:
                miss['lobby'] += 1
                continue
            bi = an.pop('b')
            name = p['name']
            if re.fullmatch(r'[A-Za-z]?\d*[A-Za-z]?\d*', name) or len(name) < 3:
                # OSM block labels (A, D, C3) need the estate's name in front
                name = f"{WORDS[int(_h(blds[bi]['id'], 8) * len(WORDS))]}中心 {name.rstrip('座')}座"
            lobbies.append({'name': name, 'cat': p['cat'], 'z': round(pos[2], 2), **an})

    # homes: residential buildings with a facade on the pavement
    vill = [(n, *proj(la, lo)) for n, la, lo in VILLAGES]
    liede = (1072.0, -560.0)
    wgrid = {}
    for i, q in enumerate(nodes):
        wgrid.setdefault((int(q[0] // 25), int(q[1] // 25)), []).append(i)

    def nearest_walk(x, y, r=30.0):
        best, bd = None, r
        for gx in range(int(x // 25) - 1, int(x // 25) + 2):
            for gy in range(int(y // 25) - 1, int(y // 25) + 2):
                for j in wgrid.get((gx, gy), ()):
                    dd = math.hypot(nodes[j][0] - x, nodes[j][1] - y)
                    if dd < bd:
                        best, bd = j, dd
        return best

    counter = {}
    for bi, b in enumerate(blds):
        kind = b['kind']
        low = b['h'] <= 30 and b['area'] < 700
        if not (kind in ('apartments', 'residential', 'detached', 'dormitory') or (kind == 'yes' and low and b['area'] > 40)):
            continue
        cx, cy = gz_city.centroid(b['outer'])
        j = nearest_walk(cx, cy, 45.0)
        if j is None:
            continue
        w = nodes[j]
        an = anchor(w, 30, 0.9 if low else 1.8, 1.4, near=(cx, cy))
        if not an or an['b'] != bi:
            continue
        an.pop('b')
        style = 'village' if low else 'unit'
        if style == 'village':
            vn = min(vill + [('猎德村', *liede)], key=lambda v: math.hypot(v[1] - cx, v[2] - cy))
            if math.hypot(vn[1] - cx, vn[2] - cy) > 900:
                vn = ('天河村', 0, 0)
            k = counter[vn[0]] = counter.get(vn[0], 0) + 1
            lane = 1 + int(_h(b['id'], 5) * 18)
            name = f"{vn[0]}{['大街', '北约', '南约', '东街', '西街'][int(_h(b['id'], 6) * 5)]}{lane}巷{3 + k % 29}号"
            room = f"{1 + int(_h(b['id'], 7) * max(1, b['h'] // 3 - 1))}楼"
        else:
            estate = f"{WORDS[int(_h(b['id'], 8) * len(WORDS))]}花园"
            nm = b['name'] or ''
            if not nm:
                base = f"{estate}{1 + int(_h(b['id'], 9) * 12)}栋"
            elif re.fullmatch(r'[A-Za-z]?\d*[A-Za-z]?', nm) or len(nm) < 3:
                base = f"{estate} {nm}栋"        # OSM block labels (A1, C2...) need an estate in front
            else:
                base = nm
            floors = max(3, int(b['h'] // 3))
            room = f"{2 + int(_h(b['id'], 10) * (floors - 2))}{1 + int(_h(b['id'], 11) * 6):02d}"
            name = base
        homes.append({'name': name, 'room': room, 'style': style, 'h': round(b['h'], 1), 'z': round(w[2], 2), **an})

    out = {'shops': shops, 'lobbies': lobbies, 'homes': homes,
           'stats': {'shops': len(shops), 'lobbies': len(lobbies), 'homes': len(homes),
                     'village': sum(h['style'] == 'village' for h in homes), 'missed': miss}}
    json.dump(out, open(os.path.join(WEB, 'delivery.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
    print('DELIVERY', json.dumps(out['stats'], ensure_ascii=False))


main()
