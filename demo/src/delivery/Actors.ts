import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildPedGeometry, dressRigWith, randomLook, type PedLook } from '../entities/ProceduralPed';
import { ik2, limbsOf, rotateWorld, wpos, type Limbs } from '../entities/Ik';

/**
 * The people of the delivery game: shop staff behind their takeaway windows, other couriers waiting for food, the
 * tower's guard, the customer (and the strangers at the bus stop who are not the customer), kind passers-by.
 * Procedural bodies (ProceduralPed) on the protagonists' Tripo skeleton with the idle / walk / arms-folded clips,
 * dressed from a look preset over a seeded random look, posed with world-space IK on top of the idle:
 *
 *   stand, fold (the idle_fold clip), phone (looking at it), wave, hips (hands on hips), give (one hand out, holding
 *   something), counter (both hands on a counter in front)
 *
 * Actors can walk to a point (straight line), turn to face someone, and say a line in a bubble over their head.
 */
export type Pose = 'stand' | 'fold' | 'phone' | 'wave' | 'hips' | 'give' | 'counter';
type ColourKey = 'skin' | 'hairColor' | 'topColor' | 'bottomColor' | 'shoes' | 'capColor' | 'backpack';
/** A look preset: any PedLook field (colours as '#hex'), plus which rig (0 lean male, 1 female, 2 heavy), scale, seed. */
export type Look = { [K in keyof PedLook]?: K extends ColourKey ? string | THREE.Color | null : PedLook[K] } & { rig?: 0 | 1 | 2; scale?: number; seed?: number };

export interface Actor {
  id: string;
  name: string;
  root: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Record<string, THREE.AnimationAction>;
  limbs: Limbs;
  pose: Pose;
  yaw: number;
  /** turn smoothly toward this yaw */
  wantYaw: number;
  walk: { to: THREE.Vector3; speed: number; done?: () => void } | null;
  bubble: HTMLElement | null;
  bubbleT: number;
  holding: THREE.Object3D | null;
  scale: number;
  /** free for the order logic */
  tag: string;
  gone: boolean;
  /** which voice fits (the recorded lines come as a woman's and a man's) */
  female: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3(), _v = new THREE.Vector3();
const _qa = new THREE.Quaternion();

export class Actors {
  readonly group = new THREE.Group();
  readonly list: Actor[] = [];
  private readonly layer = document.querySelector('#bubbles') as HTMLElement;
  private seq = 0;

  constructor(private readonly rigs: GLTF[]) {
    this.group.name = 'delivery actors';
  }

  spawn(o: { id?: string; name: string; look: Look; pos: THREE.Vector3; yaw: number; pose?: Pose; tag?: string }): Actor {
    let s = o.look.seed ?? (++this.seq * 7919);
    const rng = () => { s = (s * 16807 + 11) % 2147483647; return s / 2147483647; };
    const female = o.look.female ?? rng() < 0.45;
    const k = o.look.rig ?? (female ? 1 : rng() < 0.2 ? 2 : 0);
    const look: PedLook = { ...randomLook(rng, female), female };
    for (const [key, v] of Object.entries(o.look)) {
      if (['rig', 'scale', 'seed', 'female'].includes(key) || v === undefined) continue;
      (look as unknown as Record<string, unknown>)[key] = typeof v === 'string' && /^#/.test(v) ? new THREE.Color(v) : v;
    }
    const model = cloneSkinned(this.rigs[k].scene);
    model.rotation.y = -Math.PI / 2;
    const mesh = dressRigWith(model, (sk) => buildPedGeometry(sk, look));
    mesh.castShadow = true;
    const scale = o.look.scale ?? 0.96 + rng() * 0.08;
    model.scale.multiplyScalar(scale);
    const root = new THREE.Group();
    root.add(model);
    root.position.copy(o.pos);
    root.rotation.y = o.yaw;
    this.group.add(root);
    const mixer = new THREE.AnimationMixer(model);
    const actions: Record<string, THREE.AnimationAction> = {};
    for (const name of ['idle', 'walk', 'idle_fold']) {
      const clip = this.rigs[k].animations.find((c) => c.name === name);
      if (clip) actions[name] = mixer.clipAction(clip);
    }
    actions.idle?.play();
    if (actions.idle) actions.idle.time = rng() * 4;      // the calm first seconds of the Tripo idle
    const a: Actor = {
      id: o.id ?? `actor${this.seq}`, name: o.name, root, model, mixer, actions, limbs: limbsOf(model), pose: o.pose ?? 'stand',
      yaw: o.yaw, wantYaw: o.yaw, walk: null, bubble: null, bubbleT: 0, holding: null, scale, tag: o.tag ?? '', gone: false, female,
    };
    this.setPose(a, a.pose);
    this.list.push(a);
    return a;
  }

