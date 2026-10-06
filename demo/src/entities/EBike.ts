import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Ah Jie's delivery e-scooter (guangzhou/scripts/gz_ebike.py -> assets/vehicles/gz_ebike.glb + .json): the
 * model with its moving parts and its live details.
 *
 *   obj          placed in the world: origin on the ground midway between the axles, forward -Z (like DriveCar)
 *   steer        handlebar, fork, cowl and front wheel turn about the raked steering axis (local +Y of the pivot)
 *   wheels       spin with the distance travelled
 *   stand        the side stand folds up while riding
 *   lid          the box lid opens when food goes in or comes out
 *   decals       the Zhunshida logo on the box, the number plate, and the phone on the bars showing the order
 *                (drawn on canvases; the phone refreshes twice a second)
 *   lamps        head lamp brighter at night, tail lamp brightens under braking, indicators when turning
 *
 * Rider points (seat, grips, feet, where a foot goes down) come from the .json, in the Blender frame of the
 * model; `local()` turns them into the obj frame.
 */
export interface EBikeSpec {
  wheel_r: number; axle_f: number[]; axle_r: number[]; rake: number; wheelbase: number; length: number; width: number; height: number;
  seat: number[]; seat_top: number; floor: number; grips: number[][]; feet: number[][]; foot_down: number[];
  box: { w: number; d: number; h: number; y0: number; z0: number }; headlamp: number[]; taillamp: number[];
}

export interface PhoneInfo { phase: 'offer' | 'carrying'; place: string; dist: number; timeLeft: number; cash: number; delivered: number; rating: number; condition: number }

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

/** Blender (x, y, z) of the model -> three.js local (x, z, -y). */
export function bl(v: number[], out = new THREE.Vector3()): THREE.Vector3 { return out.set(v[0], v[2], -v[1]); }

