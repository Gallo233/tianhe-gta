"""Context beyond the phase-1 map: the rest of Guangzhou as a procedural far city, the Pearl River continuing
east and west, and Baiyun Mountain on the northern horizon.

  near ring   bounds + 5 km: jittered 160 m street grid, 1-4 lots per block, heights by sector (Tianhe north
              high-rise, Yuexiu/Haizhu mid-rise), density and height thinning with distance; footprints that
              touch water are dropped. Facade families are the city's own, so the far city lights up at night.
  far ground  bounds + 20 km: ground slab cut by the full OSM river polygons (no clipping at the map edge).
  axis north  Tianhe Sports Centre bowl and CITIC Plaza (391 m) on the central axis -- approximate
              positions (not in the downloaded OSM extract), only ever seen kilometres away in haze.
  Baiyun      a low-poly ridge 9-14 km north, 380 m high.
Nothing here is playable; the demo should treat it as a skybox layer.
"""
import math

import bmesh
import bpy
import numpy as np

import gz_city
import gz_common as c
import gz_materials as gm

NEAR = 5000.0
FAR = 20000.0


def far_ground_mat():
    return gm.plain('GZ Ground | far city floor', (0.075, 0.08, 0.07), 0.9, noise=(0.004, (0.05, 0.075, 0.035), 1.4))


def build():
    d = gz_city.data()
    x0, y0, x1, y1 = d['bounds_m']
    col = c.collection('60 • Backdrop (far city)')
    M = gm.ground_mats()
    # ---- far ground ring cut by the unclipped rivers
    E = (x0 - FAR, y0 - FAR, x1 + FAR, y1 + FAR)
    rivers = [w for w in d['water'] if abs(c.ring_area(w['outer'])) >= gz_city.RIVER_MIN_AREA]
    cut_col = bpy.data.collections.new('_far cutters')
    bpy.context.scene.collection.children.link(cut_col)
    for i, w in enumerate(rivers):
        cp = gz_city._clip_poly(w['outer'], w['holes'], (E[0] - 3, E[1] - 3, E[2] + 3, E[3] + 3), 1.0)
        if cp:
            gz_city._prism_object('far cutter %d' % i, [cp], gz_city.RIVER_CUT, 3.0, cut_col)
    outer = [(E[0], E[1]), (E[2], E[1]), (E[2], E[3]), (E[0], E[3])]
    hole = [(x0, y0), (x0, y1), (x1, y1), (x1, y0)]
    ring = gz_city._prism_object('Backdrop | far ground', [(outer, [hole])], -10.0, gz_city.KERB, col)
    gz_city._apply_boolean(ring, cut_col)
    me = ring.data
    me.materials.append(far_ground_mat()); me.materials.append(M['quay'])
    me.polygons.foreach_set('material_index', [0 if (p.normal.z > 0.7 and p.center.z > -0.2) else 1 for p in me.polygons])
    me.polygons.foreach_set('use_smooth', [False] * len(me.polygons))
    gz_city._planar_uv(me)
    for ob in list(cut_col.objects):
        bpy.data.objects.remove(ob)
    bpy.data.collections.remove(cut_col)
    # extend the river plane to the far edge: only the vertices on the map's border move (the plane has holes
    # under the metro entrances, which stay put)
    wat = bpy.data.objects.get('Water | Pearl River')
    if wat:
        for v in wat.data.vertices:
            if abs(v.co.x - (x0 - 3)) < 0.5 or abs(v.co.x - (x1 + 3)) < 0.5:
                v.co.x = E[0] - 3 if v.co.x < (x0 + x1) / 2 else E[2] + 3
            if abs(v.co.y - (y0 - 3)) < 0.5 or abs(v.co.y - (y1 + 3)) < 0.5:
                v.co.y = E[1] - 3 if v.co.y < (y0 + y1) / 2 else E[3] + 3
    # ---- water mask for the near ring (10 m cells)
    R = gz_city.Raster((x0 - NEAR, y0 - NEAR, x1 + NEAR, y1 + NEAR), cs=10.0)
    for w in d['water']:
        R.poly('water', [w['outer']] + w['holes'])
    R.dilate('water', 2)
    far_city(col, R, (x0, y0, x1, y1))
    axis_north(col)
    baiyun(col)


