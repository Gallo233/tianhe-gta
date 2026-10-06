import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { fromBlender, type CharacterSpec } from '../config';
import { dressRig, randomLook } from '../entities/ProceduralPed';
import type { PedObservation } from '../ai/brainProtocol';
import { crashSeen, crimeSeen, seePlayer, type Crime, type PlayerFacts } from '../ai/facts';
import type { NpcBrain } from '../ai/NpcBrain';
import type { Traffic } from './Traffic';
import { Path } from '../world/RoadNet';

/**
 * Walkers on the Tianhe pedestrian graph (walkways.json: sidewalks beside every road, corner links, OSM
 * footways, and a crosswalk across each road end at junctions). At a node a walker picks the next edge
 * (not straight back unless it is a dead end); a crosswalk is stepped onto only when the signal gives
 * pedestrians the way (that road's traffic red, the other axis green) and nothing is bearing down, or at
 * unsignalled junctions when there is a gap. The crowd stays around the player: walkers farther than
 * KEEP_M re-enter on an edge 20-160 m away.
 *
 * Everything else is the COSTA BRAVA crowd: procedural bodies on the protagonists' skeletons, Jev decisions
 * (stroll / stop and watch / hurry / flee / turn back / call the police), the flee reflex, witnessing and
 * reporting crimes, being shoved or knocked down by cars, animation LOD by distance.
 */
export interface WalkGraph {
  nodes: [number, number, number][];
  edges: { a: number; b: number; kind: 'side' | 'corner' | 'cross' | 'foot' | 'link'; pts: [number, number][]; node?: number; road?: number }[];
}

type Mode = 'stroll' | 'stop_watch' | 'hurry' | 'flee' | 'turn_back' | 'call_police';
type Anim = 'walk' | 'run' | 'idle';

interface Walker {
  id: string;
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Anim, THREE.AnimationAction>>;
  anim: Anim;
  spec: CharacterSpec;
  scale: number;
  e: number;             // walk edge
  s: number;             // metres along it (from node a)
  dir: 1 | -1;
  waiting: boolean;      // standing at the kerb before a crosswalk
  speed: number;
  paused: number;
  blockedS: number;
  mode: Mode;
  seq: number;
  reflexUntil: number;
  off: THREE.Vector3;
  offVel: THREE.Vector3;
  phase: 'up' | 'falling' | 'lying' | 'rising';
  phaseT: number;
  tilt: number;
  yaw: number;
  mesh: THREE.SkinnedMesh;
  animAcc: number;
  onRoad: boolean;
  callT: number;
  callFor: Crime | null;
  reported: Set<number>;
  /** metres to the right of the travel direction (eases toward `want`) and the preferred keep-right offset */
  side: number;
  lane: number;
  /** edge and direction `side` was last measured against (a turn-about on the same edge mirrors it) */
  pe: number;
  pd: 1 | -1;
  /** seconds stopped short of something it cannot get round: long enough and it turns back */
  stuckT: number;
}

/** Something walkers step around: the player, a parked e-bike, the delivery game's people. */
export interface Blocker { p: THREE.Vector3; r: number; player?: boolean }

export interface CarBody { obj: THREE.Object3D; half: THREE.Vector2; speed: number }
export interface KnockEvent { id: string; pos: THREE.Vector3 }

const KNOCK_SPEED = 2.5;
const BODY_R = 0.3;
const KEEP_M = 220;
/** how far a walker may step off the walk line (m): pavements are 3-6 m wide, the line runs down the middle */
const MAX_SIDE = 1.15;
const LOOK_AHEAD = 3.2;
const WEIGHT: Record<WalkGraph['edges'][number]['kind'], number> = { side: 1, foot: 0.9, corner: 1, link: 0.8, cross: 0.45 };

const tmpA = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpB = new THREE.Vector3();

export class Pedestrians {
  readonly group = new THREE.Group();
  private readonly walkers: Walker[] = [];
  private readonly paths: Path[];
  private readonly edges: WalkGraph['edges'];
  private readonly at: number[][];                 // node -> incident edge ids
  private readonly mids: THREE.Vector3[];

