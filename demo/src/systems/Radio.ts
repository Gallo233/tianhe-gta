/**
 * Music while riding the e-bike or driving: the player's own recordings, prepared by guangzhou/scripts/gz_music.py
 * into assets/music/ (tracks.json + one mp3 per song, a cover jpg when the file had artwork).
 *
 * One <audio> element streams the current song (no decoding whole songs into memory). Through a MediaElementSource it
 * also feeds an analyser, which the player UI (RadioUI) draws as a spectrum. What is heard:
 *
 *   gain = volume^2 (a perceptual curve) x fade x duck
 *   fade   0 -> 1 in ~0.9 s on getting on a vehicle, back to 0 in ~0.7 s on getting off (then the song pauses where it
 *          was, and picks up there next ride); with `foot` on, the music carries on walking as well
 *   duck   0.3 while somebody is talking (recorded voices, a conversation on screen)
 *   hold   help screen, a hidden tab, the screenshot pause: stop at once, no fade
 *
 * The user's pause (P / the button / the media keys) sticks until they press play again, vehicle or not. Modes: the
 * playlist on a loop, one song on repeat, shuffle. Volume, mode, the song and how far into it are kept in localStorage.
 * With no tracks.json (nothing prepared yet) the radio is empty and the UI says how to add songs.
 */
export interface Track { id: string; title: string; artist: string; lang: string; file: string; dur: number; cover: string }
export type RadioMode = 'list' | 'one' | 'shuffle';
export type RadioEvent = 'track' | 'state' | 'volume' | 'mode' | 'list';

interface Saved { id?: string; t?: number; vol?: number; mode?: RadioMode; foot?: boolean; paused?: boolean; muted?: boolean }

const KEY = 'gz.radio';
const FADE_IN = 0.9, FADE_OUT = 0.7, DUCK = 0.3;

function load(): Saved { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Saved; } catch { return {}; } }

export class Radio {
  tracks: Track[] = [];
  /** index of the current song in `tracks` (-1: none) */
  cur = -1;
  volume = 0.6;
  muted = false;
  mode: RadioMode = 'list';
  /** keep playing on foot */
  foot = false;
  /** the user pressed pause */
  userPaused = false;
  readonly el: HTMLAudioElement;
  analyser: AnalyserNode | null = null;
  /** what the UI and QA read: is the music meant to be heard right now (before the fade) */
  audible = false;
  /** stop while the tab is hidden (QA turns it off: the test browser's panel may be out of sight) */
  pauseWhenHidden = true;
  /** 0..1 vehicle fade, 0.3..1 duck */
  level = 0;
  duckK = 1;
  private ctx: AudioContext | null = null;
  private wired = false;
  private saveT = 0;
  private listeners: ((e: RadioEvent) => void)[] = [];
  private resumeAt = 0;

