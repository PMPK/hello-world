import type { Terrain } from '../world/terrain';
import { BattleSim } from './sim';
import type { BattleResult, BattleSetup } from './types';

const STEP = 0.25;
const MAX_STEPS = 20000;

function finalize(sim: BattleSim, setup: BattleSetup): BattleResult {
  if (!sim.finished) sim.finish(setup.kind === 'field' ? null : 1, 'timeout');
  return sim.computeResult();
}

/**
 * Resolve a battle without the player by running the same tactical
 * simulation headless with both sides under AI control.
 */
export function autoResolve(setup: BattleSetup, strategic: Terrain, maxSeconds = setup.timeLimit): BattleResult {
  const sim = new BattleSim(setup, strategic, { aiSides: [0, 1] });
  let guard = 0;
  while (!sim.finished && sim.time < maxSeconds + 1 && guard++ < MAX_STEPS) {
    sim.step(STEP);
    sim.events.length = 0;
  }
  return finalize(sim, setup);
}

export interface AutoResolveOptions {
  /** Main-thread budget per slice (ms) before yielding to the browser. */
  sliceMs?: number;
  onProgress?: (fraction: number) => void;
  maxSeconds?: number;
}

/**
 * Same simulation as `autoResolve` (identical, deterministic result) but run
 * in small time slices so the UI keeps rendering on slow phones.
 */
export async function autoResolveAsync(setup: BattleSetup, strategic: Terrain, opts: AutoResolveOptions = {}): Promise<BattleResult> {
  const sliceMs = opts.sliceMs ?? 12;
  const maxSeconds = opts.maxSeconds ?? setup.timeLimit;
  const sim = new BattleSim(setup, strategic, { aiSides: [0, 1] });
  let guard = 0;
  while (!sim.finished && sim.time < maxSeconds + 1 && guard < MAX_STEPS) {
    const t0 = performance.now();
    while (!sim.finished && sim.time < maxSeconds + 1 && guard++ < MAX_STEPS && performance.now() - t0 < sliceMs) {
      sim.step(STEP);
      sim.events.length = 0;
    }
    opts.onProgress?.(Math.min(0.99, sim.time / maxSeconds));
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  opts.onProgress?.(1);
  return finalize(sim, setup);
}
