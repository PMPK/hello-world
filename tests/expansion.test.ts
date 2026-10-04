import { describe, expect, it } from 'vitest';
import { orderReturn, stepArmies } from '../src/campaign/armies';
import { cancelConstruction, cancelRefund, canCancel, rebuildBuilding, startConstruction, suggestPlacement } from '../src/campaign/construction';
import { declareHostile } from '../src/campaign/diplomacy';
import { canFoundFrom, FOUND_COLONISTS, foundBase, HQ_PREFAB_PROGRESS, MIN_BASE_SPACING, validateBaseSite } from '../src/campaign/expansion';
import { captureBase } from '../src/battle/result';
import { BUILDINGS } from '../src/data/buildings';
import { worldForState } from '../src/campaign/newCampaign';
import { armiesOf, basesOf, buildingsOfBase } from '../src/campaign/queries';
import { advanceCampaign } from '../src/campaign/sim';
import { housingOf, storageCapacity } from '../src/economy/economy';
import { deserializeSave, serializeSave } from '../src/persistence/save';
import { heightAt } from '../src/world/terrain';
import { freshCampaign } from './helpers';

function richCampaign(): ReturnType<typeof freshCampaign> {
  const c = freshCampaign();
  Object.assign(c.pBase.stock, { minerals: 600, refined: 400, components: 200, food: 300, fuel: 200, ammo: 120 });
  c.pBase.population = 60;
  return c;
}

function findSite(c: ReturnType<typeof freshCampaign>): { x: number; z: number } {
  for (let r = MIN_BASE_SPACING + 4; r < 150; r += 6) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = c.pBase.x + Math.cos(a) * r;
      const z = c.pBase.z + Math.sin(a) * r;
      if (validateBaseSite(c.state, c.world, c.pBase, x, z).ok) return { x, z };
    }
  }
  throw new Error('no site');
}

