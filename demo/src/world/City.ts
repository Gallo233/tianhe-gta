import * as THREE from 'three';
import { Carriageway } from './Carriageway';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { rebuild } from './Materials';
import { barkMaterial, leafMaterial, lodCollapse, treeProtos } from './Trees';

const BASE = 'assets/tianhe/';

import { fromBlender } from '../config';
export { fromBlender };

export interface RoadGraph {
  nodes: [number, number, number][];
  edges: { a: number; b: number; hw: string; w: number; name: string | null; fwd: number; back: number; bridge: boolean; pts: [number, number, number][] }[];
}
export interface Footprint { o: [number, number][]; h: [number, number][][]; z: number; lm: string | null }
interface InstanceSet { proto: string; count: number; pos: number[]; rot: number[]; scale: number[] }

export interface CityData {
  root: THREE.Group;
  roads: RoadGraph;
  footprints: Footprint[];
  meta: { bounds_m: [number, number, number, number]; license: string };
  chunks: { mesh: THREE.InstancedMesh; center: THREE.Vector3; maxDist: number }[];
  /** trees: [near-LOD instances, far-LOD instances] */
  trees: { near: number; far: number };
  /** tree trunks, Blender (x, y, z) -- street furniture puts grates under the ones by the road */
  treePos: [number, number, number][];
  /** trunk collision radius per tree (m), same order as treePos */
  treeR: number[];
  /** Street-lamp heads (three.js coordinates) for the real lights near the camera. */
  lamps: THREE.Vector3[];
  /** Street-lamp pole bases, Blender (x, y, z) -- colliders and QA. */
  lampPoles: [number, number, number][];
  /** "is this spot on a road" (Blender coordinates) */
  carriageway: Carriageway;
  /** lamps and trees dropped at load because they stood in a carriageway */
  dropped: { lamps: number; trees: number };
}

// lamp prototypes (gz_city.lamp_protos): head centre = arm + 0.35 m out along local +x, 0.2 m under the top
const LAMP_HEAD: Record<string, [number, number]> = { tall: [2.55, 10.8], short: [1.65, 7.3], mast: [0.8, 12.6] };   // mast: Huacheng Square

const CHUNK = 400;
const NEAR_CHUNK = 100;
// tree LOD: card trees near the camera, the Blender low-poly crowns beyond (vertex-shader handover)
const TREE_NEAR = 230, TREE_FAR = 210;

