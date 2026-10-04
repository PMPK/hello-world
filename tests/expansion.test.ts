import { describe, expect, it } from 'vitest';
import { canFoundFrom, FOUND_COLONISTS, foundBase, HQ_PREFAB_PROGRESS, MIN_BASE_SPACING, validateBaseSite } from '../src/campaign/expansion';
import { worldForState } from '../src/campaign/newCampaign';
import { basesOf, buildingsOfBase } from '../src/campaign/queries';
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
});
