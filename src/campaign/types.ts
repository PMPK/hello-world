import type { Difficulty } from '../data/difficulty';
import type { Vec2 } from '../core/math';
import type { BuildingTypeId, SiteKind } from '../data/buildings';
import type { PartialStock, Stock } from '../data/resources';
import type { Character } from '../characters/character';
import type { ResearchState } from '../research/research';

/**
 * Campaign state is plain JSON-serialisable data. No Three.js objects, no
 * class instances, no Maps. Rendering reads it; the simulation mutates it.
 */

/** Bump when the shape of CampaignState changes; add a migration in persistence/migrations.ts. */
export const STATE_VERSION = 10;

export interface UnitInstance {
  id: string;
  designId: string;
  hp: number;
  /** Soldiers in the squad, or crew aboard a vehicle. */
  men: number;
  ammo: number;
  fuel: number;
  /** Experience (reserved for future veterancy). */
  xp: number;
}

export type ArmyOrder =
  | { type: 'idle' }
  | { type: 'move'; x: number; z: number }
  | { type: 'attack_army'; targetId: string }
  | { type: 'attack_base'; targetId: string }
  | { type: 'attack_building'; targetId: string }
  | { type: 'return'; baseId: string };

export interface Army {
  id: string;
  name: string;
  factionId: string;
  commanderId: string | null;
  units: UnitInstance[];
  x: number;
  z: number;
  /** Remaining waypoints. */
  path: Vec2[];
  order: ArmyOrder;
  /** Rations carried (food units). */
  food: number;
  homeBaseId: string | null;
  /** Campaign time of the last battle (engagement cooldown). */
  lastBattleTime: number;
  /** Re-path timer for pursuit orders. */
  repathAt: number;
  /** Strategic AI role tag (null for player armies). */
  aiRole: 'attack' | 'defend' | 'raid' | 'patrol' | null;
  /** Bases send supply runs on their own when the force runs low in the field (state v10). */
  autoSupply: boolean;
}

export type BuildingState = 'construction' | 'active' | 'destroyed';

export interface ProductionOrder {
  id: string;
  designId: string;
  /** Hours of work completed. */
  progress: number;
  /** Resources and people have been committed. */
  started: boolean;
}

export type BuildingStatus =
  | 'ok'
  | 'constructing'
  | 'waiting_resources'
  | 'no_workers'
  | 'low_power'
  | 'no_input'
  | 'storage_full'
  | 'idle'
  | 'disabled'
  | 'destroyed'
  | 'damaged'
  | 'no_population';

export interface Building {
  id: string;
  typeId: BuildingTypeId;
  baseId: string;
  factionId: string;
  x: number;
  z: number;
  rot: number;
  hp: number;
  state: BuildingState;
  /** 0..1 construction progress. */
  buildProgress: number;
  /** Construction materials paid (construction can start). */
  paid: boolean;
  /** 'auto' or a recipe id. */
  recipeMode: string;
  /** Recipe currently running a cycle (inputs already consumed). */
  activeRecipe: string | null;
  cycleProgress: number;
  /** Local buffer (extractor output waiting for a convoy). */
  storage: PartialStock;
  queue: ProductionOrder[];
  /** Unit design re-queued automatically whenever the queue runs empty (null = off). Added in state v2. */
  repeat: string | null;
  siteId: string | null;
  enabled: boolean;
  repairing: boolean;
  lastConvoyTime: number;
  /** Derived each tick (saved for UI continuity, recomputed anyway). */
  status: BuildingStatus;
  efficiency: number;
  workers: number;
}

export interface Base {
  id: string;
  name: string;
  factionId: string;
  x: number;
  z: number;
  radius: number;
  stock: Stock;
  /** Civilians (workforce pool). Soldiers are counted in units. */
  population: number;
  /** Fractional population growth accumulator. */
  growth: number;
  garrison: UnitInstance[];
  founded: number;
  /** Derived each tick for UI. */
  econ: BaseEconomySnapshot;
}

export interface BaseEconomySnapshot {
  energyProduced: number;
  energyDemand: number;
  workersNeeded: number;
  workersEmployed: number;
  housing: number;
  foodPerHour: number;
  /** Net change per hour estimated over the last ticks, per resource. */
  rates: PartialStock;
  storageCap: Stock;
}

export interface ResourceSite {
  id: string;
  kind: SiteKind;
  x: number;
  z: number;
  richness: number;
  buildingId: string | null;
}

export interface Convoy {
  id: string;
  factionId: string;
  /** Extractor id, `base:<id>` for automatic supply runs, or `manual:<id>` for player-sent convoys. */
  fromBuildingId: string;
  toBaseId: string;
  cargo: PartialStock;
  /** Colonists travelling with the convoy (added to the destination's population on arrival). */
  people: number;
  /** Supply run: the task force it is driving to (then it returns to `toBaseId` with what is left). */
  toArmyId: string | null;
  path: Vec2[];
  x: number;
  z: number;
}

