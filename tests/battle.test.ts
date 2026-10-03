import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { createUnit } from '../src/campaign/units';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim } from '../src/battle/sim';
import { autoResolve } from '../src/battle/autoresolve';
import { applyBattleResult } from '../src/battle/result';
import type { PendingBattle } from '../src/campaign/types';
import { freshCampaign } from './helpers';

function assault(c: ReturnType<typeof freshCampaign>, comp: Record<string, number>): PendingBattle {
  const units = [];
  for (const [d, n] of Object.entries(comp)) for (let i = 0; i < n; i++) units.push(createUnit(c.state, d));
  const a = createArmy(c, c.enemy, c.pBase.x + 4, c.pBase.z + 3, units, c.eBase.id);
  return {
    id: 'bt-test', kind: 'base_assault', x: c.pBase.x, z: c.pBase.z,
    attackerFactionId: c.enemy, defenderFactionId: c.player, attackerArmyIds: [a.id], defenderArmyIds: [],
    baseId: c.pBase.id, buildingId: null, createdAt: c.state.time, seed: 777,
  };
}

describe('battle setup', () => {
  it('a base assault battlefield contains the same buildings as the campaign base', () => {
    const c = freshCampaign();
    const p = assault(c, { rifle_squad: 2, mbt: 1 });
    const setup = createBattleSetup(c.state, c.world, p);
    const baseBuildings = Object.values(c.state.buildings).filter((b) => b.baseId === c.pBase.id && Math.hypot(b.x - c.pBase.x, b.z - c.pBase.z) < 15);
    for (const b of baseBuildings) {
      const spec = setup.buildings.find((s) => s.campaignId === b.id);
      expect(spec, `building ${b.typeId} missing`).toBeTruthy();
      expect(spec!.typeId).toBe(b.typeId);
      expect(spec!.hp).toBe(b.hp);
    }
    // relative layout preserved (HQ at the centre of the battlefield)
    const hq = setup.buildings.find((s) => s.typeId === 'hq')!;
    expect(Math.abs(hq.x - 400)).toBeLessThan(1);
    expect(Math.abs(hq.z - 400)).toBeLessThan(1);
    // defender garrison included, attacker units included
    expect(setup.sides[1].units.length).toBe(c.pBase.garrison.length);
    expect(setup.sides[0].units.length).toBe(3);
    expect(setup.playerSide).toBe(1);
  });
});

describe('battle simulation', () => {
  it('runs, spends ammo and fuel, and produces a result', () => {
    const c = freshCampaign();
    const p = assault(c, { rifle_squad: 3, mbt: 2, recon_jeep: 1 });
    const setup = createBattleSetup(c.state, c.world, p);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [0, 1] });
    for (let i = 0; i < 4000 && !sim.finished; i++) sim.step(0.25);
    if (!sim.finished) sim.finish(1, 'timeout');
    const r = sim.computeResult();
    expect(r.durationSeconds).toBeGreaterThan(0);
    expect(r.campaignHours).toBeGreaterThan(0);
    expect(r.units.length).toBe(setup.sides[0].units.length + setup.sides[1].units.length);
    expect(r.sides[0].ammoSpent + r.sides[1].ammoSpent).toBeGreaterThan(0);
    expect(r.sides[0].fuelSpent).toBeGreaterThan(0);
  });

  it('auto-resolve is deterministic', () => {
    const c1 = freshCampaign();
    const c2 = freshCampaign();
    const r1 = autoResolve(createBattleSetup(c1.state, c1.world, assault(c1, { rifle_squad: 3, mbt: 1 })), c1.world.terrain);
    const r2 = autoResolve(createBattleSetup(c2.state, c2.world, assault(c2, { rifle_squad: 3, mbt: 1 })), c2.world.terrain);
    expect(r1).toEqual(r2);
  });

  it('player orders move units and attack targets', () => {
    const c = freshCampaign();
    const p = assault(c, { rifle_squad: 2 });
    const setup = createBattleSetup(c.state, c.world, p);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [0] });
    const mine = sim.units.filter((u) => u.side === 1 && u.alive);
    expect(mine.length).toBeGreaterThan(0);
    const u = mine[0];
    const start = { x: u.x, z: u.z };
    const dest = sim.freeSpot(u.x + 40, u.z + 10);
    sim.orderMove([u.id], dest.x, dest.z, false);
    for (let i = 0; i < 40; i++) sim.step(0.25);
    expect(Math.hypot(u.x - start.x, u.z - start.z)).toBeGreaterThan(10);
    sim.orderHold([u.id]);
    expect(u.order.type).toBe('hold');
  });
});

