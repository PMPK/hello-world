import type { Terrain } from '../world/terrain';
import { BattleSim } from './sim';
import type { BattleResult, BattleSetup } from './types';

/**
 * Resolve a battle without the player by running the same tactical
 * simulation headless with both sides under AI control.
 */
export function autoResolve(setup: BattleSetup, strategic: Terrain, maxSeconds = setup.timeLimit): BattleResult {
  const sim = new BattleSim(setup, strategic, { aiSides: [0, 1] });
  const dt = 0.25;
  let guard = 0;
  while (!sim.finished && sim.time < maxSeconds + 1 && guard++ < 20000) {
    sim.step(dt);
    sim.events.length = 0;
  }
  if (!sim.finished) sim.finish(setup.kind === 'field' ? null : 1, 'timeout');
  return sim.computeResult();
}
