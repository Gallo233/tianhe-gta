import * as THREE from 'three';
import type { Jobs, Place } from '../systems/Jobs';
import type { DeliveryPlace, DeliveryWorld } from './DeliveryWorld';
import { LOOKS, type Actor, type Actors, type Look, type Pose } from './Actors';
import type { Dialogue, Step } from './Dialogue';
import type { PhotoMode, PhotoResult } from './PhotoMode';
import {
  AUNTIE_LINES, AWEI_TIPS, CHAPTER1, CUSTOMERS, DECOYS, HELPER_LINES, KITCHEN_BARKS, MERCHANTS, NICK, REVIEW_XZ, ROBOT_LINES, STATION_TALK,
  type Ctx, type Customer, type DropMode, type Merchant, type StoryOrder,
} from './Story';

/**
 * The order game on top of the ledger (Jobs): every order is a little story with a place and people.
 *
 *   assign   a story order (chapter one, one after every ordinary order) or an ordinary one: a shop near the
 *            courier, a customer dealt from the deck, a drop that suits them -- a bus stop or metro exit (meet in
 *            person), an office tower (the guard, the locker, maybe upstairs), a home (leave it at the door, photo)
 *   shop     the staff stand behind the takeaway window; E at the window plays the merchant's script: the food now,
 *            or a wait (E again hurries them; they shout when it is ready). Sometimes a rival courier (阿伟) is
 *            waiting there, or 糖水阿婆 is passing with green-bean soup
 *   drop     handover: the customer and strangers wait at the stop, the order's note says who to look for;
 *            lobby: the guard decides (locker / call them down / beg to go up), the locker takes it;
 *            door: the intercom or a knock, then the bag goes down and the photo is taken (PhotoMode)
 *   after    the review arrives on the phone 25-60 s later (stars, the customer's words, Xiaozhun's lesson); some
 *            customers complain "没收到" -- the photo decides; story orders play their epilogue
 *
 * Kind strangers: after a crash a passer-by walks over, picks the bike up and says something kind.
 * Progress (chapter step, cash, rating, Xiaozhun's pace) is saved in localStorage.
 */
type State = 'toShop' | 'waiting' | 'ready' | 'carrying' | 'done';
interface Drop { kind: 'stop' | 'lobby' | 'home'; name: string; pos: THREE.Vector3; place?: DeliveryPlace; room?: string; cat: string }

export interface Order {
  no: number;
  shop: DeliveryPlace;
  drop: Drop;
  mode: DropMode;
  merchant: Merchant;
  customer: Customer;
  story: StoryOrder | null;
  note: string;
  /** what the customer looks like (handover: the note describes them) */
  look: Look;
  who: string;
  state: State;
  readyAt: number;
  flags: Record<string, unknown>;
  photo: PhotoResult | null;
  /** the lobby: go to the locker now / the customer is coming down */
  toLocker: boolean;
  pay: number;
}

interface Review { at: number; order: Order; stars: number; text: string }
export interface PhoneNote { from: string; text: string; tone?: 'good' | 'bad' | ''; thumb?: string | null; stars?: number }

const TOP_WORD: Record<string, string> = { tee: '短袖', long: '长袖', tank: '背心' };
const COLOUR_WORDS: [string, string][] = [['#f4f1ea', '白'], ['#ffffff', '白'], ['#1f2d4a', '深蓝'], ['#e4664e', '橙红'], ['#2f8f89', '青绿'], ['#f2c14e', '黄'],
  ['#6b7a3a', '军绿'], ['#8e959c', '灰'], ['#232323', '黑'], ['#e8a3b5', '粉'], ['#8cc2e0', '浅蓝'], ['#b04a5a', '酒红']];
const TOPS = COLOUR_WORDS.map((c) => c[0]);
const _v = new THREE.Vector3();

export class Orders {
  order: Order | null = null;
  /** off: no orders are handed out (the vehicle tests switch it off) */
  enabled = true;
  storyStep = 0;
  /** ordinary orders since the last story order */
  sinceStory = 0;
  chapterDone = false;
  private seq = 1300;
  private nextAt = 0;
  private readonly reviews: Review[] = [];
  private readonly complaints: { at: number; order: Order }[] = [];
  private shopActors: Actor[] = [];
  private dropActors: Actor[] = [];
  private placedBag: THREE.Object3D | null = null;
  private helper: Actor | null = null;
  private time = 0;
  /** hooks the game provides */
  notify: (n: PhoneNote) => void = () => {};
  toast: (text: string, tone?: 'good' | 'bad' | '', s?: number) => void = () => {};
  /** advance the world clock (minutes of game time) when time passes in a script */
  skipTime: (seconds: number) => void = () => {};
  stamina: () => void = () => {};
  /** lift a crashed bike (a kind stranger does it) */
  liftBike: () => void = () => {};
  /** the courier's eyes for the photo */
  eye: () => THREE.Vector3 = () => new THREE.Vector3();
  /** distance to the first wall along a ray (the game's static collision) */
  raycast: (o: THREE.Vector3, d: THREE.Vector3, far: number) => number = (_o, _d, far) => far;
  playerCash = (n: number) => { this.jobs.cash += n; };
  /** the food went into the box (the game opens the bike's lid) */
  picked: () => void = () => {};
  /** somewhere a person can stand (on the pavement, level, clear of street furniture) */
  walkable: (p: THREE.Vector3) => boolean = () => true;
  /** a full-screen title card */
  card: (title: string, sub: string) => void = () => {};
  /** the station's couriers (persistent, outside the orders) */
  private stationCrew: Actor[] = [];
  private barkT = 0;
  /** the hotel's delivery robot for the current order */
  private robotObj: { obj: THREE.Object3D; to: THREE.Vector3 } | null = null;

  constructor(private readonly jobs: Jobs, private readonly world: DeliveryWorld, private readonly actors: Actors,
    private readonly dialog: Dialogue, private readonly photo: PhotoMode, private readonly stops: Place[], private readonly rng: () => number) {
    this.load();
  }

