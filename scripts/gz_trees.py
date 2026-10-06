"""Leaf atlas for the Tianhe street trees, baked from real leaf geometry (the lotus-pond way: every leaf a
mesh with a folded midrib, twigs as swept tubes), for the web demo's leaf-card crowns.

    Blender --background --factory-startup --python guangzhou/scripts/gz_trees.py

Each cluster is modelled at true size lying in the XY plane and shot straight down with an orthographic
camera, twice: colour (EEVEE, soft uniform light so it stays close to albedo, transparent film) and
tangent-space normals (every material swapped for an emission of the world normal, which equals the
card's tangent frame when looking down -Z). Colours are dilated into the transparent pixels so mipmaps
do not grow dark fringes.

Atlas layout (uv, v up; same as guangzhou/demo/src/world/Trees.ts CELL):
    banyan   [0, .5]-[.5, 1]     Ficus microcarpa twigs, ~1,100 leaves of 4-8 cm, 3.2 m square
    kapok    [.5, .5]-[1, 1]     palmate kapok leaves and a few flowers, 2.2 m square
    frond    [0, .25]-[1, .5]    royal palm frond, 5.2 x 1.3 m
    bloom    [k/4, 0]-[(k+1)/4, .25]   four kapok flower clusters on bare twigs, 1.2 m square

Writes guangzhou/demo/public/assets/trees/leaf_atlas.png (+ _n.jpg normals) and renders/trees/atlas_preview.png.
"""
import math
import os
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'lotus_pond', 'scripts'))
import common as c  # noqa: E402  (lotus pond helpers: mesh, tube, bezier, materials)

OUT = os.path.join(ROOT, 'demo', 'public', 'assets', 'trees')
PREV = os.path.join(ROOT, 'renders', 'trees')
ATLAS = 2048


def log(*a):
    print('[trees]', *a, flush=True)


# ------------------------------------------------------------------------------------------ geometry
class Acc:
    def __init__(self):
        self.V, self.F, self.col, self.n = [], [], [], 0

    def add(self, V, F, color):
        V = np.asarray(V, float)
        self.V.append(V)
        self.F.extend([[i + self.n for i in f] for f in F])
        self.col.extend([color] * len(F))
        self.n += len(V)

    def obj(self, name, mat, col):
        me = c.mesh(name, np.vstack(self.V), self.F, materials=[mat], smooth=True)
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
        cols = np.repeat(np.asarray(self.col, np.float32), [len(f) for f in self.F], axis=0)
        attr.data.foreach_set('color', np.hstack([cols, np.ones((len(cols), 1), np.float32)]).ravel())
        return c.obj(name, me, col)


def leaf_shape(L, W, n=5, obovate=0.0, fold=0.25, blunt=1.0):
    """Leaf outline in XY, base at origin, tip at +Y; widest point moves toward the tip with obovate,
    blunt < 1 rounds the tip (petals)."""
    s = np.linspace(0, 1, n + 2)[1:-1]
    w = W / 2 * np.sin(np.pi * s ** (0.8 - 0.35 * obovate)) ** blunt
    left = np.stack([-w, s * L, np.zeros_like(s)], -1)
    right = np.stack([w, s * L, np.zeros_like(s)], -1)
    V = np.vstack([[0, 0, 0], left, [0, L, 0], right[::-1]])
    k = len(V)
    F = [[0, k - 1, 1]]
    for i in range(n):
        a, b, ra, rb = 1 + i, 2 + i, k - 1 - i, k - 2 - i
        F.append([a, ra, rb, b] if i < n - 1 else [a, ra, n + 1])
    V[:, 2] = np.abs(V[:, 0]) * fold
    return V, F


def place(acc, V, F, base, direction, up, color):
    d = direction / np.linalg.norm(direction)
    u = up - d * np.dot(up, d)
    nu = np.linalg.norm(u)
    u = u / nu if nu > 1e-6 else np.array([0, 0, 1.0])
    side = np.cross(d, u)
    R = np.stack([side, d, u], -1)
    acc.add(V @ R.T + base, F, color)


def twig(acc, rng, p0, direction, length, r0, r1, color, bend=0.3):
    d = direction / np.linalg.norm(direction)
    side = np.cross(d, [0, 0, 1.0]); side = side / (np.linalg.norm(side) + 1e-9)
    p3 = p0 + d * length + side * rng.normal(0, bend) * length * 0.3
    p1 = p0 + d * length * 0.35 + side * rng.normal(0, bend) * length * 0.2
    p2 = p3 - d * length * 0.3
    path = c.bezier(p0, p1, p2, p3, 8)
    V, F, _ = c.tube(path, np.linspace(r0, r1, 8), sides=5, cap_top=True)
    acc.add(V, F, color)
    return path


