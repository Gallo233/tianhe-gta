import * as THREE from 'three';

/**
 * The baked tiling texture sets for ordinary buildings and streets (guangzhou/scripts/gz_texkit.py: modelled
 * high-poly patches -- aggregate in asphalt, flamed granite slabs, pavers, lawn blades, glazed wall tiles, stone
 * cladding, render, aluminium panels -- baked to albedo / normal / ORM). They are neutral in colour: shaders multiply
 * albedo / mean into the surface's own colour, so one set serves every palette.
 *
 * loadKits() before the city's materials are made; kit(name) afterwards (null when a kit is missing: the shaders
 * fall back to their procedural detail). GLSL_PERTURB perturbs a view-space normal with a tangent-space map sample
 * using a cotangent frame from screen derivatives (no tangents needed: walls, roads in road space, world-space
 * paving all work the same).
 */
export interface Kit {
  name: string;
  alb: THREE.Texture;
  nrm: THREE.Texture;
  orm: THREE.Texture;
  tile: [number, number];
  mean: [number, number, number];
}

const kits = new Map<string, Kit>();

export const CITY_KITS = ['roof_paver', 'city_asphalt', 'city_slab', 'city_brick', 'city_grass', 'wall_mosaic', 'wall_stone', 'wall_render', 'wall_panel'];

export async function loadKits(names = CITY_KITS, base = 'assets/tex/'): Promise<number> {
  let man: Record<string, { tile_m: number[]; mean?: number[]; files: Record<string, string> }>;
  try { man = await (await fetch(base + 'kits.json')).json(); } catch { return 0; }
  const loader = new THREE.TextureLoader();
  const load = async (url: string, srgb: boolean) => {
    const t = await loader.loadAsync(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  await Promise.all(names.map(async (name) => {
    const m = man[name];
    if (!m?.files?.albedo || !m.files.normal || !m.files.orm) return;
    try {
      const [alb, nrm, orm] = await Promise.all([load(m.files.albedo, true), load(m.files.normal, false), load(m.files.orm, false)]);
      // the mean was measured on the linear bake; the sRGB jpg decodes back to the same linear values
      const mean = (m.mean ?? [0.5, 0.5, 0.5]) as [number, number, number];
      kits.set(name, { name, alb, nrm, orm, tile: [m.tile_m[0], m.tile_m[1]], mean });
    } catch { /* missing files: the procedural fallback */ }
  }));
  return kits.size;
}

export function kit(name: string): Kit | null { return kits.get(name) ?? null; }

export function kitTextures(): THREE.Texture[] { return [...kits.values()].flatMap((k) => [k.alb, k.nrm, k.orm]); }

/** Uniforms for one kit under a prefix (tKA / tKN / tKO by default). */
export function kitUniforms(k: Kit, p = 'tK'): Record<string, THREE.IUniform> {
  return { [p + 'A']: { value: k.alb }, [p + 'N']: { value: k.nrm }, [p + 'O']: { value: k.orm } };
}

export const GLSL_PERTURB = /* glsl */`
  // Schüler's cotangent frame: the tangent basis from the derivatives of position and uv
  vec3 gzPerturb(vec3 N, vec3 p, vec2 uv, vec3 mapN) {
    mapN.z = max(mapN.z, 0.25);                     // never into the surface (a bad texel would black the pixel out)
    vec3 dp1 = dFdx(p), dp2 = dFdy(p);
    vec2 duv1 = dFdx(uv), duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float im = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-20));
    return normalize(mat3(T * im, B * im, N) * mapN);
  }`;
