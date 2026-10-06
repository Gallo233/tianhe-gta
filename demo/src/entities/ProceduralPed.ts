import * as THREE from 'three';

/**
 * Procedural pedestrians skinned onto the protagonists' Tripo skeleton (41 bones, T-pose, facing +X,
 * character's left at -Z). The body is built from elliptical tubes that follow the joint chains, with
 * per-vertex weights from each vertex's position along its chain (blended across joints), so the
 * protagonists' idle / walk / run clips drive it unchanged. Clothing is vertex colour, one material for
 * the whole crowd: ~2k triangles and one draw call per person instead of a 12k-triangle hero clone.
 */

export interface PedLook {
  female: boolean;
  build: number;          // 0.9 slim .. 1.25 heavy (torso width)
  skin: THREE.Color;
  hair: 'short' | 'long' | 'bun' | 'cap' | 'bald';
  hairColor: THREE.Color;
  top: 'tee' | 'long' | 'tank';
  topColor: THREE.Color;
  bottom: 'pants' | 'shorts' | 'skirt';
  bottomColor: THREE.Color;
  shoes: THREE.Color;
  sunglasses: boolean;
  backpack: THREE.Color | null;
  capColor: THREE.Color;
}

const SKIN = ['#f1c7a5', '#e0ac85', '#c68a62', '#9c6644', '#6e4630', '#f5d6bf'];
const HAIR = ['#1d1612', '#3a2618', '#5b3a22', '#a8793f', '#d8b774', '#7c7c7c', '#8a3b22'];
const TOPS = ['#f4f1ea', '#1f2d4a', '#e4664e', '#2f8f89', '#f2c14e', '#6b7a3a', '#8e959c', '#232323', '#e8a3b5', '#8cc2e0', '#b04a5a', '#ffffff'];
const PANTS = ['#2e4a6e', '#3b5b86', '#d8c7a4', '#2a2a2a', '#6f6a5f', '#a58d67'];
const SHORTS = ['#d8c7a4', '#3b5b86', '#7c8b5a', '#e4664e', '#f4f1ea', '#2f8f89'];
const SKIRTS = ['#1f2d4a', '#e4664e', '#f2c14e', '#2f8f89', '#f4f1ea', '#232323', '#b04a5a'];
const SHOES = ['#f4f4f0', '#1c1c1c', '#6b4a2e', '#e4664e', '#2f5a8a', '#d9d9d9'];

const col = (hex: string) => new THREE.Color(hex);   // three converts sRGB hex to linear for us

export function randomLook(rng: () => number, female: boolean): PedLook {
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length) % a.length];
  const bottom = female ? pick(['pants', 'shorts', 'skirt', 'skirt'] as const) : pick(['pants', 'pants', 'shorts'] as const);
  const hair = female ? pick(['long', 'long', 'bun', 'short', 'cap'] as const) : pick(['short', 'short', 'short', 'cap', 'bald', 'long'] as const);
  return {
    female,
    build: 0.92 + rng() * (rng() < 0.25 ? 0.33 : 0.16),
    skin: col(pick(SKIN)),
    hair,
    hairColor: col(pick(HAIR)),
    top: pick(['tee', 'tee', 'tee', 'long', 'tank'] as const),
    topColor: col(pick(TOPS)),
    bottom,
    bottomColor: col(pick(bottom === 'pants' ? PANTS : bottom === 'shorts' ? SHORTS : SKIRTS)),
    shoes: col(pick(SHOES)),
    sunglasses: rng() < 0.28,
    backpack: rng() < 0.22 ? col(pick(['#2b2b2b', '#1f2d4a', '#e4664e', '#6b7a3a', '#8e959c'])) : null,
    capColor: col(pick(['#1f2d4a', '#e4664e', '#f4f1ea', '#2f8f89', '#232323', '#f2c14e'])),
  };
}

