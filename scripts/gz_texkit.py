"""Tiling texture sets baked from real high-poly patches (the lotus-pond rule: bake detail, don't simplify it).

    B="$HOME/Library/Application Support/Steam/steamapps/common/Blender/Blender.app/Contents/MacOS/Blender"
    "$B" --background --factory-startup --python guangzhou/scripts/gz_texkit.py -- [kit ...]

Each kit is a periodic patch of modelled geometry (stone slats, granite panels with joints, glazing frames)
Tu x Tv metres, surrounded by copies of itself so ambient occlusion wraps across the tile edges. A flat
low-poly plane above it receives the bakes (selected-to-active, Cycles):

    albedo    DIFFUSE colour pass (procedural speckle / tone variation included)
    normal    tangent space
    orm       R = ambient occlusion, G = roughness, B = metalness (glTF packing)
    emit      night-glow mask (lit windows / glass behind the skin), white = glows

Output: guangzhou/textures/kit/<kit>/*.png (lossless) and guangzhou/demo/public/assets/tex/<kit>_*.jpg,
plus kits.json with each kit's tile size in metres (landmarks write UVs as metres / tile size).
"""
import json
import math
import os
import random
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

GZ = Path(__file__).resolve().parents[1]
OUT_PNG = GZ / 'textures' / 'kit'
OUT_WEB = GZ / 'demo' / 'public' / 'assets' / 'tex'
RES = 2048


def log(*a):
    print('[texkit]', *a, flush=True)


# ------------------------------------------------------------------ scene / materials
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "METAL"            # the GPU alone; CPU + GPU is slower on this Air
        sc.cycles.device = 'GPU'
    except Exception as e:                        # CPU is fine, just slower
        log('GPU unavailable:', e)
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    w.light_settings.distance = 0.6          # AO reach: the depth of the relief, not the building
    sc.world = w
    return sc


