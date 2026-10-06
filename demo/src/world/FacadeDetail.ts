import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { fromBlender } from '../config';
import { FACADES, type Facade } from './Materials';
import type { RoadIndex } from './RoadIndex';

/**
 * Near-LOD facade geometry for the buildings around the camera, generated from buildings.json (the exact
 * extruded rings) and the facade families' window grids, so every piece lands on the shader's windows:
 *
 *   glass      aluminium fins on every bay line, a slab-edge band at every floor, a crown band; lobby
 *              frames and an entrance canopy at the foot
 *   office     stone pilasters every second bay, window sills, a cornice
 *   podium     fins and floor bands across the ribbon glazing
 *   resi       balcony stacks (slab, parapet, glass) on the long faces, air-conditioner units with fans
 *              beside the other windows, sills
 *   village    the handshake-building look: AC units under most windows, window cages (security grilles), laundry
 *              (bamboo / steel poles out of the windows and stainless racks under them, hung with shirts, towels and
 *              trousers), cable bundles strung along the walls and sagging across the alleys to the next building
 *   civic      pilasters and sills
 * and on every street-facing ground floor: shop posts, a fascia band (the signs sit just in front of it),
 * roller-shutter boxes and coloured awnings.
 *
 * Buildings within NEAR m of the camera are generated a few per frame and cached; all instances live in
 * seven InstancedMeshes that are repacked when the near set changes.
 */
const NEAR = 190;
const FINE = 115;                 // sills, AC units and grilles only this close
const CELL = 50;
const FAMILY_MAT: Record<string, string> = {
  glass: 'GZ Facade | curtain wall', office: 'GZ Facade | office stone', resi: 'GZ Facade | residential tile',
  village: 'GZ Facade | urban village', podium: 'GZ Facade | podium', civic: 'GZ Facade | civic render', industrial: 'GZ Facade | industrial panel',
};
const AWNINGS = ['#b3261e', '#1f5aa6', '#2e7d4f', '#e0a526', '#d9602a', '#6a3d9a', '#e8e4d8', '#2b2b2b'].map((c) => new THREE.Color(c));

type Kind = 'stone' | 'metal' | 'ac' | 'balcony' | 'grille' | 'fabric' | 'dark' | 'wire' | 'shirt' | 'cloth';
/** Cast from (x, y) along (dx, dy) to the nearest other building's wall (Blender metres): its distance and record. */
type WallCast = (self: number, x: number, y: number, dx: number, dy: number, maxD: number) => { d: number; other: number; village: boolean } | null;
const LAUNDRY = ['#e8e4dc', '#f4f4f0', '#2b3a55', '#c23b3b', '#e0b23a', '#3a7d5c', '#7a4b8c', '#f08ab0', '#5a8fc4', '#3a3a3a', '#d9d2c0', '#8a5a3c', '#ffffff', '#4a6a8a'].map((c) => new THREE.Color(c));
interface Piece { kind: Kind; m: THREE.Matrix4; c: THREE.Color; fine?: boolean }
type Rec = [number, number, number, number, number[], [number, number][]];

function hash(a: number, b = 0): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ------------------------------------------------------------------------------------------ unit meshes
function vcol(g: THREE.BufferGeometry, c: [number, number, number]): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function bx(w: number, h: number, d: number, x: number, y: number, z: number, c: [number, number, number] = [1, 1, 1]): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  g.deleteAttribute('uv');
  return vcol(g, c);
}

/** Split AC unit, local frame: x along the wall, y up, z out of the wall; hangs from a bracket. */
function acUnit(): THREE.BufferGeometry {
  const parts = [bx(0.82, 0.56, 0.3, 0, 0, 0.2, [0.86, 0.86, 0.84])];
  const fan = new THREE.CircleGeometry(0.2, 18).toNonIndexed();
  fan.translate(-0.12, 0, 0.352); fan.deleteAttribute('uv');
  parts.push(vcol(fan, [0.12, 0.12, 0.13]));
  const hub = new THREE.CircleGeometry(0.05, 10).toNonIndexed();
  hub.translate(-0.12, 0, 0.354); hub.deleteAttribute('uv');
  parts.push(vcol(hub, [0.6, 0.6, 0.6]));
  for (let k = 0; k < 4; k++) parts.push(bx(0.2, 0.012, 0.01, 0.26, -0.18 + k * 0.12, 0.352, [0.45, 0.45, 0.45]));   // side vents
  for (const x of [-0.3, 0.3]) parts.push(bx(0.04, 0.04, 0.42, x, -0.3, 0.21, [0.3, 0.3, 0.3]));                     // bracket arms
  return mergeGeometries(parts)!;
}