  /** where tracks.json's files live (QA swaps in generated clips) */
  constructor(public base = 'assets/music/') {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => { if (this.mode === 'one') { this.el.currentTime = 0; void this.el.play().catch(() => {}); } else this.next(1); });
    this.el.addEventListener('error', () => this.dropBroken());
    this.el.addEventListener('play', () => this.emit('state'));
    this.el.addEventListener('pause', () => this.emit('state'));
    this.el.addEventListener('loadedmetadata', () => {
      if (this.resumeAt > 0 && this.resumeAt < this.el.duration - 2) this.el.currentTime = this.resumeAt;
      this.resumeAt = 0;
    });
    this.mediaKeys();
  }

  on(f: (e: RadioEvent) => void): void { this.listeners.push(f); }
  private emit(e: RadioEvent): void { for (const f of this.listeners) f(e); }

  get track(): Track | null { return this.tracks[this.cur] ?? null; }
  get playing(): boolean { return !this.el.paused; }

  async load(): Promise<number> {
    try {
      const r = await fetch(this.base + 'tracks.json', { cache: 'no-cache' });
      if (r.ok) this.tracks = ((await r.json()) as Track[]).filter((t) => t && t.file);
    } catch { this.tracks = []; }
    const s = load();
    this.volume = Math.min(1, Math.max(0, s.vol ?? this.volume));
    this.mode = s.mode ?? this.mode;
    this.foot = !!s.foot;
    this.userPaused = !!s.paused;
    this.muted = !!s.muted;
    if (this.tracks.length) {
      const i = this.tracks.findIndex((t) => t.id === s.id);
      // first ride ever: a song at random, like switching on the radio
      this.select(i >= 0 ? i : Math.floor(Math.random() * this.tracks.length), false);
      if (i >= 0 && s.t) this.resumeAt = s.t;
    }
    this.emit('list');
    return this.tracks.length;
  }

  /** In a user gesture (the start button): the audio graph for the spectrum, allowed to run from then on. */
  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch { this.ctx = null; }
  }

  private wire(): void {
    if (this.wired || !this.ctx || this.ctx.state !== 'running') return;
    try {
      const src = this.ctx.createMediaElementSource(this.el);
      const an = this.ctx.createAnalyser();
      an.fftSize = 256; an.smoothingTimeConstant = 0.78;
      src.connect(an).connect(this.ctx.destination);
      this.analyser = an;
    } catch { /* plays without the spectrum */ }
    this.wired = true;
  }

  // ------------------------------------------------------------------------------------------ controls
  select(i: number, play = true): void {
    if (!this.tracks.length) return;
    this.cur = ((i % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const t = this.tracks[this.cur];
    this.resumeAt = 0;
    this.el.src = this.base + t.file;
    if (play) this.userPaused = false;
    this.meta();
    this.emit('track');
    this.save();
  }

  /** next / previous song (shuffle: any other one) */
  next(dir = 1): void {
    const n = this.tracks.length;
    if (!n) return;
    if (this.mode === 'shuffle' && n > 1) {
      let k = this.cur;
      while (k === this.cur) k = Math.floor(Math.random() * n);
      this.select(k);
    } else this.select(this.cur + dir);
  }

  /** as on any player: back to the start of this song, or the one before when it has only just begun */
  prev(): void {
    if (this.el.currentTime > 3) { this.el.currentTime = 0; this.userPaused = false; this.emit('state'); return; }
    this.next(-1);
  }

  toggle(): void {
    if (!this.track) return;
    this.userPaused = !this.userPaused;
    this.emit('state');
    this.save();
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, Math.round(v * 100) / 100));
    if (this.volume > 0) this.muted = false;
    this.emit('volume');
    this.save();
  }

  nudgeVolume(d: number): void { this.setVolume((this.muted ? 0 : this.volume) + d); }

  toggleMute(): void { this.muted = !this.muted; this.emit('volume'); this.save(); }

  cycleMode(): void {
    this.mode = this.mode === 'list' ? 'one' : this.mode === 'one' ? 'shuffle' : 'list';
    this.emit('mode');
    this.save();
  }

  setFoot(on: boolean): void { this.foot = on; this.emit('mode'); this.save(); }

  /** jump to a fraction of the song */
  seek(f: number): void {
    const d = this.el.duration || this.track?.dur || 0;
    if (d > 0) this.el.currentTime = Math.min(d - 0.5, Math.max(0, f * d));
    this.emit('state');
  }

  get time(): number { return this.el.currentTime || 0; }
  get duration(): number { return (Number.isFinite(this.el.duration) && this.el.duration) || this.track?.dur || 0; }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number, s: { vehicle: boolean; duck: boolean; hold: boolean }): void {
    const t = this.track;
    this.audible = !!t && !this.userPaused && (s.vehicle || this.foot);
    if (s.hold || !t) {
      if (!this.el.paused) this.el.pause();
      return;
    }
    const want = this.audible ? 1 : 0;
    this.level = want > this.level ? Math.min(1, this.level + dt / FADE_IN) : Math.max(0, this.level - dt / FADE_OUT);
    const dk = s.duck ? DUCK : 1;
    this.duckK += (dk - this.duckK) * Math.min(1, dt * 5);
    const gain = (this.muted ? 0 : this.volume * this.volume) * this.level * this.duckK;
    this.el.volume = Math.min(1, Math.max(0, gain));
    if (this.level > 0 && this.el.paused && this.el.src) {
      this.wire();
      void this.el.play().catch(() => {});
    } else if (this.level <= 0 && !this.el.paused) {
      this.el.pause();
      this.save();
    }
    if ((this.saveT += dt) > 3) { this.saveT = 0; if (!this.el.paused) this.save(); }
  }

  state(): { cur: string | null; playing: boolean; audible: boolean; level: number; duck: number; volume: number; muted: boolean; mode: RadioMode; foot: boolean; paused: boolean; t: number; n: number } {
    return { cur: this.track?.id ?? null, playing: this.playing, audible: this.audible, level: +this.level.toFixed(3), duck: +this.duckK.toFixed(3),
      volume: this.volume, muted: this.muted, mode: this.mode, foot: this.foot, paused: this.userPaused, t: +this.time.toFixed(1), n: this.tracks.length };
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ id: this.track?.id, t: this.time, vol: this.volume, mode: this.mode, foot: this.foot, paused: this.userPaused, muted: this.muted } as Saved));
    } catch { /* private window: forgets */ }
  }

  /** a song that fails to load leaves the list (a file deleted after tracks.json was written) */
  private dropBroken(): void {
    if (this.cur < 0 || !this.el.getAttribute('src')) return;
    this.tracks.splice(this.cur, 1);
    this.emit('list');
    if (this.tracks.length) this.select(this.cur, !this.userPaused);
    else { this.cur = -1; this.el.removeAttribute('src'); this.emit('track'); }
  }

  // ------------------------------------------------------------------------------------------ OS media keys
  private mediaKeys(): void {
    const ms = navigator.mediaSession;
    if (!ms) return;
    const set = (a: MediaSessionAction, f: () => void) => { try { ms.setActionHandler(a, f); } catch { /* unsupported action */ } };
    set('play', () => { this.userPaused = false; this.emit('state'); });
    set('pause', () => { this.userPaused = true; this.emit('state'); });
    set('nexttrack', () => this.next(1));
    set('previoustrack', () => this.prev());
  }

  private meta(): void {
    const t = this.track, ms = navigator.mediaSession;
    if (!t || !ms || typeof MediaMetadata === 'undefined') return;
    ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || t.lang, album: '天河 · 车载音乐',
      artwork: t.cover ? [{ src: this.base + t.cover, sizes: '320x320', type: 'image/jpeg' }] : [] });
  }
}
