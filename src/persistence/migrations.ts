import { STATE_VERSION, type CampaignState } from '../campaign/types';

/**
 * Save-state migrations. Each entry upgrades a state object from version N
 * to N+1. When CampaignState changes shape: bump STATE_VERSION in
 * campaign/types.ts and add a migration here — never break old saves.
 */
type Migration = (s: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Record<number, Migration> = {
  // v2: production buildings can repeat a unit order
  1: (s) => {
    const buildings = (s.buildings ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, b] of Object.entries(buildings)) out[id] = { ...b, repeat: b.repeat ?? null };
    return { ...s, buildings: out, version: 2 };
  },
  // v3: campaign difficulty (old campaigns were balanced as Normal)
  2: (s) => ({ ...s, difficulty: s.difficulty ?? 'normal', version: 3 }),
  // v4: research keeps progress on projects switched away from
  3: (s) => {
    const factions = (s.factions ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, f] of Object.entries(factions)) {
      const r = (f.research ?? { completed: [], current: null }) as Record<string, unknown>;
      out[id] = { ...f, research: { ...r, shelved: r.shelved ?? {} } };
    }
    return { ...s, factions: out, version: 4 };
  },
  // v5: relief landings for expeditions that lost every base
  4: (s) => {
    const factions = (s.factions ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, f] of Object.entries(factions)) out[id] = { ...f, baselessSince: f.baselessSince ?? null, reliefLandings: f.reliefLandings ?? 0 };
    return { ...s, factions: out, version: 5 };
  },
  // v6: convoys can carry colonists between bases
  5: (s) => {
    const convoys = (s.convoys ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, c] of Object.entries(convoys)) out[id] = { ...c, people: c.people ?? 0 };
    return { ...s, convoys: out, version: 6 };
  },
  // v7: the strategic AI sends recon patrols
  6: (s) => {
    const ai = (s.ai ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, a] of Object.entries(ai)) out[id] = { ...a, lastPatrolAt: a.lastPatrolAt ?? -999 };
    return { ...s, ai: out, version: 7 };
  },
  // v8: supply runs from bases to task forces in the field
  7: (s) => {
    const convoys = (s.convoys ?? {}) as Record<string, Record<string, unknown>>;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [id, c] of Object.entries(convoys)) out[id] = { ...c, toArmyId: c.toArmyId ?? null };
    return { ...s, convoys: out, version: 8 };
  },
  // v9: strategic intelligence (sightings, last known positions, base reports)
  8: (s) => {
    const factions = (s.factions ?? {}) as Record<string, unknown>;
    const intel: Record<string, unknown> = {};
    for (const id of Object.keys(factions)) intel[id] = { armies: {}, bases: {} };
    return { ...s, intel: s.intel ?? intel, version: 9 };
  },
};

export function migrateState(raw: Record<string, unknown>): CampaignState {
  let s = raw;
  let v = typeof s.version === 'number' ? s.version : 0;
  if (v === 0) {
    // pre-release states had no version field; treat as v1 shape
    s = { ...s, version: 1 };
    v = 1;
  }
  while (v < STATE_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`No migration from state version ${v}`);
    s = m(s);
    v = typeof s.version === 'number' ? s.version : v + 1;
  }
  if (v > STATE_VERSION) throw new Error(`Save is from a newer game version (state v${v})`);
  return s as unknown as CampaignState;
}
