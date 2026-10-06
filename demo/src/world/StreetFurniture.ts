import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fromBlender } from '../config';
import type { CityData, RoadGraph } from './City';
import { plainMaterial } from './Materials';
import type { RoadIndex } from './RoadIndex';
import { lodCollapse } from './Trees';
import type { PropColliders, PropKind } from './PropColliders';
import type { MetroExits } from './MetroExits';

/**
 * Street furniture and crossings from the kit (guangzhou/scripts/gz_streetkit.py), placed by rule on the
 * OSM data and instanced in 150 m chunks that join the city's distance culling:
 *
 *   bus shelters  every ~450 m along the arterials, on the pavement facing the kerb (placed first)
 *   railings      municipal guard rails along both kerbs of the arterials, open for 22 m at each junction, at
 *                 every crossing (the zebra's width plus a step) and along each bus stop (passengers board)
 *   bollards      two at each end of every crossing, either side of the zebra band -- never on a walking line
 *   the rest      benches, bins, hydrants, cabinets and planters along the pavements on the building side,
 *                 clear of crossings and at least 1.5 m from lamp posts and tree trunks
 *   tree grates   under every tree within a pavement's width of a road
 *   zebras        painted stripes across every crossing, road paint with wear (the marking surface)
 *   metro         the Guangzhou Metro pavilions and totems at the real entrances (MetroExits); everything else
 *                 keeps off their footprints and the apron in front of the stairs
 */
const CHUNK = 150;
const MAJOR = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

type Place = { proto: string; x: number; y: number; z: number; yaw: number; sx?: number };
type Walk = { nodes: [number, number, number][]; edges: { a: number; b: number; kind: string; pts: [number, number][]; road?: number }[] };

/** Half width of a zebra band (the stripes are 5 m long, across the walking line). */
export const ZEBRA_HALF = 2.5;

/** Line segments in a 20 m grid (Blender xy): distance queries for keep-out corridors. */
export class SegmentGrid {
  private readonly segs: number[][] = [];
  private readonly grid = new Map<string, number[]>();
  add(ax: number, ay: number, bx: number, by: number): void {
    const i = this.segs.length;
    this.segs.push([ax, ay, bx, by]);
    for (let gx = Math.floor((Math.min(ax, bx) - 6) / 20); gx <= Math.floor((Math.max(ax, bx) + 6) / 20); gx++)
      for (let gy = Math.floor((Math.min(ay, by) - 6) / 20); gy <= Math.floor((Math.max(ay, by) + 6) / 20); gy++) {
        const k = `${gx},${gy}`;
        if (!this.grid.has(k)) this.grid.set(k, []);
        this.grid.get(k)!.push(i);
      }
  }
  /** Some segment passes within r of (x, y). */
  near(x: number, y: number, r: number): boolean { return this.test(x, y, r, 0, 1); }
  /** Some segment's walking line, run-outs included and a little beyond (people cut corners), within r. */
  nearLine(x: number, y: number, r: number): boolean { return this.test(x, y, r, -0.1, 1.1); }
  private test(x: number, y: number, r: number, t0: number, t1: number): boolean {
    for (const i of this.grid.get(`${Math.floor(x / 20)},${Math.floor(y / 20)}`) ?? []) {
      const [ax, ay, bx, by] = this.segs[i];
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(t0, Math.min(t1, ((x - ax) * dx + (y - ay) * dy) / L2));
      if ((ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2 < r * r) return true;
    }
    return false;
  }
}

/** Points in a 10 m grid (Blender xy). */
class PointGrid {
  private readonly grid = new Map<string, number[]>();
  add(x: number, y: number): void {
    const k = `${Math.floor(x / 10)},${Math.floor(y / 10)}`;
    if (!this.grid.has(k)) this.grid.set(k, []);
    this.grid.get(k)!.push(x, y);
  }
  near(x: number, y: number, r: number): boolean {
    const cx = Math.floor(x / 10), cy = Math.floor(y / 10);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const l = this.grid.get(`${cx + i},${cy + j}`);
      if (!l) continue;
      for (let k = 0; k < l.length; k += 2) if ((l[k] - x) ** 2 + (l[k + 1] - y) ** 2 < r * r) return true;
    }
    return false;
  }
}