export async function loadCity(onProgress: (f: number, what: string) => void): Promise<CityData> {
  const draco = new DRACOLoader().setDecoderPath('draco/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  const groups = ['ground', 'water', 'buildings', 'landmarks', 'backdrop', 'props'] as const;
  const weights = [0.18, 0.01, 0.2, 0.18, 0.4, 0.03];
  const prog = groups.map(() => 0);
  const report = (w: string) => onProgress(prog.reduce((s, p, i) => s + p * weights[i], 0), w);
  const glbs = await Promise.all(groups.map((g, i) => new Promise<GLTF>((res, rej) =>
    loader.load(BASE + g + '.glb', res, (e) => { if (e.total) { prog[i] = e.loaded / e.total; report(g); } }, rej))));
  const [roads, footprints, inst, meta] = await Promise.all(
    ['roads.json', 'footprints.json', 'instances.json', 'meta.json'].map((f) => fetch(BASE + f).then((r) => r.json())));
  // lamps and trees are placed per road in Blender; the ones that ended up in another road's lanes go
  const carriageway = new Carriageway(roads);
  const dropped = { lamps: 0, trees: 0 };
  for (const set of Object.values(inst as Record<string, InstanceSet>)) {
    const lamp = /lamp/i.test(set.proto), tree = /tree/i.test(set.proto);
    if (!lamp && !tree) continue;
    const keep: number[] = [];
    for (let i = 0; i < set.count; i++) if (!carriageway.contains(set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2], lamp ? 0.15 : 0.3)) keep.push(i);
    if (lamp) dropped.lamps += set.count - keep.length; else dropped.trees += set.count - keep.length;
    set.pos = keep.flatMap((i) => [set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2]]);
    set.rot = keep.map((i) => set.rot[i]);
    set.scale = keep.map((i) => set.scale[i]);
    set.count = keep.length;
  }
  const root = new THREE.Group();
  root.name = 'Tianhe';
  const cache = new Map<THREE.Material, THREE.Material>();
  const swap = (m: THREE.Material) => { if (!cache.has(m)) cache.set(m, rebuild(m)); return cache.get(m)!; };
  glbs.forEach((g, i) => {
    const name = groups[i];
    if (name === 'props') return;
    g.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
      const geo = mesh.geometry as THREE.BufferGeometry;
      // baked texture kits sit on per-facet UVs: they need real tangents (derivative tangents flip at seams)
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.some((m) => (m as THREE.MeshStandardMaterial).normalMap && m.userData?.gz_tex) && !geo.getAttribute('tangent') &&
          geo.index && geo.getAttribute('uv') && geo.getAttribute('normal')) geo.computeTangents();
      // facade shader reads COLOR_0 (tint rgb, random a); give untinted meshes a neutral one
      if (!geo.getAttribute('color')) {
        const n = geo.getAttribute('position').count;
        const c = new Float32Array(n * 4);
        for (let k = 0; k < n; k++) { c[k * 4] = c[k * 4 + 1] = c[k * 4 + 2] = 1; c[k * 4 + 3] = 0.5; }
        geo.setAttribute('color', new THREE.BufferAttribute(c, 4));
      }
      const far = name === 'backdrop';
      mesh.castShadow = !far && name !== 'ground' && name !== 'water';
      mesh.receiveShadow = !far;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    });
    g.scene.name = name;
    root.add(g.scene);
  });
  // prototypes -> chunked InstancedMeshes (trees culled beyond ~1.6 km, lamps beyond ~1.2 km)
  const protos = new Map<string, THREE.Mesh[]>();
  const propScene = glbs[groups.indexOf('props')].scene;
  propScene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // a multi-material prototype is one node with a child mesh per material: group by the top node
    let p: THREE.Object3D = mesh;
    while (p.parent && p.parent !== propScene) p = p.parent;
    const key = p.name.replace(/_/g, ' ');
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    if (!protos.has(key)) protos.set(key, []);
    protos.get(key)!.push(mesh);
  });
  const chunks: CityData['chunks'] = [];
  const props = new THREE.Group(); props.name = 'props';
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();
  const lamps: THREE.Vector3[] = [];
  const lampPoles: [number, number, number][] = [];
  const near = treeProtos();
  const nearMats = { bark: lodCollapse(barkMaterial(), 'near', 0, TREE_NEAR), leaves: lodCollapse(leafMaterial(), 'near', 0, TREE_NEAR) };
  const farMats = new Map<THREE.Material, THREE.Material>();
  const farOf = (m: THREE.Material) => { if (!farMats.has(m)) farMats.set(m, lodCollapse(m.clone(), 'far', TREE_FAR, 0)); return farMats.get(m)!; };
  const treeCount = { near: 0, far: 0 };
  const treePos: [number, number, number][] = [];
  const treeR: number[] = [];
  // Huacheng Square's masts last: every other lamp keeps its index (QA picks posts by index)
  const sets = Object.values(inst as Record<string, InstanceSet>).sort((a, b) => Number(/mast/.test(a.proto)) - Number(/mast/.test(b.proto)));
  for (const set of sets) {
    const head = LAMP_HEAD[set.proto.split('|').pop()!.trim()];
    if (/lamp/i.test(set.proto) && head) {
      for (let i = 0; i < set.count; i++) {
        const r = set.rot[i];
        lamps.push(fromBlender(set.pos[i * 3] + Math.cos(r) * head[0], set.pos[i * 3 + 1] + Math.sin(r) * head[0], set.pos[i * 3 + 2] + head[1]));
        lampPoles.push([set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2]]);
      }
    }
    const protoKey = [...protos.keys()].find((k) => k.toLowerCase().replace(/\s+/g, ' ').includes(set.proto.toLowerCase().split('|').pop()!.trim()));
    const parts = protoKey ? protos.get(protoKey)! : [];
    if (!parts.length) { console.warn('no proto for', set.proto); continue; }
    const isTree = /tree/i.test(set.proto);
    const species = set.proto.split('|').pop()!.trim();
    const nearProto = isTree ? near.get(species) : undefined;
    // trunk radius: banyans are thick (and carry aerial roots), kapok medium, royal palms slim
    const trunk = /banyan/i.test(species) ? 0.45 : /kapok/i.test(species) ? 0.35 : 0.3;
    if (isTree) for (let i = 0; i < set.count; i++) { treePos.push([set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2]]); treeR.push(trunk * (set.scale[i] || 1)); }
    const place = (idx: number[], build: (geo: THREE.BufferGeometry, mat: THREE.Material, leaves: boolean) => THREE.InstancedMesh, list: { geo: THREE.BufferGeometry; mat: THREE.Material; leaves: boolean }[], maxDist: number) => {
      const center = new THREE.Vector3();
      for (const i of idx) center.add(fromBlender(set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2]));
      center.divideScalar(idx.length);
      for (const part of list) {
        const im = build(part.geo, part.mat, part.leaves);
        idx.forEach((i, j) => {
          const p = fromBlender(set.pos[i * 3], set.pos[i * 3 + 1], set.pos[i * 3 + 2]);
          q.setFromAxisAngle(up, set.rot[i]);
          s.setScalar(set.scale[i]);
          m4.compose(p, q, s);
          im.setMatrixAt(j, m4);
          if (isTree && part.leaves) im.setColorAt(j, color.setHSL(0.25 + 0.05 * Math.sin(i * 12.9898), 0.35, 0.75 + 0.25 * Math.sin(i * 78.233)));
        });
        im.computeBoundingSphere();
        props.add(im);
        chunks.push({ mesh: im, center, maxDist });
      }
    };
    const group = (size: number) => {
      const byChunk = new Map<string, number[]>();
      for (let i = 0; i < set.count; i++) {
        const k = `${Math.floor(set.pos[i * 3] / size)},${Math.floor(set.pos[i * 3 + 1] / size)}`;
        if (!byChunk.has(k)) byChunk.set(k, []);
        byChunk.get(k)!.push(i);
      }
      return [...byChunk.values()];
    };
    for (const idx of group(CHUNK)) {
      place(idx, (geo, mat) => {
        const im = new THREE.InstancedMesh(geo, mat, idx.length);
        im.castShadow = isTree && !nearProto; im.receiveShadow = true;
        return im;
      }, parts.map((p) => ({ geo: p.geometry, mat: nearProto ? farOf(p.material as THREE.Material) : p.material as THREE.Material, leaves: /leaves|fronds/i.test((p.material as THREE.Material).name) })),
      isTree ? 1600 : 1200);
      if (isTree) treeCount.far += idx.length;
    }
    if (nearProto) {
      for (const idx of group(NEAR_CHUNK)) {
        place(idx, (geo, mat) => {
          const im = new THREE.InstancedMesh(geo, mat, idx.length);
          im.castShadow = true; im.receiveShadow = true;
          return im;
        }, [{ geo: nearProto.bark, mat: nearMats.bark, leaves: false }, { geo: nearProto.leaves, mat: nearMats.leaves, leaves: true }], TREE_NEAR + 70);
        treeCount.near += idx.length;
      }
    }
  }
  root.add(props);
  draco.dispose();
  return { root, roads, footprints, meta, chunks, lamps, lampPoles, trees: treeCount, treePos, treeR, carriageway, dropped };
}

/** Hide instance chunks far from the camera (they are sub-pixel and dominate the triangle count). */
export function cullChunks(chunks: CityData['chunks'], cam: THREE.Vector3): void {
  for (const c of chunks) c.mesh.visible = c.center.distanceTo(cam) < c.maxDist;
}
