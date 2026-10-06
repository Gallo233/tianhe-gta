import * as THREE from 'three';
import { fromBlender } from '../config';
import type { Apm, ApmStation } from './Apm';

/**
 * Wayfinding in the APM stations, written on one 2048 canvas and laid as backlit quads (one draw call):
 *
 *   screen-door headers   over each of the four doors on both sides: station name, "next station", direction
 *                         (the east track runs north towards 林和西, the west one south to 广州塔)
 *   column names          the station name down the platform columns, on the faces towards the tracks (curved
 *                         round the round columns), as in the photographs of 海心沙 and 花城大道
 *   concourse hangers     over the two gate lines and the stair head: 进站 / 出站, 往站台, the exits at that end
 *   passage mouths        where each passage meets the concourse: "A 出口" facing in, "往站厅" facing the passage
 *   platform screens      on the middle column: the next train in each direction
 *   trackside posters     the 6 x 2.1 m lightboxes on the walls across the tracks: the city's fictional brands
 *                         (world/NearFuture's media-wall campaigns) and two public notices, brighter (backlit)
 *
 * Sizes and positions follow the station template (gz_apm_station.py): screen-door line at +-island_v, header box
 * from PSD_TOP to PSD_TOP + 0.7, columns at u = -17, 5.5, 13.5, hanging signs 4.6 x 0.5 m.
 */
const PSD_DOORS = [-9.7, -3.3, 3.3, 9.7];
const PSD_TOP_ABOVE = 2.55;
const COLS_U = [-17.0, 5.5, 13.5];
const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

interface Poster { bg: [string, string]; title: string; sub: string; accent: string; tag: string; ink?: string; notice?: boolean }
/** the city's fictional campaigns (same brands as world/NearFuture's media walls) and two public notices */
const POSTERS: Poster[] = [
  { bg: ['#1b1d1f', '#2d3a12'], title: '准时达', sub: '30分钟必达\n超时？扣的是你的分', accent: '#c6f03c', tag: 'ZHUNSHIDA · 骑手招募中' },
  { bg: ['#07122e', '#1a3a8a'], title: '小准AI', sub: '为您优化一切\n包括您', accent: '#7ee0ff', tag: 'XIAOZHUN · AI' },
  { bg: ['#2a0633', '#c2185b'], title: '赞赞直播', sub: '流量即正义\n今晚你就是热搜', accent: '#ffd1f0', tag: 'ZANZAN LIVE' },
  { bg: ['#0b0f14', '#0f4f4a'], title: '盘古智能', sub: '红绿灯会员 ¥9.9/月\n一路绿灯', accent: '#39f5c1', tag: 'PANGU' },
  { bg: ['#2b1b0a', '#8a4b12'], title: '早茶自由', sub: '虾饺烧卖\n12期免息', accent: '#ffcf70', tag: 'DIM SUM PAY' },
  { bg: ['#101010', '#3c3c3c'], title: '天河云居', sub: '月供只要\n一辈子', accent: '#ffffff', tag: 'CLOUD HOME' },
  { bg: ['#1a0000', '#b3001b'], title: '功德+1', sub: '电子木鱼 Pro\n每秒敲 60 下', accent: '#ffe08a', tag: 'MERIT PRO' },
  { bg: ['#eef3f7', '#cfe0ee'], title: '先下后上', sub: '有序排队 文明乘车\n请勿倚靠屏蔽门', accent: '#1f6fb2', ink: '#24303a', tag: '广州地铁 · APM 线', notice: true },
  { bg: ['#03201a', '#0a8a5f'], title: '4.99', sub: '全城最高分骑手\n城市的心跳', accent: '#c6f03c', tag: 'ZHUNSHIDA RIDERS' },
  { bg: ['#101a3a', '#3a1a5a'], title: '珠江夜游', sub: '广州塔 · 海心沙 · 二沙岛\n19:30 起 每半小时一班', accent: '#ffb3e6', tag: 'PEARL RIVER NIGHT CRUISE' },
];
const BLUE = '#1f6fb2';

type Rect = { x: number; y: number; w: number; h: number; a: number };