  // ------------------------------------------------------------------------------------------ orders
  /** Give the courier the next order (story first when it is due). */
  assign(from: THREE.Vector3): void {
    this.clearScene();
    const story = !this.chapterDone && this.storyStep < CHAPTER1.length && (this.storyStep === 0 || this.sinceStory >= 1) ? CHAPTER1[this.storyStep] : null;
    const o = story ? this.storyOrder(story, from) : this.randomOrder(from);
    if (!o) return;
    this.order = o;
    const shopPlace: Place = { name: o.shop.name, pos: o.shop.pos, cat: o.shop.sub };
    const dropPlace: Place = { name: o.drop.name, pos: o.drop.pos, cat: o.drop.cat };
    this.jobs.assign(shopPlace, dropPlace, from, story?.talkOnly ? 120 : 0);
    if (story?.talkOnly) { o.state = 'carrying'; this.jobs.pick(); }
    if (story?.id === 's1') {
      this.card('第一章', '五星好评');
      const zhou = this.stationCrew.find((a) => a.id === 'zhou');
      if (zhou) this.later(5, () => this.actors.say(zhou, '阿杰！小准又给你派单了？今天第一单，顺顺利利！', 4));
    }
    if (story) {
      this.dialog.play([{ say: `第一章「五星好评」· ${CHAPTER1.indexOf(story) + 1}/${CHAPTER1.length}《${story.title}》` }, ...story.intro], undefined, false);
    } else {
      this.notify({ from: '小准', text: `新订单 #${o.no}：${o.shop.name} → ${o.drop.name}${o.drop.room ? ' ' + o.drop.room : ''}。小准已为您自动接单。`, tone: '' });
    }
  }

  private makeOrder(shop: DeliveryPlace, drop: Drop, mode: DropMode, merchant: Merchant, customer: Customer, story: StoryOrder | null): Order {
    const look: Look = customer.look ? { ...customer.look } : { topColor: TOPS[Math.floor(this.rng() * TOPS.length)], top: this.rng() < 0.6 ? 'tee' : 'long', seed: Math.floor(this.rng() * 1e6) };
    if (look.female === undefined) look.female = this.rng() < 0.45;       // decided now: the voice on the phone is the person who comes down
    const no = ++this.seq % 100 + 1;
    const nick = NICK[Math.floor(this.rng() * NICK.length)];
    let note = customer.note();
    if (mode === 'handover') note += ` · 在${drop.name.replace(/ 公交站$/, '公交站')}等，${this.describe(look)}`;
    return { no, shop, drop, mode, merchant, customer, story, note, look, who: nick, state: 'toShop', readyAt: 0, flags: {}, photo: null, toLocker: false, pay: 0 };
  }

  private describe(l: Look): string {
    const col = COLOUR_WORDS.find((c) => c[0] === l.topColor)?.[1] ?? '';
    return `穿${col}色${TOP_WORD[l.top ?? 'tee'] ?? '衣服'}${l.hair === 'cap' ? '、戴帽子' : ''}${l.sunglasses ? '、戴墨镜' : ''}的人`;
  }

  private shopsNear(p: THREE.Vector3, filter: (s: DeliveryPlace) => boolean): DeliveryPlace[] {
    return this.world.places.filter((s) => s.kind === 'shop' && filter(s)).sort((a, b) => a.pos.distanceTo(p) - b.pos.distanceTo(p));
  }

  private dropFor(mode: DropMode, from: THREE.Vector3, opts: { name?: string; sub?: string } = {}): Drop | null {
    const fit = (p: THREE.Vector3) => { const d = p.distanceTo(from); return d > 180 && d < 900; };
    if (mode === 'handover') {
      const c = this.stops.filter((s) => (s.cat === 'bus' || s.cat === 'metro') && fit(s.pos));
      const s = c[Math.floor(this.rng() * c.length)];
      return s ? { kind: 'stop', name: s.name, pos: s.pos, cat: s.cat } : null;
    }
    const kind = mode === 'lobby' ? 'lobby' : 'home';
    let c = this.world.places.filter((p) => p.kind === kind && (!opts.sub || p.sub === opts.sub));
    if (opts.name) {
      const named = c.find((p) => p.name === opts.name);
      if (named) c = [named];
      else c = c.filter((p) => p.sub === 'tower').sort((a, b) => a.pos.distanceTo(from) - b.pos.distanceTo(from)).slice(0, 1);
    } else {
      const near = c.filter((p) => fit(p.pos));
      c = near.length ? near : c.sort((a, b) => a.pos.distanceTo(from) - b.pos.distanceTo(from)).slice(0, 5);
    }
    const p = c[Math.floor(this.rng() * c.length)];
    return p ? { kind, name: p.name, pos: p.pos, place: p, room: p.room ?? (kind === 'lobby' ? `${8 + Math.floor(this.rng() * 40)}楼` : undefined), cat: p.sub } : null;
  }

  private storyOrder(st: StoryOrder, from: THREE.Vector3): Order | null {
    const byName = (n: string) => this.world.places.find((p) => p.kind === 'shop' && p.name === n);
    const shop = (st.shop && byName(st.shop)) || (st.shopKind === 'fage' && byName('发哥炸鸡'))
      || this.shopsNear(from, (s) => s.sub === 'restaurant')[0];
    if (!shop) return null;
    const drop = st.talkOnly ? this.dropFor('lobby', shop.pos, { name: st.dropName }) : this.dropFor(st.drop, shop.pos, { name: st.dropName, sub: st.dropSub });
    if (!drop) return null;
    if (st.id === 's3' || st.id === 's6') drop.room = '40楼';
    const merchant: Merchant = { id: st.id, weight: 0, pickup: st.pickup, hurry: st.hurry, ready: st.ready };
    const o = this.makeOrder(shop, drop, st.drop, merchant, st.customer, st);
    if (st.id === 's1') o.look = { topColor: '#8e959c', top: 'tee', backpack: '#2b2b2b', seed: 42 };
    o.note = st.customer.note();
    return o;
  }

  private randomOrder(from: THREE.Vector3): Order | null {
    const shops = this.shopsNear(from, (s) => s.name !== '发哥炸鸡').slice(0, 6);
    const shop = shops[Math.floor(this.rng() * shops.length)];
    if (!shop) return null;
    const merchant = this.deal(MERCHANTS);
    for (let k = 0; k < 6; k++) {
      const customer = this.deal(CUSTOMERS);
      const mode = customer.modes[Math.floor(this.rng() * customer.modes.length)];
      const drop = this.dropFor(mode, shop.pos);
      if (drop) return this.makeOrder(shop, drop, mode, merchant, customer, null);
    }
    return null;
  }

  private deal<T extends { weight: number }>(deck: T[]): T {
    const sum = deck.reduce((a, b) => a + b.weight, 0);
    let r = this.rng() * sum;
    for (const d of deck) { r -= d.weight; if (r <= 0) return d; }
    return deck[0];
  }

