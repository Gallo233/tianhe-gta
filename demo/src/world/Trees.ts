import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GZ } from './Materials';
import { fogUniforms } from './Sky';

/**
 * Near-LOD street trees for Tianhe: canopies of alpha-tested leaf cards whose texture is baked from real
 * leaf geometry in Blender (guangzhou/scripts/gz_trees.py, colour + tangent normals), normals bent toward the crown's
 * ellipsoid so the crown shades as one soft volume, darker inside and underneath, and a wind sway that
 * grows with height and is phased per instance. Same sizes and pivots as the Blender prototypes they
 * replace near the camera (base at y = 0, glTF Y-up):
 *
 *   banyan      Ficus microcarpa: short thick trunk, five limbs, a 10 m dome, aerial roots
 *   kapok       Bombax ceiba in flower: straight 10 m trunk, whorled tiers of branches, red blossom
 *   royal palm  grey column, green crownshaft, fourteen arching fronds
 */
export interface TreeProto { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry }

// atlas cells in uv (u0, v0, u1, v1), v up
const CELL = {
  banyan: [0, 0.5, 0.5, 1.0],
  kapok: [0.5, 0.5, 1.0, 1.0],
  frond: [0, 0.25, 1.0, 0.5],
  bloom: [0, 0.0, 1.0, 0.25],
} as const;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------------------------------ builders
class Builder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; col: number[] = [];
  quad(p: THREE.Vector3[], n: THREE.Vector3[], uv: number[][], c: number[]) {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      this.pos.push(p[i].x, p[i].y, p[i].z); this.nrm.push(n[i].x, n[i].y, n[i].z);
      this.uv.push(uv[i][0], uv[i][1]); this.col.push(c[i], c[i], c[i]);
    }
  }
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** A leaf card at p, facing roughly `face`, size s, normals bent toward the crown's outward direction. */
function card(b: Builder, p: THREE.Vector3, s: number, R: () => number, cell: readonly number[], centre: THREE.Vector3, radii: THREE.Vector3, ao: number, facing?: THREE.Vector3) {
  const face = new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
  if (facing) face.lerp(facing, 0.55).normalize();                 // mostly turned outward, never all the same
  const t1 = new THREE.Vector3().crossVectors(face, Math.abs(face.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
  const t2 = new THREE.Vector3().crossVectors(face, t1);
  const rot = R() * Math.PI * 2;
  const a = t1.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t2, Math.sin(rot)).multiplyScalar(s / 2);
  const c = t2.clone().multiplyScalar(Math.cos(rot)).addScaledVector(t1, -Math.sin(rot)).multiplyScalar(s / 2);
  const corners = [p.clone().sub(a).sub(c), p.clone().add(a).sub(c), p.clone().add(a).add(c), p.clone().sub(a).add(c)];
  const ns = corners.map((q) => q.clone().sub(centre).divide(radii).normalize().lerp(face, 0.15).normalize());
  const [u0, v0, u1, v1] = cell;
  const shade = corners.map((q) => ao * THREE.MathUtils.clamp(0.55 + 0.45 * ((q.y - centre.y) / radii.y + 0.6), 0.35, 1.05));
  b.quad(corners, ns, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], shade);
}

function limb(from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, seg = 6): THREE.BufferGeometry {
  const d = to.clone().sub(from);
  const g = new THREE.CylinderGeometry(r1, r0, d.length() + r0 * 0.6, seg, 1, false);
  g.translate(0, -r0 * 0.3, 0);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(from.x, from.y, from.z);
  g.deleteAttribute('uv');
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(1), 3));
  return g;
}

function barkOf(parts: THREE.BufferGeometry[], tint: [number, number, number]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => p.index ? p.toNonIndexed() : p), false)!;
  const c = g.getAttribute('color');
  const pos = g.getAttribute('position');
  for (let i = 0; i < c.count; i++) {
    const ao = THREE.MathUtils.clamp(0.55 + pos.getY(i) * 0.06, 0.55, 1);
    c.setXYZ(i, tint[0] * ao, tint[1] * ao, tint[2] * ao);
  }
  g.computeBoundingSphere();
  return g;
}

