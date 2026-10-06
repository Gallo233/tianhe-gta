import * as THREE from 'three';
import { GZ } from './Materials';

/**
 * Guangzhou weather: clear spells and subtropical downpours.
 *
 *  - `rain` eases toward `target` (0 dry .. 1 downpour); Environment reads it as overcast (grey sky, no sun
 *    disc, thicker delta haze), the ground reads GZ.uWet, which lags behind the rain and dries slowly.
 *  - Streaks: 7,000 instanced quads in a 45 m cylinder that travels with the camera; every streak's fall
 *    and wrap-around is computed in the vertex shader from its seed, so the CPU never touches them.
 *    They stretch along the fall direction (plus wind) and are lit by a sky/city tint and a little
 *    headroom so they catch the bloom under lamps.
 *  - Splashes: 900 rings on the ground near the camera, each on its own short cycle.
 *
 * Without a schedule the sky decides: every in-game hour or so there is a chance of a front coming through.
 */
const STREAKS = 9000;
const SPLASHES = 900;
const RADIUS = 30;
const HEIGHT = 34;

export class Weather {
  readonly group = new THREE.Group();
  rain = 0;
  target = 0;
  /** true once someone chose the weather (key or hook): the random schedule stops. */
  manual = false;
  private wet = 0;
  private nextRoll = 0;
  private readonly streakMat: THREE.ShaderMaterial;
  private readonly splashMat: THREE.ShaderMaterial;
  private readonly uniforms = {
    uTime: GZ.uTime, uRain: { value: 0 }, uCam: { value: new THREE.Vector3() }, uTint: { value: new THREE.Color() },
    uWind: { value: new THREE.Vector2(1.6, 0.6) }, uNight: GZ.uNight,
  };

