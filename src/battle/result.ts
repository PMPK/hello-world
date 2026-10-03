import { dist } from '../core/math';
import { BUILDINGS, buildingDisplayName } from '../data/buildings';
import { createArmy, removeArmy, retreatArmy } from '../campaign/armies';
import { log, type SimContext } from '../campaign/context';
import { declareHostile } from '../campaign/diplomacy';
import { captureOutpost } from '../campaign/encounters';
import { basesOf, nearestBaseOf } from '../campaign/queries';
import { advanceCampaign } from '../campaign/sim';
import type { Base, CampaignState, UnitInstance } from '../campaign/types';
import { formatDuration } from '../core/time';
import type { BattleResult, BattleSetup, SideIndex } from './types';

export interface AppliedBattleSummary {
  title: string;
  lines: string[];
  playerWon: boolean | null;
}

function findUnit(state: CampaignState, origin: { kind: 'army' | 'garrison'; id: string }, unitId: string): { list: UnitInstance[]; unit: UnitInstance } | null {
  if (origin.kind === 'army') {
    const a = state.armies[origin.id];
    const u = a?.units.find((x) => x.id === unitId);
    return a && u ? { list: a.units, unit: u } : null;
  }
  const b = state.bases[origin.id];
  const u = b?.garrison.find((x) => x.id === unitId);
  return b && u ? { list: b.garrison, unit: u } : null;
}

/** Transfer a base (and its outposts) to the conqueror. */
function captureBase(ctx: SimContext, base: Base, newOwner: string): void {
  const { state } = ctx;
  const prevOwner = base.factionId;
  base.factionId = newOwner;
  // a share of the personnel flees to another base of the previous owner
  const refuge = basesOf(state, prevOwner).find((b) => b.id !== base.id);
  const fleeing = Math.floor(base.population * 0.4);
  if (refuge) refuge.population += fleeing;
  base.population -= fleeing;
  base.garrison = [];
  for (const b of Object.values(state.buildings)) {
    if (b.baseId !== base.id) continue;
    b.factionId = newOwner;
    b.queue = [];
    b.repairing = false;
  }
  for (const r of Object.values(state.roads)) if (r.fromBaseId === base.id) r.factionId = newOwner;
  for (const c of Object.values(state.convoys)) if (c.toBaseId === base.id && c.factionId !== newOwner) delete state.convoys[c.id];
  for (const ch of Object.values(state.characters)) {
    if (ch.location.kind === 'base' && ch.location.id === base.id && ch.factionId === prevOwner) {
      ch.location = refuge ? { kind: 'base', id: refuge.id } : { kind: 'none' };
    }
  }
}

/**
 * Apply a finished battle to the persistent campaign:
 * surviving units keep their damage/ammo/fuel, the dead are removed,
 * vehicle crews that bailed out return to the population, buildings keep
 * battle damage, bases/outposts can change hands, armies retreat, and the
 * campaign clock advances by the battle duration.
 */
