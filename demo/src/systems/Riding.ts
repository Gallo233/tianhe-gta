import * as THREE from 'three';
import { PHYSICS } from '../config';
import type { Collision } from '../world/Collision';
import type { PropColliders } from '../world/PropColliders';
import { obbContact, type Body2D } from './CarCollisions';
import { WATER_Y } from './Driving';

/**
 * Two-wheeler physics for Ah Jie's e-scooter: arcade, but it has to feel like a light bike in heavy traffic.
 *
 *  - bicycle steering: yaw rate v / wheelbase * tan(steer); lots of lock when slow (turn round in the width of a
 *    pavement), little at speed. The bike leans into the turn by atan(v * yawRate / g) (capped at 35 degrees),
 *    on a quick spring, so it tips in and straightens up like a real one.
 *  - hub motor: strong from standstill, 45 km/h flat out; brakes (S) stop it in a few metres; Space is the rear
 *    brake -- the back steps out and the bike pivots, the courier's U-turn. Backwards is paddling with the feet.
 *  - ground from two probes under the tyres (front / rear): it pops up kerbs onto the pavement, pitches on ramps,
 *    flies off ledges; gravity and a critically damped spring like the cars.
 *  - walls: a capsule along the bike; posts, trees and furniture: its footprint box; cars (traffic, parked,
 *    police): oriented boxes. A hit harder than CRASH_SPEED (closing speed, m/s) throws the rider off:
 *    `crashed` is set and the bike falls on its side and slides to a stop (Game puts the rider in the air).
 *  - water: sinks, then is fished out onto the last safe spot (like the cars).
 */
export interface BikeInput { throttle: number; steer: number; brake: boolean }

export interface CarBody2D extends Body2D { speed: number; fwdX: number; fwdZ: number; y: number; top?: number; hit?: () => void }

const VMAX = 12.5;              // 45 km/h
const CLIMB = 0.3;              // a kerb (0.15) is nothing; a step of 0.3 m still is
const DROOP = 0.25;
const SPRING_W = 2 * Math.PI * 3.2;
export const CRASH_SPEED = 6.5; // 23 km/h into something solid

export class Bike {
  heading = 0;
  speed = 0;
  steer = 0;          // road-wheel angle (+ left)
  lean = 0;           // + leaning left (radians)
  leanV = 0;
  pitch = 0;
  vy = 0;
  vlat = 0;           // sideways slip (m/s, + right)
  yawRate = 0;
  airborne = false;
  airTime = 0;
  landing = 0;
  impact = 0;
  /** the hardest knock (closing speed, m/s) since Game last read it (it zeroes it): for the food in the box */
  knock = 0;
  inWater = false;
  waterT = 0;
  rescued = false;
  atEdge = false;
  lastSafe: { pos: THREE.Vector3; heading: number } | null = null;
  // lying on its side after a crash
  crashed = false;
  fallSide = 1;
  slide = new THREE.Vector3();
  /** what the crash hit and how hard (for the rider's throw and the HUD) */
  crash: { speed: number; dir: THREE.Vector3; at: number; car: boolean } | null = null;
  prev = new THREE.Vector3(Infinity, 0, 0);
  targetH = NaN;
  safeT = 0;
  accel = 0;
  braking = false;
  /** sliding sideways on the rear brake (the rear wheel is locked) */
  skidding = false;
  constructor(readonly obj: THREE.Object3D, readonly half: THREE.Vector2, readonly wheelbase: number) {}
  get forward(): THREE.Vector3 { return new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading)); }
  get right(): THREE.Vector3 { return new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading)); }
}

const probe = new THREE.Vector3();
const seg = new THREE.Line3();
const corr = new THREE.Vector3();

