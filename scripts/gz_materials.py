"""Tianhe materials. Facades are one procedural shader driven by metre UVs (u = distance along the footprint
ring, v = height), so window grids line up with real floors and bays at any building size, and each window
cell has a stable random value used for night lighting (M4) and panel variation.

Every material name starts with `GZ ` and a family word (Facade/Road/Ground/Water/Tree...) so the web demo's
SurfaceDetail rules can match them by regex later.
"""
import json

import bpy

import gz_look

MATS = {}
WINDOW_GAIN = 0.45   # global night window brightness (lit_k values below are relative)
LAMP_SP = 30.0       # street lamp spacing (gz_city.LAMP_SP)


class NB:
    """Tiny node-building helper: sockets or plain numbers/tuples can be passed wherever an input is expected."""

    def __init__(self, m):
        m.use_nodes = True
        self.nt = m.node_tree
        self.nt.nodes.clear()

    def node(self, typ, **props):
        n = self.nt.nodes.new(typ)
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def put(self, sock, val):
        if isinstance(val, bpy.types.NodeSocket):
            self.nt.links.new(val, sock)
        elif isinstance(val, (tuple, list)) and len(val) == 3 and sock.type == 'RGBA':
            sock.default_value = (*val, 1)
        else:
            sock.default_value = val

    def math(self, op, a, b=0.0, c=None):
        n = self.node('ShaderNodeMath', operation=op)
        self.put(n.inputs[0], a); self.put(n.inputs[1], b)
        if c is not None: self.put(n.inputs[2], c)
        return n.outputs[0]

    def _mix(self, kind, fac, a, b, blend='MIX'):
        n = self.node('ShaderNodeMix', data_type=kind, blend_type=blend)
        t = {'RGBA': 'RGBA', 'FLOAT': 'VALUE', 'VECTOR': 'VECTOR'}[kind]
        self.put(next(s for s in n.inputs if s.name == 'Factor' and s.type == 'VALUE'), fac)
        self.put(next(s for s in n.inputs if s.name == 'A' and s.type == t), a)
        self.put(next(s for s in n.inputs if s.name == 'B' and s.type == t), b)
        return next(s for s in n.outputs if s.type == t)

    def mixc(self, fac, a, b, blend='MIX'):
        return self._mix('RGBA', fac, a, b, blend)

    def mixf(self, fac, a, b):
        return self._mix('FLOAT', fac, a, b)

    def sep(self, vec):
        n = self.node('ShaderNodeSeparateXYZ'); self.put(n.inputs[0], vec)
        return n.outputs['X'], n.outputs['Y'], n.outputs['Z']

    def comb(self, x, y, z):
        n = self.node('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)): self.put(n.inputs[i], v)
        return n.outputs[0]

    def between(self, x, lo, hi):
        return self.math('MULTIPLY', self.math('GREATER_THAN', x, lo), self.math('LESS_THAN', x, hi))

    def noise(self, vec, scale, detail=3.0, rough=0.55):
        n = self.node('ShaderNodeTexNoise'); self.put(n.inputs['Vector'], vec)
        n.inputs['Scale'].default_value = scale; n.inputs['Detail'].default_value = detail
        n.inputs['Roughness'].default_value = rough
        return n.outputs['Fac']

    def white(self, vec):
        n = self.node('ShaderNodeTexWhiteNoise', noise_dimensions='3D'); self.put(n.inputs['Vector'], vec)
        return n.outputs['Value'], n.outputs['Color']

    def night(self):
        g = self.node('ShaderNodeGroup'); g.node_tree = gz_look.night_group()
        return g.outputs[0]

    def bsdf(self, **inputs):
        b = self.node('ShaderNodeBsdfPrincipled')
        for k, v in inputs.items():
            self.put(b.inputs[k.replace('_', ' ')], v)
        o = self.node('ShaderNodeOutputMaterial')
        self.nt.links.new(b.outputs[0], o.inputs['Surface'])
        return b


def new(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    MATS[name] = m
    return m


def facade(name, wall, glass, roof, floor_h, bay, win_w, sill, head, wall_rough=0.75, glass_rough=0.06,
           glass_metal=0.35, gf_h=0.0, lit=0.4, warm=0.6, lit_k=5.0, tint_glass=False, floor_bias=0.0):
    """Window-grid facade. win_w: glazed fraction of a bay; sill/head: glazed band as fractions of a floor.
    gf_h > 0 adds a ground-floor shopfront band. Night: lit = mean share of windows lit (scaled per building by
    an occupancy hash), floor_bias = how much lighting comes in whole floors (offices) rather than single
    windows (homes), warm = share of warm lamps, lit_k = brightness (x WINDOW_GAIN)."""
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*[0.5 * a + 0.5 * b for a, b in zip(wall, glass)], 1)
    # everything the web demo needs to rebuild this shader (exported as glTF material extras)
    m['gz_facade'] = json.dumps({'wall': wall, 'glass': glass, 'roof': roof, 'floor_h': floor_h, 'bay': bay,
                                 'win_w': win_w, 'sill': sill, 'head': head, 'wall_rough': wall_rough,
                                 'glass_rough': glass_rough, 'glass_metal': glass_metal, 'gf_h': gf_h, 'lit': lit,
                                 'warm': warm, 'lit_k': lit_k * WINDOW_GAIN, 'tint_glass': tint_glass,
                                 'floor_bias': floor_bias})
    k = NB(m)
    tc = k.node('ShaderNodeTexCoord')
    u, v, _ = k.sep(tc.outputs['UV'])
    geo = k.node('ShaderNodeNewGeometry')
    _, _, nz = k.sep(geo.outputs['Normal'])
    wallm = k.math('LESS_THAN', k.math('ABSOLUTE', nz), 0.5)
    su = k.math('DIVIDE', u, bay); sv = k.math('DIVIDE', v, floor_h)
    fu, cu = k.math('FRACT', su), k.math('FLOOR', su)
    fv, cv = k.math('FRACT', sv), k.math('FLOOR', sv)
    mg = (1 - win_w) / 2
    win = k.math('MULTIPLY', k.between(fu, mg, 1 - mg), k.between(fv, sill, head))
    gf = None
    if gf_h > 0:
        gf = k.math('LESS_THAN', v, gf_h)
        shop = k.math('MULTIPLY', k.between(fu, 0.05, 0.95), k.between(v, 0.35, gf_h - 0.9))
        win = k.mixf(gf, win, shop)
    win = k.math('MULTIPLY', win, wallm)
    at = k.node('ShaderNodeAttribute', attribute_name='tint')
    tint, rnd = at.outputs['Color'], at.outputs['Alpha']
    wallc = k.mixc(1.0, tint, wall, 'MULTIPLY')
    roofc = k.mixc(1.0, tint, roof, 'MULTIPLY')
    # weathering: large-scale streaks on walls, broken up per building
    grime = k.noise(k.comb(u, k.math('MULTIPLY', v, 0.15), k.math('MULTIPLY', rnd, 40)), 0.35, 4.0)
    wallc = k.mixc(k.math('MULTIPLY', k.math('SUBTRACT', grime, 0.35), 0.5), wallc, (0.18, 0.17, 0.16))
    base = k.mixc(wallm, roofc, wallc)
    cellv, cellc = k.white(k.comb(cu, cv, k.math('MULTIPLY', rnd, 531.0)))
    pane = k.math('ADD', 0.78, k.math('MULTIPLY', cellv, 0.44))
    glassc = k.mixc(1.0, k.comb(pane, pane, pane), glass, 'MULTIPLY')
    if tint_glass:
        glassc = k.mixc(0.6, glassc, k.mixc(1.0, tint, glassc, 'MULTIPLY'))
    col = k.mixc(win, base, glassc)
    rough = k.mixf(win, wall_rough, glass_rough)
    metal = k.mixf(win, 0.0, glass_metal)
    # night: per-building occupancy, then whole floors (offices) or single windows (homes); shopfronts mostly on
    occ = k.math('ADD', 0.2, k.math('MULTIPLY', k.math('FRACT', k.math('MULTIPLY', rnd, 7.13)), 1.5))
    lit_eff = k.math('MULTIPLY', lit, occ)
    if gf is not None:
        lit_eff = k.mixf(gf, lit_eff, 0.9)
    lv, lc = k.white(k.comb(k.math('ADD', cu, 0.37), k.math('ADD', cv, 0.61), k.math('ADD', k.math('MULTIPLY', rnd, 977.0), 3.0)))
    fl, _ = k.white(k.comb(0.5, k.math('ADD', cv, 0.17), k.math('ADD', k.math('MULTIPLY', rnd, 331.0), 11.0)))
    _, g2, b2 = k.sep(lc)
    cell_on = k.math('LESS_THAN', lv, lit_eff)
    floor_on = k.math('MULTIPLY', k.math('LESS_THAN', fl, lit_eff), k.math('LESS_THAN', lv, 0.9))
    on = k.math('MULTIPLY', k.math('GREATER_THAN', k.mixf(floor_bias, cell_on, floor_on), 0.5), win)
    lamp = k.mixc(k.math('LESS_THAN', g2, warm), (0.78, 0.88, 1.0), (1.0, 0.68, 0.38))
    strength = k.math('MULTIPLY', k.math('MULTIPLY', on, k.night()), k.math('MULTIPLY', k.math('ADD', 0.35, b2), lit_k * WINDOW_GAIN))
    k.bsdf(Base_Color=col, Roughness=rough, Metallic=metal, Emission_Color=lamp, Emission_Strength=strength)
    return m


def plain(name, color, rough=0.8, metal=0.0, noise=None, bump=0.0, spec=0.5, glow=None):
    """Principled with optional large-scale colour noise (noise = (scale, colour2, amount)).
    glow = (colour, strength, pooled): night light spill. pooled=True keys pools of light off road-space UV u
    every LAMP_SP metres (matching the lamp posts); otherwise an even glow."""
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*color, 1)
    m['gz_plain'] = json.dumps({'color': color, 'rough': rough, 'metal': metal,
                                'glow': list(glow) if glow else None, 'noise': list(noise) if noise else None})
    k = NB(m)
    col = color
    obj = k.node('ShaderNodeTexCoord').outputs['Object']
    if noise:
        sc, col2, amt = noise
        f = k.math('MULTIPLY', k.noise(obj, sc, 5.0, 0.6), amt)
        col = k.mixc(f, color, col2)
    b = k.bsdf(Base_Color=col, Roughness=rough, Metallic=metal, Specular_IOR_Level=spec)
    if glow:
        gcol, gk, pooled = glow
        amt = k.night()
        if pooled:
            u, _, _ = k.sep(k.node('ShaderNodeTexCoord').outputs['UV'])
            d = k.math('MULTIPLY', k.math('ABSOLUTE', k.math('SUBTRACT', k.math('FRACT', k.math('DIVIDE', u, LAMP_SP)), 0.5)), LAMP_SP)
            mr = k.node('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP')
            k.put(mr.inputs['Value'], d); mr.inputs['From Min'].default_value = 0.0; mr.inputs['From Max'].default_value = 12.0
            mr.inputs['To Min'].default_value = 1.0; mr.inputs['To Max'].default_value = 0.0
            amt = k.math('MULTIPLY', amt, k.math('ADD', 0.28, mr.outputs['Result']))
        k.put(b.inputs['Emission Color'], gcol)
        k.put(b.inputs['Emission Strength'], k.math('MULTIPLY', amt, gk))
    if bump:
        bn = k.node('ShaderNodeBump'); bn.inputs['Strength'].default_value = bump
        k.put(bn.inputs['Height'], k.noise(obj, 0.9, 6.0, 0.6))
        k.nt.links.new(bn.outputs[0], b.inputs['Normal'])
    return m