  ground: ((p: THREE.Vector3) => number | null) | null = null;
  onReport: ((crime: Crime, by: string) => void) | null = null;
  crimes: Crime[] = [];
  /** The player (or camera) the crowd stays around (Game sets it). */
  focus: THREE.Vector3 | null = null;
  /** Game refills this every frame; walkers also step around each other. */
  readonly blockers: Blocker[] = [];
  private readonly near: Walker[] = [];
  private traffic: Traffic | null = null;
  /** re-entry ring around the focus (m): close enough to keep the street busy, far enough not to pop in view */
  private ring: [number, number] = [20, 160];
  private gathered = false;
  /** Bring the crowd to the player again (after a teleport / a mission cut). */
  regather(): void { this.gathered = false; }
  private readonly local = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();

  constructor(specs: CharacterSpec[], rigs: GLTF[], private readonly rng: () => number, graph: WalkGraph, count = 70) {
    this.group.name = 'pedestrians';
    this.edges = graph.edges;
    const z = (i: number) => graph.nodes[i][2] + 0.02;
    this.paths = graph.edges.map((e) => {
      const pts = e.pts.map((p, k) => fromBlender(p[0], p[1], k === 0 ? z(e.a) : k === e.pts.length - 1 ? z(e.b) : (z(e.a) + z(e.b)) / 2));
      return new Path(pts);
    });
    this.mids = this.paths.map((p) => { const m = new THREE.Vector3(); p.at(p.length / 2, m, tmpT); return m; });
    this.at = graph.nodes.map(() => []);
    graph.edges.forEach((e, i) => { this.at[e.a].push(i); this.at[e.b].push(i); });
    const make = () => {
      const r = rng();
      const k = r < 0.45 ? 1 : r < 0.75 ? 0 : 2;
      const model = cloneSkinned(rigs[k].scene);
      model.rotation.y = -Math.PI / 2;
      const mesh = dressRig(model, randomLook(rng, k === 1));
      const scale = 0.95 + rng() * 0.1;
      model.scale.multiplyScalar(scale);
      const root = new THREE.Group();
      root.add(model);
      root.rotation.order = 'YXZ';
      this.group.add(root);
      const mixer = new THREE.AnimationMixer(model);
      const actions: Partial<Record<Anim, THREE.AnimationAction>> = {};
      for (const name of ['walk', 'run', 'idle'] as Anim[]) {
        const clip = rigs[k].animations.find((c) => c.name === name);
        if (clip) actions[name] = mixer.clipAction(clip);
      }
      return { root, mixer, actions, spec: specs[k], scale, mesh };
    };
    for (let i = 0; i < count; i++) {
      const m = make();
      const act = m.actions.walk!;
      act.play();
      act.time = rng() * act.getClip().duration;
      const w: Walker = {
        id: `P${i}`, ...m, anim: 'walk', e: 0, s: 0, dir: 1, waiting: false,
        speed: m.spec.walkSpeed * m.scale * (0.92 + rng() * 0.16), paused: 0, blockedS: 0, mode: 'stroll', seq: 0, reflexUntil: 0,
        off: new THREE.Vector3(), offVel: new THREE.Vector3(), phase: 'up', phaseT: 0, tilt: 0, yaw: 0, animAcc: 0,
        onRoad: false, callT: 0, callFor: null, reported: new Set(),
        side: 0, lane: 0.25 + rng() * 0.45, pe: -1, pd: 1, stuckT: 0,
      };
      this.place(w, null);
      this.walkers.push(w);
    }
  }

  setTraffic(t: Traffic): void {
    this.traffic = t;
  }

  /** Re-enter walker `w` on a random non-crossing edge, 60-220 m from `near` when given. */
  private place(w: Walker, near: THREE.Vector3 | null): void {
    for (let t = 0; t < 80; t++) {
      const e = Math.floor(this.rng() * this.edges.length);
      if (this.edges[e].kind === 'cross' || this.paths[e].length < 4) continue;
      if (near && t < 70) { const d = this.mids[e].distanceTo(near); if (d < this.ring[0] || d > this.ring[1]) continue; }
      w.e = e; w.s = this.rng() * this.paths[e].length; w.dir = this.rng() < 0.5 ? 1 : -1;
      w.waiting = false; w.onRoad = false; w.off.set(0, 0, 0); w.offVel.set(0, 0, 0);
      w.phase = 'up'; w.tilt = 0; w.callFor = null;
      w.side = w.lane; w.pe = e; w.pd = w.dir;
      this.pose(w);
      return;
    }
  }