export function applyBattleResult(ctx: SimContext, setup: BattleSetup, result: BattleResult): AppliedBattleSummary {
  const { state } = ctx;
  const atkF = setup.sides[0].factionId;
  const defF = setup.sides[1].factionId;
  state.pendingBattle = null;
  declareHostile(ctx, atkF, defF);

  // ---- units ----------------------------------------------------------------
  for (const r of result.units) {
    const found = findUnit(state, r.origin, r.campaignId);
    if (!found) continue;
    if (r.status === 'destroyed') {
      found.list.splice(found.list.indexOf(found.unit), 1);
      const f = setup.sides[r.side].factionId;
      state.stats.unitsLost[f] = (state.stats.unitsLost[f] ?? 0) + 1;
    } else {
      found.unit.hp = r.hp;
      found.unit.men = r.men;
      found.unit.ammo = r.ammo;
      found.unit.fuel = r.fuel;
    }
  }
  for (const s of [0, 1] as SideIndex[]) {
    const sum = result.sides[s];
    state.stats.soldiersKilled[sum.factionId] = (state.stats.soldiersKilled[sum.factionId] ?? 0) + sum.menKilled;
    if (sum.crewSurvivors > 0) {
      const home = nearestBaseOf(state, sum.factionId, setup.campaignX, setup.campaignZ);
      if (home) home.population += sum.crewSurvivors;
    }
  }

  // ---- buildings ------------------------------------------------------------
  for (const rb of result.buildings) {
    const b = state.buildings[rb.campaignId];
    if (!b) continue;
    if (rb.destroyed) {
      if (b.state !== 'destroyed') {
        b.state = 'destroyed';
        b.hp = 0;
        b.queue = [];
        b.activeRecipe = null;
        b.repairing = false;
        b.storage = {};
      }
    } else {
      b.hp = Math.min(BUILDINGS[b.typeId].maxHp, Math.max(1, rb.hp));
    }
  }

  // ---- outcome --------------------------------------------------------------
  const winnerF = result.winner === null ? null : setup.sides[result.winner].factionId;
  const playerF = state.playerFactionId;
  const lines: string[] = [];
  let title = 'Engagement inconclusive';
  const base = setup.baseId ? state.bases[setup.baseId] : undefined;

  const attackerSurvivors = Object.values(state.armies).filter((a) => setup.sides[0].armyIds.includes(a.id) && a.units.length > 0);
  if (setup.kind === 'base_assault' && base && result.winner === 0 && attackerSurvivors.length > 0) {
    const prevOwner = base.factionId;
    // remaining defender units that retreated form a new field army outside
    const leftovers = base.garrison.slice();
    captureBase(ctx, base, atkF);
    if (leftovers.length) {
      const refuge = nearestBaseOf(state, prevOwner, base.x, base.z);
      const army = createArmy(ctx, prevOwner, base.x + base.radius + 4, base.z, leftovers, refuge?.id ?? null);
      retreatArmy(ctx, army, base.x, base.z, 14);
    }
    title = `${base.name} captured`;
    lines.push(prevOwner === playerF ? `${base.name} has fallen. Surviving personnel surrendered.` : `We have taken ${base.name}. Its personnel have surrendered.`);
    log(state, prevOwner === playerF ? `${base.name} has fallen to the enemy.` : `${base.name} captured.`, 'battle');
  } else if (setup.kind === 'outpost' && result.winner === 0 && setup.objectiveBuildingId) {
    const b = state.buildings[setup.objectiveBuildingId];
    const army = attackerSurvivors[0];
    if (b && b.state !== 'destroyed' && army) captureOutpost(ctx, b, army);
    title = 'Outpost taken';
  } else if (result.winner === 0) {
    title = setup.sides[0].isPlayer ? 'Victory' : 'Defeat';
  } else if (result.winner === 1) {
    title = setup.sides[1].isPlayer ? (setup.kind === 'field' ? 'Victory' : 'Attack repulsed') : 'Attack failed';
  }

  // ---- armies: cooldowns, retreats, cleanup ---------------------------------
  const allArmyIds = [...setup.sides[0].armyIds, ...setup.sides[1].armyIds];
  for (const id of allArmyIds) {
    const a = state.armies[id];
    if (!a) continue;
    a.lastBattleTime = state.time;
    if (a.units.length === 0) {
      if (state.factions[a.factionId]?.isPlayer) lines.push(`${a.name} was destroyed.`);
      removeArmy(state, a.id);
      continue;
    }
    const isLoser = winnerF !== null && a.factionId !== winnerF;
    const draw = winnerF === null;
    if (isLoser || (draw && a.factionId === atkF)) {
      retreatArmy(ctx, a, setup.campaignX, setup.campaignZ, setup.kind === 'base_assault' ? 16 : 10);
    } else {
      a.path = [];
      a.order = { type: 'idle' };
    }
  }
  // Attackers that won a base assault but stand inside: fine (the base is theirs now).
  if (base && result.winner !== 0) {
    // keep attackers out of the base radius so they don't instantly re-trigger
    for (const a of Object.values(state.armies)) {
      if (a.factionId === atkF && dist(a.x, a.z, base.x, base.z) <= base.radius + 0.5 && a.order.type !== 'move') {
        retreatArmy(ctx, a, base.x, base.z, base.radius + 6);
      }
    }
  }

  // ---- summary --------------------------------------------------------------
  const pSide: SideIndex | null = setup.sides[0].factionId === playerF ? 0 : setup.sides[1].factionId === playerF ? 1 : null;
  if (pSide !== null) {
    const me = result.sides[pSide];
    const them = result.sides[pSide === 0 ? 1 : 0];
    lines.push(`Our losses: ${me.menKilled} killed, ${me.vehiclesLost} vehicles, ${me.squadsLost} squads.${me.crewSurvivors ? ` ${me.crewSurvivors} crew rescued.` : ''}`);
    lines.push(`Enemy losses: ${them.menKilled} killed, ${them.vehiclesLost} vehicles, ${them.squadsLost} squads.`);
    if (me.buildingsLost) lines.push(`Structures lost: ${me.buildingsLost}.`);
    if (them.buildingsLost) lines.push(`Enemy structures destroyed: ${them.buildingsLost}.`);
    lines.push(`Ammunition expended: ${Math.round(me.ammoSpent)} · Fuel burned: ${Math.round(me.fuelSpent)}`);
  }
  lines.push(`Battle duration: ${formatDuration(result.campaignHours)}`);
  const destroyedNames = result.buildings
    .filter((rb) => rb.destroyed)
    .map((rb) => state.buildings[rb.campaignId])
    .filter((b) => !!b)
    .map((b) => buildingDisplayName(b.typeId, b.siteId ? state.sites[b.siteId]?.kind : undefined));
  if (destroyedNames.length) lines.push(`Destroyed: ${destroyedNames.join(', ')}`);

  state.stats.battlesFought++;
  const playerWon = pSide === null ? null : result.winner === null ? null : result.winner === pSide;
  if (playerWon) state.stats.battlesWon++;
  log(state, `${title} — ${setup.locationName}.`, 'battle', playerF);

  // ---- the campaign clock catches up with the battle duration ---------------
  advanceCampaign(ctx, result.campaignHours);

  return { title, lines, playerWon };
}