  // ------------------------------------------------------------------------------------------ the context scripts see
  private ctx(o: Order): Ctx {
    const self = this;
    return {
      get shop() { return o.shop.name; },
      get drop() { return o.drop.name; },
      get room() { return o.drop.room ?? ''; },
      get no() { return o.no; },
      get mode() { return o.mode; },
      get late() { return self.jobs.timeLeft < 0; },
      get condition() { return self.jobs.condition; },
      get minutesLeft() { return Math.floor(self.jobs.timeLeft / 60); },
      ready: (n) => { if (n <= 0) { this.pick(o); return; } o.state = 'waiting'; o.readyAt = this.time + n; },
      pick: () => this.pick(o),
      deliver: (opts) => this.deliver(o, opts ?? {}),
      cash: (n) => { this.playerCash(n); this.toast(`${n >= 0 ? '+' : '−'}¥${Math.abs(n)}`, n >= 0 ? 'good' : 'bad', 1.6); },
      rating: (d) => { this.jobs.rating = THREE.MathUtils.clamp(this.jobs.rating + d, 1, 5); },
      stamina: () => this.stamina(),
      time: (n) => { this.skipTime(n); this.jobs.timeLeft -= n; this.time += n; },
      flag: (k, v = true) => { o.flags[k] = v; },
      has: (k) => !!o.flags[k],
      get: (k) => o.flags[k],
      phone: (from, text) => this.notify({ from, text }),
      comeDown: (s) => this.comeDown(o, s),
      toLocker: () => { o.toLocker = true; this.toast('去外卖柜，按 E 放进去', '', 2.2); },
      // at an office tower "leave it at the door" means the locker
      toPhoto: () => (o.mode === 'lobby' ? (o.toLocker = true, this.toast('去外卖柜，按 E 放进去', '', 2.2)) : this.startPhoto(o)),
    };
  }

  private pick(o: Order): void {
    o.state = 'carrying';
    this.jobs.pick();
    if (o.flags.wrapped) this.jobs.padding = 0.5;
    this.picked();
    const staff = this.shopActors.find((a) => a.tag === 'staff');
    if (staff) this.actors.setPose(staff, 'stand');
    this.toast(o.story?.talkOnly ? '' : `已取餐 · 送往 ${o.drop.name}${o.drop.room ? ' ' + o.drop.room : ''}`, 'good', 2.2);
  }

  private deliver(o: Order, opts: { mult?: number; tip?: number; how?: string }): void {
    if (o.state === 'done') return;
    let mult = opts.mult ?? 1;
    if (o.flags.wrongBag) mult *= 0.5;
    if (opts.how === 'locker') this.playerCash(-0.3);
    const ev = this.jobs.deliver(mult, opts.tip ?? 0);
    o.state = 'done';
    o.pay = (ev.reward ?? 0) + (ev.tip ?? 0);
    const c = this.ctx(o);
    if (mult > 0) this.toast(`送达 ${o.drop.name} · +¥${o.pay}${ev.tip ? `（含打赏 ¥${ev.tip}）` : ''}`, 'good', 3);
    // the review, later
    let { stars, text } = o.customer.review(c);
    if (o.flags.wrongBag) { stars = 1; text = '送错了！我点的不是这个！'; }
    else {
      if (ev.condition !== undefined && ev.condition < 0.7) { stars -= 1; text += ' 汤洒了一半。'; }
      if (this.jobs.timeLeft < 0 && !o.story) stars -= 1;
    }
    stars = THREE.MathUtils.clamp(stars, 1, 5);
    if (!o.story?.talkOnly) this.reviews.push({ at: this.time + (o.story ? 4 : 25 + this.rng() * 35), order: o, stars, text });
    o.customer.after?.(c);
    if (o.flags.complaint) this.complaints.push({ at: this.time + (o.story ? 14 : 45 + this.rng() * 30), order: o });
    if (o.story?.talkOnly) {
      // 王总 goes back up to his fortieth floor
      const w = this.dropActors.find((a) => a.tag === 'cust');
      const door = o.drop.place?.spots.door;
      if (w && door) this.later(1.5, () => this.actors.walkTo(w, door, 1.1, () => this.actors.despawn(w)));
    }
    if (o.story) {
      this.storyStep = CHAPTER1.indexOf(o.story) + 1;
      this.sinceStory = 0;
      if (this.storyStep >= CHAPTER1.length) this.chapterDone = true;
      const after = o.story.after?.(c);
      const end = this.chapterDone ? () => this.later(1.2, () => this.card('第一章 完', '第二章《特殊订单》敬请期待')) : undefined;
      if (after?.length) this.later(2.5, () => this.dialog.play(after, end, false));
    } else this.sinceStory++;
    this.save();
    this.nextAt = this.time + (o.story ? 12 : 6);
  }

  private pending: { at: number; fn: () => void }[] = [];
  private later(s: number, fn: () => void): void { this.pending.push({ at: this.time + s, fn }); }

  // ------------------------------------------------------------------------------------------ people
  private clearScene(): void {
    if (this.robotObj) { this.robotObj.obj.removeFromParent(); this.robotObj = null; }
    for (const a of [...this.shopActors, ...this.dropActors]) this.actors.despawn(a);
    this.shopActors = []; this.dropActors = [];
    if (this.placedBag) { this.placedBag.removeFromParent(); this.placedBag = null; }
  }

  private outward(p: DeliveryPlace): number { return p.yaw + Math.PI; }

  private spawnShop(o: Order): void {
    const s = o.shop;
    const st = s.spots.staff ?? s.spots.counter ?? s.pos;
    const story = o.story?.id;
    let look: Look = s.sub === 'restaurant' ? LOOKS.chef : s.sub === 'tea' ? LOOKS.teaStaff : s.sub === 'convenience' ? LOOKS.clerk : LOOKS.staff;
    let name = '店员', key = 'staff';
    if (s.name === '麦姐煲仔饭') { look = { ...LOOKS.chef, female: true, hair: 'short', topColor: '#f4f1ea', build: 1.12, seed: 7 }; name = '麦姐'; key = 'maijie'; }
    if (s.name === '发哥炸鸡') { look = { ...LOOKS.chef, female: false, rig: 2, build: 1.2, hair: 'bald', seed: 9 }; name = '发哥'; key = 'fage'; }
    if (key === 'staff') this.dialog.speaker('staff', { name: '店员', role: s.name, color: '#e4664e' });
    const a = this.actors.spawn({ name, look, pos: st, yaw: this.outward(s), pose: 'counter', tag: 'staff' });
    a.id = key;
    this.shopActors.push(a);
    // somebody waiting: 阿伟 (a rival courier) or 糖水阿婆, now and then
    const side = new THREE.Vector3(Math.cos(s.yaw), 0, -Math.sin(s.yaw));
    const out = new THREE.Vector3(-Math.sin(s.yaw), 0, -Math.cos(s.yaw));
    if (story !== 's1' && this.rng() < 0.3) {
      const p = s.pos.clone().addScaledVector(side, -2.4).addScaledVector(out, 0.4);
      this.shopActors.push(this.actors.spawn({ name: '阿伟', look: { ...LOOKS.rival, seed: 31 }, pos: p, yaw: this.outward(s) + 0.6, pose: 'phone', tag: 'awei' }));
    }
    if (this.rng() < 0.18) {
      const p = s.pos.clone().addScaledVector(side, 2.8).addScaledVector(out, 1.2);
      const g = this.actors.spawn({ name: '糖水阿婆', look: { ...LOOKS.auntie, seed: 77 }, pos: p, yaw: this.outward(s) + Math.PI * 0.8, pose: 'stand', tag: 'auntie' });
      this.shopActors.push(g);
    }
  }

