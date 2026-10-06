import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fromBlender } from '../config';
import { GZ } from './Materials';
import { fogUniforms } from './Sky';

/**
 * Guangzhou Metro street entrances (guangzhou/scripts/gz_metro.py -> assets/tianhe/metro.json): the real OSM
 * entrances, each with a pavilion from the kit (the stairwell is cut into the ground slab in Blender) or, where
 * OSM puts the entrance inside the underground mall, a standing totem.
 *
 *   placements()   kit instances for StreetFurniture (pavilion + totem), Blender coordinates
 *   collision()    the pavilion's collision proxy at every exit, for the static BVH (walk down the stair)
 *   signs          one mesh: every sign face (station band + exit letter, totem logo + letter) from one canvas atlas
 *   at(p)          the exit whose hall (in front of the ticket gates) or totem the player stands at
 *   arrive(exit)   where to put a traveller coming up from the platforms: in the hall, facing the stair
 *
 * Signs are written in the atlas with the station's Chinese and English names and line badges; they light up at
 * night (backlit boxes).
 */
export interface MetroExit {
  id: string; station: string; ref: string; en: string; lines: string[];
  kind: 'pavilion' | 'totem'; x: number; y: number; z: number; yaw: number; indoor?: boolean;
}
interface Layout {
  col_x: number; frames_y: number[]; plat: number[]; plat_z: number; steps_y0: number; roof: number[]; roof_z: number;
  pit: number[]; floor_z: number; stair_end: number; hall: number[]; gates_y: number; lid_z: number; hall_ceil: number; totem: number[];
}
export interface MetroData {
  exits: MetroExit[];
  stations: Record<string, { en: string; lines: string[] }>;
  line_colours: Record<string, string>;
  layout: Layout;
}

type Rect = { x: number; y: number; w: number; h: number };

export class MetroExits {
  readonly exits: MetroExit[];
  readonly L: Layout;
  readonly signs: THREE.Mesh;
  private readonly atlas: THREE.CanvasTexture;

  /** entrances of APM stations: no gates in their halls (the gates are in the concourse), a passage on instead */
  readonly apm: Set<string>;

  constructor(readonly data: MetroData, apmExits: Set<string> = new Set()) {
    this.apm = apmExits;
    this.exits = data.exits;
    this.L = data.layout;
    const { canvas, bands, letters, logo, plates } = this.drawAtlas();
    this.atlas = new THREE.CanvasTexture(canvas);
    this.atlas.colorSpace = THREE.SRGBColorSpace;
    this.atlas.anisotropy = 8;
    this.signs = this.buildSigns(canvas, bands, letters, logo, plates);
  }

  /** Blender local (lx, ly, lz) of an exit -> Blender world. */
  local(e: MetroExit, lx: number, ly: number, lz = 0): [number, number, number] {
    const c = Math.cos(e.yaw), s = Math.sin(e.yaw);
    return [e.x + lx * c - ly * s, e.y + lx * s + ly * c, e.z + lz];
  }

  /** Kit instances (Blender coordinates, yaw about +Z) for StreetFurniture. */
  placements(): { proto: string; x: number; y: number; z: number; yaw: number }[] {
    const out: { proto: string; x: number; y: number; z: number; yaw: number }[] = [];
    for (const e of this.exits) {
      if (e.kind === 'pavilion') {
        // the APM stations' entrances are open wells behind glass (no pavilion: the photographs), the gates below
        out.push({ proto: this.apm.has(e.id) ? 'metro_exit_open' : 'metro_exit', x: e.x, y: e.y, z: e.z, yaw: e.yaw });
        if (!this.apm.has(e.id)) out.push({ proto: 'metro_gates', x: e.x, y: e.y, z: e.z, yaw: e.yaw });
        const [x, y, z] = this.local(e, this.L.totem[0], this.L.totem[1]);
        out.push({ proto: 'metro_totem', x, y, z, yaw: e.yaw });
      } else out.push({ proto: 'metro_totem', x: e.x, y: e.y, z: e.z, yaw: e.yaw });
    }
    return out;
  }

