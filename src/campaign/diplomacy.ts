import { difficultyOf } from '../data/difficulty';
import { dist } from '../core/math';
import { FACTION_DEFS } from '../data/factions';
import { HOSTILITY_MESSAGES } from '../data/lore';
import { log, type SimContext } from './context';
import { basesOf, relationOf } from './queries';
import type { CampaignState } from './types';

/** Tension gained per hour from the deteriorating situation on Earth. */
export const TENSION_DRIFT_PER_HOUR = 0.27; // ~ +6.5/day -> weapons-free around day 15 if nothing else happens
export const TENSION_WARNING = 60;
export const TENSION_HOSTILE = 100;

function codename(state: CampaignState, factionId: string): string {
  const def = FACTION_DEFS[state.factions[factionId]?.defId ?? ''];
  return def?.codename ?? state.factions[factionId]?.name ?? 'the other expedition';
}

/** Declare open hostilities between two factions (idempotent). */
export function declareHostile(ctx: SimContext, aggressorId: string, otherId: string): void {
  const { state } = ctx;
  const r = relationOf(state, aggressorId, otherId);
  if (!r || r.status === 'hostile') return;
  r.status = 'hostile';
  r.tension = 100;
  const player = state.playerFactionId;
  if (aggressorId === player) {
    log(state, HOSTILITY_MESSAGES.playerStarted.replace('{enemy}', codename(state, otherId)), 'battle');
  } else {
    log(state, HOSTILITY_MESSAGES.aiStarted.replace('{enemy}', codename(state, aggressorId)), 'battle');
  }
}

export function addTension(ctx: SimContext, a: string, b: string, amount: number): void {
  const r = relationOf(ctx.state, a, b);
  if (!r || r.status === 'hostile') return;
  r.tension = Math.min(TENSION_HOSTILE, r.tension + amount);
}

/** Tension drift, proximity incidents, warnings and the AI going weapons-free. */
export function stepDiplomacy(ctx: SimContext, dt: number): void {
  const { state } = ctx;
  for (const r of state.relations) {
    if (r.status === 'hostile') continue;
    r.tension += TENSION_DRIFT_PER_HOUR * difficultyOf(state.difficulty).tension * dt;
    // Armies loitering near the other side's bases raise tension.
    for (const [x, y] of [
      [r.a, r.b],
      [r.b, r.a],
    ]) {
      for (const army of Object.values(state.armies)) {
        if (army.factionId !== x) continue;
        for (const base of basesOf(state, y)) {
          if (dist(army.x, army.z, base.x, base.z) < 28) r.tension += 1.2 * dt;
        }
      }
    }
    const player = state.playerFactionId;
    const other = r.a === player ? r.b : r.a;
    if (!r.warningIssued && r.tension >= TENSION_WARNING) {
      r.warningIssued = true;
      log(state, HOSTILITY_MESSAGES.rising.replace('{enemy}', codename(state, other)), 'warn');
    }
    if (r.tension >= TENSION_HOSTILE) {
      // The AI side makes the move.
      const aggressor = state.factions[r.a]?.isPlayer ? r.b : r.a;
      declareHostile(ctx, aggressor, aggressor === r.a ? r.b : r.a);
    }
  }
}
