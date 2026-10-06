import type { RoadGraph } from './City';

/**
 * Street sample points on a grid, for "does this wall face a street" questions (shopfronts, signs).
 * Service roads, links, motorways and bridges are left out: nobody opens a shop onto a flyover.
 */
export class RoadIndex {
  private readonly grid = new Map<string, { x: number; y: number; hw: number; dx: number; dy: number }[]>();

  constructor(roads: RoadGraph, private readonly cell = 25) {
    for (const e of roads.edges) {
      if (e.bridge || e.hw === 'service' || e.hw.endsWith('_link') || e.hw === 'motorway') continue;
      const p = e.pts;
      for (let i = 0; i < p.length - 1; i++) {
        const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dy);
        for (let s = 0; s < l; s += 3) {
          const x = p[i][0] + dx * s / l, y = p[i][1] + dy * s / l;
          const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
          if (!this.grid.has(k)) this.grid.set(k, []);
          this.grid.get(k)!.push({ x, y, hw: e.w / 2, dx: dx / l, dy: dy / l });
        }
      }
    }
  }

  nearest(x: number, y: number): { d: number; hw: number; dx: number; dy: number } | null {
    let best: { d: number; hw: number; dx: number; dy: number } | null = null, bd = Infinity;
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const s of this.grid.get(`${cx + i},${cy + j}`) ?? []) {
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd) { bd = d; best = { d, hw: s.hw, dx: s.dx, dy: s.dy }; }
      }
    }
    return best;
  }

  /** Wall edge a -> b of a CCW ring (outward normal to its right): kerb within `maxKerb` m and running parallel. */
  facesStreet(a: [number, number], b: [number, number], maxKerb = 16): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
    const tx = dx / l, ty = dy / l, nx = ty, ny = -tx;
    const r = this.nearest((a[0] + b[0]) / 2 + nx * 3, (a[1] + b[1]) / 2 + ny * 3);
    return !!r && r.d - r.hw < maxKerb && Math.abs(r.dx * tx + r.dy * ty) > 0.75;
  }
}
