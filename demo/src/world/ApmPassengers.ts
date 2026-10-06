import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { CharacterSpec } from '../config';
import { buildPedGeometry, dressRigWith, randomLook } from '../entities/ProceduralPed';
import type { Apm, ApmStation } from './Apm';
import { APM_CAR, OPEN_AT, closesAt, type ApmTrains, type Train } from './ApmTrains';
import type { MetroExits } from './MetroExits';
import { ik2, wpos } from '../entities/Ik';

/**
 * People in the APM: the street crowd's procedural bodies (entities/ProceduralPed) on the protagonists' rigs,
 * a separate pool because the street crowd is hidden underground.
 *
 *   riders    stand in the cars (facing a window, holding the grab rail, on the phone) or sit on the end seats;
 *             carried by the car, every train has some wherever it is
 *   waiters   stand either side of the screen doors of the station the camera is at (the "focus"), front row
 *             first, facing the track; a few sit on the platform benches
 *   walkers   come in from the street (entrance stair, hall, passage), through the gates, down the stair and on
 *             to a free spot by a door; or off a train, up the escalator (some take the stair), out through the
 *             gates and a passage to the street
 *
 * At the focus station a train's dwell is played out: riders get off first (all of them at a terminus), then
 * the waiters on that side board, each to a free spot in the car at their door; whoever has not reached the
 * doorway when the doors start to close steps back. Everywhere else a stop just re-rolls the riders. Walkers
 * enter and leave out of the camera's sight (the frustum, 60 m, or the other level of the station).
 *
 * Sitting, the phone and the grab rail are posed on top of the idle clip with two-bone IK in world space, so
 * they do not depend on the Tripo rig's bone axes. Bodies are shared: a bank of looks per rig, one geometry
 * each, bound to every clone that wears it.
 *
 * Station frame (as world/Apm): u along the line (north), x across (east; = -v), z world height.
 */
type Anim = 'walk' | 'idle' | 'idle_fold';
type Pose = 'stand' | 'fold' | 'phone' | 'hold' | 'sit';
type Act = 'off' | 'walk' | 'wait' | 'sit' | 'ride';
type After = 'wait' | 'sit' | 'board' | 'leave';

interface Leg { a: THREE.Vector3; b: THREE.Vector3; len: number; esc: boolean; stair: boolean }
interface Limbs { thigh: THREE.Bone[]; calf: THREE.Bone[]; foot: THREE.Bone[]; upper: THREE.Bone[]; fore: THREE.Bone[]; hand: THREE.Bone[]; head: THREE.Bone | null }

interface Pax {
  id: number;
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Anim, THREE.AnimationAction>>;
  anim: Anim;
  spec: CharacterSpec;
  scale: number;
  speed: number;
  hipH: number;
  limbs: Limbs;
  act: Act;
  pose: Pose;
  yaw: number;
  animAcc: number;
  seen: boolean;
  floorY: number;
  // walking
  legs: Leg[]; leg: number; f: number; after: After; delay: number; blockT: number; ghostT: number;
  inLeg: number;         // boarding: first leg inside the car (before it the walker is still on the platform)
  gateLeg: number;       // leaving: first leg past the gates
  // station
  slot: number; seat: number; side: number;
  // riding
  train: Train | null; car: number; spot: number; fx: number; fy: number;
}

/** A rider's place in a car (car-local Blender x across, y along +s) and whether it is a seat. */
interface Spot { x: number; y: number; sit: boolean }

const { CAR_HALF, HW, FLOOR, DOORS, PSD_DOORS } = APM_CAR;
const POOL = 84;
const LOOKS = 8;                     // bodies per rig
const ESC_SPEED = 0.7;
const SEAT_TOP = 0.5;                // car seat above the car floor
const BENCH_TOP = 0.455;             // platform bench above the platform
const RAIL_H = 1.7;                  // grab rail above the car floor
const SLOT_X = [3.55, 3.05];         // front / back row of the queues either side of each screen door
const LANE_X = 2.4;                  // walking line along the platform between the queues and the stair bank
const SDX = -1.45, SUX = -0.6, EX = 1.025;   // stair down / stair up / escalator lines (x)
const COLS: [number, number][] = [];         // concourse columns (u, x)
for (const x of [-5.5, 5.5]) for (const u of [-28, -20, -12, -4, 4, 12, 20, 28]) COLS.push([u, x]);
const BENCHES = [{ u: 9.5, face: 1 }, { u: 17.5, face: -1 }, { u: -14.0, face: 1 }];
const SEAT_DU = [-0.45, 0.45];          // two places on each 1.9 m bench

const SPOTS: Spot[] = [
  ...[-1.7, -0.5, 0.75, 1.9].flatMap((y) => [{ x: 0.62, y, sit: false }, { x: -0.62, y, sit: false }]),
  ...[-4.5, 4.5].flatMap((y) => [{ x: 0.45, y, sit: false }, { x: -0.45, y, sit: false }]),
  ...[-1, 1].flatMap((e) => [-1, 1].flatMap((s) => [-0.33, 0.33].map((d) => ({ x: s * 1.12, y: e * 5.3 + d, sit: true })))),
];

// route point: station-frame u, x, world z, flags
const J = 1, ESC = 2;
type RP = [number, number, number, number];

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _p = new THREE.Vector3(), _v = new THREE.Vector3();
const _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _s = new THREE.Vector3();
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

function hourFactor(h: number): number {
  const x = ((h % 24) + 24) % 24;
  if (x < 6.5 || x > 23.2) return 0.3;
  if ((x > 7.5 && x < 9.6) || (x > 17.4 && x < 19.6)) return 1.5;
  return 1;
}

export class ApmPassengers {
  readonly group = new THREE.Group();
  private readonly pool: Pax[] = [];
  private readonly bank: THREE.BufferGeometry[][] = [[], [], []];
  private building = true;
  private focus: ApmStation | null = null;
  private slots: (Pax | null)[] = [];             // side (0 west, 1 east) * 16 + door * 4 + k
  private seats: (Pax | null)[] = [];             // bench * 2 + k
  private readonly spots = new Map<number, (Pax | null)[][]>();   // train id -> [car][spot]
  private readonly dwellN = new Map<number, number>();
  private readonly prevPhase = new Map<number, string>();
  private readonly served = new Map<number, string>();
  private readonly boarded = new Map<number, string>();
  private readonly frustum = new THREE.Frustum();
  private readonly m4 = new THREE.Matrix4();
  private readonly cam = new THREE.Vector3();
  private spawnT = 0;
  private seeded = false;
  private hour = 12;
  private readonly passages: Map<string, { exit: string; st: ApmStation }[]> = new Map();