  /** Keep-out test for the rule-placed street furniture (Blender xy): the pavilion, its steps and the apron. */
  blocks(x: number, y: number, margin = 0.6): boolean {
    const [rx0, rx1, , ry1] = this.L.roof;
    for (const e of this.exits) {
      const dx = x - e.x, dy = y - e.y;
      if (dx * dx + dy * dy > 400) continue;
      const c = Math.cos(-e.yaw), s = Math.sin(-e.yaw);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (e.kind === 'pavilion') {
        if (lx > rx0 - margin && lx < rx1 + margin && ly > this.L.steps_y0 - 2.5 - margin && ly < ry1 + margin) return true;
        if (Math.abs(lx - this.L.totem[0]) < 0.6 + margin && Math.abs(ly - this.L.totem[1]) < 0.5 + margin) return true;
      } else if (lx * lx + ly * ly < (0.7 + margin) ** 2) return true;
    }
    return false;
  }

  /** The pavilion collision proxy at every exit (three.js world), for the static collision BVH. */
  collision(kit: GLTF): THREE.Group {
    const g = new THREE.Group();
    g.name = 'metro collision';
    kit.scene.updateMatrixWorld(true);
    const geoOf = (name: string): THREE.BufferGeometry | null => {
      let geo: THREE.BufferGeometry | null = null;
      kit.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && (m.name.endsWith(name) || m.parent?.name.endsWith(name))) geo = m.geometry.clone().applyMatrix4(m.matrixWorld);
      });
      return geo;
    };
    const exitGeo = geoOf('metro_exit_col'), gatesGeo = geoOf('metro_gates_col'), openGeo = geoOf('metro_exit_open_col');
    for (const e of this.exits) {
      if (e.kind !== 'pavilion') continue;
      for (const geo of this.apm.has(e.id) ? [openGeo ?? exitGeo] : [exitGeo, gatesGeo]) {
        if (!geo) continue;
        const m = new THREE.Mesh(geo);
        m.position.copy(fromBlender(e.x, e.y, e.z));
        m.rotation.y = e.yaw;
        g.add(m);
      }
    }
    return g;
  }

  /** Some APM entrance within r metres (three.js position, not far above it): the underground can be seen from here. */
  nearApmExit(p: THREE.Vector3, r: number): boolean {
    for (const e of this.exits) {
      if (!this.apm.has(e.id)) continue;
      if ((e.x - p.x) ** 2 + (e.y + p.z) ** 2 < r * r && p.y < e.z + 12) return true;
    }
    return false;
  }

  /** 0 on the street .. 1 under the pavement: along an entrance's stair tunnel and in its hall (three.js position). */
  underFactor(p: THREE.Vector3): number {
    const bx = p.x, by = -p.z, bz = p.y;
    const [x0, x1] = this.L.pit;
    const knee = this.L.pit[3] + (this.L.lid_z - this.L.hall_ceil) / 0.5;
    let k = 0;
    for (const e of this.exits) {
      if (e.kind !== 'pavilion') continue;
      const dx = bx - e.x, dy = by - e.y;
      if (dx * dx + dy * dy > 900 || bz > e.z) continue;
      const c = Math.cos(-e.yaw), s = Math.sin(-e.yaw);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (lx < x0 - 0.5 || lx > x1 + 0.5 || ly < this.L.pit[2] || ly > this.L.hall[3] + 1) continue;
      k = Math.max(k, THREE.MathUtils.clamp((ly - 1.0) / (knee - 1.0), 0, 1));
    }
    return k;
  }

  /** The exit whose hall (the stair foot up to the gates) or totem the player (three.js position) stands at. */
  at(p: THREE.Vector3): MetroExit | null {
    const bx = p.x, by = -p.z, bz = p.y;
    const [hx0, hx1] = this.L.hall;
    for (const e of this.exits) {
      const dx = bx - e.x, dy = by - e.y;
      if (dx * dx + dy * dy > 400) continue;
      const c = Math.cos(-e.yaw), s = Math.sin(-e.yaw);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (e.kind === 'pavilion') {
        if (this.apm.has(e.id)) continue;
        if (lx > hx0 && lx < hx1 && ly > this.L.stair_end - 0.4 && ly < this.L.gates_y - 0.4 && bz < e.z + this.L.floor_z + 1.2) return e;
      } else if (lx * lx + ly * ly < 2.5 * 2.5 && Math.abs(bz - e.z) < 1.5) return e;
    }
    return null;
  }

  /** Below the pavement inside a pavilion's well, stair tunnel or hall (three.js position): not the river. */
  underground(p: THREE.Vector3): boolean {
    if (p.y > 0.3) return false;
    const [x0, x1, y0, y1] = this.undergroundBox();
    const bx = p.x, by = -p.z;
    for (const e of this.exits) {
      if (e.kind !== 'pavilion') continue;
      const dx = bx - e.x, dy = by - e.y;
      if (dx * dx + dy * dy > 400) continue;
      const c = Math.cos(-e.yaw), s = Math.sin(-e.yaw);
      const lx = dx * c - dy * s, ly = dx * s + dy * c;
      if (lx > x0 && lx < x1 && ly > y0 && ly < y1) return true;
    }
    return false;
  }

  /** Where a traveller arriving at `e` stands (three.js) and the heading that faces the way out. */
  arrive(e: MetroExit): { pos: THREE.Vector3; heading: number } {
    if (e.kind === 'pavilion') {
      const [x, y, z] = this.local(e, -1.3, this.L.gates_y - 1.3, this.L.floor_z + 0.05);
      return { pos: fromBlender(x, y, z), heading: e.yaw };
    }
    const [x, y, z] = this.local(e, 0, -1.4, 0.05);
    return { pos: fromBlender(x, y, z), heading: e.yaw };
  }

  /** The n pavilions nearest a three.js position (for masks that must know where the ground is open). */
  nearest(p: THREE.Vector3, n: number): MetroExit[] {
    const bx = p.x, by = -p.z;
    return this.exits.filter((e) => e.kind === 'pavilion')
      .map((e) => ({ e, d: (e.x - bx) ** 2 + (e.y - by) ** 2 }))
      .sort((a, b) => a.d - b.d).slice(0, n).map((o) => o.e);
  }

  /** Local box (x0, x1, y0, y1) around a pavilion's well, stair tunnel and hall. */
  undergroundBox(): number[] {
    return [this.L.pit[0] - 0.3, this.L.pit[1] + 0.3, this.L.pit[2] - 0.3, this.L.hall[3] + 0.3];
  }

  /** One arrival exit per station (the first pavilion by letter), for the travel menu. */
  stations(): { station: string; en: string; lines: string[]; exit: MetroExit }[] {
    const by = new Map<string, MetroExit>();
    for (const e of this.exits) {
      const cur = by.get(e.station);
      if (!cur || (cur.kind !== 'pavilion' && e.kind === 'pavilion')) by.set(e.station, e);
    }
    return [...by.entries()].map(([station, exit]) => ({ station, en: exit.en, lines: exit.lines, exit }));
  }

  // ---------------------------------------------------------------------------------------------------- atlas
  private drawAtlas(): { canvas: HTMLCanvasElement; bands: Map<string, Rect>; letters: Map<string, Rect>; logo: Rect; plates: Map<string, Rect> } {
    const W = 2048, RH = 128;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = 2048;
    const g = canvas.getContext('2d')!;
    let cx = 0, cy = 0;
    const alloc = (w: number): Rect => {
      if (cx + w > W) { cx = 0; cy += RH; }
      const r = { x: cx, y: cy, w, h: RH };
      cx += w + 4;
      return r;
    };
    const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
    const maroon = '#7a1f1c', red = '#b52a22';
    const logoMark = (x: number, y: number, s: number, col: string) => {
      // a stylised metro mark: a ring with a forked track in it (not the operator's logo)
      g.save(); g.translate(x, y); g.strokeStyle = col; g.lineCap = 'round'; g.lineJoin = 'round';
      g.lineWidth = s * 0.09; g.beginPath(); g.arc(0, 0, s * 0.42, 0, Math.PI * 2); g.stroke();
      g.lineWidth = s * 0.11; g.beginPath();
      g.moveTo(-s * 0.2, -s * 0.2); g.lineTo(0, s * 0.02); g.lineTo(s * 0.2, -s * 0.2);
      g.moveTo(0, s * 0.02); g.lineTo(0, s * 0.26); g.stroke();
      g.restore();
    };
    const bands = new Map<string, Rect>();
    for (const [st, info] of Object.entries(this.data.stations)) {
      if (!this.exits.some((e) => e.station === st)) continue;
      const r = alloc(816);
      bands.set(st, r);
      g.fillStyle = maroon; g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(r.x, r.y + 4, r.w, 3); g.fillRect(r.x, r.y + r.h - 7, r.w, 3);
      logoMark(r.x + 52, r.y + 64, 66, '#fff');
      g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
      g.font = `700 25px ${FONT}`; g.fillText('广州地铁', r.x + 94, r.y + 62);
      g.font = `500 12px ${FONT}`; g.fillText('Guangzhou Metro', r.x + 95, r.y + 82);
      g.textAlign = 'center';
      const cxm = r.x + 430;
      g.font = `700 54px ${FONT}`; g.fillText(`${st}站`, cxm, r.y + 70);
      g.font = `500 21px ${FONT}`; g.fillText(info.en, cxm, r.y + 102);
      g.textAlign = 'left';
      // line badges, right aligned
      let bx = r.x + r.w - 16;
      for (const ln of [...info.lines].reverse()) {
        const w = ln === 'APM' ? 62 : 40;
        bx -= w;
        g.fillStyle = this.data.line_colours[ln] ?? '#888';
        g.beginPath(); g.roundRect(bx, r.y + 42, w, 40, 7); g.fill();
        g.fillStyle = '#fff'; g.font = `800 ${ln === 'APM' ? 20 : 26}px ${FONT}`; g.textAlign = 'center';
        g.fillText(ln, bx + w / 2, r.y + (ln === 'APM' ? 70 : 72));
        g.textAlign = 'left';
        bx -= 8;
      }
    }
    // exit letter panels for the sign band: "A  出入口 Exit"
    const letters = new Map<string, Rect>();
    for (const ref of new Set(this.exits.map((e) => e.ref || '·'))) {
      const r = alloc(272);
      letters.set(ref, r);
      g.fillStyle = maroon; g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = '#f3f1ea'; g.beginPath(); g.roundRect(r.x + 16, r.y + 20, 88, 88, 10); g.fill();
      g.fillStyle = maroon; g.font = `800 ${ref.length > 1 ? 50 : 66}px ${FONT}`; g.textAlign = 'center';
      g.fillText(ref, r.x + 60, r.y + (ref.length > 1 ? 82 : 88));
      g.fillStyle = '#fff'; g.font = `700 34px ${FONT}`; g.fillText('出入口', r.x + 186, r.y + 66);
      g.font = `500 17px ${FONT}`; g.fillText('Entrance / Exit', r.x + 186, r.y + 92);
      g.textAlign = 'left';
    }
    // totem plates: the mark on red, the letter on white
    const logo = alloc(RH);
    g.fillStyle = red; g.fillRect(logo.x, logo.y, logo.w, logo.h);
    logoMark(logo.x + 64, logo.y + 56, 84, '#fff');
    g.fillStyle = '#fff'; g.font = `700 17px ${FONT}`; g.textAlign = 'center'; g.fillText('广州地铁', logo.x + 64, logo.y + 118); g.textAlign = 'left';
    const plates = new Map<string, Rect>();
    for (const ref of letters.keys()) {
      const r = alloc(RH);
      plates.set(ref, r);
      g.fillStyle = '#f3f1ea'; g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = red; g.font = `800 ${ref.length > 1 ? 64 : 88}px ${FONT}`; g.textAlign = 'center';
      g.fillText(ref, r.x + 64, r.y + (ref.length > 1 ? 86 : 96)); g.textAlign = 'left';
    }
    return { canvas, bands, letters, logo, plates };
  }

  private buildSigns(canvas: HTMLCanvasElement, bands: Map<string, Rect>, letters: Map<string, Rect>, logo: Rect, plates: Map<string, Rect>): THREE.Mesh {
    const pos: number[] = [], uv: number[] = [], nor: number[] = [], idx: number[] = [];
    const W = canvas.width, H = canvas.height;
    const L = this.L;
    // quad in an exit's local frame: x from x0 to x1 at depth y, z from z0 to z1, facing -Y (dir = -1) or +Y
    const quad = (e: MetroExit, x0: number, x1: number, y: number, z0: number, z1: number, r: Rect, dir: number, ox = 0, oy = 0) => {
      const n = pos.length / 3;
      const u0 = (r.x + 1) / W, u1 = (r.x + r.w - 1) / W, v0 = 1 - (r.y + r.h - 1) / H, v1 = 1 - (r.y + 1) / H;
      // viewed from the front (dir -1 looks along +Y): left edge x0 when dir < 0, else mirrored
      const corners: [number, number, number, number][] = dir < 0
        ? [[x0, z0, u0, v0], [x1, z0, u1, v0], [x1, z1, u1, v1], [x0, z1, u0, v1]]
        : [[x1, z0, u0, v0], [x0, z0, u1, v0], [x0, z1, u1, v1], [x1, z1, u0, v1]];
      for (const [lx, lz, u, v] of corners) {
        const [bx, by, bz] = this.local(e, lx + ox, y + oy, lz);
        const w = fromBlender(bx, by, bz);
        pos.push(w.x, w.y, w.z); uv.push(u, v);
        const nb = [-Math.sin(e.yaw) * dir, Math.cos(e.yaw) * dir];
        nor.push(nb[0], 0, -nb[1]);
      }
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    };
    for (const e of this.exits) {
      const letter = letters.get(e.ref || '·')!, plate = plates.get(e.ref || '·')!;
      const totem = (ox: number, oy: number) => {
        for (const d of [-1, 1]) {
          quad(e, -0.25, 0.25, d * 0.158, 2.7, 3.2, logo, d, ox, oy);
          quad(e, -0.25, 0.25, d * 0.158, 2.1, 2.6, plate, d, ox, oy);
        }
      };
      if (e.kind === 'pavilion' && this.apm.has(e.id)) totem(L.totem[0], L.totem[1]);     // open well: no sign band
      else if (e.kind === 'pavilion') {
        const y = L.frames_y[0] - 0.06 - 0.09 - 0.006, z1 = L.roof_z - 0.35 - 0.03, z0 = z1 - 0.66;
        const xs = L.col_x - 0.18, xm = xs - (z1 - z0) * (272 / 128);
        quad(e, -xs, xm, y, z0, z1, bands.get(e.station)!, -1);
        quad(e, xm, xs, y, z0, z1, letter, -1);
        totem(L.totem[0], L.totem[1]);
      } else totem(0, 0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      name: 'metro signs', map: this.atlas, emissiveMap: this.atlas, emissive: new THREE.Color(1, 1, 1), roughness: 0.35,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    // backlit: a faint glow by day, bright at night
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= 0.12 + 1.1 * uNight;');
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'metro signs';
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** Day/night for the kit's lit parts (soffit downlights, LED strips, lightboxes, gate arrows): dim by day. */
export function metroKitNight(kit: GLTF): void {
  kit.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!m || !m.name?.includes('metro') || !m.emissive || m.emissive.getHex() === 0 || m.userData.metroNight) return;
    m.userData.metroNight = true;
    const underground = /led strip|map lightbox|ad lightbox|gate arrow/.test(m.name);
    const day = underground ? 1.0 : 0.15;
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n  totalEmissiveRadiance *= ${day.toFixed(2)} + ${(1 - day).toFixed(2)} * uNight;`);
    };
  });
}
