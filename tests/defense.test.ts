import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { makeBuilding, suggestPlacement } from '../src/campaign/construction';
import { declareHostile } from '../src/campaign/diplomacy';
import { garrisonStrength } from '../src/campaign/queries';
import { advanceCampaign } from '../src/campaign/sim';
import type { Building, PendingBattle } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { createBattleSetup } from '../src/battle/setup';
import { applyBattleResult } from '../src/battle/result';
import { BattleSim, isArmed } from '../src/battle/sim';
import type { BuildingTypeId } from '../src/data/buildings';
import { defenseStatsOf } from '../src/units/defense';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** A finished, fully crewed defence on the side of the player's base facing (dx, dz). */
function addDefense(c: Camp, typeId: BuildingTypeId, dx: number, dz: number, crewed = true): Building {
  const base = c.pBase;
  const spot = suggestPlacement(c.state, c.world, base, typeId, base.x + dx, base.z + dz)!;
  expect(spot).toBeTruthy();
  const b = makeBuilding(c.state, typeId, base, spot.x, spot.z, Math.atan2(dx, dz), null, true);
  b.workers = crewed ? defenseStatsOf(typeId)!.crew : 0;
  c.state.buildings[b.id] = b;
  return b;
}

/** Enemy infantry assault on the player's base from the +x side, base garrison removed. */
function infantryAssault(c: Camp, squads: number): PendingBattle {
  c.pBase.garrison = [];
  const units = [];
  for (let i = 0; i < squads; i++) units.push(createUnit(c.state, 'rifle_squad'));
  const a = createArmy(c, c.enemy, c.pBase.x + 6, c.pBase.z, units, c.eBase.id);
  return {
    id: 'bt-def',
    kind: 'base_assault',
    x: c.pBase.x,
    z: c.pBase.z,
    attackerFactionId: c.enemy,
    defenderFactionId: c.player,
    attackerArmyIds: [a.id],
    defenderArmyIds: [],
    baseId: c.pBase.id,
    buildingId: null,
    createdAt: c.state.time,
    seed: 4141,
  };
}

describe('defensive structures', () => {
  it('a crewed bunker takes its ammunition from the base stock into battle', () => {
    const c = freshCampaign();
    const bunker = addDefense(c, 'bunker', 6, 0);
    c.pBase.stock.ammo = 100;
    const setup = createBattleSetup(c.state, c.world, infantryAssault(c, 2));
    const spec = setup.buildings.find((s) => s.campaignId === bunker.id)!;
    expect(spec.crew).toBe(3);
    expect(spec.ammo).toBe(defenseStatsOf('bunker')!.ammoCapacity);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [0] });
    const b = sim.buildings.find((x) => x.spec.campaignId === bunker.id)!;
    expect(b.defense).not.toBeNull();
    expect(isArmed(b)).toBe(true);
    // an armed position means the base is defended, even without a garrison
    expect(sim.undefended).toBe(false);
    expect(sim.canSecure(0)).toBe(false);
  });

  it('a bunker fires on attacking infantry and the ammunition spent leaves the base stock', () => {
    const c = freshCampaign();
    const bunker = addDefense(c, 'bunker', 6, 0);
    c.pBase.stock.ammo = 100;
    const p = infantryAssault(c, 3);
    c.state.pendingBattle = p;
    const setup = createBattleSetup(c.state, c.world, p);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [0, 1] });
    for (let i = 0; i < 2400 && !sim.finished; i++) sim.step(0.25);
    if (!sim.finished) sim.finish(1, 'timeout');
    const b = sim.buildings.find((x) => x.spec.campaignId === bunker.id)!;
    expect(b.defense!.ammo).toBeLessThan(b.defense!.ammoStart);
    const attackersHurt = sim.units.filter((u) => u.side === 0 && (u.men < u.menStart || !u.alive)).length;
    expect(attackersHurt).toBeGreaterThan(0);
    const result = sim.computeResult();
    const rb = result.buildings.find((x) => x.campaignId === bunker.id)!;
    expect(rb.ammoSpent).toBeGreaterThan(0);
    const ammoBefore = c.pBase.stock.ammo;
    applyBattleResult(c, setup, result);
    // the clock advances afterwards (economy may produce some ammo), so compare against the spend
    expect(c.state.bases[c.pBase.id].stock.ammo).toBeLessThan(ammoBefore - rb.ammoSpent + 5);
  });

  it('the attacker can only secure the base once its armed positions are knocked out', () => {
    const c = freshCampaign();
    addDefense(c, 'bunker', 6, 0);
    addDefense(c, 'at_emplacement', 0, 6);
    c.pBase.stock.ammo = 80;
    const setup = createBattleSetup(c.state, c.world, infantryAssault(c, 1));
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [] });
    const defences = sim.buildings.filter((b) => b.defense);
    expect(defences.length).toBe(2);
    expect(sim.canSecure(0)).toBe(false);
    for (const b of defences) sim.damageBuilding(b, b.hp + 1);
    expect(sim.canSecure(0)).toBe(true);
    sim.secure(0);
    const r = sim.computeResult();
    expect(r.winner).toBe(0);
    // destroyed positions lose crew
    const lost = r.buildings.filter((x) => x.crewLost > 0);
    expect(lost.length).toBeGreaterThan(0);
  });

  it('unmanned or unsupplied positions do not fight', () => {
    const c = freshCampaign();
    const empty = addDefense(c, 'bunker', 6, 0, false);
    const dry = addDefense(c, 'at_emplacement', 0, 6);
    c.pBase.stock.ammo = 0;
    const setup = createBattleSetup(c.state, c.world, infantryAssault(c, 1));
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [] });
    expect(sim.buildings.find((b) => b.spec.campaignId === empty.id)!.defense).toBeNull();
    expect(isArmed(sim.buildings.find((b) => b.spec.campaignId === dry.id)!)).toBe(false);
    expect(sim.undefended).toBe(true);
  });

  it('defences count toward a base strength for AI planning', () => {
    const c = freshCampaign();
    c.pBase.stock.ammo = 50;
    const before = garrisonStrength(c.state, c.pBase);
    addDefense(c, 'bunker', 6, 0);
    const after = garrisonStrength(c.state, c.pBase);
    expect(after - before).toBeCloseTo(defenseStatsOf('bunker')!.power, 0);
  });

  it('a hostile AI fortifies its base', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    advanceCampaign(c, 24 * 16);
    const forts = Object.values(c.state.buildings).filter(
      (b) => b.factionId === c.enemy && (b.typeId === 'bunker' || b.typeId === 'at_emplacement'),
    );
    expect(forts.length).toBeGreaterThan(0);
  });
});
