import { dist, type Vec2 } from '../core/math';
import { FACTION_DEFS } from '../data/factions';
import { FOOD_PER_PERSON_HOUR, resupplyUnits } from '../economy/economy';
import { statsOf } from '../units/stats';
import type { Character } from '../characters/character';
import { log, newId, type SimContext } from './context';
import { nearestBaseOf } from './queries';
import { syncInfantryMen } from './units';
import type { Army, Base, CampaignState, UnitInstance } from './types';

export const ENGAGE_RADIUS = 2.4;
export const ARMY_MAX_UNITS = 24;
export const RATION_DAYS = 6;
/** Hours after a battle during which an army will not be re-engaged automatically. */
export const BATTLE_COOLDOWN = 2;

export function armyMen(a: Army): number {
  let n = 0;
  for (const u of a.units) n += u.men;
  return n;
}

/** Fuel a supply truck keeps for its own driving; everything above it is cargo. */
export const TRUCK_FUEL_RESERVE = 25;
/** Rations carried per supply truck (added to the army's ration capacity). */
export const TRUCK_RATIONS = 40;
/** Field transfer rates per truck and hour. */
const FIELD_FUEL_RATE = 8;
const FIELD_AMMO_RATE = 4;

export function isSupport(designId: string): boolean {
  return statsOf(designId).family === 'support';
}

/**
 * How far (map units) a force can still drive before its vehicles run dry
 * (Infinity on foot). Supply trucks pool their cargo fuel with the force.
 */
export function fuelRange(units: { designId: string; fuel: number }[]): number {
  let minRange = Infinity;
  let fighterFuel = 0;
  let fighterBurn = 0;
  let cargo = 0;
  let truckRange = Infinity;
  let trucks = 0;
  for (const u of units) {
    const st = statsOf(u.designId);
    if (st.fuelPerUnit <= 0) continue;
    if (st.family === 'support') {
      trucks++;
      cargo += Math.max(0, u.fuel - TRUCK_FUEL_RESERVE);
      truckRange = Math.min(truckRange, Math.min(u.fuel, TRUCK_FUEL_RESERVE) / st.fuelPerUnit);
    } else {
      fighterFuel += u.fuel;
      fighterBurn += st.fuelPerUnit;
      minRange = Math.min(minRange, u.fuel / st.fuelPerUnit);
    }
  }
  if (!trucks) return minRange;
  const pooled = fighterBurn > 0 ? (fighterFuel + cargo) / fighterBurn : Infinity;
  return Math.min(pooled, truckRange);
}

/** Cargo carried by an army's supply trucks (fuel above their own reserve, ammunition). */
export function armySupplies(units: UnitInstance[]): { trucks: number; fuel: number; ammo: number } {
  let trucks = 0;
  let fuel = 0;
  let ammo = 0;
  for (const u of units) {
    if (!isSupport(u.designId)) continue;
    trucks++;
    fuel += Math.max(0, u.fuel - TRUCK_FUEL_RESERVE);
    ammo += u.ammo;
  }
  return { trucks, fuel, ammo };
}

function takeFromTrucks(trucks: UnitInstance[], kind: 'fuel' | 'ammo', amount: number): number {
  let got = 0;
  for (const t of trucks) {
    const avail = kind === 'fuel' ? Math.max(0, t.fuel - TRUCK_FUEL_RESERVE) : t.ammo;
    const take = Math.min(avail, amount - got);
    if (take <= 0) continue;
    t[kind] -= take;
    got += take;
    if (got >= amount - 1e-9) break;
  }
  return got;
}

/** Supply trucks top up the rest of their task force, neediest units first. */
export function fieldResupply(units: UnitInstance[], dt: number): void {
  const trucks = units.filter((u) => isSupport(u.designId));
  if (!trucks.length) return;
  for (const kind of ['fuel', 'ammo'] as const) {
    let budget = trucks.length * (kind === 'fuel' ? FIELD_FUEL_RATE : FIELD_AMMO_RATE) * dt;
    const needy = units
      .filter((u) => !isSupport(u.designId))
      .map((u) => {
        const st = statsOf(u.designId);
        const cap = kind === 'fuel' ? st.fuelCapacity : st.ammoCapacity;
        return { u, cap, frac: cap > 0 ? u[kind] / cap : 1 };
      })
      .filter((x) => x.cap > 0 && x.u[kind] < x.cap - 1e-6)
      .sort((a, b) => a.frac - b.frac);
    for (const x of needy) {
      if (budget <= 1e-9) break;
      const want = Math.min(x.cap - x.u[kind], budget);
      const got = takeFromTrucks(trucks, kind, want);
      x.u[kind] += got;
      budget -= got;
      if (got < want - 1e-9) break; // trucks are empty
    }
  }
}

