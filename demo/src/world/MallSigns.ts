import * as THREE from 'three';
import { fromBlender } from '../config';

/**
 * 花城汇 B1's lettering and lightboxes (gz_mall -> huacheng.json 'mall'), after the Commons set "2024 in Mall of the
 * World": black hanging signs with white characters and arrows (both faces, each telling the way for the one who
 * reads it), poster lightboxes on the columns, the floor directory by the link, and the LED screen on the corridor's
 * south wall cycling the mall's ads. One canvas atlas and one mesh for the boards, the screen its own canvas.
 * Everything here is indoors and lit day and night. The posters are the story's world: the platform, its AI, the
 * e-woodfish, a matchmaking fair run by an algorithm.
 */
interface Face { c: number[]; n: number[]; w: number; h: number }
interface Hang extends Face { k: string }
interface Poster extends Face { i: number }
export interface MallJson {
  hang: Hang[]; posters: Poster[]; directory: Face | null; screen: Face | null;
  rect: number[]; z: number; h: number; vest: number[]; link: number[]; xlink: number[]; well: number[]; sdoor: number[];
}

const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const EN = '"Avenir Next", "Helvetica Neue", Arial, sans-serif';

/**
 * What each hanging sign face says: [arrow, zone line, English]. Keyed by the sign (south / mid / north) and which way
 * the reader is walking (n = (0, -1) faces south: read by those walking north).
 */
const HANG: Record<string, Record<'N' | 'S', [string, string, string]>> = {
  south: { N: ['↑', '中区 · APM 花城大道站 · 北区出口', 'Central Zone · APM Huacheng Ave · North Exit'],
           S: ['→', '南区 · 下沉广场 · 花城广场', 'South Zone · Sunken Plaza'] },
  mid: { N: ['↗', 'APM 花城大道站  珠江新城方向', 'APM Huacheng Avenue Station'],
         S: ['↓', '南区 · 下沉广场 · 大剧院 · 图书馆', 'Sunken Plaza · Opera House · Library'] },
  north: { N: ['↑', '北区出口 · 花城广场北 · 音乐喷泉', 'North Exit · Music Fountain'],
           S: ['←', 'APM 花城大道站  妇儿中心 / 广州塔', 'APM Huacheng Avenue'] },
};

/** Poster lightboxes: headline, body, small print, background, ink, accent. */
const POSTERS: [string, string, string, string, string, string][] = [
  ['小准 AI 调度 3.0', '比你更懂\n你的时间', '准时达 · 平均送达 27 分 38 秒↓12 秒\n*以算法统计为准', '#c6f03c', '#10181c', '#10181c'],
  ['功德 +1', '敲一下\n免一单超时', '电子木鱼 Pro · 每秒敲 60 下\n花城汇 B1 中区 体验店', '#120c08', '#ffcc33', '#ff6a00'],
  ['早茶自由', '虾饺套餐\n¥9.9', '仅限骑手 · 出示准时达工牌\n每日 6:00–9:30', '#7a1d18', '#f6d48a', '#ffffff'],
  ['花城汇 周年庆', '满 300\n减 30', '积分可抵外卖配送费\n活动最终解释权归算法所有', '#e8e4da', '#7a1d18', '#c48a22'],
  ['天河 AI 相亲大会', '匹配度\n99.2%', '剩下的 0.8% 请自行承担\n报名：扫码 · 由小准匹配', '#ffd1dc', '#7a2140', '#ff3d7f'],
  ['共享充电 ¥1/次', '电量\n就是正义', '小准自动扣款 · 不满 1 小时按 1 小时\n骑手驿站 · 中区', '#0f2d4d', '#5fd3ff', '#ffffff'],
];

/** The LED screen's cycle (drawn in turn into the screen canvas). */
const SCREEN: { bg: string[]; big: string; small: string; ink: string }[] = [
  { bg: ['#1d150e', '#3a2c1e'], big: '花城汇', small: 'MALL OF THE WORLD · 欢迎光临', ink: '#ffd56a' },
  { bg: ['#10181c', '#1e2a10'], big: '准时达 夜宵节', small: '22:00 后下单 · 骑手不睡你就不饿', ink: '#c6f03c' },
  { bg: ['#0f2d4d', '#123c6b'], big: '花城广场 音乐喷泉', small: '今晚 20:00 · 21:00 两场 · 北区', ink: '#9bd8ff' },
  { bg: ['#2a0f14', '#5a1520'], big: '周年庆 满 300 减 30', small: '积分可抵配送费 · 最终解释权归算法所有', ink: '#ffffff' },
];

export class MallSigns {
  readonly group = new THREE.Group();
  private readonly screenCtx: CanvasRenderingContext2D;
  private readonly screenTex: THREE.CanvasTexture;
  private readonly screenCv: HTMLCanvasElement;
  private slide = -1;
  private t = 0;

