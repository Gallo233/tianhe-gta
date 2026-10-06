import * as THREE from 'three';
import { fromBlender } from '../config';
import type { Apm } from './Apm';
import type { LampLights } from './LampLights';
import { POOL } from './NightLights';

/**
 * Real light from the APM tunnel wall lamps (apm.json 'lamps', one every 10 m on the outer wall of each bore).
 * Underground the street-lamp slots of LampLights are free (and must be: the lamps above would light the station
 * through the slab -- those lights have no shadows), so while the camera is below ground this owns slots
 * 0..POOL-1: in a tunnel, the lamps of the camera's own bore within REACH light the concrete in pools and pick
 * out the train as it passes each one; in a station, entrance hall or passage, nothing.
 */
const REACH = 55;
const FADE = 38;             // full intensity inside, zero at REACH
const CANDELA = 38;
const RANGE = 10;
const COLOR = new THREE.Color('#d8fff6');

export class ApmTunnelLights {
  private readonly lamps: THREE.Vector3[] = [];
  private readonly bore: number[] = [];                // 0 west track, 1 east
  private readonly k: number[] = new Array(POOL).fill(0);
  private readonly slot: number[] = new Array(POOL).fill(-1);
  private tunnel = 0;                                  // 0..1, eased

  constructor(private readonly apm: Apm, private readonly out: LampLights) {
    const tr = [apm.data.tracks.west, apm.data.tracks.east];
    for (const l of apm.data.lamps ?? []) {
      this.lamps.push(fromBlender(l[0], l[1], l[2]));
      let best = 0, bd = Infinity;
      tr.forEach((t, i) => { for (let j = 0; j < t.length; j += 3) { const d = (t[j][0] - l[0]) ** 2 + (t[j][1] - l[1]) ** 2; if (d < bd) { bd = d; best = i; } } });
      this.bore.push(best);
    }
  }

  /** The camera's bore (0 west, 1 east) if it is in a tunnel (not in a station box), else -1. */
  private boreAt(p: THREE.Vector3): number {
    const bx = p.x, by = -p.z;
    const F = this.apm.F, L = this.apm.L;
    if (p.y > L.rail + L.tunnel_h + 1) return -1;
    for (const st of this.apm.stations) {
      const [u, v] = this.apm.toFrame(st, bx, by);
      if (Math.abs(u) < F.box_u + 0.5 && Math.abs(v) < Math.max(F.conc_v, F.box_v) + 0.5) return -1;
    }
    let best = -1, bd = (L.tunnel_w * 0.8) ** 2;
    [this.apm.data.tracks.west, this.apm.data.tracks.east].forEach((t, i) => {
      for (let j = 0; j < t.length; j += 2) { const d = (t[j][0] - bx) ** 2 + (t[j][1] - by) ** 2; if (d < bd) { bd = d; best = i; } }
    });
    return best;
  }

  /** under: how far below ground the camera is (Game's underK); below 0.5 the street lamps keep the slots. */
  update(dt: number, camera: THREE.Camera, under: number): void {
    if (under < 0.5) { this.tunnel = 0; this.slot.fill(-1); return; }
    const cam = camera.position;
    const bore = this.boreAt(cam);
    this.tunnel += ((bore >= 0 ? 1 : 0) - this.tunnel) * Math.min(1, dt * 5);
    // the nearest lamps of this bore, sticky so a lamp keeps its slot while it stays in the set
    const want: number[] = [];
    if (bore >= 0) {
      const near: { i: number; d: number }[] = [];
      this.lamps.forEach((p, i) => { if (this.bore[i] === bore) { const d = p.distanceTo(cam); if (d < REACH) near.push({ i, d }); } });
      near.sort((a, b) => a.d - b.d);
      for (const n of near.slice(0, POOL)) want.push(n.i);
    }
    for (let s = 0; s < POOL; s++) if (!want.includes(this.slot[s])) this.slot[s] = -1;
    for (const i of want) {
      if (this.slot.includes(i)) continue;
      const s = this.slot.indexOf(-1);
      if (s < 0) break;
      this.slot[s] = i; this.k[s] = 0;
    }
    for (let s = 0; s < POOL; s++) {
      const i = this.slot[s];
      if (i < 0 || this.tunnel < 0.01) { this.out.off(s); continue; }
      const d = this.lamps[i].distanceTo(cam);
      const target = CANDELA * this.tunnel * THREE.MathUtils.smoothstep(REACH - d, 0, REACH - FADE);
      this.k[s] += (target - this.k[s]) * Math.min(1, dt * 8);
      this.out.point(s, this.lamps[i], COLOR, this.k[s], RANGE);
    }
  }
}
