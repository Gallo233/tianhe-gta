import type { RoadGraph } from './City';

/**
 * "Is this spot on a road?" for every drivable OSM way at its real width and height (bridges and ramps
 * included), in Blender coordinates. Street props are placed per road, so a lamp or railing on the median
 * side of one carriageway of a dual carriageway, or beside a slip road that hugs the main road, can land in
 * somebody else's lanes: everything that stands in the street asks here first.
 */
const CELL = 20;

export class Carriageway {
  // segments: ax, ay, az, bx, by, bz, half width
  private readonly seg: number[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(roads: RoadGraph) {
    for (const e of roads.edges) {
      const hw = e.w / 2;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [ax, ay, az] = e.pts[i], [bx, by, bz] = e.pts[i + 1];
        const k = this.seg.length / 7;
        this.seg.push(ax, ay, az, bx, by, bz, hw);
        const x0 = Math.floor((Math.min(ax, bx) - hw) / CELL), x1 = Math.floor((Math.max(ax, bx) + hw) / CELL);
        const y0 = Math.floor((Math.min(ay, by) - hw) / CELL), y1 = Math.floor((Math.max(ay, by) + hw) / CELL);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const key = (gx + 32768) * 65536 + gy + 32768;
          let l = this.grid.get(key);
          if (!l) { l = []; this.grid.set(key, l); }
          l.push(k);
        }
      }
    }
  }

  /**
   * True when (x, y) at height z lies on a carriageway (within its half width + `margin`) whose surface is
   * within 2.5 m of z -- a lamp on a viaduct does not care about the road underneath.
   */
  contains(x: number, y: number, z: number, margin = 0): boolean {
    const key = (Math.floor(x / CELL) + 32768) * 65536 + Math.floor(y / CELL) + 32768;
    const list = this.grid.get(key);
    if (!list) return false;
    const s = this.seg;
    for (const k of list) {
      const o = k * 7;
      const ax = s[o], ay = s[o + 1], bx = s[o + 3], by = s[o + 4];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0;
      const px = ax + dx * t - x, py = ay + dy * t - y;
      const r = s[o + 6] + margin;
      if (px * px + py * py >= r * r) continue;
      const sz = s[o + 2] + (s[o + 5] - s[o + 2]) * t;
      if (Math.abs(sz - z) < 2.5) return true;
    }
    return false;
  }

  /** True when any corner / the centre of an oriented rectangle (Blender xy, yaw about +z) is on a carriageway. */
  overlapsRect(x: number, y: number, z: number, yaw: number, hx: number, hy: number, margin = 0): boolean {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    if (this.contains(x, y, z, margin)) return true;
    for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0]]) {
      const lx = u * hx, ly = v * hy;
      if (this.contains(x + lx * c - ly * s, y + lx * s + ly * c, z, margin)) return true;
    }
    return false;
  }
}