export class Riding {
  props: PropColliders | null = null;
  bounds: { x0: number; x1: number; z0: number; z1: number } | null = null;
  margin = 30;
  snapToRoad: ((p: THREE.Vector3) => { pos: THREE.Vector3; heading: number } | null) | null = null;
  /** below the river's surface but not in it (花城汇's court and B1, the stations): no sinking */
  dry: ((p: THREE.Vector3) => boolean) | null = null;
  /** cars near a point (three.js), as oriented boxes with their velocity */
  cars: ((p: THREE.Vector3, r: number) => CarBody2D[]) | null = null;
  time = 0;

  constructor(private readonly collision: Collision) {}

  update(b: Bike, input: BikeInput, dt: number): void {
    if (dt <= 0) return;
    b.rescued = false;
    const n = Math.max(1, Math.ceil(dt * 60 - 1e-3));
    for (let i = 0; i < n; i++) this.step(b, input, dt / n);
    this.pose(b);
  }

  private step(b: Bike, input: BikeInput, dt: number): void {
    this.time += dt;
    const p = b.obj.position;
    if (p.distanceToSquared(b.prev) > 64) { b.vy = 0; b.targetH = NaN; b.inWater = false; b.waterT = 0; }
    if (b.crashed) { this.fallen(b, dt); b.prev.copy(p); return; }
    const grounded = !b.airborne && !b.inWater;
    // --- longitudinal
    const v = b.speed;
    let a = 0;
    b.braking = false;
    if (grounded) {
      if (input.throttle > 0) a = v < -0.2 ? 9 : (5.2 * (1 - Math.max(0, v) / VMAX) + 0.4) * input.throttle;
      else if (input.throttle < 0) {
        if (v > 0.3) { a = -8.5 * -input.throttle; b.braking = true; }
        else a = (-1.3 - v) * 3;                                                    // paddle backwards
      } else a = -Math.sign(v) * Math.min(Math.abs(v) / dt, 0.9 + Math.abs(v) * 0.05);   // regen / rolling
      if (input.brake) { a += -Math.sign(v) * Math.min(Math.abs(v) / dt, 6); b.braking = true; }
      if (input.throttle !== 0 || Math.abs(v) > 0.5) a += PHYSICS.gravity * Math.sin(b.pitch) * 0.5;
    }
    if (b.inWater) a = -b.speed * 2;
    b.accel = a;
    b.speed = THREE.MathUtils.clamp(v + a * dt, -1.4, VMAX);
    // --- steering: lock falls off with speed; the rear brake pivots the bike (the back steps out)
    const sp = Math.abs(b.speed);
    const lock = THREE.MathUtils.lerp(0.75, 0.11, Math.min(1, sp / 11));
    const target = -input.steer * lock * (input.brake && sp > 2 ? 1.25 : 1);
    b.steer += (target - b.steer) * Math.min(1, dt * 9);
    // rear-brake skid: the locked back wheel lets go, the bike pivots faster than its path turns (the tail steps
    // out) and most of the pivot shows up as sideways slide, scrubbed off slowly
    const skid = input.brake && grounded && sp > 3;
    b.yawRate = (b.speed / b.wheelbase) * Math.tan(b.steer) * (grounded ? 1 : 0.15) * (skid ? 1.6 : 1);
    const dth = b.yawRate * dt;
    b.heading += dth;
    if (skid) b.vlat += b.speed * dth * 0.45;
    if (grounded) {
      b.vlat -= Math.sign(b.vlat) * Math.min(Math.abs(b.vlat), (skid ? 4.5 : 9) * dt);
      // the front tyre still grips: the slide never outruns the rolling speed by much
      const cap = Math.max(1.5, Math.abs(b.speed) * 0.75);
      b.vlat = THREE.MathUtils.clamp(b.vlat, -cap, cap);
    }
    b.skidding = skid && Math.abs(b.vlat) > 0.6;
    // --- move
    const f = b.forward, r = b.right;
    p.addScaledVector(f, b.speed * dt).addScaledVector(r, b.vlat * dt);
    // --- walls: a capsule along the bike, 0.28 m radius, from knee to shoulder height
    const reach = b.half.y - 0.3;
    seg.start.set(p.x - f.x * reach, p.y + 0.58, p.z - f.z * reach);
    seg.end.set(p.x + f.x * reach, p.y + 0.58, p.z + f.z * reach);
    this.collision.resolveCapsule(seg, 0.28, corr);
    corr.y = 0;
    if (corr.lengthSq() > 1e-8) {
      p.add(corr);
      const nrm = corr.normalize();
      this.hitSolid(b, -(f.x * nrm.x + f.z * nrm.z) * b.speed - (r.x * nrm.x + r.z * nrm.z) * b.vlat, nrm);
    }
    // --- posts, trees, furniture
    const hit = this.props?.resolveBox(p, 0.26, b.half.y - 0.1, b.heading, p.y + 0.15, p.y + 1.2) ?? null;
    if (hit) this.hitSolid(b, -(f.x * hit.nx + f.z * hit.nz) * b.speed, new THREE.Vector3(hit.nx, 0, hit.nz));
    // --- cars
    if (this.cars && !b.crashed) {
      const me: Body2D = { x: p.x, z: p.z, hx: b.half.x * 0.8, hz: b.half.y * 0.95, h: b.heading };
      for (const c of this.cars(p, 8)) {
        const k = obbContact(me, c);
        if (!k) continue;
        p.x += k.nx * k.depth; p.z += k.nz * k.depth;
        me.x = p.x; me.z = p.z;
        // closing speed along the normal: my velocity into the car minus the car's toward me
        const vx = f.x * b.speed + r.x * b.vlat, vz = f.z * b.speed + r.z * b.vlat;
        const close = -(vx * k.nx + vz * k.nz) + (c.fwdX * c.speed * k.nx + c.fwdZ * c.speed * k.nz);
        c.hit?.();
        this.hitSolid(b, close, new THREE.Vector3(k.nx, 0, k.nz), true);
        if (b.crashed) break;
      }
    }
    b.impact = Math.max(0, b.impact - dt * 20);
    this.edge(b, dt);
    this.ground(b, dt);
    this.water(b, dt);
    this.leanStep(b, dt);
    b.prev.copy(p);
  }

