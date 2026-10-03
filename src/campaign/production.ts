import { BUILDINGS } from '../data/buildings';
import { addToStock, canAfford, missingFor, RESOURCES } from '../data/resources';
import { UNIT_DESIGNS } from '../data/unitDesigns';
import { isUnlocked } from '../research/research';
import { statsOf } from '../units/stats';
import { newId } from './context';
import type { Building, CampaignState } from './types';

export const MAX_QUEUE = 5;

/** Designs a building can produce. */
export function designsFor(b: Building, state?: CampaignState): string[] {
  const def = BUILDINGS[b.typeId];
  if (!def.produces) return [];
  const research = state?.factions[b.factionId]?.research;
  return Object.values(UNIT_DESIGNS)
    .filter((d) => d.producedAt === b.typeId)
    .filter((d) => !research || isUnlocked(research, 'design', d.id))
    .map((d) => d.id);
}

export type QueueResult = { ok: true } | { ok: false; reason: string };

/** Validate whether an order could be queued now (does not reserve resources). */
export function canQueue(state: CampaignState, buildingId: string, designId: string): QueueResult {
  const b = state.buildings[buildingId];
  if (!b || b.state !== 'active') return { ok: false, reason: 'Building not operational' };
  if (!designsFor(b, state).includes(designId)) return { ok: false, reason: 'Cannot produce here' };
  if (b.queue.length >= MAX_QUEUE) return { ok: false, reason: 'Queue full' };
  return { ok: true };
}

/** Advisory affordability check for the UI (resources are paid when work starts). */
export function affordability(state: CampaignState, buildingId: string, designId: string): QueueResult {
  const b = state.buildings[buildingId];
  const base = b ? state.bases[b.baseId] : undefined;
  if (!b || !base) return { ok: false, reason: 'No base' };
  const st = statsOf(designId);
  if (Math.floor(base.population) < st.crew) return { ok: false, reason: `Need ${st.crew} personnel` };
  if (!canAfford(base.stock, st.cost)) {
    return { ok: false, reason: `Need ${missingFor(base.stock, st.cost).map((k) => RESOURCES[k].short).join(', ')}` };
  }
  return { ok: true };
}

export function queueUnit(state: CampaignState, buildingId: string, designId: string): QueueResult {
  const check = canQueue(state, buildingId, designId);
  if (!check.ok) return check;
  const b = state.buildings[buildingId];
  b.queue.push({ id: newId(state, 'o'), designId, progress: 0, started: false });
  return { ok: true };
}

/** Cancel an order; refunds materials and returns people if work had started. */
export function cancelOrder(state: CampaignState, buildingId: string, orderId: string): boolean {
  const b = state.buildings[buildingId];
  if (!b) return false;
  const i = b.queue.findIndex((o) => o.id === orderId);
  if (i < 0) return false;
  const [o] = b.queue.splice(i, 1);
  if (o.started) {
    const base = state.bases[b.baseId];
    if (base) {
      const st = statsOf(o.designId);
      addToStock(base.stock, st.cost, 0.8);
      base.population += st.crew;
    }
  }
  return true;
}
