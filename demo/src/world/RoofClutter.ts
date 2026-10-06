import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromBlender } from '../config';

/**
 * What stands on Tianhe's flat roofs (seen from every tower and from the air):
 *
 *   hut       stair / lift machine room: a rendered box with an overhanging slab, a steel door, a louvre
 *   tank      stainless water tank on a steel stand (homes), or a blue plastic one (urban villages)
 *   solar     solar water heater: a tilted rack of glass tubes under a white tank (homes, urban villages)
 *   vrf       air-conditioning outdoor units with two top fans, in rows (offices, malls)
 *   cooler    cooling tower: louvred box, fan shroud on top (office towers, malls)
 *   mast      antenna mast with cross arms and a lightning rod
 *   dish      satellite dish on a post
 *   duct      a run of pipe / duct on sleepers between the plant
 *
 * Placed per roof (buildings.json masses) on a grid aligned with the roof's longest edge, by family. Every footprint
 * is checked against the game's collision: its corners must all land on this roof's height, so nothing stands on a
 * Blender plant box, a crown, a tower rising from a podium or over a courtyard. Instanced per kind and 500 m chunk
 * (frustum and distance culled through City's chunk list).
 *
 * The far city beyond the map (gz_backdrop: plain extruded boxes, no collision) gets the same treatment for the ring
 * next to the bounds -- see backdropRoofs(); those roofs are trusted flat, sparser (two unit rows, three tanks at
 * most), in 1 km chunks, and cast no shadow (the backdrop receives none).
 */
type Kind = 'hut' | 'tank' | 'solar' | 'vrf' | 'cooler' | 'mast' | 'dish' | 'duct';
type Rec = [number, number, number, number, number[], [number, number][]];
interface Item { kind: Kind; x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; c: THREE.Color; far?: boolean }

const CHUNK = 500, CHUNK_FAR = 1000;
const MAXD: Record<Kind, number> = { hut: 1400, tank: 1000, solar: 900, vrf: 800, cooler: 1100, mast: 1000, dish: 650, duct: 600 };
const SHADOW: Record<Kind, boolean> = { hut: true, tank: true, solar: true, vrf: true, cooler: true, mast: false, dish: false, duct: false };

// ------------------------------------------------------------------------------------------ unit geometry
type C3 = [number, number, number];
function col(g: THREE.BufferGeometry, c: C3): THREE.BufferGeometry {
  g = g.index ? g.toNonIndexed() : g;
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, c: C3 = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); return col(g, c);
}
function cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, c: C3, seg = 10, axis: 'y' | 'x' | 'z' = 'y'): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z); return col(g, c);
}
const STEEL: C3 = [0.62, 0.63, 0.64], DARK: C3 = [0.12, 0.12, 0.13], WHITE: C3 = [0.86, 0.86, 0.84], BODY: C3 = [1, 1, 1];

