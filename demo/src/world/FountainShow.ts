import * as THREE from 'three';
import { fromBlender } from '../config';
import { GZ } from './Materials';
import { fogUniforms } from './Sky';

/**
 * 花城广场's music fountain (gz_north -> huacheng.json 'north.fountain'): the shows over its 22 x 90 m basin, after the
 * 2013 photographs (a line of jets tens of metres high down the middle, rows of lower jets, arcs leaning in).
 *
 *   tall   15 jets down the middle, up to 42 m          mid   58 in two rows, up to 13 m
 *   arc    40 leaning in from the long sides, 7 m high   fog   18 foggers across the ends
 *
 * Each jet is drawn as an instance: a column (or a parabola for the arcs) whose height follows the show with the
 * inertia of water (it rises in a second, falls back a little slower), a spray cap and a ring of white water where it
 * meets the surface. At night underwater lights colour every jet, the colour running along the basin.
 *
 * Shows (the game clock runs a minute a second): at night one long show 19:30-22:30, by day short ones at 12:00, 15:00
 * and 17:00 (forty seconds each). A show is a sequence of moves -- a wave down the basin, a chase, everyone on the
 * beat, odd and even jets in turn, the crown, the finale -- each ~14 s, blended into the next.
 * `force(seconds)` starts one now (QA, screenshots).
 */
interface FountainJson { basin: number[]; water_z: number; rim_h: number; nozzles: [number, number, string, number][] }
type Kind = 'tall' | 'mid' | 'arc' | 'fog';
interface Jet { x: number; y: number; kind: Kind; lean: number; i: number; n: number; h: number }

const HMAX: Record<Kind, number> = { tall: 42, mid: 13, arc: 7, fog: 2.6 };
const WINDOWS: [number, number][] = [[12.0, 12.67], [15.0, 15.67], [17.0, 17.67], [19.5, 22.5]];
const MOVE_S = 14;

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

export class FountainShow {
  readonly group = new THREE.Group();
  private readonly jets: Jet[] = [];
  private readonly cols: THREE.InstancedMesh;
  private readonly caps: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly aH: THREE.InstancedBufferAttribute[] = [];
  private readonly aC: THREE.InstancedBufferAttribute[] = [];
  private readonly uNightK = { value: 0 };
  private t = 0;
  private forced = 0;
  /** 0 idle .. 1 a show running (jets in the air); level of the water noise for Sfx */
  power = 0;
  running = false;
  readonly centre: THREE.Vector3;

