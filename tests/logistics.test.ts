import { describe, expect, it } from 'vitest';
import { armySupplies, createArmy, fieldResupply, fuelRange, maxRations, TRUCK_FUEL_RESERVE } from '../src/campaign/armies';
import type { PendingBattle } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { resupplyUnits } from '../src/economy/economy';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim } from '../src/battle/sim';
import { statsOf } from '../src/units/stats';
import { freshCampaign } from './helpers';

describe('supply trucks', () => {
  it('are unarmed support vehicles that carry fuel and ammunition', () => {
    const st = statsOf('supply_truck');
    expect(st.family).toBe('support');
    expect(st.weapons.length).toBe(0);
    expect(st.isVehicle).toBe(true);
    expect(st.fuelCapacity).toBeGreaterThan(statsOf('mbt').fuelCapacity);
    expect(st.ammoCapacity).toBeGreaterThan(0);
    expect(st.power).toBe(0);
  });

  it('top up the task force in the field, keeping their own fuel reserve', () => {
    const c = freshCampaign();
    const tank = createUnit(c.state, 'mbt');
    const squad = createUnit(c.state, 'rifle_squad');
    const truck = createUnit(c.state, 'supply_truck');
    tank.fuel = 5;
    squad.ammo = 1;
    truck.fuel = TRUCK_FUEL_RESERVE + 10;
    const units = [tank, squad, truck];
    fieldResupply(units, 1);
    expect(tank.fuel).toBeCloseTo(13, 5); // 8 fuel / h per truck
    expect(truck.fuel).toBeCloseTo(TRUCK_FUEL_RESERVE + 2, 5);
    expect(squad.ammo).toBeGreaterThan(1);
    // the truck never gives away its reserve
    for (let i = 0; i < 10; i++) fieldResupply(units, 1);
    expect(truck.fuel).toBeCloseTo(TRUCK_FUEL_RESERVE, 5);
    expect(armySupplies(units).fuel).toBeCloseTo(0, 5);
  });

  it('extend fuel range and rations of their army', () => {
    const c = freshCampaign();
    const tank = createUnit(c.state, 'mbt');
    tank.fuel = 10;
    const alone = fuelRange([tank]);
    expect(alone).toBeCloseTo(10 / statsOf('mbt').fuelPerUnit, 5);
    const truck = createUnit(c.state, 'supply_truck');
    expect(fuelRange([tank, truck])).toBeGreaterThan(alone * 3);
    const a1 = createArmy(c, c.player, c.pBase.x + 20, c.pBase.z, [createUnit(c.state, 'rifle_squad')], c.pBase.id);
    const a2 = createArmy(c, c.player, c.pBase.x + 22, c.pBase.z, [createUnit(c.state, 'rifle_squad'), createUnit(c.state, 'supply_truck')], c.pBase.id);
    expect(maxRations(a2)).toBeGreaterThan(maxRations(a1));
  });

  it('load cargo at a base faster than units refill', () => {
    const c = freshCampaign();
    const truck = createUnit(c.state, 'supply_truck');
    const tank = createUnit(c.state, 'mbt');
    truck.ammo = 0;
    tank.ammo = 0;
    c.pBase.stock.ammo = 500;
    resupplyUnits(c.pBase, [truck, tank], 1, false);
    expect(truck.ammo).toBeGreaterThan(tank.ammo * 2);
  });
});

describe('supply trucks in battle', () => {
  function fieldBattle(c: ReturnType<typeof freshCampaign>): PendingBattle {
    const x = c.pBase.x + 30;
    const z = c.pBase.z + 20;
    const mine = createArmy(c, c.player, x, z, [createUnit(c.state, 'rifle_squad'), createUnit(c.state, 'supply_truck')], c.pBase.id);
    const theirs = createArmy(c, c.enemy, x + 2, z, [createUnit(c.state, 'rifle_squad')], c.eBase.id);
    return {
      id: 'bt-log',
      kind: 'field',
      x,
      z,
      attackerFactionId: c.enemy,
      defenderFactionId: c.player,
      attackerArmyIds: [theirs.id],
      defenderArmyIds: [mine.id],
      baseId: null,
      buildingId: null,
      createdAt: c.state.time,
      seed: 99,
    };
  }

  it('rearm units next to them', () => {
    const c = freshCampaign();
    const sim = new BattleSim(createBattleSetup(c.state, c.world, fieldBattle(c)), c.world.terrain, { aiSides: [] });
    const squad = sim.units.find((u) => u.side === 1 && u.stats.family === 'infantry')!;
    const truck = sim.units.find((u) => u.side === 1 && u.stats.family === 'support')!;
    squad.ammo = 0.5;
    truck.x = squad.x + 10;
    truck.z = squad.z;
    const cargo = truck.ammo;
    for (let i = 0; i < 20; i++) sim.step(0.5);
    expect(squad.ammo).toBeGreaterThan(5);
    expect(truck.ammo).toBeLessThan(cargo);
  });

  it('cannot hold the field alone', () => {
    const c = freshCampaign();
    const sim = new BattleSim(createBattleSetup(c.state, c.world, fieldBattle(c)), c.world.terrain, { aiSides: [] });
    const squad = sim.units.find((u) => u.side === 1 && u.stats.family === 'infantry')!;
    sim.damageUnit(squad, squad.hp + 1, null);
    expect(sim.canSecure(0)).toBe(true);
    for (let i = 0; i < 4 && !sim.finished; i++) sim.step(0.5);
    expect(sim.finished).toBe(true);
    expect(sim.winner).toBe(0);
  });
});
