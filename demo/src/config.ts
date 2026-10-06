import * as THREE from 'three';

/** Blender (x, y, z) Z-up metres -> three.js Y-up (glTF convention). */
export function fromBlender(x: number, y: number, z = 0): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

export type CharacterKey = 'ajie' | 'qiqi' | 'qiang';

export interface CharacterSpec {
  key: CharacterKey;
  name: string;
  role: string;
  file: string;
  lod1: string;
  height: number;
  color: string;
  /** Clip root speeds measured in Blender (m/s); movement uses these so feet do not slide. */
  walkSpeed: number;
  runSpeed: number;
  sprintScale: number;
  staminaSeconds: number; // Infinity = never tires
  spawn: THREE.Vector3;
  spawnHeading: number; // radians, 0 = facing +Z
  home: string;
}

/**
 * The 《准时达》 cast (guangzhou/studio/characters_tripo_brief.md), Tripo models converted by
 * guangzhou/scripts/gz_characters.py; speeds from characters_manifest.json. Order matters: index 1 is the
 * female skeleton the procedural crowd borrows.
 */
export const CHARACTERS: CharacterSpec[] = [
  {
    key: 'ajie',
    name: '阿杰',
    role: '准时达骑手 · 评分 4.99',
    file: 'assets/characters/CH_AJie.glb',
    lod1: 'assets/characters/CH_AJie_lod1.glb',
    height: 1.72,
    color: '#c6f03c',
    walkSpeed: 1.205,
    runSpeed: 4.3667,
    sprintScale: 1.45,
    staminaSeconds: 18,
    spawn: fromBlender(28, -236, 0.15),
    spawnHeading: Math.PI,
    home: '花城广场南 · 外卖站',
  },
  {
    key: 'qiqi',
    name: '琪琪',
    role: '美食主播',
    file: 'assets/characters/CH_Qiqi.glb',
    lod1: 'assets/characters/CH_Qiqi_lod1.glb',
    height: 1.63,
    color: '#f2a7c3',
    walkSpeed: 1.2115,
    runSpeed: 4.3902,
    sprintScale: 1.35,
    staminaSeconds: 12,
    spawn: fromBlender(1072, -560, 0.15),
    spawnHeading: Math.PI,
    home: '猎德村口 · 网红餐厅',
  },
  {
    key: 'qiang',
    name: '强叔',
    role: '猎德包租公 · 什么都能搞掂',
    file: 'assets/characters/CH_Qiang.glb',
    lod1: 'assets/characters/CH_Qiang_lod1.glb',
    height: 1.7,
    color: '#d4a93a',
    walkSpeed: 1.172,
    runSpeed: 4.2469,
    sprintScale: 1.12,
    staminaSeconds: 6,
    spawn: fromBlender(905, -395, 0.15),
    spawnHeading: Math.PI,
    home: '猎德大桥北 · 强叔的楼',
  },
];

export const PHYSICS = {
  gravity: -22,
  jumpSpeed: 5.6,
  capsuleRadius: 0.32,
  stepHeight: 0.38,
  groundSnap: 0.28,
  turnRate: 11,
  acceleration: 14,
  airControl: 0.35,
};

export const CAMERA = {
  distance: 4.6,
  minDistance: 1.6,
  maxDistance: 9,
  pivotHeight: 1.55,
  shoulder: 0.45,
  fov: 55,
  minPitch: -0.95,
  maxPitch: 0.62,
};
