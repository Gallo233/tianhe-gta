import * as THREE from 'three';
import { PHYSICS } from '../config';
import type { Collision } from '../world/Collision';
import type { PropColliders, PropHit } from '../world/PropColliders';
import { massOf } from './CarCollisions';
import { rollWheels, wheelsOf, type Wheel } from '../entities/VehicleModel';

export interface DriveInput {
  throttle: number; // -1..1 (S / W)
  steer: number; // -1..1 (A / D)
  handbrake: boolean;
}

/** Pearl River surface (three.js y). Tunnels in this map are flattened to street level, so anything below is water. */
export const WATER_Y = -2.8;

/** Suspension: how high a wheel can step up in one go (kerbs yes, walls no) and how far it hangs down. */
const CLIMB = 0.45;
const DROOP = 0.2;
const BUMP = 0.15;           // bump stop: the body never sinks further than this below the wheel plane
const SPRING_W = 2 * Math.PI * 2.6;
const MAX_TILT_RATE = 1.05;  // rad/s (60°/s)

interface Hardpoint { x: number; z: number; rest: number; front: boolean; left: boolean; wheel: Wheel | null; g: number; hit: boolean; comp: number }

/** A drivable car: model forward is -Z, heading 0 faces -Z. The group's origin sits on the ground at rest. */
export class DriveCar {
  heading = 0;
  speed = 0; // m/s along forward, negative = reversing
  steerAngle = 0;
  wheelbase = 2.8;   // handling (yaw rate); the real axle spacing is in `axles`
  impact = 0;
  // --- vehicle physics v2
  vy = 0;
  /** sideways slide (m/s, + = to the right) and yaw rate from knocks (rad/s); tyres scrub both off */
  vlat = 0;
  spin = 0;
  readonly mass: number;
  pitch = 0;         // + nose up
  roll = 0;          // + right side up
  airborne = false;
  airTime = 0;
  /** landing speed of the last touchdown (m/s) and when it happened (game seconds); drives camera shake */
  landing = 0;
  inWater = false;
  waterT = 0;
  /** set on the frame the car was fished out of the river */
  rescued = false;
  /** within the soft map edge and heading out */
  atEdge = false;
  lastSafe: { pos: THREE.Vector3; heading: number } | null = null;
  /** exited cars keep simulating until they come to rest (they may be mid-air) */
  settled = false;
  readonly wheels: Wheel[];
  readonly hard: Hardpoint[];
  readonly axles: number;
  readonly track: number;
  readonly body: THREE.Object3D[];
  // internal state
  prev = new THREE.Vector3(Infinity, 0, 0);
  targetH = NaN;
  safeT = 0;
  leanP = 0; leanR = 0; leanPv = 0; leanRv = 0;
  accel = 0;

  constructor(readonly obj: THREE.Group, readonly half: THREE.Vector2, public parked = true) {
    // heading from the model's forward, whatever rotation it arrives with (a stolen traffic car may be pitched)
    obj.updateMatrixWorld();
    const f = new THREE.Vector3(0, 0, -1).transformDirection(obj.matrixWorld);
    this.heading = Math.atan2(-f.x, -f.z);
    obj.rotation.order = 'YXZ';
    obj.rotation.set(0, this.heading, 0);
    this.wheels = wheelsOf(obj);
    this.body = obj.children.filter((c) => !c.userData.wheel);
    if (this.wheels.length >= 3) {
      this.hard = this.wheels.map((w) => ({
        x: w.steer.position.x, z: w.steer.position.z, rest: w.steer.position.y, front: w.front, left: w.steer.position.x < 0,
        wheel: w, g: 0, hit: false, comp: 0,
      }));
    } else {
      const hx = Math.max(0.3, half.x - 0.25), hz = Math.max(0.5, half.y - 0.85);
      this.hard = [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]].map(([x, z]) => ({ x, z, rest: 0.35, front: z < 0, left: x < 0, wheel: null, g: 0, hit: false, comp: 0 }));
    }
    const zs = this.hard.map((h) => h.z), xs = this.hard.map((h) => h.x);
    this.mass = massOf(half);
    this.axles = Math.max(1, Math.max(...zs) - Math.min(...zs));
    this.track = Math.max(0.5, Math.max(...xs) - Math.min(...xs));
  }
  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.heading), 0, -Math.cos(this.heading));
  }
}

