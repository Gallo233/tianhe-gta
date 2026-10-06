/**
 * The metro ride picker shown at the ticket gates: every station on the map with its lines and the fare from
 * here. Arrow keys / W S to move, Enter / E / F to ride, Esc to leave; clickable too. While it is open it eats the
 * keyboard (capture listener on window) so the player does not walk off.
 */
export interface MetroChoice { station: string; en: string; lines: string[]; fare: number; minutes: number; here: boolean }

export class MetroMenu {
  private readonly root: HTMLDivElement;
  private readonly list: HTMLOListElement;
  private readonly title: HTMLElement;
  private items: MetroChoice[] = [];
  private sel = 0;
  private done: ((index: number | null) => void) | null = null;

  constructor(private readonly colours: Record<string, string>) {
    const css = document.createElement('style');
    css.textContent = `
#metro-menu { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(4, 8, 10, 0.45); z-index: 30; }
#metro-menu[hidden] { display: none; }
#metro-menu .card { width: min(520px, calc(100vw - 32px)); max-height: 78vh; overflow: auto; padding: 16px 16px 12px;
  border-radius: 14px; background: rgba(12, 22, 27, 0.92); border: 1px solid rgba(244, 239, 226, 0.18); color: #f4efe2;
  font-family: "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif; }
#metro-menu h2 { margin: 0 0 2px; font-size: 1.1rem; }
#metro-menu p { margin: 0 0 10px; font-size: 0.78rem; color: #9aa6a8; }
#metro-menu ol { list-style: none; margin: 0; padding: 0; }
#metro-menu li { display: grid; grid-template-columns: 1fr auto auto; gap: 10px; align-items: center; padding: 7px 10px;
  border-radius: 9px; cursor: pointer; }
#metro-menu li.sel { background: rgba(245, 186, 73, 0.18); outline: 1px solid rgba(245, 186, 73, 0.55); }
#metro-menu li.here { opacity: 0.45; cursor: default; }
#metro-menu li b { font-size: 0.98rem; }
#metro-menu li small { display: block; color: #9aa6a8; font-size: 0.72rem; }
#metro-menu .lines span { display: inline-block; min-width: 22px; margin-left: 4px; padding: 1px 5px; border-radius: 5px;
  color: #fff; font: 800 0.72rem/1.4 system-ui, sans-serif; text-align: center; }
#metro-menu .fare { font-variant-numeric: tabular-nums; color: #f5ba49; font-weight: 700; font-size: 0.85rem; text-align: right; }
#metro-menu kbd { padding: 0 5px; border: 1px solid rgba(244, 239, 226, 0.3); border-radius: 4px; font: inherit; }`;
    document.head.appendChild(css);
    this.root = document.createElement('div');
    this.root.id = 'metro-menu';
    this.root.hidden = true;
    this.root.innerHTML = '<div class="card"><h2></h2><p>选择目的站 · <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>Enter</kbd> 乘车 · <kbd>Esc</kbd> 离开</p><ol></ol></div>';
    this.title = this.root.querySelector('h2')!;
    this.list = this.root.querySelector('ol')!;
    this.root.addEventListener('pointerdown', (e) => { if (e.target === this.root) this.close(null); });
    document.body.appendChild(this.root);
    window.addEventListener('keydown', this.onKey, true);
  }

  get open(): boolean { return !this.root.hidden; }

  /** `done` gets the chosen item's index, or null when the player walks away. */
  show(from: string, items: MetroChoice[], done: (index: number | null) => void, card?: number): void {
    this.items = items;
    this.done = done;
    this.title.textContent = `${from}站 · 乘地铁${card !== undefined ? ` · 羊城通余额 ¥${card}` : ''}`;
    this.sel = items.findIndex((i) => !i.here);
    this.list.innerHTML = '';
    items.forEach((it, k) => {
      const li = document.createElement('li');
      if (it.here) li.className = 'here';
      const lines = it.lines.map((l) => `<span style="background:${this.colours[l] ?? '#666'}">${l}</span>`).join('');
      li.innerHTML = `<div><b>${it.station}</b><small>${it.en}</small></div><div class="lines">${lines}</div>` +
        `<div class="fare">${it.here ? '当前站' : `¥${it.fare} · ${it.minutes} 分钟`}</div>`;
      li.addEventListener('pointerenter', () => { if (!it.here) { this.sel = k; this.paint(); } });
      li.addEventListener('click', () => { if (!it.here) this.close(it); });
      this.list.appendChild(li);
    });
    this.root.hidden = false;
    if (document.pointerLockElement) document.exitPointerLock();
    this.paint();
  }

  close(choice: MetroChoice | null): void {
    if (!this.open) return;
    this.root.hidden = true;
    const d = this.done;
    this.done = null;
    d?.(choice ? this.items.indexOf(choice) : null);
  }

  private paint(): void {
    [...this.list.children].forEach((li, k) => li.classList.toggle('sel', k === this.sel));
    (this.list.children[this.sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }

  private move(d: number): void {
    const n = this.items.length;
    for (let k = 1; k <= n; k++) {
      const j = (this.sel + d * k + n * 4) % n;
      if (!this.items[j].here) { this.sel = j; break; }
    }
    this.paint();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.open) return;
    e.stopImmediatePropagation();          // also when the event is dispatched on window itself (at-target phase)
    e.preventDefault();
    if (e.code === 'ArrowDown' || e.code === 'KeyS') this.move(1);
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') this.move(-1);
    else if (e.code === 'Enter' || e.code === 'KeyE' || e.code === 'KeyF' || e.code === 'Space') { const it = this.items[this.sel]; if (it && !it.here) this.close(it); }
    else if (e.code === 'Escape') this.close(null);
  };
}
