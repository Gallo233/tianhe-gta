/**
 * NPC brain protocol, shared by the browser (observations) and the dev/preview server (Jev proxy).
 *
 * The browser only ever sends numbers and enums. The server turns them into first-person Chinese
 * sentences and fixed multiple-choice questions, so the proxy cannot be used to ask Jev anything else.
 */

export const PED_CHOICES = ['stroll', 'stop_watch', 'hurry', 'flee', 'turn_back', 'call_police'] as const;
export const CAR_CHOICES = ['cruise', 'slow', 'stop', 'overtake', 'honk', 'speed_up'] as const;
export type PedChoice = (typeof PED_CHOICES)[number];
export type CarChoice = (typeof CAR_CHOICES)[number];
/** What the player's car hit: another car, a wall/post, or a person. */
export type CrashVictim = 'car' | 'wall' | 'person';
/** Crimes a bystander can witness (and report). */
export type CrimeKind = 'hit_person' | 'steal_car' | 'crash_car';

/** What the player is, as seen from one NPC (null when the player is more than ~45 m away). */
export interface PlayerSeen {
  dist: number;         // metres
  driving: boolean;
  speedKmh: number;
  towardMe: boolean;    // closing in on me
  etaS: number | null;  // seconds until the player reaches me, when towardMe
  onSidewalk: boolean;  // player (or their car) is on a pavement
  sprinting: boolean;   // on foot and sprinting
  behind: boolean;      // for cars: the player is coming up from behind
}

export interface PedObservation {
  id: string;
  kind: 'ped';
  doing: 'walking' | 'standing' | 'running';
  player: PlayerSeen | null;
  blockedS: number;                       // seconds someone has stood right in front of me
  crash: { agoS: number; dist: number; towardMe: boolean; victim: CrashVictim } | null;
  witness: { kind: CrimeKind; agoS: number; dist: number } | null;   // a crime I saw with my own eyes
}

export interface CarObservation {
  id: string;
  kind: 'car';
  speedKmh: number;
  ahead: { what: 'player_car' | 'player_foot' | 'parked_car' | 'car'; dist: number; moving: boolean } | null;
  blockedS: number;                       // seconds stopped behind something that is not moving
  oncomingClear: boolean;                 // the opposite lane is empty for the next ~40 m
  signal: 'red' | 'green' | 'stop_sign' | null;   // what controls the intersection ahead (within ~40 m)
  player: PlayerSeen | null;
  hitByPlayerAgoS: number | null;         // the player drove into me this long ago
  crash: { agoS: number; dist: number; victim: CrashVictim } | null;
}

export type Observation = PedObservation | CarObservation;

export interface BrainRequest {
  agents: Observation[];
}

export interface BrainDecision {
  choice: string;                          // Jev's argmax
  probs: Record<string, number>;
}

export interface BrainResponse {
  ok: boolean;
  ms?: number;
  decisions?: Record<string, BrainDecision>;
  error?: string;
  costUsd?: number;
}

export const MAX_AGENTS = 16;
