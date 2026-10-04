import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { KEEP_AT_HOME, MANUAL_CONVOY_CAPACITY, MANUAL_CONVOY_SEATS, sendConvoy, stepConvoys } from '../src/campaign/convoys';
import { declareHostile } from '../src/campaign/diplomacy';
import { foundBase, MIN_BASE_SPACING, validateBaseSite } from '../src/campaign/expansion';
import { STATE_VERSION, type Base } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** A campaign where the player has founded a second base (returned). */
function twoBases(): { c: Camp; home: Base; colony: Base } {
  const c = freshCampaign();
  Object.assign(c.pBase.stock, { minerals: 600, refined: 400, components: 200, food: 300, fuel: 200, ammo: 120 });
  c.pBase.population = 70;
  for (let r = MIN_BASE_SPACING + 4; r < 150; r += 6) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const x = c.pBase.x + Math.cos(a) * r;
      const z = c.pBase.z + Math.sin(a) * r;
      if (!validateBaseSite(c.state, c.world, c.pBase, x, z).ok) continue;
      const res = foundBase(c, c.pBase.id, x, z);
      if (res.ok) return { c, home: c.pBase, colony: res.base };
    }
  }
  throw new Error('no site');
}

/** Run only the convoy step (no economy) so stock changes come from the convoy alone. */
function runConvoys(c: Camp, hours: number): void {
  for (let t = 0; t < hours; t += 0.1) stepConvoys(c, 0.1);
}

describe('hand-sent convoys', () => {
  it('carry supplies and colonists to another base', () => {
    const { c, home, colony } = twoBases();
    // keep the automatic supply runs out of the picture
    for (const id of Object.keys(c.state.roads)) delete c.state.roads[id];
    const ore0 = home.stock.minerals;
    const pop0 = home.population;
    const colonyOre = colony.stock.minerals;
    const colonyPop = colony.population;
    const r = sendConvoy(c, home.id, colony.id, { minerals: 50, food: 20 }, 6);
    expect(r.ok).toBe(true);
    expect(home.stock.minerals).toBe(ore0 - 50);
    expect(home.population).toBe(pop0 - 6);
    runConvoys(c, 30);
    expect(Object.keys(c.state.convoys).length).toBe(0);
    expect(colony.stock.minerals).toBeCloseTo(colonyOre + 50, 5);
    expect(colony.population).toBe(colonyPop + 6);
    expect(c.state.log.some((l) => l.text.startsWith(`Convoy arrived at ${colony.name} with 6 colonists`))).toBe(true);
  });

  it('refuses overloaded convoys and stripping a base of its people', () => {
    const { c, home, colony } = twoBases();
    expect(sendConvoy(c, home.id, colony.id, { minerals: MANUAL_CONVOY_CAPACITY + 10 }, 0).ok).toBe(false);
    expect(sendConvoy(c, home.id, colony.id, {}, MANUAL_CONVOY_SEATS + 2).ok).toBe(false);
    home.population = KEEP_AT_HOME + 2;
    const r = sendConvoy(c, home.id, colony.id, {}, 4);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(`keep ${KEEP_AT_HOME}`);
    expect(sendConvoy(c, home.id, home.id, { food: 10 }, 0).ok).toBe(false);
    expect(sendConvoy(c, home.id, colony.id, {}, 0).ok).toBe(false);
  });

  it('can be intercepted, losing cargo and colonists', () => {
    const { c, home, colony } = twoBases();
    for (const id of Object.keys(c.state.roads)) delete c.state.roads[id];
    declareHostile(c, c.player, c.enemy);
    const r = sendConvoy(c, home.id, colony.id, { food: 30 }, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // an enemy patrol waits on the route a little way out
    const wp = r.convoy.path[Math.min(2, r.convoy.path.length - 1)];
    createArmy(c, c.enemy, wp.x, wp.z, [createUnit(c.state, 'recon_jeep')], null);
    const pop = colony.population;
    runConvoys(c, 30);
    expect(Object.keys(c.state.convoys).length).toBe(0);
    expect(colony.population).toBe(pop);
    expect(c.state.log.some((l) => l.text.includes('4 colonists were lost'))).toBe(true);
  });

  it('old saves gain empty seats on convoys in flight (v5 → v6)', () => {
    const { c, home, colony } = twoBases();
    sendConvoy(c, home.id, colony.id, { food: 10 }, 0);
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 5;
    for (const cv of Object.values(raw.convoys) as Record<string, unknown>[]) delete cv.people;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    for (const cv of Object.values(m.convoys)) expect(cv.people).toBe(0);
  });
});
