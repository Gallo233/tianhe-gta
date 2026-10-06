import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';

/**
 * Static world collision: one merged, world-space triangle soup with a BVH.
 * Characters use a floating capsule (it starts a step-height above the feet) for walls and a
 * downward ray for the ground, so curbs and stairs lower than the step are walked over, not into.
 */
export class Collision {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  readonly triangles: number;
  private readonly box = new THREE.Box3();
  private readonly triPoint = new THREE.Vector3();
  private readonly segPoint = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly ray = new THREE.Ray();

  constructor(sources: THREE.Object3D[]) {
    const parts: THREE.BufferGeometry[] = [];
    for (const root of sources) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData.noCollide) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', mesh.geometry.getAttribute('position').clone());
        if (mesh.geometry.index) g.setIndex(mesh.geometry.index.clone());
        g.applyMatrix4(mesh.matrixWorld);
        parts.push(g.index ? g : g);
      });
    }
    const indexed = parts.map((g) => (g.index ? g : indexify(g)));
    this.geometry = mergeGeometries(indexed, false)!;
    for (const g of parts) g.dispose();
    this.bvh = new MeshBVH(this.geometry, { targetLeafSize: 12 });
    this.triangles = this.geometry.index!.count / 3;
  }

  /**
   * Push a capsule (segment + radius) out of the world. Mutates `segment` in place and
   * returns the total correction vector.
   */
  resolveCapsule(segment: THREE.Line3, radius: number, out: THREE.Vector3): THREE.Vector3 {
    const start = segment.start.clone();
    this.box.makeEmpty().expandByPoint(segment.start).expandByPoint(segment.end);
    this.box.min.addScalar(-radius);
    this.box.max.addScalar(radius);
    for (let pass = 0; pass < 2; pass++) {
      this.bvh.shapecast({
        intersectsBounds: (b: THREE.Box3) => b.intersectsBox(this.box),
        intersectsTriangle: (tri: ExtendedTriangle) => {
          const d = tri.closestPointToSegment(segment, this.triPoint, this.segPoint);
          if (d < radius) {
            const depth = radius - d;
            this.dir.subVectors(this.segPoint, this.triPoint);
            if (this.dir.lengthSq() < 1e-10) tri.getNormal(this.dir);
            this.dir.normalize();
            segment.start.addScaledVector(this.dir, depth);
            segment.end.addScaledVector(this.dir, depth);
          }
          return false;
        },
      });
    }
    return out.subVectors(segment.start, start);
  }

  /** Highest ground hit below `origin` within `maxDist`; returns the hit y or null. */
  groundHeight(origin: THREE.Vector3, maxDist: number): number | null {
    this.ray.origin.copy(origin);
    this.ray.direction.set(0, -1, 0);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, maxDist);
    if (!hit) return null;
    // Reject near-vertical faces as ground (walls grazed by the ray).
    if (hit.face && Math.abs(hit.face.normal.y) < 0.55) return null;
    return hit.point.y;
  }

  /** Distance to the first hit along a ray, or Infinity. Used by the camera spring arm. */
  raycastDistance(origin: THREE.Vector3, direction: THREE.Vector3, far: number): number {
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction);
    const hit = this.bvh.raycastFirst(this.ray, THREE.DoubleSide, 0, far);
    return hit ? hit.distance : Infinity;
  }
}

function indexify(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