/** 1 x 1 x 1 m footprint conventions: x along, y up, z across; origin on the roof at the centre. */
function unit(kind: Kind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  switch (kind) {
    case 'hut':        // 1 x 1 x 1 (scaled to ~3.2 x 2.8 x 2.4): body tinted per instance, slab, door, louvre
      parts.push(box(1, 1, 1, 0, 0.5, 0, BODY), box(1.08, 0.06, 1.08, 0, 1.03, 0, [0.8, 0.8, 0.78]),
        box(0.28, 0.72, 0.02, -0.18, 0.36, 0.505, [0.32, 0.34, 0.36]), box(0.22, 0.14, 0.02, 0.22, 0.75, 0.505, DARK),
        box(1.0, 0.05, 1.0, 0, 0.025, 0, [0.5, 0.5, 0.5]));
      break;
    case 'tank':       // r 0.5, 1 m tall on a 0.35 m stand (scaled ~1.8 dia x 2.2): tinted per instance (steel / blue)
      parts.push(cyl(0.5, 0.5, 0.75, 0, 0.35 + 0.375, 0, BODY, 14), cyl(0.5, 0.18, 0.12, 0, 1.16, 0, BODY, 14));
      for (const [x, z] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]]) parts.push(box(0.05, 0.35, 0.05, x, 0.175, z, DARK));
      parts.push(box(0.8, 0.04, 0.8, 0, 0.35, 0, DARK), cyl(0.04, 0.04, 0.6, 0.45, 0.2, 0, STEEL, 6, 'x'));
      break;
    case 'solar': {    // 1 x 1 x 1 (scaled ~2 x 1.5 x 1.6): tilted tube rack, tank on top, legs
      const tilt = new THREE.Matrix4().makeRotationX(-0.75);
      const rack: THREE.BufferGeometry[] = [box(1, 0.02, 0.9, 0, 0, 0, [0.15, 0.17, 0.2])];
      for (let i = 0; i < 12; i++) rack.push(cyl(0.025, 0.025, 0.86, -0.46 + i * 0.084, 0.03, 0, [0.35, 0.4, 0.45], 5, 'z'));
      const r = mergeGeometries(rack)!; r.applyMatrix4(tilt); r.translate(0, 0.42, 0.02);
      parts.push(r, cyl(0.13, 0.13, 1.04, 0, 0.78, -0.3, WHITE, 10, 'x'));
      for (const x of [-0.45, 0.45]) parts.push(box(0.03, 0.78, 0.03, x, 0.39, -0.32, STEEL), box(0.03, 0.03, 0.8, x, 0.03, 0.02, STEEL), box(0.03, 0.04, 0.03, x, 0.02, 0.4, STEEL));
      break;
    }
    case 'vrf':        // 1 x 1 x 1 (scaled ~1.3 x 1.7 x 0.8): cabinet, two top fans with guards, side louvres
      parts.push(box(1, 0.92, 1, 0, 0.5, 0, BODY), box(1.02, 0.08, 1.02, 0, 0.96, 0, [0.82, 0.82, 0.8]));
      for (const x of [-0.25, 0.25]) parts.push(cyl(0.21, 0.21, 0.06, x, 1.02, 0, DARK, 12), cyl(0.04, 0.04, 0.08, x, 1.04, 0, STEEL, 6));
      for (let i = 0; i < 5; i++) parts.push(box(0.9, 0.025, 0.01, 0, 0.2 + i * 0.12, 0.505, [0.55, 0.56, 0.57]));
      parts.push(box(1.0, 0.04, 1.0, 0, 0.02, 0, DARK));
      break;
    case 'cooler':     // 1 x 1 x 1 (scaled ~3.2 x 2.8 x 3.2): casing, louvred lower band, fan stack
      parts.push(box(1, 0.7, 1, 0, 0.35 + 0.15, 0, BODY), box(1.01, 0.3, 1.01, 0, 0.15, 0, [0.38, 0.4, 0.42]));
      for (let i = 0; i < 4; i++) parts.push(box(1.02, 0.02, 1.02, 0, 0.04 + i * 0.07, 0, DARK));
      parts.push(cyl(0.42, 0.36, 0.22, 0, 0.96, 0, BODY, 16), cyl(0.36, 0.36, 0.02, 0, 1.08, 0, DARK, 16));
      break;
    case 'mast':       // 1 x 1 x 1 (scaled to height): pole, two cross arms with panels, a dish, the rod
      parts.push(cyl(0.012, 0.016, 1, 0, 0.5, 0, STEEL, 6), cyl(0.004, 0.004, 0.15, 0, 1.07, 0, STEEL, 4));
      for (const y of [0.62, 0.82]) {
        parts.push(box(0.36, 0.01, 0.01, 0, y, 0, STEEL));
        for (const x of [-0.17, 0.17]) parts.push(box(0.03, 0.12, 0.015, x, y + 0.02, 0.01, WHITE));
      }
      parts.push(cyl(0.06, 0.0, 0.03, 0.02, 0.5, 0.03, WHITE, 10, 'z'), box(0.3, 0.02, 0.3, 0, 0.01, 0, DARK));
      break;
    case 'dish': {     // 1 x 1 x 1 (scaled ~0.9): post and a dish facing the southern sky
      const d = new THREE.CylinderGeometry(0.45, 0.06, 0.12, 16, 1, true); d.rotateX(-Math.PI / 2 + 0.6); d.translate(0, 0.75, 0.05);
      parts.push(col(d, WHITE), cyl(0.03, 0.03, 0.7, 0, 0.35, 0, STEEL, 6), box(0.4, 0.04, 0.4, 0, 0.02, 0, DARK),
        cyl(0.01, 0.01, 0.35, 0, 0.82, 0.25, STEEL, 4, 'z'));
      break;
    }
    case 'duct':       // 1 m long run along x on two sleepers
      parts.push(cyl(0.5, 0.5, 1, 0, 0.6, 0, STEEL, 8, 'x'), box(0.1, 0.1, 1.1, -0.3, 0.05, 0, [0.5, 0.5, 0.5]), box(0.1, 0.1, 1.1, 0.3, 0.05, 0, [0.5, 0.5, 0.5]));
      break;
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------------------------------ placement
function hashN(n: number): () => number {
  let s = (Math.abs(n) % 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function inside(x: number, y: number, ring: [number, number][]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function edgeDist(x: number, y: number, ring: [number, number][]): number {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
    const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / L2));
    d = Math.min(d, Math.hypot(x - ax - ex * t, y - ay - ey * t));
  }
  return d;
}

