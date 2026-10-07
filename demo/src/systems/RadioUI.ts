import type { Radio, Track } from './Radio';

/**
 * The music player on the HUD (styles: #radio-mini / #radio-panel in styles.css).
 *
 *   mini    a strip right of the minimap while music plays: cover, title / artist / language, a five-bar spectrum,
 *           the progress along its foot; it also flashes up for a few seconds on any change (a new song, pause,
 *           volume) even on foot, and shows the volume while it is being turned
 *   panel   M: a vinyl peeking out of the cover (spins while playing), the live spectrum, a progress bar you can click
 *           or drag, mode / previous / play-pause / next / keep-playing-on-foot, the volume slider with mute, and the
 *           playlist, and 「添加音乐」 (a file picker; audio files dropped anywhere on the window open the panel and
 *           are added too; songs added that way can be deleted from the list). Opening it gives the mouse back (the game keeps running: you can drive on with the keys);
 *           M, Esc, the x or a click back into the game closes it and takes the mouse again.
 *
 * Covers: the song's own artwork when the file had one, otherwise one drawn here in the song's colours.
 */
// Material Design icons (Apache 2.0)
const ICON = {
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>',
  next: '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>',
  prev: '<path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/>',
  list: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>',
  one: '<path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z"/>',
  shuffle: '<path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  vol: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>',
  mute: '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>',
  walk: '<path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/>',
  close: '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>',
  note: '<path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>',
  add: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>',
  del: '<path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>',
};
const svg = (k: keyof typeof ICON) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[k]}</svg>`;
const MODE_TEXT = { list: '列表循环', one: '单曲循环', shuffle: '随机播放' } as const;

/** the song's colours for a drawn cover: [from, to, accent] */
const PALETTE: Record<string, [string, string, string]> = {
  heijie: ['#1b0f2e', '#5a1a5e', '#ff4fa3'],          // a street at night: violet, neon pink
  riluo_dadao: ['#ff8a3d', '#c2386b', '#ffe08a'],     // sunset orange into rose
  midnight_city: ['#0d1b4b', '#2b5fd9', '#7ef0ff'],   // indigo city lights
  blinding_lights: ['#3a0207', '#d2121f', '#ffd1d1'], // red, as the record
};
function paletteOf(t: Track): [string, string, string] {
  if (PALETTE[t.id]) return PALETTE[t.id];
  let h = 0;
  for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360;
  return [`hsl(${hue} 55% 14%)`, `hsl(${(hue + 40) % 360} 65% 42%)`, `hsl(${(hue + 180) % 360} 90% 75%)`];
}
function glyph(t: Track): string {
  if (/[一-鿿]/.test(t.title)) return t.title[0];
  return t.title.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
const mmss = (s: number) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class RadioUI {
  readonly mini: HTMLElement;
  readonly panel: HTMLElement;
  open = false;
  private flashT = 0;
  private volT = 0;
  private readonly bins = new Uint8Array(128);
  private readonly spec: HTMLCanvasElement;
  private readonly eq: HTMLCanvasElement;
  private dragging = false;
  private phase = 0;
  private bars = new Float32Array(28);
  private shownMini = false;
  private busy = false;
  private drags = 0;
  private msgTimer = 0;

  constructor(private readonly radio: Radio, host: HTMLElement, private readonly hooks: { onOpen(): void; onClose(lock: boolean): void; canOpen(): boolean }) {
    this.mini = document.createElement('div');
    this.mini.id = 'radio-mini';
    this.mini.innerHTML = `
      <div class="rm-cover cover"><img alt="" hidden /><span class="glyph"></span></div>
      <div class="rm-text"><b class="rm-title"></b><span class="rm-sub"><i class="chip"></i><em class="rm-artist"></em></span></div>
      <canvas class="rm-eq" width="60" height="40"></canvas>
      <span class="rm-state">${svg('pause')}</span>
      <kbd class="rm-key">M</kbd>
      <div class="rm-prog"><i></i></div>
      <div class="rm-vol"><span>${svg('vol')}</span><div><i></i></div><b>60</b></div>`;
    this.panel = document.createElement('section');
    this.panel.id = 'radio-panel';
    this.panel.hidden = true;
    this.panel.setAttribute('aria-label', '车载音乐');
    this.panel.innerHTML = `
      <header><span class="rp-badge">${svg('note')}车载音乐</span><span class="rp-where"></span>
        <button class="rp-addbtn" title="从电脑里选歌（可多选），也可以把文件直接拖进窗口">${svg('add')}添加音乐</button>
        <button class="rp-close" title="收起（M）">${svg('close')}</button></header>
      <div class="rp-addmsg" hidden></div>
      <input class="rp-file" type="file" accept="audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus" multiple hidden />
      <div class="rp-now">
        <div class="rp-art"><div class="rp-disc"><i></i></div><div class="rp-cover cover"><img alt="" hidden /><span class="glyph"></span></div></div>
        <div class="rp-info">
          <i class="chip rp-lang"></i>
          <b class="rp-title"></b>
          <span class="rp-artist"></span>
        </div>
      </div>
      <canvas class="rp-spec" width="664" height="84"></canvas>
      <div class="rp-seek"><span class="rp-t0">0:00</span><div class="rp-bar"><i class="rp-fill"></i><i class="rp-knob"></i></div><span class="rp-t1">0:00</span></div>
      <div class="rp-ctrl">
        <button class="rp-mode" title="播放模式">${svg('list')}</button>
        <button class="rp-prev" title="上一首（B）">${svg('prev')}</button>
        <button class="rp-play" title="播放 / 暂停（P）">${svg('play')}</button>
        <button class="rp-next" title="下一首（N）">${svg('next')}</button>
        <button class="rp-foot" title="下车继续听">${svg('walk')}</button>
      </div>
      <div class="rp-modetext"></div>
      <div class="rp-vol"><button class="rp-mute" title="静音">${svg('vol')}</button><input type="range" min="0" max="100" step="1" aria-label="音量" /><b class="rp-volv">60</b></div>
      <ol class="rp-list"></ol>
      <div class="rp-empty" hidden>
        <b>还没有歌</b>
        <p>点「添加音乐」，选你自己电脑里的歌（mp3 / m4a / flac / wav 都行，可以一次选多首），或者把文件直接拖进游戏窗口。</p>
        <p>歌只保存在这个浏览器里，下次打开还在；会自动统一音量、读出歌名歌手和封面。</p>
        <button class="rp-addbig">${svg('add')}添加音乐</button>
      </div>
      <footer><kbd>N</kbd>下一首<kbd>B</kbd>上一首<kbd>P</kbd>暂停<kbd>−</kbd><kbd>=</kbd>音量<kbd>M</kbd>收起</footer>`;
    host.append(this.mini, this.panel);
    this.spec = this.panel.querySelector('.rp-spec')!;
    this.eq = this.mini.querySelector('.rm-eq')!;
    // clicks inside the panel stay in the panel (the game's mousedown would take the pointer lock)
    for (const ev of ['mousedown', 'pointerdown', 'wheel', 'click']) this.panel.addEventListener(ev, (e) => e.stopPropagation());
    const q = <T extends HTMLElement>(s: string) => this.panel.querySelector<T>(s)!;
    q('.rp-close').addEventListener('click', () => this.close(true));
    q('.rp-play').addEventListener('click', () => this.radio.toggle());
    q('.rp-prev').addEventListener('click', () => this.radio.prev());
    q('.rp-next').addEventListener('click', () => this.radio.next(1));
    q('.rp-mode').addEventListener('click', () => this.radio.cycleMode());
    q('.rp-foot').addEventListener('click', () => this.radio.setFoot(!this.radio.foot));
    q('.rp-mute').addEventListener('click', () => this.radio.toggleMute());
    const range = q<HTMLInputElement>('.rp-vol input');
    range.addEventListener('input', () => this.radio.setVolume(Number(range.value) / 100));
    const file = q<HTMLInputElement>('.rp-file');
    for (const b of ['.rp-addbtn', '.rp-addbig']) q(b).addEventListener('click', () => { if (!this.busy) file.click(); });
    file.addEventListener('change', () => { const fs = [...(file.files ?? [])]; file.value = ''; if (fs.length) void this.add(fs); });
    // audio files dragged over the window: the panel opens as the drop target; dropped anywhere, they are added
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      this.drags += 1;
      if (!this.open && this.hooks.canOpen()) this.show();
      this.panel.classList.add('drop');
    });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --this.drags <= 0) { this.drags = 0; this.panel.classList.remove('drop'); } });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.drags = 0; this.panel.classList.remove('drop');
      void this.add([...e.dataTransfer!.files]);
    });
    q('.rp-list').addEventListener('click', (e) => {
      // an added song's bin: the first click arms it (red), a second within 2.5 s deletes
      const del = (e.target as HTMLElement).closest<HTMLElement>('.rl-del');
      if (del) {
        if (del.classList.contains('sure')) void this.radio.remove(Number(del.dataset.del));
        else { del.classList.add('sure'); del.title = '再点一次删除'; setTimeout(() => { del.classList.remove('sure'); del.title = '从歌单删除'; }, 2500); }
        return;
      }
      const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-i]');
      if (!li) return;
      const i = Number(li.dataset.i);
      if (i === this.radio.cur) this.radio.toggle(); else this.radio.select(i);
    });
    const bar = q('.rp-bar');
    const seekAt = (e: PointerEvent) => { const r = bar.getBoundingClientRect(); this.radio.seek((e.clientX - r.left) / r.width); };
    bar.addEventListener('pointerdown', (e) => { this.dragging = true; bar.setPointerCapture(e.pointerId); seekAt(e); });
    bar.addEventListener('pointermove', (e) => { if (this.dragging) seekAt(e); });
    bar.addEventListener('pointerup', () => { this.dragging = false; });
    document.addEventListener('pointerlockchange', () => { if (this.open && document.pointerLockElement) this.close(false); });
    radio.on((e) => {
      if (e === 'list') this.renderList();
      if (e === 'track' || e === 'list') this.renderTrack();
      if (e === 'volume') this.volT = 1.6;
      if (e !== 'list') this.flashT = 3.5;
      this.renderState();
    });
    this.renderList(); this.renderTrack(); this.renderState();
  }

  toggle(): void { if (this.open) this.close(true); else this.show(); }

  /** add the player's files, with progress and the outcome under the button */
  async add(files: File[]): Promise<void> {
    if (this.busy || !files.length) return;
    this.busy = true;
    const btns = [...this.panel.querySelectorAll<HTMLButtonElement>('.rp-addbtn, .rp-addbig')], msg = this.panel.querySelector<HTMLElement>('.rp-addmsg')!;
    for (const b of btns) b.disabled = true;
    clearTimeout(this.msgTimer);
    msg.className = 'rp-addmsg'; msg.hidden = false;
    try {
      const r = await this.radio.addFiles(files, (i, n, name) => { msg.textContent = `正在添加 ${n > 1 ? `${i + 1}/${n} ` : ''}${name} · 统一音量…`; });
      const bad = r.failed.slice(0, 2).map(([n, why]) => `${n}：${why}`).join('；') + (r.failed.length > 2 ? ` 等 ${r.failed.length} 个` : '');
      msg.textContent = r.added.length ? `已添加 ${r.added.length} 首${bad ? `；没加进来的：${bad}` : ''}` : (bad || '没有可添加的歌');
      msg.classList.add(r.added.length ? 'ok' : 'bad');
      if (r.added.length) this.flashT = 3.5;
      // the outcome stays a while (longer when something was left out), then the line folds away
      this.msgTimer = window.setTimeout(() => { msg.hidden = true; }, r.failed.length ? 15000 : 6000);
    } finally {
      this.busy = false;
      for (const b of btns) b.disabled = false;
    }
  }

  show(): void {
    this.open = true;
    this.panel.hidden = false;
    this.panel.classList.remove('out');
    this.renderList(); this.renderTrack(); this.renderState();
    this.hooks.onOpen();
  }

  /** lock: take the mouse back for the game (false when the player already clicked back in) */
  close(lock: boolean): void {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.hooks.onClose(lock);
  }

  // ------------------------------------------------------------------------------------------ rendering
  private setCover(root: Element, t: Track | null): void {
    const img = root.querySelector('img')!, g = root.querySelector<HTMLElement>('.glyph')!, el = root as HTMLElement;
    if (!t) { img.hidden = true; g.textContent = '♪'; el.style.setProperty('--c0', '#1d2a30'); el.style.setProperty('--c1', '#2d4048'); el.style.setProperty('--c2', '#9fb3b8'); return; }
    const [a, b, c] = paletteOf(t);
    el.style.setProperty('--c0', a); el.style.setProperty('--c1', b); el.style.setProperty('--c2', c);
    g.textContent = glyph(t);
    const url = this.radio.coverUrl(t);
    if (url) { img.src = url; img.hidden = false; } else img.hidden = true;
  }

  private renderTrack(): void {
    const t = this.radio.track;
    for (const root of [this.mini.querySelector('.rm-cover')!, this.panel.querySelector('.rp-cover')!]) this.setCover(root, t);
    this.mini.querySelector('.rm-title')!.textContent = t?.title ?? '车载音乐';
    this.mini.querySelector('.rm-artist')!.textContent = t?.artist ?? '';
    this.mini.querySelector('.chip')!.textContent = t?.lang ?? '';
    this.panel.querySelector('.rp-title')!.textContent = t?.title ?? '车载音乐';
    this.panel.querySelector('.rp-artist')!.textContent = t ? (t.artist || '未知歌手') : '暂无歌曲';
    const lang = this.panel.querySelector<HTMLElement>('.rp-lang')!;
    lang.textContent = t?.lang ?? ''; lang.hidden = !t;
    const [, , accent] = t ? paletteOf(t) : ['', '', '#f5ba49'];
    this.panel.style.setProperty('--accent', accent);
    this.mini.style.setProperty('--accent', accent);
    this.panel.querySelectorAll('.rp-list li').forEach((li) => li.classList.toggle('cur', Number((li as HTMLElement).dataset.i) === this.radio.cur));
    this.panel.querySelector<HTMLElement>('.rp-empty')!.hidden = this.radio.tracks.length > 0;
    for (const s of ['.rp-now', '.rp-spec', '.rp-seek', '.rp-ctrl', '.rp-vol', '.rp-list', '.rp-modetext']) this.panel.querySelector<HTMLElement>(s)!.hidden = !this.radio.tracks.length;
  }

  private renderList(): void {
    const ol = this.panel.querySelector('.rp-list')!;
    ol.innerHTML = this.radio.tracks.map((t, i) => `
      <li data-i="${i}" class="${i === this.radio.cur ? 'cur' : ''}">
        <span class="rl-n"><em>${i + 1}</em><span class="rl-eq"><i></i><i></i><i></i></span></span>
        <span class="rl-t"><b>${esc(t.title)}</b><small>${esc(t.artist || '未知歌手')}</small></span>
        <i class="chip">${esc(t.lang)}</i>
        <span class="rl-d">${mmss(t.dur)}</span>
        ${t.user ? `<button class="rl-del" data-del="${i}" title="从歌单删除">${svg('del')}</button>` : '<span></span>'}
      </li>`).join('');
  }

  private renderState(): void {
    const r = this.radio;
    const playing = !r.userPaused && !!r.track;
    this.panel.querySelector('.rp-play')!.innerHTML = svg(playing ? 'pause' : 'play');
    this.panel.classList.toggle('playing', r.playing);
    this.mini.classList.toggle('playing', r.playing);
    this.mini.querySelector('.rm-state')!.innerHTML = svg(r.userPaused ? 'pause' : 'play');
    this.mini.classList.toggle('paused', r.userPaused);
    const mode = this.panel.querySelector<HTMLElement>('.rp-mode')!;
    mode.innerHTML = svg(r.mode); mode.classList.toggle('on', r.mode !== 'list');
    this.panel.querySelector<HTMLElement>('.rp-foot')!.classList.toggle('on', r.foot);
    this.panel.querySelector('.rp-modetext')!.textContent = `${MODE_TEXT[r.mode]} · ${r.foot ? '下车后继续播放' : '下车自动暂停'}`;
    const v = r.muted ? 0 : Math.round(r.volume * 100);
    const range = this.panel.querySelector<HTMLInputElement>('.rp-vol input')!;
    if (document.activeElement !== range) range.value = String(v);
    range.style.setProperty('--v', `${v}%`);
    this.panel.querySelector('.rp-volv')!.textContent = String(v);
    this.panel.querySelector('.rp-mute')!.innerHTML = svg(v === 0 ? 'mute' : 'vol');
    this.mini.querySelector<HTMLElement>('.rm-vol i')!.style.width = `${v}%`;
    this.mini.querySelector('.rm-vol b')!.textContent = String(v);
    this.mini.querySelector('.rm-vol span')!.innerHTML = svg(v === 0 ? 'mute' : 'vol');
  }

  /** per frame: visibility, progress, the spectra */
  update(dt: number, vehicle: boolean): void {
    const r = this.radio;
    this.flashT = Math.max(0, this.flashT - dt);
    this.volT = Math.max(0, this.volT - dt);
    const has = !!r.track;
    const show = has && !this.open && ((r.audible && r.level > 0.02) || this.flashT > 0 || (vehicle && r.userPaused));
    if (show !== this.shownMini) { this.shownMini = show; this.mini.classList.toggle('show', show); }
    this.mini.classList.toggle('vol', this.volT > 0);
    if (!show && !this.open) return;
    const d = r.duration, f = d > 0 ? Math.min(1, r.time / d) : 0;
    this.mini.querySelector<HTMLElement>('.rm-prog i')!.style.width = `${f * 100}%`;
    if (this.open) {
      this.panel.querySelector<HTMLElement>('.rp-fill')!.style.width = `${f * 100}%`;
      this.panel.querySelector<HTMLElement>('.rp-knob')!.style.left = `${f * 100}%`;
      this.panel.querySelector('.rp-t0')!.textContent = mmss(r.time);
      this.panel.querySelector('.rp-t1')!.textContent = mmss(d);
      this.panel.querySelector('.rp-where')!.textContent = vehicle ? '' : (r.foot ? '步行中 · 继续播放' : '上车后播放');
    }
    this.levels(dt);
    if (this.open) this.drawSpectrum();
    if (show) this.drawEq();
  }

  /** 28 bands, log-spaced, eased (the analyser's own, or a believable stand-in when it is not wired) */
  private levels(dt: number): void {
    const r = this.radio, n = this.bars.length, on = r.playing && r.level > 0;
    this.phase += dt;
    if (r.analyser && on) {
      r.analyser.getByteFrequencyData(this.bins);
      for (let i = 0; i < n; i++) {
        const a = Math.floor(2 * Math.pow(56, i / n)), b = Math.max(a + 1, Math.floor(2 * Math.pow(56, (i + 1) / n)));
        let m = 0;
        for (let k = a; k < b && k < this.bins.length; k++) m = Math.max(m, this.bins[k]);
        const v = Math.pow(m / 255, 1.4) * (0.75 + 0.5 * i / n);
        this.bars[i] += (v - this.bars[i]) * Math.min(1, dt * (v > this.bars[i] ? 22 : 7));
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = on ? 0.25 + 0.22 * Math.sin(this.phase * (3.1 + i * 0.37) + i) * Math.sin(this.phase * 1.7 + i * 0.9) + 0.18 * Math.max(0, Math.sin(this.phase * 4.2)) * (1 - i / n) : 0.03;
        this.bars[i] += (v - this.bars[i]) * Math.min(1, dt * 8);
      }
    }
  }

  private drawSpectrum(): void {
    const c = this.spec, g = c.getContext('2d')!;
    const w = c.width, h = c.height, n = this.bars.length, bw = w / n;
    g.clearRect(0, 0, w, h);
    const accent = getComputedStyle(this.panel).getPropertyValue('--accent').trim() || '#f5ba49';
    const grad = g.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, 'rgba(244,239,226,0.35)'); grad.addColorStop(1, accent);
    g.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      const bh = Math.max(3, this.bars[i] * h);
      const x = i * bw + bw * 0.18, ww = bw * 0.64, y = h - bh;
      g.beginPath(); g.roundRect(x, y, ww, bh, Math.min(ww / 2, 4)); g.fill();
    }
  }

  private drawEq(): void {
    const c = this.eq, g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = getComputedStyle(this.mini).getPropertyValue('--accent').trim() || '#f5ba49';
    const pick = [2, 6, 11, 16, 22];
    pick.forEach((k, i) => {
      const bh = Math.max(4, Math.min(1, this.bars[k] * 1.25) * h);
      g.beginPath(); g.roundRect(i * 12 + 2, h - bh, 8, bh, 3); g.fill();
    });
  }
}
