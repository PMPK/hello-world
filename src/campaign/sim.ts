import { stepStrategicAI } from '../ai/strategicAI';
import { stepBaseEconomy } from '../economy/economy';
import { stepArmies } from './armies';
import { log, syncRng, type SimContext } from './context';
import { stepConvoys } from './convoys';
import { stepDiplomacy } from './diplomacy';
import { detectEncounters } from './encounters';
import { stepEvents } from './events';
import { armiesOf, basesOf } from './queries';

/** Fixed simulation step in campaign hours (6 minutes). */
export const SIM_STEP = 0.1;

export function stepCampaign(ctx: SimContext, dt: number): void {
  const { state } = ctx;
  state.time += dt;
  const bases = Object.values(state.bases).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const base of bases) stepBaseEconomy(ctx, base, dt);
  stepConvoys(ctx, dt);
  stepArmies(ctx, dt);
  stepStrategicAI(ctx, dt);
  stepDiplomacy(ctx, dt);
  stepEvents(ctx, dt);
  detectEncounters(ctx);
  updateDefeat(ctx);
  syncRng(ctx);
}

/**
 * Advance the campaign by `hours` in fixed steps. Stops early when a battle
 * becomes pending (the strategic layer freezes during battles).
 * Returns the hours actually simulated.
 */
export function advanceCampaign(ctx: SimContext, hours: number): number {
  let done = 0;
  while (done < hours - 1e-9) {
    if (ctx.state.pendingBattle) break;
    const dt = Math.min(SIM_STEP, hours - done);
    stepCampaign(ctx, dt);
    done += dt;
  }
  return done;
}

function updateDefeat(ctx: SimContext): void {
  const { state } = ctx;
  for (const f of Object.values(state.factions)) {
    const hasBase = basesOf(state, f.id).length > 0;
    const hasArmy = armiesOf(state, f.id).length > 0;
    const defeated = !hasBase && !hasArmy;
    if (defeated && !f.defeated) {
      f.defeated = true;
      log(state, f.isPlayer ? 'Our expedition has been broken. Survivors scatter into the wilderness.' : `${f.name} has been broken.`, 'battle');
    } else if (!defeated && f.defeated) {
      f.defeated = false;
    }
  }
}
