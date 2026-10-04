import { formatDuration } from '../core/time';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { statsOf } from '../units/stats';
import { armyMen } from './armies';
import { log, type SimContext } from './context';
import { areHostile, eyesOf, seenBy, type Eye } from './queries';
import type { Army, ArmySighting, Base, BaseReport, CampaignState, IntelState, LogEntry } from './types';

/**
 * Strategic intelligence: what each expedition knows about its rivals.
 *
 * Every step the rival task forces a faction has eyes on refresh their
 * sighting (position, direction of travel, composition). A force that slips
 * out of view leaves its last known position on record until the record
 * expires or one of the faction's own forces takes a close look at the spot.
 * Rival bases in view get a report (structures, defences, garrison) that
 * the UI keeps showing, dated, once the base is out of view again.
 *
 * The player is alerted (log entry with a position, so the HUD can jump
 * there) when a rival force comes into view after being unseen for a
 * while, and the first time a rival base is observed.
 */

/** Hours a lost contact stays on the map as a last known position. */
export const SIGHTING_TTL = 36;
/** A force that has been out of view this long is reported again when it reappears. */
export const REALERT_GAP = 8;
/** A last known position is cleared once an own force gets this close (fraction of sight range). */
export const CLOSE_LOOK = 0.5;
/** Base reports refresh at most this often while the base is in view (hours). */
const REPORT_INTERVAL = 1;
/** More fresh contacts than this in one step are reported in a single entry. */
const MAX_SEPARATE_ALERTS = 2;

const DEFENCES: BuildingTypeId[] = ['bunker', 'at_emplacement'];

export function intelOf(state: CampaignState, factionId: string): IntelState {
  let intel = state.intel[factionId];
  if (!intel) {
    intel = { armies: {}, bases: {} };
    state.intel[factionId] = intel;
  }
  return intel;
}

export function stepIntel(ctx: SimContext): void {
  const { state } = ctx;
  for (const f of Object.values(state.factions)) {
    const intel = intelOf(state, f.id);
    const eyes = eyesOf(state, f.id);
    const fresh = updateSightings(state, f.id, intel, eyes);
    if (f.isPlayer && fresh.length) reportContacts(state, f.id, fresh);
    updateBaseReports(state, f.id, intel, eyes);
  }
}

/** Units by design id. */
export function tally(units: { designId: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of units) out[u.designId] = (out[u.designId] ?? 0) + 1;
  return out;
}

/** "2× TANK · 3× INF" for a tally (largest groups first). */
export function tallyText(t: Record<string, number>): string {
  return (
    Object.entries(t)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .map(([id, n]) => `${n}× ${statsOf(id).short}`)
      .join(' · ') || 'none'
  );
}

/** "1 unit", "3 units". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "just now", "5h 20m ago". */
export function agoText(hours: number): string {
  return hours < 0.1 ? 'just now' : `${formatDuration(hours)} ago`;
}

