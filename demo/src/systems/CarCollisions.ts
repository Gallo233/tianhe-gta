import * as THREE from 'three';
import type { DriveCar } from './Driving';

/**
 * Car-against-car contacts in the ground plane: oriented boxes (2D SAT) with a contact point, resolved with
 * an impulse at that point so hits shove and spin cars (a PIT manoeuvre works).
 *
 *   dynamic   DriveCar: the player's car, patrol cars, parked cars. Mass, speed along the heading, lateral
 *             slide `vlat` and yaw rate `spin`.
 *   traffic   kinematic on its lane: takes only the impulse along its heading (it brakes hard, and stops
 *             for a few seconds after a crash); never moves sideways, so it acts as a wall for the player.
 *
 * Frames are three.js xz; a car's forward is (-sin h, -cos h), its right (cos h, -sin h).
 */
export interface Body2D { x: number; z: number; hx: number; hz: number; h: number }
export interface Contact { nx: number; nz: number; depth: number; px: number; pz: number }

const E = 0.2;           // restitution

/** Mass (kg) from the footprint: buses are heavy, e-bikes light. */
export function massOf(half: THREE.Vector2): number {
  if (half.y > 4) return 12000;
  return 1500 * Math.pow((4 * half.x * half.y) / 10.1, 1.2);
}

/**
 * SAT between two oriented boxes. Returns the push for A (normal from B toward A), depth and a contact point
 * (the deepest corner of the incident box), or null if they do not overlap.
 */
export function obbContact(a: Body2D, b: Body2D): Contact | null {
  const ac = Math.cos(a.h), as = Math.sin(a.h), bc = Math.cos(b.h), bs = Math.sin(b.h);
  // local x (right) = (c, -s), local z (back) = (s, c)
  const axes: [number, number, boolean][] = [[ac, -as, true], [as, ac, true], [bc, -bs, false], [bs, bc, false]];
  const dx = b.x - a.x, dz = b.z - a.z;
  let depth = Infinity, nx = 0, nz = 0, fromA = true;
  for (const [ux, uz, own] of axes) {
    const ra = a.hx * Math.abs(ac * ux - as * uz) + a.hz * Math.abs(as * ux + ac * uz);
    const rb = b.hx * Math.abs(bc * ux - bs * uz) + b.hz * Math.abs(bs * ux + bc * uz);
    const dist = dx * ux + dz * uz;
    const o = ra + rb - Math.abs(dist);
    if (o <= 0) return null;
    if (o < depth) { depth = o; const sg = dist > 0 ? -1 : 1; nx = ux * sg; nz = uz * sg; fromA = own; }
  }
  // contact: if the separating face belongs to A, B's corner that reaches furthest into A (along +n);
  // otherwise A's corner that reaches furthest into B (along -n)
  const inc = fromA ? b : a, c = fromA ? bc : ac, s = fromA ? bs : as, dir = fromA ? 1 : -1;
  let best = -Infinity, px = inc.x, pz = inc.z;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const lx = sx * inc.hx, lz = sz * inc.hz;
    const wx = inc.x + lx * c + lz * s, wz = inc.z - lx * s + lz * c;
    const k = (wx * nx + wz * nz) * dir;
    if (k > best) { best = k; px = wx; pz = wz; }
  }
  return { nx, nz, depth, px, pz };
}

/** What CarCollisions needs from a traffic car (Traffic's internal car). */
export interface TrafficBody { obj: THREE.Object3D; half: THREE.Vector2; speed: number; fwd: THREE.Vector3; hitAt: number; crashT: number }

export interface Hit { a: DriveCar; b: DriveCar | TrafficBody; rel: number; pos: THREE.Vector3; traffic: boolean }

const bodyA: Body2D = { x: 0, z: 0, hx: 0, hz: 0, h: 0 };
const bodyB: Body2D = { x: 0, z: 0, hx: 0, hz: 0, h: 0 };

function fill(o: Body2D, p: THREE.Vector3, half: THREE.Vector2, h: number): Body2D {
  o.x = p.x; o.z = p.z; o.hx = half.x; o.hz = half.y; o.h = h;
  return o;
}

export class CarCollisions {
  /** contacts resolved in the last call (QA / sound) */
  readonly hits: Hit[] = [];

  /**
   * Resolve every pair among `dynamic` cars and each dynamic car against the traffic near it.
   * `trafficNear(p, r)` lists traffic cars within r metres of p.
   */
  resolve(dynamic: DriveCar[], trafficNear: (p: THREE.Vector3, r: number) => TrafficBody[]): Hit[] {
    this.hits.length = 0;
    for (let i = 0; i < dynamic.length; i++) {
      const a = dynamic[i];
      for (let j = i + 1; j < dynamic.length; j++) this.pair(a, dynamic[j]);
    }
    for (const a of dynamic) {
      if (a.settled && a.parked) continue;               // parked and at rest: traffic steers around it
      for (const t of trafficNear(a.obj.position, 9)) this.withTraffic(a, t);
    }
    return this.hits;
  }