describe('founding new bases', () => {
  it('rejects sites too close to an existing base and requires colonists and materials', () => {
    const c = freshCampaign();
    const near = validateBaseSite(c.state, c.world, c.pBase, c.pBase.x + 10, c.pBase.z);
    expect(near.ok).toBe(false);
    c.pBase.population = 10;
    expect(canFoundFrom(c.state, c.pBase).ok).toBe(false);
  });

  it('creates a base with colonists, supplies, a prefab HQ under construction and a road home', () => {
    const c = richCampaign();
    const site = findSite(c);
    const pop0 = c.pBase.population;
    const min0 = c.pBase.stock.minerals;
    const roads0 = Object.keys(c.state.roads).length;
    const r = foundBase(c, c.pBase.id, site.x, site.z);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.base;
    expect(basesOf(c.state, c.player).length).toBe(2);
    expect(b.population).toBe(FOUND_COLONISTS);
    expect(c.pBase.population).toBe(pop0 - FOUND_COLONISTS);
    expect(c.pBase.stock.minerals).toBeLessThan(min0);
    expect(b.stock.food).toBeGreaterThan(0);
    const hq = buildingsOfBase(c.state, b.id).find((x) => x.typeId === 'hq')!;
    expect(hq.state).toBe('construction');
    expect(hq.buildProgress).toBeCloseTo(HQ_PREFAB_PROGRESS, 5);
    expect(Object.keys(c.state.roads).length).toBe(roads0 + 1);
    // terrain flattened under the new perimeter
    const hs = [0, 2, 4, 6].map((d) => heightAt(c.world.terrain, site.x + d, site.z));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(0.6);
    // colonists live in a field camp until the HQ is up, and its stores hold the starter supplies
    expect(housingOf(c.state, b.id)).toBeGreaterThanOrEqual(FOUND_COLONISTS);
    const cap = storageCapacity(c.state, b.id);
    expect(cap.minerals).toBeGreaterThanOrEqual(b.stock.minerals);
    expect(cap.food).toBeGreaterThanOrEqual(b.stock.food);
  });

  it('the HQ is completed over time and the new base runs its own economy', () => {
    const c = richCampaign();
    const site = findSite(c);
    const r = foundBase(c, c.pBase.id, site.x, site.z);
    if (!r.ok) throw new Error(r.reason);
    advanceCampaign(c, 24 * 5);
    const hq = buildingsOfBase(c.state, r.base.id).find((x) => x.typeId === 'hq')!;
    expect(hq.state).toBe('active');
    expect(r.base.econ.housing).toBeGreaterThan(0);
  });

  it('the founding base ships supplies to the young base by convoy', () => {
    const c = richCampaign();
    const site = findSite(c);
    const r = foundBase(c, c.pBase.id, site.x, site.z);
    if (!r.ok) throw new Error(r.reason);
    r.base.stock.minerals = 0;
    advanceCampaign(c, 0.5);
    const inbound = Object.values(c.state.convoys).filter((cv) => cv.toBaseId === r.base.id);
    expect(inbound.length).toBe(1);
    expect(inbound[0].cargo.minerals ?? 0).toBeGreaterThan(0);
    advanceCampaign(c, 24);
    expect(r.base.stock.minerals).toBeGreaterThan(0);
  });

  it('a saved campaign with a founded base reloads the same terrain', () => {
    const c = richCampaign();
    const site = findSite(c);
    expect(foundBase(c, c.pBase.id, site.x, site.z).ok).toBe(true);
    const loaded = deserializeSave(serializeSave(c.state, 'manual')).state;
    const w = worldForState(loaded);
    expect(Array.from(w.terrain.heights)).toEqual(Array.from(c.world.terrain.heights));
    expect(Array.from(w.terrain.biomes)).toEqual(Array.from(c.world.terrain.biomes));
  });

  it('the prefab command post of a new base cannot be cancelled for a refund', () => {
    const c = richCampaign();
    const site = findSite(c);
    const r = foundBase(c, c.pBase.id, site.x, site.z);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hq = buildingsOfBase(c.state, r.base.id).find((x) => x.typeId === 'hq')!;
    const stock0 = { ...r.base.stock };
    expect(canCancel(hq)).toBe(false);
    expect(cancelConstruction(c, hq.id)).toBe(false);
    expect(c.state.buildings[hq.id]).toBeDefined();
    expect(r.base.stock).toEqual(stock0);
  });

  it('a force heading home to a base that fell makes for another base instead of assaulting it', () => {
    const c = richCampaign();
    const site = findSite(c);
    const r = foundBase(c, c.pBase.id, site.x, site.z);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const army = armiesOf(c.state, c.player)[0];
    army.homeBaseId = r.base.id;
    expect(orderReturn(c, army.id)).toBe(true);
    expect(army.order).toEqual({ type: 'return', baseId: r.base.id });
    declareHostile(c, c.enemy, c.player);
    captureBase(c, r.base, c.enemy);
    stepArmies(c, 0.1);
    expect(army.order).toEqual({ type: 'return', baseId: c.pBase.id });
    expect(army.homeBaseId).toBe(c.pBase.id);
    expect(c.state.log.some((l) => l.text.startsWith(`${army.name}: ${r.base.name} has fallen`))).toBe(true);
  });
});

describe('construction refunds', () => {
  it('cancelling returns 75% of the materials not yet built in, never more than a rebuild cost', () => {
    const c = richCampaign();
    const def = BUILDINGS.barracks;
    const spot = suggestPlacement(c.state, c.world, c.pBase, 'barracks', c.pBase.x + 6, c.pBase.z + 6)!;
    const started = startConstruction(c, c.pBase.id, 'barracks', spot.x, spot.z);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const b = started.building;
    expect(cancelRefund(b)).toBeCloseTo(0.75, 6);
    b.buildProgress = 0.4;
    const min0 = c.pBase.stock.minerals;
    expect(cancelConstruction(c, b.id)).toBe(true);
    expect(c.pBase.stock.minerals - min0).toBeCloseTo((def.cost.minerals ?? 0) * 0.75 * 0.6, 6);

    // a ruin rebuilt at a discount and cancelled at once must not make a profit
    const ruin = Object.values(c.state.buildings).find((x) => x.baseId === c.pBase.id && x.typeId === 'barracks')!;
    ruin.state = 'destroyed';
    ruin.hp = 0;
    const before = { ...c.pBase.stock };
    expect(rebuildBuilding(c, ruin.id).ok).toBe(true);
    expect(cancelConstruction(c, ruin.id)).toBe(true);
    for (const k of ['minerals', 'refined', 'components'] as const) expect(c.pBase.stock[k]).toBeLessThanOrEqual(before[k] + 1e-9);
  });
});

