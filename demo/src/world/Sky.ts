import * as THREE from 'three';
import { lampUniforms } from './LampLights';

/**
 * Sky dome and height fog for the Tianhe day-night cycle.
 *
 *  - The dome is a gradient sky keyed to the sun's elevation (day blue -> golden hour -> blue hour ->
 *    Guangzhou night: navy zenith over a pink-orange light-pollution band), a sun disc and Mie halo,
 *    a drifting fbm cloud deck at 2.4 km (sun-lit by day, lit from below by the city at night) and a few
 *    stars that survive the light pollution.
 *  - Fog is replaced globally (ShaderChunk) by analytic exponential height fog with sun in-scatter: dense
 *    at street level, thinning with altitude so the tops of the 400-600 m towers stay crisp. The extra
 *    uniforms reach every material through `fogUniforms()`, called from each onBeforeCompile (and from a
 *    default on Material.prototype for stock materials).
 */
export const FOG = {
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogSunColor: { value: new THREE.Color(0, 0, 0) },
  /** x height falloff (1/m), y base height, z sun glow power, w max opacity */
  uFogParams: { value: new THREE.Vector4(1 / 380, -3, 8, 0.97) },
};

export function fogUniforms(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  shader.uniforms.uFogSunDir = FOG.uFogSunDir;
  shader.uniforms.uFogSunColor = FOG.uFogSunColor;
  shader.uniforms.uFogParams = FOG.uFogParams;
  lampUniforms(shader);
}

let patched = false;
export function installHeightFog(): void {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */`
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogView;
    #endif`;
  C.fog_vertex = /* glsl */`
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      vFogView = mvPosition.xyz;
    #endif`;
  C.fog_pars_fragment = /* glsl */`
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogView;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
      uniform vec3 uFogSunDir;
      uniform vec3 uFogSunColor;
      uniform vec4 uFogParams;
    #endif`;
  C.fog_fragment = /* glsl */`
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        vec3 fogRel = (vec4(vFogView, 0.0) * viewMatrix).xyz;      // camera -> fragment, world axes
        float fogDist = length(fogRel);
        vec3 fogDir = fogRel / max(fogDist, 1e-3);
        float fogB = uFogParams.x;
        float fogT = fogB * fogDir.y * fogDist;
        float fogInt = abs(fogT) > 1e-4 ? (1.0 - exp(-fogT)) / fogT : 1.0;
        float fogAmount = fogDensity * exp(-fogB * (cameraPosition.y - uFogParams.y)) * fogDist * fogInt;
        float fogFactor = min(1.0 - exp(-fogAmount), uFogParams.w);
        vec3 fogCol = fogColor + uFogSunColor * pow(max(dot(fogDir, uFogSunDir), 0.0), uFogParams.z);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        vec3 fogCol = fogColor;
      #endif
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
    #endif`;
  // stock materials (characters, cars, anything without its own onBeforeCompile) get the uniforms too
  const proto = THREE.Material.prototype as unknown as { onBeforeCompile: (s: { uniforms: Record<string, THREE.IUniform> }) => void };
  proto.onBeforeCompile = function (shader) { fogUniforms(shader); };
}

interface Key { e: number; zen: string; hor: string; glow: string; k: number }
// sky palette by sun elevation (degrees); k = overall sky radiance
const KEYS: Key[] = [
  { e: -90, zen: '#05070f', hor: '#3b2a3c', glow: '#000000', k: 0.6 },
  { e: -14, zen: '#070a17', hor: '#43303f', glow: '#1a0d10', k: 0.6 },
  { e: -8, zen: '#101a3a', hor: '#6b4a66', glow: '#6a2a2a', k: 0.7 },
  { e: -4, zen: '#1c2d5a', hor: '#b5677a', glow: '#ff6a3a', k: 0.9 },
  { e: 0, zen: '#2c4a86', hor: '#f29a66', glow: '#ff8a40', k: 1.2 },
  { e: 6, zen: '#3a64a8', hor: '#f4c79a', glow: '#ffb070', k: 1.5 },
  { e: 18, zen: '#3f70b8', hor: '#bdd2e4', glow: '#ffe0b0', k: 1.7 },
  { e: 90, zen: '#3568b4', hor: '#b4cce2', glow: '#fff0d8', k: 1.8 },
];

export interface SkyState { zenith: THREE.Color; horizon: THREE.Color; glow: THREE.Color; k: number }