  private spawnDrop(o: Order): void {
    const d = o.drop;
    if (o.mode === 'handover') {
      const n = 2 + Math.floor(this.rng() * 3);
      const spots: THREE.Vector3[] = [];
      for (let k = 0; k <= n; k++) {
        let p: THREE.Vector3;
        let tries = 0;
        do { const a = this.rng() * Math.PI * 2, r = 1.2 + this.rng() * 4.0; p = d.pos.clone().add(_v.set(Math.cos(a) * r, 0, Math.sin(a) * r)); tries++; }
        while (tries < 40 && (spots.some((q) => q.distanceTo(p) < 1.7) || !this.walkable(p)));
        if (!this.walkable(p)) continue;
        spots.push(p);
      }
      if (!spots.length) spots.push(d.pos.clone());       // the stop's own waiting spot is always on the pavement
      const poses: Pose[] = ['phone', 'stand', 'fold', 'phone'];
      spots.forEach((p, k) => {
        const isCust = k === 0;
        let look: Look;
        if (isCust) look = o.look;
        else {
          // strangers never match the description
          const top = TOPS.filter((t) => t !== o.look.topColor)[Math.floor(this.rng() * (TOPS.length - 1))];
          look = { topColor: top, seed: Math.floor(this.rng() * 1e6) };
        }
        const a = this.actors.spawn({ name: isCust ? o.who : '路人', look, pos: p, yaw: this.rng() * Math.PI * 2, pose: poses[k % poses.length], tag: isCust ? 'cust' : 'decoy' });
        this.dropActors.push(a);
      });
      return;
    }
    const pl = d.place!;
    if (o.mode === 'lobby' && pl.sub === 'hotel' && !o.story) {
      const obj = this.world.robot();
      obj.position.copy(pl.spots.door ?? pl.pos);
      obj.rotation.y = pl.yaw + Math.PI;
      this.actors.group.add(obj);
      // out through the doors, past the stanchions, to just short of where the courier stands
      this.robotObj = { obj, to: pl.pos.clone().lerp(pl.spots.door ?? pl.pos, 0.18) };
      return;
    }
    if (o.mode === 'lobby') {
      const libo = !o.story && this.rng() < 0.22;
      const g = this.actors.spawn({ name: libo ? '李伯' : '保安', look: { ...LOOKS.guard, seed: libo ? 5 : 11, build: libo ? 1.15 : 1.0 }, pos: pl.spots.guard ?? pl.pos, yaw: this.outward(pl), pose: libo ? 'stand' : 'fold', tag: libo ? 'libo' : 'guard' });
      this.dropActors.push(g);
      if (o.story?.id === 's6') {
        const side = new THREE.Vector3(Math.cos(pl.yaw), 0, -Math.sin(pl.yaw));
        const w = this.actors.spawn({ name: '王总', look: LOOKS.boss, pos: pl.pos.clone().addScaledVector(side, 2.2), yaw: this.outward(pl) - 0.8, pose: 'phone', tag: 'cust' });
        this.dropActors.push(w);
      }
    }
  }

  /** The customer walks out of the door to the courier. */
  private comeDown(o: Order, s: number): void {
    const pl = o.drop.place;
    const door = pl?.spots.door ?? o.drop.pos;
    o.flags.comingDown = true;
    this.toast(`顾客说马上下来 · 等 ${Math.round(s)} 秒`, '', 2.2);
    this.later(s, () => {
      if (this.order !== o || o.state === 'done') return;
      const a = this.actors.spawn({ name: o.who, look: o.look, pos: door.clone(), yaw: pl ? pl.yaw + Math.PI : 0, pose: 'stand', tag: 'cust' });
      this.dropActors.push(a);
      this.actors.walkTo(a, o.drop.pos.clone().lerp(door, 0.35), 1.2);
      this.actors.say(a, '外卖？我的我的！', 3);
    });
  }

  /** Which take of a recorded line fits whoever says it: 'f' / 'm' for customers and shop staff, '' for the cast. */
  voiceVariant(who: string): string {
    if (who === 'cust') {
      const a = this.dropActors.find((x) => x.tag === 'cust' && !x.gone);
      return (a ? a.female : this.order?.look.female) ? 'f' : 'm';
    }
    if (who === 'staff') return this.shopActors.find((x) => x.tag === 'staff' && !x.gone)?.female ? 'f' : 'm';
    return '';
  }

  // ------------------------------------------------------------------------------------------ the station
  /** Three couriers at the station: one on the bench with a phone, one at the swap cabinet, one by the table. */
  /** the station's water dispenser, sofa and charging shelf (world space) */
  private stationPts: Record<string, THREE.Vector3> = {};

  /**
   * The station's own little life, with or without an order: a cup of water at the dispenser (stamina), a sit on
   * the sofa (ten minutes pass -- on the order's clock too), the phone on the charging shelf (小准 takes ¥1).
   */
  private stationUse(player: THREE.Vector3, talk: boolean): { prompt: string | null; used: boolean } | null {
    const P = this.stationPts;
    const near = (p: THREE.Vector3 | undefined, r: number) => !!p && Math.hypot(p.x - player.x, p.z - player.z) < r && Math.abs(p.y - player.y) < 1.5;
    if (near(P.water, 0.9)) {
      if (!talk) return { prompt: '<kbd>E</kbd> 接杯水', used: false };
      this.stamina(); this.toast('体力回满 · 驿站的水是免费的（这个月）', 'good', 2);
      return { prompt: null, used: true };
    }
    if (near(P.sofa, 1.0)) {
      if (!talk) return { prompt: '<kbd>E</kbd> 坐下休息', used: false };
      const busy = !!this.order && this.order.state !== 'done';
      this.dialog.play([
        { say: '……我就坐一下。', who: 'ajie' },
        { pause: 1.6 },
        { run: () => { this.skipTime(600); this.time += 600; if (busy) this.jobs.timeLeft -= 600; this.stamina(); } },
        { say: '您已休息十分钟。温馨提示：休息是对奔跑的背叛。', who: 'xz' },
        ...(busy ? [{ say: '您当前订单的剩余时间已同步减少十分钟。祝您工作愉快。', who: 'xz' }] : []),
      ]);
      return { prompt: null, used: true };
    }
    if (near(P.charger, 1.0)) {
      if (!talk) return { prompt: '<kbd>E</kbd> 给手机充电', used: false };
      this.playerCash(-1);
      this.dialog.play([{ say: '充电服务已开通。本次充电费一元，已从您的收入中自动扣除。祝您电量满满。', who: 'xz' }]);
      this.toast('手机电量 100% · −¥1', 'bad', 1.8);
      return { prompt: null, used: true };
    }
    return null;
  }

