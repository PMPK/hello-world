import { dist } from '../core/math';
import { mixSeed } from '../core/rng';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { ENEMY_FACTION_DEF, FACTION_DEFS, PLAYER_FACTION_DEF } from '../data/factions';
import { INTRO_SIGNOFF } from '../data/lore';
import { emptyStock, stockFrom } from '../data/resources';
import { emptyResearch } from '../research/research';
import type { Difficulty } from '../data/difficulty';
import { BASE_RADIUS, generateLayout } from '../world/mapgen';
import { generateTerrain } from '../world/terrain';
import { World } from '../world/world';
import type { Character } from '../characters/character';
import { createArmy } from './armies';
import { buildRoad, makeBuilding, suggestPlacement } from './construction';
import { log, makeContext, newId, syncRng, type SimContext } from './context';
import { createUnit } from './units';
import { stepBaseEconomy } from '../economy/economy';
import { STATE_VERSION, type Base, type CampaignState, type FactionState } from './types';

export const STARTING_STOCK = {
  minerals: 160,
  hydrocarbons: 90,
  food: 140,
  refined: 110,
  components: 40,
  fuel: 70,
  ammo: 80,
};
export const STARTING_POPULATION = 52;

export interface Campaign {
  state: CampaignState;
  world: World;
}

export function emptyEcon(): Base['econ'] {
  return {
    energyProduced: 0,
    energyDemand: 0,
    workersNeeded: 0,
    workersEmployed: 0,
    housing: 0,
    foodPerHour: 0,
    rates: {},
    storageCap: emptyStock(),
  };
}

function blankState(seed: number, difficulty: Difficulty): CampaignState {
  return {
    version: STATE_VERSION,
    seed,
    difficulty,
    time: 0,
    rngState: mixSeed(seed, 'campaign-rng'),
    nextId: 1,
    playerFactionId: '',
    factions: {},
    bases: {},
    buildings: {},
    sites: {},
    armies: {},
    convoys: {},
    roads: {},
    characters: {},
    relations: [],
    ai: {},
    log: [],
    pendingBattle: null,
    nextEarthFlightAt: 84,
    earthFlights: 0,
    stats: { battlesFought: 0, battlesWon: 0, unitsLost: {}, soldiersKilled: {} },
  };
}

function addFaction(state: CampaignState, defId: string, isPlayer: boolean): FactionState {
  const def = FACTION_DEFS[defId];
  const f: FactionState = {
    id: def.id,
    defId,
    isPlayer,
    name: def.name,
    color: def.color,
    defeated: false,
    research: emptyResearch(),
    armyCounter: 0,
    baselessSince: null,
    reliefLandings: 0,
  };
  state.factions[f.id] = f;
  return f;
}

/** Place a finished structure near (angle, r) from the base centre (start-up and relief landings). */
export function placeStartBuilding(ctx: SimContext, base: Base, typeId: BuildingTypeId, angle: number, r: number): void {
  const { state, world } = ctx;
  const px = base.x + Math.cos(angle) * r;
  const pz = base.z + Math.sin(angle) * r;
  const spot = suggestPlacement(state, world, base, typeId, px, pz);
  if (!spot) return;
  const rot = Math.atan2(base.x - spot.x, base.z - spot.z) + Math.PI;
  const b = makeBuilding(state, typeId, base, spot.x, spot.z, rot, null, true);
  state.buildings[b.id] = b;
}