  constructor(readonly data: MallJson) {
    this.group.name = 'mall signs';
    // ---- the atlas: hanging sign faces (1024 x 136), posters (400 x 900), the directory (640 x 880)
    const faces: { f: Face; draw: (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void; pw: number; ph: number }[] = [];
    for (const h of data.hang) {
      const dir: 'N' | 'S' = h.n[1] < 0 ? 'N' : 'S';
      const txt = HANG[h.k]?.[dir] ?? ['', '', ''];
      faces.push({ f: h, pw: 1024, ph: 136, draw: (g, x, y, w, hh) => this.drawHang(g, x, y, w, hh, txt) });
    }
    for (const p of data.posters) faces.push({ f: p, pw: 400, ph: 900, draw: (g, x, y, w, hh) => this.drawPoster(g, x, y, w, hh, POSTERS[p.i % POSTERS.length]) });
    if (data.directory) faces.push({ f: data.directory, pw: 640, ph: 880, draw: (g, x, y, w, hh) => this.drawDirectory(g, x, y, w, hh) });
    // shelf packing into a 2048-wide canvas
    const W = 2048;
    let x = 0, y = 0, rowH = 0;
    const at: [number, number][] = [];
    for (const f of faces) {
      if (x + f.pw > W) { x = 0; y += rowH + 4; rowH = 0; }
      at.push([x, y]); x += f.pw + 4; rowH = Math.max(rowH, f.ph);
    }
    const H = y + rowH;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d')!;
    faces.forEach((f, i) => f.draw(g, at[i][0], at[i][1], f.pw, f.ph));
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.35 });
    mat.name = 'mall signs';
    this.group.add(this.quads(faces.map((f, i) => ({ f: f.f, u0: at[i][0] / W, v0: at[i][1] / H, u1: (at[i][0] + f.pw) / W, v1: (at[i][1] + f.ph) / H })), mat, 'mall boards'));
    // ---- the screen
    this.screenCv = document.createElement('canvas'); this.screenCv.width = 1024; this.screenCv.height = 432;
    this.screenCtx = this.screenCv.getContext('2d')!;
    this.screenTex = new THREE.CanvasTexture(this.screenCv);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    const smat = new THREE.MeshStandardMaterial({ map: this.screenTex, emissiveMap: this.screenTex, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.25, color: 0x111111 });
    smat.name = 'mall screen';
    if (data.screen) this.group.add(this.quads([{ f: data.screen, u0: 0, v0: 0, u1: 1, v1: 1 }], smat, 'mall screen'));
    this.update(0);
  }

  /** One quad per face (Blender centre c, outward n, w x h), uv from the atlas rectangle (y down). */
  private quads(list: { f: Face; u0: number; v0: number; u1: number; v1: number }[], mat: THREE.Material, name: string): THREE.Mesh {
    const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
    for (const { f, u0, v0, u1, v1 } of list) {
      const [cx, cy, cz] = f.c, [nx, ny] = f.n;
      const tx = -ny, ty = nx;                    // left to right as seen by the reader (looking along -n)
      const base = pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = fromBlender(cx + tx * a * f.w / 2 + nx * 0.008, cy + ty * a * f.w / 2 + ny * 0.008, cz + b * f.h / 2);
        pos.push(p.x, p.y, p.z);
        const n = fromBlender(nx, ny, 0);
        nor.push(n.x, n.y, n.z);
        uv.push(a < 0 ? u0 : u1, 1 - (b < 0 ? v1 : v0));
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    return m;
  }

  /** The screen changes slide every 8 s (a quick wipe between them is the canvas being redrawn). */
  update(dt: number): void {
    this.t += dt;
    const k = Math.floor(this.t / 8) % SCREEN.length;
    if (k === this.slide) return;
    this.slide = k;
    const s = SCREEN[k], g = this.screenCtx, W = this.screenCv.width, H = this.screenCv.height;
    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, s.bg[0]); bg.addColorStop(1, s.bg[1]);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // LED dot texture
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let yy = 0; yy < H; yy += 4) g.fillRect(0, yy, W, 1);
    g.fillStyle = s.ink; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `900 120px ${FONT}`; g.fillText(s.big, W / 2, H * 0.42, W - 80);
    g.font = `600 40px ${FONT}`; g.globalAlpha = 0.9; g.fillText(s.small, W / 2, H * 0.78, W - 80); g.globalAlpha = 1;
    this.screenTex.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------ drawing
  private drawHang(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, [arrow, zh, en]: [string, string, string]): void {
    g.fillStyle = '#101112'; g.fillRect(x, y, w, h);
    g.strokeStyle = '#3a3d40'; g.lineWidth = 3; g.strokeRect(x + 4, y + 4, w - 8, h - 8);
    g.fillStyle = '#ffffff'; g.textBaseline = 'middle';
    // the arrow in a white rounded square, the way in characters, the English under it
    g.beginPath(); g.roundRect(x + 18, y + 18, h - 36, h - 36, 10); g.fill();
    g.fillStyle = '#101112'; g.textAlign = 'center'; g.font = `900 78px ${FONT}`;
    g.fillText(arrow, x + 18 + (h - 36) / 2, y + h / 2 + 4);
    g.fillStyle = '#ffffff'; g.textAlign = 'left';
    g.font = `700 50px ${FONT}`; g.fillText(zh, x + h + 10, y + 50, w - h - 30);
    g.font = `500 26px ${EN}`; g.globalAlpha = 0.85; g.fillText(en, x + h + 12, y + 104, w - h - 30); g.globalAlpha = 1;
  }

  private drawPoster(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, [head, big, small, bg, ink, acc]: [string, string, string, string, string, string]): void {
    g.fillStyle = bg; g.fillRect(x, y, w, h);
    // a big accent circle, the headline, the hook in huge type, the small print
    g.globalAlpha = 0.22; g.fillStyle = acc; g.beginPath(); g.arc(x + w * 0.72, y + h * 0.36, w * 0.48, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
    g.fillStyle = ink; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.font = `800 46px ${FONT}`; g.fillText(head, x + 30, y + 92, w - 60);
    g.fillRect(x + 30, y + 118, 80, 8);
    g.font = `900 92px ${FONT}`;
    big.split('\n').forEach((line, i) => g.fillText(line, x + 28, y + 290 + i * 112, w - 56));
    g.font = `500 22px ${FONT}`; g.globalAlpha = 0.85;
    small.split('\n').forEach((line, i) => g.fillText(line, x + 30, y + h - 110 + i * 34, w - 60));
    g.globalAlpha = 1;
    g.font = `700 20px ${EN}`; g.fillText('花城汇 MALL OF THE WORLD', x + 30, y + h - 30);
  }

  private drawDirectory(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    g.fillStyle = '#f4f2ec'; g.fillRect(x, y, w, h);
    g.fillStyle = '#1d150e'; g.fillRect(x, y, w, 118);
    g.fillStyle = '#ffd56a'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `900 56px ${FONT}`; g.fillText('花城汇', x + 28, y + 50);
    g.font = `700 20px ${EN}`; g.fillText('MALL OF THE WORLD · B1 楼层导览', x + 32, y + 96);
    // the plan: south zone fan, the middle corridor (here), the APM station beside it, the north zone
    const px = x + 40, py = y + 150, pw = w - 80, ph = h - 240;
    g.strokeStyle = '#3a3d40'; g.lineWidth = 3;
    const mx = px + pw * 0.3, cw = pw * 0.16;
    g.fillStyle = '#e7d6b0'; g.fillRect(mx, py + ph * 0.18, cw, ph * 0.62);                 // middle corridor
    g.fillStyle = '#cfe6f2'; g.fillRect(mx + cw + 14, py + ph * 0.22, pw * 0.26, ph * 0.5);   // APM station
    g.fillStyle = '#f0c9a8'; g.beginPath();                                                   // south zone fan
    g.moveTo(mx - 20, py + ph * 0.8); g.lineTo(mx + cw + pw * 0.36, py + ph * 0.8); g.lineTo(mx + cw + pw * 0.3, py + ph); g.lineTo(mx - 10, py + ph); g.closePath(); g.fill();
    g.fillStyle = '#d6e8c4'; g.beginPath(); g.ellipse(mx + cw / 2, py + ph * 0.08, pw * 0.22, ph * 0.08, 0, 0, Math.PI * 2); g.fill();   // north zone
    g.fillStyle = '#1d1d1d'; g.font = `700 22px ${FONT}`; g.textAlign = 'center';
    g.fillText('北区', mx + cw / 2, py + ph * 0.08);
    g.save(); g.translate(mx + cw / 2, py + ph * 0.5); g.rotate(-Math.PI / 2); g.fillText('中区 · 商业街', 0, 0); g.restore();
    g.fillText('APM 花城大道站', mx + cw + 14 + pw * 0.13, py + ph * 0.47);
    g.fillText('南区 · 下沉广场', mx + cw / 2 + pw * 0.12, py + ph * 0.9);
    // you are here: by the link
    const yx = mx + cw - 8, yy = py + ph * 0.74;
    g.fillStyle = '#d71920'; g.beginPath(); g.arc(yx, yy, 13, 0, Math.PI * 2); g.fill();
    g.textAlign = 'left'; g.font = `800 22px ${FONT}`; g.fillText('您在此处', yx + 20, yy - 4);
    g.font = `600 14px ${EN}`; g.fillText('YOU ARE HERE', yx + 20, yy + 18);
    // the legend: a few of the shops
    g.fillStyle = '#3a3d40'; g.font = `500 17px ${FONT}`; g.textAlign = 'left';
    const legend = ['B1-01 每餐乐', 'B1-06 功德 +1', 'B1-09 准时达体验店', 'B1-12 小准AI 按摩椅', 'B1-15 骑手驿站', 'B1-20 花城药房'];
    legend.forEach((s, i) => g.fillText(s, px + pw * 0.66, py + ph * 0.1 + i * 28));
    g.fillStyle = '#7a1d18'; g.font = `600 16px ${FONT}`;
    g.fillText('洗手间 · 母婴室 → 中区北端', x + 40, y + h - 46);
  }
}