  /** Lean into turns: a quick, lightly damped spring toward atan(v * yawRate / g). */
  private leanStep(b: Bike, dt: number): void {
    if (b.crashed) return;
    const grounded = !b.airborne && !b.inWater;
    const want = grounded ? THREE.MathUtils.clamp(Math.atan((b.speed * b.yawRate) / 9.81), -0.6, 0.6) : b.lean * 0.98;
    b.leanV += ((want - b.lean) * 140 - b.leanV * 16) * dt;
    b.lean += b.leanV * dt;
  }

  /** Something solid with normal n (pointing at the bike) at closing speed `into` (m/s). */
  private hitSolid(b: Bike, into: number, n: THREE.Vector3, car = false): void {
    if (into <= 0.3) {
      // brushing past: lose the component into it
      const s = b.right.dot(n);
      if (b.vlat * s < 0) b.vlat -= b.vlat * s * s;
      return;
    }
    b.impact = Math.max(b.impact, into);
    if (into > CRASH_SPEED || (car && into > CRASH_SPEED * 0.7)) {   // a car: 16 km/h closing puts you down
      this.startCrash(b, into, n, car);
      return;
    }
    // a knock: slow down, bounce a little off the normal
    b.knock = Math.max(b.knock, into);
    b.speed *= into > 3 ? 0.35 : 0.7;
    b.vlat += b.right.dot(n) * into * 0.35;
  }

  private startCrash(b: Bike, into: number, n: THREE.Vector3, car: boolean): void {
    const vel = b.forward.multiplyScalar(b.speed).addScaledVector(b.right, b.vlat);
    b.crash = { speed: into, dir: vel.clone(), at: this.time, car };
    b.crashed = true;
    // the bike glances off: most of the speed along the obstacle survives, the part into it bounces a little
    const vn = vel.dot(n);
    b.slide.copy(vel).addScaledVector(n, -vn * 1.25);
    b.fallSide = b.lean !== 0 ? Math.sign(b.lean) : (b.right.dot(n) > 0 ? -1 : 1);
    b.speed = 0; b.vlat = 0; b.steer = 0;
  }

