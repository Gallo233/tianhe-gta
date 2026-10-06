import * as THREE from 'three';

/**
 * Night light from the shopfronts onto the pavement in front of them.
 *
 * The facade shader decides per shop bay whether it is lit, shuttered, and in which colour (Materials.facadeMaterial:
 * gzHash33(cu + 0.37, cv + 0.61, rnd * 977 + 3) on the ground-floor band). The ground surfaces repeat that exact
 * hash, so the pool on the paving matches the window behind it: a dark pavement in front of a roller shutter,
 * pink light under the pink shop.
 *
 *   tShopEdge   RGBA32F, 3 texels per ground-floor wall edge (row e): [ax, ay, bx, by] (Blender metres),
 *               [u0 (facade u at a), building rnd, bay, lit_k], [top of the shop windows, 1 = outside on the left,
 *               share of shutters (0.3 streets, 0.08 malls), 0]
 *   tShopIdx    RG16UI over the map bounds, CELL m per texel: the two nearest edges whose light can reach the cell
 *               (0 = none; edge e is stored as e + 1)
 *
 * gzShopLight(world) returns what reaches a ground point (linear rgb, as a fraction of white light): the window band's
 * view factor times each lit bay's radiance (the same value the facade emits), shared out by the angle the bay
 * subtends. The caller multiplies it into the albedo as emitted light, at night only. Families with a shop band: glass, office, resi, village, podium (gf_h > 0
 * in gz_materials) -- lobbies of the glass towers glow the same way.
 */
const CELL = 2;
const REACH = 9;                    // metres in front of the wall
// gz_materials facade families with a shop band: bay (m), top of the shop windows (gf_h - 0.9), lit_k
const FAM: Record<string, [number, number, number]> = {
  glass: [1.5, 5.1, 4.0], office: [3.0, 4.1, 4.0], resi: [3.3, 3.6, 3.0], village: [2.6, 3.1, 2.6], podium: [4.5, 5.1, 4.0],
};

type Rec = [number, number, number, number, number[], [number, number][]];

function blank(): { idx: THREE.DataTexture; edge: THREE.DataTexture } {
  const idx = new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGIntegerFormat, THREE.UnsignedShortType);
  idx.internalFormat = 'RG16UI';
  const edge = new THREE.DataTexture(new Float32Array(12), 3, 1, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [idx, edge]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }
  return { idx, edge };
}

const b0 = blank();
/** shared by every ground material (Materials.plainMaterial); filled by buildShopLight() */
export const SHOP_U = {
  tShopIdx: { value: b0.idx as THREE.Texture },
  tShopEdge: { value: b0.edge as THREE.Texture },
  uShopGrid: { value: new THREE.Vector4(0, 0, 1 / CELL, 0) },     // x0, y0 (Blender), 1 / cell, cells across
  uShopSize: { value: new THREE.Vector2(1, 1) },
  uShopK: { value: 2.5 },              // artistic gain over the physical estimate: shops outshine the street lamps
};

export interface ShopWall { a: number[]; b: number[]; u0: number; rnd: number; bay: number; litK: number; top: number; shut?: number }

