import * as THREE from 'three';
import { fromBlender } from '../config';
import { obbContact } from '../systems/CarCollisions';
import { SHOP_U } from '../world/ShopLight';

/**
 * In-game regression suite (test-first: most of these were written red, against the bugs in
 * guangzhou/docs/review_2026-09-29.md, and turn green as the fixes land).
 *
 *   window.__GZ__.qa.run()            all tests      window.__GZ__.qa.run('VEH')   ids starting with VEH
 *   window.__GZ__.qa.list()           ids + titles
 *
 * Every test drives the real game through fixed-dt `update()` calls (no rendering, no rAF), sets up its own
 * state and puts the player back on foot at the spawn afterwards. Results: { id, title, pass, detail, ms }.
 * Tests marked `info` report a number without failing the run.
 */
type Vec3 = THREE.Vector3;
interface Car {
  obj: THREE.Group; half: THREE.Vector2; speed: number; heading: number;
  // vehicle physics v2 (undefined before it lands, so the new tests fail instead of crashing)
  vy?: number; pitch?: number; roll?: number; airborne?: boolean; airTime?: number; inWater?: boolean;
  lastSafe?: { pos: Vec3; heading: number };
}
type Pilot = (car: Car, dt: number) => { throttle: number; steer: number; handbrake: boolean };
interface QAGame {
  update(dt: number, t: number): void;
  playing: boolean;
  /** replaces keyboard input for the player's car while set (QA autopilot) */
  pilot: Pilot | null;
  characters: { root: THREE.Object3D; heading: number; placeAt(p: Vec3, h: number): void; spec: { spawn: Vec3 } }[];
  active: number;
  parked: Car[];
  seat: Map<number, Car>;
  input: { interactQueued: boolean; setKey(code: string, down: boolean): void };
  rig: { yaw: number; pitch: number };
  collision: { groundHeight(o: Vec3, d: number): number | null; raycastDistance(o: Vec3, d: Vec3, far: number): number };
  roofs: { group: THREE.Group; roofs: Record<'core' | 'far', { n: number; filled: number }> };
  furniture: { group: THREE.Group; places: { proto: string; x: number; y: number }[] };
  props: { raycast(o: Vec3, d: Vec3, far: number): number; count: number; nearest(x: number, z: number, r: number, f?: (k: string) => boolean, y?: number): { kind: string; x: number; z: number } | null } & Record<string, unknown>;
  traffic: { roads: { lanes: QALane[]; lanesNear(p: Vec3): QALane[] }; respawnLog: Vec3[]; stats(): { stuck: number }; cars: TCar[] };
  crimes: { kind: string; at: number }[];
  facades: { instances: number; near: number[]; sync(p: Vec3): void };
  walk: { edges: { kind: string; pts: [number, number][] }[] };
  camera: THREE.PerspectiveCamera;
  weather: { set(v: number): void; rain: number };
  env: { setHour(h: number): void; hour: number; night: number };
  render(): void;
  canvas: HTMLCanvasElement;
  pedestrians: { regather(): void };
  scene: THREE.Scene;
  metro: QAMetro;
  metroCard: number;
  apm: QAApm;
  apmTrains: { trains: QATrain[] };
  apmPax: {
    stats(): { wait: number; sit: number; ride: number; walk: number; focus: string | null; perTrain: number[] };
    people(): { id: number; act: string; after: string; pos: Vec3; train: number | null; esc: boolean }[];
  };
  riding: unknown;
  city: { meta: { bounds_m: number[] }; lampPoles: [number, number, number][]; treePos: [number, number, number][]; root: THREE.Object3D };
}
interface QAStation { key: string; name: string; yaw: number; x: number; y: number }
interface QAApm {
  stations: QAStation[];
  L: { concourse: number; platform: number; rail: number };
  F: { paid_u: number[]; stair_top: number; box_u: number; conc_v: number; island_v: number };
  data: { passages: Record<string, number[][]> };
  group: THREE.Group;
  fromFrame(st: QAStation, u: number, v: number, z?: number): THREE.Vector3;
  toFrame(st: QAStation, x: number, y: number): [number, number];
  paidAt(p: Vec3): QAStation | null;
}
interface QATrain { id: number; track: number; phase: string; doors: number; at: QAStation | null; terminus: boolean; t: number }
/** three.js point of an APM station-frame position. */
function apmPoint(g: QAGame, st: QAStation, u: number, v: number, z: number): Vec3 { const b = g.apm.fromFrame(st, u, v, z); return fromBlender(b.x, b.y, b.z); }
/** Walk the player (W held, camera turned) to a three.js point; true if within tol metres (xz) in time. */
function walkTo(g: QAGame, target: Vec3, seconds: number, tol = 0.7): boolean {
  const ch = g.characters[g.active];
  let t = 0;
  g.input.setKey('KeyW', true);
  try {
    while (t < seconds) {
      const p = ch.root.position;
      const dx = target.x - p.x, dz = target.z - p.z;
      if (Math.hypot(dx, dz) < tol) return true;
      g.rig.yaw = Math.atan2(-dx, -dz);
      step(g, 6); t += 0.1;
    }
  } finally { g.input.setKey('KeyW', false); }
  return false;
}
interface QAExit { id: string; station: string; kind: string; x: number; y: number; z: number; yaw: number }
interface QAMetro {
  exits: QAExit[];
  L: { floor_z: number; lid_z: number; hall_ceil: number; steps_y0: number; gates_y: number; stair_end: number; pit: number[]; hall: number[] };
  apm: Set<string>;
  local(e: QAExit, lx: number, ly: number, lz?: number): [number, number, number];
  at(p: Vec3): QAExit | null;
  arrive(e: QAExit): { pos: Vec3; heading: number };
}
/** three.js point at an exit's local (lx, ly, lz). */
function exitPoint(g: QAGame, e: QAExit, lx: number, ly: number, lz = 0): Vec3 { const [x, y, z] = g.metro.local(e, lx, ly, lz); return fromBlender(x, y, z); }
interface TCar { obj: THREE.Object3D; half: THREE.Vector2; speed: number; fwd: Vec3; crashT: number; conn: unknown; lane: QALane; s: number }
interface QALane {
  edge: number; index: number; count: number; width: number;
  path: { length: number; pts: Vec3[]; at(s: number, p: Vec3, t: Vec3): void }; from: { z: number }; to: { z: number };
}
interface Result { id: string; title: string; pass: boolean; info?: boolean; detail: string; ms: number }
type Test = { id: string; title: string; info?: boolean; run: (g: QAGame) => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }> };

let simT = 1e5;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
function step(g: QAGame, frames: number, dt = 1 / 60): void { for (let i = 0; i < frames; i++) { simT += dt; g.update(dt, simT); } }
function ground(g: QAGame, x: number, y: number): number | null { return g.collision.groundHeight(fromBlender(x, y, 30), 60); }
function onFoot(g: QAGame): void {
  if (g.seat.get(g.active)) { g.input.interactQueued = true; step(g, 2); }
  const gb = g as unknown as QABikeGame;
  if (gb.pilotBike) gb.pilotBike = null;
  if (gb.rider?.ch === g.active) { gb.bike.speed = 0; g.input.interactQueued = true; step(g, 40); }
  for (let i = 0; i < 600 && gb.thrown?.ch === g.active; i++) step(g, 1);
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']) g.input.setKey(k, false);
}
function home(g: QAGame): void {
  onFoot(g);
  const s = g.characters[g.active].spec.spawn;
  g.characters[g.active].placeAt(s.clone().setY(s.y + 0.3), Math.PI);
  step(g, 5);
}
/** Put the player in the first protagonist's parked car and return it. */
function drive(g: QAGame): Car {
  onFoot(g);
  const car = g.parked[0];
  const ch = g.characters[g.active];
  ch.placeAt(car.obj.position.clone().add(V(2.2, 0.5, 0)), 0);
  step(g, 5);
  g.input.interactQueued = true; step(g, 2);
  const c = g.seat.get(g.active);
  if (!c) throw new Error('could not enter the car');
  return c;
}
// ------------------------------------------------------------------ the e-bike
interface QABikeGame {
  ebike: { obj: THREE.Object3D; standK: number; grip(k: number, out: Vec3): Vec3; spec: { wheelbase: number } };
  bike: {
    obj: THREE.Object3D; half: THREE.Vector2; speed: number; heading: number; lean: number; crashed: boolean; skidding: boolean;
    vlat: number; vy: number; targetH: number; prev: Vec3; crash: { speed: number; car: boolean } | null;
  };
  bikes: { rightUp(b: unknown, lift?: boolean): void; cars: unknown };
  rider: { ch: number; mount: number; dir: number; pose: { limbs: { hand: THREE.Bone[] }; armSide: number[] } } | null;
  thrown: { ch: number; phase: string; pos: Vec3 } | null;
  pilotBike: { throttle: number; steer: number; brake: boolean } | null;
  jobs: {
    phase: string; pickup: { pos: Vec3; name: string; cat: string }; drop: { pos: Vec3; name: string; cat: string }; timeLimit: number; timeLeft: number; pace: number;
    condition: number; cash: number; rating: number; pickups: { pos: Vec3; name: string; cat: string }[]; drops: { pos: Vec3; name: string; cat: string }[];
    assign(p: unknown, d: unknown, from: Vec3): void; pick(): void; deliver(mult?: number, tip?: number): unknown; close(): void;
  };
  parkBike(p: Vec3, facing?: number): void;
}
const bikeOf = (g: QAGame) => g as unknown as QABikeGame;
/** The bike to a three.js point (on the ground there), facing `heading`, still and upright. */
function placeBike(g: QAGame, p: Vec3, heading: number): void {
  const B = bikeOf(g), b = B.bike;
  if (b.crashed) B.bikes.rightUp(b);
  b.obj.position.set(p.x, 0, p.z);
  b.obj.position.y = g.collision.groundHeight(V(p.x, p.y + 2, p.z), 6) ?? p.y;
  b.heading = heading; b.speed = 0; b.vlat = 0; b.vy = 0; b.lean = 0; b.targetH = NaN; b.prev.copy(b.obj.position);
  b.obj.rotation.set(0, heading, 0, 'YXZ');
}
/** The active character gets on the bike (standing beside it, F); throws if that fails. */
function mountBike(g: QAGame): QABikeGame {
  const B = bikeOf(g);
  onFoot(g);
  const ch = g.characters[g.active];
  B.bike.obj.updateMatrixWorld();
  ch.placeAt(B.bike.obj.localToWorld(V(-0.9, 0, 0.2)).setY(B.bike.obj.position.y + 0.05), B.bike.heading + Math.PI);
  step(g, 3);
  g.input.interactQueued = true;
  step(g, 45);
  if (B.rider?.ch !== g.active || B.rider.mount < 1) throw new Error('could not get on the e-bike');
  return B;
}
/** Back on foot, the bike parked by Ah Jie's spawn again. */
function parkBikeHome(g: QAGame): void {
  onFoot(g);
  const B = bikeOf(g);
  if (B.bike.crashed) B.bikes.rightUp(B.bike);
  B.parkBike(g.characters[0].spec.spawn, (g.characters[0].spec as unknown as { spawnHeading: number }).spawnHeading);
  g.characters[g.active].placeAt(g.characters[g.active].spec.spawn.clone().setY(g.characters[g.active].spec.spawn.y + 0.3), Math.PI);
  step(g, 3);
}
/** A traffic car on a long straight, and the bike `back` metres behind it in its lane, facing along it. */
function bikeBehindTraffic(g: QAGame, back: number): TCar | null {
  const t = g.traffic.cars.find((x) => !x.conn && x.speed > 3 && x.lane.from.z < 0.3 && x.lane.to.z < 0.3 && x.lane.path.length - x.s > 90 && x.s > back + 10 && x.half.y < 3);
  if (!t) return null;
  const p = V(), tan = V();
  t.lane.path.at(t.s - back, p, tan);
  placeBike(g, p, Math.atan2(-tan.x, -tan.z));
  return t;
}


// ------------------------------------------------------------------ the order game
interface QAActor { name: string; tag: string; root: THREE.Object3D; bubble: HTMLElement | null }
interface QAOrders {
  enabled: boolean; storyStep: number; sinceStory: number; chapterDone: boolean;
  order: null | { state: string; mode: string; story: { id: string } | null; shop: { pos: Vec3; spots: Record<string, Vec3> }; drop: { pos: Vec3; place?: { spots: Record<string, Vec3>; sub: string }; name: string }; note: string; look: { topColor?: string }; photo: { good: boolean; text: string } | null; flags: Record<string, unknown>; customer: { id: string } };
  scene: { shop: QAActor[]; drop: QAActor[] };
  reset(): void; cancel(): void; crashHelp(bike: Vec3, rider: Vec3): void;
  debugOrder(from: Vec3, o: { customer: string; merchant?: string; mode: string; sub?: string }): boolean;
}
interface QADialog { open: boolean; choosing: boolean; pauseT: number; current: { who: string; text: string } | null; log: string[]; finishLine(): void }
interface QAOrderGame { orders: QAOrders; dialogue: QADialog; photo: { active: boolean; live: { good: boolean; bag: boolean; plate: boolean } }; input: { talkQueued: boolean; digitQueued: number | null; jumpQueued: boolean } }
const og = (g: QAGame) => g as unknown as QAOrderGame & QAGame;

/** Click through the conversation: choice `pick` (0-based) at every question. Returns the lines seen. */
function talkThrough(g: QAGame, pick = 0, max = 120): string[] {
  const G = og(g), D = G.dialogue, lines: string[] = [];
  for (let i = 0; i < max && D.open; i++) {
    if (D.pauseT > 0) { step(g, Math.ceil(D.pauseT * 60) + 2); continue; }
    if (D.choosing) { G.input.digitQueued = pick; step(g, 1); continue; }
    D.finishLine();
    if (D.current) lines.push(D.current.text);
    G.input.talkQueued = true; step(g, 1);
  }
  return lines;
}
function goTo(g: QAGame, p: Vec3): void { const c = g.characters[g.active]; c.placeAt(p.clone().setY(p.y + 0.05), c.heading); step(g, 4); }
function pressE(g: QAGame): void { og(g).input.talkQueued = true; step(g, 1); }

/**
 * Play the current order to the end like a player on foot: the shop (waiting it out), then the drop -- find the
 * customer at a stop, the locker at a tower (or the customer coming down), the photo at a door.
 * lobbyChoice: what to tell the guard (0 locker, 1 call, 2 go up). Returns a log line.
 */
function playOrder(g: QAGame, lobbyChoice = 0): string {
  const G = og(g), O = G.orders;
  for (let i = 0; i < 400 && (!O.order || O.order.state === 'done'); i++) { talkThrough(g); step(g, 10); }
  talkThrough(g);
  const o = O.order;
  if (!o) return 'no order';
  if (o.state !== 'carrying') {
    goTo(g, o.shop.pos); step(g, 10);
    pressE(g); talkThrough(g);
    for (let i = 0; i < 90 && o.state === 'waiting'; i++) { step(g, 60); talkThrough(g); }
    // a conversation may pop up meanwhile (a story epilogue): read it, then ask again
    for (let k = 0; k < 3 && (o.state === 'ready' || o.state === 'toShop'); k++) { talkThrough(g); goTo(g, o.shop.pos); pressE(g); talkThrough(g); }
  }
  if (o.state !== 'carrying') return `stuck at the shop (${o.state})`;
  goTo(g, o.drop.pos); step(g, 30);
  for (let tries = 0; tries < 6 && o.state === 'carrying'; tries++) {
    if (o.flags.comingDown && !O.scene.drop.some((a) => a.tag === 'cust')) step(g, 60 * 28);
    const robot = (O as unknown as { robotObj: { obj: THREE.Object3D } | null }).robotObj;
    if (robot) { step(g, 60 * 3); goTo(g, robot.obj.position.clone().add(V(0.9, 0, 0))); pressE(g); talkThrough(g); continue; }
    const cust = O.scene.drop.find((a) => a.tag === 'cust');
    if (cust) {
      // step up to them from the side away from the others
      const away = V();
      for (const a of O.scene.drop) if (a !== cust) away.add(V().subVectors(cust.root.position, a.root.position).setY(0).normalize());
      if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
      goTo(g, cust.root.position.clone().addScaledVector(away.normalize(), 0.75)); pressE(g); talkThrough(g); continue;
    }
    if (o.mode === 'lobby') {
      const lockerFirst = (o as unknown as { toLocker: boolean }).toLocker;
      if (lockerFirst && o.drop.place?.spots.locker) { goTo(g, o.drop.place.spots.locker); pressE(g); talkThrough(g); continue; }
      const guard = O.scene.drop.find((a) => a.tag === 'guard' || a.tag === 'libo');
      if (guard) { goTo(g, guard.root.position.clone().lerp(o.drop.pos, 0.55)); pressE(g); talkThrough(g, lobbyChoice); step(g, 60 * 25); continue; }
    }
    if (o.mode === 'door' && o.drop.place?.spots.door) {
      goTo(g, o.drop.place.spots.door); pressE(g); talkThrough(g, 1); step(g, 2);
      if (G.photo.active) { G.input.jumpQueued = true; step(g, 3); }
      continue;
    }
    step(g, 60);
  }
  const st = o.state as string;
  return st === 'done' ? `${o.story?.id ?? 'order'} ${o.mode} done` : `stuck at the drop (${o.mode}, ${st})`;
}

/** Place a car at Blender (x, y, z) facing along Blender direction (dx, dy). */
function placeCar(c: Car, x: number, y: number, z: number, dx: number, dy: number, speed = 0): void {
  c.obj.position.copy(fromBlender(x, y, z));
  // model forward is -Z (three.js); Blender (dx, dy) -> three.js (dx, 0, -dy)
  c.heading = Math.atan2(-dx, dy);
  c.obj.rotation.set(0, c.heading, 0);
  c.speed = speed;
}
/** Instances of a street-furniture material, as [position, local X axis, local Z axis] in three.js space. */
function furniture(g: QAGame, mat: string): [Vec3, Vec3, Vec3][] {
  const out: [Vec3, Vec3, Vec3][] = [];
  const m = new THREE.Matrix4();
  for (const o of g.furniture.group.children) {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || (im.material as THREE.Material).name !== mat) continue;
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, m);
      out.push([V().setFromMatrixPosition(m), V(1, 0, 0).transformDirection(m), V(0, 0, 1).transformDirection(m)]);
    }
  }
  return out;
}
/**
 * Walk the player toward a three.js point for `seconds`; returns the closest horizontal approach.
 * Throws if the character never got going (a frozen player would otherwise "pass" every blocking test).
 */