  private pose(w: Walker): void {
    this.paths[w.e].at(w.s, tmpA, tmpT);
    if (w.e === w.pe && w.dir !== w.pd) w.side = -w.side;     // turned about on the same line: stay where you are
    w.pe = w.e; w.pd = w.dir;
    const k = w.side * w.dir;
    w.root.position.copy(tmpA).add(w.off);
    w.root.position.x -= tmpT.z * k; w.root.position.z += tmpT.x * k;
  }

  /**
   * Where to walk across the line (metres right of travel) to get round what is ahead, and how fast:
   * keep right (`lane`); anything within LOOK_AHEAD that overlaps that line is passed on the side away from it,
   * the other side when that runs out of pavement; when neither fits, stop short of it.
   */
  private steer(w: Walker, at: THREE.Vector3, fx: number, fz: number): { want: number; slow: number; stop: boolean; byPlayer: boolean } {
    let want = w.lane, slow = 1, stop = false, byPlayer = false;
    const rx = -fz, rz = fx;
    const consider = (p: THREE.Vector3, r: number, player: boolean) => {
      const dx = p.x - at.x, dz = p.z - at.z;
      if (dx * dx + dz * dz > 30 || Math.abs(p.y - at.y) > 1.5) return;
      const ah = dx * fx + dz * fz;
      if (ah < -0.2 || ah > LOOK_AHEAD) return;
      const lat = dx * rx + dz * rz, clear = r + BODY_R + 0.15;
      if (Math.abs(lat - want) >= clear) return;
      const away = lat >= w.side ? lat - clear : lat + clear, other = lat >= w.side ? lat + clear : lat - clear;
      const fits = (v: number) => Math.abs(v) <= MAX_SIDE;
      if (fits(away)) want = away;
      else if (fits(other)) want = other;
      else { want = THREE.MathUtils.clamp(away, -MAX_SIDE, MAX_SIDE); if (ah < 0.6 + r) { stop = true; byPlayer ||= player; } }
      if (ah < 1.2 + r) slow = Math.min(slow, 0.6);
    };
    for (const b of this.blockers) consider(b.p, b.r, !!b.player);
    for (const o of this.near) {
      if (o === w) continue;
      // same way: only the one behind gives way; head-on: both keep right
      consider(o.root.position, BODY_R, false);
    }
    return { want, slow, stop, byPlayer };
  }

  /** At the end node of the current edge: choose the next edge (weighted, not straight back unless a dead end). */
  private nextEdge(w: Walker): void {
    const e = this.edges[w.e];
    const node = w.dir > 0 ? e.b : e.a;
    const opts = this.at[node].filter((i) => i !== w.e);
    if (!opts.length) { w.dir = w.dir > 0 ? -1 : 1; return; }
    const ws = opts.map((i) => WEIGHT[this.edges[i].kind]);
    let r = this.rng() * ws.reduce((a, b) => a + b, 0), pick = opts[opts.length - 1];
    for (let i = 0; i < opts.length; i++) { r -= ws[i]; if (r <= 0) { pick = opts[i]; break; } }
    const ne = this.edges[pick];
    w.e = pick;
    w.dir = ne.a === node ? 1 : -1;
    w.s = w.dir > 0 ? 0 : this.paths[pick].length;
    w.waiting = ne.kind === 'cross';
  }

  private permitted(e: number): boolean {
    if (!this.traffic) return true;
    const ed = this.edges[e];
    const node = ed.node !== undefined ? this.traffic.roads.nodes[ed.node] : null;
    if (node?.signal && ed.road !== undefined) return this.traffic.roads.walk(node, ed.road) && this.traffic.clearToCross(this.mids[e], 12);
    return this.traffic.clearToCross(this.mids[e]);
  }

  witnessByRule(crime: Crime, rng: () => number): void {
    for (const w of this.walkers) {
      if (w.phase !== 'up' || w.callFor || w.reported.has(crime.id)) continue;
      if (w.root.position.distanceTo(crime.pos) < 25 && rng() < 0.35) { w.callFor = crime; w.callT = 0; }
    }
  }

