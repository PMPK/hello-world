import { dist } from '../core/math';
import { BUILDINGS } from '../data/buildings';
import { statsOf } from '../units/stats';
import { defenseStatsOf } from '../units/defense';
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

/**
 * Combat value of a base's crewed defensive structures. Positions without
 * ammunition in the base stock only count for a little (they can still be
 * resupplied when a battle starts if ammunition arrives).
 */
export function defenseStrength(state: CampaignState, base: Base): number {
  let s = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.baseId !== base.id || b.state !== 'active') continue;
    const ds = defenseStatsOf(b.typeId);
    if (!ds || ds.crew <= 0) continue;
    const crewF = Math.min(1, b.workers / ds.crew);
    s += ds.power * (b.hp / ds.maxHp) * crewF;
  }
  return base.stock.ammo >= 1 ? s : s * 0.25;
}

export function garrisonStrength(state: CampaignState, base: Base): number {
  let s = strengthOf(base.garrison) + defenseStrength(state, base);
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

/** Strategic fog of war: how far a task force sees (km). Bases see a little further, outposts less. */
export const PLAYER_VISION_RADIUS = 34;

/** A point a faction observes from, with its squared sight radius. */
export interface Eye {
  x: number;
  z: number;
  r2: number;
}

/** Everything a faction has eyes on the map with: task forces, bases and extractor outposts. */
export function eyesOf(state: CampaignState, factionId: string): Eye[] {
  const r2 = PLAYER_VISION_RADIUS * PLAYER_VISION_RADIUS;
  const eyes: Eye[] = [];
  for (const a of Object.values(state.armies)) if (a.factionId === factionId) eyes.push({ x: a.x, z: a.z, r2 });
  for (const b of Object.values(state.bases)) if (b.factionId === factionId) eyes.push({ x: b.x, z: b.z, r2: r2 * 1.2 });
  for (const b of Object.values(state.buildings)) {
    if (b.factionId !== factionId || b.typeId !== 'extractor' || b.state === 'destroyed') continue;
    eyes.push({ x: b.x, z: b.z, r2: r2 * 0.5 });
  }
  return eyes;
}

/** Whether any of `eyes` sees (x, z); `reach` scales the sight radius (0.5 = a close look). */
export function seenBy(eyes: Eye[], x: number, z: number, reach = 1): boolean {
  const k = reach * reach;
  for (const e of eyes) {
    const dx = e.x - x;
    const dz = e.z - z;
    if (dx * dx + dz * dz <= e.r2 * k) return true;
  }
  return false;
}

export function isVisibleToFaction(state: CampaignState, factionId: string, x: number, z: number): boolean {
  return seenBy(eyesOf(state, factionId), x, z);
}