  constructor(private readonly specs: CharacterSpec[], private readonly rigs: GLTF[], private readonly apm: Apm,
    private readonly trains: ApmTrains, private readonly metro: MetroExits, private readonly rng: () => number) {
    this.group.name = 'apm passengers';
    this.group.visible = false;
    for (const t of trains.trains) this.spots.set(t.id, [SPOTS.map(() => null), SPOTS.map(() => null)]);
    for (const id of Object.keys(apm.data.passages)) {
      const last = apm.data.passages[id][apm.data.passages[id].length - 1];
      const st = apm.stations.reduce((a, b) => ((b.x - last[0]) ** 2 + (b.y - last[1]) ** 2 < (a.x - last[0]) ** 2 + (a.y - last[1]) ** 2 ? b : a));
      if (!this.metro.exits.find((e) => e.id === id)) continue;
      const list = this.passages.get(st.key) ?? [];
      list.push({ exit: id, st });
      this.passages.set(st.key, list);
    }
  }

  get count(): number { return this.pool.filter((a) => a.act !== 'off').length; }
  /** the station people are being shown at (the camera's), or null */
  get focusKey(): string | null { return this.focus?.key ?? null; }

  // ------------------------------------------------------------------------------------------ pool
  /**
   * Build more people for up to `budgetMs` (spread over ~30 frames the first time the camera nears an APM
   * entrance; building a body is ~2 ms, cloning a rig ~1 ms).
   */
  private grow(budgetMs: number): void {
    const rng = this.rng;
    const t0 = performance.now();
    while (this.pool.length < POOL && performance.now() - t0 < budgetMs) {
      const r = rng();
      const k = r < 0.45 ? 1 : r < 0.75 ? 0 : 2;
      const model = cloneSkinned(this.rigs[k].scene);
      model.rotation.y = -Math.PI / 2;
      let bank = this.bank[k];
      const mesh = dressRigWith(model, (sk) => {
        if (bank.length < LOOKS) { const g = buildPedGeometry(sk, randomLook(rng, k === 1)); bank.push(g); return g; }
        return bank[Math.floor(rng() * bank.length)];
      });
      bank = this.bank[k];
      mesh.castShadow = false;
      const scale = 0.94 + rng() * 0.12;
      model.scale.multiplyScalar(scale);
      const root = new THREE.Group();
      root.add(model);
      root.visible = false;
      this.group.add(root);
      const mixer = new THREE.AnimationMixer(model);
      const actions: Partial<Record<Anim, THREE.AnimationAction>> = {};
      for (const name of ['walk', 'idle', 'idle_fold'] as Anim[]) {
        const clip = this.rigs[k].animations.find((c) => c.name === name);
        if (clip) actions[name] = mixer.clipAction(clip);
      }
      const bone = (n: string) => model.getObjectByName(n) as THREE.Bone;
      const limbs: Limbs = {
        thigh: [bone('L_Thigh'), bone('R_Thigh')], calf: [bone('L_Calf'), bone('R_Calf')], foot: [bone('L_Foot'), bone('R_Foot')],
        upper: [bone('L_Upperarm'), bone('R_Upperarm')], fore: [bone('L_Forearm'), bone('R_Forearm')], hand: [bone('L_Hand'), bone('R_Hand')],
        head: (model.getObjectByName('Head') as THREE.Bone) ?? null,
      };
      const idle = actions.idle!;
      idle.play();
      mixer.update(0);
      root.updateMatrixWorld(true);
      const hipH = wpos(limbs.thigh[0], _a).y - root.position.y;
      idle.time = rng() * idle.getClip().duration;
      const spec = this.specs[k];
      this.pool.push({
        id: this.pool.length, root, mixer, actions, anim: 'idle', spec, scale, speed: spec.walkSpeed * scale * (0.9 + rng() * 0.2),
        hipH, limbs, act: 'off', pose: 'stand', yaw: 0, animAcc: 0, seen: false, floorY: 0,
        legs: [], leg: 0, f: 0, after: 'leave', delay: 0, blockT: 0, ghostT: 0, inLeg: -1, gateLeg: -1,
        slot: -1, seat: -1, side: 0, train: null, car: 0, spot: -1, fx: 0, fy: 1,
      });
    }
    if (this.pool.length >= POOL) this.building = false;
  }

  private free(): Pax | null {
    for (const a of this.pool) if (a.act === 'off') return a;
    return null;
  }

  private freeCount(): number {
    let n = 0;
    for (const a of this.pool) if (a.act === 'off') n++;
    return n;
  }

  private release(a: Pax): void {
    if (a.slot >= 0 && this.slots[a.slot] === a) this.slots[a.slot] = null;
    if (a.seat >= 0 && this.seats[a.seat] === a) this.seats[a.seat] = null;
    if (a.train && a.spot >= 0) {
      const sp = this.spots.get(a.train.id)![a.car];
      if (sp[a.spot] === a) sp[a.spot] = null;
    }
    a.act = 'off'; a.slot = -1; a.seat = -1; a.train = null; a.spot = -1; a.legs = [];
    a.root.visible = false;
  }

  private play(a: Pax, anim: Anim, fade = 0.3): void {
    if (!a.actions[anim]) anim = 'idle';
    if (a.anim === anim) return;
    const from = a.actions[a.anim]!, to = a.actions[anim]!;
    to.reset().play();
    to.time = this.rng() * to.getClip().duration;
    from.crossFadeTo(to, fade, false);
    a.anim = anim;
  }

  private standPose(a: Pax, inCar: boolean): Pose {
    const r = this.rng();
    if (inCar && r < 0.35) return 'hold';
    if (r < 0.62) return 'phone';
    return a.actions.idle_fold && r < 0.8 ? 'fold' : 'stand';
  }

  // ------------------------------------------------------------------------------------------ geometry
  /** Station frame -> three.js world. */
  private sp(st: ApmStation, u: number, x: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(st.x + st.tx * u + st.ty * x, z, -(st.y + st.ty * u - st.tx * x));
  }

  /** Blender (x, y) -> station frame (u, x). */
  private toSt(st: ApmStation, bx: number, by: number): [number, number] {
    const [u, v] = this.apm.toFrame(st, bx, by);
    return [u, -v];
  }

  private slotPos(i: number): [number, number, number] {
    const side = i < 16 ? -1 : 1;
    const k = i % 4, door = PSD_DOORS[Math.floor((i % 16) / 4)];
    return [door + (k % 2 ? 1.3 : -1.3), side * SLOT_X[k < 2 ? 0 : 1], side];
  }

  /** Sides of the island where people wait: not the arrival side at a terminus. */
  private boardingSides(st: ApmStation): number[] {
    return st.terminus === 'north' ? [-1] : st.terminus === 'south' ? [1] : [-1, 1];
  }

  private sideOf(t: Train): number { return t.track === 1 ? 1 : -1; }

