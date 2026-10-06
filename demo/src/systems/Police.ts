import * as THREE from 'three';
import { fromBlender } from '../config';
import { vehicleGroup, type VehicleTemplate } from '../entities/VehicleModel';
import type { Crime } from '../ai/facts';
import type { CrimeKind } from '../ai/brainProtocol';
import type { RoadNet, RNode } from '../world/RoadNet';
import { DriveCar, type Driving } from './Driving';

/**
 * Wanted level and police response.
 *
 * Witnesses report crimes (Pedestrians -> Game -> report). Each crime is counted once however many
 * people call; the level rises to at least the crime's severity and by one per further crime (max 3).
 * One patrol car per star comes from a road node 80-220 m away, drives with the player's own car
 * physics (so it collides with the city and climbs bridge ramps), finds its way along the Tianhe OSM
 * road graph with A* (real road polylines, one-way streets respected), and heads straight for the
 * player once within 60 m. Staying stopped next to a patrol car gets you arrested;
 * staying out of sight (>70 m from every unit) for 18 s drops a star.
 */
const SEVERITY: Record<CrimeKind, number> = { hit_person: 2, steal_car: 1, crash_car: 1 };
const PAINT = new THREE.Color('#15213a');

interface Unit {
  car: DriveCar;
  route: THREE.Vector3[];
  wp: number;
  replan: number;
  stuck: number;
  reverse: number;
  steerSign: number;
}

export interface PoliceEvents {
  level: (level: number, reason: 'report' | 'lost' | 'busted') => void;
  busted: (driving: boolean) => void;
}

const tmp = new THREE.Vector3();
const left = new THREE.Vector3();

export class Police {
  readonly group = new THREE.Group();
  level = 0;
  private units: Unit[] = [];
  private counted = new Set<number>();
  private unseen = 0;
  private engaged = false;   // a unit has had eyes on the player since the level last rose
  private bust = 0;
  private readonly nodes: RNode[];

  constructor(
    private readonly roads: RoadNet,
    private readonly driving: Driving,
    private readonly template: VehicleTemplate,
    private readonly events: PoliceEvents,
  ) {
    this.group.name = 'police';
    this.nodes = roads.nodes.filter((n) => !n.exit && n.z < 0.5);
  }

  /** A witness finished a call about `crime`. Returns true if it raised the wanted level. */
  report(crime: Crime): boolean {
    if (this.counted.has(crime.id)) return false;
    this.counted.add(crime.id);
    const next = Math.min(3, Math.max(this.level + (this.level > 0 ? 1 : 0), SEVERITY[crime.kind]));
    if (next === this.level) return false;
    this.level = next;
    this.unseen = 0;
    this.engaged = false;
    this.events.level(this.level, 'report');
    return true;
  }

  /** Units near a point (traffic treats them as obstacles; the brain can be told about sirens). */
  get cars(): DriveCar[] {
    return this.units.map((u) => u.car);
  }

  nearestDistance(p: THREE.Vector3): number {
    let d = Infinity;
    for (const u of this.units) d = Math.min(d, u.car.obj.position.distanceTo(p));
    return d;
  }

  clear(): void {
    for (const u of this.units) this.group.remove(u.car.obj);
    this.units = [];
    this.level = 0;
    this.bust = 0;
  }

  // ------------------------------------------------------------------------------------ spawning
  private spawn(player: THREE.Vector3): void {
    const pb = new THREE.Vector2(player.x, -player.z);
    const far = this.nodes
      .map((n) => ({ n, d: Math.hypot(n.x - pb.x, n.y - pb.y) }))
      .filter(({ n, d }) => d > 80 && d < 220 && !this.units.some((u) => u.car.obj.position.distanceTo(n.p) < 15))
      .sort((a, b) => a.d - b.d);
    const pick = far[Math.floor(Math.random() * Math.min(3, far.length))] ?? this.nodes.map((n) => ({ n, d: Math.hypot(n.x - pb.x, n.y - pb.y) })).sort((a, b) => b.d - a.d)[0];
    if (!pick) return;
    const obj = vehicleGroup(this.template, PAINT);     // the police model carries its own flashing light bar
    obj.position.copy(fromBlender(pick.n.x, pick.n.y, pick.n.z + 0.02));
    obj.rotation.y = Math.atan2(-(player.x - obj.position.x), -(player.z - obj.position.z));
    this.group.add(obj);
    this.units.push({ car: new DriveCar(obj, this.template.half.clone(), false), route: [], wp: 0, replan: 0, stuck: 0, reverse: 0, steerSign: 1 });
  }

  // ------------------------------------------------------------------------------------ routing
  private nearestNode(p: THREE.Vector3): RNode {
    return this.roads.nearestNode(p.x, -p.z, Infinity, (n) => !n.exit) ?? this.nodes[0];
  }

