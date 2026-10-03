import { clamp } from '../core/math';
import { BUILDINGS, REPAIR_HP_PER_HOUR, REPAIR_REFINED_PER_100HP, type BuildingTypeId, type RecipeDef } from '../data/buildings';
import {
  canAfford,
  emptyStock,
  payCost,
  STOCK_RESOURCES,
  stockTotal,
  type PartialStock,
  type Stock,
} from '../data/resources';
import { UNIT_DESIGNS } from '../data/unitDesigns';
import { statsOf } from '../units/stats';
import { log, type SimContext } from '../campaign/context';
import { buildingsOfBase } from '../campaign/queries';
import { createUnit, syncInfantryMen } from '../campaign/units';
import type { Base, Building, CampaignState } from '../campaign/types';

/** Food eaten per person per hour. */
export const FOOD_PER_PERSON_HOUR = 0.02;
/** Natural population growth per person per hour when fed and housed. */
export const GROWTH_PER_PERSON_HOUR = 0.0007;
/** Workers needed by one construction site for full speed. */
export const CONSTRUCTION_WORKERS = 4;
/** Extractor local buffer capacity. */
export const EXTRACTOR_BUFFER = 40;
/** Minimum storage a base always has (tents, crates). */
export const MIN_STORAGE = 60;

/** Workforce allocation priority (lower first). */
const WORK_PRIORITY: Record<BuildingTypeId, number> = {
  hq: 0,
  power_plant: 1,
  farm: 2,
  // defences are crewed ahead of industry: an unmanned bunker is useless when the attack comes
  bunker: 2.5,
  at_emplacement: 2.5,
  extractor: 3,
  refinery: 4,
  factory: 5,
  vehicle_depot: 6,
  barracks: 7,
  habitat: 8,
};

export function hpFactor(b: Building): number {
  const max = BUILDINGS[b.typeId].maxHp;
  const f = b.hp / max;
  return f >= 0.5 ? 1 : Math.max(0.25, f / 0.5);
}

export function storageCapacity(state: CampaignState, baseId: string): Stock {
  const cap = emptyStock();
  for (const k of STOCK_RESOURCES) cap[k] = MIN_STORAGE;
  for (const b of buildingsOfBase(state, baseId)) {
    if (b.state !== 'active') continue;
    const st = BUILDINGS[b.typeId].storage;
    if (!st) continue;
    for (const k of STOCK_RESOURCES) cap[k] += st[k] ?? 0;
  }
  return cap;
}

export function housingOf(state: CampaignState, baseId: string): number {
  let h = 0;
  for (const b of buildingsOfBase(state, baseId)) {
    if (b.state !== 'active') continue;
    h += BUILDINGS[b.typeId].housing ?? 0;
  }
  return h;
}

/** Add to base stock respecting capacity; returns the amount that did not fit. */
export function depositToBase(state: CampaignState, base: Base, add: PartialStock): PartialStock {
  const cap = storageCapacity(state, base.id);
  const overflow: PartialStock = {};
  for (const k of STOCK_RESOURCES) {
    const v = add[k] ?? 0;
    if (v <= 0) continue;
    const space = Math.max(0, cap[k] - base.stock[k]);
    const put = Math.min(space, v);
    base.stock[k] += put;
    if (v - put > 1e-6) overflow[k] = v - put;
  }
  return overflow;
}

/**
 * In 'auto' mode, intermediate goods are only produced up to these stock
 * targets so upstream materials are not all converted into surplus.
 */
export const AUTO_STOCK_TARGETS: PartialStock = { components: 120, ammo: 160, fuel: 150, food: 260 };

function recipeWanted(base: Base, cap: Stock, r: RecipeDef): boolean {
  for (const k of STOCK_RESOURCES) {
    if ((r.outputs[k] ?? 0) <= 0) continue;
    const target = Math.min(cap[k], AUTO_STOCK_TARGETS[k] ?? cap[k]);
    if (base.stock[k] < target) return true;
  }
  return false;
}

