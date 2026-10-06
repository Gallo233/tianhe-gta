import * as THREE from 'three';
import type { CrashVictim, CrimeKind, PlayerSeen } from './brainProtocol';

/** Something the player did that a bystander could report. */
export interface Crime { id: number; kind: CrimeKind; pos: THREE.Vector3; at: number }

/** The nearest crime `pos` could have seen: within `range` m and the last 12 s. */
export function crimeSeen(pos: THREE.Vector3, crimes: Crime[], now: number, range = 45): { crime: Crime; agoS: number; dist: number } | null {
  let best: { crime: Crime; agoS: number; dist: number } | null = null;
  for (const c of crimes) {
    const agoS = now - c.at, dist = pos.distanceTo(c.pos);
    if (agoS > 12 || dist > range) continue;
    if (!best || dist < best.dist) best = { crime: c, agoS, dist };
  }
  return best;
}

/** What Game knows about the player this frame (three.js space). */
export interface PlayerFacts {
  pos: THREE.Vector3;
  vel: THREE.Vector3;     // m/s, smoothed
  driving: boolean;
  onSidewalk: boolean;
  sprinting: boolean;
  crash: { pos: THREE.Vector3; at: number; victim: CrashVictim } | null;  // last time the player's car hit something (performance.now()/1000)
}

const rel = new THREE.Vector3();

/**
 * The player as seen from `pos`. `fwd` (unit, optional) is the observer's own heading, used to tell
 * a car the player is coming up from behind. Null beyond `range` metres.
 */
export function seePlayer(pos: THREE.Vector3, f: PlayerFacts, range = 45, fwd?: THREE.Vector3): PlayerSeen | null {
  rel.copy(pos).sub(f.pos).setY(0);
  const dist = rel.length();
  if (dist > range) return null;
  const speed = Math.hypot(f.vel.x, f.vel.z);
  // closing speed: player velocity projected on the direction from player to me
  const closing = dist > 0.01 ? (f.vel.x * rel.x + f.vel.z * rel.z) / dist : 0;
  const towardMe = closing > 1.0;
  const behind = fwd ? fwd.x * -rel.x + fwd.z * -rel.z < 0 : false;   // player lies behind my heading
  return {
    dist,
    driving: f.driving,
    speedKmh: speed * 3.6,
    towardMe,
    etaS: towardMe ? dist / closing : null,
    onSidewalk: f.onSidewalk,
    sprinting: f.sprinting,
    behind,
  };
}

export function crashSeen(pos: THREE.Vector3, f: PlayerFacts, now: number, range = 40): { agoS: number; dist: number; victim: CrashVictim } | null {
  if (!f.crash) return null;
  const agoS = now - f.crash.at;
  if (agoS > 8) return null;
  const dist = pos.distanceTo(f.crash.pos);
  return dist > range ? null : { agoS, dist, victim: f.crash.victim };
}

/** Labels for the J overlay. */
export const CHOICE_LABEL: Record<string, string> = {
  stroll: '散步', stop_watch: '围观', hurry: '快走', flee: '逃跑', turn_back: '掉头', call_police: '报警',
  cruise: '巡航', slow: '减速', stop: '停车', overtake: '绕行', honk: '鸣笛', speed_up: '加速',
  down: '倒地',
};
