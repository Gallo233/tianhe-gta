import * as THREE from 'three';
import type { CharacterSpec } from '../config';
import type { Jobs } from './Jobs';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing ${sel}`);
  return el;
};

export class Hud {
  private readonly hud = $('#hud');
  private readonly badge = $('#who-badge');
  private readonly name = $('#who-name');
  private readonly role = $('#who-role');
  private readonly cash = $('#cash-value');
  private readonly count = $('#cash-count');
  private readonly objective = $('#objective');
  private readonly objLabel = $('#objective-label');
  private readonly objPlace = $('#objective-place');
  private readonly objDist = $('#objective-dist');
  private readonly objTimer = $('#objective-timer');
  private readonly objFood = $('#objective-food');
  private ratingRole: ((r: number) => string) | null = null;
  private readonly compass = $('#compass');
  private readonly stamina = $('#stamina');
  private readonly staminaFill = $('#stamina-fill');
  private readonly roster = $('#roster');
  private readonly toastEl = $('#toast');
  private readonly speedo = $('#speedo');
  private readonly speedVal = $('#speed-value');
  private readonly prompt = $('#prompt');
  private readonly wanted = $('#wanted');
  private readonly busted = $('#busted');
  private readonly notesEl = $('#notes');
  private readonly orderNote = $('#order-note');
  private readonly orderTitle = $('#order-title');
  private readonly orderText = $('#order-text');
  private readonly notes: { el: HTMLElement; t: number }[] = [];
  private toastTimer = 0;
  private promptHtml = '';
  private bustedTimer = 0;
  private slots: HTMLElement[] = [];

  constructor(specs: CharacterSpec[]) {
    specs.forEach((s, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.style.setProperty('--slot', s.color);
      slot.innerHTML = `<b style="background:${s.color}">${s.name[0]}</b><span>${s.name.split(' ')[0]}</span><kbd>${i + 1}</kbd>`;
      this.roster.appendChild(slot);
      this.slots.push(slot);
    });
  }

  show(visible: boolean): void {
    this.hud.hidden = !visible;
  }

  setCharacter(spec: CharacterSpec, index: number): void {
    this.badge.textContent = spec.name[0];
    this.badge.style.background = spec.color;
    this.name.textContent = spec.name;
    this.role.textContent = spec.role;
    // the courier's role line carries his live rating
    this.ratingRole = /评分/.test(spec.role) ? (r: number) => spec.role.replace(/评分 [0-9.]+/, `评分 ${r.toFixed(2)}`) : null;
    this.slots.forEach((s, i) => s.classList.toggle('active', i === index));
    this.stamina.classList.toggle('infinite', !Number.isFinite(spec.staminaSeconds));
  }

  /** Wanted stars; `seen` makes them flash (a patrol car has eyes on you). */
  setWanted(level: number, seen: boolean): void {
    this.wanted.hidden = level <= 0;
    this.wanted.textContent = '★'.repeat(level) + '☆'.repeat(Math.max(0, 3 - level));
    this.wanted.classList.toggle('seen', seen);
  }

  showBusted(text: string, seconds = 3): void {
    this.busted.textContent = text;
    this.busted.hidden = false;
    this.bustedTimer = seconds;
  }

  get bustedShowing(): boolean {
    return this.bustedTimer > 0;
  }

  isToasting(): boolean {
    return this.toastTimer > 0;
  }

  /** `prompt`: the action hint under the player (HTML, e.g. '<kbd>F</kbd> 上车'), or null for none. */
  setDriving(speed: number | null, prompt: string | null): void {
    this.speedo.hidden = speed === null;
    this.stamina.hidden = speed !== null;
    if (speed !== null) this.speedVal.textContent = String(Math.round(Math.abs(speed) * 3.6));
    this.prompt.hidden = !prompt;
    if (prompt && this.promptHtml !== prompt) { this.prompt.innerHTML = prompt; this.promptHtml = prompt; }
  }

  toast(text: string, kind: 'good' | 'bad' | '' = '', seconds = 2.4): void {
    this.toastEl.textContent = text;
    this.toastEl.className = `show ${kind}`;
    this.toastTimer = seconds;
  }

  /** A message on the phone: a card at the right that fades after a while (4 at most). */
  notify(n: { from: string; text: string; tone?: 'good' | 'bad' | ''; thumb?: string | null; stars?: number }): void {
    const el = document.createElement('div');
    el.className = `note ${n.tone ?? ''}`;
    const stars = n.stars ? `<span class="stars">${'★'.repeat(n.stars)}${'☆'.repeat(5 - n.stars)}</span>` : '';
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    el.innerHTML = `<b>${esc(n.from)}</b>${stars}${esc(n.text)}${n.thumb ? `<img src="${n.thumb}" alt="送达照片">` : ''}`;
    this.notesEl.prepend(el);
    this.notes.unshift({ el, t: 7 + n.text.length * 0.06 });
    while (this.notes.length > 4) this.notes.pop()!.el.remove();
  }

  /** The order card under the objective: the order and the customer's note. */
  setOrder(title: string, note: string): void {
    this.orderNote.hidden = !title;
    if (this.orderTitle.textContent !== title) this.orderTitle.textContent = title;
    if (this.orderText.textContent !== note) this.orderText.textContent = note;
  }

  update(dt: number, jobs: Jobs, player: THREE.Vector3, cameraYaw: number, stamina: number, exhausted: boolean): void {
    this.cash.textContent = `¥${(Math.round(jobs.cash * 10) / 10).toLocaleString('zh-CN')}`;
    this.count.textContent = `${jobs.delivered} 单`;
    for (const n of [...this.notes]) {
      n.t -= dt;
      if (n.t < 0.6) n.el.classList.add('fade');
      if (n.t <= 0) { n.el.remove(); this.notes.splice(this.notes.indexOf(n), 1); }
    }
    const carrying = jobs.phase === 'carrying', none = jobs.phase === 'none';
    this.objective.classList.toggle('carrying', carrying);
    this.objLabel.textContent = none ? '准时达' : carrying ? '送餐' : '取餐';
    const t = jobs.target;
    this.objPlace.textContent = none ? '等待派单…' : t.name;
    const dx = t.pos.x - player.x, dz = t.pos.z - player.z;
    this.objDist.textContent = none ? '' : `${Math.round(Math.hypot(dx, dz))} m`;
    // bearing relative to camera forward (-sin yaw, -cos yaw); screen up = forward
    const bearing = Math.atan2(dx, dz) - Math.atan2(-Math.sin(cameraYaw), -Math.cos(cameraYaw));
    this.compass.style.transform = `rotate(${-bearing}rad)`;
    this.objTimer.hidden = none;
    if (!none) {
      const s = Math.ceil(Math.abs(jobs.timeLeft));
      this.objTimer.textContent = `${jobs.timeLeft < 0 ? '超时 ' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      this.objTimer.classList.toggle('low', jobs.timeLeft < 30);
    }
    this.objFood.hidden = !carrying;
    if (carrying) {
      const c = Math.round(jobs.condition * 100);
      const txt = `餐 ${c}%`;
      if (this.objFood.textContent !== txt) this.objFood.textContent = txt;
      this.objFood.classList.toggle('hurt', c < 90 && c >= 50);
      this.objFood.classList.toggle('bad', c < 50);
    }
    if (this.ratingRole && this.role.textContent !== this.ratingRole(jobs.rating)) this.role.textContent = this.ratingRole(jobs.rating);
    this.staminaFill.style.width = `${Math.round(stamina * 100)}%`;
    this.stamina.classList.toggle('tired', exhausted);
    if (this.bustedTimer > 0) {
      this.bustedTimer -= dt;
      if (this.bustedTimer <= 0) this.busted.hidden = true;
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.className = '';
    }
  }
}
