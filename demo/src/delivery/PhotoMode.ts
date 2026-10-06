import * as THREE from 'three';
import type { Collision } from '../world/Collision';

/**
 * 放门口拍照: the courier leaves the bag at the door and takes the proof photo with the phone. The view goes to the
 * courier's eyes, a phone frame sits in the middle of the screen, the mouse aims, the wheel zooms, Space (or a click,
 * or E) takes the picture, Esc puts the phone away.
 *
 * A photo counts as proof when the bag and the house plate are both inside the frame, in front of the lens and not
 * hidden behind a wall, and the bag is big enough to recognise. The picture itself (the framed part of the screen)
 * is kept as a thumbnail: the phone shows it when a customer later claims "没收到".
 */
export interface PhotoResult { bag: boolean; plate: boolean; near: boolean; good: boolean; thumb: string | null; text: string }

const el = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

export class PhotoMode {
  active = false;
  private yaw = 0;
  private pitch = 0;
  private fov = 70;
  private readonly eye = new THREE.Vector3();
  private bag = new THREE.Vector3();
  private bagTop = new THREE.Vector3();
  private plate = new THREE.Vector3();
  private onDone: ((r: PhotoResult | null) => void) | null = null;
  private pending: PhotoResult | null = null;
  private flashT = 0;
  private waited = 0;
  private savedFov = 55;
  private readonly root = el<HTMLElement>('#photo');
  private readonly frame = el<HTMLElement>('#photo-frame');
  private readonly tagBag = el<HTMLElement>('#photo-bag');
  private readonly tagPlate = el<HTMLElement>('#photo-plate');
  private readonly flash = el<HTMLElement>('#photo-flash');
  /** the last evaluation, live while aiming (tests read it) */
  live: PhotoResult = { bag: false, plate: false, near: false, good: false, thumb: null, text: '' };

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly collision: Collision) {}

  /** eye: the courier's eyes; bag: the bag's base; plate: the house plate (or the door's number). */
  start(eye: THREE.Vector3, bag: THREE.Vector3, plate: THREE.Vector3, onDone: (r: PhotoResult | null) => void): void {
    this.active = true;
    this.eye.copy(eye);
    this.start0.copy(eye);
    this.bag.copy(bag).setY(bag.y + 0.15);
    this.bagTop.copy(bag).setY(bag.y + 0.36);
    this.plate.copy(plate);
    this.onDone = onDone;
    this.pending = null;
    this.savedFov = this.camera.fov;
    this.fov = 70;
    // aim between the bag and the plate
    const mid = this.bag.clone().lerp(this.plate, 0.5);
    const d = mid.sub(this.eye);
    this.yaw = Math.atan2(-d.x, -d.z) + 0.05;
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z)) - 0.04;
    this.root.hidden = false;
    this.apply();
  }

  private readonly start0 = new THREE.Vector3();

  /** look: mouse movement this frame (px); zoom: wheel steps; move: WASD (x right, y forward) to step a little. */
  update(dt: number, look: THREE.Vector2, shoot: boolean, cancel: boolean, zoom: number, move?: THREE.Vector2): void {
    if (!this.active) return;
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.style.opacity = String(this.flashT * 3);
    // the picture is grabbed after the next render; with no render (tests stepping the game) it goes without one
    if (this.pending) { if (++this.waited > 2) { const r = this.pending; this.pending = null; this.finish(r); } return; }
    this.yaw -= look.x * 0.0018 * (this.fov / 70);
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.y * 0.0016 * (this.fov / 70), -1.3, 0.6);
    this.fov = THREE.MathUtils.clamp(this.fov + zoom * 4, 28, 80);
    if (move && move.lengthSq() > 0) {
      // step around (within 2 m of where the phone came out), never through a wall
      const f = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)), r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const d = f.multiplyScalar(move.y).add(r.multiplyScalar(move.x));
      const L = d.length() * 1.4 * dt;
      if (L > 0) {
        d.normalize();
        if (this.collision.raycastDistance(this.eye, d, L + 0.35) > L + 0.3) this.eye.addScaledVector(d, L);
        const off = this.eye.clone().sub(this.start0).setY(0);
        if (off.length() > 2) this.eye.copy(this.start0).add(off.setLength(2)).setY(this.eye.y);
      }
    }
    this.apply();
    this.live = this.evaluate();
    this.tagBag.classList.toggle('ok', this.live.bag && this.live.near);
    this.tagPlate.classList.toggle('ok', this.live.plate);
    this.tagBag.textContent = this.live.bag ? (this.live.near ? '外卖 ✓' : '外卖太远') : '外卖 ✗';
    this.tagPlate.textContent = this.live.plate ? '门牌 ✓' : '门牌 ✗';
    if (cancel) { this.finish(null); return; }
    if (shoot) {
      this.waited = 0;
      this.pending = { ...this.live };
      this.flashT = 0.35;
    }
  }

  /** Right after the frame is rendered: grab the framed part of the canvas for the thumbnail, then finish. */
  afterRender(canvas: HTMLCanvasElement): void {
    if (!this.active || !this.pending) return;
    const r = this.frameRect(canvas);
    const t = document.createElement('canvas');
    t.width = 180; t.height = 240;
    try {
      t.getContext('2d')!.drawImage(canvas, r.x, r.y, r.w, r.h, 0, 0, t.width, t.height);
      this.pending.thumb = t.toDataURL('image/jpeg', 0.8);
    } catch { this.pending.thumb = null; }
    const res = this.pending;
    this.pending = null;
    this.finish(res);
  }

  private finish(r: PhotoResult | null): void {
    this.active = false;
    this.root.hidden = true;
    this.camera.fov = this.savedFov;
    this.camera.updateProjectionMatrix();
    const f = this.onDone;
    this.onDone = null;
    f?.(r);
  }

  private apply(): void {
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    this.camera.position.copy(this.eye);
    this.camera.lookAt(this.eye.clone().add(dir));
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** The phone frame in canvas pixels (the drawing buffer, not CSS pixels). */
  private frameRect(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } {
    const fr = this.frame.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
    const sx = canvas.width / cr.width, sy = canvas.height / cr.height;
    return { x: (fr.left - cr.left) * sx, y: (fr.top - cr.top) * sy, w: fr.width * sx, h: fr.height * sy };
  }

  /** Is a world point inside the phone frame, in front of the lens and not behind a wall? */
  private inFrame(p: THREE.Vector3): boolean {
    const v = p.clone().project(this.camera);
    if (v.z > 1 || v.z < -1) return false;
    const fr = this.frame.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const x = ((v.x + 1) / 2) * vw, y = ((1 - v.y) / 2) * vh;
    if (x < fr.left || x > fr.right || y < fr.top || y > fr.bottom) return false;
    const d = p.clone().sub(this.camera.position);
    const L = d.length();
    return this.collision.raycastDistance(this.camera.position, d.divideScalar(L), L) >= L - 0.25;
  }

  private evaluate(): PhotoResult {
    const bag = this.inFrame(this.bag), plate = this.inFrame(this.plate);
    // the bag must read as a bag: at least 7% of the frame's height
    const a = this.bag.clone().setY(this.bag.y - 0.15).project(this.camera), b = this.bagTop.clone().project(this.camera);
    const frH = this.frame.getBoundingClientRect().height / window.innerHeight * 2;
    const near = Math.abs(b.y - a.y) > frH * 0.07;
    const good = bag && plate && near;
    const text = good ? '外卖和门牌都拍清楚了' : !bag ? '照片里没有外卖' : !near ? '外卖拍得太小了' : '门牌没拍进去';
    return { bag, plate, near, good, thumb: null, text };
  }
}
