import { dist } from '../core/math';
import { FACTION_DEFS } from '../data/factions';
import { canAfford, payCost, stockFrom, type PartialStock } from '../data/resources';
import { CAMP_HOUSING, storageCapacity } from '../economy/economy';
import { BASE_RADIUS } from '../world/mapgen';
import { BIOME, biomeAt, flattenArea, heightAt, slopeAt } from '../world/terrain';
import { buildRoad, makeBuilding } from './construction';
import { log, newId, type SimContext } from './context';
import { areHostile, basesOf } from './queries';
import type { Base, CampaignState } from './types';
import type { World } from '../world/world';

/**
 * Founding new bases: a prefabricated command post, colonists and starter
 * supplies leave an existing base for a new site. The terrain is flattened
 * at runtime exactly as at world generation (bases are re-applied in
 * founding order when a save is loaded).
 */

/** Paid by the founding base: prefab HQ modules plus the new base's starter supplies. */
export const FOUND_COST: PartialStock = { minerals: 160, refined: 110, components: 30, food: 60, fuel: 20, ammo: 10 };
/** What the new base starts with (part of FOUND_COST). */
export const FOUND_SUPPLIES: PartialStock = { minerals: 80, refined: 40, food: 60, fuel: 20, ammo: 10 };
export const FOUND_COLONISTS = 16;
/** People the founding base must keep. */
const KEEP_POPULATION = 12;
/** Minimum distance between base centres (map units = km). */
export const MIN_BASE_SPACING = 40;
/** Maximum distance from the founding base. */
export const MAX_FOUND_RANGE = 150;
export const MAX_BASES_PER_FACTION = 4;
/** Share of the HQ already done when the prefab modules arrive. */
export const HQ_PREFAB_PROGRESS = 0.45;

export type FoundResult = { ok: true; base: Base } | { ok: false; reason: string };

/** Can this base send out a founding party at all? */
export function canFoundFrom(state: CampaignState, from: Base): { ok: true } | { ok: false; reason: string } {
  if (basesOf(state, from.factionId).length >= MAX_BASES_PER_FACTION) return { ok: false, reason: `At most ${MAX_BASES_PER_FACTION} bases per expedition` };
  if (Math.floor(from.population) < FOUND_COLONISTS + KEEP_POPULATION) {
    return { ok: false, reason: `Needs ${FOUND_COLONISTS} colonists (and ${KEEP_POPULATION} staying)` };
  }
  if (!canAfford(from.stock, FOUND_COST)) return { ok: false, reason: 'Not enough materials and supplies' };
  return { ok: true };
}

/** Is (x, z) a valid site for a new base founded from `from`? */
export function validateBaseSite(state: CampaignState, world: World, from: Base, x: number, z: number): { ok: true } | { ok: false; reason: string } {
  const problem = siteProblem(state, world, from.factionId, x, z, from);
  return problem ? { ok: false, reason: problem } : { ok: true };
}

/**
 * Why (x, z) cannot take a new base for `factionId`, or null when it can:
 * inside the map, clear of other bases, resource sites and hostile forces,
 * on dry and reasonably flat land; within range of `from` when given.
 */
export function siteProblem(state: CampaignState, world: World, factionId: string, x: number, z: number, from?: Base): string | null {
  const t = world.terrain;
  const margin = BASE_RADIUS + 4;
  if (x < margin || z < margin || x > t.size - margin || z > t.size - margin) return 'Too close to the edge of the map';
  if (from && dist(x, z, from.x, from.z) > MAX_FOUND_RANGE) return `Out of range: at most ${MAX_FOUND_RANGE} km from ${from.name}`;
  for (const b of Object.values(state.bases)) {
    if (dist(x, z, b.x, b.z) < MIN_BASE_SPACING) return `Too close to ${b.name}`;
  }
  for (const s of Object.values(state.sites)) {
    if (dist(x, z, s.x, s.z) < BASE_RADIUS + 1.5) return 'A resource site is in the way';
  }
  // the perimeter must be dry, reasonably flat land
  let rough = 0;
  let n = 0;
  for (let r = 0; r <= BASE_RADIUS; r += BASE_RADIUS / 3) {
    const steps = r === 0 ? 1 : 12;
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      n++;
      const b = biomeAt(t, px, pz);
      if (b === BIOME.water || heightAt(t, px, pz) < 0.35) return 'Too close to water';
      if (b === BIOME.mountains || b === BIOME.snow || slopeAt(t, px, pz) > 1.6) rough++;
    }
  }
  if (rough / n > 0.2) return 'Terrain too rough';
  for (const a of Object.values(state.armies)) {
    if (a.factionId !== factionId && areHostile(state, a.factionId, factionId) && dist(a.x, a.z, x, z) < 20) return 'Hostile forces nearby';
  }
  return null;
}

export function nextBaseName(state: CampaignState, factionId: string): string {
  const def = FACTION_DEFS[state.factions[factionId]?.defId ?? ''];
  const used = new Set(Object.values(state.bases).map((b) => b.name));
  for (const n of def?.baseNames ?? []) if (!used.has(n)) return n;
  let k = Object.values(state.bases).length + 1;
  while (used.has(`Camp ${k}`)) k++;
  return `Camp ${k}`;
}

/** Found a new base at (x, z) from base `fromId`. */
export function foundBase(ctx: SimContext, fromId: string, x: number, z: number): FoundResult {
  const { state, world } = ctx;
  const from = state.bases[fromId];
  if (!from) return { ok: false, reason: 'No such base' };
  const can = canFoundFrom(state, from);
  if (!can.ok) return can;
  const site = validateBaseSite(state, world, from, x, z);
  if (!site.ok) return site;

  payCost(from.stock, FOUND_COST);
  from.population -= FOUND_COLONISTS;
  flattenArea(world.terrain, x, z, BASE_RADIUS);

  const stock = stockFrom(FOUND_SUPPLIES);
  const base: Base = {
    id: newId(state, 'base'),
    name: nextBaseName(state, from.factionId),
    factionId: from.factionId,
    x,
    z,
    radius: BASE_RADIUS,
    stock,
    population: FOUND_COLONISTS,
    growth: 0,
    garrison: [],
    founded: state.time,
    econ: {
      energyProduced: 0,
      energyDemand: 0,
      workersNeeded: 0,
      workersEmployed: 0,
      housing: CAMP_HOUSING,
      foodPerHour: 0,
      rates: {},
      storageCap: storageCapacity(state, ''),
    },
  };
  state.bases[base.id] = base;
  const hq = makeBuilding(state, 'hq', base, x, z, Math.atan2(from.x - x, from.z - z), null, false);
  hq.buildProgress = HQ_PREFAB_PROGRESS;
  state.buildings[hq.id] = hq;
  buildRoad(ctx, from, hq);
  if (state.factions[from.factionId]?.isPlayer) {
    log(state, `Colonists from ${from.name} have founded ${base.name}. The command post is being assembled.`, 'econ', from.factionId);
  }
  return { ok: true, base };
}