describe('battle results persist into the campaign', () => {
  it('casualties, damage, destroyed buildings and time are applied', () => {
    const c = freshCampaign();
    const p = assault(c, { rifle_squad: 2, mbt: 1 });
    c.state.pendingBattle = p;
    const setup = createBattleSetup(c.state, c.world, p);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [] });
    // scripted outcome: the garrison squad is wiped out, a factory-class building is destroyed,
    // one attacker tank is damaged, and the attacker is victorious.
    const defender = sim.units.find((u) => u.side === 1)!;
    sim.damageUnit(defender, defender.hp + 10, null);
    const farm = sim.buildings.find((b) => b.spec.typeId === 'farm')!;
    sim.damageBuilding(farm, farm.hp + 1);
    const tank = sim.units.find((u) => u.side === 0 && u.stats.family === 'tank')!;
    tank.hp -= 300;
    sim.time = 300;
    sim.finish(0, 'eliminated');
    const result = sim.computeResult();
    const t0 = c.state.time;
    const popBefore = c.pBase.population;
    const summary = applyBattleResult(c, setup, result);
    // garrison destroyed
    expect(c.state.bases[c.pBase.id].garrison.length).toBe(0);
    // farm destroyed in the campaign
    expect(c.state.buildings[farm.spec.campaignId].state).toBe('destroyed');
    // tank damage persisted (minus a little field repair during the post-battle hour at the captured base)
    const army = c.state.armies[p.attackerArmyIds[0]];
    const ctank = army.units.find((u) => u.id === tank.spec.campaignId)!;
    expect(ctank.hp).toBeGreaterThanOrEqual(tank.stats.maxHp - 300);
    expect(ctank.hp).toBeLessThan(tank.stats.maxHp - 200);
    // base captured by the attacker
    expect(c.state.bases[c.pBase.id].factionId).toBe(c.enemy);
    expect(c.state.bases[c.pBase.id].population).toBeLessThanOrEqual(popBefore);
    // campaign clock advanced by the battle duration
    expect(c.state.time).toBeGreaterThan(t0 + 0.9);
    expect(c.state.pendingBattle).toBeNull();
    expect(summary.playerWon).toBe(false);
    expect(c.state.stats.battlesFought).toBe(1);
  });

  it('a repulsed attack leaves the base with its owner and surviving units keep damage', () => {
    const c = freshCampaign();
    const p = assault(c, { rifle_squad: 1 });
    c.state.pendingBattle = p;
    const setup = createBattleSetup(c.state, c.world, p);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [] });
    const attacker = sim.units.find((u) => u.side === 0)!;
    sim.damageUnit(attacker, attacker.hp + 1, null);
    const def = sim.units.find((u) => u.side === 1)!;
    def.hp = 100; // 3 men left
    def.men = 3;
    def.ammo = 2;
    sim.time = 120;
    sim.finish(1, 'eliminated');
    applyBattleResult(c, setup, sim.computeResult());
    expect(c.state.bases[c.pBase.id].factionId).toBe(c.player);
    const g = c.state.bases[c.pBase.id].garrison.find((u) => u.id === def.spec.campaignId)!;
    expect(g.men).toBe(3);
    // the attacking army had a single squad: it is gone
    expect(c.state.armies[p.attackerArmyIds[0]]).toBeUndefined();
  });
});

describe('async auto-resolve', () => {
  it('produces exactly the same result as the synchronous version', async () => {
    const { autoResolveAsync } = await import('../src/battle/autoresolve');
    const c1 = freshCampaign();
    const c2 = freshCampaign();
    const sync = autoResolve(createBattleSetup(c1.state, c1.world, assault(c1, { rifle_squad: 2, mbt: 1 })), c1.world.terrain);
    const progress: number[] = [];
    const asyncR = await autoResolveAsync(createBattleSetup(c2.state, c2.world, assault(c2, { rifle_squad: 2, mbt: 1 })), c2.world.terrain, {
      sliceMs: 2,
      onProgress: (f) => progress.push(f),
    });
    expect(asyncR).toEqual(sync);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(1);
  });
});
