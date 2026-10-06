import * as THREE from 'three';
import { fromBlender } from '../config';

/**
 * Food-delivery loop on real Tianhe addresses (places.json from the OSM export; shop and restaurant names
 * are fictional parodies, stations, stops and towers keep their real names). Pick up at the yellow beam,
 * deliver to the green one before the clock runs out.
 *
 * The clock is set by Xiaozhun, the platform's algorithm, when the order is assigned: street distance (x1.35 the
 * straight line) from the courier to the shop and on to the customer at an e-bike's cruising pace, plus a minute for
 * the shop. A slow kitchen eats the courier's time, not the shop's. Late is not the end: the order goes on, the pay
 * is cut by 30% and the rating drops; five minutes late, the platform cancels it.
 * The order layer (delivery/Orders) decides when food is picked up and delivered (talking to people, lockers,
 * photos); this ledger keeps the clock, the pay, the food's condition, the rating and the markers.
 * The food has a condition (1 = perfect): crashes, hard landings and knocks spill it (`jolt`). The pay scales
 * with it, a perfect early delivery earns a tip, and the rider's rating moves with every order.
 */
export const XIAOZHUN_PACE = 9.5;   // m/s, 34 km/h: the starting assumption
export interface Place {
  name: string;
  pos: THREE.Vector3;
  cat: string;
}

/** offer: on the way to the shop; carrying: the food is in the box; none: between orders */
export type LedgerPhase = 'offer' | 'carrying' | 'none';

interface RawPlace { name: string; role: 'pickup' | 'drop'; cat: string; pos: [number, number, number] }


export interface JobEvent {
  type: 'picked' | 'delivered' | 'failed' | 'spilled' | 'late';
  reward?: number;
  tip?: number;
  /** the food's condition on delivery (0..1) */
  condition?: number;
  /** delivered early enough that Xiaozhun tightened the next limits, and by how many seconds */
  early?: boolean;
  saved?: number;
  place: string;
}

function marker(color: string): THREE.Group {
  const g = new THREE.Group();
  const beamMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 60, 32, 1, true), beamMat);
  beam.position.y = 30;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.95, 1.18, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.32), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3 }));
  gem.position.y = 2.3;
  gem.name = 'gem';
  g.add(beam, ring, gem);
  g.renderOrder = 5;
  return g;
}

export class Jobs {
  phase: LedgerPhase = 'none';
  cash = 0;
  delivered = 0;
  timeLeft = 0;
  timeLimit = 0;
  /** the food: 1 perfect .. 0 all over the road */
  condition = 1;
  rating = 4.99;
  /** Xiaozhun's assumed pace (m/s): every early delivery teaches it that you can go faster */
  pace = XIAOZHUN_PACE;
  pickup: Place;
  drop: Place;
  /** extra protection (a shop that double-bagged the soup): jolts count for this much */
  padding = 1;
  readonly pickups: Place[];
  readonly drops: Place[];
  readonly pickupMarker = marker('#f5ba49');
  readonly dropMarker = marker('#4fe0b0');
  private lateSaid = false;
  private rng: () => number;

  constructor(scene: THREE.Scene, rng: () => number, places: RawPlace[]) {
    this.rng = rng;
    const mk = (p: RawPlace): Place => ({ name: p.name, cat: p.cat, pos: fromBlender(p.pos[0], p.pos[1], p.pos[2]) });
    this.pickups = places.filter((p) => p.role === 'pickup').map(mk);
    this.drops = places.filter((p) => p.role === 'drop').map(mk);
    this.pickup = this.pickups[0];
    this.drop = this.drops[0];
    scene.add(this.pickupMarker, this.dropMarker);
    this.pickupMarker.visible = this.dropMarker.visible = false;
  }

  setRng(rng: () => number): void {
    this.rng = rng;
  }

  get target(): Place {
    return this.phase === 'carrying' ? this.drop : this.pickup;
  }

  /** A new order from `from` (the courier): to the shop, then the customer; Xiaozhun starts the clock now. */
  assign(pickup: Place, drop: Place, from: THREE.Vector3, extra = 0): void {
    this.pickup = pickup;
    this.drop = drop;
    this.phase = 'offer';
    const dist = (from.distanceTo(pickup.pos) + pickup.pos.distanceTo(drop.pos)) * 1.35;
    this.timeLimit = Math.ceil(dist / this.pace + 60 + extra);
    this.timeLeft = this.timeLimit;
    this.condition = 1;
    this.padding = 1;
    this.lateSaid = false;
    this.pickupMarker.position.copy(pickup.pos);
    this.pickupMarker.visible = true;
    this.dropMarker.visible = false;
  }

