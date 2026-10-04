import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { createCampaign } from '../src/campaign/newCampaign';
import { makeContext } from '../src/campaign/context';
import { declareHostile } from '../src/campaign/diplomacy';
import { advanceCampaign } from '../src/campaign/sim';
import { createUnit } from '../src/campaign/units';
import { aiDebugTargets } from '../src/ai/strategicAI';
import { basesOf } from '../src/campaign/queries';
import { STATE_VERSION } from '../src/campaign/types';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

describe('difficulty', () => {
  it('is stored in the campaign and old saves default to Normal', () => {
    const { state } = createCampaign(77, 'hard');
    expect(state.difficulty).toBe('hard');
    const raw = JSON.parse(JSON.stringify(state));
    raw.version = 2;
    delete raw.difficulty;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    expect(m.difficulty).toBe('normal');
  });

  it('a Hard rival out-produces an Easy one on the same map', () => {
    const run = (d: 'easy' | 'hard'): number => {
      const { state, world } = createCampaign(321, d);
      const ctx = makeContext(state, world);
      advanceCampaign(ctx, 24 * 4);
      const ai = Object.keys(state.ai)[0];
      const base = basesOf(state, ai)[0];
      return base.stock.minerals + base.stock.refined + base.stock.components;
    };
    expect(run('hard')).toBeGreaterThan(run('easy'));
  });
});

describe('strategic fog of war for the AI', () => {
  it('only targets player forces it can see', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    // a player force far from every AI asset, and one right next to the AI base
    const far = createArmy(c, c.player, c.pBase.x, c.pBase.z - 20, [createUnit(c.state, 'rifle_squad')], c.pBase.id);
    const near = createArmy(c, c.player, c.eBase.x + 12, c.eBase.z, [createUnit(c.state, 'rifle_squad')], c.pBase.id);
    const ids = aiDebugTargets(c.state, c.enemy).filter((t) => t.kind === 'army').map((t) => t.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });
});
