import * as THREE from 'three';

/**
 * Tiny synthesized sound effects (no audio files). The AudioContext is created on the first user
 * gesture (the start button) because browsers keep it suspended until then.
 */
export class Sfx {
  private ctx: AudioContext | null = null;

  unlock(): void {
    try {
      this.ctx ??= new AudioContext();
      void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  private siren: { osc: OscillatorNode; lfo: OscillatorNode; gain: GainNode } | null = null;

  /** Police siren: a wailing tone, `level` 0..1 (0 silences it). */
  setSiren(level: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (!this.siren && level > 0.01) {
      const osc = ctx.createOscillator(), lfo = ctx.createOscillator(), lfoGain = ctx.createGain(), gain = ctx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 760;
      lfo.type = 'sine'; lfo.frequency.value = 0.45; lfoGain.gain.value = 260;     // 500..1020 Hz wail
      lfo.connect(lfoGain).connect(osc.frequency);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2200;
      gain.gain.value = 0;
      osc.connect(lp).connect(gain).connect(ctx.destination);
      osc.start(); lfo.start();
      this.siren = { osc, lfo, gain };
    }
    if (this.siren) this.siren.gain.gain.setTargetAtTime(0.09 * level, ctx.currentTime, 0.15);
  }

  /** Two-tone car horn, fading out by 80 m. */
  horn(at: THREE.Vector3, listener: THREE.Vector3): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const vol = 0.28 * Math.max(0, 1 - at.distanceTo(listener) / 80);
    if (vol < 0.01) return;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.02);
    gain.gain.setValueAtTime(vol, t + 0.32);
    gain.gain.linearRampToValueAtTime(0, t + 0.42);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1800;
    gain.connect(lp).connect(ctx.destination);
    for (const f of [392, 494]) {
      const o = ctx.createOscillator();
      o.type = 'square'; o.frequency.value = f;
      o.connect(gain);
      o.start(t); o.stop(t + 0.45);
    }
  }

