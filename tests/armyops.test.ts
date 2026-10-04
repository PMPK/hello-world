import { describe, expect, it } from 'vitest';
import { armiesOf } from '../src/campaign/queries';
import { armyMen, mergeArmies, splitArmy } from '../src/campaign/armies';
import { advanceCampaign } from '../src/campaign/sim';
import { queueUnit } from '../src/campaign/production';
import { STATE_VERSION } from '../src/campaign/types';
import { migrateState } from '../src/persistence/migrations';
import { deserializeSave, serializeSave } from '../src/persistence/save';
import { freshCampaign } from './helpers';

describe('task force split and merge', () => {
  it('splits units and rations by head count, then merges them back', () => {
    const c = freshCampaign();
    const army = armiesOf(c.state, c.player)[0];
    const total = army.units.length;
    const men0 = armyMen(army);
    const food0 = army.food;
    const ids = army.units.slice(0, 2).map((u) => u.id);
    const fresh = splitArmy(c, army.id, ids)!;
    expect(fresh).toBeTruthy();
    expect(fresh.units.map((u) => u.id)).toEqual(ids);
    expect(army.units.length).toBe(total - 2);
    expect(armyMen(fresh) + armyMen(army)).toBe(men0);
    expect(fresh.food + army.food).toBeCloseTo(food0, 6);
    expect(fresh.commanderId).not.toBe(army.commanderId);
    // cannot split everything or nothing
    expect(splitArmy(c, army.id, army.units.map((u) => u.id))).toBeNull();
    expect(splitArmy(c, army.id, [])).toBeNull();
    // merge back
    expect(mergeArmies(c, army.id, fresh.id)).toBe(true);
    expect(c.state.armies[fresh.id]).toBeUndefined();
    expect(army.units.length).toBe(total);
    const staff = c.state.characters[fresh.commanderId!];
    expect(staff.alive).toBe(true);
    expect(staff.location).toEqual({ kind: 'army', id: army.id });
  });

  it('refuses to merge forces that are far apart', () => {
    const c = freshCampaign();
    const army = armiesOf(c.state, c.player)[0];
    const fresh = splitArmy(c, army.id, [army.units[0].id])!;
    fresh.x += 10;
    expect(mergeArmies(c, army.id, fresh.id)).toBe(false);
  });
});

describe('continuous production', () => {
  it('re-queues the repeated design when an order completes', () => {
    const c = freshCampaign();
    const barracks = Object.values(c.state.buildings).find((b) => b.baseId === c.pBase.id && b.typeId === 'barracks')!;
    c.pBase.stock.refined = 500;
    c.pBase.stock.components = 500;
    c.pBase.stock.ammo = 300;
    c.pBase.population += 40;
    barracks.repeat = 'rifle_squad';
    expect(queueUnit(c.state, barracks.id, 'rifle_squad').ok).toBe(true);
    const g0 = c.pBase.garrison.length;
    advanceCampaign(c, 40);
    expect(c.pBase.garrison.length).toBeGreaterThanOrEqual(g0 + 2);
    expect(barracks.queue.length).toBe(1); // the next one is already lined up
    barracks.repeat = null;
  });
});

describe('save migration v1 → v2', () => {
  it('adds the repeat field to every building of an old save', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 1;
    for (const b of Object.values(raw.buildings) as Record<string, unknown>[]) delete b.repeat;
    const migrated = migrateState(raw);
    expect(migrated.version).toBe(STATE_VERSION);
    for (const b of Object.values(migrated.buildings)) expect(b.repeat).toBeNull();
    // and a full save envelope from v1 loads
    const env = JSON.parse(serializeSave(c.state, 'manual'));
    env.state = raw;
    const loaded = deserializeSave(JSON.stringify(env));
    expect(loaded.state.version).toBe(STATE_VERSION);
  });
});