def water(name='GZ Water | Pearl River', color=(0.022, 0.036, 0.028)):
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*color, 1)
    m['gz_water'] = json.dumps({'color': color})
    k = NB(m)
    obj = k.node('ShaderNodeTexCoord').outputs['Object']
    x, y, z = k.sep(obj)
    # long wind swell along the river (x) plus fine chop
    swell = k.noise(k.comb(k.math('MULTIPLY', x, 0.35), y, z), 0.06, 3.0, 0.5)
    chop = k.noise(obj, 0.9, 4.0, 0.6)
    h = k.math('ADD', swell, k.math('MULTIPLY', chop, 0.35))
    b = k.bsdf(Base_Color=color, Roughness=0.09, Specular_IOR_Level=0.5)
    bn = k.node('ShaderNodeBump'); bn.inputs['Strength'].default_value = 0.35; bn.inputs['Distance'].default_value = 0.6
    k.put(bn.inputs['Height'], h)
    k.nt.links.new(bn.outputs[0], b.inputs['Normal'])
    return m


def leaves(name, color, color2):
    """Foliage: per-instance colour variation from Object Info random (works on GN instances)."""
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*color, 1)
    m['gz_leaves'] = json.dumps({'color': color, 'color2': color2})
    k = NB(m)
    oi = k.node('ShaderNodeObjectInfo')
    obj = k.node('ShaderNodeTexCoord').outputs['Object']
    f = k.math('ADD', k.math('MULTIPLY', oi.outputs['Random'], 0.7), k.math('MULTIPLY', k.noise(obj, 1.6, 3.0), 0.5))
    col = k.mixc(k.math('SUBTRACT', f, 0.25), color, color2)
    k.bsdf(Base_Color=col, Roughness=0.72, Specular_IOR_Level=0.35)
    return m