function walkInto(g: QAGame, target: Vec3, seconds: number): number {
  const p = g.characters[g.active].root.position;
  const start = Math.hypot(target.x - p.x, target.z - p.z);
  let best = Infinity;
  for (let i = 0; i < seconds * 60; i++) {
    const d = V(target.x - p.x, 0, target.z - p.z);
    g.rig.yaw = Math.atan2(-d.x, -d.z);
    g.input.setKey('KeyW', true);
    step(g, 1);
    best = Math.min(best, Math.hypot(target.x - p.x, target.z - p.z));
  }
  g.input.setKey('KeyW', false);
  if (start - best < 1) throw new Error(`player did not walk (start ${start.toFixed(2)} m, closest ${best.toFixed(2)} m)`);
  return best;
}

/** Penetration depth of two car footprints (0 if apart). */
function overlap(a: { obj: THREE.Object3D; half: THREE.Vector2; heading?: number; fwd?: Vec3 }, b: { obj: THREE.Object3D; half: THREE.Vector2; heading?: number; fwd?: Vec3 }): number {
  const h = (c: typeof a) => c.heading ?? Math.atan2(-c.fwd!.x, -c.fwd!.z);
  const k = obbContact(
    { x: a.obj.position.x, z: a.obj.position.z, hx: a.half.x, hz: a.half.y, h: h(a) },
    { x: b.obj.position.x, z: b.obj.position.z, hx: b.half.x, hz: b.half.y, h: h(b) });
  return k ? k.depth : 0;
}
/** Offsets -w..w every 0.12 m (a fan of parallel rays covering a body's width; bollards are 0.16 m thick). */
function fan(w: number): number[] {
  const n = Math.max(1, Math.ceil((2 * w) / 0.12));
  return Array.from({ length: n + 1 }, (_, i) => -w + (2 * w * i) / n);
}
/**
 * A start point `dist` from `target` (three.js) whose straight run to it is clear: no prop or wall within a
 * corridor `halfWidth` wide short of the target's own radius, and ground at the target's level. Tries 24
 * directions; returns the start and the unit direction toward the target, or null.
 */
function approach(g: QAGame, target: Vec3, targetR: number, dist: number, halfWidth: number): { from: Vec3; dir: Vec3 } | null {
  const o = V(), side = V();
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2 + 0.13;
    const dir = V(-Math.cos(a), 0, -Math.sin(a));                 // toward the target
    const from = target.clone().addScaledVector(dir, -dist);
    const gy = g.collision.groundHeight(o.copy(from).setY(target.y + 1), 2);
    if (gy === null || Math.abs(gy - target.y) > 0.25) continue;
    from.y = gy;
    side.set(-dir.z, 0, dir.x);
    const far = dist - targetR - 0.15;
    let clear = true;
    for (const off of fan(halfWidth)) {
      for (const h of [0.5, 1.0]) {
        o.copy(from).addScaledVector(side, off).setY(gy + h);
        if (g.props.raycast(o, dir, far) < far || g.collision.raycastDistance(o, dir, dist + 1) < dist + 1) { clear = false; break; }
      }
      if (!clear) break;
    }
    if (clear) return { from, dir };
  }
  return null;
}
/** Horizontal distance from a point to a lane's centreline, and the lane point / tangent there. */
function nearestOnLanes(g: QAGame, p: Vec3): { d: number; pos: Vec3; tan: Vec3 } {
  let best = { d: Infinity, pos: V(), tan: V() };
  const q = V(), t = V();
  for (const l of g.traffic.roads.lanesNear(p)) {
    for (let s = 0; s <= l.path.length; s += 1) {
      l.path.at(s, q, t);
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < best.d) best = { d, pos: q.clone(), tan: t.clone() };
    }
  }
  return best;
}
/**
 * Drive the player's car along a polyline (three.js points) with a pure-pursuit autopilot at `speed`.
 * Returns per-frame samples after the first `settle` seconds.
 */