/** One canvas, shelf-packed left to right, top to bottom. */
class Atlas {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  private cx = 0;
  private cy = 0;
  private rowH = 0;
  constructor(w: number, h: number, readonly index: number) {
    this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d')!;
  }
  alloc(w: number, h: number): Rect {
    if (this.cx + w > this.canvas.width) { this.cx = 0; this.cy += this.rowH + 4; this.rowH = 0; }
    if (this.cy + h > this.canvas.height) console.warn('[apm signs] atlas', this.index, 'full');
    const r = { x: this.cx, y: this.cy, w, h, a: this.index };
    this.cx += w + 4; this.rowH = Math.max(this.rowH, h);
    return r;
  }
}

export class ApmSigns {
  readonly mesh: THREE.Mesh;
  // three canvases: screen-door headers / column names + platform screens / hanging signs (deduplicated)
  private readonly atlases = [new Atlas(2048, 1536, 0), new Atlas(2048, 1024, 1), new Atlas(2048, 2048, 2), new Atlas(2048, 2048, 3)];
  private g: CanvasRenderingContext2D = this.atlases[0].g;
  private readonly hangers = new Map<string, Rect>();
  private readonly pos: number[] = [];
  private readonly uv: number[] = [];
  private readonly nor: number[] = [];
  private readonly idx: number[][] = [[], [], [], []];

