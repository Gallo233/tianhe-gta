"""M1 · Project and clean the raw OSM download into the city generator's input.

    python3 guangzhou/scripts/prepare_osm.py [--area tianhe_core]

Reads  guangzhou/data/osm/<area>.json   (fetch_osm.py, Overpass `out geom`)
Writes guangzhou/data/<area>.json       (metres, Blender X east / Y north, origin below)
       guangzhou/data/<area>_map.svg    (plan for eyeballing: roads, buildings by height, water, green)

Standard library only. Heights: OSM `height` when present, else `building:levels` x 3.3 m + 4 m, else an
estimate from building type and footprint (flagged `est`) -- about 60 % of the footprints here have
neither tag, mostly urban-village blocks and podiums. Landmarks that get hand-built models (towers,
opera house, museum, library...) are tagged `landmark` and skipped by the generic extrusion.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# origin: Huacheng Square, on the axis between the twin towers (lat, lon; read off the first plan)
LAT0, LON0 = 23.1205, 113.3192
# phase-1 core in lat/lon (south, west, north, east): Guangzhou Avenue to Liede Avenue, Huangpu Avenue to
# just south of Canton Tower. Everything else in the download is context (built low-detail, if at all).
CORE_LL = (23.1035, 113.3098, 23.1300, 113.3300)
KX = math.cos(math.radians(LAT0)) * 111_320.0
KY = 110_574.0

LANDMARKS = {
    'west_tower': {'ways': [184738716], 'name': '广州国际金融中心（西塔）'},
    'east_tower': {'ways': [511404889, 299687657], 'name': '周大福金融中心（东塔）'},
    'canton_tower': {'ways': [521222276, 584204634, 904974166, 905101058], 'parts_prefix': 9530583, 'name': '广州塔'},
    'opera_house': {'ways': [617634618], 'relations': [10061850], 'name': '广州大剧院'},
    'museum': {'ways': [240896442], 'name': '广东省博物馆'},
    'library': {'ways': [240896441], 'name': '广州图书馆'},
    'childrens_palace': {'ways': [312876745], 'name': '广州市第二少年宫'},
}

ROAD_WIDTH = {  # full carriageway width in metres for a two-way road; one-way roads get ~55 %
    'motorway': 26, 'trunk': 26, 'primary': 20, 'secondary': 15, 'tertiary': 11, 'unclassified': 8, 'residential': 7,
    'living_street': 6, 'service': 5, 'motorway_link': 8, 'trunk_link': 8, 'primary_link': 8, 'secondary_link': 7,
    'tertiary_link': 7, 'pedestrian': 7, 'footway': 2.5, 'path': 2, 'cycleway': 2.2, 'steps': 2.5,
}
DRIVABLE = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service',
            'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}


def proj(lat, lon):
    return round((lon - LON0) * KX, 2), round((lat - LAT0) * KY, 2)


def num(v):
    if v is None:
        return None
    m = re.search(r'-?\d+(\.\d+)?', str(v))
    return float(m.group(0)) if m else None


def area(ring):
    return 0.5 * sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))


def ccw(ring):
    """Outer rings counter-clockwise, no duplicated closing point."""
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring if area(ring) > 0 else ring[::-1]


def join_rings(segments):
    """Join open member ways of a multipolygon into closed rings by matching end points."""
    segs = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while segs:
        ring = segs.pop(0)
        changed = True
        while ring[0] != ring[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]: ring += s[1:]
                elif s[-1] == ring[-1]: ring += s[::-1][1:]
                elif s[-1] == ring[0]: ring = s + ring[1:]
                elif s[0] == ring[0]: ring = s[::-1] + ring[1:]
                else: continue
                segs.pop(i); changed = True
                break
        if len(ring) >= 4 and ring[0] == ring[-1]:
            rings.append(ring)
    return rings


def geom(e):
    return [proj(p['lat'], p['lon']) for p in e.get('geometry', []) if p]


def polygons(e):
    """[(outer, [holes])] for a closed way or a multipolygon relation."""
    if e['type'] == 'way':
        g = geom(e)
        return [(ccw(g), [])] if len(g) >= 4 and g[0] == g[-1] else []
    outers = join_rings([geom(m) for m in e.get('members', []) if m.get('role') == 'outer' and m['type'] == 'way'])
    inners = join_rings([geom(m) for m in e.get('members', []) if m.get('role') == 'inner' and m['type'] == 'way'])
    out = []
    for o in outers:
        o = ccw(o)
        out.append((o, [ccw(i)[::-1] for i in inners if point_in(centroid(i), o)]))
    return out


def centroid(ring):
    return (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))


def point_in(p, ring):
    x, y = p; inside = False
    for i in range(len(ring)):
        x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def jitter(i, spread):
    """Deterministic +/- spread from an OSM id."""
    return 1 + spread * (((i * 2654435761) % 1000) / 500 - 1)


def estimate_height(t, a, i):
    kind = t.get('building', t.get('building:part', 'yes'))
    if kind in ('house', 'residential', 'apartments', 'dormitory'):
        h = 22 if a < 450 else 60 if a < 900 else 95
    elif kind in ('office', 'commercial', 'hotel'):
        h = 16 if a < 400 else 60 if a < 1200 else 120
    elif kind in ('school', 'university', 'college', 'hospital', 'public', 'civic', 'government'):
        h = 20
    elif kind in ('retail', 'supermarket', 'kiosk', 'roof', 'garage', 'parking', 'construction', 'service'):
        h = 6 if kind in ('kiosk', 'roof') else 12
    else:  # 'yes' and friends: small footprints here are urban-village blocks, big ones podiums
        h = 21 if a < 250 else 26 if a < 800 else 40 if a < 3000 else 24
    return round(h * jitter(i, 0.15), 1)


def main(area_name):
    raw = json.loads((ROOT / 'data' / 'osm' / f'{area_name}.json').read_text())
    els = raw['elements']
    lm_ways = {w: k for k, v in LANDMARKS.items() for w in v.get('ways', [])}
    lm_rels = {r: k for k, v in LANDMARKS.items() for r in v.get('relations', [])}
    buildings, roads, water, green, squares, rail = [], [], [], [], [], []
    stats = {'height': 0, 'levels': 0, 'est': 0}
    for e in els:
        t = e.get('tags', {})
        if 'building' in t or 'building:part' in t:
            if t.get('building') in ('construction',) and 'height' not in t and 'building:levels' not in t:
                continue
            # metro station boxes, passages and the odd mall basement are mapped as buildings below ground: they
            # must not stand on the street
            if t.get('location') == 'underground' or (num(t.get('layer')) or 0) < 0 or (num(t.get('level')) or 0) < 0:
                stats['underground'] = stats.get('underground', 0) + 1
                continue
            lm = lm_ways.get(e['id']) if e['type'] == 'way' else lm_rels.get(e['id'])
            if not lm and e['type'] == 'way' and str(e['id']).startswith(str(LANDMARKS['canton_tower']['parts_prefix'])):
                lm = 'canton_tower'
            for outer, holes in polygons(e):
                a = abs(area(outer))
                if a < 12:
                    continue
                h, src = num(t.get('height')), 'height'
                lv = num(t.get('building:levels'))
                if h is None and lv is not None and lv < 150:
                    h, src = lv * 3.3 + 4, 'levels'
                if h is None:
                    h, src = estimate_height(t, a, e['id']), 'est'
                minh = num(t.get('min_height')) or ((num(t.get('building:min_level')) or 0) * 3.3)
                stats[src] += 1
                buildings.append({
                    'id': e['id'], 'name': t.get('name'), 'kind': t.get('building', t.get('building:part')),
                    'part': 'building:part' in t, 'h': round(h, 1), 'minh': round(minh, 1), 'src': src,
                    'area': round(a), 'outer': outer, 'holes': holes, 'landmark': lm,
                    'colour': t.get('building:colour'), 'roof': t.get('roof:shape'),
                })
        elif 'highway' in t and e['type'] == 'way':
            hw = t['highway']
            if hw not in ROAD_WIDTH:
                continue
            g = geom(e)
            if len(g) < 2:
                continue
            oneway = t.get('oneway') in ('yes', '1', 'true') or hw.endswith('_link') and t.get('oneway') != 'no'
            lanes = num(t.get('lanes'))
            w = num(t.get('width')) or (lanes * 3.4 + 1 if lanes and hw in DRIVABLE else ROAD_WIDTH[hw] * (0.55 if oneway and hw in DRIVABLE else 1))
            layer = int(num(t.get('layer')) or 0)
            roads.append({
                'id': e['id'], 'name': t.get('name'), 'hw': hw, 'drive': hw in DRIVABLE, 'oneway': oneway, 'lanes': lanes,
                'w': round(w, 1), 'tunnel': t.get('tunnel') not in (None, 'no') or layer < 0 and t.get('bridge') is None,
                'bridge': t.get('bridge') not in (None, 'no'), 'layer': layer, 'pts': g,
                'area': t.get('area') == 'yes',
            })
        elif t.get('natural') == 'water' or t.get('waterway') == 'riverbank':
            water += [{'id': e['id'], 'name': t.get('name'), 'outer': o, 'holes': hs} for o, hs in polygons(e)]
        elif t.get('leisure') in ('park', 'garden', 'pitch', 'playground', 'stadium') or t.get('landuse') in ('grass', 'recreation_ground'):
            green += [{'id': e['id'], 'name': t.get('name'), 'kind': t.get('leisure') or t.get('landuse'), 'outer': o, 'holes': hs} for o, hs in polygons(e)]
        elif t.get('place') == 'square' or 'area:highway' in t:
            squares += [{'id': e['id'], 'name': t.get('name'), 'outer': o, 'holes': hs} for o, hs in polygons(e)]
        elif 'railway' in t and e['type'] == 'way':
            rail.append({'id': e['id'], 'name': t.get('name'), 'kind': t['railway'], 'tunnel': t.get('tunnel') not in (None, 'no'),
                         'bridge': t.get('bridge') not in (None, 'no'), 'pts': geom(e)})
    s, w, n, e_ = raw['_meta']['bbox']
    (x0, y0), (x1, y1) = proj(s, w), proj(n, e_)
    (cx0, cy0), (cx1, cy1) = proj(CORE_LL[0], CORE_LL[1]), proj(CORE_LL[2], CORE_LL[3])
    core = [cx0, cy0, cx1, cy1]
    def in_core(pts):
        c = centroid(pts)
        return cx0 <= c[0] <= cx1 and cy0 <= c[1] <= cy1
    for b in buildings: b['core'] = in_core(b['outer'])
    for r in roads: r['core'] = any(cx0 <= p[0] <= cx1 and cy0 <= p[1] <= cy1 for p in r['pts'])
    out = {
        'area': area_name, 'origin_latlon': [LAT0, LON0], 'bounds_m': [x0, y0, x1, y1], 'core_m': core,
        'coordinates': 'metres, X east, Y north (Blender Z-up plan)', 'license': raw['_meta']['license'],
        'fetched': raw['_meta']['fetched'], 'landmarks': {k: v['name'] for k, v in LANDMARKS.items()},
        'stats': {'buildings': len(buildings), 'core_buildings': sum(b['core'] for b in buildings), 'core_roads': sum(r['core'] for r in roads), 'height_sources': stats, 'roads': len(roads),
                  'drivable': sum(r['drive'] and not r['tunnel'] for r in roads), 'tunnels': sum(r['tunnel'] for r in roads),
                  'bridges': sum(r['bridge'] for r in roads), 'water': len(water), 'green': len(green), 'squares': len(squares), 'rail': len(rail)},
        'buildings': buildings, 'roads': roads, 'water': water, 'green': green, 'squares': squares, 'rail': rail,
    }
    (ROOT / 'data' / f'{area_name}.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    svg(out, ROOT / 'data' / f'{area_name}_map.svg')
    print('[prep]', json.dumps(out['stats'], ensure_ascii=False))


def svg(d, path):
    x0, y0, x1, y1 = d['bounds_m']
    W, H = x1 - x0, y1 - y0
    s = 1400 / W
    def pt(p): return f'{(p[0] - x0) * s:.1f},{(y1 - p[1]) * s:.1f}'
    def poly(outer, holes, style):
        dd = 'M' + ' L'.join(pt(p) for p in outer) + ' Z' + ''.join(' M' + ' L'.join(pt(p) for p in h) + ' Z' for h in holes)
        return f'<path d="{dd}" fill-rule="evenodd" {style}/>'
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="{H * s:.0f}" viewBox="0 0 1400 {H * s:.0f}" style="background:#f3f1ea">']
    for g in d['green']: parts.append(poly(g['outer'], g['holes'], 'fill="#b9d8a0"'))
    for q in d['squares']: parts.append(poly(q['outer'], q['holes'], 'fill="#e2dccd"'))
    for wv in d['water']: parts.append(poly(wv['outer'], wv['holes'], 'fill="#8ec3de"'))
    for r in sorted(d['roads'], key=lambda r: r['w']):
        if r['area']: continue
        col = '#c9c3b4' if not r['drive'] else '#8a8a8a' if not r['tunnel'] else '#d99'
        dash = ' stroke-dasharray="4 3"' if r['tunnel'] else ''
        parts.append(f'<polyline points="{" ".join(pt(p) for p in r["pts"])}" fill="none" stroke="{col}" stroke-width="{max(0.6, r["w"] * s):.1f}" stroke-linecap="round"{dash}/>')
    for b in sorted(d['buildings'], key=lambda b: b['h']):
        h = b['h']; t = min(1, h / 300)
        col = f'rgb({int(235 - 150 * t)},{int(225 - 140 * t)},{int(210 - 90 * t)})'
        stroke = 'stroke="#d0312d" stroke-width="1.6"' if b['landmark'] else 'stroke="#555" stroke-width="0.3"'
        if b['src'] == 'est': stroke += ' stroke-dasharray="2 1"'
        parts.append(poly(b['outer'], b['holes'], f'fill="{col}" {stroke}'))
    for b in d['buildings']:
        if b['name'] and (b['landmark'] or b['h'] > 200):
            c = centroid(b['outer'])
            parts.append(f'<text x="{(c[0] - x0) * s:.0f}" y="{(y1 - c[1]) * s:.0f}" font-size="11" font-family="PingFang SC, sans-serif" fill="#222">{b["name"]} {b["h"]:.0f}m</text>')
    cx0, cy0, cx1, cy1 = d['core_m']
    parts.append(f'<rect x="{(cx0 - x0) * s:.0f}" y="{(y1 - cy1) * s:.0f}" width="{(cx1 - cx0) * s:.0f}" height="{(cy1 - cy0) * s:.0f}" fill="none" stroke="#1f6fd0" stroke-width="2" stroke-dasharray="8 4"/>')
    # scale bar and origin
    parts.append(f'<rect x="20" y="{H * s - 30:.0f}" width="{500 * s:.0f}" height="4" fill="#222"/><text x="20" y="{H * s - 36:.0f}" font-size="12">500 m</text>')
    parts.append(f'<circle cx="{(0 - x0) * s:.0f}" cy="{(y1 - 0) * s:.0f}" r="4" fill="#d0312d"/>')
    parts.append('<text x="20" y="20" font-size="12" fill="#444">© OpenStreetMap contributors · tianhe_core · 深色=更高 · 虚线轮廓=高度估算 · 红框=地标</text></svg>')
    path.write_text('\n'.join(parts))


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--area') + 1] if '--area' in sys.argv else 'tianhe_core')