export function maxRations(a: Army): number {
  let trucks = 0;
  for (const u of a.units) if (isSupport(u.designId)) trucks++;
  return Math.max(4, armyMen(a) * FOOD_PER_PERSON_HOUR * 24 * RATION_DAYS) + trucks * TRUCK_RATIONS;
}

/** Strategic speed in map units / hour, before terrain modifiers. */
export function armyBaseSpeed(a: Army): number {
  let s = Infinity;
  for (const u of a.units) {
    const st = statsOf(u.designId);
    let v = st.strategicSpeed;
    if (st.fuelCapacity > 0 && u.fuel <= 0.01) v *= 0.35; // out of fuel: towed / crawling
    if (v < s) s = v;
  }
  return Number.isFinite(s) ? s : 0;
}

export function armySpeed(ctx: SimContext, a: Army): number {
  return armyBaseSpeed(a) * ctx.world.speedFactorAt(a.x, a.z);
}

function makeCommander(ctx: SimContext, factionId: string, armyId: string): Character {
  const { state, rng } = ctx;
  const def = FACTION_DEFS[state.factions[factionId]?.defId ?? ''];
  const used = new Set(Object.values(state.characters).filter((c) => c.alive).map((c) => c.name));
  const pool = (def?.commanderNames ?? ['Capt. Unknown']).filter((n) => !used.has(n));
  const name = pool.length ? rng.pick(pool) : `Capt. ${String.fromCharCode(65 + rng.int(0, 25))}. ${rng.int(10, 99)}`;
  const c: Character = {
    id: newId(state, 'ch'),
    name,
    factionId,
    role: 'army_commander',
    skills: { command: rng.int(1, 5), logistics: rng.int(1, 5), tactics: rng.int(1, 5) },
    alive: true,
    location: { kind: 'army', id: armyId },
  };
  state.characters[c.id] = c;
  return c;
}

export function nextArmyName(state: CampaignState, factionId: string): string {
  const f = state.factions[factionId];
  const def = FACTION_DEFS[f?.defId ?? ''];
  const names = def?.armyNames ?? ['Task Force'];
  const n = f ? f.armyCounter++ : 0;
  const base = names[n % names.length];
  const cycle = Math.floor(n / names.length);
  return cycle > 0 ? `${base} ${cycle + 1}` : base;
}

export function createArmy(
  ctx: SimContext,
  factionId: string,
  x: number,
  z: number,
  units: UnitInstance[],
  homeBaseId: string | null,
): Army {
  const { state } = ctx;
  const id = newId(state, 'a');
  const army: Army = {
    id,
    name: nextArmyName(state, factionId),
    factionId,
    commanderId: null,
    units,
    x,
    z,
    path: [],
    order: { type: 'idle' },
    food: 0,
    homeBaseId,
    lastBattleTime: -999,
    repathAt: 0,
    aiRole: null,
  };
  army.food = maxRations(army);
  state.armies[id] = army;
  army.commanderId = makeCommander(ctx, factionId, id).id;
  return army;
}

/** Deploy garrison units (all, or the given ids) as a field army next to the base. */
export function formArmyFromGarrison(ctx: SimContext, baseId: string, unitIds?: string[]): Army | null {
  const { state, rng } = ctx;
  const base = state.bases[baseId];
  if (!base) return null;
  const pick = (unitIds ? base.garrison.filter((u) => unitIds.includes(u.id)) : base.garrison.slice()).slice(0, ARMY_MAX_UNITS);
  if (pick.length === 0) return null;
  base.garrison = base.garrison.filter((u) => !pick.includes(u));
  const a = rng.range(0, Math.PI * 2);
  const r = 2.5;
  let x = base.x + Math.cos(a) * r;
  let z = base.z + Math.sin(a) * r;
  if (!ctx.world.isPassable(x, z)) {
    x = base.x;
    z = base.z;
  }
  const army = createArmy(ctx, base.factionId, x, z, pick, base.id);
  // Field rations come out of base stores.
  const want = maxRations(army);
  const take = Math.min(want, base.stock.food);
  base.stock.food -= take;
  army.food = take;
  return army;
}

