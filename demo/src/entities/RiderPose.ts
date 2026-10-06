import * as THREE from 'three';
import type { Character } from './Character';
import { bl, type EBike } from './EBike';
import { aimBone, ik2, limbsOf, rotateWorld, wpos, type Limbs } from './Ik';

/**
 * A character on the e-bike, posed over its idle clip (so breathing and small motions stay):
 *
 *   seated     the root follows the bike (heading, pitch, lean) with the hip joint on the seat; feet on the
 *              footboard, hands on the grips (which turn with the bars), a slight forward lean that grows with
 *              the throttle; the head holds against the lean and looks into the turn
 *   foot down  stopped, the left foot reaches the ground beside the bike (`foot` 0..1)
 *   mounting   `mount` 0 = standing on the bike's left, facing forward .. 1 = seated; the root swings over the
 *              seat on an arc and the limbs blend to their holds
 *
 * Call after Character.animate() each frame.
 */
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qs = new THREE.Quaternion();
const YAW_PI = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const smooth = (x: number) => x * x * (3 - 2 * x);

export class RiderPose {
  private readonly limbs: Limbs;
  /** hip joint height above the feet, standing */
  readonly hipH: number;
  /** which side of the bike each leg / arm (index as in Limbs: L_, R_) belongs on: -1 left, +1 right. From the bone
   *  names, never from positions: the Tripo idle slides the hips 0.21 m sideways, and a side measured then puts
   *  both legs (or both hands) on the same side. */
  private readonly legSide = [-1, 1];
  private readonly armSide = [-1, 1];
  /** the Tripo idle shifts its weight 0.21 m sideways for 8 of its 17.6 s: on the seat the hips stay put */
  private readonly hip: THREE.Object3D | null;
  private readonly hipPos: THREE.Vector3 | null = null;
  private readonly hipQuat: THREE.Quaternion | null = null;

  constructor(private readonly ch: Character) {
    this.limbs = limbsOf(ch.model);
    ch.root.updateMatrixWorld(true);
    this.hipH = wpos(this.limbs.thigh[0], _p).y - ch.root.position.y;
    this.hip = ch.model.getObjectByName('Hip') ?? null;
    const hp = ch.idleStart('Hip.position'), hq = ch.idleStart('Hip.quaternion');
    if (hp) this.hipPos = new THREE.Vector3().fromArray(hp);
    if (hq) this.hipQuat = new THREE.Quaternion().fromArray(hq);
  }

  /** Where the character stands to get on (world), and its heading. */
  besidePoint(bike: EBike, out: THREE.Vector3): THREE.Vector3 {
    return bike.obj.localToWorld(out.set(-0.62, 0, 0.12)).setY(bike.obj.position.y);
  }

  apply(bike: EBike, mount: number, foot: number, throttle: number, lean: number, steer: number, groundY: number): void {
    const ch = this.ch, L = this.limbs, spec = bike.spec;
    const m = smooth(THREE.MathUtils.clamp(mount, 0, 1));
    bike.obj.updateMatrixWorld(true);
    // --- root: from standing beside the bike to sitting on it
    // on the front of the seat (the box is behind): the Tripo arms are short (0.37 m), the grips have to be in reach
    const seatLocal = bl([0, spec.seat[1] + 0.09, spec.seat_top + 0.08], _p);
    seatLocal.y -= this.hipH;
    const seatW = bike.obj.localToWorld(seatLocal.clone());
    const standW = this.besidePoint(bike, _q);
    bike.obj.getWorldQuaternion(_qa).multiply(YAW_PI);
    _qb.setFromAxisAngle(_u.set(0, 1, 0), bike.obj.rotation.y + Math.PI);
    ch.root.position.lerpVectors(standW, seatW, m);
    ch.root.position.y += Math.sin(Math.PI * m) * 0.18;                 // swing the leg over
    ch.root.quaternion.slerpQuaternions(_qb, _qa, m);
    if (this.hip && this.hipPos) this.hip.position.lerp(this.hipPos, m);
    if (this.hip && this.hipQuat) this.hip.quaternion.slerp(this.hipQuat, m);
    ch.root.updateMatrixWorld(true);
    if (m < 0.02) return;
    // bike axes (world)
    _f.set(0, 0, -1).transformDirection(bike.obj.matrixWorld);
    _r.set(1, 0, 0).transformDirection(bike.obj.matrixWorld);
    _u.set(0, 1, 0).transformDirection(bike.obj.matrixWorld);
    // --- a forward lean (more on the throttle) over two spine joints, before the limbs
    // (and over the bars at full lock: the far grip swings 0.2 m forward at walking pace)
    const lean0 = (0.13 + 0.05 * Math.max(0, throttle) + 0.3 * Math.abs(steer)) * m;
    for (const sb of L.spine.slice(0, 2)) rotateWorld(sb, _qs.setFromAxisAngle(_r, -lean0));
    // the shoulders turn with the bars (at walking pace the lock is large and the far grip swings away)
    if (L.spine[2]) rotateWorld(L.spine[2], _qs.setFromAxisAngle(_u, steer * 0.9 * m));
    // --- legs: feet on the footboard; the left one down to the ground when stopped
    for (let k = 0; k < 2; k++) {
      const side = this.legSide[k];
      // feet toward the outer edges of the footboard, knees out over them: a straddle, not knees together
      const onBoard = bike.obj.localToWorld(bl(spec.feet[side < 0 ? 0 : 1], _p).clone());
      onBoard.addScaledVector(_u, 0.07).addScaledVector(_f, -0.02).addScaledVector(_r, side * 0.05);
      let target = onBoard;
      if (side < 0 && foot > 0) {
        const down = bike.obj.localToWorld(bl(spec.foot_down, _q).clone());
        down.y = groundY + 0.08;
        target = onBoard.clone().lerp(down, smooth(foot));
      }
      const pole = _f.clone().multiplyScalar(1).addScaledVector(_u, 0.45).addScaledVector(_r, side * 0.55);
      ik2(L.thigh[k], L.calf[k], L.foot[k], target, pole, m);
    }
    // --- arms: hands on the grips (they turn with the bars); elbows out and down. The wrist goes a little inboard
    // of the grip so the palm lies over it; when the arm is still short the collarbone reaches forward.
    for (let k = 0; k < 2; k++) {
      const side = this.armSide[k];
      const grip = bike.grip(side < 0 ? 0 : 1, new THREE.Vector3());
      grip.addScaledVector(_f, -0.02).addScaledVector(_r, -side * 0.05).addScaledVector(_u, 0.01);
      const sh = wpos(L.upper[k], new THREE.Vector3());
      const reach = (wpos(L.fore[k], _q).distanceTo(sh) + wpos(L.hand[k], _q).distanceTo(wpos(L.fore[k], _p))) * 0.98;
      const short = sh.distanceTo(grip) - reach;
      if (short > 0 && L.clav[k]) {
        const to = grip.clone().sub(sh).normalize().multiplyScalar(Math.min(short, 0.17) * m).add(sh);
        aimBone(L.clav[k], sh, to);
      }
      const pole = _f.clone().multiplyScalar(-0.6).addScaledVector(_r, side * 0.7).addScaledVector(_u, -0.5);
      ik2(L.upper[k], L.fore[k], L.hand[k], grip, pole, m);
    }
    // --- head: holds against the lean, looks into the turn
    if (L.head) {
      rotateWorld(L.head, _qs.setFromAxisAngle(_f, lean * 0.45 * m));
      rotateWorld(L.head, _qs.setFromAxisAngle(_u, steer * 0.7 * m));
    }
  }
}