  setupStation(pts: Record<string, THREE.Vector3>, yaw: number): void {
    this.stationPts = pts;
    const face = yaw;      // the station's front faces the walkway: people there look out (kit +y)
    const out = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const crew: [string, string, THREE.Vector3, number, Pose, Look][] = [
      ['zhou', '老周', pts.bench.clone().addScaledVector(out, 0.5), face + Math.PI, 'phone', { ...LOOKS.courier, build: 1.12, seed: 101 }],
      ['li', '小黎', pts.swap.clone().addScaledVector(out, 0.6), face, 'stand', { ...LOOKS.courier, female: true, hair: 'cap', seed: 102 }],
      ['fei', '大飞', pts.bench.clone().addScaledVector(out, 1.6).add(new THREE.Vector3(Math.cos(yaw) * 2.6, 0, -Math.sin(yaw) * 2.6)), face + Math.PI + 0.7, 'fold', { ...LOOKS.courier, seed: 103 }],
    ];
    for (const [key, name, pos, y, pose, look] of crew) {
      const a = this.actors.spawn({ name, look, pos, yaw: y, pose, tag: 'crew' });
      a.id = key;
      this.stationCrew.push(a);
    }
  }

  private crewTalk(a: Actor): Step[] {
    const pool = (STATION_TALK[a.id] ?? []).filter((b) => this.storyStep >= b.from).flatMap((b) => b.lines);
    const line = pool[Math.floor(this.rng() * pool.length)] ?? '……';
    return [{ say: line, who: a.id }];
  }

  // ------------------------------------------------------------------------------------------ photo
  private startPhoto(o: Order): void {
    const pl = o.drop.place;
    if (!pl) { this.deliver(o, {}); return; }
    const spot = pl.spots.drop ?? pl.spots.door ?? pl.pos;
    const bag = this.world.bag();
    bag.position.copy(spot);
    bag.rotation.y = pl.yaw + 0.4;
    this.actors.group.add(bag);
    this.placedBag = bag;
    // the plate: the face named 'plate' of the door kit (its centre), in world space
    const kitName = pl.sub === 'village' ? 'door_village' : 'door_unit';
    const f = this.world.kit.faces[kitName]?.plate ?? [0, 0, 2, 2, 0.1];
    const plate = this.localToWorld(pl, (f[0] + f[1]) / 2, f[4], (f[2] + f[3]) / 2);
    // step back far enough to get the bag and the plate in the phone's frame (about 40 degrees tall), but never
    // into the house across the alley
    const out = new THREE.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
    const span = plate.y - spot.y + 0.45;
    const want = span / (2 * Math.tan(THREE.MathUtils.degToRad(20))) + 0.3;
    const from = (pl.spots.door ?? spot).clone().setY(spot.y + 1.5);
    const room = this.raycast(from, out, want + 0.5);
    const eye = from.clone().addScaledVector(out, Math.max(1.6, Math.min(want, room - 0.4)));
    eye.y = spot.y + 1.45;
    this.photo.start(eye, spot, plate, (r) => {
      if (!r) { this.toast('先别走，照片还没拍', 'bad', 1.6); bag.removeFromParent(); this.placedBag = null; return; }
      o.photo = r;
      this.notify({ from: '准时达', text: `送达照片已上传：${r.text}`, tone: r.good ? 'good' : 'bad', thumb: r.thumb });
      this.deliver(o, { how: 'photo' });
    });
  }

  private localToWorld(p: DeliveryPlace, lx: number, ly: number, lz: number): THREE.Vector3 {
    // kit-local x -> three (cos th, 0, -sin th); kit-local y (outward) -> three (-sin th, 0, -cos th)
    const th = p.yaw;
    return p.origin.clone().add(new THREE.Vector3(lx * Math.cos(th) - ly * Math.sin(th), lz, -lx * Math.sin(th) - ly * Math.cos(th)));
  }

  // ------------------------------------------------------------------------------------------ per frame
  /**
   * Returns the prompt to show, and whether E was used. player: the courier (on foot when walking, else riding);
   * talk: E pressed this frame.
   */
  update(dt: number, player: THREE.Vector3, onFoot: boolean, talk: boolean, playing: boolean): { prompt: string | null; used: boolean } {
    this.time += dt;
    for (const p of [...this.pending]) if (this.time >= p.at) { this.pending.splice(this.pending.indexOf(p), 1); p.fn(); }
    this.reviewsDue();
    if (!playing) return { prompt: null, used: false };
    this.ambient(dt, player, onFoot);
    if (!this.enabled) return { prompt: null, used: false };
    if (onFoot && !this.dialog.open && !this.photo.active) { const u = this.stationUse(player, talk); if (u) return u; }
    if (!this.order || this.order.state === 'done') {
      if (this.time >= this.nextAt && !this.dialog.open) this.assign(player);
      // between orders the station's couriers still talk
      const mate = onFoot && !this.dialog.open ? this.actors.nearest(player, 1.8, (a) => a.tag === 'crew') : null;
      if (mate) {
        if (talk) { this.actors.face(mate, player); this.dialog.play(this.crewTalk(mate)); return { prompt: null, used: true }; }
        return { prompt: `<kbd>E</kbd> 和${mate.name}聊两句`, used: false };
      }
      return { prompt: null, used: false };
    }
    const o = this.order;
    // spawn the people when the courier gets close
    if (!this.shopActors.length && o.state !== 'carrying' && o.shop.pos.distanceTo(player) < 80) this.spawnShop(o);
    if (!o.flags.dropSpawned && o.state === 'carrying' && o.drop.pos.distanceTo(player) < 90) { o.flags.dropSpawned = true; this.spawnDrop(o); }
    if (this.shopActors.length && o.state === 'carrying' && o.shop.pos.distanceTo(player) > 120) { for (const a of this.shopActors) this.actors.despawn(a); this.shopActors = []; }
    // the kitchen shouts when it is ready
    if (o.state === 'waiting' && this.time >= o.readyAt) {
      o.state = 'ready';
      const staff = this.shopActors.find((a) => a.tag === 'staff');
      if (staff) this.actors.say(staff, o.merchant.ready ?? `${o.no} 号好了！`, 4);
      this.notify({ from: o.shop.name, text: `${o.no} 号已出餐，请尽快取餐。` });
    }
    // somebody looking at the courier
    for (const a of [...this.shopActors, ...this.dropActors]) if (a.root.position.distanceTo(player) < 4 && !a.walk && a.tag !== 'staff') this.actors.face(a, player);
    if (this.dialog.open || this.photo.active || !onFoot) return { prompt: this.ridingPrompt(o, player, onFoot), used: false };
    return this.interact(o, player, talk);
  }

