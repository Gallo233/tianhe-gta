import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fromBlender } from '../config';
import type { Apm, ApmStation } from './Apm';

/**
 * APM service: two-car Innovia APM 100 trains running the in-map line in a loop -- north up the east track
 * (广州塔 -> 妇儿中心, which is the in-map terminus), on into the tunnel, across to the west track out of sight,
 * south calling at every station to 广州塔 (terminus: all change), on to the turnback beyond it, and round again.
 *
 * Stops: the train's centre on the station centre, so its eight doors meet the screen doors. At a stop the doors
 * and the screen doors on the platform side open together (2.5 s), stay open, close (3 s), and the train leaves.
 * Everything is instanced: car bodies, car door leaves and screen-door leaves (one draw call per material).
 *
 * Blender frame for positions (x east, y north, z up): the tracks from apm.json are south -> north, 1 m apart.
 * Car frame (Blender): +Y along +s (north), +X east; door leaves at x = +-(HW - 0.02).
 */
const CAR_HALF = 6.5;                // car centre from the train centre
const HW = 1.425;
const FLOOR = 1.0;
const DOORS = [-3.2, 3.2];           // door centres along a car
const DOOR_W = 1.5;
const PSD_DOORS = [-9.7, -3.3, 3.3, 9.7];
const PSD_W = 1.9;
const VMAX = 15.0, ACC = 1.0, DEC = 1.1;
const OPENING = 2.5, CLOSING = 3.0, OPEN = 15.0, OPEN_TERMINUS = 20.0, TURN = 12.0;
/** car and screen-door dimensions for the passengers (world/ApmPassengers) */
export const APM_CAR = { CAR_HALF, HW, FLOOR, DOORS, DOOR_W, PSD_DOORS, PSD_W } as const;
/** dwell clock (Train.t): the doors are fully open from OPEN_AT until closesAt(t) */
export const OPEN_AT = 1 + OPENING;
export function closesAt(t: { terminus: boolean }): number { return OPEN_AT + (t.terminus ? OPEN_TERMINUS : OPEN); }

export type Phase = 'run' | 'dwell' | 'turn';
export interface Train {
  id: number;
  track: 0 | 1;          // 0 west (southbound), 1 east (northbound)
  s: number;
  v: number;
  phase: Phase;
  t: number;
  doors: number;         // 0 shut .. 1 open
  at: ApmStation | null; // station being served (dwell)
  next: ApmStation | null;
  terminus: boolean;     // this stop ends the run: everybody off
  target: { st: ApmStation; s: number } | null;   // the stop being run to (fixed on departure), null = track end
  cars: THREE.Matrix4[]; // three.js world matrices of the two cars
}

type Proto = { geometry: THREE.BufferGeometry; material: THREE.Material }[];

class Track {
  readonly cum: number[] = [0];
  constructor(readonly pts: number[][]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  get length(): number { return this.cum[this.cum.length - 1]; }
  /** Blender (x, y, z) and unit tangent (tx, ty) at arc length s. */
  at(s: number, out: { x: number; y: number; z: number; tx: number; ty: number }): void {
    const c = this.cum;
    s = Math.max(0, Math.min(this.length, s));
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const f = (s - c[lo]) / Math.max(1e-6, c[hi] - c[lo]);
    const a = this.pts[lo], b = this.pts[hi];
    out.x = a[0] + (b[0] - a[0]) * f; out.y = a[1] + (b[1] - a[1]) * f; out.z = a[2] + (b[2] - a[2]) * f;
    // tangent over +-4 m (smooth through the 1 m polyline)
    const i0 = Math.max(0, lo - 4), i1 = Math.min(this.pts.length - 1, hi + 4);
    const tx = this.pts[i1][0] - this.pts[i0][0], ty = this.pts[i1][1] - this.pts[i0][1], L = Math.hypot(tx, ty) || 1;
    out.tx = tx / L; out.ty = ty / L;
  }
}

export class ApmTrains {
  readonly group = new THREE.Group();
  readonly trains: Train[] = [];
  private readonly tracks: Track[];
  private readonly stops: { st: ApmStation; s: number }[][];     // per track, in travel order
  private readonly carMeshes: THREE.InstancedMesh[] = [];
  private readonly leafMeshes: THREE.InstancedMesh[] = [];
  private readonly psdMeshes: THREE.InstancedMesh[] = [];
  private readonly psdOpen = new Map<string, number>();       // `${station}|${side}` -> 0..1
  private readonly p = { x: 0, y: 0, z: 0, tx: 0, ty: 0 };
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly v3 = new THREE.Vector3();
  /** events for the HUD: arrivals / departures of the train the player is on */
  onStop: ((t: Train) => void) | null = null;
  onDepart: ((t: Train) => void) | null = null;

