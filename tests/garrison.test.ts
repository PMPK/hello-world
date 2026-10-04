import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import type { PendingBattle } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim, eyeHeight, GARRISON_COVER } from '../src/battle/sim';
import type { BBuilding, BUnit } from '../src/battle/types';
import { dist } from '../src/core/math';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** Enemy assault on the player's base; the base garrison is `squads` rifle squads. */
function assault(c: Camp, attackers: Record<string, number>, squads: number): PendingBattle {
  c.pBase.garrison = [];
  for (let i = 0; i < squads; i++) c.pBase.garrison.push(createUnit(c.state, 'rifle_squad'));
  const units = [];
  for (const [d, n] of Object.entries(attackers)) for (let i = 0; i < n; i++) units.push(createUnit(c.state, d));
  const a = createArmy(c, c.enemy, c.pBase.x + 6, c.pBase.z, units, c.eBase.id);
  return {
    id: 'bt-gar',
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
    seed: 5150,
  };
}

function setupSim(c: Camp, attackers: Record<string, number>, squads: number, aiSides: (0 | 1)[] = []): BattleSim {
  const setup = createBattleSetup(c.state, c.world, assault(c, attackers, squads));
  return new BattleSim(setup, c.world.terrain, { aiSides });
}

const defenders = (sim: BattleSim): BUnit[] => sim.units.filter((u) => u.side === 1 && u.stats.family === 'infantry' && !u.reserve);
const habitat = (sim: BattleSim): BBuilding => sim.buildings.find((b) => b.side === 1 && b.spec.typeId === 'habitat' && !b.destroyed)!;

function runUntil(sim: BattleSim, done: () => boolean, maxSeconds: number): void {
  for (let t = 0; t < maxSeconds && !done(); t += 0.5) sim.step(0.5);
}

describe('garrisoning buildings', () => {
  it('infantry enter a friendly building up to its capacity', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { recon_jeep: 1 }, 3);
    const hab = habitat(sim);
    expect(sim.garrisonCapacity(hab)).toBe(2);
    const squads = defenders(sim);
    expect(sim.orderGarrison(squads.map((u) => u.id), hab.id)).toBe(2);
    runUntil(sim, () => sim.occupants(hab).length === 2, 90);
    const inside = sim.occupants(hab);
    expect(inside.length).toBe(2);
    for (const u of inside) {
      expect(u.x).toBe(hab.x);
      expect(u.z).toBe(hab.z);
      expect(eyeHeight(u)).toBeGreaterThan(4);
    }
    // the third squad was not sent in
    expect(squads.filter((u) => u.inside === null).length).toBe(1);
    sim.step(0.5);
    expect(inside[0].cover).toBe(GARRISON_COVER);
  });

  it('a move order brings the garrison out of the building', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { recon_jeep: 1 }, 1);
    const hab = habitat(sim);
    const [u] = defenders(sim);
    sim.orderGarrison([u.id], hab.id);
    runUntil(sim, () => u.inside !== null, 90);
    expect(u.inside).toBe(hab.id);
    sim.orderMove([u.id], hab.x + 80, hab.z, false);
    expect(u.inside).toBeNull();
    expect(dist(u.x, u.z, hab.x, hab.z)).toBeGreaterThan(hab.radius);
  });

  it('a garrison ordered to attack a target out of reach comes out after it', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { recon_jeep: 1 }, 1);
    const hab = habitat(sim);
    const [u] = defenders(sim);
    sim.orderGarrison([u.id], hab.id);
    runUntil(sim, () => u.inside !== null, 90);
    const jeep = sim.units.find((e) => e.side === 0)!;
    jeep.x = hab.x + 400;
    jeep.z = hab.z;
    jeep.seenBy[1] = true;
    sim.orderAttack([u.id], { kind: 'unit', id: jeep.id });
    sim.step(0.2);
    expect(u.inside).toBeNull();
    expect(u.order.type).toBe('attack');
  });

  it('a collapsing building hurts and ejects its garrison', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { recon_jeep: 1 }, 1);
    const hab = habitat(sim);
    const [u] = defenders(sim);
    sim.orderGarrison([u.id], hab.id);
    runUntil(sim, () => u.inside !== null, 90);
    const before = u.hp;
    sim.damageBuilding(hab, hab.hp * 0.5);
    expect(u.hp).toBeLessThan(before); // shelling the structure reaches the squad inside
    const mid = u.hp;
    sim.damageBuilding(hab, hab.hp + 10);
    expect(hab.destroyed).toBe(true);
    expect(u.inside).toBeNull();
    expect(u.hp).toBeLessThan(mid - u.stats.maxHp * 0.3);
    expect(u.suppression).toBe(1);
  });

  it('vehicles cannot garrison', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { recon_jeep: 1 }, 0);
    const jeep = sim.units.find((u) => u.side === 0)!;
    const mine = sim.buildings.find((b) => b.side === 1 && sim.garrisonCapacity(b) > 0)!;
    expect(sim.canGarrison(jeep, mine)).toBe(false);
    expect(sim.orderGarrison([jeep.id], mine.id)).toBe(0);
  });

  it('AI siege defenders man the buildings facing the attack', () => {
    const c = freshCampaign();
    const sim = setupSim(c, { mbt: 1, rifle_squad: 2 }, 3, [0, 1]);
    runUntil(sim, () => defenders(sim).some((u) => u.inside !== null), 60);
    const inside = defenders(sim).filter((u) => u.inside !== null);
    expect(inside.length).toBeGreaterThan(0);
  });
});
