import * as THREE from 'three';
import { fromBlender } from '../config';

/**
 * The shop signs round 花城汇's sunken court (gz_huacheng writes the sign boxes into huacheng.json): one canvas atlas,
 * one mesh, one draw call. Shop names are invented (the street names around are real); a few nod to the story -- the
 * platform's own store, the e-woodfish shop from the tower ads, a riders' rest stop. The entrance bay carries the
 * mall's gold lettering instead. Signs are lightboxes: lit by day, brighter after dark (update(night)).
 */
interface Sign { c: number[]; n: number[]; w: number; h: number; entrance: boolean | 'link'; name?: string; sub?: string; bg?: string; fg?: string }

const SHOPS: [string, string, string, string][] = [   // name, small line, background, text
  ['岭南茶居', '早茶 · 点心 · 午市', '#7a1d18', '#f6d48a'],
  ['珠江烧腊', '叉烧 · 烧鹅 · 白切鸡', '#1d1d1d', '#ff8a3d'],
  ['阿婆糖水', '双皮奶 · 杨枝甘露', '#f3e7cf', '#8a2a1e'],
  ['猛火炒饭', 'WOK FIRE', '#d83a1e', '#ffffff'],
  ['叮当便利', '24 小时', '#0b7a4b', '#ffffff'],
  ['小准智选', '准时达官方好物 · 骑手专享价', '#c6f03c', '#10181c'],
  ['云吞面家', '竹升面 · 鲜虾云吞', '#efe2c6', '#2b2b2b'],
  ['天河眼镜', '验光 · 配镜', '#1b3a6b', '#ffffff'],
  ['南国咖啡', 'SOUTH COFFEE', '#2a1a12', '#e9c99a'],
  ['双皮奶研究所', '顺德直送', '#ffffff', '#c0392b'],
  ['潮汕牛肉丸', '手打 · 现煮', '#a8261b', '#ffe9a8'],
  ['功德 +1', '电子木鱼 Pro 体验店', '#120c08', '#ffcc33'],
  ['芝士奶盖', 'CHEESE TEA', '#ffd1dc', '#7a2140'],
  ['老火靓汤', '煲足四个钟', '#4a2a10', '#f2c46d'],
  ['共享充电站', '¥1 / 次 · 小准自动扣款', '#0f2d4d', '#5fd3ff'],
  ['骑手驿站', '准时达 · 饮水 · 充电', '#10181c', '#c6f03c'],
  ['花城书店', 'BOOKS & COFFEE', '#e8e4da', '#24433a'],
  ['广式早茶', '虾饺 · 烧卖 · 肠粉', '#b22a20', '#ffffff'],
  // 花城汇 B1's middle zone (gz_mall): the kind of chains found there, parodied, and a few from the story
  ['每餐乐', '铁板 · 自选 · 简餐', '#1e6b52', '#ffffff'],
  ['春 · 生煎', '上海生煎 · 小馄饨', '#ffffff', '#1f6f3f'],
  ['海映都会', 'CITY PARQUE', '#0f0f10', '#ff3b3b'],
  ['乐吧扎', '欢乐集市 · 进口零食', '#c8102e', '#ffffff'],
  ['码 · 上岸', '程序员减压咖啡', '#1b1b2f', '#7ef9ff'],
  ['手机维修', '换屏 · 贴膜 · 恢复数据', '#ffffff', '#d71920'],
  ['准时达体验店', '骑手装备 · 头盔 · 雨衣', '#10181c', '#c6f03c'],
  ['湘辣辣', '剁椒鱼头 · 小炒肉', '#e23b2e', '#fff1c1'],
  ['探鱼家', '烤鱼 · 夜宵', '#141414', '#ffb000'],
  ['优衣裤', '基本款 · 第二件半价', '#d8191e', '#ffffff'],
  ['蜜糖冰城', '你爱我 我爱你 · 一杯 ¥4', '#e60012', '#ffffff'],
  ['面包新说', '肉松小贝 · 现烤', '#4a2d1a', '#f4e1c1'],
  ['花城药房', '24 小时 · 医保', '#0a7c3e', '#ffffff'],
  ['大鸭梨子', '烤鸭 · 家常', '#7a2a12', '#ffd86b'],
  ['狗的天空之城', '寄给未来的明信片', '#e9e3d5', '#3c5b6f'],
  ['小准AI 按摩椅', '10 分钟 ¥15 · 扫码即用', '#0f2d4d', '#9bd8ff'],
];

const SLOT_W = 1024, SLOT_H = 144, COLS = 2;

