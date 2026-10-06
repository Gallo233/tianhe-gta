import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { fromBlender } from '../config';

/**
 * The Zhujiang New Town APM underground (guangzhou/scripts/gz_apm*.py -> assets/apm/apm.glb + apm.json):
 * 广州塔 - 海心沙 - 大剧院 - 花城大道 - 妇儿中心, each a concourse level with the entrances' passages and an island
 * platform 6 m below, joined by twin single-track box tunnels under the axis and the Pearl River.
 *
 *   group            render meshes: the station template placed at every station (platform, concourse fittings,
 *                    that station's columns), the per-station concourse + passage shells, tunnels, track beds
 *   collisionGroup   what joins the static BVH: the template's collision proxy per station and the shells
 *   under(p)         0 outdoors .. 1 inside a station, passage or tunnel (the environment turns to indoor light)
 *   trackPoint(...)  positions along the running lines for the trains (world/ApmTrains)
 *
 * Coordinates: apm.json is Blender (x east, y north, z up); the template's local frame is +Y along the line
 * (north), +X east, z = world height, so a station instance is fromBlender(x, y, 0) turned by its yaw.
 */
export interface ApmStation {
  key: string; name: string; en: string; x: number; y: number; tx: number; ty: number; yaw: number;
  style: string; terminus: 'north' | 'south' | null; s: number[];
}
export interface ApmData {
  levels: { concourse: number; concourse_h: number; platform: number; platform_h: number; rail: number; tunnel_w: number; tunnel_h: number };
  frame: {
    track_v: number; island_v: number; plat_u: number; psd_u: number; box_u: number; box_v: number; conc_v: number;
    stair_top: number; stair_open: number[]; stair_foot: number; stair_x: number; paid_u: number[]; passage_w: number;
  };
  stations: ApmStation[];
  tracks: { west: number[][]; east: number[][] };
  passages: Record<string, number[][]>;
  exits: string[];
  /** tunnel wall lamps (Blender x, y, z), every 10 m along each bore */
  lamps?: number[][];
}

export class Apm {
  readonly group = new THREE.Group();
  readonly collisionGroup = new THREE.Group();
  readonly L: ApmData['levels'];
  readonly F: ApmData['frame'];
  readonly stations: ApmStation[];
  readonly exitIds: Set<string>;
  /** entrance lookup (station name + exit letter), set by the game once the metro entrances are loaded */
  exitInfo: ((id: string) => { station: string; ref: string } | undefined) | null = null;
  private readonly segs: { ax: number; ay: number; bx: number; by: number; hw: number; z0: number; z1: number }[] = [];

  constructor(gltf: GLTF, readonly data: ApmData) {
    this.group.name = 'apm';
    this.L = data.levels; this.F = data.frame;
    this.stations = data.stations;
    this.exitIds = new Set(data.exits);
    gltf.scene.updateMatrixWorld(true);
    const byName = new Map<string, THREE.Object3D>();
    for (const o of gltf.scene.children) byName.set(o.name, o);
    const proto = (n: string) => byName.get('kit_' + n) ?? byName.get(n);
    for (const st of data.stations) {
      const pos = fromBlender(st.x, st.y, 0);
      for (const n of ['apm_platform', 'apm_concourse', 'apm_cols_' + st.style]) {
        const p = proto(n);
        if (!p) { console.warn('[apm] missing', n); continue; }
        const o = p.clone();
        o.position.copy(pos); o.rotation.set(0, st.yaw, 0);
        o.name = `${n}@${st.key}`;
        this.group.add(o);
      }
      const col = proto('apm_station_col');
      if (col) {
        const o = col.clone();
        o.position.copy(pos); o.rotation.set(0, st.yaw, 0);
        this.collisionGroup.add(o);
      }
    }
    for (const [n, o] of byName) {
      if (n.startsWith('kit_')) continue;
      this.group.add(o);
      if (n.startsWith('apm_shell_') && !n.startsWith('apm_shell_lights')) {
        const c = o.clone();
        this.collisionGroup.add(c);
      }
    }
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = false; m.receiveShadow = false;
    });
    this.group.updateMatrixWorld(true);
    this.collisionGroup.updateMatrixWorld(true);
    // passage rectangles (Blender xy) for under()
    const hw = this.F.passage_w / 2 + 0.3;
    for (const pl of Object.values(data.passages)) {
      for (let i = 0; i < pl.length - 1; i++) {
        this.segs.push({ ax: pl[i][0], ay: pl[i][1], bx: pl[i + 1][0], by: pl[i + 1][1], hw, z0: this.L.concourse - 1, z1: this.L.concourse + this.L.concourse_h + 0.3 });
      }
    }
  }

  /** Station frame of a Blender point: u along the line (north), v across (west). */
  toFrame(st: ApmStation, x: number, y: number): [number, number] {
    const dx = x - st.x, dy = y - st.y;
    return [dx * st.tx + dy * st.ty, -dx * st.ty + dy * st.tx];
  }

  /** Blender point of a station-frame position. */
  fromFrame(st: ApmStation, u: number, v: number, z = 0): THREE.Vector3 {
    return new THREE.Vector3(st.x + st.tx * u - st.ty * v, st.y + st.ty * u + st.tx * v, z);
  }

  /** 1 inside a station box, a passage or a tunnel (three.js position), else 0. */
  under(p: THREE.Vector3): number {
    const bx = p.x, by = -p.z, bz = p.y;
    const L = this.L, F = this.F;
    if (bz > L.concourse + L.concourse_h + 0.4) return 0;
    const V = Math.max(F.conc_v, F.box_v) + 0.5;
    for (const st of this.stations) {
      const [u, v] = this.toFrame(st, bx, by);
      if (Math.abs(u) < F.box_u + 0.5 && Math.abs(v) < V) return 1;
    }
    for (const s of this.segs) {
      if (bz < s.z0 || bz > s.z1) continue;
      const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((bx - s.ax) * dx + (by - s.ay) * dy) / L2));
      if ((s.ax + dx * t - bx) ** 2 + (s.ay + dy * t - by) ** 2 < s.hw * s.hw) return 1;
    }
    if (bz < L.rail + L.tunnel_h + 0.5 && this.nearTrack(bx, by) < L.tunnel_w) return 1;
    return 0;
  }

  /**
   * The station whose paid side (between the gate lines on the concourse, or anywhere on the platform level) a
   * three.js position is in, or null.
   */
  paidAt(p: THREE.Vector3): ApmStation | null {
    const bx = p.x, by = -p.z, bz = p.y;
    const L = this.L, F = this.F;
    for (const st of this.stations) {
      const [u, v] = this.toFrame(st, bx, by);
      if (Math.abs(u) > F.box_u || Math.abs(v) > Math.max(F.conc_v, F.box_v)) continue;
      if (bz < L.concourse - 0.8) return st;                                         // stair or platform
      if (bz < L.concourse + 1.5 && u > F.paid_u[0] && u < F.paid_u[1] && Math.abs(v) < F.conc_v) return st;
    }
    return null;
  }

  /** Distance (m) from a Blender xy point to the nearest running line (coarse: every 4th sample). */
  nearTrack(x: number, y: number): number {
    let best = Infinity;
    for (const t of [this.data.tracks.west, this.data.tracks.east]) {
      for (let i = 0; i < t.length; i += 4) {
        const d = (t[i][0] - x) ** 2 + (t[i][1] - y) ** 2;
        if (d < best) best = d;
      }
    }
    return Math.sqrt(best);
  }
}
