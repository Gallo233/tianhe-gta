import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildPedGeometry, dressRigWith, randomLook } from '../entities/ProceduralPed';
import { ik2, wpos } from '../entities/Ik';
import type { PlayerFacts } from '../ai/facts';

/**
 * People who stay on 花城广场 (gz_huacheng -> huacheng.json): the street crowd only walks the paths, so the square
 * looked empty however busy the pavements were. The photographs (Commons, 2015-2026) show it as a place people
 * stop in: knots of friends and families talking, people photographing each other with the Canton Tower behind
 * them, every bench taken in the evening, and after dark the aunties' square dance (广场舞) in 花城汇's sunken court
 * to a loudspeaker on a trolley.
 *
 *   groups    2-4 people facing each other on the promenade and between the towers (a child in some)
 *   photos    a photographer north of one or two people, they pose with the tower behind them (V signs)
 *   seats     the promenade benches, the court's benches and its cafe stools (huacheng.json 'seats')
 *   dance     19:30-22:30, a 4 x 5 block and a leader in the court, stepping and waving in time
 *
 * A slot (a place and what is done there) is laid out once from a seeded random; how many are filled follows the
 * hour (busiest in the evening, nearly empty after midnight). Slots change hands only out of the camera's view.
 * People are drawn within 150 m of the camera; bodies, rigs and IK posing are the APM passengers' (one bank of
 * looks per rig). Anyone the player runs, rides or drives at jumps clear (and stays there, arms folded).
 */
interface Seat { p: [number, number, number]; f: [number, number]; cafe?: boolean }
export interface HuachengLayout {
  court: { rect: [number, number, number, number]; z: number; terraces_y1: number; stair: [number, number] };
  oval: [number, number, number, number];
  canopies: [number, number, number, number][];
  north: number;
  spawn?: [number, number];
  seats?: Seat[];
  kiosks?: [number, number][];
  wells?: [number, number, number, number][];
  /** 花城汇 B1's corridor (gz_mall): its rectangle and floor */
  mall?: { rect: number[]; z: number; link: number[]; xlink: number[] } | null;
  /** the north half (gz_north): the fountain basin and the paved areas */
  north_half?: { fountain: { basin: number[] }; pave: number[][]; rect: number[]; planters?: number[][] } | null;
}

type Anim = 'walk' | 'idle' | 'idle_fold';
type Pose = 'stand' | 'fold' | 'phone' | 'photo' | 'peace' | 'selfie' | 'sit' | 'dance';
type Kind = 'group' | 'photo' | 'seat' | 'dance' | 'mall' | 'fountain';

interface Slot {
  kind: Kind;
  x: number; y: number; z: number;          // Blender
  fx: number; fy: number;                   // facing (Blender, unit)
  pose: Pose;
  rig: number;                              // 0 man, 1 woman, 2 older man (CHARACTERS order); -1 any
  child: boolean;
  u: number;                                // fill threshold: filled while u < density(hour, kind)
  seatTop: number;                          // sitting: seat height (world z)
  dance: number;                            // dancers: index in the block (-1 leader)
  who: Person | null;
}

interface Limbs { thigh: THREE.Bone[]; calf: THREE.Bone[]; foot: THREE.Bone[]; upper: THREE.Bone[]; fore: THREE.Bone[]; hand: THREE.Bone[]; head: THREE.Bone | null }

interface Person {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Anim, THREE.AnimationAction>>;
  anim: Anim;
  rig: number;
  scale: number;
  hipH: number;
  limbs: Limbs;
  slot: Slot | null;
  pose: Pose;
  yaw: number;
  floorY: number;
  animAcc: number;
  seen: boolean;
  /** jumping clear of the player: from -> to over `t` (0..1) */
  dodge: { from: THREE.Vector3; to: THREE.Vector3; t: number } | null;
  phase: number;
}

const POOL = 200;
const LOOKS = 8;
const DRAW_M = 150;
const KERB = 0.15;
const DANCE_BEAT = 0.52;                    // s per step (a 115 bpm 广场舞 track)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _v = new THREE.Vector3();
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _sph = new THREE.Sphere();

/** How many people each kind may take from the pool (the dance, when on, takes its 21 from the groups' share). */
function cap(kind: Kind, h: number): number {
  const dancing = density('dance', h) > 0;
  return kind === 'dance' ? 21 : kind === 'mall' ? 24 : kind === 'fountain' ? 36 : kind === 'group' ? (dancing ? 78 : 90) : kind === 'photo' ? (dancing ? 11 : 20) : 30;
}