// ------------------------------------------------------------------------------------ builder
type Weights = [number, number][];                     // [bone index, weight]

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  colr: number[] = [];
  idx: number[] = [];
  si: number[] = [];
  sw: number[] = [];

  /** Append a geometry (already in skeleton space) with a colour and weights per vertex. */
  add(g: THREE.BufferGeometry, color: (p: THREE.Vector3) => THREE.Color, weights: (p: THREE.Vector3) => Weights): void {
    const base = this.pos.length / 3;
    const P = g.attributes.position, N = g.attributes.normal;
    // tubes carry their ring centre per vertex: colour by ring, so a tilted ring never straddles a hem
    const R = g.attributes.ringCentre as THREE.BufferAttribute | undefined;
    const p = new THREE.Vector3(), rc = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      p.fromBufferAttribute(P, i);
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(N.getX(i), N.getY(i), N.getZ(i));
      const c = color(R ? rc.fromBufferAttribute(R, i) : p);
      this.colr.push(c.r, c.g, c.b);
      const w = weights(p).filter(([, x]) => x > 1e-3).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const tot = w.reduce((s, [, x]) => s + x, 0) || 1;
      for (let k = 0; k < 4; k++) { this.si.push(w[k]?.[0] ?? 0); this.sw.push(w[k] ? w[k][1] / tot : 0); }
    }
    const I = g.index;
    if (I) for (let i = 0; i < I.count; i++) this.idx.push(base + I.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colr, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * A closed tube through `pts`, elliptical cross-sections `r[i] = [depth (x-ish), width]`.
 * The section frame is built from the axis and world +X (forward), so torsos, arms and legs all
 * get "depth" front-to-back.
 */
function tube(pts: THREE.Vector3[], r: [number, number][], radial = 10, sub = 2, cut?: { axis: (p: THREE.Vector3) => number; at: number[] }): THREE.BufferGeometry {
  const rings: THREE.Vector3[] = [];
  const radii: [number, number][] = [];
  const push = (i: number, t: number) => {
    rings.push(pts[i].clone().lerp(pts[i + 1], t));
    radii.push([THREE.MathUtils.lerp(r[i][0], r[i + 1][0], t), THREE.MathUtils.lerp(r[i][1], r[i + 1][1], t)]);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    // sample points along this segment, plus a tight ring pair at every colour boundary crossing it,
    // so vertex colours change over 4 mm instead of smearing across a whole ring spacing
    const ts: number[] = [];
    for (let k = 0; k < sub; k++) ts.push(k / sub);
    if (cut) {
      const a0 = cut.axis(pts[i]), a1 = cut.axis(pts[i + 1]);
      const len = pts[i].distanceTo(pts[i + 1]);
      for (const c of cut.at) {
        if ((c - a0) * (c - a1) >= 0 || Math.abs(a1 - a0) < 1e-6) continue;
        const t = (c - a0) / (a1 - a0), e = 0.002 / Math.max(len, 1e-3);
        ts.push(Math.max(0, t - e), Math.min(0.9999, t + e));
      }
    }
    ts.sort((x, y) => x - y);
    for (const t of ts) push(i, t);
  }
  rings.push(pts[pts.length - 1].clone()); radii.push(r[r.length - 1]);
  const pos: number[] = [];
  const centre: number[] = [];
  const X = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < rings.length; i++) {
    const d = (i < rings.length - 1 ? rings[i + 1].clone().sub(rings[i]) : rings[i].clone().sub(rings[i - 1])).normalize();
    let s = new THREE.Vector3().crossVectors(d, X);
    if (s.lengthSq() < 1e-4) s = new THREE.Vector3(0, 1, 0);
    s.normalize();
    const u = new THREE.Vector3().crossVectors(s, d).normalize();
    if (u.x < 0) u.negate();                                        // "depth" axis points forward
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const v = rings[i].clone().addScaledVector(u, Math.cos(a) * radii[i][0]).addScaledVector(s, Math.sin(a) * radii[i][1]);
      pos.push(v.x, v.y, v.z);
      centre.push(rings[i].x, rings[i].y, rings[i].z);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + ((j + 1) % radial), c = a + radial, e = b + radial;
      idx.push(a, c, b, b, c, e);
    }
  }
  // caps
  const capA = pos.length / 3; pos.push(rings[0].x, rings[0].y, rings[0].z);
  const capB = capA + 1; const L = rings[rings.length - 1]; pos.push(L.x, L.y, L.z);
  centre.push(rings[0].x, rings[0].y, rings[0].z, L.x, L.y, L.z);
  const last = (rings.length - 1) * radial;
  for (let j = 0; j < radial; j++) {
    idx.push(capA, j, (j + 1) % radial);
    idx.push(capB, last + ((j + 1) % radial), last + j);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('ringCentre', new THREE.Float32BufferAttribute(centre, 3));
  g.setIndex(idx);
  // make winding consistent with outward normals regardless of the frame's handedness
  g.computeVertexNormals();
  const n0 = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, 0);
  const out0 = new THREE.Vector3().fromBufferAttribute(g.attributes.position, 0).sub(rings[0]);
  if (n0.dot(out0) < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

function ellipsoid(c: THREE.Vector3, rx: number, ry: number, rz: number, w = 12, h = 9, thetaLen = Math.PI): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h, 0, Math.PI * 2, 0, thetaLen);
  g.scale(rx, ry, rz).translate(c.x, c.y, c.z);
  g.deleteAttribute('uv');
  return g;
}

