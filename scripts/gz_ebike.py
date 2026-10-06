"""Ah Jie's delivery e-scooter (电鸡) -- the hero vehicle, built part by part (lotus-pond standard).

    Blender --background --factory-startup --python guangzhou/scripts/gz_ebike.py -- [--no-preview]

After Commons photographs of Chinese delivery riders (a Meituan rider at a crossing, one in Qingdao, a step-through
e-bike with a rear rack in Beijing) and the step-through e-scooters Guangzhou's riders use: 12" wheels, a 1.28 m
wheelbase, a long seat at 0.78 m, a flat footboard, the leg shield and headlight cowl round a raked steering head,
and -- the part that makes it a delivery bike -- a big insulated box on an extended rear rack BEHIND the seat,
overhanging the rear wheel, with the tail lamp and plate hung under it. The rider sits in front of the box.

Frame (Blender): X right, Y forward, Z up; the origin on the ground midway between the axles.
Nodes (exported as a hierarchy under `ebike`):

    ebike_body        frame, footboard, bodywork, seat, rack, box, rear shocks, swing arm, mudguard, tail lamp
    ebike_steer       pivot at the front axle, rotated RAKE about X: its local Z is the steering axis (three.js:
                      local +Y). Fork, fender, cowl with the lamp, handlebar, grips, muffs, mirrors, phone holder
      ebike_wheel_f   front wheel (spins about its local X), disc rotor
      ebike_screen    the phone's screen (UV 0..1; the demo draws the order map on it)
    ebike_wheel_r     rear wheel with the hub motor (spins about local X)
    ebike_stand       side stand, pivot at its hinge; rotate about local X to fold it up
    ebike_lid         the box lid, hinged at the back edge; rotate about local X to open it
    ebike_logo        the box's logo panels (UV 0..1 each)
    ebike_plate       the number plate (UV 0..1)

Writes guangzhou/demo/public/assets/vehicles/gz_ebike.glb and gz_ebike.json (rider points, dimensions).
"""
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gz_streetkit import Part, srgb  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'vehicles')
PREV = os.path.join(ROOT, 'renders', 'vehicles')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

# ------------------------------------------------------------------ dimensions (metres)
R_TYRE = 0.232          # 90/90-12: 305 mm rim + 2 x 81 mm sidewall
R_RIM = 0.153
TYRE_W = 0.092
AX_F, AX_R = 0.64, -0.64
RAKE = math.radians(25)
SEAT_Z = 0.78
SEAT_Y0, SEAT_Y1 = -0.66, 0.0      # rear, front end of the seat
FLOOR_Z = 0.30
BAR_L = (1.02 - R_TYRE) / math.cos(RAKE)    # handlebar centre along the steering axis
BOX = dict(w=0.50, d=0.44, h=0.42, y0=-1.08, z0=0.815)     # the box sits on the rack behind the seat
LIME = '#c6f03c'

MATS = {}