function banyan(): TreeProto {
  // the lotus-pond broadleaf recipe: the crown is a union of sub-crowns of very different sizes, each fed
  // by its own limb, leaf cards crowding the sunlit shell of every clump; aerial roots hang from the limbs
  const R = rng(11);
  const bark: THREE.BufferGeometry[] = [
    limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.7, 0), 0.62, 0.44, 12),
    limb(new THREE.Vector3(0, 0.7, 0), new THREE.Vector3(0.12, 3.3, 0.05), 0.44, 0.32, 12),
    limb(new THREE.Vector3(0.12, 3.3, 0.05), new THREE.Vector3(0.25, 6.0, 0.1), 0.3, 0.07, 8),
  ];
  const centre = new THREE.Vector3(0, 6.4, 0), radii = new THREE.Vector3(5.0, 2.9, 4.7);
  const b = new Builder();
  const clumps = 13;
  for (let k = 0; k < clumps; k++) {
    const u = new THREE.Vector3(R() * 2 - 1, (R() * 2 - 1) * 0.7 + 0.15, R() * 2 - 1).normalize();
    const cpos = centre.clone().add(u.clone().multiply(radii).multiplyScalar(0.35 + R() * 0.45));
    const size = (0.3 + R() * 0.22) * radii.x;
    const crad = new THREE.Vector3(size, size * (0.55 + R() * 0.3), size);
    const start = new THREE.Vector3(0.12, 3.0 + R() * 2.2, 0.05);
    const mid = start.clone().lerp(cpos, 0.5).add(new THREE.Vector3(0, 0.5, 0));
    bark.push(limb(start, mid, 0.2, 0.13, 7), limb(mid, cpos, 0.13, 0.05, 6));
    for (let j = 0; j < 3; j++) {
      const a = new THREE.Vector3(R() - 0.5, R() * 0.5, R() - 0.5).normalize();
      bark.push(limb(cpos, cpos.clone().add(a.multiply(crad).multiplyScalar(0.8)), 0.05, 0.015, 4));
    }
    // aerial roots: thin, slightly wavering strands in bunches, most stopping well above the pavement
    if (R() < 0.45) {
      const p0 = start.clone().lerp(cpos, 0.35 + R() * 0.5);
      for (let j = 0; j < 3 + Math.floor(R() * 4); j++) {
        const p = p0.clone().add(new THREE.Vector3((R() - 0.5) * 0.6, 0, (R() - 0.5) * 0.6));
        const len = 1.2 + R() * (p.y - 1.5) * (R() < 0.2 ? 1.0 : 0.55);
        const midp = p.clone().add(new THREE.Vector3((R() - 0.5) * 0.15, -len * 0.5, (R() - 0.5) * 0.15));
        const end = p.clone().add(new THREE.Vector3((R() - 0.5) * 0.25, -len, (R() - 0.5) * 0.25));
        const r = 0.008 + R() * 0.012;
        bark.push(limb(midp, p, r, r * 1.2, 3), limb(end, midp, r * 0.7, r, 3));
      }
    }
    const n = 7 + Math.round(size * 1.5);
    for (let i = 0; i < n; i++) {
      const d = new THREE.Vector3(R() * 2 - 1, (R() * 2 - 1) * 0.8 + 0.25, R() * 2 - 1).normalize();
      const r = 0.72 + R() * 0.3;
      const p = cpos.clone().add(d.clone().multiply(crad).multiplyScalar(r));
      const out = p.clone().sub(centre).normalize().add(d).normalize();
      card(b, p, 2.3 + R() * 1.1, R, CELL.banyan, centre, radii, 0.72 + r * 0.26, out);
    }
  }
  return { bark: barkOf(bark, [0.3, 0.29, 0.26]), leaves: b.geometry() };
}

function kapok(): TreeProto {
  const R = rng(23);
  const bark: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 14.8, 0), 0.42, 0.12, 9)];
  const b = new Builder();
  const centre = new THREE.Vector3(0, 12, 0), radii = new THREE.Vector3(4.5, 3.8, 4.5);
  for (const [y, n, len] of [[8.6, 5, 4.2], [10.6, 5, 3.6], [12.6, 4, 2.9], [14.2, 3, 1.8]] as [number, number, number][]) {
    for (let k = 0; k < n; k++) {
      const a = k / n * Math.PI * 2 + y + R() * 0.5;
      const base = new THREE.Vector3(0, y, 0);
      const tip = new THREE.Vector3(Math.cos(a) * len, y + 0.6 + R() * 0.4, Math.sin(a) * len);
      bark.push(limb(base, tip, 0.1, 0.04, 5));
      for (let j = 0; j < 5; j++) {
        const p = base.clone().lerp(tip, 0.45 + j * 0.13).add(new THREE.Vector3((R() - 0.5) * 0.8, 0.3 + R() * 0.5, (R() - 0.5) * 0.8));
        const u = Math.floor(R() * 4) / 4;                      // one of the four blossom clusters
        card(b, p, 1.7 + R() * 0.9, R, j % 2 ? CELL.kapok : [u, 0, u + 0.25, 0.25], centre, radii, 0.95);
      }
    }
  }
  return { bark: barkOf(bark, [0.45, 0.43, 0.4]), leaves: b.geometry() };
}

