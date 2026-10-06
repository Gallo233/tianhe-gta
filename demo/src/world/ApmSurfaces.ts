import * as THREE from 'three';
import { GZ, HASH } from './Materials';
import { fogUniforms } from './Sky';
import type { ApmStation } from './Apm';

/**
 * Finishes for the APM stations and passages (no texture files, like world/Surfaces), after the Commons
 * photographs of the 大剧院 platform and the 广州塔 concourse: polished salt-and-pepper granite floors in
 * 0.8 m tiles with hairline joints, large-format panels on the walls with a stainless skirting, strip
 * aluminium ceilings. Everything is laid out in the station frame of the nearest station (u along the line,
 * x across), so the joints run true to the platform edges; walls use the run along the wall and the height.
 *
 *   floor     'apm floor granite' (platform, stairs), 'apm concourse tile' (concourse, passages),
 *             'apm floor granite dark' (the black bands): tiles on the tops, grain everywhere
 *   wall      'apm wall stone' (concourse, passages), 'apm wall panel' (platform ends, bulkheads), 'apm well wall'
 *   ceiling   'apm ceiling panel': 0.25 m strips with dark reveals, micro-perforation near the camera
 *   tunnel    'apm tunnel concrete': cast-in-place box: 2.4 x 1.2 m formwork marks with tie holes, a construction
 *             joint every 12 m, seepage streaks down the walls, grime low down
 *
 * The mirror look of the stone is screen-space (RenderPipeline.apmFloors: the two floor levels reflect);
 * here the stone gets its grain, joints, per-tile tone and a slight lippage that breaks the reflections up.
 */
type Kind = 'floor' | 'floor_white' | 'floor_dark' | 'wall_stone' | 'wall_panel' | 'ceiling' | 'tunnel';

function kindOf(name: string): Kind | null {
  if (/apm floor granite dark/.test(name)) return 'floor_dark';
  if (/apm floor granite/.test(name)) return 'floor';
  if (/apm concourse tile/.test(name)) return 'floor_white';
  if (/apm wall stone|apm well wall/.test(name)) return 'wall_stone';
  if (/apm wall panel/.test(name)) return 'wall_panel';
  if (/apm ceiling panel/.test(name)) return 'ceiling';
  if (/apm tunnel concrete/.test(name)) return 'tunnel';
  return null;
}

/** station frames (Blender x, y, tangent x, tangent y), shared by every patched material */
const uStations = { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4(1e6, 1e6, 0, 1)) };
const uLevels = { value: new THREE.Vector2(-5.85, -11.85) };

const DECL = /* glsl */`
  varying vec3 vApmW; varying vec3 vApmN;
  uniform vec4 uStations[5]; uniform vec2 uLevels;
  ${HASH}
  float apmH; float apmR;
  // station frame of a world point: (u along the line, x across to the east)
  vec2 apmFrame(vec3 w) {
    vec2 b = vec2(w.x, -w.z);
    vec4 best = uStations[0]; float bd = 1e20;
    for (int i = 0; i < 5; i++) { vec2 d = b - uStations[i].xy; float dd = dot(d, d); if (dd < bd) { bd = dd; best = uStations[i]; } }
    vec2 d = b - best.xy;
    return vec2(dot(d, best.zw), d.x * best.w - d.y * best.z);
  }
  float apmLine(float d, float w, float px) { return 1.0 - smoothstep(w, w + px * 1.5, d); }
  // grain: three scales of cells (fading to the mean when sub-pixel), black mica and white feldspar flecks
  vec3 apmGrain(vec2 p, vec3 base, float dark, float light) {
    float w = max(fwidth(p.x), fwidth(p.y));
    float fade = clamp(1.6 - w * 90.0, 0.0, 1.0), fade2 = clamp(1.6 - w * 30.0, 0.0, 1.0);
    float g1 = gzHash3(vec3(floor(p * 190.0), 1.3)), g2 = gzHash3(vec3(floor(p * 64.0), 2.9)), g3 = gzNoise(p * 9.0);
    vec3 c = base * (0.93 + 0.1 * g3 + 0.08 * (g2 - 0.5) * fade2);
    c = mix(c, vec3(0.05, 0.05, 0.055), step(1.0 - dark, g1) * fade * 0.6);
    c = mix(c, vec3(0.92, 0.91, 0.89), step(1.0 - light, fract(g1 * 7.31)) * fade * 0.5);
    return c;
  }
`;

