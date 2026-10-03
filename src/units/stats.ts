import {
  ARMORS,
  CHASSIS,
  ELECTRONICS,
  ENGINES,
  SENSORS,
  WEAPONS,
  type ChassisDef,
  type Mobility,
  type UnitFamily,
  type WeaponDef,
} from '../data/components';
import { sumPartial, type PartialStock } from '../data/resources';
import { UNIT_DESIGNS, type UnitDesign } from '../data/unitDesigns';

/** Derived, read-only stats for a unit design. */
export interface UnitStats {
  designId: string;
  name: string;
  short: string;
  family: UnitFamily;
  mobility: Mobility;
  model: ChassisDef['model'];
  crew: number;
  maxHp: number;
  hpPerMan: number;
  armor: number;
  /** Tactical speed in m/s. */
  speed: number;
  /** Campaign speed in map units / hour. */
  strategicSpeed: number;
  vision: number;
  spotting: number;
  stealth: number;
  accuracyBonus: number;
  weapons: WeaponDef[];
  fuelCapacity: number;
  fuelPerMetre: number;
  fuelPerUnit: number;
  ammoCapacity: number;
  size: number;
  mass: number;
  /** Materials consumed when the unit is produced (people are separate). */
  cost: PartialStock;
  buildHours: number;
  producedAt: UnitDesign['producedAt'];
  /** Rough combat value used by AI estimates and auto-resolve heuristics. */
  power: number;
  isVehicle: boolean;
}

const cache = new Map<string, UnitStats>();

export function computeStats(design: UnitDesign): UnitStats {
  const ch = CHASSIS[design.chassis];
  if (!ch) throw new Error(`Unknown chassis ${design.chassis}`);
  const eng = design.engine ? ENGINES[design.engine] : undefined;
  const arm = design.armor ? ARMORS[design.armor] : undefined;
  const weapons = design.weapons.map((w) => {
    const def = WEAPONS[w];
    if (!def) throw new Error(`Unknown weapon ${w}`);
    return def;
  });
  const sensors = design.sensors.map((s) => SENSORS[s]).filter(Boolean);
  const elec = (design.electronics ?? []).map((e) => ELECTRONICS[e]).filter(Boolean);

  let mass = ch.mass + (eng?.mass ?? 0) + (arm?.mass ?? 0);
  for (const w of weapons) mass += w.mass;
  for (const s of sensors) mass += s.mass;
  for (const e of elec) mass += e.mass;

  let cost: PartialStock = { ...ch.cost };
  let buildHours = ch.buildHours;
  for (const c of [eng, arm, ...weapons, ...sensors, ...elec]) {
    if (!c) continue;
    cost = sumPartial(cost, c.cost);
    buildHours += c.buildHours;
  }
  if (design.extraCost) cost = sumPartial(cost, design.extraCost);

  const isInfantry = ch.family === 'infantry';
  const hpPerMan = ch.hpPerMan ?? 0;
  const maxHp = isInfantry ? ch.crew * hpPerMan : ch.baseHp + (arm?.hpBonus ?? 0);

  // Power-to-weight scaling of the chassis' top speed.
  let speedFactor = 1;
  if (eng) {
    const ptw = (eng.power * 10) / Math.max(1, mass);
    speedFactor = Math.max(0.45, Math.min(1.1, Math.sqrt(ptw / (ch.mobility === 'tracked' ? 4.5 : 120))));
  }
  const speed = ch.topSpeed * speedFactor;
  const strategicSpeed = ch.strategicSpeed * Math.min(1.05, Math.max(0.6, speedFactor));

  const vision = ch.baseVision + sensors.reduce((a, s) => a + s.visionBonus, 0);
  const spotting = Math.min(1, sensors.reduce((a, s) => Math.max(a, s.spotting), 0));
  const accuracyBonus = elec.reduce((a, e) => a + e.accuracyBonus, 0);

  // Combat power heuristic (AI estimates): sqrt(damage output x survivability).
  // Calibrated against headless battle results: tank ~4-5 squads, jeep ~1 squad.
  let dps = 0;
  for (const w of weapons) dps += w.damage * w.rof * w.accuracy * (w.antiVehicleOnly ? 0.6 : 1);
  const survivability = maxHp * (1 + (arm?.armor ?? 0) / 1500);
  const power = Math.round(Math.sqrt(dps * survivability) * 10) / 10;

  return {
    designId: design.id,
    name: design.name,
    short: design.short,
    family: ch.family,
    mobility: ch.mobility,
    model: ch.model,
    crew: ch.crew,
    maxHp,
    hpPerMan,
    armor: arm?.armor ?? 0,
    speed,
    strategicSpeed,
    vision,
    spotting,
    stealth: ch.stealth,
    accuracyBonus,
    weapons,
    fuelCapacity: ch.fuelCapacity,
    fuelPerMetre: eng?.fuelPerMetre ?? 0,
    fuelPerUnit: eng?.fuelPerUnit ?? 0,
    ammoCapacity: ch.ammoCapacity,
    size: ch.size,
    mass,
    cost,
    buildHours,
    producedAt: design.producedAt,
    power,
    isVehicle: !isInfantry,
  };
}

/** Cached stats lookup by design id. */
export function statsOf(designId: string): UnitStats {
  let s = cache.get(designId);
  if (!s) {
    const d = UNIT_DESIGNS[designId];
    if (!d) throw new Error(`Unknown unit design ${designId}`);
    s = computeStats(d);
    cache.set(designId, s);
  }
  return s;
}

/** Clear the cache (used when designs change, e.g. future unit designer/tests). */
export function clearStatsCache(): void {
  cache.clear();
}
