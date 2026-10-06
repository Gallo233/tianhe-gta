import * as THREE from 'three';
import { fromBlender } from '../config';
import { GZ } from './Materials';

/**
 * Evening drone show over the Pearl River, on the central axis between Haixinsha and Canton Tower
 * (Guangzhou does these for real; here the sponsors are fictional and slightly sinister).
 *
 * 1,600 drones are one THREE.Points; every formation is a set of target points in a vertical plane facing
 * north (the Zhujiang New Town waterfront), sampled from canvas drawings (text and shapes) or built
 * analytically (a turning globe, the tower's hyperboloid). The vertex shader blends from the last
 * formation to the next with a per-drone delay and a little hover wobble; the CPU only rewrites the target
 * buffers at each change. On from 19:30 to 23:00 in game time.
 */
const N = 1600;
const CENTRE: [number, number, number] = [0, -935, 118];   // Blender x, y, z of the show's middle
const WIDTH = 300, HEIGHT = 135;
const HOLD = 13, MOVE = 6;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';

type Shape = { pts: [number, number, number][]; col: (i: number, p: [number, number, number]) => THREE.Color };

function sampleCanvas(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, w = 320, h = 140): [number, number][] {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.strokeStyle = '#fff';
  draw(g, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const on: [number, number][] = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (d[(y * w + x) * 4] > 128) on.push([x / w - 0.5, 0.5 - y / h]);
  return on;
}

/** Pick N points from a sampled outline (evenly spread), as (u, v, depth) in -0.5..0.5 plane units. */
function fit(on: [number, number][], rng: () => number): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (!on.length) return out;
  const step = on.length / N;
  for (let i = 0; i < N; i++) {
    const p = on[Math.floor(i * step + rng() * step) % on.length];
    out.push([p[0] + (rng() - 0.5) * 0.004, p[1] + (rng() - 0.5) * 0.004, (rng() - 0.5) * 0.02]);
  }
  return out;
}

function shapes(rng: () => number): Shape[] {
  const text = (s: string, size: number) => (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, w / 2, h / 2 + 4);
  };
  const solid = (c: string) => () => new THREE.Color(c);
  const out: Shape[] = [];
  out.push({ pts: fit(sampleCanvas(text('广州', 118)), rng), col: (i) => new THREE.Color().setHSL(0.0 + (i % 7) * 0.004, 0.9, 0.55) });
  // kapok flower: five fat petals, a gold heart
  out.push({
    pts: fit(sampleCanvas((g, w, h) => {
      g.save(); g.translate(w / 2, h / 2);
      for (let k = 0; k < 5; k++) { g.rotate(Math.PI * 2 / 5); g.beginPath(); g.ellipse(0, -30, 20, 34, 0, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }), rng),
    col: (_i, p) => Math.hypot(p[0] * 2.3, p[1]) < 0.09 ? new THREE.Color('#ffc53a') : new THREE.Color('#ff2a20'),
  });
  out.push({ pts: fit(sampleCanvas(text('准时达 4.99', 70)), rng), col: solid('#c6f03c') });
  // Canton Tower: a twisted hyperboloid of lines
  {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const t = rng(), a = rng() * Math.PI * 2;
      const r = 0.07 + 0.09 * Math.abs(t - 0.62) * 1.6;
      pts.push([Math.cos(a + t * 2.4) * r * 0.55, t - 0.5, Math.sin(a + t * 2.4) * r * 0.25]);
    }
    out.push({ pts, col: (_i, p) => new THREE.Color().setHSL(0.75 - (p[1] + 0.5) * 0.35, 0.85, 0.6) });
  }
  // a turning globe
  {
    const pts: [number, number, number][] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i + 0.5) / N * 2, r = Math.sqrt(1 - y * y), a = i * 2.39996;
      pts.push([Math.cos(a) * r * 0.2, y * 0.42, Math.sin(a) * r * 0.2]);
    }
    out.push({ pts, col: (_i, p) => (p[1] > 0.1 ? new THREE.Color('#57c8ff') : new THREE.Color('#2f6bff')) });
  }
  out.push({ pts: fit(sampleCanvas(text('小准爱你', 88)), rng), col: solid('#7ee0ff') });
  out.push({ pts: fit(sampleCanvas(text('❤', 130)), rng), col: solid('#ff4f8b') });
  return out;
}

