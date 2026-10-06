"""Street-level kit for the delivery game: shopfronts, the office-tower lobby set, home doors, the takeaway bag.

    Blender --background --factory-startup --python guangzhou/scripts/gz_shopfront.py -- [--no-preview]

Built from photos (Wikimedia Commons: a Meiyijia store and a wonton chain in Guangzhou, McDonald's food lockers,
Shipai village alleys). Local frame of every kit: x along the facade, +y out to the street, z up, origin on the
facade line at pavement level (the demo turns +y onto the anchor's outward normal, guangzhou/scripts/gz_delivery.py).

  shop_restaurant   cha chaan teng / siu mei / claypot rice: lightbox fascia, AC louvre, aluminium glass front with a
                    takeaway window and stainless counter, the roast-meat window, interior counter and menu board,
                    outside: takeaway rack with bags, red plastic stools, menu standee
  shop_tea          milk tea / coffee / dessert: bright front, the order window with the cup counter, rack with cups
  shop_convenience  24h store: glass front with a door, shelves of goods, lit drinks fridge, ice-cream freezer outside
  shop_mall         a mall's takeaway point: wall-mounted smart pickup cabinet under a lightbox
  shop_shop         other shops (flowers, phones, clothes...): shelves, a parcel counter
  lobby             office tower drop: glass canopy, sliding doors, guard podium, stanchions, the food locker
                    ("蜂箱"), the A-frame sign
  door_unit         apartment block entrance: tiled surround, security door, intercom, canopy, steps, number plate
  door_village      urban-village house: steel door and bar gate, couplets, 福, blue house plate, meter box, stool
  bag               the lime Zhunshida takeaway bag (carried, handed over, left at doors)
  bus_sign          a Guangzhou bus stop board (photos on 花城大道 at 华穗路, 奥体南路): a double-sided lightbox on two
                    posts, the stop's name in a white header over the green route rows
  station           the Zhunshida courier station (骑手驿站) at Ah Jie's spawn: a container booth in the brand's lime and
                    charcoal with an awning, two battery-swap cabinets (换电柜), a long bench, a water dispenser, a
                    plastic table and stools, the weekly ranking board
  robot             the hotel's delivery robot (小准二号): a rounded body on wheels, a face screen, a hatch
  stall             a street food stall where no shop has a wall to stand on (photos: a 凉皮凉面 cart in 珠江新城, a
                    葱肉饼 stall in 车陂, both 2024): a blue electric tricycle carrying a stainless food cart with a glass
                    display case, a lightbox header sign on two posts and a sign panel on the front, payment QR plates,
                    a steaming pot, an LPG cylinder, a stainless bucket, a blue cooler, red stools, takeaway bags.
                    Local frame: x along the cart, +y toward the pavement (the customer side), origin at its middle.

The shops are shallow boxes (1 m) standing in front of the ground floor: whatever is built behind the facade line
is hidden by the building's own wall. Sign faces (the shop's name, menus, plates, couplets) are drawn by the demo on
canvases; their rectangles are in the .json (local x0 x1 z0 z1 at y, facing +y).

Writes demo/public/assets/street/gz_shopkit.glb + gz_shopkit.json; previews in renders/street/shopkit_*.png.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gz_streetkit import Part, mat  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'street')
PREV = os.path.join(ROOT, 'renders', 'street')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

H = 4.3            # shop bay height (a ground floor)
W = 4.0            # bay width including the two piers
D = 1.0            # the shop box's depth in front of the facade
FACES = {}         # kit -> {face name: [x0, x1, z0, z1, y]}
POINTS = {}        # kit -> {point name: [x, y, z]}


def M():
    return {
        'granite': mat('shop granite dark', '#2c2d30', 0.0, 0.32),
        'granite_lt': mat('shop granite light', '#b9b3a8', 0.0, 0.45),
        'alu': mat('shop aluminium', '#b8bdc2', 0.9, 0.35),
        'alu_dark': mat('shop aluminium dark', '#3a3e44', 0.8, 0.4),
        'steel': mat('shop stainless', '#d4d8dc', 1.0, 0.22),
        'glass': mat('shop glass', '#9fb6c2', 0.0, 0.04, alpha=0.28),
        'tile': mat('shop floor tile', '#d9d3c8', 0.0, 0.3),
        'wall_in': mat('shop wall inside', '#efe9df', 0.0, 0.7),
        'wood': mat('shop wood', '#9a6a43', 0.0, 0.55),
        'ceiling_led': mat('shop ceiling led', '#fff6e6', 0.0, 0.3, emit=4.0),
        'menu_led': mat('shop menu board', '#f3e2b5', 0.0, 0.4, emit=2.2),
        'red_plastic': mat('shop red plastic', '#c7262b', 0.0, 0.42),
        'green_plastic': mat('shop green plastic', '#2f7d4c', 0.0, 0.5),
        'white_plastic': mat('shop white plastic', '#eeeeea', 0.0, 0.35),
        'black': mat('shop black', '#18191b', 0.0, 0.5),
        'rubber': mat('shop rubber', '#222222', 0.0, 0.9),
        'bag_lime': mat('bag lime', '#c6f03c', 0.0, 0.5),
        'bag_white': mat('bag white', '#f1efe8', 0.0, 0.5),
        'bag_red': mat('bag red', '#d8322f', 0.0, 0.5),
        'bag_orange': mat('bag orange', '#f08a24', 0.0, 0.5),
        'paper': mat('receipt paper', '#faf8f2', 0.0, 0.8),
        'roast': mat('roast meat glaze', '#7a2a12', 0.0, 0.25),
        'roast_lt': mat('roast char siu', '#a4361c', 0.0, 0.3),
        'heat_lamp': mat('heat lamp', '#ff6a2a', 0.0, 0.3, emit=3.0),
        'fridge_glow': mat('fridge glow', '#e9f4ff', 0.0, 0.2, emit=2.5),
        'goods_a': mat('goods red', '#d23c2e', 0.0, 0.5),
        'goods_b': mat('goods yellow', '#f0c43a', 0.0, 0.5),
        'goods_c': mat('goods blue', '#2f6fb3', 0.0, 0.5),
        'goods_d': mat('goods green', '#3e9a57', 0.0, 0.5),
        'goods_e': mat('goods white', '#f3f1ea', 0.0, 0.5),
        'cup': mat('cup clear', '#e8dcc8', 0.0, 0.2),
        'screen': mat('screen', '#23405a', 0.0, 0.15, emit=1.6),
        'locker': mat('locker body', '#2b2e33', 0.6, 0.4),
        'locker_in': mat('locker inside', '#dde7ee', 0.0, 0.3, emit=0.8),
        'canopy_glass': mat('canopy glass', '#bcd0d8', 0.0, 0.05, alpha=0.35),
        'door_steel': mat('security door', '#4a3a33', 0.4, 0.45),
        'gate_paint': mat('gate paint', '#5d2323', 0.4, 0.5),
        'tile_wall': mat('wall tile white', '#e7e4dc', 0.0, 0.25),
        'tile_mosaic': mat('wall mosaic', '#c9ccc5', 0.0, 0.35),
        'concrete': mat('concrete', '#9c9a94', 0.0, 0.85),
        'couplet': mat('couplet red', '#c41e1e', 0.0, 0.6),
        'plate_blue': mat('house plate blue', '#1f4f9c', 0.0, 0.4),
        'meter': mat('meter box grey', '#9aa0a3', 0.3, 0.5),
        'bulb': mat('bulb warm', '#ffd9a0', 0.0, 0.2, emit=5.0),
        'belt': mat('stanchion belt', '#2f4f7f', 0.0, 0.6),
        'sign_body': mat('sign box body', '#2a2c30', 0.6, 0.45),
        'mat_door': mat('door mat', '#3b3f43', 0.0, 0.95),
        'bus_green': mat('bus board green', '#1f6e3d', 0.0, 0.5),
        'lime': mat('brand lime', '#c6f03c', 0.1, 0.45),
        'charcoal': mat('brand charcoal', '#1b1d1f', 0.3, 0.5),
        'container': mat('container steel', '#1d2023', 0.5, 0.45),
        'swap_white': mat('swap cabinet white', '#e9edf0', 0.2, 0.35),
        'swap_blue': mat('swap cabinet blue', '#1d5fae', 0.2, 0.4),
        'led_green': mat('led green', '#39ff7a', 0.0, 0.3, emit=3.0),
        'water_blue': mat('water bottle', '#4f9ad6', 0.0, 0.05, alpha=0.55),
        'robot_white': mat('robot shell', '#f1f3f4', 0.0, 0.25),
        'awning': mat('awning lime', '#b6dc35', 0.0, 0.6),
        'trike_blue': mat('tricycle blue', '#23439a', 0.3, 0.4),
        'lpg': mat('lpg cylinder', '#b9bcbd', 0.6, 0.45),
        'cooler_blue': mat('cooler blue', '#1f4fb8', 0.0, 0.35),
        'qr_green': mat('qr wechat', '#1aad19', 0.0, 0.4),
        'qr_blue': mat('qr alipay', '#1677ff', 0.0, 0.4),
        'led_warm': mat('stall led tube', '#fff1d6', 0.0, 0.3, emit=4.5),
        'steam_pot': mat('steamer bamboo', '#b68a4e', 0.0, 0.7),
        'lining': mat('station lining', '#eeeae2', 0.0, 0.75, emit=0.35),
    }


def face(kit, name, x0, x1, z0, z1, y):
    FACES.setdefault(kit, {})[name] = [round(x0, 3), round(x1, 3), round(z0, 3), round(z1, 3), round(y, 3)]


def point(kit, name, x, y, z):
    POINTS.setdefault(kit, {})[name] = [round(x, 3), round(y, 3), round(z, 3)]


# ------------------------------------------------------------------ pieces
def bag(p, m, c, s=1.0, kind='bag_lime', handles=True):
    """A knotted plastic takeaway bag: a slightly bulged box with two handle loops and a receipt."""
    x, y, z = c
    w, d, h = 0.32 * s, 0.2 * s, 0.26 * s
    p.box(m[kind], (x, y, z + h / 2), (w, d, h), bevel=0.04 * s, seg=2)
    if handles:
        for k in (-1, 1):
            p.cyl(m[kind], (x + k * 0.06 * s, y, z + h), (x + k * 0.03 * s, y, z + h + 0.09 * s), 0.018 * s, 6)
        p.box(m[kind], (x, y, z + h + 0.1 * s), (0.08 * s, 0.03 * s, 0.03 * s), bevel=0.01 * s)
    p.box(m['paper'], (x + 0.05 * s, y + d / 2 + 0.002, z + h * 0.55), (0.1 * s, 0.003, 0.13 * s))


def cup(p, m, c):
    x, y, z = c
    p.cyl(m['cup'], (x, y, z), (x, y, z + 0.15), 0.04, 10, r2=0.047)
    p.cyl(m['white_plastic'], (x, y, z + 0.15), (x, y, z + 0.17), 0.05, 10)
    p.cyl(m['black'], (x + 0.01, y, z + 0.17), (x + 0.02, y, z + 0.27), 0.004, 4)


def stool(p, m, c):
    x, y, z = c
    p.lathe(m['red_plastic'], [(0.0, 0.45), (0.15, 0.45), (0.155, 0.43), (0.12, 0.05), (0.13, 0.0), (0.1, 0.0), (0.09, 0.4), (0.0, 0.4)], 16, z0=z, cx=x, cy=y)


def rack(p, m, x, y, bags=True, cups=False):
    """Stainless takeaway rack (外卖取餐架): 4 shelves, a paper order ticket per slot."""
    w, d, h = 0.8, 0.4, 1.55
    for sx in (-1, 1):
        for sy in (-1, 1):
            p.box(m['steel'], (x + sx * (w / 2 - 0.015), y + sy * (d / 2 - 0.015), h / 2), (0.025, 0.025, h))
    for k, zz in enumerate((0.1, 0.5, 0.9, 1.3)):
        p.box(m['steel'], (x, y, zz), (w, d, 0.02))
        if k == 0:
            continue
        for j, xx in enumerate((-0.2, 0.2)):
            if cups:
                for dx in (-0.06, 0.06):
                    cup(p, m, (x + xx + dx, y, zz + 0.01))
            elif bags and (k + j) % 3 != 2:
                bag(p, m, (x + xx, y, zz + 0.01), 0.8, ['bag_lime', 'bag_white', 'bag_red', 'bag_orange'][(k * 2 + j) % 4])
    p.box(m['alu_dark'], (x, y + d / 2, h + 0.06), (w, 0.02, 0.12))    # the header strip ("外卖取餐")


def standee(p, m, kit, x, y):
    p.box(m['black'], (x, y, 0.04), (0.5, 0.35, 0.08), bevel=0.02)
    p.box(m['sign_body'], (x, y, 0.9), (0.6, 0.08, 1.6), bevel=0.02)
    face(kit, 'menu', x - 0.27, x + 0.27, 0.15, 1.65, y + 0.041)


def bay(p, m, kit, fascia_color, glass_door=True, window=True):
    """Piers, fascia box, AC louvre, aluminium glass front with a door and (optionally) the takeaway window."""
    xi = W / 2 - 0.4                 # inner face of the piers
    for s in (-1, 1):
        p.box(m['granite'], (s * (W / 2 - 0.2), D / 2 + 0.06, H / 2), (0.4, D + 0.12, H), bevel=0.01, seg=1)
        p.box(m['granite_lt'], (s * (W / 2 - 0.2), D + 0.1, 0.06), (0.44, 0.08, 0.12))
    # the box: floor, back wall, ceiling
    p.box(m['tile'], (0, D / 2, 0.05), (2 * xi, D, 0.1))
    p.box(m['granite_lt'], (0, D + 0.15, 0.03), (2 * xi, 0.3, 0.06))                   # threshold
    p.box(m['wall_in'], (0, 0.03, 1.5), (2 * xi, 0.06, 3.0))
    p.box(m['wall_in'], (0, D / 2, 2.95), (2 * xi, D, 0.1))
    p.box(m['ceiling_led'], (0, D / 2, 2.89), (2 * xi - 0.6, 0.35, 0.02))
    # fascia lightbox + three gooseneck lamps
    fb = mat('fascia ' + kit, fascia_color, 0.2, 0.4)
    p.box(m['sign_body'], (0, D + 0.15, 3.52), (2 * xi + 0.02, 0.32, 1.1), bevel=0.02)
    p.box(fb, (0, D + 0.305, 3.52), (2 * xi - 0.1, 0.01, 1.0))
    face(kit, 'fascia', -xi + 0.06, xi - 0.06, 3.02, 4.02, D + 0.312)
    for x in (-1.1, 0.0, 1.1):
        p.cyl(m['black'], (x, D + 0.3, 4.12), (x, D + 0.75, 4.25), 0.012, 6)
        p.cyl(m['black'], (x, D + 0.72, 4.27), (x, D + 0.82, 4.17), 0.04, 10, r2=0.025)
    # AC louvre band
    for k in range(7):
        p.box(m['alu_dark'], (0, D + 0.03, 2.62 + k * 0.05), (2 * xi, 0.06, 0.018), rot=Matrix.Rotation(math.radians(30), 3, 'X'))
    p.box(m['alu_dark'], (0, D + 0.02, 2.95), (2 * xi, 0.04, 0.04))
    # glass front: mullions, transom, door, takeaway window
    z0, zt, zg = 0.1, 2.2, 2.58
    fy = D + 0.02
    for x in (-xi + 0.03, -0.55, 0.55, xi - 0.03):
        p.box(m['alu'], (x, fy, (z0 + zg) / 2), (0.06, 0.08, zg - z0))
    for zz in (z0 + 0.03, zt, zg - 0.03):
        p.box(m['alu'], (0, fy, zz), (2 * xi, 0.08, 0.06))
    p.box(m['glass'], (-(xi + 0.55) / 2, fy, (z0 + zg) / 2), (xi - 0.55, 0.012, zg - z0))
    p.box(m['glass'], (0, fy, (zt + zg) / 2), (1.1, 0.012, zg - zt))
    if glass_door:
        for s in (-1, 1):
            p.box(m['glass'], (s * 0.275, fy + 0.01, (z0 + zt) / 2), (0.52, 0.012, zt - z0 - 0.06))
            p.box(m['alu'], (s * 0.275, fy + 0.01, zt - 0.05), (0.54, 0.03, 0.04))
            p.cyl(m['steel'], (s * 0.07, fy + 0.06, 0.8), (s * 0.07, fy + 0.06, 1.6), 0.014, 8)
    xr0, xr1 = 0.55, xi
    if window:
        p.box(m['steel'], ((xr0 + xr1) / 2, fy, (z0 + 1.0) / 2), (xr1 - xr0, 0.05, 1.0 - z0))      # kick panel
        p.box(m['glass'], ((xr0 + xr1) / 2, fy, (1.8 + zt) / 2), (xr1 - xr0, 0.012, zt - 1.8))
        p.box(m['alu'], ((xr0 + xr1) / 2, fy, 1.8), (xr1 - xr0, 0.07, 0.04))
        p.box(m['glass'], (xr0 + 0.25, fy - 0.04, 1.4), (0.46, 0.012, 0.78))                        # slid-open pane
        p.box(m['steel'], ((xr0 + xr1) / 2, fy + 0.15, 1.0), (xr1 - xr0 - 0.04, 0.42, 0.03))        # counter
        p.box(m['steel'], ((xr0 + xr1) / 2 - 0.3, fy + 0.3, 1.04), (0.12, 0.08, 0.06))              # receipt printer
        p.box(m['black'], ((xr0 + xr1) / 2 + 0.3, fy + 0.3, 1.1), (0.1, 0.02, 0.14), rot=Matrix.Rotation(-0.25, 3, 'X'))   # QR stand
        p.lathe(m['steel'], [(0.0, 0.07), (0.04, 0.06), (0.05, 0.02), (0.05, 0.0), (0.0, 0.0)], 12, z0=1.015,
                cx=(xr0 + xr1) / 2 + 0.05, cy=fy + 0.28)                                            # the bell
        point(kit, 'counter', (xr0 + xr1) / 2, fy + 0.3, 1.02)
        point(kit, 'staff', (xr0 + xr1) / 2, 0.45, 0.1)
    else:
        p.box(m['glass'], ((xr0 + xr1) / 2, fy, (z0 + zt) / 2), (xr1 - xr0, 0.012, zt - z0))
        point(kit, 'counter', 0.0, fy + 0.3, 1.0)
        point(kit, 'staff', 1.0, 0.45, 0.1)
    point(kit, 'stand', (xr0 + xr1) / 2 if window else 0.0, D + 1.3, 0.0)
    point(kit, 'door', 0.0, D + 0.5, 0.0)
    return xi


# ------------------------------------------------------------------ kits
def shop_restaurant(col, m):
    p = Part('shop_restaurant')
    xi = bay(p, m, 'shop_restaurant', '#d8551f')
    # the roast-meat window at the front left: a glass case with hanging ducks and char siu under a heat lamp
    x0, x1 = -xi + 0.1, -0.7
    p.box(m['steel'], ((x0 + x1) / 2, D - 0.3, 0.95), (x1 - x0, 0.5, 0.06))
    p.box(m['glass'], ((x0 + x1) / 2, D - 0.06, 1.45), (x1 - x0, 0.012, 0.95))
    p.box(m['steel'], ((x0 + x1) / 2, D - 0.3, 1.95), (x1 - x0, 0.5, 0.04))
    p.box(m['heat_lamp'], ((x0 + x1) / 2, D - 0.3, 1.92), (x1 - x0 - 0.1, 0.1, 0.02))
    for k in range(4):
        x = x0 + 0.15 + k * (x1 - x0 - 0.3) / 3
        p.cyl(m['steel'], (x, D - 0.3, 1.93), (x, D - 0.3, 1.72), 0.006, 4)
        if k % 2 == 0:
            p.lathe(m['roast'], [(0.0, 0.0), (0.05, 0.03), (0.08, 0.12), (0.075, 0.24), (0.04, 0.32), (0.0, 0.34)], 12, z0=1.36, cx=x, cy=D - 0.3)
        else:
            for j in range(3):
                p.box(m['roast_lt'], (x + (j - 1) * 0.05, D - 0.3, 1.55), (0.04, 0.05, 0.3), bevel=0.012)
    # inside: counter, rice cooker, menu board, the kitchen pass
    p.box(m['wood'], (0.2, 0.28, 0.55), (2.2, 0.45, 0.9), bevel=0.02)
    p.box(m['steel'], (0.2, 0.28, 1.01), (2.24, 0.48, 0.03))
    p.lathe(m['white_plastic'], [(0.0, 0.0), (0.16, 0.0), (0.17, 0.2), (0.14, 0.26), (0.0, 0.27)], 14, z0=1.03, cx=-0.5, cy=0.28)
    p.box(m['menu_led'], (0.2, 0.07, 2.35), (2.6, 0.03, 0.55))
    face('shop_restaurant', 'board', -1.1, 1.5, 2.08, 2.62, 0.086)
    p.box(m['black'], (1.2, 0.07, 1.6), (0.7, 0.04, 0.45))                   # kitchen pass
    # outside: rack with bags, two stools, a bin, the menu standee
    rack(p, m, xi - 0.2, D + 0.45)
    for x in (-1.1, -0.65):
        stool(p, m, (x, D + 0.45, 0.0))
    p.lathe(m['green_plastic'], [(0.0, 0.0), (0.15, 0.0), (0.18, 0.55), (0.0, 0.55)], 12, cx=-xi + 0.15, cy=D + 0.35)
    standee(p, m, 'shop_restaurant', -0.15, D + 0.55)
    return p.build(col)


def shop_tea(col, m):
    p = Part('shop_tea')
    xi = bay(p, m, 'shop_tea', '#f3e9d9')
    # inside: the bar behind the order window, sealer and fridge, a cup tower, three menu boxes on the back wall
    p.box(m['white_plastic'], (0.3, 0.35, 0.5), (2.4, 0.55, 0.9), bevel=0.02)
    p.box(m['wood'], (0.3, 0.35, 0.97), (2.44, 0.58, 0.04))
    p.box(m['steel'], (1.1, 0.3, 1.2), (0.3, 0.35, 0.4), bevel=0.02)       # sealer
    p.box(m['steel'], (-0.6, 0.3, 1.25), (0.45, 0.4, 0.5), bevel=0.02)     # fridge
    for k in range(5):
        cup(p, m, (0.3 + k * 0.1, 0.35, 0.99))
    for k in range(3):
        x = -1.0 + k * 1.0
        p.box(m['menu_led'], (x, 0.07, 2.3), (0.9, 0.03, 0.6))
    face('shop_tea', 'board', -1.45, 1.45, 2.0, 2.6, 0.086)
    rack(p, m, xi - 0.2, D + 0.45, bags=False, cups=True)
    # two bar stools under a ledge along the left glass
    p.box(m['wood'], (-0.9, D + 0.18, 1.05), (1.1, 0.3, 0.04))
    for x in (-1.2, -0.65):
        p.cyl(m['steel'], (x, D + 0.45, 0.0), (x, D + 0.45, 0.72), 0.02, 8)
        p.cyl(m['wood'], (x, D + 0.45, 0.72), (x, D + 0.45, 0.76), 0.16, 14)
    standee(p, m, 'shop_tea', 0.1, D + 0.6)
    return p.build(col)


def shelves(p, m, x0, x1, y, z1=1.9):
    """Gondola shelves full of goods (boxes in five colours)."""
    goods = ['goods_a', 'goods_b', 'goods_c', 'goods_d', 'goods_e']
    p.box(m['alu'], ((x0 + x1) / 2, y - 0.2, z1 / 2), (x1 - x0, 0.04, z1))
    for k, zz in enumerate((0.15, 0.55, 0.95, 1.35)):
        p.box(m['alu'], ((x0 + x1) / 2, y, zz), (x1 - x0, 0.36, 0.02))
        n = int((x1 - x0) / 0.14)
        for j in range(n):
            g = goods[(j * 7 + k * 3) % 5]
            hh = 0.18 + 0.1 * ((j * 13 + k) % 3) / 2
            p.box(m[g], (x0 + 0.07 + j * 0.14, y + 0.02, zz + hh / 2 + 0.01), (0.12, 0.26, hh), bevel=0.01, seg=1)


def shop_convenience(col, m):
    p = Part('shop_convenience')
    xi = bay(p, m, 'shop_convenience', '#d0282e', window=False)
    shelves(p, m, -xi + 0.1, 0.4, 0.35)
    # lit drinks fridge on the right, glass doors
    p.box(m['alu_dark'], (1.05, 0.3, 1.0), (0.95, 0.5, 2.0))
    p.box(m['fridge_glow'], (1.05, 0.56, 1.05), (0.85, 0.02, 1.75))
    for k in range(4):
        for j in range(5):
            p.cyl(m[['goods_a', 'goods_c', 'goods_d', 'goods_b'][k]], (0.7 + j * 0.17, 0.4, 0.3 + k * 0.42), (0.7 + j * 0.17, 0.4, 0.52 + k * 0.42), 0.035, 8)
    p.box(m['alu'], (1.05, 0.58, 1.05), (0.02, 0.03, 1.8))
    # counter at the door with the till
    p.box(m['wood'], (0.3, D - 0.35, 0.5), (0.8, 0.4, 0.9), bevel=0.02)
    p.box(m['black'], (0.3, D - 0.35, 1.05), (0.3, 0.25, 0.2), bevel=0.02)
    # outside: the ice-cream freezer chest, a stack of water crates, posters (faces)
    p.box(m['white_plastic'], (-1.0, D + 0.4, 0.42), (1.0, 0.6, 0.84), bevel=0.03)
    p.box(m['glass'], (-1.0, D + 0.4, 0.86), (0.9, 0.5, 0.03))
    p.box(m['goods_c'], (-1.0, D + 0.41, 0.6), (0.85, 0.45, 0.3))
    for k in range(3):
        p.box(m['goods_c'], (1.1, D + 0.35, 0.16 + k * 0.3), (0.5, 0.35, 0.28), bevel=0.02)
    face('shop_convenience', 'poster', -1.4, -0.7, 1.05, 1.95, D + 0.035)
    return p.build(col)


def shop_mall(col, m):
    p = Part('shop_mall')
    xi = W / 2 - 0.4
    for s in (-1, 1):
        p.box(m['granite'], (s * (W / 2 - 0.2), 0.3, H / 2), (0.4, 0.6, H), bevel=0.01, seg=1)
    p.box(m['granite_lt'], (0, 0.25, H / 2), (2 * xi, 0.5, H))
    p.box(m['sign_body'], (0, 0.62, 3.52), (2 * xi, 0.25, 1.0), bevel=0.02)
    face('shop_mall', 'fascia', -xi + 0.06, xi - 0.06, 3.05, 3.99, 0.747)
    # the pickup cabinet: 4 x 3 glass cells, a screen, lit inside
    cw, ch = 0.5, 0.45
    x0, z0 = -1.1, 0.75
    p.box(m['locker'], (0, 0.62, 1.45), (2.3, 0.25, 1.75), bevel=0.02)
    for i in range(4):
        for j in range(3):
            x, z = x0 + i * (cw + 0.05) + cw / 2 - 0.25, z0 + j * (ch + 0.05) + ch / 2
            if i == 2 and j == 1:
                p.box(m['screen'], (x, 0.75, z), (cw, 0.02, ch))
                continue
            p.box(m['locker_in'], (x, 0.7, z), (cw - 0.04, 0.02, ch - 0.04))
            p.box(m['glass'], (x, 0.752, z), (cw - 0.02, 0.012, ch - 0.02))
            if (i + j) % 2 == 0:
                bag(p, m, (x, 0.62, z - ch / 2 + 0.03), 0.9)
    face('shop_mall', 'header', -1.1, 1.1, 2.4, 2.7, 0.752)
    p.box(m['sign_body'], (0, 0.62, 2.55), (2.3, 0.26, 0.35))
    point('shop_mall', 'counter', 0.0, 0.9, 1.0)
    point('shop_mall', 'staff', 1.5, 1.2, 0.0)
    point('shop_mall', 'stand', 0.0, 1.8, 0.0)
    point('shop_mall', 'door', 0.0, 1.2, 0.0)
    return p.build(col)


def shop_shop(col, m):
    p = Part('shop_shop')
    xi = bay(p, m, 'shop_shop', '#2e5c8a')
    shelves(p, m, -xi + 0.1, 0.5, 0.3, 1.6)
    p.box(m['wood'], (1.0, 0.45, 0.5), (1.0, 0.6, 0.9), bevel=0.02)
    for k in range(3):
        p.box(m['bag_white'], (0.8 + k * 0.22, 0.45, 1.0), (0.18, 0.25, 0.18), bevel=0.02)
    standee(p, m, 'shop_shop', -0.2, D + 0.55)
    return p.build(col)


def lobby(col, m):
    p = Part('lobby')
    # glass canopy on two tension rods, sliding doors in a steel portal
    p.box(m['alu_dark'], (0, 1.1, 3.45), (4.0, 2.2, 0.08))
    p.box(m['canopy_glass'], (0, 1.1, 3.51), (3.9, 2.1, 0.03))
    for s in (-1, 1):
        p.cyl(m['steel'], (s * 1.6, 0.05, 4.4), (s * 1.6, 2.1, 3.5), 0.015, 6)
    p.box(m['alu_dark'], (0, 0.08, 2.75), (2.8, 0.16, 0.14))
    for s in (-1, 1):
        p.box(m['alu_dark'], (s * 1.35, 0.08, 1.35), (0.1, 0.16, 2.7))
        p.box(m['glass'], (s * 0.62, 0.1, 1.33), (1.2, 0.015, 2.6))
        p.box(m['alu'], (s * 0.62, 0.1, 0.05), (1.2, 0.03, 0.06))
    p.box(m['mat_door'], (0, 0.9, 0.006), (2.4, 1.4, 0.012))
    # the guard's podium and the stanchions across the doors
    p.box(m['wood'], (-1.9, 1.7, 0.55), (0.65, 0.45, 1.1), bevel=0.02)
    p.box(m['granite_lt'], (-1.9, 1.7, 1.12), (0.7, 0.5, 0.04))
    face('lobby', 'podium', -2.18, -1.62, 0.55, 0.95, 1.927)
    for x in (-0.9, 0.9):
        p.cyl(m['steel'], (x, 1.5, 0.0), (x, 1.5, 0.95), 0.03, 10)
        p.lathe(m['steel'], [(0.0, 0.0), (0.16, 0.0), (0.16, 0.03), (0.0, 0.05)], 16, cx=x, cy=1.5)
    p.box(m['belt'], (0, 1.5, 0.88), (1.8, 0.01, 0.05))
    # the food locker (蜂箱 smart cabinet): 5 x 5 glass cells, a touch screen, a lit header
    lx = 2.55
    cw, ch = 0.33, 0.33
    p.box(m['locker'], (lx, 0.35, 1.1), (1.85, 0.6, 2.2), bevel=0.02)
    p.box(m['sign_body'], (lx, 0.36, 2.35), (1.85, 0.62, 0.3))
    face('lobby', 'locker_head', lx - 0.88, lx + 0.88, 2.22, 2.48, 0.671)
    for i in range(5):
        for j in range(5):
            x, z = lx - 0.72 + i * 0.36, 0.3 + j * 0.37
            if i == 2 and j in (2, 3):
                if j == 2:
                    p.box(m['screen'], (x, 0.66, z + 0.18), (cw, 0.02, 0.7))
                continue
            p.box(m['locker_in'], (x, 0.6, z), (cw - 0.03, 0.02, ch - 0.03))
            p.box(m['glass'], (x, 0.655, z), (cw - 0.01, 0.012, ch - 0.01))
            if (i * 3 + j) % 4 == 1:
                bag(p, m, (x, 0.45, z - ch / 2 + 0.02), 0.7)
    point('lobby', 'locker', lx, 1.15, 0.0)
    point('lobby', 'cell', lx + 0.36, 0.5, 0.3 + 0.37)
    # the A-frame sign
    ax, ay = 0.8, 2.4
    for s in (-1, 1):
        p.box(m['black'], (ax, ay + s * 0.12, 0.5), (0.6, 0.03, 1.0), rot=Matrix.Rotation(s * 0.2, 3, 'X'))
    face('lobby', 'aframe', ax - 0.26, ax + 0.26, 0.15, 0.9, ay + 0.24)
    point('lobby', 'guard', -1.9, 1.25, 0.0)
    point('lobby', 'stand', 0.0, 2.3, 0.0)
    point('lobby', 'door', 0.0, 0.6, 0.0)
    return p.build(col)


def door_unit(col, m):
    p = Part('door_unit')
    # tiled surround, two steps up to the sill, the canopy with a light
    p.box(m['tile_wall'], (0, 0.05, 1.55), (2.6, 0.1, 3.1))
    p.box(m['granite_lt'], (0, 0.6, 0.06), (2.2, 1.2, 0.12))
    p.box(m['granite_lt'], (0, 0.35, 0.18), (2.2, 0.7, 0.12))
    p.box(m['concrete'], (0, 0.75, 3.05), (2.4, 1.5, 0.15))
    p.box(m['bulb'], (0, 1.2, 2.965), (0.3, 0.1, 0.02))
    # the security door: steel frame, glass upper, steel lower, a pull bar
    p.box(m['door_steel'], (0, 0.12, 2.6), (1.8, 0.1, 0.14))
    for s in (-1, 1):
        p.box(m['door_steel'], (s * 0.85, 0.12, 1.4), (0.1, 0.1, 2.4))
    p.box(m['door_steel'], (0, 0.13, 0.7), (1.6, 0.04, 0.9))
    p.box(m['glass'], (0, 0.13, 1.8), (1.6, 0.012, 1.3))
    for x in (-0.4, 0.0, 0.4):
        p.box(m['door_steel'], (x, 0.14, 1.8), (0.03, 0.03, 1.3))
    p.cyl(m['steel'], (0.55, 0.2, 0.95), (0.55, 0.2, 1.45), 0.015, 8)
    # the intercom (可视对讲): screen, keypad, speaker grille
    p.box(m['black'], (1.05, 0.12, 1.35), (0.22, 0.04, 0.38), bevel=0.01)
    p.box(m['screen'], (1.05, 0.142, 1.46), (0.14, 0.005, 0.1))
    for i in range(3):
        for j in range(4):
            p.box(m['alu'], (1.0 + i * 0.05, 0.142, 1.36 - j * 0.04), (0.035, 0.006, 0.028))
    # the number plate above the door
    p.box(m['sign_body'], (0, 0.12, 2.82), (0.9, 0.04, 0.3))
    face('door_unit', 'plate', -0.43, 0.43, 2.68, 2.96, 0.142)
    point('door_unit', 'door', 0.0, 0.8, 0.24)
    point('door_unit', 'drop', 0.5, 0.45, 0.24)
    point('door_unit', 'stand', 0.0, 1.6, 0.0)
    point('door_unit', 'intercom', 1.05, 0.14, 1.35)
    return p.build(col)


def door_village(col, m):
    p = Part('door_village')
    # mosaic-tiled wall, a low step
    p.box(m['tile_mosaic'], (0, 0.03, 1.45), (2.5, 0.06, 2.9))
    p.box(m['concrete'], (0, 0.2, 0.06), (1.5, 0.35, 0.12))
    # the steel door with its riveted panels, a 福 diamond (face)
    p.box(m['door_steel'], (0, 0.08, 1.1), (1.1, 0.06, 2.2))
    for zz in (0.55, 1.1, 1.65):
        p.box(m['door_steel'], (0, 0.115, zz), (1.0, 0.012, 0.02))
    p.cyl(m['steel'], (0.4, 0.14, 1.05), (0.4, 0.14, 1.15), 0.02, 8)
    face('door_village', 'fu', -0.2, 0.2, 1.3, 1.7, 0.123)
    # the bar gate in front (铁闸), hinged open a little
    for k in range(9):
        x = -0.5 + k * 0.125
        p.cyl(m['gate_paint'], (x, 0.22, 0.05), (x, 0.22, 2.15), 0.011, 6)
    for zz in (0.08, 1.05, 2.12):
        p.box(m['gate_paint'], (0, 0.22, zz), (1.1, 0.03, 0.04))
    # couplets, the banner, the blue house plate
    for s, nm in ((-1, 'couplet_l'), (1, 'couplet_r')):
        p.box(m['couplet'], (s * 0.75, 0.065, 1.35), (0.26, 0.005, 1.5))
        face('door_village', nm, s * 0.75 - 0.12, s * 0.75 + 0.12, 0.62, 2.08, 0.068)
    p.box(m['couplet'], (0, 0.065, 2.4), (1.2, 0.005, 0.26))
    face('door_village', 'banner', -0.58, 0.58, 2.28, 2.52, 0.068)
    p.box(m['plate_blue'], (1.05, 0.066, 1.85), (0.36, 0.01, 0.2))
    face('door_village', 'plate', 0.88, 1.22, 1.76, 1.94, 0.072)
    # the LED dot-matrix sign over the door (有房出租, 士多...): a black box, the text drawn by the demo
    p.box(m['black'], (0, 0.09, 2.78), (1.3, 0.12, 0.3), bevel=0.01)
    face('door_village', 'led', -0.6, 0.6, 2.66, 2.9, 0.152)
    # the meter box, the bulb, wires, a plastic stool and slippers
    p.box(m['meter'], (-1.0, 0.12, 2.3), (0.3, 0.14, 0.4), bevel=0.01)
    p.cyl(m['black'], (-1.0, 0.12, 2.5), (-1.2, 0.2, 2.9), 0.008, 4)
    p.cyl(m['black'], (-0.95, 0.12, 2.5), (0.9, 0.2, 2.88), 0.008, 4)
    p.cyl(m['black'], (0, 0.1, 2.72), (0, 0.18, 2.62), 0.01, 6)
    p.lathe(m['bulb'], [(0.0, 0.0), (0.04, 0.02), (0.035, 0.08), (0.0, 0.09)], 10, z0=2.52, cx=0, cy=0.18)
    stool(p, m, (0.95, 0.45, 0.0))
    for x in (-0.85, -0.7):
        p.box(m['rubber'], (x, 0.35, 0.01), (0.1, 0.26, 0.02), bevel=0.01)
    point('door_village', 'door', 0.0, 0.6, 0.12)
    point('door_village', 'drop', -0.35, 0.28, 0.12)
    point('door_village', 'stand', 0.0, 1.4, 0.0)
    return p.build(col)


def bus_sign(col, m):
    p = Part('bus_sign')
    for x in (-0.48, 0.48):
        p.box(m['steel'], (x, 0, 1.4), (0.07, 0.07, 2.8), bevel=0.01)
    p.box(m['steel'], (0, 0, 2.86), (1.12, 0.26, 0.08), bevel=0.02)                 # the cap
    p.box(m['alu_dark'], (0, 0, 1.75), (0.92, 0.16, 1.9), bevel=0.015)               # the lightbox frame
    for y, nm in ((0.081, 'front'), (-0.081, 'back')):
        p.box(m['bus_green'], (0, y, 1.75), (0.86, 0.004, 1.84))
    face('bus_sign', 'front', -0.42, 0.42, 0.85, 2.65, 0.084)
    face('bus_sign', 'back', 0.42, -0.42, 0.85, 2.65, -0.084)                        # mirrored: seen from -y
    p.box(m['granite_lt'], (0, 0, 0.03), (1.2, 0.4, 0.06))
    point('bus_sign', 'wait', 0.0, 1.0, 0.0)
    return p.build(col)


def station(col, m):
    """The courier station: local x along the pavement, +y toward the walkway (the booth's front). The container is
    hollow and its door stands open: a sofa under the wall TV, the phone-charging shelf, a microwave, the rules."""
    p = Part('station')
    L, Dp, Hc = 6.0, 2.4, 2.6
    T = 0.08                                   # wall thickness
    z0, z1 = 0.15, 0.15 + Hc                   # inside floor, under the roof
    fy = Dp / 2 - T / 2                        # the front wall's centre line
    # the container: floor slab, roof, back and end walls, the front wall around the window and the door
    p.box(m['container'], (0, 0, z0 / 2), (L, Dp, z0))
    p.box(m['tile'], (0, 0, z0 + 0.005), (L - 2 * T, Dp - 2 * T, 0.01))
    p.box(m['container'], (0, 0, z1 + 0.05), (L, Dp, 0.1))
    p.box(m['container'], (0, -Dp / 2 + T / 2, (z0 + z1) / 2), (L, T, Hc))
    for sx in (-1, 1):
        p.box(m['container'], (sx * (L / 2 - T / 2), 0, (z0 + z1) / 2), (T, Dp, Hc))
    wx0, wx1, wz0, wz1 = -2.2, 0.2, 0.75, 1.95             # window
    dx0, dx1, dz1 = 1.1, 2.1, 2.05                          # door
    for xa, xb, za, zb in ((-L / 2, wx0, z0, z1), (wx0, wx1, z0, wz0), (wx0, wx1, wz1, z1), (wx1, dx0, z0, z1),
                           (dx0, dx1, dz1, z1), (dx1, L / 2, z0, z1)):
        p.box(m['container'], ((xa + xb) / 2, fy, (za + zb) / 2), (xb - xa, T, zb - za))
    # ribbed outside (not across the openings)
    for k in range(25):
        x = -L / 2 + 0.12 + k * (L - 0.24) / 24
        if wx0 - 0.05 < x < wx1 + 0.05:
            p.box(m['container'], (x, Dp / 2 + 0.02, (z0 + wz0) / 2), (0.06, 0.04, wz0 - z0 - 0.05))
            p.box(m['container'], (x, Dp / 2 + 0.02, (wz1 + z1) / 2), (0.06, 0.04, z1 - wz1 - 0.05))
            continue
        if dx0 - 0.05 < x < dx1 + 0.05:
            continue
        p.box(m['container'], (x, Dp / 2 + 0.02, (z0 + z1) / 2), (0.06, 0.04, Hc - 0.2))
    # the light inside: lining on the back and end walls and the ceiling, two LED panels
    p.box(m['lining'], (0, -Dp / 2 + T + 0.01, (z0 + z1) / 2), (L - 2 * T, 0.02, Hc))
    for sx in (-1, 1):
        p.box(m['lining'], (sx * (L / 2 - T - 0.01), 0, (z0 + z1) / 2), (0.02, Dp - 2 * T, Hc))
    p.box(m['lining'], (0, 0, z1 - 0.01), (L - 2 * T, Dp - 2 * T, 0.02))
    for x in (-1.4, 1.2):
        p.box(m['ceiling_led'], (x, 0.0, z1 - 0.03), (1.2, 0.5, 0.02))
    # the brand stripe and the sign over the window and door
    p.box(m['lime'], (0, Dp / 2 + 0.045, 2.25), (L - 0.1, 0.02, 0.5))
    face('station', 'sign', -2.7, 2.7, 2.02, 2.48, Dp / 2 + 0.057)
    # window: frame, glass, the counter behind it
    p.box(m['alu'], ((wx0 + wx1) / 2, Dp / 2, wz0 - 0.02), (wx1 - wx0 + 0.1, 0.1, 0.05))
    p.box(m['alu'], ((wx0 + wx1) / 2, Dp / 2, wz1 + 0.02), (wx1 - wx0 + 0.1, 0.1, 0.05))
    for x in (wx0, (wx0 + wx1) / 2, wx1):
        p.box(m['alu'], (x, Dp / 2, (wz0 + wz1) / 2), (0.05, 0.1, wz1 - wz0))
    p.box(m['glass'], ((wx0 + wx1) / 2, Dp / 2 - 0.01, (wz0 + wz1) / 2), (wx1 - wx0, 0.012, wz1 - wz0))
    p.box(m['wood'], ((wx0 + wx1) / 2, Dp / 2 - 0.3, 1.0), (wx1 - wx0 - 0.1, 0.42, 0.05))
    p.box(m['alu_dark'], ((wx0 + wx1) / 2, Dp / 2 - 0.3, 0.58), (wx1 - wx0 - 0.1, 0.38, 0.84))
    # the door: frame, and the leaf standing open toward the street on its right-hand hinge
    for x in (dx0, dx1):
        p.box(m['alu_dark'], (x, fy, (z0 + dz1) / 2), (0.06, T + 0.04, dz1 - z0))
    p.box(m['alu_dark'], ((dx0 + dx1) / 2, fy, dz1), (dx1 - dx0 + 0.06, T + 0.04, 0.06))
    p.box(m['charcoal'], (dx1 + 0.03, Dp / 2 + 0.48, (z0 + dz1) / 2), (0.05, 0.92, dz1 - z0 - 0.04))
    p.cyl(m['steel'], (dx1 + 0.08, Dp / 2 + 0.85, 0.95), (dx1 + 0.08, Dp / 2 + 0.85, 1.25), 0.014, 8)
    p.box(m['mat_door'], ((dx0 + dx1) / 2, Dp / 2 + 0.35, 0.01), (0.9, 0.6, 0.02))
    # inside: the sofa under the TV, the charging shelf, a microwave, a fan; the rules on the front wall
    by = -Dp / 2 + T + 0.02
    p.box(m['black'], (-1.65, by + 0.33, 0.37), (2.1, 0.62, 0.42), bevel=0.05)
    p.box(m['black'], (-1.65, by + 0.09, 0.78), (2.1, 0.16, 0.5), bevel=0.05)
    for x in (-2.66, -0.64):
        p.box(m['black'], (x, by + 0.33, 0.55), (0.14, 0.62, 0.36), bevel=0.04)
    p.box(m['black'], (-1.65, by + 0.03, 1.9), (1.7, 0.05, 0.98), bevel=0.01)
    face('station', 'tv', -2.45, -0.85, 1.46, 2.34, by + 0.06)
    p.box(m['alu'], (1.5, by + 0.16, 1.05), (1.9, 0.3, 0.03))                                   # charging shelf
    for k in range(8):
        x = 0.68 + k * 0.235
        p.box(m['black'], (x, by + 0.2, 1.11), (0.08, 0.14, 0.01))                              # phones on charge
        p.box(m['screen'], (x, by + 0.2, 1.116), (0.07, 0.12, 0.002))
        p.cyl(m['black'], (x, by + 0.08, 1.07), (x, by + 0.02, 1.3), 0.004, 4)
    p.box(m['white_plastic'], (1.5, by + 0.05, 1.42), (1.9, 0.06, 0.16))                          # the socket strip
    face('station', 'charge', 0.6, 2.4, 1.36, 1.48, by + 0.085)
    p.box(m['swap_white'], (2.55, by + 0.2, 1.42), (0.5, 0.36, 0.3), bevel=0.01)                  # microwave
    p.box(m['black'], (2.5, by + 0.385, 1.42), (0.3, 0.01, 0.2))
    p.box(m['alu'], (2.55, by + 0.2, 1.26), (0.6, 0.4, 0.03))
    face('station', 'rules', dx0 - 0.08, wx1 + 0.08, 0.95, 1.95, fy - T / 2 - 0.006)            # faces into the room
    point('station', 'sofa', -1.65, by + 0.95, z0)
    point('station', 'charger', 1.5, by + 0.85, z0)
    point('station', 'door_in', (dx0 + dx1) / 2, Dp / 2 - 0.6, z0)
    point('station', 'door_out', (dx0 + dx1) / 2, Dp / 2 + 0.7, 0.0)
    p.box(m['awning'], (-0.4, Dp / 2 + 0.75, 2.55), (5.2, 1.5, 0.05), rot=Matrix.Rotation(math.radians(-8), 3, 'X'))
    for x in (-2.8, 2.0):
        p.cyl(m['steel'], (x, Dp / 2 + 0.05, 2.62), (x, Dp / 2 + 1.45, 2.42), 0.02, 6)
    # the weekly ranking board on the wall
    p.box(m['charcoal'], (-2.55, Dp / 2 + 0.06, 1.25), (0.62, 0.04, 0.9))
    face('station', 'rank', -2.83, -2.27, 0.84, 1.66, Dp / 2 + 0.082)
    # two battery-swap cabinets at the right end: 3 x 4 doors with a green LED each, a screen on top
    for j, cx in enumerate((L / 2 + 0.65, L / 2 + 1.75)):
        p.box(m['swap_white'], (cx, 0.6, 0.95), (0.95, 0.6, 1.9), bevel=0.02)
        p.box(m['swap_blue'], (cx, 0.6, 1.95), (0.97, 0.62, 0.12))
        p.box(m['screen'], (cx, 0.91, 1.68), (0.42, 0.01, 0.26))
        if j == 0:
            face('station', 'swap', cx - 0.2, cx + 0.2, 1.56, 1.8, 0.918)
        for i in range(3):
            for k in range(4):
                x, z = cx - 0.3 + i * 0.3, 0.25 + k * 0.32
                p.box(m['swap_white'], (x, 0.905, z), (0.26, 0.012, 0.27))
                p.box(m['led_green'] if (i + k + j) % 4 else m['heat_lamp'], (x + 0.09, 0.913, z + 0.1), (0.03, 0.006, 0.03))
    # bench, water dispenser, a plastic table and stools in front
    p.box(m['wood'], (-1.2, Dp / 2 + 1.1, 0.45), (2.4, 0.4, 0.06))
    for x in (-2.3, -0.1):
        p.box(m['steel'], (x, Dp / 2 + 1.1, 0.22), (0.06, 0.36, 0.44))
    p.box(m['white_plastic'], (0.4, Dp / 2 + 0.35, 0.55), (0.35, 0.35, 1.1), bevel=0.02)
    p.cyl(m['water_blue'], (0.4, Dp / 2 + 0.35, 1.1), (0.4, Dp / 2 + 0.35, 1.5), 0.13, 14)
    p.lathe(m['red_plastic'], [(0.0, 0.72), (0.38, 0.72), (0.38, 0.69), (0.3, 0.66), (0.06, 0.05), (0.2, 0.0), (0.0, 0.0)], 18, cx=1.5, cy=Dp / 2 + 1.6)
    for a in (0.0, 2.1, 4.2):
        stool(p, m, (1.5 + math.cos(a) * 0.55, Dp / 2 + 1.6 + math.sin(a) * 0.55, 0.0))
    point('station', 'stand', 0.0, Dp / 2 + 2.6, 0.0)
    point('station', 'bench', -1.2, Dp / 2 + 1.1, 0.0)
    point('station', 'swap', L / 2 + 0.65, 1.6, 0.0)
    point('station', 'water', 0.4, Dp / 2 + 0.85, 0.0)
    point('station', 'bikes', -1.0, Dp / 2 + 3.6, 0.0)
    return p.build(col)


def robot(col, m):
    p = Part('robot')
    # base with wheels, a tapered body, a head with the face screen, the hatch with a lime trim
    p.lathe(m['charcoal'], [(0.0, 0.05), (0.28, 0.05), (0.3, 0.12), (0.28, 0.18), (0.0, 0.18)], 24)
    p.lathe(m['robot_white'], [(0.0, 0.16), (0.27, 0.16), (0.26, 0.55), (0.22, 0.85), (0.0, 0.85)], 24)
    p.box(m['lime'], (0, 0.266, 0.52), (0.28, 0.014, 0.03))
    p.box(m['charcoal'], (0, 0.272, 0.38), (0.26, 0.012, 0.24), bevel=0.005)          # the hatch, a thin door on the shell
    p.lathe(m['robot_white'], [(0.0, 0.86), (0.19, 0.86), (0.21, 0.98), (0.18, 1.1), (0.0, 1.12)], 24)
    p.box(m['screen'], (0, 0.19, 0.99), (0.24, 0.03, 0.14), bevel=0.02)
    face('robot', 'face', -0.11, 0.11, 0.93, 1.05, 0.206)
    for a in (0.6, 2.5, 4.4):
        p.cyl(m['rubber'], (math.cos(a) * 0.2, math.sin(a) * 0.2, 0.0), (math.cos(a) * 0.2, math.sin(a) * 0.2, 0.06), 0.05, 10)
    return p.build(col)


def stall(col, m):
    """A street food stall on an electric tricycle (x along the cart, +y the customer side)."""
    p = Part('stall')
    cx = 0.35                                            # the cart over the rear bed
    # the tricycle: front wheel, fork, shield, seat, handlebar; the bed on two rear wheels
    for y in (-0.5, 0.5):
        p.cyl(m['rubber'], (0.75, y - 0.06, 0.22), (0.75, y + 0.06, 0.22), 0.22, 18)
        p.cyl(m['steel'], (0.75, y - 0.065, 0.22), (0.75, y + 0.065, 0.22), 0.09, 12)
    p.cyl(m['rubber'], (-1.42, -0.05, 0.2), (-1.42, 0.05, 0.2), 0.2, 18)
    p.cyl(m['steel'], (-1.42, -0.055, 0.2), (-1.42, 0.055, 0.2), 0.08, 12)
    p.cyl(m['trike_blue'], (-1.42, 0.0, 0.2), (-1.3, 0.0, 0.92), 0.035, 8)                       # fork
    p.box(m['trike_blue'], (-1.22, 0.0, 0.62), (0.12, 0.5, 0.62), bevel=0.04, rot=Matrix.Rotation(math.radians(12), 3, 'Y'))
    p.cyl(m['black'], (-1.3, -0.33, 1.02), (-1.3, 0.33, 1.02), 0.016, 8)                         # handlebar
    for y in (-0.33, 0.33):
        p.cyl(m['rubber'], (-1.3, y, 1.02), (-1.3, y + (0.1 if y > 0 else -0.1), 1.02), 0.022, 8)
    p.box(m['trike_blue'], (-0.85, 0.0, 0.38), (0.75, 0.42, 0.16), bevel=0.03)                   # footboard
    p.box(m['black'], (-0.78, 0.0, 0.78), (0.42, 0.3, 0.1), bevel=0.04)                          # seat
    p.box(m['trike_blue'], (-0.78, 0.0, 0.58), (0.28, 0.24, 0.32), bevel=0.03)
    p.box(m['trike_blue'], (cx, 0.0, 0.43), (1.75, 0.98, 0.06))                                  # the bed
    p.box(m['trike_blue'], (cx, 0.0, 0.33), (1.6, 0.1, 0.16))
    # the stainless cart: body, counter top, glass display case, posts and the header lightbox
    p.box(m['steel'], (cx, 0.0, 0.86), (1.5, 0.85, 0.8), bevel=0.01)
    p.box(m['steel'], (cx, 0.03, 1.275), (1.6, 0.92, 0.03))
    gx0, gx1, gy, gz0, gz1 = cx - 0.6, cx + 0.3, 0.14, 1.29, 1.72
    for x in (gx0, gx1):
        for y in (gy - 0.24, gy + 0.24):
            p.box(m['alu'], (x, y, (gz0 + gz1) / 2), (0.025, 0.025, gz1 - gz0))
    p.box(m['alu'], ((gx0 + gx1) / 2, gy, gz1), (gx1 - gx0, 0.5, 0.02))
    p.box(m['glass'], ((gx0 + gx1) / 2, gy + 0.24, (gz0 + gz1) / 2), (gx1 - gx0, 0.01, gz1 - gz0))
    p.box(m['glass'], ((gx0 + gx1) / 2, gy - 0.24, (gz0 + gz1) / 2), (gx1 - gx0, 0.01, gz1 - gz0))
    for x in (gx0, gx1):
        p.box(m['glass'], (x, gy, (gz0 + gz1) / 2), (0.01, 0.48, gz1 - gz0))
    p.box(m['steel'], ((gx0 + gx1) / 2, gy, 1.5), (gx1 - gx0 - 0.04, 0.44, 0.015))               # the shelf inside
    for k in range(5):                                                                             # food in the case
        x = gx0 + 0.12 + k * 0.17
        p.cyl(m['roast_lt'] if k % 2 else m['wood'], (x, gy, 1.3), (x, gy, 1.36), 0.065, 10)
        p.cyl(m['white_plastic'], (x, gy - 0.05, 1.515), (x, gy - 0.05, 1.56), 0.05, 10)
    for x in (cx - 0.72, cx + 0.72):
        p.cyl(m['steel'], (x, -0.36, 1.29), (x, -0.36, 2.42), 0.018, 8)
    p.box(m['sign_body'], (cx, -0.36, 2.18), (1.56, 0.09, 0.48), bevel=0.01)
    face('stall', 'fascia', cx - 0.74, cx + 0.74, 1.96, 2.4, -0.31)
    p.box(m['led_warm'], (cx, -0.25, 1.93), (1.4, 0.03, 0.03))
    # the front panel sign and the payment codes
    face('stall', 'front', cx - 0.72, cx + 0.72, 0.5, 1.22, 0.43)
    for x, mm in ((cx + 0.46, 'qr_green'), (cx + 0.66, 'qr_blue')):
        p.box(m[mm], (x, gy + 0.255, 1.55), (0.17, 0.008, 0.24))
        p.box(m['white_plastic'], (x, gy + 0.26, 1.53), (0.12, 0.004, 0.12))
    # on the counter: the steamer stack, a ladle, bags ready to go
    for k in range(3):
        p.lathe(m['steam_pot'], [(0.0, 0.1), (0.2, 0.1), (0.21, 0.09), (0.21, 0.01), (0.2, 0.0), (0.0, 0.0)], 18,
                z0=1.29 + k * 0.1, cx=cx + 0.55, cy=-0.08)
    p.lathe(m['steam_pot'], [(0.0, 0.08), (0.05, 0.08), (0.2, 0.02), (0.21, 0.0), (0.0, 0.0)], 18, z0=1.59, cx=cx + 0.55, cy=-0.08)
    bag(p, m, (cx - 0.15, 0.33, 1.29), 0.8, 'bag_white')
    bag(p, m, (cx + 0.15, 0.33, 1.29), 0.8, 'bag_red')
    # around it: LPG cylinder, stainless bucket, cooler, two stools
    p.cyl(m['lpg'], (cx + 1.08, -0.25, 0.0), (cx + 1.08, -0.25, 0.52), 0.15, 16)
    p.lathe(m['lpg'], [(0.0, 0.62), (0.03, 0.62), (0.04, 0.55), (0.15, 0.52), (0.0, 0.52)], 14, cx=cx + 1.08, cy=-0.25)
    p.lathe(m['steel'], [(0.0, 0.5), (0.2, 0.5), (0.21, 0.48), (0.2, 0.0), (0.0, 0.0)], 18, cx=cx + 1.12, cy=0.28)
    p.box(m['cooler_blue'], (cx - 1.25, 0.62, 0.2), (0.6, 0.4, 0.38), bevel=0.03)
    p.box(m['white_plastic'], (cx - 1.25, 0.62, 0.41), (0.62, 0.42, 0.05), bevel=0.02)
    stool(p, m, (cx - 1.5, 1.15, 0.0))
    stool(p, m, (cx + 1.35, 1.0, 0.0))
    point('stall', 'stand', cx, 1.3, 0.0)
    point('stall', 'staff', cx - 0.1, -0.78, 0.0)
    point('stall', 'counter', cx, 0.33, 1.29)
    point('stall', 'door', cx, 1.0, 0.0)
    return p.build(col)


def takeaway_bag(col, m):
    p = Part('bag')
    bag(p, m, (0, 0, 0), 1.0)
    return p.build(col)


def build():
    col = bpy.data.collections.new('shopkit')
    bpy.context.scene.collection.children.link(col)
    m = M()
    objs = [f(col, m) for f in (shop_restaurant, shop_tea, shop_convenience, shop_mall, shop_shop, lobby, door_unit, door_village, takeaway_bag, bus_sign, station, robot, stall)]
    for i, o in enumerate(objs):
        o.location.x = i * 9.0         # side by side for the preview; the GLB keeps each at its own origin
    return col, objs


def preview(objs):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 32
    sc.render.resolution_x, sc.render.resolution_y = 1400, 900
    sc.view_settings.view_transform = 'AgX'
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (0.55, 0.6, 0.66, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    sc.world = w
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.0; sun.data.angle = math.radians(3); sun.rotation_euler = (math.radians(50), 0, math.radians(200))
    sc.collection.objects.link(sun)
    import bmesh
    gm = bpy.data.meshes.new('g'); bmg = bmesh.new(); bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=60); bmg.to_mesh(gm); bmg.free()
    gm.materials.append(mat('preview ground', '#77787a', 0, 0.85))
    g = bpy.data.objects.new('ground', gm); sc.collection.objects.link(g)
    wm = bpy.data.meshes.new('wall'); bmw = bmesh.new(); bmesh.ops.create_cube(bmw, size=1.0)
    bmesh.ops.transform(bmw, matrix=Matrix.Translation((50, -0.5, 5)) @ Matrix.Diagonal((110, 1, 10, 1)), verts=bmw.verts)
    bmw.to_mesh(wm); bmw.free(); wm.materials.append(mat('preview wall', '#8a8f94', 0, 0.8))
    wall = bpy.data.objects.new('wall', wm); sc.collection.objects.link(wall)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    os.makedirs(PREV, exist_ok=True)
    for o in objs:
        c = o.location.x
        small = o.name in ('kit_bag', 'kit_robot')
        tgt = Vector((c, 0.8, 1.6 if not small else 0.5))
        eye = Vector((c + 3.2, 6.5, 2.3)) if not small else Vector((c + 1.2, 2.2, 1.2))
        if o.name == 'kit_station':
            tgt, eye = Vector((c + 1.0, 1.2, 1.3)), Vector((c + 5.5, 9.5, 3.2))
        cam.location = eye
        cam.rotation_euler = (tgt - eye).to_track_quat('-Z', 'Y').to_euler()
        cam.data.lens = 32 if o.name != 'kit_bag' else 50
        sc.render.filepath = os.path.join(PREV, 'shopkit_' + o.name.replace('kit_', '') + '.png')
        bpy.ops.render.render(write_still=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    col, objs = build()
    for o in objs:
        n = sum(len(p.vertices) - 2 for p in o.data.polygons)
        print('[shopkit]', o.name, n, 'tris', len(o.data.materials), 'materials', flush=True)
    if '--no-preview' not in ARGS:
        preview(objs)
    for o in objs:
        o.location.x = 0
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    path = os.path.join(OUT, 'gz_shopkit.glb')
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_materials='EXPORT', export_texcoords=True, export_normals=True, export_extras=False,
                              export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
    json.dump({'faces': FACES, 'points': POINTS, 'bay': {'w': W, 'h': H, 'd': D}}, open(os.path.join(OUT, 'gz_shopkit.json'), 'w'), indent=1)
    print('[shopkit] ->', path, os.path.getsize(path) // 1024, 'KB', flush=True)


if __name__ == '__main__':
    main()
