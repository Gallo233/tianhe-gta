import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GZ, HASH } from '../world/Materials';

/**
 * HDR frame for Tianhe: the scene renders linear into a 2x MSAA half-float target (float depth, so the
 * reversed-Z depth keeps its precision off-screen), then
 *
 *   ssr     screen-space reflections for the horizontal surfaces only -- the Pearl River (always) and the
 *           streets when wet (GZ.uWet): world position from the float depth, reflect about the up axis
 *           (river ripples tilt it), march in world space, bisect the hit. Half resolution; the weight
 *           carries Fresnel and the puddle mask (the same noise as Surfaces), alpha says how sharp the
 *           reflection is, and the composite streaks the soft ones vertically like wet asphalt does.
 *   ao      screen-space ambient occlusion at half resolution: the depth is first reduced to a half-res linear
 *           depth (cache-friendly taps), position rebuilt from it, normal from screen derivatives; 8 taps on a
 *           golden-angle spiral (rotated per pixel), horizon-style estimator with a falloff;
 *           the world radius grows from 1.6 m near to 6 m far so building feet still darken in aerial views;
 *           two depth-aware blur passes; multiplied into the scene before bloom (weaker at night, where most
 *           of the light is emitted);
 *   bloom   physically based: Karis-averaged soft-threshold prefilter, 13-tap downsample chain to 1/64,
 *           tent-filter upsample back up (no hard threshold -- only energy above `knee` spills);
 *   grade   exposure, white balance, ACES filmic, then display-space contrast, saturation, split toning
 *           (cool shadows / warm highlights, amounts from the time of day), vignette and dither grain.
 *
 * Everything the grade does is exposed on `grade` so Environment can key it to the clock.
 */
