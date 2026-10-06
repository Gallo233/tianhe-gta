import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VehicleInstances, attachFarLod, vehicleGroup, vehicleTemplate, type VehicleTemplate } from '../entities/VehicleModel';
import type { CarChoice, CarObservation } from '../ai/brainProtocol';
import { crashSeen, seePlayer, type PlayerFacts } from '../ai/facts';
import type { NpcBrain } from '../ai/NpcBrain';
import type { HeadlightPools } from '../world/CarLights';
import { RoadNet, type Conn, type Lane, type LaneOccupant, type Path, type RoadGraph } from '../world/RoadNet';

/**
 * Traffic on the Tianhe OSM network (world/RoadNet): lanes, Bézier turns, two-phase signals at arterial
 * junctions, yield-on-occupancy elsewhere, IDM car-following. On top of that the COSTA BRAVA behaviour:
 * obstacle reflexes (player, parked cars, pedestrians on the road), Jev decisions (cruise / slow / stop /
 * honk / speed up / overtake), overtaking by a lateral offset, instanced models with a far LOD.
 *
 * The map is 3.8 km across, so cars are kept where the player is: a car that reaches a dead end (the map
 * edge), drifts more than RECYCLE_M from the viewer, or stays wedged for two minutes out of sight re-enters on an
 * empty lane 200-800 m away.
 */
const FAR_LOD_M = 35;
const DRAW_M = 450;
const RECYCLE_M = 900;
const CAR_LEN = 4.6;
const PAINTS = ['#f2f2ee', '#c9ccce', '#1c1f24', '#233a5c', '#b3272d', '#2f8f89', '#d8c7a4', '#6d7378', '#9fd3c7', '#e8a3b5', '#f2c14e', '#5a6e3a'];
const TURN_WEIGHT = { straight: 0.55, right: 0.25, left: 0.2 };
const MAJOR_HW = new Set(['motorway', 'trunk', 'primary', 'secondary']);

export type ObstacleKind = 'player' | 'parked' | 'ped';
export interface Obstacle { pos: THREE.Vector3; kind: ObstacleKind; moving?: boolean }
export type Horn = (pos: THREE.Vector3) => void;

interface Car extends LaneOccupant {
  n: number;
  id: string;
  obj: THREE.Object3D;       // transform only: drawn by VehicleInstances
  model: number;
  paint: THREE.Color;
  roll: number;
  half: THREE.Vector2;
  speed: number;
  cruise: number;            // preference factor x lane speed
  lane: Lane;
  conn: Conn | null;         // inside a junction on this connector
  next: Conn | null;
  s: number;
  steer: number;
  fwd: THREE.Vector3;
  offset: number;            // lateral offset toward the left while overtaking
  blocked: number;
  waiting: number;
  ahead: CarObservation['ahead'];
  oncomingClear: boolean;
  signal: CarObservation['signal'];
  hitAt: number;
  /** seconds left standing after a crash (hard stop, then waits) */
  crashT: number;
  hornSeq: number;
}

const tmpP = new THREE.Vector3();
const tmpT = new THREE.Vector3();

export class Traffic {
  readonly group = new THREE.Group();
  readonly roads: RoadNet;
  readonly cars: Car[] = [];
  private readonly temps: VehicleTemplate[];
  private readonly inst: VehicleInstances;
  private readonly local = new THREE.Vector3();
  private readonly left = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  private hornAt = 0;
  private recycled = 0;
  /** Camera position: LOD switch, draw distance, where cars are kept (Game sets it). */
  viewer: THREE.Vector3 | null = null;
  /** Night headlight cards for the cars near the camera. */
  pools: HeadlightPools | null = null;
  /** The camera: respawns happen outside its view (or far enough that nobody sees a car appear). */
  camera: THREE.Camera | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  /** Recent respawn positions (QA checks that cars never pop into view). */
  readonly respawnLog: THREE.Vector3[] = [];