  /** On its side: fall over, slide, spin a little, stop. */
  private fallen(b: Bike, dt: number): void {
    const p = b.obj.position;
    const want = b.fallSide * 1.42;
    b.leanV += ((want - b.lean) * 90 - b.leanV * 8) * dt;
    b.lean += b.leanV * dt;
    if (Math.abs(b.lean) > 1.42) { b.lean = want; b.leanV *= -0.2; }
    const s = b.slide.length();
    if (s > 0) b.slide.multiplyScalar(Math.max(0, s - 5.5 * dt) / s);
    p.addScaledVector(b.slide, dt);
    b.heading += b.slide.length() * 0.12 * b.fallSide * dt;
    seg.start.set(p.x, p.y + 0.3, p.z); seg.end.set(p.x, p.y + 0.31, p.z);
    this.collision.resolveCapsule(seg, 0.5, corr);
    corr.y = 0;
    if (corr.lengthSq() > 1e-8) { p.add(corr); const nn = corr.normalize(); const vn = b.slide.dot(nn); if (vn < 0) b.slide.addScaledVector(nn, -vn * 1.3); }
    this.ground(b, dt);
    this.water(b, dt);
  }

  /** Hit while nobody rides it (a car ploughs into it): over it goes, sliding off with part of `vel`. */
  knockOver(b: Bike, vel: THREE.Vector3): void {
    if (b.crashed) return;
    b.crashed = true;
    b.crash = { speed: vel.length(), dir: vel.clone(), at: this.time, car: true };
    b.slide.copy(vel).setY(0).multiplyScalar(0.7);
    b.fallSide = b.right.dot(vel) > 0 ? -1 : 1;
    b.speed = 0; b.vlat = 0; b.steer = 0;
  }

  /** Stand it back up: still; `lift` leaves the lean for the spring to swing up (the rider pulling it upright). */
  rightUp(b: Bike, lift = false): void {
    b.crashed = false; b.crash = null; b.slide.set(0, 0, 0); b.speed = 0; b.vlat = 0;
    if (!lift) { b.lean = 0; b.leanV = 0; }
  }

  private edge(b: Bike, dt: number): void {
    b.atEdge = false;
    const bd = this.bounds;
    if (!bd) return;
    const p = b.obj.position, m = this.margin;
    let nx = 0, nz = 0;
    if (p.x > bd.x1 - m) nx = (p.x - (bd.x1 - m)) / m; else if (p.x < bd.x0 + m) nx = -((bd.x0 + m) - p.x) / m;
    if (p.z > bd.z1 - m) nz = (p.z - (bd.z1 - m)) / m; else if (p.z < bd.z0 + m) nz = -((bd.z0 + m) - p.z) / m;
    if (nx || nz) {
      const f = b.forward;
      if ((f.x * nx + f.z * nz) * Math.sign(b.speed || 1) > 0) {
        b.atEdge = true;
        b.speed -= Math.sign(b.speed) * Math.min(Math.abs(b.speed), (5 + 20 * Math.min(1, Math.hypot(nx, nz))) * dt);
      }
    }
    p.x = THREE.MathUtils.clamp(p.x, bd.x0 + 1.5, bd.x1 - 1.5);
    p.z = THREE.MathUtils.clamp(p.z, bd.z0 + 1.5, bd.z1 - 1.5);
  }