/**
 * The far city's roofs as buildings.json records (Blender coordinates), for the lots whose centre lies within `ring`
 * metres of the map bounds. Each backdrop box is 4 walls and a quad roof: up-facing triangles are joined through
 * their shared corners into one roof per building; the family comes from the mesh name (`Backdrop | resi 3_4`).
 */
export function backdropRoofs(root: THREE.Object3D, families: string[], bounds: [number, number, number, number], ring = 900): Rec[] {
  const [bx0, by0, bx1, by1] = bounds;
  const out: Rec[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const m = /^Backdrop_\|_([a-z]+)_\d+_\d+$/.exec(mesh.name);
    if (!mesh.isMesh || !m) return;
    const fi = families.indexOf(m[1]);
    if (fi < 0) return;
    const g = mesh.geometry, pos = g.getAttribute('position'), colour = g.getAttribute('color'), idx = g.index;
    const corner = (i: number, v: THREE.Vector3) => v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    const vid = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
    const parent: number[] = [], tv: number[][] = [];
    const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const byKey = new Map<string, number>(), keyOf = (v: THREE.Vector3) => `${Math.round(v.x * 20)},${Math.round(v.y * 20)},${Math.round(v.z * 20)}`;
    const nt = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < nt; t++) {
      const i = [vid(t, 0), vid(t, 1), vid(t, 2)];
      corner(i[0], a); corner(i[1], b); corner(i[2], c);
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      if (n.y < 0.98 || a.y < 6) continue;
      const ti = parent.length;
      parent.push(ti); tv.push(i);
      for (const v of [a, b, c]) {
        const k = keyOf(v), o2 = byKey.get(k);
        if (o2 === undefined) byKey.set(k, ti); else parent[find(ti)] = find(o2);
      }
    }
    const roofs = new Map<number, number[]>();
    tv.forEach((i, ti) => { const r = find(ti); if (!roofs.has(r)) roofs.set(r, []); roofs.get(r)!.push(...i); });
    for (const vs of roofs.values()) {
      const pts = new Map<string, [number, number]>();
      let y = 0;
      for (const i of vs) { corner(i, a); y = a.y; pts.set(`${Math.round(a.x * 20)},${Math.round(a.z * 20)}`, [a.x, -a.z]); }
      const ringPts = [...pts.values()];
      if (ringPts.length < 3) continue;
      let cx = 0, cy = 0;
      for (const [x, yy] of ringPts) { cx += x; cy += yy; }
      cx /= ringPts.length; cy /= ringPts.length;
      if (Math.hypot(Math.max(bx0 - cx, 0, cx - bx1), Math.max(by0 - cy, 0, cy - by1)) > ring) continue;
      ringPts.sort((p, q) => Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx));
      const tint = colour ? [colour.getX(vs[0]), colour.getY(vs[0]), colour.getZ(vs[0])] : [1, 1, 1];
      out.push([Math.round(cx * 7.31 + cy * 13.7 + y * 101), fi, 0, y, tint, ringPts]);
    }
  });
  return out;
}

