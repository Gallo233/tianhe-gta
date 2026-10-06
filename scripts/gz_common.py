"""Shared Blender helpers for the Guangzhou generator (collections, materials, polygon meshes)."""
import math

import bmesh
import bpy
from mathutils import Vector

COL = None
MATS = {}


def collection(name, parent=None):
    global COL
    c = bpy.data.collections.get(name) or bpy.data.collections.new(name)
    if c.name not in (parent or bpy.context.scene.collection).children:
        (parent or bpy.context.scene.collection).children.link(c)
    COL = c
    return c


def mat(name, color, rough=0.6, metal=0.0, emission=0.0, emit_color=None, vcol=False, alpha=1.0):
    """Principled material. vcol: base colour = colour attribute 'tint' x color (per-building variation)."""
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bs = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Roughness'].default_value = rough
    bs.inputs['Metallic'].default_value = metal
    if emission:
        bs.inputs['Emission Color'].default_value = (*(emit_color or color), 1)
        bs.inputs['Emission Strength'].default_value = emission
    if alpha < 1:
        bs.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'
    if vcol:
        attr = nt.nodes.new('ShaderNodeVertexColor'); attr.layer_name = 'tint'
        mix = nt.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
        mix.inputs['Factor'].default_value = 1.0
        mix.inputs[6].default_value = (*color, 1)
        nt.links.new(attr.outputs['Color'], mix.inputs[7])
        nt.links.new(mix.outputs[2], bs.inputs['Base Color'])
    m.diffuse_color = (*color, 1)
    MATS[name] = m
    return m


def obj_from_bmesh(name, bm, material, col=None, smooth=False):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me); bm.free()
    if material:
        for m in (material if isinstance(material, (list, tuple)) else [material]):
            me.materials.append(m)
    # explicit either way: foreach_set meshes default to smooth in 5.x
    me.polygons.foreach_set('use_smooth', [smooth] * len(me.polygons))
    o = bpy.data.objects.new(name, me)
    (col or COL).objects.link(o)
    return o


def fill_polygon(bm, outer, holes, z, flip=False, uv=None, tint=None):
    """Triangulated flat polygon with holes at height z (outer CCW). Returns the new faces.
    uv: bmesh UV layer -> planar (x, y) in metres. tint: (layer, rgba) written to every corner."""
    edges = []
    for ring in [outer] + list(holes):
        vs = [bm.verts.new((p[0], p[1], z)) for p in ring]
        edges += [bm.edges.new((vs[i], vs[(i + 1) % len(vs)])) for i in range(len(vs))]
    res = bmesh.ops.triangle_fill(bm, use_beauty=True, use_dissolve=False, edges=edges)
    faces = [g for g in res['geom'] if isinstance(g, bmesh.types.BMFace)]
    for f in faces:
        f.normal_update()
        if (f.normal.z < 0) != flip:
            f.normal_flip()
        for lp in f.loops:
            if uv: lp[uv].uv = (lp.vert.co.x, lp.vert.co.y)
            if tint: lp[tint[0]] = tint[1]
    return faces


def clean_ring(ring, eps=0.05):
    """Drop consecutive duplicates (and a duplicated closing point); None if fewer than 3 points remain."""
    out = []
    for p in ring:
        if not out or abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) > eps:
            out.append((p[0], p[1]))
    while len(out) > 1 and abs(out[0][0] - out[-1][0]) + abs(out[0][1] - out[-1][1]) <= eps:
        out.pop()
    return out if len(out) >= 3 else None


def extrude_polygon(bm, outer, holes, z0, z1, top=True, bottom=False, uv=None, tint=None):
    """Walls (outward) and caps of a prism with holes, between z0 and z1. Returns the new faces.
    uv: wall UVs are (distance along the ring, z) in metres, caps (x, y) -- the facade shader's grid.
    Vertices are not shared between walls and caps (flat shading); weld() when a closed solid is needed."""
    faces = []
    for ring in [outer] + list(holes):
        n = len(ring)
        lo = [bm.verts.new((p[0], p[1], z0)) for p in ring]
        hi = [bm.verts.new((p[0], p[1], z1)) for p in ring]
        s = 0.0
        for i in range(n):
            j = (i + 1) % n
            seg = math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])
            # outer rings are CCW: (lo_i, lo_j, hi_j, hi_i) faces outward; holes are CW -> same order faces inward to the hole
            try:
                f = bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
            except ValueError:
                s += seg
                continue
            for lp, (u, v) in zip(f.loops, ((s, z0), (s + seg, z0), (s + seg, z1), (s, z1))):
                if uv: lp[uv].uv = (u, v)
                if tint: lp[tint[0]] = tint[1]
            faces.append(f)
            s += seg
    if top:
        faces += fill_polygon(bm, outer, holes, z1, uv=uv, tint=tint)
    if bottom:
        faces += fill_polygon(bm, outer, holes, z0, flip=True, uv=uv, tint=tint)
    return faces


def weld(bm, dist=0.001):
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=dist)


def strip(bm, pts, width, zfun, uv_scale=None):
    """A ribbon of `width` along a polyline (mitred joins, clamped), z from zfun(i, s). Returns faces."""
    n = len(pts)
    if n < 2:
        return []
    P = [Vector((p[0], p[1])) for p in pts]
    s = [0.0]
    for i in range(1, n):
        s.append(s[-1] + (P[i] - P[i - 1]).length)
    left, right = [], []
    for i in range(n):
        if i == 0: d = (P[1] - P[0])
        elif i == n - 1: d = (P[-1] - P[-2])
        else:
            a = (P[i] - P[i - 1]).normalized(); b = (P[i + 1] - P[i]).normalized()
            d = a + b if (a + b).length > 1e-6 else a
        d = d.normalized()
        nrm = Vector((-d.y, d.x))
        k = 1.0
        if 0 < i < n - 1:
            a = (P[i] - P[i - 1]).normalized()
            cosh = max(0.35, nrm.dot(Vector((-a.y, a.x))))
            k = 1 / cosh
        off = nrm * (width / 2 * k)
        z = zfun(i, s[i])
        left.append(bm.verts.new((P[i].x + off.x, P[i].y + off.y, z)))
        right.append(bm.verts.new((P[i].x - off.x, P[i].y - off.y, z)))
    faces = []
    for i in range(n - 1):
        try:
            faces.append(bm.faces.new((right[i], right[i + 1], left[i + 1], left[i])))
        except ValueError:
            pass
    return faces


def clip_rect(ring, x0, y0, x1, y1):
    """Sutherland-Hodgman clip of a polygon ring to an axis-aligned rectangle."""
    def clip(pts, inside, inter):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ia, ib = inside(a), inside(b)
            if ib:
                if not ia: out.append(inter(a, b))
                out.append(b)
            elif ia:
                out.append(inter(a, b))
        return out
    def ix(x):
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))
    def iy(y):
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)
    pts = list(ring)
    for inside, inter in [(lambda p: p[0] >= x0, ix(x0)), (lambda p: p[0] <= x1, ix(x1)),
                          (lambda p: p[1] >= y0, iy(y0)), (lambda p: p[1] <= y1, iy(y1))]:
        if not pts: break
        pts = clip(pts, inside, inter)
    return pts


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0))) if e1 != e0 else 1.0
    return t * t * (3 - 2 * t)


def hash01(i, salt=0):
    return ((int(i) * 2654435761 + salt * 97531) % 100003) / 100003.0


def ring_area(ring):
    return 0.5 * sum(ring[i][0] * ring[(i + 1) % len(ring)][1] - ring[(i + 1) % len(ring)][0] * ring[i][1] for i in range(len(ring)))
