import { dist } from '../core/math';
import { BUILDINGS } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import type { CampaignState, PendingBattle, UnitInstance } from '../campaign/types';
import { BIOME_NAMES, biomeAt } from '../world/terrain';
import type { World } from '../world/world';
import { campaignToBattle } from './terrain';
import {
  BATTLE_POS_SCALE,
  BATTLE_SIZE,
  BATTLE_TIME_LIMIT,
  type BattleBuildingSpec,
  type BattleSetup,
  type BattleSideSetup,
  type BattleUnitSpec,
  type SideIndex,
} from './types';

function specOf(u: UnitInstance, origin: BattleUnitSpec['origin']): BattleUnitSpec {
  return { campaignId: u.id, designId: u.designId, hp: u.hp, men: u.men, ammo: u.ammo, fuel: u.fuel, origin };
}

function sideSetup(state: CampaignState, factionId: string, armyIds: string[], units: BattleUnitSpec[]): Omit<BattleSideSetup, 'entry'> {
  const f = state.factions[factionId];
  const def = FACTION_DEFS[f?.defId ?? ''];
  return {
    factionId,
    name: f?.name ?? factionId,
    isPlayer: !!f?.isPlayer,
    armyIds,
    units,
    color: def?.color ?? '#888888',
    vehicleTint: def?.vehicleTint ?? '#777766',
    uniformTint: def?.uniformTint ?? '#666655',
  };
}

/** Human-readable place name for a battle location. */
export function locationName(state: CampaignState, world: World, x: number, z: number): string {
  const b = biomeAt(world.terrain, x, z);
  let near = '';
  let nd = Infinity;
  for (const base of Object.values(state.bases)) {
    const d = dist(base.x, base.z, x, z);
    if (d < nd) {
      nd = d;
      near = base.name;
    }
  }
  if (nd <= 12) return near;
  return `${BIOME_NAMES[b]}, ${Math.round(nd)} km from ${near}`;
}

/**
 * Build a tactical battle from a pending campaign encounter. The battlefield
 * contains the actual campaign units and, for base/outpost fights, the
 * actual campaign buildings at their real relative positions.
 */
export function createBattleSetup(state: CampaignState, world: World, p: PendingBattle): BattleSetup {
  const cx = p.x;
  const cz = p.z;
  const atkUnits: BattleUnitSpec[] = [];
  const defUnits: BattleUnitSpec[] = [];
  let ax = 0;
  let az = 0;
  let an = 0;
  for (const id of p.attackerArmyIds) {
    const a = state.armies[id];
    if (!a) continue;
    for (const u of a.units) atkUnits.push(specOf(u, { kind: 'army', id }));
    ax += a.x;
    az += a.z;
    an++;
  }
  for (const id of p.defenderArmyIds) {
    const a = state.armies[id];
    if (!a) continue;
    for (const u of a.units) defUnits.push(specOf(u, { kind: 'army', id }));
  }
  if (p.baseId) {
    const base = state.bases[p.baseId];
    if (base) for (const u of base.garrison) defUnits.push(specOf(u, { kind: 'garrison', id: base.id }));
  }

  // Direction from which the attacker approaches.
  let dirX = 0;
  let dirZ = 0;
  if (an > 0) {
    dirX = ax / an - cx;
    dirZ = az / an - cz;
  }
  let len = Math.hypot(dirX, dirZ);
  if (len < 0.3) {
    // Attacker is on top of the objective: use its home direction, else a seeded direction.
    const a = state.armies[p.attackerArmyIds[0]];
    const home = a?.homeBaseId ? state.bases[a.homeBaseId] : undefined;
    if (home) {
      dirX = home.x - cx;
      dirZ = home.z - cz;
    } else {
      const ang = (p.seed % 628) / 100;
      dirX = Math.cos(ang);
      dirZ = Math.sin(ang);
    }
    len = Math.hypot(dirX, dirZ) || 1;
  }
  dirX /= len;
  dirZ /= len;

  // Buildings inside the battlefield (both factions).
  const half = BATTLE_SIZE / 2 / BATTLE_POS_SCALE - 1;
  const buildings: BattleBuildingSpec[] = [];
  for (const b of Object.values(state.buildings)) {
    if (Math.abs(b.x - cx) > half || Math.abs(b.z - cz) > half) continue;
    const pos = campaignToBattle(cx, cz, b.x, b.z);
    const side: SideIndex = b.factionId === p.attackerFactionId ? 0 : 1;
    buildings.push({
      campaignId: b.id,
      typeId: b.typeId,
      siteKind: b.siteId ? (state.sites[b.siteId]?.kind ?? null) : null,
      side,
      factionId: b.factionId,
      x: pos.x,
      z: pos.z,
      rot: b.rot,
      hp: b.state === 'destroyed' ? 0 : b.hp,
      maxHp: BUILDINGS[b.typeId].maxHp,
      state: b.state,
    });
  }

  const mid = BATTLE_SIZE / 2;
  const isSiege = p.kind === 'base_assault' || p.kind === 'outpost';
  const atkDist = isSiege ? 330 : 255;
  const defDist = isSiege ? 0 : 255;
  const atk: BattleSideSetup = {
    ...sideSetup(state, p.attackerFactionId, p.attackerArmyIds, atkUnits),
    entry: { x: mid + dirX * atkDist, z: mid + dirZ * atkDist, dirX: -dirX, dirZ: -dirZ },
  };
  const def: BattleSideSetup = {
    ...sideSetup(state, p.defenderFactionId, p.defenderArmyIds, defUnits),
    entry: { x: mid - dirX * defDist, z: mid - dirZ * defDist, dirX, dirZ },
  };
  const playerSide: SideIndex | null = atk.isPlayer ? 0 : def.isPlayer ? 1 : null;

  return {
    id: p.id,
    seed: p.seed,
    kind: p.kind,
    campaignX: cx,
    campaignZ: cz,
    sides: [atk, def],
    buildings,
    baseId: p.baseId,
    objectiveBuildingId: p.buildingId,
    playerSide,
    timeLimit: BATTLE_TIME_LIMIT,
    locationName: locationName(state, world, cx, cz),
  };
}