/** Return an army's units to the garrison of a friendly base it is standing in. */
export function garrisonArmy(ctx: SimContext, armyId: string): boolean {
  const { state } = ctx;
  const army = state.armies[armyId];
  if (!army) return false;
  const base = Object.values(state.bases).find(
    (b) => b.factionId === army.factionId && dist(b.x, b.z, army.x, army.z) <= b.radius + 1.5,
  );
  if (!base) return false;
  base.garrison.push(...army.units);
  base.stock.food += army.food;
  removeArmy(state, army.id, { kind: 'base', id: base.id });
  return true;
}

/** Move garrison units into an existing army that is at the base. */
export function reinforceArmy(ctx: SimContext, armyId: string, unitIds?: string[]): number {
  const { state } = ctx;
  const army = state.armies[armyId];
  if (!army) return 0;
  const base = Object.values(state.bases).find(
    (b) => b.factionId === army.factionId && dist(b.x, b.z, army.x, army.z) <= b.radius + 1.5,
  );
  if (!base) return 0;
  const room = ARMY_MAX_UNITS - army.units.length;
  const pick = (unitIds ? base.garrison.filter((u) => unitIds.includes(u.id)) : base.garrison.slice()).slice(0, Math.max(0, room));
  base.garrison = base.garrison.filter((u) => !pick.includes(u));
  army.units.push(...pick);
  return pick.length;
}

export function removeArmy(state: CampaignState, armyId: string, commanderTo: Character['location'] | null = null): void {
  const army = state.armies[armyId];
  if (!army) return;
  if (army.commanderId) {
    const c = state.characters[army.commanderId];
    if (c) {
      if (commanderTo) c.location = commanderTo;
      else {
        c.alive = false;
        c.location = { kind: 'none' };
      }
    }
  }
  delete state.armies[armyId];
}

export function setArmyPath(ctx: SimContext, army: Army, x: number, z: number): boolean {
  const path = ctx.world.findArmyPath({ x: army.x, z: army.z }, { x, z });
  if (!path) return false;
  army.path = path;
  return true;
}

export function orderMove(ctx: SimContext, armyId: string, x: number, z: number): boolean {
  const army = ctx.state.armies[armyId];
  if (!army) return false;
  if (!setArmyPath(ctx, army, x, z)) return false;
  army.order = { type: 'move', x, z };
  return true;
}

export type AttackTarget = { kind: 'army' | 'base' | 'building'; id: string };

export function targetPosition(state: CampaignState, t: AttackTarget): Vec2 | null {
  if (t.kind === 'army') {
    const a = state.armies[t.id];
    return a ? { x: a.x, z: a.z } : null;
  }
  if (t.kind === 'base') {
    const b = state.bases[t.id];
    return b ? { x: b.x, z: b.z } : null;
  }
  const b = state.buildings[t.id];
  return b ? { x: b.x, z: b.z } : null;
}

export function orderAttack(ctx: SimContext, armyId: string, target: AttackTarget): boolean {
  const { state } = ctx;
  const army = state.armies[armyId];
  if (!army) return false;
  const pos = targetPosition(state, target);
  if (!pos) return false;
  if (!setArmyPath(ctx, army, pos.x, pos.z)) return false;
  army.order =
    target.kind === 'army'
      ? { type: 'attack_army', targetId: target.id }
      : target.kind === 'base'
        ? { type: 'attack_base', targetId: target.id }
        : { type: 'attack_building', targetId: target.id };
  army.repathAt = state.time + 0.75;
  return true;
}

export function orderReturn(ctx: SimContext, armyId: string): boolean {
  const { state } = ctx;
  const army = state.armies[armyId];
  if (!army) return false;
  const home = (army.homeBaseId && state.bases[army.homeBaseId]?.factionId === army.factionId
    ? state.bases[army.homeBaseId]
    : nearestBaseOf(state, army.factionId, army.x, army.z)) as Base | null;
  if (!home) return false;
  if (!setArmyPath(ctx, army, home.x, home.z)) return false;
  army.order = { type: 'return', baseId: home.id };
  army.homeBaseId = home.id;
  return true;
}

export function stopArmy(army: Army): void {
  army.path = [];
  army.order = { type: 'idle' };
}

