import type { BuildingTypeId } from './buildings';
import type { PartialStock } from './resources';

/**
 * A unit design = chassis + components. The three MVP designs below are
 * ordinary data; the future unit designer will create more of these at
 * runtime (and they will be stored in the save file).
 */
export interface UnitDesign {
  id: string;
  name: string;
  /** Short label for HUD chips. */
  short: string;
  description: string;
  chassis: string;
  engine?: string;
  armor?: string;
  weapons: string[];
  sensors: string[];
  electronics?: string[];
  producedAt: BuildingTypeId;
  /** Equipment / initial supplies loaded on completion (fuel & ammo fill-up). */
  extraCost?: PartialStock;
}

export const UNIT_DESIGNS: Record<string, UnitDesign> = {
  rifle_squad: {
    id: 'rifle_squad',
    name: 'Rifle Squad',
    short: 'INF',
    description:
      'Six soldiers with rifles, a light machine gun and disposable anti-tank launchers. Cheap in materials, costly in people. Excellent in forests and towns.',
    chassis: 'rifle_squad',
    weapons: ['assault_rifles', 'squad_at'],
    sensors: ['binoculars'],
    producedAt: 'barracks',
    extraCost: { ammo: 6 },
  },
  recon_jeep: {
    id: 'recon_jeep',
    name: 'Recon Jeep',
    short: 'JEEP',
    description:
      'Fast 4x4 with a 12.7mm machine gun and an optics mast. Scouts, harasses infantry, dies quickly to anything heavier.',
    chassis: 'light_4x4',
    engine: 'diesel_light',
    armor: 'light_plating',
    weapons: ['hmg_127'],
    sensors: ['recon_optics'],
    producedAt: 'vehicle_depot',
    extraCost: { fuel: 10, ammo: 4 },
  },
  mbt: {
    id: 'mbt',
    name: 'Main Battle Tank',
    short: 'TANK',
    description:
      'Heavily armoured, 120mm gun. Dominates open ground but is half-blind without infantry or recon support and vulnerable from the sides and rear.',
    chassis: 'mbt_hull',
    engine: 'diesel_v12',
    armor: 'composite_heavy',
    weapons: ['cannon_120', 'coax_mg'],
    sensors: ['tank_sight'],
    electronics: ['fire_control'],
    producedAt: 'vehicle_depot',
    extraCost: { fuel: 25, ammo: 10 },
  },
  atgm_team: {
    id: 'atgm_team',
    name: 'ATGM Team',
    short: 'ATGM',
    description:
      'Four soldiers with a guided anti-tank missile launcher and personal weapons. Out-ranges tank guns; slow to reload and helpless against infantry at close range. Requires the ATGM Teams research.',
    chassis: 'weapons_team',
    weapons: ['assault_rifles', 'atgm'],
    sensors: ['binoculars'],
    producedAt: 'barracks',
    extraCost: { ammo: 10 },
  },
  supply_truck: {
    id: 'supply_truck',
    name: 'Supply Truck',
    short: 'SUP',
    description:
      'Unarmed 6x6 truck carrying fuel, ammunition and rations for its task force. Keeps armies supplied away from bases and rearms nearby units in battle. Protect it.',
    chassis: 'truck_6x6',
    engine: 'diesel_light',
    armor: 'none',
    weapons: [],
    sensors: [],
    producedAt: 'vehicle_depot',
    extraCost: { fuel: 60, ammo: 30 },
  },
};

export const DESIGN_ORDER = ['rifle_squad', 'atgm_team', 'recon_jeep', 'mbt', 'supply_truck'];
