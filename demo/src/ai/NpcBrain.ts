import type { BrainResponse, Observation } from './brainProtocol';

export interface Decision {
  choice: string;   // what the NPC will do (sampled from Jev's distribution)
  p: number;        // Jev's probability for that choice
  top: string;      // Jev's own argmax, for the debug overlay
  seq: number;      // increments on every new decision for this agent (edge-triggered actions)
  at: number;       // performance.now() / 1000 when it arrived
}

export type BrainStatus = 'checking' | 'live' | 'offline';

/**
 * Asks Jev (through the dev/preview server's /api/npc-brain) what the NPCs near the player do next.
 * One request in flight at a time; the next one leaves as soon as the previous answer lands, so
 * decisions refresh about once a second (Jev itself is ~0.5 s from here). Decisions expire after
 * TTL_S; systems fall back to their built-in rules for agents without a live decision, and for every
 * agent when the server has no API key (e.g. a static deploy of dist/).
 */
export class NpcBrain {
  static readonly TTL_S = 4;
  status: BrainStatus = 'checking';
  lastMs = 0;
  calls = 0;
  failures = 0;
  lastAgents = 0;
  private inflight = false;
  private nextAt = 0;
  private reprobeAt = 60;
  private seq = 0;
  private readonly decided = new Map<string, Decision>();

  constructor(private readonly endpoint = 'api/npc-brain', private readonly rng: () => number = Math.random) {
    fetch(`${endpoint}/status`)
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((j: { available?: boolean }) => { this.status = j.available ? 'live' : 'offline'; })
      .catch(() => { this.status = 'offline'; });
  }

  /** Call every frame; gathers observations only when a request is about to leave. */
  tick(gather: () => Observation[]): void {
    const now = performance.now() / 1000;
    // offline after repeated failures: probe again every minute, so the brain comes back with the service
    if (this.status === 'offline' && !this.inflight && now > this.reprobeAt) {
      this.reprobeAt = now + 60;
      fetch(`${this.endpoint}/status`).then((r) => (r.ok ? r.json() : { available: false }))
        .then((j: { available?: boolean }) => { if (j.available) { this.status = 'live'; this.failures = 0; } }).catch(() => {});
    }
    if (this.status !== 'live' || this.inflight || now < this.nextAt) return;
    const agents = gather();
    this.lastAgents = agents.length;
    if (!agents.length) { this.nextAt = now + 0.5; return; }
    this.inflight = true;
    const t0 = performance.now();
    fetch(this.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents }) })
      .then(async (r) => {
        const j = (await r.json()) as BrainResponse;
        if (r.status === 429) return;                           // someone else's request is in flight
        if (!j.ok || !j.decisions) throw new Error(j.error ?? `HTTP ${r.status}`);
        const at = performance.now() / 1000;
        for (const [id, d] of Object.entries(j.decisions)) {
          const choice = this.sample(d.probs);
          this.decided.set(id, { choice, p: d.probs[choice] ?? 0, top: d.choice, seq: ++this.seq, at });
        }
        this.calls++;
        this.lastMs = Math.round(performance.now() - t0);
        this.failures = 0;
      })
      .catch((e: Error) => {
        this.failures++;
        if (this.failures === 1 || this.failures % 10 === 0) console.warn('[npc-brain]', e.message);
        if (this.failures >= 5) this.status = 'offline';        // stop hammering a dead server; rules take over
      })
      .finally(() => {
        this.inflight = false;
        this.nextAt = performance.now() / 1000 + (this.failures ? 2 : 0.25);
      });
  }

  /** The live decision for an agent, or null (never asked, expired, or brain offline). */
  get(id: string): Decision | null {
    const d = this.decided.get(id);
    if (!d || this.status !== 'live') return null;
    return performance.now() / 1000 - d.at > NpcBrain.TTL_S ? null : d;
  }

  /** All live decisions (debug overlay). */
  entries(): [string, Decision][] {
    const now = performance.now() / 1000;
    return [...this.decided].filter(([, d]) => now - d.at <= NpcBrain.TTL_S);
  }

  /**
   * Sample instead of taking the argmax: a driver told "stop 0.86 / honk 0.14" honks now and then,
   * which reads as a crowd of different people. Options under 10 % are dropped so nobody does
   * something Jev considered unreasonable, and weights are p^1.5 so a clear favourite (flee 0.74 vs
   * hurry 0.12) wins ~94 % of the time instead of 86 %.
   */
  private sample(probs: Record<string, number>): string {
    const opts = Object.entries(probs).filter(([, p]) => p >= 0.1).map(([k, p]) => [k, p ** 1.5] as [string, number]);
    if (!opts.length) return Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0];
    const total = opts.reduce((s, [, p]) => s + p, 0);
    let r = this.rng() * total;
    for (const [k, p] of opts) { r -= p; if (r <= 0) return k; }
    return opts[opts.length - 1][0];
  }
}