  /** Push concourse legs clear of the columns (0.8 m). */
  private avoidCols(pts: RP[], CZ: number): RP[] {
    const out: RP[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = out[out.length - 1], b = pts[i];
      if (Math.abs(a[2] - CZ) < 0.3 && Math.abs(b[2] - CZ) < 0.3) {
        const du = b[0] - a[0], dx = b[1] - a[1], L2 = du * du + dx * dx;
        for (const [cu, cx] of COLS) {
          if (L2 < 1e-6) break;
          const t = THREE.MathUtils.clamp(((cu - a[0]) * du + (cx - a[1]) * dx) / L2, 0, 1);
          const pu = a[0] + du * t - cu, px = a[1] + dx * t - cx, d = Math.hypot(pu, px);
          if (d < 0.8 && t > 0.02 && t < 0.98) {
            const nu = d > 1e-3 ? pu / d : -dx / Math.sqrt(L2), nx = d > 1e-3 ? px / d : du / Math.sqrt(L2);
            out.push([cu + nu * 1.1, cx + nx * 1.1, CZ, J]);
            break;
          }
        }
      }
      out.push(b);
    }
    return out;
  }

  /** Blender polyline shifted `off` m to the right of its direction of travel. */
  private offsetLine(pts: number[][], off: number): number[][] {
    return pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
      return [p[0] + (dy / L) * off, p[1] - (dx / L) * off];
    });
  }

  /** Street -> entrance stair -> hall -> passage -> concourse end (station frame), or the reverse. */
  private exitRoute(st: ApmStation, exitId: string, inbound: boolean): RP[] {
    const e = this.metro.exits.find((x) => x.id === exitId)!;
    const L = this.metro.L, CZ = this.apm.L.concourse;
    const sx = inbound ? -1.7 : -0.85;
    const loc = (lx: number, ly: number, lz: number, f: number): RP => {
      const [x, y, z] = this.metro.local(e, lx, ly, lz);
      const [u, xs] = this.toSt(st, x, y);
      return [u, xs, z, f];
    };
    const street: RP[] = [loc(sx, -10.5, 0, J), loc(sx, -7.2, 0, 0), loc(sx, -5.3, L.plat_z, 0), loc(sx, L.pit[2], L.plat_z, 0),
      loc(sx, L.stair_end, L.floor_z, 0), loc(-0.4, L.stair_end + 1.6, L.floor_z, J)];
    let pl = this.apm.data.passages[exitId].map((p) => [p[0], p[1]]);
    if (!inbound) pl = pl.reverse();
    pl = this.offsetLine(pl, 0.75 + (this.rng() - 0.5) * 0.4);
    const pas: RP[] = pl.map((p) => { const [u, x] = this.toSt(st, p[0], p[1]); return [u, x, CZ, 0]; });
    return inbound ? [...street, ...pas] : [...pas, ...street.reverse()];
  }

  /** Concourse end of a passage (station frame) for choosing the gate line. */
  private passageEnd(st: ApmStation, exitId: string): [number, number] {
    const pl = this.apm.data.passages[exitId];
    const p = pl[pl.length - 1];
    return this.toSt(st, p[0], p[1]);
  }

  /** From a passage end in the concourse through a gate line and down the stair to the platform. */
  private inConcourse(E: [number, number]): RP[] {
    const F = this.apm.F, CZ = this.apm.L.concourse, PZ = this.apm.L.platform;
    const north = E[0] > 0, gu = north ? F.paid_u[1] : F.paid_u[0], o = north ? 1 : -1;
    const xc = [-3.6, -2.4, -1.2, 0][Math.floor(this.rng() * 4)];
    const top = F.stair_top, foot = top - 2 * (CZ - PZ);
    const pts: RP[] = [[gu + o * 2.0, xc, CZ, J], [gu + o * 0.8, xc, CZ, 0], [gu - o * 0.8, xc, CZ, 0], [gu - o * 2.0, xc, CZ, J]];
    if (!north) pts.push([-9.0, -3.3, CZ, J], [1.6, -3.3, CZ, J], [2.4, -2.3, CZ, 0]);
    pts.push([2.4, SDX, CZ, 0], [top, SDX, CZ, 0], [foot, SDX, PZ, 0], [foot - 0.9, SDX, PZ, 0]);
    return pts;
  }

  /** From the top of the escalator (or the stair) to a gate line and on to a passage end. */
  private outConcourse(E: [number, number], x0: number): { pts: RP[]; gate: number } {
    const F = this.apm.F, CZ = this.apm.L.concourse;
    const north = E[0] > 0, gu = north ? F.paid_u[1] : F.paid_u[0], o = north ? 1 : -1;
    const xc = [1.2, 2.4, 3.6, 0][Math.floor(this.rng() * 4)];
    const pts: RP[] = [[2.3, x0, CZ, 0]];
    if (!north) pts.push([1.7, 3.3, CZ, J], [-9.0, 3.3, CZ, J]);
    pts.push([gu - o * 2.0, xc, CZ, J], [gu - o * 0.8, xc, CZ, 0]);
    const gate = pts.length;
    pts.push([gu + o * 0.8, xc, CZ, 0], [gu + o * 2.0, xc, CZ, J]);
    return { pts, gate };
  }

  /** From a screen door (side, door u) up to the concourse: escalator, or now and then the stair. */
  private upFromPlatform(side: number, du: number): { pts: RP[]; x0: number } {
    const F = this.apm.F, CZ = this.apm.L.concourse, PZ = this.apm.L.platform;
    const top = F.stair_top, foot = top - 2 * (CZ - PZ);
    const run = (CZ - PZ) / Math.tan(Math.PI / 6);
    const pts: RP[] = [[du, side * 3.7, PZ, 0], [du, side * LANE_X, PZ, 0], [foot - 1.5, side * LANE_X, PZ, 0]];
    if (this.rng() < 0.75) {
      pts.push([foot - 1.6, EX, PZ, 0], [top - 1.0 - run - 0.9, EX, PZ, 0], [top - 1.0 - run, EX, PZ, ESC], [top - 1.0, EX, CZ, ESC], [top, EX, CZ, ESC]);
      return { pts, x0: EX };
    }
    pts.push([foot - 1.4, SUX, PZ, 0], [foot, SUX, PZ, 0], [top, SUX, CZ, 0]);
    return { pts, x0: SUX };
  }

  /** Station-frame route -> legs (world), with a little per-person scatter at the open points. */
  private legsOf(st: ApmStation, pts: RP[], jitter = 0.28): Leg[] {
    const CZ = this.apm.L.concourse;
    const r = this.avoidCols(pts, CZ);
    const w = r.map((p) => {
      const j = p[3] & J ? jitter : 0;
      return this.sp(st, p[0] + (this.rng() - 0.5) * 2 * j, p[1] + (this.rng() - 0.5) * 2 * j, p[2]);
    });
    const legs: Leg[] = [];
    for (let i = 0; i < w.length - 1; i++) {
      const len = w[i].distanceTo(w[i + 1]);
      if (len < 1e-3) continue;
      legs.push({ a: w[i], b: w[i + 1], len, esc: !!(r[i][3] & ESC) && !!(r[i + 1][3] & ESC), stair: Math.abs(w[i + 1].y - w[i].y) > 0.3 });
    }
    return legs;
  }

  private worldLegs(pts: THREE.Vector3[]): Leg[] {
    const legs: Leg[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = pts[i].distanceTo(pts[i + 1]);
      if (len > 1e-3) legs.push({ a: pts[i], b: pts[i + 1], len, esc: false, stair: false });
    }
    return legs;
  }

  // ------------------------------------------------------------------------------------------ routes
  /** A newcomer: from an entrance (or from partway along) to a free queue spot or bench seat. */
  private inbound(st: ApmStation, a: Pax, target: { slot: number } | { seat: number }, startAt: 'hidden' | number): boolean {
    const pas = this.passages.get(st.key);
    if (!pas?.length) return false;
    const PZ = this.apm.L.platform;
    const tries = pas.slice().sort(() => this.rng() - 0.5);
    for (const { exit } of tries) {
      const E = this.passageEnd(st, exit);
      const pts = [...this.exitRoute(st, exit, true), ...this.inConcourse(E)];
      const foot = pts[pts.length - 1];
      if ('slot' in target) {
        const [su, sx, side] = this.slotPos(target.slot);
        pts.push([foot[0] - 0.6, side * LANE_X * 0.6, PZ, J], [Math.min(su, foot[0] - 0.6), side * LANE_X, PZ, 0], [su, side * LANE_X, PZ, 0], [su, sx, PZ, 0]);
      } else {
        const b = BENCHES[Math.floor(target.seat / 2)], du = SEAT_DU[target.seat % 2];
        const lane = b.face * LANE_X;
        pts.push([foot[0] - 0.6, lane * 0.6, PZ, J], [Math.min(b.u, foot[0] - 0.6), lane, PZ, 0], [b.u + du, lane, PZ, 0], [b.u + du, b.face * 0.4, PZ, 0]);
      }
      const legs = this.legsOf(st, pts);
      // where to start: out of sight, as far along as possible up to the platform stair
      let s0 = 0;
      const total = legs.reduce((s, l) => s + l.len, 0);
      if (startAt === 'hidden') {
        const cands: number[] = [];
        let acc = 0;
        for (const l of legs) {
          for (let d = 0; d < l.len; d += 2.5) {
            _v.lerpVectors(l.a, l.b, d / l.len);
            if (_v.y < this.apm.L.concourse - 0.5) break;
            // out of sight, not at the camera's elbow, and not on top of someone already walking there
            if (!this.visible(_v, 1.5) && _v.distanceToSquared(this.cam) > 144 && !this.crowded(_v, 1.3)) cands.push(acc + d);
          }
          acc += l.len;
        }
        if (!cands.length) continue;
        // mostly the hidden point nearest the platform (the paid side of the concourse when the camera is
        // downstairs), sometimes farther back so they do not all appear in one place
        s0 = this.rng() < 0.6 ? cands[cands.length - 1] : cands[Math.floor(cands.length * (0.4 + 0.6 * this.rng()))];
      } else {
        // placed partway along (first look at a station): a few tries for a spot nobody stands on
        s0 = total * startAt;
        for (let k = 0; k < 6; k++) {
          const at = this.pointAt(legs, s0);
          if (!this.crowded(at, 1.3)) break;
          s0 = total * (0.2 + 0.7 * this.rng());
        }
      }
      this.startWalk(a, legs, s0, 'slot' in target ? 'wait' : 'sit');
      if ('slot' in target) { a.slot = target.slot; this.slots[target.slot] = a; a.side = this.slotPos(target.slot)[2]; }
      else { a.seat = target.seat; this.seats[target.seat] = a; }
      return true;
    }
    return false;
  }

  /** Off a train (station-frame screen door) -> up -> gates -> passage -> street. */
  private outbound(st: ApmStation, side: number, du: number, prefix: THREE.Vector3[], fromLane = false): { legs: Leg[]; gate: number } | null {
    const pas = this.passages.get(st.key);
    if (!pas?.length) return null;
    const { exit } = pas[Math.floor(this.rng() * pas.length)];
    const E = this.passageEnd(st, exit);
    const up = this.upFromPlatform(side, du);
    if (fromLane) up.pts.shift();
    const con = this.outConcourse(E, up.x0);
    const ex = this.exitRoute(st, exit, false);
    const station = this.legsOf(st, [...up.pts, ...con.pts, ...ex]);
    const pre = prefix.length ? this.worldLegs([...prefix, station[0].a]) : [];
    // the gate crossing: count legs up to it (avoidCols may add points before it, so find it by position)
    const gp = this.sp(st, con.pts[con.gate][0], con.pts[con.gate][1], con.pts[con.gate][2]);
    let gate = station.findIndex((l) => l.b.distanceTo(gp) < 0.6);
    if (gate < 0) gate = Math.floor(station.length / 2);
    return { legs: [...pre, ...station], gate: pre.length + gate + 1 };
  }

  /** Anyone (walking, waiting or sitting) within r m of p, on the same floor. */
  private crowded(p: THREE.Vector3, r: number): boolean {
    for (const o of this.pool) {
      if (o.act === 'off' || o.act === 'ride') continue;
      const q = o.root.position;
      if (Math.abs(q.y - p.y) < 1.5 && (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < r * r) return true;
    }
    return false;
  }

  private pointAt(legs: Leg[], s: number): THREE.Vector3 {
    for (const l of legs) {
      if (s <= l.len) return new THREE.Vector3().lerpVectors(l.a, l.b, s / l.len);
      s -= l.len;
    }
    return legs[legs.length - 1].b.clone();
  }

  private startWalk(a: Pax, legs: Leg[], s0: number, after: After): void {
    a.act = 'walk'; a.after = after; a.legs = legs; a.leg = 0; a.f = s0; a.delay = 0; a.blockT = 0; a.ghostT = 0;
    a.inLeg = -1; a.gateLeg = -1; a.pose = 'stand';
    while (a.leg < legs.length - 1 && a.f > legs[a.leg].len) { a.f -= legs[a.leg].len; a.leg++; }
    a.f = Math.min(a.f, legs[a.leg].len);
    const l = legs[a.leg];
    a.root.position.lerpVectors(l.a, l.b, a.f / l.len);
    a.yaw = Math.atan2(l.b.x - l.a.x, l.b.z - l.a.z);
    a.root.rotation.set(0, a.yaw, 0);
    this.play(a, 'walk', 0.01);
  }

  // ------------------------------------------------------------------------------------------ riders
  private spotsOf(t: Train, car: number): (Pax | null)[] { return this.spots.get(t.id)![car]; }

  private freeSpot(t: Train, car: number, preferStand: boolean): number {
    const sp = this.spotsOf(t, car);
    const ids = SPOTS.map((_, i) => i).filter((i) => !sp[i]).sort(() => this.rng() - 0.5);
    if (!ids.length) return -1;
    const pick = ids.find((i) => SPOTS[i].sit !== preferStand);
    return pick ?? ids[0];
  }

  private seatRider(a: Pax, t: Train, car: number, spot: number): void {
    const s = SPOTS[spot];
    a.act = 'ride'; a.train = t; a.car = car; a.spot = spot; a.legs = [];
    this.spotsOf(t, car)[spot] = a;
    if (s.sit) { a.pose = 'sit'; a.fx = -Math.sign(s.x); a.fy = 0; }
    else {
      a.pose = this.standPose(a, true);
      const r = this.rng();
      if (a.pose === 'hold' || r < 0.5) { a.fx = Math.sign(s.x); a.fy = (this.rng() - 0.5) * 0.4; }
      else { a.fx = (this.rng() - 0.5) * 0.5; a.fy = r < 0.75 ? 1 : -1; }
      if (Math.abs(s.y) > 4) { a.fx = -Math.sign(s.x) * 0.3; a.fy = -Math.sign(s.y); if (a.pose === 'hold') a.pose = 'phone'; }
    }
    this.play(a, a.pose === 'fold' ? 'idle_fold' : 'idle');
  }

  private riders(t: Train): Pax[] { return this.pool.filter((a) => a.act === 'ride' && a.train === t); }

  /** Everywhere the dwell is not watched: some get off, some get on. */
  private reroll(t: Train): void {
    for (const a of this.riders(t)) if (t.terminus || this.rng() < 0.35) this.release(a);
    if (!t.terminus) this.fill(t);
  }

  /** Top a train up to a few riders per car from the free pool (keeping enough back for the focus station). */
  private fill(t: Train): void {
    const reserve = this.focus ? 18 : 4;
    for (let car = 0; car < 2; car++) {
      const want = Math.round((2 + this.rng() * 5) * Math.min(1.3, hourFactor(this.hour)));
      let have = this.spotsOf(t, car).filter(Boolean).length;
      while (have < want && this.freeCount() > reserve) {
        const a = this.free()!;
        const spot = this.freeSpot(t, car, this.rng() < 0.6);
        if (spot < 0) break;
        this.seatRider(a, t, car, spot);
        have++;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ dwell at the focus
  private alight(t: Train): void {
    const st = t.at!;
    const side = this.sideOf(t);
    const xSide = t.track === 1 ? -1 : 1;
    let k = 0;
    for (const a of this.riders(t)) {
      if (!t.terminus && this.rng() > 0.4) continue;
      const s = SPOTS[a.spot];
      const cy = DOORS.reduce((p, d) => (Math.abs(d - s.y) < Math.abs(p - s.y) ? d : p));
      const du = cy + (a.car === 0 ? CAR_HALF : -CAR_HALF);
      const here = this.trains.carToWorld(t, a.car, new THREE.Vector3(s.x * (s.sit ? 0.55 : 1), s.y, FLOOR), new THREE.Vector3());
      const door = this.trains.carToWorld(t, a.car, new THREE.Vector3(xSide * (HW - 0.45), cy + (this.rng() - 0.5) * 0.5, FLOOR), new THREE.Vector3());
      const out = this.outbound(st, side, du, [here, door]);
      if (!out) continue;
      const car = a.car;
      this.spotsOf(t, car)[a.spot] = null;
      a.train = null; a.spot = -1;
      a.floorY = this.apm.L.platform;
      this.startWalk(a, out.legs, 0, 'leave');
      a.gateLeg = out.gate;
      a.delay = 0.2 + k * 0.45 + this.rng() * 0.5;
      k++;
    }
  }

  private board(t: Train): void {
    if (t.terminus) return;
    const st = t.at!;
    const side = this.sideOf(t);
    const xSide = t.track === 1 ? -1 : 1;
    const PZ = this.apm.L.platform;
    const left = closesAt(t) - t.t - 1.2;
    const waiting = this.pool.filter((a) => a.act === 'wait' && a.side === side && a.slot >= 0)
      .sort((p, q) => (this.slotPos(p.slot)[1] * side > this.slotPos(q.slot)[1] * side ? -1 : 1));
    for (const a of waiting) {
      const [su, sx] = this.slotPos(a.slot);
      const di = Math.floor((a.slot % 16) / 4), du = PSD_DOORS[di];
      const car = du > 0 ? 0 : 1;
      const cy = du - (car === 0 ? CAR_HALF : -CAR_HALF);
      const spot = this.freeSpot(t, car, this.rng() < 0.55);
      if (spot < 0) continue;
      const s = SPOTS[spot];
      const pts = [
        this.sp(st, su, sx, PZ),
        this.sp(st, du + Math.sign(su - du) * 0.35, side * 3.75, PZ),
        this.sp(st, du + Math.sign(su - du) * 0.15, side * 4.05, PZ),
        this.trains.carToWorld(t, car, new THREE.Vector3(xSide * (HW - 0.45), cy + Math.sign(su - du) * 0.2, FLOOR), new THREE.Vector3()),
        this.trains.carToWorld(t, car, new THREE.Vector3(s.x * (s.sit ? 0.55 : 1), s.y, FLOOR), new THREE.Vector3()),
      ];
      const legs = this.worldLegs(pts);
      const back = Math.abs(sx) < SLOT_X[0] - 0.1;
      const delay = (back ? 1.2 : 0.1) + this.rng() * 0.9;
      const need = legs.slice(0, 3).reduce((q, l) => q + l.len, 0) / a.speed + delay;
      if (need > left) continue;
      this.slots[a.slot] = null; a.slot = -1;
      this.startWalk(a, legs, 0, 'board');
      a.inLeg = 3; a.delay = delay;
      a.train = t; a.car = car; a.spot = spot;
      this.spotsOf(t, car)[spot] = a;
    }
  }

  /** The doors are closing: whoever is still on the platform side steps back to a queue spot. */
  private stepBack(t: Train): void {
    const st = t.at;
    for (const a of this.pool) {
      if (a.act !== 'walk' || a.after !== 'board' || a.train !== t || a.leg >= a.inLeg) continue;
      this.spotsOf(t, a.car)[a.spot] = null;
      a.train = null; a.spot = -1;
      const slot = st ? this.freeSlot(this.sideOf(t)) : -1;
      if (!st || slot < 0) { this.release(a); continue; }
      const [su, sx] = this.slotPos(slot);
      const PZ = this.apm.L.platform;
      const legs = this.worldLegs([a.root.position.clone(), this.sp(st, su, this.sideOf(t) * LANE_X, PZ), this.sp(st, su, sx, PZ)]);
      if (!legs.length) { this.release(a); continue; }
      this.startWalk(a, legs, 0, 'wait');
      a.slot = slot; this.slots[slot] = a; a.side = this.sideOf(t);
    }
  }

  /** The train left: anyone still walking to their spot in it is there. */
  private settle(t: Train): void {
    for (const a of this.pool) {
      if (a.act === 'walk' && a.after === 'board' && a.train === t) {
        if (a.leg >= a.inLeg) this.seatRider(a, t, a.car, a.spot);
        else this.release(a);
      }
    }
  }

  private freeSlot(side: number, frontFirst = true): number {
    const base = side < 0 ? 0 : 16;
    const ids: number[] = [];
    for (let i = base; i < base + 16; i++) if (!this.slots[i]) ids.push(i);
    if (!ids.length) return -1;
    ids.sort(() => this.rng() - 0.5);
    if (frontFirst) { const f = ids.find((i) => i % 4 < 2); if (f !== undefined) return f; }
    return ids[0];
  }

  // ------------------------------------------------------------------------------------------ focus station
  private setFocus(st: ApmStation | null): void {
    if (st === this.focus) return;
    for (const a of this.pool) {
      if (a.act === 'ride') continue;
      if (a.act === 'walk' && a.after === 'board' && a.train) { if (a.leg >= a.inLeg) this.seatRider(a, a.train, a.car, a.spot); else this.release(a); continue; }
      if (a.act !== 'off') this.release(a);
    }
    this.focus = st;
    this.slots = new Array(32).fill(null);
    this.seats = new Array(BENCHES.length * 2).fill(null);
    if (st) this.populate(st);
  }

  private target(): number { return Math.round(5.5 * hourFactor(this.hour)); }

  /** First look at a station: people already waiting, sitting and on their way. */
  private populate(st: ApmStation): void {
    const PZ = this.apm.L.platform;
    for (const side of this.boardingSides(st)) {
      const n = Math.round(this.target() * (0.5 + this.rng() * 0.4));
      for (let i = 0; i < n; i++) {
        const a = this.free(); if (!a) return;
        const slot = this.freeSlot(side);
        if (slot < 0) break;
        this.waitAt(a, st, slot);
      }
    }
    const sitters = Math.floor(this.rng() * 3 * Math.min(1, hourFactor(this.hour))) + 1;
    for (let i = 0; i < sitters; i++) {
      const a = this.free(); if (!a) return;
      const seat = Math.floor(this.rng() * this.seats.length);
      if (this.seats[seat]) continue;
      this.sitAt(a, st, seat);
    }
    for (let i = 0; i < 3; i++) {
      const a = this.free(); if (!a) return;
      const side = this.boardingSides(st)[Math.floor(this.rng() * this.boardingSides(st).length)];
      const slot = this.freeSlot(side);
      if (slot >= 0) this.inbound(st, a, { slot }, 0.25 + this.rng() * 0.6);
    }
    for (let i = 0; i < 2; i++) {
      const a = this.free(); if (!a) return;
      const side = this.rng() < 0.5 ? -1 : 1, du = PSD_DOORS[Math.floor(this.rng() * 4)];
      const out = this.outbound(st, side, du, []);
      if (!out) continue;
      const total = out.legs.reduce((s, l) => s + l.len, 0);
      a.floorY = PZ;
      this.startWalk(a, out.legs, total * (0.35 + this.rng() * 0.5), 'leave');
      a.gateLeg = out.gate;
    }
  }

  private waitAt(a: Pax, st: ApmStation, slot: number): void {
    const [su, sx, side] = this.slotPos(slot);
    const PZ = this.apm.L.platform;
    a.act = 'wait'; a.slot = slot; a.side = side; this.slots[slot] = a;
    a.pose = this.standPose(a, false);
    a.floorY = PZ;
    this.sp(st, su, sx, PZ, a.root.position);
    const f = this.sp(st, su, sx + side, PZ).sub(a.root.position);
    a.yaw = Math.atan2(f.x, f.z) + (this.rng() - 0.5) * 0.7;
    a.root.rotation.set(0, a.yaw, 0);
    this.play(a, a.pose === 'fold' ? 'idle_fold' : 'idle');
  }

  private sitAt(a: Pax, st: ApmStation, seat: number): void {
    const b = BENCHES[Math.floor(seat / 2)], du = SEAT_DU[seat % 2];
    const PZ = this.apm.L.platform;
    a.act = 'sit'; a.seat = seat; this.seats[seat] = a; a.pose = 'sit';
    a.floorY = PZ;
    this.sp(st, b.u + du, -b.face * 0.06, PZ + BENCH_TOP + 0.1 - a.hipH, a.root.position);
    const f = this.sp(st, b.u, b.face, PZ).sub(this.sp(st, b.u, 0, PZ));
    a.yaw = Math.atan2(f.x, f.z);
    a.root.rotation.set(0, a.yaw, 0);
    this.play(a, 'idle');
  }

  // ------------------------------------------------------------------------------------------ per frame
  private readonly sphere = new THREE.Sphere();

  /** In the view frustum and within `far` m (for drawing). */
  private inView(p: THREE.Vector3, r: number, far: number): boolean {
    if (p.distanceToSquared(this.cam) > far * far) return false;
    this.sphere.center.copy(p); this.sphere.center.y += 0.9; this.sphere.radius = r;
    return this.frustum.intersectsSphere(this.sphere);
  }

  /** Could the camera see someone here (for appearing / vanishing): in view, near, and on the same level. */
  private visible(p: THREE.Vector3, r = 1.2): boolean {
    if (Math.abs(this.level(p.y) - this.level(this.cam.y)) > 0.6) return false;
    return this.inView(p, r, 60);
  }

  /** 0 platform level, 0.5 on the stair between, 1 concourse (passages, entrance halls), 1.5 entrance stair, 2 street. */
  private level(y: number): number {
    const L = this.apm.L;
    return y < L.platform + 2.8 ? 0 : y < L.concourse - 0.6 ? 0.5 : y < L.concourse + 2.8 ? 1 : y < -1.0 ? 1.5 : 2;
  }

  /**
   * active: the APM is drawn (camera underground or by an APM entrance); camera: the view; player: to keep out
   * of (and push); hour: how busy.
   */
  update(dt: number, camera: THREE.Camera, player: THREE.Vector3 | null, hour: number, active: boolean): void {
    this.hour = hour;
    if (active && this.building) this.grow(3);
    this.group.visible = active;
    this.cam.copy(camera.position);
    camera.updateMatrixWorld();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    // seed the trains once the pool is built
    if (!this.building && !this.seeded) {
      this.seeded = true;
      for (const t of this.trains.trains) if (t.phase !== 'turn') this.fill(t);
    }
    // the station the camera is at
    let focus: ApmStation | null = null;
    if (active && !this.building) {
      const bx = this.cam.x, by = -this.cam.z;
      focus = this.apm.stations.reduce((a, b) => ((b.x - bx) ** 2 + (b.y - by) ** 2 < (a.x - bx) ** 2 + (a.y - by) ** 2 ? b : a));
    }
    if (!this.building) this.setFocus(focus);
    // trains: dwell events
    for (const t of this.trains.trains) {
      const prev = this.prevPhase.get(t.id);
      if (t.phase === 'dwell' && prev !== 'dwell') this.dwellN.set(t.id, (this.dwellN.get(t.id) ?? 0) + 1);
      if (prev === 'dwell' && t.phase !== 'dwell') this.settle(t);
      this.prevPhase.set(t.id, t.phase);
      if (t.phase !== 'dwell' || !t.at || this.building) continue;
      const key = `${t.at.key}:${t.track}:${this.dwellN.get(t.id)}`;
      const here = this.focus === t.at;
      if (t.doors > 0.9 && this.served.get(t.id) !== key) {
        this.served.set(t.id, key);
        if (here) this.alight(t); else this.reroll(t);
      }
      if (here && t.t > OPEN_AT + 3.4 && this.boarded.get(t.id) !== key) { this.boarded.set(t.id, key); this.board(t); }
      if (here && t.t > closesAt(t) - 0.3) this.stepBack(t);
    }
    if (!active || this.building) { for (const a of this.pool) a.root.visible = false; return; }
    // newcomers
    const st = this.focus;
    if (st) {
      this.spawnT -= dt;
      if (this.spawnT <= 0) {
        this.spawnT = (1.4 + this.rng() * 2.6) / hourFactor(this.hour);
        const waiting = this.pool.filter((a) => (a.act === 'wait' || (a.act === 'walk' && a.after === 'wait'))).length;
        const sides = this.boardingSides(st);
        const a = this.free();
        if (a && waiting < this.target() * sides.length && this.freeCount() > 6) {
          if (this.rng() < 0.12) {
            const seat = this.seats.findIndex((s) => !s);
            if (seat >= 0) this.inbound(st, a, { seat }, 'hidden');
          } else {
            const slot = this.freeSlot(sides[Math.floor(this.rng() * sides.length)]);
            if (slot >= 0) this.inbound(st, a, { slot }, 'hidden');
          }
        }
      }
    }
    for (const a of this.pool) {
      if (a.act === 'off') continue;
      if (a.act === 'walk') this.walk(a, dt, player);
      else if (a.act === 'ride') this.ride(a);
      else if (a.act === 'sit' && this.rng() < dt / 150) {
        // done resting: off to the exit
        const b = BENCHES[Math.floor(a.seat / 2)];
        const from = a.root.position.clone(); from.y = this.apm.L.platform;
        const out = st && this.outbound(st, b.face, b.u, [from], true);
        if (out) {
          this.seats[a.seat] = null; a.seat = -1;
          this.startWalk(a, out.legs, 0, 'leave');
          a.gateLeg = out.gate;
        }
      }
      if ((a.act as Act) === 'off') continue;   // walk() may have let them go
      const d = a.root.position.distanceTo(this.cam);
      a.seen = this.inView(a.root.position, 1.3, 90);
      a.root.visible = a.seen;
      if (!a.seen) continue;
      a.animAcc += dt;
      if (a.animAcc >= (d < 25 ? 0 : d < 50 ? 1 / 30 : 1 / 15)) {
        a.mixer.update(a.animAcc);
        a.animAcc = 0;
        this.applyPose(a);
      }
    }
  }

  private walk(a: Pax, dt: number, player: THREE.Vector3 | null): void {
    if (a.delay > 0) {
      a.delay -= dt;
      this.play(a, 'idle');
      return;
    }
    const l = a.legs[a.leg];
    let v = l.esc ? ESC_SPEED : a.speed * (l.stair ? 0.72 : 1);
    a.ghostT = Math.max(0, a.ghostT - dt);
    if (!l.esc && a.ghostT <= 0 && this.blocked(a, l, player)) {
      a.blockT += dt;
      v = 0;
      if (a.blockT > 2.2) { a.ghostT = 1.6; a.blockT = 0; }
    } else a.blockT = Math.max(0, a.blockT - dt);
    a.f += v * dt;
    let leg = l;
    while (a.f >= leg.len) {
      a.f -= leg.len;
      a.leg++;
      if (a.leg >= a.legs.length) { this.arrive(a); return; }
      leg = a.legs[a.leg];
    }
    a.root.position.lerpVectors(leg.a, leg.b, a.f / leg.len);
    // through the gates and out of sight: gone (frees the place for someone coming in)
    if (a.after === 'leave' && a.gateLeg >= 0 && a.leg >= a.gateLeg && !this.visible(a.root.position, 1.5) && a.root.position.distanceTo(this.cam) > 10) { this.release(a); return; }
    if (!leg.esc && v > 0) {
      const want = Math.atan2(leg.b.x - leg.a.x, leg.b.z - leg.a.z);
      a.yaw += Math.atan2(Math.sin(want - a.yaw), Math.cos(want - a.yaw)) * Math.min(1, dt * 8);
    }
    a.root.rotation.set(0, a.yaw, 0);
    this.play(a, leg.esc || v === 0 ? 'idle' : 'walk');
    const act = a.actions.walk;
    if (act && a.anim === 'walk') act.timeScale = v / (a.spec.walkSpeed * a.scale);
  }

  /** Someone walking the same way close ahead (or the player in the way). */
  private blocked(a: Pax, l: Leg, player: THREE.Vector3 | null): boolean {
    const hx = (l.b.x - l.a.x) / l.len, hz = (l.b.z - l.a.z) / l.len;
    const p = a.root.position;
    const test = (q: THREE.Vector3, ahead: number) => {
      if (Math.abs(q.y - p.y) > 0.9) return false;
      const dx = q.x - p.x, dz = q.z - p.z;
      const al = dx * hx + dz * hz;
      return al > 0.05 && al < ahead && Math.abs(dx * hz - dz * hx) < 0.42;
    };
    if (player && test(player, 0.75)) return true;
    for (const o of this.pool) {
      if (o === a || o.act !== 'walk' || o.delay > 0) continue;
      const ol = o.legs[o.leg];
      if (!ol || (ol.b.x - ol.a.x) * hx + (ol.b.z - ol.a.z) * hz < 0.3 * ol.len) continue;
      if (test(o.root.position, 0.8)) return true;
    }
    return false;
  }

  private arrive(a: Pax): void {
    const st = this.focus;
    if (a.after === 'leave' || !st) { this.release(a); return; }
    if (a.after === 'wait') {
      const slot = a.slot;
      if (slot < 0) { this.release(a); return; }
      this.waitAt(a, st, slot);
    } else if (a.after === 'sit') {
      this.sitAt(a, st, a.seat);
    } else if (a.after === 'board' && a.train) {
      this.seatRider(a, a.train, a.car, a.spot);
    }
  }

  private ride(a: Pax): void {
    const t = a.train!;
    const s = SPOTS[a.spot];
    const cam = this.cam;
    const cm = t.cars[a.car];
    if ((cm.elements[12] - cam.x) ** 2 + (cm.elements[14] - cam.z) ** 2 > 160 * 160) { a.root.visible = false; return; }
    const z = s.sit ? SEAT_TOP + 0.1 - a.hipH : 0;
    this.trains.carToWorld(t, a.car, _v.set(s.x, s.y, FLOOR + z), a.root.position);
    a.floorY = this.trains.carToWorld(t, a.car, _v.set(0, 0, FLOOR), _c).y;
    _n.set(a.fx, 0, -a.fy).transformDirection(cm);
    a.yaw = Math.atan2(_n.x, _n.z);
    a.root.rotation.set(0, a.yaw, 0);
  }

  // ------------------------------------------------------------------------------------------ poses
  private applyPose(a: Pax): void {
    if (a.pose === 'stand' || a.pose === 'fold') return;
    if (a.act === 'walk') return;
    a.root.updateMatrixWorld(true);
    const L = a.limbs;
    _f.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    _r.set(-Math.cos(a.yaw), 0, Math.sin(a.yaw));
    const root = a.root.position;
    const sideOf = (b: THREE.Bone) => Math.sign(wpos(b, _v).sub(root).dot(_r)) || 1;
    if (a.pose === 'sit') {
      for (let k = 0; k < 2; k++) {
        const side = sideOf(L.thigh[k]);
        const hip = wpos(L.thigh[k], new THREE.Vector3());
        const foot = hip.clone().addScaledVector(_f, 0.4 * a.scale).addScaledVector(_r, side * 0.05);
        foot.y = a.floorY + 0.09 * a.scale;
        ik2(L.thigh[k], L.calf[k], L.foot[k], foot, _p.copy(_f).addScaledVector(UP, 0.3).clone());
        // hands resting on the thighs, elbows a little bent
        const hand = hip.clone().addScaledVector(_f, 0.2 * a.scale).addScaledVector(_r, side * 0.1 * a.scale);
        hand.y += 0.17 * a.scale;
        ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.copy(_f).multiplyScalar(-0.5).addScaledVector(UP, -1).addScaledVector(_r, side * 0.5).clone());
      }
      return;
    }
    // one arm (the right one) busy: the phone in front of the chest, or up to the grab rail
    const k = sideOf(L.upper[0]) > 0 ? 0 : 1;
    const sh = wpos(L.upper[k], new THREE.Vector3());
    if (a.pose === 'phone') {
      // upper arm hanging, forearm forward and in across the chest (the rig's arm is short: scale by it)
      const l1 = sh.distanceTo(wpos(L.fore[k], _c)), l2 = _c.distanceTo(wpos(L.hand[k], _b));
      const hand = sh.clone().addScaledVector(UP, -0.88 * l1 + 0.4 * l2).addScaledVector(_f, 0.3 * l1 + 0.85 * l2).addScaledVector(_r, -0.5 * l2);
      ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, 0.4).addScaledVector(_f, -0.2).clone());
      if (L.head) {
        _q.setFromAxisAngle(_n.copy(_r).negate(), 0.38);
        L.head.matrixWorld.decompose(_v, _wq, _s);
        L.head.parent!.matrixWorld.decompose(_v, _pq, _s);
        L.head.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
        L.head.updateMatrixWorld(true);
      }
    } else if (a.pose === 'hold') {
      const hand = root.clone().addScaledVector(_f, 0.24).addScaledVector(_r, 0.1);
      hand.y = a.floorY + RAIL_H;
      ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.copy(_r).addScaledVector(UP, -0.6).clone());
    }
  }

  /** Re-test who is in view for a camera placed by hand (screenshots: shotAt does not run update). */
  sync(camera: THREE.Camera): void {
    this.cam.copy(camera.position);
    camera.updateMatrixWorld();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    for (const a of this.pool) {
      if (a.act === 'off') continue;
      if (a.act === 'ride') this.ride(a);
      a.seen = this.inView(a.root.position, 1.3, 90);
      a.root.visible = a.seen;
      if (a.seen) { a.mixer.update(0); this.applyPose(a); }
    }
  }

  /** Keep the player out of the people standing and walking in the station (like Pedestrians.pushPlayer). */
  pushPlayer(p: THREE.Vector3, radius: number): boolean {
    if (!this.group.visible) return false;
    let hit = false;
    const r = radius + 0.26;
    for (const a of this.pool) {
      if (a.act === 'off' || a.act === 'ride' || Math.abs(p.y - a.root.position.y) > 1.2) continue;
      if (a.act === 'sit') continue;
      const dx = p.x - a.root.position.x, dz = p.z - a.root.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      p.x = a.root.position.x + (dx / d) * r;
      p.z = a.root.position.z + (dz / d) * r;
      hit = true;
    }
    return hit;
  }

  /** QA / debug: who is where. */
  stats(): { pool: number; ride: number; wait: number; sit: number; walk: number; board: number; leave: number; focus: string | null; perTrain: number[] } {
    const n = (f: (a: Pax) => boolean) => this.pool.filter(f).length;
    return {
      pool: this.pool.length, ride: n((a) => a.act === 'ride'), wait: n((a) => a.act === 'wait'), sit: n((a) => a.act === 'sit'),
      walk: n((a) => a.act === 'walk'), board: n((a) => a.act === 'walk' && a.after === 'board'), leave: n((a) => a.act === 'walk' && a.after === 'leave'),
      focus: this.focus?.key ?? null, perTrain: this.trains.trains.map((t) => this.riders(t).length),
    };
  }

  /** QA: every active person with where they are (three.js) and what they are doing. */
  people(): { id: number; act: Act; after: After; pos: THREE.Vector3; train: number | null; seen: boolean; esc: boolean }[] {
    return this.pool.filter((a) => a.act !== 'off').map((a) => ({
      id: a.id, act: a.act, after: a.after, pos: a.root.position.clone(), train: a.train?.id ?? null, seen: a.seen,
      esc: a.act === 'walk' && !!a.legs[a.leg]?.esc,
    }));
  }
}
