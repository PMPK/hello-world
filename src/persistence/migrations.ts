import { STATE_VERSION, type CampaignState } from '../campaign/types';

/**
 * Save-state migrations. Each entry upgrades a state object from version N
 * to N+1. When CampaignState changes shape: bump STATE_VERSION in
 * campaign/types.ts and add a migration here — never break old saves.
 */
type Migration = (s: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Record<number, Migration> = {
  // Example for the future:
  // 1: (s) => ({ ...s, version: 2, newField: defaultValue }),
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