  /** Two tyre probes: height, pitch, air time, landings. */
  private ground(b: Bike, dt: number): void {
    const p = b.obj.position;
    const f = b.forward;
    const hw = b.wheelbase / 2;
    const yRest = p.y;
    const gF = this.collision.groundHeight(probe.set(p.x + f.x * hw, yRest + CLIMB + Math.max(0, Math.sin(b.pitch) * hw), p.z + f.z * hw), CLIMB + DROOP + 0.3);
    const gR = this.collision.groundHeight(probe.set(p.x - f.x * hw, yRest + CLIMB, p.z - f.z * hw), CLIMB + DROOP + 0.3);
    const okF = gF !== null && gF > yRest - DROOP - Math.sin(b.pitch) * hw;
    const okR = gR !== null && gR > yRest - DROOP;
    const wasAir = b.airborne;
    b.airborne = !okF && !okR;
    b.airTime = b.airborne ? b.airTime + dt : 0;
    if (!b.airborne) {
      const hF = okF ? gF! : (okR ? gR! : yRest), hR = okR ? gR! : hF;
      // on its side it rests on the bar end, the mirror and the box corner, not on the axle line
      const th = (hF + hR) / 2 + (b.crashed ? 0.19 * Math.sin(Math.abs(b.lean)) : 0);
      const tp = Math.atan2(hF - hR, b.wheelbase);
      const vt = Number.isNaN(b.targetH) ? 0 : THREE.MathUtils.clamp((th - b.targetH) / dt, -5, 5);
      b.targetH = th;
      const acc = Math.max(PHYSICS.gravity, SPRING_W * SPRING_W * (th - p.y) + 2 * SPRING_W * (vt - b.vy));
      b.vy += acc * dt;
      p.y += b.vy * dt;
      if (p.y < th - 0.08) {
        if (b.vy < 0) { b.landing = Math.max(b.landing, -b.vy); }
        p.y = th - 0.08; b.vy = Math.max(b.vy, vt);
      }
      b.pitch += THREE.MathUtils.clamp((tp - b.pitch) * Math.min(1, dt * 16), -2 * dt, 2 * dt);
      if (wasAir) b.landing = Math.max(b.landing, -b.vy);
    } else {
      b.targetH = NaN;
      b.vy += PHYSICS.gravity * dt;
      p.y += b.vy * dt;
      const want = Math.atan2(b.vy, Math.max(3, Math.abs(b.speed))) * 0.4;
      b.pitch += THREE.MathUtils.clamp(want - b.pitch, -0.8 * dt, 0.8 * dt);
    }
    const gc = this.collision.groundHeight(probe.set(p.x, p.y + CLIMB, p.z), 200);
    if (gc !== null && p.y < gc - 0.1 && b.prev.y >= gc - 0.1) { p.y = gc; b.vy = Math.max(0, b.vy); }
    b.safeT -= dt;
    if (b.safeT <= 0 && !b.airborne && !b.inWater && !b.crashed && p.y > WATER_Y + 1.5 && Math.abs(b.pitch) < 0.2) {
      b.safeT = 0.5;
      b.lastSafe = this.snapToRoad?.(p) ?? b.lastSafe ?? { pos: p.clone(), heading: b.heading };
    }
  }

  private water(b: Bike, dt: number): void {
    const p = b.obj.position;
    if (p.y > WATER_Y + 0.2 || this.dry?.(p)) { b.inWater = false; b.waterT = 0; return; }
    if (!b.inWater) { b.inWater = true; b.vy *= 0.25; }
    b.waterT += dt;
    b.vy += (-1.2 - b.vy) * Math.min(1, dt * 3);
    b.speed *= Math.exp(-dt * 2);
    if (b.waterT < 1.6) return;
    const to = b.lastSafe;
    if (to) { p.copy(to.pos).setY(to.pos.y + 0.05); b.heading = to.heading; } else p.y = 0.2;
    b.speed = 0; b.vy = 0; b.pitch = 0; b.vlat = 0; b.inWater = false; b.waterT = 0; b.targetH = NaN;
    this.rightUp(b);
    b.rescued = true;
    b.prev.set(Infinity, 0, 0);
  }

  /** Set the transform. */
  private pose(b: Bike): void {
    // YXZ: heading, then pitch, then the lean about the bike's own forward axis
    b.obj.rotation.set(b.pitch, b.heading, b.lean, 'YXZ');
  }
}
