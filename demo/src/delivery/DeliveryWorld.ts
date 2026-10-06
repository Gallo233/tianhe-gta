import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fromBlender } from '../config';
import type { PropColliders } from '../world/PropColliders';

/**
 * The places of the delivery game, made physical (guangzhou/scripts/gz_delivery.py -> assets/tianhe/delivery.json,
 * the kit from guangzhou/scripts/gz_shopfront.py -> assets/street/gz_shopkit.glb + .json):
 *
 *   shops    a shopfront on the ground floor of a real building at every pickup (91): restaurant / tea /
 *            convenience / mall / shop kits, the shop's (fictional) name on its lightbox fascia
 *   lobbies  the office-tower drop set at every tower, office and hotel that takes orders (179): canopy, doors,
 *            guard podium, stanchions, the food locker, "骑手禁止入内"
 *   homes    doors on residential buildings (220): apartment entrances with real building names, urban-village
 *            houses in 冼村 / 石牌村 / 猎德村 with couplets and blue house plates
 *
 * Kits are instanced per material in 150 m chunks that join the city's distance culling; all sign faces (names,
 * menus, plates, couplets) are merged into one mesh per canvas atlas. Each place exposes its interaction points in
 * world space (three.js): where the courier stands, the takeaway counter, where the staff / guard stand, the door,
 * where a bag is left, the locker.
 */
export type ShopKind = 'restaurant' | 'tea' | 'convenience' | 'mall' | 'shop';
export type Spot = 'stand' | 'counter' | 'staff' | 'door' | 'drop' | 'guard' | 'locker' | 'cell' | 'intercom';

interface Anchor { a: [number, number]; n: [number, number]; s: [number, number]; span: number; z: number }
interface ShopRec extends Anchor { name: string; cat: string; kind: ShopKind }
interface LobbyRec extends Anchor { name: string; cat: string }
interface HomeRec extends Anchor { name: string; room: string; style: 'unit' | 'village'; h: number }
interface KitJson { faces: Record<string, Record<string, number[]>>; points: Record<string, Record<string, number[]>>; bay: { w: number; h: number; d: number } }

export interface DeliveryPlace {
  /** a street stall (no shop behind it) */
  stall?: boolean;
  id: string;
  kind: 'shop' | 'lobby' | 'home';
  name: string;
  /** shops: the kit; lobbies: tower / office / hotel; homes: unit / village */
  sub: string;
  /** homes: the flat ("1203") or floor */
  room?: string;
  /** three.js position of each interaction point, and the facade's outward yaw (the kit's +y) */
  spots: Partial<Record<Spot, THREE.Vector3>>;
  yaw: number;
  /** where the courier walks to (the order target) */
  pos: THREE.Vector3;
  /** the kit's origin (three.js): the facade point at pavement level */
  origin: THREE.Vector3;
}

const CHUNK = 150;
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
const DETAIL = /bag|goods|cup|roast|receipt|rubber|belt|bulb|meter|couplet|house plate|stanchion/;
const GLOW = /led|menu board|fridge|locker inside|screen|bulb|heat lamp/;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  // final avalanche (murmur3): names that differ only in the last character land far apart
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A canvas atlas of equal slots; hands out UV rectangles. */
class Atlas {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  private next = 0;
  constructor(readonly w: number, readonly h: number, readonly sw: number, readonly sh: number) {
    this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace; this.tex.anisotropy = 8; this.tex.flipY = false;
    this.tex.generateMipmaps = true;
  }
  /** Draw into a new slot; returns its UV rect [u0, v0, u1, v1] (v down, flipY off). */
  slot(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): number[] {
    const cols = Math.floor(this.w / this.sw);
    const i = this.next++;
    const x = (i % cols) * this.sw, y = Math.floor(i / cols) * this.sh;
    if (y + this.sh > this.h) throw new Error('atlas full');
    this.g.save(); this.g.translate(x, y); this.g.beginPath(); this.g.rect(0, 0, this.sw, this.sh); this.g.clip();
    draw(this.g, this.sw, this.sh);
    this.g.restore();
    const pad = 1;
    return [(x + pad) / this.w, (y + pad) / this.h, (x + this.sw - pad) / this.w, (y + this.sh - pad) / this.h];
  }
}

/** Collects sign quads (world space) for one atlas into a single geometry. */
class Quads {
  readonly pos: number[] = []; readonly uv: number[] = []; readonly nor: number[] = []; readonly idx: number[] = [];
  add(corners: THREE.Vector3[], uv: number[], n: THREE.Vector3): void {
    const b = this.pos.length / 3;
    // corners: bottom-left, bottom-right, top-right, top-left (seen from the front); v runs down in the canvas
    const uvs = [[uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]], [uv[0], uv[1]]];
    corners.forEach((c, i) => { this.pos.push(c.x, c.y, c.z); this.uv.push(...uvs[i]); this.nor.push(n.x, n.y, n.z); });
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  mesh(mat: THREE.Material, name: string): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.name = name; m.receiveShadow = true;
    return m;
  }
}

// ------------------------------------------------------------------------------------ sign designs
const SHOP_COLOURS: Record<ShopKind, [string, string, string][]> = {
  // [background, text, accent]
  restaurant: [['#d8551f', '#fff6e0', '#ffd23a'], ['#b8201f', '#ffe9b8', '#ffd23a'], ['#f2b21e', '#3a1d08', '#b8201f'], ['#1f5e3a', '#fff2cf', '#f2b21e']],
  tea: [['#f6efe3', '#3b2a1e', '#c98a4b'], ['#fbd9e2', '#7a2a44', '#ffffff'], ['#1e1e1e', '#f5e7c8', '#c6f03c'], ['#dff0e6', '#2c5b43', '#f08a24']],
  convenience: [['#d0282e', '#ffffff', '#ffd23a'], ['#127a3c', '#ffffff', '#f08a24'], ['#1c4fa0', '#ffffff', '#ffd23a']],
  mall: [['#2a2c30', '#ffffff', '#c6f03c']],
  shop: [['#2e5c8a', '#ffffff', '#9fd0ff'], ['#3b3b3b', '#f4e3c2', '#e4664e'], ['#7a4bb0', '#ffffff', '#ffd6f0']],
};
const SUBLINE: Record<ShopKind, string[]> = {
  restaurant: ['堂食 · 外卖 · 30分钟必达', '老字号 · 现炒现做', '明火靓汤 · 外卖专窗', '广州味道 · SINCE 2033'],
  tea: ['现煮 · 少糖 · 去冰', 'FRESH TEA & COFFEE', '手作甜品 · 外卖自取', '第二杯半价（小准推荐）'],
  convenience: ['24 小时营业', '便利到家 · 24H', '热食 · 饮品 · 快递代收'],
  mall: ['外卖取餐点 · 智能取餐柜'],
  shop: ['线上下单 · 骑手取货', '闪送 · 同城 1 小时达', '正品保证'],
};

