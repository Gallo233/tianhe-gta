"""Per-building records for the web demo's near-LOD facade detail (and the near-future layer).

    Blender --background --factory-startup --python guangzhou/scripts/export_buildings_json.py

Same selection as gz_city.build_buildings (outlines that contain building:parts are replaced by the parts),
and the same massing (gz_city.building_masses: podium / shaft / setbacks are separate records), so every record
is a prism that is actually rendered: the cleaned outer ring exactly as extruded (CCW, the
facade shader's u runs from ring[0] along it in metres), z0..z1, the facade family and the tint (rgb +
per-building random in a) that the buildings.glb vertex colours carry.

Writes guangzhou/demo/public/assets/tianhe/buildings.json:
    {"families": [...], "b": [[id, fam_index, z0, z1, [r, g, b, a], [[x, y], ...]], ...]}
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gz_city  # noqa: E402
import gz_common as c  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), 'demo', 'public', 'assets', 'tianhe', 'buildings.json')


def main():
    d = gz_city.data()
    x0, y0, x1, y1 = gz_city.bounds()
    cen = gz_city.centroid
    blds = [b for b in d['buildings'] if not b['landmark'] and x0 <= cen(b['outer'])[0] <= x1 and y0 <= cen(b['outer'])[1] <= y1]
    parts = [b for b in blds if b['part']]
    skip = set()
    for b in blds:
        if b['part']:
            continue
        xs = [p[0] for p in b['outer']]; ys = [p[1] for p in b['outer']]
        for p in parts:
            cx, cy = cen(p['outer'])
            if min(xs) <= cx <= max(xs) and min(ys) <= cy <= max(ys) and gz_city.point_in((cx, cy), b['outer']):
                skip.add(b['id']); break
    fams = ['glass', 'office', 'resi', 'village', 'podium', 'civic', 'industrial']
    out = []
    import lm_towers
    scratch = c.collection('buildings.json scratch')      # the named towers build geometry to report their prisms
    for b in blds:
        if b['id'] in skip:
            continue
        fam = gz_city.family(b)
        t = gz_city.tint_for(b, fam)
        masses = lm_towers.build(b, scratch) if lm_towers.handles(b) else gz_city.building_masses(b, fam)
        # one record per rendered prism (podium, shaft, setbacks); crowns and masts carry no near detail
        for ring, z0, z1, mf in masses:
            if mf not in fams:
                continue
            out.append([b['id'], fams.index(mf), round(z0, 2), round(z1, 2), [round(v, 4) for v in t],
                        [[round(p[0], 3), round(p[1], 3)] for p in ring]])
    json.dump({'families': fams, 'b': out}, open(OUT, 'w'), separators=(',', ':'))
    print('[bj] %d buildings (%d outlines replaced by parts) -> %s (%d KB)' % (len(out), len(skip), OUT, os.path.getsize(OUT) // 1024), flush=True)


main()
