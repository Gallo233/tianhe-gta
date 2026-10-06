import * as THREE from 'three';
import { installLampLighting } from './LampLights';
import type { Grade } from '../render/RenderPipeline';
import { GZ } from './Materials';
import { FOG, SkyDome, installHeightFog, skyAt } from './Sky';

const LAT = THREE.MathUtils.degToRad(23.12);
const MOON_DIR = new THREE.Vector3(-0.35, 0.8, 0.45).normalize();
const UG_TOP = new THREE.Color('#f4f3ef');
const UG_BOTTOM = new THREE.Color('#c9c4b9');

/**
 * Day-night light for Tianhe. A 24 h clock drives the sun over Guangzhou (equinox declination), the
 * gradient sky dome with clouds (world/Sky), height fog with sun in-scatter, the key light (sun by day;
 * a dim cool moon/sky key at night so people and cars keep their form), hemisphere fill (sky over warm
 * city bounce), the colour grade and the shared night value GZ.uNight that switches on windows, street
 * lamps and tower lighting. The reflection map is re-baked from the (disc-less) sky when the light moves.
 */
export class Environment {
  readonly sun = new THREE.DirectionalLight('#ffe2c0', 3.0);
  readonly hemi = new THREE.HemisphereLight('#bcd3ea', '#6b6152', 0.6);
  readonly sky = new SkyDome();
  readonly sunDir = new THREE.Vector3();
  /** Where the key light comes from (the sun by day, the moon at night). */
  readonly keyDir = new THREE.Vector3();
  private readonly fog = new THREE.FogExp2('#c4c9cc', 0.00016);
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** what window glass reflects (GZ.uRefl): the sky with clouds and a dimmed sun, over a ring of skyline */
  private readonly reflRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  private readonly reflCam = new THREE.CubeCamera(1, 2000, this.reflRT);
  private readonly reflScene = new THREE.Scene();
  private readonly reflSky: THREE.ShaderMaterial;
  private readonly skyline: THREE.ShaderMaterial;
  private bakedHour = -99;
  private grade: Grade | null = null;
  night = 0;
  dusk = 0;
  elevation = 0;
  hour = 16.0;
  /** 0 clear .. 1 overcast; rain sets this */
  overcast = 0;
  /** 0 outdoors .. 1 underground (metro): no sun or sky, an even light from the ceilings */
  under = 0;