/** A car sliding sideways into a surface with normal (nx, nz) stops sliding into it, and its spin is damped. */
function scrubSlide(car: DriveCar, nx: number, nz: number): void {
  const s = Math.cos(car.heading) * nx - Math.sin(car.heading) * nz;      // right . n
  if (car.vlat * s < 0) car.vlat -= car.vlat * s * s;
  car.spin *= 0.6;
}

const tmpSeg = new THREE.Line3();
const corr = new THREE.Vector3();
const probe = new THREE.Vector3();
const leanE = new THREE.Euler(0, 0, 0, 'YXZ');
const pivot = new THREE.Vector3(0, 0.55, 0);
const pv = new THREE.Vector3();

/**
 * Arcade car physics tuned for a small city: quick throttle, speed-sensitive steering, a handbrake that lets
 * the rear step out -- on top of a four-wheel raycast suspension:
 *
 *  - every wheel casts down from `CLIMB` above its rest contact point; the contacts give the body its target
 *    height, pitch and roll. The body follows on a critically damped spring that can push up hard (kerbs,
 *    landings) but never pull down faster than gravity, so crests and ledges throw the car into the air.
 *  - with no wheel in reach the car is airborne: gravity, kept momentum, 20% steering.
 *  - walls come from the static collision as a horizontal capsule floating 0.3 m up (tilted with the pitch),
 *    so it mounts kerbs but stops at walls; a step too tall for `CLIMB` stops the wheels too.
 *  - below the river surface the car sinks and after 2 s is fished out onto the last safe lane point.
 *  - a soft map edge slows the car down and turns it back; walls in the collision mesh are the hard edge.
 */
export class Driving {
  maxSpeed = 30; // ~108 km/h
  grip = 1;
  /** map bounds in three.js x / z, soft edge `margin` metres inside */
  bounds: { x0: number; x1: number; z0: number; z1: number } | null = null;
  margin = 30;
  /** nearest lane point and heading for a rescue (three.js), or null */
  snapToRoad: ((p: THREE.Vector3) => { pos: THREE.Vector3; heading: number } | null) | null = null;
  /** below the river's surface but not in it (花城汇's court and B1, the stations): no sinking */
  dry: ((p: THREE.Vector3) => boolean) | null = null;
  time = 0;
  /** lamp posts, trees, street furniture */
  props: PropColliders | null = null;
  /** last prop hit per car this step (for sound / crime / QA) */
  lastProp: PropHit | null = null;

  constructor(private readonly collision: Collision) {}

  update(car: DriveCar, input: DriveInput, dt: number): void {
    if (dt <= 0) return;
    car.rescued = false;
    const n = Math.max(1, Math.ceil(dt * 60 - 1e-3));
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(car, input, h);
    this.pose(car, dt);
  }

