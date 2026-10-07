import { analyse, deleteSong, isAudio, listSongs, putSong, type UserSong } from './MusicLibrary';

/**
 * Music while riding the e-bike or driving. Two sources, one playlist:
 *   bundled   songs prepared by guangzhou/scripts/gz_music.py into assets/music/ (tracks.json + one mp3 per song, a
 *             cover jpg when the file had artwork) -- the developer's defaults, not in the release zip by default
 *   added     songs the player adds in the game (「添加音乐」 / dropping files), kept in this browser's IndexedDB
 *             (MusicLibrary): levelled by a per-song gain, leading silence skipped, removable again
 *
 * One <audio> element streams the current song (no decoding whole songs into memory). Through a MediaElementSource it
 * also feeds an analyser, which the player UI (RadioUI) draws as a spectrum. What is heard:
 *
 *   gain = volume^2 (a perceptual curve) x fade x duck x the song's own gain (added songs; through a GainNode once
 *          the audio graph is wired, so it may be above 1)
 *   fade   0 -> 1 in ~0.9 s on getting on a vehicle, back to 0 in ~0.7 s on getting off (then the song pauses where it
 *          was, and picks up there next ride); with `foot` on, the music carries on walking as well
 *   duck   0.3 while somebody is talking (recorded voices, a conversation on screen)
 *   hold   help screen, a hidden tab, the screenshot pause: stop at once, no fade
 *
 * The user's pause (P / the button / the media keys) sticks until they press play again, vehicle or not. Modes: the
 * playlist on a loop, one song on repeat, shuffle. Volume, mode, the song and how far into it are kept in localStorage.
 * With no songs at all the radio is empty and the UI offers 「添加音乐」.
 */
export interface Track {
  id: string; title: string; artist: string; lang: string; file: string; dur: number; cover: string;
  /** added in the game: the stored file and cover as object URLs, the levelling gain, where the sound starts */
  user?: boolean; src?: string; art?: string; gain?: number; skip?: number;
}
export interface AddResult { added: Track[]; failed: [string, string][] }
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
  private trackGain: GainNode | null = null;
  private asked = false;

  /** where tracks.json's files live (QA swaps in generated clips) */
  constructor(public base = 'assets/music/') {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => { if (this.mode === 'one') { this.el.currentTime = this.track?.skip ?? 0; void this.el.play().catch(() => {}); } else this.next(1); });
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
  url(t: Track): string { return t.src ?? this.base + t.file; }
  coverUrl(t: Track): string { return t.art ?? (t.cover ? this.base + t.cover : ''); }
  get playing(): boolean { return !this.el.paused; }

  async load(): Promise<number> {
    try {
      const r = await fetch(this.base + 'tracks.json', { cache: 'no-cache' });
      if (r.ok) this.tracks = ((await r.json()) as Track[]).filter((t) => t && t.file);
    } catch { this.tracks = []; }
    this.tracks.push(...(await listSongs()).map((u) => this.fromStore(u)));
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
      const g = this.ctx.createGain();
      g.gain.value = this.track?.gain ?? 1;
      const an = this.ctx.createAnalyser();
      an.fftSize = 256; an.smoothingTimeConstant = 0.78;
      src.connect(g).connect(an).connect(this.ctx.destination);
      this.analyser = an;
      this.trackGain = g;
    } catch { /* plays without the spectrum */ }
    this.wired = true;
  }

  // ------------------------------------------------------------------------------------------ added songs
  private fromStore(u: UserSong): Track {
    return { id: u.id, title: u.title, artist: u.artist, lang: '我的', file: u.name, dur: u.dur, cover: '', user: true,
      src: URL.createObjectURL(u.blob), art: u.cover ? URL.createObjectURL(u.cover) : undefined, gain: u.gain, skip: u.skip };
  }

  /**
   * Add the player's files, one at a time (each is decoded to measure it): the audio ones that decode join the end of
   * the playlist and the browser's store. A song already in the list (same title, artist and length) is not added twice.
   * The first song ever added becomes the current one when there was none. `progress` hears about each file as it starts.
   */
  async addFiles(files: File[], progress?: (i: number, n: number, name: string) => void): Promise<AddResult> {
    const res: AddResult = { added: [], failed: [] };
    const list = files.filter(isAudio);
    for (const f of files) if (!isAudio(f)) res.failed.push([f.name, '不是音频文件']);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      progress?.(i, list.length, f.name);
      try {
        const u = await analyse(f);
        const dup = this.tracks.find((t) => t.title === u.title && t.artist === u.artist && Math.abs(t.dur - u.dur) < 1.5);
        if (dup) { res.failed.push([f.name, `已经在歌单里（${dup.title}）`]); continue; }
        await putSong(u);
        const t = this.fromStore(u);
        this.tracks.push(t);
        res.added.push(t);
        this.emit('list');
      } catch (e) {
        res.failed.push([f.name, e instanceof Error ? e.message : String(e)]);
      }
    }
    if (res.added.length) {
      if (this.cur < 0) this.select(this.tracks.indexOf(res.added[0]), false);
      // ask once that the browser keep them when the disk runs low
      if (!this.asked) { this.asked = true; void navigator.storage?.persist?.().catch(() => false); }
    }
    return res;
  }

  /** take an added song out of the playlist and the store (the bundled ones stay) */
  async remove(i: number): Promise<boolean> {
    const t = this.tracks[i];
    if (!t?.user) return false;
    await deleteSong(t.id);
    const wasCur = i === this.cur, play = wasCur && !this.el.paused;
    this.tracks.splice(i, 1);
    if (t.src) URL.revokeObjectURL(t.src);
    if (t.art) URL.revokeObjectURL(t.art);
    if (i < this.cur) this.cur -= 1;
    this.emit('list');
    if (wasCur) {
      if (this.tracks.length) this.select(Math.min(i, this.tracks.length - 1), play);
      else { this.cur = -1; this.el.removeAttribute('src'); this.el.load(); this.emit('track'); }
    } else this.emit('track');
    this.save();
    return true;
  }

  // ------------------------------------------------------------------------------------------ controls
  select(i: number, play = true): void {
    if (!this.tracks.length) return;
    this.cur = ((i % this.tracks.length) + this.tracks.length) % this.tracks.length;
    const t = this.tracks[this.cur];
    this.resumeAt = t.skip ?? 0;
    this.el.src = this.url(t);
    if (this.trackGain) this.trackGain.gain.value = t.gain ?? 1;
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
    if (this.el.currentTime > 3 + (this.track?.skip ?? 0)) { this.el.currentTime = this.track?.skip ?? 0; this.userPaused = false; this.emit('state'); return; }
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
    // the song's own gain: on the GainNode once wired, else (no audio graph) folded into the element's volume
    const own = this.trackGain ? 1 : (t.gain ?? 1);
    const gain = (this.muted ? 0 : this.volume * this.volume) * this.level * this.duckK * own;
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
    const art = this.coverUrl(t);
    ms.metadata = new MediaMetadata({ title: t.title, artist: t.artist || t.lang, album: '天河 · 车载音乐',
      artwork: art ? [{ src: art, sizes: '320x320', type: 'image/jpeg' }] : [] });
  }
}
