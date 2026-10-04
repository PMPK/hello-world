import { describe, expect, it } from 'vitest';
import { stepStrategicAI } from '../src/ai/strategicAI';
import { createArmy, orderMove, stepArmies } from '../src/campaign/armies';
import { sendSupplyRun, stepConvoys } from '../src/campaign/convoys';
import { armiesOf, basesOf } from '../src/campaign/queries';
import { STATE_VERSION, type Army } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { migrateState } from '../src/persistence/migrations';
import { statsOf } from '../src/units/stats';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** A player task force out in the field, low on everything. */
function thirstyForce(c: Camp, dx = 45): Army {
  const units = [createUnit(c.state, 'mbt'), createUnit(c.state, 'rifle_squad')];
  // find passable ground dx km out
  let x = c.pBase.x + dx;
  let z = c.pBase.z;
  for (let k = 0; k < 16 && !c.world.isPassable(x, z); k++) {
    const a = (k / 16) * Math.PI * 2;
    x = c.pBase.x + Math.cos(a) * dx;
    z = c.pBase.z + Math.sin(a) * dx;
  }
  const a = createArmy(c, c.player, x, z, units, c.pBase.id);
  units[0].fuel = 5;
  units[0].ammo = 2;
  units[1].ammo = 1;
  a.food = 0;
  return a;
}

function run(c: Camp, hours: number): void {
  for (let t = 0; t < hours; t += 0.1) {
    stepArmies(c, 0.1);
    stepConvoys(c, 0.1);
  }
}

describe('supply runs', () => {
  it('reach a task force, top it up and bring the rest home', () => {
    const c = freshCampaign();
    for (const id of Object.keys(c.state.roads)) delete c.state.roads[id];
    const a = thirstyForce(c);
    c.pBase.stock.fuel = 200;
    c.pBase.stock.ammo = 100;
    const fuel0 = c.pBase.stock.fuel;
    const r = sendSupplyRun(c, c.pBase.id, a.id, { fuel: 100, ammo: 20 });
    expect(r.ok).toBe(true);
    expect(c.pBase.stock.fuel).toBe(fuel0 - 100);
    run(c, 12);
    const tank = a.units[0];
    expect(tank.fuel).toBeCloseTo(statsOf('mbt').fuelCapacity, 5);
    expect(tank.ammo).toBeGreaterThan(2);
    expect(c.state.log.some((l) => l.text.startsWith(`Supply run reached ${a.name}`))).toBe(true);
    // the convoy drives home with what the force could not take
    run(c, 12);
    expect(Object.keys(c.state.convoys).length).toBe(0);
    expect(c.pBase.stock.fuel).toBeGreaterThan(fuel0 - 100 + 30);
  });

  it('follow a force that keeps moving', () => {
    const c = freshCampaign();
    for (const id of Object.keys(c.state.roads)) delete c.state.roads[id];
    const a = thirstyForce(c, 30);
    a.units[0].fuel = 40;
    c.pBase.stock.food = 300;
    sendSupplyRun(c, c.pBase.id, a.id, { food: 30 });
    orderMove(c, a.id, a.x + (a.x - c.pBase.x) * 0.6, a.z + (a.z - c.pBase.z) * 0.6);
    run(c, 16);
    expect(a.food).toBeGreaterThan(0);
  });

  it('turn back when the force is gone, and refuse the wrong goods', () => {
    const c = freshCampaign();
    for (const id of Object.keys(c.state.roads)) delete c.state.roads[id];
    const a = thirstyForce(c);
    c.pBase.stock.minerals = 300;
    expect(sendSupplyRun(c, c.pBase.id, a.id, { minerals: 50 }).ok).toBe(false);
    expect(sendSupplyRun(c, c.pBase.id, a.id, { fuel: 200 }).ok).toBe(false);
    c.pBase.stock.fuel = 100;
    expect(sendSupplyRun(c, c.pBase.id, a.id, { fuel: 50 }).ok).toBe(true);
    run(c, 0.5);
    delete c.state.armies[a.id];
    run(c, 12);
    expect(Object.keys(c.state.convoys).length).toBe(0);
    expect(c.pBase.stock.fuel).toBeGreaterThan(90);
  });

  it('the rival rescues a force that ran dry', () => {
    const c = freshCampaign();
    const eBase = basesOf(c.state, c.enemy)[0];
    eBase.stock.fuel = 300;
    for (const army of armiesOf(c.state, c.enemy)) {
      army.x = eBase.x + 60;
      army.z = eBase.z;
      for (const u of army.units) u.fuel = 0;
    }
    c.state.ai[c.enemy].nextThinkAt = 0;
    stepStrategicAI(c, 0);
    const runs = Object.values(c.state.convoys).filter((cv) => cv.factionId === c.enemy && cv.toArmyId);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].cargo.fuel ?? 0).toBeGreaterThan(0);
  });

  it('old saves gain the supply-run field (v7 → v8)', () => {
    const c = freshCampaign();
    const a = thirstyForce(c);
    c.pBase.stock.fuel = 100;
    sendSupplyRun(c, c.pBase.id, a.id, { fuel: 20 });
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 7;
    for (const cv of Object.values(raw.convoys) as Record<string, unknown>[]) delete cv.toArmyId;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    for (const cv of Object.values(m.convoys)) expect(cv.toArmyId).toBeNull();
  });
});