  /** `mix`: share of each model in the traffic; `arterial`: models kept to arterial roads (buses). */
  constructor(graph: RoadGraph, models: GLTF[], count: number, private readonly rng: () => number,
              private readonly horn: Horn = () => {}, lods: GLTF[] = [], mix: number[] = [], private readonly arterial: boolean[] = []) {
    this.group.name = 'traffic';
    this.roads = new RoadNet(graph);
    const temps = models.map(vehicleTemplate);
    temps.forEach((t, i) => { if (lods[i]) attachFarLod(t, lods[i]); });
    this.temps = temps;
    const w = temps.map((_, i) => mix[i] ?? 1);
    const wsum = w.reduce((a, b) => a + b, 0);
    const modelOf: number[] = [];
    for (let k = 0; k < count; k++) {
      let r = rng() * wsum, m = 0;
      while (m < w.length - 1 && r > w[m]) { r -= w[m]; m++; }
      modelOf.push(m);
    }
    this.inst = new VehicleInstances(temps, temps.map((_, m) => modelOf.filter((x) => x === m).length + 2));
    this.group.add(this.inst.group);
    const ok = this.roads.lanes.filter((l) => l.path.length > 25 && l.out.length);
    const okMajor = ok.filter((l) => MAJOR_HW.has(l.hw));
    for (let k = 0, tries = 0; k < count && tries < count * 30; tries++) {
      const model = modelOf[k];
      const pool = this.arterial[model] ? okMajor : ok;
      const lane = pool[Math.floor(rng() * pool.length)];
      const s = 4 + rng() * (lane.path.length - 10);
      if (lane.cars.some((c) => Math.abs(c.s - s) < 14 + (temps[model].half.y - 2.3) * 2)) continue;
      const t = temps[model];
      const obj = new THREE.Object3D();
      obj.userData.localBox = t.localBox;
      const car: Car = {
        n: k, id: `C${k}`, obj, model, paint: t.livery ? new THREE.Color(1, 1, 1) : rng() < 0.3 ? t.paint.clone() : new THREE.Color(PAINTS[Math.floor(rng() * PAINTS.length)]),
        roll: 0, half: t.half.clone(), speed: lane.speed * 0.7, cruise: 0.85 + rng() * 0.25, lane, conn: null, next: null, s,
        steer: 0, fwd: new THREE.Vector3(), offset: 0, blocked: 0, waiting: 0, ahead: null, oncomingClear: true, signal: null,
        hitAt: -1e9, crashT: 0, hornSeq: 0,
      };
      lane.cars.push(car);
      this.cars.push(car);
      this.pose(car);
      k++;
    }
    for (const l of this.roads.lanes) l.cars.sort((a, b) => a.s - b.s);
  }

  private path(c: Car): Path { return c.conn ? c.conn.path : c.lane.path; }

  private pose(c: Car): void {
    this.path(c).at(c.s, tmpP, tmpT);
    c.fwd.copy(tmpT);
    this.left.set(tmpT.z, 0, -tmpT.x);
    c.obj.position.copy(tmpP).addScaledVector(this.left, c.conn ? 0 : c.offset);
    // model forward is -Z; yaw, then pitch with bridge ramps (nose up = positive rotation about X)
    c.obj.rotation.order = 'YXZ';
    c.obj.rotation.set(Math.asin(THREE.MathUtils.clamp(tmpT.y, -0.3, 0.3)), Math.atan2(-tmpT.x, -tmpT.z), 0);
  }

