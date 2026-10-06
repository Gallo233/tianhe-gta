import * as THREE from 'three';
import { PHYSICS } from '../config';
import type { Character } from '../entities/Character';
import type { Collision } from '../world/Collision';
import type { PropColliders } from '../world/PropColliders';

export interface MoveIntent {
  move: THREE.Vector2; // x strafe, y forward (camera relative)
  sprint: boolean;
  walk: boolean;
  jump: boolean;
}

/**
 * Kinematic third-person controller. Walls: a capsule that floats one step-height above the
 * feet, pushed out of the BVH. Ground: a downward ray that snaps the feet to anything within the
 * step height, so curbs are climbed and small drops are followed without bouncing.
 */
export class Controller {
  private readonly wish = new THREE.Vector3();
  private readonly segment = new THREE.Line3();
  private readonly correction = new THREE.Vector3();
  private readonly probe = new THREE.Vector3();
  private readonly horiz = new THREE.Vector3();
  lastSpeed = 0;
  /** lamp posts, trees, street furniture */
  props: PropColliders | null = null;

  constructor(private readonly collision: Collision) {}

  update(ch: Character, intent: MoveIntent, cameraYaw: number, dt: number): void {
    const p = ch.root.position;
    const v = ch.velocity;
    const spec = ch.spec;

    // --- desired horizontal velocity
    const fx = -Math.sin(cameraYaw), fz = -Math.cos(cameraYaw);
    const rx = Math.cos(cameraYaw), rz = -Math.sin(cameraYaw);
    this.wish.set(fx * intent.move.y + rx * intent.move.x, 0, fz * intent.move.y + rz * intent.move.x);
    const amount = Math.min(1, this.wish.length());
    if (amount > 1e-3) this.wish.divideScalar(this.wish.length());

    const wantsSprint = intent.sprint && amount > 0.1 && !intent.walk;
    if (Number.isFinite(spec.staminaSeconds)) {
      if (ch.exhausted && ch.stamina > 0.3) ch.exhausted = false;
      ch.sprinting = wantsSprint && !ch.exhausted && ch.grounded;
      if (ch.sprinting) ch.stamina -= dt / spec.staminaSeconds;
      else ch.stamina = Math.min(1, ch.stamina + dt * 0.22);
      if (ch.stamina <= 0) { ch.stamina = 0; ch.exhausted = true; ch.sprinting = false; }
    } else {
      ch.sprinting = wantsSprint;
      ch.stamina = 1;
    }
    let speed = intent.walk ? spec.walkSpeed * 1.1 : spec.runSpeed;
    if (ch.sprinting) speed = spec.runSpeed * spec.sprintScale;
    speed *= amount;

    const control = ch.grounded ? 1 : PHYSICS.airControl;
    const k = 1 - Math.exp(-PHYSICS.acceleration * control * dt);
    v.x += (this.wish.x * speed - v.x) * k;
    v.z += (this.wish.z * speed - v.z) * k;

    // --- facing follows movement
    const hs = Math.hypot(v.x, v.z);
    if (hs > 0.3 && amount > 0.05) {
      const target = Math.atan2(v.x, v.z);
      let d = target - ch.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      ch.heading += d * Math.min(1, PHYSICS.turnRate * dt);
      ch.root.rotation.y = ch.heading;
    }

    // --- vertical
    if (ch.grounded && intent.jump) {
      v.y = PHYSICS.jumpSpeed;
      ch.grounded = false;
    }
    if (!ch.grounded) v.y += PHYSICS.gravity * dt;

    p.addScaledVector(v, dt);

    // --- walls: floating capsule
    const r = PHYSICS.capsuleRadius;
    const bottom = PHYSICS.stepHeight + r;
    const top = Math.max(bottom + 0.05, spec.height - r);
    this.segment.start.set(p.x, p.y + bottom, p.z);
    this.segment.end.set(p.x, p.y + top, p.z);
    this.collision.resolveCapsule(this.segment, r, this.correction);
    if (this.correction.lengthSq() > 1e-10) {
      p.x += this.correction.x;
      p.z += this.correction.z;
      if (this.correction.y < -1e-4 && v.y > 0) { p.y += this.correction.y; v.y = 0; } // head bump
      this.horiz.set(this.correction.x, 0, this.correction.z);
      if (this.horiz.lengthSq() > 1e-10) {
        this.horiz.normalize();
        const into = v.x * this.horiz.x + v.z * this.horiz.z;
        if (into < 0) { v.x -= this.horiz.x * into; v.z -= this.horiz.z * into; }
      }
    }

    // --- posts, trunks and street furniture
    const hit = this.props?.resolveCircle(p, r, spec.height, PHYSICS.stepHeight);
    if (hit) {
      const into = v.x * hit.nx + v.z * hit.nz;
      if (into < 0) { v.x -= hit.nx * into; v.z -= hit.nz * into; }
    }

    // --- ground: snap within the step window
    const above = PHYSICS.stepHeight + 0.25;
    const snap = ch.grounded ? PHYSICS.groundSnap : Math.max(0.02, -v.y * dt + 0.02);
    this.probe.set(p.x, p.y + above, p.z);
    const hitY = v.y > 0.01 ? null : this.collision.groundHeight(this.probe, above + snap);
    if (hitY !== null && hitY - p.y <= PHYSICS.stepHeight + 0.02) {
      const rise = hitY - p.y;
      if (ch.grounded && rise > 0.03) ch.stepOffset -= rise;
      p.y = hitY;
      v.y = 0;
      ch.grounded = true;
    } else {
      ch.grounded = false;
    }
    if (p.y < -30) ch.placeAt(spec.spawn, spec.spawnHeading);
    this.lastSpeed = Math.hypot(v.x, v.z);
  }
}
