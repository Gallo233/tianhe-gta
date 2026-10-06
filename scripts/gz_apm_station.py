"""APM station template (lotus-pond standard: real parts, no boxes standing in for things), from the Commons
photographs of 海心沙 / 花城大道 / 大剧院 / 妇儿中心 / 广州塔 platforms and the 大剧院 concourse.

Local frame (the demo places one per station by gz_apm.stations()): +Y along the line (north, u), +X east (v = -x),
z = world height (gz_apm levels). Built with gz_streetkit's Part helper.

    apm_platform      island platform, screen doors both sides, ceiling, stair + escalator bank up to the concourse,
                      track wells with trackside walls and advertising light boxes, platform end walls
    apm_concourse     the fittings inside the concourse (its shell -- floor, walls, ceiling -- is generated per station
                      with the passages, gz_apm_build): floor bands, columns, ceiling lights, the two gate lines with
                      glass fences, the balustrade round the stair opening, ticket machines, service booth
    apm_cols_<style>  the platform columns for each station finish (round white / square blue / square white /
                      round cream with a square capital / the exposed ceiling with pink panels of 妇儿中心)
    apm_station_col   collision proxy (platform, screen-door lines, stair ramp and its sides, the concourse fences,
                      the gate cabinets, columns, end walls, ceilings for the camera)
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import gz_apm as A  # noqa: E402
from gz_streetkit import Part, mat  # noqa: E402

PZ, CZ = A.PLAT_Z, A.CONC_Z
PH, CH = A.PLAT_H, A.CONC_H
RZ = A.RAIL_Z
IV, TV, BV = A.ISLAND_V, A.TRACK_V, A.BOX_V
PU, SU, BU = A.PLAT_U, A.PSD_U, A.BOX_U
CV = A.CONC_V
# train doors: two cars of 12.75 m, two double doors a side each (APM 100)
DOORS = (-9.7, -3.3, 3.3, 9.7)
DOOR_W = 1.9
PSD_TOP = PZ + 2.55
COLS_U = (-17.0, 5.5, 13.5)


def M():
    return {
        'granite': mat('apm floor granite', '#b9b8b3', 0.0, 0.18),
        'granite_dark': mat('apm floor granite dark', '#3c3c3e', 0.0, 0.2),
        'white_tile': mat('apm concourse tile', '#eceae6', 0.0, 0.12),
        'yellow': mat('apm yellow line', '#e2b21c', 0.0, 0.4),
        'tactile': mat('apm tactile', '#8d978f', 0.0, 0.6),
        'green': mat('apm door mark', '#3aa05a', 0.0, 0.5),
        'ss': mat('apm stainless', '#c9ccd0', 0.9, 0.22),
        'frame': mat('apm door frame', '#1d1f22', 0.4, 0.35),
        'glass': mat('apm glass', '#a9c3cc', 0.0, 0.04, alpha=0.28),
        'red': mat('apm door warning', '#c8323a', 0.0, 0.4),
        'header': mat('apm door header', '#eef1f4', 0.0, 0.35, emit=0.35),
        'blue': mat('apm header blue', '#5aa7dc', 0.0, 0.35),
        'ceiling': mat('apm ceiling panel', '#eef0f1', 0.2, 0.45),
        'void': mat('apm ceiling void', '#141619', 0.0, 0.9),
        'light': mat('apm light strip', '#fbfdff', 0.0, 0.3, emit=5.0),
        'down': mat('apm downlight', '#fff6e6', 0.0, 0.3, emit=4.0),
        'wall': mat('apm wall panel', '#e7e4dc', 0.05, 0.6),
        'stone': mat('apm wall stone', '#d9cfbf', 0.0, 0.85),
        'track_wall': mat('apm trackside wall', '#4a4d52', 0.0, 0.8),
        'bed': mat('apm track bed', '#3a3b3d', 0.0, 0.95),
        'ad': mat('apm ad lightbox', '#fff4dc', 0.0, 0.3, emit=2.2),
        'black': mat('apm escalator black', '#151515', 0.2, 0.4),
        'alu': mat('apm escalator steps', '#8e9296', 0.85, 0.35),
        'screen': mat('apm screen', '#0f1a24', 0.2, 0.3, emit=1.4),
        'machine': mat('apm ticket machine red', '#c42a2a', 0.3, 0.35),
        'gtop': mat('apm gate top', '#2b2e33', 0.3, 0.3),
        'arrow': mat('apm gate arrow', '#29d17a', 0.0, 0.3, emit=3.0),
        'col_white': mat('apm column white', '#eceeef', 0.1, 0.25),
        'col_blue': mat('apm column blue', '#6f9bd6', 0.1, 0.25),
        'col_cream': mat('apm column cream', '#e6dcc4', 0.1, 0.3),
        'col_joint': mat('apm column joint', '#6d6f73', 0.0, 0.6),
        'pink': mat('apm ceiling pink', '#e58aa6', 0.0, 0.5),
    }


def ring_rect(x0, x1, y0, y1, z):
    return [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]


# ------------------------------------------------------------------------------------------ platform level
def platform(col):
    p = Part('apm_platform')
    m = M()
    # island slab, polished granite, with a dark border band and a tactile + yellow line along both screen-door lines
    p.box(m['granite'], (0, 0, PZ - 0.6), (2 * IV, 2 * PU, 1.2))
    for s in (-1, 1):
        p.box(m['ss'], (s * (IV - 0.02), 0, PZ - 0.02), (0.05, 2 * PU, 0.06))
        p.box(m['yellow'], (s * (IV - 0.45), 0, PZ + 0.002), (0.1, 2 * PU - 0.4, 0.004))
        p.box(m['tactile'], (s * (IV - 0.85), 0, PZ + 0.003), (0.4, 2 * PU - 1.0, 0.006))
        for u in DOORS:                                                # where to stand: green arrows either side
            for d in (-1, 1):
                p.box(m['green'], (s * (IV - 0.25), u + d * (DOOR_W / 2 + 0.35), PZ + 0.003), (0.35, 0.5, 0.005))
    # screen doors: black frames, glass leaves with a red warning band, fixed panels, end doors, header box
    for s in (-1, 1):
        x = s * IV
        stops = sorted([-SU, SU] + [u - DOOR_W / 2 for u in DOORS] + [u + DOOR_W / 2 for u in DOORS])
        for u in stops:
            p.box(m['frame'], (x, u, (PZ + PSD_TOP) / 2), (0.12, 0.1, PSD_TOP - PZ))
        # fixed panels between doors (and the stretch past the doors to the platform ends: full-height glass)
        spans = [(-PU + 0.3, -SU)] + [(a + DOOR_W / 2, b - DOOR_W / 2) for a, b in zip(DOORS, DOORS[1:])] + [(SU, PU - 0.3)]
        spans.insert(1, (-SU, DOORS[0] - DOOR_W / 2))
        spans.insert(len(spans) - 1, (DOORS[-1] + DOOR_W / 2, SU))
        for a, b in spans:
            top = PSD_TOP if -SU - 0.01 <= a and b <= SU + 0.01 else PZ + PH
            p.box(m['glass'], (x, (a + b) / 2, (PZ + top) / 2), (0.02, b - a - 0.1, top - PZ - 0.1))
            p.box(m['frame'], (x, (a + b) / 2, PZ + 0.1), (0.1, b - a, 0.2))
        # (the door leaves are apm_psd_leaf, placed and slid by the demo)
        # header: white sign panel (the demo writes the station and direction on it), blue band, bulkhead to ceiling
        p.box(m['header'], (x - s * 0.02, 0, PSD_TOP + 0.35), (0.16, 2 * SU + 0.2, 0.7))
        p.box(m['blue'], (x - s * 0.03, 0, PSD_TOP + 0.78), (0.16, 2 * SU + 0.2, 0.16))
        p.box(m['wall'], (x, 0, (PSD_TOP + 0.86 + PZ + PH) / 2), (0.14, 2 * SU + 0.2, PZ + PH - PSD_TOP - 0.86))
        for u in DOORS:                                                # door-status lamps
            p.box(m['arrow'], (x - s * 0.1, u, PSD_TOP + 0.04), (0.04, 0.3, 0.06))
    # ceiling: panels with dark gaps, a light strip along each screen-door line, downlights down the middle
    o0, o1 = A.STAIR_OPEN
    sx = A.STAIR_X
    for a_, b_ in ((-PU, o0), (o1, PU)):
        p.box(m['void'], (0, (a_ + b_) / 2, PZ + PH + 0.3), (2 * IV + 0.4, b_ - a_, 0.05))
    for s in (-1, 1):
        p.box(m['void'], (s * (sx + IV + 0.2) / 2, (o0 + o1) / 2, PZ + PH + 0.3), (IV + 0.2 - sx, o1 - o0, 0.05))
    for s in (-1, 1):
        p.box(m['light'], (s * (IV - 0.55), 0, PZ + PH - 0.01), (0.25, 2 * PU - 1.0, 0.02))
    # platform end walls (staff doors), with the track wells' end walls beyond the platform ends
    for e in (-1, 1):
        y = e * PU
        p.box(m['wall'], (0, y + e * 0.1, (PZ + PZ + PH) / 2), (2 * IV, 0.2, PH))
        p.box(m['frame'], (1.2, y - e * 0.01, PZ + 1.05), (1.0, 0.04, 2.1))
        p.box(m['screen'], (-1.6, y - e * 0.02, PZ + 2.9), (1.4, 0.03, 0.8))
    # trackside: bed, platform-edge face, outer walls with light boxes, ceiling over the wells
    for s in (-1, 1):
        cx = s * (IV + BV) / 2
        p.box(m['bed'], (cx, 0, RZ - 0.45), (BV - IV, 2 * PU, 0.2))
        p.box(m['track_wall'], (s * (IV + 0.05), 0, (RZ - 0.35 + PZ) / 2), (0.1, 2 * PU, PZ - RZ + 0.35))
        p.box(m['track_wall'], (s * (BV + 0.1), 0, (RZ - 0.35 + PZ + PH) / 2), (0.2, 2 * PU, PZ + PH - RZ + 0.35))
        for u in (-12.0, 0.0, 12.0):
            p.box(m['frame'], (s * BV, u, PZ + 1.6), (0.08, 6.2, 2.3))
            p.box(m['ad'], (s * (BV - 0.05), u, PZ + 1.6), (0.03, 6.0, 2.1))
        p.box(m['void'], (cx, 0, PZ + PH + 0.3), (BV - IV, 2 * PU, 0.05))
    # stair + escalator bank from the concourse (north, u = STAIR_TOP) down to the platform, heading south
    bank(p, m)
    return p.build(col)


def bank(p, m):
    """Fixed stair (west half, x < 0) and up escalator (east half) between concourse and platform."""
    top, sx = A.STAIR_TOP, A.STAIR_X
    rise = CZ - PZ
    n = int(round(rise / 0.15))
    tread = 0.3
    x0, x1 = -sx + 0.1, -0.15                       # stair
    for k in range(n):
        zt = CZ - 0.15 * (k + 1)
        y1 = top - tread * k
        p.box(m['granite'], ((x0 + x1) / 2, y1 - tread / 2, zt - 0.075), (x1 - x0, tread, 0.15))
        p.box(m['granite_dark'], ((x0 + x1) / 2, y1 - tread + 0.03, zt + 0.002), (x1 - x0, 0.05, 0.004))
    foot = top - tread * (n - 1)
    # escalator (30 degrees) with flat comb plates top and bottom
    e0, e1 = 0.05, sx - 0.1
    run = rise / math.tan(math.radians(30))
    y_top, y_bot = top - 1.0, top - 1.0 - run
    p.box(m['alu'], ((e0 + e1) / 2, top - 0.5, CZ - 0.02), (e1 - e0 - 0.3, 1.0, 0.04))
    p.box(m['alu'], ((e0 + e1) / 2, y_bot - 0.5, PZ - 0.02), (e1 - e0 - 0.3, 1.0, 0.04))
    ns = int(run / 0.4)
    for k in range(ns):
        ya = y_top - run * k / ns
        zt = CZ - rise * (k + 1) / ns
        p.box(m['alu'], ((e0 + e1) / 2, ya - run / ns / 2, zt - 0.06), (e1 - e0 - 0.3, run / ns, 0.12))
        p.box(m['yellow'], ((e0 + e1) / 2, ya - 0.03, zt + 0.002), (e1 - e0 - 0.3, 0.04, 0.004))
    for bx in (e0 + 0.075, e1 - 0.075):
        pts = [(top + 0.3, CZ), (y_top, CZ), (y_bot, PZ), (y_bot - 1.3, PZ)]
        for (ya, za), (yb, zb) in zip(pts, pts[1:]):
            p.slab(m['black'], (yb, zb + 0.28), (ya, za + 0.28), 0.15, 0.45, bx)
            p.slab(m['glass'], (yb, zb + 0.98), (ya, za + 0.98), 0.02, 0.7, bx)
            p.slab(m['black'], (yb, zb + 1.04), (ya, za + 1.04), 0.1, 0.07, bx)
    # glass balustrades on the stair's outer side and the middle, stainless handrails
    for bx in (x0 - 0.05, x1 + 0.05):
        p.slab(m['glass'], (foot, PZ + 1.0), (top, CZ + 1.0), 0.02, 0.9, bx)
        p.cyl(m['ss'], (bx, foot - 0.3, PZ + 0.95), (bx, top + 0.3, CZ + 0.95), 0.025, 8)
    # the enclosure under the bank on the platform (white panels) and its underside
    for bx in (-sx, sx):
        p.solid(m['wall'], [[(bx - 0.03, foot, PZ), (bx - 0.03, top, PZ), (bx - 0.03, top, CZ - 0.6), (bx - 0.03, foot, PZ + 0.05)],
                            [(bx + 0.03, foot, PZ), (bx + 0.03, top, PZ), (bx + 0.03, top, CZ - 0.6), (bx + 0.03, foot, PZ + 0.05)]])
    p.box(m['wall'], (0, top + 0.05, (PZ + CZ - 0.6) / 2), (2 * sx, 0.1, CZ - 0.6 - PZ))


def psd_leaf(col):
    """One screen-door leaf centred on the origin along Y (DOOR_W / 2 wide), from the platform up to the header."""
    p = Part('apm_psd_leaf')
    m = M()
    w, h = DOOR_W / 2, PSD_TOP - PZ
    p.box(m['glass'], (0, 0, PZ + h / 2), (0.03, w - 0.08, h - 0.08))
    for d in (-1, 1):
        p.box(m['frame'], (0, d * (w / 2 - 0.03), PZ + h / 2), (0.05, 0.06, h))
    p.box(m['frame'], (0, 0, PZ + 0.05), (0.05, w, 0.1))
    p.box(m['red'], (0, 0, PZ + 1.35), (0.035, w - 0.1, 0.16))
    p.box(m['yellow'], (0, 0, PZ + 0.3), (0.035, w - 0.1, 0.1))
    return p.build(col)


# ------------------------------------------------------------------------------------------ concourse fittings
def concourse(col):
    p = Part('apm_concourse')
    m = M()
    z = CZ
    # black granite bands in the white floor (every 6 m across, two lengthwise)
    for u in range(-30, 31, 6):
        p.box(m['granite_dark'], (0, u, z + 0.002), (2 * CV - 0.2, 0.5, 0.004))
    for x in (-5.5, 5.5):
        p.box(m['granite_dark'], (x, 0, z + 0.002), (0.5, 2 * BU - 0.2, 0.004))
    # round white columns, a dark plinth, a stainless skirt
    for x in (-5.5, 5.5):
        for u in (-28, -20, -12, -4, 4, 12, 20, 28):
            p.cyl(m['col_white'], (x, u, z), (x, u, z + CH), 0.4, 20)
            p.cyl(m['ss'], (x, u, z), (x, u, z + 0.12), 0.42, 20)
    # ceiling: downlights on a 3 m grid, black recessed bands over the floor bands
    for u in range(-30, 31, 6):
        p.box(m['void'], (0, u, z + CH - 0.01), (2 * CV - 0.2, 0.5, 0.02))
    for u in [x * 3.0 + 1.5 for x in range(-10, 10)]:
        for x in (-8.0, -2.8, 2.8, 8.0):
            p.cyl(m['down'], (x, u, z + CH - 0.03), (x, u, z + CH - 0.015), 0.13, 12)
    # the opening down to the platform: a glass balustrade on three sides (open to the north, where the bank starts)
    o0, o1 = A.STAIR_OPEN
    sx = A.STAIR_X
    for x in (-sx - 0.05, sx + 0.05):
        p.box(m['glass'], (x, (o0 + o1) / 2, z + 0.55), (0.02, o1 - o0, 1.0))
        p.cyl(m['ss'], (x, o0, z + 1.08), (x, o1, z + 1.08), 0.03, 8)
    p.box(m['glass'], (0, o0 - 0.05, z + 0.55), (2 * sx + 0.1, 0.02, 1.0))
    p.cyl(m['ss'], (-sx - 0.05, o0 - 0.05, z + 1.08), (sx + 0.05, o0 - 0.05, z + 1.08), 0.03, 8)
    # gate lines at both ends of the paid area: six channels in the middle, glass fences to the walls
    for gu in A.PAID_U:
        cabs = [-4.2 + 1.2 * k for k in range(8)]
        for x in cabs:
            p.box(m['ss'], (x, gu, z + 0.475), (0.24, 1.3, 0.95), 0.02)
            p.box(m['gtop'], (x, gu, z + 0.975), (0.26, 1.32, 0.05), 0.01)
            for d in (-1, 1):
                p.box(m['arrow'], (x, gu + d * 0.55, z + 1.002), (0.1, 0.1, 0.004))
        for s in (-1, 1):
            a, b = 4.4, CV - 0.05
            p.box(m['glass'], (s * (a + b) / 2, gu, z + 0.6), (b - a, 0.02, 1.1))
            for x in [a + (b - a) * k / 4 for k in range(5)]:
                p.cyl(m['ss'], (s * x, gu, z), (s * x, gu, z + 1.15), 0.03, 8)
            p.cyl(m['ss'], (s * a, gu, z + 1.15), (s * b, gu, z + 1.15), 0.025, 8)
    # ticket machines along the walls in both unpaid ends, a service booth by the north gate line
    for u in (A.PAID_U[1] + 4.0, A.PAID_U[1] + 5.2, A.PAID_U[0] - 4.0, A.PAID_U[0] - 5.2):
        for s in (-1, 1):
            p.box(m['machine'], (s * (CV - 0.45), u, z + 0.85), (0.8, 1.0, 1.7), 0.03)
            p.box(m['screen'], (s * (CV - 0.86), u, z + 1.25), (0.02, 0.6, 0.45))
    bu = A.PAID_U[1] - 1.8
    p.box(m['frame'], (-7.5, bu, z + 1.25), (3.0, 2.4, 2.5), 0.02)
    p.box(m['glass'], (-7.5, bu, z + 1.45), (3.04, 2.44, 1.2))
    p.box(m['header'], (-7.5, bu - 1.23, z + 2.25), (2.6, 0.04, 0.35))
    # hanging direction signs over the gates and the stair (the demo writes on them)
    for u in (A.PAID_U[1] + 0.8, A.PAID_U[0] - 0.8, A.STAIR_TOP + 1.2):
        p.box(m['frame'], (0, u, z + CH - 0.55), (4.6, 0.18, 0.5))
        for rod in (-2.0, 2.0):
            p.cyl(m['ss'], (rod, u, z + CH - 0.3), (rod, u, z + CH), 0.015, 6)
    return p.build(col)


# ------------------------------------------------------------------------------------------ platform columns
def columns(col, style):
    p = Part('apm_cols_' + style)
    m = M()
    colour = {'white_round': 'col_white', 'white_square': 'col_white', 'blue_square': 'col_blue',
              'cream_round': 'col_cream', 'pink_open': 'col_white'}[style]
    top = PZ + PH
    for u in COLS_U:
        if 'round' in style or style == 'pink_open':
            p.cyl(m[colour], (0, u, PZ), (0, u, top), 0.45, 24)
            p.cyl(m['frame'], (0, u, PZ), (0, u, PZ + 0.15), 0.47, 24)
            for k in range(1, 6):
                zj = PZ + 0.15 + k * 0.7
                p.cyl(m['col_joint'], (0, u, zj - 0.006), (0, u, zj + 0.006), 0.455, 24)
            if style == 'cream_round':                                  # the square capital flaring into the ceiling
                p.solid(m[colour], [ring_rect(-0.47, 0.47, u - 0.47, u + 0.47, top - 0.6), ring_rect(-0.8, 0.8, u - 0.8, u + 0.8, top - 0.25),
                                    ring_rect(-0.8, 0.8, u - 0.8, u + 0.8, top)])
        else:
            p.box(m[colour], (0, u, (PZ + top) / 2), (0.9, 0.9, PH), 0.02)
            p.box(m['frame'], (0, u, PZ + 0.08), (0.94, 0.94, 0.16))
            for k in range(1, 5):
                zj = PZ + 0.16 + k * 0.78
                p.box(m['col_joint'], (0, u, zj), (0.912, 0.912, 0.012))
        # a platform screen (next train) on each face of the middle column, a bin by each
        if u == COLS_U[1]:
            for s in (-1, 1):
                p.box(m['frame'], (s * 0.62, u, PZ + 2.6), (0.12, 1.1, 0.65))
                p.box(m['screen'], (s * 0.69, u, PZ + 2.6), (0.02, 1.0, 0.56))
        p.box(m['ss'], (0.0, u - 0.75, PZ + 0.45), (0.45, 0.35, 0.9), 0.03)
    # benches between the columns
    for u in (9.5, 17.5, -14.0):
        p.box(m['ss'], (0, u, PZ + 0.43), (0.5, 1.9, 0.05), 0.01)
        for d in (-0.8, 0.8):
            p.box(m['ss'], (0, u + d, PZ + 0.21), (0.4, 0.05, 0.42))
    # the ceiling finish down the middle of the island
    if style == 'pink_open':
        p.box(m['void'], (0, 0, top + 0.2), (4.2, 2 * PU, 0.05))
        o0, o1 = A.STAIR_OPEN
        for u in range(-18, 19, 6):
            if o0 - 2 < u < o1 + 2:
                continue
            for x in (-1.1, 1.1):
                p.box(m['pink'], (x, u, top - 0.3), (1.6, 3.8, 0.04))
        for s in (-1, 1):
            p.box(m['ceiling'], (s * 3.1, 0, top), (1.8, 2 * PU, 0.05))
    else:
        o0, o1 = A.STAIR_OPEN
        for u in [-PU + 0.9 + 1.8 * k for k in range(int(2 * PU / 1.8))]:
            for x in (-2.4, 0.0, 2.4):
                if o0 - 0.9 < u < o1 + 0.9 and abs(x) < A.STAIR_X + 1.2:
                    continue                                           # the opening over the stair
                p.box(m['ceiling'], (x, u, top), (2.35, 1.75, 0.05))
        for u in (-15.0, 9.5):                                         # hanging light boxes
            p.box(m['light'], (0, u, top - 0.4), (1.2, 1.2, 0.08))
    return p.build(col)


# ------------------------------------------------------------------------------------------ collision
def collision(col):
    p = Part('apm_station_col')
    c = mat('apm collision', '#ff00ff', 0.0, 1.0)
    def bx(x0, x1, y0, y1, z0, z1):
        p.box(c, ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0))
    bx(-IV, IV, -PU, PU, PZ - 1.0, PZ)                              # platform
    for s in (-1, 1):
        bx(s * IV - 0.08, s * IV + 0.08, -PU, PU, PZ, PZ + PH)       # screen-door lines (the train is boarded by trigger)
    for e in (-1, 1):
        bx(-IV, IV, e * PU, e * (PU + 0.3), PZ, PZ + PH)             # end walls
    o0, o1 = A.STAIR_OPEN
    for a_, b_ in ((-PU, o0), (o1, PU)):
        bx(-IV - 1, IV + 1, a_, b_, PZ + PH, PZ + PH + 0.3)          # ceiling (camera), open over the stair
    for s_ in (-1, 1):
        bx(min(s_ * (A.STAIR_X + 0.1), s_ * (IV + 1)), max(s_ * (A.STAIR_X + 0.1), s_ * (IV + 1)), o0, o1, PZ + PH, PZ + PH + 0.3)
    for u in COLS_U:
        bx(-0.5, 0.5, u - 0.5, u + 0.5, PZ, PZ + PH)
    # the bank: one ramp over stair + escalator, sides up to the handrails, the enclosure underneath
    top, sx = A.STAIR_TOP, A.STAIR_X
    rise = CZ - PZ
    foot = top - 0.3 * (int(round(rise / 0.15)) - 1)
    p.slab(c, (foot, PZ), (top, CZ), 2 * sx - 0.2, 0.3)
    for s in (-1, 1):
        p.slab(c, (foot, PZ + 1.1), (top, CZ + 1.1), 0.1, rise + 1.1, s * sx)
    bx(-sx, sx, top, top + 0.1, PZ, CZ - 0.3)                       # the enclosure's north face
    # concourse: the fence round the opening, gate cabinets and glass fences
    o0, o1 = A.STAIR_OPEN
    for s in (-1, 1):
        bx(s * sx - 0.06, s * sx + 0.06, o0, o1, CZ, CZ + 1.1)
    bx(-sx, sx, o0 - 0.1, o0, CZ, CZ + 1.1)
    for gu in A.PAID_U:
        for x in [-4.2 + 1.2 * k for k in range(8)]:
            bx(x - 0.12, x + 0.12, gu - 0.65, gu + 0.65, CZ, CZ + 1.0)
        for s in (-1, 1):
            bx(min(s * 4.4, s * CV), max(s * 4.4, s * CV), gu - 0.05, gu + 0.05, CZ, CZ + 1.15)
    for x in (-5.5, 5.5):
        for u in (-28, -20, -12, -4, 4, 12, 20, 28):
            bx(x - 0.4, x + 0.4, u - 0.4, u + 0.4, CZ, CZ + CH)
    bu = A.PAID_U[1] - 1.8
    bx(-9.0, -6.0, bu - 1.2, bu + 1.2, CZ, CZ + 2.5)
    return p.build(col)


STYLES = ('white_round', 'blue_square', 'white_square', 'cream_round', 'pink_open')


def build_all(col):
    objs = [platform(col), concourse(col), collision(col), psd_leaf(col)]
    objs += [columns(col, s) for s in STYLES]
    for o in objs:
        print('[apm-station]', o.name, sum(len(f.vertices) - 2 for f in o.data.polygons), 'tris', flush=True)
    return objs
