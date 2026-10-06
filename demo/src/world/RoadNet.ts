import * as THREE from 'three';
import { fromBlender } from '../config';

/**
 * The drivable network of Tianhe, from roads.json (guangzhou/scripts/export_web.py: OSM ways split at
 * junctions, bridges carrying their deck heights). Right-hand traffic. Shared by Traffic (lanes), Police
 * (routes), Pedestrians (when a crosswalk may be used) and SignalLamps.
 *
 * Lanes: each edge direction gets `fwd` / `back` lanes offset to the right of the centre line, trimmed back
 * from junctions by a radius from the widest road there. Turns are cubic Bézier connectors from the end of
 * an incoming lane to the start of an outgoing one (left turns leftmost lane -> leftmost, right turns
 * rightmost -> rightmost, straight keeps the index). No U-turns; dead ends (the map edge) are exits.
 *
 * Signals: at-grade junctions that touch an arterial (not viaduct nodes, not slip-road splits/merges) run two phases. Approach directions are clustered into two
 * axes (angle mod 180): green 18 s, amber 3 s, all-red 2 s each, offset per junction.
 */
export interface RoadGraph {
  nodes: [number, number, number][];
  edges: { a: number; b: number; hw: string; w: number; name: string | null; fwd: number; back: number; bridge: boolean; pts: [number, number, number][] }[];
}

export type Light = 'green' | 'amber' | 'red';
export type TurnKind = 'left' | 'right' | 'straight';

export const SPEED: Record<string, number> = {
  motorway: 20, trunk: 16.7, primary: 14, secondary: 12.5, tertiary: 11, motorway_link: 11, trunk_link: 10,
  primary_link: 10, secondary_link: 9.5, tertiary_link: 9, unclassified: 8.5, residential: 8, living_street: 4, service: 5.5,
};
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary']);
export const PHASE = { green: 18, amber: 3, allred: 2 };

export class Path {
  readonly pts: THREE.Vector3[];
  readonly cum: number[] = [0];
  constructor(pts: THREE.Vector3[]) {
    this.pts = pts;
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  get length(): number { return this.cum[this.cum.length - 1]; }
  /** Point and unit tangent at arc length s. */
  at(s: number, pos: THREE.Vector3, tan: THREE.Vector3): void {
    s = Math.max(0, Math.min(this.length, s));
    let lo = 1, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < s) lo = mid + 1; else hi = mid; }
    const i = lo, s0 = this.cum[i - 1], s1 = this.cum[i];
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    pos.lerpVectors(this.pts[i - 1], this.pts[i], t);
    tan.subVectors(this.pts[i], this.pts[i - 1]).normalize();
  }
}

export interface RLink { edge: number; to: RNode; len: number; pts: THREE.Vector3[] }
export interface RNode {
  id: number; x: number; y: number; z: number; p: THREE.Vector3;
  deg: number; radius: number; signal: boolean; offset: number; exit: boolean;
  /** cars inside the junction box: car id -> axis group */
  inside: Map<number, number>;
  axis0: THREE.Vector2 | null;
  out: RLink[];
}
/** Anything that occupies a lane or connector (traffic cars): sorted by `s` along it. */
export interface LaneOccupant { s: number; speed: number }
export interface Conn { path: Path; to: Lane; node: RNode; kind: TurnKind; cars: LaneOccupant[] }
export interface Lane {
  id: number; edge: number; hw: string; path: Path; from: RNode; to: RNode; index: number; count: number; speed: number;
  dirIn: THREE.Vector2; dirOut: THREE.Vector2; out: Conn[]; group: number; width: number; cars: LaneOccupant[];
  /** a short link between two signalled nodes of one junction complex: no stop line at its end */
  inner: boolean;
}

export class RoadNet {
  readonly nodes: RNode[] = [];
  readonly lanes: Lane[] = [];
  readonly edges: RoadGraph['edges'];
  private time = 0;
  private readonly grid = new Map<string, RNode[]>();
  private readonly laneGrid = new Map<string, Lane[]>();
  /** lanes of edge e entering node n -> axis group (pedestrian crossings) */
  private readonly entryGroup = new Map<string, number>();
  /** signalled node -> its junction complex id */
  private readonly complex = new Map<number, number>();

