import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { CharacterSpec } from '../config';

type Clip = 'idle' | 'walk' | 'run' | 'jump';
const CLIPS: Clip[] = ['idle', 'walk', 'run', 'jump'];

/**
 * A Tripo character on the shared 41-bone rig. The clips were made in-place in Blender, so the
 * controller moves the root and the clip playback rate follows the actual speed (no foot sliding).
 * The source model faces +X; it is turned to face +Z inside `root`, whose yaw is the heading.
 */
export class Character {
  readonly root = new THREE.Group();
  readonly velocity = new THREE.Vector3();
  heading = 0;
  grounded = true;
  stamina = 1;
  sprinting = false;
  exhausted = false;
  /** Visual-only vertical offset that eases out step-ups onto curbs and stairs. */
  stepOffset = 0;
  readonly model: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = {} as Record<Clip, THREE.AnimationAction>;
  private readonly weights: Record<Clip, number> = { idle: 1, walk: 0, run: 0, jump: 0 };
  private lastGait: Clip = 'idle';
  /** Seconds: when set, the idle clip ping-pongs inside its first `idleWindow` seconds (the Tripo idle shifts its
   *  weight 0.21 m sideways from ~5 s on, which throws a seated, IK-posed body off its seat and grips). */
  idleWindow: number | null = null;
  private idleClock = 0;

  constructor(readonly spec: CharacterSpec, gltf: GLTF) {
    const model = gltf.scene;
    this.model = model;
    model.rotation.y = -Math.PI / 2;
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        const mat = m.material as THREE.MeshStandardMaterial;
        // Tripo's metal channel is noise on skin and cloth (specks up to 0.9 on the face) and its roughness runs
        // glossy (skin ~0.47): together the faces read as bronze. No metal, everything rougher (skin ~0.75).
        mat.metalness = 0;
        mat.roughness = 1.6;
        mat.envMapIntensity = 0.6;
      }
    });
    this.root.add(model);
    this.root.name = spec.key;
    this.mixer = new THREE.AnimationMixer(model);
    for (const name of CLIPS) {
      const clip = gltf.animations.find((c) => c.name === name);
      if (!clip) throw new Error(`${spec.key}: missing clip ${name}`);
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveWeight(this.weights[name]);
      action.play();
      this.actions[name] = action;
    }
    this.placeAt(spec.spawn, spec.spawnHeading);
  }

  placeAt(position: THREE.Vector3, heading: number): void {
    this.root.position.copy(position);
    this.heading = heading;
    this.root.rotation.y = heading;
    this.velocity.set(0, 0, 0);
    this.grounded = true;
  }

  /** Blend idle / walk / run / air from the horizontal speed actually achieved this frame. */
  animate(dt: number): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const { walkSpeed, runSpeed } = this.spec;
    let target: Clip;
    if (!this.grounded) target = 'jump';
    else if (speed < 0.2) target = 'idle';
    else if (speed < (walkSpeed + runSpeed) * 0.42) target = 'walk';
    else target = 'run';
    if (target !== this.lastGait && (target === 'walk' || target === 'run') && (this.lastGait === 'walk' || this.lastGait === 'run')) {
      // keep foot phase when changing gait so the blend does not scissor the legs
      const from = this.actions[this.lastGait];
      const to = this.actions[target];
      to.time = (from.time / from.getClip().duration) * to.getClip().duration;
    }
    this.lastGait = target;
    const rate = target === 'jump' ? 14 : 7;
    for (const c of CLIPS) {
      const goal = c === target ? 1 : 0;
      this.weights[c] += (goal - this.weights[c]) * Math.min(1, dt * rate);
      this.actions[c].setEffectiveWeight(this.weights[c]);
    }
    if (this.idleWindow) {
      const w = this.idleWindow;
      this.idleClock = (this.idleClock + dt) % (2 * w);
      this.actions.idle.time = this.idleClock < w ? this.idleClock : 2 * w - this.idleClock;
    }
    this.actions.walk.timeScale = THREE.MathUtils.clamp(speed / walkSpeed, 0.6, 1.8);
    this.actions.run.timeScale = THREE.MathUtils.clamp(speed / runSpeed, 0.7, 1.6);
    this.mixer.update(dt);
    this.stepOffset *= Math.exp(-dt * 14);
    this.model.position.y = this.stepOffset;
  }

  /** The idle clip's first keyframe for a track (e.g. 'Hip.position'): a neutral value to pin a bone to. */
  idleStart(track: string): number[] | null {
    const t = this.actions.idle.getClip().tracks.find((k) => k.name === track);
    return t ? Array.from(t.values.slice(0, t.getValueSize())) : null;
  }

  /** Freeze on a representative frame (screenshots). */
  freeze(): void {
    this.mixer.setTime(0.5);
  }
}