def hsv(h, s, v):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (r ** 2.2, g ** 2.2, b ** 2.2)


def banyan_cluster(col, mat, size=3.2, seed=1):
    """A patch of banyan crown seen from outside: three-level forking twigs coming up from inside the crown,
    small glossy leaves crowded along the outer twigs (~60 % cover), gaps that show the twigs behind."""
    rng = np.random.default_rng(seed)
    wood, leaves = Acc(), Acc()
    bark = hsv(0.08, 0.2, 0.36)
    h = size / 2

    def grow(p, d, length, r, level):
        path = twig(wood, rng, p, d, length, r, r * 0.55, bark, 0.35)
        if level >= 2 or length < 0.12:
            for q in path[1:]:
                for _ in range(int(rng.integers(4, 8))):
                    L = rng.uniform(0.045, 0.08)
                    dv = rng.normal(0, 1, 3); dv[2] = abs(dv[2]) * 0.5 + 0.15
                    V, F = leaf_shape(L, L * rng.uniform(0.5, 0.62), obovate=0.6, fold=0.18)
                    colr = hsv(0.26 + rng.normal(0, 0.022), 0.55 + rng.uniform(0, 0.25), 0.18 + rng.uniform(0, 0.17))
                    place(leaves, V, F, q + rng.normal(0, 0.035, 3), dv, np.array([0, 0, 1.0]) + rng.normal(0, 0.45, 3), colr)
            return
        n = int(rng.integers(2, 4))
        for k in range(n):
            t = rng.uniform(0.45, 1.0)
            q = path[min(7, int(t * 7))]
            a = math.atan2(d[1], d[0]) + rng.normal(0, 0.8)
            grow(q, np.array([math.cos(a), math.sin(a), rng.uniform(0.05, 0.35)]), length * rng.uniform(0.5, 0.7), r * 0.6, level + 1)

    for k in range(22):
        # limbs rise from inside the crown at scattered points, pointing outward
        p0 = np.array([rng.uniform(-h, h) * 0.8, rng.uniform(-h, h) * 0.8, -0.35])
        a = rng.uniform(0, 2 * np.pi)
        grow(p0, np.array([math.cos(a), math.sin(a), 0.25]), rng.uniform(0.6, 0.95), 0.012, 0)
    wood.obj('banyan twigs', mat['bark'], col)
    leaves.obj('banyan leaves', mat['leaf'], col)
    log('banyan cluster: %d leaves' % (len(leaves.F) // 6))


def kapok_leaf(acc, rng, p, direction, up, scale, color):
    """Palmately compound leaf: five to seven leaflets fanned from the petiole tip."""
    n = int(rng.integers(5, 8))
    d = direction / np.linalg.norm(direction)
    side = np.cross(d, up); side /= np.linalg.norm(side) + 1e-9
    for i in range(n):
        a = (i / (n - 1) - 0.5) * math.radians(150)
        dv = d * math.cos(a) + side * math.sin(a)
        L = scale * (1.0 - 0.35 * abs(i / (n - 1) - 0.5) * 2)
        V, F = leaf_shape(L, L * 0.32, n=6, fold=0.3)
        p = p + dv * scale * 0.08                                    # leaflets part at the petiole tip
        place(acc, V, F, p, dv + up * 0.15, up, color)


def flower(acc, rng, p, up, size, cup=0.55):
    """Kapok flower: five thick crimson petals in a cup, a brush of yellow stamens."""
    up = up / np.linalg.norm(up)
    ref = np.cross(up, [1.0, 0.2, 0.1]); ref /= np.linalg.norm(ref)
    col = hsv(0.01 + rng.uniform(0, 0.035), 0.88, 0.6 + rng.uniform(0, 0.22))
    for k in range(5):
        a = k / 5 * 2 * np.pi + rng.normal(0, 0.1)
        out = c.rotate_vec(ref, up, a)
        dv = out * math.cos(cup) + up * math.sin(cup)
        # thick fleshy petals, broad near the tip, curling back
        V, F = leaf_shape(size, size * 0.8, n=9, obovate=0.85, fold=0.5, blunt=0.4)
        V[:, 2] -= (V[:, 1] / size) ** 2 * size * 0.35
        place(acc, V, F, p, dv, up, col)
    # dark calyx cup under the petals
    V, F = leaf_shape(size * 0.35, size * 0.4, n=3, fold=0.2)
    for k in range(5):
        a = k / 5 * 2 * np.pi + 0.6
        place(acc, V, F, p - up * 0.01, c.rotate_vec(ref, up, a) * 0.5 - up * 0.2, up, hsv(0.05, 0.6, 0.25))
    for k in range(18):
        a = rng.uniform(0, 2 * np.pi)
        out = c.rotate_vec(ref, up, a)
        dv = out * 0.35 + up
        V, F = leaf_shape(size * 0.55, size * 0.05, n=2, fold=0.0)
        place(acc, V, F, p, dv, out, hsv(0.13, 0.8, 0.9))


def kapok_cluster(col, mat, size=2.2, seed=2):
    rng = np.random.default_rng(seed)
    wood, leaves, flowers = Acc(), Acc(), Acc()
    bark = hsv(0.07, 0.15, 0.45)
    h = size / 2
    for k in range(11):
        a = k / 11 * 2 * np.pi + rng.normal(0, 0.3)
        p0 = np.array([rng.normal(0, 0.15), rng.normal(0, 0.15), -0.2])
        br = twig(wood, rng, p0, np.array([math.cos(a), math.sin(a), 0.1]), rng.uniform(0.7, 1.0) * h, 0.03, 0.008, bark, 0.5)
        for p in br[3:]:
            for _ in range(2):
                if rng.uniform() < 0.85:
                    pet = twig(wood, rng, p, np.array([math.cos(a + rng.normal(0, 0.9)), math.sin(a + rng.normal(0, 0.9)), 0.3]), rng.uniform(0.1, 0.2), 0.004, 0.003, bark)
                    kapok_leaf(leaves, rng, pet[-1], np.array([math.cos(a + rng.normal(0, 0.8)), math.sin(a + rng.normal(0, 0.8)), 0.0]),
                               np.array([0, 0, 1.0]), rng.uniform(0.12, 0.18), hsv(0.25 + rng.normal(0, 0.02), 0.6, 0.26 + rng.uniform(0, 0.12)))
            if rng.uniform() < 0.45:
                flower(flowers, rng, p + np.array([0, 0, 0.05]), np.array([0, 0, 1.0]) + rng.normal(0, 0.3, 3), rng.uniform(0.075, 0.095))
    wood.obj('kapok twigs', mat['bark'], col)
    leaves.obj('kapok leaves', mat['leaf'], col)
    flowers.obj('kapok flowers', mat['petal'], col)


def bloom_cluster(col, mat, size=1.2, seed=3):
    rng = np.random.default_rng(seed)
    wood, flowers = Acc(), Acc()
    bark = hsv(0.07, 0.12, 0.42)
    h = size / 2
    base = twig(wood, rng, np.array([-h * 0.9, rng.uniform(-0.2, 0.2), 0]), np.array([1.0, rng.normal(0, 0.2), 0.05]), size * 0.9, 0.025, 0.01, bark, 0.4)
    for p in base[1:]:
        for _ in range(int(rng.integers(1, 3))):
            b = np.array([rng.normal(0.3, 0.5), rng.choice([-1, 1]) * rng.uniform(0.5, 1.0), 0.2])
            sp = twig(wood, rng, p, b, rng.uniform(0.15, 0.35), 0.01, 0.004, bark)
            for q in sp[4::2]:
                if rng.uniform() < 0.9:
                    flower(flowers, rng, q + np.array([0, 0, 0.05]), np.array([0, 0, 1.0]) + rng.normal(0, 0.35, 3), rng.uniform(0.075, 0.1))
    wood.obj('bloom twigs', mat['bark'], col)
    flowers.obj('bloom flowers', mat['petal'], col)


def frond(col, mat, length=5.2, width=1.3, seed=4):
    """Royal palm frond seen from above: the rachis along +X, leaflets in two ranks with a slight V."""
    rng = np.random.default_rng(seed)
    wood, leaves = Acc(), Acc()
    path = c.bezier(np.array([0, 0, 0]), np.array([length * 0.33, 0, 0.02]), np.array([length * 0.66, 0, 0.0]), np.array([length, 0, -0.05]), 24)
    V, F, _ = c.tube(path, np.linspace(0.035, 0.006, 24), sides=6, cap_top=True)
    wood.add(V, F, hsv(0.17, 0.35, 0.55))
    x = 0.25
    while x < length - 0.05:
        t = x / length
        Lmax = width / 2 * (math.sin(math.pi * min(1.0, t * 1.08)) * 0.9 + 0.1)
        for sd in (-1, 1):
            L = Lmax * rng.uniform(0.85, 1.05)
            ang = math.radians(rng.uniform(38, 55))
            dv = np.array([math.cos(ang), sd * math.sin(ang), 0.12])
            V, F = leaf_shape(L, 0.035, n=6, fold=0.35)
            place(leaves, V, F, np.array([x, 0, 0.01]), dv, np.array([0, 0, 1.0]), hsv(0.24 + rng.normal(0, 0.02), 0.62, 0.3 + rng.uniform(0, 0.12)))
        x += rng.uniform(0.045, 0.06)
    wood.obj('frond rachis', mat['bark_light'], col)
    leaves.obj('frond leaflets', mat['leaf'], col)


# ------------------------------------------------------------------------------------------ materials
def materials():
    def principled(name, color_attr=True, base=(0.3, 0.3, 0.3), rough=0.45, spec=0.25, back=1.25):
        m = c.new_material(name)
        nb, out = c.output(m)
        if color_attr:
            a = nb.node('ShaderNodeVertexColor', layer_name='Col').outputs['Color']
            geo = nb.node('ShaderNodeNewGeometry')
            # undersides lighter and duller
            col = nb.mix(geo.outputs['Backfacing'], a, nb.mix(0.3 * (back - 1.0) * 4, a, (0.55, 0.62, 0.35))) if back != 1.0 else a
        else:
            col = base
        p = c.principled(nb, **{'Base Color': col, 'Roughness': rough, 'Specular IOR Level': spec})
        nb.set(out.inputs['Surface'], p.outputs[0])
        return m
    return {'leaf': principled('GZT leaf'), 'petal': principled('GZT petal', back=1.1, rough=0.55),
            'bark': principled('GZT bark', back=1.0, rough=0.9), 'bark_light': principled('GZT rachis', back=1.0, rough=0.7)}


def normal_material():
    """Emission of the (camera-facing) world normal, encoded 0..1: a tangent-space map for top-down cards."""
    m = c.new_material('GZT normal')
    nb, out = c.output(m)
    geo = nb.node('ShaderNodeNewGeometry')
    n = nb.vmath('MULTIPLY', geo.outputs['Normal'], (1, 1, 1))
    flip = nb.node('ShaderNodeVectorMath', operation='SCALE')
    nb.set(flip.inputs[0], n)
    nb.set(flip.inputs['Scale'], nb.sub(1.0, nb.mul(geo.outputs['Backfacing'], 2.0)))
    enc = nb.vmath('MULTIPLY_ADD', flip.outputs[0], (0.5, 0.5, 0.5), (0.5, 0.5, 0.5))
    em = nb.node('ShaderNodeEmission', {'Color': enc, 'Strength': 1.0})
    nb.set(out.inputs['Surface'], em.outputs[0])
    return m


# ------------------------------------------------------------------------------------------ baking
def shoot(col, extent, res, path, normal_mat=None):
    """Orthographic top-down render of one collection: extent = (cx, cy, sx, sy) metres, res = (w, h) px."""
    sc = bpy.context.scene
    for cc in bpy.data.collections:
        lc = bpy.context.view_layer.layer_collection.children.get(cc.name)
        if lc:
            lc.exclude = cc != col
    cam = bpy.data.objects.get('bake cam') or bpy.data.objects.new('bake cam', bpy.data.cameras.new('bake cam'))
    if cam.name not in sc.collection.objects:
        sc.collection.objects.link(cam)
    cx, cy, sx, sy = extent
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = max(sx, sy)
    cam.data.clip_start, cam.data.clip_end = 0.1, 20
    cam.location = (cx, cy, 6)
    cam.rotation_euler = (0, 0, 0)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.film_transparent = True
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.color_depth = '8'
    over = sc.view_layers[0]
    over.material_override = normal_mat
    sc.view_settings.view_transform = 'Raw' if normal_mat else 'Standard'
    bpy.ops.render.render(write_still=True)
    over.material_override = None
    img = bpy.data.images.load(path, check_existing=False)
    px = np.array(img.pixels[:], np.float32).reshape(res[1], res[0], 4)
    bpy.data.images.remove(img)
    return px


def dilate(px, it=10):
    """Bleed colour into transparent pixels (keeps alpha)."""
    rgb, a = px[..., :3].copy(), px[..., 3]
    known = a > 0.5
    for _ in range(it):
        acc = np.zeros_like(rgb); cnt = np.zeros(a.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(known, dy, 0), dx, 1)
            acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * sh[..., None]
            cnt += sh
        grow = (~known) & (cnt > 0)
        rgb[grow] = acc[grow] / cnt[grow][:, None]
        known = known | grow
    out = px.copy(); out[..., :3] = rgb
    return out


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.eevee.taa_render_samples = 16
    w = bpy.data.worlds.new('bake light')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    sc.world = w
    # a soft key from above so leaves shade each other a little
    sun = bpy.data.objects.new('key', bpy.data.lights.new('key', 'SUN'))
    sun.data.energy = 1.2; sun.data.angle = math.radians(40)
    sun.rotation_euler = (math.radians(20), math.radians(10), 0)
    sc.collection.objects.link(sun)
    mats = materials()
    nmat = normal_material()
    cols = {}
    for name in ('banyan', 'kapok', 'frond', 'bloom0', 'bloom1', 'bloom2', 'bloom3'):
        cols[name] = c.collection('T ' + name)
    banyan_cluster(cols['banyan'], mats)
    kapok_cluster(cols['kapok'], mats)
    frond(cols['frond'], mats)
    for k in range(4):
        bloom_cluster(cols['bloom%d' % k], mats, seed=10 + k)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(PREV, exist_ok=True)
    tmp = os.path.join(PREV, '_cell.png')
    atlas = np.zeros((ATLAS, ATLAS, 4), np.float32)
    natlas = np.zeros((ATLAS, ATLAS, 4), np.float32)
    natlas[..., :3] = (0.5, 0.5, 1.0)
    H = ATLAS // 2
    # (collection, extent (cx, cy, sx, sy), pixel rect x0, y0 (bottom-up rows), w, h)
    cells = [('banyan', (0, 0, 3.2, 3.2), 0, H, H, H), ('kapok', (0, 0, 2.2, 2.2), H, H, H, H),
             ('frond', (2.6, 0, 5.2, 1.3), 0, ATLAS // 4, ATLAS, ATLAS // 4)]
    cells += [('bloom%d' % k, (0, 0, 1.2, 1.2), k * ATLAS // 4, 0, ATLAS // 4, ATLAS // 4) for k in range(4)]
    for name, ext, x0, y0, cw, ch in cells:
        px = shoot(cols[name], ext, (cw, ch), tmp)
        npx = shoot(cols[name], ext, (cw, ch), tmp, nmat)
        atlas[y0:y0 + ch, x0:x0 + cw] = dilate(px)
        nn = npx.copy(); nn[..., 3] = 1
        nn[npx[..., 3] < 0.5, :3] = (0.5, 0.5, 1.0)
        natlas[y0:y0 + ch, x0:x0 + cw] = nn
        log('cell', name, 'coverage %.0f%%' % (100 * (px[..., 3] > 0.5).mean()))
    img = bpy.data.images.new('leaf_atlas', ATLAS, ATLAS, alpha=True)
    img.pixels.foreach_set(atlas.ravel())
    img.filepath_raw = os.path.join(OUT, 'leaf_atlas.png'); img.file_format = 'PNG'; img.save()
    nimg = bpy.data.images.new('leaf_atlas_n', ATLAS, ATLAS, alpha=False)
    nimg.colorspace_settings.name = 'Non-Color'
    nimg.pixels.foreach_set(natlas.ravel())
    nimg.filepath_raw = os.path.join(PREV, 'leaf_atlas_n.png'); nimg.file_format = 'PNG'; nimg.save()
    os.system('sips -s format jpeg -s formatOptions 90 "%s" --out "%s" >/dev/null' % (os.path.join(PREV, 'leaf_atlas_n.png'), os.path.join(OUT, 'leaf_atlas_n.jpg')))
    # preview on grey
    prev = atlas[..., :3] * atlas[..., 3:] + 0.5 * (1 - atlas[..., 3:])
    pimg = bpy.data.images.new('atlas preview', ATLAS, ATLAS)
    pimg.pixels.foreach_set(np.dstack([prev, np.ones((ATLAS, ATLAS, 1))]).astype(np.float32).ravel())
    pimg.filepath_raw = os.path.join(PREV, 'atlas_preview.png'); pimg.file_format = 'PNG'; pimg.save()
    os.remove(tmp)
    log('atlas written to', OUT)


main()