/** A convoy one base sends to another on a schedule (state v10). */
export interface StandingTransfer {
  id: string;
  factionId: string;
  fromBaseId: string;
  toBaseId: string;
  /** Goods per run (what the sending base can spare is sent when it has less). */
  cargo: PartialStock;
  people: number;
  /** Hours between departures. */
  everyHours: number;
  nextAt: number;
}

export interface Road {
  id: string;
  factionId: string;
  fromBaseId: string;
  toBuildingId: string;
  points: Vec2[];
}

export type DiplomaticStatus = 'standoff' | 'hostile';

export interface Relation {
  a: string;
  b: string;
  status: DiplomaticStatus;
  /** 0..100; at 100 the AI side goes weapons-free. */
  tension: number;
  warningIssued: boolean;
}

export interface FactionState {
  id: string;
  defId: string;
  isPlayer: boolean;
  name: string;
  color: string;
  defeated: boolean;
  research: ResearchState;
  /** Counter for naming armies / bases. */
  armyCounter: number;
  /** Campaign time the expedition lost its last base (null while it holds one). */
  baselessSince: number | null;
  /** Relief landings Earth has already sent to this expedition. */
  reliefLandings: number;
}

export interface AIState {
  factionId: string;
  nextThinkAt: number;
  lastAttackLaunch: number;
  /** Planned target for the current offensive. */
  targetKind: 'base' | 'building' | 'army' | null;
  targetId: string | null;
  lastBuildCheck: number;
  /** Campaign time the last recon patrol set out. */
  lastPatrolAt: number;
}

export type BattleKind = 'field' | 'base_assault' | 'outpost';

export interface PendingBattle {
  id: string;
  kind: BattleKind;
  x: number;
  z: number;
  attackerFactionId: string;
  defenderFactionId: string;
  attackerArmyIds: string[];
  defenderArmyIds: string[];
  /** Base whose garrison and buildings take part. */
  baseId: string | null;
  /** Outpost building that is the objective (outpost battles). */
  buildingId: string | null;
  createdAt: number;
  seed: number;
}

export interface LogEntry {
  t: number;
  text: string;
  kind: 'info' | 'warn' | 'battle' | 'econ' | 'lore';
  factionId?: string;
  /** Where it happened, for "show me" (intel reports). */
  at?: { x: number; z: number };
  /** What it is about: a sighted force (army id) or a reported base (base id). */
  ref?: { kind: 'army' | 'base'; id: string };
}

/** What a faction last saw of a rival task force (state v9). */
export interface ArmySighting {
  armyId: string;
  /** Owner of the sighted force. */
  factionId: string;
  name: string;
  x: number;
  z: number;
  /** Campaign time of the last fix. */
  t: number;
  /** Direction of travel at the last fix (unit vector; 0,0 when stationary). */
  hx: number;
  hz: number;
  /** Observed units by design id. */
  units: Record<string, number>;
  men: number;
  /** In view at the last intel update; otherwise this is a last known position. */
  inSight: boolean;
}

/** Latest report on a rival base, taken while it was in view (state v9). */
export interface BaseReport {
  baseId: string;
  factionId: string;
  t: number;
  /** Finished, standing structures by type. */
  structures: Partial<Record<BuildingTypeId, number>>;
  /** Structures under construction. */
  underConstruction: number;
  /** Garrisoned units by design id. */
  garrison: Record<string, number>;
  garrisonMen: number;
  population: number;
}

/** A faction's knowledge of its rivals (state v9). */
export interface IntelState {
  /** Rival task forces in view or recently lost from view, by army id. */
  armies: Record<string, ArmySighting>;
  /** Latest report per rival base, by base id. */
  bases: Record<string, BaseReport>;
}

export interface CampaignStats {
  battlesFought: number;
  battlesWon: number;
  unitsLost: Record<string, number>;
  soldiersKilled: Record<string, number>;
}

export interface CampaignState {
  version: number;
  seed: number;
  /** Rival expedition difficulty (state v3). */
  difficulty: Difficulty;
  /** Campaign hours since start. */
  time: number;
  rngState: number;
  nextId: number;
  playerFactionId: string;
  factions: Record<string, FactionState>;
  bases: Record<string, Base>;
  buildings: Record<string, Building>;
  sites: Record<string, ResourceSite>;
  armies: Record<string, Army>;
  convoys: Record<string, Convoy>;
  /** Standing convoy orders between bases (state v10). */
  transfers: Record<string, StandingTransfer>;
  roads: Record<string, Road>;
  characters: Record<string, Character>;
  relations: Relation[];
  ai: Record<string, AIState>;
  /** Per-faction intelligence: sightings and base reports (state v9). */
  intel: Record<string, IntelState>;
  log: LogEntry[];
  pendingBattle: PendingBattle | null;
  nextEarthFlightAt: number;
  earthFlights: number;
  stats: CampaignStats;
}
