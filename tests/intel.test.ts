import { describe, expect, it } from 'vitest';
import { createArmy } from '../src/campaign/armies';
import { declareHostile } from '../src/campaign/diplomacy';
import { CLOSE_LOOK, compassPoint, REALERT_GAP, SIGHTING_TTL, stepIntel, structureCount } from '../src/campaign/intel';
import { armiesOf, PLAYER_VISION_RADIUS } from '../src/campaign/queries';
import { advanceCampaign } from '../src/campaign/sim';
import { STATE_VERSION, type Army } from '../src/campaign/types';
import { createUnit } from '../src/campaign/units';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

type Camp = ReturnType<typeof freshCampaign>;

/** A point `km` from the player's base, on the line towards the rival base. */
function towardRival(c: Camp, km: number): { x: number; z: number } {
  const dx = c.eBase.x - c.pBase.x;
  const dz = c.eBase.z - c.pBase.z;
  const d = Math.hypot(dx, dz);
  return { x: c.pBase.x + (dx / d) * km, z: c.pBase.z + (dz / d) * km };
}

/** The rival's first task force, parked at a point. */
function rivalAt(c: Camp, p: { x: number; z: number }): Army {
  const a = armiesOf(c.state, c.enemy)[0];
  a.x = p.x;
  a.z = p.z;
  a.path = [];
  a.order = { type: 'idle' };
  return a;
}

const contacts = (c: Camp): string[] => c.state.log.filter((l) => l.factionId === c.player && l.text.startsWith('Contact:')).map((l) => l.text);

describe('strategic intelligence', () => {
  it('reports a rival force once when it comes into view and keeps its last known position', () => {
    const c = freshCampaign();
    const near = towardRival(c, 20);
    const far = towardRival(c, 110);
    const a = rivalAt(c, far);
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id]).toBeUndefined();

    a.x = near.x;
    a.z = near.z;
    stepIntel(c);
    const seen = c.state.intel[c.player].armies[a.id];
    expect(seen.inSight).toBe(true);
    expect(contacts(c).length).toBe(1);
    const entry = c.state.log[c.state.log.length - 1];
    expect(entry.ref).toEqual({ kind: 'army', id: a.id });
    expect(entry.at?.x).toBeCloseTo(near.x, 5);
    stepIntel(c);
    expect(contacts(c).length).toBe(1);

    // it drives off: the record stays where it was last seen, with its bearing
    a.x = near.x + 2;
    stepIntel(c);
    a.x = far.x;
    a.z = far.z;
    stepIntel(c);
    const ghost = c.state.intel[c.player].armies[a.id];
    expect(ghost.inSight).toBe(false);
    expect(ghost.x).toBeCloseTo(near.x + 2, 5);
    expect(compassPoint(ghost.hx, ghost.hz)).toBe('east');

    // back within the re-alert gap: no new report; after a longer absence: reported again
    c.state.time += REALERT_GAP / 2;
    a.x = near.x;
    a.z = near.z;
    stepIntel(c);
    expect(contacts(c).length).toBe(1);
    a.x = far.x;
    a.z = far.z;
    stepIntel(c);
    c.state.time += REALERT_GAP + 1;
    a.x = near.x;
    a.z = near.z;
    stepIntel(c);
    expect(contacts(c).length).toBe(2);
  });

  it('clears a last known position after a close look, and lets old ones expire', () => {
    const c = freshCampaign();
    // only the base and task forces watch here (an outpost would take its own close look)
    for (const b of Object.values(c.state.buildings)) if (b.factionId === c.player && b.typeId === 'extractor') delete c.state.buildings[b.id];
    const near = towardRival(c, 30);
    const a = rivalAt(c, near);
    stepIntel(c);
    a.x = c.eBase.x;
    a.z = c.eBase.z;
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id].inSight).toBe(false);

    // a scout passing at the edge of sight does not clear it; one close by does
    const edge = towardRival(c, 30 + PLAYER_VISION_RADIUS * 0.8);
    const scout = createArmy(c, c.player, edge.x, edge.z, [createUnit(c.state, 'recon_jeep')], c.pBase.id);
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id]).toBeDefined();
    const close = towardRival(c, 30 + PLAYER_VISION_RADIUS * CLOSE_LOOK * 0.8);
    scout.x = close.x;
    scout.z = close.z;
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id]).toBeUndefined();

    // another sighting simply runs out
    delete c.state.armies[scout.id];
    a.x = near.x;
    a.z = near.z;
    stepIntel(c);
    a.x = c.eBase.x;
    a.z = c.eBase.z;
    stepIntel(c);
    c.state.time += SIGHTING_TTL + 1;
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id]).toBeUndefined();
  });

  it('forgets a force that disappears while observed', () => {
    const c = freshCampaign();
    const a = rivalAt(c, towardRival(c, 20));
    stepIntel(c);
    delete c.state.armies[a.id];
    stepIntel(c);
    expect(c.state.intel[c.player].armies[a.id]).toBeUndefined();
  });

  it('files a dated report on a rival base and only updates it in view', () => {
    const c = freshCampaign();
    const scout = createArmy(c, c.player, c.eBase.x - 20, c.eBase.z, [createUnit(c.state, 'recon_jeep')], c.pBase.id);
    stepIntel(c);
    const r = c.state.intel[c.player].bases[c.eBase.id];
    expect(r).toBeDefined();
    const finished = Object.values(c.state.buildings).filter((b) => b.baseId === c.eBase.id && b.state === 'active').length;
    expect(structureCount(r)).toBe(finished);
    expect(c.state.log.some((l) => l.text.startsWith(`Intelligence: first look at ${c.eBase.name}`) && l.ref?.id === c.eBase.id)).toBe(true);

    // out of view, the garrison grows: the report does not change
    scout.x = c.pBase.x;
    scout.z = c.pBase.z;
    c.eBase.garrison.push(createUnit(c.state, 'mbt'));
    c.state.time += 2;
    stepIntel(c);
    const old = c.state.intel[c.player].bases[c.eBase.id];
    expect(old.garrison.mbt ?? 0).toBe(r.garrison.mbt ?? 0);

    // back in view: refreshed
    scout.x = c.eBase.x - 20;
    scout.z = c.eBase.z;
    stepIntel(c);
    const now = c.state.intel[c.player].bases[c.eBase.id];
    expect(now.garrison.mbt ?? 0).toBe((r.garrison.mbt ?? 0) + 1);
    expect(now.t).toBe(c.state.time);
  });

  it('warns about forces once at war, and the full sim keeps the records consistent', () => {
    const c = freshCampaign();
    declareHostile(c, c.player, c.enemy);
    const a = rivalAt(c, towardRival(c, 20));
    stepIntel(c);
    const entry = c.state.log.filter((l) => l.text.startsWith('Contact:')).pop();
    expect(entry?.kind).toBe('warn');
    // a couple of days of normal play: every record points at a real rival force or base
    advanceCampaign(c, 48);
    for (const s of Object.values(c.state.intel[c.player].armies)) {
      expect(s.factionId).not.toBe(c.player);
      if (s.inSight) expect(c.state.armies[s.armyId]).toBeDefined();
    }
    for (const id of Object.keys(c.state.intel[c.player].bases)) expect(c.state.bases[id].factionId).not.toBe(c.player);
    void a;
  });

  it('old saves gain empty intel (v8 → v9)', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 8;
    delete raw.intel;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    expect(Object.keys(m.intel).sort()).toEqual(Object.keys(m.factions).sort());
    for (const i of Object.values(m.intel)) expect(i).toEqual({ armies: {}, bases: {} });
  });
});