  onRoad(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const w of this.walkers) if (w.onRoad || w.phase !== 'up') out.push(w.root.position);
    return out;
  }

  private play(w: Walker, anim: Anim): void {
    if (w.anim === anim || !w.actions[anim]) return;
    const from = w.actions[w.anim]!, to = w.actions[anim]!;
    to.reset().play();
    from.crossFadeTo(to, 0.25, false);
    w.anim = anim;
  }

  observe(f: PlayerFacts, max: number): PedObservation[] {
    const now = performance.now() / 1000;
    const near = this.walkers
      .filter((w) => w.phase === 'up')
      .map((w) => ({ w, d: w.root.position.distanceTo(f.pos) }))
      .filter((x) => x.d < 45)
      .sort((a, b) => a.d - b.d)
      .slice(0, max);
    return near.map(({ w }) => {
      const crash = crashSeen(w.root.position, f, now);
      const player = seePlayer(w.root.position, f);
      const seen = crimeSeen(w.root.position, this.crimes, now);
      const witness = seen && !w.reported.has(seen.crime.id) ? { kind: seen.crime.kind, agoS: seen.agoS, dist: seen.dist } : null;
      return {
        id: w.id, kind: 'ped',
        doing: w.mode === 'flee' ? 'running' : w.paused > 0 || w.waiting || w.mode === 'stop_watch' ? 'standing' : 'walking',
        player, blockedS: w.blockedS,
        crash: crash ? { ...crash, towardMe: Boolean(player?.driving && player.towardMe) } : null,
        witness,
      };
    });
  }

  update(dt: number, camera: THREE.Vector3, f: PlayerFacts, brain: NpcBrain | null): void {
    const now = performance.now() / 1000;
    const focus = this.focus ?? camera;
    if (!this.gathered && this.focus) {
      // first frame with a player: bring the whole crowd to where the player is
      this.gathered = true;
      this.ring = [8, 160];
      for (const w of this.walkers) this.place(w, focus);
      this.ring = [20, 160];
    }
    this.near.length = 0;
    for (const w of this.walkers) if (w.phase === 'up' && w.root.visible && w.root.position.distanceToSquared(camera) < 60 * 60) this.near.push(w);
    for (const w of this.walkers) {
      if (w.phase === 'up' && w.root.position.distanceTo(focus) > KEEP_M) this.place(w, focus);
      if (w.phase !== 'up') {
        this.updateDown(w, dt, now);
      } else {
        const path = this.paths[w.e];
        path.at(w.s, tmpA, tmpT);
        const along = tmpT.clone();
        const fwd = along.clone().multiplyScalar(w.dir);
        // where the walker actually is (off the line by `side`) and what it has to get round
        const kx = -tmpT.z * w.dir * w.side, kz = tmpT.x * w.dir * w.side;
        tmpB.set(tmpA.x + kx, tmpA.y, tmpA.z + kz);
        const st = this.steer(w, tmpB, fwd.x, fwd.z);
        const inFront = st.stop;
        w.stuckT = st.stop ? w.stuckT + dt : 0;
        if (w.stuckT > (st.byPlayer ? 4 : 1.2) && !w.waiting) { w.dir = w.dir === 1 ? -1 : 1; w.stuckT = 0; }
        w.blockedS = st.byPlayer && !f.driving ? w.blockedS + dt : Math.max(0, w.blockedS - dt * 2);
        const seen = seePlayer(tmpA, f, 14);
        if (seen && seen.driving && seen.towardMe && seen.etaS !== null && seen.etaS < 1.4) w.reflexUntil = now + 2.5;
        const d = brain?.get(w.id) ?? null;
        let mode: Mode = d ? (d.choice as Mode) : 'stroll';
        if (d && d.seq !== w.seq) {
          w.seq = d.seq;
          if (mode === 'turn_back' && !w.waiting) w.dir = w.dir === 1 ? -1 : 1;
        }
        if (mode === 'turn_back') mode = 'stroll';
        if (mode === 'call_police' && !w.callFor) {
          const s = crimeSeen(w.root.position, this.crimes, now);
          if (s && !w.reported.has(s.crime.id)) { w.callFor = s.crime; w.callT = 0; } else mode = 'stop_watch';
        }
        if (w.callFor) mode = 'call_police';
        if (now < w.reflexUntil) { mode = 'flee'; w.callFor = null; }
        w.mode = mode;
        let speed = 0, anim: Anim = 'walk';
        switch (mode) {
          case 'stroll': speed = w.speed; break;
          case 'hurry': speed = w.speed * 1.6; break;
          case 'flee': speed = w.spec.runSpeed * w.scale * 0.95; anim = 'run'; break;
          case 'stop_watch': case 'call_police': speed = 0; anim = 'idle'; break;
        }
        if (w.callFor) {
          w.callT += dt;
          if (w.callT > 2.5) { w.reported.add(w.callFor.id); this.onReport?.(w.callFor, w.id); w.callFor = null; }
        }
        if (mode === 'flee') {
          const away = (tmpA.x - f.pos.x) * along.x + (tmpA.z - f.pos.z) * along.z;
          w.dir = away >= 0 ? 1 : -1;
          w.waiting = false;
        }
        w.paused = inFront && mode !== 'flee' ? 0.4 : Math.max(0, w.paused - dt);
        if (w.paused > 0 && anim === 'walk') speed = 0;
        if (mode !== 'flee') speed *= st.slow;
        const ds = st.want - w.side, ls = dt * (mode === 'flee' ? 2.2 : 1.1);
        const sideStep = THREE.MathUtils.clamp(ds, -ls, ls);
        w.side += sideStep;
        const sideV = dt > 0 && speed > 0 ? sideStep / dt : 0;
        // at the kerb of a crosswalk: wait for the signal / a gap
        if (w.waiting && speed > 0) {
          if (this.permitted(w.e)) w.waiting = false;
          else { speed = 0; anim = 'idle'; }
        }
        if (speed > 0) {
          w.s += w.dir * speed * dt;
          if (w.s > path.length || w.s < 0) {
            if (mode === 'flee') { w.s = THREE.MathUtils.clamp(w.s, 0, path.length); w.dir = w.dir === 1 ? -1 : 1; }
            else this.nextEdge(w);
          }
        }
        w.onRoad = this.edges[w.e].kind === 'cross' && !w.waiting;
        const ol = w.off.length();
        if (ol > 0) w.off.multiplyScalar(Math.max(0, ol - dt * 0.9) / ol);
        this.pose(w);
        const dcam = w.root.position.distanceTo(camera);
        if (this.ground && (dcam < 60 || w.onRoad)) {
          const g = this.ground(w.root.position);
          if (g !== null && Math.abs(g - w.root.position.y) < 1.2) w.root.position.y = g;
        }
        if (mode === 'stop_watch' || mode === 'call_police') {
          const look = w.callFor ? w.callFor.pos : f.crash && now - f.crash.at < 8 ? f.crash.pos : f.pos;
          const want = Math.atan2(look.x - w.root.position.x, look.z - w.root.position.z);
          w.yaw += Math.atan2(Math.sin(want - w.yaw), Math.cos(want - w.yaw)) * Math.min(1, dt * 5);
        } else {
          this.paths[w.e].at(w.s, tmpA, tmpT);
          const heading = Math.atan2(tmpT.x * w.dir, tmpT.z * w.dir) - Math.atan2(sideV, Math.max(0.4, speed));
          w.yaw += Math.atan2(Math.sin(heading - w.yaw), Math.cos(heading - w.yaw)) * Math.min(1, dt * 10);
        }
        w.root.rotation.set(0, w.yaw, 0);
        this.play(w, speed > 0 || anim === 'walk' ? anim : 'idle');
        const act = w.actions[w.anim]!;
        if (w.anim === 'walk') act.timeScale = speed > 0 ? speed / (w.spec.walkSpeed * w.scale) : 0;
        else if (w.anim === 'run') act.timeScale = speed / (w.spec.runSpeed * w.scale);
        else act.timeScale = 1;
      }
      const dcam = w.root.position.distanceTo(camera);
      w.root.visible = dcam < 130;
      w.mesh.castShadow = dcam < 45;
      if (w.root.visible) {
        w.animAcc += dt;
        if (w.animAcc >= (dcam < 30 ? 0 : dcam < 60 ? 1 / 30 : 1 / 15)) { w.mixer.update(w.animAcc); w.animAcc = 0; }
      }
    }
  }

  private updateDown(w: Walker, dt: number, now: number): void {
    w.phaseT -= dt;
    if (w.phase === 'falling') {
      w.tilt = Math.max(-Math.PI / 2, w.tilt - dt * 6);
      if (w.phaseT <= 0) { w.phase = 'lying'; w.phaseT = 4 + (w.id.charCodeAt(w.id.length - 1) % 3); }
    } else if (w.phase === 'lying') {
      if (w.phaseT <= 0) { w.phase = 'rising'; w.phaseT = 0.8; }
    } else if (w.phase === 'rising') {
      w.tilt = Math.min(0, w.tilt + dt * 2.2);
      if (w.phaseT <= 0) {
        w.phase = 'up'; w.tilt = 0; w.blockedS = 0;
        w.reflexUntil = now + 3;
        w.actions[w.anim]!.timeScale = 1;
      }
    }
    w.off.addScaledVector(w.offVel, dt);
    w.offVel.multiplyScalar(Math.exp(-dt * 5));
    this.pose(w);
    if (this.ground) { const g = this.ground(w.root.position); if (g !== null) w.root.position.y = g; }
    w.root.rotation.set(w.tilt, w.yaw, 0);
  }

  pushPlayer(p: THREE.Vector3, radius: number): boolean {
    let hit = false;
    const r = radius + BODY_R;
    for (const w of this.walkers) {
      if (w.phase !== 'up' || Math.abs(p.y - w.root.position.y) > 1.5) continue;
      const dx = p.x - w.root.position.x, dz = p.z - w.root.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      p.x = w.root.position.x + (dx / d) * r;
      p.z = w.root.position.z + (dz / d) * r;
      hit = true;
    }
    return hit;
  }

  hitByCar(car: CarBody): KnockEvent[] {
    const out: KnockEvent[] = [];
    car.obj.updateMatrixWorld();
    this.inv.copy(car.obj.matrixWorld).invert();
    const fx = -Math.sin(car.obj.rotation.y), fz = -Math.cos(car.obj.rotation.y);
    for (const w of this.walkers) {
      if (w.phase !== 'up') continue;
      const p = w.root.position;
      if ((p.x - car.obj.position.x) ** 2 + (p.z - car.obj.position.z) ** 2 > 49 || Math.abs(p.y - car.obj.position.y) > 2) continue;
      const l = this.local.copy(p).applyMatrix4(this.inv);
      const hx = car.half.x + BODY_R, hz = car.half.y + BODY_R;
      if (Math.abs(l.x) >= hx || Math.abs(l.z) >= hz) continue;
      const v = Math.abs(car.speed);
      if (v < KNOCK_SPEED) {
        const px = hx - Math.abs(l.x), pz = hz - Math.abs(l.z);
        if (px < pz) l.x = Math.sign(l.x || 1) * hx; else l.z = Math.sign(l.z || 1) * hz;
        const world = l.applyMatrix4(car.obj.matrixWorld);
        w.off.x += world.x - p.x; w.off.z += world.z - p.z;
        w.paused = 0.6;
        continue;
      }
      const sgn = Math.sign(car.speed) || 1;
      const side = Math.sign(l.x || 1) * 0.35;
      w.offVel.set((fx * sgn + fz * side) * v * 0.55, 0, (fz * sgn - fx * side) * v * 0.55);
      w.yaw = Math.atan2(-fx * sgn, -fz * sgn);
      w.phase = 'falling'; w.phaseT = 0.3; w.tilt = 0;
      w.reflexUntil = 0; w.waiting = false;
      this.play(w, 'idle');
      if (w.actions.idle) w.actions.idle.timeScale = 0;
      out.push({ id: w.id, pos: p.clone() });
    }
    return out;
  }

  headOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const w = this.walkers.find((x) => x.id === id);
    return w ? out.copy(w.root.position).setY(w.root.position.y + w.spec.height * w.scale + 0.35) : null;
  }

  get count(): number {
    return this.walkers.length;
  }
}
