import { dist, type Vec2 } from '../core/math';
import { RESOURCES, STOCK_RESOURCES, stockTotal, type PartialStock, type StockResourceId } from '../data/resources';
import { depositToBase } from '../economy/economy';
import { log, newId, type SimContext } from './context';
import { areHostile } from './queries';
import type { Base, Convoy } from './types';

export const CONVOY_SPEED = 12; // map units per hour
export const CONVOY_LOAD = 15;
export const CONVOY_MAX_INTERVAL = 12; // hours
const INTERCEPT_RADIUS = 1.8;

/** Dispatch convoys from extractors and move existing convoys along roads. */
export function stepConvoys(ctx: SimContext, dt: number): void {
  const { state } = ctx;
  // dispatch
  for (const b of Object.values(state.buildings)) {
    if (b.typeId !== 'extractor' || b.state !== 'active') continue;
    const held = stockTotal(b.storage);
    if (held <= 0.5) continue;
    const due = held >= CONVOY_LOAD || state.time - b.lastConvoyTime >= CONVOY_MAX_INTERVAL;
    if (!due) continue;
    if (Object.values(state.convoys).some((c) => c.fromBuildingId === b.id)) continue;
    const base = state.bases[b.baseId];
    if (!base || base.factionId !== b.factionId) continue;
    const road = Object.values(state.roads).find((r) => r.toBuildingId === b.id);
    const path = road ? road.points.slice().reverse() : [{ x: base.x, z: base.z }];
    const cargo: PartialStock = { ...b.storage };
    b.storage = {};
    b.lastConvoyTime = state.time;
    const c: Convoy = {
      id: newId(state, 'c'),
      factionId: b.factionId,
      fromBuildingId: b.id,
      toBaseId: base.id,
      cargo,
      people: 0,
      path: path.slice(1),
      x: b.x,
      z: b.z,
    };
    state.convoys[c.id] = c;
  }

  dispatchSupplyConvoys(ctx);

  // movement / delivery / interception
  for (const c of Object.values(state.convoys)) {
    const base = state.bases[c.toBaseId];
    if (!base || base.factionId !== c.factionId) {
      delete state.convoys[c.id];
      continue;
    }
    let move = CONVOY_SPEED * ctx.world.speedFactorAt(c.x, c.z) * dt;
    while (move > 0 && c.path.length > 0) {
      const wp = c.path[0];
      const d = dist(c.x, c.z, wp.x, wp.z);
      if (d <= move) {
        c.x = wp.x;
        c.z = wp.z;
        move -= d;
        c.path.shift();
      } else {
        c.x += ((wp.x - c.x) / d) * move;
        c.z += ((wp.z - c.z) / d) * move;
        move = 0;
      }
    }
    if (c.path.length === 0 || dist(c.x, c.z, base.x, base.z) < 1) {
      const lost = depositToBase(state, base, c.cargo);
      base.population += c.people;
      delete state.convoys[c.id];
      if (c.fromBuildingId.startsWith('manual:') && state.factions[c.factionId]?.isPlayer) {
        const spilled = stockTotal(lost);
        log(state, `Convoy arrived at ${base.name}${c.people ? ` with ${c.people} colonists` : ''}.${spilled >= 1 ? ` Storage full: ${Math.round(spilled)} units left behind.` : ''}`, 'econ', c.factionId);
      }
      continue;
    }
    for (const a of Object.values(state.armies)) {
      if (!areHostile(state, a.factionId, c.factionId)) continue;
      if (dist(a.x, a.z, c.x, c.z) < INTERCEPT_RADIUS) {
        delete state.convoys[c.id];
        if (state.factions[c.factionId]?.isPlayer) {
          log(state, `A supply convoy was intercepted and destroyed by hostile forces.${c.people ? ` ${c.people} colonists were lost.` : ''}`, 'warn', c.factionId);
        }
        else if (state.factions[a.factionId]?.isPlayer) log(state, `${a.name} intercepted an enemy supply convoy.`, 'battle', a.factionId);
        break;
      }
    }
  }
}

/** Resources a sister base ships to a young base, with the stock each side keeps. */
const SUPPLY_TRANSFER: { k: StockResourceId; keepHome: number; want: number }[] = [
  { k: 'minerals', keepHome: 140, want: 120 },
  { k: 'refined', keepHome: 100, want: 80 },
  { k: 'food', keepHome: 120, want: 100 },
  { k: 'components', keepHome: 60, want: 40 },
  { k: 'fuel', keepHome: 80, want: 50 },
  { k: 'ammo', keepHome: 60, want: 30 },
];
const SUPPLY_LOAD = 45;

/**
 * Bases linked by a road keep each other supplied: when a base runs short of
 * something its sister base has in surplus, a convoy carries it over (one
 * convoy in flight per destination; it can be intercepted like any other).
 */
