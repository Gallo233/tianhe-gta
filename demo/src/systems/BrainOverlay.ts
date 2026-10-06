import * as THREE from 'three';
import { CHOICE_LABEL } from '../ai/facts';
import type { NpcBrain } from '../ai/NpcBrain';

/**
 * HUD badge (always) and per-NPC labels (toggle with J): what Jev decided for each nearby NPC and how
 * sure it was. Labels are pooled DOM nodes projected from world space every frame.
 */
export class BrainOverlay {
  visible = false;
  private readonly layer = document.createElement('div');
  private readonly badge = document.createElement('div');
  private readonly pool: HTMLElement[] = [];
  private readonly v = new THREE.Vector3();

  constructor(
    private readonly brain: NpcBrain,
    private readonly headOf: (id: string, out: THREE.Vector3) => THREE.Vector3 | null,
  ) {
    this.layer.id = 'brain-labels';
    this.badge.id = 'brain-badge';
    this.badge.title = 'NPC 决策：TypeSafe Jev（J 显示/隐藏标签）';
    const hud = document.querySelector('#hud')!;
    hud.appendChild(this.layer);
    hud.appendChild(this.badge);
  }

  toggle(): void {
    this.visible = !this.visible;
  }

  update(camera: THREE.Camera, width: number, height: number): void {
    const b = this.brain;
    this.badge.className = b.status;
    this.badge.innerHTML = b.status === 'live'
      ? `<b>JEV</b> ${b.calls ? `${b.lastMs} ms · ${b.lastAgents} 个 NPC` : '连接中…'}<kbd>J</kbd>`
      : b.status === 'checking' ? '<b>JEV</b> 检查中…' : '<b>JEV</b> 离线 · 规则 NPC';
    let used = 0;
    if (this.visible) {
      for (const [id, d] of b.entries()) {
        const p = this.headOf(id, this.v);
        if (!p || p.distanceTo(camera.position) > 70) continue;
        p.project(camera);
        if (p.z > 1 || Math.abs(p.x) > 1.05 || Math.abs(p.y) > 1.05) continue;
        const el = this.pool[used] ?? this.layer.appendChild(document.createElement('span'));
        this.pool[used++] = el;
        el.style.transform = `translate(${((p.x + 1) / 2) * width}px, ${((1 - p.y) / 2) * height}px) translate(-50%, -100%)`;
        const pct = Math.round(d.p * 100);
        el.textContent = `${CHOICE_LABEL[d.choice] ?? d.choice} ${pct}%${d.choice !== d.top ? '*' : ''}`;
        el.dataset.kind = id[0] === 'C' ? 'car' : 'ped';
        el.hidden = false;
      }
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].hidden = true;
  }
}
