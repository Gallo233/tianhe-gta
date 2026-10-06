import * as THREE from 'three';
import { SHOP_DECL, SHOP_U } from './ShopLight';
import { fogUniforms } from './Sky';
import { SURFACE_DECL, SURFACE_NORMAL, SURFACE_ROUGH, surfaceColor, surfaceKind, surfaceKit } from './Surfaces';
import { GLSL_PERTURB, kit, kitUniforms, type Kit } from './TexKits';

/**
 * Rebuilds the Blender looks from the glTF material extras written by guangzhou/scripts/gz_materials.py.
 * Everything that changes between day and night reads the shared uniform GZ.uNight (0 day .. 1 night),
 * the same switch as the Blender node group `GZ Night`.
 *
 *   gz_facade  window grid from metre UVs (u along the footprint ring, v = height), per-building tint and
 *              random from COLOR_0 (rgb, a), per-window night lighting; fades to the mean when a window is
 *              smaller than a pixel so distant towers do not shimmer.
 *   gz_plain   world-space colour noise; `glow` adds night light spill, pooled every LAMP_SP metres along
 *              road-space u when the road has lamp posts.
 *   gz_emit / night_emit / gz_led / gz_box / gz_water / gz_leaves: see below.
 */
export const GZ = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  /** 0 while real lamp lights (world/NightLights) light the street near the camera: the painted pools fade there */
  uLampNear: { value: 1 },
  /** 0 dry .. 1 soaked (rain) */
  uWet: { value: 0 },
  /** what window glass reflects: sky, clouds, sun and a skyline ring (Environment re-renders it as the light moves) */
  uRefl: { value: null as THREE.Texture | null },
  uReflK: { value: 1 },
};
const LAMP_SP = 30.0;

type Vec3 = [number, number, number];
const v3 = (a: Vec3) => `vec3(${a.map((x) => x.toFixed(4)).join(', ')})`;
const f = (x: number) => x.toFixed(4);

export const HASH = /* glsl */ `
float gzHash3(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
vec3 gzHash33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float gzNoise(vec2 p){ vec2 i = floor(p), u = fract(p); u = u*u*(3.0-2.0*u);
  float a = gzHash3(vec3(i, 1.7)), b = gzHash3(vec3(i + vec2(1,0), 1.7)), c = gzHash3(vec3(i + vec2(0,1), 1.7)), d = gzHash3(vec3(i + 1.0, 1.7));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y); }
float gzFbm(vec2 p){ float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++) { s += a * gzNoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

export interface Facade {
  wall: Vec3; glass: Vec3; roof: Vec3; floor_h: number; bay: number; win_w: number; sill: number; head: number;
  wall_rough: number; glass_rough: number; glass_metal: number; gf_h: number; lit: number; warm: number; lit_k: number;
  tint_glass: boolean; floor_bias: number;
}

function commonVertex(shader: THREE.WebGLProgramParametersWithUniforms, extraDecl = '', extraBody = ''): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      varying vec3 vGzWorld; varying vec3 vGzN; varying vec2 vGzUv; varying vec3 vGzLocal; ${extraDecl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vGzUv = vec2(uv.x, 1.0 - uv.y);   // glTF stores V flipped: back to Blender's (metres along, height)
      vGzLocal = position;
      #ifdef USE_INSTANCING
        vGzWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vGzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
      vGzN = normalize(mat3(modelMatrix) * objectNormal); ${extraBody}`);
}

function fragDecl(extra = ''): string {
  return `#include <common>
    uniform float uNight; uniform float uTime; uniform float uLampNear;
    varying vec3 vGzWorld; varying vec3 vGzN; varying vec2 vGzUv; varying vec3 vGzLocal; ${extra}
    ${HASH}`;
}

/**
 * Wall surface by facade family: tile / panel size (m) and joint half-width, staggered rows, tone spread,
 * joint darkness, rain streaks under the windows, grime at the foot and mould (urban villages).
 */
interface WallStyle { tw: number; th: number; jw: number; stag: boolean; tvar: number; jdark: number; streak: number; grime: number; mould: number }
function wallStyle(name: string, p: Facade): WallStyle {
  if (/residential/.test(name)) return { tw: 0.2, th: 0.1, jw: 0.0025, stag: true, tvar: 0.14, jdark: 0.22, streak: 0.4, grime: 0.3, mould: 0.1 };
  if (/urban village/.test(name)) return { tw: 0.2, th: 0.1, jw: 0.003, stag: true, tvar: 0.22, jdark: 0.3, streak: 0.6, grime: 0.5, mould: 0.45 };
  if (/office stone/.test(name)) return { tw: 1.2, th: 0.75, jw: 0.006, stag: false, tvar: 0.12, jdark: 0.45, streak: 0.22, grime: 0.2, mould: 0 };
  if (/civic/.test(name)) return { tw: p.bay, th: p.floor_h, jw: 0.01, stag: false, tvar: 0.05, jdark: 0.3, streak: 0.35, grime: 0.3, mould: 0.1 };
  if (/podium|curtain/.test(name)) return { tw: 1.5, th: 0.75, jw: 0.008, stag: false, tvar: 0.07, jdark: 0.5, streak: 0.08, grime: 0.1, mould: 0 };
  if (/industrial/.test(name)) return { tw: 0.25, th: 400, jw: 0.02, stag: false, tvar: 0.05, jdark: 0.35, streak: 0.4, grime: 0.4, mould: 0.2 };
  return { tw: 1.0, th: 0.6, jw: 0.005, stag: false, tvar: 0.06, jdark: 0.25, streak: 0.15, grime: 0.15, mould: 0 };
}

