import { Rng } from '../core/rng';
import type { World } from '../world/world';
import type { CampaignState, LogEntry } from './types';

/**
 * Everything a simulation step needs. `rng` is synced back into
 * `state.rngState` after each step so the simulation stays deterministic
 * across save/load.
 */
export interface SimContext {
  state: CampaignState;
  world: World;
  rng: Rng;
}

export function makeContext(state: CampaignState, world: World): SimContext {
  return { state, world, rng: new Rng(state.rngState) };
}

export function syncRng(ctx: SimContext): void {
  ctx.state.rngState = ctx.rng.state;
}

export function newId(state: CampaignState, prefix: string): string {
  const id = `${prefix}${state.nextId.toString(36)}`;
  state.nextId++;
  return id;
}

export const LOG_LIMIT = 80;

/**
 * Entries added after `last` (the newest entry a reader has already seen).
 * The log is trimmed from the front, so readers must not track indices.
 */
export function entriesSince(log: LogEntry[], last: LogEntry | null): LogEntry[] {
  if (!last) return log.slice();
  const i = log.lastIndexOf(last);
  if (i >= 0) return log.slice(i + 1);
  // `last` was trimmed away (or the log replaced): fall back to time
  return log.filter((e) => e.t > last.t);
}

export function log(state: CampaignState, text: string, kind: LogEntry['kind'] = 'info', factionId?: string): void {
  state.log.push({ t: state.time, text, kind, factionId });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}
