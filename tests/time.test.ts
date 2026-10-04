import { describe, expect, it } from 'vitest';
import { darkness, hourOfDay } from '../src/core/time';
import { createBattleSetup } from '../src/battle/setup';
import { BattleSim } from '../src/battle/sim';
import { createArmy } from '../src/campaign/armies';
import { createUnit } from '../src/campaign/units';
import type { PendingBattle } from '../src/campaign/types';
import { statsOf } from '../src/units/stats';
import { freshCampaign } from './helpers';

describe('time of day', () => {
  it('maps campaign hours to local hour of day (campaign starts 06:00)', () => {
    expect(hourOfDay(0)).toBeCloseTo(6, 5);
    expect(hourOfDay(6)).toBeCloseTo(12, 5);
    expect(hourOfDay(18)).toBeCloseTo(0, 5);
    expect(hourOfDay(20.5)).toBeCloseTo(2.5, 5);
  });

  it('is dark at night, light by day, and blends at dawn and dusk', () => {
    expect(darkness(0)).toBe(1);
    expect(darkness(12)).toBe(0);
    expect(darkness(6)).toBeGreaterThan(0);
    expect(darkness(6)).toBeLessThan(1);
    expect(darkness(19)).toBeGreaterThan(0);
    expect(darkness(23)).toBe(1);
  });

  it('thermal sights keep tanks seeing at night; infantry see less', () => {
    expect(statsOf('mbt').nightVision).toBe(1);
    expect(statsOf('rifle_squad').nightVision).toBe(0);
    expect(statsOf('recon_jeep').nightVision).toBeGreaterThan(0);
  });

  it('battles carry their start hour and advance it with the compressed battle clock', () => {
    const c = freshCampaign();
    c.state.time = 16; // 22:00 local
    const x = c.pBase.x + 30;
    const z = c.pBase.z + 20;
    const a = createArmy(c, c.player, x, z, [createUnit(c.state, 'rifle_squad')], c.pBase.id);
    const b = createArmy(c, c.enemy, x + 2, z, [createUnit(c.state, 'rifle_squad')], c.eBase.id);
    const p: PendingBattle = {
      id: 'bt-night', kind: 'field', x, z, attackerFactionId: c.enemy, defenderFactionId: c.player,
      attackerArmyIds: [b.id], defenderArmyIds: [a.id], baseId: null, buildingId: null, createdAt: c.state.time, seed: 5,
    };
    const setup = createBattleSetup(c.state, c.world, p);
    expect(setup.startHour).toBeCloseTo(22, 5);
    const sim = new BattleSim(setup, c.world.terrain, { aiSides: [] });
    expect(sim.hourNow()).toBeCloseTo(22, 5);
    sim.time = 300; // 5 min of battle = 1 h of campaign time
    expect(sim.hourNow()).toBeCloseTo(23, 5);
  });
});