/**
 * The colours a family's buildings are actually built in (linear), one picked per building: a CBD block is not one
 * beige. Residential towers in Tianhe are white, cream, grey or salmon tile; offices granite, sandstone, limestone;
 * curtain walls come with silver, black or champagne frames and blue-green, silver, blue, bronze or green coated glass
 * (which also tints what the glass reflects).
 */
function palette(name: string, p: Facade): { wall: Vec3[]; glass: Vec3[] | null } {
  if (/residential tile/.test(name)) return { wall: [[0.70, 0.68, 0.63], [0.66, 0.58, 0.46], [0.53, 0.53, 0.52], [0.63, 0.50, 0.43], [0.52, 0.56, 0.60], [0.72, 0.70, 0.66]], glass: null };
  if (/urban village/.test(name)) return { wall: [[0.62, 0.55, 0.46], [0.68, 0.66, 0.62], [0.50, 0.47, 0.42], [0.58, 0.45, 0.39], [0.47, 0.49, 0.43]], glass: null };
  if (/office stone/.test(name)) return { wall: [[0.50, 0.47, 0.42], [0.40, 0.40, 0.39], [0.58, 0.50, 0.38], [0.30, 0.30, 0.31], [0.62, 0.60, 0.55]], glass: null };
  if (/curtain wall/.test(name)) return {
    wall: [[0.20, 0.22, 0.24], [0.46, 0.48, 0.50], [0.11, 0.11, 0.12], [0.43, 0.39, 0.32]],
    glass: [[0.55, 0.76, 0.80], [0.78, 0.80, 0.82], [0.46, 0.57, 0.78], [0.82, 0.67, 0.48], [0.56, 0.74, 0.60]],
  };
  if (/podium/.test(name)) return { wall: [[0.42, 0.42, 0.43], [0.55, 0.52, 0.46], [0.30, 0.31, 0.33], [0.62, 0.62, 0.61]], glass: [[0.70, 0.82, 0.86], [0.80, 0.80, 0.80], [0.62, 0.70, 0.80]] };
  return { wall: [p.wall], glass: null };
}
/** GLSL: pick one of `cs` by a 0..1 key */
function pick(cs: Vec3[], key: string): string {
  let out = v3(cs[cs.length - 1]);
  for (let i = cs.length - 2; i >= 0; i--) out = `(${key} < ${f((i + 1) / cs.length)} ? ${v3(cs[i])} : ${out})`;
  return out;
}

/** The baked wall surface for a facade family (null: the procedural joints). */
function wallKit(name: string): Kit | null {
  if (/residential tile/.test(name)) return kit('wall_mosaic');
  if (/office stone/.test(name)) return kit('wall_stone');
  if (/urban village|civic render/.test(name)) return kit('wall_render');
  if (/mall (court|interior)/.test(name)) return kit('wall_stone');
  if (/curtain wall|podium|industrial/.test(name)) return kit('wall_panel');
  return null;
}