/** Balcony, unit width 1 m (scaled along x per bay): slab, low solid parapet, glass above, side returns. */
function balcony(): THREE.BufferGeometry {
  const D = 1.25;
  return mergeGeometries([
    bx(1.0, 0.16, D, 0, 0, D / 2, [1, 1, 1]),
    bx(1.0, 0.55, 0.1, 0, 0.35, D - 0.05, [0.95, 0.95, 0.93]),
    bx(1.0, 0.5, 0.03, 0, 0.87, D - 0.05, [0.2, 0.25, 0.28]),
    bx(1.0, 0.04, 0.08, 0, 1.13, D - 0.05, [0.4, 0.4, 0.42]),
    bx(0.08, 1.05, D, -0.5, 0.6, D / 2, [0.95, 0.95, 0.93]),
    bx(0.08, 1.05, D, 0.5, 0.6, D / 2, [0.95, 0.95, 0.93]),
  ])!;
}

/** A shirt on a line, 1 m wide and 1 m tall from the shoulders (scaled per item): body and sleeves, a thin slab. */
function shirt(): THREE.BufferGeometry {
  return mergeGeometries([bx(0.62, 0.82, 0.02, 0, -0.45, 0), bx(0.36, 0.26, 0.02, -0.42, -0.17, 0), bx(0.36, 0.26, 0.02, 0.42, -0.17, 0)])!;
}

/** Window cage (security grille), 1 x 1 m scaled to the window: frame, vertical bars, two rails. */
function grille(): THREE.BufferGeometry {
  const parts = [bx(1.0, 0.04, 0.3, 0, 0.5, 0.15), bx(1.0, 0.04, 0.3, 0, -0.5, 0.15), bx(0.04, 1.0, 0.3, -0.5, 0, 0.15), bx(0.04, 1.0, 0.3, 0.5, 0, 0.15)];
  for (let k = 1; k < 8; k++) parts.push(bx(0.015, 1.0, 0.015, -0.5 + k / 8, 0, 0.3));
  for (const y of [-0.2, 0.2]) parts.push(bx(1.0, 0.015, 0.015, 0, y, 0.3));
  return mergeGeometries(parts)!;
}