function box(c: THREE.Vector3, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(sx, sy, sz).translate(c.x, c.y, c.z);
  g.deleteAttribute('uv');
  return g;
}

/** Weights along a joint chain: nearest segment's bone, blended into the neighbour near each joint. */
function chainWeights(pts: THREE.Vector3[], bones: number[], p: THREE.Vector3, blend = 0.22): Weights {
  let best = 0, bt = 0, bd = Infinity;
  const seg = new THREE.Line3(), q = new THREE.Vector3();
  for (let k = 0; k < pts.length - 1; k++) {
    seg.set(pts[k], pts[k + 1]);
    const t = seg.closestPointToPointParameter(p, true);
    seg.at(t, q);
    const d = q.distanceToSquared(p);
    if (d < bd) { bd = d; best = k; bt = t; }
  }
  const w: Weights = [[bones[best], 1]];
  if (bt > 1 - blend && best + 1 < bones.length && bones[best + 1] !== bones[best]) {
    const x = (bt - (1 - blend)) / (2 * blend);
    w[0][1] = 1 - x; w.push([bones[best + 1], x]);
  } else if (bt < blend && best > 0 && bones[best - 1] !== bones[best]) {
    const x = (blend - bt) / (2 * blend);
    w[0][1] = 1 - x; w.push([bones[best - 1], x]);
  }
  return w;
}

