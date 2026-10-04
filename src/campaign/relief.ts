import { dist } from '../core/math';
import { FACTION_DEFS } from '../data/factions';
import { stockFrom, type PartialStock } from '../data/resources';
import { CAMP_HOUSING, stepBaseEconomy, storageCapacity } from '../economy/economy';
import { BASE_RADIUS } from '../world/mapgen';
import { flattenArea } from '../world/terrain';
import { makeBuilding, OUTPOST_RANGE } from './construction';
import { log, newId, type SimContext } from './context';
import { nextBaseName, siteProblem } from './expansion';
import { emptyEcon, placeStartBuilding } from './newCampaign';
import { areHostile, armiesOf, basesOf } from './queries';
import { createUnit } from './units';
import type { Base, CampaignState } from './types';
import type { World } from '../world/world';

/**
 * Expedition recovery. An expedition that has lost every base is not
 * written off at once: after a few days Earth lands a relief module
 * somewhere safe (at most MAX_RELIEF_LANDINGS times per campaign — Earth's
 * support is running out). Surviving task forces can regroup there.
 */

/** Hours without any base before the relief landing arrives. */
export const RELIEF_DELAY = 72;
/** Relief landings Earth can mount for one expedition over a campaign. */
export const MAX_RELIEF_LANDINGS = 2;
export const RELIEF_COLONISTS = 30;
export const RELIEF_SUPPLIES: PartialStock = { minerals: 140, hydrocarbons: 40, food: 120, refined: 90, components: 24, fuel: 40, ammo: 50 };
/** Campaign step length (h); mirrors SIM_STEP in sim.ts (imported there, so not imported here). */
const SIM_STEP_HOURS = 0.1;
/** Keep the landing at least this far (km) from hostile bases and forces. */
const SAFE_DISTANCE = 90;

export function stepRelief(ctx: SimContext): void {
  const { state, world } = ctx;
  for (const f of Object.values(state.factions)) {
    if (basesOf(state, f.id).length > 0) {
      f.baselessSince = null;
      continue;
    }
    if (f.baselessSince === null) {
      f.baselessSince = state.time;
      if (f.isPlayer) {
        log(
          state,
          f.reliefLandings < MAX_RELIEF_LANDINGS
            ? 'Earth command: hold on. A relief landing is being prepared — expect it in about three days.'
            : 'Earth command has gone silent. No more relief landings will come.',
          'warn',
          f.id,
        );
      }
      continue;
    }
    if (f.reliefLandings >= MAX_RELIEF_LANDINGS || state.time - f.baselessSince < RELIEF_DELAY) continue;
    // the full-map site search is costly: look once at the start of every hour
    if (state.time % 1 >= SIM_STEP_HOURS) continue;
    const site = findReliefSite(state, world, f.id);
    if (!site) continue; // try again on a later step
    const base = landRelief(ctx, f.id, site.x, site.z);
    const last = f.reliefLandings >= MAX_RELIEF_LANDINGS;
    if (f.isPlayer) {
      log(state, `Relief landing: ${base.name} is operational with ${RELIEF_COLONISTS} colonists and supplies.${last ? ' Earth: "This is all we can spare."' : ''}`, 'econ', f.id);
    } else {
      log(state, `Intelligence: ${FACTION_DEFS[f.defId]?.codename ?? f.name} has landed a relief expedition.`, 'info');
    }
  }
}

/** Hours until this expedition's relief landing (0 = due now), or null when it holds a base or Earth has no more to send. */
export function reliefEta(state: CampaignState, factionId: string): number | null {
  const f = state.factions[factionId];
  if (!f || basesOf(state, factionId).length > 0 || f.reliefLandings >= MAX_RELIEF_LANDINGS) return null;
  if (f.baselessSince === null) return RELIEF_DELAY;
  return Math.max(0, f.baselessSince + RELIEF_DELAY - state.time);
}

/** Free ground far from hostile bases and forces, near unclaimed resources and our surviving task forces. */
export function findReliefSite(state: CampaignState, world: World, factionId: string): { x: number; z: number } | null {
  const size = world.terrain.size;
  const hostileBases = Object.values(state.bases).filter((b) => b.factionId !== factionId);
  const hostileArmies = Object.values(state.armies).filter((a) => a.factionId !== factionId && areHostile(state, a.factionId, factionId));
  const ownArmies = armiesOf(state, factionId);
  const freeSites = Object.values(state.sites).filter((s) => !s.buildingId || state.buildings[s.buildingId]?.state === 'destroyed');
  let best: { x: number; z: number } | null = null;
  let bestScore = -Infinity;
  const step = 24;
  for (let x = BASE_RADIUS + 8; x < size - BASE_RADIUS - 8; x += step) {
    for (let z = BASE_RADIUS + 8; z < size - BASE_RADIUS - 8; z += step) {
      let threat = Infinity;
      for (const b of hostileBases) threat = Math.min(threat, dist(b.x, b.z, x, z));
      for (const a of hostileArmies) threat = Math.min(threat, dist(a.x, a.z, x, z));
      if (threat < SAFE_DISTANCE) continue;
      if (siteProblem(state, world, factionId, x, z)) continue;
      let score = Math.min(threat, 260) * 0.1;
      for (const s of freeSites) if (dist(s.x, s.z, x, z) <= OUTPOST_RANGE) score += 6 * s.richness;
      for (const a of ownArmies) score += Math.max(0, 25 - dist(a.x, a.z, x, z) * 0.15);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  return best;
}

/** Land a relief expedition at (x, z): finished landing modules, colonists, supplies and a guard. */
export function landRelief(ctx: SimContext, factionId: string, x: number, z: number): Base {
  const { state, world, rng } = ctx;
  const f = state.factions[factionId];
  flattenArea(world.terrain, x, z, BASE_RADIUS);
  const base: Base = {
    id: newId(state, 'base'),
    name: nextBaseName(state, factionId),
    factionId,
    x,
    z,
    radius: BASE_RADIUS,
    stock: stockFrom(RELIEF_SUPPLIES),
    population: RELIEF_COLONISTS,
    growth: 0,
    garrison: [createUnit(state, 'rifle_squad'), createUnit(state, 'rifle_squad')],
    founded: state.time,
    econ: { ...emptyEcon(), housing: CAMP_HOUSING, storageCap: storageCapacity(state, '') },
  };
  state.bases[base.id] = base;
  const hq = makeBuilding(state, 'hq', base, x, z, rng.range(0, Math.PI * 2), null, true);
  state.buildings[hq.id] = hq;
  const a0 = rng.range(0, Math.PI * 2);
  placeStartBuilding(ctx, base, 'habitat', a0, 4.2);
  placeStartBuilding(ctx, base, 'farm', a0 + 2.1, 4.4);
  f.reliefLandings++;
  f.baselessSince = null;
  f.defeated = false;
  stepBaseEconomy(ctx, base, 0);
  return base;
}