export function tallyCount(t: Record<string, number>): number {
  let n = 0;
  for (const v of Object.values(t)) n += v;
  return n;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** Compass point of a direction on the map (north is -z, east is +x). */
export function compassPoint(dx: number, dz: number): string {
  const a = Math.atan2(dx, -dz);
  const i = Math.round(a / (Math.PI / 4));
  return COMPASS[(i + 8) % 8];
}

/** "12 km north-east of Vostok Ridge" relative to the nearest base on the map (any faction). */
export function placeName(state: CampaignState, x: number, z: number): string {
  let best: Base | null = null;
  let bestD = Infinity;
  for (const b of Object.values(state.bases)) {
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (!best) return 'in the wilderness';
  if (bestD < best.radius + 2) return `at ${best.name}`;
  return `${Math.round(bestD)} km ${compassPoint(x - best.x, z - best.z)} of ${best.name}`;
}

/** Refresh sightings; returns the forces that should be reported as new contacts. */
function updateSightings(state: CampaignState, factionId: string, intel: IntelState, eyes: Eye[]): Army[] {
  const fresh: Army[] = [];
  const inView = new Set<string>();
  for (const a of Object.values(state.armies)) {
    if (a.factionId === factionId || !seenBy(eyes, a.x, a.z)) continue;
    inView.add(a.id);
    const prev: ArmySighting | undefined = intel.armies[a.id];
    if (!prev || (!prev.inSight && state.time - prev.t >= REALERT_GAP)) fresh.push(a);
    let hx = 0;
    let hz = 0;
    if (prev) {
      const dx = a.x - prev.x;
      const dz = a.z - prev.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        hx = dx / d;
        hz = dz / d;
      } else if (state.time - prev.t < 0.5) {
        // a stationary step between fixes: keep the last bearing briefly
        hx = prev.hx;
        hz = prev.hz;
      }
    }
    intel.armies[a.id] = {
      armyId: a.id,
      factionId: a.factionId,
      name: a.name,
      x: a.x,
      z: a.z,
      t: state.time,
      hx,
      hz,
      units: tally(a.units),
      men: armyMen(a),
      inSight: true,
    };
  }
  for (const [id, s] of Object.entries(intel.armies)) {
    if (inView.has(id)) continue;
    if (s.inSight) {
      // gone while we were watching (destroyed, garrisoned, merged): nothing left to track
      if (!state.armies[id]) delete intel.armies[id];
      else s.inSight = false;
      continue;
    }
    // a lost contact: expires, or is cleared when we take a close look at the spot
    if (state.time - s.t > SIGHTING_TTL || seenBy(eyes, s.x, s.z, CLOSE_LOOK)) delete intel.armies[id];
  }
  return fresh;
}

function reportContacts(state: CampaignState, factionId: string, fresh: Army[]): void {
  const hostileTo = (a: Army): boolean => areHostile(state, factionId, a.factionId);
  if (fresh.length > MAX_SEPARATE_ALERTS) {
    const units = fresh.reduce((n, a) => n + a.units.length, 0);
    const cx = fresh.reduce((n, a) => n + a.x, 0) / fresh.length;
    const cz = fresh.reduce((n, a) => n + a.z, 0) / fresh.length;
    const entry: Omit<LogEntry, 't'> = {
      text: `Contact: ${fresh.length} rival task forces (${plural(units, 'unit')}) sighted ${placeName(state, cx, cz)}.`,
      kind: fresh.some(hostileTo) ? 'warn' : 'info',
      factionId,
      at: { x: cx, z: cz },
      ref: { kind: 'army', id: fresh[0].id },
    };
    pushEntry(state, entry);
    return;
  }
  for (const a of fresh) {
    const s = state.intel[factionId].armies[a.id];
    const moving = s && (s.hx !== 0 || s.hz !== 0) ? `, heading ${compassPoint(s.hx, s.hz)}` : '';
    pushEntry(state, {
      text: `Contact: ${a.name} (${tallyText(tally(a.units))}) sighted ${placeName(state, a.x, a.z)}${moving}.`,
      kind: hostileTo(a) ? 'warn' : 'info',
      factionId,
      at: { x: a.x, z: a.z },
      ref: { kind: 'army', id: a.id },
    });
  }
}

function pushEntry(state: CampaignState, e: Omit<LogEntry, 't'>): void {
  log(state, e.text, e.kind, e.factionId);
  const last = state.log[state.log.length - 1];
  if (e.at) last.at = e.at;
  if (e.ref) last.ref = e.ref;
}

/** A snapshot of what can be seen of a base from outside. */
export function observeBase(state: CampaignState, base: Base): BaseReport {
  const structures: Partial<Record<BuildingTypeId, number>> = {};
  let underConstruction = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.baseId !== base.id || b.state === 'destroyed') continue;
    if (b.state === 'construction') {
      underConstruction++;
      continue;
    }
    structures[b.typeId] = (structures[b.typeId] ?? 0) + 1;
  }
  return {
    baseId: base.id,
    factionId: base.factionId,
    t: state.time,
    structures,
    underConstruction,
    garrison: tally(base.garrison),
    garrisonMen: base.garrison.reduce((n, u) => n + u.men, 0),
    population: Math.round(base.population / 10) * 10,
  };
}

/** Defensive positions in a report, e.g. "2× BNK · 1× ATG" (empty when there are none). */
export function defencesText(r: BaseReport): string {
  return DEFENCES.filter((t) => r.structures[t])
    .map((t) => `${r.structures[t]}× ${BUILDINGS[t].short}`)
    .join(' · ');
}

export function structureCount(r: BaseReport): number {
  let n = 0;
  for (const v of Object.values(r.structures)) n += v ?? 0;
  return n;
}

function updateBaseReports(state: CampaignState, factionId: string, intel: IntelState, eyes: Eye[]): void {
  for (const b of Object.values(state.bases)) {
    if (b.factionId === factionId || !seenBy(eyes, b.x, b.z)) continue;
    const prev = intel.bases[b.id];
    if (prev && prev.factionId === b.factionId && state.time - prev.t < REPORT_INTERVAL) continue;
    const r = observeBase(state, b);
    intel.bases[b.id] = r;
    if (!prev && state.factions[factionId]?.isPlayer) {
      const def = defencesText(r);
      const garrison = tallyCount(r.garrison);
      pushEntry(state, {
        text: `Intelligence: first look at ${b.name} — ${plural(structureCount(r), 'structure')}, ${def ? `defences ${def}` : 'no defences seen'}, ${garrison ? `garrison ~${plural(garrison, 'unit')}` : 'no garrison seen'}.`,
        kind: 'info',
        factionId,
        at: { x: b.x, z: b.z },
        ref: { kind: 'base', id: b.id },
      });
    }
  }
  // bases that are gone or now ours need no report
  for (const id of Object.keys(intel.bases)) {
    const b = state.bases[id];
    if (!b || b.factionId === factionId) delete intel.bases[id];
  }
}