  /** The food is in the box. */
  pick(): JobEvent {
    this.phase = 'carrying';
    this.pickupMarker.visible = false;
    this.dropMarker.position.copy(this.drop.pos);
    this.dropMarker.visible = true;
    return { type: 'picked', place: this.pickup.name };
  }

  /** Handed over / left: pay (scaled by the food, lateness and mult), tip, rating, Xiaozhun's lesson. */
  deliver(mult = 1, extraTip = 0): JobEvent {
    const dist = this.drop.pos.distanceTo(this.pickup.pos);
    const c = this.condition, late = this.timeLeft < 0;
    const reward = Math.round((30 + dist * 0.08 + Math.max(0, this.timeLeft) * 0.5) * (0.4 + 0.6 * c) * (late ? 0.7 : 1) * mult);
    const tip = (c >= 0.9 && this.timeLeft > this.timeLimit * 0.2 && mult > 0 ? Math.round(3 + this.timeLeft * 0.15) : 0) + extraTip;
    this.cash += reward + tip;
    if (mult > 0) this.delivered += 1;
    if (late) this.rating = Math.max(1, this.rating - 0.03);
    // early by more than a quarter of the limit: the algorithm "optimises" the next limits
    const early = this.timeLeft > this.timeLimit * 0.25 && mult > 0;
    if (early) this.pace = Math.min(12, this.pace * 1.03);
    const saved = Math.round(this.timeLeft);
    this.close();
    return { type: 'delivered', reward, tip, condition: c, place: this.drop.name, early, saved };
  }

  /** No order on (between orders, cancelled). */
  close(): void {
    this.phase = 'none';
    this.pickupMarker.visible = false;
    this.dropMarker.visible = false;
  }

  /** A knock to the food while carrying it (0..1 of a perfect meal); true if that spilled the lot. */
  jolt(amount: number): boolean {
    if (this.phase !== 'carrying' || amount <= 0 || this.condition <= 0) return false;
    this.condition = Math.max(0, this.condition - amount * this.padding);
    return this.condition <= 0;
  }

  /** The order ends because the food is gone (a crash spilled it): cancelled, rating down. */
  spill(): JobEvent {
    const place = this.drop.name;
    this.rating = Math.max(1, this.rating - 0.08);
    this.close();
    return { type: 'spilled', place };
  }

  /** The clock and the markers; 'late' once when time runs out, 'failed' five minutes after (cancelled). */
  update(dt: number, elapsed: number, player?: THREE.Vector3): JobEvent | null {
    for (const m of [this.pickupMarker, this.dropMarker]) {
      const gem = m.getObjectByName('gem')!;
      gem.rotation.y = elapsed * 1.8;
      gem.position.y = 2.3 + Math.sin(elapsed * 2.4) * 0.15;
      // close to it the beam and the gem step aside: they would stand in the doorway, in the photo
      const d = player ? Math.hypot(m.position.x - player.x, m.position.z - player.z) : 99;
      const k = THREE.MathUtils.clamp((d - 4) / 6, 0, 1);
      m.children.forEach((c) => {
        const mat = (c as THREE.Mesh).material as THREE.MeshBasicMaterial;
        if (c.name === 'gem') c.visible = k > 0.05;
        else if (mat && mat.opacity !== undefined && c !== m.children[1]) { mat.opacity = 0.28 * k; c.visible = k > 0.01; }
      });
    }
    if (this.phase === 'none') return null;
    this.timeLeft -= dt;
    if (this.timeLeft < 0 && !this.lateSaid) {
      this.lateSaid = true;
      this.pace = Math.max(XIAOZHUN_PACE, this.pace * 0.98);
      return { type: 'late', place: this.drop.name };
    }
    if (this.timeLeft < -300) {
      const place = this.drop.name;
      this.rating = Math.max(1, this.rating - 0.05);
      this.close();
      return { type: 'failed', place };
    }
    return null;
  }

  /** Random pick helper for the order layer. */
  random(): number { return this.rng(); }
}
