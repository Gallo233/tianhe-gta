import * as THREE from 'three';
import { GZ } from './Materials';
import type { LampLights } from './LampLights';

/**
 * Real light from the street lamps nearest the camera. 6,800 lamp heads exist; a fixed pool of light
 * slots (LampLights: uniform arrays in every lit material, so no shader ever recompiles) is handed to the
 * lamps closest to a point just ahead of the camera. Slots are sticky -- a lamp keeps its light while it
 * stays in the set -- and intensity fades with distance, so the lights that change hands are the dim
 * ones at the edge. Inside that radius the road shaders' painted lamp pools fade out (GZ.uLampNear).
 */
export const POOL = 14;       // slots 0..13 (14, 15 are the player's headlights)
const REACH = 95;           // candidates within this distance of the focus
const FADE_NEAR = 45;       // full intensity inside, zero at REACH
const CANDELA = 520;        // at 10.8 m: ~4.5 lux-ish irradiance, the level of the painted pools

const COLOR = new THREE.Color('#ffd6a8');
const RANGE = 34;

export class NightLights {
  readonly group = new THREE.Group();
  private readonly intensity: number[] = [];
  private readonly slotLamp: number[] = [];
  private readonly focus = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private t = 0;
  night = 0;

  constructor(private readonly lamps: THREE.Vector3[], private readonly out: LampLights) {
    this.group.name = 'night-lights';
    for (let i = 0; i < POOL; i++) { this.intensity.push(0); this.slotLamp.push(-1); }
  }

  update(dt: number, camera: THREE.Camera, night: number): void {
    this.night = night;
    GZ.uLampNear.value = night > 0.02 ? 0 : 1;   // painted pools stand in until the real lights are up
    this.t -= dt;
    camera.getWorldDirection(this.fwd);
    this.fwd.y = 0; this.fwd.normalize();
    this.focus.copy(camera.position).addScaledVector(this.fwd, 18);
    if (this.t <= 0) { this.t = 0.2; this.assign(); }
    for (let i = 0; i < POOL; i++) {
      const k = this.slotLamp[i];
      if (k < 0 || night < 0.02) { this.intensity[i] = 0; this.out.off(i); continue; }
      const d = this.lamps[k].distanceTo(this.focus);
      const target = CANDELA * night * THREE.MathUtils.smoothstep(REACH - d, 0, REACH - FADE_NEAR);
      this.intensity[i] += (target - this.intensity[i]) * Math.min(1, dt * 6);
      this.out.point(i, this.lamps[k], COLOR, this.intensity[i], RANGE);
    }
  }

  private assign(): void {
    const f = this.focus;
    const r2 = REACH * REACH;
    const near: { k: number; d: number }[] = [];
    for (let k = 0; k < this.lamps.length; k++) {
      const p = this.lamps[k];
      const dx = p.x - f.x, dz = p.z - f.z;
      const d = dx * dx + dz * dz;
      if (d < r2) near.push({ k, d });
    }
    near.sort((a, b) => a.d - b.d);
    const want = new Set(near.slice(0, POOL).map((n) => n.k));
    // keep sticky slots, free the rest, then fill free slots with the new lamps
    for (let i = 0; i < POOL; i++) if (!want.has(this.slotLamp[i])) this.slotLamp[i] = -1;
    const have = new Set(this.slotLamp);
    for (const k of want) {
      if (have.has(k)) continue;
      const i = this.slotLamp.indexOf(-1);
      if (i < 0) break;
      this.slotLamp[i] = k;
      this.intensity[i] = 0;
    }
  }
}