/**
 * How far a metro pavilion's part is drawn (its 25 materials would be 25 draw calls per pavilion): the stairwell,
 * tunnel and hall only up close (you see into the well from the pavement), the fittings from a street away, the
 * silhouette -- granite, red frames, blue roof, sign band -- as far as the pavilion reads at all.
 */
function metroPartDistance(mat: string): number {
  if (/wall|ceiling|led strip|hall floor|gate|lightbox|escalator|step edge/.test(mat)) return 60;
  if (/stainless|mullion|frame hole|downlight|glass|anti-slip|tactile/.test(mat)) return 200;
  return 650;
}

function hash(a: number, b = 0): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Collision shapes per prototype, in the prop's three.js frame (x along, z toward its front; front faces the
 * road): [kind, 'c' circle | 'b' box, cx, cz, r | hx, hz?, height]. Sizes from gz_streetkit.py.
 */
type Shape = [PropKind, 'c' | 'b', number, number, number, number, number];
const SHAPES: Record<string, Shape[]> = {
  railing: [['railing', 'b', 0, 0, 1.0, 0.05, 1.05]],
  bollard: [['bollard', 'c', 0, 0, 0.08, 0, 0.8]],
  bench: [['bench', 'b', 0, -0.05, 0.97, 0.27, 0.64]],
  bin: [['bin', 'b', 0, 0, 0.45, 0.22, 0.92]],
  cabinet: [['cabinet', 'b', 0, 0, 0.44, 0.24, 1.5]],
  planter: [['planter', 'b', 0, 0, 1.03, 0.43, 0.63]],
  hydrant: [['hydrant', 'c', 0, 0, 0.14, 0, 0.81]],
  metro_totem: [['metro', 'b', 0, 0, 0.33, 0.17, 3.5]],
  // the pavilion itself is in the static BVH; these are its bollards (gz_metro.BOLLARDS, Blender -y -> +z)
  metro_exit: [-2.4, -0.8, 0.8, 2.4].map((x): Shape => ['bollard', 'c', x, 6.4, 0.08, 0, 0.9]),
  // the APM stations' open well (gz_streetkit.metro_exit open_): the same bollards; kerb and glass are in the BVH
  metro_exit_open: [-2.4, -0.8, 0.8, 2.4].map((x): Shape => ['bollard', 'c', x, 6.4, 0.08, 0, 0.9]),
  shelter: [
    ['shelter', 'b', 0, -0.8, 4.0, 0.08, 2.6],          // back glass and posts
    ['shelter', 'b', -3.8, -0.2, 0.05, 0.6, 2.5],       // end glass
    ['shelter', 'b', 3.8, -0.25, 0.11, 0.65, 2.6],      // advertising light box
    ['shelter', 'b', -1.5, -0.32, 2.0, 0.16, 0.5],      // bench
    ['shelter', 'c', -4.6, 0.9, 0.06, 0, 3.2],          // stop sign post
  ],
};

export class StreetFurniture {
  readonly group = new THREE.Group();
  counts: Record<string, number> = {};
  /** every placed prop, Blender coordinates (colliders, QA) */
  readonly places: Place[] = [];
  /** crossing corridors (zebra band + 2 m past each kerb), Blender coordinates: later placements keep out of them too */
  readonly crossings = new SegmentGrid();

