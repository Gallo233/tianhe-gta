import * as THREE from 'three';

/**
 * Street lamps and the player's headlights as a fixed array of lights in every lit material, instead of
 * three.js PointLights / SpotLights.
 *
 * three builds one shader program per light count, evaluates every light for every lit pixel (zero
 * intensity included), and switching lights on at dusk means compiling a new program set mid-game. Here the
 * count never changes: SLOTS lights live in uniform arrays, patched into `lights_fragment_begin` the same
 * way the height fog is patched in, and each pixel skips a light as soon as it is out of its range. In the
 * day every slot has zero range and the loop exits at once.
 *
 * Per slot (view space, updated right before rendering):
 *   gzLampPos   xyz position, w cut-off distance (0 = off)
 *   gzLampCol   rgb colour x intensity (candela, like three's physical lights), w decay exponent
 *   gzLampSpot  xyz spot direction, w cos(outer cone) (-2 = point light)
 *   gzLampPen   x cos(inner cone)
 */
export const SLOTS = 16;

const pos = Array.from({ length: SLOTS }, () => new THREE.Vector4());
const col = Array.from({ length: SLOTS }, () => new THREE.Vector4());
const spot = Array.from({ length: SLOTS }, () => new THREE.Vector4(0, 0, -1, -2));
const pen = Array.from({ length: SLOTS }, () => new THREE.Vector4());
const U = {
  gzLampPos: { value: pos },
  gzLampCol: { value: col },
  gzLampSpot: { value: spot },
  gzLampPen: { value: pen },
  gzLampN: { value: 0 },
};

/** Called from every material's onBeforeCompile (through Sky.fogUniforms). */
export function lampUniforms(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, U);
}

/** World-space lamp description; LampLights.toView() moves it into the uniforms each frame. */
interface Slot { on: boolean; p: THREE.Vector3; d: THREE.Vector3; color: THREE.Color; intensity: number; range: number; decay: number; cone: number; penumbra: number }

export class LampLights {
  private readonly slots: Slot[] = Array.from({ length: SLOTS }, () => ({
    on: false, p: new THREE.Vector3(), d: new THREE.Vector3(0, -1, 0), color: new THREE.Color(), intensity: 0, range: 0, decay: 2, cone: -2, penumbra: 0,
  }));
  private readonly v = new THREE.Vector3();

  /** A point light in slot i (world space). */
  point(i: number, p: THREE.Vector3, color: THREE.Color, intensity: number, range: number, decay = 2): void {
    const s = this.slots[i];
    s.on = intensity > 1e-3; s.p.copy(p); s.color.copy(color); s.intensity = intensity; s.range = range; s.decay = decay; s.cone = -2;
  }

  /** A spot light in slot i: cone half-angle and penumbra as in THREE.SpotLight. */
  spot(i: number, p: THREE.Vector3, dir: THREE.Vector3, color: THREE.Color, intensity: number, range: number, angle: number, penumbra: number, decay = 2): void {
    const s = this.slots[i];
    s.on = intensity > 1e-3; s.p.copy(p); s.d.copy(dir).normalize(); s.color.copy(color); s.intensity = intensity; s.range = range; s.decay = decay;
    s.cone = Math.cos(angle); s.penumbra = Math.cos(angle * (1 - penumbra));
  }

  off(i: number): void { this.slots[i].on = false; }

  /** Pack the lit slots (first) into the uniforms, in the camera's view space. */
  toView(camera: THREE.Camera): void {
    camera.updateMatrixWorld();
    const view = camera.matrixWorldInverse;
    let n = 0;
    for (const s of this.slots) {
      if (!s.on) continue;
      this.v.copy(s.p).applyMatrix4(view);
      pos[n].set(this.v.x, this.v.y, this.v.z, s.range);
      col[n].set(s.color.r * s.intensity, s.color.g * s.intensity, s.color.b * s.intensity, s.decay);
      if (s.cone > -1.5) {
        this.v.copy(s.d).transformDirection(view);
        spot[n].set(this.v.x, this.v.y, this.v.z, s.cone);
        pen[n].set(s.penumbra, 0, 0, 0);
      } else spot[n].w = -2;
      n++;
    }
    U.gzLampN.value = n;
  }
}

let patched = false;
/** Patch the lit-material chunks once, before any lit material compiles. */
export function installLampLighting(): void {
  if (patched) return;
  patched = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.lights_pars_begin += /* glsl */`
    #define GZ_SLOTS ${SLOTS}
    uniform vec4 gzLampPos[GZ_SLOTS];
    uniform vec4 gzLampCol[GZ_SLOTS];
    uniform vec4 gzLampSpot[GZ_SLOTS];
    uniform vec4 gzLampPen[GZ_SLOTS];
    uniform int gzLampN;
  `;
  C.lights_fragment_begin += /* glsl */`
    #if defined( RE_Direct )
    for ( int i = 0; i < GZ_SLOTS; i ++ ) {
      if ( i >= gzLampN ) break;
      vec4 lp = gzLampPos[ i ];
      vec3 lv = lp.xyz - geometryPosition;
      float d2 = dot( lv, lv );
      if ( d2 > lp.w * lp.w ) continue;                          // out of range: most lamps for most pixels
      float d = sqrt( d2 );
      directLight.direction = lv / max( d, 1e-4 );
      vec4 lc = gzLampCol[ i ];
      directLight.color = lc.rgb * getDistanceAttenuation( d, lp.w, lc.w );
      vec4 sp = gzLampSpot[ i ];
      if ( sp.w > -1.5 ) directLight.color *= getSpotAttenuation( sp.w, gzLampPen[ i ].x, dot( directLight.direction, -sp.xyz ) );
      directLight.visible = true;
      RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
    }
    #endif
  `;
}
