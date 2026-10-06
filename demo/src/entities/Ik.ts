import * as THREE from 'three';

/**
 * World-space posing on top of whatever the animation mixer left in the bones (the Tripo rig's bone axes are
 * not something to rely on): aim a bone so its child joint lies on a line, and two-bone IK for limbs. The
 * skeleton's world matrices must be current (root.updateMatrixWorld(true)) before the first call; every call
 * updates the bones it moves and their children.
 *
 * Used by the APM passengers (sitting, phones, grab rails) and Ah Jie on his e-bike.
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _e = new THREE.Vector3();
const _n = new THREE.Vector3(), _t = new THREE.Vector3(), _p = new THREE.Vector3(), _v = new THREE.Vector3();
const _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _s = new THREE.Vector3();

export const wpos = (o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 => out.setFromMatrixPosition(o.matrixWorld);

/** Turn `bone` (world space) so the point `child` (its child joint, world) moves onto the line to `target`. */
export function aimBone(bone: THREE.Bone, child: THREE.Vector3, target: THREE.Vector3, weight = 1): void {
  wpos(bone, _a);
  _n.subVectors(child, _a).normalize();
  _t.subVectors(target, _a).normalize();
  if (_n.lengthSq() < 0.5 || _t.lengthSq() < 0.5) return;
  _q.setFromUnitVectors(_n, _t);
  if (weight < 1) _q.slerp(_pq.identity(), 1 - weight);
  bone.matrixWorld.decompose(_v, _wq, _s);
  bone.parent!.matrixWorld.decompose(_v, _pq, _s);
  bone.quaternion.copy(_pq.invert().multiply(_q.multiply(_wq)));
  bone.updateMatrixWorld(true);
}

/** Rotate a bone in world space by `q` (applied on top of its current world orientation). */
export function rotateWorld(bone: THREE.Bone, q: THREE.Quaternion): void {
  bone.matrixWorld.decompose(_v, _wq, _s);
  bone.parent!.matrixWorld.decompose(_v, _pq, _s);
  bone.quaternion.copy(_pq.invert().multiply(_q.copy(q).multiply(_wq)));
  bone.updateMatrixWorld(true);
}

/**
 * Two-bone IK: a -> b -> c reaches for `target`, the middle joint bending towards `pole`. `weight` blends from
 * the animated pose (0) to the full reach (1).
 */
export function ik2(a: THREE.Bone, b: THREE.Bone, c: THREE.Bone, target: THREE.Vector3, pole: THREE.Vector3, weight = 1): void {
  const A = wpos(a, new THREE.Vector3()), B = wpos(b, _b), C = wpos(c, _c);
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
  const tgt = weight < 1 ? C.clone().lerp(target, weight) : target;
  const dv = _p.subVectors(tgt, A);
  let d = dv.length();
  if (d < 1e-4) return;
  const n = dv.divideScalar(d).clone();
  d = THREE.MathUtils.clamp(d, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const pn = pole.clone().addScaledVector(n, -pole.dot(n));
  if (pn.lengthSq() < 1e-6) pn.set(0, 1, 0).addScaledVector(n, -n.y);
  pn.normalize();
  _e.copy(A).addScaledVector(n, x).addScaledVector(pn, h);
  aimBone(a, B, _e);
  wpos(c, _c);
  aimBone(b, _c, A.addScaledVector(n, d));
}

export interface Limbs {
  hips: THREE.Bone | null;
  spine: THREE.Bone[];
  thigh: THREE.Bone[]; calf: THREE.Bone[]; foot: THREE.Bone[];
  upper: THREE.Bone[]; fore: THREE.Bone[]; hand: THREE.Bone[];
  clav: THREE.Bone[];
  head: THREE.Bone | null;
}

/** The limbs of a Tripo-rigged model (L_ / R_ bone names; which side is which is tested in world space). */
export function limbsOf(model: THREE.Object3D): Limbs {
  const b = (n: string) => model.getObjectByName(n) as THREE.Bone;
  return {
    hips: (model.getObjectByName('Pelvis') as THREE.Bone) ?? null,
    spine: ['Waist', 'Spine01', 'Spine02'].map(b).filter(Boolean),
    thigh: [b('L_Thigh'), b('R_Thigh')], calf: [b('L_Calf'), b('R_Calf')], foot: [b('L_Foot'), b('R_Foot')],
    upper: [b('L_Upperarm'), b('R_Upperarm')], fore: [b('L_Forearm'), b('R_Forearm')], hand: [b('L_Hand'), b('R_Hand')],
    clav: [b('L_Clavicle'), b('R_Clavicle')],
    head: (model.getObjectByName('Head') as THREE.Bone) ?? null,
  };
}
