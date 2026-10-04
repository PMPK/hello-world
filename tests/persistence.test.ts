import { describe, expect, it } from 'vitest';
import { advanceCampaign } from '../src/campaign/sim';
import { worldForState } from '../src/campaign/newCampaign';
import { makeContext } from '../src/campaign/context';
import { MemoryStore } from '../src/persistence/kvstore';
import { deserializeSave, exportFileName, SaveManager, serializeSave, slotLabel } from '../src/persistence/save';
import { migrateState } from '../src/persistence/migrations';
import { STATE_VERSION } from '../src/campaign/types';
import { freshCampaign } from './helpers';

describe('persistence', () => {
  it('round-trips the full campaign state through JSON', () => {
    const c = freshCampaign();
    advanceCampaign(c, 50);
    const json = serializeSave(c.state, 'manual');
    const save = deserializeSave(json);
    expect(save.formatVersion).toBe(1);
    expect(save.state.version).toBe(STATE_VERSION);
    expect(JSON.stringify(save.state)).toBe(JSON.stringify(c.state));
    expect(save.summary.day).toBeGreaterThanOrEqual(3);
  });

  it('a loaded campaign continues identically (world rebuilt from seed + saved data)', () => {
    const a = freshCampaign(555);
    advanceCampaign(a, 40);
    const loaded = deserializeSave(serializeSave(a.state, 'autosave')).state;
    const b = makeContext(loaded, worldForState(loaded));
    // terrain identical
    expect(Array.from(b.world.terrain.heights.slice(0, 2000))).toEqual(Array.from(a.world.terrain.heights.slice(0, 2000)));
    advanceCampaign(a, 60);
    advanceCampaign(b, 60);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  it('saves units, damage, queues and AI state', () => {
    const c = freshCampaign();
    const army = Object.values(c.state.armies)[0];
    army.units[0].hp = 17;
    army.units[0].ammo = 3;
    const b = Object.values(c.state.buildings)[0];
    b.hp = 123;
    const s = deserializeSave(serializeSave(c.state, 'manual')).state;
    expect(s.armies[army.id].units[0].hp).toBe(17);
    expect(s.armies[army.id].units[0].ammo).toBe(3);
    expect(s.buildings[b.id].hp).toBe(123);
    expect(Object.keys(s.ai).length).toBe(1);
    expect(s.seed).toBe(c.state.seed);
  });

  it('rejects corrupted or foreign data with a clear error', () => {
    expect(() => deserializeSave('not json')).toThrow(/corrupted/);
    expect(() => deserializeSave(JSON.stringify({ format: 'other' }))).toThrow(/Not a Planet X/);
    expect(() => deserializeSave(JSON.stringify({ format: 'planet-x-save', formatVersion: 99, state: {} }))).toThrow(/newer/);
  });

  it('migrates version-less states and refuses states from the future', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    delete raw.version;
    // version-less states are treated as v1 and migrated forward to the current schema
    expect(migrateState(raw).version).toBe(STATE_VERSION);
    expect(() => migrateState({ ...raw, version: STATE_VERSION + 1 })).toThrow(/newer/);
  });

  it('SaveManager stores slots and finds the latest', async () => {
    const c = freshCampaign();
    const m = new SaveManager(new MemoryStore());
    expect(await m.latest()).toBeNull();
    await m.save(c.state, 'autosave');
    await new Promise((r) => setTimeout(r, 5));
    advanceCampaign(c, 5);
    await m.save(c.state, 'manual');
    const latest = await m.latest();
    expect(latest?.slot).toBe('manual');
    const loaded = await m.load('autosave');
    expect(loaded?.state.time).toBeLessThan(c.state.time);
    await m.clear();
    expect(await m.list()).toEqual([]);
  });

  it('keeps several manual slots and deletes one without touching the others', async () => {
    const c = freshCampaign();
    const m = new SaveManager(new MemoryStore());
    await m.save(c.state, 'manual');
    advanceCampaign(c, 3);
    await m.save(c.state, 'slot2');
    advanceCampaign(c, 3);
    await m.save(c.state, 'slot3');
    expect((await m.list()).map((s) => s.slot).sort()).toEqual(['manual', 'slot2', 'slot3']);
    await m.delete('slot2');
    expect((await m.list()).map((s) => s.slot).sort()).toEqual(['manual', 'slot3']);
    expect(slotLabel('manual')).toBe('Slot 1');
    expect(slotLabel('autosave')).toBe('Autosave');
  });

  it('exports a portable save file and imports it into the autosave slot', async () => {
    const c = freshCampaign();
    advanceCampaign(c, 30);
    const a = new SaveManager(new MemoryStore());
    const json = a.exportJson(c.state);
    expect(exportFileName(c.state, new Date(2026, 0, 4, 18, 30))).toBe('planet-x-day2-20260104-1830.json');
    // another device / browser
    const b = new SaveManager(new MemoryStore());
    const imported = await b.importJson(`  ${json}\n`);
    expect(JSON.stringify(imported.state)).toBe(JSON.stringify(c.state));
    const latest = await b.latest();
    expect(latest?.slot).toBe('autosave');
    await expect(b.importJson('{"format":"something-else"}')).rejects.toThrow(/Not a Planet X/);
  });
});