  constructor(private readonly rng: () => number = Math.random) {
    this.group.name = 'weather';
    // --- streaks
    const quad = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('uv', quad.getAttribute('uv'));
    const seed = new Float32Array(STREAKS * 4);
    for (let i = 0; i < STREAKS; i++) {
      seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random(); seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = Math.random();
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geo.instanceCount = STREAKS;
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, fog: false,
      vertexShader: /* glsl */`
        attribute vec4 aSeed;
        uniform float uTime, uRain; uniform vec3 uCam; uniform vec2 uWind;
        varying float vA; varying vec2 vUv;
        void main() {
          vUv = uv;
          float speed = 9.0 + aSeed.w * 3.0;
          // fall through a box that wraps around the camera, so the rain never runs out
          vec3 box = vec3(${(RADIUS * 2).toFixed(1)}, ${HEIGHT.toFixed(1)}, ${(RADIUS * 2).toFixed(1)});
          float s = fract(aSeed.y + uTime * speed / box.y);                 // 0 top .. 1 ground
          vec3 p = vec3(aSeed.x * box.x, (1.0 - s) * box.y, aSeed.z * box.z);
          p.xz += uWind * s * box.y / speed;
          vec3 base = uCam - vec3(box.x * 0.5, 6.0, box.z * 0.5);
          p.xz = base.xz + mod(p.xz - base.xz, box.xz);
          p.y += base.y;
          // camera-facing quad stretched along the fall direction
          vec3 fall = normalize(vec3(uWind.x, -speed, uWind.y));
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(fall, toCam));
          float len = 0.55 + aSeed.w * 0.35;
          vec3 world = p + side * position.x * 0.016 + fall * position.y * len;
          float d = length(cameraPosition - p);
          vA = step(aSeed.x * 0.999, uRain) * smoothstep(0.5, 2.5, d) * (1.0 - smoothstep(20.0, ${RADIUS.toFixed(1)}, d));
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uTint; uniform float uNight;
        varying float vA; varying vec2 vUv;
        void main() {
          float a = vA * (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.3, vUv.y) * smoothstep(1.0, 0.6, vUv.y);
          if (a < 0.01) discard;
          gl_FragColor = vec4(uTint * mix(1.1, 2.4, uNight), a * 0.65);
        }`,
    });
    const streaks = new THREE.Mesh(geo, this.streakMat);
    streaks.frustumCulled = false;
    streaks.renderOrder = 5;
    // --- splashes: flat rings on the ground
    const sq = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const sgeo = new THREE.InstancedBufferGeometry();
    sgeo.index = sq.index;
    sgeo.setAttribute('position', sq.getAttribute('position'));
    sgeo.setAttribute('uv', sq.getAttribute('uv'));
    const s2 = new Float32Array(SPLASHES * 4);
    for (let i = 0; i < SPLASHES * 4; i++) s2[i] = Math.random();
    sgeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(s2, 4));
    sgeo.instanceCount = SPLASHES;
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uGround: { value: 0.16 } }, transparent: true, depthWrite: false, fog: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: /* glsl */`
        attribute vec4 aSeed;
        uniform float uTime, uRain, uGround; uniform vec3 uCam;
        varying vec2 vUv; varying float vPh; varying float vA;
        void main() {
          vUv = uv;
          float cyc = 0.55 + aSeed.w * 0.4;
          float t = uTime / cyc + aSeed.z * 10.0;
          float k = floor(t);
          vPh = fract(t);
          // a new spot every cycle, scattered within 16 m of the camera
          vec2 j = fract(vec2(sin(k * 12.9898 + aSeed.x * 78.2), sin(k * 39.346 + aSeed.y * 11.1)) * 43758.5453) - 0.5;
          vec3 p = vec3(uCam.x + j.x * 32.0, uGround, uCam.z + j.y * 32.0);
          float size = 0.05 + vPh * 0.18;
          vA = step(aSeed.x, uRain) * (1.0 - vPh);
          gl_Position = projectionMatrix * viewMatrix * vec4(p + position * size, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uTint; uniform float uNight;
        varying vec2 vUv; varying float vPh; varying float vA;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.75, 0.9, r) * smoothstep(1.0, 0.92, r);
          float a = ring * vA * 0.3;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uTint * mix(1.2, 2.0, uNight), a);
        }`,
    });
    const splashes = new THREE.Mesh(sgeo, this.splashMat);
    splashes.frustumCulled = false;
    splashes.renderOrder = 4;
    this.group.add(streaks, splashes);
  }

  set(level: number): void { this.target = THREE.MathUtils.clamp(level, 0, 1); this.manual = true; }

  update(dt: number, camera: THREE.Camera, groundY: number, hour: number, night: number): void {
    // random fronts: a roll every ~40 game minutes (2/3 real minutes at the default clock)
    if (!this.manual) {
      this.nextRoll -= dt;
      if (this.nextRoll <= 0) {
        this.nextRoll = 40 + this.rng() * 50;
        const r = this.rng();
        this.target = this.target > 0.1 ? (r < 0.55 ? 0 : this.target) : (r < 0.22 ? 0.5 + this.rng() * 0.5 : 0);
      }
    }
    this.rain += (this.target - this.rain) * Math.min(1, dt * 0.12);
    if (Math.abs(this.target - this.rain) < 0.002) this.rain = this.target;
    // the ground soaks quickly and dries slowly
    const wetTarget = Math.min(1, this.rain * 1.4);
    this.wet += (wetTarget - this.wet) * Math.min(1, dt * (wetTarget > this.wet ? 0.25 : 0.02));
    GZ.uWet.value = this.wet;
    const u = this.uniforms;
    u.uRain.value = this.rain;
    u.uCam.value.copy(camera.position);
    (this.splashMat.uniforms.uGround as { value: number }).value = groundY + 0.03;
    u.uTint.value.set('#9aa7b4').lerp(new THREE.Color('#b0917a'), night).multiplyScalar(0.55);
    this.group.visible = this.rain > 0.01;
    void hour;
  }

  get wetness(): number { return this.wet; }
}