function setupExpedition(ctx: SimContext, factionId: string, x: number, z: number): Base {
  const { state, rng } = ctx;
  const def = FACTION_DEFS[state.factions[factionId].defId];
  const base: Base = {
    id: newId(state, 'base'),
    name: def.baseNames[0],
    factionId,
    x,
    z,
    radius: BASE_RADIUS,
    stock: stockFrom(STARTING_STOCK),
    population: STARTING_POPULATION,
    growth: 0,
    garrison: [],
    founded: 0,
    econ: emptyEcon(),
  };
  state.bases[base.id] = base;

  // HQ in the centre, a few core structures around it.
  const hq = makeBuilding(state, 'hq', base, x, z, rng.range(0, Math.PI * 2), null, true);
  state.buildings[hq.id] = hq;
  const a0 = rng.range(0, Math.PI * 2);
  placeStartBuilding(ctx, base, 'habitat', a0, 4.2);
  placeStartBuilding(ctx, base, 'farm', a0 + 1.4, 4.4);
  placeStartBuilding(ctx, base, 'barracks', a0 + 2.9, 4.4);
  placeStartBuilding(ctx, base, 'habitat', a0 - 1.5, 4.3);

  // One working mine on the nearest mineral deposit.
  const mineral = Object.values(state.sites)
    .filter((s) => s.kind === 'minerals' && !s.buildingId)
    .sort((p, q) => dist(p.x, p.z, x, z) - dist(q.x, q.z, x, z))[0];
  if (mineral) {
    const ext = makeBuilding(state, 'extractor', base, mineral.x, mineral.z, Math.atan2(x - mineral.x, z - mineral.z), mineral.id, true);
    state.buildings[ext.id] = ext;
    mineral.buildingId = ext.id;
    buildRoad(ctx, base, ext);
  }

  // Starting forces: a small field task force with its supply truck and a squad on guard duty.
  const units = [
    createUnit(state, 'rifle_squad'),
    createUnit(state, 'rifle_squad'),
    createUnit(state, 'rifle_squad'),
    createUnit(state, 'recon_jeep'),
    createUnit(state, 'recon_jeep'),
    createUnit(state, 'mbt'),
    createUnit(state, 'supply_truck'),
  ];
  const ang = rng.range(0, Math.PI * 2);
  let ax = x + Math.cos(ang) * (BASE_RADIUS + 3);
  let az = z + Math.sin(ang) * (BASE_RADIUS + 3);
  for (let k = 0; k < 12 && !ctx.world.isPassable(ax, az); k++) {
    const a2 = ang + k * 0.55;
    ax = x + Math.cos(a2) * (BASE_RADIUS + 3);
    az = z + Math.sin(a2) * (BASE_RADIUS + 3);
  }
  createArmy(ctx, factionId, ax, az, units, base.id);
  base.garrison.push(createUnit(state, 'rifle_squad'));
  return base;
}

/** Create a brand-new campaign from a seed. Deterministic for a given seed. */
export function createCampaign(seed: number, difficulty: Difficulty = 'normal'): Campaign {
  const raw = generateTerrain(seed);
  const layout = generateLayout(raw, seed);
  const world = new World(seed, layout.bases, []);
  const state = blankState(seed, difficulty);
  const ctx = makeContext(state, world);

  const player = addFaction(state, PLAYER_FACTION_DEF, true);
  const enemy = addFaction(state, ENEMY_FACTION_DEF, false);
  state.playerFactionId = player.id;
  state.relations.push({ a: player.id, b: enemy.id, status: 'standoff', tension: 8, warningIssued: false });
  state.ai[enemy.id] = { factionId: enemy.id, nextThinkAt: 1, lastAttackLaunch: -999, targetKind: null, targetId: null, lastBuildCheck: 0 };

  for (const s of layout.sites) {
    const id = newId(state, 's');
    state.sites[id] = { id, kind: s.kind, x: s.x, z: s.z, richness: s.richness, buildingId: null };
  }

  const pBase = setupExpedition(ctx, player.id, layout.bases[0].x, layout.bases[0].z);
  const eBase = setupExpedition(ctx, enemy.id, layout.bases[1].x, layout.bases[1].z);

  const director: Character = {
    id: newId(state, 'ch'),
    name: 'Expedition Director',
    factionId: player.id,
    role: 'expedition_director',
    skills: { command: 3, logistics: 3, tactics: 3 },
    alive: true,
    location: { kind: 'base', id: pBase.id },
    player: { controlMode: 'command_post', commandCapacity: 6 },
  };
  state.characters[director.id] = director;
  const enemyDirector: Character = {
    id: newId(state, 'ch'),
    name: 'Col. V. Rostova',
    factionId: enemy.id,
    role: 'expedition_director',
    skills: { command: 4, logistics: 3, tactics: 3 },
    alive: true,
    location: { kind: 'base', id: eBase.id },
  };
  state.characters[enemyDirector.id] = enemyDirector;

  log(state, `Day 1. ${pBase.name} reports all modules operational.`, 'lore', player.id);
  log(state, INTRO_SIGNOFF, 'lore', player.id);
  log(state, `${FACTION_DEFS[enemy.defId].codename} landing site confirmed ${Math.round(dist(pBase.x, pBase.z, eBase.x, eBase.z))} km to the north-east.`, 'info', player.id);
  // a zero-length economy pass assigns workers and fills the HUD snapshot before the clock starts
  for (const b of [pBase, eBase]) stepBaseEconomy(ctx, b, 0);
  syncRng(ctx);
  return { state, world };
}

/** Rebuild the runtime World for a loaded state. */
export function worldForState(state: CampaignState): World {
  const basePositions = Object.values(state.bases)
    .slice()
    .sort((a, b) => a.founded - b.founded || (a.id < b.id ? -1 : 1))
    .map((b) => ({ x: b.x, z: b.z }));
  return new World(state.seed, basePositions, Object.values(state.roads));
}

export const BUILDING_LIST = Object.keys(BUILDINGS) as BuildingTypeId[];
