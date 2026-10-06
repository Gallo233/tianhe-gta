/**
 * Recorded voices. Every line the game speaks has a clip in assets/voice/ (guangzhou/scripts/gz_voice.py: Alibaba Cloud
 * TTS -- Cantonese for the Guangzhou locals, Mandarin for the platform and the office people), looked up by speaker and
 * subtitle text in index.json; `{}` in an indexed subtitle stands for a number or a name filled in at run time.
 * Speakers recorded twice (customers, staff, passers-by) pick the woman's or the man's take to match who is on screen.
 *
 * Channels: the conversation (one at a time: a new line cuts the last one off, except a line that answers what the
 * courier just said, which waits for it), the street (speech bubbles near the courier: one voice at a time with a
 * breath between lines, silent while the conversation speaks -- the bubble text still shows), and the APM's
 * announcements (Mandarin, then Cantonese, then English). No clip, no sound -- the browser's own speech is never used.
 */
type Entry = Record<string, [string, number]>;          // variant ('' | 'f' | 'm') -> [clip id, seconds]

export class Voice {
  private index: Record<string, Record<string, Entry>> = {};
  private pats: { who: string; re: RegExp; e: Entry }[] = [];
  private talk: HTMLAudioElement | null = null;
  private talkEnd = 0;
  private queued: number | null = null;
  private street: HTMLAudioElement | null = null;
  private streetGain = 0;
  private streetId: string | null = null;
  private streetEnd = 0;
  private streetQuiet = 0;
  private pa: HTMLAudioElement[] = [];
  private paTimer: number | null = null;
  volume = 0.95;
  ready = false;

  constructor(private readonly base = 'assets/voice/') {}

  async load(): Promise<void> {
    try {
      const r = await fetch(this.base + 'index.json');
      if (!r.ok) return;
      this.index = await r.json();
      for (const [who, m] of Object.entries(this.index)) {
        for (const [text, e] of Object.entries(m)) {
          if (!text.includes('{}')) continue;
          const re = new RegExp('^' + text.split('{}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?') + '$');
          this.pats.push({ who, re, e });
        }
      }
      this.ready = true;
    } catch { /* no voices: silent */ }
  }

  get count(): number { return Object.values(this.index).reduce((n, m) => n + Object.keys(m).length, 0); }

  /** The clip for a line, or null: exact subtitle first, then the patterns. */
  find(who: string, text: string, variant = ''): [string, number] | null {
    const e = this.index[who]?.[text] ?? this.pats.find((p) => p.who === who && p.re.test(text))?.e;
    if (!e) return null;
    return e[variant] ?? e[''] ?? e.f ?? e.m ?? null;
  }

  private audio(id: string, gain: number): HTMLAudioElement {
    const a = new Audio(this.base + id + '.mp3');
    a.volume = Math.max(0, Math.min(1, gain * this.volume));
    return a;
  }

  /**
   * A conversation line. `wait`: start when the line now playing ends (an answer to what was just said) instead of
   * cutting it off. Returns the clip's length in seconds, 0 when there is none.
   */
  say(who: string, text: string, variant = '', wait = false): number {
    const c = this.find(who, text, variant);
    if (!c) { if (!wait) this.stopTalk(); return 0; }
    const now = performance.now() / 1000;
    const start = () => {
      this.queued = null;
      this.talk?.pause();
      this.street?.pause();                          // the conversation has the floor
      this.streetEnd = 0;
      this.talk = this.audio(c[0], 1);
      this.talkEnd = performance.now() / 1000 + c[1];
      void this.talk.play().catch(() => {});
    };
    if (this.queued !== null) { clearTimeout(this.queued); this.queued = null; }
    const left = this.talkEnd - now;
    if (wait && this.talk && left > 0.05) this.queued = window.setTimeout(start, (left + 0.15) * 1000);
    else start();
    return c[1];
  }

  /** the street line speaking now (clip id), for QA */
  get streetLine(): string | null { return this.street && performance.now() / 1000 < this.streetEnd ? this.streetId : null; }

  /** a conversation line is being spoken (the music ducks under it) */
  get talking(): boolean { return this.talk !== null && performance.now() / 1000 < this.talkEnd; }

  stopTalk(): void {
    if (this.queued !== null) { clearTimeout(this.queued); this.queued = null; }
    this.talk?.pause();
    this.talk = null;
    this.talkEnd = 0;
  }

  /**
   * A speech bubble out in the street: `gain` falls off with distance (the caller works it out, 0 out of earshot).
   * One street voice at a time: while one speaks, only somebody much nearer (+0.3 gain) may cut in; after it, 1.2 s of quiet
   * (somebody right beside the courier is not kept waiting). Nothing while the conversation channel speaks.
   */
  bubble(who: string, text: string, variant: string, gain: number): void {
    if (gain < 0.05 || this.talking) return;
    const c = this.find(who, text, variant);
    if (!c) return;
    const now = performance.now() / 1000;
    const busy = !!this.street && now < this.streetEnd;            // by the clip's length: a blocked play() still counts
    if (busy && gain - this.streetGain < 0.3) return;
    if (!busy && now < this.streetQuiet && gain < 0.85) return;
    this.street?.pause();
    this.street = this.audio(c[0], gain);
    this.streetId = c[0];
    this.streetGain = gain;
    this.streetEnd = now + c[1];
    this.streetQuiet = now + c[1] + 1.2;
    void this.street.play().catch(() => {});
  }

  /** The APM's announcement for a Mandarin line: Mandarin, Cantonese, English, one after the other. */
  announce(zh: string, gain = 0.85): void {
    for (const a of this.pa) a.pause();
    this.pa = [];
    if (this.paTimer !== null) clearTimeout(this.paTimer);
    const seq = (['apm', 'apm_yue', 'apm_en'] as const).map((w) => this.find(w, zh)).filter((c): c is [string, number] => !!c);
    const step = (i: number) => {
      if (i >= seq.length) return;
      const a = this.audio(seq[i][0], gain);
      this.pa.push(a);
      void a.play().catch(() => {});
      this.paTimer = window.setTimeout(() => step(i + 1), (seq[i][1] + 0.45) * 1000);
    };
    step(0);
  }

  /** Everything off (pause menu, a teleport). */
  silence(): void {
    this.stopTalk();
    for (const a of this.pa) a.pause();
    this.street?.pause();
    this.street = null; this.pa = [];
    this.streetEnd = this.streetQuiet = 0;
    if (this.paTimer !== null) clearTimeout(this.paTimer);
  }
}