// ------------------------------------------------------------------------------------ body
export function buildPedGeometry(skeleton: THREE.Skeleton, look: PedLook): THREE.BufferGeometry {
  const idx = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const bind = new Map<string, THREE.Vector3>();
  skeleton.bones.forEach((b, i) => bind.set(b.name, new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[i].clone().invert())));
  const J = (n: string) => bind.get(n)!.clone();
  const B = (n: string) => idx.get(n)!;
  const out = new Builder();
  const F = look.female, W = look.build;
  const skin = look.skin;

  const hipY = J('Pelvis').y, s1 = J('Spine01'), s2 = J('Spine02'), neck = J('NeckTwist01'), head = J('Head');
  const cx = (s1.x + s2.x) / 2 + 0.005, cz = (J('L_Thigh').z + J('R_Thigh').z) / 2;
  const beltY = hipY + 0.05;
  const topCol = (p: THREE.Vector3) => (p.y > beltY ? (look.top === 'tank' && p.y > neck.y - 0.05 && Math.abs(p.z - cz) > 0.12 ? skin : look.topColor) : look.bottomColor);

  // --- torso: crotch -> hips -> waist -> chest -> shoulders -> neck base
  const lv = [hipY - 0.08, hipY, s1.y + 0.03, s2.y + 0.05, neck.y - 0.035, neck.y + 0.035];
  const tw = F ? [0.12, 0.175, 0.125 * W, 0.155 * W, 0.17, 0.065] : [0.12, 0.162 * W, 0.145 * W, 0.17 * W, 0.195, 0.07];
  const td = F ? [0.09, 0.12, 0.092 * W, 0.128, 0.09, 0.06] : [0.09, 0.112 * W, 0.105 * W, 0.12 * W, 0.1, 0.065];
  const tpts = lv.map((y) => new THREE.Vector3(cx + (y > s1.y ? (s2.x - s1.x) * 0.3 : 0), y, cz));
  const tchain = [new THREE.Vector3(cx, hipY - 0.2, cz), new THREE.Vector3(cx, hipY, cz), s1, s2, neck, head];
  const tbones = [B('Pelvis'), B('Waist'), B('Spine01'), B('Spine02'), B('NeckTwist01')];
  out.add(tube(tpts, tw.map((w, i) => [td[i], w] as [number, number]), 12, 2, { axis: (p) => p.y, at: [beltY] }), topCol, (p) => {
    const w = chainWeights(tchain, tbones, p);
    // shoulders follow the clavicles, the crotch follows the thighs
    const side = p.z - cz;
    if (p.y > neck.y - 0.09 && Math.abs(side) > 0.1) {
      const k = Math.min(1, (Math.abs(side) - 0.1) / 0.1) * 0.6;
      w.forEach((e) => (e[1] *= 1 - k)); w.push([B(side < 0 ? 'L_Clavicle' : 'R_Clavicle'), k]);
    }
    if (p.y < hipY - 0.02 && Math.abs(side) > 0.04) {
      const k = Math.min(1, (hipY - 0.02 - p.y) / 0.06) * 0.5;
      w.forEach((e) => (e[1] *= 1 - k)); w.push([B(side < 0 ? 'L_Thigh' : 'R_Thigh'), k]);
    }
    return w;
  });

  // --- legs
  for (const S of ['L', 'R'] as const) {
    const hip = J(`${S}_Thigh`), knee = J(`${S}_Calf`), foot = J(`${S}_Foot`);
    const ankle = new THREE.Vector3(foot.x, 0.1, foot.z);
    const mid = hip.clone().lerp(knee, 0.5), calf = knee.clone().lerp(ankle, 0.35);
    hip.y -= 0.02; hip.z = THREE.MathUtils.lerp(hip.z, cz, 0.12);
    const pts = [hip, mid, knee, calf, ankle];
    const thigh = F ? 0.09 : 0.085;
    const rr: [number, number][] = [[thigh * W, thigh * W], [0.072, 0.07], [0.052, 0.05], [0.06, 0.055], [0.042, 0.04]];
    const bones = [B(`${S}_Thigh`), B(`${S}_Thigh`), B(`${S}_Calf`), B(`${S}_Calf`)];
    const hemY = look.bottom === 'pants' ? 0.08 : look.bottom === 'shorts' ? knee.y + 0.1 : 9;
    out.add(tube(pts, rr, 9, 2, { axis: (p) => p.y, at: [hemY] }), (p) => (p.y > hemY ? look.bottomColor : skin), (p) => chainWeights(pts, bones, p));
    // shoe: heel behind the ankle, toe spring at the front
    const toe = J(`${S}_ToeBase`);
    const shoe = new THREE.BoxGeometry(0.235, 0.08, 0.088, 3, 1, 1).translate(foot.x + 0.045, 0.04, foot.z);
    shoe.deleteAttribute('uv');
    const sp = shoe.attributes.position;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i), y = sp.getY(i);
      const front = (x - (foot.x + 0.045)) / 0.1175;              // -1 heel .. 1 toe
      if (front > 0.2 && y > 0.05) sp.setY(i, y - 0.03 * front);   // low toe box
      if (front > 0.5) sp.setZ(i, THREE.MathUtils.lerp(sp.getZ(i), foot.z, 0.25));
    }
    shoe.computeVertexNormals();
    out.add(shoe, () => look.shoes, (p) => (p.x > toe.x + 0.03 ? [[B(`${S}_Foot`), 0.5], [B(`${S}_ToeBase`), 0.5]] : [[B(`${S}_Foot`), 1]]));
  }

  // --- skirt (over the legs, from the belt to above the knee)
  if (look.bottom === 'skirt') {
    const knee = J('L_Calf').y;
    const g = new THREE.CylinderGeometry(1, 1.35, beltY - (knee + 0.08), 14, 2, true);
    g.scale(0.13 * W, 1, 0.19).translate(cx, (beltY + knee + 0.08) / 2, cz);
    g.deleteAttribute('uv');
    const top = beltY, len = beltY - (knee + 0.08);
    out.add(g, () => look.bottomColor, (p) => {
      const k = Math.min(1, Math.max(0, (top - p.y) / len)) * 0.55;
      return [[B('Pelvis'), 1 - k], [B(p.z < cz ? 'L_Thigh' : 'R_Thigh'), k]];
    });
  }

  // --- arms (T-pose along ±Z)
  for (const S of ['L', 'R'] as const) {
    const sgn = S === 'L' ? -1 : 1;
    const clav = J(`${S}_Clavicle`), sh = J(`${S}_Upperarm`), el = J(`${S}_Forearm`), wr = J(`${S}_Hand`);
    const inner = clav.clone(); inner.z = cz + sgn * 0.1; inner.y = sh.y - 0.02;
    const shoulder = sh.clone(); shoulder.y -= 0.015;
    const pts = [inner, shoulder, shoulder.clone().lerp(el, 0.5), el, el.clone().lerp(wr, 0.5), wr];
    const a = F ? 0.9 : 1;
    const rr: [number, number][] = [[0.065, 0.065], [0.064 * a, 0.06 * a], [0.052 * a, 0.05 * a], [0.042, 0.04], [0.042 * a, 0.039], [0.032, 0.029]];
    const bones = [B(`${S}_Clavicle`), B(`${S}_Upperarm`), B(`${S}_Upperarm`), B(`${S}_Forearm`), B(`${S}_Forearm`)];
    const sleeve = look.top === 'long' ? 9 : look.top === 'tee' ? 0.15 : -1;
    const sleeveEnd = Math.abs(shoulder.z) + sleeve;
    out.add(tube(pts, rr, 8, 2, { axis: (p) => Math.abs(p.z), at: [sleeveEnd] }), (p) => (Math.abs(p.z) < sleeveEnd ? look.topColor : skin), (p) => chainWeights(pts, bones, p));
    // hand: flat, palm down in the T-pose
    const hand = ellipsoid(wr.clone().add(new THREE.Vector3(0, -0.005, sgn * 0.085)), 0.045, 0.022, 0.085, 8, 6);
    out.add(hand, () => skin, () => [[B(`${S}_Hand`), 1]]);
  }

  // --- neck and head
  const hc = head.clone().add(new THREE.Vector3(0.014, 0.125, 0));
  const npts = [new THREE.Vector3(cx, neck.y - 0.02, cz), neck, head.clone().add(new THREE.Vector3(0.005, 0.05, 0))];
  out.add(tube(npts, [[0.058, 0.058], [0.052, 0.05], [0.05, 0.048]], 8, 1), () => skin, (p) =>
    chainWeights([J('Spine02'), neck, J('NeckTwist02'), head], [B('Spine02'), B('NeckTwist01'), B('NeckTwist02')], p));
  const hs = F ? 0.96 : 1;
  const HR = { x: 0.106 * hs, y: 0.126 * hs, z: 0.086 * hs };
  const H = () => [[B('Head'), 1]] as Weights;
  out.add(ellipsoid(hc, HR.x, HR.y, HR.z, 14, 10), () => skin, H);
  out.add(box(hc.clone().add(new THREE.Vector3(HR.x - 0.004, -0.02, 0)), 0.04, 0.045, 0.024), () => skin, H);      // nose
  for (const z of [-1, 1]) {
    out.add(ellipsoid(hc.clone().add(new THREE.Vector3(HR.x - 0.018, 0.018, z * 0.034)), 0.012, 0.009, 0.013, 6, 4), () => col('#1a1512'), H);
    out.add(ellipsoid(hc.clone().add(new THREE.Vector3(-0.005, 0, z * HR.z)), 0.018, 0.028, 0.012, 6, 4), () => skin, H);   // ears
  }
  if (look.sunglasses) out.add(box(hc.clone().add(new THREE.Vector3(HR.x - 0.01, 0.018, 0)), 0.02, 0.028, 0.15), () => col('#101418'), H);

  // hair / cap: a cap-shaped shell tilted so it comes lower at the back
  const shell = (scale: number, theta: number, c: THREE.Color) => {
    const g = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, theta);
    g.scale(HR.x * scale, HR.y * scale, HR.z * scale).rotateZ(0.45).translate(hc.x, hc.y + 0.005, hc.z);
    g.deleteAttribute('uv');
    out.add(g, () => c, H);
  };
  switch (look.hair) {
    case 'short': shell(1.07, 1.35, look.hairColor); break;
    case 'long':
      shell(1.08, 1.5, look.hairColor);
      out.add(ellipsoid(hc.clone().add(new THREE.Vector3(-HR.x * 0.55, -0.09, 0)), 0.07, 0.17, HR.z * 1.08, 10, 8), () => look.hairColor, (p) =>
        [[B('Head'), p.y > hc.y - 0.1 ? 1 : 0.6], [B('Spine02'), p.y > hc.y - 0.1 ? 0 : 0.4]]);
      break;
    case 'bun':
      shell(1.07, 1.4, look.hairColor);
      out.add(ellipsoid(hc.clone().add(new THREE.Vector3(-HR.x * 0.95, 0.06, 0)), 0.05, 0.05, 0.05, 8, 6), () => look.hairColor, H);
      break;
    case 'cap':
      shell(1.08, 1.25, look.capColor);
      out.add(box(hc.clone().add(new THREE.Vector3(HR.x + 0.03, 0.07, 0)), 0.1, 0.012, HR.z * 1.7), () => look.capColor, H);   // brim
      break;
    case 'bald': break;
  }

  if (look.backpack) {
    const bp = look.backpack;
    out.add(box(new THREE.Vector3(cx - 0.12 * W - 0.07, s2.y - 0.02, cz), 0.12, 0.34, 0.27), () => bp, () => [[B('Spine02'), 0.8], [B('Spine01'), 0.2]]);
  }
  return out.geometry();
}