function fitText(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight = 900): number {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  while (g.measureText(text).width > maxW && s > 10) { s -= 2; g.font = `${weight} ${s}px ${FONT}`; }
  return s;
}

function drawFascia(g: CanvasRenderingContext2D, w: number, h: number, name: string, kind: ShopKind): void {
  const pal = SHOP_COLOURS[kind][Math.floor(hash(name) * SHOP_COLOURS[kind].length)];
  const [bg, fg, ac] = pal;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, 'rgba(255,255,255,0.14)'); grd.addColorStop(1, 'rgba(0,0,0,0.12)');
  g.fillStyle = grd; g.fillRect(0, 0, w, h);
  // the round logo with the first character
  const r = h * 0.34, cx = h * 0.48, cy = h * 0.5;
  g.fillStyle = ac; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = bg; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${Math.round(r * 1.25)}px ${FONT}`; g.fillText(name.replace(/^24小时/, '')[0], cx, cy + r * 0.06);
  // the name, and a small line under it
  g.textAlign = 'left'; g.fillStyle = fg;
  const x0 = h * 0.95, maxW = w - x0 - h * 0.25;
  fitText(g, name, maxW, Math.round(h * 0.5));
  g.fillText(name, x0, h * 0.42);
  const sub = SUBLINE[kind][Math.floor(hash(name + 's') * SUBLINE[kind].length)];
  g.globalAlpha = 0.85; fitText(g, sub, maxW, Math.round(h * 0.17), 700); g.fillText(sub, x0 + 2, h * 0.8); g.globalAlpha = 1;
}

/** The panel on a stall's cart, like the 凉皮凉面 cart in 珠江新城: white, the house speciality in big red characters. */
function drawStallFront(g: CanvasRenderingContext2D, w: number, h: number, name: string, kind: ShopKind): void {
  const SPECIAL: Record<ShopKind, string[]> = {
    restaurant: ['肠粉 炒粉', '猪脚饭', '云吞 净面', '砂锅粥', '烧腊 快餐', '鸡蛋肠'],
    tea: ['杨枝甘露', '手打柠檬茶', '糖水 双皮奶', '豆浆 油条', '鸡蛋仔'],
    convenience: ['冰水 饮料', '烟 酒 汽水', '雪糕 冻水'],
    mall: ['肠粉 炒粉', '鸡蛋饼'],
    shop: ['手机贴膜', '鲜花 一把十元', '袜子 三对十元'],
  };
  const list = SPECIAL[kind] ?? SPECIAL.restaurant;
  const text = list[Math.floor(hash(name + 'stall') * list.length)];
  g.fillStyle = '#f6f4ee'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#c9c4b8'; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4);
  g.fillStyle = '#c8261e'; g.textAlign = 'center'; g.textBaseline = 'middle';
  fitText(g, text, w * 0.8, Math.round(h * 0.5));
  g.fillText(text, w * 0.52, h * 0.5);
  g.font = `800 ${Math.round(h * 0.16)}px ${FONT}`; g.textAlign = 'left';
  g.fillText(kind === 'tea' ? '现做' : kind === 'shop' ? '特价' : '老字号', w * 0.04, h * 0.18);
}

function drawMenu(g: CanvasRenderingContext2D, w: number, h: number, kind: ShopKind, seed: number): void {
  const items: Record<string, [string, string][]> = {
    restaurant: [['叉烧饭', '26'], ['烧鸭饭', '28'], ['煲仔饭', '32'], ['云吞面', '22'], ['猪脚饭', '25'], ['例汤', '8']],
    tea: [['杨枝甘露', '19'], ['柠檬茶', '14'], ['双皮奶', '16'], ['美式', '15'], ['生椰拿铁', '18'], ['芋圆', '17']],
    shop: [['同城闪送', '9.9'], ['鲜花速递', '99'], ['手机配件', '39'], ['日用百货', '15']],
    convenience: [['关东煮', '3'], ['饭团', '8'], ['咖啡', '10'], ['雪糕', '6']],
    mall: [['取餐', '']],
  };
  const list = items[kind] ?? items.shop;
  g.fillStyle = '#1b1c1e'; g.fillRect(0, 0, w, h);
  g.fillStyle = kind === 'tea' ? '#f3e2c8' : '#ffd23a'; g.fillRect(0, 0, w, h * 0.13);
  g.fillStyle = '#1b1c1e'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `900 ${Math.round(w * 0.17)}px ${FONT}`; g.fillText(kind === 'tea' ? '饮品单' : '今日推荐', w / 2, h * 0.066);
  const rowH = (h * 0.87) / list.length;
  list.forEach(([n, p], i) => {
    const y = h * 0.13 + rowH * i;
    const hue = (seed * 360 + i * 47) % 360;
    g.fillStyle = `hsl(${hue}, 55%, 42%)`;
    g.beginPath(); g.ellipse(w * 0.26, y + rowH * 0.5, w * 0.19, rowH * 0.36, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = `hsl(${hue}, 65%, 70%)`;
    g.beginPath(); g.ellipse(w * 0.24, y + rowH * 0.44, w * 0.11, rowH * 0.18, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffffff'; g.textAlign = 'left';
    g.font = `800 ${Math.round(w * 0.12)}px ${FONT}`; g.fillText(n, w * 0.5, y + rowH * 0.38);
    if (p) { g.fillStyle = '#ffd23a'; g.font = `900 ${Math.round(w * 0.12)}px ${FONT}`; g.fillText('¥' + p, w * 0.5, y + rowH * 0.72); }
  });
}

function drawPlate(g: CanvasRenderingContext2D, w: number, h: number, name: string, style: 'unit' | 'village'): void {
  if (style === 'village') {
    g.fillStyle = '#1f4f9c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#ffffff'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const m = name.match(/^(.*?)(\d+巷)(\d+号)$/);
    if (m) {
      fitText(g, m[1] + m[2], w - 16, Math.round(h * 0.34), 700); g.fillText(m[1] + m[2], w / 2, h * 0.34);
      fitText(g, m[3], w - 16, Math.round(h * 0.4), 900); g.fillText(m[3], w / 2, h * 0.72);
    } else { fitText(g, name, w - 16, Math.round(h * 0.4)); g.fillText(name, w / 2, h / 2); }
    return;
  }
  g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#243447'; g.fillRect(0, 0, w * 0.05, h);
  g.fillStyle = '#243447'; g.textAlign = 'center'; g.textBaseline = 'middle';
  fitText(g, name, w * 0.85, Math.round(h * 0.52)); g.fillText(name, w * 0.53, h * 0.5);
}

// ------------------------------------------------------------------------------------ the world
export class DeliveryWorld {
  readonly group = new THREE.Group();
  readonly places: DeliveryPlace[] = [];
  readonly chunks: { mesh: THREE.InstancedMesh; center: THREE.Vector3; maxDist: number }[] = [];
  private readonly glow: { m: THREE.MeshStandardMaterial; base: number }[] = [];
  private readonly signMats: THREE.MeshStandardMaterial[] = [];
  private ledMat: THREE.MeshStandardMaterial | null = null;
  private readonly bagProto: THREE.Object3D;
  /** kit name -> meshes with the node transform baked in (for the one-off pieces placed later) */
  private readonly protos = new Map<string, THREE.Mesh[]>();
  readonly kit: KitJson;

  /** places dropped (no wall behind them in the game's collision) and slid back onto their wall */
  readonly fixes = { dropped: 0, moved: 0 };
  /** shops whose wall was not there in the game: they become street stalls (Game.placeStalls) */
  readonly wallless: { name: string; kind: ShopKind; a: [number, number]; z: number }[] = [];
  /** The courier station and the street stalls as circles, for walkers to step around (placed on the pavement after the walk graph was made). */
  readonly walkBlockers: { p: THREE.Vector3; r: number }[] = [];

  /**
   * wall: distance to the first static wall along a ray (the game's collision). Every anchor is checked against
   * it: the footprint edge it was computed from is not always where the rendered building stands (podiums, towers
   * built by hand). A wall a few metres further in: the place slides back onto it; none within 14 m: dropped.
   */
  constructor(gltf: GLTF, kit: KitJson, data: { shops: ShopRec[]; lobbies: LobbyRec[]; homes: HomeRec[] },
    wall?: (o: THREE.Vector3, d: THREE.Vector3, far: number) => number) {
    this.group.name = 'delivery world';
    this.kit = kit;
    if (wall) {
      const check = <T extends Anchor>(list: T[]): T[] => list.filter((r) => {
        const th = Math.atan2(-r.n[0], r.n[1]);
        const out = new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th));
        const o = fromBlender(r.a[0], r.a[1], r.z).addScaledVector(out, 1.0);
        o.y += 1.6;
        const d = wall(o, out.clone().negate(), 14);
        if (d < 2.0) return true;
        if (!Number.isFinite(d)) { this.fixes.dropped++; if ('kind' in r) this.wallless.push(r as unknown as ShopRec); return false; }
        const shift = d - 1.0;                       // metres the facade really is further in (Blender: along -n)
        r.a = [r.a[0] - r.n[0] * shift, r.a[1] - r.n[1] * shift];
        this.fixes.moved++;
        return true;
      });
      data = { shops: check(data.shops), lobbies: check(data.lobbies), homes: check(data.homes) };
    }
    // prototypes: kit name -> meshes with the node transform baked in
    const protos = new Map<string, THREE.Mesh[]>();
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      let p: THREE.Object3D = m;
      while (p.parent && p.parent !== gltf.scene) p = p.parent;
      const key = p.name.replace(/^kit_/, '');
      if (!protos.has(key)) protos.set(key, []);
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      const mat = m.material as THREE.MeshStandardMaterial;
      if (GLOW.test(mat.name) && !this.glow.find((x) => x.m === mat)) this.glow.push({ m: mat, base: mat.emissiveIntensity });
      if (/glass/.test(mat.name)) { mat.transparent = true; mat.depthWrite = false; mat.envMapIntensity = 1.3; }
      const mm = new THREE.Mesh(g, mat);
      mm.name = m.name;
      protos.get(key)!.push(mm);
    });
    this.protos = protos;
    const bag = new THREE.Group();
    for (const m of protos.get('bag') ?? []) { const c = m.clone(); c.castShadow = true; bag.add(c); }
    this.bagProto = bag;

    // placements
    type Pl = { kit: string; x: number; y: number; z: number; th: number };
    const pls: Pl[] = [];
    const fascia = new Atlas(2048, 2048, 340, 106);
    const plates = new Atlas(2048, 2048, 204, 68);
    const misc = new Atlas(2048, 1024, 128, 512);
    const qFascia = new Quads(), qPlate = new Quads(), qMisc = new Quads(), qLed = new Quads();
    // the urban village's red LED dot-matrix signs over the doors
    const ledAtlas = new Atlas(1024, 512, 512, 102);
    const LED_TEXT = ['有房出租 拎包入住', '单间 800 起 包水电', '24小时士多', '快递代收', '早餐 肠粉 粥', '房东电话 138****', '有房出租', '（灯坏了一半）'];
    const leds = LED_TEXT.map((t) => ledAtlas.slot((g, w, h) => {
      g.fillStyle = '#0a0a0a'; g.fillRect(0, 0, w, h);
      // the text, then a dot-matrix mask over it (only round dots light up)
      const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
      const tg = tmp.getContext('2d')!;
      tg.fillStyle = t.includes('坏') ? '#ff3b2f' : t.includes('士多') || t.includes('早餐') ? '#39ff7a' : '#ff2a1a';
      tg.textAlign = 'center'; tg.textBaseline = 'middle';
      fitText(tg, t, w - 20, Math.round(h * 0.7)); tg.fillText(t, w / 2, h / 2 + 2);
      if (t.includes('坏')) { tg.clearRect(w * 0.55, 0, w * 0.45, h); }
      const px = tg.getImageData(0, 0, w, h).data, step = 6;
      for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
        const i = (Math.floor(y) * w + Math.floor(x)) * 4;
        if (px[i + 3] < 60) { g.fillStyle = '#1a0806'; } else g.fillStyle = `rgb(${px[i]},${px[i + 1]},${px[i + 2]})`;
        g.beginPath(); g.arc(x, y, step * 0.36, 0, Math.PI * 2); g.fill();
      }
    }));
    const menus: Record<string, number[]> = {};
    for (const k of ['restaurant', 'tea', 'shop', 'convenience'] as ShopKind[]) menus[k] = misc.slot((g, w, h) => drawMenu(g, w, h, k, hash(k)));
    // fixed signs (the same on every lobby / mall / store): one canvas each, at its face's own aspect
    const fixedSigns = new Map<string, { atlas: Atlas; q: Quads; uv: number[] }>();
    const fixedSign = (key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void) => {
      const atlas = new Atlas(w, h, w, h);
      fixedSigns.set(key, { atlas, q: new Quads(), uv: atlas.slot(draw) });
    };
    const centered = (g: CanvasRenderingContext2D) => { g.textAlign = 'center'; g.textBaseline = 'middle'; };
    fixedSign('podium', 360, 256, (g, w, h) => { g.fillStyle = '#1d2733'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffffff'; centered(g); g.font = `900 64px ${FONT}`; g.fillText('访客登记', w / 2, h * 0.36); g.fillStyle = '#ffd23a'; g.font = `800 50px ${FONT}`; g.fillText('外卖止步', w / 2, h * 0.72); });
    fixedSign('locker', 1024, 150, (g, w, h) => { g.fillStyle = '#f2c21e'; g.fillRect(0, 0, w, h); g.fillStyle = '#1b1c1e'; centered(g); g.font = `900 78px ${FONT}`; g.fillText('蜂箱 · 智能取餐柜', w / 2, h * 0.42); g.font = `700 30px ${FONT}`; g.fillText('扫码开柜 · 超时 2 小时收费 ¥1/小时 · 骑手使用费 ¥0.3/次', w / 2, h * 0.84); });
    fixedSign('aframe', 256, 370, (g, w, h) => { g.fillStyle = '#b8201f'; g.fillRect(0, 0, w, h); g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20); g.fillStyle = '#ffffff'; centered(g); g.font = `900 46px ${FONT}`; g.fillText('外卖', w / 2, h * 0.2); g.fillText('请放柜', w / 2, h * 0.36); g.fillStyle = '#ffd23a'; g.font = `900 38px ${FONT}`; g.fillText('骑手', w / 2, h * 0.6); g.fillText('禁止入内', w / 2, h * 0.74); g.fillStyle = '#ffffff'; g.font = `600 18px ${FONT}`; g.fillText('—— 物业管理处', w / 2, h * 0.9); });
    fixedSign('mallHeader', 1024, 140, (g, w, h) => { g.fillStyle = '#1b1c1e'; g.fillRect(0, 0, w, h); g.fillStyle = '#c6f03c'; centered(g); g.font = `900 70px ${FONT}`; g.fillText('外卖取餐柜 · 请勿逗留', w / 2, h / 2); });
    fixedSign('banner', 512, 106, (g, w, h) => { g.fillStyle = '#c41e1e'; g.fillRect(0, 0, w, h); g.fillStyle = '#1b1b1b'; centered(g); g.font = `900 76px ${FONT}`; g.fillText('出入平安', w / 2, h / 2 + 4); });
    fixedSign('poster', 280, 360, (g, w, h) => { g.fillStyle = '#ffd23a'; g.fillRect(0, 0, w, h); g.fillStyle = '#b8201f'; centered(g); g.font = `900 58px ${FONT}`; g.fillText('第二件', w / 2, h * 0.24); g.fillText('半价', w / 2, h * 0.44); g.fillStyle = '#1b1c1e'; g.font = `700 26px ${FONT}`; g.fillText('小准会员专享', w / 2, h * 0.66); g.font = `600 20px ${FONT}`; g.fillText('第一件原价上调 50%', w / 2, h * 0.82); });
    const fixed = (k: string) => fixedSigns.get(k)!;
    const couplets: number[][][] = [
      ['家和万事兴旺', '人勤百业昌隆'], ['一帆风顺年年好', '万事如意步步高'], ['出入平安福星照', '合家欢乐喜临门'],
    ].map(([l, r]) => [l, r].map((t) => misc.slot((g, w, h) => {
      g.fillStyle = '#c41e1e'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#1b1b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const n = t.length, s = Math.min(w * 0.72, (h - 20) / n);
      g.font = `900 ${Math.round(s)}px ${FONT}`;
      for (let i = 0; i < n; i++) g.fillText(t[i], w / 2, 10 + s * (i + 0.5));
    })));
    // 福 upside down (福到了), on a red diamond; transparent corners
    fixedSign('fu', 256, 256, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI / 4); g.fillStyle = '#c41e1e'; g.fillRect(-w * 0.35, -h * 0.35, w * 0.7, h * 0.7);
      g.strokeStyle = '#e8c24a'; g.lineWidth = 6; g.strokeRect(-w * 0.31, -h * 0.31, w * 0.62, h * 0.62); g.restore();
      g.save(); g.translate(w / 2, h / 2); g.rotate(Math.PI); g.fillStyle = '#1b1b1b'; centered(g); g.font = `900 ${Math.round(w * 0.42)}px ${FONT}`; g.fillText('福', 0, 4); g.restore();
    });

    const toWorld = (ax: number, ay: number, th: number, z0: number, l: number[] | THREE.Vector3): THREE.Vector3 => {
      const [lx, ly, lz] = Array.isArray(l) ? l : [l.x, l.y, l.z];
      const c = Math.cos(th), s = Math.sin(th);
      return fromBlender(ax + lx * c - ly * s, ay + lx * s + ly * c, z0 + lz);
    };
    const addFace = (q: Quads, kitName: string, faceName: string, ax: number, ay: number, th: number, z0: number, uv: number[]) => {
      const f = kit.faces[kitName]?.[faceName];
      if (!f) return;
      const [x0, x1, fz0, fz1, fy] = f;
      // seen from the front (+y), local +x is on the viewer's left
      const corners = [[x1, fy, fz0], [x0, fy, fz0], [x0, fy, fz1], [x1, fy, fz1]].map((p) => toWorld(ax, ay, th, z0, p));
      // the kit's +y (outward) in three.js: Blender (-sin th, cos th) -> (x, -y)
      q.add(corners, uv, new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th)));
    };
    const spotsOf = (kitName: string, ax: number, ay: number, th: number, z0: number) => {
      const out: Partial<Record<Spot, THREE.Vector3>> = {};
      for (const [k, v] of Object.entries(kit.points[kitName] ?? {})) out[k as Spot] = toWorld(ax, ay, th, z0, v);
      return out;
    };
    // the kit's +y (Blender (0, 1)) turned onto the anchor normal n: n = (-sin th, cos th)
    const thetaOf = (n: [number, number]) => Math.atan2(-n[0], n[1]);

    data.shops.forEach((s, i) => {
      const th = thetaOf(s.n), kitName = 'shop_' + s.kind;
      pls.push({ kit: kitName, x: s.a[0], y: s.a[1], z: s.z, th });
      const uv = fascia.slot((g, w, h) => drawFascia(g, w, h, s.name, s.kind));
      addFace(qFascia, kitName, 'fascia', s.a[0], s.a[1], th, s.z, uv);
      if (s.kind === 'mall') addFace(fixed('mallHeader').q, kitName, 'header', s.a[0], s.a[1], th, s.z, fixed('mallHeader').uv);
      if (menus[s.kind]) addFace(qMisc, kitName, 'menu', s.a[0], s.a[1], th, s.z, menus[s.kind]);
      if (s.kind === 'convenience') addFace(fixed('poster').q, kitName, 'poster', s.a[0], s.a[1], th, s.z, fixed('poster').uv);
      const spots = spotsOf(kitName, s.a[0], s.a[1], th, s.z);
      this.places.push({ id: 'shop' + i, kind: 'shop', name: s.name, sub: s.kind, spots, yaw: th, pos: spots.stand!, origin: fromBlender(s.a[0], s.a[1], s.z) });
    });
    data.lobbies.forEach((l, i) => {
      const th = thetaOf(l.n);
      pls.push({ kit: 'lobby', x: l.a[0], y: l.a[1], z: l.z, th });
      addFace(fixed('podium').q, 'lobby', 'podium', l.a[0], l.a[1], th, l.z, fixed('podium').uv);
      addFace(fixed('locker').q, 'lobby', 'locker_head', l.a[0], l.a[1], th, l.z, fixed('locker').uv);
      addFace(fixed('aframe').q, 'lobby', 'aframe', l.a[0], l.a[1], th, l.z, fixed('aframe').uv);
      const spots = spotsOf('lobby', l.a[0], l.a[1], th, l.z);
      this.places.push({ id: 'lobby' + i, kind: 'lobby', name: l.name, sub: l.cat, spots, yaw: th, pos: spots.stand!, origin: fromBlender(l.a[0], l.a[1], l.z) });
    });
    data.homes.forEach((h, i) => {
      const th = thetaOf(h.n), kitName = h.style === 'village' ? 'door_village' : 'door_unit';
      pls.push({ kit: kitName, x: h.a[0], y: h.a[1], z: h.z, th });
      if (h.style === 'village') {
        addFace(qPlate, kitName, 'plate', h.a[0], h.a[1], th, h.z, plates.slot((g, w, hh) => drawPlate(g, w, hh, h.name, 'village')));
        const c = couplets[Math.floor(hash(h.name) * couplets.length)];
        addFace(qMisc, kitName, 'couplet_r', h.a[0], h.a[1], th, h.z, c[0]);
        addFace(qMisc, kitName, 'couplet_l', h.a[0], h.a[1], th, h.z, c[1]);
        addFace(fixed('fu').q, kitName, 'fu', h.a[0], h.a[1], th, h.z, fixed('fu').uv);
        addFace(fixed('banner').q, kitName, 'banner', h.a[0], h.a[1], th, h.z, fixed('banner').uv);
        addFace(qLed, kitName, 'led', h.a[0], h.a[1], th, h.z, leds[Math.floor(hash(h.name + 'led') * leds.length)]);
      } else {
        addFace(qPlate, kitName, 'plate', h.a[0], h.a[1], th, h.z, plates.slot((g, w, hh) => drawPlate(g, w, hh, h.name, 'unit')));
      }
      const spots = spotsOf(kitName, h.a[0], h.a[1], th, h.z);
      this.places.push({ id: 'home' + i, kind: 'home', name: h.name, sub: h.style, room: h.room, spots, yaw: th, pos: spots.stand!, origin: fromBlender(h.a[0], h.a[1], h.z) });
    });

    // instance the kits per 150 m chunk
    const byChunk = new Map<string, Pl[]>();
    for (const p of pls) {
      const k = `${p.kit}|${Math.floor(p.x / CHUNK)},${Math.floor(p.y / CHUNK)}`;
      if (!byChunk.has(k)) byChunk.set(k, []);
      byChunk.get(k)!.push(p);
    }
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), sc = new THREE.Vector3(1, 1, 1);
    for (const [k, list] of byChunk) {
      const parts = protos.get(k.split('|')[0]);
      if (!parts) continue;
      const center = new THREE.Vector3();
      for (const p of list) center.add(fromBlender(p.x, p.y, p.z));
      center.divideScalar(list.length);
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((p, i) => { q.setFromAxisAngle(up, p.th); m4.compose(fromBlender(p.x, p.y, p.z), q, sc); im.setMatrixAt(i, m4); });
        im.computeBoundingSphere();
        const mname = (part.material as THREE.Material).name;
        const detail = DETAIL.test(mname);
        im.castShadow = !/glass/.test(mname) && !detail; im.receiveShadow = true;
        this.group.add(im);
        this.chunks.push({ mesh: im, center, maxDist: detail ? 120 : /glass/.test(mname) ? 220 : 330 });
      }
    }
    // the sign meshes
    const signMat = (atlas: Atlas, name: string, emissive: boolean) => {
      const cut = atlas === misc || name === 'signs fu';
      const m = new THREE.MeshStandardMaterial({ map: atlas.tex, roughness: 0.45, metalness: 0.0, alphaTest: cut ? 0.4 : 0 });
      atlas.tex.generateMipmaps = true;
      if (emissive) { m.emissiveMap = atlas.tex; m.emissive = new THREE.Color(1, 1, 1); m.emissiveIntensity = 0.2; this.signMats.push(m); }
      m.name = name;
      m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
      return m;
    };
    fascia.tex.needsUpdate = true; plates.tex.needsUpdate = true; misc.tex.needsUpdate = true;
    this.group.add(qFascia.mesh(signMat(fascia, 'signs fascia', true), 'signs fascia'));
    this.group.add(qPlate.mesh(signMat(plates, 'signs plates', false), 'signs plates'));
    this.group.add(qMisc.mesh(signMat(misc, 'signs misc', true), 'signs misc'));
    ledAtlas.tex.needsUpdate = true;
    const ledMat = signMat(ledAtlas, 'signs led', true);
    this.ledMat = ledMat as THREE.MeshStandardMaterial;
    this.group.add(qLed.mesh(ledMat, 'signs led'));
    for (const [k, f] of fixedSigns) if (f.q.idx.length) { f.atlas.tex.needsUpdate = true; this.group.add(f.q.mesh(signMat(f.atlas, 'signs ' + k, true), 'signs ' + k)); }
  }

  /** Colliders: the shop boxes (piers, glass front) and racks; the lobby's locker and podium. */
  addColliders(props: PropColliders): void {
    const d = this.kit.bay.d, w = this.kit.bay.w;
    for (const p of this.places) {
      const y0 = p.origin.y;
      if (p.kind === 'shop') {
        this.box(props, p, 0, d / 2 + 0.05, w / 2, d / 2 + 0.1, y0, y0 + 3);
        if (p.sub === 'restaurant' || p.sub === 'tea') this.box(props, p, 1.4, d + 0.45, 0.42, 0.22, y0, y0 + 1.6);
        if (p.sub === 'convenience') this.box(props, p, -1.0, d + 0.4, 0.52, 0.32, y0, y0 + 0.9);
      } else if (p.kind === 'lobby') {
        this.box(props, p, 2.55, 0.35, 0.95, 0.32, y0, y0 + 2.4);
        this.box(props, p, -1.9, 1.7, 0.34, 0.24, y0, y0 + 1.1);
      }
    }
  }

  /** A box centred at kit-local (lx, ly) with half extents (hx along the facade, hy out from it). */
  private box(props: PropColliders, p: DeliveryPlace, lx: number, ly: number, hx: number, hy: number, y0: number, y1: number): void {
    // kit-local +x -> three.js local +x, kit-local +y (outward) -> three.js local -z (the yaw turns both)
    props.addBox(p.origin.x, p.origin.z, p.yaw, lx, -ly, hx, hy, y0, y1, 'shop');
  }

  /** A takeaway bag model (for handing over, leaving at a door, putting in a locker). */
  bag(): THREE.Object3D { return this.bagProto.clone(); }

  /** One kit as a plain group (one-offs: the station, the robot). */
  private kitGroup(name: string): THREE.Group {
    const g = new THREE.Group();
    for (const m of this.protos.get(name) ?? []) { const c = new THREE.Mesh(m.geometry, m.material); c.castShadow = !/glass/.test((m.material as THREE.Material).name); c.receiveShadow = true; g.add(c); }
    return g;
  }

  /** A sign face of a one-off kit (local rect from the kit json) drawn on its own canvas, added to `parent`. */
  private faceMesh(parent: THREE.Object3D, kitName: string, faceName: string, px: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, glow = 0.6): THREE.Mesh | null {
    const f = this.kit.faces[kitName]?.[faceName];
    if (!f) return null;
    const [x0, x1, z0, z1, y] = f;
    const w = Math.abs(x1 - x0), h = z1 - z0;
    const cv = document.createElement('canvas');
    cv.width = px; cv.height = Math.max(16, Math.round(px * h / w));
    draw(cv.getContext('2d')!, cv.width, cv.height);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const m = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: glow * 0.3, roughness: 0.5 });
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -2;
    this.signMats.push(m);
    // kit-local (Blender x, y, z) -> three (x, z, -y); faces look along +y (or -y when x0 > x1: the back side)
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.position.set((x0 + x1) / 2, (z0 + z1) / 2, -y);
    if (x0 > x1) mesh.rotation.y = 0; else mesh.rotation.y = Math.PI;
    parent.add(mesh);
    return mesh;
  }

  /**
   * Street food stalls (kit 'stall') for the pickups no shop wall could take: each at `pos` (three.js), the customer
   * side (kit +y) facing `yaw` like the station. They join `places` as shops with the kit's spots.
   */
  addStalls(list: { name: string; kind: ShopKind; pos: THREE.Vector3; yaw: number }[], props: PropColliders): void {
    list.forEach((s, i) => {
      const g = this.kitGroup('stall');
      g.position.copy(s.pos);
      g.rotation.y = s.yaw;
      this.group.add(g);
      this.faceMesh(g, 'stall', 'fascia', 640, (c, w, h) => drawFascia(c, w, h, s.name, s.kind), 0.9);
      this.faceMesh(g, 'stall', 'front', 512, (c, w, h) => drawStallFront(c, w, h, s.name, s.kind), 0.45);
      g.updateMatrixWorld(true);
      const spots: Partial<Record<Spot, THREE.Vector3>> = {};
      for (const [k, v] of Object.entries(this.kit.points.stall ?? {})) spots[k as Spot] = new THREE.Vector3(v[0], v[2], -v[1]).applyMatrix4(g.matrixWorld);
      this.places.push({ id: 'stall' + i, kind: 'shop', stall: true, name: s.name, sub: s.kind, spots, yaw: s.yaw, pos: spots.stand!, origin: s.pos.clone() });
      props.addBox(s.pos.x, s.pos.z, s.yaw, 0, 0, 1.65, 0.55, s.pos.y, s.pos.y + 2.4, 'shop');
      for (const lx of [-1.1, 0.1, 1.2]) this.walkBlockers.push({ p: new THREE.Vector3(lx, 0, 0).applyMatrix4(g.matrixWorld), r: 0.85 });
      this.chunks.push({ mesh: g as unknown as THREE.InstancedMesh, center: s.pos.clone(), maxDist: 260 });
    });
  }

  /**
   * The courier station at `pos` (three.js), its front (kit +y) facing `yaw`: the booth, cabinets, bench, a row of
   * parked e-bikes (instanced from the e-bike's model). Returns the kit points in world space.
   */
  addStation(pos: THREE.Vector3, yaw: number, ebike: THREE.Object3D | null, props: PropColliders, rating: () => number): Record<string, THREE.Vector3> {
    const g = this.kitGroup('station');
    g.position.copy(pos);
    g.rotation.y = yaw;
    this.group.add(g);
    this.faceMesh(g, 'station', 'sign', 1600, (c, w, h) => {
      c.fillStyle = '#c6f03c'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#10140a'; c.textAlign = 'left'; c.textBaseline = 'middle';
      fitText(c, '准时达 · 花城广场南站', w * 0.54, Math.round(h * 0.62)); c.fillText('准时达 · 花城广场南站', h * 0.4, h * 0.52);
      c.textAlign = 'right';
      fitText(c, '骑手驿站 · 饮水 · 充电 · 休息', w * 0.36, Math.round(h * 0.3), 700); c.fillText('骑手驿站 · 饮水 · 充电 · 休息', w - h * 0.4, h * 0.34);
      fitText(c, '（每次限时 10 分钟）', w * 0.36, Math.round(h * 0.24), 600); c.fillText('（每次限时 10 分钟）', w - h * 0.4, h * 0.72);
    }, 0.8);
    this.faceMesh(g, 'station', 'rank', 420, (c, w, h) => {
      c.fillStyle = '#14181b'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#c6f03c'; c.textAlign = 'center'; c.font = `900 ${Math.round(w * 0.09)}px ${FONT}`; c.fillText('本周骑手排行', w / 2, h * 0.1);
      const rows = [['阿杰', '4.99', '连续接单 21 天'], ['老周', '4.97', '连续接单 33 天'], ['小黎', '4.95', '今日 61 单'], ['阿伟', '—', '已转去「快到家」']];
      c.textAlign = 'left';
      rows.forEach(([n, r, t], i) => {
        const y = h * (0.22 + i * 0.15);
        c.fillStyle = i === 0 ? '#ffd23a' : '#ffffff'; c.font = `800 ${Math.round(w * 0.075)}px ${FONT}`; c.fillText(`${i + 1}. ${n}`, w * 0.06, y);
        c.textAlign = 'right'; c.fillText(r, w * 0.94, y); c.textAlign = 'left';
        c.fillStyle = '#9fb0b8'; c.font = `600 ${Math.round(w * 0.05)}px ${FONT}`; c.fillText(t, w * 0.1, y + h * 0.06);
      });
      c.fillStyle = '#ff8a6a'; c.font = `700 ${Math.round(w * 0.048)}px ${FONT}`; c.textAlign = 'center';
      c.fillText('小准提醒：休息是对奔跑的背叛', w / 2, h * 0.92);
    }, 0.5);
    void rating;
    // inside: the TV over the sofa, the label on the charging strip, the rules on the front wall
    this.faceMesh(g, 'station', 'tv', 640, (c, w, h) => {
      c.fillStyle = '#0b1d33'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#c6f03c'; c.fillRect(0, 0, w, h * 0.16);
      c.fillStyle = '#0b1d33'; c.textAlign = 'left'; c.textBaseline = 'middle';
      fitText(c, '准时达 · 今日播报', w * 0.9, Math.round(h * 0.11)); c.fillText('准时达 · 今日播报', w * 0.04, h * 0.08);
      const rows: [string, string][] = [['全城平均送达', '27 分 38 秒 ↓12 秒'], ['超时率', '3.2%（目标 0%）'], ['今日之星', '阿杰 · 4.99'], ['明日时限', '再快 3% 💪']];
      rows.forEach(([k, v], i) => {
        const y = h * (0.3 + i * 0.17);
        c.fillStyle = '#9fb6c8'; c.font = `700 ${Math.round(h * 0.075)}px ${FONT}`; c.fillText(k, w * 0.05, y);
        c.fillStyle = i === 3 ? '#ffd23a' : '#ffffff'; c.textAlign = 'right'; c.font = `900 ${Math.round(h * 0.09)}px ${FONT}`; c.fillText(v, w * 0.95, y); c.textAlign = 'left';
      });
      c.fillStyle = '#ff8a6a'; c.font = `700 ${Math.round(h * 0.06)}px ${FONT}`; c.textAlign = 'center';
      c.fillText('感谢每一位奔跑的你 · 休息是对奔跑的背叛', w / 2, h * 0.94);
    }, 1.0);
    this.faceMesh(g, 'station', 'charge', 512, (c, w, h) => {
      c.fillStyle = '#f2f2ee'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#1b1c1e'; c.textAlign = 'center'; c.textBaseline = 'middle';
      fitText(c, '共享充电 · ¥1/次 · 小准自动扣款', w * 0.94, Math.round(h * 0.62), 800); c.fillText('共享充电 · ¥1/次 · 小准自动扣款', w / 2, h / 2);
    }, 0.3);
    this.faceMesh(g, 'station', 'rules', 360, (c, w, h) => {
      c.fillStyle = '#fbfaf4'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#c8261e'; c.fillRect(0, 0, w, h * 0.17);
      c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = `900 ${Math.round(h * 0.09)}px ${FONT}`; c.fillText('准时达骑手守则', w / 2, h * 0.085);
      const rules = ['一、顾客永远是对的', '二、系统永远是对的', '三、二者冲突时，以系统为准', '四、休息时间不计入工作时长', '五、微笑是最好的服务', '六、本守则解释权归准时达所有'];
      c.fillStyle = '#1b1c1e'; c.textAlign = 'left';
      rules.forEach((r, i) => { fitText(c, r, w * 0.9, Math.round(h * 0.06), 700); c.fillText(r, w * 0.06, h * (0.26 + i * 0.12)); });
    }, 0.2);
    this.faceMesh(g, 'station', 'swap', 256, (c, w, h) => {
      c.fillStyle = '#0b2a4a'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#7ee0ff'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `800 ${Math.round(h * 0.26)}px ${FONT}`;
      c.fillText('换电柜 · 满电 7 块', w / 2, h * 0.35); c.fillStyle = '#ffd23a'; c.font = `700 ${Math.round(h * 0.2)}px ${FONT}`; c.fillText('换电 ¥2.5 / 次', w / 2, h * 0.72);
    }, 1.0);
    const pts: Record<string, THREE.Vector3> = {};
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    // kit-local (x, y): three local (x, -y); rotate by yaw about +Y
    const toW = (lx: number, ly: number, lz = 0) => new THREE.Vector3(pos.x + lx * c - ly * sn, pos.y + lz, pos.z - lx * sn - ly * c);
    for (const [k, v] of Object.entries(this.kit.points.station ?? {})) pts[k] = toW(v[0], v[1], v[2]);
    // colliders: the container's walls (the door is open: you can walk in), the open door leaf, the sofa, the cabinets
    const wallBox = (kx: number, ky: number, hx: number, hy: number, h = 2.8) => props.addBox(pos.x, pos.z, yaw, kx, -ky, hx, hy, pos.y, pos.y + h, 'shop');
    wallBox(0, -1.16, 3.0, 0.05);                       // back
    wallBox(-2.96, 0, 0.05, 1.2); wallBox(2.96, 0, 0.05, 1.2);
    wallBox(-0.95, 1.16, 2.05, 0.05);                  // front: end wall to the door, window included
    wallBox(2.55, 1.16, 0.45, 0.05);                   // front: right of the door
    wallBox(2.13, 1.66, 0.04, 0.46, 2.1);              // the door leaf, standing open
    wallBox(-1.65, -0.75, 1.05, 0.33, 0.9);            // sofa
    for (let lx = -2.2; lx <= 2.21; lx += 1.1) this.walkBlockers.push({ p: toW(lx, 0), r: 1.3 });
    this.walkBlockers.push({ p: toW(4.2, -0.6), r: 0.7 });
    for (let i = 0; i < 4; i++) this.walkBlockers.push({ p: toW(-3.2 + i * 1.05, 4.9), r: 0.7 });
    props.addBox(pos.x, pos.z, yaw, 4.2, -0.6, 1.05, 0.32, pos.y, pos.y + 2.0, 'shop');
    // the other couriers' e-bikes, parked in a row in front of the bench
    if (ebike) {
      const parts: THREE.Mesh[] = [];
      ebike.updateMatrixWorld(true);
      ebike.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !/screen|logo|plate/.test(m.name)) parts.push(m); });
      const n = 4, m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), inv = new THREE.Matrix4().copy(ebike.matrixWorld).invert();
      for (const part of parts) {
        const local = new THREE.Matrix4().multiplyMatrices(inv, part.matrixWorld);
        const im = new THREE.InstancedMesh(part.geometry, part.material, n);
        for (let i = 0; i < n; i++) {
          const p = toW(-3.2 + i * 1.05, 4.9, 0);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw + Math.PI / 2 + 0.35 + (i % 2) * 0.08);
          m4.compose(p, q, new THREE.Vector3(1, 1, 1)).multiply(local);
          im.setMatrixAt(i, m4);
        }
        im.computeBoundingSphere();
        im.castShadow = true; im.receiveShadow = true;
        this.group.add(im);
        this.chunks.push({ mesh: im, center: pos.clone(), maxDist: 160 });
      }
      for (let i = 0; i < n; i++) { const p = toW(-3.2 + i * 1.05, 4.9, 0); props.addBox(p.x, p.z, yaw + Math.PI / 2 + 0.35, 0, 0, 0.3, 0.95, pos.y, pos.y + 1.2, 'shop'); }
    }
    return pts;
  }

  /**
   * Bus stop boards at the given stops (three.js position on the pavement, yaw = the board's facing), with the
   * stop's name and a few made-up route rows. Returns where people wait at each.
   */
  addBusSigns(stops: { pos: THREE.Vector3; yaw: number; name: string }[]): THREE.Vector3[] {
    const parts = this.protos.get('bus_sign') ?? [];
    const atlas = new Atlas(2048, 2048, 97, 207);          // 21 x 9 = 189 boards
    const q = new Quads();
    const routes = ['40', '90', '107', '194', '230', '886', 'B1', 'B4', '夜34', '284', '518', '823'];
    const waits: THREE.Vector3[] = [];
    const m4 = new THREE.Matrix4(), qt = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
    const ims = parts.map((p) => new THREE.InstancedMesh(p.geometry, p.material, stops.length));
    stops.forEach((st, i) => {
      qt.setFromAxisAngle(up, st.yaw);
      m4.compose(st.pos, qt, one);
      ims.forEach((im) => im.setMatrixAt(i, m4));
      const name = st.name.replace(/ 公交站$/, '').replace(/站$/, '');
      let uv: number[];
      try {
        uv = atlas.slot((g, w, h) => {
          g.fillStyle = '#1f6e3d'; g.fillRect(0, 0, w, h);
          g.fillStyle = '#f4f4ee'; g.fillRect(0, 0, w, h * 0.17);
          g.fillStyle = '#1b1b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
          fitText(g, name + '站', w - 8, Math.round(h * 0.085)); g.fillText(name + '站', w / 2, h * 0.07);
          g.font = `600 ${Math.round(h * 0.03)}px ${FONT}`; g.fillText('BUS STOP', w / 2, h * 0.14);
          const n = 4 + Math.floor(hash(name) * 3);
          // n different routes, a seeded shuffle of the list
          const pick = routes.map((r, k) => ({ r, o: hash(name + '/' + r + k) })).sort((a, b) => a.o - b.o).slice(0, n).map((x) => x.r);
          for (let k = 0; k < n; k++) {
            const y = h * (0.2 + k * 0.13);
            const r = pick[k];
            const here = Math.floor(hash(name + r) * 6);       // this stop on the route's strip
            g.fillStyle = '#14552e'; g.fillRect(4, y, w * 0.36, h * 0.11);
            g.fillStyle = '#ffffff'; g.font = `900 ${Math.round(h * 0.055)}px ${FONT}`; g.fillText(r, w * 0.2, y + h * 0.05);
            g.fillStyle = '#ff6a5a'; g.font = `700 ${Math.round(h * 0.022)}px ${FONT}`; g.fillText('下站', w * 0.2, y + h * 0.093);
            for (let j = 0; j < 6; j++) {
              g.fillStyle = j === here ? '#ffd23a' : 'rgba(255,255,255,0.85)';
              g.fillRect(w * 0.42 + j * w * 0.09, y + 4, w * 0.05, h * 0.1 - 8);
            }
          }
          g.fillStyle = '#f08a24'; g.fillRect(0, h * 0.92, w, h * 0.08);
          g.fillStyle = '#ffffff'; g.font = `700 ${Math.round(h * 0.025)}px ${FONT}`; g.fillText('温馨提示：请勿在站台等外卖', w / 2, h * 0.96);
        });
      } catch { uv = [0, 0, 0.01, 0.01]; }
      const th = st.yaw;
      for (const side of ['front', 'back'] as const) {
        const f = this.kit.faces.bus_sign[side];
        const [x0, x1, z0, z1, y] = f;
        // kit-local -> world: x along (cos th, 0, -sin th), local y (Blender) -> three -z turned by th
        const toW = (lx: number, ly: number, lz: number) => new THREE.Vector3(st.pos.x + lx * Math.cos(th) - ly * Math.sin(th), st.pos.y + lz, st.pos.z - lx * Math.sin(th) - ly * Math.cos(th));
        const corners = [[x1, y, z0], [x0, y, z0], [x0, y, z1], [x1, y, z1]].map(([a, b, cc]) => toW(a, b, cc));
        const nrm = new THREE.Vector3(-Math.sin(th), 0, -Math.cos(th)).multiplyScalar(side === 'front' ? 1 : -1);
        q.add(corners, uv, nrm);
      }
      const w = this.kit.points.bus_sign.wait;
      waits.push(new THREE.Vector3(st.pos.x + w[0] * Math.cos(th) - w[1] * Math.sin(th), st.pos.y, st.pos.z - w[0] * Math.sin(th) - w[1] * Math.cos(th)));
    });
    for (const im of ims) {
      im.computeBoundingSphere();
      im.castShadow = true; im.receiveShadow = true;
      this.group.add(im);
    }
    atlas.tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({ map: atlas.tex, emissiveMap: atlas.tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.2, roughness: 0.4 });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -1; mat.polygonOffsetUnits = -2;
    this.signMats.push(mat);
    this.group.add(q.mesh(mat, 'bus boards'));
    return waits;
  }

  /** The hotel's delivery robot (小准二号), with a face on its screen. */
  robot(): THREE.Object3D {
    const g = this.kitGroup('robot');
    this.faceMesh(g, 'robot', 'face', 128, (c, w, h) => {
      c.fillStyle = '#0b2a4a'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#7ee0ff';
      c.beginPath(); c.arc(w * 0.32, h * 0.45, h * 0.16, 0, Math.PI * 2); c.arc(w * 0.68, h * 0.45, h * 0.16, 0, Math.PI * 2); c.fill();
      c.fillRect(w * 0.38, h * 0.74, w * 0.24, h * 0.06);
    }, 1.4);
    return g;
  }

  /** Night: the lightboxes, the menu boards, the fridges and lockers glow; by day they are dimmer. */
  update(night: number): void {
    const k = 0.35 + 0.65 * night;
    for (const g of this.glow) g.m.emissiveIntensity = g.base * k;
    for (const m of this.signMats) m.emissiveIntensity = 0.12 + 1.0 * night;
    if (this.ledMat) this.ledMat.emissiveIntensity = 0.5 + 2.2 * night;     // LEDs are bright even by day
  }

  near(p: THREE.Vector3, r: number, kind?: DeliveryPlace['kind']): DeliveryPlace[] {
    return this.places.filter((x) => (!kind || x.kind === kind) && x.pos.distanceTo(p) < r);
  }
}
