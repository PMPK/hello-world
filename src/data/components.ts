import type { PartialStock } from './resources';

/**
 * Modular unit components.
 *
 * Every military unit is a *design* assembled from components. Stats are
 * derived from the components (see src/units/stats.ts), never hard-coded per
 * unit. This is the foundation for the future unit designer (vehicles,
 * robots, drones, mechs): new chassis/engines/weapons/AI cores are just new
 * entries here.
 */

export type ComponentKind = 'chassis' | 'engine' | 'armor' | 'weapon' | 'sensor' | 'electronics';

export type UnitFamily = 'infantry' | 'light_vehicle' | 'tank';
export type Mobility = 'foot' | 'wheeled' | 'tracked';

interface ComponentBase {
  id: string;
  kind: ComponentKind;
  name: string;
  description?: string;
  mass: number; // tonnes (abstract)
  cost: PartialStock;
  /** Hours of assembly this component adds. */
  buildHours: number;
}

export interface ChassisDef extends ComponentBase {
  kind: 'chassis';
  family: UnitFamily;
  mobility: Mobility;
  /** People needed: squad size for infantry, crew for vehicles. */
  crew: number;
  baseHp: number;
  /** For infantry: HP per soldier (squad HP = men * hpPerMan). */
  hpPerMan?: number;
  slots: { weapons: number; sensors: number; engine: boolean; armor: boolean; electronics: number };
  fuelCapacity: number;
  ammoCapacity: number;
  /** Collision / selection radius in battle (metres). */
  size: number;
  baseVision: number;
  /** Tactical top speed before engine scaling (m/s). */
  topSpeed: number;
  /** Strategic speed before engine scaling (map units / hour). */
  strategicSpeed: number;
  /** How hard the unit is to spot (0 = obvious, 1 = invisible). */
  stealth: number;
  /** Render model key. */
  model: 'infantry' | 'jeep' | 'tank';
}

export interface EngineDef extends ComponentBase {
  kind: 'engine';
  power: number; // abstract hp per tonne reference
  /** Fuel per metre moved in battle. */
  fuelPerMetre: number;
  /** Fuel per map unit moved on the campaign map. */
  fuelPerUnit: number;
}

export interface ArmorDef extends ComponentBase {
  kind: 'armor';
  /** Frontal armour (mm RHA-equivalent, abstract). */
  armor: number;
  hpBonus: number;
}

export type WeaponClass = 'small_arms' | 'mg' | 'hmg' | 'at_rocket' | 'cannon';

export interface WeaponDef extends ComponentBase {
  kind: 'weapon';
  weaponClass: WeaponClass;
  range: number; // metres (tactically compressed)
  damage: number;
  penetration: number;
  /** Shots (or bursts) per second. */
  rof: number;
  /** Base hit probability at short range. */
  accuracy: number;
  ammoPerShot: number;
  projectileSpeed: number; // m/s, visual travel time
  /** Multiplier vs infantry targets (HE / suppression effectiveness). */
  vsInfantry: number;
  /** Multiplier vs buildings. */
  vsStructure: number;
  /** Only engages vehicles/structures (e.g. AT launchers). */
  antiVehicleOnly?: boolean;
  /** Accuracy multiplier when the firing unit is moving. */
  movingAccuracy: number;
  /** Infantry firepower scales with surviving men. */
  scalesWithMen?: boolean;
  /** Suppression applied to infantry on hit/near miss (0..1). */
  suppression: number;
}

export interface SensorDef extends ComponentBase {
  kind: 'sensor';
  visionBonus: number;
  /** Ability to see through concealment (0..1). */
  spotting: number;
}

export interface ElectronicsDef extends ComponentBase {
  kind: 'electronics';
  accuracyBonus: number;
}

export type ComponentDef = ChassisDef | EngineDef | ArmorDef | WeaponDef | SensorDef | ElectronicsDef;

