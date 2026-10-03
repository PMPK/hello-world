import { describe, expect, it } from 'vitest';
import { BUILDINGS } from '../src/data/buildings';
import { stockTotal } from '../src/data/resources';
import { startConstruction, startOutpost, suggestPlacement, validatePlacement } from '../src/campaign/construction';
import { queueUnit } from '../src/campaign/production';
import { advanceCampaign, stepCampaign } from '../src/campaign/sim';
import { stepBaseEconomy, storageCapacity } from '../src/economy/economy';
import { statsOf } from '../src/units/stats';
import { freshCampaign } from './helpers';

describe('economy', () => {
  it('construction pays its cost up front and completes over time', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const before = { ...base.stock };
    const spot = suggestPlacement(c.state, c.world, base, 'refinery')!;
    expect(spot).toBeTruthy();
    const r = startConstruction(c, base.id, 'refinery', spot.x, spot.z);
    expect(r.ok).toBe(true);
    expect(base.stock.minerals).toBe(before.minerals - (BUILDINGS.refinery.cost.minerals ?? 0));
    if (!r.ok) return;
    expect(r.building.state).toBe('construction');
    advanceCampaign(c, BUILDINGS.refinery.buildHours + 2);
    expect(c.state.buildings[r.building.id].state).toBe('active');
    expect(c.state.buildings[r.building.id].hp).toBe(BUILDINGS.refinery.maxHp);
  });

  it('rejects unaffordable or invalid placements', () => {
    const c = freshCampaign();
    const base = c.pBase;
    base.stock.minerals = 0;
    const spot = suggestPlacement(c.state, c.world, base, 'factory')!;
    const r = startConstruction(c, base.id, 'factory', spot.x, spot.z);
    expect(r.ok).toBe(false);
    base.stock.minerals = 999;
    expect(validatePlacement(c.state, c.world, base, 'factory', base.x, base.z).ok).toBe(false); // on top of HQ
    expect(validatePlacement(c.state, c.world, base, 'factory', base.x + 40, base.z).ok).toBe(false); // outside
  });

  it('a refinery converts minerals into refined alloys, consuming inputs over time', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const spot = suggestPlacement(c.state, c.world, base, 'refinery')!;
    const r = startConstruction(c, base.id, 'refinery', spot.x, spot.z);
    if (!r.ok) throw new Error(r.reason);
    const b = c.state.buildings[r.building.id];
    b.state = 'active';
    b.hp = BUILDINGS.refinery.maxHp;
    b.recipeMode = 'smelt_alloy';
    base.stock.minerals = 200;
    base.stock.refined = 0;
    // isolate: run only this base's economy for 12 hours
    for (let i = 0; i < 120; i++) stepBaseEconomy(c, base, 0.1);
    expect(base.stock.refined).toBeGreaterThan(10);
    expect(base.stock.minerals).toBeLessThan(200);
    // conservation for the smelt recipe: minerals consumed >= refined produced
    expect(200 - base.stock.minerals).toBeGreaterThanOrEqual(base.stock.refined);
  });

  it('power deficits slow powered production', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const make = (typeId: 'refinery' | 'factory') => {
      const spot = suggestPlacement(c.state, c.world, base, typeId)!;
      const r = startConstruction(c, base.id, typeId, spot.x, spot.z);
      if (!r.ok) throw new Error(r.reason);
      const b = c.state.buildings[r.building.id];
      b.state = 'active';
      b.hp = BUILDINGS[typeId].maxHp;
      return b;
    };
    base.stock.minerals = 300;
    base.stock.refined = 300;
    make('refinery');
    make('factory');
    stepBaseEconomy(c, base, 0.1);
    expect(base.econ.energyDemand).toBeGreaterThan(base.econ.energyProduced);
    const ref = Object.values(c.state.buildings).find((b) => b.baseId === base.id && b.typeId === 'refinery')!;
    expect(ref.efficiency).toBeLessThan(1);
  });

  it('extractors fill a local buffer and convoys deliver it to the base', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const mine = Object.values(c.state.buildings).find((b) => b.baseId === base.id && b.typeId === 'extractor')!;
    expect(mine).toBeTruthy();
    base.stock.minerals = 0;
    advanceCampaign(c, 30);
    expect(base.stock.minerals + stockTotal(mine.storage)).toBeGreaterThan(20);
    expect(base.stock.minerals).toBeGreaterThan(0); // at least one convoy arrived
  });

  it('unit production consumes people and materials and puts the unit in the garrison', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const barracks = Object.values(c.state.buildings).find((b) => b.baseId === base.id && b.typeId === 'barracks')!;
    const pop = base.population;
    const garrison = base.garrison.length;
    const st = statsOf('rifle_squad');
    expect(queueUnit(c.state, barracks.id, 'rifle_squad').ok).toBe(true);
    stepCampaign(c, 0.1);
    expect(base.population).toBeLessThanOrEqual(pop - st.crew + 1);
    advanceCampaign(c, st.buildHours + 2);
    expect(base.garrison.length).toBe(garrison + 1);
  });

  it('there is no infinite manpower: production stalls without people', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const barracks = Object.values(c.state.buildings).find((b) => b.baseId === base.id && b.typeId === 'barracks')!;
    base.population = 3;
    queueUnit(c.state, barracks.id, 'rifle_squad');
    stepCampaign(c, 0.1);
    expect(barracks.queue[0].started).toBe(false);
    expect(barracks.status === 'no_population' || barracks.status === 'no_workers').toBe(true);
  });

  it('storage capacity limits stockpiles', () => {
    const c = freshCampaign();
    const base = c.pBase;
    const cap = storageCapacity(c.state, base.id);
    base.stock.minerals = cap.minerals + 500;
    stepBaseEconomy(c, base, 0.1);
    expect(base.stock.minerals).toBeLessThanOrEqual(cap.minerals);
  });

  it('outposts require a free resource site and build a road', () => {
    const c = freshCampaign();
    const base = c.pBase;
    base.stock.minerals = 500;
    const free = Object.values(c.state.sites)
      .filter((s) => !s.buildingId)
      .sort((a, b) => Math.hypot(a.x - base.x, a.z - base.z) - Math.hypot(b.x - base.x, b.z - base.z))[0];
    const r = startOutpost(c, base.id, free.id);
    expect(r.ok).toBe(true);
    expect(free.buildingId).toBeTruthy();
    expect(Object.values(c.state.roads).some((road) => road.toBuildingId === free.buildingId)).toBe(true);
    expect(startOutpost(c, base.id, free.id).ok).toBe(false);
  });
});