/** How full each kind of slot is at an hour (0..1). */
function density(kind: Kind, h: number): number {
  const x = ((h % 24) + 24) % 24;
  if (kind === 'dance') return x > 19.5 && x < 22.5 ? 1 : 0;
  if (kind === 'mall') return x > 10 && x < 22 ? (x > 18 ? 0.95 : 0.7) : x > 9.5 && x < 22.5 ? 0.2 : 0;   // 10:00-22:00
  if (kind === 'fountain') return x > 19.2 && x < 22.6 ? 1 : x > 11 && x < 19.2 ? 0.35 : 0;              // the evening shows draw a crowd
  const base = x < 6.5 ? 0.05 : x < 9 ? 0.35 : x < 16.5 ? 0.6 : x < 22.5 ? 0.95 : x < 24 ? 0.4 : 0.05;
  if (kind === 'photo') return x > 7 && x < 22 ? base : 0;
  if (kind === 'seat') return base * 0.32;
  return base;
}

export class PlazaLife {
  readonly group = new THREE.Group();
  private readonly pool: Person[] = [];
  private readonly slots: Slot[] = [];
  private readonly bank: THREE.BufferGeometry[][] = [[], [], []];
  private readonly frustum = new THREE.Frustum();
  private readonly m4 = new THREE.Matrix4();
  private readonly cam = new THREE.Vector3();
  private readonly speaker: THREE.Group;
  private building = true;
  private refillT = 0;
  private hour = 12;
  private danceT = 0;
  private lastHour = 12;
  /** true while the camera is near the square (the pool exists and people are placed) */
  active = false;

  constructor(private readonly rigs: GLTF[], private readonly L: HuachengLayout,
    private readonly free: (x: number, y: number, r: number) => boolean, private readonly rng: () => number) {
    this.group.name = 'plaza life';
    this.group.visible = false;
    this.layout();
    this.speaker = this.buildSpeaker();
    this.group.add(this.speaker);
  }

  get count(): number { return this.pool.filter((p) => p.slot).length; }

  // ------------------------------------------------------------------------------------------ layout
  /** Is (x, y) open paving on the square: not in the court, a well, under a canopy, on the spawn or by a prop. */
  private open(x: number, y: number, r: number): boolean {
    const [x0, y0, x1, y1] = this.L.court.rect;
    if (x > x0 - 2 && x < x1 + 2 && y > y0 - 2 && y < y1 + 2) return false;
    const nh = this.L.north_half;
    if (nh) {
      const inR = (r: number[], p: number) => x > r[0] - p && x < r[2] + p && y > r[1] - p && y < r[3] + p;
      if (inR(nh.rect, 2) || inR(nh.fountain.basin, 1.5)) return false;
      if ((nh.planters ?? []).some(([px, py]) => Math.abs(x - px) < 2.0 && Math.abs(y - py) < 2.0)) return false;
      if (this.L.mall && inR((this.L.mall as unknown as { well: number[] }).well, 4)) return false;
    }
    for (const [cx, cy, sx, sy] of this.L.canopies) if (Math.abs(x - cx) < sx / 2 + 1 && Math.abs(y - cy) < sy / 2 + 1) return false;
    const sp = this.L.spawn ?? [28, -236];
    if (Math.hypot(x - sp[0], y - sp[1]) < 16) return false;             // the courier's station and the e-bike tests
    for (const [kx, ky] of this.L.kiosks ?? []) if (Math.hypot(x - kx, y - ky) < 4) return false;
    for (const s of this.L.seats ?? []) if (Math.abs(x - s.p[0]) < 1.6 && Math.abs(y - s.p[1]) < 2.2) return false;
    return this.free(x, y, r);
  }

