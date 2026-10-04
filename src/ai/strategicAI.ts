import { dist } from '../core/math';
import { BUILDINGS, type BuildingTypeId, type SiteKind } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { canAfford } from '../data/resources';
import { statsOf } from '../units/stats';
import { formArmyFromGarrison, fuelRange, orderAttack, orderReturn, type AttackTarget } from '../campaign/armies';
import {
  canBuildOutpost,
  OUTPOST_RANGE,
  rebuildBuilding,
  startConstruction,
  startOutpost,
  suggestPlacement,
} from '../campaign/construction';
import type { SimContext } from '../campaign/context';
import { canFoundFrom, foundBase, FOUND_COST, MIN_BASE_SPACING, validateBaseSite } from '../campaign/expansion';
import { queueUnit } from '../campaign/production';
import {
  areHostile,
  armiesOf,
  armyStrength,
  basesOf,
  buildingsOfBase,
  enemyFactionOf,
  garrisonStrength,
  isOutpost,
  isVisibleToFaction,
  relationOf,
  strengthOf,
} from '../campaign/queries';
import { difficultyOf } from '../data/difficulty';
import { isUnlocked } from '../research/research';
import type { AIState, Army, Base, CampaignState } from '../campaign/types';

const THINK_INTERVAL = 1.5;
const OFFENSIVE_COOLDOWN = 14;
const MAX_MILITARY_UNITS = 30;

/** Strategic AI for non-player expeditions. Runs on its own schedule. */
export function stepStrategicAI(ctx: SimContext, _dt: number): void {
  const { state } = ctx;
  for (const ai of Object.values(state.ai)) {
    if (state.time < ai.nextThinkAt) continue;
    ai.nextThinkAt = state.time + THINK_INTERVAL;
    const f = state.factions[ai.factionId];
    if (!f || f.isPlayer) continue;
    for (const base of basesOf(state, ai.factionId)) {
      thinkEconomy(ctx, ai, base);
      thinkRecruitment(ctx, ai, base);
    }
    thinkExpansion(ctx, ai);
    thinkMilitary(ctx, ai);
  }
}

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------

function count(state: CampaignState, base: Base, typeId: BuildingTypeId, siteKind?: SiteKind): number {
  let n = 0;
  for (const b of Object.values(state.buildings)) {
    if (b.baseId !== base.id || b.typeId !== typeId || b.state === 'destroyed') continue;
    if (siteKind && (!b.siteId || state.sites[b.siteId]?.kind !== siteKind)) continue;
    n++;
  }
  return n;
}

type TryResult = 'ok' | 'unaffordable' | 'impossible';

function tryBuild(ctx: SimContext, base: Base, typeId: BuildingTypeId): TryResult {
  const { state, world, rng } = ctx;
  if (!canAfford(base.stock, BUILDINGS[typeId].cost)) return 'unaffordable';
  const a = rng.range(0, Math.PI * 2);
  const r = rng.range(3, base.radius - 2.5);
  const spot = suggestPlacement(state, world, base, typeId, base.x + Math.cos(a) * r, base.z + Math.sin(a) * r);
  if (!spot) return 'impossible';
  return startConstruction(ctx, base.id, typeId, spot.x, spot.z).ok ? 'ok' : 'impossible';
}

/** Place a defensive position on the perimeter, covering the approach from the nearest enemy base. */
function tryBuildDefense(ctx: SimContext, base: Base, typeId: BuildingTypeId): TryResult {
  const { state, world, rng } = ctx;
  if (!canAfford(base.stock, BUILDINGS[typeId].cost)) return 'unaffordable';
  const enemy = enemyFactionOf(state, base.factionId);
  const enemyBase = enemy
    ? basesOf(state, enemy).sort((a, b) => dist(a.x, a.z, base.x, base.z) - dist(b.x, b.z, base.x, base.z))[0]
    : undefined;
  const toward = enemyBase ? Math.atan2(enemyBase.z - base.z, enemyBase.x - base.x) : rng.range(0, Math.PI * 2);
  // fan successive positions out to both sides of the threat axis
  const n = count(state, base, 'bunker') + count(state, base, 'at_emplacement');
  const a = toward + (n % 2 === 0 ? 1 : -1) * Math.ceil(n / 2) * 0.45 + rng.range(-0.12, 0.12);
  const r = base.radius - 1.6;
  const spot = suggestPlacement(state, world, base, typeId, base.x + Math.cos(a) * r, base.z + Math.sin(a) * r);
  if (!spot) return 'impossible';
  return startConstruction(ctx, base.id, typeId, spot.x, spot.z).ok ? 'ok' : 'impossible';
}

