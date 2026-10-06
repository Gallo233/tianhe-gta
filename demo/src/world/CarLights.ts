import * as THREE from 'three';
import type { LampLights } from './LampLights';
import { GZ } from './Materials';

/**
 * Night driving light:
 *  - HeadlightPools: every car near the camera throws a warm cone of light on the road ahead and a red glow
 *    behind -- additive ground cards laid in the car's own frame (so they tilt with bridge ramps), one draw
 *    call for all of them, no lights in the shaders. On a wet road the SSR pass mirrors them.
 *  - PlayerHeadlights: two real spot lights on the car the player drives (fixed count: they exist all the
 *    time and go dark by day or on foot, so shader programs never recompile).
 */
const MAX = 160;

export class HeadlightPools {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly off = new THREE.Matrix4();

  constructor() {
    // local frame of a car: forward -Z. The card spans x -0.5..0.5, z -1..0 (ahead of the bumper).
    const g = new THREE.PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, -0.5);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: GZ.uNight },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      vertexShader: /* glsl */`
        varying vec2 vP; varying float vDist;
        void main() {
          vP = position.xz;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight;
        varying vec2 vP; varying float vDist;
        void main() {
          float ahead = -vP.y;                                   // 0 at the bumper .. 1 at the far end
          float spread = 0.13 + ahead * 0.42;                    // the cone widens with distance
          float lateral = abs(vP.x) / spread;
          float beam = smoothstep(1.0, 0.35, lateral) * smoothstep(1.0, 0.2, ahead) * smoothstep(0.0, 0.05, ahead);
          beam *= 0.75 + 0.25 * smoothstep(0.2, 0.02, abs(abs(vP.x) - 0.1 * (1.0 - ahead)));   // two lamps near the car
          vec3 c = vec3(1.0, 0.9, 0.72) * beam * 0.55;
          gl_FragColor = vec4(c * uNight * exp(-vDist * 0.004), 1.0);
        }`,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = 'headlight-pools';
  }

  begin(): void { this.n = 0; }

  /** A car (its object's matrix, half width / half length). */
  add(obj: THREE.Object3D, half: THREE.Vector2): void {
    if (this.n >= MAX) return;
    obj.updateMatrix();
    // card 16 m long ahead of the bumper, 7 m wide at the far end
    this.off.makeTranslation(0, 0.07, -half.y + 0.3).multiply(new THREE.Matrix4().makeScale(7, 1, 16));
    this.m.multiplyMatrices(obj.matrix, this.off);
    this.mesh.setMatrixAt(this.n++, this.m);
  }

  end(night: number): void {
    this.mesh.count = night > 0.05 ? this.n : 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class PlayerHeadlights {
  readonly group = new THREE.Group();
  private readonly color = new THREE.Color('#fff1d8');
  private readonly p = new THREE.Vector3();
  private readonly t = new THREE.Vector3();

  /** The two spot slots after the street lamps (LampLights). */
  constructor(private readonly out: LampLights, private readonly first = 14) {
    this.group.name = 'player-headlights';
  }

  /** Follow the car the player drives (or go dark). */
  update(car: THREE.Object3D | null, halfLen: number, night: number): void {
    const on = car && night > 0.05;
    for (let k = 0; k < 2; k++) {
      if (!on) { this.out.off(this.first + k); continue; }
      const x = k ? 0.65 : -0.65;
      car.updateMatrixWorld();
      this.p.set(x, 0.75, -halfLen + 0.2).applyMatrix4(car.matrixWorld);
      this.t.set(x * 2.5, 0, -30).applyMatrix4(car.matrixWorld).sub(this.p);
      this.out.spot(this.first + k, this.p, this.t, this.color, 900 * night, 75, 0.46, 0.55, 1.4);
    }
  }
}
