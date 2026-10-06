import * as THREE from 'three';
import { fromBlender } from '../config';
import type { Footprint, RoadGraph } from './City';
import { GZ } from './Materials';
import { fogUniforms } from './Sky';

/**
 * The 2030s layer over the real Tianhe skeleton, generated from footprints.json and roads.json:
 *
 *  - TowerLights  architectural LED outlines on towers over 70 m: corner lines, crowns, and on some towers
 *                 floor bands; each tower runs its own programme (steady white, slow colour cycle, waves
 *                 climbing the facade) -- one additive draw call, night only.
 *  - MediaWalls   LED media facades on a dozen tall towers facing the public spaces, cycling parody ads
 *                 (canvas-drawn, fictional brands) and generative interludes, with an LED dot pitch that
 *                 shows up close. On by day as well, brighter at night.
 *  - ShopSigns    lightboxes and neon over the shopfronts of every street-facing facade, fictional shop
 *                 names from a canvas atlas, instanced (one draw call); daylight-lit, glowing at night.
 *
 * All text is drawn here with canvas 2D; brands and shops are invented (GTA convention, no real marks).
 */
const FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';

type P2 = [number, number];

function ringArea(r: P2[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;   // > 0 counter-clockwise (x east, y north)
}

/** Outer ring, counter-clockwise, without a repeated closing point. */
function ccw(o: P2[]): P2[] {
  let r = o.slice();
  if (r.length > 2 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (ringArea(r) < 0) r = r.reverse();
  return r;
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// ------------------------------------------------------------------------------------------ tower lights
export class TowerLights {
  readonly mesh: THREE.Mesh;

  constructor(footprints: Footprint[]) {
    const pos: number[] = [], info: number[] = [];
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, h: number, r: number, kind: number, mode: number) => {
      for (const p of [a, b, c, a, c, d]) { pos.push(p.x, p.y, p.z); info.push(h, r, kind, mode); }
    };
    let towers = 0;
    footprints.forEach((f, idx) => {
      if (f.lm || f.z < 70) return;
      const ring = ccw(f.o as P2[]);
      if (ring.length < 3) return;
      const H = f.z, r = hash(idx + 0.5);
      // not every tower is outlined: the tallest always, the rest about half
      if (H < 180 && hash(idx * 7.7 + 1.3) > 0.55) return;
      towers++;
      // programme: 0 steady, 1 colour cycle, 2 climbing waves, 3 floor bands + steady corners
      const mode = r < 0.45 ? 0 : r < 0.68 ? 1 : r < 0.86 ? 2 : 3;
      const n = ring.length;
      const edge = (i: number) => { const a = ring[i], b = ring[(i + 1) % n]; const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return { a, b, l, t: [dx / l, dy / l] as P2, nrm: [dy / l, -dx / l] as P2 }; };
      // corners: turns sharper than 28 degrees; long smooth curves get a line every 18 m instead
      let lastCorner = -1e9, run = 0;
      for (let i = 0; i < n; i++) {
        const e0 = edge((i - 1 + n) % n), e1 = edge(i);
        const turn = Math.acos(Math.max(-1, Math.min(1, e0.t[0] * e1.t[0] + e0.t[1] * e1.t[1])));
        run += e0.l;
        if (turn < THREE.MathUtils.degToRad(28) && run - lastCorner < 18) continue;
        if (turn < THREE.MathUtils.degToRad(28) && e0.l > 6) continue;
        lastCorner = run;
        const bx = e0.nrm[0] + e1.nrm[0], by = e0.nrm[1] + e1.nrm[1];
        const bl = Math.hypot(bx, by) || 1;
        const p = ring[i];
        const ox = p[0] + bx / bl * 0.4, oy = p[1] + by / bl * 0.4;
        const tx = -by / bl * 0.45, ty = bx / bl * 0.45;          // half-width across the corner
        const z0 = Math.max(10, H * 0.06), z1 = H + 0.4;
        quad(fromBlender(ox - tx, oy - ty, z0), fromBlender(ox + tx, oy + ty, z0), fromBlender(ox + tx, oy + ty, z1), fromBlender(ox - tx, oy - ty, z1), H, r, 0, mode);
      }
      // crown and bands along every edge
      for (let i = 0; i < n; i++) {
        const e = edge(i);
        if (e.l < 0.5) continue;
        const ox = e.nrm[0] * 0.3, oy = e.nrm[1] * 0.3;
        const strip = (za: number, zb: number, kind: number) => quad(
          fromBlender(e.a[0] + ox, e.a[1] + oy, za), fromBlender(e.b[0] + ox, e.b[1] + oy, za),
          fromBlender(e.b[0] + ox, e.b[1] + oy, zb), fromBlender(e.a[0] + ox, e.a[1] + oy, zb), H, r, kind, mode);
        strip(H - 2.2, H - 0.6, 1);
        if (mode === 3) for (let z = 24; z < H - 12; z += 16) strip(z, z + 0.6, 2);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTower', new THREE.Float32BufferAttribute(info, 4));
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: GZ.uNight, uTime: GZ.uTime },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      vertexShader: /* glsl */`
        attribute vec4 aTower;
        varying vec4 vT; varying float vY; varying float vDist;
        void main() {
          vT = aTower; vY = position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight, uTime;
        varying vec4 vT; varying float vY; varying float vDist;
        vec3 hsv(float h, float s, float v) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), k, s); }
        void main() {
          float H = vT.x, r = vT.y, kind = vT.z, mode = vT.w;
          float h = clamp(vY / H, 0.0, 1.0);
          vec3 warm = vec3(1.0, 0.78, 0.5), cool = vec3(0.75, 0.88, 1.0), gold = vec3(1.0, 0.66, 0.25);
          vec3 col = r < 0.3 ? warm : r < 0.6 ? cool : gold;
          float k = kind < 0.5 ? 1.0 : kind < 1.5 ? 1.3 : 0.7;
          if (mode > 0.5 && mode < 1.5) col = hsv(fract(r * 3.1 + uTime * 0.015 + h * 0.25), 0.55, 1.0);
          if (mode > 1.5 && mode < 2.5) {
            float w = 0.5 + 0.5 * sin(h * 14.0 - uTime * 1.3 + r * 40.0);
            k *= 0.25 + 1.4 * w * w * w;
            col = mix(cool, hsv(0.52 + r * 0.3, 0.6, 1.0), 0.6);
          }
          // the crown breathes slowly; far away the lines thin out into the haze
          k *= kind > 0.5 && kind < 1.5 ? 0.85 + 0.15 * sin(uTime * 0.7 + r * 20.0) : 1.0;
          float fade = exp(-vDist * 0.00022);
          float level = 0.45 + 0.55 * fract(r * 17.3);          // each building its own brightness
          gl_FragColor = vec4(col * k * 2.6 * level * uNight * fade, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = `tower-lights (${towers} towers)`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }
}

// ------------------------------------------------------------------------------------------ media walls
interface Ad { bg: [string, string]; title: string; sub: string; accent: string; tag: string; ink?: string }
const ADS: Ad[] = [
  { bg: ['#1b1d1f', '#2d3a12'], title: '准时达', sub: '30分钟必达\n超时？扣的是你的分', accent: '#c6f03c', tag: 'ZHUNSHIDA' },
  { bg: ['#07122e', '#1a3a8a'], title: '小准AI', sub: '为您优化一切\n包括您', accent: '#7ee0ff', tag: 'XIAOZHUN · AI' },
  { bg: ['#2a0633', '#c2185b'], title: '赞赞直播', sub: '流量即正义\n今晚你就是热搜', accent: '#ffd1f0', tag: 'ZANZAN LIVE' },
  { bg: ['#0b0f14', '#0f4f4a'], title: '盘古智能', sub: '红绿灯会员\n¥9.9/月 一路绿灯', accent: '#39f5c1', tag: 'PANGU' },
  { bg: ['#2b1b0a', '#8a4b12'], title: '早茶自由', sub: '虾饺烧卖\n12期免息', accent: '#ffcf70', tag: 'DIM SUM PAY' },
  { bg: ['#101010', '#3c3c3c'], title: '天河云居', sub: '月供只要\n一辈子', accent: '#ffffff', tag: 'CLOUD HOME' },
  { bg: ['#1a0000', '#b3001b'], title: '功德+1', sub: '电子木鱼 Pro\n每秒敲 60 下', accent: '#ffe08a', tag: 'MERIT PRO' },
  { bg: ['#03201a', '#0a8a5f'], title: '4.99', sub: '全城最高分骑手\n城市的心跳', accent: '#c6f03c', tag: 'ZHUNSHIDA RIDERS' },
];

function drawAds(): THREE.CanvasTexture {
  const W = 256, Hh = 768;
  const cv = document.createElement('canvas');
  cv.width = W * ADS.length; cv.height = Hh;
  const g = cv.getContext('2d')!;
  ADS.forEach((ad, i) => {
    const x0 = i * W;
    const grad = g.createLinearGradient(x0, 0, x0, Hh);
    grad.addColorStop(0, ad.bg[0]); grad.addColorStop(1, ad.bg[1]);
    g.fillStyle = grad; g.fillRect(x0, 0, W, Hh);
    // a bold graphic: rings, a disc and stripes in the accent colour
    g.save();
    g.beginPath(); g.rect(x0, 0, W, Hh); g.clip();
    g.globalAlpha = 0.9;
    g.strokeStyle = ad.accent; g.lineWidth = 10;
    g.beginPath(); g.arc(x0 + W * 0.5, Hh * 0.62, W * 0.34, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.35;
    g.beginPath(); g.arc(x0 + W * 0.5, Hh * 0.62, W * 0.46, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.18;
    for (let k = 0; k < 9; k++) { g.fillStyle = ad.accent; g.fillRect(x0 - 40 + k * 40, Hh * 0.85, 18, Hh * 0.15); }
    g.restore();
    g.fillStyle = ad.accent;
    g.textAlign = 'center';
    g.font = `900 ${ad.title.length > 3 ? 54 : 70}px ${FONT}`;
    g.fillText(ad.title, x0 + W / 2, 150);
    g.fillStyle = ad.ink ?? '#ffffff';
    g.font = `700 26px ${FONT}`;
    ad.sub.split('\n').forEach((line, k) => g.fillText(line, x0 + W / 2, 220 + k * 36));
    g.font = `600 14px ${FONT}`;
    g.globalAlpha = 0.8;
    g.fillText(ad.tag, x0 + W / 2, Hh - 30);
    g.globalAlpha = 1;
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

export class MediaWalls {
  readonly mesh: THREE.Mesh;
  readonly count: number;

  constructor(footprints: Footprint[], centre: P2 = [0, -300]) {
    type Cand = { f: Footprint; i: number; a: P2; b: P2; l: number; nrm: P2; score: number; mid: P2 };
    const cands: Cand[] = [];
    footprints.forEach((f) => {
      // the Second Children's Palace really has a giant curved LED screen over its entrance, facing the square
      const palace = f.lm === 'childrens_palace';
      if ((f.lm && !palace) || (!palace && f.z < 110)) return;
      const ring = ccw(f.o as P2[]);
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < 24) continue;
        const nrm: P2 = [dy / l, -dx / l];
        const mid: P2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const tc = palace ? [1, 0] : [centre[0] - mid[0], centre[1] - mid[1]], tl = palace ? 1 : Math.hypot(tc[0], tc[1]) || 1;
        const facing = (nrm[0] * tc[0] + nrm[1] * tc[1]) / tl;
        if (facing < (palace ? 0.8 : 0.25)) continue;
        cands.push({ f, i, a, b, l, nrm, mid, score: palace ? 1e6 * facing : f.z * (0.6 + facing) * Math.min(1, l / 40) / (1 + tl / 1500) });
      }
    });
    cands.sort((x, y) => y.score - x.score);
    const chosen: Cand[] = [];
    for (const c of cands) {
      if (chosen.length >= 14) break;
      if (chosen.some((o) => o.f === c.f || Math.hypot(o.mid[0] - c.mid[0], o.mid[1] - c.mid[1]) < 90)) continue;
      chosen.push(c);
    }
    const pos: number[] = [], uv: number[] = [], wall: number[] = [];
    chosen.forEach((c, k) => {
      const H = c.f.z;
      const palace = c.f.lm === 'childrens_palace';
      const z0 = palace ? 10.5 : Math.max(24, H * 0.32), z1 = palace ? 24.5 : H * 0.93;
      const off = 0.6;                                    // on a frame just off the curtain wall
      const s0 = 0.07, s1 = 0.93;
      const P = (s: number, z: number) => fromBlender(c.a[0] + (c.b[0] - c.a[0]) * s + c.nrm[0] * off, c.a[1] + (c.b[1] - c.a[1]) * s + c.nrm[1] * off, z);
      const q = [P(s0, z0), P(s1, z0), P(s1, z1), P(s0, z1)];
      const t = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const aspect = (c.l * (s1 - s0)) / (z1 - z0);
      for (const j of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[j].x, q[j].y, q[j].z); uv.push(t[j][0], t[j][1]);
        wall.push(k, aspect, hash(k + 3.3), c.l * (s1 - s0));
      }
    });
    this.count = chosen.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 4));
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: GZ.uNight, uTime: GZ.uTime, uAds: { value: drawAds() }, uN: { value: ADS.length } },
      side: THREE.FrontSide, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      vertexShader: /* glsl */`
        attribute vec4 aWall;
        varying vec2 vUv; varying vec4 vW; varying float vDist;
        void main() {
          vUv = uv; vW = aWall;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vDist = length(mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uNight, uTime, uN;
        uniform sampler2D uAds;
        varying vec2 vUv; varying vec4 vW; varying float vDist;
        vec3 hsv(float h, float s, float v) { vec3 k = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); return v * mix(vec3(1.0), k, s); }
        vec3 poster(float idx, vec2 uv, float aspect) {
          // fit the 1:3 poster to the wall: cover by height, centre horizontally, mirror-tile the rest
          float pw = aspect * 3.0;                       // wall width in poster widths
          float x = (uv.x - 0.5) * pw + 0.5;
          float inside = step(0.0, x) * step(x, 1.0);
          vec3 c = texture2D(uAds, vec2((idx + clamp(x, 0.002, 0.998)) / uN, uv.y)).rgb;
          vec3 edge = texture2D(uAds, vec2((idx + 0.5) / uN, 0.98)).rgb;
          return mix(edge * (0.6 + 0.4 * sin(uv.y * 40.0 + uTime)), c, inside);
        }
        vec3 interlude(vec2 uv, float r, float t) {
          // generative: kapok-red and lime ribbons flowing up the tower
          float a = sin(uv.y * 9.0 - t * 0.9 + sin(uv.x * 6.0 + t * 0.5 + r * 10.0) * 1.2);
          float b = sin(uv.y * 23.0 + t * 1.7 + uv.x * 4.0);
          vec3 c1 = hsv(fract(0.98 + r * 0.2 + uv.y * 0.1), 0.85, 1.0);
          vec3 c2 = vec3(0.78, 0.94, 0.24);
          return mix(c1, c2, smoothstep(-0.2, 0.9, a)) * (0.2 + 0.45 * smoothstep(0.2, 1.0, b * 0.5 + 0.5));
        }
        void main() {
          float r = vW.z, aspect = vW.y;
          float period = 11.0;
          float tt = uTime + r * 97.0;
          float slot = floor(tt / period), ph = fract(tt / period);
          float idx = mod(vW.x + slot, uN);
          vec3 col = mod(slot + floor(r * 3.0), 4.0) < 0.5 ? interlude(vUv, r, tt) : poster(idx, vUv, aspect);
          // wipe in from the top at every change
          float wipe = smoothstep(0.0, 0.08, ph);
          col *= mix(0.15, 1.0, step(1.0 - wipe, vUv.y) + step(0.999, wipe));
          // LED pitch: dots near the camera, averaged far away
          vec2 px = vUv * vec2(vW.w, vW.w / aspect) / 0.45;
          vec2 fp = fract(px) - 0.5;
          float dotm = smoothstep(0.5, 0.25, length(fp));
          float near = clamp(1.4 - max(fwidth(px.x), fwidth(px.y)) * 1.2, 0.0, 1.0);
          col *= mix(1.0, dotm * 1.8, near);
          float k = mix(0.8, 1.8, uNight) * exp(-vDist * 0.00018);
          gl_FragColor = vec4(col * k, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = `media-walls (${this.count})`;
    this.mesh.frustumCulled = false;
  }
}

// ------------------------------------------------------------------------------------------ shop signs
const SHOPS = ['陈记肠粉', '老西关烧腊', '阿妹奶茶', '24H 便利', '凉茶铺', '全记云吞面', '牛杂', '电竞网咖', '修手机', '大药房',
  '隆江猪脚饭', '潮汕牛肉火锅', '煲仔饭', '糖水铺', '美甲', '足浴', '五金', '茶餐厅', '士多', '打印复印', '快递驿站', '准时达骑手站',
  '水果', '粥粉面', '烧鹅濑粉', '双皮奶', '腊味', '眼镜', '房产中介', '彩票', '桂林米粉', '沙县小吃', '兰州拉面', '炸鸡汉堡',
  '咖啡', '烘焙', '按摩', '理发', '宠物', '花店', '奶茶研究所', '小龙虾', '烧烤', '海鲜酒家', '点心', '麻辣烫', '螺蛳粉', '书店',
  '文具', '母婴', '药材', '茶叶', '服装', '鞋店', '手机壳', '数码', '钥匙', '洗衣', '快餐', '砂锅粥', '鸡煲', '凉皮', '豆浆油条', '深夜食堂'];
const SIGN_COLS = 4, SIGN_ROWS = 16;

function drawSigns(): THREE.CanvasTexture {
  const cw = 256, ch = 64;
  const cv = document.createElement('canvas');
  cv.width = cw * SIGN_COLS; cv.height = ch * SIGN_ROWS;
  const g = cv.getContext('2d')!;
  const light = [['#ffffff', '#c8102e'], ['#ffd400', '#1a1a1a'], ['#c8102e', '#ffffff'], ['#0a4da2', '#ffffff'], ['#1e8c45', '#ffffff'], ['#fff3d6', '#8a2b0a']];
  const neon = ['#ff3ea5', '#35f2ff', '#ffb13b', '#8dff4a', '#b77dff', '#ff5252'];
  for (let i = 0; i < SIGN_COLS * SIGN_ROWS; i++) {
    const x0 = (i % SIGN_COLS) * cw, y0 = Math.floor(i / SIGN_COLS) * ch;
    const name = SHOPS[i % SHOPS.length];
    const style = i % 3;               // 0 lightbox, 1 neon, 2 lightbox with a stripe
    g.save();
    g.beginPath(); g.rect(x0, y0, cw, ch); g.clip();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const size = name.length > 5 ? 34 : 42;
    if (style === 1) {
      g.fillStyle = '#0c0c10'; g.fillRect(x0, y0, cw, ch);
      const c = neon[i % neon.length];
      g.font = `800 ${size}px ${FONT}`;
      g.shadowColor = c; g.shadowBlur = 14;
      g.strokeStyle = c; g.lineWidth = 3; g.strokeText(name, x0 + cw / 2, y0 + ch / 2 + 2);
      g.fillStyle = '#ffffff'; g.shadowBlur = 6; g.fillText(name, x0 + cw / 2, y0 + ch / 2 + 2);
      g.shadowBlur = 0; g.strokeStyle = c; g.lineWidth = 2; g.strokeRect(x0 + 5, y0 + 5, cw - 10, ch - 10);
    } else {
      const [bg, fg] = light[i % light.length];
      g.fillStyle = bg; g.fillRect(x0, y0, cw, ch);
      if (style === 2) { g.fillStyle = fg; g.globalAlpha = 0.85; g.fillRect(x0, y0 + ch - 10, cw, 10); g.globalAlpha = 1; }
      g.fillStyle = fg; g.font = `900 ${size}px ${FONT}`;
      g.fillText(name, x0 + cw / 2, y0 + ch / 2 - (style === 2 ? 4 : 0));
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 4; g.strokeRect(x0 + 2, y0 + 2, cw - 4, ch - 4);
    }
    g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class ShopSigns {
  readonly mesh: THREE.InstancedMesh;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(footprints: Footprint[], roads: RoadGraph) {
    // road samples on a 25 m grid: position, half width, direction
    const CELL = 25;
    const grid = new Map<string, { x: number; y: number; hw: number; dx: number; dy: number }[]>();
    for (const e of roads.edges) {
      if (e.bridge || e.hw === 'service' || e.hw.endsWith('_link') || e.hw === 'motorway') continue;
      const p = e.pts;
      for (let i = 0; i < p.length - 1; i++) {
        const dx = p[i + 1][0] - p[i][0], dy = p[i + 1][1] - p[i][1], l = Math.hypot(dx, dy);
        for (let s = 0; s < l; s += 3) {
          const x = p[i][0] + dx * s / l, y = p[i][1] + dy * s / l;
          const k = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push({ x, y, hw: e.w / 2, dx: dx / l, dy: dy / l });
        }
      }
    }
    const nearest = (x: number, y: number) => {
      let best = null as null | { d: number; hw: number; dx: number; dy: number }, bd = Infinity;
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        for (const s of grid.get(`${cx + i},${cy + j}`) ?? []) {
          const d = Math.hypot(s.x - x, s.y - y);
          if (d < bd) { bd = d; best = { d, hw: s.hw, dx: s.dx, dy: s.dy }; }
        }
      }
      return best;
    };
    const mats: THREE.Matrix4[] = [], cells: number[] = [];
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let seed = 1;
    footprints.forEach((f, idx) => {
      if (f.lm || f.z < 5) return;
      const ring = ccw(f.o as P2[]);
      const tall = f.z > 60;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
        if (l < 5) continue;
        const tx = dx / l, ty = dy / l, nx = ty, ny = -tx;
        const mx = (a[0] + b[0]) / 2 + nx * 3, my = (a[1] + b[1]) / 2 + ny * 3;
        const r = nearest(mx, my);
        if (!r || r.d - r.hw > 16 || Math.abs(r.dx * tx + r.dy * ty) < 0.75) continue;
        for (let s = 2.2; s < l - 2.2;) {
          seed++;
          const h = hash(idx * 131 + i * 17 + seed);
          const w = 2.6 + h * 2.2;
          if (s + w > l - 1.5) break;
          if (hash(seed * 3.7) < (tall ? 0.3 : 0.82)) {
            const cxp = a[0] + tx * (s + w / 2) + nx * 0.14, cyp = a[1] + ty * (s + w / 2) + ny * 0.14;
            const z = 3.9 + hash(seed * 1.3) * 0.8;
            const p = fromBlender(cxp, cyp, z);
            // plane faces +Z in its frame; turn it to face the street (outward normal), in three.js axes
            q.setFromAxisAngle(up, Math.atan2(nx, -ny));
            sc.set(w, w / 4, 1);
            mats.push(m4.compose(p, q, sc).clone());
            cells.push(Math.floor(hash(seed * 9.1) * SIGN_COLS * SIGN_ROWS));
          }
          s += w + 1.2 + hash(seed * 5.3) * 5;
        }
      }
    });
    const geo = new THREE.PlaneGeometry(1, 1);
    const cellAttr = new Float32Array(cells.length * 2);
    cells.forEach((c, i) => { cellAttr[i * 2] = (c % SIGN_COLS) / SIGN_COLS; cellAttr[i * 2 + 1] = 1 - (Math.floor(c / SIGN_COLS) + 1) / SIGN_ROWS; });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cellAttr, 2));
    const tex = drawSigns();
    this.mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0.15, roughness: 0.45, metalness: 0 });
    this.mat.onBeforeCompile = (shader) => {
      fogUniforms(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vMapUv = uv * vec2(${(1 / SIGN_COLS).toFixed(5)}, ${(1 / SIGN_ROWS).toFixed(5)}) + aCell;
          vEmissiveMapUv = vMapUv;`);
    };
    this.mat.customProgramCacheKey = () => 'gz-shop-signs';
    this.mesh = new THREE.InstancedMesh(geo, this.mat, mats.length);
    mats.forEach((m, i) => this.mesh.setMatrixAt(i, m));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
    this.mesh.frustumCulled = false;
    this.mesh.name = `shop-signs (${mats.length})`;
    this.mesh.receiveShadow = true;
  }

  update(night: number): void {
    this.mat.emissiveIntensity = THREE.MathUtils.lerp(0.18, 2.6, night);
  }
}

export class NearFuture {
  readonly group = new THREE.Group();
  readonly towers: TowerLights;
  readonly walls: MediaWalls;
  readonly signs: ShopSigns;

  constructor(footprints: Footprint[], roads: RoadGraph) {
    this.group.name = 'near-future';
    this.towers = new TowerLights(footprints);
    this.walls = new MediaWalls(footprints);
    this.signs = new ShopSigns(footprints, roads);
    this.group.add(this.towers.mesh, this.walls.mesh, this.signs.mesh);
  }

  update(night: number): void {
    this.towers.mesh.visible = night > 0.03;
    this.signs.update(night);
  }
}
