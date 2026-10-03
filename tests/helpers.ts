import { createCampaign } from '../src/campaign/newCampaign';
import { makeContext, type SimContext } from '../src/campaign/context';
import { basesOf } from '../src/campaign/queries';
import type { Base } from '../src/campaign/types';

/** Shared fixture: a fresh deterministic campaign. */
export function freshCampaign(seed = 4242): SimContext & { player: string; enemy: string; pBase: Base; eBase: Base } {
  const { state, world } = createCampaign(seed);
  const ctx = makeContext(state, world);
  const player = state.playerFactionId;
  const enemy = Object.keys(state.factions).find((f) => f !== player)!;
  return { ...ctx, player, enemy, pBase: basesOf(state, player)[0], eBase: basesOf(state, enemy)[0] };
}
