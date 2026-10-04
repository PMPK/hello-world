import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { foundBase, MIN_BASE_SPACING, validateBaseSite } from '../src/campaign/expansion';
import { addStandingTransfer, stepLogistics, STANDING_RESERVE, transfersFrom } from '../src/campaign/logistics';
import { STATE_VERSION } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { captureBase } from '../src/battle/result';
import { declareHostile } from '../src/campaign/diplomacy';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

function secondBase(c: Camp) {
  Object.assign(c.pBase.stock, { minerals: 600, refined: 400, components: 200, food: 300, fuel: 200, ammo: 120 });
  c.pBase.population = 60;
  for (let r = MIN_BASE_SPACING + 4; r < 150; r += 6) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = c.pBase.x + Math.cos(a) * r;
      const z = c.pBase.z + Math.sin(a) * r;
      if (!validateBaseSite(c.state, c.world, c.pBase, x, z).ok) continue;
      const res = foundBase(c, c.pBase.id, x, z);
      if (res.ok) return res.base;
    }
  }
  throw new Error('no site');
}

/** Run the logistics step hour by hour (on the hour, as in the campaign). */
function hours(c: Camp, n: number): void {
  for (let h = 0; h < n; h++) {
    c.state.time = Math.floor(c.state.time) + 1;
    stepLogistics(c);
  }
}

describe('standing logistics orders', () => {
  it('a task force set to automatic supply gets a supply run when it runs low in the field', () => {
    const c = freshCampaign();
    const units = [createUnit(c.state, 'mbt'), createUnit(c.state, 'rifle_squad')];
    const a = createArmy(c, c.player, c.pBase.x + 50, c.pBase.z, units, c.pBase.id);
    units[0].fuel = 3;
    a.food = 0;
    c.pBase.stock.fuel = 200;
    c.pBase.stock.food = 200;
    hours(c, 1);
    expect(Object.values(c.state.convoys).some((cv) => cv.toArmyId === a.id)).toBe(false);
    a.autoSupply = true;
    hours(c, 1);
    const run = Object.values(c.state.convoys).find((cv) => cv.toArmyId === a.id);
    expect(run).toBeTruthy();
    expect(run!.cargo.fuel ?? 0).toBeGreaterThan(0);
    expect(run!.cargo.food ?? 0).toBeGreaterThan(0);
    expect(c.state.log.some((l) => l.text.includes(`on its way to ${a.name} (automatic)`))).toBe(true);
    // one run at a time
    hours(c, 1);
    expect(Object.values(c.state.convoys).filter((cv) => cv.toArmyId === a.id).length).toBe(1);
  });

  it('a standing convoy leaves on schedule with what the base can spare, and stops when a base falls', () => {
    const c = freshCampaign();
    const outpost = secondBase(c);
    for (const id of Object.keys(c.state.convoys)) delete c.state.convoys[id];
    expect(addStandingTransfer(c, c.pBase.id, outpost.id, { minerals: 40, fuel: 30 }, 0, 7)).not.toBeNull();
    expect(addStandingTransfer(c, c.pBase.id, outpost.id, { minerals: 40, fuel: 30 }, 0, 12)).toBeNull();
    expect(transfersFrom(c.state, c.pBase.id).length).toBe(1);
    c.pBase.stock.minerals = 200;
    c.pBase.stock.fuel = 25;
    hours(c, 11);
    expect(Object.keys(c.state.convoys).length).toBe(0);
    hours(c, 1);
    const sent = Object.values(c.state.convoys);
    expect(sent.length).toBe(1);
    expect(sent[0].cargo.minerals).toBe(40);
    expect(sent[0].cargo.fuel).toBe(25 - STANDING_RESERVE);
    expect(c.pBase.stock.fuel).toBeCloseTo(STANDING_RESERVE, 6);
    // the outpost falls: the order is dropped
    declareHostile(c, c.enemy, c.player);
    captureBase(c, outpost, c.enemy);
    hours(c, 1);
    expect(transfersFrom(c.state, c.pBase.id).length).toBe(0);
    expect(c.state.log.some((l) => l.text.startsWith('Standing convoy') && l.text.includes('cancelled'))).toBe(true);
  });

  it('old saves gain the logistics fields (v9 → v10)', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 9;
    delete raw.transfers;
    for (const a of Object.values(raw.armies) as Record<string, unknown>[]) delete a.autoSupply;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    expect(m.transfers).toEqual({});
    for (const a of Object.values(m.armies)) expect(a.autoSupply).toBe(false);
  });
});