function colorChunk(kind: Kind): string {
  const floorTiles = (size: number, base: string, dark: number, light: number, joint: string) => /* glsl */`
    vec2 fp = apmFrame(vApmW);
    float up = step(0.6, vApmN.y);
    vec3 col = apmGrain(fp, ${base}, ${dark.toFixed(3)}, ${light.toFixed(3)});
    vec2 q = fp / ${size.toFixed(2)};
    vec2 cell = floor(q), fr = fract(q);
    vec2 e = min(fr, 1.0 - fr) * ${size.toFixed(2)};
    float px = max(fwidth(fp.x), fwidth(fp.y));
    float joint = apmLine(min(e.x, e.y), 0.0012, px) * up * clamp(1.4 - px * 40.0, 0.0, 1.0);
    vec3 th = gzHash33(vec3(cell, 5.1));
    col *= mix(1.0, 0.95 + 0.1 * th.x, up);
    col = mix(col, ${joint}, joint * 0.8);
    diffuseColor.rgb = col;
    apmR = mix(0.3, 0.2 + 0.08 * th.y, up) + joint * 0.4;
    // lippage: each tile tilted a hair, the joint a hair lower
    apmH = up * ((th.z - 0.5) * 0.0012 * (fr.x - 0.5) + (th.y - 0.5) * 0.0012 * (fr.y - 0.5) - joint * 0.0008);`;
  switch (kind) {
    case 'floor': return floorTiles(0.8, 'diffuseColor.rgb', 0.035, 0.1, 'vec3(0.12, 0.12, 0.12)');
    case 'floor_white': return floorTiles(0.8, 'diffuseColor.rgb', 0.014, 0.02, 'vec3(0.35, 0.34, 0.33)');
    case 'floor_dark': return floorTiles(0.8, 'diffuseColor.rgb * 1.4', 0.0, 0.12, 'vec3(0.02)');
    case 'wall_stone':
    case 'wall_panel': {
      const [w, h, seam] = kind === 'wall_stone' ? [1.2, 0.6, 0.0025] : [1.0, 0.5, 0.003];
      return /* glsl */`
    vec2 t2 = normalize(vec2(-vApmN.z, vApmN.x) + 1e-5);
    float side = 1.0 - step(0.6, abs(vApmN.y));
    vec2 wp = vec2(dot(vApmW.xz, t2), vApmW.y - uLevels.y);
    vec2 q = wp / vec2(${w.toFixed(2)}, ${h.toFixed(2)});
    vec2 cell = floor(q), fr = fract(q);
    vec2 e = min(fr, 1.0 - fr) * vec2(${w.toFixed(2)}, ${h.toFixed(2)});
    float px = max(fwidth(wp.x), fwidth(wp.y));
    float seam = apmLine(min(e.x, e.y), ${seam.toFixed(4)}, px) * side * clamp(1.4 - px * 30.0, 0.0, 1.0);
    vec3 th = gzHash33(vec3(cell, 8.3));
    vec3 col = diffuseColor.rgb * (0.95 + 0.08 * th.x);
    ${kind === 'wall_stone' ? `
    // soft veining in the stone, one direction per panel
    float vein = gzNoise(vec2(dot(wp, vec2(cos(th.y * 6.28), sin(th.y * 6.28))) * 1.7, th.z * 20.0) + gzNoise(wp * 3.1 + th.xy * 9.0) * 0.5);
    col *= 0.95 + 0.08 * vein;` : ''}
    // stainless skirting along the floor on both levels
    float yc = vApmW.y - (abs(vApmW.y - uLevels.x) < abs(vApmW.y - uLevels.y) ? uLevels.x : uLevels.y);
    float skirt = side * step(0.0, yc) * (1.0 - smoothstep(0.14, 0.14 + px, yc));
    col = mix(col, vec3(0.32, 0.33, 0.34), skirt);
    col = mix(col, col * 0.35, seam);
    diffuseColor.rgb = col;
    apmR = mix(${kind === 'wall_stone' ? '0.42' : '0.3'} + 0.1 * th.y, 0.28, skirt) + seam * 0.3;
    apmH = -seam * 0.002 + skirt * 0.004 * smoothstep(0.1, 0.14, yc);`;
    }
    case 'tunnel': return /* glsl */`
    vec2 t2 = normalize(vec2(-vApmN.z, vApmN.x) + 1e-5);
    float side = 1.0 - step(0.6, abs(vApmN.y));
    // walls: (run along the wall, height); the roof and floor only get the tone and grime
    vec2 wp = side > 0.5 ? vec2(dot(vApmW.xz, t2), vApmW.y) : vApmW.xz;
    float px = max(fwidth(wp.x), fwidth(wp.y));
    vec2 q = wp / vec2(2.4, 1.2);
    vec2 fr = fract(q);
    vec2 e = min(fr, 1.0 - fr) * vec2(2.4, 1.2);
    float form = apmLine(min(e.x, e.y), 0.004, px) * side * clamp(1.4 - px * 20.0, 0.0, 1.0);
    vec2 tie = abs(fract(wp / vec2(0.6, 0.6)) - 0.5) * 0.6;
    float holes = (1.0 - smoothstep(0.012, 0.012 + px, length(tie))) * side * clamp(1.4 - px * 60.0, 0.0, 1.0);
    float cj = apmLine(6.0 - abs(fract(wp.x / 12.0) - 0.5) * 12.0, 0.012, px) * side;
    float seep = smoothstep(0.52, 0.72, gzFbm(vec2(wp.x * 3.0, wp.y * 0.25))) * side;
    float low = 1.0 - smoothstep(-12.9, -11.9, vApmW.y);
    float tone = 0.9 + 0.2 * gzFbm(wp * 0.6) + 0.08 * (gzHash3(vec3(floor(q), 2.0)) - 0.5);
    diffuseColor.rgb *= tone * (1.0 - 0.35 * form) * (1.0 - 0.55 * holes) * (1.0 - 0.3 * seep) * (1.0 - 0.3 * low);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03), cj * 0.6);
    apmR = 0.88 - 0.25 * seep;
    apmH = -form * 0.003 - holes * 0.006 - cj * 0.01;`;
    case 'ceiling': return /* glsl */`
    vec2 fp = apmFrame(vApmW);
    float down = step(0.6, -vApmN.y);
    float px = max(fwidth(fp.x), fwidth(fp.y));
    float sx = abs(fract(fp.y / 0.25) - 0.5) * 0.25;
    float reveal = apmLine(0.125 - sx, 0.003, px) * down * clamp(1.4 - px * 25.0, 0.0, 1.0);
    float strip = floor(fp.y / 0.25);
    float perf = step(0.5, gzHash3(vec3(floor(fp * 180.0), 4.4))) * clamp(1.2 - px * 180.0, 0.0, 1.0) * down;
    diffuseColor.rgb *= (0.97 + 0.04 * gzHash3(vec3(strip, 1.0, 2.0))) * (1.0 - 0.12 * perf);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.08), reveal * 0.55);
    apmR = 0.4 + reveal * 0.4;
    apmH = -reveal * 0.004;`;
  }
}