function recipeOutputsFit(base: Base, cap: Stock, r: RecipeDef): boolean {
  for (const k of STOCK_RESOURCES) {
    const out = r.outputs[k] ?? 0;
    if (out > 0 && base.stock[k] + out > cap[k] + 1e-6) return false;
  }
  return true;
}

/**
 * Pick the recipe to run next. 'auto' prefers the recipe whose outputs are
 * scarcest relative to storage capacity (with a nudge toward ammunition
 * and fuel when they are low, since the military consumes them).
 */
export function chooseRecipe(b: Building, base: Base, cap: Stock): { recipe: RecipeDef | null; reason: 'ok' | 'no_input' | 'storage_full' } {
  const def = BUILDINGS[b.typeId];
  const recipes = def.recipes ?? [];
  let candidates = recipes;
  if (b.recipeMode !== 'auto') candidates = recipes.filter((r) => r.id === b.recipeMode);
  let best: RecipeDef | null = null;
  let bestScore = -Infinity;
  let sawInputShort = false;
  let sawFull = false;
  for (const r of candidates) {
    if (!canAfford(base.stock, r.inputs)) {
      sawInputShort = true;
      continue;
    }
    if (!recipeOutputsFit(base, cap, r) || (b.recipeMode === 'auto' && !recipeWanted(base, cap, r))) {
      sawFull = true;
      continue;
    }
    let score = 0;
    for (const k of STOCK_RESOURCES) {
      if ((r.outputs[k] ?? 0) > 0) score += 1 - base.stock[k] / Math.max(1, cap[k]);
    }
    // Keep alloys flowing: refined materials feed everything else.
    if (r.outputs.refined) score += 0.15;
    if (r.outputs.ammo && base.stock.ammo < 40) score += 0.25;
    if (r.outputs.fuel && base.stock.fuel < 40) score += 0.2;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (best) return { recipe: best, reason: 'ok' };
  return { recipe: null, reason: sawFull && !sawInputShort ? 'storage_full' : 'no_input' };
}

function recipeById(typeId: BuildingTypeId, id: string | null): RecipeDef | undefined {
  if (!id) return undefined;
  return BUILDINGS[typeId].recipes?.find((r) => r.id === id);
}

/** One economy step for a single base. */
export function stepBaseEconomy(ctx: SimContext, base: Base, dt: number): void {
  const { state } = ctx;
  const buildings = buildingsOfBase(state, base.id);
  const before: Stock = { ...base.stock };
  const cap = storageCapacity(state, base.id);
  const housing = housingOf(state, base.id);

  // ---- 1. Workforce allocation ----------------------------------------
  let workforce = Math.floor(base.population);
  let workersNeeded = 0;
  const operating = buildings
    .filter((b) => b.state === 'active')
    .sort((a, b) => WORK_PRIORITY[a.typeId] - WORK_PRIORITY[b.typeId] || (a.id < b.id ? -1 : 1));
  const staffing = new Map<string, number>();
  for (const b of operating) {
    const need = BUILDINGS[b.typeId].workers;
    if (!b.enabled) {
      b.workers = 0;
      staffing.set(b.id, 0);
      continue;
    }
    workersNeeded += need;
    const assigned = Math.min(need, workforce);
    workforce -= assigned;
    b.workers = assigned;
    staffing.set(b.id, need > 0 ? assigned / need : 1);
  }
  const sites = buildings.filter((b) => b.state === 'construction').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const b of sites) {
    workersNeeded += CONSTRUCTION_WORKERS;
    const assigned = Math.min(CONSTRUCTION_WORKERS, workforce);
    workforce -= assigned;
    b.workers = assigned;
    staffing.set(b.id, assigned / CONSTRUCTION_WORKERS);
  }

  // ---- 2. Energy ---------------------------------------------------------
  let demand = 0;
  for (const b of operating) {
    const def = BUILDINGS[b.typeId];
    const s = staffing.get(b.id) ?? 0;
    if (def.energyUse > 0 && s > 0) demand += def.energyUse * Math.max(0.35, s);
  }
  let freeCapacity = 0;
  let plantCapacity = 0;
  const plants: Building[] = [];
  for (const b of operating) {
    const def = BUILDINGS[b.typeId];
    if (!def.energyOutput) continue;
    const out = def.energyOutput * (staffing.get(b.id) ?? 0) * hpFactor(b);
    if (def.energyFuel) {
      if (base.stock[def.energyFuel.resource] > 0.01) {
        plantCapacity += out;
        plants.push(b);
      }
    } else {
      freeCapacity += out;
    }
  }
  const capacity = freeCapacity + plantCapacity;
  const powerRatio = demand > 0 ? clamp(capacity / demand, 0, 1) : 1;
  // Plants burn fuel in proportion to the load they actually carry.
  const plantLoad = plantCapacity > 0 ? clamp((demand - freeCapacity) / plantCapacity, 0, 1) : 0;
  for (const p of plants) {
    const def = BUILDINGS[p.typeId];
    const burn = def.energyFuel!.perHour * plantLoad * dt * hpFactor(p);
    base.stock[def.energyFuel!.resource] = Math.max(0, base.stock[def.energyFuel!.resource] - burn);
    p.status = plantLoad > 0.01 ? (hpFactor(p) < 1 ? 'damaged' : 'ok') : 'idle';
  }

  // ---- 3. Buildings ------------------------------------------------------
  for (const b of buildings) {
    const def = BUILDINGS[b.typeId];
    if (b.state === 'destroyed') {
      b.status = 'destroyed';
      b.efficiency = 0;
      continue;
    }
    if (b.state === 'construction') {
      const s = staffing.get(b.id) ?? 0;
      b.status = s > 0 ? 'constructing' : 'no_workers';
      b.efficiency = s;
      b.buildProgress = Math.min(1, b.buildProgress + (dt * s) / def.buildHours);
      if (b.buildProgress >= 1) {
        b.state = 'active';
        b.hp = def.maxHp;
        b.status = 'ok';
        if (state.factions[b.factionId]?.isPlayer) {
          log(state, `${def.name} completed at ${base.name}.`, 'econ', b.factionId);
        }
      }
      continue;
    }
    // active
    if (!b.enabled) {
      b.status = 'disabled';
      b.efficiency = 0;
      continue;
    }
    const s = staffing.get(b.id) ?? 0;
    const powered = def.energyUse > 0 ? powerRatio : 1;
    const eff = s * hpFactor(b) * powered;
    b.efficiency = eff;

    // repairs (any active building)
    if (b.repairing) {
      const max = def.maxHp;
      if (b.hp >= max) {
        b.repairing = false;
      } else {
        const hpGain = Math.min(max - b.hp, REPAIR_HP_PER_HOUR * dt);
        const cost = (hpGain / 100) * REPAIR_REFINED_PER_100HP;
        if (base.stock.refined >= cost) {
          base.stock.refined -= cost;
          b.hp += hpGain;
        }
      }
    }

    if (def.energyOutput) {
      if (!def.energyFuel) {
        b.status = s > 0 ? 'ok' : 'no_workers';
      } else if (!plants.includes(b)) {
        b.status = s > 0 ? 'no_input' : 'no_workers';
        b.efficiency = 0;
      } else {
        b.efficiency = plantLoad;
      }
      continue;
    }

    if (def.extraction && b.siteId) {
      const site = state.sites[b.siteId];
      if (!site) continue;
      const ex = def.extraction[site.kind];
      const held = stockTotal(b.storage);
      if (s <= 0) {
        b.status = 'no_workers';
      } else if (held >= EXTRACTOR_BUFFER - 1e-6) {
        b.status = 'storage_full';
      } else {
        const amount = Math.min(EXTRACTOR_BUFFER - held, ex.perHour * site.richness * eff * dt);
        b.storage[ex.resource] = (b.storage[ex.resource] ?? 0) + amount;
        b.status = hpFactor(b) < 1 ? 'damaged' : 'ok';
      }
      continue;
    }

    if (def.defense) {
      b.status = s < 1 ? 'no_workers' : hpFactor(b) < 1 ? 'damaged' : 'ok';
      continue;
    }

    if (def.recipes && def.recipes.length) {
      if (s <= 0) {
        b.status = 'no_workers';
        continue;
      }
      if (!b.activeRecipe) {
        const pick = chooseRecipe(b, base, cap);
        if (!pick.recipe) {
          b.status = pick.reason;
          continue;
        }
        payCost(base.stock, pick.recipe.inputs);
        b.activeRecipe = pick.recipe.id;
        b.cycleProgress = 0;
      }
      const r = recipeById(b.typeId, b.activeRecipe);
      if (!r) {
        b.activeRecipe = null;
        continue;
      }
      b.cycleProgress += dt * eff;
      b.status = powered < 0.99 ? 'low_power' : s < 1 ? 'no_workers' : hpFactor(b) < 1 ? 'damaged' : 'ok';
      if (b.cycleProgress >= r.cycleHours) {
        depositToBase(state, base, r.outputs);
        b.activeRecipe = null;
        b.cycleProgress = 0;
      }
      continue;
    }

    if (def.produces) {
      stepUnitProduction(ctx, base, b, eff, s, dt);
      continue;
    }

    if (def.housing || def.storage) {
      b.status = s > 0 || def.workers === 0 ? 'ok' : 'no_workers';
    }
  }

  // ---- 4. Garrison upkeep: resupply, reinforce, field repairs -------------
  stepGarrisonUpkeep(base, dt);

  // ---- 5. Food & population ------------------------------------------------
  let garrisonMen = 0;
  for (const u of base.garrison) garrisonMen += u.men;
  const eaters = base.population + garrisonMen;
  const eat = eaters * FOOD_PER_PERSON_HOUR * dt;
  const starving = base.stock.food < eat;
  base.stock.food = Math.max(0, base.stock.food - eat);
  if (starving) {
    base.growth -= base.population * 0.0025 * dt;
  } else if (base.population < housing) {
    base.growth += Math.max(0.5, base.population) * GROWTH_PER_PERSON_HOUR * dt;
  } else if (base.population > housing + 2) {
    // Overcrowding: people drift away (or fall ill) slowly.
    base.growth -= (base.population - housing) * 0.002 * dt;
  }
  if (base.growth >= 1) {
    const n = Math.floor(base.growth);
    base.population += n;
    base.growth -= n;
  } else if (base.growth <= -1) {
    const n = Math.floor(-base.growth);
    base.population = Math.max(0, base.population - n);
    base.growth += n;
    if (state.factions[base.factionId]?.isPlayer) {
      log(state, `${base.name}: ${starving ? 'food shortage' : 'overcrowding'} — personnel lost.`, 'warn', base.factionId);
    }
  }

  // clamp stock to capacity (e.g. after a storage building was destroyed)
  for (const k of STOCK_RESOURCES) base.stock[k] = clamp(base.stock[k], 0, Math.max(cap[k], 0));

  // ---- 6. Snapshot for the UI -------------------------------------------------
  const rates: PartialStock = base.econ?.rates ?? {};
  const alpha = 1 - Math.exp(-dt / 8);
  for (const k of STOCK_RESOURCES) {
    const delta = (base.stock[k] - before[k]) / Math.max(dt, 1e-6);
    rates[k] = (rates[k] ?? 0) + (delta - (rates[k] ?? 0)) * alpha;
  }
  let foodPerHour = 0;
  for (const b of operating) {
    const def = BUILDINGS[b.typeId];
    const r = def.recipes?.find((x) => x.outputs.food);
    if (r) foodPerHour += ((r.outputs.food ?? 0) / r.cycleHours) * (b.efficiency ?? 0);
  }
  base.econ = {
    energyProduced: capacity,
    energyDemand: demand,
    workersNeeded,
    workersEmployed: Math.floor(base.population) - workforce,
    housing,
    foodPerHour: foodPerHour - eaters * FOOD_PER_PERSON_HOUR,
    rates,
    storageCap: cap,
  };
}

