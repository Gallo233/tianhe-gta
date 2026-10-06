import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GZ } from '../world/Materials';
import { fogUniforms } from '../world/Sky';

/**
 * Vehicle GLBs from the Blender kit: ~85 meshes, 11-12 flat materials (no textures), and four
 * "axle pivot" nodes (extras spin_axis = 'X', radius_m) at the wheel centres.
 *
 * Every material folds into one of five classes -- paint, metal, glass, matte, lamp -- with its own
 * colour baked into vertex colours, so a car is 5 body meshes + 4 wheels x ~2 meshes. Two ways to draw it:
 *
 *  - vehicleTemplate().group: a normal Object3D (drivable cars, a car the player steals). Wheels are
 *      wheel steer group (at the wheel centre; yaw = steering)  -> userData.wheel = { front, radius }
 *        wheel spin group (rotation.x = rolling)
 *  - VehicleInstances: every traffic car of every model in ~36 draw calls total (InstancedMesh per
 *    model x class, wheels per model x side x class), with a per-car paint colour.
 */
export type PartClass = 'paint' | 'metal' | 'glass' | 'matte' | 'lamp';

export interface WheelSpec {
  pos: THREE.Vector3;      // wheel centre in the car's frame
  front: boolean;
  left: boolean;
  radius: number;
  parts: Map<PartClass, THREE.BufferGeometry>;   // in the wheel's own frame (spin about X)
}

export interface VehicleTemplate {
  group: THREE.Group;
  half: THREE.Vector2;     // half width (x) / half length (z)
  body: Map<PartClass, THREE.BufferGeometry>;
  wheels: WheelSpec[];
  paint: THREE.Color;
  localBox: number[];
  colors: Map<string, THREE.Color>;   // material name -> colour (the far LOD reuses these)
  far?: Map<PartClass, THREE.BufferGeometry>;   // decimated body+wheels for distant instanced traffic
  livery: boolean;         // fixed colours (taxi, police, bus): paint is not recoloured per car
}

export interface Wheel {
  steer: THREE.Object3D;
  spin: THREE.Object3D;
  front: boolean;
  radius: number;
}

function classify(m: THREE.MeshStandardMaterial): PartClass {
  // the Guangzhou kit (gz_vehicles.py) says what each material is; older kits are inferred
  const tag = m.userData?.gz_class as string | undefined;
  if (tag) return tag === 'livery' ? 'paint' : tag as PartClass;
  if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.01) return 'lamp';
  if (/glaz|glass/i.test(m.name)) return 'glass';
  if (m.metalness >= 0.8) return 'metal';
  if (m.metalness > 0.6 && m.roughness < 0.3) return 'paint';
  return 'matte';
}

/**
 * Lamp kinds travel in the lamp vertex colour's alpha; the lamp shader turns them into day/night
 * brightness (headlamps and tail lamps light up at night, DRLs always), taxi and bus signs, and the
 * alternating red/blue police flash.
 */
const LAMP_KIND: Record<string, number> = { head: 0.0, drl: 0.1, tail: 0.2, amber: 0.3, sign: 0.4, police_r: 0.6, police_b: 0.8 };

function lampMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    fogUniforms(shader);
    shader.uniforms.uNight = GZ.uNight;
    shader.uniforms.uTime = GZ.uTime;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight; uniform float uTime;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef USE_COLOR_ALPHA
          float kind = vColor.a;
          float n = uNight;
          float k = 1.0;
          if (kind < 0.05) k = mix(1.1, 7.0, n);                         // headlamp
          else if (kind < 0.15) k = 3.2;                                 // DRL strip
          else if (kind < 0.25) k = mix(0.7, 3.4, n);                    // tail
          else if (kind < 0.35) k = mix(0.5, 0.8, n);                    // amber (off)
          else if (kind < 0.5) k = mix(1.0, 2.6, n);                     // taxi / bus sign
          else {                                                         // police: red and blue alternate, double flash
            float t = uTime * 2.2 + (kind > 0.7 ? 0.5 : 0.0);
            float ph = fract(t);
            float on = step(ph, 0.12) + step(0.2, ph) * step(ph, 0.32);
            k = mix(0.25, 9.0, clamp(on, 0.0, 1.0));
          }
          diffuseColor.rgb *= k;
          diffuseColor.a = 1.0;
        #endif`);
  };
  m.customProgramCacheKey = () => 'gz-vehicle-lamp';
  return m;
}