// ------------------------------------------------------------------------------------------ generator
function generate(rec: Rec, fam: string, F: Facade, roads: RoadIndex, castWall: WallCast | null = null, self = -1): Piece[] {
  const [id, , z0, z1, tint, ring] = rec;
  const out: Piece[] = [];
  const tcol = new THREE.Color(tint[0], tint[1], tint[2]);
  const wallC = new THREE.Color(F.wall[0], F.wall[1], F.wall[2]).multiply(tcol);
  const metalC = fam === 'glass' ? new THREE.Color(0.2, 0.22, 0.25).multiply(tcol) : new THREE.Color(0.32, 0.33, 0.35);
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const add = (kind: Kind, c: THREE.Color, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tilt = 0) => {
    q.setFromAxisAngle(up, yaw);
    if (tilt) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt));
    pos.copy(fromBlender(x, y, z));
    out.push({ kind, m: new THREE.Matrix4().compose(pos, q, sc.set(sx, sy, sz)), c });
  };
  // a straight piece of cable between two Blender points
  const zAxis = new THREE.Vector3(0, 0, 1), pa = new THREE.Vector3(), pb = new THREE.Vector3(), dir = new THREE.Vector3();
  const seg = (ax: number, ay: number, az: number, bx_: number, by: number, bz: number, r: number, c: THREE.Color) => {
    pa.copy(fromBlender(ax, ay, az)); pb.copy(fromBlender(bx_, by, bz));
    dir.subVectors(pb, pa); const len = dir.length();
    if (len < 1e-3) return;
    q.setFromUnitVectors(zAxis, dir.divideScalar(len));
    pos.addVectors(pa, pb).multiplyScalar(0.5);
    out.push({ kind: 'wire', m: new THREE.Matrix4().compose(pos, q, sc.set(r, r, len + r)), c, fine: true } as Piece);
  };
  /** a sagging cable from a to b (Blender), drooping `sag` m at the middle */
  const cable = (a: readonly number[], b: readonly number[], sag: number, r: number, c: THREE.Color) => {
    const n = Math.max(3, Math.min(9, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.6)));
    let px = a[0], py = a[1], pz = a[2];
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t - sag * 4 * t * (1 - t);
      seg(px, py, pz, x, y, z, r, c);
      px = x; py = y; pz = z;
    }
  };
  const cableC = [new THREE.Color(0.05, 0.05, 0.055), new THREE.Color(0.09, 0.09, 0.1), new THREE.Color(0.16, 0.15, 0.14)];
  const bay = F.bay, fh = F.floor_h, gfH = F.gf_h > 0 ? F.gf_h : 0;
  const winW = bay * F.win_w, sillZ = F.sill * fh, headZ = F.head * fh;
  // first floor whose windows clear the shop band (and the part's base), last one under the roof
  let f0 = 0;
  while (f0 * fh + sillZ < gfH - 0.01 || f0 * fh < z0 - 0.01) f0++;
  const f1 = Math.floor(z1 / fh);
  const n = ring.length;
  let u0 = 0;
  // the longest street-facing edge gets the entrance canopy on towers
  let entrance = -1, entranceL = 0;
  const street: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const s = z0 < 0.5 && L > 4 && roads.facesStreet(a, b);
    street.push(s);
    if (s && L > entranceL) { entranceL = L; entrance = i; }
  }
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 0.8) { u0 += L; continue; }
    const tx = dx / L, ty = dy / L, nx = ty, ny = -tx;
    const yaw = Math.atan2(ty, tx);
    const at = (s: number, out_: number) => [a[0] + tx * s + nx * out_, a[1] + ty * s + ny * out_] as const;
    // window columns on this edge: centres at u = (k + 0.5) * bay
    const cols: number[] = [];
    for (let k = Math.ceil(u0 / bay - 0.5); (k + 0.5) * bay < u0 + L; k++) {
      const s = (k + 0.5) * bay - u0;
      if (s - winW / 2 > 0.15 && s + winW / 2 < L - 0.15) cols.push(s);
    }
    const lines: number[] = [];
    for (let k = Math.ceil(u0 / bay); k * bay < u0 + L; k++) { const s = k * bay - u0; if (s > 0.25 && s < L - 0.25) lines.push(s); }
    const zTop = z1 - (fam === 'glass' ? 0.6 : 0.2);
    const zLow = Math.max(z0, gfH);
    if (fam === 'glass' || fam === 'podium') {
      const d = fam === 'glass' ? 0.3 : 0.4, w = fam === 'glass' ? 0.08 : 0.12;
      if (zTop - zLow > 1) for (const s of lines) { const [x, y] = at(s, d / 2); add('metal', metalC, x, y, (zLow + zTop) / 2, yaw, w, zTop - zLow, d); }
      for (let f = f0; f <= f1; f++) {
        const z = f * fh;
        if (z < zLow - 0.01 || z > zTop) continue;
        const [x, y] = at(L / 2, 0.09);
        add('metal', metalC, x, y, z, yaw, L, fam === 'glass' ? 0.34 : 0.55, 0.18);
      }
      const [x, y] = at(L / 2, 0.16);
      add('metal', metalC, x, y, z1 - 0.7, yaw, L, 1.4, 0.32);
    }
    if (fam === 'office' || fam === 'civic') {
      if (zTop - z0 > 3) for (let k = 0; k < lines.length; k += 2) { const [x, y] = at(lines[k], 0.15); add('stone', wallC, x, y, (z0 + zTop) / 2, yaw, 0.55, zTop - z0, 0.3); }
      const [x, y] = at(L / 2, 0.2);
      add('stone', wallC, x, y, z1 - 0.35, yaw, L + 0.2, 0.7, 0.4);
    }
    const fine: Piece[] = [];
    const addFine = (kind: Kind, c: THREE.Color, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
      add(kind, c, x, y, z, yaw, sx, sy, sz);
      fine.push(out.pop()!);
    };
    if (fam === 'office' || fam === 'civic' || fam === 'resi' || fam === 'village') {
      for (let f = f0; f < f1; f++) {
        const zf = f * fh;
        if (zf + headZ > z1 || zf < z0) continue;
        for (const [ci, s] of cols.entries()) {
          const h = hash(id * 0.013 + ci * 7.1, f * 3.3);
          const [x, y] = at(s, 0.07);
          if (fam !== 'village' || h < 0.5) addFine('stone', wallC, x, y, zf + sillZ - 0.04, winW + 0.16, 0.08, 0.14);
          if (fam === 'resi') {
            const stack = hash(id * 0.07 + ci * 1.7) < 0.42 && L > 10;           // whole columns of balconies
            if (stack && f > 0) {
              const [bxp, byp] = at(s, 0);
              add('balcony', wallC, bxp, byp, zf, yaw, bay * 0.96, 1, 1);
            } else if (h < 0.55) {
              const side = hash(id + ci, f) < 0.5 ? -1 : 1;
              const [ax, ay] = at(s + side * (winW / 2 + 0.5), 0);
              addFine('ac', new THREE.Color(1, 1, 1).multiplyScalar(0.9 + 0.1 * h), ax, ay, zf + sillZ - 0.45, 1, 1, 1);
            }
          }
          if (fam === 'village') {
            if (h < 0.72) {
              const [ax, ay] = at(s + (h < 0.36 ? -0.25 : 0.25), 0);
              addFine('ac', new THREE.Color(1, 1, 1).multiplyScalar(0.8 + 0.2 * h), ax, ay, zf + sillZ - 0.42, 1, 1, 1);
            }
            const caged = hash(id * 0.31 + ci, f * 1.9) < 0.55;
            if (caged) {
              const [gx, gy] = at(s, 0);
              addFine('grille', new THREE.Color(0.35, 0.34, 0.33), gx, gy, zf + (sillZ + headZ) / 2, winW + 0.12, headZ - sillZ + 0.12, 1);
            }
            // laundry: a pole pushed out of the window (bamboo or steel), or a stainless rack under it
            const hl = hash(id * 0.71 + ci * 3.7, f * 2.3);
            if (f >= 1 && hl < 0.3) {
              const steel = new THREE.Color(0.62, 0.63, 0.64), bamboo = new THREE.Color(0.55, 0.47, 0.3);
              const item = (k: number, ox: number, oz: number, zTop: number, yawI: number) => {
                const r = hash(id + ci * 5.3 + k * 1.7, f + k);
                const c = LAUNDRY[Math.floor(hash(id * 3.1 + k, ci + f * 7) * LAUNDRY.length)];
                const [x, y] = at(s + ox, oz);
                // across the pole (yawI = 90 deg: the sleeves along it) or facing the street (rack)
                const put = (kind: Kind, z: number, sx: number, sy: number, sz: number) => { add(kind, c, x, y, z, yaw + yawI, sx, sy, sz); fine.push(out.pop()!); };
                if (r < 0.45) put('shirt', zTop, 0.5 + r * 0.6, 0.55 + r * 0.35, 1);
                else if (r < 0.75) put('cloth', zTop - 0.38, 0.3 + r * 0.2, 0.75, 0.02);                // towel
                else put('cloth', zTop - 0.5, 0.38, 1.0, 0.02);                                         // trousers
              };
              if (hl < 0.17) {
                const zPole = zf + headZ + 0.08, Lp = 1.3 + hash(id, ci + f) * 0.6;
                const [px, py] = at(s + (hl < 0.08 ? -0.2 : 0.2), Lp / 2);
                addFine('metal', hl < 0.11 ? bamboo : steel, px, py, zPole, Lp > 1.6 ? 0.045 : 0.035, 0.04, Lp);
                const n = 2 + Math.floor(hash(id + 9, ci * f) * 3);
                for (let k = 0; k < n; k++) item(k, hl < 0.08 ? -0.2 : 0.2, 0.35 + (k + 0.5) * ((Lp - 0.4) / n), zPole - 0.03, Math.PI / 2);
              } else {
                const zr = zf + sillZ - 0.12;
                for (const sx of [-winW / 2 - 0.05, winW / 2 + 0.05]) { const [ax, ay] = at(s + sx, 0.3); addFine('metal', steel, ax, ay, zr, 0.03, 0.03, 0.6); }
                for (const oz of [0.22, 0.4, 0.58]) { const [bx_, by] = at(s, oz); addFine('metal', steel, bx_, by, zr, winW + 0.2, 0.025, 0.025); }
                const n = 2 + Math.floor(hash(id + 4, ci + f * 3) * 3);
                for (let k = 0; k < n; k++) item(k, -winW / 2 + (k + 0.5) * (winW / n), [0.22, 0.4, 0.58][k % 3], zr - 0.02, 0);
              }
            }
          }
        }
      }
    }
    // village cables: a bundle tied along the wall over the shop band, and spans across the alley to the next wall
    if (fam === 'village' && L > 3 && z1 - z0 > 6) {
      const hb = hash(id * 0.19 + i, 4.1);
      if (hb < 0.75) {
        const nb = 2 + Math.floor(hb * 4), zb = Math.max(z0, gfH, 2.6) + 0.4 + hb * 0.8;     // over the doors: 3-3.8 m
        for (let w = 0; w < nb; w++) {
          const zz = zb + w * 0.07, oo = 0.12 + (w % 2) * 0.05;
          const step = 3.2 + hash(id + w, i) * 1.5;
          for (let s0 = 0.3; s0 < L - 0.3; s0 += step) {
            const s1 = Math.min(L - 0.3, s0 + step);
            const [ax, ay] = at(s0, oo), [bx_, by] = at(s1, oo);
            cable([ax, ay, zz], [bx_, by, zz], 0.06 + 0.03 * w, 0.011 + 0.004 * (w % 3), cableC[w % 3]);
          }
        }
      }
      if (castWall && L > 4) {
        const spans = L > 14 ? 2 : 1;
        for (let k = 0; k < spans; k++) {
          const sk = L * (k + 0.5 + (hash(id + k, i * 3) - 0.5) * 0.4) / spans;
          const [x0, y0] = at(sk, 0.05);
          const hit = castWall(self, x0, y0, nx, ny, 14);
          if (!hit || hit.d < 1.5 || (hit.village && hit.other < self)) continue;       // one side strings it
          const nw = 2 + Math.floor(hash(id * 1.7 + k, i) * 4), za = Math.max(z0, gfH, 3.0) + 0.2 + hash(id + k * 7, i) * 3.3;
          const bxp = x0 + nx * hit.d, byp = y0 + ny * hit.d;
          for (let w = 0; w < nw; w++) {
            const off = (w - (nw - 1) / 2) * 0.22, zA = za + (w % 3) * 0.12, zB = zA + (hash(id + w, k + i) - 0.5) * 0.9;
            cable([x0 + tx * off, y0 + ty * off, zA], [bxp + tx * off * 1.4, byp + ty * off * 1.4, zB], 0.18 + hit.d * 0.035 + w * 0.03,
              0.012 + 0.005 * (w % 2), cableC[w % 3]);
          }
        }
      }
    }
    // shopfronts along the street
    if (street[i] && gfH > 0 && fam !== 'glass' && fam !== 'industrial') {
      const units = Math.max(1, Math.round(L / (4 + hash(id, i) * 2)));
      const uw = L / units;
      for (let k = 0; k <= units; k++) {
        const [x, y] = at(k * uw, 0.12);
        add('dark', new THREE.Color(0.14, 0.14, 0.15), x, y, (gfH - 0.9) / 2, yaw, 0.3, gfH - 0.9, 0.24);
      }
      const [fx, fy] = at(L / 2, 0.05);
      add('stone', wallC.clone().multiplyScalar(0.8), fx, fy, gfH - 0.45, yaw, L, 0.9, 0.1);
      for (let k = 0; k < units; k++) {
        const h = hash(id * 1.3 + k, i);
        const s = (k + 0.5) * uw;
        if (h < 0.45) {
          const [ax, ay] = at(s, 0.65);
          add('fabric', AWNINGS[Math.floor(hash(id + k * 3.1, i) * AWNINGS.length)], ax, ay, gfH - 1.35, yaw, uw - 0.4, 0.06, 1.3, 0.32);
        } else {
          const [rx, ry] = at(s, 0.14);
          add('dark', new THREE.Color(0.5, 0.5, 0.52), rx, ry, gfH - 1.05, yaw, uw - 0.35, 0.28, 0.26);
        }
      }
    }
    if (fam === 'glass' && z0 < 0.5) {
      // lobby: heavier glazing frames up to the first floor band, and the canopy over the entrance
      for (let s = 3; s < L - 1; s += 3) { const [x, y] = at(s, 0.12); add('metal', metalC, x, y, gfH / 2, yaw, 0.14, gfH, 0.24); }
      if (i === entrance) { const [x, y] = at(L / 2, 1.6); add('metal', metalC, x, y, gfH - 1.6, yaw, Math.min(L - 2, 14), 0.4, 3.2); }
    }
    for (const p of fine) (p as Piece & { fine?: boolean }).fine = true;
    out.push(...fine);
    u0 += L;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ streaming