  private pair(a: DriveCar, b: DriveCar): void {
    const pa = a.obj.position, pb = b.obj.position;
    if (Math.abs(pa.y - pb.y) > 1.6) return;
    const r = Math.hypot(a.half.x, a.half.y) + Math.hypot(b.half.x, b.half.y);
    if ((pa.x - pb.x) ** 2 + (pa.z - pb.z) ** 2 > r * r) return;
    const c = obbContact(fill(bodyA, pa, a.half, a.heading), fill(bodyB, pb, b.half, b.heading));
    if (!c) return;
    const ia = 1 / a.mass, ib = 1 / b.mass;
    // separate by inverse mass
    pa.x += c.nx * c.depth * ia / (ia + ib); pa.z += c.nz * c.depth * ia / (ia + ib);
    pb.x -= c.nx * c.depth * ib / (ia + ib); pb.z -= c.nz * c.depth * ib / (ia + ib);
    const rel = impulse(a, b, c);
    a.settled = false; b.settled = false;
    if (rel > 0.5) this.hits.push({ a, b, rel, pos: new THREE.Vector3(c.px, pa.y, c.pz), traffic: false });
  }

  private withTraffic(a: DriveCar, t: TrafficBody): void {
    const pa = a.obj.position, pt = t.obj.position;
    if (Math.abs(pa.y - pt.y) > 1.6) return;
    const h = Math.atan2(-t.fwd.x, -t.fwd.z);
    const c = obbContact(fill(bodyA, pa, a.half, a.heading), fill(bodyB, pt, t.half, h));
    if (!c) return;
    // the traffic car does not move sideways: the dynamic car takes the whole separation
    pa.x += c.nx * c.depth; pa.z += c.nz * c.depth;
    const mt = massOf(t.half);
    // relative normal velocity at the contact
    const va = velAt(a, c.px, c.pz);
    const vtx = t.fwd.x * t.speed, vtz = t.fwd.z * t.speed;
    const vn = (va.x - vtx) * c.nx + (va.y - vtz) * c.nz;
    if (vn >= 0) return;
    const rax = c.px - pa.x, raz = c.pz - pa.z;
    const rna = raz * c.nx - rax * c.nz;
    const ia = 1 / a.mass;
    // traffic: only its along-lane motion responds
    const ft = t.fwd.x * c.nx + t.fwd.z * c.nz;
    const ib = (ft * ft) / mt;
    const j = (-(1 + E) * vn) / (ia + ib + (rna * rna) / inertia(a));
    applyTo(a, j * c.nx, j * c.nz, rax, raz);
    t.speed = Math.max(0, t.speed - (j * ft) / mt);
    const rel = -vn;
    if (rel > 1) { t.crashT = Math.max(t.crashT, rel > 4 ? 5 : 2); t.hitAt = performance.now() / 1000; }
    a.settled = false;
    if (rel > 0.5) this.hits.push({ a, b: t, rel, pos: new THREE.Vector3(c.px, pa.y, c.pz), traffic: true });
  }
}

function inertia(c: DriveCar): number {
  return (c.mass * (4 * c.half.x * c.half.x + 4 * c.half.y * c.half.y)) / 12;
}

const vtmp = new THREE.Vector2();
/** Velocity (xz) of the point (px, pz) of a car: linear + spin x r. */
function velAt(c: DriveCar, px: number, pz: number): THREE.Vector2 {
  const h = c.heading, fx = -Math.sin(h), fz = -Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
  const rX = px - c.obj.position.x, rZ = pz - c.obj.position.z;
  // yaw rate w about +Y: w x r = (w * rz, -w * rx)
  return vtmp.set(fx * c.speed + rx * c.vlat + c.spin * rZ, fz * c.speed + rz * c.vlat - c.spin * rX);
}

/** Impulse (jx, jz) at offset (rx, rz) from the centre: linear velocity into speed / slide, torque into spin. */
function applyTo(c: DriveCar, jx: number, jz: number, rx: number, rz: number): void {
  const h = c.heading, fx = -Math.sin(h), fz = -Math.cos(h), qx = Math.cos(h), qz = -Math.sin(h);
  const dvx = jx / c.mass, dvz = jz / c.mass;
  c.speed += dvx * fx + dvz * fz;
  c.vlat += dvx * qx + dvz * qz;
  // (r x j)_y = rz * jx - rx * jz
  c.spin += (rz * jx - rx * jz) / inertia(c);
}

function impulse(a: DriveCar, b: DriveCar, c: Contact): number {
  const va = velAt(a, c.px, c.pz).clone();
  const vb = velAt(b, c.px, c.pz);
  const vn = (va.x - vb.x) * c.nx + (va.y - vb.y) * c.nz;
  if (vn >= 0) return 0;
  const rax = c.px - a.obj.position.x, raz = c.pz - a.obj.position.z;
  const rbx = c.px - b.obj.position.x, rbz = c.pz - b.obj.position.z;
  const rna = raz * c.nx - rax * c.nz, rnb = rbz * c.nx - rbx * c.nz;
  const j = (-(1 + E) * vn) / (1 / a.mass + 1 / b.mass + (rna * rna) / inertia(a) + (rnb * rnb) / inertia(b));
  applyTo(a, j * c.nx, j * c.nz, rax, raz);
  applyTo(b, -j * c.nx, -j * c.nz, rbx, rbz);
  return -vn;
}