export function facadeMaterial(name: string, p: Facade): THREE.MeshStandardMaterial {
  const pal = palette(name, p);
  const wk = wallKit(name);
  const rk = kit('roof_paver');
  // flat roofs: grey pavers mostly; offices sometimes a green or grey waterproof coating, village houses red tiles
  const roofPal: Vec3[] = /urban village/.test(name) ? [[0.36, 0.35, 0.33], [0.42, 0.22, 0.16], [0.38, 0.37, 0.34]]
    : /curtain|office|podium|industrial/.test(name) ? [[0.36, 0.36, 0.35], [0.24, 0.32, 0.27], [0.42, 0.42, 0.41]]
    : [[0.38, 0.37, 0.35], [0.44, 0.43, 0.41], [0.34, 0.33, 0.31]];
  const ws = wallStyle(name, p);
  // 花城汇's court (gz_huacheng) and its B1 corridor (gz_mall): a mall -- the shops are lit all day, not only after dark
  const mall = /mall (court|interior)/.test(name);
  const m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: p.wall_rough, metalness: 0 });
  const mg = (1 - p.win_w) / 2;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    shader.uniforms.uTime = GZ.uTime;
    shader.uniforms.uRefl = GZ.uRefl; shader.uniforms.uReflK = GZ.uReflK;
    if (wk) Object.assign(shader.uniforms, kitUniforms(wk, 'tW'));
    if (rk) Object.assign(shader.uniforms, kitUniforms(rk, 'tR'));
    commonVertex(shader, 'attribute vec4 color; varying vec4 vGzTint;', 'vGzTint = color;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragDecl('varying vec4 vGzTint; float gzWin; float gzOn; vec3 gzLamp; float gzAA; vec3 gzDayIn; vec3 gzNightIn; float gzWallH; vec3 gzRefl; uniform samplerCube uRefl; uniform float uReflK;' +
        ' uniform sampler2D tWA, tWN, tWO, tRA, tRN, tRO; vec2 gzWTuv; vec3 gzWMapN; float gzWRough; float gzWallM; vec2 gzRTuv; vec3 gzRMapN;' + GLSL_PERTURB))
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 uv = vGzUv;
        float wallm = step(abs(vGzN.y), 0.5);
        float su = uv.x / ${f(p.bay)}, sv = uv.y / ${f(p.floor_h)};
        float fu = fract(su), cu = floor(su), fv = fract(sv), cv = floor(sv);
        float win = step(${f(mg)}, fu) * step(fu, ${f(1 - mg)}) * step(${f(p.sill)}, fv) * step(fv, ${f(p.head)});
        float gf = ${p.gf_h > 0 ? `step(uv.y, ${f(p.gf_h)})` : '0.0'};
        ${p.gf_h > 0 ? `win = mix(win, step(0.05, fu) * step(fu, 0.95) * step(0.35, uv.y) * step(uv.y, ${f(p.gf_h - 0.9)}), gf);` : ''}
        // sub-pixel windows: blend toward the glazed fraction instead of aliasing
        gzAA = clamp(1.6 - 3.0 * max(fwidth(su), fwidth(sv)), 0.0, 1.0);
        win = mix(${f(p.win_w * (p.head - p.sill))}, win, gzAA) * wallm;
        vec3 tint = vGzTint.rgb; float rnd = vGzTint.a;
        float palK = fract(rnd * 7.31 + 0.13), glassK = fract(rnd * 3.17 + 0.41);
        vec3 wallc = ${pick(pal.wall, 'palK')} * tint;
        vec3 gzGlassTint = ${pal.glass ? pick(pal.glass, 'glassK') : 'vec3(1.0)'};
        float grime = gzFbm(vec2(uv.x * 0.35, uv.y * 0.05) + rnd * 40.0);
        wallc = mix(wallc, vec3(0.18, 0.17, 0.16), clamp((grime - 0.35) * 0.5, 0.0, 1.0));
        // wall surface: tiles or panels with joints, per-tile tone, rain streaks from the sills, foot grime, mould
        gzWRough = ${f(p.wall_rough)}; gzWallM = wallm; gzWTuv = vec2(0.0); gzWMapN = vec3(0.0, 0.0, 1.0);
        {
          vec2 wu = uv;
          ${wk ? `
          // the baked cladding (gz_texkit): tiles / panels / render with their joints, AO and roughness
          gzWTuv = wu / vec2(${f(wk.tile[0])}, ${f(wk.tile[1])}) + vec2(rnd * 7.0, 0.0);
          vec3 wA = texture2D(tWA, gzWTuv).rgb / vec3(${wk.mean.map((m) => f(Math.max(m, 0.02))).join(', ')});
          vec3 wO = texture2D(tWO, gzWTuv).rgb;
          gzWMapN = texture2D(tWN, gzWTuv).xyz * 2.0 - 1.0;
          wallc *= wA * mix(1.0, wO.r, 0.8);
          gzWRough = wO.g;
          float jfade = 1.0, joint = 0.0, tone = 1.0; vec3 th = vec3(0.5);` : `
          float gw = max(fwidth(wu.x), fwidth(wu.y));
          vec2 ts = vec2(${f(ws.tw)}, ${f(ws.th)});
          float row = floor(wu.y / ts.y);
          vec2 q = vec2(wu.x / ts.x + ${ws.stag ? '0.5 * mod(row, 2.0)' : '0.0'}, wu.y / ts.y);
          vec2 e = min(fract(q), 1.0 - fract(q)) * ts;
          float jfade = clamp(1.4 - gw / ${f(Math.min(ws.tw, ws.th) * 0.25)}, 0.0, 1.0);
          float joint = (1.0 - smoothstep(${f(ws.jw)}, ${f(ws.jw)} + gw * 1.5, min(e.x, e.y))) * jfade;
          vec3 th = gzHash33(vec3(floor(q), rnd * 13.0 + 1.0));
          float tone = 1.0 + (th.x - 0.5) * ${f(ws.tvar)} * mix(0.4, 1.0, jfade);`}
          float colWin = smoothstep(${f(mg - 0.02)}, ${f(mg + 0.02)}, fu) * smoothstep(${f(1 - mg + 0.02)}, ${f(1 - mg - 0.02)}, fu);
          float dBelow = fv < ${f(p.sill)} ? ${f(p.sill)} - fv : 1.0 + ${f(p.sill)} - fv;       // floors below the sill above
          float streakN = gzNoise(vec2(uv.x * 7.0, uv.y * 0.35 + rnd * 20.0)) * 0.7 + gzNoise(vec2(uv.x * 23.0, uv.y * 0.9)) * 0.3;
          float streak = colWin * exp(-dBelow * 2.2) * smoothstep(0.35, 0.75, streakN) * step(${f(p.gf_h)}, uv.y) * ${f(ws.streak)};
          float grimeFoot = (1.0 - smoothstep(0.0, 1.6, uv.y)) * ${f(ws.grime)};
          float mould = smoothstep(0.55, 0.8, gzFbm(uv * vec2(0.4, 0.25) + rnd * 9.0)) * ${f(ws.mould)};
          wallc *= tone * (1.0 - joint * ${f(ws.jdark)});
          wallc = mix(wallc, wallc * vec3(0.48, 0.47, 0.44), clamp(streak + grimeFoot * 0.6, 0.0, 0.85));
          wallc = mix(wallc, wallc * vec3(0.55, 0.6, 0.5), mould);
          gzWallH = (-joint * 0.004 + (th.y - 0.5) * 0.0015 * jfade) * wallm;
        }
        vec3 roofc = ${pick(roofPal, 'fract(rnd * 5.71 + 0.29)')} * tint;
        gzRTuv = vGzWorld.xz / ${f(rk ? rk.tile[0] : 4)}; gzRMapN = vec3(0.0, 0.0, 1.0);
        ${rk ? `
        if (wallm < 0.5) {
          vec3 rA = texture2D(tRA, gzRTuv).rgb / vec3(${rk.mean.map((m) => f(Math.max(m, 0.02))).join(', ')});
          vec3 rO = texture2D(tRO, gzRTuv).rgb;
          gzRMapN = texture2D(tRN, gzRTuv).xyz * 2.0 - 1.0;
          roofc *= rA * mix(1.0, rO.r, 0.8) * (0.85 + 0.3 * gzFbm(vGzWorld.xz * 0.08 + rnd * 7.0));
          gzWRough = rO.g;
        }` : ''}
        vec3 base = mix(roofc, wallc, wallm);
        float pane = 0.78 + 0.44 * gzHash3(vec3(cu, cv, rnd * 531.0));
        vec3 glassc = ${v3(p.glass)} * mix(1.0, pane, gzAA);
        ${p.tint_glass ? 'glassc = mix(glassc, glassc * tint, 0.6);' : ''}
        // glass has next to no diffuse: what it shows is the reflection (gzRefl) and the room behind (gzDayIn / gzLamp)
        diffuseColor.rgb = mix(base, glassc * gzGlassTint * 0.3, win);
        // night: occupancy per building, whole floors (offices) or single windows (homes), shops mostly lit
        float occ = 0.2 + 1.5 * fract(rnd * 7.13);
        float litEff = mix(${f(p.lit)} * occ, 0.9, gf);
        vec3 lh = gzHash33(vec3(cu + 0.37, cv + 0.61, rnd * 977.0 + 3.0));
        float fl = gzHash3(vec3(0.5, cv + 0.17, rnd * 331.0 + 11.0));
        float cellOn = step(lh.x, litEff);
        float floorOn = step(fl, litEff) * step(lh.x, 0.9);
        gzOn = step(0.5, mix(cellOn, floorOn, ${f(p.floor_bias)} * (1.0 - gf)));      // shops switch on one by one, not as a floor
        // shopfronts: a third have the roller shutter down (corrugated, unlit); the rest glow in their own colour
        float shut = gf * step(fract(lh.y * 7.7 + rnd), ${mall ? '0.08' : '0.3'}) * ${p.gf_h > 0 ? '1.0' : '0.0'};     // malls: few shutters
        gzOn = mix(litEff * 0.6, gzOn, gzAA) * win;
        gzLamp = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.64, 0.34), step(lh.y, ${f(p.warm)})) * (0.3 + lh.z * mix(0.5, 1.0, gzAA));
        vec3 shopC = lh.z < 0.08 ? vec3(1.0, 0.5, 0.62) : lh.z < 0.16 ? vec3(0.62, 1.0, 0.8) : lh.z < 0.66 ? vec3(1.0, 0.82, 0.6) : vec3(0.88, 0.93, 1.0);
        gzLamp = mix(gzLamp, shopC * (0.45 + 0.35 * lh.x) * 1.6, gf);      // at night the shops are the brightest thing at street level
        if (shut > 0.5) {
          float rib = 0.5 + 0.5 * sin(uv.y * 62.8);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.43, 0.44) * (0.8 + 0.25 * rib), win);
          gzOn = 0.0;
        }
        // --- interior mapping: a room behind every window, traced from the view ray (near the camera)
        vec3 gzN3 = normalize(vec3(vGzN.x, 0.0, vGzN.z) + 1e-5);
        vec3 gzT3 = normalize(cross(vec3(0.0, 1.0, 0.0), gzN3));
        vec3 gzV = normalize(vGzWorld - cameraPosition);
        float gzGf = gf;
        float roomW = mix(${f(p.bay)}, ${f(p.bay)}, gzGf), roomH = mix(${f(p.floor_h)}, ${f(Math.max(p.gf_h, 3))}, gzGf);
        vec3 rd = vec3(dot(gzV, gzT3) / roomW, gzV.y / roomH, max(-dot(gzV, gzN3), 1e-3) / ${f(p.floor_bias > 0.5 ? 6.0 : 4.5)});
        vec3 ro = vec3(fu, mix(fv, uv.y / roomH, gzGf), 0.0);
        vec2 tx = vec2(rd.x > 0.0 ? (1.0 - ro.x) / rd.x : -ro.x / min(rd.x, -1e-5), rd.y > 0.0 ? (1.0 - ro.y) / rd.y : -ro.y / min(rd.y, -1e-5));
        float tz = 1.0 / rd.z;
        float th = min(min(tx.x, tx.y), tz);
        vec3 hp = ro + rd * th;
        float isBack = step(tz, min(tx.x, tx.y));
        float isFC = (1.0 - isBack) * step(tx.y, tx.x);
        float isCeil = isFC * step(0.0, rd.y), isFloor = isFC - isCeil, isSide = 1.0 - isBack - isFC;
        vec3 rc = gzHash33(vec3(cu + 3.1, cv + 7.3, rnd * 71.0));
        vec3 rwall = mix(vec3(0.78, 0.74, 0.66), vec3(0.62, 0.68, 0.74), rc.x) * (0.75 + 0.35 * rc.y);
        vec3 roomC = rwall * (isBack * 0.9 + isSide * 0.72) + mix(vec3(0.34, 0.28, 0.22), vec3(0.52, 0.52, 0.54), rc.z) * isFloor + vec3(0.88) * isCeil;
        // furniture against the back wall, a partition now and then
        float furn = isBack * step(hp.y, 0.3 + 0.2 * rc.x) * step(0.1 + 0.3 * rc.y, hp.x) * step(hp.x, 0.55 + 0.4 * rc.z);
        furn += isSide * step(hp.y, 0.45) * step(0.55, hp.z) * step(0.5, rc.y);
        roomC = mix(roomC, roomC * vec3(0.3, 0.28, 0.27), clamp(furn, 0.0, 1.0) * (1.0 - gzGf));
        // shops, three kinds by the room's hash: a mini-mart (shelf rows of goods in the shop's own muted packaging
        // colours, items of different heights, gaps, now and then a bright brand; a fridge), a restaurant (warm walls,
        // a band of lit menu boxes across the back wall, tables on the floor), a boutique (white walls, a few items)
        float mart = step(rc.y, 0.45), cafe = step(0.45, rc.y) * step(rc.y, 0.75), btq = step(0.75, rc.y);
        float wallM = (isBack + isSide) * gzGf;
        float rowF = fract(hp.y * 5.0), rowI = floor(hp.y * 5.0);
        float shelfRow = step(0.08, rowF) * step(hp.y, 0.78) * step(0.08, hp.y);
        float itemX = (hp.x + hp.z) * 11.0 + rowI * 0.37;
        vec3 ih = gzHash33(vec3(floor(itemX), rowI, rc.x * 17.0));
        vec3 pal = mix(vec3(0.78, 0.62, 0.42), vec3(0.52, 0.62, 0.72), rc.z);
        vec3 goods = mix(pal * (0.55 + 0.55 * ih.x), 0.3 + 0.7 * ih, step(0.82, ih.y) * 0.75);
        float item = shelfRow * step(rowF, 0.1 + 0.85 * (0.4 + 0.6 * ih.z)) * step(0.1, fract(itemX)) * step(0.12, ih.x);
        float shelfM = wallM * item * (mart + btq * step(0.72, ih.y) * step(0.35, hp.y));
        roomC = mix(roomC, mix(vec3(0.86, 0.66, 0.46), vec3(0.95, 0.93, 0.9), btq) * (0.85 + 0.2 * rc.x), wallM * (cafe + btq) * 0.8);
        roomC = mix(roomC, goods * 0.8, shelfM);
        roomC = mix(roomC, vec3(0.12, 0.1, 0.09), wallM * mart * (1.0 - step(0.08, rowF)) * step(hp.y, 0.8));
        float menu = isBack * gzGf * cafe * step(0.62, hp.y) * step(hp.y, 0.8) * step(0.12, fract(hp.x * 4.0));
        roomC = mix(roomC, mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.85, 0.35), gzHash3(vec3(floor(hp.x * 4.0), rc.x, 5.0))), menu);
        vec2 tq = fract(hp.xz * vec2(3.0, 4.0));
        float table = isFloor * gzGf * cafe * step(0.25, tq.x) * step(tq.x, 0.65) * step(0.3, tq.y) * step(tq.y, 0.7) * step(0.35, hp.z);
        roomC = mix(roomC, vec3(0.32, 0.2, 0.12), table);
        float counter = isFloor * gzGf * step(0.25, hp.z) * step(hp.z, 0.4) * step(0.15, hp.x) * step(hp.x, 0.7) * (1.0 - cafe * step(0.35, hp.z));
        roomC = mix(roomC, vec3(0.5, 0.42, 0.34), counter);
        // lighting inside: the ceiling (with office light panels) is brightest, falling off to the floor
        float panels = ${p.floor_bias > 0.5 ? 'isCeil * step(0.55, fract(hp.x * 1.5 + 0.25)) * step(0.6, fract(hp.z * 3.0))' : 'isCeil * smoothstep(0.25, 0.05, length(hp.xz - vec2(0.5, 0.45)))'};
        float shade = isCeil * 0.75 + isBack * 0.95 + isSide * 0.7 + isFloor * 0.55;
        float wt = clamp((fv - ${f(p.sill)}) / ${f(Math.max(0.05, p.head - p.sill))}, 0.0, 1.0);
        float blind = step(0.6, fract(lh.z * 13.7)) * fract(lh.x * 41.3) * 0.7 * (1.0 - gzGf);
        float blindM = step(1.0 - blind, wt);
        vec3 gzRoom = mix(roomC * shade, vec3(0.8, 0.76, 0.68) * 0.8, blindM);
        float fridge = gzGf * isSide * mart * step(0.2, rc.y) * step(0.3, hp.z) * step(hp.y, 0.8);
        float gzRoomGlow = mix(shade + panels * 1.4 + fridge * 1.5 + shelfM * 0.4 + menu * 2.0, 0.9, blindM) * ${p.floor_bias > 0.5 ? '0.7' : '1.0'};
        // day: the room is dim next to the sunlit street; fades to the mean where windows are sub-pixel
        gzDayIn = mix(vec3(0.03), gzRoom * (0.13 - 0.07 * hp.z * (1.0 - blindM)), gzAA) * win * (1.0 - shut);
        gzLamp *= mix(0.75, gzRoomGlow * 0.85, gzAA);
        gzLamp *= mix(vec3(1.0), mix(roomC * 1.5, vec3(0.9), blindM), gzAA);     // the lit room shows its own colours
        gzLamp = mix(gzLamp, vec3(0.35, 0.5, 1.0) * 0.6, step(0.965, fract(lh.y * 23.1)) * ${f(1 - p.floor_bias)});
        gzNightIn = mix(vec3(0.012), gzRoom * 0.05, gzAA) * win * (1.0 - gzOn) * (1.0 - shut);    // unlit rooms: a trace of street light
        // the glass reflects the sky, the clouds, the sun and the skyline (Fresnel), every pane set a hair off the
        // wall's plane so the reflection breaks up pane by pane the way real curtain walls do
        {
          vec3 Vw = normalize(vGzWorld - cameraPosition);
          vec3 Nw = gzN3;
          vec3 ph = gzHash33(vec3(cu * 1.7 + 0.3, cv * 2.3 + 0.7, rnd * 91.0)) - 0.5;
          Nw = normalize(Nw + gzT3 * ph.x * ${f(p.floor_bias > 0.5 ? 0.05 : 0.025)} + vec3(0.0, 1.0, 0.0) * ph.y * ${f(p.floor_bias > 0.5 ? 0.035 : 0.02)});
          vec3 Rw = reflect(Vw, Nw);
          float cosv = clamp(dot(-Vw, Nw), 0.0, 1.0);
          float F0 = ${f(p.floor_bias > 0.5 ? 0.16 : p.tint_glass ? 0.12 : 0.06)};
          float Fr = F0 + (1.0 - F0) * pow(1.0 - cosv, 5.0);
          vec3 rc = textureCube(uRefl, Rw).rgb;                         // a cube render target: no x flip
          gzRefl = rc * gzGlassTint * Fr * win * (1.0 - shut) * uReflK * (1.0 - 0.6 * gzOn * uNight);
        }
        gzWin = win;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(gzWRough, ${f(p.glass_rough)}, gzWin);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        ${wk ? 'normal = normalize(mix(normal, gzPerturb(normal, -vViewPosition, gzWTuv, gzWMapN), gzWallM * (1.0 - gzWin)));' : ''}
        ${rk ? 'if (gzWallM < 0.5) normal = gzPerturb(normal, -vViewPosition, gzRTuv, gzRMapN);' : ''}
        {
          float hh = gzWallH * (1.0 - gzWin);
          vec3 sp = -vViewPosition; vec3 dpdx = dFdx(sp), dpdy = dFdy(sp);
          vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          normal = normalize(abs(det) * normal - sign(det) * (dFdx(hh) * r1 + dFdy(hh) * r2));
        }`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(0.0, ${f(p.glass_metal * 0.35)}, gzWin);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += gzLamp * gzOn * ${mall ? 'mix(0.6, 1.0, uNight)' : 'uNight'} * ${f(p.lit_k)} * 0.55;
        totalEmissiveRadiance += gzDayIn * (1.0 - uNight) + gzNightIn * uNight;
        totalEmissiveRadiance += gzRefl;`);
  };
  m.customProgramCacheKey = () => 'gz-facade-' + name + (wk ? '-' + wk.name : '') + (rk ? '-roof' : '');
  return m;
}