export const CHASSIS: Record<string, ChassisDef> = {
  rifle_squad: {
    id: 'rifle_squad',
    kind: 'chassis',
    name: 'Rifle Squad (6)',
    family: 'infantry',
    mobility: 'foot',
    crew: 6,
    baseHp: 0,
    hpPerMan: 40,
    mass: 0.6,
    cost: { refined: 4, components: 1 },
    buildHours: 6,
    slots: { weapons: 2, sensors: 1, engine: false, armor: false, electronics: 0 },
    fuelCapacity: 0,
    ammoCapacity: 12,
    size: 6,
    baseVision: 210,
    topSpeed: 3.4,
    strategicSpeed: 4.6,
    stealth: 0.5,
    model: 'infantry',
  },
  light_4x4: {
    id: 'light_4x4',
    kind: 'chassis',
    name: 'Light 4x4 Utility Vehicle',
    family: 'light_vehicle',
    mobility: 'wheeled',
    crew: 3,
    baseHp: 170,
    mass: 2.4,
    cost: { refined: 10, components: 3 },
    buildHours: 8,
    slots: { weapons: 1, sensors: 1, engine: true, armor: true, electronics: 1 },
    fuelCapacity: 20,
    ammoCapacity: 16,
    size: 4,
    baseVision: 250,
    topSpeed: 15,
    strategicSpeed: 9,
    stealth: 0.15,
    model: 'jeep',
  },
  mbt_hull: {
    id: 'mbt_hull',
    kind: 'chassis',
    name: 'Main Battle Tank Hull',
    family: 'tank',
    mobility: 'tracked',
    crew: 3,
    baseHp: 650,
    mass: 38,
    cost: { refined: 24, components: 10 },
    buildHours: 20,
    slots: { weapons: 2, sensors: 1, engine: true, armor: true, electronics: 1 },
    fuelCapacity: 60,
    ammoCapacity: 24,
    size: 6.5,
    baseVision: 140,
    topSpeed: 8.5,
    strategicSpeed: 5.6,
    stealth: 0,
    model: 'tank',
  },
};

export const ENGINES: Record<string, EngineDef> = {
  diesel_light: {
    id: 'diesel_light',
    kind: 'engine',
    name: '6.5L Turbo Diesel',
    power: 70,
    mass: 0.4,
    cost: { refined: 2, components: 2 },
    buildHours: 2,
    fuelPerMetre: 0.0012,
    fuelPerUnit: 0.07,
  },
  diesel_v12: {
    id: 'diesel_v12',
    kind: 'engine',
    name: 'V12 Multi-fuel Diesel',
    power: 20,
    mass: 4,
    cost: { refined: 8, components: 6 },
    buildHours: 6,
    fuelPerMetre: 0.0045,
    fuelPerUnit: 0.2,
  },
};

export const ARMORS: Record<string, ArmorDef> = {
  none: { id: 'none', kind: 'armor', name: 'Unarmoured', armor: 0, hpBonus: 0, mass: 0, cost: {}, buildHours: 0 },
  light_plating: {
    id: 'light_plating',
    kind: 'armor',
    name: 'Light Steel Plating',
    armor: 4,
    hpBonus: 30,
    mass: 0.4,
    cost: { refined: 3 },
    buildHours: 1,
  },
  composite_heavy: {
    id: 'composite_heavy',
    kind: 'armor',
    name: 'Composite Armour Package',
    armor: 520,
    hpBonus: 250,
    mass: 18,
    cost: { refined: 10, components: 4 },
    buildHours: 10,
  },
};

