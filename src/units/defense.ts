import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { WEAPONS, type WeaponDef } from '../data/components';

/** Derived combat stats of a defensive structure (bunker, gun emplacement). */
export interface DefenseStats {
  typeId: BuildingTypeId;
  weapons: WeaponDef[];
  vision: number;
  eyeHeight: number;
  ammoCapacity: number;
  /** Full crew (the building's worker requirement). */
  crew: number;
  maxHp: number;
  turret: boolean;
  maxRange: number;
  /** Combat value on the same scale as UnitStats.power (full crew and health). */
  power: number;
}

const cache = new Map<BuildingTypeId, DefenseStats | null>();

/** Stats for a defensive building type, or null for ordinary buildings. */
export function defenseStatsOf(typeId: BuildingTypeId): DefenseStats | null {
  const hit = cache.get(typeId);
  if (hit !== undefined) return hit;
  const def = BUILDINGS[typeId];
  let out: DefenseStats | null = null;
  if (def?.defense) {
    const weapons = def.defense.weapons.map((id) => {
      const w = WEAPONS[id];
      if (!w) throw new Error(`Unknown weapon ${id} on ${typeId}`);
      return w;
    });
    // same heuristic as units: sqrt(damage output x survivability)
    let dps = 0;
    let maxRange = 0;
    for (const w of weapons) {
      dps += w.damage * w.rof * w.accuracy * (w.antiVehicleOnly ? 0.6 : 1);
      maxRange = Math.max(maxRange, w.range);
    }
    out = {
      typeId,
      weapons,
      vision: def.defense.vision,
      eyeHeight: def.defense.eyeHeight,
      ammoCapacity: def.defense.ammoCapacity,
      crew: def.workers,
      maxHp: def.maxHp,
      turret: def.defense.turret,
      maxRange,
      power: Math.round(Math.sqrt(dps * def.maxHp) * 10) / 10,
    };
  }
  cache.set(typeId, out);
  return out;
}

export function isDefense(typeId: BuildingTypeId): boolean {
  return !!BUILDINGS[typeId]?.defense;
}