let sharedMat: THREE.MeshStandardMaterial | null = null;
export function pedMaterial(): THREE.MeshStandardMaterial {
  return (sharedMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }));
}

/**
 * Replace the skinned mesh(es) of a cloned hero rig with a procedural body bound to the same skeleton.
 * Returns the new mesh; the rig's bones, clips and mixer target stay exactly as they were.
 */
export function dressRig(rig: THREE.Object3D, look: PedLook): THREE.SkinnedMesh {
  return dressRigWith(rig, (skeleton) => buildPedGeometry(skeleton, look));
}

/**
 * dressRig with a body built elsewhere: `geometry` is called with the rig's skeleton (or is a geometry already
 * built for another clone of the same rig -- the bind pose is shared, so one body can dress many clones).
 */
export function dressRigWith(rig: THREE.Object3D, geometry: THREE.BufferGeometry | ((s: THREE.Skeleton) => THREE.BufferGeometry)): THREE.SkinnedMesh {
  const olds: THREE.SkinnedMesh[] = [];
  rig.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) olds.push(o as THREE.SkinnedMesh); });
  const src = olds[0];
  const geo = typeof geometry === 'function' ? geometry(src.skeleton) : geometry;
  const mesh = new THREE.SkinnedMesh(geo, pedMaterial());
  mesh.position.copy(src.position); mesh.quaternion.copy(src.quaternion); mesh.scale.copy(src.scale);
  mesh.bind(src.skeleton, src.bindMatrix);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  src.parent!.add(mesh);
  for (const o of olds) o.parent!.remove(o);
  return mesh;
}
