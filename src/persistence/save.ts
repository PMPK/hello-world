import { GAME_INFO } from '../config/gameInfo';
import { campaignDay, formatCampaignDate } from '../core/time';
import type { CampaignState } from '../campaign/types';
import { migrateState } from './migrations';
import type { KVStore } from './kvstore';

/** Envelope format version (independent from the state schema version). */
export const SAVE_FORMAT_VERSION = 1;
export const SAVE_SLOTS = ['autosave', 'manual'] as const;
export type SaveSlot = (typeof SAVE_SLOTS)[number];

export interface SaveSummary {
  day: number;
  date: string;
  playerName: string;
  bases: number;
  armies: number;
}

export interface SaveGame {
  format: 'planet-x-save';
  formatVersion: number;
  gameVersion: string;
  savedAt: string;
  slot: SaveSlot;
  summary: SaveSummary;
  state: CampaignState;
}

export interface SaveInfo {
  slot: SaveSlot;
  savedAt: string;
  summary: SaveSummary;
}

export function summarize(state: CampaignState): SaveSummary {
  const pf = state.playerFactionId;
  return {
    day: campaignDay(state.time),
    date: formatCampaignDate(state.time),
    playerName: state.factions[pf]?.name ?? 'Expedition',
    bases: Object.values(state.bases).filter((b) => b.factionId === pf).length,
    armies: Object.values(state.armies).filter((a) => a.factionId === pf).length,
  };
}

export function serializeSave(state: CampaignState, slot: SaveSlot, now = new Date()): string {
  const save: SaveGame = {
    format: 'planet-x-save',
    formatVersion: SAVE_FORMAT_VERSION,
    gameVersion: GAME_INFO.version,
    savedAt: now.toISOString(),
    slot,
    summary: summarize(state),
    state,
  };
  return JSON.stringify(save);
}

export function deserializeSave(json: string): SaveGame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Save data is corrupted (invalid JSON)');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Save data is not an object');
  const p = parsed as Record<string, unknown>;
  if (p.format !== 'planet-x-save') throw new Error('Not a Planet X save');
  const fv = typeof p.formatVersion === 'number' ? p.formatVersion : 0;
  if (fv > SAVE_FORMAT_VERSION) throw new Error('Save was created by a newer version of the game');
  if (!p.state || typeof p.state !== 'object') throw new Error('Save has no campaign state');
  const state = migrateState(p.state as Record<string, unknown>);
  validateState(state);
  return { ...(p as unknown as SaveGame), formatVersion: SAVE_FORMAT_VERSION, state };
}

/** Minimal structural validation so a broken save fails loudly instead of crashing later. */
export function validateState(s: CampaignState): void {
  const need = ['seed', 'time', 'factions', 'bases', 'buildings', 'armies', 'sites'] as const;
  for (const k of need) {
    if ((s as unknown as Record<string, unknown>)[k] === undefined) throw new Error(`Save is missing "${k}"`);
  }
  if (!s.playerFactionId || !s.factions[s.playerFactionId]) throw new Error('Save has no player faction');
}

/** Save manager on top of a KV store. */
export class SaveManager {
  constructor(private readonly store: KVStore) {}

  async save(state: CampaignState, slot: SaveSlot): Promise<void> {
    await this.store.set(`save:${slot}`, serializeSave(state, slot));
  }

  async load(slot: SaveSlot): Promise<SaveGame | null> {
    const json = await this.store.get(`save:${slot}`);
    if (!json) return null;
    return deserializeSave(json);
  }

  async list(): Promise<SaveInfo[]> {
    const out: SaveInfo[] = [];
    for (const slot of SAVE_SLOTS) {
      const json = await this.store.get(`save:${slot}`);
      if (!json) continue;
      try {
        const s = JSON.parse(json) as SaveGame;
        out.push({ slot, savedAt: s.savedAt, summary: s.summary });
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
  }

  /** Most recent save of any slot. */
  async latest(): Promise<SaveInfo | null> {
    const l = await this.list();
    return l[0] ?? null;
  }

  async clear(): Promise<void> {
    for (const slot of SAVE_SLOTS) await this.store.delete(`save:${slot}`);
  }
}