function followPath(g: QAGame, c: Car, pts: Vec3[], speed: number, settle = 1.5) {
  const path = { cum: [0] as number[] };
  for (let i = 1; i < pts.length; i++) path.cum.push(path.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = path.cum[path.cum.length - 1];
  const at = (s: number, out: Vec3, tan?: Vec3) => {
    s = Math.max(0, Math.min(L, s));
    let i = 1; while (i < pts.length - 1 && path.cum[i] < s) i++;
    const k = (s - path.cum[i - 1]) / Math.max(1e-6, path.cum[i] - path.cum[i - 1]);
    out.lerpVectors(pts[i - 1], pts[i], k);
    if (tan) tan.subVectors(pts[i], pts[i - 1]).normalize();
  };
  const t0 = V();
  at(0, c.obj.position, t0);
  c.obj.position.y += 0.05;
  c.heading = Math.atan2(-t0.x, -t0.z); c.obj.rotation.set(0, c.heading, 0); c.speed = speed;
  let s = 0, time = 0;
  const samples: { t: number; air: boolean; dy: number; dPitch: number; lat: number }[] = [];
  const P = V(), T = V(), A = V();
  g.pilot = (car) => {
    const p = car.obj.position;
    // project onto the path near the last station
    let bestS = s, bd = Infinity;
    for (let q = s - 5; q < s + 30; q += 0.5) { at(q, P); const d = Math.hypot(P.x - p.x, P.z - p.z); if (d < bd) { bd = d; bestS = q; } }
    s = Math.max(s, bestS);
    at(s + 9 + Math.abs(car.speed) * 0.35, A);
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    const dx = A.x - p.x, dz = A.z - p.z;
    const cross = fx * dz - fz * dx;          // >0: target to the right of forward (three.js, looking down -y)
    const ang = Math.atan2(cross, fx * dx + fz * dz);
    const steer = THREE.MathUtils.clamp(ang * 2.2, -1, 1);
    const throttle = THREE.MathUtils.clamp((speed - car.speed) * 0.5, -1, 1);
    return { throttle, steer, handbrake: false };
  };
  const dt = 1 / 60;
  try {
    while (s < L - 12 && time < L / speed * 2 + 10) {
      step(g, 1, dt); time += dt;
      if (time < settle) continue;
      at(s, P, T);
      const p = c.obj.position;
      samples.push({ t: time, air: !!c.airborne, dy: p.y - P.y, dPitch: (c.obj.rotation.x - Math.asin(THREE.MathUtils.clamp(T.y, -1, 1))) * 57.3, lat: Math.hypot(P.x - p.x, P.z - p.z) });
    }
  } finally { g.pilot = null; }
  return { samples, time, done: s >= L - 12, length: L };
}
/** Lanes of one road edge chained into a polyline: lane `index` of the edge, as three.js points. */
function edgeLane(g: QAGame, edge: number, index = 1): Vec3[] {
  const l = g.traffic.roads.lanes.find((x) => x.edge === edge && x.index === Math.min(index, x.count - 1));
  return l ? l.path.pts.map((p) => p.clone()) : [];
}

const TESTS: Test[] = [
  // ------------------------------------------------------------------ vehicles
  {
    id: 'VEH-01', title: '车从 8 m 高处 2 秒内落地（有重力）',
    run: (g) => {
      const c = drive(g);
      const gy = ground(g, 20, -400)!;
      placeCar(c, 20, -400, gy + 8, 0, 1);
      step(g, 120);
      const y = c.obj.position.y;
      return { pass: Math.abs(y - gy) < 0.35, detail: `ground ${gy.toFixed(2)} m, car ${y.toFixed(2)} m after 2 s` };
    },
  },
  {
    id: 'VEH-02', title: '车开进珠江会落水（下沉或被捞回岸上），不能在水面上开',
    run: (g) => {
      const c = drive(g);
      placeCar(c, 300, -900, 0.2, 0, 1);
      const start = c.obj.position.clone();
      step(g, 150);
      const p = c.obj.position;
      const moved = p.distanceTo(start) > 20;          // rescued to the last dry spot
      return { pass: p.y < -0.6 || moved, detail: `car at y ${p.y.toFixed(2)} m, moved ${p.distanceTo(start).toFixed(1)} m` };
    },
  },
  {
    id: 'VEH-03', title: '地图边界：开不出地图东界',
    run: (g) => {
      const c = drive(g);
      const x1 = g.city.meta.bounds_m[2];
      const gy = ground(g, x1 - 40, 0) ?? 0.15;
      placeCar(c, x1 - 40, 0, gy + 0.1, 1, 0, 20);
      g.input.setKey('KeyW', true); step(g, 300); g.input.setKey('KeyW', false);
      const x = c.obj.position.x;
      return { pass: x < x1 + 5, detail: `east bound ${x1.toFixed(0)}, car ended at x ${x.toFixed(0)}` };
    },
  },
  {
    id: 'VEH-04', title: '坡道上车身随坡度俯仰（误差 < 3°）并贴合路面',
    run: (g) => {
      const c = drive(g);
      const p = V(), t = V();
      let found: { p: Vec3; t: Vec3 } | null = null;
      for (const l of g.traffic.roads.lanes) {
        for (let s = 5; s < l.path.length - 5 && !found; s += 5) {
          l.path.at(s, p, t);
          if (t.y > 0.045 && t.y < 0.12 && p.y > 2) found = { p: p.clone(), t: t.clone() };
        }
        if (found) break;
      }
      if (!found) return { pass: false, detail: 'no ramp lane found' };
      c.obj.position.copy(found.p);
      c.heading = Math.atan2(-found.t.x, -found.t.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 0;
      step(g, 30);
      const want = Math.asin(found.t.y);
      const pitch = c.obj.rotation.x;
      const dy = c.obj.position.y - found.p.y;
      return { pass: Math.abs(pitch - want) < 0.052 && Math.abs(dy) < 0.4, detail: `slope ${(want * 57.3).toFixed(1)}°, car pitch ${(pitch * 57.3).toFixed(1)}°, height error ${dy.toFixed(2)} m` };
    },
  },
  {
    id: 'VEH-05', title: '平路操控基线：满油 3 秒到 14–30 m/s，不跑偏',
    run: (g) => {
      const c = drive(g);
      const p = V(), t = V();
      const lane = g.traffic.roads.lanes.find((l) => l.path.length > 200 && l.from.z < 0.5 && l.to.z < 0.5);
      if (!lane) return { pass: false, detail: 'no flat lane' };
      lane.path.at(20, p, t);
      c.obj.position.copy(p); c.heading = Math.atan2(-t.x, -t.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 0;
      const h0 = c.heading;
      g.input.setKey('KeyW', true); step(g, 180); g.input.setKey('KeyW', false);
      const drift = Math.abs(c.heading - h0) * 57.3;
      return { pass: c.speed > 14 && c.speed < 30 && drift < 2, detail: `speed ${c.speed.toFixed(1)} m/s, heading drift ${drift.toFixed(2)}°` };
    },
  },
  {
    id: 'VEH-06', title: '车撞护栏停下或弹开，不能穿过',
    run: (g) => {
      const c = drive(g);
      const rails = furniture(g, 'GZK | rail green');
      if (!rails.length) return { pass: false, detail: 'no railings' };
      // a railing segment with a clear 7 m run-up square to it, from either side
      let rp = V(), n = V();
      const o = V();
      for (let i = Math.floor(rails.length / 3); i < rails.length && !n.lengthSq(); i += 97) {
        const [p, x, z] = rails[i];
        for (const sgn of [1, -1]) {
          const nn = z.clone().setY(0).normalize().multiplyScalar(sgn);
          const along = x.clone().setY(0).normalize();
          const from = p.clone().addScaledVector(nn, 7);
          const gy = g.collision.groundHeight(o.copy(from).setY(p.y + 1), 2);
          if (gy === null || Math.abs(gy - p.y) > 0.3) continue;
          const dir = nn.clone().negate();
          if (fan(1.2).some((off) => g.props.raycast(o.copy(from).addScaledVector(along, off).setY(p.y + 0.7), dir, 6.6) < 6.6)) continue;
          if (g.collision.raycastDistance(o.copy(from).setY(p.y + 0.8), dir, 7) < 7) continue;
          rp = p; n = nn; break;
        }
      }
      if (!n.lengthSq()) return { pass: false, detail: 'no railing with a clear run-up' };
      const from = rp.clone().addScaledVector(n, 7);
      c.obj.position.copy(from).setY(rp.y + 0.05);
      c.heading = Math.atan2(n.x, n.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 12;   // facing -n (toward the rail)
      let closest = Infinity;
      g.input.setKey('KeyW', true);
      for (let i = 0; i < 90; i++) { step(g, 1); closest = Math.min(closest, c.obj.position.clone().sub(rp).dot(n)); }
      g.input.setKey('KeyW', false);
      const side = c.obj.position.clone().sub(rp).dot(n);
      return { pass: side > 0.5 && closest < 3, detail: `car centre ${side.toFixed(2)} m on the start side of the railing (negative = drove through), closest ${closest.toFixed(2)} m` };
    },
  },
  {
    id: 'VEH-07', title: '车撞路灯杆被挡住',
    run: (g) => {
      const c = drive(g);
      let pole = V(), dir = V();
      for (let i = 200; i < g.city.lampPoles.length; i += 37) {
        const [x, y, z] = g.city.lampPoles[i];
        const a = approach(g, fromBlender(x, y, z), 0.13, 9, 1.2);
        if (a) { pole = fromBlender(x, y, z); dir = a.dir; break; }
      }
      if (!dir.lengthSq()) return { pass: false, detail: 'no lamp post with a clear run-up' };
      c.obj.position.copy(pole).addScaledVector(dir, -9).setY(pole.y + 0.05);
      c.heading = Math.atan2(-dir.x, -dir.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 10;
      let closest = Infinity;
      g.input.setKey('KeyW', true);
      for (let i = 0; i < 90; i++) { step(g, 1); closest = Math.min(closest, Math.hypot(c.obj.position.x - pole.x, c.obj.position.z - pole.z)); }
      g.input.setKey('KeyW', false);
      return { pass: closest > 0.9 && closest < 3, detail: `closest approach of the car centre to the pole axis ${closest.toFixed(2)} m` };
    },
  },
  {
    id: 'VEH-08', title: '车撞停着的车不能互相穿透（包围盒重叠 < 0.3 m）',
    run: (g) => {
      const c = drive(g);
      const other = g.parked[1];
      // the other car stands across a straight lane; the player drives along the lane into its side
      const lane = g.traffic.roads.lanes.filter((l) => l.path.length > 200 && l.from.z < 0.3 && l.to.z < 0.3)[7];
      const p = V(), t = V();
      lane.path.at(90, p, t);
      other.obj.position.copy(p).setY(p.y + 0.02);
      other.heading = Math.atan2(-t.z, t.x);                 // square to the lane
      other.obj.rotation.set(0, other.heading, 0); other.speed = 0;
      (other as unknown as { settled: boolean }).settled = false;
      lane.path.at(70, p, t);
      c.obj.position.copy(p).setY(p.y + 0.05);
      c.heading = Math.atan2(-t.x, -t.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 12;
      let worst = 0, closest = Infinity;
      g.pilot = () => ({ throttle: 1, steer: 0, handbrake: false });
      try {
        for (let i = 0; i < 100; i++) {
          step(g, 1);
          worst = Math.max(worst, overlap(c, other));
          closest = Math.min(closest, c.obj.position.distanceTo(other.obj.position));
        }
      } finally { g.pilot = null; }
      return { pass: worst < 0.3 && closest < 4, detail: `max overlap ${worst.toFixed(2)} m, closest centres ${closest.toFixed(2)} m, other car pushed to ${other.obj.position.clone().sub(p).length().toFixed(1)} m from the start` };
    },
  },
  {
    id: 'VEH-09', title: '从桥面缺口以 12 m/s 冲出：3 s 内落到下方地面或水里，全程不穿地',
    run: (g) => {
      const c = drive(g);
      // any viaduct: the outer lane, a point high over dry ground with no parapet on its right (a merge / diverge gap)
      const P = V(), right = V(), probe = V();
      let pick: { p: Vec3; right: Vec3; low: number } | null = null;
      for (const l of g.traffic.roads.lanes) {
        if (l.index !== l.count - 1 || pick) continue;
        const pts = l.path.pts;
        for (let i = 1; i < pts.length && !pick; i++) {
          P.copy(pts[i]);
          if (P.y < 6) continue;
          const d = V().subVectors(pts[i], pts[i - 1]).setY(0).normalize();
          right.set(-d.z, 0, d.x);
          if (g.collision.raycastDistance(probe.copy(P).setY(P.y + 0.7), right, 12) < 12) continue;
          if (g.collision.raycastDistance(probe.copy(P).setY(P.y + 0.3), right, 12) < 12) continue;
          const fwd = V(right.z, 0, -right.x);
          if (fan(1.4).some((o) => g.props.raycast(probe.copy(P).addScaledVector(fwd, o).setY(P.y + 0.7), right, 12) < 12)) continue;
          const low = g.collision.groundHeight(probe.copy(P).addScaledVector(right, 14).setY(P.y - 1), 40);
          if (low === null || low > P.y - 4 || low < -1) continue;
          pick = { p: P.clone(), right: right.clone(), low };
        }
      }
      if (!pick) return { pass: false, detail: 'no open deck edge found on any viaduct' };
      c.obj.position.copy(pick.p).setY(pick.p.y + 0.05);
      c.heading = Math.atan2(-pick.right.x, -pick.right.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 12;
      let worst = Infinity, landed = false;
      for (let i = 0; i < 180; i++) {
        step(g, 1);
        const p = c.obj.position;
        const below = g.collision.groundHeight(probe.set(p.x, pick.p.y - 1, p.z), 60);
        if (below !== null && p.y < pick.p.y - 1.5) worst = Math.min(worst, p.y - below);
        if (c.inWater || (below !== null && Math.abs(p.y - below) < 0.35 && p.y < pick.p.y - 3)) landed = true;
      }
      return { pass: landed && worst > -0.2, detail: `deck ${pick.p.y.toFixed(1)} m, ground below ${pick.low.toFixed(1)} m; landed ${landed}, lowest clearance ${Number.isFinite(worst) ? worst.toFixed(2) : 'n/a'} m, end y ${c.obj.position.y.toFixed(2)}` };
    },
  },
  {
    id: 'VEH-10', title: '5 m/s 能爬上 0.15 m 路缘；0.45 m 以上的台阶挡住',
    run: (g) => {
      const c = drive(g);
      const P = V(), T = V(), right = V(), q = V();
      let kerb: { p: Vec3; right: Vec3; at: number } | null = null;
      for (const l of g.traffic.roads.lanes) {
        if (l.index !== l.count - 1 || l.from.z > 0.3 || l.to.z > 0.3 || l.path.length < 60) continue;
        l.path.at(l.path.length / 2, P, T);
        right.set(-T.z, 0, T.x).normalize();
        let prev = g.collision.groundHeight(q.copy(P).setY(P.y + 1), 3);
        for (let o = 0.5; o < 8 && prev !== null; o += 0.25) {
          const h = g.collision.groundHeight(q.copy(P).addScaledVector(right, o).setY(P.y + 1), 3);
          if (h === null) break;
          if (h - prev > 0.1 && h - prev < 0.2) { kerb = { p: P.clone(), right: right.clone(), at: o }; break; }
          prev = h;
        }
        if (kerb) {
          // the pavement must be clear for a few metres (no wall right behind the kerb)
          if (g.collision.raycastDistance(q.copy(P).addScaledVector(right, kerb.at).setY(P.y + 0.8), right, 5) < 5) kerb = null;
          else break;
        }
      }
      if (!kerb) return { pass: false, detail: 'no kerb found' };
      const start = kerb.p.clone().addScaledVector(kerb.right, kerb.at - 3.2);
      c.obj.position.copy(start).setY(kerb.p.y + 0.03);
      c.heading = Math.atan2(-kerb.right.x, -kerb.right.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 5;
      g.pilot = () => ({ throttle: 0.3, steer: 0, handbrake: false });
      try { step(g, 75); } finally { g.pilot = null; }
      const past = c.obj.position.clone().sub(kerb.p).dot(kerb.right) - kerb.at;
      const up = c.obj.position.y - kerb.p.y;
      const kerbOk = past > 1.0 && up > 0.08;
      // a step: scan around the spawn for a 0.45-1.2 m rise onto a flat top
      let stepRes = 'no step found nearby';
      let stepOk = true;
      outer: for (const l of g.traffic.roads.lanes) {
        if (l.from.z > 0.3 || l.to.z > 0.3 || l.path.length < 40) continue;
        for (let s = 10; s < l.path.length - 10; s += 15) {
          l.path.at(s, P, T);
          for (const side of [1, -1]) {
            right.set(-T.z * side, 0, T.x * side).normalize();
            let prev = g.collision.groundHeight(q.copy(P).setY(P.y + 1), 3);
            for (let o = 1; o < 14 && prev !== null; o += 0.5) {
              const h = g.collision.groundHeight(q.copy(P).addScaledVector(right, o).setY(P.y + 3), 5);
              if (h === null) break;
              const h2 = g.collision.groundHeight(q.copy(P).addScaledVector(right, o + 2.5).setY(P.y + 3), 5);
              if (h - prev > 0.45 && h - prev < 1.2 && h2 !== null && Math.abs(h2 - h) < 0.05) {
                const base = prev;
                c.obj.position.copy(P).addScaledVector(right, o - 4.5).setY(base + 0.03);
                c.heading = Math.atan2(-right.x, -right.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 5;
                g.pilot = () => ({ throttle: 0.3, steer: 0, handbrake: false });
                try { step(g, 90); } finally { g.pilot = null; }
                const rose = c.obj.position.y - base;
                stepOk = rose < 0.3;
                stepRes = `step ${(h - base).toFixed(2)} m: car rose ${rose.toFixed(2)} m`;
                break outer;
              }
              if (Math.abs(h - prev) > 0.05) break;
              prev = h;
            }
          }
        }
      }
      return { pass: kerbOk && stepOk, detail: `kerb: ${past.toFixed(2)} m past the kerb, ${up.toFixed(2)} m up; ${stepRes}` };
    },
  },
  {
    id: 'VEH-11', title: '25 m/s 冲坡腾空：空中 ≥ 0.3 s，落地保留 ≥ 60% 速度，1 s 内姿态回正',
    run: (g) => {
      const c = drive(g);
      if (c.vy === undefined) return { pass: false, detail: 'car has no vertical velocity (no physics v2)' };
      const p = V(), t = V();
      const lane = g.traffic.roads.lanes.find((l) => l.path.length > 300 && l.from.z < 0.3 && l.to.z < 0.3)!;
      lane.path.at(40, p, t);
      c.obj.position.copy(p).setY(p.y + 0.05);
      c.heading = Math.atan2(-t.x, -t.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 25;
      step(g, 20);
      c.speed = 25; c.vy = 5.5; c.pitch = 0.1;                    // what a ~13° kicker does at 25 m/s (nose already dropping)
      let air = 0, landedAt = -1, speedAtLand = 0, upright = -1;
      for (let i = 0; i < 180; i++) {
        step(g, 1);
        if (c.airborne) air += 1 / 60;
        else if (landedAt < 0 && air > 0) { landedAt = i; speedAtLand = c.speed; }
        if (landedAt >= 0 && upright < 0 && Math.abs(c.obj.rotation.x) < 0.035 && Math.abs(c.obj.rotation.z) < 0.035) upright = (i - landedAt) / 60;
      }
      const keep = speedAtLand / 25;
      return { pass: air >= 0.3 && keep >= 0.6 && upright >= 0 && upright <= 1, detail: `airborne ${air.toFixed(2)} s, speed kept ${(keep * 100).toFixed(0)}%, upright after ${upright < 0 ? 'never' : upright.toFixed(2) + ' s'}` };
    },
  },
  {
    id: 'VEH-12', title: '猎德大桥北引桥上桥再下桥：腾空 < 0.2 s，高度误差 < 0.3 m，俯仰误差 < 3°',
    run: (g) => {
      const c = drive(g);
      const up = edgeLane(g, 251, 1), down = edgeLane(g, 600, 1);
      if (up.length < 2 || down.length < 2) return { pass: false, detail: 'bridge lanes not found' };
      const res = [followPath(g, c, up, 16), followPath(g, c, down, 16)];
      const all = res.flatMap((r) => r.samples);
      const air = all.filter((x) => x.air).length / 60;
      const dy = Math.max(...all.map((x) => Math.abs(x.dy)));
      const dp = Math.max(...all.map((x) => Math.abs(x.dPitch)));
      const lat = Math.max(...all.map((x) => x.lat));
      const done = res.every((r) => r.done);
      return { pass: done && air < 0.2 && dy < 0.3 && dp < 3, detail: `${(res[0].length + res[1].length).toFixed(0)} m, finished ${done}; airborne ${air.toFixed(2)} s, height err ${dy.toFixed(2)} m, pitch err ${dp.toFixed(1)}°, off-lane max ${lat.toFixed(1)} m` };
    },
  },
  {
    id: 'VEH-13', title: '落水救回：放回车道上（离中心线 < 3 m），不在水面',
    run: (g) => {
      const c = drive(g);
      const p = V(), t = V();
      const lane = g.traffic.roads.lanes.find((l) => l.path.length > 200 && l.from.z < 0.3 && l.to.z < 0.3)!;
      lane.path.at(30, p, t);
      c.obj.position.copy(p).setY(p.y + 0.05);
      c.heading = Math.atan2(-t.x, -t.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 8;
      step(g, 60);
      // then some time parked on the plaza (dry, but no road) before rolling into the river
      const gy = ground(g, 20, -400)!;
      placeCar(c, 20, -400, gy + 0.05, 0, 1);
      step(g, 60);
      placeCar(c, 300, -900, 0.2, 0, 1, 6);
      let rescued = false;
      const river = c.obj.position.clone();
      for (let i = 0; i < 360 && !rescued; i++) { step(g, 1); rescued = c.obj.position.distanceTo(river) > 40; }
      const q = c.obj.position;
      const near = nearestOnLanes(g, q);
      return { pass: rescued && near.d < 3 && q.y > -0.5, detail: `rescued ${rescued}; at y ${q.y.toFixed(2)} m, ${near.d.toFixed(1)} m from a lane centreline` };
    },
  },
  {
    id: 'VEH-14', title: '20 m/s 追尾车流车：重叠 < 0.3 m，对方 2 s 内停下，记罪行',
    run: (g) => {
      const c = drive(g);
      const t = g.traffic.cars.find((x) => !x.conn && x.speed > 4 && x.lane.from.z < 0.3 && x.lane.to.z < 0.3 && x.lane.path.length - x.s > 90 && x.s > 30 && x.half.y < 3);
      if (!t) return { pass: false, detail: 'no traffic car on a long straight' };
      const p = V(), tan = V();
      t.lane.path.at(t.s - 24, p, tan);
      c.obj.position.copy(p).setY(p.y + 0.05);
      c.heading = Math.atan2(-tan.x, -tan.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 20;
      (g as unknown as { lastCarCrimeAt: number }).lastCarCrimeAt = -1e9;   // the 3 s de-duplication runs on the wall clock
      const crimes0 = g.crimes.filter((k) => k.kind === 'crash_car').length;
      let worst = 0, hitAt = -1, stopAt = -1;
      g.pilot = (car) => {
        // steer at the car ahead
        const to = V().subVectors(t.obj.position, car.obj.position);
        const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
        const ang = Math.atan2(fx * to.z - fz * to.x, fx * to.x + fz * to.z);
        return { throttle: hitAt < 0 ? 1 : 0, steer: THREE.MathUtils.clamp(ang * 2, -1, 1), handbrake: false };
      };
      try {
        for (let i = 0; i < 240; i++) {
          step(g, 1);
          const o = overlap(c, t);
          worst = Math.max(worst, o);
          if (hitAt < 0 && c.obj.position.distanceTo(t.obj.position) < t.half.y + c.half.y + 0.4) hitAt = i;
          if (hitAt >= 0 && stopAt < 0 && t.speed < 0.3) stopAt = i;
        }
      } finally { g.pilot = null; }
      const crimes = g.crimes.filter((k) => k.kind === 'crash_car').length - crimes0;
      const stopS = stopAt < 0 ? Infinity : (stopAt - hitAt) / 60;
      return { pass: hitAt >= 0 && worst < 0.3 && stopS <= 2 && crimes > 0, detail: `hit ${hitAt >= 0}, max overlap ${worst.toFixed(2)} m, traffic car stopped ${Number.isFinite(stopS) ? stopS.toFixed(2) + ' s' : 'never'} after, crimes +${crimes}` };
    },
  },
  {
    id: 'VEH-15', title: '侧撞公交：玩家车被弹开，公交横向位移 < 0.2 m',
    run: (g) => {
      const c = drive(g);
      const P = g.props as unknown as { resolveBox(p: Vec3, hx: number, hz: number, yaw: number, y0: number, y1: number): unknown };
      // a stopped bus, the player's car 6.5 m off its left side and square to it; the start must be free
      // (none free right now -- another car alongside, a rail: let the traffic move on and look again)
      for (let attempt = 0; attempt < 6; attempt++) {
        for (const bus of g.traffic.cars.filter((x) => x.half.y > 4 && !x.conn && x.lane.from.z < 0.3)) {
          const left = V(bus.fwd.z, 0, -bus.fwd.x);
          const from = bus.obj.position.clone().addScaledVector(left, 6.5);
          const heading = Math.atan2(left.x, left.z);
          if (P.resolveBox(from.clone(), c.half.x, c.half.y, heading, from.y + 0.1, from.y + 1.4)) continue;
          if (g.collision.raycastDistance(from.clone().setY(from.y + 0.6), left.clone().negate(), 6) < 6) continue;
          const toBus = left.clone().negate();
          if (fan(1.2).some((off) => g.props.raycast(from.clone().addScaledVector(bus.fwd, off).setY(from.y + 0.5), toBus, 5) < 5)) continue;   // median rails
          if (g.traffic.cars.some((q) => q !== bus && q.obj.position.distanceTo(from) < 7)) continue;
          bus.crashT = 8; bus.speed = 0;
          step(g, 2);
          const b0 = bus.obj.position.clone();
          c.obj.position.copy(b0).addScaledVector(left, 6.5).setY(b0.y + 0.05);
          c.heading = heading; c.obj.rotation.set(0, c.heading, 0); c.speed = 15;      // facing -left: at the bus
          let worst = 0, hit = -1, after = 15;
          g.pilot = () => ({ throttle: 0, steer: 0, handbrake: false });
          try {
            for (let i = 0; i < 60; i++) {
              step(g, 1);
              worst = Math.max(worst, overlap(c, bus));
              if (hit < 0 && c.obj.position.distanceTo(bus.obj.position) < bus.half.x + c.half.y + 0.3) hit = i;
              if (hit >= 0 && i === hit + 15) after = c.speed;
            }
          } finally { g.pilot = null; }
          const lat = Math.abs(bus.obj.position.clone().sub(b0).dot(left));
          return { pass: hit >= 0 && lat < 0.2 && worst < 0.3 && after < 15 * 0.3, detail: `hit ${hit >= 0}, bus moved sideways ${lat.toFixed(2)} m, max overlap ${worst.toFixed(2)} m, player speed ${after.toFixed(1)} m/s after the hit (was 15)` };
        }
        step(g, 120);
      }
      return { pass: false, detail: 'no bus with a free spot beside it' };
    },
  },
  // ------------------------------------------------------------------ Ah Jie's e-bike
  {
    id: 'BIKE-01', title: '阿杰的电鸡停在出生点 4 m 内；F 上车 1 s 内坐稳、脚撑收起',
    run: (g) => {
      const B = bikeOf(g);
      parkBikeHome(g);
      const d = B.bike.obj.position.distanceTo(g.characters[0].spec.spawn);
      try {
        mountBike(g);
        step(g, 20);
        return { pass: d < 4 && B.rider!.mount >= 1 && B.ebike.standK < 0.1, detail: `parked ${d.toFixed(1)} m from the spawn; mount ${B.rider!.mount.toFixed(2)}, stand ${B.ebike.standK.toFixed(2)}` };
      } finally { parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-02', title: '满油 4 s 到 35–46 km/h、极速不超 46 km/h；满舵压弯 20–36°',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      // a long, straight, level lane: 8 s flat out is ~85 m, then the swerve
      const p0 = V(), t0 = V(), p1 = V(), t1 = V();
      const lane = g.traffic.roads.lanes.find((l) => {
        if (l.path.length < 240 || l.from.z > 0.3 || l.to.z > 0.3) return false;
        l.path.at(10, p0, t0); l.path.at(160, p1, t1);
        return t0.dot(t1) > Math.cos(THREE.MathUtils.degToRad(4)) && Math.abs(p1.y - p0.y) < 1;
      });
      if (!lane) return { pass: false, detail: 'no long straight lane' };
      placeBike(g, p0, Math.atan2(-t0.x, -t0.z));
      step(g, 3);
      // a clean run: the bike ignores cars for this one (traffic puts its cars back on their lanes every frame, so
      // they cannot be moved out of the way)
      const cars0 = B.bikes.cars;
      B.bikes.cars = null;
      try {
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        step(g, 240);
        const v4 = B.bike.speed * 3.6;
        step(g, 240);
        const vmax = B.bike.speed * 3.6;
        B.pilotBike = { throttle: 1, steer: 1, brake: false };
        let lean = 0;
        for (let i = 0; i < 30; i++) { step(g, 1); lean = Math.max(lean, Math.abs(B.bike.lean) * 57.3); }
        const crashed = B.bike.crashed || !!B.thrown;
        return { pass: !crashed && v4 >= 35 && v4 <= 46 && vmax <= 46 && lean >= 20 && lean <= 36, detail: `4 s ${v4.toFixed(1)} km/h, 8 s ${vmax.toFixed(1)} km/h, lean ${lean.toFixed(1)} deg${crashed ? ', crashed into something' : ''}` };
      } finally { B.pilotBike = null; B.bikes.cars = cars0; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-03', title: '步速满舵转弯直径 ≤ 5 m；30 km/h 空格后刹 + 转向 1.5 s 内掉头 ≥ 120°',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g), b = B.bike;
      try {
        // the square south of the library: open paving
        const at = g.characters[0].spec.spawn.clone();
        placeBike(g, at, 0); step(g, 5);
        const p0 = b.obj.position.clone(), h0 = b.heading;
        let diam = 0;
        for (let i = 0; i < 600 && Math.abs(b.heading - h0) < 2 * Math.PI; i++) {
          B.pilotBike = { throttle: b.speed < 2 ? 1 : 0, steer: 1, brake: false };
          step(g, 1);
          diam = Math.max(diam, b.obj.position.distanceTo(p0));
        }
        placeBike(g, at, 0); step(g, 5);
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        for (let i = 0; i < 300 && b.speed < 8.3; i++) step(g, 1);
        const v0 = b.speed, h1 = b.heading;
        let skid = false;
        B.pilotBike = { throttle: 0, steer: -1, brake: true };
        for (let i = 0; i < 90; i++) { step(g, 1); skid = skid || b.skidding; }
        const turned = Math.abs(b.heading - h1) * 57.3;
        return { pass: diam <= 5 && turned >= 120 && skid && !b.crashed, detail: `turning circle ${diam.toFixed(2)} m; from ${(v0 * 3.6).toFixed(0)} km/h the rear brake turned it ${turned.toFixed(0)} deg (skid ${skid})${b.crashed ? ', crashed' : ''}` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-04', title: '追尾车流车：人飞出去（翻过车顶或被挡住，不穿车身），3 s 内落地，10 s 内站起来',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      const t = bikeBehindTraffic(g, 24);
      if (!t) return { pass: false, detail: 'no traffic car on a long straight' };
      t.speed = 0; t.crashT = 20;   // waiting at a light: a clean rear-end at the bike's own speed
      try {
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        let i = 0;
        for (; i < 600 && !B.thrown; i++) {
          // steer at the car ahead
          const to = V().subVectors(t.obj.position, B.bike.obj.position);
          const fx = -Math.sin(B.bike.heading), fz = -Math.cos(B.bike.heading);
          B.pilotBike.steer = THREE.MathUtils.clamp(Math.atan2(fx * to.z - fz * to.x, fx * to.x + fz * to.z) * 2, -1, 1);
          step(g, 1);
        }
        B.pilotBike = null;
        if (!B.thrown) return { pass: false, detail: 'never thrown off' };
        const hitKmh = (B.bike.crash?.speed ?? 0) * 3.6;
        let inside = 0, landed = -1, up = -1;
        const h = Math.atan2(-t.fwd.x, -t.fwd.z);
        for (let k = 0; k < 900 && B.thrown; k++) {
          step(g, 1);
          const th = B.thrown;
          if (!th) { up = k; break; }
          if (landed < 0 && th.phase !== 'air') landed = k;
          const d = V().subVectors(th.pos, t.obj.position);
          const lx = d.x * Math.cos(h) - d.z * Math.sin(h), lz = -(d.x * Math.sin(h) + d.z * Math.cos(h));
          if (Math.abs(lx) < t.half.x - 0.1 && Math.abs(lz) < t.half.y - 0.1 && th.pos.y < t.obj.position.y + 1.1) inside++;
        }
        if (B.thrown === null && up < 0) up = 0;
        return { pass: inside === 0 && landed >= 0 && landed <= 180 && up >= 0 && up <= 600, detail: `hit at ${hitKmh.toFixed(0)} km/h; ${inside} frames inside the car body; landed after ${(landed / 60).toFixed(2)} s, up after ${(up / 60).toFixed(1)} s` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-05', title: '35 km/h 撞墙：车和人都不穿墙',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      const o = g.characters[0].spec.spawn.clone().setY(g.characters[0].spec.spawn.y + 0.8);
      let dir: Vec3 | null = null, dist = 0;
      for (let a = 0; a < 6.28 && !dir; a += 0.1) {
        const d = V(Math.cos(a), 0, Math.sin(a));
        const r = g.collision.raycastDistance(o, d, 60);
        if (r > 22 && r < 55) { dir = d; dist = r; }
      }
      if (!dir) return { pass: false, detail: 'no wall 22-55 m from the spawn' };
      try {
        placeBike(g, o.clone().setY(o.y - 0.8), Math.atan2(-dir.x, -dir.z));
        step(g, 3);
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        // through a wall = further from the start than the first static hit on the straight line out to it
        const through = (p: Vec3, h: number) => {
          const d = V(p.x - o.x, 0, p.z - o.z), len = d.length();
          if (len < 1) return 0;
          const hit = g.collision.raycastDistance(V(o.x, p.y + h, o.z), d.divideScalar(len), len + 2);
          return Math.max(0, len - hit);
        };
        let worst = 0, worstBody = 0, far = 0;
        for (let i = 0; i < 600; i++) {
          step(g, 1);
          far = Math.max(far, V().subVectors(B.bike.obj.position, o).dot(dir));
          worst = Math.max(worst, through(B.bike.obj.position, 0.6));
          if (B.thrown) worstBody = Math.max(worstBody, through(B.thrown.pos, 0));
          if (B.bike.crashed && !B.thrown && i > 60) break;
        }
        const crashed = !!B.bike.crash;
        return { pass: worst < 0.3 && worstBody < 0.3, detail: `wall at ${dist.toFixed(1)} m (reached ${far.toFixed(1)} m along the line); beyond the first wall: bike ${worst.toFixed(2)} m, rider ${worstBody.toFixed(2)} m; crash ${crashed ? (B.bike.crash!.speed * 3.6).toFixed(0) + ' km/h' : 'none (stopped by something first)'}` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-06', title: '摔车后走到车旁按 F：扶起并骑上，0.8 s 内车身回正（< 5°）',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      const t = bikeBehindTraffic(g, 20);
      if (!t) return { pass: false, detail: 'no traffic car' };
      t.speed = 0; t.crashT = 20;
      try {
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        for (let i = 0; i < 600 && !B.thrown; i++) {
          const to = V().subVectors(t.obj.position, B.bike.obj.position);
          const fx = -Math.sin(B.bike.heading), fz = -Math.cos(B.bike.heading);
          B.pilotBike.steer = THREE.MathUtils.clamp(Math.atan2(fx * to.z - fz * to.x, fx * to.x + fz * to.z) * 2, -1, 1);
          step(g, 1);
        }
        B.pilotBike = null;
        for (let i = 0; i < 900 && B.thrown; i++) step(g, 1);
        if (!B.bike.crashed) return { pass: false, detail: 'the bike did not fall' };
        for (let i = 0; i < 240 && B.bike.crashed && Math.abs(B.bike.lean) < 1.3; i++) step(g, 1);
        const lying = Math.abs(B.bike.lean) * 57.3;
        const ch = g.characters[g.active];
        B.bike.obj.updateMatrixWorld();
        ch.placeAt(B.bike.obj.localToWorld(V(-0.9, 0, 0.2)).setY(B.bike.obj.position.y + 0.05), B.bike.heading + Math.PI);
        step(g, 3);
        g.input.interactQueued = true;
        step(g, 48);
        const lean = Math.abs(B.bike.lean) * 57.3;
        return { pass: lying > 60 && !B.bike.crashed && lean < 5 && B.rider?.ch === g.active, detail: `lying at ${lying.toFixed(0)} deg; after F: crashed ${B.bike.crashed}, lean ${lean.toFixed(1)} deg, riding ${B.rider?.ch === g.active}` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-07', title: '停下按 F 下车：站在车左侧 0.4–1.2 m；车速 > 2.5 m/s 时下不了车',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      try {
        placeBike(g, g.characters[0].spec.spawn, 0); step(g, 5);
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        step(g, 60);
        B.pilotBike = { throttle: 0, steer: 0, brake: false };
        const fast = B.bike.speed;
        g.input.interactQueued = true; step(g, 30);
        const stillOn = B.rider?.ch === g.active && B.rider.dir >= 0;
        B.pilotBike = { throttle: 0, steer: 0, brake: true };
        for (let i = 0; i < 300 && Math.abs(B.bike.speed) > 0.05; i++) step(g, 1);
        B.pilotBike = null;
        g.input.interactQueued = true; step(g, 40);
        const ch = g.characters[g.active];
        const local = B.bike.obj.worldToLocal(ch.root.position.clone());
        return { pass: stillOn && !B.rider && local.x < -0.4 && local.x > -1.2, detail: `at ${fast.toFixed(1)} m/s F ${stillOn ? 'refused' : 'got off'}; stopped: off ${!B.rider}, standing at bike-local x ${local.x.toFixed(2)} m` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-08', title: '骑车送餐：时限按小准的电鸡速度算；摔车扣餐品完好度，送达收入按完好度打折',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      const J = B.jobs;
      try {
        const from = B.bike.obj.position.clone();
        const shop = J.pickups[0], drop = J.drops.find((d) => d.pos.distanceTo(shop.pos) > 300) ?? J.drops[0];
        J.assign(shop, drop, from);
        const want = Math.ceil((from.distanceTo(shop.pos) + shop.pos.distanceTo(drop.pos)) * 1.35 / J.pace + 60);
        J.pick();
        const limitOk = Math.abs(J.timeLimit - want) <= 1;
        const t = bikeBehindTraffic(g, 20);
        if (!t) return { pass: false, detail: 'no traffic car' };
        t.speed = 0; t.crashT = 20;
        B.pilotBike = { throttle: 1, steer: 0, brake: false };
        for (let i = 0; i < 600 && !B.thrown; i++) {
          const to = V().subVectors(t.obj.position, B.bike.obj.position);
          const fx = -Math.sin(B.bike.heading), fz = -Math.cos(B.bike.heading);
          B.pilotBike.steer = THREE.MathUtils.clamp(Math.atan2(fx * to.z - fz * to.x, fx * to.x + fz * to.z) * 2, -1, 1);
          step(g, 1);
        }
        B.pilotBike = null;
        const cond = J.condition;
        for (let i = 0; i < 900 && B.thrown; i++) step(g, 1);
        if (J.phase !== 'carrying') return { pass: false, detail: `the crash spilled the lot (condition ${cond.toFixed(2)}) -- expected a partial loss` };
        onFoot(g);
        const cash0 = J.cash, left = J.timeLeft;
        const full = 30 + J.drop.pos.distanceTo(J.pickup.pos) * 0.08 + Math.max(0, left) * 0.5;
        J.deliver();
        const got = J.cash - cash0;
        return { pass: limitOk && cond < 0.95 && cond > 0 && got > 0 && got < full, detail: `limit ${J.timeLimit} s (want ${want}); crash left the food at ${(cond * 100).toFixed(0)}%; paid ${got} of an unscaled ${full.toFixed(0)}` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-09', title: '骑手双手在车把上（手腕离握把目标 < 0.08 m），转弯时跟着车把走',
    run: (g) => {
      parkBikeHome(g);
      const B = mountBike(g);
      try {
        placeBike(g, g.characters[0].spec.spawn, 0); step(g, 5);
        const gap = () => {
          g.characters[g.active].root.updateMatrixWorld(true);
          return [0, 1].map((k) => {
            const side = B.rider!.pose.armSide[k];
            const grip = B.ebike.grip(side < 0 ? 0 : 1, V());
            return V().setFromMatrixPosition(B.rider!.pose.limbs.hand[k].matrixWorld).distanceTo(grip);
          });
        };
        // 15 s sitting still: longer than the whole 17.6 s idle clip's weight shift (5-14 s) would need to show up
        const still: number[] = [];
        for (let k = 0; k < 30; k++) { step(g, 30); still.push(...gap()); }
        B.pilotBike = { throttle: 0.4, steer: 1, brake: false };
        step(g, 40);
        const turning = gap();
        const worst = Math.max(...still, ...turning);
        return { pass: worst < 0.08, detail: `wrist to grip: 15 s still, worst ${Math.max(...still).toFixed(3)} m; turning ${turning.map((v) => v.toFixed(3)).join(' / ')} m` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  {
    id: 'BIKE-10', title: '人走向停着的电鸡会被挡住（不穿车）',
    run: (g) => {
      parkBikeHome(g);
      const B = bikeOf(g), o = B.bike.obj;
      o.updateMatrixWorld();
      const ch = g.characters[g.active];
      ch.placeAt(o.localToWorld(V(-3, 0, 0)).setY(o.position.y + 0.1), 0);
      step(g, 3);
      let closest = Infinity;
      g.input.setKey('KeyW', true);
      try {
        for (let i = 0; i < 180; i++) {
          const d = V().subVectors(o.position, ch.root.position);
          g.rig.yaw = Math.atan2(-d.x, -d.z);
          step(g, 1);
          closest = Math.min(closest, Math.abs(o.worldToLocal(ch.root.position.clone()).x));
        }
      } finally { g.input.setKey('KeyW', false); parkBikeHome(g); }
      return { pass: closest >= 0.5, detail: `closest the walker got to the bike's centre line: ${closest.toFixed(2)} m` };
    },
  },
  {
    id: 'BIKE-11', title: '开车撞停着的电鸡：电鸡被撞倒，不被穿过',
    run: (g) => {
      parkBikeHome(g);
      const B = bikeOf(g), b = B.bike;
      const c = drive(g);
      const parkedAt = { pos: c.obj.position.clone(), heading: c.heading };
      try {
        b.obj.updateMatrixWorld();
        const from = b.obj.localToWorld(V(0, 0, -14)).setY(b.obj.position.y + 0.05);
        c.obj.position.copy(from);
        const d = V().subVectors(b.obj.position, from);
        c.heading = Math.atan2(-d.x, -d.z); c.obj.rotation.set(0, c.heading, 0); c.speed = 0;
        step(g, 2);
        g.pilot = (car) => {
          const to = V().subVectors(b.obj.position, car.obj.position);
          const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
          return { throttle: 0.6, steer: THREE.MathUtils.clamp(Math.atan2(fx * to.z - fz * to.x, fx * to.x + fz * to.z) * 2, -1, 1), handbrake: false };
        };
        let fell = -1;
        for (let i = 0; i < 240 && fell < 0; i++) { step(g, 1); if (b.crashed) fell = i; }
        g.pilot = null;
        return { pass: fell >= 0, detail: fell >= 0 ? `knocked over after ${(fell / 60).toFixed(2)} s, sliding ${(B.bike as unknown as { slide: Vec3 }).slide.length().toFixed(1)} m/s` : 'the car never knocked it over' };
      } finally {
        g.pilot = null;
        onFoot(g);
        // the car back where it was parked (later tests start from the spawn it was driven to)
        c.obj.position.copy(parkedAt.pos); c.heading = parkedAt.heading; c.obj.rotation.set(0, c.heading, 0); c.speed = 0;
        parkBikeHome(g);
      }
    },
  },
  {
    id: 'BIKE-12', title: '在 idle 重心侧移时第一次上车：左右手脚各归各边（不交叉、不并腿），手在握把上',
    run: (g) => {
      parkBikeHome(g);
      const B = bikeOf(g);
      const ch = g.characters[g.active] as unknown as { actions: { idle: { time: number } }; model: THREE.Object3D };
      // forget the cached pose so the next mount builds a new one, mid weight-shift (the idle clip's 5-14 s)
      (g as unknown as { riderPoses: Map<number, unknown> }).riderPoses.delete(g.active);
      onFoot(g);
      const c = g.characters[g.active];
      B.bike.obj.updateMatrixWorld();
      c.placeAt(B.bike.obj.localToWorld(V(-0.9, 0, 0.2)).setY(B.bike.obj.position.y + 0.05), B.bike.heading + Math.PI);
      ch.actions.idle.time = 9; step(g, 2); ch.actions.idle.time = 9;
      g.input.interactQueued = true;
      try {
        step(g, 50);
        if (B.rider?.ch !== g.active) return { pass: false, detail: 'did not get on' };
        B.pilotBike = { throttle: 0.6, steer: 0, brake: false };
        step(g, 40);
        c.root.updateMatrixWorld(true);
        const o = B.bike.obj;
        const lx = (n: string) => o.worldToLocal(V().setFromMatrixPosition(ch.model.getObjectByName(n)!.matrixWorld)).x;
        const feet = [lx('L_Foot'), lx('R_Foot')], knees = [lx('L_Calf'), lx('R_Calf')], hands = [lx('L_Hand'), lx('R_Hand')];
        const gaps = [0, 1].map((k) => V().setFromMatrixPosition(B.rider!.pose.limbs.hand[k].matrixWorld).distanceTo(B.ebike.grip(k, V())));
        const ok = feet[0] < -0.05 && feet[1] > 0.05 && knees[1] - knees[0] > 0.3 && hands[0] < -0.15 && hands[1] > 0.15 && Math.max(...gaps) < 0.08;
        return { pass: ok, detail: `bike-local x: feet ${feet.map((v) => v.toFixed(2)).join(' / ')}, knees ${knees.map((v) => v.toFixed(2)).join(' / ')} (apart ${(knees[1] - knees[0]).toFixed(2)} m), hands ${hands.map((v) => v.toFixed(2)).join(' / ')}; wrist to grip ${gaps.map((v) => v.toFixed(3)).join(' / ')} m` };
      } finally { B.pilotBike = null; parkBikeHome(g); }
    },
  },
  // ------------------------------------------------------------------ the order game
  {
    id: 'ORD-01', title: '店面都贴在真实楼的首层外墙上：门前站位在地面（不在楼里、不在车行道），招牌和店员位置都在',
    run: (g) => {
      const W = (g as unknown as { delivery: { places: { kind: string; name: string; pos: Vec3; origin: Vec3; spots: Record<string, Vec3> }[] } }).delivery;
      const shops = W.places.filter((p) => p.kind === 'shop');
      const bad: string[] = [];
      for (const s of shops) {
        const gnd = g.collision.groundHeight(s.pos.clone().setY(s.pos.y + 1.5), 4);
        const dz = gnd === null ? 99 : Math.abs(gnd - s.pos.y);
        // walls between the courier and the counter would mean the shop is inside a building
        const c = s.spots.counter;
        const d = c.clone().setY(s.pos.y + 1.0).sub(s.pos.clone().setY(s.pos.y + 1.0));
        const L = d.length();
        const wall = g.collision.raycastDistance(s.pos.clone().setY(s.pos.y + 1.0), d.divideScalar(L), L);
        if (dz > 0.5 || wall < L - 0.3 || !s.spots.staff) bad.push(`${s.name} (ground ${dz.toFixed(2)}, wall ${wall.toFixed(1)}/${L.toFixed(1)})`);
      }
      return { pass: shops.length > 60 && bad.length <= shops.length * 0.05, detail: `${shops.length} shops, ${bad.length} misplaced${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}` };
    },
  },
  {
    id: 'ORD-02', title: '第一单：麦姐煲仔饭（等饭焦）→ 公交站找人当面交；找错人不算；评价到手机、剧情推进',
    run: (g) => {
      const G = og(g), O = G.orders;
      onFoot(g);
      O.reset(); step(g, 90); talkThrough(g);
      const o = O.order;
      if (!o || o.story?.id !== 's1') return { pass: false, detail: 'the first order is not 《第一单》' };
      goTo(g, o.shop.pos); pressE(g); talkThrough(g);
      const waited = o.state === 'waiting';
      for (let i = 0; i < 40 && o.state === 'waiting'; i++) step(g, 60);
      pressE(g); talkThrough(g);
      if (o.state !== 'carrying') return { pass: false, detail: `not carrying after the shop (${o.state})` };
      goTo(g, o.drop.pos); step(g, 30);
      const decoy = O.scene.drop.find((a) => a.tag === 'decoy'), cust = O.scene.drop.find((a) => a.tag === 'cust');
      if (!decoy || !cust) return { pass: false, detail: 'nobody at the stop' };
      goTo(g, decoy.root.position.clone().add(V(0.8, 0, 0))); pressE(g); step(g, 5);
      const decoyOk = (o.state as string) === 'carrying' && !!decoy.bubble?.textContent;
      goTo(g, cust.root.position.clone().add(V(0.8, 0, 0))); pressE(g); talkThrough(g);
      const done = (o.state as string) === 'done';
      const r0 = g.characters.length >= 0 ? (G as unknown as { jobs: { rating: number } }).jobs.rating : 0;
      step(g, 60 * 8);
      const notes = [...document.querySelectorAll('.note')].map((n) => n.textContent ?? '');
      const review = notes.some((t) => t.includes('★'));
      return { pass: waited && decoyOk && done && review && O.storyStep === 1, detail: `waited ${waited}, a stranger said "${decoy.bubble?.textContent ?? ''}" and kept nothing ${decoyOk}, handed over ${done}, review ${review}, story step ${O.storyStep}, rating ${r0.toFixed(2)}` };
    },
  },
  {
    id: 'ORD-03', title: '写字楼：普通保安不让上楼（求情会被拒、再给选择）；放外卖柜送达',
    run: (g) => {
      const G = og(g), O = G.orders;
      onFoot(g);
      for (let k = 0; k < 40; k++) {
        O.reset(); O.storyStep = 6; O.chapterDone = true; step(g, 90); talkThrough(g);
        if (O.order?.mode === 'lobby' && O.order.customer.id !== 'no_answer') break;
      }
      const o = O.order;
      if (!o || o.mode !== 'lobby') return { pass: false, detail: 'no tower order came up' };
      goTo(g, o.shop.pos); pressE(g); talkThrough(g);
      for (let i = 0; i < 90 && o.state !== 'carrying'; i++) { step(g, 60); if (o.state === 'ready') { pressE(g); talkThrough(g); } }
      goTo(g, o.drop.pos); step(g, 30);
      const guard = O.scene.drop.find((a) => a.tag === 'guard' || a.tag === 'libo');
      if (!guard) return { pass: false, detail: 'no guard' };
      goTo(g, guard.root.position.clone().lerp(o.drop.pos, 0.55)); pressE(g);
      // beg to go up (choice 3) once; a normal guard says no and asks again, a kind one (李伯) lets you up
      const D = G.dialogue, lines: string[] = [];
      let choices = 0, asked = false;
      for (let i = 0; i < 40 && D.open; i++) {
        if (D.pauseT > 0) { step(g, Math.ceil(D.pauseT * 60) + 2); continue; }
        if (D.choosing) { if (++choices === 2) { asked = true; break; } G.input.digitQueued = 2; step(g, 1); continue; }
        D.finishLine(); if (D.current) lines.push(D.current.text);
        G.input.talkQueued = true; step(g, 1);
      }
      if ((o.state as string) === 'done') asked = true;
      talkThrough(g, 0);
      if ((o.state as string) !== 'done') { goTo(g, o.drop.place!.spots.locker); pressE(g); talkThrough(g); }
      return { pass: asked && (o.state as string) === 'done', detail: `${guard.tag}: ${lines.slice(0, 2).join(' / ')}; asked again ${asked}; delivered ${(o.state as string) === 'done'}` };
    },
  },
  {
    id: 'ORD-04', title: '放门口拍照：默认取景能拍到外卖和门牌；转开镜头拍就不算；"没收到"投诉时好照片申诉成功、坏照片被扣钱',
    run: (g) => {
      const G = og(g), O = G.orders, J = (g as unknown as { jobs: { cash: number } }).jobs;
      onFoot(g);
      const out: string[] = [];
      for (const aimAway of [false, true]) {
        O.reset(); O.storyStep = 4; O.sinceStory = 1; step(g, 90); talkThrough(g);
        const o = O.order!;
        goTo(g, o.shop.pos); pressE(g); talkThrough(g);
        goTo(g, o.drop.place!.spots.door); pressE(g); talkThrough(g); step(g, 2);
        if (!G.photo.active) return { pass: false, detail: 'the photo did not start' };
        if (aimAway) { g.input.setKey('KeyW', false); (G as unknown as { lookVec: THREE.Vector2 }).lookVec.set(0, 0); for (let i = 0; i < 6; i++) { (g as unknown as { photo: { yaw: number } }).photo.yaw += 0.5; step(g, 1); } }
        const live = { ...G.photo.live };
        G.input.jumpQueued = true; step(g, 3);
        const cash0 = J.cash;
        step(g, 60 * 22);
        const notes = [...document.querySelectorAll('.note')].map((n) => n.textContent ?? '').join(' | ');
        out.push(`${aimAway ? 'aimed away' : 'default'}: live ${live.bag}/${live.plate} -> ${o.photo?.good}; complaint ${/没收到/.test(notes)}, ${/申诉成功/.test(notes) ? 'appeal won' : /申诉失败/.test(notes) ? 'appeal lost' : 'no verdict'} (cash ${(J.cash - cash0).toFixed(1)})`);
        if (aimAway ? o.photo?.good !== false || !/申诉失败/.test(notes) : !o.photo?.good || !/申诉成功/.test(notes)) return { pass: false, detail: out.join('; ') };
      }
      return { pass: true, detail: out.join('; ') };
    },
  },
  {
    id: 'ORD-05', title: '第一章《五星好评》从头玩到尾（6 个剧情单 + 中间的普通单），每单都能送完，最后解锁「特殊订单」',
    run: (g) => {
      const G = og(g), O = G.orders;
      onFoot(g);
      O.reset(); step(g, 60);
      const log: string[] = [];
      for (let k = 0; k < 14 && !O.chapterDone; k++) {
        const r = playOrder(g, 0);
        log.push(r);
        if (r.startsWith('stuck') || r === 'no order') return { pass: false, detail: log.join(' · ') };
        step(g, 60 * 3);
      }
      talkThrough(g);
      const lines = G.dialogue.log.join(' ');
      return { pass: O.chapterDone, detail: `${log.join(' · ')}; chapter done ${O.chapterDone}` + (lines ? '' : '') };
    },
  },
  {
    id: 'ORD-06', title: '摔车后有路人走过来、说句话、把车扶起来',
    run: (g) => {
      const G = og(g), O = G.orders;
      const B = bikeOf(g);
      parkBikeHome(g);
      const b = B.bike;
      (B.bikes as unknown as { knockOver(b: unknown, v: Vec3): void }).knockOver(b, V(4, 0, 0));
      step(g, 90);
      const crashed = b.crashed;
      O.crashHelp(b.obj.position.clone(), g.characters[g.active].root.position.clone());
      let said = '', lifted = false;
      for (let i = 0; i < 60 * 25 && !lifted; i++) {
        step(g, 1);
        const h = (O as unknown as { helper: QAActor | null }).helper;
        if (h?.bubble?.textContent) said = h.bubble.textContent;
        lifted = !b.crashed && Math.abs(b.lean) < 0.1;
      }
      parkBikeHome(g);
      return { pass: crashed && lifted && !!said, detail: `knocked over ${crashed}, a passer-by said "${said}", bike upright ${lifted}` };
    },
  },
  {
    id: 'ORD-07', title: '酒店：送餐机器人小准二号出门来接，按 E 交给它（不用过保安）',
    run: (g) => {
      const G = og(g), O = G.orders;
      onFoot(g);
      O.reset(); O.chapterDone = true; O.storyStep = 6;
      if (!O.debugOrder(g.characters[g.active].root.position, { customer: 'normal', mode: 'lobby', sub: 'hotel' })) return { pass: false, detail: 'no hotel' };
      const r = playOrder(g, 0);
      const said = G.dialogue.log.find((l) => l.includes('5.00')) ?? '';
      return { pass: r.endsWith('done') && !!said, detail: `${r}; the robot said "${said}"` };
    },
  },
  {
    id: 'ORD-08', title: '外卖站在阿杰出生点 40 m 内、有 3 个骑手能聊天；公交站牌 > 100 个；站牌边等的人都站在人行道上',
    run: (g) => {
      const G = og(g), O = G.orders;
      const gg = g as unknown as { timings: Record<string, number>; orders: { stationCrew: QAActor[]; walkable(p: Vec3): boolean } };
      onFoot(g);
      const crew = gg.orders.stationCrew;
      const spawn = V(gg.timings.spawnX, 0, gg.timings.spawnZ);      // where Ah Jie actually starts (snapped to the pavement)
      const st = V(gg.timings.stationX, 0, gg.timings.stationZ);
      const dSt = Math.hypot(st.x - spawn.x, st.z - spawn.z);
      let chat = '';
      if (crew.length) {
        goTo(g, crew[0].root.position.clone().add(V(0.9, 0, 0.3)));
        O.cancel(); step(g, 2);
        pressE(g); const l = talkThrough(g); chat = l[0] ?? '';
      }
      // people at a few bus stops
      let bad = 0, total = 0;
      for (let k = 0; k < 4; k++) {
        O.reset(); O.chapterDone = true; O.storyStep = 6;
        if (!O.debugOrder(g.characters[g.active].root.position, { customer: 'normal', mode: 'handover' })) continue;
        const o = O.order!;
        (o as unknown as { state: string }).state = 'carrying';
        goTo(g, o.drop.pos.clone().add(V(3, 0, 3))); step(g, 30);
        for (const a of O.scene.drop) { total++; if (!gg.orders.walkable(a.root.position.clone())) bad++; }
      }
      O.cancel();
      return { pass: dSt < 40 && crew.length === 3 && !!chat && (gg.timings.busSigns ?? 0) > 100 && total > 4 && bad === 0, detail: `station ${dSt.toFixed(1)} m from the spawn, ${crew.length} couriers, 老周: "${chat}"; ${gg.timings.busSigns} stop boards; ${bad} of ${total} waiting people off the pavement` };
    },
  },
  {
    id: 'ORD-09', title: '新顾客都能送完：博主（配合拍摄给打赏）、阿婆（下楼慢、给利是）、带垃圾、顺路带纸巾、给狗点的',
    run: (g) => {
      const G = og(g), O = G.orders;
      onFoot(g);
      const out: string[] = [];
      for (const [id, mode] of [['influencer', 'handover'], ['oldlady', 'door'], ['garbage', 'door'], ['errand', 'handover'], ['dog', 'handover']] as const) {
        O.reset(); O.chapterDone = true; O.storyStep = 6;
        if (!O.debugOrder(g.characters[g.active].root.position, { customer: id, mode })) { out.push(`${id}: no order`); continue; }
        const r = playOrder(g, 0);
        out.push(`${id}: ${r}`);
      }
      O.cancel();
      return { pass: out.every((l) => l.endsWith('done')), detail: out.join(' · ') };
    },
  },
  // ------------------------------------------------------------------ character
  {
    id: 'CHR-01', title: '人走向路灯杆会被挡住（不穿杆）',
    run: (g) => {
      onFoot(g);
      let pole = V(), from: Vec3 | null = null;
      for (let i = 300; i < g.city.lampPoles.length && !from; i += 41) {
        const [x, y, z] = g.city.lampPoles[i];
        pole = fromBlender(x, y, z);
        from = approach(g, pole, 0.13, 3, 0.35)?.from ?? null;
      }
      if (!from) return { pass: false, detail: 'no lamp post with a clear approach' };
      g.characters[g.active].placeAt(from.setY(from.y + 0.3), 0);
      step(g, 10);
      const d = walkInto(g, pole, 2.5);
      return { pass: d > 0.38, detail: `closest approach to the pole axis ${d.toFixed(2)} m (pole 0.13 + capsule 0.32)` };
    },
  },
  {
    id: 'CHR-02', title: '人走向行道树干会被挡住',
    run: (g) => {
      onFoot(g);
      let trunk = V(), from: Vec3 | null = null;
      for (let i = 0; i < g.city.treePos.length && !from; i += 53) {
        const t = g.city.treePos[i];
        if (t[2] > 0.4) continue;
        trunk = fromBlender(t[0], t[1], t[2]);
        from = approach(g, trunk, 0.6, 3.5, 0.35)?.from ?? null;
      }
      if (!from) return { pass: false, detail: 'no street tree with a clear approach' };
      g.characters[g.active].placeAt(from.setY(from.y + 0.3), 0);
      step(g, 10);
      const d = walkInto(g, trunk, 2.5);
      return { pass: d > 0.5, detail: `closest approach to the trunk axis ${d.toFixed(2)} m` };
    },
  },
  {
    id: 'CHR-03', title: '人走向长椅 / 垃圾桶 / 电箱会被挡住',
    run: (g) => {
      onFoot(g);
      const res: string[] = [];
      let ok = true;
      for (const mat of ['GZK | hardwood', 'GZK | bin green', 'GZK | cabinet grey']) {
        const list = furniture(g, mat);
        if (!list.length) { ok = false; res.push(`${mat}: none`); continue; }
        let p = V(), from: Vec3 | null = null;
        for (let i = Math.floor(list.length / 2); i < list.length && !from; i += 7) { p = list[i][0]; from = approach(g, p, 1.05, 3.5, 0.35)?.from ?? null; }
        if (!from) { ok = false; res.push(`${mat}: no clear approach`); continue; }
        g.characters[g.active].placeAt(from.setY(from.y + 0.3), 0);
        step(g, 10);
        const d = walkInto(g, p, 2.5);
        ok &&= d > 0.3;
        res.push(`${mat.split('| ')[1]} ${d.toFixed(2)} m`);
      }
      return { pass: ok, detail: res.join(', ') };
    },
  },
  {
    id: 'CHR-04', title: '人从背后走向公交站，被站亭后墙挡住',
    run: (g) => {
      onFoot(g);
      const sh = furniture(g, 'GZK | shelter roof');
      const o = V();
      for (let i = 0; i < sh.length; i += 5) {
        const [p, , z] = sh[i];
        const back = z.clone().setY(0).normalize();              // local +z = front (toward the kerb)
        const from = p.clone().addScaledVector(back, -3.2);
        const gy = g.collision.groundHeight(o.copy(from).setY(p.y + 1), 2);
        if (gy === null || Math.abs(gy - p.y) > 0.25) continue;
        const along = V(back.z, 0, -back.x);
        if (fan(0.4).some((off) => g.props.raycast(o.copy(from).addScaledVector(along, off).setY(gy + 1), back, 2.2) < 2.2 || g.collision.raycastDistance(o.copy(from).addScaledVector(along, off).setY(gy + 1), back, 3.2) < 3.2)) continue;
        g.characters[g.active].placeAt(from.setY(gy + 0.3), 0);
        step(g, 10);
        const pl = g.characters[g.active].root.position;
        let worst = -Infinity;
        const target = p.clone().addScaledVector(back, 1.5);
        for (let k = 0; k < 150; k++) {
          const d = V(target.x - pl.x, 0, target.z - pl.z);
          g.rig.yaw = Math.atan2(-d.x, -d.z);
          g.input.setKey('KeyW', true);
          step(g, 1);
          worst = Math.max(worst, pl.clone().sub(p).dot(back));
        }
        g.input.setKey('KeyW', false);
        return { pass: worst < -0.85, detail: `deepest point behind the shelter centre ${worst.toFixed(2)} m (back wall at -0.8 m)` };
      }
      return { pass: false, detail: 'no shelter with a clear approach from behind' };
    },
  },
  {
    id: 'CAM-01', title: '镜头弹簧臂不穿过树干',
    run: (g) => {
      onFoot(g);
      for (let i = 0; i < g.city.treePos.length; i += 61) {
        const t = g.city.treePos[i];
        if (t[2] > 0.4) continue;
        const trunk = fromBlender(t[0], t[1], t[2]);
        const a = approach(g, trunk, 0.6, 2.6, 0.35);
        if (!a) continue;
        const ch = g.characters[g.active];
        ch.placeAt(a.from.clone().setY(a.from.y + 0.3), 0);
        step(g, 5);
        // look at the player from the trunk's side: the camera arm points from the player toward the trunk
        g.rig.yaw = Math.atan2(-a.dir.x, -a.dir.z) + Math.PI;
        g.rig.pitch = -0.02;
        step(g, 30);
        const pl = ch.root.position, cam = g.camera.position.clone();
        const trunkD = Math.hypot(trunk.x - pl.x, trunk.z - pl.z);
        const camD = Math.hypot(cam.x - pl.x, cam.z - pl.z);
        // what matters: the lens is not inside the trunk and the player is in sight
        const inTrunk = Math.hypot(cam.x - trunk.x, cam.z - trunk.z) < 0.5;
        const chest = pl.clone().setY(pl.y + 1.3);
        const los = chest.clone().sub(cam);
        const L = los.length(); los.normalize();
        const blocked = g.props.raycast(cam, los, L - 0.4) < L - 0.4;
        return { pass: !inTrunk && !blocked, detail: `trunk ${trunkD.toFixed(2)} m behind the player, camera ${camD.toFixed(2)} m out; lens in trunk ${inTrunk}, view blocked ${blocked}` };
      }
      return { pass: false, detail: 'no tree with a clear approach' };
    },
  },
  {
    id: 'PERF-02', title: '碰撞查询 CPU：开车 40 s，每帧道具查询 P95 < 0.2 ms',
    run: (g) => {
      const c = drive(g);
      // record every prop query of every frame while driving, then time a replay (the browser clock is too
      // coarse to time single queries)
      const P = g.props as unknown as Record<string, (...a: unknown[]) => unknown>;
      const names = ['resolveBox', 'resolveCircle', 'raycast'];
      const orig = names.map((n) => P[n]);
      type Call = [number, unknown[]];
      let cur: Call[] = [];
      const frames: Call[][] = [];
      names.forEach((n, k) => { P[n] = (...a: unknown[]) => { cur.push([k, a.map((x) => (x instanceof THREE.Vector3 ? x.clone() : x))]); return orig[k].apply(g.props, a); }; });
      const origUpdate = g.update;
      try {
        g.update = (dt: number, t: number) => { cur = []; origUpdate.call(g, dt, t); frames.push(cur); };
        const lane = g.traffic.roads.lanes.filter((l) => l.path.length > 400 && l.from.z < 0.3 && l.to.z < 0.3)[3];
        followPath(g, c, lane.path.pts.map((q) => q.clone()), 14, 0);
      } finally {
        delete (g as unknown as Record<string, unknown>).update;
        names.forEach((n) => delete P[n]);
      }
      const scratch = [V(), V(), V()];
      const per: number[] = [];
      for (const f of frames) {
        const t0 = performance.now();
        for (let rep = 0; rep < 50; rep++) {
          for (const [k, a] of f) {
            const args = a.map((x, j) => (x instanceof THREE.Vector3 ? scratch[j].copy(x) : x));
            orig[k].apply(g.props, args);
          }
        }
        per.push((performance.now() - t0) / 50);
      }
      per.sort((a, b) => a - b);
      const p95 = per[Math.floor(per.length * 0.95)] ?? 0;
      const calls = frames.reduce((s2, f) => s2 + f.length, 0) / Math.max(1, frames.length);
      return { pass: frames.length > 200 && p95 < 0.2, detail: `${frames.length} frames, ${calls.toFixed(1)} queries/frame; per frame median ${per[per.length >> 1]?.toFixed(4)} ms, P95 ${p95.toFixed(4)} ms` };
    },
  },
  {
    id: 'PERF-01', title: '1440p 每帧耗时（连续渲染再同步，GPU 与 CPU 重叠后的真实吞吐）：出生点街景 / 塔楼方向 × 白天 / 夜，白天 ≤ 14 ms、夜 ≤ 16 ms（窗口不是 1440p 时只报数；GPU 计时器读数附在后面，ANGLE/Metal 下可能偏高）',
    run: async (g) => {
      const G = (window as unknown as { __GZ__: Record<string, (...a: unknown[]) => unknown> }).__GZ__;
      const is1440 = g.canvas.width >= 2500;
      const res: string[] = [];
      let ok = true;
      const hour = g.env.hour;
      for (const [tag, h, budget] of [['day', 15, 14], ['night', 21.5, 16]] as [string, number, number][]) {
        g.env.setHour(h);
        G.teleport(905, -395, Math.PI);
        for (const [view, yaw, pitch, dist] of [['street', 2.6, -0.12, 5], ['towers', 0.6, -0.05, 6]] as [string, number, number, number][]) {
          G.setView(yaw, pitch, dist); G.step(8);
          await G.bench(10);                                   // warm-up: uploads and detail generation after the teleport
          const b = await G.bench(36) as { median: number; throughput: number; size: string };
          ok &&= b.throughput <= budget;
          res.push(`${tag}/${view} ${b.throughput} ms (timer ${b.median})`);
        }
      }
      g.env.setHour(hour);
      return { pass: !is1440 || ok, detail: `${g.canvas.width}x${g.canvas.height}${is1440 ? '' : ' (not 1440p: info only)'}: ${res.join(', ')}` };
    },
  },
  {
    id: 'PERF-03', title: '黄昏开灯不卡：17:36 → 19:10 快进，每帧 CPU（逻辑 + 渲染）< 25 ms',
    run: (g) => {
      home(g);
      const hour = g.env.hour;
      g.env.setHour(17.6);
      step(g, 3); g.render();
      const per: number[] = [];
      let at = 0;
      for (let i = 0; i < 45; i++) {
        g.env.setHour(17.6 + i * 0.035);
        const t0 = performance.now();
        step(g, 1); g.render();
        const ms = performance.now() - t0;
        per.push(ms);
        if (ms >= Math.max(...per)) at = g.env.hour;
      }
      g.env.setHour(hour);
      const worst = Math.max(...per.slice(1));
      per.sort((a, b) => a - b);
      return { pass: worst < 25, detail: `worst frame ${worst.toFixed(1)} ms at ${at.toFixed(2)} h, median ${per[per.length >> 1].toFixed(1)} ms` };
    },
  },
  // ------------------------------------------------------------------ layout rules
  {
    id: 'LAY-01', title: '过街线上没有护柱挡路',
    run: (g) => {
      const bol = furniture(g, 'GZK | reflector').map(([p]) => [p.x, -p.z]);
      const badSet = new Set<number>();
      for (const e of g.walk.edges) {
        if (e.kind !== 'cross') continue;
        const a = e.pts[0], b = e.pts[e.pts.length - 1];
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
        bol.forEach((p, i) => {
          if (Math.abs(p[0] - a[0]) > 30 || Math.abs(p[1] - a[1]) > 30) return;
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
          const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
          if (t > -0.2 && t < 1.2 && d < 0.6) badSet.add(i);
        });
      }
      return { pass: badSet.size === 0, detail: `${badSet.size} of ${bol.length} bollards stand on a crossing's walking line` };
    },
  },
  {
    id: 'LAY-02', title: '公交站前面没有护栏（乘客能上车）',
    run: (g) => {
      const rails = furniture(g, 'GZK | rail green').map(([p]) => p);
      const sh = furniture(g, 'GZK | shelter roof');
      let bad = 0;
      for (const [p] of sh) if (rails.some((r) => Math.hypot(r.x - p.x, r.z - p.z) < 5)) bad++;
      return { pass: bad === 0, detail: `${bad} of ${sh.length} shelters have a guard rail between them and the kerb` };
    },
  },
  {
    id: 'LAY-03', title: '护栏不切断斑马线',
    run: (g) => {
      const rails = furniture(g, 'GZK | rail green').map(([p]) => [p.x, -p.z]);
      const grid = new Map<string, number[][]>();
      for (const r of rails) { const k = `${Math.floor(r[0] / 20)},${Math.floor(r[1] / 20)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(r); }
      let cut = 0, n = 0;
      for (const e of g.walk.edges) {
        if (e.kind !== 'cross') continue;
        n++;
        const a = e.pts[0], b = e.pts[e.pts.length - 1];
        for (let t = 0; t <= 1; t += 0.1) {
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
          if ((grid.get(`${Math.floor(x / 20)},${Math.floor(y / 20)}`) ?? []).some((r) => Math.hypot(r[0] - x, r[1] - y) < 1.1)) { cut++; break; }
        }
      }
      return { pass: cut === 0, detail: `${cut} of ${n} crossings are cut by a railing` };
    },
  },
  {
    id: 'LAY-04', title: '人行道小件（长椅、垃圾桶、消防栓、电箱、花箱）离路灯杆和树干 ≥ 1.2 m',
    run: (g) => {
      const grid = new Map<string, number[]>();
      const add = (x: number, y: number) => { const k = `${Math.floor(x / 10)},${Math.floor(y / 10)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(x, y); };
      for (const [x, y] of g.city.lampPoles) add(x, y);
      for (const [x, y] of g.city.treePos) add(x, y);
      const small = new Set(['bench', 'bin', 'hydrant', 'cabinet', 'planter']);
      let n = 0, bad = 0;
      for (const p of g.furniture.places) {
        if (!small.has(p.proto)) continue;
        n++;
        const cx = Math.floor(p.x / 10), cy = Math.floor(p.y / 10);
        let hit = false;
        for (let i = -1; i <= 1 && !hit; i++) for (let j = -1; j <= 1 && !hit; j++) {
          const l = grid.get(`${cx + i},${cy + j}`) ?? [];
          for (let k = 0; k < l.length; k += 2) if (Math.hypot(l[k] - p.x, l[k + 1] - p.y) < 1.2) { hit = true; break; }
        }
        if (hit) bad++;
      }
      return { pass: bad === 0 && n > 1000, detail: `${bad} of ${n} pavement props within 1.2 m of a lamp post or tree` };
    },
  },
  {
    id: 'LAY-06', title: '车行道上没有道具（路灯杆、护栏、站亭、树等不压车道）',
    run: (g) => {
      const p = V(), t = V();
      const kinds: Record<string, number> = {};
      const seen = new Set<string>();
      for (const l of g.traffic.roads.lanes) {
        for (let s = 1; s < l.path.length - 1; s += 2) {
          l.path.at(s, p, t);
          const n = g.props.nearest(p.x, p.z, Math.max(0.5, l.width / 2 - 0.3), (k) => k !== 'bollard', p.y);
          if (!n) continue;
          const key = `${n.x.toFixed(1)},${n.z.toFixed(1)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
        }
      }
      return { pass: seen.size === 0, detail: `${seen.size} props inside a lane: ${JSON.stringify(kinds)}` };
    },
  },
  {
    id: 'LAY-07', title: '屋顶杂物：核心区 ≥ 95% 的平屋顶上有东西，没有悬空或埋进楼里的；地图外一圈远景楼顶也有',
    run: (g) => {
      const r = g.roofs.roofs, p = V(), q = V(), m = new THREE.Matrix4();
      let n = 0, bad = 0;
      const ex: string[] = [];
      for (const o of g.roofs.group.children) {
        const im = o as THREE.InstancedMesh;
        if (!im.receiveShadow) continue;                 // backdrop roofs: no collision to check against
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, m); p.setFromMatrixPosition(m);
          const y = g.collision.groundHeight(q.set(p.x, p.y + 6, p.z), 12);
          n++;
          if (y === null || Math.abs(y - p.y) > 0.35) {
            bad++;
            if (ex.length < 4) ex.push(`${im.name} @ ${p.x.toFixed(0)},${p.z.toFixed(0)} y ${p.y.toFixed(1)} roof ${y?.toFixed(1) ?? '-'}`);
          }
        }
      }
      const cov = r.core.filled / Math.max(1, r.core.n);
      return { pass: cov >= 0.95 && bad === 0 && r.far.filled > 1000,
        detail: `core roofs ${r.core.filled}/${r.core.n} (${(cov * 100).toFixed(1)}%), backdrop ${r.far.filled}/${r.far.n}; ${n} items probed, ${bad} off their roof ${ex.join('; ')}` };
    },
  },
  // ------------------------------------------------------------------ traffic
  {
    id: 'TRF-01', title: '车流 3 分钟模拟无卡死',
    run: (g) => {
      home(g);
      step(g, 180 * 20, 1 / 20);
      const s = g.traffic.stats();
      return { pass: s.stuck === 0, detail: `stuck ${s.stuck}` };
    },
  },
  {
    id: 'TRF-02', title: '车辆刷新不穿帮（不在镜头 300 m 内、视野里凭空出现）',
    run: (g) => {
      home(g);
      g.traffic.respawnLog.length = 0;
      step(g, 60 * 20, 1 / 20);
      const cam = g.camera;
      cam.updateMatrixWorld();
      const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      const fresh = g.traffic.respawnLog;
      const seen = fresh.filter((p) => p.distanceTo(cam.position) < 300 && fr.containsPoint(p)).length;
      return { pass: seen === 0, detail: `${fresh.length} respawns in 60 s, ${seen} of them inside the view within 300 m` };
    },
  },
  // ------------------------------------------------------------------ metro entrances
  {
    id: 'MET-01', title: '从人行道走进地铁口，顺楼梯下到地下厅，闸机前出现乘车提示',
    run: (g) => {
      onFoot(g);
      // gated halls only (the APM entrances run on into passages; APM-01 walks those)
      const pav = g.metro.exits.filter((e) => e.kind === 'pavilion' && !g.metro.apm.has(e.id));
      const picks = [pav[0], pav[Math.floor(pav.length / 2)], pav.find((e) => e.station === '珠江新城') ?? pav[1]];
      const out: string[] = [];
      let ok = 0;
      for (const e of picks) {
        const ch = g.characters[g.active];
        const h = e.yaw + Math.PI;                      // facing local +Y: in through the opening, down the stair
        ch.placeAt(exitPoint(g, e, -1.3, g.metro.L.steps_y0 - 2.2, 0.3), h);
        g.rig.yaw = h + Math.PI; g.rig.pitch = 0.2;
        step(g, 5);
        g.input.setKey('KeyW', true);
        let t = 0;
        try {
          while (t < 14 && g.metro.at(ch.root.position)?.id !== e.id) { step(g, 6); t += 0.1; }
          step(g, 24);                                  // off the last step and up to the gates
        } finally { g.input.setKey('KeyW', false); }
        const y = ch.root.position.y - e.z;
        const reached = g.metro.at(ch.root.position)?.id === e.id && Math.abs(y - g.metro.L.floor_z) < 0.15;
        const prompt = (document.querySelector('#prompt') as HTMLElement | null);
        step(g, 2);
        const shown = !!prompt && !prompt.hidden && prompt.textContent!.includes('地铁');
        if (reached && shown) ok++;
        const q = ch.root.position, cy = Math.cos(-e.yaw), sy = Math.sin(-e.yaw);
        const lx = (q.x - e.x) * cy - (-q.z - e.y) * sy, ly = (q.x - e.x) * sy + (-q.z - e.y) * cy;
        out.push(`${e.station}${e.id}: ${reached ? `hall in ${t.toFixed(1)} s` : `stuck at (${lx.toFixed(2)}, ${ly.toFixed(2)}, ${y.toFixed(2)})`}${shown ? '' : ', no prompt'}`);
      }
      return { pass: ok === picks.length, detail: out.join('; ') };
    },
  },
  {
    id: 'MET-02', title: '闸机前按 E 选站乘车：淡出后出现在目的站地下厅，羊城通扣费',
    run: (g) => {
      onFoot(g);
      const from = g.metro.exits.find((e) => e.kind === 'pavilion' && e.station === '珠江新城') ?? g.metro.exits[0];
      const a = g.metro.arrive(from);
      g.characters[g.active].placeAt(a.pos, a.heading);
      step(g, 5);
      const card0 = g.metroCard;
      g.input.interactQueued = true; step(g, 2);
      const menu = document.querySelector('#metro-menu') as HTMLElement | null;
      if (!menu || menu.hidden) return { pass: false, detail: 'E at the gates did not open the menu' };
      // from the page like a real key press (dispatched on window itself, the game's own listener would see it too)
      const key = (code: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      key('ArrowDown'); key('ArrowDown');
      const pick = menu.querySelector('li.sel b')?.textContent ?? '?';
      key('Enter');
      step(g, 110);
      // arrived in the hall of one of that station's entrances (APM halls have no gates, so not metro.at())
      const p = g.characters[g.active].root.position;
      const near = g.metro.exits.filter((e) => e.station === pick).map((e) => g.metro.arrive(e).pos.distanceTo(p));
      const d = near.length ? Math.min(...near) : Infinity;
      const pass = d < 3 && g.metroCard < card0;
      return { pass, detail: `picked ${pick}; ${d.toFixed(1)} m from its arrival point; card ${card0} -> ${g.metroCard}` };
    },
  },
  {
    id: 'MET-03', title: '每个地铁口的楼梯井和地下厅都是通的（没有地面、草坪、人行道、江面盖在上面）',
    run: (g) => {
      const L = g.metro.L;
      const rc = new THREE.Raycaster();
      const bad: string[] = [];
      let n = 0;
      for (const e of g.metro.exits) {
        if (e.kind !== 'pavilion') continue;
        // collision: the well from above lands on the stair ramp; under the lid, the hall floor
        for (const [lx, ly, from, want] of [[-1.0, 0.0, 3.0, -0.6], [0.8, 2.5, 3.0, -1.0], [-0.5, 11.0, L.hall_ceil - 0.3, L.floor_z + 0.1], [0.0, 14.0, L.hall_ceil - 0.3, L.floor_z + 0.1]]) {
          n++;
          const hy = g.collision.groundHeight(exitPoint(g, e, lx, ly, from), 12);
          if (hy === null || hy - e.z > want) bad.push(`${e.id} collision ${lx},${ly}: ${hy === null ? 'none' : (hy - e.z).toFixed(2)}`);
          // render: the first surface straight down is the entrance's own
          rc.set(exitPoint(g, e, lx, ly, from), V(0, -1, 0)); rc.far = 12;
          const hit = rc.intersectObjects(g.scene.children, true).find((h) => (h.object as THREE.Mesh).isMesh);
          const name = ((hit?.object as THREE.Mesh | undefined)?.material as THREE.Material | undefined)?.name ?? 'none';
          if (!name.includes('metro')) bad.push(`${e.id} render ${lx},${ly}: ${name}`);
        }
      }
      return { pass: bad.length === 0, detail: bad.length ? `${bad.length}/${n * 2} probes blocked: ${bad.slice(0, 6).join('; ')}` : `${n * 2} probes in ${n / 4} entrances all open` };
    },
  },
  {
    id: 'MET-04', title: '车开不进地铁口（亭前护柱挡住，不会掉进楼梯井）',
    run: (g) => {
      const c = drive(g);
      const out: string[] = [];
      let ok = 0;
      const pav = g.metro.exits.filter((e) => e.kind === 'pavilion').slice(0, 4);
      for (const e of pav) {
        const s = exitPoint(g, e, -0.2, g.metro.L.steps_y0 - 12, 0);
        const gy = g.collision.groundHeight(s.clone().setY(s.y + 3), 6) ?? s.y;
        const [dx, dy] = [-Math.sin(e.yaw), Math.cos(e.yaw)];     // local +Y in Blender
        const [bx, by] = [s.x, -s.z];
        placeCar(c, bx, by, gy + 0.05, dx, dy, 8);
        g.pilot = () => ({ throttle: 0.6, steer: 0, handbrake: false });
        let lowest = Infinity;
        try { for (let i = 0; i < 40; i++) { step(g, 6); lowest = Math.min(lowest, c.obj.position.y - e.z); } } finally { g.pilot = null; }
        const q = c.obj.position;
        const lx = (q.x - e.x) * Math.cos(-e.yaw) - (-q.z - e.y) * Math.sin(-e.yaw);
        const ly = (q.x - e.x) * Math.sin(-e.yaw) + (-q.z - e.y) * Math.cos(-e.yaw);
        const good = lowest > -0.5 && ly < g.metro.L.steps_y0 + 0.2;
        if (good) ok++;
        out.push(`${e.id}: stopped at local y ${ly.toFixed(1)} (lx ${lx.toFixed(1)}), lowest ${lowest.toFixed(2)}`);
      }
      return { pass: ok === pav.length, detail: out.join('; ') };
    },
  },
  // ------------------------------------------------------------------ APM underground
  {
    id: 'APM-01', title: '从大剧院 A 口走进站：楼梯 → 通道 → 站厅闸机（扣费）→ 楼梯 → 站台',
    run: (g) => {
      onFoot(g);
      const e = g.metro.exits.find((x) => x.station === '大剧院' && g.apm.data.passages[x.id]);
      const st = g.apm.stations.find((s) => s.name === '大剧院');
      if (!e || !st) return { pass: false, detail: 'no 大剧院 entrance with a passage' };
      const ch = g.characters[g.active];
      const h = e.yaw + Math.PI;
      ch.placeAt(exitPoint(g, e, -0.4, g.metro.L.steps_y0 - 2.2, 0.3), h);
      g.rig.yaw = h + Math.PI; step(g, 5);
      const card0 = g.metroCard;
      const legs: [string, Vec3][] = [['stair', exitPoint(g, e, -0.4, g.metro.L.hall[3] - 0.6, g.metro.L.floor_z)]];
      const pl = g.apm.data.passages[e.id];
      pl.slice(1).forEach((q, i) => legs.push(['passage ' + (i + 1), fromBlender(q[0], q[1], g.apm.L.concourse)]));
      const end = pl[pl.length - 1];
      const [ue] = g.apm.toFrame(st, end[0], end[1]);
      const [p0, p1] = g.apm.F.paid_u;
      const Lz = g.apm.L;
      if (ue > 0) {
        legs.push(['gate', apmPoint(g, st, p1 + 2.5, 0, Lz.concourse)], ['paid', apmPoint(g, st, p1 - 2.0, 0, Lz.concourse)]);
      } else {
        legs.push(['gate', apmPoint(g, st, p0 - 2.5, 0, Lz.concourse)], ['paid', apmPoint(g, st, p0 + 2.0, 0, Lz.concourse)],
          ['round the well', apmPoint(g, st, p0 + 2.0, 3.2, Lz.concourse)], ['stair side', apmPoint(g, st, g.apm.F.stair_top + 1.8, 3.2, Lz.concourse)]);
      }
      legs.push(['stair head', apmPoint(g, st, g.apm.F.stair_top + 1.8, 1.1, Lz.concourse)], ['platform', apmPoint(g, st, -12.2, 1.1, Lz.platform)]);
      const done: string[] = [];
      for (const [name, tgt] of legs) {
        if (!walkTo(g, tgt, 40, name === 'platform' ? 0.9 : 0.8)) {
          const p = ch.root.position;
          return { pass: false, detail: `stuck before "${name}" at (${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}); passed ${done.join(' > ')}` };
        }
        done.push(name);
      }
      const onPlatform = Math.abs(ch.root.position.y - Lz.platform) < 0.2;
      const paid = g.apm.paidAt(ch.root.position)?.name === '大剧院';
      return { pass: onPlatform && paid && g.metroCard < card0, detail: `${done.length} legs; platform ${onPlatform}, paid side ${paid}, card ${card0} -> ${g.metroCard}` };
    },
  },
  {
    id: 'APM-02', title: 'APM 乘车：开门时走进车门上车 → 下一站到站 → 按 F 下车到站台',
    run: (g) => {
      onFoot(g);
      const ch = g.characters[g.active];
      let tr: QATrain | undefined;
      for (let i = 0; i < 600 && !tr; i++) { step(g, 6); tr = g.apmTrains.trains.find((t) => t.track === 1 && t.phase === 'dwell' && t.doors > 0.9 && !!t.at && !t.terminus && t.at.key !== 'fuer'); }
      if (!tr || !tr.at) return { pass: false, detail: 'no northbound train at a platform within 60 s' };
      const st = tr.at;
      const iv = g.apm.F.island_v;
      ch.placeAt(apmPoint(g, st, 3.3, -(iv - 1.4), g.apm.L.platform + 0.05), 0);
      step(g, 2);
      walkTo(g, apmPoint(g, st, 3.3, -(iv + 0.5), g.apm.L.platform), 3, 0.2);
      if (!g.riding) return { pass: false, detail: `did not board at ${st.name}` };
      let t = 0;
      while (t < 150 && !(tr.phase === 'dwell' && tr.doors > 0.9 && tr.at && tr.at.key !== st.key)) { step(g, 6); t += 0.1; }
      const arrived = tr.at?.name ?? '-';
      g.input.interactQueued = true; step(g, 3);
      const off = !g.riding;
      const p = ch.root.position;
      const onPlat = Math.abs(p.y - g.apm.L.platform) < 0.2;
      step(g, 200);                                         // stays off (not sucked back in)
      const stayed = !g.riding;
      return { pass: arrived !== '-' && off && onPlat && stayed, detail: `${st.name} -> ${arrived} in ${t.toFixed(0)} s; off ${off}, on platform ${onPlat}, stayed off ${stayed}` };
    },
  },
  {
    id: 'APM-03', title: 'APM 五站结构：站厅地面、站台地面、每条通道都连续可走（碰撞）',
    run: (g) => {
      const L = g.apm.L, F = g.apm.F;
      const bad: string[] = [];
      let n = 0;
      for (const st of g.apm.stations) {
        for (let u = -31; u <= 31; u += 3) for (let v = -9.5; v <= 9.5; v += 2.5) {
          if (u > -8 && u < 1.5 && Math.abs(v) < 2.5) continue;                 // the well
          if (F.paid_u.some((pu) => Math.abs(u - pu) < 1.0)) continue;             // gate cabinets and fences
          n++;
          const hy = g.collision.groundHeight(apmPoint(g, st, u, v, L.concourse + 2.5), 5);
          if (hy === null || Math.abs(hy - L.concourse) > 0.1) bad.push(`${st.key} concourse ${u},${v}`);
        }
        for (let u = -20; u <= 20; u += 2) for (const v of [-3.3, 3.3]) {
          n++;
          const hy = g.collision.groundHeight(apmPoint(g, st, u, v, L.platform + 1.5), 3);
          if (hy === null || Math.abs(hy - L.platform) > 0.1) bad.push(`${st.key} platform ${u},${v}`);
        }
      }
      for (const [eid, pl] of Object.entries(g.apm.data.passages)) {
        for (let i = 0; i < pl.length - 1; i++) {
          const a = pl[i], b = pl[i + 1];
          const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.0));
          for (let k = 1; k < m; k++) {
            n++;
            const x = a[0] + (b[0] - a[0]) * k / m, y = a[1] + (b[1] - a[1]) * k / m;
            const hy = g.collision.groundHeight(fromBlender(x, y, L.concourse + 2.5), 5);
            if (hy === null || Math.abs(hy - L.concourse) > 0.1) bad.push(`${eid} passage ${i}.${k}`);
          }
        }
      }
      void F;
      return { pass: bad.length === 0, detail: bad.length ? `${bad.length}/${n} probes off: ${bad.slice(0, 6).join('; ')}` : `${n} floor probes on level` };
    },
  },
  {
    id: 'APM-04', title: '入地切换：街上不画地铁；站厅里不画城市、不下雨、室内照明',
    run: (g) => {
      onFoot(g);
      const ch0 = g.characters[g.active];
      ch0.placeAt(fromBlender(905, -395, 1.0), 0);                              // 猎德大桥 north end, far from the APM
      step(g, 20);
      const street = !g.apm.group.visible;
      const st = g.apm.stations.find((s) => s.key === 'haixinsha')!;
      g.weather.set(1);
      const ch = g.characters[g.active];
      ch.placeAt(apmPoint(g, st, 20, 0, g.apm.L.concourse + 0.05), 0);
      step(g, 40);
      const inside = !g.city.root.visible && g.apm.group.visible;
      const env = (g as unknown as { env: { under: number } }).env.under;
      const rainHidden = !(g as unknown as { weather: { group: THREE.Group } }).weather.group.visible;
      g.weather.set(0);
      home(g); step(g, 20);
      const back = g.city.root.visible;
      return { pass: street && inside && env > 0.99 && rainHidden && back, detail: `street hides APM ${street}; inside hides city ${inside}; indoor light ${env.toFixed(2)}; rain hidden ${rainHidden}; city back ${back}` };
    },
  },
  {
    id: 'APM-05', title: 'APM 乘客站位：站台有人候车/坐长椅，都站在站台上（不进楼梯井、柱子、屏蔽门外），不重叠',
    run: (g) => {
      onFoot(g);
      const h0 = g.env.hour;
      g.env.setHour(12);
      const st = g.apm.stations.find((s) => s.key === 'haixinsha')!;
      const L = g.apm.L, iv = g.apm.F.island_v;
      g.characters[g.active].placeAt(apmPoint(g, st, 19, 0, L.platform + 0.05), Math.PI);
      step(g, 60 * 60);
      const s = g.apmPax.stats();
      const bad: string[] = [];
      const still = g.apmPax.people().filter((p) => p.act === 'wait' || p.act === 'sit');
      for (const p of still) {
        const [u, v] = g.apm.toFrame(st, p.pos.x, -p.pos.z);
        const x = -v;
        const tag = `${p.act}@(${u.toFixed(1)},${x.toFixed(1)})`;
        if (Math.abs(x) > iv - 0.3) bad.push(tag + ' past the screen doors');
        if (Math.abs(x) < 2.2 && u > -11.5 && u < 1.2) bad.push(tag + ' in the stair bank');
        if ([-17, 5.5, 13.5].some((cu) => Math.hypot(u - cu, x) < 0.55)) bad.push(tag + ' in a column');
        if (p.act === 'wait' && Math.abs(p.pos.y - L.platform) > 0.06) bad.push(tag + ` at y ${p.pos.y.toFixed(2)}`);
      }
      for (let i = 0; i < still.length; i++) for (let j = i + 1; j < still.length; j++) {
        const a = still[i].pos, b = still[j].pos;
        if (Math.hypot(a.x - b.x, a.z - b.z) < 0.42) bad.push(`overlap ${still[i].id}/${still[j].id}`);
      }
      g.env.setHour(h0);
      const ok = s.focus === 'haixinsha' && s.wait >= 4 && bad.length === 0;
      return { pass: ok, detail: `focus ${s.focus}; waiting ${s.wait}, sitting ${s.sit}, riding ${s.ride} (${s.perTrain.join('/')})${bad.length ? '; ' + bad.slice(0, 5).join('; ') : ''}` };
    },
  },
  {
    id: 'APM-06', title: 'APM 到站先下后上：有人下车、有人上车；车开走后没人留在屏蔽门外',
    run: (g) => {
      onFoot(g);
      const h0 = g.env.hour;
      g.env.setHour(12);
      const st = g.apm.stations.find((s) => s.key === 'haixinsha')!;
      const L = g.apm.L, iv = g.apm.F.island_v;
      g.characters[g.active].placeAt(apmPoint(g, st, 19, 0, L.platform + 0.05), Math.PI);
      step(g, 60 * 40);
      // the next train to open its doors here
      let tr: QATrain | undefined;
      for (let i = 0; i < 1200 && !tr; i++) { step(g, 6); tr = g.apmTrains.trains.find((t) => t.phase === 'dwell' && t.at?.key === st.key && !t.terminus && t.t < 0.9); }   // just stopped, doors not open yet
      if (!tr) { g.env.setHour(h0); return { pass: false, detail: 'no train stopped at 海心沙 within 2 min' }; }
      const before = new Set(g.apmPax.people().filter((p) => p.act === 'ride' && p.train === tr!.id).map((p) => p.id));
      const side = tr.track === 1 ? 1 : -1;
      const waiting = g.apmPax.people().filter((p) => p.act === 'wait' && -g.apm.toFrame(st, p.pos.x, -p.pos.z)[1] * side > 0).map((p) => p.id);
      const alighted = new Set<number>(), boarded = new Set<number>();
      while (tr.phase === 'dwell') {
        step(g, 6);
        for (const p of g.apmPax.people()) {
          if (before.has(p.id) && p.act === 'walk' && p.after === 'leave') alighted.add(p.id);
          if (waiting.includes(p.id) && p.train === tr.id) boarded.add(p.id);
        }
      }
      step(g, 60);
      const stranded = g.apmPax.people().filter((p) => {
        if (p.act === 'ride') return false;
        const [u, v] = g.apm.toFrame(st, p.pos.x, -p.pos.z);
        return Math.abs(u) < 25 && Math.abs(v) > iv + 0.1 && p.pos.y < L.platform + 3;
      });
      const inCar = g.apmPax.people().filter((p) => boarded.has(p.id) && p.act === 'ride' && p.train === tr!.id).length;
      g.env.setHour(h0);
      // (a train on the other side may be mid-exchange: people in its doorway are fine)
      const other = g.apmTrains.trains.find((t) => t !== tr && t.phase === 'dwell' && t.at?.key === st.key);
      const lost = stranded.filter((p) => !other || Math.sign(-g.apm.toFrame(st, p.pos.x, -p.pos.z)[1]) !== (other.track === 1 ? 1 : -1));
      const ok = alighted.size > 0 && (waiting.length === 0 || boarded.size > 0) && inCar === boarded.size && lost.length === 0;
      const desc = (p: { id: number; act: string; after: string; pos: Vec3 }) => { const [u, v] = g.apm.toFrame(st, p.pos.x, -p.pos.z); return `#${p.id} ${p.act}/${p.after} (${u.toFixed(1)}, ${(-v).toFixed(1)})`; };
      return { pass: ok, detail: `${before.size} on board, ${alighted.size} got off; ${waiting.length} waiting on that side, ${boarded.size} got on (${inCar} riding away); left outside the doors ${lost.length}${lost.length ? ': ' + lost.map(desc).join(', ') : ''}${other ? ` (other side: ${stranded.length - lost.length} in its doorway)` : ''}` };
    },
  },
  {
    id: 'APM-07', title: 'APM 乘客走线：90 s 内所有走动的人脚下都有地面（不穿墙、不悬空），也不叠在一起走',
    run: (g) => {
      onFoot(g);
      const st = g.apm.stations.find((s) => s.key === 'opera')!;
      const L = g.apm.L, iv = g.apm.F.island_v;
      g.characters[g.active].placeAt(apmPoint(g, st, 20, 4, L.concourse + 0.05), Math.PI);
      let n = 0, worst = 0, stacked = 0;
      const bad: string[] = [];
      for (let k = 0; k < 360; k++) {
        step(g, 15);
        const walkers = g.apmPax.people().filter((p) => p.act === 'walk' && !p.esc);
        for (let i = 0; i < walkers.length; i++) for (let j = i + 1; j < walkers.length; j++) {
          const a = walkers[i].pos, b = walkers[j].pos;
          if (Math.abs(a.y - b.y) < 0.5 && Math.hypot(a.x - b.x, a.z - b.z) < 0.25) stacked++;
        }
        for (const p of g.apmPax.people()) {
          if (p.act !== 'walk' || p.esc) continue;
          const [u, v] = g.apm.toFrame(st, p.pos.x, -p.pos.z);
          if (Math.abs(u) < 25 && Math.abs(v) > iv - 0.2 && p.pos.y < L.platform + 1) continue;     // stepping into / out of a car
          n++;
          const hy = g.collision.groundHeight(p.pos.clone().setY(p.pos.y + 1.0), 2.5);
          const d = hy === null ? 9 : Math.abs(hy - p.pos.y);
          worst = Math.max(worst, d);
          if (d > 0.35 && bad.length < 6) bad.push(`#${p.id} ${p.after} (${u.toFixed(1)}, ${(-v).toFixed(1)}, ${p.pos.y.toFixed(2)}) ground ${hy === null ? 'none' : hy.toFixed(2)}`);
        }
      }
      const off = bad.length;
      return { pass: n > 200 && off === 0 && stacked < n * 0.01, detail: `${n} samples, worst ${worst.toFixed(2)} m; walking inside one another ${stacked}${off ? '; ' + bad.join('; ') : ''}` };
    },
  },
  // ------------------------------------------------------------------ world / rendering
  {
    id: 'BLD-01', title: '楼体有碰撞（从街上朝楼射线能打到墙）',
    run: (g) => {
      const p = g.characters[g.active].root.position;
      let hits = 0;
      for (let a = 0; a < 6.28; a += 0.2) if (g.collision.raycastDistance(p.clone().setY(p.y + 1.5), V(Math.cos(a), 0, Math.sin(a)), 400) < 400) hits++;
      return { pass: hits > 5, detail: `${hits} of 32 horizontal rays from the spawn hit a building within 400 m` };
    },
  },
  {
    id: 'RAD-01', title: '车载音乐：骑上淡入、下车淡出；有人说话时压低；暂停一直有效；N 切歌、音量限幅；「下车继续听」',
    run: (g) => {
      type T = { id: string; title: string; artist: string; lang: string; file: string; dur: number; cover: string };
      const G = g as unknown as {
        radioVehicle: boolean;
        voice: { say(who: string, text: string, v?: string): number; silence(): void };
        radio: {
          tracks: T[]; base: string; cur: number; volume: number; muted: boolean; mode: string; foot: boolean; userPaused: boolean;
          pauseWhenHidden: boolean; audible: boolean; level: number; duckK: number; el: HTMLAudioElement;
          select(i: number, play?: boolean): void; prev(): void; toggle(): void; setVolume(v: number): void; nudgeVolume(d: number): void; setFoot(on: boolean): void;
        };
      };
      const R = G.radio;
      const keep = { tracks: R.tracks, base: R.base, cur: R.cur, vol: R.volume, mode: R.mode, foot: R.foot, paused: R.userPaused, muted: R.muted, hidden: R.pauseWhenHidden };
      let saved: string | null = null;
      try { saved = localStorage.getItem('gz.radio'); } catch { /* private window */ }
      // three silent 4 s WAV clips (8 kHz mono): real files the <audio> element can load, nothing to hear
      const wav = () => {
        const n = 8000 * 4, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
        const w = (o: number, t: string) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
        w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      };
      const urls = [wav(), wav(), wav()];
      const out: string[] = [], ok: boolean[] = [];
      const check = (name: string, c: boolean, info = '') => { ok.push(c); out.push(`${name} ${c ? 'ok' : 'FAIL'}${info ? ' (' + info + ')' : ''}`); };
      try {
        R.base = '';
        R.tracks = urls.map((u, i) => ({ id: 'qa' + i, title: 'QA ' + i, artist: '', lang: '英语', file: u, dur: 4, cover: '' }));
        R.pauseWhenHidden = false; R.mode = 'list'; R.foot = false; R.muted = false; R.setVolume(0.5);
        R.select(0, true);
        parkBikeHome(g); step(g, 60);
        check('on foot: silent', !R.audible && R.level === 0);
        mountBike(g); step(g, 60);
        check('riding: fades in', G.radioVehicle && R.audible && R.level > 0.95, `level ${R.level.toFixed(2)}`);
        G.voice.say('staff', '准时达的，等一下！', 'm'); step(g, 30);
        check('a voice: ducks', R.duckK < 0.45, `x${R.duckK.toFixed(2)}`);
        G.voice.silence(); step(g, 60);
        check('back up after', R.duckK > 0.9);
        g.input.setKey('KeyN', true); step(g, 1); g.input.setKey('KeyN', false); step(g, 1);
        check('N: next song', R.cur === 1);
        R.prev();
        check('B: the one before', R.cur === 0);
        R.toggle(); step(g, 60);
        check('pause: fades out', R.userPaused && !R.audible && R.level === 0);
        onFoot(g); mountBike(g); step(g, 30);
        check('pause holds on a new ride', R.userPaused && R.level === 0);
        R.toggle(); step(g, 60);
        check('play again', R.level > 0.95);
        R.nudgeVolume(1); const hi = R.volume; R.nudgeVolume(-5); const lo = R.volume; R.setVolume(0.5);
        check('volume 0..1', hi === 1 && lo === 0);
        onFoot(g); step(g, 60);
        check('off the bike: fades out', !G.radioVehicle && R.level === 0);
        R.setFoot(true); step(g, 60);
        check('keep playing on foot', R.level > 0.95);
        R.setFoot(false); step(g, 60);
        check('then stops again', R.level === 0);
      } finally {
        R.el.pause();
        R.base = keep.base; R.tracks = keep.tracks; R.mode = keep.mode; R.foot = keep.foot; R.muted = keep.muted; R.pauseWhenHidden = keep.hidden;
        R.volume = keep.vol;
        if (R.tracks.length) R.select(Math.max(0, keep.cur), false);
        else { R.cur = -1; R.el.removeAttribute('src'); R.el.load(); }
        R.userPaused = keep.paused;
        for (const u of urls) URL.revokeObjectURL(u);
        try { if (saved === null) localStorage.removeItem('gz.radio'); else localStorage.setItem('gz.radio', saved); } catch { /* private window */ }
        parkBikeHome(g);
      }
      return { pass: ok.every(Boolean), detail: out.join(', ') };
    },
  },
  {
    id: 'VOI-01', title: '路人语音只在身边播：11 m 外不出声；街上同时只有一个声音（贴身的人可插话）；对话在说时旁人只冒气泡',
    run: (g) => {
      home(g);
      type A = { root: THREE.Object3D; bubble: HTMLElement | null };
      const G = g as unknown as {
        voice: { silence(): void; say(who: string, text: string, variant?: string): number; find(who: string, text: string, v?: string): [string, number] | null; streetLine: string | null };
        actors: { spawn(o: { name: string; look: { female: boolean; seed: number }; pos: Vec3; yaw: number; pose: string; tag: string }): A; say(a: A, text: string, s?: number): void; despawn(a: A): void };
      };
      const Vo = G.voice, Ac = G.actors;
      const L = ['准时达的，等一下！', '38 号好了——不是你的。', '饭焦！饭焦要时间！', '下一单！下一单！'];
      const id = (t: string) => Vo.find('staff', t, 'm')?.[0] ?? '?';
      const p = g.characters[g.active].root.position;
      const at = (dx: number) => Ac.spawn({ name: '店员', look: { female: false, seed: 7 }, pos: p.clone().add(V(dx, 0, 0)), yaw: 0, pose: 'stand', tag: 'staff' });
      const far = at(14), mid = at(7), mid2 = at(-7.5), near = at(1.5);
      const out: string[] = [];
      try {
        Vo.silence();
        Ac.say(far, L[0]);
        const farQuiet = Vo.streetLine === null && !!far.bubble?.textContent;
        Ac.say(mid, L[1]);
        const midOn = Vo.streetLine === id(L[1]);
        Ac.say(mid2, L[2]);
        const oneAtATime = Vo.streetLine === id(L[1]);
        Ac.say(near, L[3]);
        const cutIn = Vo.streetLine === id(L[3]);
        Vo.silence();
        Vo.say('staff', L[0], 'm');
        Ac.say(near, L[2]);
        const yields = Vo.streetLine === null && !!near.bubble?.textContent;
        out.push(`14 m silent ${farQuiet}`, `7 m speaks ${midOn}`, `second 7 m waits ${oneAtATime}`, `1.5 m cuts in ${cutIn}`, `quiet under a conversation ${yields}`);
        return { pass: farQuiet && midOn && oneAtATime && cutIn && yields, detail: out.join(', ') };
      } finally {
        Vo.silence();
        for (const a of [far, mid, mid2, near]) Ac.despawn(a);
      }
    },
  },
  {
    id: 'REN-01', title: '瞬移后近景立面构件生成',
    run: (g) => {
      home(g);
      // a fixed street among towers (north end of 猎德大桥), not wherever the current cast happens to spawn
      g.facades.sync(fromBlender(905, -395, 1.7));
      return { pass: g.facades.near.length > 0 && g.facades.instances > 100, detail: `${g.facades.near.length} buildings near, ${g.facades.instances} detail instances` };
    },
  },
  {
    id: 'REN-02', title: '夜里底商的光照亮门前地面（城中村巷子：开灯比关灯地面亮 ≥ 30%）',
    run: (g) => {
      // 冼村-side alley between two urban-village blocks, looking along it; lower third of the frame is paving
      const hour = g.env.hour, k = SHOP_U.uShopK.value;
      g.env.setHour(21.5);
      g.camera.position.copy(fromBlender(-523.0, -2216.6, 1.7));
      g.camera.lookAt(fromBlender(-545, -2221, 1.0));
      g.camera.updateMatrixWorld();
      g.facades.sync(g.camera.position);
      const c = document.createElement('canvas'); c.width = 64; c.height = 36;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      const lum = (on: number) => {
        SHOP_U.uShopK.value = on;
        g.render();
        ctx.drawImage(g.canvas, 0, 0, 64, 36);
        const px = ctx.getImageData(0, 24, 64, 12).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        return sum / (px.length / 4);
      };
      const off = lum(0), on = lum(k || 2.5);
      SHOP_U.uShopK.value = k;
      g.env.setHour(hour);
      return { pass: on > off * 1.3 && on > 20, detail: `ground luminance ${off.toFixed(1)} -> ${on.toFixed(1)} (x${(on / Math.max(off, 1e-3)).toFixed(2)})` };
    },
  },
  // ------------------------------------------------------------------ 花城广场 / 花城汇
  {
    id: 'HC-01', title: '花城汇下沉广场：从街面往下看，第一眼看到的是坑底石材（江面水平面开了洞、OSM 台阶不再浮在半空）',
    run: (g) => {
      const G = g as unknown as { city: { root: THREE.Object3D }; huacheng: { court: { rect: number[]; z: number } } | null };
      if (!G.huacheng) return { pass: false, detail: 'no huacheng.json' };
      const [x0, y0, x1, y1] = G.huacheng.court.rect, cz = G.huacheng.court.z;
      const rc = new THREE.Raycaster(), down = V(0, -1, 0);
      let bad = 0, n = 0;
      const ex: string[] = [];
      for (let x = x0 + 1.5; x < x1 - 1; x += 3) {
        for (let y = 50; y < y1 - 2; y += 4) {
          rc.set(fromBlender(x, y, 4), down); rc.far = 20;
          const hit = rc.intersectObject(G.city.root, true).find((h) => (h.object as THREE.Mesh).visible !== false);
          n++;
          // the court's own furniture (umbrellas, benches) may come first; water, roads or the street slab may not
          const stray = !hit || (/^(Water|Roads|Ground|Green)/.test(hit.object.name) && Math.abs(hit.point.y - cz) > 0.25);
          if (stray) {
            bad++;
            if (ex.length < 4) ex.push(`(${x.toFixed(0)},${y}) ${hit ? hit.object.name + ' @ ' + hit.point.y.toFixed(2) : 'nothing'}`);
          }
        }
      }
      return { pass: bad === 0 && n > 50, detail: `${n} rays over the court floor (y 50..${y1}), ${bad} hit something else ${ex.join('; ')}${y0 ? '' : ''}` };
    },
  },
  {
    id: 'HC-02', title: 'APM 车站出入口是露天扶梯井（玻璃栏杆 + 红色图腾柱），不再是通用红柱蓝顶亭子；其他线路照旧是亭子',
    run: (g) => {
      const G = g as unknown as { furniture: { places: { proto: string; x: number; y: number }[] }; metro: { apm: Set<string>; exits: { id: string; kind: string; x: number; y: number }[] } };
      const apm = G.metro.exits.filter((e) => e.kind === 'pavilion' && G.metro.apm.has(e.id));
      const others = G.metro.exits.filter((e) => e.kind === 'pavilion' && !G.metro.apm.has(e.id));
      const at = (e: { x: number; y: number }, proto: string) => G.furniture.places.some((p) => p.proto === proto && Math.hypot(p.x - e.x, p.y - e.y) < 0.1);
      const openOk = apm.filter((e) => at(e, 'metro_exit_open') && !at(e, 'metro_exit')).length;
      const pavOk = others.filter((e) => at(e, 'metro_exit') && !at(e, 'metro_exit_open')).length;
      return { pass: apm.length >= 8 && openOk === apm.length && pavOk === others.length,
        detail: `APM entrances open wells ${openOk}/${apm.length}; other lines' pavilions ${pavOk}/${others.length}` };
    },
  },
  {
    id: 'HC-03', title: '花城广场有人：傍晚 ≥ 120 人（聊天的、拍照的、坐长椅的），站着的都踩在地面上、不站进树和灯杆；晚上 8 点半下沉广场有 21 人跳广场舞',
    run: (g) => {
      const G = g as unknown as { plaza: { fillNow(h: number): void; stats(): { filled: Record<string, number>; people: [number, number, number, string, string, boolean][] } } | null;
        props: { nearest(x: number, z: number, r: number): unknown } };
      if (!G.plaza) return { pass: false, detail: 'no plaza life' };
      const hour = g.env.hour;
      G.plaza.fillNow(17.5);
      const day = G.plaza.stats();
      let off = 0, inProp = 0;
      const ex: string[] = [];
      for (const [x, y, z, kind] of day.people) {
        if (kind === 'seat') continue;
        const gy = g.collision.groundHeight(fromBlender(x, y, z + 1.5), 3);     // from just above them: 花城汇 B1 is under the street
        if (gy === null || Math.abs(gy - z) > 0.3) { off++; if (ex.length < 3) ex.push(`${kind} (${x},${y}) z ${z} ground ${gy?.toFixed(2)}`); }
        if (G.props.nearest(x, -y, 0.35)) inProp++;
      }
      G.plaza.fillNow(20.5);
      const night = G.plaza.stats();
      const dancers = night.people.filter((p) => p[3] === 'dance');
      G.plaza.fillNow(hour);
      const n = day.people.length;
      return { pass: n >= 120 && (day.filled.seat ?? 0) >= 15 && (day.filled.photo ?? 0) >= 10 && off === 0 && inProp === 0 && dancers.length === 21 && dancers.every((p) => p[2] < -5),
        detail: `17:30 ${n} people ${JSON.stringify(day.filled)}, ${off} off the ground, ${inProp} in a prop ${ex.join('; ')}; 20:30 ${dancers.length} dancing` };
    },
  },
  {
    id: 'HC-05', title: '花城汇 B1 走得通：下沉广场北门 → 门厅 → APM 花城大道站站厅（停在闸机前）；西侧连廊 → 中区长廊；长廊北端扶梯 ↔ 花城广场北；长廊东侧门 → 站厅；人在坑底不会被当成掉进珠江捞走',
    run: (g) => {
      onFoot(g);
      const ch = g.characters[g.active];
      const G = g as unknown as { rig: { yaw: number; pitch: number; snap(p: Vec3, h: number): void } };
      const walk = (x: number, y: number, z: number, heading: number, frames: number) => {
        ch.placeAt(fromBlender(x, y, z + 0.3), heading);
        G.rig.snap(ch.root.position, heading);
        G.rig.yaw = heading + Math.PI; G.rig.pitch = -0.1;
        g.input.setKey('KeyW', true);
        step(g, frames);
        g.input.setKey('KeyW', false);
        step(g, 3);
        const p = ch.root.position;
        return [p.x, -p.z, p.y];
      };
      const res: string[] = [];
      let ok = true;
      const check = (name: string, p: number[], test: (x: number, y: number, z: number) => boolean) => {
        const pass = test(p[0], p[1], p[2]);
        ok &&= pass;
        res.push(`${name} ${pass ? 'ok' : 'FAIL'} (${p.map((v) => v.toFixed(1)).join(', ')})`);
      };
      check('portal->gates', walk(-6, 80, -5.85, Math.PI, 420), (_x, y, z) => y > 100 && y < 108 && Math.abs(z + 5.85) < 0.2);
      check('link->corridor', walk(-15, 85, -5.85, -Math.PI / 2, 420), (x, _y, z) => x < -33 && Math.abs(z + 5.85) < 0.2);
      check('escalator up', walk(-32.7, 142, -5.85, Math.PI, 720), (_x, y, z) => y > 166 && z > 0);
      check('escalator down', walk(-32.7, 168, 0.15, 0, 600), (_x, y, z) => y < 146 && Math.abs(z + 5.85) < 0.2);
      check('cross door', walk(-29, 139, -5.85, Math.PI / 2, 420), (x, _y, z) => x > -12 && Math.abs(z + 5.85) < 0.2);
      // standing in the court for 3 s: still there (the river check used to fish people out of it)
      const p = walk(-10, 60, -5.85, Math.PI, 1);
      step(g, 180);
      check('court stays', [ch.root.position.x, -ch.root.position.z, ch.root.position.y], (x, y, z) => Math.hypot(x - p[0], y - p[1]) < 1 && z < -5);
      home(g);
      return { pass: ok, detail: res.join('; ') };
    },
  },
  {
    id: 'HC-06', title: '花城广场北段：从南沿走台阶下到花城汇北区下沉广场；音乐喷泉开演后中轴高喷 ≥ 25 m、不在场次时水面平静；两侧榕树林成片（≥ 600 棵）；晚上 8 点半喷泉边有观众',
    run: (g) => {
      onFoot(g);
      const G = g as unknown as { rig: { yaw: number; pitch: number; snap(p: Vec3, h: number): void };
        fountain: { force(s: number): void; update(dt: number, h: number, n: number, c: Vec3): void; stats(): { running: boolean; tallest: number; mean: number } } | null;
        city: { treePos: number[][] };
        plaza: { fillNow(h: number): void; stats(): { filled: Record<string, number> } } | null; camera: THREE.Camera };
      const ch = g.characters[g.active];
      const res: string[] = [];
      let ok = true;
      // down the stair into the north court
      ch.placeAt(fromBlender(-3, 194, 0.45), Math.PI);
      G.rig.snap(ch.root.position, Math.PI);
      G.rig.yaw = 0; G.rig.pitch = -0.1;
      g.input.setKey('KeyW', true); step(g, 900); g.input.setKey('KeyW', false); step(g, 3);
      const p = ch.root.position;
      const down = -p.z > 224 && p.y < -5.6;
      ok &&= down; res.push(`stair ${down ? 'ok' : 'FAIL'} (${p.x.toFixed(1)}, ${(-p.z).toFixed(1)}, ${p.y.toFixed(2)})`);
      home(g);
      // the fountain: quiet out of hours, tall in a show
      if (!G.fountain) return { pass: false, detail: 'no fountain' };
      const cam = G.camera.position;
      G.fountain.force(0);
      for (let i = 0; i < 300; i++) G.fountain.update(1 / 30, 9.0, 0, cam);
      const idle = G.fountain.stats();
      G.fountain.force(30);
      for (let i = 0; i < 300; i++) G.fountain.update(1 / 30, 9.0, 0, cam);
      const show = G.fountain.stats();
      G.fountain.force(0);
      const fok = !idle.running && idle.mean < 0.05 && show.running && show.tallest >= 25;
      ok &&= fok; res.push(`fountain idle mean ${idle.mean.toFixed(2)} m, in a show tallest ${show.tallest.toFixed(1)} m ${fok ? 'ok' : 'FAIL'}`);
      // the woods
      const nw = G.city.treePos.filter(([x, y]) => x > -70 && x < 66 && y > 176 && y < 430).length;
      ok &&= nw >= 600; res.push(`woods ${nw} trees`);
      // the evening crowd at the rim
      if (G.plaza) {
        G.plaza.fillNow(20.5);
        const f = G.plaza.stats().filled.fountain ?? 0;
        G.plaza.fillNow(g.env.hour);
        ok &&= f >= 25; res.push(`20:30 fountain crowd ${f}`);
      }
      return { pass: ok, detail: res.join('; ') };
    },
  },
  {
    id: 'HC-04', title: '骑电鸡 / 开车冲向广场上的人：他们会跳开（离车的路线 ≥ 1.2 m），不会被穿过',
    run: (g) => {
      const G = g as unknown as { plaza: { fillNow(h: number): void; update(dt: number, cam: THREE.Camera, f: unknown, h: number, a: boolean): void; stats(): { people: [number, number, number, string, string, boolean][] } } | null; camera: THREE.Camera };
      if (!G.plaza) return { pass: false, detail: 'no plaza life' };
      G.plaza.fillNow(15);
      const target = G.plaza.stats().people.find((p) => p[3] === 'group');
      if (!target) return { pass: false, detail: 'nobody standing' };
      const [tx, ty, tz] = target;
      // a rider 6 m north of them heading straight at them at 8 m/s
      const f = { pos: fromBlender(tx, ty + 6, tz), vel: V(0, 0, 8), driving: true, onSidewalk: true, sprinting: false, crash: null };
      for (let i = 0; i < 40; i++) {
        f.pos.addScaledVector(f.vel, 1 / 60);
        G.plaza.update(1 / 60, G.camera, f, 15, true);
      }
      // whoever stood within 1 m of the line the rider took is now clear of it
      const left = G.plaza.stats().people.filter((p) => p[3] === 'group' && Math.abs(p[1] - ty) < 3 && Math.abs(p[0] - tx) < 1.2);
      const me = G.plaza.stats().people.find((p) => p[3] === 'group' && Math.abs(p[1] - ty) < 3 && Math.abs(p[0] - tx) >= 1.2 && Math.abs(p[0] - tx) < 4);
      G.plaza.fillNow(g.env.hour);
      return { pass: !!me && left.length === 0, detail: `${me ? `jumped to x ${me[0]} (line at x ${tx.toFixed(2)})` : 'nobody jumped'}; ${left.length} still within 1.2 m of the line` };
    },
  },
];

export async function runQA(game: unknown, filter = ''): Promise<Result[]> {
  const g = game as QAGame;
  const out: Result[] = [];
  const rain = g.weather.rain;
  g.weather.set(0);
  // input is ignored until the start screen is dismissed
  if (!g.playing) (window as unknown as { __THREE_GAME_TEST_HOOKS__: { setState(s: string): void } }).__THREE_GAME_TEST_HOOKS__.setState('active-play');
  const og = g as unknown as { orders: { enabled: boolean; cancel(): void } };
  for (const t of TESTS) {
    if (filter && !t.id.startsWith(filter)) continue;
    og.orders.enabled = t.id.startsWith('ORD');
    if (!og.orders.enabled) og.orders.cancel();
    const t0 = performance.now();
    let r: { pass: boolean; detail: string };
    try { r = await t.run(g); } catch (e) { r = { pass: false, detail: 'error: ' + (e instanceof Error ? e.message : String(e)) }; }
    out.push({ id: t.id, title: t.title, pass: r.pass, info: t.info, detail: r.detail, ms: Math.round(performance.now() - t0) });
    await new Promise((res) => setTimeout(res, 0));
  }
  og.orders.enabled = true;
  home(g);
  g.weather.set(rain);
  g.pedestrians.regather();
  return out;
}

export function listQA(): { id: string; title: string }[] {
  return TESTS.map((t) => ({ id: t.id, title: t.title }));
}