  private route(from: RNode, to: RNode): THREE.Vector3[] {
    return this.roads.route(from, to);
  }

  // ------------------------------------------------------------------------------------ update
  update(dt: number, player: THREE.Vector3, playerCar: DriveCar | null, siren: (v: number) => void, bikeSpeed: number | null = null): void {
    // units follow the wanted level; extra units leave once out of sight
    while (this.units.length < this.level) this.spawn(player);
    // units beyond the wanted level drive off and vanish 100 m out
    this.units = this.units.filter((u, i) => {
      if (i < this.level || u.car.obj.position.distanceTo(player) < 100) return true;
      this.group.remove(u.car.obj);
      return false;
    });
    const saved = [this.driving.maxSpeed, this.driving.grip];
    this.driving.maxSpeed = 31; this.driving.grip = 1.15;
    let nearest = Infinity;
    for (const u of this.units) {
      const car = u.car, pos = car.obj.position;
      const dPlayer = pos.distanceTo(player);
      const leaving = this.units.indexOf(u) >= this.level;
      if (!leaving) nearest = Math.min(nearest, dPlayer);
      // --- where to go
      u.replan -= dt;
      if (leaving) {
        // head for the intersection farthest from the player
        if (u.replan <= 0 || !u.route.length) {
          const cand = this.nodes.filter((n) => { const d = Math.hypot(n.x - player.x, n.y + player.z); return d > 400 && d < 650; });
          const far = cand[Math.floor(Math.random() * cand.length)] ?? this.nodes[0];
          u.route = this.route(this.nearestNode(pos), far); u.wp = 0; u.replan = 3;
        }
      } else if (dPlayer < 60) { u.route = []; }
      else if (u.replan <= 0 || u.wp >= u.route.length) {
        u.route = this.route(this.nearestNode(pos), this.nearestNode(player));
        u.wp = u.route.length > 1 && u.route[0].distanceTo(pos) < 10 ? 1 : 0;
        u.replan = 1.5;
      }
      while (u.wp < u.route.length && u.route[u.wp].distanceTo(pos) < 9) u.wp++;
      const target = u.wp < u.route.length ? u.route[u.wp] : leaving ? pos : player;
      // --- steer toward it
      const to = tmp.subVectors(target, pos).setY(0);
      const dist = to.length();
      to.normalize();
      const f = car.forward;
      left.set(f.z, 0, -f.x);
      const angle = Math.atan2(to.dot(left), to.dot(f));                 // + = target to the left
      let steer = THREE.MathUtils.clamp(-angle * 1.8, -1, 1);
      let throttle = Math.abs(angle) > 1.3 && car.speed > 6 ? 0.2 : 1;
      if (target === player) throttle = THREE.MathUtils.clamp((dist - 4.5) / 6, -0.4, 1);
      // --- unstick: reverse out for a moment
      if (u.reverse > 0) {
        u.reverse -= dt;
        throttle = -1; steer = u.steerSign;
      } else if (throttle > 0.3 && Math.abs(car.speed) < 0.8) {
        u.stuck += dt;
        if (u.stuck > 1.6) { u.reverse = 1.1; u.stuck = 0; u.steerSign = -Math.sign(steer || 1); }
      } else u.stuck = Math.max(0, u.stuck - dt);
      this.driving.update(car, { throttle, steer, handbrake: false }, dt);
    }
    this.driving.maxSpeed = saved[0]; this.driving.grip = saved[1];
    // units vs each other, the player's car and traffic: Game resolves all car contacts (CarCollisions)
    siren(this.units.length ? Math.max(0, 1 - nearest / 110) : 0);
    // --- arrest: stopped next to a patrol car
    const still = playerCar ? Math.abs(playerCar.speed) < 2 : bikeSpeed !== null ? Math.abs(bikeSpeed) < 1.5 : true;
    const close = this.level > 0 && (playerCar ? nearest < 7 : nearest < 5.5);
    this.bust = close && still && this.level > 0 ? this.bust + dt : Math.max(0, this.bust - dt * 2);
    if (this.bust > (playerCar ? 2.5 : 1.6)) {
      this.bust = 0;
      this.events.busted(Boolean(playerCar));
      this.clear();
      this.events.level(0, 'busted');
      return;
    }
    // --- losing them
    if (this.level > 0) {
      if (nearest < 70) this.engaged = true;
      // the clock only runs once the police have actually found you
      this.unseen = nearest > 70 && this.engaged ? this.unseen + dt : 0;
      if (this.unseen > 25) {
        this.unseen = 0;
        this.level--;
        this.events.level(this.level, 'lost');
      }
    }
  }
}