export class FacadeDetail {
  readonly group = new THREE.Group();
  private readonly recs: Rec[];
  private readonly fams: string[];
  private readonly grid = new Map<string, number[]>();
  private readonly bounds: [number, number, number, number][] = [];
  private readonly cache = new Map<number, Piece[]>();
  private readonly meshes = new Map<Kind, THREE.InstancedMesh>();
  private near: number[] = [];
  private pending: number[] = [];
  private t = 0;
  private dirty = false;
  private lastCam = new THREE.Vector2(1e9, 1e9);
  instances = 0;

  constructor(data: { families: string[]; b: Rec[] }, private readonly roads: RoadIndex) {
    this.group.name = 'facade-detail';
    this.recs = data.b;
    this.fams = data.families;
    this.recs.forEach((r, i) => {
      const xs = r[5].map((p) => p[0]), ys = r[5].map((p) => p[1]);
      const bb: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      this.bounds.push(bb);
      for (let cx = Math.floor(bb[0] / CELL); cx <= Math.floor(bb[2] / CELL); cx++)
        for (let cy = Math.floor(bb[1] / CELL); cy <= Math.floor(bb[3] / CELL); cy++) {
          const k = `${cx},${cy}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k)!.push(i);
        }
    });
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(o);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const kinds: [Kind, THREE.BufferGeometry, THREE.Material, boolean][] = [
      ['stone', box, std({ roughness: 0.82 }), true],
      ['metal', box, std({ roughness: 0.34, metalness: 0.65 }), false],
      ['dark', box, std({ roughness: 0.5, metalness: 0.4 }), false],
      ['ac', acUnit(), std({ roughness: 0.55, vertexColors: true }), true],
      ['balcony', balcony(), std({ roughness: 0.6, vertexColors: true }), true],
      ['grille', grille(), std({ roughness: 0.5, metalness: 0.6 }), false],
      ['fabric', box, std({ roughness: 0.92, side: THREE.DoubleSide }), true],
      ['wire', box, std({ roughness: 0.7 }), false],
      ['shirt', shirt(), std({ roughness: 0.95, side: THREE.DoubleSide }), true],
      ['cloth', box, std({ roughness: 0.95, side: THREE.DoubleSide }), true],
    ];
    for (const [k, g, m, shadow] of kinds) {
      const im = new THREE.InstancedMesh(g, m, 16);
      im.count = 0;
      im.castShadow = shadow; im.receiveShadow = true;
      im.frustumCulled = false;
      im.name = 'facade ' + k;
      this.meshes.set(k, im);
      this.group.add(im);
    }
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.t -= dt;
    const cx = cam.x, cy = -cam.z;
    if (this.t <= 0 && Math.hypot(cx - this.lastCam.x, cy - this.lastCam.y) > 12) {
      this.t = 0.4;
      this.lastCam.set(cx, cy);
      const want = new Set<number>();
      const r = Math.ceil(NEAR / CELL);
      const gx = Math.floor(cx / CELL), gy = Math.floor(cy / CELL);
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        for (const k of this.grid.get(`${gx + i},${gy + j}`) ?? []) {
          const b = this.bounds[k];
          const d = Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3]));
          if (d < NEAR) want.add(k);
        }
      }
      const next = [...want];
      if (next.length !== this.near.length || next.some((k, i) => k !== this.near[i])) {
        this.near = next;
        this.pending = next.filter((k) => !this.cache.has(k));
        this.dirty = true;
      }
      // forget far-away cache entries
      if (this.cache.size > 400) for (const k of this.cache.keys()) if (!want.has(k)) this.cache.delete(k);
    }
    // generate a few buildings per frame, then repack once
    let budget = 6;
    while (this.pending.length && budget-- > 0) {
      const k = this.pending.shift()!;
      const rec = this.recs[k];
      const fam = this.fams[rec[1]];
      const F = FACADES.get(FAMILY_MAT[fam]);
      this.cache.set(k, F ? generate(rec, fam, F, this.roads, this.castWall, k) : []);
    }
    if (this.dirty && !this.pending.length) { this.dirty = false; this.repack(cx, cy); }
  }

  /** Nearest other building wall along a ray (Blender metres), within maxD. */
  private readonly castWall: WallCast = (self, x, y, dx, dy, maxD) => {
    let best: { d: number; other: number; village: boolean } | null = null;
    const seen = new Set<number>();
    for (let t = 0; t <= maxD + CELL; t += CELL / 2) {
      const k = `${Math.floor((x + dx * Math.min(t, maxD)) / CELL)},${Math.floor((y + dy * Math.min(t, maxD)) / CELL)}`;
      for (const r of this.grid.get(k) ?? []) {
        if (r === self || seen.has(r)) continue;
        seen.add(r);
        const ring = this.recs[r][5];
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const ex = b[0] - a[0], ey = b[1] - a[1];
          const den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-9) continue;
          const t1 = ((a[0] - x) * ey - (a[1] - y) * ex) / den, u = ((a[0] - x) * dy - (a[1] - y) * dx) / den;
          if (t1 > 0 && t1 < maxD && u >= 0 && u <= 1 && (!best || t1 < best.d)) best = { d: t1, other: r, village: this.fams[this.recs[r][1]] === 'village' };
        }
      }
      if (t > maxD) break;
    }
    return best;
  };

  /** Build everything for this camera position now (screenshots, teleports). */
  sync(cam: THREE.Vector3): void {
    this.t = 0; this.lastCam.set(1e9, 1e9);
    this.update(0, cam);
    let guard = 0;
    while ((this.pending.length || this.dirty) && guard++ < 500) this.update(0, cam);
  }

  private repack(cx: number, cy: number): void {
    const buckets = new Map<Kind, Piece[]>();
    for (const k of this.near) {
      const b = this.bounds[k];
      const d = Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3]));
      for (const p of this.cache.get(k) ?? []) {
        if ((p as Piece & { fine?: boolean }).fine && d > FINE) continue;
        if (!buckets.has(p.kind)) buckets.set(p.kind, []);
        buckets.get(p.kind)!.push(p);
      }
    }
    this.instances = 0;
    for (const [kind, im0] of this.meshes) {
      const list = buckets.get(kind) ?? [];
      let im = im0;
      if (list.length > im.instanceMatrix.count) {
        const cap = Math.ceil(list.length * 1.3);
        const bigger = new THREE.InstancedMesh(im.geometry, im.material, cap);
        bigger.castShadow = im.castShadow; bigger.receiveShadow = true; bigger.frustumCulled = false; bigger.name = im.name;
        this.group.remove(im); im.dispose();
        this.group.add(bigger);
        this.meshes.set(kind, bigger);
        im = bigger;
      }
      list.forEach((p, i) => { im.setMatrixAt(i, p.m); im.setColorAt(i, p.c); });
      im.count = list.length;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.instances += list.length;
    }
  }
}