export interface Grade {
  exposure: number;
  bloom: number;          // bloom gain (the chain sums six levels)
  knee: number;           // luminance where bloom starts
  contrast: number;
  saturation: number;
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  split: number;          // split-toning amount
  vignette: number;
  temperature: number;    // -1 cool .. +1 warm white balance
}

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// the grade is a RawShaderMaterial: a ShaderMaterial drawn to the screen already gets three's tone-mapping
// and colour-space chunks in its prefix, and including them again fails to compile
const RAW_VERT = /* glsl */`
  precision highp float;
  attribute vec3 position; attribute vec2 uv;
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const MIPS = 6;

export class RenderPipeline {
  readonly grade: Grade = {
    exposure: 1, bloom: 0.12, knee: 1.2, contrast: 1.06, saturation: 1.05,
    shadowTint: new THREE.Color('#1c2a3a'), highlightTint: new THREE.Color('#ffd9b0'), split: 0.12, vignette: 0.22, temperature: 0,
  };
  enabled = true;
  private readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly ssrRT: THREE.WebGLRenderTarget;
  private readonly ssrMat: THREE.ShaderMaterial;
  /** metro entrances near the camera: (Blender x, y, cos yaw, sin yaw); far away when unused */
  private readonly holes = [0, 1, 2, 3].map(() => new THREE.Vector4(1e6, 1e6, 1, 0));
  /** 0 disables reflections (debug / low-end). */
  ssr = 1;
  /** ambient occlusion strength (0 off); Environment lowers it at night */
  ao = 0.85;
  /** debug: show the occlusion buffer instead of the frame */
  aoView = false;
  private readonly aoRT: THREE.WebGLRenderTarget;
  private readonly aoLinRT: THREE.WebGLRenderTarget;
  private readonly aoLinMat: THREE.ShaderMaterial;
  private readonly aoBlurRT: THREE.WebGLRenderTarget;
  private readonly aoMat: THREE.ShaderMaterial;
  private readonly aoBlurMat: THREE.ShaderMaterial;
  /** the camera is underground: the APM / entrance-hall floor levels reflect like polished granite */
  set apmFloors(on: boolean) { this.ssrMat.uniforms.uApm.value = on ? 1 : 0; }
  setApmLevels(concourse: number, platform: number): void { this.ssrMat.uniforms.uApmZ.value.set(concourse, platform); }
  /** Scene resolution scale (dynamic resolution keeps the GPU under `budgetMs`). */
  scale = 1;
  dynamic = true;
  budgetMs = 14.5;
  private adaptT = 0;
  private readonly down: THREE.WebGLRenderTarget[] = [];
  private readonly up: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new FullScreenQuad();
  private readonly prefilter: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly finalMat: THREE.RawShaderMaterial;
  private w = 1;
  private h = 1;
  private frame = 0;
  // GPU timing (EXT_disjoint_timer_query_webgl2), median of the last 60 frames
  private readonly gl: WebGL2RenderingContext;
  private readonly timerExt: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly queries: WebGLQuery[] = [];
  private readonly gpuMs: number[] = [];
  /** wall-clock intervals between rendered frames (ms): what the player actually gets */
  private readonly frameMs: number[] = [];
  private lastFrameT = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const opts = { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: 2, depthBuffer: true,     // 4x costs ~5 ms at 1440p on Apple GPUs; 2x is nearly free
      depthTexture: new THREE.DepthTexture(1, 1, THREE.FloatType),
    });
    this.sceneRT.texture.name = 'hdr-scene';
    this.ssrRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.ssrMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: {
        tScene: { value: this.sceneRT.texture }, tDepth: { value: this.sceneRT.depthTexture },
        uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() }, uWet: GZ.uWet, uTime: GZ.uTime,
        uRes: { value: new THREE.Vector2() }, uOn: { value: 1 },
        uHoles: { value: this.holes }, uHoleBox: { value: new THREE.Vector4(0, 0, 0, 0) },
        uApm: { value: 0 }, uApmZ: { value: new THREE.Vector2(-5.85, -11.85) },
      },
      fragmentShader: /* glsl */`
        uniform sampler2D tScene, tDepth; uniform float uApm; uniform vec2 uApmZ;
        uniform mat4 uProj, uInvProj, uView, uInvView;
        uniform vec3 uCam; uniform float uWet, uTime, uOn; uniform vec2 uRes;
        uniform vec4 uHoles[4]; uniform vec4 uHoleBox;
        // below the pavement inside a metro entrance's well / tunnel / hall: not the river, not a wet street
        bool underground(vec3 wp) {
          if (wp.y > 0.2) return false;
          for (int i = 0; i < 4; i++) {
            vec4 h = uHoles[i];
            vec2 d = vec2(wp.x - h.x, -wp.z - h.y);
            float lx = d.x * h.z + d.y * h.w, ly = -d.x * h.w + d.y * h.z;
            if (lx > uHoleBox.x && lx < uHoleBox.y && ly > uHoleBox.z && ly < uHoleBox.w) return true;
          }
          return false;
        }
        varying vec2 vUv;
        ${HASH}
        vec3 viewAt(vec2 uv, float d) { vec4 c = uInvProj * vec4(uv * 2.0 - 1.0, d, 1.0); return c.xyz / c.w; }
        vec2 toScreen(vec3 q, out float qz) { vec4 v = uView * vec4(q, 1.0); qz = -v.z; vec4 c = uProj * v; return c.xy / c.w * 0.5 + 0.5; }
        void main() {
          gl_FragColor = vec4(0.0);
          float d = texture2D(tDepth, vUv).r;
          if (uOn < 0.5 || d <= 1e-7) return;
          vec3 wp = (uInvView * vec4(viewAt(vUv, d), 1.0)).xyz;
          // the polished stone floors of the APM stations, passages and entrance halls (camera underground)
          float stone = uApm * max(1.0 - step(0.035, abs(wp.y - uApmZ.x)), 1.0 - step(0.035, abs(wp.y - uApmZ.y)));
          if (stone < 0.5 && underground(wp)) return;
          float water = step(-3.4, wp.y) * step(wp.y, -2.3) * (1.0 - stone);
          float ground = step(-0.25, wp.y) * step(wp.y, 0.32);
          float pud = smoothstep(0.56, 0.64, gzFbm(wp.xz * 0.16 + 3.0)) * smoothstep(0.35, 0.8, uWet);
          float k = max(water * 0.95 + ground * uWet * (0.32 + 0.63 * pud), stone * 0.9);
          if (k < 0.01) return;
          vec3 V = normalize(wp - uCam);
          vec3 N = vec3(0.0, 1.0, 0.0);
          if (stone > 0.5) {                     // 0.8 m tiles, each laid a hair off level
            vec3 th = gzHash33(vec3(floor(wp.xz / 0.8), 3.3)) - 0.5;
            N = normalize(vec3(th.x * 0.008, 1.0, th.y * 0.008));
          }
          if (water > 0.5) {
            vec2 q = wp.xz * 0.22 + vec2(uTime * 0.21, uTime * 0.07);
            float n0 = gzNoise(q), nx = gzNoise(q + vec2(0.35, 0.0)), nz = gzNoise(q + vec2(0.0, 0.35));
            float fade = 1.0 / (1.0 + length(wp - uCam) * 0.004);
            N = normalize(vec3((n0 - nx) * 0.35 * fade, 1.0, (n0 - nz) * 0.35 * fade));
          }
          vec3 R = reflect(V, N);
          if (R.y < 0.002) return;
          float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 5.0);
          float t = 0.3 + gzHash3(vec3(gl_FragCoord.xy, uTime)) * 0.35;
          float prev = 0.0;
          vec2 hit = vec2(-1.0);
          float qz;
          for (int i = 0; i < 40; i++) {
            vec2 su = toScreen(wp + R * t, qz);
            if (su.x < 0.0 || su.x > 1.0 || su.y < 0.0 || su.y > 1.0 || qz < 0.0) break;
            float sd = texture2D(tDepth, su).r;
            float sz = -viewAt(su, sd).z;
            if (sd > 1e-7 && sz < qz && qz - sz < 0.8 + t * 0.15) {
              float a = prev, b = t;
              for (int j = 0; j < 5; j++) {
                float m = (a + b) * 0.5;
                float mz; vec2 mu = toScreen(wp + R * m, mz);
                float szm = -viewAt(mu, texture2D(tDepth, mu).r).z;
                if (szm < mz) b = m; else a = m;
              }
              hit = toScreen(wp + R * b, qz);
              break;
            }
            prev = t;
            t = t * 1.2 + 0.2;
          }
          if (hit.x < 0.0) return;
          vec3 c = min(texture2D(tScene, hit).rgb, vec3(30.0));
          float edge = smoothstep(0.0, 0.06, hit.x) * smoothstep(1.0, 0.94, hit.x) * smoothstep(0.0, 0.05, hit.y) * smoothstep(1.0, 0.85, hit.y);
          gl_FragColor = vec4(c * k * fres * edge, water > 0.5 ? 0.75 : stone > 0.5 ? 0.72 : pud);
        }`,
    });
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.aoBlurRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.aoLinRT = new THREE.WebGLRenderTarget(1, 1, { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    // pass 1: half-resolution linear depth (view-space distance along -z), the nearest of each 2x2 block
    this.aoLinMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tDepth: { value: this.sceneRT.depthTexture }, uInvProj: { value: new THREE.Matrix4() }, uFull: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */`
        uniform sampler2D tDepth; uniform mat4 uInvProj; uniform vec2 uFull; varying vec2 vUv;
        float lin(vec2 uv) { float d = texture2D(tDepth, uv).r; if (d <= 1e-7) return 1e4; vec4 c = uInvProj * vec4(uv * 2.0 - 1.0, d, 1.0); return -c.z / c.w; }
        void main() {
          vec2 t = 0.5 / uFull;
          float z = min(min(lin(vUv + vec2(-t.x, -t.y)), lin(vUv + vec2(t.x, -t.y))), min(lin(vUv + vec2(-t.x, t.y)), lin(vUv + vec2(t.x, t.y))));
          gl_FragColor = vec4(z, 0.0, 0.0, 1.0);
        }`,
    });
    // pass 2: the occlusion, from the linear depth alone (position rebuilt from uv and z, normal from derivatives)
    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tLin: { value: this.aoLinRT.texture }, uProj: { value: new THREE.Vector2(1, 1) }, uHalf: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */`
        uniform sampler2D tLin; uniform vec2 uProj, uHalf; varying vec2 vUv;
        vec3 posAt(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0) / uProj * z, -z); }
        void main() {
          float z = texture2D(tLin, vUv).r;
          if (z > 9e3) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }      // sky
          vec3 P = posAt(vUv, z);
          vec3 N = normalize(cross(dFdx(P), dFdy(P)));
          if (dot(N, -P) < 0.0) N = -N;
          float R = mix(1.6, 6.0, smoothstep(30.0, 320.0, z));                       // metres
          float rPx = clamp(R * uProj.y * uHalf.y * 0.5 / z, 2.0, 48.0);
          float ang = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
          float occ = 0.0;
          for (int i = 0; i < 8; i++) {
            float fi = float(i);
            float a = ang + fi * 2.39996323;
            vec2 su = vUv + vec2(cos(a), sin(a)) * rPx * ((fi + 0.5) / 8.0) / uHalf;
            float sz = texture2D(tLin, su).r;
            if (sz > 9e3) continue;
            vec3 v = posAt(su, sz) - P;
            float L = length(v);
            float h = clamp((dot(v, N) - 0.0015 * z) / max(L, 1e-4) - 0.15, 0.0, 1.0) * 1.2;
            occ += h * clamp(1.0 - L / R, 0.0, 1.0);
          }
          float ao = clamp(1.0 - occ / 8.0 * 3.6, 0.0, 1.0);
          ao = ao * ao;
          ao = mix(ao, 1.0, smoothstep(450.0, 900.0, z));                             // far: the haze takes over
          gl_FragColor = vec4(ao, z, 0.0, 1.0);
        }`,
    });
    this.aoBlurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 uDir; varying vec2 vUv;
        void main() {                       // 9 taps, weighted by how close each tap's depth is to the centre's
          vec2 c = texture2D(tSrc, vUv).rg;
          float sum = c.r, wsum = 1.0;
          for (int i = -4; i <= 4; i++) {
            if (i == 0) continue;
            vec2 s = texture2D(tSrc, vUv + uDir * float(i)).rg;
            float w = exp(-float(i * i) / 10.0) * exp(-abs(s.g - c.g) / (0.03 * c.g + 0.05) * 2.0);
            sum += s.r * w; wsum += w;
          }
          gl_FragColor = vec4(sum / wsum, c.g, 0.0, 1.0);
        }`,
    });
    for (let i = 0; i < MIPS; i++) { this.down.push(new THREE.WebGLRenderTarget(1, 1, opts)); this.up.push(new THREE.WebGLRenderTarget(1, 1, opts)); }
    this.prefilter = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, tSsr: { value: null }, texel: { value: new THREE.Vector2() }, knee: { value: 1 } },
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc, tSsr; uniform vec2 texel; uniform float knee; varying vec2 vUv;
        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        vec3 soft(vec3 c) {                       // quadratic soft knee: only energy above the knee spills
          float l = luma(c); float k = knee * 0.5;
          float s = clamp(l - knee + k, 0.0, 2.0 * k); s = s * s / (4.0 * k + 1e-4);
          return c * max(s, l - knee) / max(l, 1e-4);
        }
        void main() {                             // Karis average of four taps against fireflies
          vec3 a = soft(texture2D(tSrc, vUv + texel * vec2(-1.0, -1.0)).rgb + texture2D(tSsr, vUv + texel * vec2(-1.0, -1.0)).rgb);
          vec3 b = soft(texture2D(tSrc, vUv + texel * vec2( 1.0, -1.0)).rgb + texture2D(tSsr, vUv + texel * vec2( 1.0, -1.0)).rgb);
          vec3 c = soft(texture2D(tSrc, vUv + texel * vec2(-1.0,  1.0)).rgb + texture2D(tSsr, vUv + texel * vec2(-1.0,  1.0)).rgb);
          vec3 d = soft(texture2D(tSrc, vUv + texel * vec2( 1.0,  1.0)).rgb + texture2D(tSsr, vUv + texel * vec2( 1.0,  1.0)).rgb);
          float wa = 1.0 / (1.0 + luma(a)), wb = 1.0 / (1.0 + luma(b)), wc = 1.0 / (1.0 + luma(c)), wd = 1.0 / (1.0 + luma(d));
          gl_FragColor = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
        }`,
    });
    this.downMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() } },
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc; uniform vec2 texel; varying vec2 vUv;
        vec3 t(vec2 o) { return texture2D(tSrc, vUv + texel * o).rgb; }
        void main() {           // Jimenez 2014, 13 taps
          vec3 c = t(vec2(0.0));
          vec3 r = (t(vec2(-1.0,-1.0)) + t(vec2(1.0,-1.0)) + t(vec2(-1.0,1.0)) + t(vec2(1.0,1.0))) * 0.125;
          vec3 o = (t(vec2(-2.0,-2.0)) + t(vec2(2.0,-2.0)) + t(vec2(-2.0,2.0)) + t(vec2(2.0,2.0))) * 0.03125;
          vec3 e = (t(vec2(-2.0,0.0)) + t(vec2(2.0,0.0)) + t(vec2(0.0,-2.0)) + t(vec2(0.0,2.0))) * 0.0625;
          gl_FragColor = vec4(c * 0.125 + r + o + e, 1.0);
        }`,
    });
    this.upMat = new THREE.ShaderMaterial({
      vertexShader: VERT, depthTest: false, depthWrite: false,
      uniforms: { tSrc: { value: null }, tLow: { value: null }, texel: { value: new THREE.Vector2() }, spread: { value: 1 } },
      fragmentShader: /* glsl */`
        uniform sampler2D tSrc, tLow; uniform vec2 texel; uniform float spread; varying vec2 vUv;
        vec3 t(vec2 o) { return texture2D(tLow, vUv + texel * o * spread).rgb; }
        void main() {           // 3x3 tent over the coarser level, added to this level
          vec3 s = t(vec2(0.0)) * 4.0 + (t(vec2(-1.0,0.0)) + t(vec2(1.0,0.0)) + t(vec2(0.0,-1.0)) + t(vec2(0.0,1.0))) * 2.0
                 + t(vec2(-1.0,-1.0)) + t(vec2(1.0,-1.0)) + t(vec2(-1.0,1.0)) + t(vec2(1.0,1.0));
          gl_FragColor = vec4(texture2D(tSrc, vUv).rgb + s / 16.0, 1.0);
        }`,
    });
    this.finalMat = new THREE.RawShaderMaterial({
      vertexShader: RAW_VERT, depthTest: false, depthWrite: false,
      defines: { ACES_FILMIC_TONE_MAPPING: '' },
      uniforms: {
        tScene: { value: this.sceneRT.texture }, tBloom: { value: null }, tSsr: { value: this.ssrRT.texture }, uSsrTexel: { value: new THREE.Vector2() },
        tAo: { value: this.aoRT.texture }, uAo: { value: 0 }, uAoView: { value: 0 },
        toneMappingExposure: { value: 1 },
        uBloom: { value: 0 }, uContrast: { value: 1 }, uSat: { value: 1 }, uShadow: { value: new THREE.Color() },
        uHigh: { value: new THREE.Color() }, uSplit: { value: 0 }, uVignette: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) },
        uAspect: { value: 1 }, uFrame: { value: 0 },
      },
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tScene, tBloom, tSsr, tAo; uniform vec2 uSsrTexel; uniform float uBloom, uContrast, uSat, uSplit, uVignette, uAspect, uFrame, uAo, uAoView;
        uniform vec3 uShadow, uHigh, uWB; varying vec2 vUv;
        #include <tonemapping_pars_fragment>
        #include <colorspace_pars_fragment>
        float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
        float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb;
          c *= mix(1.0, texture2D(tAo, vUv).r, uAo);
          // reflections: sharp in puddles and on the river, streaked vertically on wet asphalt
          vec4 s0 = texture2D(tSsr, vUv);
          float sp = (1.0 - s0.a) * 5.0;
          vec2 dv = vec2(0.0, uSsrTexel.y * sp);
          vec3 rs = s0.rgb * 0.2270 + (texture2D(tSsr, vUv + dv * 1.3846).rgb + texture2D(tSsr, vUv - dv * 1.3846).rgb) * 0.3162
                  + (texture2D(tSsr, vUv + dv * 3.2308).rgb + texture2D(tSsr, vUv - dv * 3.2308).rgb) * 0.0703;
          c += rs;
          c = (c + texture2D(tBloom, vUv).rgb * uBloom) * uWB;
          c = ACESFilmicToneMapping(c);                                 // exposure lives in toneMappingExposure
          // display-space grade
          c = clamp(c, 0.0, 1.0);
          vec3 sc = c * c * (3.0 - 2.0 * c);                            // S-curve
          c = mix(c, sc, uContrast - 1.0);
          float l = luma(c);
          c = mix(vec3(l), c, uSat);
          vec3 tint = mix(uShadow, uHigh, smoothstep(0.05, 0.75, l));
          c = mix(c, c * tint * 2.0, uSplit * (1.0 - abs(l - 0.5)));  // split toning, strongest in the midtones
          vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
          c *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));
          if (uAoView > 0.5) c = vec3(texture2D(tAo, vUv).r);
          gl_FragColor = sRGBTransferOETF(vec4(clamp(c, 0.0, 1.0), 1.0));
          gl_FragColor.rgb += (hash(gl_FragCoord.xy + uFrame * 17.0) - 0.5) / 255.0 * 1.5;   // dither + faint grain
        }`,
    });
    this.gl = renderer.getContext() as WebGL2RenderingContext;
    this.timerExt = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    renderer.info.autoReset = false;
  }

  /** Metro wells / tunnels / halls near the camera (Blender x, y, yaw) and their local box (x0, x1, y0, y1). */
  setHoles(list: { x: number; y: number; yaw: number }[], box: number[]): void {
    this.holes.forEach((h, i) => {
      const e = list[i];
      if (e) h.set(e.x, e.y, Math.cos(e.yaw), Math.sin(e.yaw)); else h.set(1e6, 1e6, 1, 0);
    });
    (this.ssrMat.uniforms.uHoleBox.value as THREE.Vector4).set(box[0], box[1], box[2], box[3]);
  }

  setSize(width: number, height: number): void {
    if (width === this.w && height === this.h) return;
    this.w = width; this.h = height;
    this.sceneRT.setSize(width, height);
    const hw = Math.max(1, Math.floor(width / 2)), hh = Math.max(1, Math.floor(height / 2));
    this.ssrRT.setSize(hw, hh);
    this.aoRT.setSize(hw, hh); this.aoBlurRT.setSize(hw, hh); this.aoLinRT.setSize(hw, hh);
    this.aoLinMat.uniforms.uFull.value.set(width, height);
    this.aoMat.uniforms.uHalf.value.set(hw, hh);
    this.ssrMat.uniforms.uRes.value.set(hw, hh);
    this.finalMat.uniforms.uSsrTexel.value.set(1 / hw, 1 / hh);
    let w = width, h = height;
    for (let i = 0; i < MIPS; i++) {
      w = Math.max(1, Math.floor(w / 2)); h = Math.max(1, Math.floor(h / 2));
      this.down[i].setSize(w, h); this.up[i].setSize(w, h);
    }
    this.finalMat.uniforms.uAspect.value = width / height;
  }

  /** Scene depth (reversed-Z float) of the last frame, for effects that want it. */
  get depth(): THREE.DepthTexture { return this.sceneRT.depthTexture as THREE.DepthTexture; }

  /**
   * Precompile every material for the target the scene really renders into: programs compiled against the
   * canvas (sRGB output, tone mapping) have different cache keys from the half-float scene target and would
   * all be compiled again on first use.
   */
  compile(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.enabled ? this.sceneRT : null);
    r.compile(scene, camera);
    r.setRenderTarget(prev);
  }

  /** Same, in the background (KHR_parallel_shader_compile): for light setups that are coming up soon. */
  compileAsync(scene: THREE.Scene, camera: THREE.Camera): Promise<unknown> {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(this.enabled ? this.sceneRT : null);
    const p = r.compileAsync(scene, camera);            // the synchronous part reads the target set here
    r.setRenderTarget(prev);
    return p;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    r.info.reset();
    const now = performance.now();
    if (this.lastFrameT) { const d = now - this.lastFrameT; if (d > 1 && d < 100) { this.frameMs.push(d); if (this.frameMs.length > 60) this.frameMs.shift(); } }
    this.lastFrameT = now;
    this.beginTimer();
    if (!this.enabled) {
      r.setRenderTarget(null);
      r.render(scene, camera);
      this.endTimer();
      return;
    }
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    this.adapt();
    this.setSize(Math.max(64, Math.round(size.x * this.scale)), Math.max(64, Math.round(size.y * this.scale)));
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    const g = this.grade;
    // bloom chain
    const pass = (mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = mat; r.setRenderTarget(target); this.quad.render(r);
    };
    // reflections (half resolution)
    const cam = camera as THREE.PerspectiveCamera;
    const su = this.ssrMat.uniforms;
    su.uProj.value.copy(cam.projectionMatrix);
    su.uInvProj.value.copy(cam.projectionMatrixInverse);
    su.uView.value.copy(cam.matrixWorldInverse);
    su.uInvView.value.copy(cam.matrixWorld);
    su.uCam.value.setFromMatrixPosition(cam.matrixWorld);
    su.uOn.value = this.ssr;
    pass(this.ssrMat, this.ssrRT);
    this.finalMat.uniforms.uAo.value = this.ao * (1 - 0.45 * GZ.uNight.value);   // at night most light is emitted
    this.finalMat.uniforms.uAoView.value = this.aoView ? 1 : 0;
    this.prefilter.uniforms.tSrc.value = this.sceneRT.texture;
    this.prefilter.uniforms.tSsr.value = this.ssrRT.texture;
    this.prefilter.uniforms.texel.value.set(1 / this.w, 1 / this.h);
    this.prefilter.uniforms.knee.value = g.knee;
    pass(this.prefilter, this.down[0]);
    const NM = MIPS;
    for (let i = 1; i < NM; i++) {
      this.downMat.uniforms.tSrc.value = this.down[i - 1].texture;
      this.downMat.uniforms.texel.value.set(1 / this.down[i - 1].width, 1 / this.down[i - 1].height);
      pass(this.downMat, this.down[i]);
    }
    let low = this.down[NM - 1];
    for (let i = NM - 2; i >= 0; i--) {
      this.upMat.uniforms.tSrc.value = this.down[i].texture;
      this.upMat.uniforms.tLow.value = low.texture;
      this.upMat.uniforms.texel.value.set(1 / low.width, 1 / low.height);
      pass(this.upMat, this.up[i]);
      low = this.up[i];
    }
    // ambient occlusion (half resolution) and its two blur passes
    if (this.ao > 0) {
      this.aoLinMat.uniforms.uInvProj.value.copy(cam.projectionMatrixInverse);
      pass(this.aoLinMat, this.aoLinRT);
      this.aoMat.uniforms.uProj.value.set(cam.projectionMatrix.elements[0], cam.projectionMatrix.elements[5]);
      pass(this.aoMat, this.aoRT);
      const bu = this.aoBlurMat.uniforms;
      bu.tSrc.value = this.aoRT.texture; bu.uDir.value.set(1 / this.aoRT.width, 0); pass(this.aoBlurMat, this.aoBlurRT);
      bu.tSrc.value = this.aoBlurRT.texture; bu.uDir.value.set(0, 1 / this.aoRT.height); pass(this.aoBlurMat, this.aoRT);
    }
    const u = this.finalMat.uniforms;
    u.tBloom.value = this.up[0].texture;
    u.toneMappingExposure.value = g.exposure;
    u.uBloom.value = g.bloom;
    u.uContrast.value = g.contrast;
    u.uSat.value = g.saturation;
    u.uShadow.value.copy(g.shadowTint);
    u.uHigh.value.copy(g.highlightTint);
    u.uSplit.value = g.split;
    u.uVignette.value = g.vignette;
    const t = g.temperature;
    u.uWB.value.set(1 + 0.1 * t, 1 + 0.01 * t, 1 - 0.12 * t);
    u.uFrame.value = (this.frame++) % 64;
    pass(this.finalMat, null);
    this.endTimer();
  }

  /**
   * Every 30 frames: step the resolution scale down when frames are really late, back up when there is room.
   * The GPU timer alone is not trusted to go down: on ANGLE's Metal backend it can count the CPU's encoding time
   * once a frame has more than a handful of passes, reading 8-10 ms high while the frame is on time -- so going down
   * also needs the real interval between frames to miss 60 Hz. Up: either measure says there is room.
   */
  private adapt(): void {
    if (!this.dynamic || ++this.adaptT < 30) return;
    this.adaptT = 0;
    const g = this.gpuStats();
    if (g.n < 20 || this.frameMs.length < 20) return;
    const f = [...this.frameMs].sort((a, b) => a - b)[this.frameMs.length >> 1];
    if (g.median > this.budgetMs && f > 17.5 && this.scale > 0.62) this.scale = Math.max(0.62, this.scale - 0.06);
    else if ((g.median < this.budgetMs * 0.72 || f < 15) && this.scale < 1) this.scale = Math.min(1, this.scale + 0.04);
  }

  private beginTimer(): void {
    if (!this.timerExt) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this.queries.push(q);
  }

  private endTimer(): void {
    if (!this.timerExt || !this.queries.length) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    const disjoint = this.gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
    while (this.queries.length > 1) {
      const q = this.queries[0];
      if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) this.gpuMs.push(this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) / 1e6);
      this.gl.deleteQuery(q);
      this.queries.shift();
      if (this.gpuMs.length > 60) this.gpuMs.shift();
    }
  }

  /** Forget the GPU timings so far (benchmarks). */
  resetGpu(): void { this.gpuMs.length = 0; }

  /** Median / 90th-percentile GPU frame time (ms) over the last 60 measured frames. */
  gpuStats(): { median: number; p90: number; n: number } {
    const s = [...this.gpuMs].sort((a, b) => a - b);
    if (!s.length) return { median: 0, p90: 0, n: 0 };
    return { median: +s[Math.floor(s.length / 2)].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2), n: s.length };
  }
}