  // ------------------------------------------------------------------------------------------ APM
  private noise: AudioBuffer | null = null;
  private ride: { rumble: GainNode; hum: OscillatorNode; humGain: GainNode; lp: BiquadFilterNode } | null = null;

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < n; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = b * 3.5; }    // brown-ish
    return (this.noise = buf);
  }

  private running(): AudioContext | null {
    const ctx = this.ctx;
    return ctx && ctx.state === 'running' ? ctx : null;
  }

  /** The station chime before an announcement: three rising tones. */
  metroChime(vol = 0.16): number {
    const ctx = this.running();
    if (!ctx) return 0;
    const t = ctx.currentTime;
    [659, 784, 1047].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t0 = t + i * 0.28;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t0); o.stop(t0 + 0.95);
    });
    return 1.1;
  }

  /** Door-closing warning: quick beeps for `seconds`, `vol` by distance. */
  doorBeep(vol: number, seconds = 2.8): void {
    const ctx = this.running();
    if (!ctx || vol < 0.01) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.value = 1320;
    g.gain.value = 0;
    for (let k = 0; k < seconds * 4; k++) {
      const t0 = t + k * 0.25;
      g.gain.setValueAtTime(0.06 * vol, t0);
      g.gain.setValueAtTime(0, t0 + 0.12);
    }
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3000;
    o.connect(lp).connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + seconds + 0.2);
  }

  /** Door leaves moving: a pneumatic hiss and a soft thump at the end. */
  doorAir(vol: number, seconds = 2.5): void {
    const ctx = this.running();
    if (!ctx || vol < 0.01) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35 * vol, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.002, t + seconds * 0.6);
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t); src.stop(t + seconds);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 70;
    og.gain.setValueAtTime(0, t + seconds - 0.1);
    og.gain.linearRampToValueAtTime(0.25 * vol, t + seconds - 0.08);
    og.gain.exponentialRampToValueAtTime(0.001, t + seconds + 0.2);
    o.connect(og).connect(ctx.destination);
    o.start(t + seconds - 0.12); o.stop(t + seconds + 0.25);
  }

  /**
   * A moving APM train: rubber tyres on concrete (rumble) and the traction hum rising with speed.
   * level 0..1 (0 silences it; on board ~1, a train passing the platform by distance), speed m/s.
   */
  setTrain(level: number, speed: number): void {
    const ctx = this.running();
    if (!ctx) return;
    if (!this.ride && level > 0.01) {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx); src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300;
      const rumble = ctx.createGain(); rumble.gain.value = 0;
      src.connect(lp).connect(rumble).connect(ctx.destination);
      src.start();
      const hum = ctx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 90;
      const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 900;
      const humGain = ctx.createGain(); humGain.gain.value = 0;
      hum.connect(hl).connect(humGain).connect(ctx.destination);
      hum.start();
      this.ride = { rumble, hum, humGain, lp };
    }
    if (!this.ride) return;
    const v = Math.min(1, speed / 15);
    const now = ctx.currentTime;
    this.ride.rumble.gain.setTargetAtTime(level * (0.05 + 0.5 * v), now, 0.2);
    this.ride.lp.frequency.setTargetAtTime(160 + 420 * v, now, 0.2);
    this.ride.hum.frequency.setTargetAtTime(70 + 330 * v, now, 0.2);
    this.ride.humGain.gain.setTargetAtTime(level * 0.03 * Math.min(1, v * 3) * (1.1 - v * 0.5), now, 0.2);
  }

  /** the recorded announcer (Game sets it: Voice.announce); the chime plays first */
  speakAnnouncement: ((zh: string) => void) | null = null;
  /** An announcement: the chime, then the recorded Mandarin / Cantonese / English lines for this Mandarin text. */
  announce(zh: string): void {
    const wait = this.metroChime();
    if (!wait) return;
    setTimeout(() => this.speakAnnouncement?.(zh), wait * 1000);
  }

  private ebike: { whine: OscillatorNode; whineGain: GainNode; tyre: GainNode; lp: BiquadFilterNode } | null = null;
  /** The e-bike: hub-motor whine rising with speed and load, tyre hiss; level 0 silences it. */
  setEbike(level: number, speed: number, load: number): void {
    const ctx = this.running();
    if (!ctx) return;
    if (!this.ebike && level > 0.01) {
      const whine = ctx.createOscillator(); whine.type = 'triangle'; whine.frequency.value = 200;
      const whineGain = ctx.createGain(); whineGain.gain.value = 0;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 150;
      whine.connect(hp).connect(whineGain).connect(ctx.destination);
      whine.start();
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx); src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'bandpass'; lp.frequency.value = 900; lp.Q.value = 0.6;
      const tyre = ctx.createGain(); tyre.gain.value = 0;
      src.connect(lp).connect(tyre).connect(ctx.destination);
      src.start();
      this.ebike = { whine, whineGain, tyre, lp };
    }
    if (!this.ebike) return;
    const v = Math.min(1, Math.abs(speed) / 12.5), now = ctx.currentTime;
    this.ebike.whine.frequency.setTargetAtTime(180 + 1500 * v, now, 0.08);
    this.ebike.whineGain.gain.setTargetAtTime(level * (0.004 + 0.02 * v) * (0.5 + 0.8 * Math.max(0, load)), now, 0.08);
    this.ebike.tyre.gain.setTargetAtTime(level * 0.12 * v, now, 0.15);
    this.ebike.lp.frequency.setTargetAtTime(500 + 1400 * v, now, 0.15);
  }

  /** The e-bike horn: two short electronic beeps. */
  ebikeHorn(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const k of [0, 0.16]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 1850;
      g.gain.setValueAtTime(0, t + k);
      g.gain.linearRampToValueAtTime(0.07, t + k + 0.01);
      g.gain.setValueAtTime(0.07, t + k + 0.1);
      g.gain.linearRampToValueAtTime(0, t + k + 0.12);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 1.5;
      o.connect(bp).connect(g).connect(ctx.destination);
      o.start(t + k); o.stop(t + k + 0.14);
    }
  }

  /** A body hitting the ground: a low drop and a short dull noise. */
  thud(vol: number): void {
    const ctx = this.running();
    if (!ctx || vol < 0.02) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    og.gain.setValueAtTime(0.5 * vol, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(og).connect(ctx.destination); o.start(t); o.stop(t + 0.3);
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.35 * vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(lp).connect(g).connect(ctx.destination); src.start(t); src.stop(t + 0.2);
  }

  /** Plastic panels and a steel frame hitting something: a crunch and a few rattles. */
  crunch(vol: number): void {
    const ctx = this.running();
    if (!ctx || vol < 0.02) return;
    const t = ctx.currentTime;
    for (let k = 0; k < 4; k++) {
      const at = t + (k === 0 ? 0 : 0.04 + Math.random() * 0.25);
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = k === 0 ? 900 : 1800 + Math.random() * 2500; bp.Q.value = k === 0 ? 0.8 : 3;
      const g = ctx.createGain(); const v = (k === 0 ? 0.6 : 0.2) * vol, len = k === 0 ? 0.28 : 0.06;
      g.gain.setValueAtTime(v, at); g.gain.exponentialRampToValueAtTime(0.001, at + len);
      src.connect(bp).connect(g).connect(ctx.destination); src.start(at); src.stop(at + len + 0.02);
    }
    this.thud(vol * 0.7);
  }

  private fountain: { hiss: GainNode; roar: GainNode } | null = null;
  /**
   * 花城广场's music fountain (FountainShow): spray hiss and the roar of water falling back into the basin. level 0..1
   * from the distance, power 0..1 how much water is in the air.
   */
  setFountain(level: number, power: number): void {
    const ctx = this.running();
    if (!ctx) return;
    if (!this.fountain && level * power > 0.005) {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx); src.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
      const hiss = ctx.createGain(); hiss.gain.value = 0;
      src.connect(hp).connect(hiss).connect(ctx.destination);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      const roar = ctx.createGain(); roar.gain.value = 0;
      src.connect(lp).connect(roar).connect(ctx.destination);
      src.start();
      this.fountain = { hiss, roar };
    }
    if (!this.fountain) return;
    const now = ctx.currentTime, v = Math.min(1, level) * Math.min(1, power);
    this.fountain.hiss.gain.setTargetAtTime(0.35 * v, now, 0.4);
    this.fountain.roar.gain.setTargetAtTime(0.5 * v, now, 0.4);
  }

  private scrape: { gain: GainNode; bp: BiquadFilterNode } | null = null;
  /** Something sliding on the road (the bike on its side): level 0..1 with the sliding speed. */
  setScrape(level: number): void {
    const ctx = this.running();
    if (!ctx) return;
    if (!this.scrape && level > 0.01) {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer(ctx); src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 1.2;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(bp).connect(gain).connect(ctx.destination); src.start();
      this.scrape = { gain, bp };
    }
    if (!this.scrape) return;
    const now = ctx.currentTime;
    this.scrape.gain.gain.setTargetAtTime(0.16 * Math.min(1, level), now, 0.05);
    this.scrape.bp.frequency.setTargetAtTime(1800 + 1600 * Math.min(1, level), now, 0.1);
  }

  /** The e-bike switching on: the controller's rising two-note chirp. */
  ebikeOn(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    [[0, 1320], [0.11, 1760]].forEach(([k, f]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + k); g.gain.linearRampToValueAtTime(0.06, t + k + 0.01);
      g.gain.setValueAtTime(0.06, t + k + 0.07); g.gain.linearRampToValueAtTime(0, t + k + 0.09);
      o.connect(g).connect(ctx.destination); o.start(t + k); o.stop(t + k + 0.1);
    });
  }

  /** The phone: a soft two-note notification. */
  ping(): void {
    const ctx = this.running();
    if (!ctx) return;
    const t = ctx.currentTime;
    [[0, 1046], [0.09, 1568]].forEach(([k, f]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + k); g.gain.linearRampToValueAtTime(0.045, t + k + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + k + 0.22);
      o.connect(g).connect(ctx.destination); o.start(t + k); o.stop(t + k + 0.25);
    });
  }
}
