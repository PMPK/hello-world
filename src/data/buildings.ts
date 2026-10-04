import type { PartialStock } from './resources';

export type BuildingTypeId =
  | 'hq'
  | 'habitat'
  | 'power_plant'
  | 'extractor'
  | 'farm'
  | 'refinery'
  | 'factory'
  | 'barracks'
  | 'vehicle_depot'
  | 'bunker'
  | 'at_emplacement'
  | 'research_lab';

export type SiteKind = 'minerals' | 'hydrocarbons';

export interface RecipeDef {
  id: string;
  name: string;
  inputs: PartialStock;
  outputs: PartialStock;
  /** Hours for one cycle at 100% efficiency. */
  cycleHours: number;
}

/** Fixed weapon position that fights in tactical battles (crewed from the workforce). */
export interface DefenseDef {
  /** Weapon component ids (see data/components.ts). */
  weapons: string[];
  /** Spotting range in metres (with line of sight). */
  vision: number;
  /** Muzzle / observer height above ground (metres). */
  eyeHeight: number;
  /** Rounds held at the position; filled from the base's ammunition stock when a battle starts. */
  ammoCapacity: number;
  /** The gun traverses on a separate mount (rendered as a turret). */
  turret: boolean;
  /** Fraction of structural damage absorbed (reinforced concrete). */
  armor: number;
  /** Hit-chance multiplier for incoming fire (small, dug-in positions are hard to hit). */
  profile: number;
  /** 0..1: how exposed the crew is to small arms and blast (open gun pits vs closed casemates). */
  exposure: number;
}

export interface BuildingTypeDef {
  id: BuildingTypeId;
  name: string;
  short: string;
  description: string;
  category: 'command' | 'housing' | 'power' | 'extraction' | 'industry' | 'military' | 'defense' | 'science';
  cost: PartialStock;
  buildHours: number;
  /** Workers required for full efficiency. */
  workers: number;
  maxHp: number;
  /** Electricity demand (MW) while operating. */
  energyUse: number;
  /** Electricity generated (MW) at full efficiency. */
  energyOutput?: number;
  /** Fuel burned per hour at 100% load to generate energy. */
  energyFuel?: { resource: 'hydrocarbons'; perHour: number };
  /** Population housing capacity. */
  housing?: number;
  /** Storage capacity added to the base (per resource). */
  storage?: PartialStock;
  /** Production recipes (refinery/factory/farm). */
  recipes?: RecipeDef[];
  /** Site-dependent extraction output (per hour at full efficiency). */
  extraction?: Record<SiteKind, { resource: 'minerals' | 'hydrocarbons'; perHour: number; name: string }>;
  /** Unit production capability. */
  produces?: 'infantry' | 'vehicles';
  /** Research points per hour at full efficiency (research labs). */
  research?: number;
  /** Defensive weapon position (bunkers, gun emplacements). Workers are its crew. */
  defense?: DefenseDef;
  /** Must be placed on a resource site of one of these kinds. */
  requiresSite?: SiteKind[];
  /** Campaign-map footprint radius (map units). */
  footprint: number;
  /** Footprint radius in tactical battle (metres). */
  battleFootprint: number;
  /** Infantry squads that can garrison the structure in a battle (0/absent = none). */
  garrison?: number;
  buildable: boolean;
  maxPerBase?: number;
  /** Importance for AI targeting / defence (0..1). */
  importance: number;
  /** Render model key. */
  model: string;
}