interface Plain { color: Vec3; rough: number; metal: number; glow: [Vec3, number, boolean] | null; noise: [number, Vec3, number] | null; night_emit?: [number, number, number, number] }

export function plainMaterial(name: string, p: Plain): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name, color: new THREE.Color(...p.color), roughness: p.rough, metalness: p.metal });
  if (surfaceKind(name) === 'plaza') {
    // Huacheng Square's paving lies 6 mm over the ground slab: past ~20 m the depth buffer could not tell them apart
    // and the slab won, so the strips and the eye vanished a few slabs from the camera
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = -4;
  }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    shader.uniforms.uTime = GZ.uTime;
    shader.uniforms.uLampNear = GZ.uLampNear;
    commonVertex(shader);
    let color = '';
    const kind = surfaceKind(name);
    if (kind) {
      shader.uniforms.uWet = GZ.uWet;
      const sk = surfaceKit(kind);
      if (sk) Object.assign(shader.uniforms, kitUniforms(sk));
      Object.assign(shader.uniforms, SHOP_U);
      color = surfaceColor(kind);
    } else if (p.noise) {
      const [sc, c2, amt] = p.noise;
      color = `float nz = gzFbm(vec2(vGzWorld.x, vGzWorld.z) * ${f(Math.max(sc, 0.002))});
        diffuseColor.rgb = mix(diffuseColor.rgb, ${v3(c2)}, clamp(nz * ${f(amt)}, 0.0, 1.0));`;
    }
    // shopfront light pooling on the pavement (and spilling over the kerb into the road) at night
    let emit = kind ? 'if (uNight > 0.01) totalEmissiveRadiance += diffuseColor.rgb * gzShopLight(vGzWorld) * uNight; totalEmissiveRadiance += gzEmit;' : '';
    if (p.glow) {
      const [gc, gk, pooled] = p.glow;
      const pool = pooled
        ? `(0.12 + (1.0 - smoothstep(0.0, 12.0, abs(fract(vGzUv.x / ${f(LAMP_SP)}) - 0.5) * ${f(LAMP_SP)}))
             * mix(uLampNear, 1.0, smoothstep(40.0, 70.0, distance(vGzWorld, cameraPosition))))`
        : '1.0';
      // painted lamp spill: real lamp lights take over near the camera, so this stays a distance cue
      emit += `totalEmissiveRadiance += ${v3(gc)} * uNight * ${f(gk * 0.6)} * ${pool};`;
    }
    if (p.night_emit) {
      const [r, g, b, k0] = p.night_emit;
      const ifc = /IFC diagrid/.test(name);
      const k = ifc ? k0 * 0.4 : k0;     // the west tower's LED lattice washed out the skyline
      // ...and at its feet the raking columns, lit full, filled half the screen as a white V: the lattice lights up
      // above the podium canopy (6 -> 30 m), as the real tower's does
      const lift = ifc ? ' * (0.08 + 0.92 * smoothstep(6.0, 30.0, vGzWorld.y))' : '';
      emit += `totalEmissiveRadiance += vec3(${f(r)}, ${f(g)}, ${f(b)}) * uNight * ${f(k)}${lift};`;
    }
    if (/membrane/.test(name)) {
      // tensile membrane is translucent: by day the belly glows with the sun through it (seen from the street it is
      // never the dull grey of an opaque underside); at night uplights wash it warm white
      const under = /underside/.test(name);
      emit += `totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.97, 0.92) * (${under ? '0.42' : '0.05'} * (1.0 - uNight) + ${under ? '0.6' : '0.16'} * uNight);`;
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragDecl() + (kind ? SURFACE_DECL + SHOP_DECL : ''))
      .replace('#include <color_fragment>', `#include <color_fragment>\n${color}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${emit}`);
    if (kind) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${SURFACE_ROUGH}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SURFACE_NORMAL}`);
    }
  };
  m.customProgramCacheKey = () => 'gz-plain-' + name;
  return m;
}

export function emitMaterial(name: string, p: { color: Vec3; strength: number; night_only: boolean }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name, color: 0x999999, roughness: 0.4, emissive: new THREE.Color(...p.color) });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= ${p.night_only ? 'uNight' : '1.0'} * ${f(Math.min(p.strength, 12.0))};`);
  };
  m.customProgramCacheKey = () => 'gz-emit-' + name;
  return m;
}