  /** Life around the courier: the crew look up when Ah Jie walks by; the kitchen shouts while he waits; the robot. */
  private ambient(dt: number, player: THREE.Vector3, onFoot: boolean): void {
    for (const a of this.stationCrew) if (a.root.position.distanceTo(player) < 5) this.actors.face(a, player);
    this.barkT -= dt;
    const o = this.order;
    // chatter only reaches a courier on foot and close by, and not every few seconds
    if (this.barkT <= 0 && onFoot && o?.state === 'waiting' && o.shop.pos.distanceTo(player) < 8) {
      const staff = this.shopActors.find((a) => a.tag === 'staff');
      if (staff) this.actors.say(staff, KITCHEN_BARKS[Math.floor(this.rng() * KITCHEN_BARKS.length)], 2.6);
      this.barkT = 10 + this.rng() * 6;
    }
    if (this.barkT <= 0 && onFoot && this.stationCrew.length && this.stationCrew[0].root.position.distanceTo(player) < 8) {
      const a = this.stationCrew[Math.floor(this.rng() * this.stationCrew.length)];
      const pool = (STATION_TALK[a.id] ?? []).filter((b) => this.storyStep >= b.from).flatMap((b) => b.lines);
      if (pool.length) this.actors.say(a, pool[Math.floor(this.rng() * pool.length)], 4);
      this.barkT = 16 + this.rng() * 12;
    }
    // the robot rolls out to meet the courier
    const r = this.robotObj;
    if (r) {
      const near = r.obj.position.distanceTo(player) < 14;
      const goal = near ? r.to : r.obj.position;
      const d = goal.clone().sub(r.obj.position).setY(0);
      if (d.length() > 0.05) { r.obj.position.addScaledVector(d.normalize(), Math.min(d.length(), 0.9 * dt)); }
      const f = player.clone().sub(r.obj.position);
      // its screen is on the model's -z: turn that toward the courier
      let dy = Math.atan2(f.x, f.z) + Math.PI - r.obj.rotation.y;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      r.obj.rotation.y += dy * Math.min(1, dt * 3);
    }
  }

  private ridingPrompt(o: Order, player: THREE.Vector3, onFoot: boolean): string | null {
    if (onFoot) return null;
    const target = o.state === 'carrying' ? o.drop.pos : o.shop.pos;
    return target.distanceTo(player) < 12 ? '<kbd>F</kbd> 下车步行过去' : null;
  }