  private layout(): void {
    const rng = this.rng;
    const centres: [number, number][] = [];
    const spaced = (x: number, y: number, d: number) => centres.every(([cx, cy]) => (cx - x) ** 2 + (cy - y) ** 2 > d * d);
    const pick = (x0: number, x1: number, y0: number, y1: number, d: number): [number, number] | null => {
      for (let k = 0; k < 40; k++) {
        const x = x0 + rng() * (x1 - x0), y = y0 + rng() * (y1 - y0);
        if (spaced(x, y, d) && this.open(x, y, 2.2)) { centres.push([x, y]); return [x, y]; }
      }
      return null;
    };
    const anyRig = () => { const r = rng(); return r < 0.42 ? 0 : r < 0.84 ? 1 : 2; };
    const standPose = (): Pose => { const r = rng(); return r < 0.45 ? 'stand' : r < 0.7 ? 'phone' : r < 0.9 ? 'fold' : 'selfie'; };
    const add = (s: Partial<Slot> & { kind: Kind; x: number; y: number; z: number; fx: number; fy: number }) =>
      this.slots.push({ pose: 'stand', rig: -1, child: false, u: rng(), seatTop: 0, dance: 0, who: null, ...s });
    // groups: the promenade (south of the towers) and the funnel between them
    const areas: [number, number, number, number, number][] = [[-22, 17, -510, -130, 26], [-40, 30, -95, 10, 12]];
    for (const [x0, x1, y0, y1, n] of areas) {
      for (let i = 0; i < n; i++) {
        const c = pick(x0, x1, y0, y1, 7);
        if (!c) continue;
        const r = rng(), size = r < 0.45 ? 2 : r < 0.8 ? 3 : 4;
        const family = size >= 3 && rng() < 0.4;
        const u = rng(), a0 = rng() * Math.PI * 2;
        for (let k = 0; k < size; k++) {
          const a = a0 + (k / size) * Math.PI * 2 + (rng() - 0.5) * 0.5;
          const child = family && k === size - 1;
          const rad = (size === 2 ? 0.55 : 0.75) * (child ? 0.8 : 1);
          const x = c[0] + Math.cos(a) * rad, y = c[1] + Math.sin(a) * rad;
          add({ kind: 'group', x, y, z: KERB, fx: -Math.cos(a), fy: -Math.sin(a), pose: child ? 'stand' : standPose(), rig: anyRig(), child, u: u + k * 0.02 });
        }
      }
    }
    // photographs with the Canton Tower behind: the subject faces north, the photographer 3 m north faces south
    const photoAreas: [number, number, number, number, number][] = [[-14, 8, -500, -150, 8], [-28, 18, -60, -5, 5]];
    for (const [x0, x1, y0, y1, n] of photoAreas) {
      for (let i = 0; i < n; i++) {
        const c = pick(x0, x1, y0, y1, 10);
        if (!c || !this.open(c[0], c[1] + 3.2, 1)) continue;
        const u = rng() * 0.9;
        const pair = rng() < 0.55;
        for (let k = 0; k < (pair ? 2 : 1); k++) {
          add({ kind: 'photo', x: c[0] + (pair ? (k ? 0.35 : -0.35) : 0), y: c[1], z: KERB, fx: (rng() - 0.5) * 0.3, fy: 1, pose: rng() < 0.6 ? 'peace' : 'stand', rig: rng() < 0.65 ? 1 : 0, u });
        }
        add({ kind: 'photo', x: c[0] + (rng() - 0.5) * 0.4, y: c[1] + 3.2, z: KERB, fx: 0, fy: -1, pose: 'photo', rig: anyRig(), u });
      }
    }
    // seats
    for (const s of this.L.seats ?? []) {
      const top = s.p[2];
      add({ kind: 'seat', x: s.p[0], y: s.p[1], z: top - 0.48, fx: s.f[0], fy: s.f[1], pose: 'sit', rig: anyRig(), seatTop: top,
        u: s.cafe ? rng() * 0.5 : rng() });
    }
    // 花城汇 B1: window shoppers a step off the glass (one or two, facing the shop), and a few knots in the aisle,
    // clear of the column line, the benches and the openings
    const m = this.L.mall;
    if (m) {
      const [x0, y0, x1, y1] = m.rect, mx = (x0 + x1) / 2;
      const openE = (y: number) => (y > m.link[1] - 1.5 && y < m.link[3] + 1.5) || (y > m.xlink[1] - 1.5 && y < m.xlink[3] + 1.5);
      for (let y = y0 + 3; y < y1 - 3; y += 6) {
        for (const side of [-1, 1]) {
          if (rng() < 0.4 || (side > 0 && openE(y))) continue;
          const wx = side < 0 ? x0 + 1.15 : x1 - 1.15;
          const two = rng() < 0.4, u = rng();
          for (let q = 0; q < (two ? 2 : 1); q++) {
            add({ kind: 'mall', x: wx + (rng() - 0.5) * 0.3, y: y + (two ? (q - 0.5) * 0.7 : 0) + (rng() - 0.5) * 1.6, z: m.z, fx: side, fy: 0,
              pose: rng() < 0.3 ? 'phone' : 'stand', rig: anyRig(), u: u + q * 0.02 });
          }
        }
      }
      for (const y of [86, 100, 118, 128, 146]) {
        const cx = mx + (rng() < 0.5 ? -2.6 : 2.6), u = rng(), a0 = rng() * 6.28;
        for (let q = 0; q < 2; q++) {
          const a = a0 + q * Math.PI;
          add({ kind: 'mall', x: cx + Math.cos(a) * 0.5, y: y + Math.sin(a) * 0.5, z: m.z, fx: -Math.cos(a), fy: -Math.sin(a), pose: standPose(), rig: anyRig(), u: u + q * 0.02 });
        }
      }
    }
    // the north half (gz_north): the crowd along the fountain's rim (shoulder to shoulder in the evening, phones up),
    // knots on the forecourt and the square at the fountain's north end
    const nh = this.L.north_half;
    if (nh) {
      const [bx0, by0, bx1, by1] = nh.fountain.basin;
      for (const side of [-1, 1]) {
        const x = side < 0 ? bx0 - 1.2 : bx1 + 1.2;
        for (let y = by0 + 2; y < by1 - 2; y += 1.4 + rng() * 1.6) {
          add({ kind: 'fountain', x: x + (rng() - 0.5) * 0.4, y, z: KERB, fx: -side, fy: (rng() - 0.5) * 0.4,
            pose: rng() < 0.45 ? 'photo' : rng() < 0.5 ? 'phone' : 'stand', rig: anyRig(), u: rng() });
        }
      }
      for (let y = by0 - 1; y > by0 - 6; y -= 1.3) {                       // the south end, looking up the basin
        for (let x = bx0 + 1; x < bx1 - 1; x += 1.3 + rng()) {
          add({ kind: 'fountain', x, y: y - 0.6, z: KERB, fx: 0, fy: 1, pose: rng() < 0.5 ? 'photo' : 'stand', rig: anyRig(), u: rng() });
        }
      }
      const areas2: [number, number, number, number, number][] = [[-34, 28, 139, 173, 7], [-20, 14, 347, 361, 4]];
      for (const [x0, x1, y0, y1, n] of areas2) {
        for (let i = 0; i < n; i++) {
          const c = pick(x0, x1, y0, y1, 7);
          if (!c) continue;
          const size = rng() < 0.55 ? 2 : 3, u = rng(), a0 = rng() * 6.28;
          for (let q = 0; q < size; q++) {
            const a = a0 + (q / size) * Math.PI * 2;
            add({ kind: 'group', x: c[0] + Math.cos(a) * 0.6, y: c[1] + Math.sin(a) * 0.6, z: KERB, fx: -Math.cos(a), fy: -Math.sin(a), pose: standPose(), rig: anyRig(), u: u + q * 0.02 });
          }
        }
      }
    }
    // the dance: a 4 x 5 block in the court facing south toward the leader and the loudspeaker
    const [cx0, , cx1] = this.L.court.rect, cz = this.L.court.z;
    const dcx = (cx0 + cx1) / 2 - 1.5, dcy = 66.5;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        add({ kind: 'dance', x: dcx + (c - 2) * 1.7, y: dcy + r * 1.7, z: cz, fx: 0, fy: -1, pose: 'dance', rig: rng() < 0.85 ? 1 : 2, u: 0, dance: r * 5 + c });
      }
    }
    add({ kind: 'dance', x: dcx, y: dcy - 3.0, z: cz, fx: 0, fy: 1, pose: 'dance', rig: 1, u: 0, dance: -1 });
  }

  // ------------------------------------------------------------------------------------------ pool
  private grow(budgetMs: number): void {
    const rng = this.rng;
    const t0 = performance.now();
    while (this.pool.length < POOL && performance.now() - t0 < budgetMs) {
      const k = this.pool.length % 3 === 0 ? 0 : this.pool.length % 3 === 1 ? 1 : 2;
      const model = cloneSkinned(this.rigs[k].scene);
      model.rotation.y = -Math.PI / 2;
      const bank = this.bank[k];
      const mesh = dressRigWith(model, (sk) => {
        if (bank.length < LOOKS) { const g = buildPedGeometry(sk, randomLook(rng, k === 1)); bank.push(g); return g; }
        return bank[Math.floor(rng() * bank.length)];
      });
      mesh.castShadow = true;
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
      this.pool.push({ root, mixer, actions, anim: 'idle', rig: k, scale: 1, hipH, limbs, slot: null, pose: 'stand', yaw: 0, floorY: 0,
        animAcc: 0, seen: false, dodge: null, phase: rng() * 10 });
    }
    if (this.pool.length >= POOL) this.building = false;
  }

  private play(p: Person, anim: Anim, fade = 0.3): void {
    if (!p.actions[anim]) anim = 'idle';
    if (p.anim === anim) return;
    const from = p.actions[p.anim]!, to = p.actions[anim]!;
    to.reset().play();
    to.time = this.rng() * to.getClip().duration;
    from.crossFadeTo(to, fade, false);
    p.anim = anim;
  }

  private seat(p: Person, s: Slot): void {
    p.slot = s; s.who = p;
    p.pose = s.pose; p.dodge = null;
    p.scale = s.child ? 0.62 + this.rng() * 0.08 : 0.94 + this.rng() * 0.12;
    p.root.scale.setScalar(p.scale);
    p.floorY = s.z;
    const y = s.kind === 'seat' ? s.seatTop + 0.1 - p.hipH * p.scale : s.z;
    p.root.position.set(s.x, y, -s.y);
    p.yaw = Math.atan2(s.fx, -s.fy) + (s.kind === 'group' ? (this.rng() - 0.5) * 0.4 : 0);
    p.root.rotation.set(0, p.yaw, 0);
    if (s.kind === 'dance') {
      this.play(p, 'walk', 0.1);
      p.actions.walk!.timeScale = 0.55;
    } else {
      if (p.actions.walk) p.actions.walk.timeScale = 1;
      this.play(p, p.pose === 'fold' && p.actions.idle_fold ? 'idle_fold' : 'idle', 0.1);
    }
  }

  private release(p: Person): void {
    if (p.slot) p.slot.who = null;
    p.slot = null;
    p.root.visible = false;
  }

  // ------------------------------------------------------------------------------------------ update
  /** Is a three.js point within the camera's view (with a margin), not too far. */
  private inView(p: THREE.Vector3, r: number, far: number): boolean {
    if (p.distanceToSquared(this.cam) > far * far) return false;
    _sph.center.copy(p).setY(p.y + 0.9); _sph.radius = r;
    return this.frustum.intersectsSphere(_sph);
  }

  /**
   * camera: the view; f: the player (position, velocity, driving); hour; active: the square can be seen (on the
   * surface, within a few hundred metres).
   */
  update(dt: number, camera: THREE.Camera, f: PlayerFacts | null, hour: number, active: boolean): void {
    this.hour = hour;
    this.active = active;
    this.group.visible = active;
    if (!active) return;
    if (this.building) {
      this.grow(3);
      if (this.building) return;
      this.refill(true);                                     // the first time: everyone in place at once
    }
    // a jump in the clock (the time menu, QA) re-deals the square at once
    if (Math.abs(hour - this.lastHour) > 0.5 && Math.abs(hour - this.lastHour) < 23.5) this.refill(true);
    this.lastHour = hour;
    this.cam.copy(camera.position);
    camera.updateMatrixWorld();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    // who should be where: fill and empty slots out of sight, a few per second
    this.refillT -= dt;
    if (this.refillT <= 0) { this.refillT = 0.25; this.refill(false); }
    this.danceT += dt;
    this.speaker.visible = density('dance', hour) > 0;
    for (const p of this.pool) {
      if (!p.slot) continue;
      if (f) this.avoid(p, f);
      if (p.dodge) this.stepDodge(p, dt);
      else if (p.slot.kind === 'dance') this.dance(p);
      const d = p.root.position.distanceTo(this.cam);
      p.seen = this.inView(p.root.position, 1.2, DRAW_M);
      p.root.visible = p.seen;
      if (!p.seen) continue;
      p.animAcc += dt;
      if (p.slot.kind === 'dance') {
        // in step: everyone's walk is on the same beat
        const w = p.actions.walk!;
        w.time = (this.danceT * w.timeScale) % w.getClip().duration;
        p.mixer.update(0);
        p.animAcc = 0;
        this.applyPose(p);
      } else if (p.animAcc >= (d < 25 ? 0 : d < 60 ? 1 / 30 : 1 / 12)) {
        p.mixer.update(p.animAcc);
        p.animAcc = 0;
        this.applyPose(p);
      }
    }
  }

  /**
   * Fill slots that should be taken and empty ones that should not -- only where the camera is not looking, unless
   * `all`. Each kind keeps to its share of the pool (cap), so the evening's dance can take its people from the groups.
   */
  private refill(all: boolean): void {
    let budget = all ? 1e9 : 6;
    const h = this.hour;
    const k: Record<Kind, number> = { group: 0, photo: 0, seat: 0, dance: 0, mall: 0, fountain: 0 };
    const hidden = (s: Slot) => all || !this.inView(_p.set(s.x, s.z, -s.y), 1.5, DRAW_M + 20);
    for (const s of this.slots) {
      if (!s.who) continue;
      if (s.u < density(s.kind, h) && k[s.kind] < cap(s.kind, h)) { k[s.kind]++; continue; }
      if (budget > 0 && hidden(s)) { this.release(s.who); budget--; } else k[s.kind]++;
    }
    for (const s of this.slots) {
      if (budget <= 0) break;
      if (s.who || s.u >= density(s.kind, h) || k[s.kind] >= cap(s.kind, h) || !hidden(s)) continue;
      const p = this.pool.find((q) => !q.slot && (s.rig < 0 || q.rig === s.rig)) ?? this.pool.find((q) => !q.slot);
      if (!p) break;
      this.seat(p, s);
      k[s.kind]++;
      budget--;
    }
  }

  /** The player bearing down (driving, riding or sprinting at them): jump clear, sideways to the player's path. */
  private avoid(p: Person, f: PlayerFacts): void {
    if (p.dodge || p.slot?.kind === 'seat') return;
    const speed = Math.hypot(f.vel.x, f.vel.z);
    if (speed < (f.driving ? 1.5 : 4.0)) return;
    const pos = p.root.position;
    if (Math.abs(f.pos.y - pos.y) > 2 || f.pos.distanceToSquared(pos) > 100) return;
    // closest approach along the next 0.9 s of the player's path
    _a.set(f.vel.x, 0, f.vel.z).divideScalar(speed);
    _b.subVectors(pos, f.pos).setY(0);
    const along = _b.dot(_a);
    if (along < -0.5 || along > speed * 0.9 + 1.5) return;
    const side = _b.x * _a.z - _b.z * _a.x;                 // + : the person is to the player's right
    const miss = Math.abs(side);
    if (miss > (f.driving ? 2.4 : 1.1)) return;
    const s = side >= 0 ? 1 : -1;
    const to = pos.clone().add(_c.set(_a.z * s, 0, -_a.x * s).multiplyScalar((f.driving ? 2.8 : 1.6) - miss * 0.5));
    p.dodge = { from: pos.clone(), to, t: 0 };
    p.yaw = Math.atan2(to.x - pos.x, to.z - pos.z);
    p.root.rotation.set(0, p.yaw, 0);
    if (p.slot?.kind === 'dance' && p.actions.walk) p.actions.walk.timeScale = 1.6;
    this.play(p, 'walk', 0.08);
  }

  private stepDodge(p: Person, dt: number): void {
    const d = p.dodge!;
    d.t = Math.min(1, d.t + dt / 0.5);
    const e = 1 - (1 - d.t) * (1 - d.t);
    p.root.position.lerpVectors(d.from, d.to, e);
    if (d.t < 1) return;
    // made it: stay there, turn back to glare at the road hog, arms folded (the dancers rejoin their place)
    p.dodge = null;
    const s = p.slot!;
    if (s.kind === 'dance') { p.root.position.set(s.x, s.z, -s.y); if (p.actions.walk) p.actions.walk.timeScale = 0.55; return; }
    s.x = p.root.position.x; s.y = -p.root.position.z;
    p.yaw += Math.PI;
    p.root.rotation.set(0, p.yaw, 0);
    p.pose = p.actions.idle_fold ? 'fold' : 'stand';
    this.play(p, p.pose === 'fold' ? 'idle_fold' : 'idle', 0.2);
  }

  /**
   * The square dance: 8-beat phrases -- four steps forward, four back -- and a quarter turn every four phrases,
   * everyone together; the leader faces the block and mirrors it.
   */
  private dance(p: Person): void {
    const s = p.slot!;
    const beat = this.danceT / DANCE_BEAT;
    const phrase = Math.floor(beat / 8), inP = (beat % 8) / 8;
    const fwd = inP < 0.5 ? inP * 2 : 2 - inP * 2;            // 0 -> 1 -> 0 over the phrase
    const turn = (Math.floor(phrase / 4) % 4) * (Math.PI / 2) * (s.dance < 0 ? -1 : 1);
    const base = Math.atan2(s.fx, -s.fy);
    p.yaw = base + turn;
    p.root.rotation.set(0, p.yaw, 0);
    const step = 0.5 * fwd;
    p.root.position.set(s.x + Math.sin(p.yaw) * step, s.z, -s.y + Math.cos(p.yaw) * step);
  }

  // ------------------------------------------------------------------------------------------ poses
  private applyPose(p: Person): void {
    if (p.pose === 'stand' || p.pose === 'fold' || p.dodge) return;
    p.root.updateMatrixWorld(true);
    const L = p.limbs, sc = p.scale;
    _f.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    _r.set(-Math.cos(p.yaw), 0, Math.sin(p.yaw));
    const root = p.root.position;
    const sideOf = (b: THREE.Bone) => Math.sign(wpos(b, _v).sub(root).dot(_r)) || 1;
    const arm = (k: number) => {
      const sh = wpos(L.upper[k], new THREE.Vector3());
      const l1 = sh.distanceTo(wpos(L.fore[k], _c)), l2 = _c.distanceTo(wpos(L.hand[k], _b));
      return { sh, l1, l2, side: sideOf(L.upper[k]) };
    };
    if (p.pose === 'sit') {
      for (let k = 0; k < 2; k++) {
        const side = sideOf(L.thigh[k]);
        const hip = wpos(L.thigh[k], new THREE.Vector3());
        const foot = hip.clone().addScaledVector(_f, 0.4 * sc).addScaledVector(_r, side * 0.06 * sc);
        foot.y = p.floorY + 0.09 * sc;
        ik2(L.thigh[k], L.calf[k], L.foot[k], foot, _p.copy(_f).addScaledVector(UP, 0.3).clone());
        const hand = hip.clone().addScaledVector(_f, 0.2 * sc).addScaledVector(_r, side * 0.1 * sc);
        hand.y += 0.17 * sc;
        ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.copy(_f).multiplyScalar(-0.5).addScaledVector(UP, -1).addScaledVector(_r, side * 0.5).clone());
      }
      return;
    }
    if (p.pose === 'photo') {
      // both hands up before the face, holding the phone out level
      for (let k = 0; k < 2; k++) {
        const A = arm(k);
        const hand = A.sh.clone().addScaledVector(_f, (A.l1 + A.l2) * 0.62).addScaledVector(_r, -A.side * 0.12 * sc).addScaledVector(UP, 0.1 * sc);
        ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, A.side * 0.6).clone());
      }
      return;
    }
    if (p.pose === 'dance') {
      // arms swing up and out on the beat, the two sides half a beat apart
      const beat = this.danceT / DANCE_BEAT;
      for (let k = 0; k < 2; k++) {
        const A = arm(k);
        const w = 0.5 + 0.5 * Math.sin((beat + k * 0.5) * Math.PI);
        const hand = A.sh.clone().addScaledVector(UP, -0.35 * sc + 0.6 * sc * w).addScaledVector(_r, A.side * (0.25 + 0.25 * w) * sc).addScaledVector(_f, 0.2 * sc);
        ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, A.side).addScaledVector(_f, -0.3).clone());
      }
      return;
    }
    // one arm busy (the right one)
    const k = sideOf(L.upper[0]) > 0 ? 0 : 1;
    const A = arm(k);
    if (p.pose === 'phone') {
      const hand = A.sh.clone().addScaledVector(UP, -0.88 * A.l1 + 0.4 * A.l2).addScaledVector(_f, 0.3 * A.l1 + 0.85 * A.l2).addScaledVector(_r, -0.5 * A.l2);
      ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, 0.4).addScaledVector(_f, -0.2).clone());
    } else if (p.pose === 'selfie') {
      // arm out and up, the phone turned back at the face
      const hand = A.sh.clone().addScaledVector(_f, (A.l1 + A.l2) * 0.75).addScaledVector(UP, 0.3 * sc).addScaledVector(_r, A.side * 0.15 * sc);
      ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, A.side).clone());
    } else if (p.pose === 'peace') {
      // the V beside the face
      const hand = A.sh.clone().addScaledVector(UP, 0.32 * sc).addScaledVector(_r, A.side * 0.05 * sc).addScaledVector(_f, 0.12 * sc);
      ik2(L.upper[k], L.fore[k], L.hand[k], hand, _p.set(0, -1, 0).addScaledVector(_r, A.side).addScaledVector(_f, -0.2).clone());
    }
  }

  /** The dance's loudspeaker: a trolley speaker beside the leader, a red power light, a phone on top. */
  private buildSpeaker(): THREE.Group {
    const g = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1b1e, roughness: 0.6 });
    const grille = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.9, metalness: 0.2 });
    const red = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff2010, emissiveIntensity: 3 });
    const blue = new THREE.MeshStandardMaterial({ color: 0x001020, emissive: 0x2080ff, emissiveIntensity: 2 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.62, 0.34), dark); body.position.y = 0.42; g.add(body);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 20), grille);
    cone.rotation.x = Math.PI / 2; cone.position.set(0, 0.36, 0.175); g.add(cone);
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 12), grille);
    tw.rotation.x = Math.PI / 2; tw.position.set(0, 0.62, 0.175); g.add(tw);
    const led = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.01), red); led.position.set(0.15, 0.68, 0.172); g.add(led);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.008, 6, 24), blue); ring.position.set(0, 0.36, 0.18); g.add(ring);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.03), grille); handle.position.set(0.14, 0.98, -0.12); g.add(handle);
    const handle2 = handle.clone(); handle2.position.x = -0.14; g.add(handle2);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.03, 0.03), grille); bar.position.set(0, 1.23, -0.12); g.add(bar);
    for (const sx of [-0.17, 0.17]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 14), dark);
      wh.rotation.z = Math.PI / 2; wh.position.set(sx, 0.06, -0.12); g.add(wh);
    }
    const [cx0, , cx1] = this.L.court.rect;
    g.position.set((cx0 + cx1) / 2 - 1.5 + 2.2, this.L.court.z, -(66.5 - 3.4));
    g.rotation.y = 0;
    g.visible = false;
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    return g;
  }

  /** Re-test who is in view for a camera placed by hand (screenshots). */
  sync(camera: THREE.Camera): void {
    if (!this.active || this.building) return;
    this.cam.copy(camera.position);
    camera.updateMatrixWorld();
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    for (const p of this.pool) {
      if (!p.slot) continue;
      if (p.slot.kind === 'dance' && !p.dodge) this.dance(p);
      p.seen = this.inView(p.root.position, 1.2, DRAW_M);
      p.root.visible = p.seen;
      if (p.seen) { p.mixer.update(0); this.applyPose(p); }
    }
  }

  /** Drop every slot within r m of Blender (x, y) -- the courier station, the start, the e-bike (placed after us). */
  keepClear(x: number, y: number, r: number): void {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i];
      if (s.kind === 'seat' || (s.x - x) ** 2 + (s.y - y) ** 2 > r * r) continue;
      if (s.who) this.release(s.who);
      this.slots.splice(i, 1);
    }
  }

  /** Fill every slot for the hour now (a teleport, the first frame, QA): no waiting for them to be out of view. */
  fillNow(hour: number): void {
    this.hour = this.lastHour = hour;
    while (this.building) this.grow(50);
    this.refill(true);
  }

  /** Keep the player out of the people standing about (like Pedestrians.pushPlayer). */
  pushPlayer(pos: THREE.Vector3, radius: number): boolean {
    if (!this.active) return false;
    let hit = false;
    const r = radius + 0.25;
    for (const p of this.pool) {
      if (!p.slot || p.slot.kind === 'seat' || Math.abs(pos.y - p.root.position.y) > 1.2) continue;
      const dx = pos.x - p.root.position.x, dz = pos.z - p.root.position.z;
      const d2 = dx * dx + dz * dz;
      const rr = r * (p.scale < 0.8 ? 0.8 : 1);
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      pos.x = p.root.position.x + (dx / d) * rr;
      pos.z = p.root.position.z + (dz / d) * rr;
      hit = true;
    }
    return hit;
  }

  /** QA / debug: counts by kind, and the people (Blender x, y, z, kind, pose, dodging). */
  stats(): { pool: number; slots: number; filled: Record<string, number>; people: [number, number, number, string, string, boolean][] } {
    const filled: Record<string, number> = {};
    const people: [number, number, number, string, string, boolean][] = [];
    for (const p of this.pool) {
      if (!p.slot) continue;
      filled[p.slot.kind] = (filled[p.slot.kind] ?? 0) + 1;
      people.push([+p.root.position.x.toFixed(2), +(-p.root.position.z).toFixed(2), +p.root.position.y.toFixed(2), p.slot.kind, p.pose, !!p.dodge]);
    }
    return { pool: this.pool.length, slots: this.slots.length, filled, people };
  }
}