// shared materials; paint is per model for normal groups (its colour lives in the material) and
// white-with-instance-colour for the instanced traffic
const MATS: Partial<Record<PartClass, THREE.Material>> = {};
function sharedMat(c: Exclude<PartClass, 'paint'>): THREE.Material {
  return (MATS[c] ??= c === 'lamp'
    ? lampMaterial()
    : new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: c === 'metal' ? 0.9 : c === 'glass' ? 0.0 : 0.02,
      roughness: c === 'metal' ? 0.28 : c === 'glass' ? 0.04 : 0.62,
      envMapIntensity: c === 'glass' ? 1.6 : 1.0,
    }));
}
const paintMats = new Map<string, THREE.MeshPhysicalMaterial>();
function paintMat(color: THREE.Color, vertexColors = false): THREE.MeshPhysicalMaterial {
  const k = color.getHexString() + (vertexColors ? 'v' : '');
  let m = paintMats.get(k);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.06, vertexColors });
    paintMats.set(k, m);
  }
  return m;
}
let instancedPaint: THREE.MeshPhysicalMaterial | null = null;

function mergeByClass(meshes: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[], colorByName?: Map<string, THREE.Color>, livery = false): { parts: Map<PartClass, THREE.BufferGeometry>; paint: THREE.Color | null } {
  const byCls = new Map<PartClass, THREE.BufferGeometry[]>();
  let paint: THREE.Color | null = null;
  for (const { mesh, matrix } of meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    const cls = classify(mat);
    const geo = mesh.geometry.clone().applyMatrix4(matrix);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    if (!geo.index) geo.setIndex([...Array(geo.attributes.position.count).keys()]);
    const base = colorByName?.get(mat.name) ?? mat.color;
    const fixed = livery || mat.userData?.gz_class === 'livery';
    // recolourable paint carries white (its colour is the material's or the instance's); a livery keeps its own
    let c: THREE.Color;
    if (cls === 'paint') c = fixed ? base.clone() : new THREE.Color(1, 1, 1);
    else if (cls === 'lamp') c = mat.userData?.gz_lamp ? base.clone() : mat.emissive.clone().lerp(base, 0.5).multiplyScalar(1.6);
    else c = base;
    if (cls === 'paint' && !fixed) paint = mat.color.clone();
    const n = geo.attributes.position.count;
    const lamp = cls === 'lamp';
    const size = lamp ? 4 : 3;
    const kind = LAMP_KIND[mat.userData?.gz_lamp as string] ?? 0.1;
    const cols = new Float32Array(n * size);
    for (let i = 0; i < n; i++) {
      cols[i * size] = c.r; cols[i * size + 1] = c.g; cols[i * size + 2] = c.b;
      if (lamp) cols[i * size + 3] = kind;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, size));
    if (!byCls.has(cls)) byCls.set(cls, []);
    byCls.get(cls)!.push(geo);
  }
  const parts = new Map<PartClass, THREE.BufferGeometry>();
  for (const [cls, geos] of byCls) {
    const merged = mergeGeometries(geos, false);
    if (merged) parts.set(cls, merged);
  }
  if (livery) paint = new THREE.Color(1, 1, 1);
  return { parts, paint };
}

function meshesFor(parts: Map<PartClass, THREE.BufferGeometry>, paint: THREE.Color, into: THREE.Object3D, livery = false): void {
  for (const [cls, geo] of parts) {
    const m = new THREE.Mesh(geo, cls === 'paint' ? paintMat(paint, livery) : sharedMat(cls));
    m.castShadow = cls !== 'lamp'; m.receiveShadow = true;
    into.add(m);
  }
}