  constructor(private readonly apm: Apm) {
    const sts = apm.stations;
    const byU = (a: ApmStation, b: ApmStation) => this.order(a) - this.order(b);
    const ordered = [...sts].sort(byU);           // south -> north
    const exitsAt = this.exitEnds();
    for (let i = 0; i < ordered.length; i++) {
      const st = ordered[i];
      const north = ordered[i + 1] ?? null, south = ordered[i - 1] ?? null;
      // screen-door headers, one design per side
      for (const side of [1, -1] as const) {                 // +1: east track (northbound), -1: west (southbound)
        const nextSt = side === 1 ? north : south;
        const terminus = (side === 1 && st.terminus === 'north') || (side === -1 && st.terminus === 'south') || !nextSt;
        const r = this.header(st, nextSt, side, terminus);
        const x = side * (apm.F.island_v - 0.105);
        for (const du of PSD_DOORS) {
          this.quadX(st, x, du - 1.3, du + 1.3, apm.L.platform + PSD_TOP_ABOVE + 0.05, apm.L.platform + PSD_TOP_ABOVE + 0.66, r, -side);
        }
      }
      // column names
      const cr = this.columnName(st);
      for (const u of COLS_U) {
        for (const side of [1, -1] as const) {
          if (st.style.includes('square')) this.quadX(st, side * 0.465, u - 0.3, u + 0.3, apm.L.platform + 0.95, apm.L.platform + 3.15, cr, side);
          else this.curvedX(st, u, side, 0.462, 0.62, apm.L.platform + 0.95, apm.L.platform + 3.15, cr);
        }
      }
      // platform screens on the middle column (faces +-0.69 in x, 1.0 x 0.56 m)
      for (const side of [1, -1] as const) {
        const nextSt = side === 1 ? north : south;
        const r = this.pids(nextSt, side, (side === 1 && st.terminus === 'north') || (side === -1 && st.terminus === 'south'));
        this.quadX(st, side * 0.705, COLS_U[1] - 0.48, COLS_U[1] + 0.48, apm.L.platform + 2.35, apm.L.platform + 2.86, r, side);
      }
      // concourse hangers: 4.6 x 0.5 frames at u = paid[1] + 0.8, paid[0] - 0.8, stair_top + 1.2 (faces at u +- 0.09)
      const zc = apm.L.concourse + apm.L.concourse_h - 0.55;
      const [p0, p1] = apm.F.paid_u;
      const ex = exitsAt.get(st.key) ?? { north: [], south: [] };
      // [u, read by people south of the sign (facing -u), read by people north of it (facing +u)]
      const pairs: [number, Rect, Rect][] = [
        [p1 + 0.8, this.hanger('出站', 'Exit', ex.north.length ? `出口 ${ex.north.join(' ')}` : '出口 Exit', '↑'), this.hanger('进站', 'Entrance', '往站台 To Platforms', '↓')],
        [p0 - 0.8, this.hanger('进站', 'Entrance', '往站台 To Platforms', '↓'), this.hanger('出站', 'Exit', ex.south.length ? `出口 ${ex.south.join(' ')}` : '出口 Exit', '↑')],
        [apm.F.stair_top + 1.2, this.hanger('出站', 'Exit', '闸机 Gates', '↑'), this.hanger('往站台', 'To Platforms', this.dirText(st), '↓')],
      ];
      for (const [u, faceMinus, facePlus] of pairs) {
        // a sign read by someone coming from +u faces +u; from -u faces -u
        this.quadU(st, u - 0.095, -2.2, 2.2, zc - 0.2, zc + 0.2, faceMinus, -1);
        this.quadU(st, u + 0.095, -2.2, 2.2, zc - 0.2, zc + 0.2, facePlus, 1);
      }
    }
    this.passageSigns();
    this.trackAds(ordered);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const all: number[] = [];
    const mats: THREE.Material[] = [];
    this.atlases.forEach((at, i) => {
      geo.addGroup(all.length, this.idx[i].length, i);
      all.push(...this.idx[i]);
      const tex = new THREE.CanvasTexture(at.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      const k = i === 3 ? 1.8 : 0.55;                      // the posters are lightboxes (seen through the screen doors)
      mats.push(new THREE.MeshStandardMaterial({
        name: 'apm signs ' + i, map: tex, emissiveMap: tex, emissive: new THREE.Color(k, k, k), roughness: 0.4,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
      }));
    });
    geo.setIndex(all);
    geo.computeBoundingSphere();
    this.mesh = new THREE.Mesh(geo, mats);
    this.mesh.name = 'apm signs';
  }

  private order(st: ApmStation): number { return st.y; }

  /** Posters on the trackside lightboxes (template x = +-(BOX_V - 0.05), u = -12 / 0 / 12, 6.0 x 2.1 m at PZ + 1.6). */
  private trackAds(ordered: ApmStation[]): void {
    const posters = POSTERS.map((p) => this.poster(p));
    const bv = this.apm.F.box_v, pz = this.apm.L.platform;
    ordered.forEach((st, i) => {
      for (const side of [1, -1] as const) {
        [-12, 0, 12].forEach((u, k) => {
          const r = posters[(i * 5 + k * 3 + (side > 0 ? 0 : 7)) % posters.length];
          this.quadX(st, side * (bv - 0.075), u - 2.98, u + 2.98, pz + 0.57, pz + 2.63, r, -side);
        });
      }
    });
  }

  private poster(p: Poster): Rect {
    const r = this.alloc(3, 1000, 350);
    const g = this.g, { x, y, w, h } = r;
    const grad = g.createLinearGradient(x, y, x + w, y + h);
    grad.addColorStop(0, p.bg[0]); grad.addColorStop(1, p.bg[1]);
    g.fillStyle = grad; g.fillRect(x, y, w, h);
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    // the campaign graphic on the right: rings and a band of bars in the accent colour
    g.strokeStyle = p.accent; g.lineWidth = 14; g.globalAlpha = 0.85;
    g.beginPath(); g.arc(x + w * 0.8, y + h * 0.5, h * 0.33, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.3; g.lineWidth = 8;
    g.beginPath(); g.arc(x + w * 0.8, y + h * 0.5, h * 0.46, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 0.16; g.fillStyle = p.accent;
    for (let k = 0; k < 14; k++) g.fillRect(x + w * 0.55 + k * 34, y + h * 0.84, 16, h * 0.16);
    g.restore();
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    g.fillStyle = p.accent;
    g.font = `900 ${p.title.length > 4 ? 92 : 118}px ${FONT}`;
    g.fillText(p.title, x + 48, y + 150);
    g.fillStyle = p.ink ?? '#ffffff';
    g.font = `700 40px ${FONT}`;
    p.sub.split('\n').forEach((line, k) => g.fillText(line, x + 52, y + 222 + k * 52));
    g.font = `600 20px ${FONT}`;
    g.globalAlpha = 0.75;
    g.fillText(p.tag, x + 52, y + h - 22);
    g.textAlign = 'right';
    g.fillText(p.notice ? '公益广告' : '广告', x + w - 24, y + 34);
    g.globalAlpha = 1;
    return r;
  }

  private dirText(st: ApmStation): string {
    if (st.terminus === 'south') return '往 林和西方向';
    if (st.terminus === 'north') return '往 广州塔方向';
    return '往 广州塔 / 林和西方向';
  }

  /** Which exit letters each station's passages bring in at the north (u > 0) and south ends. */
  private exitEnds(): Map<string, { north: string[]; south: string[] }> {
    const out = new Map<string, { north: string[]; south: string[] }>();
    for (const [eid, pl] of Object.entries(this.apm.data.passages)) {
      const e = this.apm.exitInfo?.(eid);
      if (!e) continue;
      const st = this.apm.stations.find((s) => s.name === e.station);
      if (!st) continue;
      const end = pl[pl.length - 1];
      const [u] = this.apm.toFrame(st, end[0], end[1]);
      const rec = out.get(st.key) ?? { north: [], south: [] };
      (u > 0 ? rec.north : rec.south).push(e.ref);
      out.set(st.key, rec);
    }
    for (const r of out.values()) { r.north.sort(); r.south.sort(); }
    return out;
  }

  // ------------------------------------------------------------------ atlas drawing
  private alloc(atlas: number, w: number, h: number): Rect {
    this.g = this.atlases[atlas].g;
    return this.atlases[atlas].alloc(w, h);
  }

  private header(st: ApmStation, next: ApmStation | null, side: number, terminus: boolean): Rect {
    const r = this.alloc(0, 1020, 240);
    const g = this.g;
    g.fillStyle = '#f4f6f8'; g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = BLUE; g.fillRect(r.x, r.y + r.h - 22, r.w, 22);
    g.fillStyle = '#1b2a36'; g.textBaseline = 'alphabetic'; g.textAlign = 'left';
    g.font = `700 86px ${FONT}`; g.fillText(st.name, r.x + 40, r.y + 118);
    g.font = `500 32px ${FONT}`; g.fillText(st.en, r.x + 44, r.y + 172);
    // right: next station and direction
    g.textAlign = 'right';
    g.fillStyle = '#4a5864'; g.font = `500 30px ${FONT}`;
    g.fillText(terminus ? '终点站 Terminus' : '下一站 Next', r.x + r.w - 40, r.y + 70);
    if (next && !terminus) {
      g.fillStyle = '#1b2a36'; g.font = `700 58px ${FONT}`; g.fillText(next.name, r.x + r.w - 40, r.y + 136);
      g.fillStyle = '#4a5864'; g.font = `500 26px ${FONT}`; g.fillText(next.en, r.x + r.w - 40, r.y + 174);
    }
    // APM badge and direction
    g.textAlign = 'center';
    g.fillStyle = '#00a8e1'; g.beginPath(); g.roundRect(r.x + 470, r.y + 40, 120, 56, 10); g.fill();
    g.fillStyle = '#fff'; g.font = `800 34px ${FONT}`; g.fillText('APM', r.x + 530, r.y + 80);
    g.fillStyle = '#1b2a36'; g.font = `600 30px ${FONT}`;
    g.fillText(side === 1 ? '往 林和西方向 →' : '← 往 广州塔方向', r.x + 530, r.y + 148);
    g.textAlign = 'left';
    return r;
  }

  private columnName(st: ApmStation): Rect {
    const r = this.alloc(1, 170, 600);
    const g = this.g;
    const style = st.style;
    const bg = style === 'blue_square' ? '#6f9bd6' : style === 'cream_round' ? '#e6dcc4' : '#eceeef';
    g.fillStyle = bg; g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#1b1c1e'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const chars = [...st.name];
    const step = Math.min(150, 560 / chars.length);
    g.font = `600 ${Math.round(step * 0.82)}px ${FONT}`;
    chars.forEach((ch, i) => g.fillText(ch, r.x + r.w / 2, r.y + 20 + step * (i + 0.5)));
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    return r;
  }

  private pids(next: ApmStation | null, side: number, terminus: boolean): Rect {
    const r = this.alloc(1, 390, 200);
    const g = this.g;
    g.fillStyle = '#0c1620'; g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#ffb347'; g.font = `600 26px ${FONT}`; g.fillText(side === 1 ? '往 林和西方向' : '往 广州塔方向', r.x + 20, r.y + 42);
    g.fillStyle = '#e8f2ff'; g.font = `700 38px ${FONT}`;
    g.fillText(terminus ? '本站为终点站' : '列车即将进站', r.x + 20, r.y + 100);
    g.fillStyle = '#9fb3c6'; g.font = `500 23px ${FONT}`;
    g.fillText(terminus ? '请勿上车 Not in service' : `下一站 ${next ? next.name : ''}`, r.x + 20, r.y + 142);
    g.fillStyle = '#29d17a'; g.fillRect(r.x + 20, r.y + 168, 110, 9);
    return r;
  }

  private hanger(big: string, en: string, line: string, arrow: string): Rect {
    const key = [big, en, line, arrow].join('|');
    const hit = this.hangers.get(key);
    if (hit) return hit;
    const r = this.alloc(2, 1020, 96);
    this.hangers.set(key, r);
    const g = this.g;
    g.fillStyle = '#1d2227'; g.fillRect(r.x, r.y, r.w, r.h);
    g.fillStyle = '#ffd24a'; g.font = `800 60px ${FONT}`; g.textAlign = 'center';
    g.fillText(arrow, r.x + 56, r.y + 72);
    g.fillStyle = '#fff'; g.textAlign = 'left';
    g.font = `700 50px ${FONT}`; g.fillText(big, r.x + 110, r.y + 64);
    const bw = g.measureText(big).width;
    g.fillStyle = '#b8c2cc'; g.font = `500 26px ${FONT}`; g.fillText(en, r.x + 124 + bw, r.y + 64);
    g.fillStyle = '#fff'; g.font = `600 40px ${FONT}`; g.textAlign = 'right';
    g.fillText(line, r.x + r.w - 30, r.y + 64);
    g.textAlign = 'left';
    return r;
  }

  private passageSigns(): void {
    const apm = this.apm;
    const zc = apm.L.concourse + apm.L.concourse_h - 0.45;
    for (const [eid, pl] of Object.entries(apm.data.passages)) {
      const e = apm.exitInfo?.(eid);
      if (!e) continue;
      const st = apm.stations.find((s) => s.name === e.station);
      if (!st) continue;
      // where the centre line enters the concourse box
      let mouth: [number, number, number, number] | null = null;
      for (let i = pl.length - 1; i > 0; i--) {
        const [ua, va] = apm.toFrame(st, pl[i - 1][0], pl[i - 1][1]);
        const [ub, vb] = apm.toFrame(st, pl[i][0], pl[i][1]);
        const inA = Math.abs(ua) < apm.F.box_u && Math.abs(va) < apm.F.conc_v;
        const inB = Math.abs(ub) < apm.F.box_u && Math.abs(vb) < apm.F.conc_v;
        if (!inA && inB) {
          // bisect for the crossing
          let lo = 0, hi = 1;
          for (let k = 0; k < 20; k++) {
            const m = (lo + hi) / 2;
            const u = ua + (ub - ua) * m, v = va + (vb - va) * m;
            if (Math.abs(u) < apm.F.box_u && Math.abs(v) < apm.F.conc_v) hi = m; else lo = m;
          }
          const x = pl[i - 1][0] + (pl[i][0] - pl[i - 1][0]) * hi, y = pl[i - 1][1] + (pl[i][1] - pl[i - 1][1]) * hi;
          const L = Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]) || 1;
          mouth = [x, y, (pl[i][0] - pl[i - 1][0]) / L, (pl[i][1] - pl[i - 1][1]) / L];
          break;
        }
      }
      if (!mouth) continue;
      const [mx, my, dx, dy] = mouth;
      const inR = this.hanger(`${e.ref} 出口`, `Exit ${e.ref}`, '往地面 To Street', '↑');
      const outR = this.hanger('往站厅', 'To Concourse', `${st.name}站`, '↑');
      // dir points from the passage into the concourse: "A 出口" faces the concourse (+dir), "往站厅" the passage
      const c = [mx + dx * 1.0, my + dy * 1.0];
      this.quadWorld(c[0] + dx * 0.06, c[1] + dy * 0.06, dx, dy, 1.9, zc - 0.17, zc + 0.17, inR, 1);
      this.quadWorld(c[0] - dx * 0.06, c[1] - dy * 0.06, dx, dy, 1.9, zc - 0.17, zc + 0.17, outR, -1);
    }
  }

  // ------------------------------------------------------------------ quads (Blender coordinates)
  private push(corners: THREE.Vector3[], r: Rect, normal: THREE.Vector3): void {
    const W = this.atlases[r.a].canvas.width, H = this.atlases[r.a].canvas.height;
    const n = this.pos.length / 3;
    const u0 = (r.x + 1) / W, u1 = (r.x + r.w - 1) / W, v0 = 1 - (r.y + r.h - 1) / H, v1 = 1 - (r.y + 1) / H;
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    corners.forEach((c, i) => {
      const w = fromBlender(c.x, c.y, c.z);
      this.pos.push(w.x, w.y, w.z);
      this.uv.push(uvs[i][0], uvs[i][1]);
      this.nor.push(normal.x, normal.z, -normal.y);
    });
    this.idx[r.a].push(n, n + 1, n + 2, n, n + 2, n + 3);
  }

  /** A quad in the plane x = const of the station template (x = -v), spanning u0..u1, facing +x (face = 1) or -x. */
  private quadX(st: ApmStation, x: number, u0: number, u1: number, z0: number, z1: number, r: Rect, face: number): void {
    const P = (u: number, z: number) => this.apm.fromFrame(st, u, -x, z);
    // viewed from +x looking west, north (+u) is on the right: the text starts at u0; from -x it starts at u1
    const [ul, ur] = face > 0 ? [u0, u1] : [u1, u0];
    const n = this.apm.fromFrame(st, 0, -face, 0).sub(this.apm.fromFrame(st, 0, 0, 0)).normalize();
    this.push([P(ul, z0), P(ur, z0), P(ur, z1), P(ul, z1)], r, n);
  }

  /** A quad in a plane u = const, spanning x0..x1 (template x), facing +u (face = 1) or -u. */
  private quadU(st: ApmStation, u: number, x0: number, x1: number, z0: number, z1: number, r: Rect, face: number): void {
    const P = (x: number, z: number) => this.apm.fromFrame(st, u, -x, z);
    // viewed from +u looking -u (south), +x (east) is to the left
    const [xl, xr] = face > 0 ? [x1, x0] : [x0, x1];
    const n = this.apm.fromFrame(st, face, 0, 0).sub(this.apm.fromFrame(st, 0, 0, 0)).normalize();
    this.push([P(xl, z0), P(xr, z0), P(xr, z1), P(xl, z1)], r, n);
  }

  /** Vertical strips round a round column at (u, x = 0): the name on the side facing +x (side 1) or -x. */
  private curvedX(st: ApmStation, u: number, side: number, rad: number, arc: number, z0: number, z1: number, r: Rect): void {
    const N = 6;
    for (let k = 0; k < N; k++) {
      const a0 = -arc / 2 + (arc * k) / N, a1 = -arc / 2 + (arc * (k + 1)) / N;
      // angle measured from the +x (or -x) axis toward +u... text left is +u when viewed from +x
      const pt = (a: number, z: number) => {
        const x = side * rad * Math.cos(a), du = side * rad * Math.sin(a);
        return this.apm.fromFrame(st, u + du, -x, z);
      };
      const sub: Rect = { x: r.x + (r.w * k) / N, y: r.y, w: r.w / N, h: r.h, a: r.a };
      const mid = (a0 + a1) / 2;
      const n = this.apm.fromFrame(st, side * Math.sin(mid), -side * Math.cos(mid), 0).sub(this.apm.fromFrame(st, 0, 0, 0)).normalize();
      this.push([pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1)], sub, n);
    }
  }

  /** A quad at world (x, y) in the vertical plane across direction (dx, dy), width w, facing +dir (face 1) or -dir. */
  private quadWorld(x: number, y: number, dx: number, dy: number, w: number, z0: number, z1: number, r: Rect, face: number): void {
    const nx = -dy, ny = dx;               // left of the direction
    const h = w / 2;
    // viewed from +dir looking back, "left" of the viewer is -n ... choose so the text reads correctly
    const L = new THREE.Vector3(x - nx * h * face, y - ny * h * face, 0), R = new THREE.Vector3(x + nx * h * face, y + ny * h * face, 0);
    const n = new THREE.Vector3(dx * face, dy * face, 0);
    this.push([L.clone().setZ(z0), R.clone().setZ(z0), R.clone().setZ(z1), L.clone().setZ(z1)], r, n);
  }
}