def material(name, base, rough, metal=0.0, emit=0.0, speckle=0.0, speckle_scale=40.0, bump=0.0, bump_scale=300.0):
    """Principled material: base colour x the piece's tone (colour attribute) x granular speckle; `bump` adds a
    fine noise relief (flamed granite, sand in render) that the normal pass picks up."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    # per-object tone (object colour) x base colour x granular speckle
    oi = nt.nodes.new('ShaderNodeAttribute'); oi.attribute_name = 'tone'
    mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
    mix.inputs['Factor'].default_value = 1.0
    mix.inputs['A'].default_value = (*base, 1)
    nt.links.new(oi.outputs['Color'], mix.inputs['B'])
    col = mix.outputs['Result']
    if speckle > 0:
        tc = nt.nodes.new('ShaderNodeTexCoord')
        nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = speckle_scale
        nz.inputs['Detail'].default_value = 8.0
        nt.links.new(tc.outputs['Object'], nz.inputs['Vector'])
        ramp = nt.nodes.new('ShaderNodeMapRange')
        ramp.inputs['From Min'].default_value = 0.35; ramp.inputs['From Max'].default_value = 0.65
        ramp.inputs['To Min'].default_value = 1 - speckle; ramp.inputs['To Max'].default_value = 1 + speckle * 0.5
        nt.links.new(nz.outputs['Fac'], ramp.inputs['Value'])
        m2 = nt.nodes.new('ShaderNodeMix'); m2.data_type = 'RGBA'; m2.blend_type = 'MULTIPLY'
        m2.inputs['Factor'].default_value = 1.0
        nt.links.new(col, m2.inputs['A'])
        comb = nt.nodes.new('ShaderNodeCombineColor')
        for k in ('Red', 'Green', 'Blue'):
            nt.links.new(ramp.outputs['Result'], comb.inputs[k])
        nt.links.new(comb.outputs['Color'], m2.inputs['B'])
        col = m2.outputs['Result']
    nt.links.new(col, b.inputs['Base Color'])
    if bump > 0:
        tc2 = nt.nodes.new('ShaderNodeTexCoord')
        nz2 = nt.nodes.new('ShaderNodeTexNoise'); nz2.inputs['Scale'].default_value = bump_scale
        nz2.inputs['Detail'].default_value = 6.0; nz2.inputs['Roughness'].default_value = 0.7
        nt.links.new(tc2.outputs['Object'], nz2.inputs['Vector'])
        bn = nt.nodes.new('ShaderNodeBump'); bn.inputs['Strength'].default_value = 1.0
        bn.inputs['Distance'].default_value = bump
        nt.links.new(nz2.outputs['Fac'], bn.inputs['Height'])
        nt.links.new(bn.outputs['Normal'], b.inputs['Normal'])
    if emit > 0:
        b.inputs['Emission Color'].default_value = (1, 1, 1, 1)
        b.inputs['Emission Strength'].default_value = emit
    return m


class Patch:
    """Kit geometry merged into one mesh per material; per-piece tone in a colour attribute ('tone')."""

    def __init__(self, tu, tv):
        self.bms = {}
        self.meshes = []                          # ready meshes (heightfields)
        self.tu, self.tv = tu, tv

    def _clip(self, pts):
        """Clip a CCW polygon to the tile [0, tu] x [0, tv] (Sutherland-Hodgman). The 8 copies around the tile
        continue whatever is cut off here; geometry reaching past the edge would sit exactly on top of a
        copy, and a coincident surface occludes every AO ray (the black edge triangles of the first bakes)."""
        for axis, lim, keep_le in ((0, 0.0, False), (0, self.tu, True), (1, 0.0, False), (1, self.tv, True)):
            out = []
            n = len(pts)
            for i in range(n):
                a, b = pts[i], pts[(i + 1) % n]
                ina = a[axis] <= lim if keep_le else a[axis] >= lim
                inb = b[axis] <= lim if keep_le else b[axis] >= lim
                if ina:
                    out.append(a)
                if ina != inb:
                    t = (lim - a[axis]) / (b[axis] - a[axis])
                    out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            pts = out
            if len(pts) < 3:
                return []
        return pts

    def _bm(self, mat):
        if mat.name not in self.bms:
            bm = bmesh.new()
            bm.loops.layers.float_color.new('tone')
            self.bms[mat.name] = (bm, mat)
        return self.bms[mat.name][0]

    def prism(self, mat, pts, z0, z1, tone=1.0, bevel=0.0):
        """Vertical prism over a 2D polygon (pts CCW), from z0 to z1, clipped to the tile."""
        clipped = self._clip(pts)
        if len(clipped) < 3:
            return
        if len(clipped) != len(pts) or any(abs(a[0] - b[0]) + abs(a[1] - b[1]) > 1e-9 for a, b in zip(clipped, pts)):
            bevel = 0.0                           # a bevel along the cut would draw a line at the tile edge
        pts = clipped
        tmp = bmesh.new()
        bot = [tmp.verts.new((x, y, z0)) for x, y in pts]
        top = [tmp.verts.new((x, y, z1)) for x, y in pts]
        tmp.faces.new(top)
        n = len(pts)
        for i in range(n):
            tmp.faces.new((bot[i], bot[(i + 1) % n], top[(i + 1) % n], top[i]))
        if bevel > 0:
            bmesh.ops.bevel(tmp, geom=[e for e in tmp.edges if all(v.co.z > z0 + 1e-4 for v in e.verts)],
                            offset=bevel, segments=1, affect='EDGES')
        bm = self._bm(mat)
        lay = bm.loops.layers.float_color['tone']
        t = tone if isinstance(tone, tuple) else (tone, tone, tone)
        vmap = {v: bm.verts.new(v.co) for v in tmp.verts}
        for f in tmp.faces:
            nf = bm.faces.new([vmap[v] for v in f.verts])
            for loop in nf.loops:
                loop[lay] = (*t, 1.0)
        tmp.free()

    def field(self, mat, z, tone, z0=0.0):
        """A heightfield over the whole tile from periodic arrays z (metres) and tone (n x n): one quad per cell, the
        last row / column wrapping to the first so the 8 copies around the tile meet it seamlessly. Built straight
        from numpy (a million faces through bmesh would take minutes)."""
        n = z.shape[0]
        ii, jj = np.meshgrid(np.arange(n + 1), np.arange(n + 1))
        co = np.stack([ii * self.tu / n, jj * self.tv / n, z0 + z[jj % n, ii % n]], -1).reshape(-1, 3).astype(np.float32)
        q = np.arange((n + 1) * (n + 1)).reshape(n + 1, n + 1)
        quads = np.stack([q[:-1, :-1], q[:-1, 1:], q[1:, 1:], q[1:, :-1]], -1).reshape(-1, 4)
        me = bpy.data.meshes.new(mat.name + ' field')
        me.vertices.add(len(co)); me.vertices.foreach_set('co', co.ravel())
        me.loops.add(quads.size); me.loops.foreach_set('vertex_index', quads.ravel().astype(np.int32))
        me.polygons.add(len(quads))
        me.polygons.foreach_set('loop_start', np.arange(0, quads.size, 4, dtype=np.int32))
        me.polygons.foreach_set('loop_total', np.full(len(quads), 4, dtype=np.int32))
        me.update(calc_edges=True)
        tv = tone[jj % n, ii % n].ravel()[quads.ravel()]
        col = me.color_attributes.new('tone', 'FLOAT_COLOR', 'CORNER')
        rgba = np.ones((quads.size, 4), dtype=np.float32); rgba[:, 0] = rgba[:, 1] = rgba[:, 2] = tv
        col.data.foreach_set('color', rgba.ravel())
        me.materials.append(mat)
        self.meshes.append(me)

    def blade(self, mat, base, tip, w, tone):
        """A grass blade: one thin triangle from base (x, y, z) to tip, w wide at the root (only if its root is
        inside the tile; neighbours come from the copies)."""
        if not (0 <= base[0] < self.tu and 0 <= base[1] < self.tv):
            return
        bm = self._bm(mat)
        lay = bm.loops.layers.float_color['tone']
        dx, dy = tip[0] - base[0], tip[1] - base[1]
        L = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / L * w / 2, dx / L * w / 2
        if L < 1e-3:
            nx, ny = w / 2, 0.0
        pa, pb = (base[0] - nx, base[1] - ny, base[2]), (base[0] + nx, base[1] + ny, base[2])
        # wind the triangle so its normal points up: a single-sided blade facing down bakes a normal into the ground
        ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
        vx, vy, vz = tip[0] - pa[0], tip[1] - pa[1], tip[2] - pa[2]
        if ux * vy - uy * vx < 0:
            pa, pb = pb, pa
        a = bm.verts.new(pa); b = bm.verts.new(pb)
        c = bm.verts.new(tip)
        f = bm.faces.new((a, b, c))
        t = tone if isinstance(tone, tuple) else (tone, tone, tone)
        for loop in f.loops:
            loop[lay] = (*t, 1.0)

    def slab(self, mat, x0, y0, x1, y1, z0, z1, tone=1.0, bevel=0.0):
        self.prism(mat, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1, tone, bevel)

    def tile(self, tu, tv):
        """One object per material for the tile, plus 8 linked copies around it so occlusion wraps.
        Returns the centre objects (the bake sources)."""
        centre = []
        made = []
        for bm, mat in self.bms.values():
            me = bpy.data.meshes.new(mat.name)
            bm.to_mesh(me); bm.free()
            me.materials.append(mat)
            made.append(me)
        for me in made + self.meshes:
            mat = me.materials[0]
            o = bpy.data.objects.new(mat.name, me)
            bpy.context.scene.collection.objects.link(o)
            centre.append(o)
            for du in (-1, 0, 1):
                for dv in (-1, 0, 1):
                    if du or dv:
                        c = bpy.data.objects.new(mat.name + ' copy', me)
                        c.location = (du * tu, dv * tv, 0)
                        bpy.context.scene.collection.objects.link(c)
        return centre, None


# ------------------------------------------------------------------ bake
def bake_kit(name, tu, tv, centre, top_z, metal_from_emit=0.0, res=RES, emit=True):
    global RES
    RES = res
    sc = bpy.context.scene
    me = bpy.data.meshes.new('target')
    bm = bmesh.new()
    vs = [bm.verts.new(p) for p in ((0, 0, top_z), (tu, 0, top_z), (tu, tv, top_z), (0, tv, top_z))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new('UVMap')
    for loop in f.loops:
        loop[uv].uv = (loop.vert.co.x / tu, loop.vert.co.y / tv)
    bm.to_mesh(me); bm.free()
    target = bpy.data.objects.new('target', me)
    sc.collection.objects.link(target)
    tm = bpy.data.materials.new('target')
    tm.use_nodes = True
    me.materials.append(tm)
    node = tm.node_tree.nodes.new('ShaderNodeTexImage')
    tm.node_tree.nodes.active = node
    out = {}
    mats = [m for m in bpy.data.materials if m.use_nodes and 'Principled BSDF' in m.node_tree.nodes and m.name != 'target']
    bsdf = {m.name: m.node_tree.nodes['Principled BSDF'] for m in mats}
    metal = {k: b.inputs['Metallic'].default_value for k, b in bsdf.items()}
    emis = {k: (tuple(b.inputs['Emission Color'].default_value), b.inputs['Emission Strength'].default_value) for k, b in bsdf.items()}

    def set_state(tag):
        """albedo: Cycles' diffuse colour is base x (1 - metallic), so metals bake black unless zeroed;
        metal: every material emits its metallic value, baked through the EMIT pass."""
        for k, b in bsdf.items():
            b.inputs['Metallic'].default_value = 0.0 if tag == 'albedo' else metal[k]
            if tag == 'metal':
                b.inputs['Emission Color'].default_value = (metal[k], metal[k], metal[k], 1.0)
                b.inputs['Emission Strength'].default_value = 1.0
            else:
                b.inputs['Emission Color'].default_value = emis[k][0]
                b.inputs['Emission Strength'].default_value = emis[k][1]

    passes = [('albedo', 'DIFFUSE', {'COLOR'}, 16, False), ('normal', 'NORMAL', None, 16, True),
              ('ao', 'AO', None, 128, True), ('rough', 'ROUGHNESS', None, 8, True), ('emit', 'EMIT', None, 8, True),
              ('metal', 'EMIT', None, 8, True)]
    for tag, kind, filt, samples, non_color in passes:
        set_state(tag)
        img = bpy.data.images.new(f'{name}_{tag}', RES, RES, alpha=False, float_buffer=False)
        if non_color:
            img.colorspace_settings.name = 'Non-Color'
        node.image = img
        sc.cycles.samples = samples
        bpy.ops.object.select_all(action='DESELECT')
        for o in centre:
            o.select_set(True)
        target.select_set(True)
        bpy.context.view_layer.objects.active = target
        kw = dict(type=kind, use_selected_to_active=True, cage_extrusion=0.02, max_ray_distance=top_z + 1.0, margin=0,
                  use_clear=True)
        if filt:
            kw['pass_filter'] = filt
        if kind == 'NORMAL':
            kw['normal_space'] = 'TANGENT'
        bpy.ops.object.bake(**kw)
        out[tag] = img
        log(name, tag, 'baked')
    set_state('emit')
    d = OUT_PNG / name
    d.mkdir(parents=True, exist_ok=True)
    OUT_WEB.mkdir(parents=True, exist_ok=True)

    def px(img):
        a = np.empty(RES * RES * 4, dtype=np.float32)
        img.pixels.foreach_get(a)
        return a.reshape(RES, RES, 4)

    ao, rough = px(out['ao']), px(out['rough'])
    orm = np.ones((RES, RES, 4), dtype=np.float32)
    orm[..., 0] = ao[..., 0]
    orm[..., 1] = rough[..., 0]
    em, mt = px(out['emit']), px(out['metal'])
    orm[..., 2] = np.maximum(mt[..., 0], em[..., 0] * metal_from_emit)   # glass behind a frame reads as reflective
    oimg = bpy.data.images.new(f'{name}_orm', RES, RES, alpha=False)
    oimg.colorspace_settings.name = 'Non-Color'
    oimg.pixels.foreach_set(orm.ravel())
    out['orm'] = oimg
    sc.render.image_settings.quality = 90
    alb = px(out['albedo'])
    # byte images hand back their sRGB-encoded values: the web samples linear, so the mean must be linear too
    lin = np.where(alb[..., :3] <= 0.04045, alb[..., :3] / 12.92, ((alb[..., :3] + 0.055) / 1.055) ** 2.4)
    mean = [round(float(lin[..., c].mean()), 4) for c in range(3)]
    tags = ('albedo', 'normal', 'orm', 'emit') if emit else ('albedo', 'normal', 'orm')
    for tag in tags:
        img = out[tag]
        img.filepath_raw = str(d / f'{tag}.png'); img.file_format = 'PNG'; img.save()
        img.filepath_raw = str(OUT_WEB / f'{name}_{tag}.jpg'); img.file_format = 'JPEG'
        img.save(quality=92 if tag == 'normal' else 88)
    return {'tile_m': [tu, tv], 'mean': mean, 'res': res, 'files': {t: f'assets/tex/{name}_{t}.jpg' for t in tags}}


# ------------------------------------------------------------------ periodic noise (numpy)
def pnoise(n, cells, seed):
    """Smooth value noise on an n x n grid that wraps (cells lattice points across), range ~0..1."""
    r = np.random.default_rng(seed)
    lat = r.random((cells, cells))
    x = np.arange(n) / n * cells
    i0 = np.floor(x).astype(int); f = x - i0; f = f * f * (3 - 2 * f)
    i1 = (i0 + 1) % cells; i0 %= cells
    a = lat[np.ix_(i0, i0)]; b = lat[np.ix_(i0, i1)]; c = lat[np.ix_(i1, i0)]; d = lat[np.ix_(i1, i1)]
    fy, fx = f[:, None], f[None, :]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def pfbm(n, cells, seed, octaves=5):
    s, a, tot = np.zeros((n, n)), 0.5, 0.0
    for k in range(octaves):
        c = cells * 2 ** k
        if c > n // 2:
            break
        s += a * pnoise(n, c, seed + k * 17); tot += a; a *= 0.5
    return s / tot


def stones(n, size_m, count, rmin, rmax, seed, tile_m):
    """Aggregate: `count` rounded stones (radius rmin..rmax m) splatted into a wrapping n x n height map over a
    tile_m square. Returns (height, stone id map for tones, -1 = binder)."""
    r = np.random.default_rng(seed)
    h = np.zeros((n, n)); ident = -np.ones((n, n), dtype=np.int32)
    px = tile_m / n
    cx = r.random(count) * n; cy = r.random(count) * n
    rad = r.uniform(rmin, rmax, count) / px
    flat = r.uniform(0.35, 0.7, count)
    for k in range(count):
        R = rad[k]; w = int(math.ceil(R)) + 1
        xs = np.arange(int(cx[k]) - w, int(cx[k]) + w + 1); ys = np.arange(int(cy[k]) - w, int(cy[k]) + w + 1)
        dx = (xs[None, :] - cx[k]) / R; dy = (ys[:, None] - cy[k]) / R
        d2 = dx * dx + dy * dy
        bump = np.sqrt(np.clip(1 - d2, 0, None)) * R * px * flat[k]
        sub = np.ix_(ys % n, xs % n)
        cur = h[sub]
        take = bump > cur
        h[sub] = np.where(take, bump, cur)
        ident[sub] = np.where(take & (bump > 0), k, ident[sub])
    return h, ident


# ------------------------------------------------------------------ kits
def kit_library_louver(rng):
    """Guangzhou Library skin: courses of pale stone slats of random length, 'pages of a book', over dark
    glazing; some gaps are windows (lit at night). 12 x 12 m, u along the facade, v up."""
    TU = TV = 12.0
    p = Patch(TU, TV)
    stone = material('stone', (0.74, 0.71, 0.65), 0.72, speckle=0.12, speckle_scale=90)
    stone_dark = material('stone dark', (0.58, 0.56, 0.52), 0.75, speckle=0.12, speckle_scale=90)
    back = material('back', (0.05, 0.055, 0.06), 0.25)
    win = material('window', (0.06, 0.07, 0.08), 0.08, emit=1.0)
    # the dark wall / glazing behind everything
    p.slab(back, -0.5, -0.5, TU + 0.5, TV + 0.5, -0.30, -0.25)
    rows, y = [], 0.0
    while y < TV - 0.2:
        h = rng.choice((0.30, 0.30, 0.45, 0.45, 0.60))
        rows.append([y, min(h, TV - y)]); y += h
    rows[-1][1] = TV - rows[-1][0]
    for y0, h in rows:
        # a course of slats, scaled to close exactly at TU and rotated by a random phase so the courses'
        # joints never line up at the tile edge
        x, pieces = 0.0, []
        while x < TU:
            L = rng.uniform(0.8, 4.6)
            g = rng.choice((0.04, 0.06, 0.08, 0.12, 0.2)) if rng.random() < 0.92 else rng.uniform(0.6, 1.4)
            pieces.append((x, L, g)); x += L + g
        scale = TU / x
        phase = rng.uniform(0, TU)
        for x0, L, g in pieces:
            a, b = x0 * scale + phase, (x0 + L) * scale + phase
            depth = rng.choice((0.08, 0.14, 0.22, 0.3))
            tone = rng.uniform(0.9, 1.08)
            m = stone_dark if rng.random() < 0.18 else stone
            for off in (0.0, -TU, -2 * TU):     # wrap round the tile
                aa, bb = a + off, b + off
                if bb < 0 or aa > TU:
                    continue
                p.slab(m, aa, y0 + 0.02, bb, y0 + h - 0.02, -0.25, depth - 0.25, tone, bevel=0.012)
            gap0, gap1 = b, (x0 + L + g) * scale + phase
            if gap1 - gap0 > 0.4 and rng.random() < 0.6:
                for off in (0.0, -TU, -2 * TU):
                    if gap1 + off < 0 or gap0 + off > TU:
                        continue
                    p.slab(win, gap0 + off, y0 + 0.04, gap1 + off, y0 + h - 0.04, -0.27, -0.255)
    centre, _ = p.tile(TU, TV)
    return TU, TV, centre, 0.2


def kit_opera_granite(rng):
    """Guangzhou Opera House stone: equilateral triangular granite panels (1.5 m) with 12 mm joints,
    pale grey with a granular speckle, each panel a hair out of plane. 12 x 12.99 m (8 panels x 10 rows)."""
    A = 1.5
    H = A * math.sqrt(3) / 2
    TU, TV = 8 * A, 10 * H
    p = Patch(TU, TV)
    g1 = material('granite', (0.80, 0.80, 0.78), 0.55, speckle=0.18, speckle_scale=160)
    joint = material('joint', (0.25, 0.25, 0.25), 0.9)
    p.slab(joint, -0.5, -0.5, TU + 0.5, TV + 0.5, -0.06, -0.04)
    J = 0.006
    for r in range(10):
        y0 = r * H
        for k in range(-1, 17):
            up = (k + r) % 2 == 0
            x0 = (k * A) / 2
            # counter-clockwise: an upright triangle on the row's base line, or an inverted one hanging from its top
            tri = [(x0, y0), (x0 + A, y0), (x0 + A / 2, y0 + H)] if up else [(x0 + A / 2, y0), (x0 + A, y0 + H), (x0, y0 + H)]
            cx = sum(q[0] for q in tri) / 3; cy = sum(q[1] for q in tri) / 3
            s = 1 - J * 2 / (A * 0.29)
            tri = [(cx + (q[0] - cx) * s, cy + (q[1] - cy) * s) for q in tri]
            if max(q[0] for q in tri) < -0.2 or min(q[0] for q in tri) > TU + 0.2:
                continue
            tone = rng.uniform(0.93, 1.05)
            dz = rng.uniform(-0.004, 0.004)
            p.prism(g1, tri, -0.04, 0.0 + dz, tone, bevel=0.004)
    centre, _ = p.tile(TU, TV)
    return TU, TV, centre, 0.1


def kit_opera_glass(rng):
    """Opera House glazing: triangulated steel lattice (2.4 m triangles), 120 mm white-grey frames 250 mm
    deep over dark glass (lit foyer behind at night). 9.6 x 12.47 m (8 x 6 rows)."""
    A = 2.4
    H = A * math.sqrt(3) / 2
    TU, TV = 4 * A, 6 * H
    p = Patch(TU, TV)
    glass = material('glass', (0.12, 0.14, 0.15), 0.06, metal=0.0, emit=1.0)          # lit foyer behind it
    steel = material('steel', (0.82, 0.83, 0.82), 0.35, metal=0.6)
    p.slab(glass, -0.5, -0.5, TU + 0.5, TV + 0.5, -0.27, -0.25)
    W = 0.06
    # three families of lines: horizontals and the two diagonals
    for r in range(-1, 8):
        y = r * H
        p.slab(steel, -0.6, y - W, TU + 0.6, y + W, -0.25, 0.0, 1.0, bevel=0.01)
    # the two diagonal families through (k A, 0) at 60 and 120 degrees; a 60-degree line climbs 3 A in x per
    # tile height, so the lattice repeats in both directions
    for th in (math.radians(60), math.radians(120)):
        dx, dy = math.cos(th), math.sin(th)
        nx, ny = -dy, dx
        L = (TV + 2) / dy
        for k in range(-6, 11):
            x0, y0 = k * A - dx, -dy                       # start 1 m below the tile along the line
            x1, y1 = x0 + dx * L, y0 + dy * L
            pts = [(x0 - nx * W, y0 - ny * W), (x1 - nx * W, y1 - ny * W), (x1 + nx * W, y1 + ny * W), (x0 + nx * W, y0 + ny * W)]
            p.prism(steel, pts, -0.25, -0.01, 1.0)
    centre, _ = p.tile(TU, TV)
    return TU, TV, centre, 0.1


def kit_museum_tile(rng):
    """Guangdong Museum skin: charcoal stone panels 1.2 x 0.6 m, stack-bonded, 8 mm joints, subtle tone
    variation and flatness error. 9.6 x 9.6 m."""
    TU = TV = 9.6
    p = Patch(TU, TV)
    t = material('tile', (0.12, 0.12, 0.12), 0.82, speckle=0.12, speckle_scale=70)       # matte charcoal stone
    joint = material('joint', (0.12, 0.12, 0.12), 0.9)
    p.slab(joint, -0.5, -0.5, TU + 0.5, TV + 0.5, -0.05, -0.03)
    for i in range(8):
        for j in range(16):
            x0, y0 = i * 1.2 + 0.004, j * 0.6 + 0.004
            p.slab(t, x0, y0, x0 + 1.192, y0 + 0.592, -0.04, rng.uniform(-0.002, 0.002), rng.uniform(0.9, 1.08), bevel=0.003)
    centre, _ = p.tile(TU, TV)
    return TU, TV, centre, 0.1


def kit_metal_ribs(rng):
    """Children's Palace skin: horizontal aluminium ribs (rounded, 60 mm, 120 mm pitch) over a darker backing,
    the odd rib a touch off-tone. 4.8 x 4.8 m."""
    TU = TV = 4.8
    p = Patch(TU, TV)
    rib = material('rib', (0.74, 0.75, 0.76), 0.4, metal=0.45)          # anodised, reads light silver in photos
    back = material('back', (0.22, 0.23, 0.24), 0.6, metal=0.2)
    p.slab(back, 0, 0, TU, TV, -0.08, -0.06)
    y = 0.0
    while y < TV - 1e-6:
        tone = rng.uniform(0.94, 1.04)
        # a rib: a flat bar with rounded front (three stacked slabs approximate the round)
        for dy0, dy1, z1 in ((0.0, 0.06, -0.03), (0.01, 0.05, -0.01), (0.02, 0.04, 0.0)):
            p.slab(rib, 0, y + dy0, TU, y + dy1, -0.06, z1, tone)
        y += 0.12
    centre, _ = p.tile(TU, TV)
    return TU, TV, centre, 0.05


# ------------------------------------------------------------------ city kits (ordinary buildings and streets)
# Neutral in colour: the web shader divides each by its mean and multiplies the building's / road's own colour in,
# so one set serves every palette. Photos: 珠江新城 / 车陂 pavements 2024 (flamed grey granite slabs, light and dark;
# grey-red pavers), Tianhe residential towers (small glazed tiles), urban-village render.
def kit_city_asphalt(rng):
    """Asphalt, 2 x 2 m: aggregate stones (2.5-8 mm) in a black binder, the stones a range of greys, the odd pale
    quartz; worn flat on top. Heightfield 1024^2 (2 mm)."""
    T = 2.0
    p = Patch(T, T)
    n = 1024
    h, ident = stones(n, T, 17000, 0.0025, 0.008, 11, T)
    r = np.random.default_rng(5)
    st_tone = r.uniform(1.9, 3.6, 17000) * np.where(r.random(17000) < 0.05, 1.6, 1.0)
    tone = np.where(ident >= 0, st_tone[np.clip(ident, 0, None)], 1.0)
    tone *= 0.85 + 0.3 * pfbm(n, 8, 3)
    h = np.minimum(h, 0.0035) + pfbm(n, 16, 7) * 0.0012           # traffic grinds the tops flat
    p.field(material('asphalt', (0.05, 0.05, 0.05), 0.88), h, tone)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_city_slab(rng):
    """Pavement granite, 2.4 x 2.4 m: flamed slabs 600 x 300 in running bond, 4 mm joints, light and dark grey
    slabs as on the 珠江新城 pavements, each a hair out of level, chamfered edges."""
    T = 2.4
    p = Patch(T, T)
    g = material('granite', (0.5, 0.5, 0.49), 0.82, speckle=0.3, speckle_scale=420, bump=0.0012, bump_scale=260)
    joint = material('joint', (0.18, 0.18, 0.17), 0.95)
    p.slab(joint, -0.1, -0.1, T + 0.1, T + 0.1, -0.05, -0.004)
    J = 0.002
    for j in range(8):
        off = 0.3 if j % 2 else 0.0
        for i in range(-1, 5):
            x0 = i * 0.6 + off
            dark = rng.random() < 0.3
            tone = rng.uniform(0.66, 0.74) if dark else rng.uniform(0.94, 1.08)
            p.slab(g, x0 + J, j * 0.3 + J, x0 + 0.6 - J, j * 0.3 + 0.3 - J, -0.05, rng.uniform(-0.0012, 0.0012), tone, bevel=0.002)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_city_brick(rng):
    """Footway pavers, 2.4 x 2.4 m: 200 x 100 concrete / clay pavers in running bond along the walk, 3 mm sanded
    joints, 4 mm chamfers, tones from greyish to warm."""
    T = 2.4
    p = Patch(T, T)
    b = material('paver', (0.5, 0.5, 0.5), 0.86, speckle=0.18, speckle_scale=300, bump=0.0008, bump_scale=400)
    sand = material('sand', (0.42, 0.40, 0.36), 0.95, speckle=0.3, speckle_scale=900)
    p.slab(sand, -0.1, -0.1, T + 0.1, T + 0.1, -0.06, -0.006)
    J = 0.0015
    for j in range(24):
        off = 0.1 if j % 2 else 0.0
        for i in range(-1, 13):
            x0 = i * 0.2 + off
            k = rng.uniform(0.78, 1.16)
            warm = rng.uniform(0.0, 0.09)
            p.slab(b, x0 + J, j * 0.1 + J, x0 + 0.2 - J, j * 0.1 + 0.1 - J, -0.06, rng.uniform(-0.001, 0.001),
                   (k * (1 + warm), k, k * (1 - warm)), bevel=0.004)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_city_grass(rng):
    """Lawn, 2 x 2 m: mossy soil under ~70 000 blades (3.5-8 cm, leaning every way), greens from blue-green to
    straw."""
    T = 2.0
    p = Patch(T, T)
    n = 256
    soil_h = pfbm(n, 8, 21) * 0.01
    p.field(material('soil', (0.07, 0.08, 0.04), 0.95), soil_h, 0.8 + 0.4 * pfbm(n, 16, 22))   # moss and thatch, not bare earth
    blade = material('blade', (0.16, 0.28, 0.08), 0.8)
    for _ in range(70000):
        x, y = rng.random() * T, rng.random() * T
        L = rng.uniform(0.035, 0.08)
        a = rng.random() * math.tau
        lean = rng.uniform(0.25, 0.85)
        base = (x, y, 0.004)
        tip = (x + math.cos(a) * L * lean, y + math.sin(a) * L * lean, 0.004 + L * math.sqrt(1 - lean * lean))
        k = rng.random()
        tone = (1.0, 1.0, 1.0) if k < 0.7 else (1.25, 1.15, 0.7) if k < 0.88 else (0.8, 1.05, 1.2)
        tone = tuple(t * rng.uniform(0.75, 1.2) for t in tone)
        p.blade(blade, base, tip, rng.uniform(0.004, 0.007), tone)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.12


def kit_wall_mosaic(rng):
    """Residential tile, 1.8 x 1.8 m: glazed 95 x 45 mm tiles in running bond, 5 mm recessed grout, a slight
    pillow on each tile, the odd tile off-tone (repairs)."""
    T = 1.8
    p = Patch(T, T)
    t = material('tile', (0.7, 0.7, 0.68), 0.32, speckle=0.05, speckle_scale=200)
    grout = material('grout', (0.42, 0.41, 0.39), 0.95, speckle=0.2, speckle_scale=700)
    p.slab(grout, -0.1, -0.1, T + 0.1, T + 0.1, -0.02, -0.003)
    for j in range(36):
        off = 0.05 if j % 2 else 0.0
        for i in range(-1, 19):
            x0 = i * 0.1 + off
            tone = rng.uniform(0.95, 1.05) if rng.random() > 0.03 else rng.uniform(0.8, 0.9)
            p.slab(t, x0 + 0.0025, j * 0.05 + 0.0025, x0 + 0.0975, j * 0.05 + 0.0475, -0.02, rng.uniform(-0.0003, 0.0003), tone, bevel=0.0015)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.01


def kit_wall_stone(rng):
    """Office granite cladding, 4.8 x 4.8 m: flamed panels 1200 x 600, 8 mm joints, stack bond, tone per panel."""
    T = 4.8
    p = Patch(T, T)
    g = material('granite', (0.55, 0.54, 0.52), 0.72, speckle=0.25, speckle_scale=260, bump=0.001, bump_scale=200)
    joint = material('joint', (0.2, 0.2, 0.2), 0.9)
    p.slab(joint, -0.1, -0.1, T + 0.1, T + 0.1, -0.04, -0.01)
    for j in range(8):
        for i in range(4):
            x0, y0 = i * 1.2 + 0.004, j * 0.6 + 0.004
            p.slab(g, x0, y0, x0 + 1.192, y0 + 0.592, -0.04, rng.uniform(-0.0015, 0.0015), rng.uniform(0.9, 1.1), bevel=0.003)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_wall_render(rng):
    """Render / painted concrete (urban village, civic), 4 x 4 m: wavy hand-trowelled surface, blotchy repainted
    areas with ragged edges, rain-darkened patches, fine sand."""
    T = 4.0
    p = Patch(T, T)
    n = 512
    h = pfbm(n, 5, 31) * 0.005 + pfbm(n, 48, 32, octaves=3) * 0.0015
    tone = 0.92 + 0.16 * pfbm(n, 6, 33)
    # repaints: a threshold on low-frequency noise, edges ragged by a finer one
    rp = pfbm(n, 4, 34) + 0.25 * pfbm(n, 32, 35)
    m = np.clip((rp - 0.62) / 0.03, 0, 1)
    tone *= 1 + 0.09 * m
    h += m * 0.0006
    # weathered blotches, a little darker
    wb = np.clip((pfbm(n, 10, 36) - 0.6) / 0.08, 0, 1)
    tone *= 1 - 0.1 * wb
    p.field(material('render', (0.62, 0.6, 0.57), 0.88, bump=0.0012, bump_scale=900), h, tone)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_wall_panel(rng):
    """Aluminium composite panels (spandrels, podiums, sheds), 6 x 6 m: 1500 x 750 panels, 15 mm open joints,
    each panel a touch off-tone and off-plane."""
    T = 6.0
    p = Patch(T, T)
    pan = material('panel', (0.62, 0.63, 0.64), 0.42, metal=0.5)
    back = material('back', (0.05, 0.05, 0.05), 0.8)
    p.slab(back, -0.1, -0.1, T + 0.1, T + 0.1, -0.05, -0.03)
    for j in range(8):
        for i in range(4):
            x0, y0 = i * 1.5 + 0.0075, j * 0.75 + 0.0075
            p.slab(pan, x0, y0, x0 + 1.485, y0 + 0.735, -0.03, rng.uniform(-0.001, 0.001), rng.uniform(0.95, 1.05), bevel=0.004)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


def kit_roof_paver(rng):
    """Flat-roof insulation pavers (隔热砖), 4 x 4 m: 500 x 500 concrete pavers on pedestals, 10 mm open joints,
    each a touch off level, chamfered; weathered tones, a few newer replacements, dark stains and moss spreading from
    the joints in damp areas."""
    T = 4.0
    p = Patch(T, T)
    pv = material('paver', (0.55, 0.54, 0.51), 0.9, speckle=0.3, speckle_scale=500, bump=0.0015, bump_scale=300)
    gap = material('gap', (0.08, 0.08, 0.07), 0.95)
    p.slab(gap, -0.1, -0.1, T + 0.1, T + 0.1, -0.06, -0.03)
    damp = pnoise(8, 3, 41)
    for j in range(8):
        for i in range(8):
            x0, y0 = i * 0.5 + 0.005, j * 0.5 + 0.005
            new = rng.random() < 0.06
            wet = damp[j, i]
            tone = (rng.uniform(1.08, 1.18) if new else rng.uniform(0.82, 1.02)) * (1 - 0.25 * max(0.0, wet - 0.55))
            t = (tone, tone * (1 + 0.04 * wet), tone * (1 - 0.06 * wet))
            p.slab(pv, x0, y0, x0 + 0.49, y0 + 0.49, -0.04, rng.uniform(-0.003, 0.003), t, bevel=0.006)
    centre, _ = p.tile(T, T)
    return T, T, centre, 0.02


CITY = {  # kit -> bake resolution
    'roof_paver': 1024,
    'city_asphalt': 2048, 'city_slab': 2048, 'city_brick': 2048, 'city_grass': 1024,
    'wall_mosaic': 1024, 'wall_stone': 1024, 'wall_render': 1024, 'wall_panel': 1024,
}

KITS = {
    'roof_paver': kit_roof_paver,
    'city_asphalt': kit_city_asphalt, 'city_slab': kit_city_slab, 'city_brick': kit_city_brick, 'city_grass': kit_city_grass,
    'wall_mosaic': kit_wall_mosaic, 'wall_stone': kit_wall_stone, 'wall_render': kit_wall_render, 'wall_panel': kit_wall_panel,
    'metal_ribs': kit_metal_ribs,
    'library_louver': kit_library_louver,
    'opera_granite': kit_opera_granite,
    'opera_glass': kit_opera_glass,
    'museum_tile': kit_museum_tile,
}


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = [a for a in args if a in KITS] or list(KITS)
    man_path = OUT_WEB / 'kits.json'
    man = json.loads(man_path.read_text()) if man_path.exists() else {}
    for name in names:
        sc = reset()
        if name == 'city_grass':
            sc.world.light_settings.distance = 0.03     # between the blades, not under a 0.6 m dome of them
        rng = random.Random(sum(ord(ch) * (i + 1) for i, ch in enumerate(name)))
        tu, tv, centre, top = KITS[name](rng)
        man[name] = bake_kit(name, tu, tv, centre, top, metal_from_emit=0.45 if name == 'opera_glass' else 0.0,
                             res=CITY.get(name, 2048), emit=name not in CITY)
        log('DONE', name, man[name]['tile_m'])
    OUT_WEB.mkdir(parents=True, exist_ok=True)
    man_path.write_text(json.dumps(man, indent=1))
    (GZ / 'textures' / 'kit' / 'kits.json').write_text(json.dumps(man, indent=1))


main()