def emat(key, hexc, metal=0.0, rough=0.5, emit=0.0, alpha=1.0, coat=0.0):
    if key in MATS:
        return MATS[key]
    m = bpy.data.materials.new('GZE | ' + key)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    col = srgb(hexc)
    b.inputs['Base Color'].default_value = (*col, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat:
        b.inputs['Coat Weight'].default_value = coat
    if emit:
        b.inputs['Emission Color'].default_value = (*col, 1)
        b.inputs['Emission Strength'].default_value = emit
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    m.diffuse_color = (*col, 1)
    MATS[key] = m
    return m


def M():
    return {
        'paint': emat('ebike paint lime', LIME, 0.0, 0.32, coat=0.6),
        'black': emat('ebike plastic black', '#1c1e21', 0.0, 0.55),
        'gloss': emat('ebike gloss black', '#0c0d0f', 0.0, 0.22, coat=0.8),
        'seat': emat('ebike seat', '#151515', 0.0, 0.62),
        'rubber': emat('ebike rubber', '#191919', 0.0, 0.92),
        'alu': emat('ebike aluminium', '#b9bec3', 1.0, 0.32),
        'chrome': emat('ebike chrome', '#dfe3e6', 1.0, 0.1),
        'steel': emat('ebike steel dark', '#35383c', 0.8, 0.45),
        'rim': emat('ebike rim', '#2a2d31', 0.7, 0.35),
        'spring': emat('ebike spring red', '#c8262b', 0.3, 0.35),
        'head': emat('ebike headlamp', '#fff7e8', 0.0, 0.15, emit=6.0),
        'drl': emat('ebike drl', '#e8f6ff', 0.0, 0.15, emit=4.0),
        'tail': emat('ebike taillamp', '#ff2a1a', 0.0, 0.2, emit=3.0),
        'amber': emat('ebike indicator', '#ff9a1f', 0.0, 0.25, emit=0.6),
        'glass': emat('ebike mirror glass', '#9fb3bf', 1.0, 0.02),
        'lens': emat('ebike lens', '#d8e4ea', 0.0, 0.05, alpha=0.45),
        'box': emat('ebike box fabric', LIME, 0.0, 0.78),
        'boxdark': emat('ebike box piping', '#15171a', 0.0, 0.7),
        'reflect': emat('ebike reflective strip', '#c9ced2', 0.4, 0.28),
        'strap': emat('ebike bungee strap', '#f07a1e', 0.0, 0.6),
        'bag': emat('ebike plastic bag', '#d8322f', 0.0, 0.45),
        'dash': emat('ebike dash lcd', '#2f6b8f', 0.0, 0.2, emit=1.2),
        'reflector': emat('ebike reflector', '#ff5a1a', 0.0, 0.3, emit=0.3),
        'logo': emat('ebike logo', '#ffffff', 0.0, 0.7),
        'plate': emat('ebike plate', '#f2f2ea', 0.3, 0.4),
        'screen': emat('ebike phone screen', '#1a2a33', 0.0, 0.1, emit=1.0),
    }


# ------------------------------------------------------------------ geometry helpers on a Part
def verts_after(bm, fn):
    """Run fn() adding geometry to bm, return the vertices it added."""
    before = set(bm.verts)
    fn()
    return [v for v in bm.verts if v not in before]


def revolve(p, m, prof, seg=28, closed=False, xf=Matrix.Identity(4), cap=False):
    """Surface of revolution about local Z of (r, z) points; closed joins the last point back to the first (a
    torus-like tyre). xf places it (e.g. turn the axis onto X for a wheel)."""
    bm = p._bm(m)
    rings = []
    for r, z in prof:
        ring = []
        for k in range(seg):
            a = 2 * math.pi * k / seg
            ring.append(bm.verts.new(xf @ Vector((r * math.cos(a), r * math.sin(a), z))))
        rings.append(ring)
    n = len(rings)
    for i in range(n - (0 if closed else 1)):
        A, B = rings[i], rings[(i + 1) % n]
        for k in range(seg):
            bm.faces.new((A[k], A[(k + 1) % seg], B[(k + 1) % seg], B[k]))
    if not closed and cap:
        if prof[-1][0] > 1e-4:
            bm.faces.new(rings[-1])
        if prof[0][0] > 1e-4:
            bm.faces.new(list(reversed(rings[0])))


def loft(p, m, rings, cap=True):
    p.solid(m, rings, cap)


def rrect_xz(y, x0, x1, z0, z1, r, n=4):
    """Rounded rectangle in the XZ plane at y (points counter-clockwise seen from +Y)."""
    r = min(r, (x1 - x0) / 2 - 1e-4, (z1 - z0) / 2 - 1e-4)
    pts = []
    for cx, cz, a0 in ((x1 - r, z0 + r, -90), (x1 - r, z1 - r, 0), (x0 + r, z1 - r, 90), (x0 + r, z0 + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), y, cz + r * math.sin(a)))
    return pts


def rrect_xy(z, x0, x1, y0, y1, r, n=4):
    r = min(r, (x1 - x0) / 2 - 1e-4, (y1 - y0) / 2 - 1e-4)
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a), z))
    return pts


def arc_band(p, m, cy, cz, r, a0, a1, width, thick, n=18, x=0.0):
    """A curved band round an axle at (y=cy, z=cz): fenders and mudguards. Angles in degrees from +Y toward +Z."""
    rings = []
    for k in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * k / n)
        c, s = math.cos(a), math.sin(a)
        ring = [(x + dx, cy + rr * c, cz + rr * s) for dx, rr in ((-width / 2, r), (width / 2, r), (width / 2, r + thick), (-width / 2, r + thick))]
        rings.append(ring)
    loft(p, m, rings, True)


def tube(p, m, a, b, r, seg=10):
    p.cyl(m, a, b, r, seg)


def tube_path(p, m, pts, r, seg=10):
    """A bent tube through points, with a ball at each bend."""
    for a, b in zip(pts, pts[1:]):
        p.cyl(m, a, b, r, seg)
    for q in pts[1:-1]:
        sph(p, m, q, r * 1.02)