export class DroneShow {
  readonly points: THREE.Points;
  private readonly geo = new THREE.BufferGeometry();
  private readonly shapes: Shape[];
  private idx = 0;
  private t = 0;
  private readonly uniforms = { uMix: { value: 0 }, uTime: GZ.uTime, uOn: { value: 0 }, uScale: { value: 1 } };

  constructor(rng: () => number = Math.random) {
    this.shapes = shapes(rng);
    const from = new Float32Array(N * 3), to = new Float32Array(N * 3), cf = new Float32Array(N * 3), ct = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = rng();
    this.geo.setAttribute('position', new THREE.BufferAttribute(from, 3));
    this.geo.setAttribute('aTo', new THREE.BufferAttribute(to, 3));
    this.geo.setAttribute('aCf', new THREE.BufferAttribute(cf, 3));
    this.geo.setAttribute('aCt', new THREE.BufferAttribute(ct, 3));
    this.geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.geo.boundingSphere = new THREE.Sphere(fromBlender(...CENTRE), 400);
    this.write('position', 'aCf', 0);
    this.write('aTo', 'aCt', 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      vertexShader: /* glsl */`
        attribute vec3 aTo, aCf, aCt; attribute float aSeed;
        uniform float uMix, uTime, uOn, uScale;
        varying vec3 vC; varying float vA;
        void main() {
          float m = smoothstep(aSeed * 0.35, aSeed * 0.35 + 0.65, uMix);
          vec3 p = mix(position, aTo, m);
          // mid-flight the swarm billows outward a little
          p += normalize(p + vec3(0.001)) * sin(m * 3.14159) * 6.0 * (0.5 + aSeed);
          p += vec3(sin(uTime * 1.3 + aSeed * 40.0), cos(uTime * 1.1 + aSeed * 23.0), sin(uTime * 0.9 + aSeed * 11.0)) * 0.25;
          vC = mix(aCf, aCt, m);
          vA = uOn * (0.75 + 0.25 * sin(uTime * 6.0 + aSeed * 60.0));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(3400.0 * uScale / -mv.z, 2.0, 26.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vC; varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float core = smoothstep(1.0, 0.0, r);
          if (core < 0.01 || vA < 0.01) discard;
          gl_FragColor = vec4(vC * (core * core * 3.0 + core * 0.6) * vA, 1.0);
        }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.name = 'drone-show';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  /** Formation k into a position attribute (+ colour attribute), world space. */
  private write(posName: string, colName: string, k: number): void {
    const s = this.shapes[k % this.shapes.length];
    const P = this.geo.getAttribute(posName) as THREE.BufferAttribute;
    const C = this.geo.getAttribute(colName) as THREE.BufferAttribute;
    const c = fromBlender(...CENTRE);
    for (let i = 0; i < N; i++) {
      const p = s.pts[i % s.pts.length];
      // plane facing the north bank: read from there, 'right' is west (-x)
      P.setXYZ(i, c.x - p[0] * WIDTH, c.y + p[1] * HEIGHT, c.z + p[2] * WIDTH);
      const col = s.col(i, p);
      C.setXYZ(i, col.r, col.g, col.b);
    }
    P.needsUpdate = true; C.needsUpdate = true;
  }

  update(dt: number, hour: number, night: number): void {
    const on = night > 0.6 && hour >= 19.5 && hour < 23 ? 1 : 0;
    this.uniforms.uOn.value += (on - this.uniforms.uOn.value) * Math.min(1, dt * 0.5);
    this.points.visible = this.uniforms.uOn.value > 0.01;
    if (!this.points.visible) return;
    this.t += dt;
    const cyc = HOLD + MOVE;
    if (this.t > cyc) {
      this.t -= cyc;
      // the target becomes the start; pick the next formation
      const P = this.geo.getAttribute('position') as THREE.BufferAttribute, T = this.geo.getAttribute('aTo') as THREE.BufferAttribute;
      const CF = this.geo.getAttribute('aCf') as THREE.BufferAttribute, CT = this.geo.getAttribute('aCt') as THREE.BufferAttribute;
      (P.array as Float32Array).set(T.array as Float32Array); P.needsUpdate = true;
      (CF.array as Float32Array).set(CT.array as Float32Array); CF.needsUpdate = true;
      this.idx++;
      this.write('aTo', 'aCt', this.idx);
    }
    this.uniforms.uMix.value = THREE.MathUtils.clamp((this.t - HOLD) / MOVE, 0, 1);
  }
}