  private step(car: DriveCar, input: DriveInput, dt: number): void {
    this.time += dt;
    const p = car.obj.position;
    // teleported (spawn, QA, rescue, the player's hook): start the suspension afresh
    if (p.distanceToSquared(car.prev) > 64) { car.vy = 0; car.targetH = NaN; car.inWater = false; car.waterT = 0; }
    const f = car.forward;
    const grounded = !car.airborne && !car.inWater;
    // --- longitudinal
    const v = car.speed;
    let a = 0;
    if (grounded) {
      if (input.throttle > 0) a = v < -0.3 ? 16 : 9.5 * (1 - Math.max(0, v) / this.maxSpeed) + 1.2;
      else if (input.throttle < 0) a = v > 0.3 ? -16 : -6 * (1 + v / 9);
      a *= Math.abs(input.throttle) || 1;
      if (input.throttle === 0) a = -Math.sign(v) * Math.min(Math.abs(v) / dt, 2.2 + Math.abs(v) * 0.08);
      if (input.handbrake) a += -Math.sign(v) * Math.min(Math.abs(v) / dt, 13);
      // gravity along the slope (arcade 60%); a car left on a hill holds still
      if (input.throttle !== 0 || Math.abs(v) > 0.5) a += PHYSICS.gravity * Math.sin(car.pitch) * 0.6;
    }
    if (car.inWater) a = -car.speed * 1.6;
    car.accel = a;
    car.speed = THREE.MathUtils.clamp(v + a * dt, -9, this.maxSpeed);
    // --- steering: less lock at speed; handbrake tightens the turn; a little air control
    const lock = THREE.MathUtils.lerp(0.62, 0.14, Math.min(1, Math.abs(car.speed) / 26)) * (input.handbrake ? 1.5 : 1);
    const target = -input.steer * lock;
    car.steerAngle += (target - car.steerAngle) * Math.min(1, dt * 7);
    const yawRate = (car.speed / car.wheelbase) * Math.tan(car.steerAngle) * this.grip * (grounded ? 1 : car.inWater ? 0.1 : 0.2);
    car.heading += (yawRate + car.spin) * dt;
    // knocks: slide and spin die out on the tyres (not in the air)
    if (grounded) {
      car.vlat -= Math.sign(car.vlat) * Math.min(Math.abs(car.vlat), 11 * dt);
      car.spin *= Math.exp(-dt * (Math.abs(car.spin) > 1.5 ? 1.6 : 3.5));
      if (Math.abs(car.spin) < 0.02) car.spin = 0;
    }
    // --- move, with a little slide when the handbrake is on
    const slip = input.handbrake && grounded ? 0.35 : 0;
    const move = car.forward.multiplyScalar(car.speed * dt);
    move.lerp(f.multiplyScalar(car.speed * dt), slip);
    const right = new THREE.Vector3(Math.cos(car.heading), 0, -Math.sin(car.heading));
    move.addScaledVector(right, car.vlat * dt);
    // on a slope the car travels along it; the vertical part comes from the suspension
    p.add(move);
    rollWheels(car.wheels, grounded ? car.speed * dt : 0, car.steerAngle);
    // --- walls: a capsule along the body, tilted with the pitch
    const r = Math.min(car.half.x, 1.0);
    const reach = Math.max(0.1, car.half.y - r);
    const fw = car.forward;
    const lift = Math.sin(car.pitch) * reach;
    tmpSeg.start.set(p.x - fw.x * reach, p.y + 0.3 + r - lift, p.z - fw.z * reach);
    tmpSeg.end.set(p.x + fw.x * reach, p.y + 0.3 + r + lift, p.z + fw.z * reach);
    this.collision.resolveCapsule(tmpSeg, r, corr);
    corr.y = 0;
    if (corr.lengthSq() > 1e-8) {
      p.add(corr);
      const nrm = corr.clone().normalize();
      const into = fw.dot(nrm) * car.speed;
      if (into < 0) {
        car.impact = Math.max(car.impact, Math.abs(into));
        car.speed *= Math.abs(into) > 6 ? 0.25 : 0.75;
      }
      scrubSlide(car, nrm.x, nrm.z);
    }
    // --- props: the body's footprint against posts, trunks, rails and furniture
    const hit = this.props?.resolveBox(p, car.half.x, car.half.y, car.heading, p.y + 0.12, p.y + 1.4) ?? null;
    if (hit) {
      this.lastProp = hit;
      const into = (fw.x * hit.nx + fw.z * hit.nz) * car.speed;
      if (into < 0) {
        car.impact = Math.max(car.impact, Math.abs(into));
        car.speed *= Math.abs(into) > 6 ? 0.25 : 0.75;
      }
      scrubSlide(car, hit.nx, hit.nz);
    }
    car.impact = Math.max(0, car.impact - dt * 20);
    this.edge(car, dt);
    this.suspension(car, dt);
    this.water(car, dt);
    car.prev.copy(p);
  }

