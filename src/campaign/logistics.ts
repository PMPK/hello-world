import { dist } from '../core/math';
import { STOCK_RESOURCES, type PartialStock } from '../data/resources';
import { FOOD_PER_PERSON_HOUR } from '../economy/economy';
import { statsOf } from '../units/stats';
import { armyMen, fuelRange, supplyingBase } from './armies';
import { log, newId, type SimContext } from './context';
import { KEEP_AT_HOME, MANUAL_CONVOY_CAPACITY, sendConvoy, sendSupplyRun } from './convoys';
import { nearestBaseOf } from './queries';
import type { Army, StandingTransfer } from './types';

/**
 * Standing logistics orders, so supply does not need constant attention:
 *  - **automatic supply runs**: a task force flagged `autoSupply` that runs
 *    short in the field gets a supply run from the nearest base that can
 *    spare it (the rival's forces always do);
 *  - **standing convoys**: a base sends the same load to another base on a
 *    schedule, as much of it as it can spare.
 */

/** Intervals offered for standing convoys (hours). */
export const TRANSFER_INTERVALS = [12, 24, 48];
/** A base keeps at least this much of each good when a standing convoy leaves. */
export const STANDING_RESERVE = 10;
const SIM_STEP_HOURS = 0.1;

export function stepLogistics(ctx: SimContext): void {
  const { state } = ctx;
  for (const t of Object.values(state.transfers)) runTransfer(ctx, t);
  // supply needs are checked once an hour
  if (state.time % 1 >= SIM_STEP_HOURS) return;
  for (const army of Object.values(state.armies)) {
    if (!army.autoSupply || !state.factions[army.factionId]?.isPlayer) continue;
    const run = requestSupplyRun(ctx, army, true);
    if (run) log(state, `Supply run from ${run} on its way to ${army.name} (automatic).`, 'econ', army.factionId);
  }
}

/**
 * A force in the field running short gets a supply run from the nearest base
 * that can spare it: fuel once the tanks no longer cover the way home with a
 * margin, ammunition below 30%, and (with `rations`) food for less than a
 * day. One run at a time. Returns the sending base's name, or null.
 */
export function requestSupplyRun(ctx: SimContext, army: Army, rations: boolean): string | null {
  const { state } = ctx;
  if (supplyingBase(state, army)) return null;
  if (Object.values(state.convoys).some((c) => c.toArmyId === army.id)) return null;
  const home = nearestBaseOf(state, army.factionId, army.x, army.z);
  if (!home) return null;
  let ammo = 0;
  let ammoCap = 0;
  for (const u of army.units) {
    const st = statsOf(u.designId);
    ammo += u.ammo;
    ammoCap += st.ammoCapacity;
  }
  const lowFuel = fuelRange(army.units) < dist(army.x, army.z, home.x, home.z) * 1.2 + 15;
  const lowAmmo = ammoCap > 0 && ammo < ammoCap * 0.3;
  const daily = armyMen(army) * FOOD_PER_PERSON_HOUR * 24;
  const lowFood = rations && army.food < daily;
  if (!lowFuel && !lowAmmo && !lowFood) return null;
  const fuel = lowFuel ? Math.max(0, Math.min(90, Math.floor(home.stock.fuel - 40))) : 0;
  const shells = lowAmmo ? Math.max(0, Math.min(30, Math.floor(home.stock.ammo - 20))) : 0;
  const food = lowFood ? Math.max(0, Math.min(Math.ceil(daily * 2), MANUAL_CONVOY_CAPACITY - fuel - shells, Math.floor(home.stock.food - 30))) : 0;
  if (fuel < 10 && shells < 5 && food < 5) return null;
  const cargo: PartialStock = {};
  if (fuel > 0) cargo.fuel = fuel;
  if (shells > 0) cargo.ammo = shells;
  if (food > 0) cargo.food = food;
  return sendSupplyRun(ctx, home.id, army.id, cargo).ok ? home.name : null;
}

/** Set up a standing convoy; returns null or why it cannot be set up. */
export function addStandingTransfer(
  ctx: SimContext,
  fromId: string,
  toId: string,
  cargo: PartialStock,
  people: number,
  everyHours: number,
): string | null {
  const { state } = ctx;
  const from = state.bases[fromId];
  const to = state.bases[toId];
  if (!from || !to || from === to || from.factionId !== to.factionId) return 'Choose another of your bases';
  if (!TRANSFER_INTERVALS.includes(everyHours)) return 'Choose how often it runs';
  let load = 0;
  for (const k of STOCK_RESOURCES) load += Math.max(0, cargo[k] ?? 0);
  if (load < 1 && people < 1) return 'Load something first';
  const t: StandingTransfer = {
    id: newId(state, 't'),
    factionId: from.factionId,
    fromBaseId: from.id,
    toBaseId: to.id,
    cargo: { ...cargo },
    people: Math.max(0, Math.floor(people)),
    everyHours,
    nextAt: state.time + everyHours,
  };
  state.transfers[t.id] = t;
  return null;
}

export function cancelStandingTransfer(ctx: SimContext, id: string): void {
  delete ctx.state.transfers[id];
}

/** Standing convoys leaving a base. */
export function transfersFrom(state: { transfers: Record<string, StandingTransfer> }, baseId: string): StandingTransfer[] {
  return Object.values(state.transfers).filter((t) => t.fromBaseId === baseId);
}

function runTransfer(ctx: SimContext, t: StandingTransfer): void {
  const { state } = ctx;
  const from = state.bases[t.fromBaseId];
  const to = state.bases[t.toBaseId];
  if (!from || !to || from.factionId !== t.factionId || to.factionId !== t.factionId) {
    delete state.transfers[t.id];
    if (state.factions[t.factionId]?.isPlayer) {
      log(state, `Standing convoy ${from?.name ?? '?'} → ${to?.name ?? '?'} cancelled: the route's base was lost.`, 'warn', t.factionId);
    }
    return;
  }
  if (state.time < t.nextAt) return;
  t.nextAt = state.time + t.everyHours;
  // send what can be spared this time
  const cargo: PartialStock = {};
  for (const k of STOCK_RESOURCES) {
    const want = t.cargo[k] ?? 0;
    const spare = Math.floor(Math.max(0, from.stock[k] - STANDING_RESERVE));
    const v = Math.min(want, spare);
    if (v >= 1) cargo[k] = v;
  }
  const people = Math.min(t.people, Math.max(0, Math.floor(from.population) - KEEP_AT_HOME));
  if (!Object.keys(cargo).length && people < 1) return;
  sendConvoy(ctx, from.id, to.id, cargo, people);
}