export function buildShopLight(data: { families: string[]; b: Rec[] }, bounds: [number, number, number, number], extra: ShopWall[] = []): { edges: number; cells: number } {
  const [x0, y0, x1, y1] = bounds;
  const W = Math.ceil((x1 - x0) / CELL), H = Math.ceil((y1 - y0) / CELL);
  const edges: number[] = new Array(12).fill(0);                  // row 0: unused (index 0 = none)
  const idx = new Uint16Array(W * H * 2);
  const dist = new Float32Array(W * H * 2).fill(Infinity);
  /** one wall: a -> b with the facade's u at a; outside on the right (left when flip) */
  const addEdge = (a: number[], b: number[], u0: number, rnd: number, bay: number, litK: number, top: number, flip: boolean, shut = 0.3) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const e = edges.length / 12;
    if (e >= 65535 || L < 0.8) return;
    // the stored direction keeps u increasing from a; a clockwise ring is walked the same way but its outside is on the left
    edges.push(a[0], a[1], b[0], b[1], u0, rnd, bay, litK, top, flip ? 1 : 0, shut, 0);
    const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
    const nx = flip ? -ty : ty, ny = flip ? tx : -tx;
    // cells of the quad in front of the edge (plus a margin round the ends)
    const cs = [[-2, -1], [L + 2, -1], [-2, REACH + 1], [L + 2, REACH + 1]].map(([s, d]) => [a[0] + tx * s + nx * d, a[1] + ty * s + ny * d]);
    const cx0 = Math.max(0, Math.floor((Math.min(...cs.map((c) => c[0])) - x0) / CELL)), cx1 = Math.min(W - 1, Math.floor((Math.max(...cs.map((c) => c[0])) - x0) / CELL));
    const cy0 = Math.max(0, Math.floor((Math.min(...cs.map((c) => c[1])) - y0) / CELL)), cy1 = Math.min(H - 1, Math.floor((Math.max(...cs.map((c) => c[1])) - y0) / CELL));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const px = x0 + (cx + 0.5) * CELL - a[0], py = y0 + (cy + 0.5) * CELL - a[1];
      const s = px * tx + py * ty, d = px * nx + py * ny;
      const m = CELL * 0.75;                                       // the cell centre may sit outside while a corner is in reach
      if (d < -m || d > REACH + m || s < -2 - m || s > L + 2 + m) continue;
      const k = (cy * W + cx) * 2;
      const dd = Math.max(0, d) + Math.max(0, -s, s - L);
      if (dd < dist[k]) { dist[k + 1] = dist[k]; idx[k + 1] = idx[k]; dist[k] = dd; idx[k] = e; }
      else if (dd < dist[k + 1] && idx[k] !== e) { dist[k + 1] = dd; idx[k + 1] = e; }
    }
  };
  for (const [, fi, z0, , tint, ring0] of data.b) {
    const fam = FAM[data.families[fi]];
    if (!fam || z0 > 0.5 || ring0.length < 3) continue;
    const [bay, top, litK] = fam;
    // facade u runs along the ring as stored (FacadeDetail does the same); the outward normal is on the right of a
    // counter-clockwise ring
    let area = 0;
    for (let i = 0; i < ring0.length; i++) { const [ax, ay] = ring0[i], [bx, by] = ring0[(i + 1) % ring0.length]; area += ax * by - bx * ay; }
    let u0 = 0;
    for (let i = 0; i < ring0.length; i++) {
      const a = ring0[i], b = ring0[(i + 1) % ring0.length];
      addEdge(a, b, u0, tint[3], bay, litK, top, area < 0);
      u0 += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  // walls that are not buildings: the shopfronts round 花城汇's sunken court (their light falls on its floor)
  for (const w of extra) addEdge(w.a, w.b, w.u0, w.rnd, w.bay, w.litK, w.top, false, w.shut ?? 0.3);
  const nE = edges.length / 12;
  const it = new THREE.DataTexture(idx, W, H, THREE.RGIntegerFormat, THREE.UnsignedShortType);
  it.internalFormat = 'RG16UI';
  const et = new THREE.DataTexture(new Float32Array(edges), 3, nE, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [it, et]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.flipY = false; t.needsUpdate = true; }
  SHOP_U.tShopIdx.value = it;
  SHOP_U.tShopEdge.value = et;
  SHOP_U.uShopGrid.value.set(x0, y0, 1 / CELL, 0);
  SHOP_U.uShopSize.value.set(W, H);
  let cells = 0;
  for (let i = 0; i < W * H; i++) if (idx[i * 2]) cells++;
  return { edges: nE - 1, cells };
}

/** GLSL (needs HASH's gzHash33 and the SHOP_U uniforms): shop light reaching three.js world point `wp` */
export const SHOP_DECL = /* glsl */`
  uniform highp usampler2D tShopIdx; uniform highp sampler2D tShopEdge; uniform vec4 uShopGrid; uniform vec2 uShopSize; uniform float uShopK;
  vec3 gzShopEdge(uint e, vec2 bp) {
    vec4 g = texelFetch(tShopEdge, ivec2(0, int(e)), 0), h = texelFetch(tShopEdge, ivec2(1, int(e)), 0), k = texelFetch(tShopEdge, ivec2(2, int(e)), 0);
    vec2 ab = g.zw - g.xy; float L = length(ab); vec2 t = ab / L;
    vec2 n = k.y > 0.5 ? vec2(-t.y, t.x) : vec2(t.y, -t.x);
    vec2 r = bp - g.xy;
    float s = dot(r, t), d = dot(r, n);
    if (d < -0.1 || d > ${REACH.toFixed(1)}) return vec3(0.0);
    float bay = h.z, rnd = h.y, u = h.x + s, top = k.x, litK = h.w;
    d = max(d, 0.03);
    // the shop windows are a lit vertical band 0.35 m .. top: view factor of an infinitely wide band from a point on
    // the ground d metres out, shared out between the bays by the angle each one subtends
    float F = 0.5 * (d * inversesqrt(d * d + 0.1225) - d * inversesqrt(d * d + top * top)) * (1.0 - smoothstep(6.0, ${REACH.toFixed(1)}, d));
    float dl = d + 0.3, hw = 0.45 * bay;
    float cu0 = floor(u / bay);
    vec3 sum = vec3(0.0);
    for (int j = -3; j <= 3; j++) {
      float cu = cu0 + float(j);
      float uc = (cu + 0.5) * bay - h.x;                      // this bay's centre along the edge
      if (uc < 0.0 || uc > L) continue;
      vec3 lh = gzHash33(vec3(cu + 0.37, 0.61, rnd * 977.0 + 3.0));
      if (lh.x > 0.9 || fract(lh.y * 7.7 + rnd) < k.z) continue;   // dark, or the roller shutter is down (k.z: the share)
      vec3 shopC = lh.z < 0.08 ? vec3(1.0, 0.5, 0.62) : lh.z < 0.16 ? vec3(0.62, 1.0, 0.8) : lh.z < 0.66 ? vec3(1.0, 0.82, 0.6) : vec3(0.88, 0.93, 1.0);
      float x = s - uc;
      float lat = (atan(x + hw, dl) - atan(x - hw, dl)) * 0.31831;
      sum += shopC * (0.45 + 0.35 * lh.x) * lat;
    }
    // the window's own radiance in the facade shader: gzLamp (x 1.6 for shops) * lit_k * 0.55
    return sum * (1.6 * 0.55 * litK) * F;
  }
  vec3 gzShopLight(vec3 wp) {
    vec2 bp = vec2(wp.x, -wp.z);
    vec2 c = floor((bp - uShopGrid.xy) * uShopGrid.z);
    if (c.x < 0.0 || c.y < 0.0 || c.x >= uShopSize.x || c.y >= uShopSize.y) return vec3(0.0);
    uvec2 id = texelFetch(tShopIdx, ivec2(c), 0).rg;
    vec3 l = vec3(0.0);
    if (id.r > 0u) l += gzShopEdge(id.r, bp);
    if (id.g > 0u) l += gzShopEdge(id.g, bp);
    return l * uShopK;
  }
`;