const NORMAL = /* glsl */`
  {
    vec3 sp = -vViewPosition;
    vec3 dpdx = dFdx(sp), dpdy = dFdy(sp);
    vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
    float det = dot(dpdx, r1);
    normal = normalize(abs(det) * normal - sign(det) * (dFdx(apmH) * r1 + dFdy(apmH) * r2));
  }`;

function patch(m: THREE.MeshStandardMaterial, kind: Kind): void {
  m.onBeforeCompile = (shader) => {
    fogUniforms(shader);
    shader.uniforms.uStations = uStations;
    shader.uniforms.uLevels = uLevels;
    shader.uniforms.uTime = GZ.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vApmW; varying vec3 vApmN;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vApmW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vApmW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        vApmN = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + DECL)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${colorChunk(kind)}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(apmR, 0.05, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + NORMAL);
  };
  m.customProgramCacheKey = () => 'apm-surf-' + kind;
}

/** Patch every APM material that has a finish (once per material, the objects share them). */
export function dressApm(root: THREE.Object3D, stations: ApmStation[], levels: { concourse: number; platform: number }): void {
  stations.slice(0, 5).forEach((s, i) => uStations.value[i].set(s.x, s.y, s.tx, s.ty));
  uLevels.value.set(levels.concourse, levels.platform);
  const done = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (done.has(mat) || !(mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
      done.add(mat);
      const kind = kindOf(mat.name);
      if (kind) patch(mat as THREE.MeshStandardMaterial, kind);
    }
  });
}