  constructor(gltf: GLTF, private readonly apm: Apm, count = 4) {
    this.group.name = 'apm trains';
    this.tracks = [new Track(apm.data.tracks.west), new Track(apm.data.tracks.east)];
    const sts = apm.stations;
    this.stops = [
      sts.map((st) => ({ st, s: st.s[0] })).sort((a, b) => b.s - a.s),     // west: southbound, s falling
      sts.map((st) => ({ st, s: st.s[1] })).sort((a, b) => a.s - b.s),     // east: northbound, s rising
    ];
    const proto = (name: string): Proto => {
      const out: Proto = [];
      const node = gltf.scene.getObjectByName(name);
      node?.updateMatrixWorld(true);
      node?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const g = m.geometry.clone();
        // bake the node's own transform relative to the prototype root (the root sits at the origin)
        g.applyMatrix4(new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(m.matrixWorld));
        out.push({ geometry: g, material: m.material as THREE.Material });
      });
      return out;
    };
    const inst = (p: Proto, n: number, list: THREE.InstancedMesh[]) => {
      for (const part of p) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, n);
        im.frustumCulled = false;
        im.castShadow = false; im.receiveShadow = false;
        list.push(im);
        this.group.add(im);
      }
    };
    inst(proto('kit_apm_car'), count * 2, this.carMeshes);
    inst(proto('kit_apm_leaf'), count * 2 * 2 * DOORS.length * 2, this.leafMeshes);
    inst(proto('kit_apm_psd_leaf'), sts.length * 2 * PSD_DOORS.length * 2, this.psdMeshes);
    // four trains spread round the loop: two up the east track, two down the west
    const place: [0 | 1, number][] = [[1, 0], [1, 2], [0, 0], [0, 2]];
    for (let i = 0; i < count; i++) {
      const [track, k] = place[i % place.length];
      const stop = this.stops[track][Math.min(k, this.stops[track].length - 1)];
      this.trains.push({ id: i, track, s: stop.s, v: 0, phase: 'dwell', t: 1 + i * 4.3, doors: 0, at: stop.st, next: stop.st,
        terminus: false, target: null, cars: [new THREE.Matrix4(), new THREE.Matrix4()] });
    }
    this.update(0);
  }

  private dir(t: Train): number { return t.track === 1 ? 1 : -1; }

  /** Next stop at or beyond s in the direction of travel, or null (then the end of the track). */
  private nextStop(t: Train, from: number): { st: ApmStation; s: number } | null {
    const d = this.dir(t);
    for (const k of this.stops[t.track]) if ((k.s - from) * d > 0.5) return k;
    return null;
  }

  private isTerminus(t: Train, st: ApmStation): boolean {
    return (t.track === 1 && st.terminus === 'north') || (t.track === 0 && st.terminus === 'south');
  }

  update(dt: number): void {
    for (const t of this.trains) this.step(t, dt);
    this.writeMatrices();
  }

  private step(t: Train, dt: number): void {
    const d = this.dir(t);
    const tr = this.tracks[t.track];
    if (t.phase === 'dwell') {
      t.t += dt;
      const openFor = t.terminus ? OPEN_TERMINUS : OPEN;
      t.doors = t.t < 1 ? 0 : t.t < 1 + OPENING ? (t.t - 1) / OPENING : t.t < 1 + OPENING + openFor ? 1
        : Math.max(0, 1 - (t.t - 1 - OPENING - openFor) / CLOSING);
      if (t.t > 1.5 + OPENING + openFor + CLOSING) {
        t.phase = 'run'; t.t = 0; t.doors = 0;
        t.target = this.nextStop(t, t.s);
        t.next = t.target ? t.target.st : null;
        this.onDepart?.(t);
        t.at = null;
      }
      return;
    }
    if (t.phase === 'turn') {
      t.t += dt;
      if (t.t > TURN) {
        // across to the other track, out of sight at the end of the modelled tunnel
        const north = t.track === 1;
        t.track = north ? 0 : 1;
        t.s = north ? this.tracks[0].length - 16 : 16;
        t.phase = 'run'; t.t = 0; t.v = 0;
        t.target = this.nextStop(t, t.s);
        t.next = t.target ? t.target.st : null;
      }
      return;
    }
    const stop = t.target;
    const target = stop ? stop.s : (d > 0 ? tr.length - 16 : 16);
    const dist = (target - t.s) * d;
    const vt = Math.min(VMAX, Math.sqrt(2 * DEC * Math.max(0, dist - 0.02)));
    t.v += THREE.MathUtils.clamp(vt - t.v, -DEC * 1.6 * dt, ACC * dt);
    t.v = Math.max(0, t.v);
    t.s += d * t.v * dt;
    if (dist < 0.05 || (t.v < 0.05 && dist < 0.4)) {
      t.s = target; t.v = 0; t.t = 0;
      if (stop) {
        t.phase = 'dwell'; t.at = stop.st; t.terminus = this.isTerminus(t, stop.st);
        this.onStop?.(t);
      } else t.phase = 'turn';
    }
  }

  /** Car centre (Blender) and heading for car k (0 ahead in +s, 1 behind). */
  private carPose(t: Train, k: number): { x: number; y: number; z: number; yaw: number } {
    const tr = this.tracks[t.track];
    tr.at(t.s + (k === 0 ? CAR_HALF : -CAR_HALF), this.p);
    return { x: this.p.x, y: this.p.y, z: this.p.z, yaw: Math.atan2(-this.p.tx, this.p.ty) };
  }

  private writeMatrices(): void {
    let ci = 0, li = 0;
    this.psdOpen.clear();
    for (const t of this.trains) {
      const side = t.track === 1 ? -1 : 1;           // the island is west of the east track, east of the west one
      for (let k = 0; k < 2; k++) {
        const c = this.carPose(t, k);
        this.q.setFromAxisAngle(this.up, c.yaw);
        t.cars[k].compose(fromBlender(c.x, c.y, c.z), this.q, this.one);
        for (const im of this.carMeshes) im.setMatrixAt(ci, t.cars[k]);
        ci++;
        for (const s of [-1, 1]) {
          const open = s === side ? t.doors : 0;
          for (const dz of DOORS) {
            for (const lf of [-1, 1]) {
              const ly = dz + lf * DOOR_W / 4 + lf * open * (DOOR_W / 2 - 0.06);
              // car-local Blender (x, y, 0) -> three local (x, 0, -y)
              this.v3.set(s * (HW - 0.02), 0, -ly);
              this.m4.makeTranslation(this.v3.x, this.v3.y, this.v3.z).premultiply(t.cars[k]);
              for (const im of this.leafMeshes) im.setMatrixAt(li, this.m4);
              li++;
            }
          }
        }
      }
      if (t.phase === 'dwell' && t.at) {
        const key = `${t.at.key}|${t.track}`;
        this.psdOpen.set(key, Math.max(this.psdOpen.get(key) ?? 0, t.doors));
      }
    }
    // screen doors: per station, per side (template x = +IV faces the east track)
    let pi = 0;
    const IV = this.apm.F.island_v;
    for (const st of this.apm.stations) {
      const base = fromBlender(st.x, st.y, 0);
      this.q.setFromAxisAngle(this.up, st.yaw);
      const stM = new THREE.Matrix4().compose(base, this.q, this.one);
      for (const track of [0, 1] as const) {
        const open = this.psdOpen.get(`${st.key}|${track}`) ?? 0;
        const x = track === 1 ? IV : -IV;
        for (const du of PSD_DOORS) {
          for (const lf of [-1, 1]) {
            const u = du + lf * PSD_W / 4 + lf * open * (PSD_W / 2 - 0.06);
            this.m4.makeTranslation(x, 0, -u).premultiply(stM);
            for (const im of this.psdMeshes) im.setMatrixAt(pi, this.m4);
            pi++;
          }
        }
      }
    }
    for (const im of [...this.carMeshes, ...this.leafMeshes, ...this.psdMeshes]) im.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------ passengers
  /**
   * A door the player (three.js position) can step through now: a train at this platform with its doors open,
   * the player at the screen-door line in front of one of its doors. Returns the car and the car-local spot inside.
   */
  boardable(p: THREE.Vector3): { train: Train; car: number; local: THREE.Vector3 } | null {
    const bx = p.x, by = -p.z;
    for (const t of this.trains) {
      if (t.phase !== 'dwell' || t.doors < 0.85 || !t.at || t.terminus) continue;
      const st = t.at;
      if (Math.abs(p.y - this.apm.L.platform) > 0.8) continue;
      const [u, v] = this.apm.toFrame(st, bx, by);
      const IV = this.apm.F.island_v;
      const sideV = t.track === 1 ? -1 : 1;           // island edge facing this train, in v (west +)
      if (v * sideV < IV - 1.0 || v * sideV > IV + 0.3) continue;
      for (const du of PSD_DOORS) {
        if (Math.abs(u - du) > PSD_W / 2 - 0.15) continue;
        const car = du > 0 ? 0 : 1;
        const cy = du - (car === 0 ? CAR_HALF : -CAR_HALF);
        const xSide = t.track === 1 ? -1 : 1;         // car-local x of the platform side
        return { train: t, car, local: new THREE.Vector3(xSide * (HW - 0.75), cy, FLOOR) };
      }
    }
    return null;
  }

  /** three.js world position of a car-local Blender point (x, y, z). */
  carToWorld(t: Train, car: number, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(local.x, local.z, -local.y).applyMatrix4(t.cars[car]);
  }

  /** Heading (three.js yaw) of a car. */
  carYaw(t: Train, car: number): number {
    return this.carPose(t, car).yaw;
  }

  /** Where to put someone stepping off car `car` of a dwelling train through the door nearest `local`. */
  alightPoint(t: Train, car: number, local: THREE.Vector3): THREE.Vector3 | null {
    if (t.phase !== 'dwell' || t.doors < 0.85 || !t.at) return null;
    const st = t.at;
    const du = local.y + (car === 0 ? CAR_HALF : -CAR_HALF);
    const door = PSD_DOORS.reduce((a, b) => (Math.abs(b - du) < Math.abs(a - du) ? b : a));
    const sideV = t.track === 1 ? -1 : 1;
    const b = this.apm.fromFrame(st, door, sideV * (this.apm.F.island_v - 1.5), this.apm.L.platform + 0.05);   // clear of the boarding zone
    return fromBlender(b.x, b.y, b.z);
  }

  /**
   * Camera arm inside a car: distance along a ray (three.js) from inside the car to its inner walls, so the
   * third-person camera never leaves the car.
   */
  insideHit(t: Train, car: number, origin: THREE.Vector3, dir: THREE.Vector3): number {
    const inv = new THREE.Matrix4().copy(t.cars[car]).invert();
    const o = origin.clone().applyMatrix4(inv);
    const d = dir.clone().transformDirection(inv);
    // car interior box in three local: x +-(HW-0.12), y FLOOR..3.0, z +-(6.1)
    const min = [-(HW - 0.12), FLOOR + 0.05, -6.1], max = [HW - 0.12, 2.9, 6.1];
    let tExit = Infinity;
    const oa = [o.x, o.y, o.z], da = [d.x, d.y, d.z];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(da[i]) < 1e-6) continue;
      const tt = ((da[i] > 0 ? max[i] : min[i]) - oa[i]) / da[i];
      if (tt >= 0) tExit = Math.min(tExit, tt);
    }
    return tExit;
  }
}