export function vehicleTemplate(g: GLTF): VehicleTemplate {
  g.scene.updateMatrixWorld(true);
  const pivots: THREE.Object3D[] = [];
  g.scene.traverse((o) => { if (o.userData.spin_axis) pivots.push(o); });
  const underPivot = new Map<THREE.Mesh, THREE.Object3D>();
  for (const p of pivots) p.traverse((o) => { if ((o as THREE.Mesh).isMesh) underPivot.set(o as THREE.Mesh, p); });

  const bodyMeshes: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
  g.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !underPivot.has(m)) bodyMeshes.push({ mesh: m, matrix: m.matrixWorld });
  });
  let livery = false;
  g.scene.traverse((o) => { if (o.userData.gz_livery) livery = true; });
  const { parts: body, paint: bodyPaint } = mergeByClass(bodyMeshes, undefined, livery);
  const paint = bodyPaint ?? new THREE.Color(0.6, 0.6, 0.6);

  const group = new THREE.Group();
  meshesFor(body, paint, group, livery);
  const wheels: WheelSpec[] = [];
  for (const p of pivots) {
    const inv = p.matrixWorld.clone().invert();
    const list: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
    for (const [mesh, owner] of underPivot) if (owner === p) list.push({ mesh, matrix: inv.clone().multiply(mesh.matrixWorld) });
    const { parts } = mergeByClass(list, undefined, livery);
    const pos = new THREE.Vector3().setFromMatrixPosition(p.matrixWorld);
    const spec: WheelSpec = { pos, front: pos.z < 0, left: pos.x < 0, radius: Number(p.userData.radius_m) || 0.36, parts };
    wheels.push(spec);
    const steer = new THREE.Group();
    steer.position.copy(pos);
    const spin = new THREE.Group();
    spin.name = 'wheel-spin';
    steer.add(spin);
    meshesFor(parts, paint, spin, livery);
    steer.userData.wheel = { front: spec.front, radius: spec.radius };
    group.add(steer);
  }

  const box = new THREE.Box3().setFromObject(group);
  const localBox = [...box.min.toArray(), ...box.max.toArray()];
  group.userData.localBox = localBox;   // survives clone(); used for camera occlusion
  const colors = new Map<string, THREE.Color>();
  g.scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m?.name) colors.set(m.name, m.color.clone()); });
  return { group, half: new THREE.Vector2((box.max.x - box.min.x) / 2, (box.max.z - box.min.z) / 2), body, wheels, paint, localBox, colors, livery };
}

/**
 * Attach the far LOD (vehicle_<model>_lod2.glb, ~5k triangles, wheels merged into the body) to a
 * template. Colours come from the full model by material name: Blender exports procedural materials
 * (the tyre rubber) as white.
 */
export function attachFarLod(t: VehicleTemplate, lod: GLTF): void {
  lod.scene.updateMatrixWorld(true);
  const meshes: { mesh: THREE.Mesh; matrix: THREE.Matrix4 }[] = [];
  lod.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) meshes.push({ mesh: m, matrix: m.matrixWorld }); });
  t.far = mergeByClass(meshes, t.colors, t.livery).parts;
}

/** A fresh drivable copy of a template, optionally in another paint colour. */
export function vehicleGroup(t: VehicleTemplate, paint?: THREE.Color): THREE.Group {
  const g = t.group.clone();
  if (paint && !paint.equals(t.paint) && !t.livery) {
    const from = paintMat(t.paint), to = paintMat(paint);
    g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.material === from) m.material = to; });
  }
  return g;
}

/** Wheels of a (cloned) vehicle group; clones keep userData, so this works on any copy. */
export function wheelsOf(obj: THREE.Object3D): Wheel[] {
  const out: Wheel[] = [];
  for (const c of obj.children) {
    const w = c.userData.wheel as { front: boolean; radius: number } | undefined;
    if (w) out.push({ steer: c, spin: c.getObjectByName('wheel-spin')!, front: w.front, radius: w.radius });
  }
  return out;
}

/** Roll every wheel by `distance` metres (negative = reversing); front wheels take `steer` radians of yaw. */
export function rollWheels(wheels: Wheel[], distance: number, steer = 0): void {
  for (const w of wheels) {
    // model forward is -Z: rolling forward turns the wheel top toward -Z, a negative rotation about +X
    w.spin.rotation.x -= distance / w.radius;
    if (w.front) w.steer.rotation.y = steer;
  }
}

// ------------------------------------------------------------------------------ instanced traffic
/**
 * All traffic cars in a handful of draw calls. Instances are repacked every frame: between `begin()`
 * and `end()` each visible car is `draw()`n into either the full-detail set (body + separately rolling
 * wheels) or the far set (decimated LOD, wheels merged), and every InstancedMesh's `count` is set to
 * what was written -- a zero-scaled "hidden" instance would still cost its whole vertex workload.
 */
export class VehicleInstances {
  readonly group = new THREE.Group();
  private readonly body: THREE.InstancedMesh[][] = [];            // [model][class]
  private readonly far: THREE.InstancedMesh[][] = [];             // [model][class], decimated LOD
  private readonly wheel: { left: boolean; meshes: THREE.InstancedMesh[] }[][] = [];   // [model][side]
  private readonly nNear: number[];
  private readonly nFar: number[];
  private readonly m = new THREE.Matrix4();
  private readonly w = new THREE.Matrix4();
  private readonly r = new THREE.Matrix4();