/** Pull back after a lost engagement, away from (fromX, fromZ). */
export function retreatArmy(ctx: SimContext, army: Army, fromX: number, fromZ: number, distance = 9): void {
  const dx = army.x - fromX;
  const dz = army.z - fromZ;
  const len = Math.hypot(dx, dz) || 1;
  for (const turn of [0, 0.6, -0.6, 1.2, -1.2, Math.PI]) {
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    const rx = (dx / len) * c - (dz / len) * s;
    const rz = (dx / len) * s + (dz / len) * c;
    const tx = army.x + rx * distance;
    const tz = army.z + rz * distance;
    if (ctx.world.isPassable(tx, tz) && setArmyPath(ctx, army, tx, tz)) {
      army.order = { type: 'move', x: tx, z: tz };
      return;
    }
  }
  orderReturn(ctx, army.id);
}

function friendlyBaseNear(state: CampaignState, a: Army): Base | null {
  for (const b of Object.values(state.bases)) {
    if (b.factionId === a.factionId && dist(b.x, b.z, a.x, a.z) <= b.radius + 2) return b;
  }
  return null;
}

export function stepArmies(ctx: SimContext, dt: number): void {
  const { state } = ctx;
  const ids = Object.keys(state.armies).sort();
  for (const id of ids) {
    const army = state.armies[id];
    if (!army) continue;
    army.units = army.units.filter((u) => u.hp > 0 && u.men > 0);
    if (army.units.length === 0) {
      if (state.factions[army.factionId]?.isPlayer) log(state, `${army.name} has ceased to exist.`, 'warn', army.factionId);
      removeArmy(state, army.id);
      continue;
    }

    // --- order upkeep ---
    const o = army.order;
    if (o.type === 'attack_army') {
      const target = state.armies[o.targetId];
      if (!target) {
        stopArmy(army);
      } else if (state.time >= army.repathAt) {
        army.repathAt = state.time + 0.75;
        if (!setArmyPath(ctx, army, target.x, target.z)) stopArmy(army);
      }
    } else if (o.type === 'attack_base') {
      const b = state.bases[o.targetId];
      if (!b || b.factionId === army.factionId) stopArmy(army);
    } else if (o.type === 'attack_building') {
      const b = state.buildings[o.targetId];
      if (!b || b.factionId === army.factionId || b.state === 'destroyed') stopArmy(army);
    }

    // --- movement ---
    const before = { x: army.x, z: army.z };
    if (army.path.length > 0) {
      let move = armySpeed(ctx, army) * dt;
      while (move > 1e-6 && army.path.length > 0) {
        const wp = army.path[0];
        const d = dist(army.x, army.z, wp.x, wp.z);
        if (d <= move) {
          army.x = wp.x;
          army.z = wp.z;
          move -= d;
          army.path.shift();
        } else {
          army.x += ((wp.x - army.x) / d) * move;
          army.z += ((wp.z - army.z) / d) * move;
          move = 0;
        }
      }
      if (army.path.length === 0) {
        if (army.order.type === 'move') army.order = { type: 'idle' };
        if (army.order.type === 'return') {
          const home = state.bases[army.order.baseId];
          army.order = { type: 'idle' };
          if (home && army.aiRole && home.factionId === army.factionId) {
            garrisonArmy(ctx, army.id);
            continue;
          }
        }
      }
    }
    const moved = dist(before.x, before.z, army.x, army.z);
    if (moved > 0) {
      for (const u of army.units) {
        const st = statsOf(u.designId);
        if (st.fuelPerUnit > 0) u.fuel = Math.max(0, u.fuel - st.fuelPerUnit * moved);
      }
    }

    // --- supply ---
    const home = friendlyBaseNear(state, army);
    if (home) {
      resupplyUnits(home, army.units, dt, false);
      const want = maxRations(army) - army.food;
      if (want > 0 && home.stock.food > 0) {
        const take = Math.min(want, home.stock.food, 20 * dt);
        army.food += take;
        home.stock.food -= take;
      }
    } else {
      fieldResupply(army.units, dt);
      const eat = armyMen(army) * FOOD_PER_PERSON_HOUR * dt;
      if (army.food >= eat) {
        army.food -= eat;
      } else {
        army.food = 0;
        // hunger attrition: infantry slowly lose strength
        for (const u of army.units) {
          const st = statsOf(u.designId);
          if (!st.isVehicle) {
            u.hp = Math.max(st.hpPerMan * 0.5, u.hp - st.maxHp * 0.004 * dt);
            syncInfantryMen(u);
          }
        }
      }
    }
  }
}