function stepUnitProduction(ctx: SimContext, base: Base, b: Building, eff: number, staffingRatio: number, dt: number): void {
  const { state } = ctx;
  const order = b.queue[0];
  if (!order) {
    b.status = staffingRatio > 0 ? 'idle' : 'no_workers';
    return;
  }
  const design = UNIT_DESIGNS[order.designId];
  if (!design) {
    b.queue.shift();
    return;
  }
  const st = statsOf(order.designId);
  if (!order.started) {
    if (Math.floor(base.population) < st.crew) {
      b.status = 'no_population';
      return;
    }
    if (!canAfford(base.stock, st.cost)) {
      b.status = 'waiting_resources';
      return;
    }
    payCost(base.stock, st.cost);
    base.population -= st.crew;
    order.started = true;
  }
  if (staffingRatio <= 0) {
    b.status = 'no_workers';
    return;
  }
  order.progress += dt * eff;
  b.status = eff < 0.99 ? (staffingRatio < 1 ? 'no_workers' : 'low_power') : 'ok';
  if (order.progress >= st.buildHours) {
    b.queue.shift();
    const unit = createUnit(state, order.designId);
    base.garrison.push(unit);
    if (state.factions[base.factionId]?.isPlayer) {
      log(state, `${design.name} ready at ${base.name}.`, 'econ', base.factionId);
    }
  }
}