  private interact(o: Order, player: THREE.Vector3, talk: boolean): { prompt: string | null; used: boolean } {
    const near = (p: THREE.Vector3 | undefined, r: number) => !!p && Math.hypot(p.x - player.x, p.z - player.z) < r && Math.abs(p.y - player.y) < 2;
    const run = (steps: Step[]) => { this.dialog.play(steps); return { prompt: null, used: true }; };
    const c = this.ctx(o);
    // the couriers at the station
    const mate = this.actors.nearest(player, 1.8, (a) => a.tag === 'crew');
    if (mate) {
      if (talk) { this.actors.face(mate, player); return run(this.crewTalk(mate)); }
      return { prompt: `<kbd>E</kbd> 和${mate.name}聊两句`, used: false };
    }
    // the regulars at the shop: 阿伟, 糖水阿婆
    const other = this.actors.nearest(player, 1.7, (a) => a.tag === 'awei' || a.tag === 'auntie');
    if (other) {
      if (talk) {
        this.actors.face(other, player);
        if (other.tag === 'awei') return run([{ say: AWEI_TIPS[Math.floor(this.rng() * AWEI_TIPS.length)], who: 'awei' }]);
        other.tag = 'auntie_done';
        return run([{ say: AUNTIE_LINES[0], who: 'auntie' }, { say: '唔该阿婆！', who: 'ajie' }, { say: AUNTIE_LINES[1], who: 'auntie' }, { run: () => { this.stamina(); this.toast('体力回满 · 绿豆沙', 'good', 1.6); } }]);
      }
      return { prompt: `<kbd>E</kbd> 和${other.name}说话`, used: false };
    }
    // the errand: a convenience store on the way
    if (o.customer.id === 'errand' && o.state === 'carrying' && !o.flags.boughtErrand) {
      const shop = this.world.places.find((p) => p.kind === 'shop' && p.sub === 'convenience' && near(p.pos, 2.4));
      if (shop) {
        if (talk) return run([{ say: '一包纸巾，三块五。', who: 'staff' }, { run: () => { c.cash(-3.5); c.flag('boughtErrand'); } }]);
        return { prompt: '<kbd>E</kbd> 买顾客要的纸巾', used: false };
      }
    }
    // at the shop
    if (o.state !== 'carrying' && (near(o.shop.pos, 2.4) || near(o.shop.spots.counter, 2.0))) {
      if (o.state === 'toShop') {
        if (talk) { const staff = this.shopActors.find((a) => a.tag === 'staff'); if (staff) this.actors.face(staff, player); return run(o.merchant.pickup(c)); }
        return { prompt: `<kbd>E</kbd> 取餐 · ${o.no} 号`, used: false };
      }
      if (o.state === 'waiting') {
        const s = Math.max(0, Math.ceil(o.readyAt - this.time));
        if (talk) return run(o.merchant.hurry?.(c) ?? [{ say: '快了快了。', who: 'staff' }]);
        return { prompt: `出餐中 · 还要 ${s} 秒 · <kbd>E</kbd> 催单`, used: false };
      }
      if (o.state === 'ready') {
        if (talk) return run([{ say: o.merchant.ready ?? '好了，拿走！', who: o.shop.name === '麦姐煲仔饭' ? 'maijie' : o.shop.name === '发哥炸鸡' ? 'fage' : 'staff' }, { run: () => this.pick(o) }]);
        return { prompt: '<kbd>E</kbd> 取餐', used: false };
      }
    }
    if (o.state !== 'carrying') return { prompt: null, used: false };
    // at the drop
    if (o.mode === 'handover' || this.dropActors.some((a) => a.tag === 'cust')) {
      const a = this.actors.nearest(player, 1.6, (x) => x.tag === 'cust' || x.tag === 'decoy');
      if (a) {
        if (talk) {
          this.actors.face(a, player);
          if (a.tag === 'decoy') { this.actors.say(a, DECOYS[Math.floor(this.rng() * DECOYS.length)], 3.2); return { prompt: null, used: true }; }
          this.dialog.speaker('cust', { name: a.name === '王总' ? '王总' : o.who, role: '顾客', color: '#6fa8dc' });
          return run([...o.customer.handover(c), { run: () => { this.actors.hold(a, this.world.bag()); this.actors.setPose(a, 'stand'); } }]);
        }
        return { prompt: `<kbd>E</kbd> ${a.tag === 'cust' && o.mode !== 'handover' ? '把外卖交给' + a.name : '问问：是你点的外卖吗？'}`, used: false };
      }
    }
    // somebody is on the way down: wait for them
    if (o.flags.comingDown && !this.dropActors.some((a) => a.tag === 'cust') && near(o.drop.pos, 6)) return { prompt: '顾客正在下楼…', used: talk };
    if (this.robotObj && near(this.robotObj.obj.position, 2.0)) {
      if (talk) {
        const lines = ROBOT_LINES(this.jobs.rating);
        return run([{ say: lines[0], who: 'robot' }, { say: lines[1] }, { say: lines[2], who: 'robot' }, { say: '……', who: 'ajie' }, { say: lines[3], who: 'robot' }, { say: lines[4], who: 'robot' },
          { run: () => { this.deliver(o, { how: 'robot' }); if (this.robotObj) this.robotObj.to = o.drop.place?.spots.door ?? this.robotObj.to; } }]);
      }
      return { prompt: '<kbd>E</kbd> 把外卖交给送餐机器人', used: false };
    }
    if (o.mode === 'lobby' && o.drop.place) {
      const pl = o.drop.place;
      if (o.story?.talkOnly) return { prompt: null, used: false };
      if (near(pl.spots.locker, 1.6)) {
        if (talk) {
          if (o.customer.id === 'wang' && !o.toLocker) return run([{ say: '（你想起王总的备注：「不要放柜」。还是先跟保安说说？）' }]);
          return run([{ say: '（扫码，开柜，放进去，关门。柜门上的屏幕显示：「已存入，取件码已发送给顾客」。）' }, { run: () => this.deliver(o, { how: 'locker' }) }]);
        }
        return { prompt: '<kbd>E</kbd> 放进外卖柜', used: false };
      }
      const g = this.actors.nearest(player, 2.0, (x) => x.tag === 'guard' || x.tag === 'libo');
      if (g) {
        if (talk) { this.actors.face(g, player); return run(this.guardScript(o, g.tag === 'libo')); }
        return { prompt: `<kbd>E</kbd> 和${g.name}说话`, used: false };
      }
    }
    if (o.mode === 'door' && o.drop.place && near(o.drop.place.spots.door ?? o.drop.pos, 1.8)) {
      if (talk) {
        this.dialog.speaker('cust', { name: o.who, role: '顾客 · 对讲机', color: '#6fa8dc' });
        const knock: Step = { say: o.drop.place.sub === 'village' ? '（你拍了拍铁闸：「外卖！」）' : `（你按了门禁对讲：${o.drop.room ?? ''}）` };
        return run([knock, ...(o.customer.call?.(c) ?? [{ say: '放门口吧，谢谢。', who: 'cust' }, { run: () => c.toPhoto() }])]);
      }
      return { prompt: `<kbd>E</kbd> ${o.drop.place.sub === 'village' ? '敲门' : '按门禁'} · ${o.drop.name} ${o.drop.room ?? ''}`, used: false };
    }
    return { prompt: null, used: false };
  }

  private guardScript(o: Order, libo: boolean): Step[] {
    const c = this.ctx(o);
    const who = libo ? 'libo' : 'guard';
    const upstairs: Step[] = libo
      ? [{ say: '唉，去吧去吧，走员工电梯，快点下来，别让主管看见。', who }, { pause: 1.2 }, { run: () => c.time(70) },
        { say: `（员工电梯每一层都停了一下。${o.drop.room ?? ''}，你把外卖递了过去。）` },
        { run: () => { c.flag('wentUp'); return o.customer.handover(c); } }]
      : [{ say: pickLine(['规定就是规定。上个月有个骑手偷偷上去，我被扣了两百块。', '你上去了，我下岗。你养我？']), who }, { run: () => this.guardScript(o, false).slice(1) }];
    const call: Step[] = o.customer.call ? [{ run: () => { this.dialog.speaker('cust', { name: o.customer.id === 'wang' ? '王总' : o.who, role: '顾客 · 电话', color: '#6fa8dc' }); return o.customer.call!(c); } },
      { run: () => (o.toLocker || o.state === 'done' || o.flags.comingDown ? null : this.guardScript(o, libo).slice(1)) }]
      : [{ say: '我下来拿，等我一下。', who: 'cust' }, { run: () => c.comeDown(20) }];
    return [
      { say: libo ? '后生仔，又是你们准时达。外卖不能上楼的，放柜子还是叫他下来？' : pickLine(['外卖不能上楼。放柜子，或者叫他下来拿。', '站住！外卖止步。看见那个牌子没有？']), who },
      {
        choose: [
          { text: '放外卖柜', then: [{ run: () => { o.toLocker = true; this.toast('去旁边的外卖柜，按 E 放进去', '', 2.2); } }] },
          { text: '打电话叫顾客下来', then: call },
          { text: libo ? '「李伯，帮帮忙，让我送上去吧。」' : '「求求你，让我送上去吧。」', then: upstairs },
        ],
      },
    ];
  }