function tryOutpost(ctx: SimContext, base: Base, kind: SiteKind): TryResult {
  const { state } = ctx;
  const enemy = enemyFactionOf(state, base.factionId);
  const enemyBases = enemy ? basesOf(state, enemy) : [];
  let best: string | null = null;
  let bestScore = Infinity;
  for (const site of Object.values(state.sites)) {
    if (site.kind !== kind) continue;
    if (site.buildingId && state.buildings[site.buildingId]?.state !== 'destroyed') continue;
    const d = dist(site.x, site.z, base.x, base.z);
    if (d > OUTPOST_RANGE) continue;
    // prefer safe sites: closer to us than to the enemy
    let danger = 0;
    for (const eb of enemyBases) danger += Math.max(0, 45 - dist(site.x, site.z, eb.x, eb.z)) * 1.5;
    const score = d + danger - site.richness * 6;
    if (score < bestScore) {
      bestScore = score;
      best = site.id;
    }
  }
  if (!best) return 'impossible';
  if (!canAfford(base.stock, BUILDINGS.extractor.cost)) return 'unaffordable';
  if (!canBuildOutpost(state, base, best).ok) return 'impossible';
  return startOutpost(ctx, base.id, best).ok ? 'ok' : 'impossible';
}

/** Output of buildings of a type, counting those still under construction. */
function plannedEnergy(state: CampaignState, base: Base): number {
  let e = 0;
  for (const b of buildingsOfBase(state, base.id)) {
    if (b.state === 'destroyed') continue;
    e += BUILDINGS[b.typeId].energyOutput ?? 0;
  }
  return e;
}

function plannedEnergyDemand(state: CampaignState, base: Base): number {
  let e = 0;
  for (const b of buildingsOfBase(state, base.id)) {
    if (b.state === 'destroyed') continue;
    e += BUILDINGS[b.typeId].energyUse;
  }
  return e;
}

function plannedWorkers(state: CampaignState, base: Base): number {
  let w = 0;
  for (const b of buildingsOfBase(state, base.id)) {
    if (b.state === 'destroyed') continue;
    w += BUILDINGS[b.typeId].workers;
  }
  return w;
}

function plannedHousing(state: CampaignState, base: Base): number {
  let h = 0;
  for (const b of buildingsOfBase(state, base.id)) {
    if (b.state === 'destroyed') continue;
    h += BUILDINGS[b.typeId].housing ?? 0;
  }
  return h;
}