  /** Soft map edge: inside the margin a car heading out is braked and steered back. */
  private edge(car: DriveCar, dt: number): void {
    car.atEdge = false;
    const b = this.bounds;
    if (!b) return;
    const p = car.obj.position;
    const m = this.margin;
    let nx = 0, nz = 0;
    if (p.x > b.x1 - m) nx = (p.x - (b.x1 - m)) / m; else if (p.x < b.x0 + m) nx = -((b.x0 + m) - p.x) / m;
    if (p.z > b.z1 - m) nz = (p.z - (b.z1 - m)) / m; else if (p.z < b.z0 + m) nz = -((b.z0 + m) - p.z) / m;
    if (!nx && !nz) return;
    const f = car.forward;
    const out = (f.x * nx + f.z * nz) * Math.sign(car.speed || 1);
    if (out > 0) {
      car.atEdge = true;
      const k = Math.min(1, Math.hypot(nx, nz));
      car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), (6 + 30 * k) * dt);
    }
    // never past the edge itself
    p.x = THREE.MathUtils.clamp(p.x, b.x0 + 1.5, b.x1 - 1.5);
    p.z = THREE.MathUtils.clamp(p.z, b.z0 + 1.5, b.z1 - 1.5);
  }

  private suspension(car: DriveCar, dt: number): void {
    const p = car.obj.position;
    const ch = Math.cos(car.heading), sh = Math.sin(car.heading);
    const sp = Math.sin(car.pitch), sr = Math.sin(car.roll);
    let contacts = 0;
    let left = 0, right = 0, front = 0, rear = 0;
    for (const w of car.hard) {
      const wx = p.x + w.x * ch + w.z * sh;
      const wz = p.z - w.x * sh + w.z * ch;
      const yRest = p.y + w.x * sr - w.z * sp;
      const g = this.collision.groundHeight(probe.set(wx, yRest + CLIMB, wz), CLIMB + DROOP);
      w.hit = g !== null && g >= yRest - DROOP;
      w.g = w.hit ? g! : yRest - DROOP;
      w.comp = THREE.MathUtils.clamp(w.g - yRest, -DROOP, BUMP);
      if (w.hit) { contacts++; if (w.left) left++; else right++; if (w.front) front++; else rear++; }
    }
    // centre: what is under the car at all (a long ray; also the anti-tunnelling floor)
    const gc = this.collision.groundHeight(probe.set(p.x, p.y + CLIMB, p.z), 200);
    // perched on one side / one axle over a drop: it tips and falls instead of hovering
    const oneSided = contacts > 0 && contacts <= 2 && (left === 0 || right === 0 || front === 0 || rear === 0);
    const supported = contacts > 0 && !(oneSided && (gc === null || gc < p.y - 0.8));
    const wasAir = car.airborne;
    car.airborne = contacts === 0;
    car.airTime = car.airborne ? car.airTime + dt : 0;
    let a = PHYSICS.gravity;
    if (supported) {
      // plane through the (hanging) wheels
      let gF = 0, gB = 0, gL = 0, gR = 0, nF = 0, nB = 0, nL = 0, nR = 0;
      for (const w of car.hard) {
        if (w.front) { gF += w.g; nF++; } else { gB += w.g; nB++; }
        if (w.left) { gL += w.g; nL++; } else { gR += w.g; nR++; }
      }
      gF /= nF || 1; gB /= nB || 1; gL /= nL || 1; gR /= nR || 1;
      const tp = Math.atan2(gF - gB, car.axles);
      const tr = Math.atan2(gR - gL, car.track);
      let th = 0;
      for (const w of car.hard) th += w.g - (w.x * Math.sin(tr) - w.z * Math.sin(tp));
      th /= car.hard.length;
      const vt = Number.isNaN(car.targetH) ? 0 : THREE.MathUtils.clamp((th - car.targetH) / dt, -4, 4);
      car.targetH = th;
      a = Math.max(PHYSICS.gravity, SPRING_W * SPRING_W * (th - p.y) + 2 * SPRING_W * (vt - car.vy));
      const rate = MAX_TILT_RATE * dt;
      car.pitch += THREE.MathUtils.clamp((tp - car.pitch) * Math.min(1, dt * 14), -rate, rate);
      car.roll += THREE.MathUtils.clamp((tr - car.roll) * Math.min(1, dt * 14), -rate, rate);
      car.vy += a * dt;
      p.y += car.vy * dt;
      if (p.y < th - BUMP) {                     // bump stop: a hard landing
        if (car.vy < 0) { car.landing = -car.vy; car.speed *= 1 - Math.min(0.35, -car.vy * 0.025); }
        p.y = th - BUMP;
        car.vy = Math.max(car.vy, vt);
      }
      if (wasAir && !car.airborne) { car.landing = Math.max(car.landing, -car.vy); car.impact = Math.max(car.impact, -car.vy); }
    } else {
      car.targetH = NaN;
      car.vy += a * dt;
      p.y += car.vy * dt;
      // in the air the nose slowly follows the flight path; tipping over an edge keeps rolling a little
      const want = Math.atan2(car.vy, Math.max(4, Math.abs(car.speed))) * 0.5;
      car.pitch += THREE.MathUtils.clamp(want - car.pitch, -0.6 * dt, 0.6 * dt);
      if (!car.airborne && contacts > 0) {
        const side = left === 0 ? -1 : right === 0 ? 1 : 0;       // fall toward the unsupported side
        car.roll += side * 0.9 * dt;
      } else car.roll *= 1 - Math.min(1, dt * 0.4);
    }
    // anti-tunnelling: never end a step below the floor under the centre
    if (gc !== null && p.y < gc - BUMP - 0.05 && car.prev.y >= gc - BUMP - 0.05) {
      if (car.vy < 0) car.landing = Math.max(car.landing, -car.vy);
      p.y = gc - BUMP;
      car.vy = Math.max(0, car.vy);
    }
    // a safe spot to come back to: all wheels down, dry, not about to fall
    car.safeT -= dt;
    if (car.safeT <= 0 && contacts === car.hard.length && !car.inWater && p.y > WATER_Y + 1.5 && Math.abs(car.pitch) < 0.2) {
      car.safeT = 0.5;
      const snapped = this.snapToRoad?.(p);
      if (snapped) car.lastSafe = snapped;
      else if (!car.lastSafe) car.lastSafe = { pos: p.clone(), heading: car.heading };
    }
  }

  private water(car: DriveCar, dt: number): void {
    const p = car.obj.position;
    if (p.y > WATER_Y + 0.3 || this.dry?.(p)) { car.inWater = false; car.waterT = 0; return; }
    if (!car.inWater) { car.inWater = true; car.vy *= 0.25; car.landing = 0; }
    car.waterT += dt;
    // sink at ~1.5 m/s, lose way
    car.vy += (-1.5 - car.vy) * Math.min(1, dt * 3);
    car.speed *= Math.exp(-dt * 1.6);
    if (car.waterT < 2) return;
    const to = car.lastSafe ?? null;
    if (to) {
      p.copy(to.pos).setY(to.pos.y + 0.05);
      car.heading = to.heading;
    } else p.y = 0.2;
    car.speed = 0; car.vy = 0; car.pitch = 0; car.roll = 0; car.vlat = 0; car.spin = 0;
    car.inWater = false; car.waterT = 0; car.targetH = NaN;
    car.rescued = true;
    car.prev.set(Infinity, 0, 0);
  }

  /** Transform, suspension travel on the wheels, and body lean from acceleration (visual only). */
  private pose(car: DriveCar, dt: number): void {
    car.obj.rotation.set(car.pitch, car.heading, car.roll, 'YXZ');
    for (const w of car.hard) {
      if (!w.wheel) continue;
      const want = w.rest + (car.airborne ? -DROOP * 0.6 : w.comp);
      w.wheel.steer.position.y += (want - w.wheel.steer.position.y) * Math.min(1, dt * 20);
    }
    // lean: squat under throttle, dive under brakes, roll out of corners; a lightly damped spring
    const grounded = !car.airborne && !car.inWater;
    const lat = grounded ? car.speed * ((car.speed / car.wheelbase) * Math.tan(car.steerAngle) * this.grip) : 0;
    const tp = grounded ? THREE.MathUtils.clamp(car.accel * 0.0045, -0.055, 0.04) : 0;
    const tr = grounded ? THREE.MathUtils.clamp(-lat * 0.004, -0.06, 0.06) : 0;
    const k = 80, c = 9;
    car.leanPv += ((tp - car.leanP) * k - car.leanPv * c) * dt;
    car.leanRv += ((tr - car.leanR) * k - car.leanRv * c) * dt;
    car.leanP += car.leanPv * dt;
    car.leanR += car.leanRv * dt;
    leanE.set(car.leanP, 0, car.leanR, 'YXZ');
    pv.copy(pivot).applyEuler(leanE);
    for (const b of car.body) {
      b.rotation.copy(leanE);
      b.position.set(pivot.x - pv.x, pivot.y - pv.y, pivot.z - pv.z);
    }
  }
}