def emissive(name, color, strength, night_only=True):
    """Lamp heads, tower lighting: emission scaled by the shared night value."""
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*color, 1)
    m['gz_emit'] = json.dumps({'color': color, 'strength': strength, 'night_only': night_only})
    k = NB(m)
    s = k.math('MULTIPLY', k.night(), strength) if night_only else strength
    k.bsdf(Base_Color=(0.6, 0.6, 0.6), Roughness=0.4, Emission_Color=color, Emission_Strength=s)
    return m


# ---------------------------------------------------------------- the city palette
def building_mats():
    """Facade families (name -> material). Colours are linear."""
    return {
        # supertall/tall office: blue-grey curtain wall, 4.2 m floors, 1.5 m mullions, spandrel band
        'glass': facade('GZ Facade | curtain wall', wall=(0.20, 0.22, 0.24), glass=(0.10, 0.14, 0.18),
                        roof=(0.30, 0.30, 0.29), floor_h=4.2, bay=1.5, win_w=0.92, sill=0.24, head=0.98,
                        glass_rough=0.04, glass_metal=0.55, gf_h=6.0, lit=0.32, warm=0.25, lit_k=4.0, tint_glass=True, floor_bias=0.8),
        # mid-rise office: stone panels, punched windows
        'office': facade('GZ Facade | office stone', wall=(0.50, 0.47, 0.42), glass=(0.06, 0.08, 0.10),
                         roof=(0.34, 0.33, 0.31), floor_h=3.9, bay=3.0, win_w=0.6, sill=0.28, head=0.86,
                         gf_h=5.0, lit=0.3, warm=0.3, lit_k=4.0, floor_bias=0.6),
        # residential towers: pale tile, smaller windows, 3 m floors
        'resi': facade('GZ Facade | residential tile', wall=(0.66, 0.64, 0.59), glass=(0.07, 0.09, 0.10),
                       roof=(0.40, 0.38, 0.35), floor_h=3.0, bay=3.3, win_w=0.46, sill=0.3, head=0.82,
                       gf_h=4.5, lit=0.42, warm=0.8, lit_k=3.0),
        # urban-village blocks (handshake buildings): warm tile, small windows, shops below
        'village': facade('GZ Facade | urban village', wall=(0.62, 0.55, 0.46), glass=(0.07, 0.08, 0.09),
                          roof=(0.36, 0.33, 0.30), floor_h=3.0, bay=2.6, win_w=0.42, sill=0.34, head=0.78,
                          gf_h=4.0, lit=0.5, warm=0.75, lit_k=2.6),
        # podiums / malls: ribbon glazing
        'podium': facade('GZ Facade | podium', wall=(0.42, 0.42, 0.43), glass=(0.08, 0.10, 0.12),
                         roof=(0.33, 0.33, 0.32), floor_h=5.2, bay=4.5, win_w=0.94, sill=0.18, head=0.72,
                         glass_metal=0.3, gf_h=6.0, lit=0.5, warm=0.5, lit_k=4.0, floor_bias=0.3),
        # schools, hospitals, government
        'civic': facade('GZ Facade | civic render', wall=(0.72, 0.70, 0.64), glass=(0.07, 0.09, 0.10),
                        roof=(0.42, 0.41, 0.38), floor_h=3.8, bay=3.6, win_w=0.58, sill=0.3, head=0.82,
                        lit=0.3, warm=0.2, lit_k=3.0),
        # tower tops: a screen of vertical fins, lit white at night (the CBD's crown lighting)
        'crown': facade('GZ Facade | tower crown fins', wall=(0.62, 0.64, 0.66), glass=(0.12, 0.15, 0.18),
                        roof=(0.3, 0.3, 0.3), floor_h=6.0, bay=1.2, win_w=0.45, sill=0.0, head=1.0,
                        glass_rough=0.1, glass_metal=0.3, lit=0.9, warm=0.1, lit_k=5.0, floor_bias=1.0),
        # residential roof frames: light painted concrete with big openings
        'resi_crown': facade('GZ Facade | residential roof frame', wall=(0.74, 0.72, 0.68), glass=(0.20, 0.22, 0.24),
                             roof=(0.4, 0.4, 0.4), floor_h=4.5, bay=3.3, win_w=0.7, sill=0.15, head=0.85, lit=0.0, lit_k=0.0),
        'mast': facade('GZ Facade | steel mast', wall=(0.70, 0.71, 0.72), glass=(0.70, 0.71, 0.72),
                       roof=(0.7, 0.7, 0.7), floor_h=3.0, bay=2.0, win_w=0.1, sill=0.4, head=0.6, lit=0.0, lit_k=0.0),
        'industrial': facade('GZ Facade | industrial panel', wall=(0.46, 0.48, 0.49), glass=(0.08, 0.09, 0.10),
                             roof=(0.36, 0.37, 0.37), floor_h=6.0, bay=6.0, win_w=0.3, sill=0.6, head=0.82,
                             lit=0.2, warm=0.1, lit_k=2.0),
    }