  constructor(g: RoadGraph) {
    this.edges = g.edges;
    const maxW = new Map<number, number>(), deg = new Map<number, number>(), major = new Map<number, boolean>();
    const slip = new Set<number>();
    for (const e of g.edges) for (const n of [e.a, e.b]) {
      maxW.set(n, Math.max(maxW.get(n) ?? 0, e.w));
      deg.set(n, (deg.get(n) ?? 0) + 1);
      if (MAJOR.has(e.hw)) major.set(n, true);
      if (e.hw.endsWith('_link')) slip.add(n);
    }
    const T = 2 * (PHASE.green + PHASE.amber + PHASE.allred);
    g.nodes.forEach((p, i) => {
      const d = deg.get(i) ?? 0;
      const node: RNode = {
        id: i, x: p[0], y: p[1], z: p[2], p: fromBlender(p[0], p[1], p[2]), deg: d,
        radius: d >= 3 ? THREE.MathUtils.clamp((maxW.get(i) ?? 8) / 2 + 3, 6, 22) : 0,
        // no lights on viaducts or where slip roads split off / merge (those are give-way merges)
        signal: d >= 3 && !!major.get(i) && p[2] < 0.5 && !slip.has(i), offset: (i * 7.31) % T, exit: d <= 1,
        inside: new Map(), axis0: null, out: [],
      };
      this.nodes.push(node);
      const k = `${Math.floor(p[0] / 100)},${Math.floor(p[1] / 100)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k)!.push(node);
    });
    g.edges.forEach((e, ei) => {
      const len = e.pts.reduce((s, p, k) => k ? s + Math.hypot(p[0] - e.pts[k - 1][0], p[1] - e.pts[k - 1][1]) : 0, 0);
      const fwdPts = e.pts.map((p) => fromBlender(p[0], p[1], p[2]));
      if (e.fwd) this.nodes[e.a].out.push({ edge: ei, to: this.nodes[e.b], len, pts: fwdPts });
      if (e.back) this.nodes[e.b].out.push({ edge: ei, to: this.nodes[e.a], len, pts: [...fwdPts].reverse() });
      const P2 = e.pts.map((p) => new THREE.Vector2(p[0], p[1]));
      const Z = e.pts.map((p) => p[2]);
      const oneway = e.back === 0;
      for (const [dir, n] of [[1, e.fwd], [-1, e.back]] as [number, number][]) {
        if (!n) continue;
        const P = dir > 0 ? P2 : [...P2].reverse();
        const Zd = dir > 0 ? Z : [...Z].reverse();
        const from = this.nodes[dir > 0 ? e.a : e.b], to = this.nodes[dir > 0 ? e.b : e.a];
        const laneW = oneway ? e.w / n : Math.min(3.5, e.w / 2 / n);
        for (let i = 0; i < n; i++) {
          const off = oneway ? -e.w / 2 + laneW * (i + 0.5) : laneW * (i + 0.5);
          const line = offsetRight(P, off).map((q, k) => fromBlender(q.x, q.y, Zd[k] + 0.01));
          const path = trim(line, from.radius, to.radius);
          if (!path) continue;
          const a = path.pts[0], b = path.pts[1], y = path.pts[path.pts.length - 2], z = path.pts[path.pts.length - 1];
          const lane: Lane = {
            id: this.lanes.length, edge: ei, hw: e.hw, path, from, to, index: i, count: n, speed: SPEED[e.hw] ?? 8, width: laneW,
            dirOut: new THREE.Vector2(b.x - a.x, b.z - a.z).normalize(), dirIn: new THREE.Vector2(z.x - y.x, z.z - y.z).normalize(),
            out: [], group: 0, cars: [], inner: false,
          };
          this.lanes.push(lane);
          for (const q of [a, path.pts[Math.floor(path.pts.length / 2)], z]) {
            const k = `${Math.floor(q.x / 100)},${Math.floor(q.z / 100)}`;
            if (!this.laneGrid.has(k)) this.laneGrid.set(k, []);
            const l = this.laneGrid.get(k)!;
            if (!l.includes(lane)) l.push(lane);
          }
        }
      }
    });
    // Junction complexes: OSM maps a big crossing of two dual carriageways as up to four signalled nodes a few
    // metres apart. Run each complex as ONE signal (shared offset and axis reference) and let cars that got
    // a green at the entry drive through its short inner links without stopping again -- otherwise the
    // inner links fill up and the four nodes gridlock each other.
    const parent = this.nodes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    g.edges.forEach((e, ei) => {
      const A = this.nodes[e.a], B = this.nodes[e.b];
      const len = e.pts.reduce((s2, p, k) => k ? s2 + Math.hypot(p[0] - e.pts[k - 1][0], p[1] - e.pts[k - 1][1]) : 0, 0);
      if (A.signal && B.signal && len < 45) {
        parent[find(e.a)] = find(e.b);
        for (const l of this.lanes) if (l.edge === ei) l.inner = true;
      }
    });
    const lead = new Map<number, RNode>();
    for (const n of this.nodes) {
      if (!n.signal) continue;
      const r = find(n.id);
      if (!lead.has(r)) lead.set(r, n);
      n.offset = lead.get(r)!.offset;
      this.complex.set(n.id, r);
    }
    const complexAxis = new Map<number, THREE.Vector2>();
    const byFrom = new Map<number, Lane[]>();
    for (const l of this.lanes) { if (!byFrom.has(l.from.id)) byFrom.set(l.from.id, []); byFrom.get(l.from.id)!.push(l); }
    for (const L of this.lanes) {
      const node = L.to;
      if (!node.axis0) {
        const r = this.complex.get(node.id);
        if (r !== undefined) { if (!complexAxis.has(r)) complexAxis.set(r, L.dirIn.clone()); node.axis0 = complexAxis.get(r)!.clone(); }
        else node.axis0 = L.dirIn.clone();
      }
      const ang = Math.abs(Math.atan2(L.dirIn.x * node.axis0.y - L.dirIn.y * node.axis0.x, L.dirIn.dot(node.axis0)));
      L.group = Math.min(ang, Math.PI - ang) < Math.PI / 4 ? 0 : 1;
      this.entryGroup.set(`${node.id}:${L.edge}`, L.group);
      const edges = new Map<number, Lane[]>();
      for (const M of byFrom.get(node.id) ?? []) {
        if (M.edge === L.edge) continue;
        if (!edges.has(M.edge)) edges.set(M.edge, []);
        edges.get(M.edge)!.push(M);
      }
      for (const lanes of edges.values()) {
        const M0 = lanes[0];
        // three.js xz plane: the Blender y axis is flipped, so a left turn has a negative cross product
        const cross = L.dirIn.x * M0.dirOut.y - L.dirIn.y * M0.dirOut.x;
        if (L.dirIn.dot(M0.dirOut) < -0.85) continue;
        const kind: TurnKind = node.deg < 3 ? 'straight' : cross < -0.35 ? 'left' : cross > 0.35 ? 'right' : 'straight';
        if (kind === 'left' && L.index !== 0) continue;
        if (kind === 'right' && L.index !== L.count - 1) continue;
        const target = kind === 'left' ? lanes.find((m) => m.index === 0)
          : kind === 'right' ? lanes.find((m) => m.index === m.count - 1)
          : lanes.find((m) => m.index === Math.min(L.index, m.count - 1));
        if (!target) continue;
        L.out.push({ path: bezier(L.path.pts[L.path.pts.length - 1], L.dirIn, target.path.pts[0], target.dirOut), to: target, node, kind, cars: [] });
      }
    }
  }

  tick(dt: number): void { this.time += dt; }

  light(node: RNode, group: number): Light {
    const G = PHASE.green, A = PHASE.amber, R = PHASE.allred, T = 2 * (G + A + R);
    const t = (this.time + node.offset) % T;
    const g = t < G + A + R ? 0 : 1;
    const tt = g === 0 ? t : t - (G + A + R);
    if (g !== group) return 'red';
    return tt < G ? 'green' : tt < G + A ? 'amber' : 'red';
  }

  /** May a pedestrian cross road `edge` at signalled junction `node` now? (its traffic red, the other axis green) */
  walk(node: RNode, edge: number): boolean {
    const g = this.entryGroup.get(`${node.id}:${edge}`);
    if (g === undefined) return true;
    return this.light(node, g) === 'red' && this.light(node, 1 - g) === 'green';
  }

  /** Nearest node to Blender (x, y) within maxDist (default: any). */
  nearestNode(x: number, y: number, maxDist = Infinity, filter?: (n: RNode) => boolean): RNode | null {
    let best: RNode | null = null, bd = maxDist;
    const r = Number.isFinite(maxDist) ? Math.ceil(maxDist / 100) : 3;
    const cx = Math.floor(x / 100), cy = Math.floor(y / 100);
    for (let gx = cx - r; gx <= cx + r; gx++) for (let gy = cy - r; gy <= cy + r; gy++) {
      for (const n of this.grid.get(`${gx},${gy}`) ?? []) {
        if (filter && !filter(n)) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        if (d < bd) { bd = d; best = n; }
      }
    }
    if (!best && !Number.isFinite(maxDist)) {
      for (const n of this.nodes) { if (filter && !filter(n)) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < bd) { bd = d; best = n; } }
    }
    return best;
  }

  /** Lanes with a sample point within ~100 m of a three.js position. */
  lanesNear(p: THREE.Vector3): Lane[] {
    const out: Lane[] = [];
    const cx = Math.floor(p.x / 100), cz = Math.floor(p.z / 100);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) for (const l of this.laneGrid.get(`${gx},${gz}`) ?? []) if (!out.includes(l)) out.push(l);
    return out;
  }

  /** A* over junctions along the real road polylines (respecting one-way); three.js points from `from` to `to`. */
  route(from: RNode, to: RNode): THREE.Vector3[] {
    const g = new Map<RNode, number>([[from, 0]]);
    const came = new Map<RNode, RLink>();
    const open: [number, RNode][] = [[Math.hypot(from.x - to.x, from.y - to.y), from]];
    const closed = new Set<RNode>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, cur] = open.splice(bi, 1)[0];
      if (cur === to) break;
      if (closed.has(cur)) continue;
      closed.add(cur);
      for (const l of cur.out) {
        const cost = g.get(cur)! + l.len + (l.to.deg >= 3 ? 8 : 0);
        if (cost < (g.get(l.to) ?? Infinity)) {
          g.set(l.to, cost); came.set(l.to, l);
          open.push([cost + Math.hypot(l.to.x - to.x, l.to.y - to.y), l.to]);
        }
      }
      if (closed.size > 4000) break;
    }
    if (!came.has(to) && from !== to) return [];
    const links: RLink[] = [];
    for (let n = to; n !== from; ) { const l = came.get(n); if (!l) break; links.unshift(l); n = this.nodes[this.edges[l.edge].a] === l.to ? this.nodes[this.edges[l.edge].b] : this.nodes[this.edges[l.edge].a]; }
    const out: THREE.Vector3[] = [from.p.clone()];
    for (const l of links) for (const p of l.pts.slice(1)) if (p.distanceTo(out[out.length - 1]) > 6) out.push(p.clone());
    return out;
  }
}

/** Mitred offset of a 2D polyline (Blender plane), `off` metres to the right of travel. */
function offsetRight(P: THREE.Vector2[], off: number): THREE.Vector2[] {
  const n = P.length, out: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = i > 0 ? P[i].clone().sub(P[i - 1]).normalize() : P[1].clone().sub(P[0]).normalize();
    const b = i < n - 1 ? P[i + 1].clone().sub(P[i]).normalize() : a.clone();
    const d = a.clone().add(b); if (d.lengthSq() < 1e-6) d.copy(a); d.normalize();
    const right = new THREE.Vector2(d.y, -d.x);
    const k = 1 / Math.max(0.4, right.dot(new THREE.Vector2(a.y, -a.x)));
    out.push(P[i].clone().addScaledVector(right, off * k));
  }
  return out;
}

/** Cut `a` metres off the start and `b` off the end of a polyline (keeping at least 2 m). */
function trim(pts: THREE.Vector3[], a: number, b: number): Path | null {
  const full = new Path(pts);
  const L = full.length;
  if (L < 1) return null;
  let s0 = a, s1 = L - b;
  if (s1 - s0 < 2) { const mid = L * (a / Math.max(a + b, 1e-3)); s0 = Math.max(0, mid - 1); s1 = Math.min(L, mid + 1); }
  const out: THREE.Vector3[] = [];
  const p = new THREE.Vector3(), t = new THREE.Vector3();
  full.at(s0, p, t); out.push(p.clone());
  for (let i = 1; i < pts.length - 1; i++) if (full.cum[i] > s0 && full.cum[i] < s1) out.push(pts[i].clone());
  full.at(s1, p, t); out.push(p.clone());
  return out.length >= 2 ? new Path(out) : null;
}

function bezier(p0: THREE.Vector3, d0: THREE.Vector2, p3: THREE.Vector3, d3: THREE.Vector2): Path {
  const k = p0.distanceTo(p3) / 2.6;
  const c1 = p0.clone().add(new THREE.Vector3(d0.x, 0, d0.y).multiplyScalar(k));
  const c2 = p3.clone().sub(new THREE.Vector3(d3.x, 0, d3.y).multiplyScalar(k));
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, u = 1 - t;
    pts.push(new THREE.Vector3()
      .addScaledVector(p0, u * u * u).addScaledVector(c1, 3 * u * u * t).addScaledVector(c2, 3 * u * t * t).addScaledVector(p3, t * t * t));
  }
  return new Path(pts);
}
