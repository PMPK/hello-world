import { describe, expect, it } from 'vitest';
import { dist } from '../src/core/math';
import { CAMPAIGN_HOURS_PER_SECOND } from '../src/core/time';
import { formArmyFromGarrison, fuelRange, garrisonArmy, orderAttack, orderMove } from '../src/campaign/armies';
import { createUnit } from '../src/campaign/units';
import { advanceCampaign, SIM_STEP } from '../src/campaign/sim';
import { armiesOf } from '../src/campaign/queries';
import { statsOf } from '../src/units/stats';
import { freshCampaign } from './helpers';

describe('campaign time', () => {
  it('advances in fixed steps and stops when a battle is pending', () => {
    const c = freshCampaign();
    const t0 = c.state.time;
    const done = advanceCampaign(c, 10);
    expect(done).toBeCloseTo(10, 5);
    expect(c.state.time).toBeCloseTo(t0 + 10, 5);
    c.state.pendingBattle = {
      id: 'x', kind: 'field', x: 0, z: 0, attackerFactionId: c.enemy, defenderFactionId: c.player,
      attackerArmyIds: [], defenderArmyIds: [], baseId: null, buildingId: null, createdAt: 0, seed: 1,
    };
    expect(advanceCampaign(c, 5)).toBe(0);
    expect(c.state.time).toBeCloseTo(t0 + 10, 5);
    expect(SIM_STEP).toBeGreaterThan(0);
    expect(CAMPAIGN_HOURS_PER_SECOND).toBeGreaterThan(0);
  });

  it('is deterministic for the same seed', () => {
    const a = freshCampaign(31337);
    const b = freshCampaign(31337);
    advanceCampaign(a, 72);
    advanceCampaign(b, 72);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });
});

describe('armies', () => {
  it('moves continuously toward its destination over campaign time and burns fuel', () => {
    const c = freshCampaign();
    const army = armiesOf(c.state, c.player)[0];
    const tank = army.units.find((u) => u.designId === 'mbt')!;
    const fuel0 = tank.fuel;
    const start = { x: army.x, z: army.z };
    // pick a reachable target ~25 units away
    let target = { x: army.x + 25, z: army.z };
    for (const [dx, dz] of [[25, 0], [-25, 0], [0, 25], [0, -25], [18, 18], [-18, -18]]) {
      if (c.world.isPassable(army.x + dx, army.z + dz)) {
        target = { x: army.x + dx, z: army.z + dz };
        break;
      }
    }
    expect(orderMove(c, army.id, target.x, target.z)).toBe(true);
    advanceCampaign(c, 1);
    const d1 = dist(army.x, army.z, start.x, start.z);
    expect(d1).toBeGreaterThan(0.5);
    expect(d1).toBeLessThan(8);
    advanceCampaign(c, 30);
    expect(dist(army.x, army.z, target.x, target.z)).toBeLessThan(1);
    expect(army.order.type).toBe('idle');
    expect(tank.fuel).toBeLessThan(fuel0);
  });

  it('forms an army from the garrison and returns units to it', () => {
    const c = freshCampaign();
    c.pBase.garrison.push(createUnit(c.state, 'recon_jeep'));
    const n = c.pBase.garrison.length;
    const army = formArmyFromGarrison(c, c.pBase.id)!;
    expect(army.units.length).toBe(n);
    expect(c.pBase.garrison.length).toBe(0);
    expect(army.food).toBeGreaterThan(0);
    expect(garrisonArmy(c, army.id)).toBe(true);
    expect(c.pBase.garrison.length).toBe(n);
    expect(c.state.armies[army.id]).toBeUndefined();
  });

  it('fuel range is limited by the thirstiest vehicle; infantry walk', () => {
    const c = freshCampaign();
    const tank = createUnit(c.state, 'mbt');
    const jeep = createUnit(c.state, 'recon_jeep');
    const inf = createUnit(c.state, 'rifle_squad');
    tank.fuel = 10;
    const perUnit = statsOf('mbt').fuelPerUnit;
    expect(fuelRange([tank, jeep, inf])).toBeCloseTo(10 / perUnit, 5);
    expect(fuelRange([inf])).toBe(Infinity);
  });

  it('army speed is limited by the slowest unit', () => {
    const c = freshCampaign();
    const army = armiesOf(c.state, c.player)[0];
    const slowest = Math.min(...army.units.map((u) => statsOf(u.designId).strategicSpeed));
    expect(slowest).toBeGreaterThan(0);
    expect(slowest).toBeLessThan(statsOf('recon_jeep').strategicSpeed);
  });

  it('attacking an enemy army starts hostilities and creates a pending battle', () => {
    const c = freshCampaign();
    const mine = armiesOf(c.state, c.player)[0];
    const theirs = armiesOf(c.state, c.enemy)[0] ?? null;
    let targetId: string;
    if (theirs) targetId = theirs.id;
    else {
      // AI may have garrisoned its army; deploy one next to ours for the test
      const a = formArmyFromGarrison(c, c.eBase.id)!;
      targetId = a.id;
    }
    const enemy = c.state.armies[targetId];
    enemy.x = mine.x + 6;
    enemy.z = mine.z;
    enemy.path = [];
    enemy.order = { type: 'idle' };
    expect(c.state.relations[0].status).toBe('standoff');
    expect(orderAttack(c, mine.id, { kind: 'army', id: targetId })).toBe(true);
    advanceCampaign(c, 6);
    expect(c.state.pendingBattle).not.toBeNull();
    expect(c.state.relations[0].status).toBe('hostile');
    expect(c.state.pendingBattle!.attackerFactionId).toBe(c.player);
  });

  it('armies in standoff pass each other without fighting', () => {
    const c = freshCampaign();
    const mine = armiesOf(c.state, c.player)[0];
    const a = armiesOf(c.state, c.enemy)[0] ?? formArmyFromGarrison(c, c.eBase.id)!;
    a.x = mine.x + 1;
    a.z = mine.z;
    a.path = [];
    a.order = { type: 'idle' };
    c.state.ai[c.enemy].nextThinkAt = 1e9; // keep the AI from moving it
    advanceCampaign(c, 2);
    expect(c.state.pendingBattle).toBeNull();
  });
});
