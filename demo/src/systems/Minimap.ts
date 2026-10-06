import * as THREE from 'three';

/** Map image: the dark OSM plan from guangzhou/scripts/gz_gameplay.minimap_svg (square, Blender metres). */
const MAP = { cx: -1095.45 + 3788.01 / 2, cy: -2432.63 + 3788.01 / 2, size: 3788.01 };

export interface MapMarker {
  pos: THREE.Vector3;
  color: string;
  kind: 'target' | 'friend' | 'car' | 'bike';
}

/** GTA-style round minimap: player-centred, rotates with the camera, target clamped to the rim. */
export class Minimap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly img = new Image();
  private loaded = false;
  private readonly px: number;
  metresAcross = 320;

  constructor(canvas: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.px = 180 * dpr;
    canvas.width = canvas.height = this.px;
    this.ctx = canvas.getContext('2d')!;
    this.img.onload = () => { this.loaded = true; };
    this.img.src = 'assets/tianhe/minimap.jpg';
  }

  draw(player: THREE.Vector3, cameraYaw: number, markers: MapMarker[]): void {
    const { ctx, px } = this;
    const r = px / 2;
    const scale = px / this.metresAcross;          // canvas px per metre
    const bx = player.x, by = -player.z;          // Blender coordinates
    const fwd = Math.atan2(-Math.cos(cameraYaw), -Math.sin(cameraYaw));
    const rot = -Math.PI / 2 - fwd;
    ctx.clearRect(0, 0, px, px);
    ctx.save();
    ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#1b2227'; ctx.fillRect(0, 0, px, px);
    ctx.translate(r, r); ctx.rotate(rot);
    if (this.loaded) {
      const iw = this.img.width, k = (scale * MAP.size) / iw;
      const u = ((bx - (MAP.cx - MAP.size / 2)) / MAP.size) * iw;
      const v = (1 - (by - (MAP.cy - MAP.size / 2)) / MAP.size) * iw;
      ctx.drawImage(this.img, -u * k, -v * k, iw * k, iw * k);
    }
    for (const m of markers) {
      let dx = (m.pos.x - bx) * scale, dy = -(-m.pos.z - by) * scale;
      const d = Math.hypot(dx, dy), lim = r - 12;
      if (d > lim) { dx *= lim / d; dy *= lim / d; }
      ctx.save(); ctx.translate(dx, dy); ctx.rotate(-rot);
      ctx.fillStyle = m.color; ctx.strokeStyle = '#0c161b'; ctx.lineWidth = 3;
      ctx.beginPath();
      if (m.kind === 'target') ctx.arc(0, 0, px * 0.035, 0, Math.PI * 2);
      else if (m.kind === 'car') ctx.rect(-px * 0.018, -px * 0.03, px * 0.036, px * 0.06);
      else if (m.kind === 'bike') { ctx.arc(-px * 0.02, 0, px * 0.016, 0, Math.PI * 2); ctx.moveTo(px * 0.036, 0); ctx.arc(px * 0.02, 0, px * 0.016, 0, Math.PI * 2); }
      else ctx.arc(0, 0, px * 0.024, 0, Math.PI * 2);
      ctx.stroke(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    // player arrow (always points up = camera forward)
    ctx.save(); ctx.translate(r, r);
    ctx.fillStyle = '#f4efe2'; ctx.strokeStyle = '#0c161b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, -px * 0.05); ctx.lineTo(px * 0.035, px * 0.035); ctx.lineTo(0, px * 0.015); ctx.lineTo(-px * 0.035, px * 0.035); ctx.closePath();
    ctx.stroke(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(244,239,226,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(r, r, r - 2, 0, Math.PI * 2); ctx.stroke();
  }
}