  // ------------------------------------------------------------------------------------------ reviews, complaints, strangers
  private reviewsDue(): void {
    for (const r of [...this.reviews]) {
      if (this.time < r.at) continue;
      this.reviews.splice(this.reviews.indexOf(r), 1);
      const d = [0, -0.06, -0.04, -0.02, 0, 0.01][r.stars];
      this.jobs.rating = THREE.MathUtils.clamp(this.jobs.rating + d, 1, 5);
      this.notify({ from: `顾客评价 · ${r.order.drop.name}`, text: r.text, stars: r.stars, tone: r.stars >= 4 ? 'good' : r.stars <= 2 ? 'bad' : '' });
      if (r.stars <= 2 || r.stars >= 5) this.later(2.2, () => this.notify({ from: '小准', text: pickLine(r.stars >= 5 ? REVIEW_XZ.good : REVIEW_XZ.bad), tone: r.stars >= 5 ? '' : 'bad' }));
      this.save();
    }
    for (const k of [...this.complaints]) {
      if (this.time < k.at) continue;
      this.complaints.splice(this.complaints.indexOf(k), 1);
      const o = k.order;
      const ok = !!o.photo?.good;
      this.notify({ from: `顾客投诉 · ${o.drop.name}`, text: '「我没收到外卖！要求全额退款！」', tone: 'bad' });
      this.later(3, () => {
        if (ok) this.notify({ from: '准时达', text: '申诉成功：送达照片清楚显示外卖与门牌。顾客回复：「哦，原来在门口。」（未道歉）', tone: 'good', thumb: o.photo?.thumb });
        else {
          this.playerCash(-Math.max(15, o.pay));
          this.jobs.rating = Math.max(1, this.jobs.rating - 0.03);
          this.notify({ from: '准时达', text: `申诉失败：${o.photo ? o.photo.text : '没有送达照片'}。已从您的收入中扣除 ¥${Math.max(15, o.pay)}。`, tone: 'bad', thumb: o.photo?.thumb });
        }
      });
    }
  }

  /** A crash: a passer-by comes over, picks the bike up, says something kind, walks off. */
  crashHelp(bike: THREE.Vector3, rider: THREE.Vector3): void {
    if (this.helper && !this.helper.gone && this.helper.tag === 'helper') return;     // one at a time (a leaving one does not count)
    const a = Math.random() * Math.PI * 2;
    const from = bike.clone().add(_v.set(Math.cos(a) * 9, 0, Math.sin(a) * 9));
    const lines = HELPER_LINES[Math.floor(Math.random() * HELPER_LINES.length)];
    const h = this.actors.spawn({ name: '路人', look: { female: Math.random() < 0.5, seed: Math.floor(Math.random() * 1e6) }, pos: from, yaw: 0, pose: 'stand', tag: 'helper' });
    this.helper = h;
    this.actors.walkTo(h, rider.clone().lerp(bike, 0.5), 1.6, () => {
      this.actors.say(h, lines[0], 3);
      this.later(2.4, () => this.actors.walkTo(h, bike.clone().add(_v.set(0.9, 0, 0.4)), 1.2, () => {
        this.liftBike();
        this.actors.say(h, lines[1], 4);
        this.later(4.5, () => { h.tag = 'leaving'; this.actors.walkTo(h, from, 1.3, () => this.actors.despawn(h)); });
      }));
    });
  }

  // ------------------------------------------------------------------------------------------ save
  private save(): void {
    try { localStorage.setItem('gz.orders', JSON.stringify({ step: this.storyStep, done: this.chapterDone, cash: this.jobs.cash, rating: this.jobs.rating, pace: this.jobs.pace, delivered: this.jobs.delivered })); } catch { /* private mode */ }
  }

  private load(): void {
    try {
      const s = JSON.parse(localStorage.getItem('gz.orders') ?? 'null');
      if (!s) return;
      this.storyStep = s.step ?? 0; this.chapterDone = !!s.done;
      this.jobs.cash = s.cash ?? 0; this.jobs.rating = s.rating ?? 4.99; this.jobs.pace = s.pace ?? this.jobs.pace; this.jobs.delivered = s.delivered ?? 0;
      this.sinceStory = 1;
    } catch { /* nothing saved */ }
  }

  /**
   * A specific ordinary order (tests, trying content out): customer and merchant by id, the drop by mode and
   * optionally the drop place's sub-kind ('hotel', 'village', 'unit', 'tower').
   */
  debugOrder(from: THREE.Vector3, o: { customer: string; merchant?: string; mode: DropMode; sub?: string }): boolean {
    this.cancel();
    const customer = CUSTOMERS.find((c) => c.id === o.customer);
    const merchant = MERCHANTS.find((m) => m.id === (o.merchant ?? 'normal'));
    const shop = this.shopsNear(from, (s) => s.name !== '发哥炸鸡')[0];
    if (!customer || !merchant || !shop) return false;
    let drop: Drop | null = null;
    if (o.sub) {
      const c = this.world.places.filter((p) => p.sub === o.sub).sort((a, b) => a.pos.distanceTo(shop.pos) - b.pos.distanceTo(shop.pos));
      const p = c.find((x) => x.pos.distanceTo(shop.pos) > 150) ?? c[0];
      if (p) drop = { kind: p.kind === 'home' ? 'home' : 'lobby', name: p.name, pos: p.pos, place: p, room: p.room ?? '18楼', cat: p.sub };
    } else drop = this.dropFor(o.mode, shop.pos);
    if (!drop) return false;
    const ord = this.makeOrder(shop, drop, o.mode, merchant, customer, null);
    this.order = ord;
    this.jobs.assign({ name: shop.name, pos: shop.pos, cat: shop.sub }, { name: drop.name, pos: drop.pos, cat: drop.cat }, from);
    return true;
  }

  /** The order is gone (spilled, cancelled by the platform): clear up, the next one comes soon. */
  cancel(): void {
    if (this.order) this.order.state = 'done';
    if (this.dialog.open) this.dialog.cancel();
    this.clearScene();
    this.nextAt = this.time + 8;
  }

  /** Start over (the help screen's button, QA). */
  reset(): void {
    try { localStorage.removeItem('gz.orders'); } catch { /* */ }
    if (this.dialog.open) this.dialog.cancel();
    this.storyStep = 0; this.sinceStory = 0; this.chapterDone = false;
    this.jobs.cash = 0; this.jobs.rating = 4.99; this.jobs.delivered = 0;
    this.order = null; this.clearScene(); this.reviews.length = 0; this.complaints.length = 0; this.pending.length = 0;
    if (this.helper) { this.actors.despawn(this.helper); this.helper = null; }
    this.nextAt = this.time + 1;
  }

  /** What the HUD and the bike's phone show about the order. */
  get summary(): { title: string; note: string; state: State | 'none'; story: string | null } {
    const o = this.order;
    if (!o || o.state === 'done') return { title: '', note: '', state: 'none', story: null };
    return { title: `#${o.no} ${o.shop.name} → ${o.drop.name}${o.drop.room ? ' ' + o.drop.room : ''}`, note: o.note, state: o.state, story: o.story ? `《${o.story.title}》` : null };
  }

  get clock(): number { return this.time; }
  get scene(): { shop: Actor[]; drop: Actor[] } { return { shop: this.shopActors, drop: this.dropActors }; }
}

function pickLine(a: string[]): string { return a[Math.floor(Math.random() * a.length)]; }
