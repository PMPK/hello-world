import { statsOf } from '../units/stats';
import { newId } from './context';
import type { CampaignState, UnitInstance } from './types';

/** A freshly produced unit: full health, crew, fuel and ammunition. */
export function createUnit(state: CampaignState, designId: string): UnitInstance {
  const st = statsOf(designId);
  return {
    id: newId(state, 'u'),
    designId,
    hp: st.maxHp,
    men: st.crew,
    ammo: st.ammoCapacity,
    fuel: st.fuelCapacity,
    xp: 0,
  };
}

export function unitAlive(u: UnitInstance): boolean {
  return u.hp > 0 && u.men > 0;
}

/** Health fraction 0..1. */
export function unitHealth(u: UnitInstance): number {
  const st = statsOf(u.designId);
  return st.maxHp > 0 ? Math.max(0, Math.min(1, u.hp / st.maxHp)) : 0;
}

/** For infantry, HP and men are coupled: men = ceil(hp / hpPerMan). */
export function syncInfantryMen(u: UnitInstance): void {
  const st = statsOf(u.designId);
  if (st.isVehicle || st.hpPerMan <= 0) return;
  u.men = Math.max(0, Math.min(st.crew, Math.ceil(u.hp / st.hpPerMan - 1e-6)));
}
