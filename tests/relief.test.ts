import { describe, expect, it } from 'vitest';
import { dist } from '../src/core/math';
import { captureBase } from '../src/battle/result';
import { declareHostile } from '../src/campaign/diplomacy';
import { worldForState } from '../src/campaign/newCampaign';
import { basesOf } from '../src/campaign/queries';
import { MAX_RELIEF_LANDINGS, RELIEF_COLONISTS, RELIEF_DELAY } from '../src/campaign/relief';
import { advanceCampaign } from '../src/campaign/sim';
import { STATE_VERSION } from '../src/campaign/types';
import { migrateState } from '../src/persistence/migrations';
import { heightAt } from '../src/world/terrain';
import { freshCampaign } from './helpers';

/** The enemy takes every base of the player. */
function loseAllBases(c: ReturnType<typeof freshCampaign>): void {
  for (const b of basesOf(c.state, c.player)) captureBase(c, b, c.enemy);
}

describe('relief landings', () => {
  it('land a new base a few days after an expedition loses its last one', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    loseAllBases(c);
    advanceCampaign(c, 1);
    const f = c.state.factions[c.player];
    expect(f.baselessSince).not.toBeNull();
    expect(c.state.log.some((l) => l.text.includes('relief landing is being prepared'))).toBe(true);
    advanceCampaign(c, RELIEF_DELAY - 2);
    expect(basesOf(c.state, c.player).length).toBe(0);
    advanceCampaign(c, 3);
    const bases = basesOf(c.state, c.player);
    expect(bases.length).toBe(1);
    const base = bases[0];
    expect(f.reliefLandings).toBe(1);
    expect(f.baselessSince).toBeNull();
    expect(base.population).toBeGreaterThanOrEqual(RELIEF_COLONISTS - 1);
    expect(base.garrison.length).toBe(2);
    const types = Object.values(c.state.buildings).filter((b) => b.baseId === base.id && b.state === 'active').map((b) => b.typeId);
    expect(types).toEqual(expect.arrayContaining(['hq', 'habitat', 'farm']));
    for (const b of basesOf(c.state, c.enemy)) expect(dist(b.x, b.z, base.x, base.z)).toBeGreaterThanOrEqual(90);
    // the runtime terrain edit is reproduced when the world is rebuilt from a save
    const rebuilt = worldForState(c.state);
    expect(heightAt(rebuilt.terrain, base.x, base.z)).toBeCloseTo(heightAt(c.world.terrain, base.x, base.z), 6);
  });

  it(`stops after ${MAX_RELIEF_LANDINGS} landings`, () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    for (let k = 0; k < MAX_RELIEF_LANDINGS; k++) {
      loseAllBases(c);
      advanceCampaign(c, RELIEF_DELAY + 2);
      expect(basesOf(c.state, c.player).length).toBe(1);
    }
    loseAllBases(c);
    advanceCampaign(c, RELIEF_DELAY * 2);
    expect(basesOf(c.state, c.player).length).toBe(0);
    expect(c.state.log.some((l) => l.text.includes('No more relief landings'))).toBe(true);
  });

  it('old saves gain the relief fields (v4 → v5)', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 4;
    for (const f of Object.values(raw.factions) as Record<string, unknown>[]) {
      delete f.baselessSince;
      delete f.reliefLandings;
    }
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    for (const f of Object.values(m.factions)) {
      expect(f.baselessSince).toBeNull();
      expect(f.reliefLandings).toBe(0);
    }
  });
});
