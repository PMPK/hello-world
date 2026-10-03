import { dist } from '../core/math';
import { buildingDisplayName } from '../data/buildings';
import { BATTLE_COOLDOWN, ENGAGE_RADIUS, stopArmy } from './armies';
import { buildRoad } from './construction';
import { log, newId, type SimContext } from './context';
import { declareHostile } from './diplomacy';
import { areHostile, isOutpost, nearestBaseOf } from './queries';
import type { Army, Building, PendingBattle } from './types';

const OUTPOST_CAPTURE_RADIUS = 1.9;
const OUTPOST_DEFENCE_RADIUS = 5;
const JOIN_RADIUS = 4;

function targets(a: Army, kind: 'army' | 'base' | 'building', id: string): boolean {
  const o = a.order;
  if (kind === 'army') return o.type === 'attack_army' && o.targetId === id;
  if (kind === 'base') return o.type === 'attack_base' && o.targetId === id;
  return o.type === 'attack_building' && o.targetId === id;
}

function cooled(time: number, a: Army): boolean {
  return time - a.lastBattleTime >= BATTLE_COOLDOWN;
}

/** Armies of `factionId` near (x, z). */
function armiesNear(armies: Army[], factionId: string, x: number, z: number, r: number): Army[] {
  return armies.filter((a) => a.factionId === factionId && dist(a.x, a.z, x, z) <= r);
}

/**
 * Detect contact between hostile forces and create a pending battle.
 * Only one battle is pending at a time; the campaign clock stops until it
 * is resolved (tactically or by auto-resolve).
 */