function thinkEconomy(ctx: SimContext, ai: AIState, base: Base): void {
  const { state } = ctx;
  const buildings = buildingsOfBase(state, base.id);
  // Keep things repaired.
  for (const b of buildings) {
    if (b.state === 'active' && b.hp < BUILDINGS[b.typeId].maxHp * 0.95 && base.stock.refined > 30) b.repairing = true;
  }
  const constructing = buildings.filter((b) => b.state === 'construction').length;
  if (constructing >= 2) return;
  ai.lastBuildCheck = state.time;

  // Rebuild important destroyed structures first.
  for (const b of buildings) {
    if (b.state === 'destroyed' && BUILDINGS[b.typeId].importance >= 0.6 && !isOutpost(state, b)) {
      if (rebuildBuilding(ctx, b.id).ok) return;
    }
  }

  const workersFree = Math.floor(base.population * 0.8) + 2 - plannedWorkers(state, base);
  const housing = plannedHousing(state, base);
  const energySurplus = plannedEnergy(state, base) - plannedEnergyDemand(state, base);
  const hydroSites = count(state, base, 'extractor', 'hydrocarbons');
  const mineralSites = count(state, base, 'extractor', 'minerals');
  const farms = count(state, base, 'farm');
  const farmOut = BUILDINGS.farm.recipes![0];
  const perFarm = (farmOut.outputs.food ?? 0) / farmOut.cycleHours;
  const eaters = base.population + soldiersOf(state, base.factionId) + 10;
  const foodNet = farms * perFarm - eaters * 0.02;
  const enemy = enemyFactionOf(state, base.factionId);
  const rel = enemy ? relationOf(state, base.factionId, enemy) : null;
  const threatened = !!enemy && (areHostile(state, base.factionId, enemy) || (rel?.tension ?? 0) > 50);
  const industry = count(state, base, 'refinery') > 0 && count(state, base, 'factory') > 0;
  const bunkers = count(state, base, 'bunker');
  const atGuns = count(state, base, 'at_emplacement');
  const hasLab = Object.values(state.buildings).some((b) => b.factionId === base.factionId && b.typeId === 'research_lab');

  // the plan normally keeps a fifth of the people spare for construction crews; the lab may use them
  const spareForLab = Math.floor(base.population) - plannedWorkers(state, base) >= BUILDINGS.research_lab.workers;
  type Step = { type: BuildingTypeId | 'mine' | 'well'; when: boolean; blocking?: boolean; staffed?: boolean };
  const plan: Step[] = [
    // a young base first secures an income of ore
    { type: 'mine', when: mineralSites < 1 && count(state, base, 'refinery') < 1, blocking: true },
    { type: 'habitat', when: base.population >= housing - 3, blocking: true },
    { type: 'farm', when: foodNet < 0.2, blocking: true },
    { type: 'refinery', when: count(state, base, 'refinery') < 1, blocking: true },
    { type: 'well', when: hydroSites < 1, blocking: true },
    { type: 'power_plant', when: energySurplus < 6 && (hydroSites > 0 || base.stock.hydrocarbons > 30), blocking: true },
    { type: 'factory', when: count(state, base, 'factory') < 1, blocking: true },
    { type: 'vehicle_depot', when: count(state, base, 'vehicle_depot') < 1, blocking: true },
    { type: 'mine', when: mineralSites < 2 },
    { type: 'barracks', when: count(state, base, 'barracks') < 1, blocking: true },
    // under threat the first bunker is worth saving up for
    { type: 'bunker', when: industry && threatened && bunkers < 1, blocking: true },
    { type: 'at_emplacement', when: industry && threatened && atGuns < 1 && bunkers >= 1 },
    // one lab per expedition: its research benefits every base
    { type: 'research_lab', when: industry && !hasLab && (!threatened || bunkers > 0) && count(state, base, 'vehicle_depot') > 0 && state.time > 24 * 5, staffed: spareForLab },
    { type: 'habitat', when: base.population >= housing - 8 },
    { type: 'well', when: hydroSites < 2 },
    { type: 'mine', when: mineralSites < 3 },
    { type: 'farm', when: foodNet < 0.8 && workersFree > 8 },
    { type: 'refinery', when: count(state, base, 'refinery') < 2 && mineralSites >= 3 },
    { type: 'factory', when: count(state, base, 'factory') < 2 && base.stock.refined > 120 },
    { type: 'power_plant', when: energySurplus < 14 },
    { type: 'bunker', when: industry && bunkers < 2 && (threatened || state.time > 24 * 8) },
    { type: 'at_emplacement', when: industry && atGuns < 2 && bunkers >= 2 && base.stock.components > 40 },
  ];
  for (const step of plan) {
    if (!step.when) continue;
    const workerCost =
      step.type === 'mine' || step.type === 'well' ? BUILDINGS.extractor.workers : BUILDINGS[step.type].workers;
    // Don't build what we cannot staff (housing and food are always allowed).
    if (step.type !== 'habitat' && !(step.type === 'farm' && foodNet < 0.2) && !step.staffed && workerCost > workersFree + 2) continue;
    let r: TryResult;
    if (step.type === 'mine') r = tryOutpost(ctx, base, 'minerals');
    else if (step.type === 'well') r = tryOutpost(ctx, base, 'hydrocarbons');
    else if (BUILDINGS[step.type].defense) r = tryBuildDefense(ctx, base, step.type);
    else r = tryBuild(ctx, base, step.type);
    if (r === 'ok') return;
    if (r === 'unaffordable' && step.blocking) return; // save up for it
  }
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/** AI expeditions found one more base once their first one is well established. */
const AI_MAX_BASES = 2;

function thinkExpansion(ctx: SimContext, ai: AIState): void {
  const { state, world } = ctx;
  if (state.time < 24 * 10) return;
  const bases = basesOf(state, ai.factionId);
  if (!bases.length || bases.length >= AI_MAX_BASES) return;
  const from = bases.slice().sort((a, b) => b.population - a.population)[0];
  if (!canFoundFrom(state, from).ok) return;
  // keep a healthy reserve at home
  if (from.population < 50 || from.stock.minerals < (FOUND_COST.minerals ?? 0) + 120 || from.stock.refined < (FOUND_COST.refined ?? 0) + 80) return;
  const enemy = enemyFactionOf(state, ai.factionId);
  const enemyBases = enemy ? basesOf(state, enemy) : [];
  let best: { x: number; z: number } | null = null;
  let bestScore = -Infinity;
  for (let r = MIN_BASE_SPACING + 5; r <= 110; r += 15) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2 + r * 0.05;
      const x = from.x + Math.cos(a) * r;
      const z = from.z + Math.sin(a) * r;
      if (!validateBaseSite(state, world, from, x, z).ok) continue;
      let score = 0;
      for (const site of Object.values(state.sites)) {
        if (site.buildingId && state.buildings[site.buildingId]?.state !== 'destroyed') continue;
        if (dist(site.x, site.z, x, z) <= OUTPOST_RANGE) score += 10 * site.richness;
      }
      for (const eb of enemyBases) score += Math.min(120, dist(eb.x, eb.z, x, z)) * 0.08;
      score -= r * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  if (best && bestScore > 8) foundBase(ctx, from.id, best.x, best.z);
}

// ---------------------------------------------------------------------------
// Recruitment
// ---------------------------------------------------------------------------

function militaryCounts(state: CampaignState, factionId: string): { inf: number; jeep: number; tank: number; truck: number; atgm: number; total: number } {
  const r = { inf: 0, jeep: 0, tank: 0, truck: 0, atgm: 0, total: 0 };
  const add = (designId: string): void => {
    const fam = statsOf(designId).family;
    if (designId === 'atgm_team') r.atgm++;
    if (fam === 'infantry') r.inf++;
    else if (fam === 'light_vehicle') r.jeep++;
    else if (fam === 'support') r.truck++;
    else r.tank++;
    r.total++;
  };
  for (const b of basesOf(state, factionId)) for (const u of b.garrison) add(u.designId);
  for (const a of armiesOf(state, factionId)) for (const u of a.units) add(u.designId);
  for (const b of Object.values(state.buildings)) if (b.factionId === factionId) for (const o of b.queue) add(o.designId);
  return r;
}

function soldiersOf(state: CampaignState, factionId: string): number {
  let n = 0;
  for (const b of basesOf(state, factionId)) for (const u of b.garrison) n += u.men;
  for (const a of armiesOf(state, factionId)) for (const u of a.units) n += u.men;
  return n;
}

function underThreat(state: CampaignState, base: Base): boolean {
  for (const a of Object.values(state.armies)) {
    if (a.factionId === base.factionId || !areHostile(state, a.factionId, base.factionId)) continue;
    if (dist(a.x, a.z, base.x, base.z) < 40) return true;
  }
  return false;
}

function thinkRecruitment(ctx: SimContext, ai: AIState, base: Base): void {
  const { state } = ctx;
  const counts = militaryCounts(state, ai.factionId);
  if (counts.total >= MAX_MILITARY_UNITS) return;
  const threatened = underThreat(state, base);
  const hasIndustry = count(state, base, 'refinery') > 0 && count(state, base, 'factory') > 0;
  if (!hasIndustry && !threatened && state.time < 24 * 6) return;
  const soldiers = soldiersOf(state, ai.factionId);
  const maxSoldiers = (base.population + soldiers) * (threatened ? 0.6 : 0.45);
  const spare = Math.floor(base.population) - plannedWorkers(state, base) - (threatened ? 0 : 6);
  for (const b of buildingsOfBase(state, base.id)) {
    if (b.state !== 'active' || b.queue.length > 0) continue;
    if (b.typeId === 'barracks') {
      const okMaterials = base.stock.refined >= (threatened ? 6 : 35) && base.stock.ammo >= 10;
      if (spare >= 6 && soldiers + 6 <= maxSoldiers && okMaterials && counts.inf < counts.total * 0.6 + 3) {
        // a third of new infantry are ATGM teams once researched
        const research = state.factions[ai.factionId]?.research;
        const atgm = research && isUnlocked(research, 'design', 'atgm_team') && counts.atgm < Math.ceil(counts.inf / 3);
        queueUnit(state, b.id, atgm ? 'atgm_team' : 'rifle_squad');
      }
    } else if (b.typeId === 'vehicle_depot') {
      if (spare < 3 || soldiers + 3 > maxSoldiers) continue;
      const wantTank = counts.tank < Math.max(1, Math.ceil(counts.inf / 2));
      // one supply truck per ~8 fighting units once a core force exists
      const wantTruck = !wantTank && counts.total >= 6 && counts.truck < Math.floor((counts.total - counts.truck) / 8) && base.stock.fuel > 80;
      const design = wantTruck ? 'supply_truck' : wantTank ? 'mbt' : counts.jeep < Math.max(2, Math.ceil(counts.inf / 3)) ? 'recon_jeep' : 'mbt';
      const st = statsOf(design);
      if (canAfford(base.stock, st.cost, 0.8)) queueUnit(state, b.id, design);
    }
  }
}

// ---------------------------------------------------------------------------
// Military
// ---------------------------------------------------------------------------

interface TargetOption {
  target: AttackTarget;
  x: number;
  z: number;
  defense: number;
  value: number;
}

function enemyTargets(state: CampaignState, factionId: string): TargetOption[] {
  const out: TargetOption[] = [];
  for (const b of Object.values(state.bases)) {
    if (b.factionId === factionId || !areHostile(state, factionId, b.factionId)) continue;
    out.push({ target: { kind: 'base', id: b.id }, x: b.x, z: b.z, defense: garrisonStrength(state, b), value: 10 });
  }
  for (const b of Object.values(state.buildings)) {
    if (b.factionId === factionId || b.state === 'destroyed' || b.typeId !== 'extractor') continue;
    if (!areHostile(state, factionId, b.factionId) || !isOutpost(state, b)) continue;
    let defense = 0;
    for (const a of Object.values(state.armies)) {
      if (a.factionId === b.factionId && dist(a.x, a.z, b.x, b.z) < 12) defense += armyStrength(a);
    }
    out.push({ target: { kind: 'building', id: b.id }, x: b.x, z: b.z, defense, value: 3 });
  }
  for (const a of Object.values(state.armies)) {
    if (a.factionId === factionId || !areHostile(state, factionId, a.factionId)) continue;
    // strategic fog of war: only forces the AI currently has eyes on
    if (!isVisibleToFaction(state, factionId, a.x, a.z)) continue;
    out.push({ target: { kind: 'army', id: a.id }, x: a.x, z: a.z, defense: armyStrength(a), value: 4 });
  }
  return out;
}

/** Fit to keep fighting: enough fuel, ammunition and health. */
function armyReady(a: Army): boolean {
  let ammo = 0;
  let ammoCap = 0;
  let hp = 0;
  let hpCap = 0;
  for (const u of a.units) {
    const st = statsOf(u.designId);
    ammo += u.ammo;
    ammoCap += st.ammoCapacity;
    hp += u.hp;
    hpCap += st.maxHp;
  }
  return fuelRange(a.units) > 45 && ammo >= ammoCap * 0.45 && hp >= hpCap * 0.5;
}

function pickTarget(
  state: CampaignState,
  factionId: string,
  x: number,
  z: number,
  strength: number,
  caution: number,
  range = Infinity,
): TargetOption | null {
  let best: TargetOption | null = null;
  let bestScore = -Infinity;
  for (const t of enemyTargets(state, factionId)) {
    const needed = t.defense * (1.25 + caution * 0.9) + 40;
    if (strength < needed) continue;
    const d = dist(x, z, t.x, t.z);
    if (d * 1.15 + 10 > range) continue; // cannot get there (and fight) on the fuel we carry
    const score = t.value * 30 - d * 0.6 - t.defense * 0.05;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function thinkMilitary(ctx: SimContext, ai: AIState): void {
  const { state } = ctx;
  const fid = ai.factionId;
  const def = FACTION_DEFS[state.factions[fid]?.defId ?? ''];
  const level = difficultyOf(state.difficulty);
  const caution = Math.max(0, (def?.ai.caution ?? 0.5) + level.aiCaution);
  const enemy = enemyFactionOf(state, fid);
  const hostile = enemy ? areHostile(state, fid, enemy) : false;
  const armies = armiesOf(state, fid);
  const bases = basesOf(state, fid);

  // --- manage field armies ---
  for (const army of armies) {
    if (!army.aiRole) army.aiRole = 'attack';
    const s = armyStrength(army);
    const lowAmmo = army.units.every((u) => {
      const st = statsOf(u.designId);
      return st.ammoCapacity > 0 && u.ammo < st.ammoCapacity * 0.25;
    });
    const weak = army.units.length <= 1 || s < 90 || lowAmmo || !armyReady(army);
    if (army.order.type === 'idle' || weak) {
      if (weak || !hostile) {
        if (bases.length) orderReturn(ctx, army.id);
        else retarget(ctx, army, s, caution);
        continue;
      }
      // continue the offensive with the next target, or go home
      if (!retarget(ctx, army, s, caution)) orderReturn(ctx, army.id);
    }
  }

  if (!hostile || bases.length === 0) return;

  // --- defence: recall field armies if a base is threatened ---
  for (const base of bases) {
    let threat = 0;
    for (const a of Object.values(state.armies)) {
      if (a.factionId === fid || !isVisibleToFaction(state, fid, a.x, a.z)) continue;
      const d = dist(a.x, a.z, base.x, base.z);
      if (d < 26 || (a.order.type === 'attack_base' && a.order.targetId === base.id)) threat += armyStrength(a);
    }
    if (threat > garrisonStrength(state, base) * 0.9) {
      for (const army of armies) {
        if (dist(army.x, army.z, base.x, base.z) < 60 && army.order.type !== 'return') orderReturn(ctx, army.id);
      }
    }
  }

  // --- offence ---
  if (state.time - ai.lastAttackLaunch < OFFENSIVE_COOLDOWN * level.offensiveCooldown) return;
  if (armies.some((a) => (a.aiRole === 'attack' || a.aiRole === 'raid') && a.order.type !== 'return')) return;
  const home = bases.slice().sort((a, b) => strengthOf(b.garrison) - strengthOf(a.garrison))[0];
  if (!home || home.garrison.length < 3) return;
  const total = strengthOf(home.garrison);
  // keep a home guard of roughly a third
  const sorted = home.garrison.slice().sort((a, b) => statsOf(b.designId).power - statsOf(a.designId).power);
  const guardIds = new Set<string>();
  let guard = 0;
  for (let i = sorted.length - 1; i >= 0 && guard < total * 0.3; i--) {
    guardIds.add(sorted[i].id);
    guard += strengthOf([sorted[i]]);
  }
  const strikeUnits = home.garrison.filter((u) => !guardIds.has(u.id));
  if (strikeUnits.length < 2) return;
  const strike = strengthOf(strikeUnits);
  const target = pickTarget(state, fid, home.x, home.z, strike, caution, fuelRange(strikeUnits));
  if (!target) return;
  if (target.target.kind !== 'building' && strikeUnits.length < 5) return;
  const army = formArmyFromGarrison(ctx, home.id, strikeUnits.map((u) => u.id));
  if (!army) return;
  army.aiRole = target.target.kind === 'building' ? 'raid' : 'attack';
  if (!orderAttack(ctx, army.id, target.target)) {
    orderReturn(ctx, army.id);
    return;
  }
  ai.lastAttackLaunch = state.time;
  ai.targetKind = target.target.kind;
  ai.targetId = target.target.id;
}

function retarget(ctx: SimContext, army: Army, strength: number, caution: number): boolean {
  const { state } = ctx;
  if (!armyReady(army)) return false;
  const t = pickTarget(state, army.factionId, army.x, army.z, strength, caution, fuelRange(army.units));
  if (!t) return false;
  if (dist(army.x, army.z, t.x, t.z) > 90) return false;
  return orderAttack(ctx, army.id, t.target);
}

/** Exposed for tests/debug. */
export function aiDebugTargets(state: CampaignState, factionId: string): { kind: string; id: string; defense: number }[] {
  return enemyTargets(state, factionId).map((t) => ({ kind: t.target.kind, id: t.target.id, defense: t.defense }));
}