function palm(): TreeProto {
  const R = rng(37);
  const bark: THREE.BufferGeometry[] = [];
  // swollen grey column in three pieces, then the green crownshaft
  bark.push(limb(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 4, 0), 0.34, 0.4, 10));
  bark.push(limb(new THREE.Vector3(0, 4, 0), new THREE.Vector3(0, 8, 0), 0.4, 0.33, 10));
  bark.push(limb(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, 10.4, 0), 0.33, 0.3, 10));
  const g = barkOf(bark, [0.62, 0.61, 0.58]);
  const shaft = barkOf([limb(new THREE.Vector3(0, 10.4, 0), new THREE.Vector3(0, 12.6, 0), 0.32, 0.26, 10)], [0.3, 0.42, 0.16]);
  const trunk = mergeGeometries([g, shaft], false)!;
  const b = new Builder();
  const top = new THREE.Vector3(0, 12.6, 0);
  const [u0, v0, u1, v1] = CELL.frond;
  for (let k = 0; k < 20; k++) {
    const a = k * 2.39996 + R() * 0.3;
    const elev = THREE.MathUtils.degToRad(70 - (k / 20) * 105 + (R() - 0.5) * 10);
    const L = 4.6 + R() * 0.8;
    const dir = new THREE.Vector3(Math.cos(a) * Math.cos(elev), Math.sin(elev), Math.sin(a) * Math.cos(elev));
    const side = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    const SEG = 7;
    let prev: THREE.Vector3 | null = null;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG;
      // the frond arches over: its direction bends downward along its length
      const p = top.clone().addScaledVector(dir, L * t).add(new THREE.Vector3(0, -(1.6 + (1 - Math.sin(elev)) * 1.2) * t * t, 0));
      if (prev) {
        const tp = (s - 1) / SEG;
        const w0 = 1.25 * Math.sin(Math.PI * Math.min(1, tp * 1.05)) + 0.15, w1 = 1.25 * Math.sin(Math.PI * Math.min(1, t * 1.05)) + 0.15;
        const up = new THREE.Vector3(0, 1, 0);
        // a shallow V across the rib: two quads per segment
        for (const sd of [-1, 1]) {
          const q0 = prev.clone().addScaledVector(side, sd * w0).addScaledVector(up, -0.25 * w0);
          const q1 = p.clone().addScaledVector(side, sd * w1).addScaledVector(up, -0.25 * w1);
          const vm = (v0 + v1) / 2, ve = sd < 0 ? v0 : v1;
          const n = up.clone().addScaledVector(side, sd * 0.35).normalize();
          const uA = u0 + (u1 - u0) * tp, uB = u0 + (u1 - u0) * t;
          b.quad([prev, p, q1, q0], [n, n, n, n], [[uA, vm], [uB, vm], [uB, ve], [uA, ve]], [0.9, 0.95, 1.0, 0.95]);
        }
      }
      prev = p;
    }
  }
  return { bark: trunk, leaves: b.geometry() };
}

// ------------------------------------------------------------------------------------------ materials
let atlas: { map: THREE.Texture; normal: THREE.Texture } | null = null;
function loadAtlas(): { map: THREE.Texture; normal: THREE.Texture } {
  if (atlas) return atlas;
  const loader = new THREE.TextureLoader();
  const map = loader.load('assets/trees/leaf_atlas.png');
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const normal = loader.load('assets/trees/leaf_atlas_n.jpg');
  normal.anisotropy = 4;
  atlas = { map, normal };
  return atlas;
}

/**
 * GLSL (vertex, instanced): 1 for a tree standing on Huacheng Square south of 花城大道 (gz_huacheng) -- its groves and
 * avenues have uplights at their feet. three.js x = Blender x, z = -Blender y.
 */
const UPLIT = `(step(-112.0, (modelMatrix * instanceMatrix[3]).x) * step((modelMatrix * instanceMatrix[3]).x, 112.0)
  * step(-135.0, (modelMatrix * instanceMatrix[3]).z) * step((modelMatrix * instanceMatrix[3]).z, 570.0))`;

