"""M1 · Download OpenStreetMap data for the Tianhe CBD (Zhujiang New Town core) slice.

    python3 guangzhou/scripts/fetch_osm.py [--area tianhe_core] [--pois]

--pois fetches named amenities/shops/offices, metro entrances and bus stops (`out center`) into
guangzhou/data/osm/<area>_pois.json -- the demo's delivery and mission points.

Writes guangzhou/data/osm/<area>.json (raw Overpass JSON, `out geom`). Data © OpenStreetMap
contributors, ODbL -- the demo and renders must credit it.

The main Overpass instance and the kumi mirror answer 406 from this machine; the mail.ru mirror works
(2026-09-28), so it is tried first.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

AREAS = {
    # south, west, north, east -- Huangpu Avenue to the Pearl River (plus the south bank for Canton
    # Tower), Guangzhou Avenue to Liede Avenue, with a margin for context.
    'tianhe_core': (23.0985, 113.3085, 23.1305, 113.3455),
}

MIRRORS = [
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]

QUERY = """[out:json][timeout:180];
(
  way["building"]({b});
  relation["building"]({b});
  way["building:part"]({b});
  relation["building:part"]({b});
  way["highway"]({b});
  way["natural"="water"]({b});
  relation["natural"="water"]({b});
  way["waterway"]({b});
  relation["waterway"="riverbank"]({b});
  way["leisure"~"park|garden|pitch|stadium|playground"]({b});
  relation["leisure"~"park|garden"]({b});
  way["landuse"~"grass|recreation_ground|construction|commercial|residential"]({b});
  way["place"="square"]({b});
  way["area:highway"]({b});
  way["man_made"~"bridge|pier"]({b});
  way["railway"]({b});
  node["name"]["tourism"]({b});
  node["name"]["amenity"~"theatre|library|museum"]({b});
);
out geom;"""


# delivery / mission points: anything named that a courier could pick up from or drop at
POI_QUERY = """[out:json][timeout:120];
(
  node["name"]["amenity"]({b}); way["name"]["amenity"]({b});
  node["name"]["shop"]({b}); way["name"]["shop"]({b});
  node["name"]["office"]({b}); way["name"]["office"]({b});
  node["name"]["tourism"]({b});
  node["name"]["leisure"]({b});
  node["railway"="subway_entrance"]({b});
  node["highway"="bus_stop"]({b});
);
out center;"""


def fetch(area: str, pois: bool = False) -> Path:
    s, w, n, e = AREAS[area]
    q = (POI_QUERY if pois else QUERY).replace('{b}', f'{s},{w},{n},{e}')
    body = urllib.parse.urlencode({'data': q}).encode()
    out = ROOT / 'data' / 'osm' / f'{area}{"_pois" if pois else ""}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    last = None
    for url in MIRRORS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(url, data=body, headers={
                    'User-Agent': 'costa-brava-guangzhou-demo/0.1 (personal research project)',
                    'Accept': 'application/json'})
                t0 = time.time()
                with urllib.request.urlopen(req, timeout=240) as r:
                    raw = r.read()
                data = json.loads(raw)
                data['_meta'] = {'area': area, 'bbox': [s, w, n, e], 'source': url, 'fetched': time.strftime('%Y-%m-%d %H:%M:%S'),
                                 'license': 'ODbL 1.0, (c) OpenStreetMap contributors'}
                out.write_text(json.dumps(data, ensure_ascii=False))
                print(f'[osm] {area}: {len(data["elements"])} elements, {len(raw) // 1024} KB from {url} in {time.time() - t0:.1f}s')
                return out
            except Exception as ex:                       # noqa: BLE001 -- try the next mirror
                last = f'{url}: {ex}'
                print('[osm] retry:', last, file=sys.stderr)
                time.sleep(3)
    raise SystemExit(f'all mirrors failed: {last}')


if __name__ == '__main__':
    area = sys.argv[sys.argv.index('--area') + 1] if '--area' in sys.argv else 'tianhe_core'
    fetch(area, pois='--pois' in sys.argv)