def ground_mats():
    return {
        'paving': plain('GZ Ground | paving', (0.19, 0.185, 0.175), 0.85, noise=(0.02, (0.14, 0.14, 0.135), 0.8),
                        glow=((1.0, 0.75, 0.5), 0.035, False)),
        'grass': plain('GZ Ground | lawn', (0.075, 0.13, 0.035), 0.95, noise=(0.03, (0.13, 0.17, 0.05), 1.2), spec=0.3),
        'kerb': plain('GZ Ground | kerb granite', (0.33, 0.32, 0.30), 0.7, noise=(0.4, (0.26, 0.25, 0.24), 0.5)),
        'road_bed': plain('GZ Road | junction asphalt', (0.05, 0.052, 0.055), 0.88, noise=(0.05, (0.075, 0.075, 0.075), 0.6),
                          glow=((1.0, 0.74, 0.48), 0.2, False)),
        'quay': plain('GZ Ground | quay stone', (0.22, 0.21, 0.19), 0.85, noise=(0.2, (0.2, 0.2, 0.18), 0.8)),
        'water': water(),
        'pond': water('GZ Water | pond', (0.03, 0.06, 0.05)),
    }


def road_mats():
    return {
        'major': plain('GZ Road | asphalt major', (0.045, 0.047, 0.050), 0.88, noise=(0.05, (0.07, 0.07, 0.07), 0.6),
                       glow=((1.0, 0.76, 0.52), 0.36, True)),
        'minor': plain('GZ Road | asphalt minor', (0.065, 0.065, 0.066), 0.9, noise=(0.05, (0.09, 0.09, 0.088), 0.6),
                       glow=((1.0, 0.62, 0.30), 0.30, True)),
        'foot': plain('GZ Road | footway paving', (0.22, 0.17, 0.15), 0.85, noise=(0.08, (0.25, 0.23, 0.21), 0.7),
                      glow=((1.0, 0.8, 0.6), 0.08, False)),
        'steps': plain('GZ Road | steps granite', (0.42, 0.41, 0.39), 0.8),
        'bridge': plain('GZ Road | bridge concrete', (0.44, 0.44, 0.42), 0.8, noise=(0.03, (0.34, 0.34, 0.33), 0.7)),
        'marking': plain('GZ Road | marking white', (0.62, 0.62, 0.60), 0.6),
    }