export class RoofClutter {
  readonly group = new THREE.Group();
  readonly chunks: { mesh: THREE.InstancedMesh; center: THREE.Vector3; maxDist: number }[] = [];
  readonly counts: Record<string, number> = {};
  /** roofs big enough for clutter, and how many got any (QA: LAY-07) */
  readonly roofs = { core: { n: 0, filled: 0 }, far: { n: 0, filled: 0 } };

  /**
   * roofAt(x, z, top): the collision height under three.js (x, z) cast down from `top`, or null.
   * far: backdrop roofs (backdropRoofs) -- flat boxes off the collision, taken as they are.
   */
  constructor(data: { families: string[]; b: Rec[] }, roofAt: (x: number, z: number, top: number) => number | null, wallColour: (fam: string) => THREE.Color,
    far: Rec[] = []) {
    this.group.name = 'roof clutter';
    const items: Item[] = [];
    const nCore = data.b.length;
    for (const [ri, rec] of [...data.b, ...far].entries()) {
      const isFar = ri >= nCore;
      const fam = data.families[rec[1]];
      const [id, , z0, z1, tint, ring] = rec;
      if (z1 - z0 < 6 || z1 < 9 || ring.length < 3) continue;
      const rnd = hashN(id * 31 + Math.round(z1 * 10));
      // frame: the longest edge
      let best = 0, ux = 1, uy = 0;
      for (let i = 0; i < ring.length; i++) {
        const [ax, ay] = ring[i], [bx, by] = ring[(i + 1) % ring.length];
        const L = Math.hypot(bx - ax, by - ay);
        if (L > best) { best = L; ux = (bx - ax) / L; uy = (by - ay) / L; }
      }
      const vx = -uy, vy = ux, yaw = Math.atan2(uy, ux);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [x, y] of ring) { const u = x * ux + y * uy, v = x * vx + y * vy; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const area = (u1 - u0) * (v1 - v0);
      if (area < 60) continue;
      const before = items.length;
      const placed: [number, number, number][] = [];         // x, y, radius (Blender)
      const toXY = (u: number, v: number): [number, number] => [u * ux + v * vx, u * uy + v * vy];
      /** a box of half extents (hu, hv) at (u, v), turned by `turn` (0 or pi/2): on this roof, clear of the rest */
      const fits = (u: number, v: number, hu: number, hv: number, margin = 1.0): boolean => {
        const [x, y] = toXY(u, v);
        const r = Math.hypot(hu, hv);
        if (!inside(x, y, ring) || edgeDist(x, y, ring) < Math.min(hu, hv) + margin) return false;
        for (const [px, py, pr] of placed) if (Math.hypot(px - x, py - y) < pr + r + 0.4) return false;
        // the footprint sampled every <= 3 m, corners and centre included (a row of outdoor units can straddle a lightwell)
        const nu = Math.max(2, Math.ceil(hu / 1.5)), nv = Math.max(2, Math.ceil(hv / 1.5));
        for (let iu = 0; iu <= nu; iu++) for (let iv = 0; iv <= nv; iv++) {
          const [cx, cy] = toXY(u + (2 * iu / nu - 1) * hu, v + (2 * iv / nv - 1) * hv);
          if (!inside(cx, cy, ring)) return false;
          if (isFar) continue;
          const p = fromBlender(cx, cy, 0);
          const g = roofAt(p.x, p.z, z1 + 6);
          if (g === null || Math.abs(g - z1) > 0.3) return false;
        }
        return true;
      };
      const put = (kind: Kind, u: number, v: number, sx: number, sy: number, sz: number, c: THREE.Color, turn = 0, hu = sx / 2, hv = sz / 2) => {
        const [x, y] = toXY(u, v);
        placed.push([x, y, Math.hypot(hu, hv)]);
        items.push({ kind, x, y, z: z1, yaw: yaw + turn, sx, sy, sz, c, far: isFar });
      };
      /** try `n` random spots for a box (half extents hu, hv): the first that fits */
      const spot = (hu: number, hv: number, n = 14, margin = 1.0): [number, number] | null => {
        for (let k = 0; k < n; k++) {
          const u = u0 + hu + margin + rnd() * Math.max(0, u1 - u0 - 2 * (hu + margin));
          const v = v0 + hv + margin + rnd() * Math.max(0, v1 - v0 - 2 * (hv + margin));
          if (fits(u, v, hu, hv, margin)) return [u, v];
        }
        return null;
      };
      const wall = wallColour(fam).clone().multiply(new THREE.Color(tint[0], tint[1], tint[2])).multiplyScalar(0.95);
      const office = fam === 'glass' || fam === 'office' || fam === 'podium' || fam === 'civic' || fam === 'industrial';
      const tall = z1 > 60;
      // stair / lift huts
      const huts = area > 900 ? 2 : area > 150 ? 1 : 0;
      for (let k = 0; k < huts; k++) {
        const w = 2.6 + rnd() * 2.4, d = 2.2 + rnd() * 1.6, h = 2.4 + rnd() * 1.4 + (tall ? 1.2 : 0);
        const s = spot(w / 2, d / 2);
        if (s) put('hut', s[0], s[1], w, h, d, wall.clone().multiplyScalar(0.9 + rnd() * 0.15));
      }
      if (!office) {
        // homes: water tanks in a cluster, solar heaters in a row facing south, a dish, sometimes a mast
        const village = fam === 'village';
        const nt = village ? 1 + Math.floor(rnd() * 2) : Math.min(isFar ? 3 : 6, 1 + Math.floor(area / 250));
        const blue = village && rnd() < 0.6;
        for (let k = 0; k < nt; k++) {
          const dia = village ? 1.2 + rnd() * 0.4 : 1.6 + rnd() * 0.6, h = village ? 1.6 : 2.0 + rnd() * 0.5;
          const s = spot(dia / 2, dia / 2, 10, 0.8);
          if (s) put('tank', s[0], s[1], dia, h, dia, blue ? new THREE.Color(0.12, 0.3, 0.62) : new THREE.Color(0.66, 0.67, 0.68).multiplyScalar(0.9 + rnd() * 0.15));
        }
        const ns = Math.floor((village ? 1 + rnd() * 4 : z1 < 40 ? rnd() * 6 : rnd() * 2.5));
        // the panels face south: Blender -y; the unit's tubes rise toward -z local = toward +v... turn so they face south
        const southTurn = Math.atan2(-1, 0) - yaw + Math.PI / 2;
        for (let k = 0; k < ns; k++) {
          const s = spot(1.2, 1.2, 10, 0.6);
          if (s) put('solar', s[0], s[1], 2.0, 1.5, 1.6, new THREE.Color(1, 1, 1), southTurn, 1.0, 0.8);
        }
        if (rnd() < 0.55) { const s = spot(0.5, 0.5, 8, 0.5); if (s) put('dish', s[0], s[1], 0.9, 0.9, 0.9, new THREE.Color(1, 1, 1), southTurn); }
        if (rnd() < (tall ? 0.45 : 0.2)) { const s = spot(0.3, 0.3, 8, 0.8); if (s) put('mast', s[0], s[1], 1.6, 3 + rnd() * 5, 1.6, new THREE.Color(1, 1, 1), rnd() * 3); }
      } else {
        // offices / malls: rows of outdoor units, cooling towers on the big roofs, ducts, a mast
        const rows = Math.min(isFar ? 2 : 4, Math.floor(area / 400));
        for (let r = 0; r < rows; r++) {
          const n = 4 + Math.floor(rnd() * 8);
          const len = n * 1.45;
          const s = spot(len / 2, 0.55, 12, 1.2);
          if (!s) continue;
          for (let k = 0; k < n; k++) {
            const [x, y] = toXY(s[0] - len / 2 + 0.72 + k * 1.45, s[1]);
            items.push({ kind: 'vrf', x, y, z: z1, yaw, sx: 1.3, sy: 1.7, sz: 0.8, c: new THREE.Color(0.86, 0.87, 0.86).multiplyScalar(0.92 + rnd() * 0.1), far: isFar });
          }
          placed.push([...toXY(s[0], s[1]), len / 2]);
          // a duct from the row toward a hut, if there is room
          const du = s[0] + (rnd() < 0.5 ? -1 : 1) * (len / 2 + 3);
          if (fits(du, s[1] + 1.2, 2.5, 0.3, 0.6)) put('duct', du, s[1] + 1.2, 5, 0.45, 0.45, new THREE.Color(1, 1, 1), 0, 2.5, 0.3);
        }
        const nc = area > 1200 ? 1 + Math.floor(rnd() * 3) : area > 600 && rnd() < 0.5 ? 1 : 0;
        for (let k = 0; k < nc; k++) {
          const w = 3 + rnd() * 1.2;
          const s = spot(w / 2, w / 2, 12, 1.5);
          if (s) put('cooler', s[0], s[1], w, 2.6 + rnd() * 0.8, w, new THREE.Color(0.78, 0.8, 0.82).multiplyScalar(0.9 + rnd() * 0.12));
        }
        if (rnd() < (tall ? 0.6 : 0.25)) { const s = spot(0.4, 0.4, 8, 1.0); if (s) put('mast', s[0], s[1], 2.2, tall ? 6 + rnd() * 8 : 3 + rnd() * 3, 2.2, new THREE.Color(1, 1, 1), rnd() * 3); }
        if (rnd() < 0.3) { const s = spot(0.6, 0.6, 8, 0.8); if (s) put('dish', s[0], s[1], 1.4, 1.4, 1.4, new THREE.Color(1, 1, 1), rnd() * 6); }
      }
      const tag = isFar ? 'far' : 'core';
      this.roofs[tag].n++;
      if (items.length > before) this.roofs[tag].filled++;
    }
    // instance: kind x chunk
    const geos = new Map<Kind, THREE.BufferGeometry>();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.15 });
    mat.name = 'roof clutter';
    const buckets = new Map<string, Item[]>();
    for (const it of items) {
      const ch = it.far ? CHUNK_FAR : CHUNK;
      const k = `${it.kind}|${Math.floor(it.x / ch)},${Math.floor(it.y / ch)}|${it.far ? 1 : 0}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(it);
      this.counts[it.kind] = (this.counts[it.kind] ?? 0) + 1;
      if (it.far) this.counts.far = (this.counts.far ?? 0) + 1;
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
    for (const [k, list] of buckets) {
      const kind = k.split('|')[0] as Kind;
      if (!geos.has(kind)) geos.set(kind, unit(kind));
      const im = new THREE.InstancedMesh(geos.get(kind)!, mat, list.length);
      const center = new THREE.Vector3();
      list.forEach((it, i) => {
        const p = fromBlender(it.x, it.y, it.z);
        center.add(p);
        q.setFromAxisAngle(up, it.yaw);
        im.setMatrixAt(i, m4.compose(p, q, sc.set(it.sx, it.sy, it.sz)));
        im.setColorAt(i, it.c);
      });
      center.divideScalar(list.length);
      im.computeBoundingSphere();
      const isFar = k.endsWith('|1');
      im.castShadow = SHADOW[kind] && !isFar; im.receiveShadow = !isFar;
      im.name = 'roof ' + kind;
      this.group.add(im);
      this.chunks.push({ mesh: im, center, maxDist: MAXD[kind] });
    }
    this.counts.total = items.length;
  }
}