/**
 * A baked texture kit (guangzhou/scripts/gz_texkit.py) as exported: albedo / normal / ORM / emission mask with
 * the tile scale in KHR_texture_transform. Kept as loaded; the emission mask only lights at night, tinted
 * `glow` x `glow_k`, and the maps get anisotropic filtering (facades are mostly seen at a slant).
 */
export function texMaterial(m: THREE.MeshStandardMaterial, p: { glow: Vec3 | null; glow_k: number }): THREE.MeshStandardMaterial {
  for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap, m.emissiveMap]) if (t) t.anisotropy = 8;
  if (p.glow && m.emissiveMap) {
    m.emissive = new THREE.Color(...p.glow);
    m.emissiveIntensity = p.glow_k;
  } else {
    m.emissive = new THREE.Color(0, 0, 0);
    m.emissiveMap = null;
  }
  m.aoMapIntensity = 1;
  const key = 'gz-tex-' + m.name;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= uNight;`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Canton Tower LED skin: height gradient in the object frame, animated sweep at night. */
export function ledMaterial(name: string, p: { height: number; stops: [number, Vec3][]; strength: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name, color: new THREE.Color(0.75, 0.75, 0.73), roughness: 0.35, metalness: 0.3 });
  const ramp = p.stops.map(([t, c], i) => i === 0 ? `vec3 led = ${v3(c)};` :
    `led = mix(led, ${v3(c)}, smoothstep(${f(p.stops[i - 1][0])}, ${f(t)}, h));`).join('\n');
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    shader.uniforms.uTime = GZ.uTime;
    commonVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragDecl())
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float hy = clamp(vGzLocal.y / ${f(p.height)}, 0.0, 1.0);
        float h = clamp(fract(hy - uTime * 0.02), 0.0, 1.0);
        ${ramp}
        // the evening light show: four programmes, 24 s each, cross-fading
        float ang = atan(vGzLocal.z, vGzLocal.x) / 6.28318 + 0.5;
        float prog = mod(floor(uTime / 24.0), 4.0), pf = fract(uTime / 24.0);
        vec3 rainbow = 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + fract(hy * 2.0 + ang - uTime * 0.08)));
        float band = smoothstep(0.06, 0.0, abs(fract(hy * 3.0 - uTime * 0.25) - 0.5) - 0.18);
        vec3 bands = mix(vec3(0.9, 0.2, 0.9), vec3(0.2, 0.8, 1.0), hy) * (0.25 + band);
        float spark = step(0.965, gzHash3(vec3(floor(vGzLocal.xz * 0.8), floor(vGzLocal.y * 0.5) + floor(uTime * 8.0)))) * 3.0;
        vec3 sparkle = vec3(0.35, 0.3, 0.55) * 0.4 + vec3(1.0, 0.95, 0.85) * spark;
        vec3 show = prog < 0.5 ? led : prog < 1.5 ? rainbow * 0.6 : prog < 2.5 ? bands : sparkle * 0.7;
        led = mix(led, show, smoothstep(0.0, 0.08, pf) * smoothstep(1.0, 0.92, pf) + step(prog, 0.5));
        totalEmissiveRadiance += led * uNight * ${f(Math.min(p.strength, 6) * 0.7)};`);
  };
  m.customProgramCacheKey = () => 'gz-led-' + name;
  return m;
}