  private chooseNext(l: Lane, c?: Car): Conn | null {
    if (!l.out.length) return null;
    // buses keep to the arterials whenever the junction offers one
    const outs = c && this.arterial[c.model] && l.out.some((o) => MAJOR_HW.has(o.to.hw)) ? l.out.filter((o) => MAJOR_HW.has(o.to.hw)) : l.out;
    const w = outs.map((o) => TURN_WEIGHT[o.kind]);
    let r = this.rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < outs.length; i++) { r -= w[i]; if (r <= 0) return outs[i]; }
    return outs[outs.length - 1];
  }

  /** May car `c`, `d` metres from its stop line, enter the junction now? */
  private mayEnter(c: Car, d: number): boolean {
    const node = c.lane.to;
    const conn = c.next;
    if (!conn) return true;
    // don't block the box: the exit lane needs room for us
    const last = conn.to.cars[0];
    const room = !last || last.s > (last as Car).half.y + c.half.y + 3;
    if (node.signal && !c.lane.inner) {
      const l = this.roads.light(node, c.lane.group);
      c.signal = l === 'green' ? 'green' : 'red';
      if (l === 'red') return false;
      if (l === 'amber' && d > (c.speed * c.speed) / (2 * 5) + 0.5) return false;
      return room;
    }
    if (node.deg >= 3 && !c.lane.inner && !node.signal) {
      c.signal = 'stop_sign';
      for (const [n, g] of node.inside) if (n !== c.n && g !== c.lane.group) return false;
    }
    return room;
  }

  /** Put a car back on a lane 150-500 m from the viewer (anywhere if there is no viewer yet). */
  private respawn(c: Car): boolean {
    this.recycled++;
    const v = this.viewer;
    for (let t = 0; t < 60; t++) {
      const lane = this.roads.lanes[Math.floor(this.rng() * this.roads.lanes.length)];
      if (lane.path.length < 30 || !lane.out.length) continue;
      if (this.arterial[c.model] && !MAJOR_HW.has(lane.hw)) continue;
      const start = lane.path.pts[0];
      if (v && t < 50) {
        const d = start.distanceTo(v);
        if (d < 200 || d > 800) continue;
        // out of sight: behind the camera or off to the side (a car-length of margin), or past 450 m
        if (this.camera && d < 450 && this.frustum.intersectsSphere(this.sphere.set(start, 6))) continue;
      }
      if (lane.cars.length && (lane.cars[0].s < 30 || lane.cars.length > 2)) continue;
      if (c.conn) { c.conn.node.inside.delete(c.n); remove(c.conn.cars, c); } else remove(c.lane.cars, c);
      c.lane = lane; c.conn = null; c.next = null; c.s = 0; c.offset = 0; c.speed = lane.speed * 0.6; c.waiting = 0;
      lane.cars.unshift(c);
      this.respawnLog.push(start.clone());                         // QA: where cars (re)appear
      if (this.respawnLog.length > 400) this.respawnLog.shift();
      return true;
    }
    return false;
  }

  observe(f: PlayerFacts, max: number): CarObservation[] {
    const now = performance.now() / 1000;
    return this.cars
      .map((c) => ({ c, d: c.obj.position.distanceTo(f.pos) }))
      .filter((x) => x.d < 60)
      .sort((a, b) => a.d - b.d)
      .slice(0, max)
      .map(({ c }) => {
        const player = seePlayer(c.obj.position, f, 45, c.fwd);
        const ago = now - c.hitAt;
        return {
          id: c.id, kind: 'car', speedKmh: c.speed * 3.6, ahead: c.ahead, blockedS: c.blocked, oncomingClear: c.oncomingClear,
          signal: c.signal, player, hitByPlayerAgoS: ago < 10 ? ago : null, crash: crashSeen(c.obj.position, f, now),
        };
      });
  }

  update(dt: number, obstacles: Obstacle[], f: PlayerFacts, brain: NpcBrain | null): void {
    const now = performance.now() / 1000;
    if (this.camera) {
      this.camera.updateMatrixWorld();
      this.frustum.setFromProjectionMatrix(this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    }
    this.roads.tick(dt);
    this.inst.begin();
    for (const c of this.cars) {
      const pos = c.obj.position;
      const fwd = c.fwd;
      const left = this.left.set(fwd.z, 0, -fwd.x);
      const off = c.conn ? 0 : c.offset;
      const near = !this.viewer || pos.distanceTo(this.viewer) < 250;
      let limit = Infinity, blockedBy = false, clearAhead = true;
      let ahead: CarObservation['ahead'] = null;
      // --- obstacles in the lane (only matters where the player can be)
      const laneHalf = c.conn ? 1.6 : c.lane.width / 2;
      if (near) for (const o of obstacles) {
        // someone on foot on the pavement is not in anybody's lane
        if (o.kind === 'player' && !f.driving && f.onSidewalk) continue;
        const to = this.local.copy(o.pos).sub(pos);
        if (Math.abs(to.y) > 3 || to.lengthSq() > 900) continue;
        const along = to.dot(fwd), lat = to.dot(left);
        const reach = laneHalf + (o.kind === 'player' && f.driving ? 0.95 : o.kind === 'parked' ? 0.6 : 0.35);
        if (along > -7 && along < 14 && Math.abs(lat) < 2.6) clearAhead = false;
        if (along > 0 && along < 30 && Math.abs(lat - off) < reach) {
          if (along < 11) { limit = Math.min(limit, Math.max(0, (along - 4.5) * 1.5)); blockedBy = true; }
          if (!ahead || along < ahead.dist) {
            const what = o.kind === 'parked' ? 'parked_car' : o.kind === 'ped' ? 'player_foot' : f.driving ? 'player_car' : 'player_foot';
            ahead = { what, dist: along, moving: o.kind === 'player' ? Math.hypot(f.vel.x, f.vel.z) > 1 : Boolean(o.moving) };
          }
        }
      }
      // --- leader: next car on my path, else the first car on where I go next
      const path = this.path(c);
      const list = (c.conn ? c.conn.cars : c.lane.cars) as Car[];
      const rest = path.length - c.s;
      let gap = Infinity, dv = 0;
      const k = list.indexOf(c);
      if (k >= 0 && k < list.length - 1) { const lead = list[k + 1]; gap = lead.s - c.s - lead.half.y - c.half.y - 0.2; dv = c.speed - lead.speed; }
      else {
        const nextList = (c.conn ? c.conn.to.cars : c.next ? c.next.cars : null) as Car[] | null;
        const lead = nextList && nextList.length ? nextList[0] : null;
        if (lead) { gap = rest + lead.s - lead.half.y - c.half.y - 0.2; dv = c.speed - lead.speed; }
      }
      c.oncomingClear = true;
      // --- stop line
      c.signal = null;
      if (!c.conn) {
        if (!c.next && !c.lane.to.exit) c.next = this.chooseNext(c.lane, c);
        if (rest < 40 && c.next && !this.mayEnter(c, rest)) {
          gap = Math.min(gap, Math.max(0.1, rest - 0.6)); dv = c.speed;
          if (rest < 1.6 && c.speed < 0.4) c.waiting += dt;
        }
      }
      c.ahead = ahead ?? (gap < 30 ? { what: 'car', dist: gap + CAR_LEN, moving: dv < c.speed - 0.5 } : null);
      c.blocked = blockedBy && c.speed < 0.5 ? c.blocked + dt : Math.max(0, c.blocked - dt * 0.5);

      // --- deliberate behaviour within the reflex limits
      const dec = near && brain ? brain.get(c.id) : null;
      let v0 = c.lane.speed * c.cruise * (c.conn ? 0.55 : 1);
      let want: number;
      const canPass = !c.conn && (c.oncomingClear || c.offset > 1.5);
      if (dec) {
        const choice = dec.choice as CarChoice;
        switch (choice) {
          case 'cruise': break;
          case 'slow': v0 *= 0.45; break;
          case 'stop': v0 = 0; break;
          case 'honk': v0 *= 0.4; break;
          case 'speed_up': v0 *= 1.45; break;
          case 'overtake': v0 = canPass ? v0 * 0.8 : 0; break;
        }
        want = choice === 'overtake' && canPass && !clearAhead ? 3.4 : clearAhead ? 0 : c.offset;
        if (choice === 'honk' && dec.seq !== c.hornSeq && now - this.hornAt > 0.6) {
          c.hornSeq = dec.seq; this.hornAt = now;
          this.horn(pos);
        }
      } else {
        want = c.blocked > 2.5 && canPass ? 3.4 : clearAhead ? 0 : c.offset;
      }
      if (c.conn) want = 0;
      // after a crash: brake hard and stand for a while (the driver gets out of the shock)
      if (c.crashT > 0) { c.crashT -= dt; v0 = 0; limit = 0; want = c.offset; }
      c.offset += Math.sign(want - c.offset) * Math.min(Math.abs(want - c.offset), dt * 1.8);
      // IDM toward v0 with the gap, then the obstacle reflex cap
      const sStar = 2.5 + c.speed * 1.2 + (c.speed * dv) / (2 * Math.sqrt(1.8 * 3.0));
      let acc = 1.8 * (1 - Math.pow(c.speed / Math.max(v0, 0.1), 4) - (gap < Infinity ? Math.pow(Math.max(sStar, 0) / Math.max(gap, 0.1), 2) : 0));
      acc = Math.max(-8, Math.min(acc, 2.4));
      c.speed = Math.max(0, c.speed + acc * dt);
      if (c.speed > limit) c.speed = Math.max(limit, c.speed - 9 * dt);
      c.s += c.speed * dt;
      c.roll += c.speed * dt;
      if (c.speed > 0.3) c.waiting = 0;

      // --- path transitions
      if (c.s >= path.length) {
        if (c.conn) {
          const conn = c.conn;
          remove(conn.cars, c); conn.node.inside.delete(c.n);
          c.s -= path.length; c.lane = conn.to; c.conn = null; c.next = null;
          c.lane.cars.unshift(c);
        } else if (!c.next) {
          this.respawn(c);
        } else if (this.mayEnter(c, 0)) {
          remove(c.lane.cars, c);
          c.s -= path.length; c.conn = c.next; c.offset = 0;
          c.conn.cars.unshift(c);
          if (c.lane.to.deg >= 3) c.lane.to.inside.set(c.n, c.lane.group);
        } else {
          c.s = path.length; c.speed = 0;
        }
      }
      // out of the player's sight: far away, or wedged for two minutes (a gridlock the rules could not avoid)
      if (this.viewer && (pos.distanceTo(this.viewer) > RECYCLE_M || (c.waiting > 120 && pos.distanceTo(this.viewer) > 60))) this.respawn(c);
      this.pose(c);
      c.steer = c.conn ? (c.conn.kind === 'left' ? 0.38 : c.conn.kind === 'right' ? -0.38 : 0) : (want !== c.offset ? Math.sign(want - c.offset) * 0.1 : 0);
      const dView = this.viewer ? pos.distanceTo(this.viewer) : 0;
      if (dView < DRAW_M) this.inst.draw(c.model, c.obj, c.paint, c.roll, c.steer, dView > FAR_LOD_M);
      if (this.pools && dView < 200) this.pools.add(c.obj, c.half);
    }
    this.inst.end();
  }

  /** For a pedestrian about to step onto a road: nobody within `radius` driving toward `p`, nobody on it. */
  clearToCross(p: THREE.Vector3, radius = 26): boolean {
    for (const c of this.cars) {
      const to = this.local.copy(p).sub(c.obj.position);
      const d2 = to.lengthSq();
      if (d2 > radius * radius) continue;
      if (d2 < 36) return false;
      if (c.speed > 0.8 && to.dot(c.fwd) > 0) return false;
    }
    return true;
  }

  get bodies(): THREE.Object3D[] {
    return this.cars.map((c) => c.obj);
  }

  /** Traffic cars whose centre is within r of p (CarCollisions). */
  near(p: THREE.Vector3, r: number): Car[] {
    const out: Car[] = [];
    for (const c of this.cars) {
      const q = c.obj.position;
      if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 < r * r) out.push(c);
    }
    return out;
  }

  pushOut(p: THREE.Vector3, radius: number): boolean {
    let hit = false;
    for (const c of this.cars) {
      const d2 = (p.x - c.obj.position.x) ** 2 + (p.z - c.obj.position.z) ** 2;
      if (d2 > 36 || Math.abs(p.y - c.obj.position.y) > 2) continue;
      c.obj.updateMatrixWorld();
      this.inv.copy(c.obj.matrixWorld).invert();
      const l = this.local.copy(p).applyMatrix4(this.inv);
      const hx = c.half.x + radius, hz = c.half.y + radius;
      if (Math.abs(l.x) < hx && Math.abs(l.z) < hz) {
        const px = hx - Math.abs(l.x), pz = hz - Math.abs(l.z);
        if (px < pz) l.x = Math.sign(l.x || 1) * hx; else l.z = Math.sign(l.z || 1) * hz;
        p.copy(l.applyMatrix4(c.obj.matrixWorld));
        c.hitAt = performance.now() / 1000;
        hit = true;
      }
    }
    return hit;
  }

  template(i: number): VehicleTemplate {
    return this.temps[i % this.temps.length];
  }

  spawn(i: number): { obj: THREE.Group; half: THREE.Vector2 } {
    const t = this.temps[i % this.temps.length];
    return { obj: vehicleGroup(t), half: t.half.clone() };
  }

  takeNearest(p: THREE.Vector3, maxDist: number): { obj: THREE.Group; half: THREE.Vector2; speed: number } | null {
    let best = -1, bd = maxDist;
    this.cars.forEach((c, i) => {
      const d = Math.hypot(c.obj.position.x - p.x, c.obj.position.z - p.z) - c.half.x;
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return null;
    const [c] = this.cars.splice(best, 1);
    if (c.conn) { remove(c.conn.cars, c); c.conn.node.inside.delete(c.n); } else remove(c.lane.cars, c);
    const obj = vehicleGroup(this.temps[c.model], c.paint);
    obj.position.copy(c.obj.position); obj.rotation.set(0, c.obj.rotation.y, 0);
    return { obj, half: c.half, speed: c.speed };
  }

  nearestDistance(p: THREE.Vector3): number {
    let bd = Infinity;
    for (const c of this.cars) bd = Math.min(bd, Math.hypot(c.obj.position.x - p.x, c.obj.position.z - p.z) - c.half.x);
    return bd;
  }

  headOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const c = this.cars.find((x) => x.id === id);
    return c ? out.copy(c.obj.position).setY(c.obj.position.y + 2.6) : null;
  }

  stats(): { cars: number; stopped: number; stuck: number; recycled: number; lanes: number; signals: number } {
    return {
      cars: this.cars.length, stopped: this.cars.filter((c) => c.speed < 0.3).length,
      stuck: this.cars.filter((c) => c.waiting > 90).length, recycled: this.recycled,
      lanes: this.roads.lanes.length, signals: this.roads.nodes.filter((n) => n.signal).length,
    };
  }

  get count(): number {
    return this.cars.length;
  }
}

function remove<T>(a: T[], x: T): void { const i = a.indexOf(x); if (i >= 0) a.splice(i, 1); }