function dispatchSupplyConvoys(ctx: SimContext): void {
  const { state } = ctx;
  for (const road of Object.values(state.roads)) {
    const from = state.bases[road.fromBaseId];
    const hq = state.buildings[road.toBuildingId];
    if (!from || !hq || hq.typeId !== 'hq') continue;
    const to = state.bases[hq.baseId];
    if (!to || to === from || to.factionId !== from.factionId || from.factionId !== road.factionId) continue;
    const tag = `base:${from.id}`;
    if (Object.values(state.convoys).some((c) => c.toBaseId === to.id && c.fromBuildingId === tag)) continue;
    const cargo: PartialStock = {};
    let load = 0;
    for (const t of SUPPLY_TRANSFER) {
      const need = t.want - to.stock[t.k];
      const spare = from.stock[t.k] - t.keepHome;
      const amt = Math.min(need, spare, SUPPLY_LOAD - load);
      if (amt < 5) continue;
      cargo[t.k] = amt;
      from.stock[t.k] -= amt;
      load += amt;
      if (load >= SUPPLY_LOAD) break;
    }
    if (load <= 0) continue;
    const c: Convoy = {
      id: newId(state, 'c'),
      factionId: from.factionId,
      fromBuildingId: tag,
      toBaseId: to.id,
      cargo,
      people: 0,
      path: road.points.slice(1),
      x: from.x,
      z: from.z,
    };
    state.convoys[c.id] = c;
  }
}

// ---------------------------------------------------------------------------
// Convoys sent by hand between two bases of the same expedition
// ---------------------------------------------------------------------------

/** Cargo (stock units) and seats of one hand-sent convoy. */
export const MANUAL_CONVOY_CAPACITY = 120;
export const MANUAL_CONVOY_SEATS = 12;
/** People a base keeps when it sends colonists away. */
export const KEEP_AT_HOME = 8;

/** Route between two bases: along the road that links them when there is one, otherwise cross-country. */
export function convoyRoute(ctx: SimContext, from: Base, to: Base): Vec2[] | null {
  const { state } = ctx;
  for (const r of Object.values(state.roads)) {
    const end = state.buildings[r.toBuildingId];
    if (!end || end.typeId !== 'hq') continue;
    if (r.fromBaseId === from.id && end.baseId === to.id) return r.points.slice(1);
    if (r.fromBaseId === to.id && end.baseId === from.id) return r.points.slice().reverse().slice(1);
  }
  return ctx.world.findArmyPath({ x: from.x, z: from.z }, { x: to.x, z: to.z });
}

/** Why this transfer cannot be sent, or null when it can. */
export function transferProblem(from: Base | undefined, to: Base | undefined, cargo: PartialStock, people: number): string | null {
  if (!from || !to || from === to) return 'Choose a destination base';
  if (to.factionId !== from.factionId) return 'Convoys only run between your own bases';
  let load = 0;
  for (const k of STOCK_RESOURCES) {
    const v = cargo[k] ?? 0;
    if (v < 0) return 'Invalid cargo';
    if (v > from.stock[k] + 1e-6) return `Not enough ${RESOURCES[k].name.toLowerCase()} in ${from.name}`;
    load += v;
  }
  if (load > MANUAL_CONVOY_CAPACITY + 1e-6) return `A convoy carries at most ${MANUAL_CONVOY_CAPACITY} units`;
  if (people < 0 || people > MANUAL_CONVOY_SEATS) return `A convoy seats at most ${MANUAL_CONVOY_SEATS} colonists`;
  if (people > 0 && Math.floor(from.population) - people < KEEP_AT_HOME) return `${from.name} must keep ${KEEP_AT_HOME} people`;
  if (load < 1 && people < 1) return 'Load something first';
  return null;
}

export type ConvoyResult = { ok: true; convoy: Convoy } | { ok: false; reason: string };

/** Send supplies and/or colonists from one base to another (they can be intercepted on the way). */
export function sendConvoy(ctx: SimContext, fromId: string, toId: string, cargo: PartialStock, people: number): ConvoyResult {
  const { state } = ctx;
  const from = state.bases[fromId];
  const to = state.bases[toId];
  people = Math.floor(people);
  const problem = transferProblem(from, to, cargo, people);
  if (problem) return { ok: false, reason: problem };
  const path = convoyRoute(ctx, from, to);
  if (!path) return { ok: false, reason: 'No route between the bases' };
  const load: PartialStock = {};
  for (const k of STOCK_RESOURCES) {
    const v = cargo[k] ?? 0;
    if (v <= 0) continue;
    load[k] = v;
    from.stock[k] -= v;
  }
  from.population -= people;
  const c: Convoy = {
    id: newId(state, 'c'),
    factionId: from.factionId,
    fromBuildingId: `manual:${from.id}`,
    toBaseId: to.id,
    cargo: load,
    people,
    path,
    x: from.x,
    z: from.z,
  };
  state.convoys[c.id] = c;
  return { ok: true, convoy: c };
}

/** Rough travel time (hours) of a convoy along a route. */
export function convoyHours(from: Vec2, path: Vec2[]): number {
  let d = 0;
  let p = from;
  for (const q of path) {
    d += dist(p.x, p.z, q.x, q.z);
    p = q;
  }
  return d / CONVOY_SPEED;
}

/** Total cargo of the supply convoys currently heading to a base. */
export function incomingSupplies(state: { convoys: Record<string, Convoy> }, baseId: string): number {
  let n = 0;
  for (const c of Object.values(state.convoys)) {
    if (c.toBaseId !== baseId || !c.fromBuildingId.startsWith('base:')) continue;
    for (const k of STOCK_RESOURCES) n += c.cargo[k] ?? 0;
  }
  return n;
}