/** Guangdong Museum treasure box: random-width carved slots on a 7 x 3.3 m cell grid. */
export function boxMaterial(name: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name, color: 0xffffff, roughness: 0.45, metalness: 0.2 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    commonVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragDecl('float gzOpen;'))
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 s = vGzUv / vec2(7.0, 3.3); vec2 c = floor(s), fr = fract(s);
        vec3 h = gzHash33(vec3(c, 1.7));
        float w = 0.25 + h.x * 0.7, x0 = h.y * (1.0 - w);
        gzOpen = step(gzHash3(vec3(c, 5.1)), 0.42) * step(x0, fr.x) * step(fr.x, x0 + w) * step(0.3, fr.y) * step(fr.y, 0.72);
        gzOpen *= step(abs(vGzN.y), 0.5);
        diffuseColor.rgb = mix(vec3(0.06, 0.055, 0.05), vec3(0.55, 0.42, 0.24), gzOpen);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.72, 0.4) * gzOpen * uNight * 2.5;`);
  };
  m.customProgramCacheKey = () => 'gz-box';
  return m;
}

/** Pearl River: travelling waves in the normal, murky green-brown body, sky/city reflections via env map. */
export function waterMaterial(name: string, color: Vec3): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ name, color: new THREE.Color(...color), roughness: 0.06, metalness: 0.0, envMapIntensity: 1.0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = GZ.uTime;
    shader.uniforms.uNight = GZ.uNight; fogUniforms(shader);
    commonVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', fragDecl(`
        vec2 wv(vec2 p, vec2 d, float k, float s, float a){ float ph = dot(p, d) * k + uTime * s; return d * (cos(ph) * a * k); }`))
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 wp = vGzWorld.xz;
        vec2 g = wv(wp, normalize(vec2(1.0, 0.15)), 0.16, 1.1, 0.30) + wv(wp, normalize(vec2(0.8, -0.6)), 0.43, 1.7, 0.10)
               + wv(wp, normalize(vec2(0.3, 1.0)), 1.2, 2.5, 0.03) + wv(wp, normalize(vec2(-0.9, 0.4)), 2.9, 3.6, 0.011);
        float fade = 1.0 / (1.0 + length(vGzWorld - cameraPosition) * 0.0025);
        vec3 wn = normalize(vec3(-g.x * fade, 1.0, -g.y * fade));
        normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);`);
  };
  m.customProgramCacheKey = () => 'gz-water';
  return m;
}

