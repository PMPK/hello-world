import { dist } from '../core/math';
import { BUILDINGS, REBUILD_COST_FACTOR, type BuildingTypeId } from '../data/buildings';
import { addToStock, canAfford, missingFor, payCost, RESOURCES, type PartialStock } from '../data/resources';
import { BIOME, biomeAt, heightAt, slopeAt } from '../world/terrain';
import { newId, type SimContext } from './context';
import { buildingsOfBase, countBuildings } from './queries';
import type { Base, Building, CampaignState, Road } from './types';
import type { World } from '../world/world';

/** Max distance from a base at which outposts (extractors) can be established. */
export const OUTPOST_RANGE = 70;

export type PlacementResult = { ok: true } | { ok: false; reason: string };

export function makeBuilding(
  state: CampaignState,
  typeId: BuildingTypeId,
  base: Base,
  x: number,
  z: number,
  rot: number,
  siteId: string | null,
  complete: boolean,
): Building {
  const def = BUILDINGS[typeId];
  return {
    id: newId(state, 'b'),
    typeId,
    baseId: base.id,
    factionId: base.factionId,
    x,
    z,
    rot,
    hp: complete ? def.maxHp : Math.round(def.maxHp * 0.1),
    state: complete ? 'active' : 'construction',
    buildProgress: complete ? 1 : 0,
    paid: true,
    recipeMode: 'auto',
    activeRecipe: null,
    cycleProgress: 0,
    storage: {},
    queue: [],
    repeat: null,
    siteId,
    enabled: true,
    repairing: false,
    lastConvoyTime: state.time,
    status: complete ? 'ok' : 'constructing',
    efficiency: 0,
    workers: 0,
  };
}

/** Validate a core-building placement inside a base. */
export function validatePlacement(
  state: CampaignState,
  world: World,
  base: Base,
  typeId: BuildingTypeId,
  x: number,
  z: number,
  ignoreId?: string,
): PlacementResult {
  const def = BUILDINGS[typeId];
  if (def.requiresSite) return { ok: false, reason: 'Must be built on a resource site' };
  if (dist(x, z, base.x, base.z) + def.footprint > base.radius) return { ok: false, reason: 'Outside base perimeter' };
  const t = world.terrain;
  if (heightAt(t, x, z) < 0.3) return { ok: false, reason: 'Terrain is flooded' };
  if (slopeAt(t, x, z) > 1.4) return { ok: false, reason: 'Terrain too steep' };
  const b = biomeAt(t, x, z);
  if (b === BIOME.water || b === BIOME.mountains || b === BIOME.snow) return { ok: false, reason: 'Unsuitable terrain' };
  for (const other of buildingsOfBase(state, base.id)) {
    if (other.id === ignoreId) continue;
    const od = BUILDINGS[other.typeId];
    if (dist(other.x, other.z, x, z) < od.footprint + def.footprint + 0.35) return { ok: false, reason: 'Too close to another structure' };
  }
  return { ok: true };
}

/** Find a free spot for a building inside the base (spiral search). */
export function suggestPlacement(
  state: CampaignState,
  world: World,
  base: Base,
  typeId: BuildingTypeId,
  preferX?: number,
  preferZ?: number,
): { x: number; z: number } | null {
  const def = BUILDINGS[typeId];
  const cx = preferX ?? base.x;
  const cz = preferZ ?? base.z;
  let best: { x: number; z: number } | null = null;
  let bestD = Infinity;
  for (let r = 0; r <= base.radius; r += 0.6) {
    const n = Math.max(1, Math.round((r * Math.PI * 2) / 0.8));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r * 0.7;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (dist(x, z, base.x, base.z) + def.footprint > base.radius) continue;
      if (!validatePlacement(state, world, base, typeId, x, z).ok) continue;
      const d = dist(x, z, cx, cz);
      if (d < bestD) {
        bestD = d;
        best = { x, z };
      }
    }
    if (best) return best;
  }
  return best;
}

export function constructionCost(typeId: BuildingTypeId): PartialStock {
  return BUILDINGS[typeId].cost;
}

export function canBuildType(state: CampaignState, base: Base, typeId: BuildingTypeId): PlacementResult {
  const def = BUILDINGS[typeId];
  if (!def.buildable) return { ok: false, reason: 'Cannot be built' };
  if (def.maxPerBase !== undefined && countBuildings(state, base.id, typeId) >= def.maxPerBase) {
    return { ok: false, reason: `Limit ${def.maxPerBase} per base` };
  }
  if (!canAfford(base.stock, def.cost)) {
    const miss = missingFor(base.stock, def.cost).map((k) => RESOURCES[k].short);
    return { ok: false, reason: `Need ${miss.join(', ')}` };
  }
  return { ok: true };
}

/** Start constructing a core building (pays the full cost immediately). */
export function startConstruction(
  ctx: SimContext,
  baseId: string,
  typeId: BuildingTypeId,
  x: number,
  z: number,
): { ok: true; building: Building } | { ok: false; reason: string } {
  const { state, world } = ctx;
  const base = state.bases[baseId];
  if (!base) return { ok: false, reason: 'No such base' };
  const can = canBuildType(state, base, typeId);
  if (!can.ok) return can;
  const valid = validatePlacement(state, world, base, typeId, x, z);
  if (!valid.ok) return valid;
  payCost(base.stock, BUILDINGS[typeId].cost);
  const rot = Math.atan2(base.x - x, base.z - z) + Math.PI; // face away from HQ (doors outward)
  const b = makeBuilding(state, typeId, base, x, z, rot, null, false);
  state.buildings[b.id] = b;
  return { ok: true, building: b };
}