export function detectEncounters(ctx: SimContext): void {
  const { state } = ctx;
  if (state.pendingBattle) return;
  const armies = Object.values(state.armies).sort((a, b) => (a.id < b.id ? -1 : 1));

  const create = (p: Omit<PendingBattle, 'id' | 'createdAt' | 'seed'>): void => {
    state.pendingBattle = { ...p, id: newId(state, 'bt'), createdAt: state.time, seed: ctx.rng.int(1, 0x7fffffff) };
  };

  // 1. Army vs army
  for (let i = 0; i < armies.length; i++) {
    const A = armies[i];
    for (let j = i + 1; j < armies.length; j++) {
      const B = armies[j];
      if (A.factionId === B.factionId) continue;
      if (dist(A.x, A.z, B.x, B.z) > ENGAGE_RADIUS) continue;
      const aT = targets(A, 'army', B.id);
      const bT = targets(B, 'army', A.id);
      const hostile = areHostile(state, A.factionId, B.factionId);
      if (!hostile && !aT && !bT) continue;
      if (!aT && !bT && (!cooled(state.time, A) || !cooled(state.time, B))) continue;
      const attacker = aT ? A : bT ? B : A.path.length >= B.path.length ? A : B;
      const defender = attacker === A ? B : A;
      if (!hostile) declareHostile(ctx, attacker.factionId, defender.factionId);
      const mx = (A.x + B.x) / 2;
      const mz = (A.z + B.z) / 2;
      // Fighting inside a defender's base turns into a base assault.
      const base = Object.values(state.bases).find(
        (b) => b.factionId === defender.factionId && dist(b.x, b.z, mx, mz) <= b.radius + 1,
      );
      if (base) {
        create({
          kind: 'base_assault',
          x: base.x,
          z: base.z,
          attackerFactionId: attacker.factionId,
          defenderFactionId: defender.factionId,
          attackerArmyIds: armiesNear(armies, attacker.factionId, base.x, base.z, base.radius + JOIN_RADIUS).map((a) => a.id),
          defenderArmyIds: armiesNear(armies, defender.factionId, base.x, base.z, base.radius + JOIN_RADIUS).map((a) => a.id),
          baseId: base.id,
          buildingId: null,
        });
      } else {
        const att = armiesNear(armies, attacker.factionId, mx, mz, JOIN_RADIUS).map((a) => a.id);
        const def = armiesNear(armies, defender.factionId, mx, mz, JOIN_RADIUS).map((a) => a.id);
        if (!att.includes(attacker.id)) att.push(attacker.id);
        if (!def.includes(defender.id)) def.push(defender.id);
        create({
          kind: 'field',
          x: mx,
          z: mz,
          attackerFactionId: attacker.factionId,
          defenderFactionId: defender.factionId,
          attackerArmyIds: att,
          defenderArmyIds: def,
          baseId: null,
          buildingId: null,
        });
      }
      return;
    }
  }

  // 2. Army vs base
  for (const A of armies) {
    for (const base of Object.values(state.bases)) {
      if (base.factionId === A.factionId) continue;
      if (dist(A.x, A.z, base.x, base.z) > base.radius + 0.3) continue;
      const targeted = targets(A, 'base', base.id);
      const hostile = areHostile(state, A.factionId, base.factionId);
      if (!hostile && !targeted) continue;
      if (!targeted && !cooled(state.time, A)) continue;
      if (!hostile) declareHostile(ctx, A.factionId, base.factionId);
      const att = armiesNear(armies, A.factionId, base.x, base.z, base.radius + JOIN_RADIUS).map((a) => a.id);
      if (!att.includes(A.id)) att.push(A.id);
      create({
        kind: 'base_assault',
        x: base.x,
        z: base.z,
        attackerFactionId: A.factionId,
        defenderFactionId: base.factionId,
        attackerArmyIds: att,
        defenderArmyIds: armiesNear(armies, base.factionId, base.x, base.z, base.radius + JOIN_RADIUS).map((a) => a.id),
        baseId: base.id,
        buildingId: null,
      });
      return;
    }
  }

  // 3. Army vs outpost (explicit attack order required)
  for (const A of armies) {
    if (A.order.type !== 'attack_building') continue;
    const b = state.buildings[A.order.targetId];
    if (!b || b.factionId === A.factionId || b.state === 'destroyed') continue;
    if (dist(A.x, A.z, b.x, b.z) > OUTPOST_CAPTURE_RADIUS) continue;
    if (!isOutpost(state, b)) continue; // base buildings are fought over as part of the base
    if (!areHostile(state, A.factionId, b.factionId)) declareHostile(ctx, A.factionId, b.factionId);
    const defenders = armiesNear(armies, b.factionId, b.x, b.z, OUTPOST_DEFENCE_RADIUS);
    if (defenders.length === 0) {
      captureOutpost(ctx, b, A);
      continue;
    }
    create({
      kind: 'outpost',
      x: b.x,
      z: b.z,
      attackerFactionId: A.factionId,
      defenderFactionId: b.factionId,
      attackerArmyIds: armiesNear(armies, A.factionId, b.x, b.z, JOIN_RADIUS).map((a) => a.id),
      defenderArmyIds: defenders.map((a) => a.id),
      baseId: null,
      buildingId: b.id,
    });
    return;
  }
}

/** Transfer an undefended outpost to the attacker (or wreck it if they have no base). */
export function captureOutpost(ctx: SimContext, b: Building, by: Army): void {
  const { state } = ctx;
  const site = b.siteId ? state.sites[b.siteId] : undefined;
  const name = buildingDisplayName(b.typeId, site?.kind);
  const prevOwner = b.factionId;
  const base = nearestBaseOf(state, by.factionId, b.x, b.z);
  stopArmy(by);
  for (const c of Object.values(state.convoys)) if (c.fromBuildingId === b.id) delete state.convoys[c.id];
  b.storage = {};
  if (!base) {
    b.state = 'destroyed';
    b.hp = 0;
    if (state.factions[prevOwner]?.isPlayer) log(state, `Our ${name} was destroyed by ${by.name}.`, 'battle', prevOwner);
    return;
  }
  b.factionId = by.factionId;
  b.baseId = base.id;
  b.queue = [];
  buildRoad(ctx, base, b);
  if (state.factions[prevOwner]?.isPlayer) log(state, `Our ${name} has been captured by enemy forces.`, 'battle', prevOwner);
  if (state.factions[by.factionId]?.isPlayer) log(state, `${by.name} captured an enemy ${name}.`, 'battle', by.factionId);
}
