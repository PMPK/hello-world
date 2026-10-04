import { describe, expect, it } from 'vitest';
import { aiDebugTargets, stepStrategicAI, underThreat } from '../src/ai/strategicAI';
import { createArmy, orderMove } from '../src/campaign/armies';
import { declareHostile } from '../src/campaign/diplomacy';
import { stepIntel } from '../src/campaign/intel';
import { armiesOf } from '../src/campaign/queries';
import { createUnit } from '../src/campaign/units';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** A point `km` from the rival's base, on the line towards the player's base. */
function towardPlayer(c: Camp, km: number): { x: number; z: number } {
  const dx = c.pBase.x - c.eBase.x;
  const dz = c.pBase.z - c.eBase.z;
  const d = Math.hypot(dx, dz);
  return { x: c.eBase.x + (dx / d) * km, z: c.eBase.z + (dz / d) * km };
}

function playerForce(c: Camp, at: { x: number; z: number }) {
  return createArmy(c, c.player, at.x, at.z, [createUnit(c.state, 'recon_jeep'), createUnit(c.state, 'recon_jeep')], c.pBase.id);
}

describe('the rival uses its intel', () => {
  it('targets a force in view, and keeps hunting it for a while after losing sight of it', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    const near = towardPlayer(c, 30);
    const scouts = playerForce(c, near);
    stepIntel(c);
    expect(aiDebugTargets(c.state, c.enemy).some((t) => t.kind === 'army' && t.id === scouts.id)).toBe(true);
    expect(underThreat(c.state, c.eBase)).toBe(true);
    // it slips away: still a target, at the spot where it was last seen
    const far = towardPlayer(c, 90);
    scouts.x = far.x;
    scouts.z = far.z;
    stepIntel(c);
    const lost = c.state.intel[c.enemy].armies[scouts.id];
    expect(lost.inSight).toBe(false);
    const targets = aiDebugTargets(c.state, c.enemy).filter((t) => t.kind === 'army' && t.id === scouts.id);
    expect(targets.length).toBe(1);
    // ...until the trail goes cold
    c.state.time += 7;
    expect(aiDebugTargets(c.state, c.enemy).some((t) => t.kind === 'army' && t.id === scouts.id)).toBe(false);
  });

  it('a force it never saw does not alarm it', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    // just outside what the rival's base and forces can see
    const p = towardPlayer(c, 39);
    for (const a of armiesOf(c.state, c.enemy)) {
      a.x = c.eBase.x;
      a.z = c.eBase.z;
    }
    playerForce(c, p);
    stepIntel(c);
    expect(underThreat(c.state, c.eBase)).toBe(false);
  });

  it('recalls its field forces when a strong contact slipped out of view heading for its base', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    const field = armiesOf(c.state, c.enemy)[0];
    const out = towardPlayer(c, 20);
    field.x = out.x;
    field.z = out.z;
    expect(orderMove(c, field.id, out.x + 5, out.z + 5)).toBe(true);
    // a heavy player force was last seen 40 km out, driving at the base
    const heavy = createArmy(c, c.player, c.pBase.x, c.pBase.z, Array.from({ length: 8 }, () => createUnit(c.state, 'mbt')), c.pBase.id);
    const spot = towardPlayer(c, 40);
    const dx = c.eBase.x - spot.x;
    const dz = c.eBase.z - spot.z;
    const d = Math.hypot(dx, dz);
    c.state.intel[c.enemy].armies[heavy.id] = {
      armyId: heavy.id,
      factionId: c.player,
      name: heavy.name,
      x: spot.x,
      z: spot.z,
      t: c.state.time - 0.5,
      hx: dx / d,
      hz: dz / d,
      units: { mbt: 8 },
      men: 24,
      inSight: false,
    };
    c.state.ai[c.enemy].nextThinkAt = 0;
    stepStrategicAI(c, 0);
    expect(field.order.type).toBe('return');
  });
});