/** Validate building an extractor on a resource site. */
export function canBuildOutpost(state: CampaignState, base: Base, siteId: string): PlacementResult {
  const site = state.sites[siteId];
  if (!site) return { ok: false, reason: 'No such site' };
  if (site.buildingId) {
    const existing = state.buildings[site.buildingId];
    if (existing && existing.state !== 'destroyed') return { ok: false, reason: 'Site already claimed' };
  }
  if (dist(site.x, site.z, base.x, base.z) > OUTPOST_RANGE) return { ok: false, reason: 'Too far from base' };
  const can = canBuildType(state, base, 'extractor');
  if (!can.ok) return can;
  return { ok: true };
}

export function startOutpost(ctx: SimContext, baseId: string, siteId: string): { ok: true; building: Building } | { ok: false; reason: string } {
  const { state } = ctx;
  const base = state.bases[baseId];
  if (!base) return { ok: false, reason: 'No such base' };
  const can = canBuildOutpost(state, base, siteId);
  if (!can.ok) return can;
  const site = state.sites[siteId];
  // clear a destroyed extractor ruin on the site
  if (site.buildingId && state.buildings[site.buildingId]?.state === 'destroyed') {
    removeBuilding(state, site.buildingId);
  }
  payCost(base.stock, BUILDINGS.extractor.cost);
  const rot = Math.atan2(base.x - site.x, base.z - site.z);
  const b = makeBuilding(state, 'extractor', base, site.x, site.z, rot, site.id, false);
  state.buildings[b.id] = b;
  site.buildingId = b.id;
  buildRoad(ctx, base, b);
  return { ok: true, building: b };
}

/** Lay a road from the base to an outpost (used by convoys; speeds armies). */
export function buildRoad(ctx: SimContext, base: Base, b: Building): Road {
  const { state, world } = ctx;
  for (const r of Object.values(state.roads)) {
    if (r.toBuildingId === b.id) delete state.roads[r.id];
  }
  const path = world.findRoadPath({ x: base.x, z: base.z }, { x: b.x, z: b.z });
  const points = [{ x: base.x, z: base.z }, ...(path ?? [{ x: b.x, z: b.z }])];
  const road: Road = { id: newId(state, 'r'), factionId: base.factionId, fromBaseId: base.id, toBuildingId: b.id, points };
  state.roads[road.id] = road;
  world.rebuildRoads(Object.values(state.roads));
  return road;
}

export function removeBuilding(state: CampaignState, id: string): void {
  const b = state.buildings[id];
  if (!b) return;
  if (b.siteId && state.sites[b.siteId]?.buildingId === id) state.sites[b.siteId].buildingId = null;
  for (const r of Object.values(state.roads)) if (r.toBuildingId === id) delete state.roads[r.id];
  for (const c of Object.values(state.convoys)) if (c.fromBuildingId === id) delete state.convoys[c.id];
  delete state.buildings[id];
}

/** Cancel a construction site, refunding 75% of the cost. */
export function cancelConstruction(ctx: SimContext, buildingId: string): boolean {
  const { state, world } = ctx;
  const b = state.buildings[buildingId];
  if (!b || b.state !== 'construction') return false;
  const base = state.bases[b.baseId];
  if (base) addToStock(base.stock, BUILDINGS[b.typeId].cost, 0.75);
  removeBuilding(state, buildingId);
  world.rebuildRoads(Object.values(state.roads));
  return true;
}

/** Rebuild a destroyed structure in place for a fraction of its cost. */
export function rebuildBuilding(ctx: SimContext, buildingId: string): PlacementResult {
  const { state } = ctx;
  const b = state.buildings[buildingId];
  if (!b || b.state !== 'destroyed') return { ok: false, reason: 'Not destroyed' };
  const base = state.bases[b.baseId];
  if (!base) return { ok: false, reason: 'No base' };
  const def = BUILDINGS[b.typeId];
  if (!canAfford(base.stock, def.cost, REBUILD_COST_FACTOR)) {
    const scaled: PartialStock = {};
    for (const [k, v] of Object.entries(def.cost)) scaled[k as keyof PartialStock] = (v ?? 0) * REBUILD_COST_FACTOR;
    return { ok: false, reason: `Need ${missingFor(base.stock, scaled).map((k) => RESOURCES[k].short).join(', ')}` };
  }
  payCost(base.stock, def.cost, REBUILD_COST_FACTOR);
  b.state = 'construction';
  b.buildProgress = 0.25;
  b.hp = Math.round(def.maxHp * 0.25);
  b.queue = [];
  b.activeRecipe = null;
  b.cycleProgress = 0;
  return { ok: true };
}

export function setRepair(state: CampaignState, buildingId: string, on: boolean): void {
  const b = state.buildings[buildingId];
  if (b && b.state === 'active') b.repairing = on;
}

export function setRecipeMode(state: CampaignState, buildingId: string, mode: string): void {
  const b = state.buildings[buildingId];
  if (!b) return;
  const def = BUILDINGS[b.typeId];
  if (mode !== 'auto' && !def.recipes?.some((r) => r.id === mode)) return;
  b.recipeMode = mode;
}

export function toggleEnabled(state: CampaignState, buildingId: string): void {
  const b = state.buildings[buildingId];
  if (b && b.state === 'active') b.enabled = !b.enabled;
}