  constructor(private readonly scene: THREE.Scene, private readonly renderer: THREE.WebGLRenderer) {
    installHeightFog();
    installLampLighting();
    scene.add(this.sky.mesh);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const c = this.sun.shadow.camera;
    c.left = -450; c.right = 450; c.top = 450; c.bottom = -450; c.near = 10; c.far = 3000;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    scene.background = null;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // the reflection scene: a copy of the sky (its own uniforms: the sun disc is dimmed) and the skyline ring
    this.reflSky = this.sky.bakeMaterial();
    const reflDome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), this.reflSky);
    reflDome.renderOrder = -1;                                   // the sky first, the skyline over it
    this.reflScene.add(reflDome);
    this.skyline = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { uHor: { value: new THREE.Color() }, uK: { value: 1 }, uNight: { value: 0 }, uCity: { value: new THREE.Color() } },
      vertexShader: /* glsl */`varying vec3 vP; void main() { vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uHor, uCity; uniform float uK, uNight; varying vec3 vP;
        float h1(float x) { return fract(sin(x * 127.1 + 0.37) * 43758.5453); }
        void main() {
          vec3 d = normalize(vP);
          float u = (atan(d.z, d.x) + 3.14159265) / 6.2831853 * 240.0, i = floor(u);
          float top = 0.012 + pow(h1(i), 3.0) * 0.14 + step(0.94, h1(i + 7.1)) * 0.13;   // towers, now and then a tall one
          if (d.y > top) discard;
          vec3 col = uHor * uK * (0.34 + 0.12 * h1(i + 3.3));                          // facades in the haze
          col *= 1.0 - 0.35 * smoothstep(0.0, -0.25, d.y);                              // the streets below
          // windows lit at night
          float fy = d.y * 700.0, fx = fract(u) * 7.0;
          float lit = step(0.7, h1(i * 13.1 + floor(fy) * 7.7 + floor(fx) * 3.1)) * step(0.45, fract(fy)) * step(0.3, fract(fx));
          col += (vec3(1.0, 0.72, 0.42) * lit * 0.7 + uCity * 0.25) * uNight;
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(600, 600, 1200, 96, 1, true), this.skyline);
    ring.position.y = -400;
    ring.renderOrder = 1;
    this.reflScene.add(ring);
    this.setHour(this.hour);
  }

  attachGrade(g: Grade): void { this.grade = g; this.setHour(this.hour); }

  /** Sun direction (three.js, toward the sun) for a local solar hour. */
  static sunFor(hour: number, out: THREE.Vector3): number {
    const H = THREE.MathUtils.degToRad((hour - 12) * 15);
    const elev = Math.asin(Math.cos(LAT) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT));  // from south, + toward west
    // Blender/scene frame: x east, y north. South = -y; west = -x.
    const x = -Math.sin(az) * Math.cos(elev), y = -Math.cos(az) * Math.cos(elev), z = Math.sin(elev);
    out.set(x, z, -y).normalize();
    return THREE.MathUtils.radToDeg(elev);
  }

  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
    const elev = Environment.sunFor(this.hour, this.sunDir);
    this.elevation = elev;
    const night = THREE.MathUtils.smoothstep(-elev, -3, 8);          // 0 above +3 deg .. 1 below -8 deg
    const dusk = THREE.MathUtils.smoothstep(14 - Math.abs(elev), 0, 14) * (1 - night * 0.6);
    this.night = night; this.dusk = dusk;
    GZ.uNight.value = night;
    const oc = this.overcast;
    // --- sky
    const s = skyAt(elev);
    const grey = (c: THREE.Color, k: number) => c.lerp(new THREE.Color(c.r + c.g + c.b).multiplyScalar(0.33), k);
    const su = this.sky.uniforms;
    su.uZen.value.copy(grey(s.zenith, oc * 0.8));
    su.uHor.value.copy(grey(s.horizon, oc * 0.7));
    su.uGlow.value.copy(s.glow).multiplyScalar(1 - oc * 0.8);
    su.uK.value = s.k * (1 - oc * 0.35);
    su.uSun.value.copy(this.sunDir);
    su.uNight.value = night;
    su.uCloud.value = THREE.MathUtils.lerp(0.54, 0.95, oc);
    su.uDisc.value = (1 - oc) * THREE.MathUtils.smoothstep(elev, -1.5, 1);
    su.uStars.value = night * (1 - oc) * 0.6;
    // city glow on the haze; under rain cloud it is stronger but greyer
    su.uCity.value.set('#7a4538').lerp(new THREE.Color('#6a3f5c'), 0.35).lerp(new THREE.Color('#5a5058'), oc * 0.55).multiplyScalar(0.55 + oc * 0.3);
    su.uSunCol.value.set('#fff1dc').lerp(new THREE.Color('#ff9a50'), dusk);
    // --- key light: sun, handing over to a dim cool moon/sky key through the blue hour
    const sunK = THREE.MathUtils.smoothstep(elev, -2, 10);
    const warm = new THREE.Color('#fff0dc').lerp(new THREE.Color('#ff9a55'), dusk * (1 - night));
    if (elev > -3) {
      this.keyDir.copy(this.sunDir);
      this.sun.color.copy(warm);
      this.sun.intensity = 5.2 * sunK * (1 - oc * 0.75);
    } else {
      this.keyDir.copy(MOON_DIR);
      this.sun.color.set('#9fb4e0');
      this.sun.intensity = 0.32 * THREE.MathUtils.smoothstep(-elev, 3, 10) * (1 - oc * 0.6);
    }
    // --- fill: day sky over grey ground; at night a purple sky over the warm bounce of 6,800 street lamps
    // by day the sky dome (environment map) is the fill; the hemisphere only adds warm ground bounce
    // Guangzhou daylight is hazy: shade reads near-neutral grey in photographs, not blue
    this.hemi.color.set('#dfe3e6').lerp(new THREE.Color('#5a4a78'), night);
    this.hemi.groundColor.set('#9a8468').lerp(new THREE.Color('#6a4630'), night);
    // a little less fill than before: sunlit and shaded faces should read apart (the AO darkens the corners on top)
    this.hemi.intensity = THREE.MathUtils.lerp(0.28 + oc * 0.56, 0.42, night);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.46 + oc * 0.39, 1.0, night);
    // --- fog matches the sky's horizon so the ground dissolves into it
    const fogC = su.uHor.value.clone().multiplyScalar(su.uK.value * 0.8);
    this.fog.color.copy(fogC);
    this.fog.density = THREE.MathUtils.lerp(0.00008, 0.00019, night) * (1 + oc * 2.2);      // clear days read crisp; rain brings the murk back
    FOG.uFogSunDir.value.copy(this.sunDir);
    FOG.uFogSunColor.value.copy(s.glow).multiplyScalar(s.k * 0.9 * (1 - oc * 0.8) * (1 - night));
    // --- grade
    const g = this.grade;
    if (g) {
      g.exposure = THREE.MathUtils.lerp(1.0, 1.25, night) * (1 + oc * 0.15);
      g.bloom = THREE.MathUtils.lerp(0.08, 0.32, night);
      g.knee = THREE.MathUtils.lerp(2.2, 0.9, night);
      g.contrast = THREE.MathUtils.lerp(1.16, 1.14, night) - oc * 0.06;
      g.saturation = THREE.MathUtils.lerp(1.12, 1.12, night) * (1 - oc * 0.2);
      g.temperature = THREE.MathUtils.lerp(0.05, -0.25, night) + dusk * 0.35 * (1 - night);
      g.shadowTint.set('#2a2f36').lerp(new THREE.Color('#1b1f4a'), night);
      g.highlightTint.set('#ffe2c2').lerp(new THREE.Color('#ffb98a'), Math.max(dusk, night * 0.6));
      g.split = THREE.MathUtils.lerp(0.05, 0.22, Math.max(night, dusk));
      g.vignette = THREE.MathUtils.lerp(0.2, 0.3, night);
    }
    // --- underground: the sun and the sky go; the stations are lit evenly from their ceilings
    const u = this.under;
    if (u > 0) {
      this.sun.intensity *= 1 - u;
      this.hemi.color.lerp(UG_TOP, u);
      this.hemi.groundColor.lerp(UG_BOTTOM, u);
      this.hemi.intensity = THREE.MathUtils.lerp(this.hemi.intensity, 2.4, u);
      this.scene.environmentIntensity = THREE.MathUtils.lerp(this.scene.environmentIntensity, 0.07, u);
      if (g) {
        g.temperature = THREE.MathUtils.lerp(g.temperature, 0.0, u);
        g.bloom = THREE.MathUtils.lerp(g.bloom, 0.14, u);
        g.shadowTint.lerp(new THREE.Color('#2a2c30'), u);
        g.split *= 1 - u * 0.8;
      }
    }
    if (Math.abs(this.hour - this.bakedHour) > 0.2) this.bake();
  }

  /** Blend towards underground light (0..1); cheap to call every frame. */
  setUnder(k: number): void {
    if (Math.abs(k - this.under) < 0.01 && !(k === 0 && this.under > 0) && !(k === 1 && this.under < 1)) return;
    this.under = k;
    this.setHour(this.hour);
  }

  /** Per frame: the dome rides with the camera; clouds drift. */
  update(camera: THREE.Camera, time: number): void {
    this.sky.mesh.position.copy(camera.position);
    this.sky.uniforms.uTime.value = time;
  }

  /** Reflections from the sky without its disc (the disc would become a second, shadowless sun). */
  private bake(): void {
    this.bakedHour = this.hour;
    const mat = this.sky.bakeMaterial();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), mat);
    // the city below the horizon: by day pale paving and facades bouncing a neutral grey back up (vertical
    // walls in shade get most of their fill from it); at night a warm glow of lit windows and lamps
    const city = new THREE.Mesh(new THREE.SphereGeometry(90, 32, 8, 0, Math.PI * 2, Math.PI * 0.52, Math.PI * 0.48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color('#5c5850').lerp(new THREE.Color('#5a3a26'), this.night).multiplyScalar(1 + this.night * 0.6), side: THREE.BackSide }));
    // lighting only (the visible sky is untouched): Guangzhou's daylight sky is hazy, so the fill it gives walls
    // in shade is a pale grey-blue, not the dome's clean blue
    const haze = new THREE.Mesh(new THREE.SphereGeometry(95, 32, 8, 0, Math.PI * 2, 0, Math.PI * 0.52),
      new THREE.MeshBasicMaterial({ color: '#c9ccce', transparent: true, opacity: 0.45 * (1 - this.night), side: THREE.BackSide, depthWrite: false }));
    haze.renderOrder = 1;
    const envScene = new THREE.Scene(); envScene.add(dome, city, haze);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    // the glass reflection: the live sky's state, the sun at a quarter (a glint, not a second sun), the skyline
    const ru = this.reflSky.uniforms, su = this.sky.uniforms as unknown as Record<string, THREE.IUniform>;
    for (const k of Object.keys(ru)) { const v = su[k]?.value; if (v === undefined) continue; if (v && typeof (v as THREE.Color).copy === 'function') (ru[k].value as THREE.Color).copy(v as THREE.Color); else ru[k].value = v; }
    ru.uDisc.value = (su.uDisc.value as number) * 0.25; ru.uStars.value = 0;
    const kl = this.skyline.uniforms;
    (kl.uHor.value as THREE.Color).copy(su.uHor.value as THREE.Color); kl.uK.value = su.uK.value; kl.uNight.value = this.night;
    (kl.uCity.value as THREE.Color).copy(su.uCity.value as THREE.Color);
    this.reflCam.update(this.renderer, this.reflScene);
    GZ.uRefl.value = this.reflRT.texture;
    GZ.uReflK.value = THREE.MathUtils.lerp(1.0, 0.85, this.night) * (1 - this.under);
    dome.geometry.dispose(); mat.dispose(); city.geometry.dispose(); (city.material as THREE.Material).dispose();
    haze.geometry.dispose(); (haze.material as THREE.Material).dispose();
  }

  /**
   * Shadow-map refresh: every frame by day; at night the only key is a dim moon whose shadows are barely
   * visible, so the map is re-rendered twice a second instead (the whole shadow pass saved most frames).
   */
  private shadowT = 0;
  shadows(dt: number): void {
    const sm = this.renderer.shadowMap;
    if (this.night < 0.85) { sm.autoUpdate = true; return; }
    sm.autoUpdate = false;
    this.shadowT -= dt;
    if (this.shadowT <= 0) { this.shadowT = 0.5; sm.needsUpdate = true; }
  }

  /** Keep the shadow frustum around what the camera is looking at. */
  follow(target: THREE.Vector3, span: number): void {
    const c = this.sun.shadow.camera;
    const half = THREE.MathUtils.clamp(span, 120, 900);
    if (Math.abs(c.right - half) > 20) {
      c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.updateProjectionMatrix();
    }
    const snap = half * 2 / 4096 * 4;
    const t = new THREE.Vector3(Math.round(target.x / snap) * snap, 0, Math.round(target.z / snap) * snap);
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).addScaledVector(this.keyDir, 1500);
  }
}
