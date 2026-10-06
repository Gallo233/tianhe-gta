/**
 * Vite dev/preview middleware: POST /api/npc-brain -> TypeSafe Jev.
 *
 * - The API key is read here only (TYPESAFE_API_KEY or ~/.typesafe/key); it never reaches the browser.
 * - The browser sends numeric/enum observations (src/ai/brainProtocol.ts). Every sentence Jev reads is
 *   written here, in the first person of that one NPC. Keeping the shared `state` neutral matters:
 *   putting "the player crashed on the sidewalk" in the shared state made an unrelated walker 30 m away
 *   choose to flee (0.64); per-agent sentences fixed it (1.0 stroll).
 * - One request in flight per server process; extra requests get 429 immediately (the client retries).
 * - Node's global fetch keeps the HTTPS connection alive, which is what brings a call from ~1.5 s to ~0.5 s.
 * GET /api/npc-brain/status -> { available } so the client can fall back to rule-based NPCs.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import {
  CAR_CHOICES, MAX_AGENTS, PED_CHOICES,
  type BrainDecision, type BrainResponse, type CarObservation, type CrashVictim, type CrimeKind, type Observation, type PedObservation, type PlayerSeen,
} from '../src/ai/brainProtocol';

const API_URL = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.JEV_MODEL || 'jev-1.13.0'; // pinned: jev-latest upgrades would silently change NPC behaviour
const TIMEOUT_MS = 4000;
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000;

function loadKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  try {
    return readFileSync(join(homedir(), '.typesafe', 'key'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------ sentences
const n0 = (v: number) => Math.round(v);
const n1 = (v: number) => Math.round(v * 10) / 10;

const PED_CRITERIA: Record<(typeof PED_CHOICES)[number], string> = {
  stroll: '照常散步：周围没有任何危险或异常时',
  stop_watch: '停下来围观：附近有热闹可看、但离我足够远不会伤到我时',
  hurry: '加快脚步走开：有让人不舒服但不紧急的情况时',
  flee: '拔腿就跑、躲开：有东西马上要撞到我、我有危险时',
  turn_back: '掉头往回走：前面的路被挡住或前方有麻烦时',
  call_police: '停下来打电话报警：亲眼看到有人撞人、抢车之类的违法事情、而自己不在危险中时',
};
const CAR_CRITERIA: Record<(typeof CAR_CHOICES)[number], string> = {
  cruise: '正常行驶：前方畅通时',
  slow: '减速慢行：前方有情况需要小心、但还没挡住我时',
  stop: '停车等待：前方被挡住、而且没法安全绕过时',
  overtake: '借对向车道绕过去：前方被挡住很久、对向车道是空的时',
  honk: '按喇叭并减速：前面的车或人挡住我、我想催他让开时',
  speed_up: '加速离开：身后或旁边有危险、需要尽快离开时',
};

const CRIME_WHAT: Record<CrimeKind, string> = {
  hit_person: '开车撞倒了一个路人', steal_car: '把司机赶下车、抢走了一辆车', crash_car: '开车猛撞了另一辆车',
};

const CRASH_WHAT: Record<CrashVictim, string> = {
  car: '一辆车撞上了另一辆车', wall: '一辆车撞上了路边的东西', person: '有辆车把一个路人撞倒在地',
};

function playerSentence(p: PlayerSeen, forCar: boolean): string {
  const d = n0(p.dist);
  if (p.driving) {
    const where = p.onSidewalk ? '在人行道上' : '在马路上';
    if (forCar && p.behind && p.towardMe) return `玩家的车正以 ${n0(p.speedKmh)} km/h ${where}从后面冲过来，离我 ${d} 米。`;
    if (p.towardMe && p.speedKmh > 5) {
      const eta = p.etaS !== null && p.etaS < 6 ? `，大约 ${n1(p.etaS)} 秒后就会到我这里` : '';
      return `玩家开着车以 ${n0(p.speedKmh)} km/h ${where}朝我开过来，离我 ${d} 米${eta}。`;
    }
    if (p.speedKmh < 3) return `玩家的车停在${p.onSidewalk ? '人行道上' : '马路上'}，离我 ${d} 米。`;
    return `玩家开着车以 ${n0(p.speedKmh)} km/h ${where}行驶，离我 ${d} 米，没有朝我这边开。`;
  }
  if (p.towardMe && p.sprinting) return `有个人正在朝我快速冲刺过来，离我 ${d} 米。`;
  if (p.towardMe && p.speedKmh > 2) return `有个人正朝我走过来，离我 ${d} 米。`;
  if (p.speedKmh <= 2) return `有个人站在离我 ${d} 米的地方没动。`;
  return `有个人在离我 ${d} 米的地方走开了。`;
}

function pedQuestion(o: PedObservation): string {
  const who = { walking: '在人行道上散步的路人', standing: '站在人行道上的路人', running: '正在人行道上跑的路人' }[o.doing];
  const parts = [`我是${who}。`];
  if (o.player) parts.push(playerSentence(o.player, false));
  if (o.witness) parts.push(`${n0(o.witness.agoS)} 秒前，我在 ${n0(o.witness.dist)} 米外亲眼看到有人${CRIME_WHAT[o.witness.kind]}。`);
  if (o.blockedS > 1) parts.push(`有人站在我正前方 1 米的人行道上挡住了我的路，已经挡了 ${n0(o.blockedS)} 秒。`);
  if (o.crash) parts.push(`${n0(o.crash.agoS)} 秒前，离我 ${n0(o.crash.dist)} 米的地方${CRASH_WHAT[o.crash.victim]}，${o.crash.towardMe ? '肇事的车正朝我这边来' : '肇事的车没有朝我这边来'}。`);
  if (parts.length === 1) parts.push('我附近 30 米内没有车开上人行道，也没有人朝我跑来，什么特别的事都没有发生。');
  parts.push('我接下来应该怎么做？');
  return parts.join('');
}

function carQuestion(o: CarObservation): string {
  const parts = [o.speedKmh < 2 ? '我是开车的司机，车已经停住。' : `我是开车的司机，车速 ${n0(o.speedKmh)} km/h。`];
  if (o.ahead) {
    const what = { player_car: '玩家的车', player_foot: '一个人', parked_car: '一辆停着的车', car: '前车' }[o.ahead.what];
    const how = o.ahead.what === 'player_foot' ? (o.ahead.moving ? '在我的车道上走动' : '站在车道中间不走') : o.ahead.moving ? '在我的车道上慢慢移动' : '停在我的车道上不动';
    parts.push(`我前方 ${n0(o.ahead.dist)} 米，${what}${how}${o.blockedS > 0.5 ? `，已经挡了我 ${n0(o.blockedS)} 秒` : ''}。`);
    parts.push(o.oncomingClear ? '对向车道是空的。' : '对向车道有车开过来。');
  } else {
    parts.push('前方 60 米内的车道都是畅通的。');
  }
  if (o.signal === 'red') parts.push('前方路口是红灯，我必须在停车线前停下等绿灯。');
  else if (o.signal === 'green') parts.push('前方路口是绿灯。');
  else if (o.signal === 'stop_sign') parts.push('前方是没有红绿灯的路口，我要先停车、让主路的车先走。');
  if (o.player && !(o.ahead && o.ahead.what.startsWith('player'))) parts.push(playerSentence(o.player, true));
  if (o.hitByPlayerAgoS !== null) parts.push(`玩家 ${n0(o.hitByPlayerAgoS)} 秒前开车撞了我的车。`);
  if (o.crash) parts.push(`${n0(o.crash.agoS)} 秒前在离我 ${n0(o.crash.dist)} 米的地方${CRASH_WHAT[o.crash.victim]}。`);
  parts.push('我接下来应该怎么做？');
  return parts.join('');
}

// ----------------------------------------------------------------------------------- validation
const num = (v: unknown, lo: number, hi: number): number => {
  const x = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(hi, Math.max(lo, x));
};
const bool = (v: unknown) => v === true;
const VICTIMS = ['car', 'wall', 'person'] as const;
const oneOf = <T extends string>(v: unknown, opts: readonly T[], dflt: T): T => (opts.includes(v as T) ? (v as T) : dflt);

function cleanPlayer(p: unknown): PlayerSeen | null {
  if (!p || typeof p !== 'object') return null;
  const q = p as Record<string, unknown>;
  return {
    dist: num(q.dist, 0, 200), driving: bool(q.driving), speedKmh: num(q.speedKmh, 0, 250), towardMe: bool(q.towardMe),
    etaS: q.etaS === null || q.etaS === undefined ? null : num(q.etaS, 0, 60), onSidewalk: bool(q.onSidewalk),
    sprinting: bool(q.sprinting), behind: bool(q.behind),
  };
}

function clean(o: unknown): Observation | null {
  if (!o || typeof o !== 'object') return null;
  const q = o as Record<string, unknown>;
  const id = typeof q.id === 'string' && /^[A-Za-z0-9_]{1,12}$/.test(q.id) ? q.id : null;
  if (!id) return null;
  const crash = q.crash && typeof q.crash === 'object' ? (q.crash as Record<string, unknown>) : null;
  if (q.kind === 'ped') {
    const wt = q.witness && typeof q.witness === 'object' ? (q.witness as Record<string, unknown>) : null;
    return {
      id, kind: 'ped', doing: oneOf(q.doing, ['walking', 'standing', 'running'] as const, 'walking'),
      player: cleanPlayer(q.player), blockedS: num(q.blockedS, 0, 120),
      crash: crash ? { agoS: num(crash.agoS, 0, 60), dist: num(crash.dist, 0, 200), towardMe: bool(crash.towardMe), victim: oneOf(crash.victim, VICTIMS, 'car') } : null,
      witness: wt ? { kind: oneOf(wt.kind, ['hit_person', 'steal_car', 'crash_car'] as const, 'crash_car'), agoS: num(wt.agoS, 0, 60), dist: num(wt.dist, 0, 200) } : null,
    };
  }
  if (q.kind === 'car') {
    const ah = q.ahead && typeof q.ahead === 'object' ? (q.ahead as Record<string, unknown>) : null;
    return {
      id, kind: 'car', speedKmh: num(q.speedKmh, 0, 250),
      ahead: ah ? { what: oneOf(ah.what, ['player_car', 'player_foot', 'parked_car', 'car'] as const, 'car'), dist: num(ah.dist, 0, 200), moving: bool(ah.moving) } : null,
      blockedS: num(q.blockedS, 0, 120), oncomingClear: bool(q.oncomingClear), player: cleanPlayer(q.player),
      signal: q.signal === null || q.signal === undefined ? null : oneOf(q.signal, ['red', 'green', 'stop_sign'] as const, 'green'),
      hitByPlayerAgoS: q.hitByPlayerAgoS === null || q.hitByPlayerAgoS === undefined ? null : num(q.hitByPlayerAgoS, 0, 60),
      crash: crash ? { agoS: num(crash.agoS, 0, 60), dist: num(crash.dist, 0, 200), victim: oneOf(crash.victim, VICTIMS, 'car') } : null,
    };
  }
  return null;
}

export function buildQuestions(agents: Observation[]): Record<string, unknown> {
  const qs: Record<string, unknown> = {};
  for (const a of agents) {
    qs[a.id] = a.kind === 'ped'
      ? { type: 'choice', instructions: pedQuestion(a), criteria: PED_CRITERIA }
      : { type: 'choice', instructions: carQuestion(a), criteria: CAR_CRITERIA };
  }
  return qs;
}

const STATE = '海滨城 Costa Brava 傍晚的街道。下面每个问题描述的是城里某一个路人或司机此刻亲眼看到的情况，只根据问题里写的情况回答。';

// ------------------------------------------------------------------------------------- handler
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, code: number, body: BrainResponse | { available: boolean; model: string }): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function npcBrainPlugin(): Plugin {
  const key = loadKey();
  let busy = false;
  let calls = 0, spent = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? '';
    if (url.startsWith('/api/npc-brain/status')) return send(res, 200, { available: Boolean(key), model: MODEL });
    if (!url.startsWith('/api/npc-brain')) return next();
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
    if (!key) return send(res, 503, { ok: false, error: 'no TypeSafe API key on the server' });
    if (busy) return send(res, 429, { ok: false, error: 'busy' });
    busy = true;
    try {
      const raw = JSON.parse(await readBody(req, 64 * 1024)) as { agents?: unknown[] };
      const agents = (Array.isArray(raw.agents) ? raw.agents : []).slice(0, MAX_AGENTS).map(clean).filter((a): a is Observation => a !== null);
      const ids = new Set<string>();
      const uniq = agents.filter((a) => !ids.has(a.id) && ids.add(a.id));
      if (!uniq.length) return send(res, 200, { ok: true, ms: 0, decisions: {} });
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let r: Response;
      try {
        r = await fetch(API_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODEL, state: STATE, questions: buildQuestions(uniq) }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await r.text();
      if (!r.ok) return send(res, 502, { ok: false, error: `Jev HTTP ${r.status}: ${text.slice(0, 200)}` });
      const out = JSON.parse(text) as { answers: Record<string, { choice: string; probabilities: Record<string, number> }>; usage?: { input_tokens?: number } };
      const decisions: Record<string, BrainDecision> = {};
      for (const [id, a] of Object.entries(out.answers ?? {})) decisions[id] = { choice: a.choice, probs: a.probabilities };
      const cost = (out.usage?.input_tokens ?? 0) * PRICE_PER_INPUT_TOKEN;
      calls++; spent += cost;
      if (calls % 60 === 1) console.log(`[npc-brain] ${calls} calls, ~$${spent.toFixed(4)} so far (${uniq.length} agents, ${Math.round(performance.now() - t0)} ms)`);
      send(res, 200, { ok: true, ms: Math.round(performance.now() - t0), decisions, costUsd: cost });
    } catch (e) {
      const err = e as Error;
      send(res, err.name === 'AbortError' ? 504 : 500, { ok: false, error: err.name === 'AbortError' ? `Jev timeout > ${TIMEOUT_MS} ms` : err.message });
    } finally {
      busy = false;
    }
  };
  return {
    name: 'costa-npc-brain',
    configureServer(server) { server.middlewares.use((req, res, next) => { void handle(req, res, next); }); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => { void handle(req, res, next); }); },
  };
}