/** Rebuild one glTF material from its extras; unknown ones are returned unchanged. */
/** Facade parameters by material name, filled as buildings.glb loads (the near-LOD detail aligns to them). */
export const FACADES = new Map<string, Facade>();

export function rebuild(mat: THREE.Material): THREE.Material {
  const u = mat.userData ?? {};
  const name = mat.name;
  const parse = (k: string) => (typeof u[k] === 'string' ? JSON.parse(u[k]) : u[k]);
  if (u.gz_tex) return texMaterial(mat as THREE.MeshStandardMaterial, parse('gz_tex'));
  if (u.gz_facade) { const fp = parse('gz_facade') as Facade; FACADES.set(name, fp); return facadeMaterial(name, fp); }
  if (u.gz_led) return ledMaterial(name, parse('gz_led'));
  if (u.gz_box) return boxMaterial(name);
  if (u.gz_water) return waterMaterial(name, parse('gz_water').color);
  if (u.gz_emit) return emitMaterial(name, parse('gz_emit'));
  if (u.gz_pebble) {
    const p = parse('gz_pebble');
    return new THREE.MeshStandardMaterial({ name, color: new THREE.Color(...(p.stone as Vec3)), roughness: 0.45, metalness: 0.1, flatShading: true });
  }
  if (u.gz_leaves) {
    const p = parse('gz_leaves');
    return new THREE.MeshStandardMaterial({ name, color: new THREE.Color(...(p.color as Vec3)).lerp(new THREE.Color(...(p.color2 as Vec3)), 0.4), roughness: 0.8 });
  }
  if (u.gz_plain) return plainMaterial(name, parse('gz_plain'));
  return mat;
}
