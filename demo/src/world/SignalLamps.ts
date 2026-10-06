import * as THREE from 'three';
import type { Light, RoadNet } from './RoadNet';
import type { Carriageway } from './Carriageway';

/**
 * A signal pole at the right-hand kerb of every approach to a signalled junction, facing the oncoming
 * traffic, with red / amber / green lenses driven by the same phase clock the cars obey. All poles and
 * lenses are instanced (a few draw calls for ~2,000 heads); a lens that is off is scaled to zero.
 */
const LENS_Y: Record<Light, number> = { red: 5.25, amber: 4.9, green: 4.55 };
const DRAW_M = 350;
const LENS_COL: Record<Light, string> = { red: '#ff3b2f', amber: '#ffb020', green: '#38ff7a' };

interface Head { node: number; group: number; m: THREE.Matrix4 }

export class SignalLamps {
  readonly group = new THREE.Group();
  private readonly heads: Head[] = [];
  private readonly lenses: Record<Light, THREE.InstancedMesh>;
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly pole: THREE.InstancedMesh;
  private t = 0;

  constructor(private readonly roads: RoadNet, carriageway?: Carriageway) {
    this.group.name = 'signal-lamps';
    const seen = new Set<string>();
    for (const lane of roads.lanes) {
      const node = lane.to;
      if (!node.signal || lane.index !== lane.count - 1) continue;        // one head per approach, on the rightmost lane
      const k = `${node.id}:${lane.edge}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const end = lane.path.pts[lane.path.pts.length - 1];
      const d = lane.dirIn;                                               // travel direction (three.js xz)
      const right = new THREE.Vector2(-d.y, d.x);                         // right of travel in three.js xz
      // at the kerb, pushed further out if that spot is in the crossing road's lanes
      // (on a traffic island or the far kerb in a tight junction: no clear spot within 8 m -> no pole there)
      let off = lane.width / 2 + 1.6;
      const blocked = (o: number) => carriageway?.contains(end.x + right.x * o, -(end.z + right.y * o), end.y, 0.25) ?? false;
      while (off < lane.width / 2 + 8 && blocked(off)) off += 0.6;
      if (blocked(off)) continue;
      const pos = new THREE.Vector3(end.x + right.x * off, end.y + 0.14, end.z + right.y * off);
      const m = new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(d.x, d.y)), new THREE.Vector3(1, 1, 1));
      this.heads.push({ node: node.id, group: lane.group, m });
    }
    const n = this.heads.length;
    const pole = new THREE.InstancedMesh(poleGeometry(), new THREE.MeshStandardMaterial({ color: '#3a3f44', roughness: 0.5, metalness: 0.6 }), n);
    pole.castShadow = true;
    pole.frustumCulled = false;
    pole.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pole = pole;
    this.heads.forEach((h, i) => pole.setMatrixAt(i, h.m));
    this.group.add(pole);
    const lensGeo = new THREE.SphereGeometry(0.11, 6, 4);
    this.lenses = {} as Record<Light, THREE.InstancedMesh>;
    for (const l of Object.keys(LENS_Y) as Light[]) {
      const g = lensGeo.clone().translate(0, LENS_Y[l], -0.2);
      const im = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial({ color: LENS_COL[l], toneMapped: false }), n);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      this.lenses[l] = im;
      this.group.add(im);
    }
    this.update(1);
  }

  /** Pole bases (three.js), for the colliders. */
  poles(): THREE.Vector3[] {
    return this.heads.map((h) => new THREE.Vector3().setFromMatrixPosition(h.m));
  }

  /** `viewer`: only heads within DRAW_M are drawn (compacted to the front of the instance buffers). */
  update(dt: number, viewer?: THREE.Vector3): void {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.2;
    const p = new THREE.Vector3();
    let k = 0;
    for (const h of this.heads) {
      p.setFromMatrixPosition(h.m);
      if (viewer && p.distanceToSquared(viewer) > DRAW_M * DRAW_M) continue;
      this.pole.setMatrixAt(k, h.m);
      const on = this.roads.light(this.roads.nodes[h.node], h.group);
      for (const l of Object.keys(this.lenses) as Light[]) this.lenses[l].setMatrixAt(k, l === on ? h.m : this.zero);
      k++;
    }
    this.pole.count = k;
    this.pole.instanceMatrix.needsUpdate = true;
    for (const l of Object.values(this.lenses)) { l.count = k; l.instanceMatrix.needsUpdate = true; }
  }

  get count(): number { return this.heads.length; }
}

function poleGeometry(): THREE.BufferGeometry {
  const post = new THREE.CylinderGeometry(0.09, 0.12, 5.6, 8); post.translate(0, 2.8, 0);
  const box = new THREE.BoxGeometry(0.36, 1.15, 0.3); box.translate(0, 4.9, -0.05);
  const visor = new THREE.BoxGeometry(0.44, 0.04, 0.2); visor.translate(0, 5.5, -0.22);
  const g = new THREE.BufferGeometry();
  const parts = [post, box, visor].map((p) => p.toNonIndexed());
  const pos = new Float32Array(parts.reduce((s, p) => s + p.getAttribute('position').count * 3, 0));
  const nrm = new Float32Array(pos.length);
  let o = 0;
  for (const p of parts) { pos.set(p.getAttribute('position').array as Float32Array, o); nrm.set(p.getAttribute('normal').array as Float32Array, o); o += p.getAttribute('position').count * 3; }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}