export function skyAt(elev: number): SkyState {
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].e < elev) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = THREE.MathUtils.clamp((elev - a.e) / (b.e - a.e), 0, 1);
  const lerp = (x: string, y: string) => new THREE.Color(x).lerp(new THREE.Color(y), t);
  return { zenith: lerp(a.zen, b.zen), horizon: lerp(a.hor, b.hor), glow: lerp(a.glow, b.glow), k: THREE.MathUtils.lerp(a.k, b.k, t) };
}

const SKY_VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p;
  }`;

const SKY_FRAG = /* glsl */`
  uniform vec3 uZen, uHor, uGlow, uSun, uSunCol, uCity;
  uniform float uK, uNight, uTime, uCloud, uDisc, uStars;
  varying vec3 vDir;
  float h3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
  float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(h3(vec3(i,1.)), h3(vec3(i+vec2(1,0),1.)), f.x), mix(h3(vec3(i+vec2(0,1),1.)), h3(vec3(i+1.,1.)), f.x), f.y); }
  float fbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * n2(p); p = p * 2.07 + vec2(1.7, 9.2); a *= 0.5; } return s; }
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = max(h, 0.0);
    vec3 col = mix(uHor, uZen, pow(up, 0.45));
    // below the horizon: the delta haze, a little darker
    col = h < 0.0 ? mix(uHor, uHor * 0.55, pow(min(-h * 4.0, 1.0), 0.6)) : col;
    float mu = max(dot(d, uSun), 0.0);
    // horizon band toward the sun at golden / blue hour, broad Mie halo, sharp disc
    float band = pow(1.0 - up, 6.0) * pow(mu, 3.0);
    col += uGlow * (band * 1.4 + pow(mu, 12.0) * 0.5);
    // city light pollution: warm glow low on every bearing at night
    col += uCity * uNight * pow(1.0 - up, 5.0);
    col *= uK;
    col += uSunCol * uDisc * smoothstep(0.99965, 0.99985, mu) * 60.0;
    // cloud deck at 2.4 km
    if (h > 0.01) {
      vec2 cp = d.xz * (2400.0 / h) / 5200.0 + vec2(uTime * 0.004, uTime * 0.0015);
      float n = fbm(cp) + 0.5 * fbm(cp * 3.1 - 7.0) - 0.25;
      float cov = smoothstep(1.0 - uCloud, 1.25 - uCloud * 0.6, n) * smoothstep(0.01, 0.12, h);
      // cheap self-shadowing: where the density falls off toward the sun the cloud is lit, where it rises it is in its own shade
      vec2 toSun = normalize(uSun.xz + 1e-4) * 0.05;
      float ns = fbm(cp + toSun) + 0.5 * fbm((cp + toSun) * 3.1 - 7.0) - 0.25;
      float self = clamp(0.5 + (n - ns) * 5.0, 0.0, 1.0);
      float lit = (0.55 + 0.45 * pow(mu, 3.0)) * mix(0.66, 1.18, self);
      vec3 cday = mix(uHor * 0.9, vec3(1.0), 0.55) * uK * lit + uGlow * uK * pow(mu, 4.0) * 1.2;
      vec3 cnight = uCity * (0.7 + 0.8 * pow(1.0 - up, 2.0));
      vec3 ccol = mix(cday, cnight, uNight);
      col = mix(col, ccol, cov * 0.85);
      // stars through the gaps
      vec3 sd = floor(d * 380.0);
      float st = step(0.9975, h3(sd)) * (1.0 - cov) * smoothstep(0.25, 0.6, h);
      col += vec3(0.8, 0.85, 1.0) * st * uStars * (0.5 + h3(sd + 3.1));
    }
    gl_FragColor = vec4(col, 1.0);
  }`;

export class SkyDome {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uZen: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
    uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 0.9, 0.75) },
    uCity: { value: new THREE.Color('#6b3b3a') }, uK: { value: 1 }, uNight: { value: 0 }, uTime: { value: 0 },
    uCloud: { value: 0.45 }, uDisc: { value: 1 }, uStars: { value: 0 },
  };

  constructor(radius = 24000) {
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
  }

  /** A copy for the reflection bake: same state, no sun disc (it would become a shadowless second sun). */
  bakeMaterial(): THREE.ShaderMaterial {
    const u = THREE.UniformsUtils.clone(this.uniforms);
    u.uDisc.value = 0; u.uStars.value = 0;
    return new THREE.ShaderMaterial({ uniforms: u, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false });
  }
}