def sph(p, m, c, r, seg=10):
    bm = p._bm(m)
    res = bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=max(4, seg // 2), radius=r)
    bmesh.ops.translate(bm, vec=Vector(c), verts=res['verts'])


def transform_part(p, mx):
    for bm, _ in p.bm.values():
        bmesh.ops.transform(bm, matrix=mx, verts=bm.verts)


# ------------------------------------------------------------------ wheels
def wheel(name, col, m, front):
    """Wheel centred on its own origin, axle along X: tyre with tread grooves, 5-spoke rim, hub (motor at the
    rear), disc rotor at the front."""
    p = Part(name)
    to_x = Matrix.Rotation(math.radians(90), 4, 'Y')
    hw = TYRE_W / 2
    # tyre cross-section (r, x) round a torus: bead at the rim, sidewall bulge, crown with two grooves
    sec = []
    for k in range(24):
        a = 2 * math.pi * k / 24
        rr = (R_TYRE - R_RIM) / 2
        rc = R_RIM + rr
        r = rc + rr * math.cos(a)
        x = hw * math.sin(a) * (1.0 if math.cos(a) < 0.3 else 1.05)
        if math.cos(a) > 0.92:                     # the crown: two shallow circumferential grooves
            x_abs = abs(x)
            if 0.012 < x_abs < 0.018 or 0.03 < x_abs < 0.036:
                r -= 0.004
        sec.append((r, x))
    revolve(p, m['rubber'], sec, seg=40, closed=True, xf=to_x)
    # tread blocks: sipes across the crown (thin dark boxes set into the rubber)
    for k in range(36):
        a = 2 * math.pi * k / 36
        c, s = math.cos(a), math.sin(a)
        for side in (-1, 1):
            q = Vector((side * 0.024, c * (R_TYRE - 0.0015), s * (R_TYRE - 0.0015)))
            rot = Matrix.Rotation(a, 3, 'X') @ Matrix.Rotation(math.radians(20 * side), 3, 'Z')
            p.box(m['black'], tuple(q), (0.022, 0.004, 0.006), rot=rot)          # local y = radial
    # rim: a lathe profile (flanges, well) and five spokes
    rim = [(R_RIM + 0.012, -hw * 0.85), (R_RIM, -hw * 0.85), (R_RIM - 0.012, -hw * 0.6), (R_RIM - 0.016, 0.0),
           (R_RIM - 0.012, hw * 0.6), (R_RIM, hw * 0.85), (R_RIM + 0.012, hw * 0.85)]
    revolve(p, m['rim'], rim, seg=40, closed=False, xf=to_x)
    revolve(p, m['rim'], [(R_RIM - 0.016, -hw * 0.6), (R_RIM - 0.016, hw * 0.6)], seg=40, xf=to_x)
    for k in range(5):
        a = 2 * math.pi * k / 5 + (0.3 if front else 0.0)
        c, s = math.cos(a), math.sin(a)
        mid = (R_RIM - 0.016 + 0.05) / 2
        rot = Matrix.Rotation(a, 3, 'X')
        p.box(m['rim'], (0, c * mid, s * mid), (0.022, R_RIM - 0.016 - 0.05, 0.03), 0.004, rot=rot)
    if front:
        revolve(p, m['alu'], [(0.05, -0.05), (0.05, 0.05)], seg=20, xf=to_x)                  # hub
        revolve(p, m['alu'], [(0.052, -0.05), (0.0, -0.05)], seg=20, xf=to_x)
        revolve(p, m['alu'], [(0.0, 0.05), (0.052, 0.05)], seg=20, xf=to_x)
        # disc rotor on the left with drilled holes (dark dots)
        revolve(p, m['chrome'], [(0.112, -0.058), (0.066, -0.058), (0.066, -0.062), (0.112, -0.062)], seg=36, closed=True, xf=to_x)
        for k in range(12):
            a = 2 * math.pi * k / 12
            p.box(m['steel'], (-0.0605, 0.09 * math.cos(a), 0.09 * math.sin(a)), (0.006, 0.01, 0.01))
    else:
        # hub motor: a fat drum with cooling ribs, the cable leaving on the right
        revolve(p, m['steel'], [(0.0, -0.06), (0.095, -0.06), (0.1, -0.05), (0.1, 0.05), (0.095, 0.06), (0.0, 0.06)], seg=32, xf=to_x)
        for k in range(8):
            revolve(p, m['rim'], [(0.101, -0.04 + k * 0.011), (0.106, -0.04 + k * 0.011 + 0.004)], seg=32, xf=to_x)
        revolve(p, m['alu'], [(0.03, 0.06), (0.03, 0.075), (0.0, 0.075)], seg=16, xf=to_x)
    return p.build(col)


# ------------------------------------------------------------------ body
def body(col, m):
    p = Part('ebike_body')
    # --- footboard: floor pan, rubber mat with ribs, chrome edge trims
    p.box(m['black'], (0, 0.22, FLOOR_Z - 0.045), (0.38, 0.42, 0.09), 0.03)
    for k in range(7):
        p.box(m['rubber'], (0, 0.05 + k * 0.055, FLOOR_Z + 0.004), (0.32, 0.03, 0.008), 0.003)
    for sd in (-1, 1):
        tube(p, m['chrome'], (sd * 0.19, 0.02, FLOOR_Z - 0.01), (sd * 0.19, 0.42, FLOOR_Z - 0.01), 0.007, 8)
    # under-floor frame and battery box (dark), ground clearance ~0.15
    p.box(m['steel'], (0, 0.16, 0.18), (0.26, 0.5, 0.06), 0.02)
    # --- rear body under the seat: a lofted shell, lime above a black skirt
    prof = [(0.02, 0.22, 0.40, 0.170), (-0.03, 0.24, 0.62, 0.172), (-0.12, 0.28, 0.68, 0.176), (-0.25, 0.32, 0.70, 0.182),
            (-0.40, 0.37, 0.71, 0.186), (-0.56, 0.41, 0.72, 0.178), (-0.68, 0.46, 0.72, 0.150), (-0.78, 0.52, 0.70, 0.105),
            (-0.84, 0.58, 0.66, 0.05)]
    rings = [rrect_xz(y, -hw, hw, zb, zt, 0.06) for y, zb, zt, hw in prof]
    loft(p, m['paint'], rings, True)
    skirt = [rrect_xz(y, -hw - 0.004, hw + 0.004, zb - 0.004, zb + (zt - zb) * 0.34, 0.05) for y, zb, zt, hw in prof[:-1]]
    loft(p, m['black'], skirt, True)
    # a crease line along the side panel (a thin dark inlay)
    for sd in (-1, 1):
        for (ya, za), (yb, zb) in zip([(0.0, 0.40), (-0.3, 0.55), (-0.6, 0.6), (-0.8, 0.6)], [(-0.3, 0.55), (-0.6, 0.6), (-0.8, 0.6), (-0.83, 0.6)]):
            d = Vector((0, yb - ya, zb - za))
            L = d.length
            rot = Matrix.Rotation(math.atan2(d.z, d.y), 3, 'X')
            hw_at = 0.18
            p.box(m['gloss'], (sd * (hw_at + 0.004), (ya + yb) / 2, (za + zb) / 2), (0.004, L, 0.012), rot=rot)
    # --- seat: a long padded loft with a raised rear hump and a piping seam
    ys = [SEAT_Y1 - (SEAT_Y1 - SEAT_Y0) * k / 20 for k in range(21)]
    sprof = [(0.0, 0.0), (0.85, 0.0), (1.0, 0.3), (0.96, 0.75), (0.75, 0.97), (0.4, 1.0), (0.0, 1.0)]
    seat_rings = []
    for y in ys:
        t = (SEAT_Y1 - y) / (SEAT_Y1 - SEAT_Y0)                      # 0 front .. 1 rear
        w = 0.125 + 0.035 * math.sin(min(1, t * 1.6) * math.pi / 2) - 0.03 * max(0, t - 0.85) / 0.15
        z0 = 0.655 + 0.05 * t
        z1 = SEAT_Z - 0.02 * (1 - t) ** 2 + 0.02 * max(0, t - 0.75) / 0.25
        right = [(u * w, y, z0 + v * (z1 - z0)) for u, v in sprof]
        left = [(-u * w, y, z0 + v * (z1 - z0)) for u, v in reversed(sprof[1:-1])]
        seat_rings.append(right + left)
    loft(p, m['seat'], seat_rings, True)
    for sd in (-1, 1):
        tube(p, m['gloss'], (sd * 0.152, -0.04, 0.745), (sd * 0.158, -0.62, 0.765), 0.005, 6)
    # --- the leg shield (apron) rising from the footboard to the cowl, behind the front wheel and its fender:
    # lime on the front, black on the rider's side (two lofts split front / back)
    front_rings, back_rings = [], []
    for z, yb, yf, hw in ((0.33, 0.28, 0.38, 0.19), (0.45, 0.27, 0.39, 0.19), (0.58, 0.27, 0.44, 0.17), (0.70, 0.27, 0.45, 0.15),
                          (0.80, 0.28, 0.44, 0.13), (0.88, 0.30, 0.42, 0.10)):
        ys = yb + 0.35 * (yf - yb)
        front_rings.append(rrect_xy(z, -hw, hw, ys, yf, 0.06))
        back_rings.append(rrect_xy(z, -hw + 0.004, hw - 0.004, yb, ys + 0.002, 0.05))
    loft(p, m['paint'], front_rings, True)
    loft(p, m['black'], back_rings, True)
    # the shield's lower part joins the footboard; a hook for bags on its rider side
    p.box(m['black'], (0, 0.43, FLOOR_Z + 0.03), (0.38, 0.06, 0.1), 0.02)
    tube_path(p, m['chrome'], [(0, 0.34, 0.72), (0, 0.31, 0.72), (0, 0.30, 0.69)], 0.006, 6)
    # a takeaway bag on the hook (red plastic, a food box showing through)
    p.box(m['bag'], (0, 0.27, 0.58), (0.2, 0.09, 0.2), 0.03)
    tube_path(p, m['bag'], [(-0.05, 0.275, 0.68), (0, 0.29, 0.705), (0.05, 0.275, 0.68)], 0.006, 6)
    # --- swing arm, rear shocks with red springs, mudguard
    for sd in (-1, 1):
        p.box(m['steel'], (sd * 0.075, -0.42, 0.235), (0.035, 0.46, 0.06), 0.012)
        a, b = Vector((sd * 0.09, -0.58, 0.25)), Vector((sd * 0.13, -0.40, 0.60))
        tube(p, m['chrome'], a, b, 0.011, 10)
        d = (b - a)
        for k in range(9):
            c = a + d * (0.2 + 0.07 * k)
            p.cyl(m['spring'], tuple(c - d.normalized() * 0.006), tuple(c + d.normalized() * 0.006), 0.026, 12)
        p.cyl(m['black'], tuple(a + d * 0.12), tuple(a + d * 0.2), 0.02, 12)
        p.cyl(m['black'], tuple(a + d * 0.86), tuple(a + d * 0.95), 0.02, 12)
    arc_band(p, m['black'], AX_R, R_TYRE, R_TYRE + 0.03, 95, 205, 0.11, 0.008)
    # --- rear rack: side rails, uprights to the frame, cross bars, a platform plate under the box
    rz = BOX['z0'] - 0.012
    for sd in (-1, 1):
        x = sd * 0.20
        tube_path(p, m['steel'], [(sd * 0.16, -0.46, 0.62), (x, -0.52, rz), (x, BOX['y0'] - 0.01, rz), (sd * 0.14, BOX['y0'] - 0.03, 0.66)], 0.013, 10)
        tube(p, m['steel'], (x, -0.86, rz), (sd * 0.12, -0.74, 0.52), 0.011, 8)
    for y in (-0.56, -0.80, BOX['y0'] + 0.01):
        tube(p, m['steel'], (-0.2, y, rz), (0.2, y, rz), 0.01, 8)
    p.box(m['steel'], (0, (BOX['y0'] - 0.60) / 2, rz + 0.008), (0.40, -0.60 - BOX['y0'], 0.006))
    # --- the box: rounded body with piping, reflective bands, handles; the lid is its own node
    bw, bd, bh, by0, bz0 = BOX['w'], BOX['d'], BOX['h'], BOX['y0'], BOX['z0']
    yc = by0 + bd / 2
    p.box(m['box'], (0, yc, bz0 + (bh - 0.03) / 2), (bw, bd, bh - 0.03), 0.045, seg=4)
    p.box(m['boxdark'], (0, yc, bz0 + 0.03), (bw + 0.008, bd + 0.008, 0.06), 0.03)
    p.box(m['boxdark'], (0, yc, bz0 + bh - 0.035), (bw + 0.006, bd + 0.006, 0.014), 0.006)
    for sd in (-1, 1):
        p.box(m['reflect'], (sd * (bw / 2 + 0.002), yc, bz0 + 0.12), (0.004, bd - 0.07, 0.03))
        p.box(m['boxdark'], (sd * (bw / 2 + 0.012), yc, bz0 + bh * 0.62), (0.018, 0.16, 0.035), 0.008)     # handle
    p.box(m['reflect'], (0, by0 - 0.002, bz0 + 0.12), (bw - 0.07, 0.004, 0.03))
    # bungee straps over the box: down both sides and across the lid
    for y in (yc - 0.1, yc + 0.1):
        tube_path(p, m['strap'], [(-bw / 2 - 0.01, y, bz0 + 0.02), (-bw / 2 - 0.012, y, bz0 + bh + 0.005), (bw / 2 + 0.012, y, bz0 + bh + 0.005),
                                  (bw / 2 + 0.01, y, bz0 + 0.02)], 0.006, 6)
    # --- tail: lamp under the rack's end, plate bracket, reflectors, indicators
    p.box(m['black'], (0, by0 + 0.02, 0.73), (0.22, 0.06, 0.07), 0.02)
    p.box(m['tail'], (0, by0 - 0.012, 0.73), (0.19, 0.012, 0.045), 0.008)
    for sd in (-1, 1):
        p.box(m['amber'], (sd * 0.15, by0 + 0.01, 0.73), (0.05, 0.03, 0.03), 0.008)
    tube(p, m['steel'], (0, by0 + 0.02, 0.70), (0, by0 + 0.03, 0.60), 0.01, 8)
    p.box(m['black'], (0, by0 + 0.03, 0.535), (0.24, 0.012, 0.155), 0.006)
    p.box(m['reflector'], (0, -0.86, 0.56), (0.08, 0.01, 0.03), 0.004)
    # side reflectors on the fork-side body
    for sd in (-1, 1):
        p.box(m['reflector'], (sd * 0.186, -0.3, 0.45), (0.004, 0.06, 0.02))
    return p.build(col)


def lid(col, m):
    """Box lid, hinged at its back edge (origin on the hinge line)."""
    p = Part('ebike_lid')
    bw, bd = BOX['w'], BOX['d']
    p.box(m['box'], (0, bd / 2, 0.015), (bw + 0.004, bd + 0.004, 0.03), 0.014)
    p.box(m['boxdark'], (0, bd / 2, 0.031), (bw - 0.04, bd - 0.04, 0.004), 0.002)
    p.box(m['boxdark'], (0, bd - 0.005, 0.0), (0.12, 0.02, 0.03), 0.006)             # the pull tab at the front
    for sd in (-1, 1):
        p.box(m['steel'], (sd * 0.15, 0.0, 0.01), (0.06, 0.012, 0.02), 0.003)          # hinges
    return p.build(col)


def stand(col, m):
    """Side stand, pivot at the origin; deployed it reaches the ground at (-0.13, -0.10, -0.22)."""
    p = Part('ebike_stand')
    tube_path(p, m['steel'], [(0, 0, 0), (-0.07, -0.05, -0.12), (-0.12, -0.09, -0.21)], 0.011, 8)
    p.box(m['steel'], (-0.125, -0.095, -0.215), (0.05, 0.04, 0.01), 0.004)
    p.cyl(m['steel'], (-0.02, 0, 0), (0.02, 0, 0), 0.016, 10)
    return p.build(col)


def steer(col, m):
    """Everything that turns with the bars, in the steer frame: origin at the front axle, local Z up the steering
    axis (raked back), local Y forward-and-up, X right."""
    p = Part('ebike_steer')
    L = BAR_L
    # fork: lower sliders (black) with axle bosses, upper stanchions (chrome), bottom and top clamps
    for sd in (-1, 1):
        x = sd * 0.075
        p.cyl(m['gloss'], (x, 0.0, -0.02), (x, 0.0, 0.30), 0.026, 14)
        p.cyl(m['chrome'], (x, 0.0, 0.30), (x, 0.0, 0.56), 0.018, 14)
        p.box(m['gloss'], (x, 0.0, 0.0), (0.03, 0.05, 0.05), 0.01)
    p.box(m['steel'], (0, 0.0, 0.56), (0.21, 0.07, 0.035), 0.012)
    p.box(m['steel'], (0, 0.0, 0.70), (0.19, 0.06, 0.03), 0.01)
    p.cyl(m['steel'], (0, 0, 0.56), (0, 0, L - 0.06), 0.022, 12)
    # brake caliper hugging the rotor on the left leg
    p.box(m['gloss'], (-0.06, -0.075, 0.07), (0.035, 0.06, 0.08), 0.01)
    tube_path(p, m['black'], [(-0.06, -0.06, 0.12), (-0.09, -0.02, 0.4), (-0.12, 0.02, L - 0.02)], 0.004, 6)
    # front fender following the wheel (angles in the steer frame: world angle - rake)
    arc_band_steer(p, m['paint'], R_TYRE + 0.03, 38, 135, 0.12, 0.009)
    # headlight cowl above the fork crown, lamp and DRL facing forward, indicators either side
    zc = L - 0.13
    cow = [rrect_xy(zc + dz, -hw, hw, -0.05 - dy, 0.09 + dy * 0.4, 0.04) for dz, hw, dy in ((-0.08, 0.09, 0.0), (-0.04, 0.12, 0.02), (0.04, 0.125, 0.025), (0.08, 0.1, 0.01))]
    loft(p, m['paint'], cow, True)
    p.box(m['gloss'], (0, 0.105, zc + 0.005), (0.17, 0.02, 0.085), 0.02)
    p.box(m['head'], (0, 0.113, zc + 0.005), (0.13, 0.012, 0.055), 0.015)
    p.box(m['lens'], (0, 0.118, zc + 0.005), (0.15, 0.006, 0.07), 0.02)
    p.box(m['drl'], (0, 0.112, zc + 0.058), (0.16, 0.01, 0.012), 0.004)
    for sd in (-1, 1):
        p.box(m['amber'], (sd * 0.13, 0.07, zc), (0.04, 0.035, 0.025), 0.008)
    # dash LCD facing the rider
    p.box(m['black'], (0, -0.06, L - 0.03), (0.15, 0.06, 0.05), 0.012)
    p.box(m['dash'], (0, -0.088, L - 0.022), (0.11, 0.004, 0.032), 0.003)
    # handlebar: centre clamp, bar swept back to the grips, grips, levers, bar ends
    bar = [(-0.33, -0.06, L + 0.01), (-0.2, -0.02, L + 0.02), (0.0, 0.0, L), (0.2, -0.02, L + 0.02), (0.33, -0.06, L + 0.01)]
    tube_path(p, m['steel'], bar, 0.012, 10)
    p.box(m['steel'], (0, 0.0, L), (0.08, 0.05, 0.05), 0.012)
    for sd in (-1, 1):
        a, b = Vector((sd * 0.225, -0.035, L + 0.017)), Vector((sd * 0.335, -0.062, L + 0.011))
        p.cyl(m['rubber'], tuple(a), tuple(b), 0.018, 12)
        p.cyl(m['steel'], tuple(b), tuple(b + (b - a).normalized() * 0.012), 0.02, 12)
        # brake lever pivoting from a perch at the switch pod, running just in front of the grip
        p.box(m['alu'], (sd * 0.215, -0.012, L + 0.022), (0.03, 0.03, 0.028), 0.006)
        p.box(m['alu'], (sd * 0.275, -0.004, L + 0.02), (0.12, 0.011, 0.014), 0.004,
              rot=Matrix.Rotation(math.radians(-12 * sd), 3, 'Z'))
        p.box(m['black'], (sd * 0.2, -0.01, L + 0.025), (0.05, 0.04, 0.04), 0.01)          # switch pods
        # mirrors on stalks
        s0 = Vector((sd * 0.19, -0.005, L + 0.03))
        s1 = Vector((sd * 0.27, 0.01, L + 0.24))
        tube(p, m['steel'], s0, s1, 0.006, 8)
        p.box(m['gloss'], (sd * 0.3, 0.012, L + 0.265), (0.13, 0.03, 0.075), 0.02)
        p.box(m['glass'], (sd * 0.3, -0.004, L + 0.265), (0.115, 0.004, 0.062), 0.012)
    # phone holder: clamp on the bar, arm, cradle with the phone tilted to the rider (screen = ebike_screen)
    tube(p, m['black'], (0.07, 0.0, L + 0.01), (0.07, -0.02, L + 0.1), 0.008, 8)
    ph = phone_frame()
    p.box(m['black'], tuple(ph['c']), (0.086, 0.012, 0.165), 0.008, rot=ph['rot'])
    for dz in (-0.07, 0.07):
        p.box(m['black'], tuple(ph['c'] + ph['rot'] @ Vector((0, -0.004, dz))), (0.095, 0.02, 0.012), 0.004, rot=ph['rot'])
    return p.build(col)


def phone_frame():
    """Centre and orientation (steer frame) of the phone in its holder: facing the rider, tilted back 35 deg."""
    c = Vector((0.07, -0.03, BAR_L + 0.15))
    rot = Matrix.Rotation(math.radians(-10), 3, 'X')
    return {'c': c, 'rot': rot}


def arc_band_steer(p, m, r, a0, a1, width, thick, n=18):
    """A fender round the axle in the steer frame (the wheel plane is the local YZ plane there too)."""
    rings = []
    for k in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * k / n) - RAKE
        c, s = math.cos(a), math.sin(a)
        rings.append([(dx, rr * c, rr * s) for dx, rr in ((-width / 2, r), (width / 2, r), (width / 2, r + thick), (-width / 2, r + thick))])
    loft(p, m, rings, True)