export class EBike {
  readonly obj = new THREE.Group();
  readonly half: THREE.Vector2;
  readonly steerPivot: THREE.Object3D;
  private readonly steerBase: THREE.Quaternion;
  private readonly wheelF: THREE.Object3D;
  private readonly wheelR: THREE.Object3D;
  private readonly stand: THREE.Object3D;
  private readonly lid: THREE.Object3D;
  private readonly head: THREE.MeshStandardMaterial[] = [];
  private readonly tail: THREE.MeshStandardMaterial[] = [];
  private readonly amber: THREE.MeshStandardMaterial[] = [];
  private readonly phone: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture };
  private phoneT = 0;
  private blinkT = 0;
  steer = 0;
  standK = 1;      // 1 down .. 0 folded
  lidK = 0;        // 0 shut .. 1 open
  private lidTarget = 0;
  private lidHold = 0;

  constructor(gltf: GLTF, readonly spec: EBikeSpec) {
    const root = gltf.scene.getObjectByName('ebike') ?? gltf.scene;
    this.obj.add(root);
    this.obj.name = 'ebike';
    this.obj.rotation.order = 'YXZ';
    const find = (n: string) => {
      const o = root.getObjectByName(n);
      if (!o) throw new Error('ebike: missing node ' + n);
      return o;
    };
    this.steerPivot = find('ebike_steer_pivot');
    this.steerBase = this.steerPivot.quaternion.clone();
    this.wheelF = find('kit_ebike_wheel_f');
    this.wheelR = find('kit_ebike_wheel_r');
    this.stand = find('kit_ebike_stand');
    this.lid = find('kit_ebike_lid');
    this.half = new THREE.Vector2(spec.width / 2, spec.length / 2);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[];
      for (const mat of mats) {
        if (/headlamp|drl/.test(mat.name) && !this.head.includes(mat)) this.head.push(mat);
        if (/taillamp/.test(mat.name) && !this.tail.includes(mat)) this.tail.push(mat);
        if (/indicator/.test(mat.name) && !this.amber.includes(mat)) this.amber.push(mat);
      }
    });
    // decals
    const logo = find('ebike_logo') as THREE.Mesh;
    (logo.material as THREE.MeshStandardMaterial).map = this.drawLogo();
    (logo.material as THREE.MeshStandardMaterial).needsUpdate = true;
    const plate = find('ebike_plate') as THREE.Mesh;
    (plate.material as THREE.MeshStandardMaterial).map = this.drawPlate();
    (plate.material as THREE.MeshStandardMaterial).needsUpdate = true;
    const screen = find('ebike_screen') as THREE.Mesh;
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 512;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4; tex.flipY = false;   // glTF UVs
    this.phone = { canvas: cv, tex };
    const sm = screen.material as THREE.MeshStandardMaterial;
    sm.map = tex; sm.emissiveMap = tex; sm.emissive = new THREE.Color(1, 1, 1); sm.emissiveIntensity = 0.9; sm.needsUpdate = true;
    for (const m of [logo, plate, screen]) m.castShadow = false;
    this.drawPhone(null);
  }

  /** A model point (Blender frame of the .json) in the obj's local frame. */
  local(v: number[], out = new THREE.Vector3()): THREE.Vector3 { return bl(v, out); }

  /** Grip `k` (0 left, 1 right) in world space, following the bars. */
  grip(k: number, out: THREE.Vector3): THREE.Vector3 {
    // the grips in the steer frame: the .json has them in the body frame with the bars straight
    const g = this.spec.grips[k];
    bl(g, out);
    this.obj.updateMatrixWorld(true);
    // body-local -> steer-local (bars straight) -> steer-local turned -> world
    const piv = this.steerPivot;
    const inv = new THREE.Matrix4().compose(piv.position, this.steerBase, new THREE.Vector3(1, 1, 1)).invert();
    out.applyMatrix4(inv);
    return piv.localToWorld(out);
  }

  /** Turn the bars (radians, + = left), roll the wheels by the distance travelled (m). */
  pose(steer: number, dist: number, dt: number, night: number, braking: boolean, indicator: number, rearLocked = false): void {
    this.steer = steer;
    this.steerPivot.quaternion.copy(this.steerBase).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), steer));
    const r = this.spec.wheel_r;
    this.wheelF.rotation.x -= dist / r;
    if (!rearLocked) this.wheelR.rotation.x -= dist / r;
    this.stand.rotation.x = -1.22 * (1 - this.standK);
    // lid: opens to 100 degrees, holds, shuts
    if (this.lidHold > 0) { this.lidHold -= dt; if (this.lidHold <= 0) this.lidTarget = 0; }
    this.lidK += (this.lidTarget - this.lidK) * Math.min(1, dt * 5);
    this.lid.rotation.x = 1.75 * this.lidK;
    // lamps
    for (const m of this.head) m.emissiveIntensity = 0.25 + 1.6 * night;
    for (const m of this.tail) m.emissiveIntensity = braking ? 1.6 + 1.5 * night : 0.35 + 0.8 * night;
    this.blinkT += dt;
    const on = indicator !== 0 && Math.floor(this.blinkT * 2.6) % 2 === 0;
    for (const m of this.amber) m.emissiveIntensity = on ? 4 : 0.15;
    void dt;
  }

  /** Open the box lid for a moment (food in / out). */
  openLid(seconds = 1.6): void { this.lidTarget = 1; this.lidHold = seconds; }

  /** The order on the phone (twice a second is plenty). */
  updatePhone(dt: number, info: PhoneInfo | null): void {
    this.phoneT -= dt;
    if (this.phoneT > 0) return;
    this.phoneT = 0.5;
    this.drawPhone(info);
  }

  /** The cradle's clamps hide the top ~64 px and the bottom ~50 px of the 256 x 512 canvas: everything sits between. */
  private drawPhone(info: PhoneInfo | null): void {
    const { canvas, tex } = this.phone;
    const g = canvas.getContext('2d')!;
    const W = canvas.width, H = canvas.height, T0 = 66;
    g.fillStyle = '#0f1417'; g.fillRect(0, 0, W, H);
    // header
    g.fillStyle = '#c6f03c'; g.fillRect(0, T0, W, 46);
    g.fillStyle = '#10140a'; g.font = `900 26px ${FONT}`; g.textAlign = 'left'; g.fillText('准时达 · 骑手', 12, T0 + 32);
    g.font = `700 17px ${FONT}`; g.textAlign = 'right'; g.fillText(`${(info?.rating ?? 4.99).toFixed(2)}★`, W - 10, T0 + 31);
    if (!info) { tex.needsUpdate = true; return; }
    const late = info.phase === 'carrying' && info.timeLeft < 60;
    const col = info.phase === 'offer' ? '#f5ba49' : '#4fe0b0';
    // the route: a stylised map with the leg to go
    const my = T0 + 54;
    g.fillStyle = '#1a2328'; g.fillRect(10, my, W - 20, 120);
    g.strokeStyle = '#2d3a40'; g.lineWidth = 5;
    for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(10, my + 16 + k * 30); g.lineTo(W - 10, my + 8 + k * 32); g.stroke(); }
    g.strokeStyle = col; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(44, my + 100); g.lineTo(84, my + 64); g.lineTo(164, my + 52); g.lineTo(206, my + 20); g.stroke();
    g.fillStyle = '#ffffff'; g.beginPath(); g.arc(44, my + 100, 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = col; g.beginPath(); g.arc(206, my + 20, 10, 0, Math.PI * 2); g.fill();
    // the order
    let y = my + 150;
    g.fillStyle = col; g.textAlign = 'left'; g.font = `800 22px ${FONT}`; g.fillText(info.phase === 'offer' ? '去取餐' : '去送餐', 12, y);
    g.fillStyle = '#9fb0b8'; g.font = `600 18px ${FONT}`; g.textAlign = 'right';
    g.fillText(info.dist < 1000 ? `${Math.round(info.dist)} m` : `${(info.dist / 1000).toFixed(1)} km`, W - 12, y);
    y += 30;
    g.fillStyle = '#ffffff'; g.textAlign = 'left'; g.font = `700 19px ${FONT}`;
    g.fillText(info.place.length > 12 ? info.place.slice(0, 12) + '…' : info.place, 12, y);
    y += 16;
    if (info.phase === 'carrying') {
      const m = Math.max(0, Math.floor(info.timeLeft / 60)), sec = Math.max(0, Math.floor(info.timeLeft % 60));
      g.fillStyle = late ? '#ff5a5a' : '#c6f03c'; g.font = `900 50px ${FONT}`;
      g.fillText(`${m}:${String(sec).padStart(2, '0')}`, 12, y + 46);
      // the food's condition
      const c = Math.max(0, Math.min(1, info.condition));
      g.fillStyle = '#9fb0b8'; g.font = `600 15px ${FONT}`; g.textAlign = 'right'; g.fillText('餐品', W - 12, y + 18);
      g.fillStyle = c > 0.9 ? '#4fe0b0' : c > 0.5 ? '#f5ba49' : '#ff5a5a'; g.font = `800 22px ${FONT}`; g.fillText(`${Math.round(c * 100)}%`, W - 12, y + 44);
      g.fillStyle = '#26323a'; g.fillRect(12, y + 58, W - 24, 8);
      g.fillStyle = c > 0.9 ? '#4fe0b0' : c > 0.5 ? '#f5ba49' : '#ff5a5a'; g.fillRect(12, y + 58, (W - 24) * c, 8);
      g.fillStyle = late ? '#ff5a5a' : '#9fb0b8'; g.font = `600 14px ${FONT}`; g.textAlign = 'left';
      g.fillText(late ? '即将超时！小准提醒您注意安全' : '小准已为您规划最优路线', 12, y + 88);
    } else {
      g.fillStyle = '#c6f03c'; g.font = `700 19px ${FONT}`; g.fillText(`今日 ${info.delivered} 单 · ¥${info.cash}`, 12, y + 34);
      g.fillStyle = '#9fb0b8'; g.font = `600 14px ${FONT}`; g.fillText('新订单已自动接单 · 请尽快取餐', 12, y + 60);
    }
    tex.needsUpdate = true;
  }

  private drawLogo(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 300;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#1b1d1f';
    g.beginPath(); g.roundRect(0, 0, 512, 300, 34); g.fill();
    // the clock-bolt mark
    g.strokeStyle = '#c6f03c'; g.lineWidth = 14;
    g.beginPath(); g.arc(96, 150, 62, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#c6f03c';
    g.beginPath(); g.moveTo(104, 96); g.lineTo(70, 160); g.lineTo(98, 160); g.lineTo(88, 206); g.lineTo(126, 138); g.lineTo(98, 138); g.closePath(); g.fill();
    g.textAlign = 'left';
    g.font = `900 104px ${FONT}`; g.fillText('准时达', 180, 162);
    g.fillStyle = '#ffffff'; g.font = `700 38px ${FONT}`; g.fillText('30分钟 必达', 184, 226);
    g.font = `600 22px ${FONT}`; g.fillStyle = '#9aa3a8'; g.fillText('ZHUNSHIDA  ·  RIDER 4.99', 184, 266);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.flipY = false;
    return t;
  }

  private drawPlate(): THREE.CanvasTexture {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 204;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#e9f2ea'; g.fillRect(0, 0, 320, 204);
    g.strokeStyle = '#1f7a45'; g.lineWidth = 10; g.strokeRect(8, 8, 304, 188);
    g.fillStyle = '#1f7a45'; g.textAlign = 'center';
    g.font = `800 40px ${FONT}`; g.fillText('广州', 160, 66);
    g.font = `900 84px "DIN Alternate", "Arial Narrow", ${FONT}`; g.fillText('A·4990', 160, 162);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.flipY = false;
    return t;
  }
}