  despawn(a: Actor): void {
    if (a.gone) return;
    a.gone = true;
    this.group.remove(a.root);
    a.bubble?.remove();
    if (a.holding) a.holding.removeFromParent();
    const i = this.list.indexOf(a);
    if (i >= 0) this.list.splice(i, 1);
  }

  clear(tag?: string): void { for (const a of [...this.list]) if (!tag || a.tag === tag) this.despawn(a); }

  setPose(a: Actor, pose: Pose): void {
    a.pose = pose;
    const fold = pose === 'fold' && a.actions.idle_fold;
    for (const [n, act] of Object.entries(a.actions)) {
      const on = n === (a.walk ? 'walk' : fold ? 'idle_fold' : 'idle');
      if (on && !act.isRunning()) { act.reset().play(); if (n !== 'walk') act.time = Math.random() * 4; }
      act.setEffectiveWeight(on ? 1 : 0);
    }
  }

  /** Walk in a straight line to `to`, then call done. */
  walkTo(a: Actor, to: THREE.Vector3, speed = 1.3, done?: () => void): void {
    a.walk = { to: to.clone(), speed, done };
    this.setPose(a, a.pose);
  }

  face(a: Actor, p: THREE.Vector3): void {
    a.wantYaw = Math.atan2(p.x - a.root.position.x, p.z - a.root.position.z);
  }

  /** the game voices bubbles (Voice): called with the actor and the line */
  onSay: (a: Actor, text: string) => void = () => {};

  say(a: Actor, text: string, seconds = 3.2): void {
    this.onSay(a, text);
    if (!a.bubble) { a.bubble = document.createElement('div'); a.bubble.className = 'bubble'; this.layer.appendChild(a.bubble); }
    a.bubble.textContent = text;
    a.bubble.hidden = false;
    a.bubbleT = seconds;
  }

  /** Something (a bag) in the actor's right hand, or null to let go. */
  hold(a: Actor, o: THREE.Object3D | null): void {
    if (a.holding && a.holding !== o) a.holding.removeFromParent();
    a.holding = o;
    if (o) this.group.add(o);
  }

  nearest(p: THREE.Vector3, r: number, filter?: (a: Actor) => boolean): Actor | null {
    let best: Actor | null = null, bd = r;
    for (const a of this.list) {
      if (filter && !filter(a)) continue;
      const d = Math.hypot(a.root.position.x - p.x, a.root.position.z - p.z);
      if (d < bd && Math.abs(a.root.position.y - p.y) < 2) { best = a; bd = d; }
    }
    return best;
  }

  update(dt: number, camera: THREE.Camera, w: number, h: number): void {
    const cam = camera.position;
    for (const a of [...this.list]) {
      const far = a.root.position.distanceTo(cam);
      a.root.visible = far < 140;
      // walking
      if (a.walk) {
        const d = _v.subVectors(a.walk.to, a.root.position).setY(0);
        const L = d.length();
        if (L < 0.12) {
          const done = a.walk.done;
          a.walk = null;
          this.setPose(a, a.pose);
          done?.();
        } else {
          a.wantYaw = Math.atan2(d.x, d.z);
          a.root.position.addScaledVector(d.normalize(), Math.min(L, a.walk.speed * dt));
          a.root.position.y += (a.walk.to.y - a.root.position.y) * Math.min(1, dt * 6);
          const w0 = a.actions.walk;
          if (w0) w0.timeScale = a.walk.speed / 1.3;
        }
      }
      let dy = a.wantYaw - a.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      a.yaw += dy * Math.min(1, dt * 6);
      a.root.rotation.y = a.yaw;
      if (!a.root.visible) { a.bubble && (a.bubble.hidden = true); continue; }
      a.mixer.update(dt);
      a.root.updateMatrixWorld(true);
      if (!a.walk) this.applyPose(a);
      // what's in the hand hangs from it, upright
      if (a.holding) {
        const hand = wpos(a.limbs.hand[1], _p);
        a.holding.position.set(hand.x, hand.y - 0.3, hand.z);
        a.holding.rotation.set(0, a.yaw, 0);
      }
      // the bubble over the head
      if (a.bubble) {
        a.bubbleT -= dt;
        const head = a.limbs.head ? wpos(a.limbs.head, _q).setY(_q.y + 0.45) : _q.copy(a.root.position).setY(a.root.position.y + 2.1);
        const v = head.project(camera);
        const vis = a.bubbleT > 0 && v.z < 1 && far < 40;
        a.bubble.hidden = !vis;
        if (vis) a.bubble.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
      }
    }
  }