export function leafMaterial(): THREE.MeshStandardMaterial {
  const t = loadAtlas();
  const m = new THREE.MeshStandardMaterial({
    map: t.map, normalMap: t.normal, normalScale: new THREE.Vector2(0.8, 0.8),
    alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true, roughness: 0.55, metalness: 0,
  });
  m.onBeforeCompile = (shader) => {
    fogUniforms(shader);
    shader.uniforms.uTime = GZ.uTime;
    shader.uniforms.uNight = GZ.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime; varying float vGzUp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          float ph = instanceMatrix[3].x * 0.13 + instanceMatrix[3].z * 0.17;
          vGzUp = ${UPLIT} * (1.0 - smoothstep(2.0, 9.5, position.y));
        #else
          float ph = 0.0;
          vGzUp = 0.0;
        #endif
        float hw = max(position.y - 3.0, 0.0) * 0.02;
        transformed.x += sin(uTime * 1.3 + ph + position.y * 0.3) * hw * (0.6 + 0.4 * sin(uTime * 0.37 + ph));
        transformed.z += cos(uTime * 1.1 + ph * 1.3 + position.x * 0.4) * hw * 0.7;`);
    // light through the leaves: a little of the sun's colour on the side facing away from it
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; varying float vGzUp;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #if NUM_DIR_LIGHTS > 0
          float gzBack = pow(clamp(dot(normalize(-vViewPosition), directionalLights[0].direction), 0.0, 1.0), 3.0);
          reflectedLight.directDiffuse += directionalLights[0].color * diffuseColor.rgb * vec3(0.9, 1.1, 0.5) * gzBack * 0.35;
        #endif`)
      // uplights under the square's trees: the lower crown glows warm from below, the undersides most
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.82, 0.55) * vGzUp * uNight * (1.8 + 2.0 * clamp(-normal.y, 0.0, 1.0));`);
  };
  m.customProgramCacheKey = () => 'gz-tree-leaves';
  return m;
}

/** Bark: the lotus-pond recipe in a shader -- vertical fissures (stretched cell edges), mottling, lichen. */
export function barkMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    fogUniforms(shader);
    shader.uniforms.uNight = GZ.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBark; varying float vGzUp;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBark = position;
        #ifdef USE_INSTANCING
          vGzUp = ${UPLIT} * (1.0 - smoothstep(0.0, 3.5, position.y));
        #else
          vGzUp = 0.0;
        #endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vBark; uniform float uNight; varying float vGzUp;
        float bh(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
        float bn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(bh(i), bh(i + vec2(1, 0)), f.x), mix(bh(i + vec2(0, 1)), bh(i + 1.0), f.x), f.y); }
        float bEdge(vec2 p) { vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) { vec2 g = vec2(x, y); vec2 o = vec2(bh(i + g), bh(i + g + 7.1));
            float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
          return d2 - d1; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float ang = atan(vBark.z, vBark.x);
        vec2 bp = vec2(ang * 2.2, vBark.y * 1.4);
        float fis = 1.0 - smoothstep(0.0, 0.12, bEdge(bp * vec2(1.0, 0.35)));
        float mot = bn(bp * 3.0) * 0.6 + bn(bp * 9.0) * 0.4;
        diffuseColor.rgb *= (0.78 + 0.44 * mot) * (1.0 - 0.45 * fis);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.33, 0.24), smoothstep(0.62, 0.8, bn(bp * 1.3 + 4.0)) * 0.45);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.78, 0.5) * vGzUp * vGzUp * uNight * 0.8;`);
  };
  m.customProgramCacheKey = () => 'gz-tree-bark';
  return m;
}

/**
 * Distance LOD in the vertex shader: `near` meshes collapse instances beyond `r1`, `far` meshes collapse
 * instances closer than `r0` (both keyed on the instance origin), so the two versions hand over without
 * rebuilding instance buffers. Chains any onBeforeCompile the material already has.
 */
export function lodCollapse(m: THREE.Material, mode: 'near' | 'far', r0: number, r1: number): THREE.Material {
  const prev = m.onBeforeCompile.bind(m);
  const key = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #ifdef USE_INSTANCING
        float lodD = distance((modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz, cameraPosition);
        ${mode === 'near' ? `if (lodD > ${r1.toFixed(1)}) transformed *= 0.0;` : `if (lodD < ${r0.toFixed(1)}) transformed *= 0.0;`}
      #endif
      #include <project_vertex>`);
  };
  m.customProgramCacheKey = () => key() + '-lod-' + mode;
  return m;
}

let cache: Map<string, TreeProto> | null = null;
/** Near-LOD prototypes keyed like the Blender ones: 'banyan', 'kapok', 'royal palm'. */
export function treeProtos(): Map<string, TreeProto> {
  cache ??= new Map([['banyan', banyan()], ['kapok', kapok()], ['royal palm', palm()]]);
  return cache;
}