# ------------------------------------------------------------------ UV'd decals (logo, plate, phone screen)
def quad_obj(name, col, m, quads):
    """One object of UV-mapped quads [(corners (4 x Vector) counter-clockwise from bottom-left)]."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    for corners in quads:
        vs = [bm.verts.new(c) for c in corners]
        f = bm.faces.new(vs)
        for lp, t in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            lp[uv].uv = t
    bm.to_mesh(me); bm.free()
    me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    return o


def decals(col, m):
    """Corners are bottom-left, bottom-right, top-right, top-left as seen from outside (UV 0..1 in that order)."""
    bw, bd, bh, by0, bz0 = BOX['w'], BOX['d'], BOX['h'], BOX['y0'], BOX['z0']
    z0, z1 = bz0 + 0.16, bz0 + 0.36
    e = 0.004
    ya, yb = by0 + 0.05, by0 + bd - 0.05
    xl, xr = -bw / 2 - e, bw / 2 + e
    V = Vector
    quads = [
        [V((xl, yb, z0)), V((xl, ya, z0)), V((xl, ya, z1)), V((xl, yb, z1))],          # left side (seen from -X)
        [V((xr, ya, z0)), V((xr, yb, z0)), V((xr, yb, z1)), V((xr, ya, z1))],          # right side (seen from +X)
        [V((-bw / 2 + 0.05, by0 - e, z0)), V((bw / 2 - 0.05, by0 - e, z0)), V((bw / 2 - 0.05, by0 - e, z1)), V((-bw / 2 + 0.05, by0 - e, z1))],
    ]
    logo = quad_obj('ebike_logo', col, m['logo'], quads)
    py = BOX['y0'] + 0.03 - 0.008
    plate = quad_obj('ebike_plate', col, m['plate'], [[V((-0.11, py, 0.465)), V((0.11, py, 0.465)), V((0.11, py, 0.605)), V((-0.11, py, 0.605))]])
    ph = phone_frame()
    c, rot = ph['c'], ph['rot']
    hw, hh = 0.036, 0.074
    screen = quad_obj('ebike_screen', col, m['screen'], [[c + rot @ V((x, -0.0075, z)) for x, z in ((-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh))]])
    return logo, plate, screen


# ------------------------------------------------------------------ assembly
def build():
    col = bpy.data.collections.new('ebike')
    bpy.context.scene.collection.children.link(col)
    m = M()
    root = bpy.data.objects.new('ebike', None)
    col.objects.link(root)
    b = body(col, m); b.parent = root
    # steer pivot: at the front axle, rotated about X by the rake (local +Z = steering axis)
    piv = bpy.data.objects.new('ebike_steer_pivot', None)
    col.objects.link(piv)
    piv.parent = root
    piv.location = (0, AX_F, R_TYRE)
    piv.rotation_euler = (RAKE, 0, 0)
    s = steer(col, m); s.parent = piv
    wf = wheel('ebike_wheel_f', col, m, True)
    # the front wheel stays upright in the steer frame's YZ plane: un-rake it so its axle is local X and it spins
    # about X like the rear one (rotation about X keeps X as the axle anyway)
    wf.parent = piv
    wr = wheel('ebike_wheel_r', col, m, False)
    wr.parent = root; wr.location = (0, AX_R, R_TYRE)
    st = stand(col, m); st.parent = root; st.location = (-0.1, -0.12, 0.22)
    ld = lid(col, m); ld.parent = root; ld.location = (0, BOX['y0'], BOX['z0'] + BOX['h'] - 0.03)
    logo, plate, screen = decals(col, m)
    logo.parent = root; plate.parent = root
    # the screen was placed in the steer frame: parent it to the pivot without moving it
    screen.parent = piv
    return root, col


def manifest():
    """Rider and handling points for the demo (Blender frame, steering straight)."""
    ca, sa = math.cos(RAKE), math.sin(RAKE)
    def steer_to_body(x, y, z):
        return [round(x, 4), round(AX_F + y * ca - z * sa, 4), round(R_TYRE + y * sa + z * ca, 4)]
    L = BAR_L
    return {
        'wheel_r': R_TYRE, 'axle_f': [0, AX_F, R_TYRE], 'axle_r': [0, AX_R, R_TYRE], 'rake': RAKE, 'wheelbase': AX_F - AX_R,
        'length': round(AX_F + R_TYRE + 0.02 - BOX['y0'], 3), 'width': 0.72, 'height': round(BOX['z0'] + BOX['h'], 3),
        'seat': [0, -0.28, SEAT_Z], 'seat_top': SEAT_Z, 'floor': FLOOR_Z,
        'grips': [steer_to_body(sd * 0.285, -0.05, L + 0.015) for sd in (-1, 1)],
        'feet': [[sd * 0.1, 0.2, FLOOR_Z] for sd in (-1, 1)],
        'foot_down': [-0.34, -0.02, 0.0],
        'box': BOX, 'stand_hinge': [-0.1, -0.12, 0.22], 'lid_hinge': [0, BOX['y0'], BOX['z0'] + BOX['h'] - 0.03],
        'steer_pivot': [0, AX_F, R_TYRE], 'headlamp': steer_to_body(0, 0.12, L - 0.125), 'taillamp': [0, BOX['y0'] - 0.02, 0.73],
    }


def preview(root):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 32
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.8
    sc.world = w
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2; sun.data.angle = math.radians(3); sun.rotation_euler = (math.radians(48), 0, math.radians(35))
    sc.collection.objects.link(sun)
    gm = bpy.data.meshes.new('g'); bmg = bmesh.new(); bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=20); bmg.to_mesh(gm); bmg.free()
    gm.materials.append(emat('ground', '#6f7073', 0, 0.85))
    g = bpy.data.objects.new('ground', gm); sc.collection.objects.link(g)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 50
    sc.collection.objects.link(cam)
    sc.camera = cam
    os.makedirs(PREV, exist_ok=True)
    shots = {'ebike_side': ((-4.2, -0.25, 0.9), (0, -0.2, 0.62)), 'ebike_front34': ((-2.3, 2.6, 1.45), (0, -0.05, 0.62)),
             'ebike_rear34': ((2.2, -3.1, 1.6), (0, -0.3, 0.7)), 'ebike_bars': ((-0.55, -0.75, 1.55), (0, 0.3, 1.0))}
    for name, (eye, tgt) in shots.items():
        cam.location = eye
        cam.rotation_euler = (Vector(tgt) - Vector(eye)).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = 35 if name == 'ebike_bars' else 50
        sc.render.filepath = os.path.join(PREV, name + '.png')
        bpy.ops.render.render(write_still=True)
    for o in (g, cam, sun):
        bpy.data.objects.remove(o)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    root, col = build()
    tris = 0
    for o in col.objects:
        if o.type == 'MESH':
            n = sum(len(p.vertices) - 2 for p in o.data.polygons)
            tris += n
            print('[ebike]', o.name, n, 'tris', flush=True)
    print('[ebike] total', tris, 'tris', flush=True)
    if '--no-preview' not in ARGS:
        preview(root)
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in col.objects:
        o.select_set(True)
    path = os.path.join(OUT, 'gz_ebike.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_materials='EXPORT', export_texcoords=True, export_normals=True, export_extras=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
    json.dump(manifest(), open(os.path.join(OUT, 'gz_ebike.json'), 'w'), indent=1)
    print('[ebike] ->', path, os.path.getsize(path) // 1024, 'KB', flush=True)


if __name__ == '__main__':
    main()