  constructor(readonly data: FountainJson) {
    this.group.name = 'music fountain';
    const kinds: Kind[] = ['tall', 'mid', 'arc', 'fog'];
    for (const k of kinds) {
      const list = data.nozzles.filter((n) => n[2] === k);
      list.forEach(([x, y, , lean], i) => this.jets.push({ x, y, kind: k, lean, i, n: list.length, h: 0 }));
    }
    const [x0, y0, x1, y1] = data.basin;
    this.centre = fromBlender((x0 + x1) / 2, (y0 + y1) / 2, data.water_z);
    const n = this.jets.length;
    // ---- columns / arcs: an open cylinder, y 0..1 bent and scaled per instance in the vertex shader
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 10, 18, true);
    cyl.translate(0, 0.5, 0);
    this.cols = this.instanced(cyl, n, 'cols', this.colMaterial());
    // ---- spray caps: camera-facing quads at the top of every jet
    this.caps = this.instanced(new THREE.PlaneGeometry(1, 1), n, 'caps', this.capMaterial());
    // ---- white water where the jets meet the surface (and the coloured light under them at night)
    const ring = new THREE.PlaneGeometry(1, 1); ring.rotateX(-Math.PI / 2);
    this.rings = this.instanced(ring, n, 'rings', this.ringMaterial());
    this.jets.forEach((j, k) => {
      _p.copy(fromBlender(j.x, j.y, data.water_z + 0.01));
      _m.compose(_p, _q.identity(), _s.set(1, 1, 1));
      for (const im of [this.cols, this.caps, this.rings]) im.setMatrixAt(k, _m);
    });
    for (const im of [this.cols, this.caps, this.rings]) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
    // the bounds must cover the jets at full height
    const bs = new THREE.Sphere(this.centre.clone().setY(this.centre.y + 20), 60);
    for (const im of [this.cols, this.caps, this.rings]) im.boundingSphere = bs;
  }

  private instanced(geo: THREE.BufferGeometry, n: number, name: string, mat: THREE.Material): THREE.InstancedMesh {
    const aH = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);       // height, lean (m), width, kind
    const aC = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);       // light colour
    aH.setUsage(THREE.DynamicDrawUsage); aC.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aJet', aH); geo.setAttribute('aCol', aC);
    this.aH.push(aH); this.aC.push(aC);
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.name = 'fountain ' + name;
    im.frustumCulled = true;
    im.castShadow = false; im.receiveShadow = false;
    im.renderOrder = 2;
    this.group.add(im);
    return im;
  }

  /** Shared preamble: night factor, time, fog. */
  private patch(m: THREE.MeshBasicMaterial, vert: string, vmain: string, frag: string, fmain: string, key: string): THREE.MeshBasicMaterial {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = GZ.uTime; shader.uniforms.uNightK = this.uNightK; fogUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nattribute vec4 aJet; attribute vec3 aCol; uniform float uTime; varying vec3 vCol; varying vec2 vJ; varying float vH;\n${vert}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${vmain}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uTime; uniform float uNightK; varying vec3 vCol; varying vec2 vJ; varying float vH;\n${frag}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${fmain}`);
    };
    m.customProgramCacheKey = () => 'gz-fountain-' + key;
    return m;
  }

  private colMaterial(): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
    return this.patch(m, '', /* glsl */`
      float h = aJet.x, lean = aJet.y, w = aJet.z;
      float t = position.y;
      vH = h; vCol = aCol;
      vJ = vec2(atan(position.x, position.z), t);
      // vertical jets widen as they rise; arcs keep their width and bend over (a parabola to the landing point)
      float r = w * (aJet.w > 1.5 ? 1.0 : (0.55 + 6.0 * t * t * t * t)) * smoothstep(0.0, 0.08, h);
      if (aJet.w > 2.5) {
        transformed = vec3(0.0);                    // foggers: only their mist (caps)
      } else if (aJet.w > 1.5) {
        transformed = vec3(position.x * r + lean * t, 4.0 * h * t * (1.0 - t), position.z * r);
      } else {
        transformed = vec3(position.x * r, h * t, position.z * r);
      }`, /* glsl */`
      float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
      float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }`, /* glsl */`
      if (vH < 0.05) discard;
      // streaks racing up the column, ragged and thinning toward the top
      float s = vnoise(vec2(vJ.x * 3.0, vJ.y * vH * 0.9 - uTime * 7.0)) * 0.6 + vnoise(vec2(vJ.x * 9.0, vJ.y * vH * 2.5 - uTime * 13.0)) * 0.4;
      // dense near the nozzle, a ragged veil where it flares at the top
      float veil = smoothstep(0.6, 1.0, vJ.y);
      float a = mix(0.3 + 0.55 * s, 0.08 + 0.3 * step(0.55, s) * s, veil) * (1.0 - smoothstep(0.9, 1.0, vJ.y)) * smoothstep(0.0, 0.03, vJ.y);
      vec3 water = vec3(0.84, 0.9, 0.96) * (0.72 + 0.35 * s);
      diffuseColor.rgb = mix(water, vCol * (1.4 + 0.8 * s), uNightK);
      diffuseColor.a *= a * mix(0.75, 0.9, uNightK);`, 'col');
  }

  private capMaterial(): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, fog: true });
    // billboard: the quad is laid out in view space round the top of the jet (the arc's crest)
    const mm = this.patch(m, '', /* glsl */`
      vH = aJet.x; vCol = aCol; vJ = uv;`, '', /* glsl */`
      if (vH < 0.3) discard;
      vec2 d = vJ - 0.5;
      float r = length(d) * 2.0;
      vec2 q = vJ * 7.0 + vec2(0.0, uTime * 0.6);
      vec2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
      float h00 = fract(sin(dot(i, vec2(12.9, 78.2))) * 43758.5), h10 = fract(sin(dot(i + vec2(1, 0), vec2(12.9, 78.2))) * 43758.5);
      float h01 = fract(sin(dot(i + vec2(0, 1), vec2(12.9, 78.2))) * 43758.5), h11 = fract(sin(dot(i + vec2(1, 1), vec2(12.9, 78.2))) * 43758.5);
      float puff = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
      float a = (1.0 - smoothstep(0.1, 1.0, r)) * smoothstep(0.35, 0.9, puff) * 0.28;
      diffuseColor.rgb = mix(vec3(0.92, 0.95, 1.0), vCol * 1.3, uNightK);
      diffuseColor.a *= a;`, 'cap');
    const prev = mm.onBeforeCompile;
    mm.onBeforeCompile = (shader, r) => {
      prev(shader, r);
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', /* glsl */`
        float hh = aJet.x, ln = aJet.y;
        vec3 top = aJet.w > 1.5 ? vec3(ln * 0.5, hh, 0.0) : vec3(0.0, hh, 0.0);
        float size = aJet.w > 2.5 ? 2.2 + hh * 1.2 : 0.8 + hh * 0.09;
        if (aJet.w > 2.5) top.y = hh * 0.45; else if (aJet.w < 1.5) top.y = hh * 0.93;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(top, 1.0);
        mvPosition.xy += position.xy * size;
        gl_Position = projectionMatrix * mvPosition;`);
    };
    return mm;
  }

  private ringMaterial(): THREE.MeshBasicMaterial {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return this.patch(m, '', /* glsl */`
      vH = aJet.x; vCol = aCol; vJ = uv;
      float rr = 0.45 + clamp(aJet.x, 0.0, 30.0) * 0.045 + (aJet.w > 1.5 ? 0.4 : 0.0);
      transformed = vec3(position.x * rr * 2.0 + (aJet.w > 1.5 && aJet.w < 2.5 ? aJet.y : 0.0), position.y, position.z * rr * 2.0);`, /* glsl */`
      float hash2(vec2 p) { return fract(sin(dot(p, vec2(27.1, 61.7))) * 43758.5453); }`, /* glsl */`
      vec2 d = vJ - 0.5;
      float r = length(d) * 2.0;
      float foam = hash2(floor(vJ * 24.0) + floor(uTime * 12.0));
      float on = smoothstep(0.2, 1.5, vH);
      // foam where the water comes down, the uplight's glow under the surface at night
      float a = on * (1.0 - smoothstep(0.45, 1.0, r)) * (0.1 + 0.4 * step(0.6, foam) * (1.0 - r));
      float glow = uNightK * (1.0 - smoothstep(0.0, 1.0, r)) * 0.8;
      diffuseColor.rgb = mix(vec3(0.95), vCol * 1.6, uNightK * 0.7);
      diffuseColor.a *= max(a, glow * mix(0.25, 1.0, on));`, 'ring');
  }

  /** Start a show now, for `seconds` (QA, screenshots). */
  force(seconds: number): void { this.forced = seconds; this.t = 0; }

  private inWindow(hour: number): boolean {
    const h = ((hour % 24) + 24) % 24;
    return WINDOWS.some(([a, b]) => h >= a && h < b);
  }

  /** 0..1 target height of a jet in the move `k` at show time t. */
  private move(k: number, t: number, j: Jet): number {
    const u = j.n > 1 ? j.i / (j.n - 1) : 0.5;        // position along the basin, south to north
    const beat = 0.6;                                   // s per beat (~100 bpm)
    switch (k % 6) {
      case 0: return 0.5 + 0.5 * Math.sin((t / 3.2 - u * 2.0) * Math.PI * 2);                             // wave
      case 1: { const c = ((t / 5.0) % 1.4) - 0.2; return Math.exp(-(((u - c) / 0.09) ** 2)); }              // chase
      case 2: return Math.pow(Math.abs(Math.sin((t / beat) * Math.PI)), 4) * (j.kind === 'arc' ? 1 : 0.85);  // the beat
      case 3: return ((j.i + Math.floor(t / (beat * 2))) % 2) ? 1 : 0.15;                                     // odd / even
      case 4: return j.kind === 'tall' ? 0.45 + 0.55 * Math.exp(-(((u - 0.5) / 0.25) ** 2)) : j.kind === 'mid' ? 0.6 : 1.0;   // the crown
      default: return 0.75 + 0.25 * Math.sin(t * 11.0 + j.i * 1.7);                                          // finale
    }
  }

  update(dt: number, hour: number, night: number, camera: THREE.Vector3): void {
    this.uNightK.value = night;
    const near = camera.distanceToSquared(this.centre) < 520 * 520;
    this.forced = Math.max(0, this.forced - dt);
    const on = this.forced > 0 || this.inWindow(hour);
    this.running = on;
    if (on) this.t += dt; else this.t = 0;
    this.group.visible = near;
    if (!near && !on) { this.power = 0; return; }
    const k0 = Math.floor(this.t / MOVE_S), f = (this.t % MOVE_S) / MOVE_S;
    const blend = THREE.MathUtils.smoothstep(f, 0.85, 1.0);
    const hueBase = this.t * 0.04 + k0 * 0.17;
    let sum = 0;
    const aH = this.aH.map((a) => a.array as Float32Array), aC = this.aC.map((a) => a.array as Float32Array);
    this.jets.forEach((j, idx) => {
      // the opening seconds rise from nothing; outside a show the water falls back flat
      let target = 0;
      if (on) {
        const a = this.move(k0, this.t, j), b = this.move(k0 + 1, this.t, j);
        target = THREE.MathUtils.lerp(a, b, blend) * HMAX[j.kind] * Math.min(1, this.t / 2.5);
        if (k0 % 6 === 5) target *= 1.0 + 0.1 * Math.sin(this.t * 3 + j.i);
      }
      const rate = target > j.h ? (j.kind === 'tall' ? 1.6 : 3.0) : (j.kind === 'tall' ? 1.1 : 2.2);
      j.h += (target - j.h) * Math.min(1, dt * rate);
      sum += j.h / HMAX[j.kind];
      const kindN = j.kind === 'arc' ? 2 : j.kind === 'fog' ? 3 : j.kind === 'mid' ? 1 : 0;
      const w = j.kind === 'tall' ? 0.22 : j.kind === 'mid' ? 0.1 : j.kind === 'arc' ? 0.07 : 0.6;
      const lean = j.kind === 'arc' ? j.lean * 8.6 : 0;           // the landing point's offset in x (three x = Blender x)
      _c.setHSL(((hueBase + j.y * 0.004 + (j.kind === 'arc' ? 0.33 : 0)) % 1 + 1) % 1, 0.85, 0.55);
      for (const arr of aH) { arr[idx * 4] = j.h; arr[idx * 4 + 1] = lean; arr[idx * 4 + 2] = w; arr[idx * 4 + 3] = kindN; }
      for (const arr of aC) { arr[idx * 3] = _c.r; arr[idx * 3 + 1] = _c.g; arr[idx * 3 + 2] = _c.b; }
    });
    for (const a of [...this.aH, ...this.aC]) a.needsUpdate = true;
    this.power = Math.min(1, sum / (this.jets.length * 0.45));
  }

  /** QA / debug */
  stats(): { running: boolean; tallest: number; mean: number; jets: number } {
    const tall = this.jets.filter((j) => j.kind === 'tall');
    return { running: this.running, tallest: Math.max(...tall.map((j) => j.h)), mean: this.jets.reduce((a, j) => a + j.h, 0) / this.jets.length, jets: this.jets.length };
  }
}