/**
 * Units garrisoned at a base slowly refill ammo/fuel from base stock, depleted
 * squads take replacements from the population, and damaged vehicles are
 * patched up with refined materials.
 */
export function stepGarrisonUpkeep(base: Base, dt: number): void {
  resupplyUnits(base, base.garrison, dt, true);
}

export function resupplyUnits(base: Base, units: Base['garrison'], dt: number, allowReplacements: boolean): void {
  for (const u of units) {
    const st = statsOf(u.designId);
    if (u.ammo < st.ammoCapacity && base.stock.ammo > 0) {
      const amt = Math.min(st.ammoCapacity - u.ammo, base.stock.ammo, 6 * dt);
      u.ammo += amt;
      base.stock.ammo -= amt;
    }
    if (st.fuelCapacity > 0 && u.fuel < st.fuelCapacity && base.stock.fuel > 0) {
      const amt = Math.min(st.fuelCapacity - u.fuel, base.stock.fuel, 10 * dt);
      u.fuel += amt;
      base.stock.fuel -= amt;
    }
    if (u.hp < st.maxHp) {
      if (!st.isVehicle) {
        // replacements: one soldier per ~3 hours if a civilian volunteers
        if (allowReplacements && base.population > 8 && u.men < st.crew) {
          const hpGain = Math.min(st.maxHp - u.hp, (st.hpPerMan / 3) * dt);
          const menBefore = u.men;
          u.hp += hpGain;
          syncInfantryMen(u);
          const added = u.men - menBefore;
          if (added > 0) base.population -= added;
        } else if (u.hp < u.men * st.hpPerMan) {
          // wounded heal (hp below what the surviving men can have)
          u.hp = Math.min(u.men * st.hpPerMan, u.hp + st.hpPerMan * 0.1 * dt);
        }
      } else {
        const hpGain = Math.min(st.maxHp - u.hp, st.maxHp * 0.04 * dt);
        const cost = hpGain * 0.02;
        if (base.stock.refined >= cost) {
          base.stock.refined -= cost;
          u.hp += hpGain;
        }
        if (u.men < st.crew && base.population > 8) {
          // replacement crew
          const need = st.crew - u.men;
          const take = Math.min(need, Math.floor(base.population - 8));
          if (take > 0) {
            u.men += take;
            base.population -= take;
          }
        }
      }
    }
  }
}

/** Expected per-hour production of a resource at a base (for UI/AI estimates). */
export function nominalOutputPerHour(state: CampaignState, baseId: string, res: keyof Stock): number {
  let total = 0;
  for (const b of buildingsOfBase(state, baseId)) {
    if (b.state !== 'active') continue;
    const def = BUILDINGS[b.typeId];
    if (def.extraction && b.siteId) {
      const site = state.sites[b.siteId];
      if (site && def.extraction[site.kind].resource === res) total += def.extraction[site.kind].perHour * site.richness;
    }
    for (const r of def.recipes ?? []) {
      if ((r.outputs[res] ?? 0) > 0) total += (r.outputs[res] ?? 0) / r.cycleHours / (def.recipes!.length || 1);
    }
  }
  return total;
}