def _sector_height(x, y, b, rng):
    """Height for a far lot: sector base range, occasional towers, thinning with distance from the map."""
    x0, y0, x1, y1 = b
    dx = max(x0 - x, 0, x - x1); dy = max(y0 - y, 0, y - y1)
    dist = math.hypot(dx, dy)
    if y > y1 and x > x0 - 800:      # Tianhe north / Tianhe Road: dense high-rise
        lo, hi, pt, th = 30, 120, 0.12, (150, 260)
    elif x > x1:                      # Tianhe east / Yuancun / Pazhou east
        lo, hi, pt, th = 25, 100, 0.08, (120, 220)
    elif x < x0:                      # Yuexiu / Dongshan: older, mid-rise
        lo, hi, pt, th = 18, 70, 0.04, (90, 160)
    else:                             # Haizhu, south of the river
        lo, hi, pt, th = 20, 90, 0.05, (100, 180)
    k = 1.0 if dist < 2500 else 0.8
    if rng.uniform() < pt * (1.0 if dist < 2500 else 0.5):
        return rng.uniform(*th) * k
    return (lo + (hi - lo) * rng.uniform() ** 1.6) * k


def far_city(col, R, b):
    x0, y0, x1, y1 = b
    FM = gm.building_mats()
    rng = np.random.default_rng(2026)
    buckets = {}
    n = 0
    CELL = 160.0
    gx0, gy0 = x0 - NEAR, y0 - NEAR
    nx, ny = int((x1 - x0 + 2 * NEAR) / CELL), int((y1 - y0 + 2 * NEAR) / CELL)
    for iy in range(ny):
        for ix in range(nx):
            cx = gx0 + (ix + 0.5) * CELL + rng.uniform(-15, 15)
            cy = gy0 + (iy + 0.5) * CELL + rng.uniform(-15, 15)
            if x0 - 40 < cx < x1 + 40 and y0 - 40 < cy < y1 + 40:
                continue
            dist = math.hypot(max(x0 - cx, 0, cx - x1), max(y0 - cy, 0, cy - y1))
            p_lot = 0.85 if dist < 2500 else 0.55
            ang = rng.uniform(-0.12, 0.12)
            ca, sa = math.cos(ang), math.sin(ang)
            for sx in (-1, 1):
                for sy in (-1, 1):
                    if rng.uniform() > p_lot:
                        continue
                    lx, ly = cx + sx * 37, cy + sy * 37
                    w, dpt = rng.uniform(18, 58), rng.uniform(18, 58)
                    h = _sector_height(lx, ly, b, rng)
                    if h > 100:
                        w = dpt = min(w, dpt, 45)
                    pts = [(-w / 2, -dpt / 2), (w / 2, -dpt / 2), (w / 2, dpt / 2), (-w / 2, dpt / 2)]
                    pts = [(lx + ca * px - sa * py, ly + sa * px + ca * py) for px, py in pts]
                    if any(R.at('water', *p) for p in pts + [(lx, ly)]):
                        continue
                    if any(x0 - 5 < p[0] < x1 + 5 and y0 - 5 < p[1] < y1 + 5 for p in pts):
                        continue
                    r = rng.uniform()
                    fam = ('glass' if r < 0.6 else 'office') if h > 100 else ('resi' if r < 0.55 else 'office' if r < 0.8 else 'village' if h < 36 else 'resi')
                    tk = (int((lx - gx0) // 2000), int((ly - gy0) // 2000))
                    key = (fam, tk)
                    if key not in buckets:
                        bm = bmesh.new()
                        buckets[key] = (bm, bm.loops.layers.uv.new('UVMap'), bm.loops.layers.float_color.new('tint'))
                    bm, uv, tl = buckets[key]
                    v = 0.8 + 0.35 * rng.uniform()
                    c.extrude_polygon(bm, pts, [], 0.0, h, uv=uv, tint=(tl, (v, v, v * (0.95 + 0.1 * rng.uniform()), rng.uniform())))
                    n += 1
    for (fam, tk), (bm, uv, tl) in sorted(buckets.items()):
        o = c.obj_from_bmesh('Backdrop | %s %d_%d' % (fam, tk[0], tk[1]), bm, FM[fam], col)
        o['gz_role'] = 'backdrop'
    gz_city.log('backdrop: %d far buildings' % n)


def axis_north(col):
    """Tianhe Sports Centre bowl and CITIC Plaza on the central axis north of Huangpu Avenue (approximate)."""
    FM = gm.building_mats()
    bm = bmesh.new(); uv = bm.loops.layers.uv.new('UVMap'); tl = bm.loops.layers.float_color.new('tint')
    # CITIC Plaza: square 80-storey tower, 322 m roof, twin spires to 391 m, flanked by two 38-storey slabs
    cx, cy = 5.0, 2480.0
    a = 23.0
    c.extrude_polygon(bm, [(cx - a, cy - a), (cx + a, cy - a), (cx + a, cy + a), (cx - a, cy + a)], [], 0, 322, uv=uv, tint=(tl, (0.95, 1.0, 1.0, 0.3)))
    c.extrude_polygon(bm, [(cx - 15, cy - 15), (cx + 15, cy - 15), (cx + 15, cy + 15), (cx - 15, cy + 15)], [], 322, 345, uv=uv, tint=(tl, (0.95, 1.0, 1.0, 0.3)))
    for sx in (-1, 1):
        c.extrude_polygon(bm, [(cx + sx * 70 - 18, cy - 12), (cx + sx * 70 + 18, cy - 12), (cx + sx * 70 + 18, cy + 12), (cx + sx * 70 - 18, cy + 12)], [], 0, 135,
                          uv=uv, tint=(tl, (1.0, 1.0, 1.0, 0.6)))
    o = c.obj_from_bmesh('Backdrop | CITIC Plaza (approx.)', bm, FM['office'], col)
    bm = bmesh.new()
    for sx in (-1, 1):
        res = bmesh.ops.create_cone(bm, segments=6, radius1=1.4, radius2=0.2, depth=46, cap_ends=True)
        for v in res['verts']:
            v.co.x += cx + sx * 9; v.co.y += cy; v.co.z += 345 + 23
    c.obj_from_bmesh('Backdrop | CITIC Plaza spires', bm, gm.plain('GZ Landmark | spire steel', (0.6, 0.6, 0.6), 0.4, 0.6), col)
    # Tianhe Sports Centre: oval stadium bowl
    bm = bmesh.new(); uv = bm.loops.layers.uv.new('UVMap'); tl = bm.loops.layers.float_color.new('tint')
    sx_, sy_ = 0.0, 1820.0
    outer = [(sx_ + 125 * math.cos(t), sy_ + 150 * math.sin(t)) for t in (2 * math.pi * i / 48 for i in range(48))]
    inner = [(sx_ + 80 * math.cos(t), sy_ + 105 * math.sin(t)) for t in (2 * math.pi * i / 48 for i in range(48))][::-1]
    c.extrude_polygon(bm, outer, [inner], 0, 26, uv=uv, tint=(tl, (1.1, 1.1, 1.1, 0.2)))
    c.obj_from_bmesh('Backdrop | Tianhe Sports Centre (approx.)', bm, FM['civic'], col)
    bm = bmesh.new()
    c.fill_polygon(bm, [(sx_ + 78 * math.cos(t), sy_ + 103 * math.sin(t)) for t in (2 * math.pi * i / 48 for i in range(48))], [], 0.05)
    c.obj_from_bmesh('Backdrop | Tianhe stadium pitch', bm, gm.ground_mats()['grass'], col)
    return o


def baiyun(col):
    """Baiyun Mountain: a ridge of smooth peaks 9-14 km north of the axis, max ~380 m."""
    nx, ny = 90, 40
    X0, X1, Y0, Y1 = -9000.0, 7000.0, 9000.0, 16000.0
    peaks = [(-1500, 11500, 380, 1700), (-3200, 12800, 300, 1500), (500, 12500, 260, 1600), (-5200, 11000, 180, 1800),
             (2500, 13500, 220, 2000), (-800, 14500, 250, 2200)]
    bm = bmesh.new()
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            x = X0 + (X1 - X0) * i / nx; y = Y0 + (Y1 - Y0) * j / ny
            z = sum(h * math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * s * s)) for px, py, h, s in peaks)
            z += 18 * math.sin(x * 0.003) * math.sin(y * 0.004) - 6
            row.append(bm.verts.new((x, y, max(-4.0, z))))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    o = c.obj_from_bmesh('Backdrop | Baiyun Mountain', bm, gm.plain('GZ Ground | hillside forest', (0.035, 0.06, 0.03), 0.9,
                                                                 noise=(0.002, (0.06, 0.08, 0.045), 1.2)), col, smooth=True)
    return o