  private applyPose(a: Actor): void {
    const L = a.limbs;
    if (a.pose === 'stand' || a.pose === 'fold') return;
    _f.set(Math.sin(a.yaw), 0, Math.cos(a.yaw));
    _r.set(-Math.cos(a.yaw), 0, Math.sin(a.yaw));
    const t = performance.now() / 1000;
    // L_ is the character's left: side -1 = left (-_r), +1 = right (+_r)
    for (let k = 0; k < 2; k++) {
      const side = k === 0 ? -1 : 1;
      const sh = wpos(L.upper[k], new THREE.Vector3());
      const l1 = sh.distanceTo(wpos(L.fore[k], _p)), l2 = _p.distanceTo(wpos(L.hand[k], _q));
      let target: THREE.Vector3 | null = null, pole: THREE.Vector3 | null = null;
      if (a.pose === 'phone' && k === 1) {
        target = sh.clone().addScaledVector(UP, -0.88 * l1 + 0.4 * l2).addScaledVector(_f, 0.3 * l1 + 0.85 * l2).addScaledVector(_r, -0.5 * l2);
        pole = _v.set(0, -1, 0).addScaledVector(_r, 0.4).clone();
      } else if (a.pose === 'wave' && k === 1) {
        target = sh.clone().addScaledVector(UP, l1 * 0.6 + l2 * 0.8).addScaledVector(_r, 0.18 + Math.sin(t * 7) * 0.12).addScaledVector(_f, 0.1);
        pole = _v.copy(_r).addScaledVector(UP, -0.5).clone();
      } else if (a.pose === 'hips') {
        target = sh.clone().addScaledVector(UP, -(l1 + l2) * 0.78).addScaledVector(_r, side * 0.2 * a.scale).addScaledVector(_f, 0.02);
        pole = _v.copy(_r).multiplyScalar(side).addScaledVector(_f, -0.4).clone();
      } else if (a.pose === 'give' && k === 1) {
        target = sh.clone().addScaledVector(UP, -l1 * 0.35).addScaledVector(_f, (l1 + l2) * 0.85).addScaledVector(_r, -0.05);
        pole = _v.set(0, -1, 0).addScaledVector(_r, 0.5).clone();
      } else if (a.pose === 'counter') {
        target = sh.clone().addScaledVector(UP, -(l1 + l2) * 0.55).addScaledVector(_f, (l1 + l2) * 0.7).addScaledVector(_r, side * 0.12);
        pole = _v.set(0, -1, 0).addScaledVector(_r, side * 0.6).clone();
      }
      if (target && pole) ik2(L.upper[k], L.fore[k], L.hand[k], target, pole);
    }
    if (a.pose === 'phone' && L.head) rotateWorld(L.head, _qa.setFromAxisAngle(_v.copy(_r).negate(), 0.38));
  }
}

/** Outfit presets for the regulars and the trades. */
export const LOOKS = {
  chef: { top: 'tee', topColor: '#f4f4ef', bottom: 'pants', bottomColor: '#2a2a2a', hair: 'cap', capColor: '#f4f4ef' } as Look,
  staff: { top: 'tee', topColor: '#1f2d4a', bottom: 'pants', bottomColor: '#2a2a2a', hair: 'cap', capColor: '#e4664e' } as Look,
  teaStaff: { top: 'tee', topColor: '#f3e2c8', bottom: 'pants', bottomColor: '#3b2a1e', hair: 'cap', capColor: '#3b2a1e' } as Look,
  clerk: { top: 'tee', topColor: '#d0282e', bottom: 'pants', bottomColor: '#2a2a2a' } as Look,
  guard: { top: 'long', topColor: '#1d2733', bottom: 'pants', bottomColor: '#1d2733', hair: 'cap', capColor: '#1d2733', female: false } as Look,
  courier: { top: 'long', topColor: '#c6f03c', bottom: 'pants', bottomColor: '#1b1d1f', hair: 'cap', capColor: '#c6f03c', female: false } as Look,
  rival: { top: 'long', topColor: '#f08a24', bottom: 'pants', bottomColor: '#1b1d1f', hair: 'cap', capColor: '#f08a24', female: false } as Look,
  boss: { top: 'long', topColor: '#f4f4f0', bottom: 'pants', bottomColor: '#1c1c1c', hair: 'bald', build: 1.22, female: false, rig: 2 } as Look,
  auntie: { top: 'tee', topColor: '#b04a5a', bottom: 'pants', bottomColor: '#232323', hair: 'short', hairColor: '#7c7c7c', female: true } as Look,
  influencer: { top: 'tee', topColor: '#e8a3b5', bottom: 'skirt', bottomColor: '#f4f1ea', hair: 'long', sunglasses: true, female: true } as Look,
};