export const BUILDINGS: Record<BuildingTypeId, BuildingTypeDef> = {
  hq: {
    id: 'hq',
    name: 'Headquarters',
    short: 'HQ',
    description:
      'Expedition command post: landing module, communications array and central storage. Provides basic generator power and housing.',
    category: 'command',
    cost: { minerals: 200, refined: 150, components: 40 },
    buildHours: 96,
    workers: 4,
    maxHp: 2600,
    energyUse: 0,
    energyOutput: 12,
    housing: 30,
    storage: { minerals: 300, hydrocarbons: 300, food: 300, refined: 300, components: 300, fuel: 300, ammo: 300 },
    footprint: 1.7,
    battleFootprint: 22,
    garrison: 3,
    buildable: false,
    maxPerBase: 1,
    importance: 1,
    model: 'hq',
  },
  habitat: {
    id: 'habitat',
    name: 'Habitat',
    short: 'HAB',
    description: 'Pressurised modular housing. Increases population capacity.',
    category: 'housing',
    cost: { minerals: 30, refined: 20 },
    buildHours: 18,
    workers: 1,
    maxHp: 800,
    energyUse: 2,
    housing: 30,
    footprint: 1.2,
    battleFootprint: 14,
    garrison: 2,
    buildable: true,
    importance: 0.4,
    model: 'habitat',
  },
  power_plant: {
    id: 'power_plant',
    name: 'Power Plant',
    short: 'PWR',
    description: 'Gas-turbine plant. Burns hydrocarbons in proportion to the electrical load.',
    category: 'power',
    cost: { minerals: 40, refined: 25 },
    buildHours: 24,
    workers: 4,
    maxHp: 1100,
    energyUse: 0,
    energyOutput: 32,
    energyFuel: { resource: 'hydrocarbons', perHour: 1.0 },
    storage: { hydrocarbons: 100 },
    footprint: 1.3,
    battleFootprint: 16,
    garrison: 1,
    buildable: true,
    importance: 0.75,
    model: 'power_plant',
  },
  extractor: {
    id: 'extractor',
    name: 'Extractor',
    short: 'EXT',
    description:
      'Self-powered outpost on a resource site: a mine shaft on mineral deposits or a pump on hydrocarbon fields. Output is trucked to the base by convoy.',
    category: 'extraction',
    cost: { minerals: 40 },
    buildHours: 20,
    workers: 4,
    maxHp: 700,
    energyUse: 0,
    extraction: {
      minerals: { resource: 'minerals', perHour: 2.5, name: 'Mine' },
      hydrocarbons: { resource: 'hydrocarbons', perHour: 2.5, name: 'Oil Well' },
    },
    requiresSite: ['minerals', 'hydrocarbons'],
    footprint: 1.0,
    battleFootprint: 12,
    buildable: true,
    importance: 0.5,
    model: 'extractor',
  },
  farm: {
    id: 'farm',
    name: 'Agri-Dome',
    short: 'AGR',
    description: 'Hydroponic greenhouse domes growing food under artificial light.',
    category: 'extraction',
    cost: { minerals: 25, refined: 15 },
    buildHours: 16,
    workers: 5,
    maxHp: 600,
    energyUse: 4,
    storage: { food: 100 },
    recipes: [{ id: 'grow_food', name: 'Grow food', inputs: {}, outputs: { food: 6 }, cycleHours: 2.5 }],
    footprint: 1.25,
    battleFootprint: 15,
    buildable: true,
    importance: 0.45,
    model: 'farm',
  },
  refinery: {
    id: 'refinery',
    name: 'Refinery',
    short: 'REF',
    description: 'Smelts minerals into refined alloys, or cracks hydrocarbons into fuel.',
    category: 'industry',
    cost: { minerals: 60 },
    buildHours: 30,
    workers: 5,
    maxHp: 1200,
    energyUse: 8,
    storage: { refined: 100, fuel: 100 },
    recipes: [
      { id: 'smelt_alloy', name: 'Smelt alloys', inputs: { minerals: 4 }, outputs: { refined: 4 }, cycleHours: 1.5 },
      { id: 'crack_fuel', name: 'Crack fuel', inputs: { hydrocarbons: 4 }, outputs: { fuel: 4 }, cycleHours: 1.5 },
    ],
    footprint: 1.35,
    battleFootprint: 17,
    garrison: 1,
    buildable: true,
    importance: 0.7,
    model: 'refinery',
  },
  factory: {
    id: 'factory',
    name: 'Industrial Factory',
    short: 'FAC',
    description: 'Produces components from refined materials, and ammunition from alloys and propellant.',
    category: 'industry',
    cost: { minerals: 60, refined: 40 },
    buildHours: 36,
    workers: 7,
    maxHp: 1400,
    energyUse: 10,
    storage: { components: 100, ammo: 100 },
    recipes: [
      { id: 'make_components', name: 'Components', inputs: { refined: 2 }, outputs: { components: 2 }, cycleHours: 1.5 },
      {
        id: 'make_ammo',
        name: 'Ammunition',
        inputs: { refined: 1, hydrocarbons: 1 },
        outputs: { ammo: 5 },
        cycleHours: 1.5,
      },
    ],
    footprint: 1.5,
    battleFootprint: 19,
    garrison: 2,
    buildable: true,
    importance: 0.85,
    model: 'factory',
  },
  barracks: {
    id: 'barracks',
    name: 'Barracks',
    short: 'BRK',
    description: 'Trains and equips infantry squads from volunteers in the population.',
    category: 'military',
    cost: { minerals: 40, refined: 20 },
    buildHours: 24,
    workers: 3,
    maxHp: 1000,
    energyUse: 3,
    produces: 'infantry',
    footprint: 1.3,
    battleFootprint: 16,
    garrison: 2,
    buildable: true,
    maxPerBase: 2,
    importance: 0.6,
    model: 'barracks',
  },
  vehicle_depot: {
    id: 'vehicle_depot',
    name: 'Vehicle Depot',
    short: 'VDP',
    description: 'Assembles and crews light vehicles and main battle tanks.',
    category: 'military',
    cost: { minerals: 80, refined: 60, components: 20 },
    buildHours: 48,
    workers: 6,
    maxHp: 1800,
    energyUse: 8,
    produces: 'vehicles',
    storage: { fuel: 50, ammo: 50 },
    footprint: 1.6,
    battleFootprint: 21,
    garrison: 2,
    buildable: true,
    maxPerBase: 2,
    importance: 0.9,
    model: 'vehicle_depot',
  },
  research_lab: {
    id: 'research_lab',
    name: 'Research Lab',
    short: 'LAB',
    description:
      'Field laboratory and workshop. Scientists study the planet and improve the expedition\'s equipment and methods: choose a research project in the lab panel.',
    category: 'science',
    cost: { minerals: 60, refined: 50, components: 20 },
    buildHours: 30,
    workers: 5,
    maxHp: 900,
    energyUse: 6,
    research: 1,
    footprint: 1.2,
    battleFootprint: 15,
    garrison: 1,
    buildable: true,
    maxPerBase: 1,
    importance: 0.65,
    model: 'research_lab',
  },
  bunker: {
    id: 'bunker',
    name: 'MG Bunker',
    short: 'BNK',
    description:
      'Reinforced concrete casemate with twin heavy machine guns. Shreds infantry and light vehicles; only tank guns and massed AT rockets can crack it. Crewed by 3 and supplied from base ammunition.',
    category: 'defense',
    cost: { minerals: 35, refined: 30 },
    buildHours: 16,
    workers: 3,
    maxHp: 1800,
    energyUse: 0,
    defense: {
      weapons: ['bunker_mg'],
      vision: 230,
      eyeHeight: 1.6,
      ammoCapacity: 30,
      turret: false,
      armor: 0.6,
      profile: 0.9,
      exposure: 0.1,
    },
    footprint: 0.7,
    battleFootprint: 7,
    buildable: true,
    maxPerBase: 6,
    importance: 0.55,
    model: 'bunker',
  },
  at_emplacement: {
    id: 'at_emplacement',
    name: 'AT Gun Emplacement',
    short: 'ATG',
    description:
      'Dug-in 90mm anti-tank gun on a traversing mount. Out-ranges tank guns and is hard to hit, but cannot engage infantry and its crew is exposed to small arms. Crewed by 4 and supplied from base ammunition.',
    category: 'defense',
    cost: { minerals: 25, refined: 35, components: 12 },
    buildHours: 20,
    workers: 4,
    maxHp: 1300,
    energyUse: 0,
    defense: {
      weapons: ['at_gun_90'],
      vision: 260,
      eyeHeight: 1.9,
      ammoCapacity: 16,
      turret: true,
      armor: 0,
      profile: 0.35,
      exposure: 0.8,
    },
    footprint: 0.8,
    battleFootprint: 8,
    buildable: true,
    maxPerBase: 4,
    importance: 0.55,
    model: 'at_emplacement',
  },
};

export const BUILDABLE_TYPES: BuildingTypeId[] = (Object.keys(BUILDINGS) as BuildingTypeId[]).filter(
  (k) => BUILDINGS[k].buildable,
);

/** Fraction of the original cost needed to rebuild a destroyed building. */
export const REBUILD_COST_FACTOR = 0.6;
/** Refined materials needed to repair 100 HP. */
export const REPAIR_REFINED_PER_100HP = 1.5;
/** HP repaired per hour when repair is active. */
export const REPAIR_HP_PER_HOUR = 60;

export function buildingDisplayName(typeId: BuildingTypeId, siteKind?: SiteKind): string {
  const def = BUILDINGS[typeId];
  if (typeId === 'extractor' && siteKind && def.extraction) return def.extraction[siteKind].name;
  return def.name;
}
