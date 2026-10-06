import * as THREE from 'three';
import { CAMERA } from '../config';
import type { Collision } from '../world/Collision';

/**
 * Over-the-shoulder orbit camera with a spring arm that pulls in when a wall is behind the
 * player, plus a GTA-style character switch: rise into an aerial view, travel, drop back in.
 */
export class CameraRig {
  yaw = 0;
  pitch = -0.18;
  distance = CAMERA.distance;
  private armLength = CAMERA.distance;
  private readonly pivot = new THREE.Vector3();
  private readonly smoothPivot = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private switchT = 1;
  private switchDur = 1.6;
  private readonly from = new THREE.Vector3();
  private readonly fromLook = new THREE.Vector3();
  private readonly lookAt = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly centre = new THREE.Vector3();
  private kick = 0;
  private kickT = 0;

  /** Riding in a moving vehicle (a metro car): the pivot is not smoothed, so the camera never lags out of it. */
  riding = false;

  /** Moving things the static collision does not know about (cars): distance along a ray, or Infinity. */
  occluder: ((origin: THREE.Vector3, dir: THREE.Vector3, max: number) => number) | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera, private readonly collision: Collision) {}

  get switching(): boolean {
    return this.switchT < 1;
  }

  private lookIdle = 10;
  private pivotHeight: number = CAMERA.pivotHeight;
  private shoulder: number = CAMERA.shoulder;
  private extraDistance = 0;

  /** Chase camera: higher, further back, no shoulder offset, and it swings behind the car on its own. */
  updateDriving(target: THREE.Vector3, heading: number, dt: number, speed: number): void {
    this.lookIdle += dt;
    if (this.lookIdle > 0.8 && speed > 1.5) {
      let d = heading - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 2.6);
      this.pitch += (-0.16 - this.pitch) * Math.min(1, dt * 1.5);
    }
    this.pivotHeight = 1.7; this.shoulder = 0; this.extraDistance = 2.2 + Math.min(speed, 30) * 0.06;
    this.update(target, dt, 0);
    this.pivotHeight = CAMERA.pivotHeight; this.shoulder = CAMERA.shoulder; this.extraDistance = 0;
  }

  /**
   * Riding the e-bike: lower and closer than a car, the arm stretching a little with speed, swinging in behind
   * the heading when the mouse is left alone (quicker than for a car: bikes turn sharply).
   */
  updateRiding(target: THREE.Vector3, heading: number, dt: number, speed: number): void {
    this.lookIdle += dt;
    if (this.lookIdle > 0.6 && speed > 1.2) {
      let d = heading - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * Math.min(1, dt * 4.2);
      this.pitch += (-0.12 - this.pitch) * Math.min(1, dt * 1.5);
    }
    this.pivotHeight = 1.4; this.shoulder = 0; this.extraDistance = -0.7 + Math.min(speed, 15) * 0.075;
    this.update(target, dt, 0);
    this.pivotHeight = CAMERA.pivotHeight; this.shoulder = CAMERA.shoulder; this.extraDistance = 0;
  }

  /** Following a thrown rider (target = the body's centre): a low pivot, a little further out, looking down. */
  updateThrown(target: THREE.Vector3, dt: number): void {
    this.lookIdle += dt;
    if (this.lookIdle > 0.6) this.pitch += (-0.3 - this.pitch) * Math.min(1, dt * 2);
    this.pivotHeight = 0.6; this.shoulder = 0; this.extraDistance = 0.6;
    this.update(target, dt, 0);
    this.pivotHeight = CAMERA.pivotHeight; this.shoulder = CAMERA.shoulder; this.extraDistance = 0;
  }

  /** A short jolt (0..1): landings, heavy hits. */
  shake(amount: number): void {
    this.kick = Math.max(this.kick, amount);
  }

  addLook(dx: number, dy: number): void {
    if (dx || dy) this.lookIdle = 0;
    this.yaw -= dx * 0.0024;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.002, CAMERA.minPitch, CAMERA.maxPitch);
  }

  zoom(steps: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + steps * 0.6, CAMERA.minDistance, CAMERA.maxDistance);
  }

  snap(target: THREE.Vector3, heading: number): void {
    this.yaw = heading + Math.PI;
    this.smoothPivot.copy(target).y += CAMERA.pivotHeight;
    this.armLength = this.distance;
    this.update(target, 1 / 60, 0);
  }

  /** Start the aerial switch toward a new character (keeps the current view as the start). */
  beginSwitch(heading: number): void {
    this.from.copy(this.camera.position);
    this.fromLook.copy(this.lookAt);
    this.yaw = heading + Math.PI;
    this.switchT = 0;
  }

  update(target: THREE.Vector3, dt: number, speed: number): void {
    this.pivot.copy(target).y += this.pivotHeight;
    const follow = 1 - Math.exp(-dt * 12);
    if (this.riding) this.smoothPivot.copy(this.pivot);
    else this.smoothPivot.lerp(this.pivot, follow);
    // a touch further out when running reads speed without an FOV lurch
    const dist = this.distance + this.extraDistance + Math.min(speed, 7) * 0.12;
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp).normalize();
    this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const shoulderPivot = this.tmp.copy(this.smoothPivot).addScaledVector(this.right, this.shoulder);
    // spring arm: shorten instantly on hit, relax back slowly
    // two rays: from the shoulder pivot, and from the character's centre line toward the camera,
    // so a trunk or post between the body and the lens also pulls the camera in
    const hitShoulder = this.collision.raycastDistance(shoulderPivot, this.dir, dist + 0.3);
    this.centre.copy(this.smoothPivot).addScaledVector(this.right, this.shoulder * 0.35);
    const hitCentre = this.collision.raycastDistance(this.centre, this.dir, dist + 0.3);
    let hit = Math.min(hitShoulder, hitCentre);
    if (this.occluder) hit = Math.min(hit, this.occluder(shoulderPivot, this.dir, dist + 0.3), this.occluder(this.centre, this.dir, dist + 0.3));
    const allowed = Math.max(0.35, Math.min(dist, hit - 0.3));
    this.armLength = allowed < this.armLength ? allowed : this.armLength + (allowed - this.armLength) * (1 - Math.exp(-dt * 3));
    this.desired.copy(shoulderPivot).addScaledVector(this.dir, this.armLength);
    this.lookAt.copy(shoulderPivot).addScaledVector(this.dir, -6);

    if (this.switchT < 1) {
      this.switchT = Math.min(1, this.switchT + dt / this.switchDur);
      const t = this.switchT;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lift = Math.sin(Math.PI * t) * Math.max(40, this.from.distanceTo(this.desired) * 0.45);
      this.camera.position.lerpVectors(this.from, this.desired, e).y += lift;
      const look = this.tmp.lerpVectors(this.fromLook, this.lookAt, e);
      this.camera.lookAt(look);
      return;
    }
    this.camera.position.copy(this.desired);
    this.camera.lookAt(this.lookAt);
    if (this.kick > 0.01) {
      this.kickT += dt;
      const k = this.kick * 0.22;
      this.camera.position.y += Math.sin(this.kickT * 47) * k;
      this.camera.position.addScaledVector(this.right, Math.sin(this.kickT * 31 + 1.3) * k * 0.6);
      this.kick *= Math.exp(-dt * 7);
    }
  }
}