def tree_mats():
    return {
        'banyan': leaves('GZ Tree | banyan leaves', (0.030, 0.075, 0.018), (0.075, 0.13, 0.03)),
        'kapok': leaves('GZ Tree | kapok leaves', (0.045, 0.10, 0.022), (0.10, 0.15, 0.035)),
        'palm': leaves('GZ Tree | palm fronds', (0.05, 0.11, 0.025), (0.11, 0.15, 0.04)),
        'bark': plain('GZ Tree | bark', (0.10, 0.085, 0.07), 0.9),
        'palm_trunk': plain('GZ Tree | royal palm trunk', (0.28, 0.27, 0.25), 0.8),
    }


def plain_lit(name, color, rough=0.5, metal=0.0, emit=(1, 1, 1), strength=0.0):
    """Principled whose emission switches on with the shared night value (lit structure, LED lines)."""
    if name in MATS:
        return MATS[name]
    m = new(name)
    m.diffuse_color = (*color, 1)
    m['gz_plain'] = json.dumps({'color': color, 'rough': rough, 'metal': metal, 'night_emit': [*emit, strength]})
    k = NB(m)
    k.bsdf(Base_Color=color, Roughness=rough, Metallic=metal, Emission_Color=emit,
           Emission_Strength=k.math('MULTIPLY', k.night(), strength))
    return m
