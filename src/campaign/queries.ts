import { dist } from '../core/math';
import { BUILDINGS } from '../data/buildings';
import { statsOf } from '../units/stats';
import type { Army, Base, Building, CampaignState, Relation, UnitInstance } from './types';

export function basesOf(state: CampaignState, factionId: string): Base[] {
  return Object.values(state.bases).filter((b) => b.factionId === factionId);
}

export function buildingsOfBase(state: CampaignState, baseId: string): Building[] {
  return Object.values(state.buildings).filter((b) => b.baseId === baseId);
}

export function armiesOf(state: CampaignState, factionId: string): Army[] {
  return Object.values(state.armies).filter((a) => a.factionId === factionId);
}

export function playerFaction(state: CampaignState): string {
  return state.playerFactionId;
}

export function enemyFactionOf(state: CampaignState, factionId: string): string | null {
  for (const id of Object.keys(state.factions)) if (id !== factionId) return id;
  return null;
}

export function hqOf(state: CampaignState, baseId: string): Building | undefined {
  return Object.values(state.buildings).find((b) => b.baseId === baseId && b.typeId === 'hq');
}

export function isOutpost(state: CampaignState, b: Building): boolean {
  const base = state.bases[b.baseId];
  if (!base) return true;
  return dist(base.x, base.z, b.x, b.z) > base.radius + 0.5;
}

export function nearestBaseOf(state: CampaignState, factionId: string, x: number, z: number): Base | null {
  let best: Base | null = null;
  let bd = Infinity;
  for (const b of basesOf(state, factionId)) {
    const d = dist(b.x, b.z, x, z);
    if (d < bd) {
      bd = d;
      best = b;
    }
  }
  return best;
}

export function baseAt(state: CampaignState, x: number, z: number, extra = 0): Base | null {
  for (const b of Object.values(state.bases)) if (dist(b.x, b.z, x, z) <= b.radius + extra) return b;
  return null;
}

/** Sum of men aboard units. */
export function menIn(units: UnitInstance[]): number {
  let n = 0;
  for (const u of units) n += u.men;
  return n;
}

/** Combat strength estimate: power weighted by remaining health and ammo. */
export function strengthOf(units: UnitInstance[]): number {
  let s = 0;
  for (const u of units) {
    const st = statsOf(u.designId);
    const hpF = st.maxHp > 0 ? u.hp / st.maxHp : 1;
    const ammoF = st.ammoCapacity > 0 ? 0.35 + 0.65 * Math.min(1, u.ammo / st.ammoCapacity) : 1;
    s += st.power * hpF * ammoF;
  }
  return s;
}

export function armyStrength(a: Army): number {
  return strengthOf(a.units);
}

export function garrisonStrength(state: CampaignState, base: Base): number {
  let s = strengthOf(base.garrison);
  for (const a of Object.values(state.armies)) {
    if (a.factionId === base.factionId && dist(a.x, a.z, base.x, base.z) <= base.radius + 3) s += armyStrength(a);
  }
  return s;
}

export function relationOf(state: CampaignState, a: string, b: string): Relation | null {
  return state.relations.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a)) ?? null;
}

export function areHostile(state: CampaignState, a: string, b: string): boolean {
  if (a === b) return false;
  const r = relationOf(state, a, b);
  return !r || r.status === 'hostile';
}

export function buildingMaxHp(b: Building): number {
  return BUILDINGS[b.typeId].maxHp;
}

export function countBuildings(state: CampaignState, baseId: string, typeId: Building['typeId'], includeConstruction = true): number {
  let n = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.baseId !== baseId || b.typeId !== typeId) continue;
    if (b.state === 'destroyed') continue;
    if (!includeConstruction && b.state !== 'active') continue;
    n++;
  }
  return n;
}

/** Strategic fog of war: positions the player currently has eyes on. */
export const PLAYER_VISION_RADIUS = 34;

export function isVisibleToFaction(state: CampaignState, factionId: string, x: number, z: number): boolean {
  const r2 = PLAYER_VISION_RADIUS * PLAYER_VISION_RADIUS;
  for (const a of Object.values(state.armies)) {
    if (a.factionId !== factionId) continue;
    const dx = a.x - x;
    const dz = a.z - z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  for (const b of Object.values(state.bases)) {
    if (b.factionId !== factionId) continue;
    const dx = b.x - x;
    const dz = b.z - z;
    if (dx * dx + dz * dz <= r2 * 1.2) return true;
  }
  for (const b of Object.values(state.buildings)) {
    if (b.factionId !== factionId || b.typeId !== 'extractor' || b.state === 'destroyed') continue;
    const dx = b.x - x;
    const dz = b.z - z;
    if (dx * dx + dz * dz <= r2 * 0.5) return true;
  }
  return false;
}