  constructor(kit: GLTF, city: CityData, walk: Walk, roads: RoadIndex, ground: (x: number, y: number) => number | null, metro: MetroExits | null = null) {
    this.group.name = 'street-furniture';
    const places = this.places;
    const put = (proto: string, x: number, y: number, z: number, yaw: number, sx?: number) => {
      if (metro?.blocks(x, y)) { this.counts.metroKeepOut = (this.counts.metroKeepOut ?? 0) + 1; return; }
      places.push({ proto, x, y, z, yaw, sx });
    };
    // keep-out zones: every crossing is a corridor (its zebra band, 2 m past each kerb)
    const crossings = this.crossings;
    for (const e of walk.edges) {
      if (e.kind !== 'cross' || e.pts.length < 2) continue;
      const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 4) continue;
      const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      crossings.add(a[0] - ux * 2, a[1] - uy * 2, b[0] + ux * 2, b[1] + uy * 2);
    }
    const shelters = this.shelters(city.roads, put);
    this.rails(city.roads, put, (x, y) => crossings.near(x, y, ZEBRA_HALF + 1.3) || shelters.some(([sx, sy]) => (sx - x) ** 2 + (sy - y) ** 2 < 8.5 * 8.5));
    // bollards at both ends of every crossing, just outside the zebra band, and never on another crossing's line
    for (const e of walk.edges) {
      if (e.kind !== 'cross' || e.pts.length < 2) continue;
      const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 4) continue;
      const ux = dx / L, uy = dy / L, px = -uy, py = ux;
      for (const [p, s] of [[a, -1], [b, 1]] as [[number, number], number][]) {
        for (const o of [-(ZEBRA_HALF + 0.8), ZEBRA_HALF + 0.8]) {
          const x = p[0] + ux * s * 0.7 + px * o, y = p[1] + uy * s * 0.7 + py * o;
          if (crossings.nearLine(x, y, 1.0)) continue;
          put('bollard', x, y, 0.15, 0);
        }
      }
    }
    // posts and trunks the pavement props keep 1.5 m away from
    const posts = new PointGrid();
    for (const [x, y] of city.lampPoles) posts.add(x, y);
    for (const [x, y] of city.treePos) posts.add(x, y);
    // pavement props on the building side of every sidewalk
    const kinds: [string, number][] = [['bin', 0.3], ['bench', 0.15], ['hydrant', 0.1], ['cabinet', 0.17], ['planter', 0.28]];
    let seq = 0;
    for (const e of walk.edges) {
      if (e.kind !== 'side') continue;
      let acc = 12 + hash(seq++) * 20;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const [ax, ay] = e.pts[i], [bx, by] = e.pts[i + 1];
        const L = Math.hypot(bx - ax, by - ay);
        let s = acc;
        while (s < L) {
          const t = s / L, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
          const r = roads.nearest(x, y);
          if (r) {
            // away from the road: the side the sidewalk line lies on, 1.3 m further out
            const tx = (bx - ax) / L, ty = (by - ay) / L;
            const nx = -ty, ny = tx;
            const probe = roads.nearest(x + nx * 2, y + ny * 2);
            const out = probe && probe.d > r.d ? 1 : -1;
            const h = hash(seq++, i);
            let c = 0, k = kinds[0][0];
            for (const [name, w] of kinds) { c += w; if (h < c) { k = name; break; } }
            // the prop's front (Blender -Y, three.js +Z) faces the road, i.e. along -out * n
            const yaw = Math.atan2(-out * nx, out * ny);
            const px = x + nx * out * 1.3, py = y + ny * out * 1.3;
            if (!crossings.near(px, py, ZEBRA_HALF + 1.5) && !posts.near(px, py, 1.5)) put(k, px, py, 0.15, yaw);
          }
          s += 18 + hash(seq++) * 22;
        }
        acc = s - L;
      }
    }
    // tree grates under the street trees
    for (const [x, y, z] of city.treePos) {
      const r = roads.nearest(x, y);
      if (r && r.d - r.hw < 7 && z < 0.4) put('grate', x, y, z + 0.005, hash(x, y) * 6.28);
    }
    for (const m of metro?.placements() ?? []) places.push(m);
    // nothing stands in a carriageway (the median side of a dual carriageway, slip roads hugging the kerb)
    const cw = city.carriageway;
    const before = places.length;
    const clear = places.filter((p) => {
      const shapes = SHAPES[p.proto];
      if (!shapes || p.proto.startsWith('metro_exit')) return true;  // placed clear of every carriageway in Blender
      const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      return !shapes.some(([, t, cx, cz, a, b]) => {
        // prop frame (three.js x, z) -> Blender local (x, -z), rotated by yaw about +z
        const x = p.x + cx * c + cz * s, y = p.y + cx * s - cz * c;
        return t === 'c' ? cw.contains(x, y, p.z, a + 0.1) : cw.overlapsRect(x, y, p.z, p.yaw, a, b, 0.1);
      });
    });
    places.length = 0;
    places.push(...clear);
    this.counts.droppedOnRoad = before - clear.length;
    this.instance(kit, places);
    this.zebras(walk, ground);
  }

  /** Walk the arterials' kerbs: `fn(edge, side, at, total)` per side of every major at-grade road. */
  private kerbs(roads: RoadGraph, fn: (e: RoadGraph['edges'][number], side: number, at: (s: number) => { x: number; y: number; tx: number; ty: number }, total: number) => void): void {
    for (const e of roads.edges) {
      if (!MAJOR.has(e.hw) || e.bridge) continue;
      const pts = e.pts;
      const seg: number[] = [0];
      for (let i = 1; i < pts.length; i++) seg.push(seg[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = seg[seg.length - 1];
      if (total < 50) continue;
      const at = (s: number) => {
        let i = 0;
        while (i < seg.length - 2 && seg[i + 1] < s) i++;
        const f = (s - seg[i]) / Math.max(1e-6, seg[i + 1] - seg[i]);
        const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
        const dx = pts[i + 1][0] - pts[i][0], dy = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dy) || 1;
        return { x, y, tx: dx / l, ty: dy / l };
      };
      for (const side of [1, -1]) fn(e, side, at, total);
    }
  }

  /** Bus shelters, facing the kerb, every ~450 m; returns their positions (Blender xy). */
  private shelters(roads: RoadGraph, put: (p: string, x: number, y: number, z: number, yaw: number) => void): [number, number][] {
    const out: [number, number][] = [];
    this.kerbs(roads, (e, side, at, total) => {
      for (let s = 60 + hash(e.a, side) * 200; s < total - 40; s += 450) {
        const p = at(s);
        const nx = -p.ty * side, ny = p.tx * side;
        const x = p.x + nx * (e.w / 2 + 2.3), y = p.y + ny * (e.w / 2 + 2.3);
        put('shelter', x, y, 0.15, Math.atan2(-nx, ny));
        out.push([x, y]);
      }
    });
    return out;
  }

  /** Guard rails along the kerbs, skipping driveway openings and every spot `blocked` says is a gap. */
  private rails(roads: RoadGraph, put: (p: string, x: number, y: number, z: number, yaw: number) => void, blocked: (x: number, y: number) => boolean): void {
    this.kerbs(roads, (e, side, at, total) => {
      const off = e.w / 2 + 0.35;
      for (let s = 22; s < total - 22; s += 2) {
        if (hash(e.a * 3 + side, Math.floor(s / 60)) < 0.12) continue;       // an opening now and then (driveways)
        const p = at(s + 1);
        const nx = -p.ty * side, ny = p.tx * side;
        const x = p.x + nx * off, y = p.y + ny * off;
        if (blocked(x, y)) continue;
        put('railing', x, y, 0.15, Math.atan2(p.ty, p.tx));
      }
    });
  }

  private instance(kit: GLTF, places: Place[]): void {
    kit.scene.updateMatrixWorld(true);
    const protos = new Map<string, THREE.Mesh[]>();
    kit.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let p: THREE.Object3D = m;
      while (p.parent && p.parent !== kit.scene) p = p.parent;
      const key = p.name.replace(/^kit_/, '');
      if (!protos.has(key)) protos.set(key, []);
      // bake the node transform into the geometry so instances only carry placement
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      const mm = new THREE.Mesh(g, m.material);
      mm.name = m.name;
      protos.get(key)!.push(mm);
    });
    // railings: real geometry up close, a baked card (2 triangles) beyond, handed over per instance
    const near = new Map<THREE.Material, THREE.Material>();
    for (const part of protos.get('railing') ?? []) {
      const m = part.material as THREE.Material;
      if (!near.has(m)) near.set(m, lodCollapse(m.clone(), 'near', 0, 70));
      part.material = near.get(m)!;
    }
    const tex = new THREE.TextureLoader().load('assets/street/railing_card.png');
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const cardGeo = new THREE.PlaneGeometry(2.0, 1.05).translate(0, 0.525, 0);
    const cardMat = lodCollapse(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.4, metalness: 0.3 }), 'far', 62, 0);
    protos.get('railing')?.push(new THREE.Mesh(cardGeo, cardMat));
    const byChunk = new Map<string, Place[]>();
    for (const p of places) {
      const k = `${p.proto}|${Math.floor(p.x / CHUNK)},${Math.floor(p.y / CHUNK)}`;
      if (!byChunk.has(k)) byChunk.set(k, []);
      byChunk.get(k)!.push(p);
      this.counts[p.proto] = (this.counts[p.proto] ?? 0) + 1;
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(1, 1, 1);
    for (const [k, list] of byChunk) {
      const proto = k.split('|')[0];
      const parts = protos.get(proto);
      if (!parts) continue;
      const center = new THREE.Vector3();
      for (const p of list) center.add(fromBlender(p.x, p.y, p.z));
      center.divideScalar(list.length);
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) => {
          q.setFromAxisAngle(up, p.yaw);
          m4.compose(fromBlender(p.x, p.y, p.z), q, sc);
          im.setMatrixAt(i, m4);
        });
        im.computeBoundingSphere();
        im.castShadow = proto !== 'grate' && part.material !== cardMat; im.receiveShadow = true;
        const far: Record<string, number> = { railing: 330, shelter: 600, bollard: 170, grate: 150, metro_exit: 650, metro_exit_open: 650, metro_totem: 400 };
        const nearRail = proto === 'railing' && part.material !== cardMat;      // chunks of real rails stop early
        let maxDist = nearRail ? 140 : far[proto] ?? 230;
        if (proto.startsWith('metro_exit')) maxDist = metroPartDistance((part.material as THREE.Material).name);
        (im.userData as { center: THREE.Vector3; maxDist: number }) = { center, maxDist };
        this.group.add(im);
      }
    }
  }

  /** Register every prop's collision shapes. */
  addColliders(props: PropColliders): void {
    for (const p of this.places) {
      const shapes = SHAPES[p.proto];
      if (!shapes) continue;
      const w = fromBlender(p.x, p.y, p.z);
      for (const [kind, t, cx, cz, a, b, h] of shapes) {
        if (t === 'c') {
          const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
          props.addCircle(w.x + cx * c + cz * s, w.z - cx * s + cz * c, a, w.y, w.y + h, kind);
        } else props.addBox(w.x, w.z, p.yaw, cx, cz, a, b, w.y, w.y + h, kind);
      }
    }
  }

  /** Chunks for City.cullChunks. */
  chunks(): { mesh: THREE.InstancedMesh; center: THREE.Vector3; maxDist: number }[] {
    return this.group.children.map((o) => {
      const im = o as THREE.InstancedMesh;
      const u = im.userData as { center: THREE.Vector3; maxDist: number };
      return { mesh: im, center: u.center, maxDist: u.maxDist };
    });
  }

  private zebras(walk: Walk, ground: (x: number, y: number) => number | null): void {
    const mats: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3();
    for (const e of walk.edges) {
      if (e.kind !== 'cross' || e.pts.length < 2) continue;
      const [a, b] = [e.pts[0], e.pts[e.pts.length - 1]];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 4 || L > 60) continue;
      const ux = dx / L, uy = dy / L;
      const n = Math.floor((L - 1.2) / 1.0);
      for (let k = 0; k < n; k++) {
        const t = 0.6 + 0.225 + k * 1.0;
        const x = a[0] + ux * t, y = a[1] + uy * t;
        const z = ground(x, y);
        if (z === null || z > 1.5) continue;
        // stripe: 0.45 m across the walking line, 5 m along the road
        q.setFromAxisAngle(up, Math.atan2(uy, ux));
        mats.push(new THREE.Matrix4().compose(fromBlender(x, y, z + 0.012), q, sc.set(0.45, 1, 5.0)));
      }
    }
    const g = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const mat = plainMaterial('GZ Road | marking white zebra', { color: [0.78, 0.78, 0.76], rough: 0.6, metal: 0, glow: null, noise: null });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
    const im = new THREE.InstancedMesh(g, mat, mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    im.receiveShadow = true;
    im.name = `zebras (${mats.length})`;
    (im.userData as { center: THREE.Vector3; maxDist: number }) = { center: new THREE.Vector3(), maxDist: 1e9 };
    this.group.add(im);
    this.counts.zebra = mats.length;
  }
}
