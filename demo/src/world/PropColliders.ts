import * as THREE from 'three';

/**
 * Colliders for everything the static collision mesh does not have: lamp posts, street trees, signal poles and
 * the street furniture (guard rails, bollards, benches, bins, bus shelters...). ~100k simple shapes in an 8 m
 * grid hash, all in three.js world coordinates:
 *
 *   circle  a vertical cylinder: centre (x, z), radius r, from y0 to y1
 *   box     a vertical prism: centre (x, z), half extents (hx, hz) in its own frame, rotated by yaw about +Y
 *           (local (x, z) -> world (x cos + z sin, -x sin + z cos), the same as Object3D.rotation.y)
 *
 * Queries: `resolveCircle` (people), `resolveBox` (a car's footprint, 2D SAT), `raycast` (the camera arm).
 */
const CELL = 8;
const KINDS = ['lamp', 'tree', 'signal', 'railing', 'bollard', 'bench', 'bin', 'cabinet', 'planter', 'hydrant', 'shelter', 'metro', 'shop'] as const;
export type PropKind = (typeof KINDS)[number];

export interface PropHit { kind: PropKind; nx: number; nz: number; depth: number }

export class PropColliders {
  // struct of arrays: type 0 circle / 1 box
  private type: number[] = [];
  private cx: number[] = [];
  private cz: number[] = [];
  private hx: number[] = [];      // circle: radius
  private hz: number[] = [];
  private cs: number[] = [];      // cos(yaw)
  private sn: number[] = [];      // sin(yaw)
  private y0: number[] = [];
  private y1: number[] = [];
  private kind: number[] = [];
  private readonly grid = new Map<number, number[]>();
  private stamp: Uint32Array = new Uint32Array(0);
  private epoch = 1;
  /** queries this frame (perf counter) */
  queries = 0;

  get count(): number { return this.type.length; }

  addCircle(x: number, z: number, r: number, y0: number, y1: number, kind: PropKind): void {
    this.push(0, x, z, r, r, 1, 0, y0, y1, kind);
  }