  constructor(private readonly temps: VehicleTemplate[], capacity: number[]) {
    this.group.name = 'traffic-instances';
    instancedPaint ??= new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0.45, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.06, vertexColors: true });
    this.nNear = temps.map(() => 0);
    this.nFar = temps.map(() => 0);
    temps.forEach((t, mi) => {
      const cap = Math.max(1, capacity[mi] ?? 0);
      const make = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;                                   // instances span the whole city
        im.castShadow = mat.type !== 'MeshBasicMaterial'; im.receiveShadow = true;
        im.count = 0;
        this.group.add(im);
        return im;
      };
      const level = (parts: Map<PartClass, THREE.BufferGeometry>) => [...parts].map(([cls, geo]) => {
        const im = make(geo, cls === 'paint' ? instancedPaint! : sharedMat(cls), cap);
        if (cls === 'paint') { im.setColorAt(0, t.paint); im.instanceColor!.setUsage(THREE.DynamicDrawUsage); }
        return im;
      });
      this.body[mi] = level(t.body);
      this.far[mi] = t.far ? level(t.far) : [];
      for (const im of this.far[mi]) im.castShadow = false;       // distant traffic: no shadow-pass cost
      // one wheel geometry per side (hub caps face outwards), two instances per side per car
      this.wheel[mi] = [true, false].map((left) => {
        const spec = t.wheels.find((w) => w.left === left) ?? t.wheels[0];
        return { left, meshes: [...spec.parts].map(([cls, geo]) => make(geo, sharedMat(cls === 'paint' ? 'metal' : cls), cap * 2)) };
      });
    });
  }

  begin(): void {
    this.nNear.fill(0);
    this.nFar.fill(0);
  }

  /**
   * One car: transform from `obj`, wheels rolled by `roll` metres travelled, front wheels steered
   * `steer`, body `paint`. `far` uses the decimated LOD when the model has one.
   */
  draw(model: number, obj: THREE.Object3D, paint: THREE.Color, roll: number, steer: number, far: boolean): void {
    obj.updateMatrix();
    if (far && this.far[model].length) {
      const i = this.nFar[model]++;
      for (const im of this.far[model]) { im.setMatrixAt(i, obj.matrix); if (im.instanceColor) im.setColorAt(i, paint); }
      return;
    }
    const i = this.nNear[model]++;
    for (const im of this.body[model]) { im.setMatrixAt(i, obj.matrix); if (im.instanceColor) im.setColorAt(i, paint); }
    const t = this.temps[model];
    for (const side of this.wheel[model]) {
      let k = 0;
      for (const ws of t.wheels) {
        if (ws.left !== side.left) continue;
        this.w.makeTranslation(ws.pos.x, ws.pos.y, ws.pos.z);
        if (ws.front) this.w.multiply(this.r.makeRotationY(steer));
        this.w.multiply(this.r.makeRotationX(-roll / ws.radius));        // same sign as rollWheels
        this.m.multiplyMatrices(obj.matrix, this.w);
        for (const im of side.meshes) im.setMatrixAt(i * 2 + k, this.m);
        k++;
      }
    }
  }

  end(): void {
    this.temps.forEach((_, mi) => {
      const upd = (im: THREE.InstancedMesh, n: number) => {
        im.count = n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      };
      for (const im of this.body[mi]) upd(im, this.nNear[mi]);
      for (const im of this.far[mi]) upd(im, this.nFar[mi]);
      for (const side of this.wheel[mi]) for (const im of side.meshes) upd(im, this.nNear[mi] * 2);
    });
  }
}

// ------------------------------------------------------------------------------ camera occlusion
const ray = new THREE.Ray();
const box = new THREE.Box3();
const inv = new THREE.Matrix4();
const hitP = new THREE.Vector3();

/** Distance along a world ray to a vehicle's body box, or Infinity. */
export function raycastVehicle(obj: THREE.Object3D, origin: THREE.Vector3, dir: THREE.Vector3, max: number): number {
  const b = obj.userData.localBox as number[] | undefined;
  if (!b || obj.position.distanceTo(origin) > max + 7) return Infinity;
  obj.updateMatrixWorld();
  inv.copy(obj.matrixWorld).invert();
  ray.set(origin, dir).applyMatrix4(inv);
  box.min.fromArray(b, 0); box.max.fromArray(b, 3);
  if (!ray.intersectBox(box, hitP)) return Infinity;
  return hitP.applyMatrix4(obj.matrixWorld).distanceTo(origin);
}
