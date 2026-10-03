import type { BattleKind } from '../campaign/types';
import type { BuildingTypeId, SiteKind } from '../data/buildings';
import type { WeaponClass, WeaponDef } from '../data/components';
import type { UnitStats } from '../units/stats';

/** Battlefield edge length in metres. */
export const BATTLE_SIZE = 800;
/** Battle terrain grid resolution (cells per side). */
export const BATTLE_GRID = 100;
/** Metres per campaign map unit when laying out bases and terrain. */
export const BATTLE_POS_SCALE = 20;
/** Metres per campaign height unit. */
export const BATTLE_HEIGHT_SCALE = 6;
/** Hard battle time limit (seconds of battle time). */
export const BATTLE_TIME_LIMIT = 15 * 60;
/**
 * Tactical engagements are time-compressed: one battle second represents
 * this many seconds of campaign time when the result is applied.
 */
export const BATTLE_TIME_SCALE = 12;
/** Maximum simultaneously deployed units per side (extra units wait as reserves). */
export const MAX_UNITS_PER_SIDE = 30;

export type SideIndex = 0 | 1; // 0 = attacker, 1 = defender

export interface BattleUnitSpec {
  campaignId: string;
  designId: string;
  hp: number;
  men: number;
  ammo: number;
  fuel: number;
  origin: { kind: 'army' | 'garrison'; id: string };
}

export interface BattleSideSetup {
  factionId: string;
  name: string;
  isPlayer: boolean;
  armyIds: string[];
  units: BattleUnitSpec[];
  color: string;
  vehicleTint: string;
  uniformTint: string;
  /** Deployment centre (battle metres) and facing direction (unit vector toward the enemy). */
  entry: { x: number; z: number; dirX: number; dirZ: number };
}

export interface BattleBuildingSpec {
  campaignId: string;
  typeId: BuildingTypeId;
  siteKind: SiteKind | null;
  side: SideIndex;
  factionId: string;
  x: number;
  z: number;
  rot: number;
  hp: number;
  maxHp: number;
  state: 'active' | 'construction' | 'destroyed';
  /** Defensive structures: crew on duty when the battle started. */
  crew?: number;
  /** Defensive structures: rounds drawn from the base stock for this battle. */
  ammo?: number;
}

/** Everything needed to (re)create a battle. Plain JSON. */
export interface BattleSetup {
  id: string;
  seed: number;
  kind: BattleKind;
  campaignX: number;
  campaignZ: number;
  sides: [BattleSideSetup, BattleSideSetup];
  buildings: BattleBuildingSpec[];
  baseId: string | null;
  objectiveBuildingId: string | null;
  playerSide: SideIndex | null;
  timeLimit: number;
  /** Campaign map region name for UI. */
  locationName: string;
}

export type TargetRef = { kind: 'unit'; id: number } | { kind: 'building'; id: number };

export type UnitOrder =
  | { type: 'idle' }
  | { type: 'move'; x: number; z: number; attackMove: boolean }
  | { type: 'attack'; target: TargetRef }
  | { type: 'hold' }
  | { type: 'retreat' };

export interface BUnit {
  id: number;
  spec: BattleUnitSpec;
  side: SideIndex;
  stats: UnitStats;
  x: number;
  z: number;
  heading: number;
  /** Absolute turret heading (vehicles). */
  turret: number;
  speedNow: number;
  hp: number;
  men: number;
  ammo: number;
  fuel: number;
  alive: boolean;
  retreated: boolean;
  /** Not yet deployed (reserve). */
  reserve: boolean;
  order: UnitOrder;
  path: { x: number; z: number }[];
  /** Destination offset for group moves. */
  target: TargetRef | null;
  /** Preferred target suggested by AI focus fire. */
  focus: TargetRef | null;
  weaponCd: number[];
  seenBy: [boolean, boolean];
  lastFired: number;
  lastHit: number;
  suppression: number;
  cover: number;
  inForest: boolean;
  nextAcquire: number;
  ammoSpent: number;
  fuelSpent: number;
  kills: number;
  /** AI task label (debug / future UI). */
  task: string;
  menStart: number;
}

/** Weapon state of a crewed defensive structure. */
export interface BDefense {
  weapons: WeaponDef[];
  weaponCd: number[];
  crew: number;
  crewMax: number;
  /** Crew at the start of the battle (casualties = crewStart - crew). */
  crewStart: number;
  ammo: number;
  ammoStart: number;
  ammoCapacity: number;
  vision: number;
  eyeHeight: number;
  /** Absolute heading of the gun mount. */
  turret: number;
  /** Traverse rate of the mount (rad/s). */
  traverse: number;
  target: TargetRef | null;
  nextAcquire: number;
  lastFired: number;
  kills: number;
  /** Combat value at full health (UnitStats.power scale). */
  power: number;
}

export interface BBuilding {
  id: number;
  spec: BattleBuildingSpec;
  x: number;
  z: number;
  rot: number;
  hp: number;
  maxHp: number;
  radius: number;
  side: SideIndex;
  destroyed: boolean;
  /** Crewed defensive structure (bunker, gun emplacement); null for other buildings. */
  defense: BDefense | null;
}

export type BattleEvent =
  | {
      type: 'shot';
      shooter: number;
      weapon: WeaponClass;
      fromX: number;
      fromY: number;
      fromZ: number;
      toX: number;
      toY: number;
      toZ: number;
      hit: boolean;
      travel: number;
    }
  | { type: 'explosion'; x: number; y: number; z: number; size: number; delay: number }
  | { type: 'unit_destroyed'; id: number; x: number; z: number; vehicle: boolean }
  | { type: 'building_destroyed'; id: number; x: number; z: number }
  | { type: 'casualty'; id: number; x: number; z: number };

export interface SideSummary {
  factionId: string;
  unitsStart: number;
  unitsLost: number;
  menStart: number;
  menKilled: number;
  crewSurvivors: number;
  vehiclesLost: number;
  squadsLost: number;
  ammoSpent: number;
  fuelSpent: number;
  buildingsLost: number;
}

export interface BattleUnitResult {
  campaignId: string;
  origin: BattleUnitSpec['origin'];
  side: SideIndex;
  status: 'alive' | 'destroyed' | 'retreated';
  hp: number;
  men: number;
  ammo: number;
  fuel: number;
}

export interface BattleBuildingResult {
  campaignId: string;
  hp: number;
  destroyed: boolean;
  /** Defences: ammunition fired (drawn from the owning base's stock). */
  ammoSpent: number;
  /** Defences: crew killed when the position was destroyed. */
  crewLost: number;
}

export interface BattleResult {
  battleId: string;
  kind: BattleKind;
  winner: SideIndex | null;
  reason: 'eliminated' | 'withdrawal' | 'timeout' | 'undefended' | 'retreat';
  durationSeconds: number;
  campaignHours: number;
  units: BattleUnitResult[];
  buildings: BattleBuildingResult[];
  sides: [SideSummary, SideSummary];
  playerWithdrew: boolean;
}