  /** A box whose local centre (lx, lz) sits in a frame at (x, z) rotated by `yaw`. */
  addBox(x: number, z: number, yaw: number, lx: number, lz: number, hx: number, hz: number, y0: number, y1: number, kind: PropKind): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    this.push(1, x + lx * c + lz * s, z - lx * s + lz * c, hx, hz, c, s, y0, y1, kind);
  }

  private push(t: number, x: number, z: number, hx: number, hz: number, c: number, s: number, y0: number, y1: number, kind: PropKind): void {
    const i = this.type.length;
    this.type.push(t); this.cx.push(x); this.cz.push(z); this.hx.push(hx); this.hz.push(hz);
    this.cs.push(c); this.sn.push(s); this.y0.push(y0); this.y1.push(y1); this.kind.push(KINDS.indexOf(kind));
    // extent in world x / z
    const ex = t === 0 ? hx : Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = t === 0 ? hx : Math.abs(s) * hx + Math.abs(c) * hz;
    const gx0 = Math.floor((x - ex) / CELL), gx1 = Math.floor((x + ex) / CELL);
    const gz0 = Math.floor((z - ez) / CELL), gz1 = Math.floor((z + ez) / CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const k = key(gx, gz);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      list.push(i);
    }
  }

  /** Call once after adding everything. */
  finish(): void {
    this.stamp = new Uint32Array(this.type.length);
  }

  /** Shapes whose cells overlap the world-space rectangle; each shape visited once. */
  private visit(x0: number, z0: number, x1: number, z1: number, fn: (i: number) => void): void {
    this.queries++;
    const e = ++this.epoch;
    const gx0 = Math.floor(x0 / CELL), gx1 = Math.floor(x1 / CELL), gz0 = Math.floor(z0 / CELL), gz1 = Math.floor(z1 / CELL);
    for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
      const list = this.grid.get(key(gx, gz));
      if (!list) continue;
      for (const i of list) { if (this.stamp[i] === e) continue; this.stamp[i] = e; fn(i); }
    }
  }

  /**
   * Push a vertical circle (a person: feet at p.y, `height` tall) out of every shape it overlaps. Shapes lower
   * than `step` above the feet are stepped over. Mutates p; returns the last hit (for velocity), or null.
   */
  resolveCircle(p: THREE.Vector3, r: number, height: number, step = 0.35): PropHit | null {
    let hit: PropHit | null = null;
    this.visit(p.x - r, p.z - r, p.x + r, p.z + r, (i) => {
      if (this.y1[i] < p.y + step || this.y0[i] > p.y + height) return;
      const h = this.circleVs(i, p.x, p.z, r);
      if (!h) return;
      p.x += h.nx * h.depth; p.z += h.nz * h.depth;
      hit = h;
    });
    return hit;
  }

  /** Circle (x, z, r) against shape i: push direction (away from the shape) and depth, or null. */
  private circleVs(i: number, x: number, z: number, r: number): PropHit | null {
    const kind = KINDS[this.kind[i]];
    const dx = x - this.cx[i], dz = z - this.cz[i];
    if (this.type[i] === 0) {
      const R = r + this.hx[i];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) return null;
      const d = Math.sqrt(d2);
      return d > 1e-6 ? { kind, nx: dx / d, nz: dz / d, depth: R - d } : { kind, nx: 1, nz: 0, depth: R };
    }
    // into the box frame (inverse rotation)
    const c = this.cs[i], s = this.sn[i];
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const hx = this.hx[i], hz = this.hz[i];
    const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
    let ox = lx - qx, oz = lz - qz;
    const d2 = ox * ox + oz * oz;
    let depth: number;
    if (d2 > 1e-10) {
      if (d2 >= r * r) return null;
      const d = Math.sqrt(d2);
      ox /= d; oz /= d; depth = r - d;
    } else {
      // centre inside: out through the nearest face
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      if (px < pz) { ox = Math.sign(lx) || 1; oz = 0; depth = px + r; } else { ox = 0; oz = Math.sign(lz) || 1; depth = pz + r; }
    }
    // back to world
    return { kind, nx: ox * c + oz * s, nz: -ox * s + oz * c, depth };
  }

  /**
   * Push an oriented box (a car footprint: centre p, half extents hx across / hz along, rotated by yaw, spanning
   * y0..y1) out of every shape it overlaps (2D SAT). Mutates p; returns the deepest hit, or null.
   */
  resolveBox(p: THREE.Vector3, hx: number, hz: number, yaw: number, y0: number, y1: number): PropHit | null {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const ex = Math.abs(c) * hx + Math.abs(s) * hz, ez = Math.abs(s) * hx + Math.abs(c) * hz;
    let best: PropHit | null = null;
    this.visit(p.x - ex - 1, p.z - ez - 1, p.x + ex + 1, p.z + ez + 1, (i) => {
      if (this.y1[i] < y0 || this.y0[i] > y1) return;
      const h = this.type[i] === 0 ? this.boxVsCircle(i, p, hx, hz, c, s) : this.boxVsBox(i, p, hx, hz, c, s);
      if (!h) return;
      p.x += h.nx * h.depth; p.z += h.nz * h.depth;
      if (!best || h.depth > best.depth) best = h;
    });
    return best;
  }

  private boxVsCircle(i: number, p: THREE.Vector3, hx: number, hz: number, c: number, s: number): PropHit | null {
    // circle in the car's frame; push the car the opposite way
    const dx = this.cx[i] - p.x, dz = this.cz[i] - p.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;
    const r = this.hx[i];
    const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
    let ox = lx - qx, oz = lz - qz;
    const d2 = ox * ox + oz * oz;
    let depth: number;
    if (d2 > 1e-10) {
      if (d2 >= r * r) return null;
      const d = Math.sqrt(d2);
      ox /= d; oz /= d; depth = r - d;
    } else {
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      if (px < pz) { ox = Math.sign(lx) || 1; oz = 0; depth = px + r; } else { ox = 0; oz = Math.sign(lz) || 1; depth = pz + r; }
    }
    // (ox, oz) points from the car toward the circle; the car moves away from it
    return { kind: KINDS[this.kind[i]], nx: -(ox * c + oz * s), nz: -(-ox * s + oz * c), depth };
  }

  private boxVsBox(i: number, p: THREE.Vector3, ahx: number, ahz: number, ac: number, as: number): PropHit | null {
    // axes of A (car) and B (prop), world xz: local x axis = (c, -s), local z axis = (s, c)
    const bc = this.cs[i], bs = this.sn[i], bhx = this.hx[i], bhz = this.hz[i];
    const dx = this.cx[i] - p.x, dz = this.cz[i] - p.z;
    const axes = [[ac, -as], [as, ac], [bc, -bs], [bs, bc]];
    let bestDepth = Infinity, nx = 0, nz = 0;
    for (const [ux, uz] of axes) {
      const ra = ahx * Math.abs(ac * ux - as * uz) + ahz * Math.abs(as * ux + ac * uz);
      const rb = bhx * Math.abs(bc * ux - bs * uz) + bhz * Math.abs(bs * ux + bc * uz);
      const dist = dx * ux + dz * uz;
      const overlap = ra + rb - Math.abs(dist);
      if (overlap <= 0) return null;
      if (overlap < bestDepth) { bestDepth = overlap; const sg = dist > 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; }
    }
    return { kind: KINDS[this.kind[i]], nx, nz, depth: bestDepth };
  }

  /** Distance along a ray to the first shape (camera spring arm), or Infinity. */
  raycast(o: THREE.Vector3, d: THREE.Vector3, far: number): number {
    const ex = o.x + d.x * far, ez = o.z + d.z * far;
    let best = far;
    const hz2 = d.x * d.x + d.z * d.z;
    if (hz2 < 1e-8) return Infinity;
    this.visit(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez), (i) => {
      let t: number;
      if (this.type[i] === 0) {
        // ray vs vertical cylinder in xz
        const fx = o.x - this.cx[i], fz = o.z - this.cz[i], r = this.hx[i];
        const b = fx * d.x + fz * d.z, cc = fx * fx + fz * fz - r * r;
        const disc = b * b - hz2 * cc;
        if (disc < 0) return;
        t = (-b - Math.sqrt(disc)) / hz2;
        if (t < 0) t = cc < 0 ? 0 : Infinity;
      } else {
        // slab test in the box frame
        const c = this.cs[i], s = this.sn[i];
        const fx = o.x - this.cx[i], fz = o.z - this.cz[i];
        const lx = fx * c - fz * s, lz = fx * s + fz * c;
        const vx = d.x * c - d.z * s, vz = d.x * s + d.z * c;
        let t0 = -Infinity, t1 = Infinity;
        for (const [pp, vv, h] of [[lx, vx, this.hx[i]], [lz, vz, this.hz[i]]]) {
          if (Math.abs(vv) < 1e-9) { if (Math.abs(pp) > h) return; continue; }
          let a = (-h - pp) / vv, b = (h - pp) / vv;
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        }
        if (t0 > t1 || t1 < 0) return;
        t = Math.max(0, t0);
      }
      if (t >= best) return;
      const y = o.y + d.y * t;
      if (y < this.y0[i] || y > this.y1[i]) return;
      best = t;
    });
    return best < far ? best : Infinity;
  }

  /**
   * Nearest shape centre of a kind within `r` of (x, z) (QA / pedestrians), or null. With `y`, only shapes
   * whose height span covers y..y+1.5 (a car or a person standing at y) count.
   */
  nearest(x: number, z: number, r: number, filter?: (k: PropKind) => boolean, y?: number): { x: number; z: number; kind: PropKind; d: number; y0: number; y1: number } | null {
    let best: { x: number; z: number; kind: PropKind; d: number; y0: number; y1: number } | null = null;
    this.visit(x - r, z - r, x + r, z + r, (i) => {
      const k = KINDS[this.kind[i]];
      if (filter && !filter(k)) return;
      if (y !== undefined && (this.y1[i] < y + 0.2 || this.y0[i] > y + 1.5)) return;
      const d = Math.hypot(this.cx[i] - x, this.cz[i] - z);
      if (d < r && (!best || d < best.d)) best = { x: this.cx[i], z: this.cz[i], kind: k, d, y0: this.y0[i], y1: this.y1[i] };
    });
    return best;
  }
}

function key(gx: number, gz: number): number {
  return (gx + 32768) * 65536 + (gz + 32768);
}