export const WEAPONS: Record<string, WeaponDef> = {
  assault_rifles: {
    id: 'assault_rifles',
    kind: 'weapon',
    name: 'Assault Rifles & LMG',
    weaponClass: 'small_arms',
    range: 160,
    damage: 7,
    penetration: 5,
    rof: 1.4,
    accuracy: 0.55,
    ammoPerShot: 0.035,
    projectileSpeed: 700,
    vsInfantry: 1,
    vsStructure: 0.15,
    movingAccuracy: 0.35,
    scalesWithMen: true,
    suppression: 0.08,
    mass: 0.05,
    cost: { components: 1 },
    buildHours: 1,
  },
  squad_at: {
    id: 'squad_at',
    kind: 'weapon',
    name: 'Disposable AT Launchers',
    weaponClass: 'at_rocket',
    range: 135,
    damage: 210,
    penetration: 420,
    rof: 0.085,
    accuracy: 0.42,
    ammoPerShot: 1,
    projectileSpeed: 180,
    vsInfantry: 0.3,
    vsStructure: 0.8,
    antiVehicleOnly: true,
    movingAccuracy: 0.2,
    suppression: 0.2,
    mass: 0.05,
    cost: { components: 1 },
    buildHours: 1,
  },
  hmg_127: {
    id: 'hmg_127',
    kind: 'weapon',
    name: '12.7mm Heavy Machine Gun',
    weaponClass: 'hmg',
    range: 175,
    damage: 10,
    penetration: 25,
    rof: 2.2,
    accuracy: 0.5,
    ammoPerShot: 0.08,
    projectileSpeed: 850,
    vsInfantry: 1,
    vsStructure: 0.35,
    movingAccuracy: 0.6,
    suppression: 0.12,
    mass: 0.1,
    cost: { refined: 1, components: 1 },
    buildHours: 1,
  },
  cannon_120: {
    id: 'cannon_120',
    kind: 'weapon',
    name: '120mm Smoothbore Gun',
    weaponClass: 'cannon',
    range: 270,
    damage: 300,
    penetration: 620,
    rof: 0.17,
    accuracy: 0.7,
    ammoPerShot: 1,
    projectileSpeed: 1100,
    vsInfantry: 0.35,
    vsStructure: 1.4,
    movingAccuracy: 0.55,
    suppression: 0.45,
    mass: 3,
    cost: { refined: 6, components: 5 },
    buildHours: 6,
  },
  bunker_mg: {
    id: 'bunker_mg',
    kind: 'weapon',
    name: 'Twin 12.7mm MG (casemate)',
    weaponClass: 'hmg',
    range: 215,
    damage: 10,
    penetration: 30,
    rof: 2.6,
    accuracy: 0.55,
    ammoPerShot: 0.08,
    projectileSpeed: 850,
    vsInfantry: 1,
    vsStructure: 0.35,
    movingAccuracy: 1,
    suppression: 0.16,
    mass: 0.3,
    cost: { refined: 2, components: 2 },
    buildHours: 2,
  },
  at_gun_90: {
    id: 'at_gun_90',
    kind: 'weapon',
    name: '90mm Anti-Tank Gun',
    weaponClass: 'cannon',
    range: 285,
    damage: 270,
    penetration: 560,
    rof: 0.2,
    accuracy: 0.62,
    ammoPerShot: 1,
    projectileSpeed: 1000,
    vsInfantry: 0.25,
    vsStructure: 1,
    antiVehicleOnly: true,
    movingAccuracy: 1,
    suppression: 0.3,
    mass: 2,
    cost: { refined: 6, components: 6 },
    buildHours: 4,
  },
  coax_mg: {
    id: 'coax_mg',
    kind: 'weapon',
    name: '7.62mm Coaxial MG',
    weaponClass: 'mg',
    range: 170,
    damage: 8,
    penetration: 6,
    rof: 1.6,
    accuracy: 0.5,
    ammoPerShot: 0.03,
    projectileSpeed: 800,
    vsInfantry: 1,
    vsStructure: 0.1,
    movingAccuracy: 0.6,
    suppression: 0.1,
    mass: 0.05,
    cost: { components: 1 },
    buildHours: 1,
  },
};

export const SENSORS: Record<string, SensorDef> = {
  binoculars: {
    id: 'binoculars',
    kind: 'sensor',
    name: 'Binoculars & Radios',
    visionBonus: 20,
    spotting: 0.3,
    mass: 0,
    cost: {},
    buildHours: 0,
  },
  recon_optics: {
    id: 'recon_optics',
    kind: 'sensor',
    name: 'Recon Optics Mast',
    visionBonus: 70,
    spotting: 0.5,
    mass: 0.1,
    cost: { components: 2 },
    buildHours: 1,
  },
  tank_sight: {
    id: 'tank_sight',
    kind: 'sensor',
    name: 'Gunner Thermal Sight',
    visionBonus: 50,
    spotting: 0.2,
    mass: 0.2,
    cost: { components: 3 },
    buildHours: 2,
  },
};

export const ELECTRONICS: Record<string, ElectronicsDef> = {
  fire_control: {
    id: 'fire_control',
    kind: 'electronics',
    name: 'Ballistic Fire Control',
    accuracyBonus: 0.08,
    mass: 0.1,
    cost: { components: 3 },
    buildHours: 2,
  },
};

export function getComponent(id: string): ComponentDef | undefined {
  return CHASSIS[id] ?? ENGINES[id] ?? ARMORS[id] ?? WEAPONS[id] ?? SENSORS[id] ?? ELECTRONICS[id];
}
