import { describe, expect, it } from 'vitest';
import { stepStrategicAI } from '../src/ai/strategicAI';
import { createCampaign } from '../src/campaign/newCampaign';
import { declareHostile } from '../src/campaign/diplomacy';
import { armiesOf, basesOf } from '../src/campaign/queries';
import { advanceCampaign } from '../src/campaign/sim';
import { STATE_VERSION, type Army, type Convoy } from '../src/campaign/types';
import { dist } from '../src/core/math';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

const patrolOf = (c: Camp): Army | undefined => armiesOf(c.state, c.enemy).find((a) => a.aiRole === 'patrol');

/** Advance until the rival has a patrol out (it needs its jeeps home and fuelled first). */
function untilPatrol(c: Camp, maxHours = 24 * 6): Army {
  for (let h = 0; h < maxHours && !patrolOf(c); h += 2) advanceCampaign(c, 2);
  const p = patrolOf(c);
  expect(p).toBeTruthy();
  return p!;
}

describe('AI recon patrols', () => {
  it('a pair of jeeps sets out after a few days and keeps clear of our bases during the standoff', () => {
    const c = freshCampaign();
    const p = untilPatrol(c);
    expect(c.state.time).toBeGreaterThan(24 * 3);
    expect(p.units.every((u) => u.designId === 'recon_jeep')).toBe(true);
    // follow it for a day: every destination respects the standoff clearance
    for (let h = 0; h < 24; h++) {
      advanceCampaign(c, 1);
      const cur = patrolOf(c);
      if (!cur || cur.order.type !== 'move') continue;
      for (const b of basesOf(c.state, c.player)) expect(dist(cur.order.x, cur.order.z, b.x, b.z)).toBeGreaterThan(30);
    }
  });

  it('at war it cuts across the route of a supply convoy it can see', () => {
    const c = freshCampaign();
    const p = untilPatrol(c);
    declareHostile(c, c.player, c.enemy);
    const convoy: Convoy = {
      id: 'c-test',
      factionId: c.player,
      fromBuildingId: `manual:${c.pBase.id}`,
      toBaseId: c.pBase.id,
      cargo: { food: 30 },
      people: 0,
      toArmyId: null,
      path: [{ x: c.pBase.x, z: c.pBase.z }],
      x: p.x + 12,
      z: p.z,
    };
    c.state.convoys[convoy.id] = convoy;
    const ai = c.state.ai[c.enemy];
    ai.nextThinkAt = 0;
    stepStrategicAI(c, 0);
    expect(p.order.type).toBe('move');
    if (p.order.type !== 'move') return;
    const aim = dist(p.order.x, p.order.z, convoy.x, convoy.z) < 1 || dist(p.order.x, p.order.z, c.pBase.x, c.pBase.z) < 1;
    expect(aim).toBe(true);
  });

  it('turns back while the fuel still covers the way home', () => {
    const c = freshCampaign();
    const p = untilPatrol(c);
    const home = basesOf(c.state, c.enemy)[0];
    // somewhere passable 60 km out
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const x = home.x + Math.cos(a) * 60;
      const z = home.z + Math.sin(a) * 60;
      if (!c.world.isPassable(x, z) || !c.world.findArmyPath({ x, z }, { x: home.x, z: home.z })) continue;
      p.x = x;
      p.z = z;
      break;
    }
    p.path = [];
    p.order = { type: 'idle' };
    for (const u of p.units) u.fuel = 4; // a few dozen km left: not enough for 60 km plus a margin
    c.state.ai[c.enemy].nextThinkAt = 0;
    stepStrategicAI(c, 0);
    expect(p.order.type).toBe('return');
  });

  it('difficulty changes the rival’s starting force', () => {
    const count = (d: 'easy' | 'hard'): { units: number; tanks: number } => {
      const { state } = createCampaign(321, d);
      const enemy = Object.keys(state.factions).find((f) => f !== state.playerFactionId)!;
      const units = armiesOf(state, enemy).flatMap((a) => a.units);
      return { units: units.length, tanks: units.filter((u) => u.designId === 'mbt').length };
    };
    const easy = count('easy');
    const hard = count('hard');
    expect(easy.tanks).toBe(0);
    expect(hard.tanks).toBe(2);
    expect(hard.units).toBe(easy.units + 3);
  });

  it('old saves gain the patrol clock (v6 → v7)', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 6;
    for (const a of Object.values(raw.ai) as Record<string, unknown>[]) delete a.lastPatrolAt;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    for (const a of Object.values(m.ai)) expect(a.lastPatrolAt).toBe(-999);
  });
});