export class HuachengSigns {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(signs: Sign[]) {
    const rows = Math.ceil(signs.length / COLS);
    const cv = document.createElement('canvas');
    cv.width = SLOT_W * COLS; cv.height = SLOT_H * rows;
    const g = cv.getContext('2d')!;
    const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
    let shop = 0;
    signs.forEach((s, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const ox = col * SLOT_W, oy = row * SLOT_H;
      if (s.entrance === 'link') this.drawEntrance(g, ox, oy, '中区', 'CENTRAL ZONE · 往 APM');
      else if (s.entrance) this.drawEntrance(g, ox, oy);
      else if (s.name) this.drawShop(g, ox, oy, [s.name, s.sub ?? '', s.bg ?? '#ffffff', s.fg ?? '#1d1d1d']);   // the kiosks
      else this.drawShop(g, ox, oy, SHOPS[shop++ % SHOPS.length]);
      // the quad on the box face (Blender: centre c, out of the wall n, w x h)
      const [cx, cy, cz] = s.c, [nx, ny] = s.n;
      const tx = -ny, ty = nx;                       // along the wall, left to right as seen from the court (facing -n)
      const base = pos.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const p = fromBlender(cx + tx * a * s.w / 2 + nx * 0.01, cy + ty * a * s.w / 2 + ny * 0.01, cz + b * s.h / 2);
        pos.push(p.x, p.y, p.z);
        const n = fromBlender(nx, ny, 0);
        nor.push(n.x, n.y, n.z);
        uv.push((ox + (a + 1) / 2 * SLOT_W) / cv.width, 1 - (oy + (1 - (b + 1) / 2) * SLOT_H) / cv.height);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    this.mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.35, metalness: 0 });
    this.mat.name = 'huacheng signs';
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.name = 'huacheng signs';
    this.mesh.frustumCulled = true;
  }

  /** lightboxes: a steady glow by day, bright at night */
  update(night: number): void { this.mat.emissiveIntensity = 0.45 + 1.4 * night; }

  private drawShop(g: CanvasRenderingContext2D, ox: number, oy: number, s: [string, string, string, string]): void {
    const [name, sub, bg, fg] = s;
    g.fillStyle = bg; g.fillRect(ox, oy, SLOT_W, SLOT_H);
    // a thin inner rule and a round logo disc on the left
    g.strokeStyle = fg; g.globalAlpha = 0.35; g.lineWidth = 3; g.strokeRect(ox + 8, oy + 8, SLOT_W - 16, SLOT_H - 16); g.globalAlpha = 1;
    g.fillStyle = fg; g.beginPath(); g.arc(ox + 78, oy + SLOT_H / 2, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = bg; g.font = '900 54px "PingFang SC", "Hiragino Sans GB", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(name[0], ox + 78, oy + SLOT_H / 2 + 2);
    g.fillStyle = fg; g.textAlign = 'left';
    g.font = '800 70px "PingFang SC", "Hiragino Sans GB", sans-serif';
    g.fillText(name, ox + 150, oy + 60, SLOT_W - 180);
    g.font = '500 28px "PingFang SC", "Hiragino Sans GB", sans-serif';
    g.globalAlpha = 0.85; g.fillText(sub, ox + 154, oy + 114, SLOT_W - 190); g.globalAlpha = 1;
  }

  private drawEntrance(g: CanvasRenderingContext2D, ox: number, oy: number, zone = '', zoneEn = ''): void {
    // bright gold letters on a dark bronze band (gold on the beige stone read as nothing from the floor)
    const bg = g.createLinearGradient(0, oy, 0, oy + SLOT_H);
    bg.addColorStop(0, '#3a2c1e'); bg.addColorStop(1, '#1d150e');
    g.fillStyle = bg; g.fillRect(ox, oy, SLOT_W, SLOT_H);
    g.strokeStyle = '#b8893a'; g.lineWidth = 4; g.strokeRect(ox + 6, oy + 6, SLOT_W - 12, SLOT_H - 12);
    const grad = g.createLinearGradient(0, oy, 0, oy + SLOT_H);
    grad.addColorStop(0, '#fff6cf'); grad.addColorStop(0.45, '#ffd56a'); grad.addColorStop(1, '#c48a22');
    g.fillStyle = grad;
    const fx = ox + 300, fy = oy + 62;
    for (let k = 0; k < 6; k++) {                     // six petals
      const a = k * Math.PI / 3;
      g.beginPath(); g.ellipse(fx + Math.cos(a) * 26, fy + Math.sin(a) * 26, 24, 12, a, 0, Math.PI * 2); g.fill();
    }
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = '900 86px "PingFang SC", "Hiragino Sans GB", sans-serif';
    g.fillText('花城汇', ox + 350, oy + 58);
    g.font = '700 26px "Avenir Next", "Helvetica Neue", sans-serif';
    g.fillText('MALL OF THE WORLD', ox + 356, oy + 118);
    if (zone) {                                       // the link into the middle zone: the zone's name after a rule
      g.fillRect(ox + 640, oy + 26, 3, SLOT_H - 52);
      g.font = '900 72px "PingFang SC", "Hiragino Sans GB", sans-serif';
      g.fillText(zone, ox + 668, oy + 60);
      g.font = '700 22px "Avenir Next", "PingFang SC", sans-serif';
      g.fillText(zoneEn, ox + 670, oy + 116, SLOT_W - 690);
    }
  }
}
