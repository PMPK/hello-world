import { angleDiff, approachAngle, clamp, dist } from '../core/math';
import { mixSeed, Rng } from '../core/rng';
import { BUILDINGS } from '../data/buildings';
import type { WeaponDef } from '../data/components';
import { statsOf } from '../units/stats';
import { astar, nearestPassable, type GridGraph } from '../world/pathfinding';
import type { Terrain } from '../world/terrain';
import { TacticalAI } from './ai';
import {
  bBlocked,
  bCell,
  bForest,
  bHeight,
  bLineOfSight,
  bSlope,
  createBattleTerrain,
  type BattleTerrain,
} from './terrain';
import {
  BATTLE_TIME_SCALE,
  MAX_UNITS_PER_SIDE,
  type BattleEvent,
  type BattleResult,
  type BattleSetup,
  type BBuilding,
  type BUnit,
  type SideIndex,
  type SideSummary,
  type TargetRef,
} from './types';

export interface BattleOptions {
  /** Sides controlled by the tactical AI. */
  aiSides: SideIndex[];
}

const ACQUIRE_INTERVAL = 0.35;
const VIS_INTERVAL = 0.25;
const EXIT_MARGIN = 22;

export function eyeHeight(u: BUnit): number {
  return u.stats.isVehicle ? 2.8 : 1.8;
}

export function isActive(u: BUnit): boolean {
  return u.alive && !u.retreated && !u.reserve;
}

/** True when the unit cannot fire any of its weapons for lack of ammunition. */
export function outOfAmmo(u: BUnit): boolean {
  if (!u.stats.weapons.length) return false;
  let min = Infinity;
  for (const w of u.stats.weapons) min = Math.min(min, w.ammoPerShot);
  return u.ammo < min;
}

/** Penetration vs armour → damage multiplier. */
export function penetrationFactor(pen: number, armor: number): number {
  if (armor <= 0 || pen >= armor) return 1;
  const r = pen / armor;
  return Math.max(0.02, r * r * 0.6);
}

/**
 * The tactical battle simulation. Pure logic (no Three.js); the renderer
 * reads `units`, `buildings` and drains `events`.
 */
export class BattleSim {
  readonly setup: BattleSetup;
  readonly terrain: BattleTerrain;
  readonly rng: Rng;
  units: BUnit[] = [];
  buildings: BBuilding[] = [];
  time = 0;
  events: BattleEvent[] = [];
  finished = false;
  winner: SideIndex | null = null;
  endReason: BattleResult['reason'] = 'eliminated';
  playerWithdrew = false;
  readonly ais: [TacticalAI | null, TacticalAI | null] = [null, null];
  readonly startPower: [number, number] = [0, 0];
  /** Units that left the field on each side's retreat. */
  private visTimer = 0;
  private endTimer = 0;
  private nextId = 1;
  private navs: Record<'foot' | 'wheeled' | 'tracked', GridGraph>;
  /** When true (no defenders in a siege), the attacker may end the battle at will. */
  readonly undefended: boolean;

  constructor(setupIn: BattleSetup, strategic: Terrain, opts: BattleOptions) {
    // private copy: deployment points may be adjusted to the terrain
    const setup: BattleSetup = JSON.parse(JSON.stringify(setupIn));
    this.setup = setup;
    this.rng = new Rng(mixSeed(setup.seed, 'battle-sim'));
    this.terrain = createBattleTerrain(strategic, setup.campaignX, setup.campaignZ, setup.seed, setup.buildings);
    const t = this.terrain;
    const mk = (mob: 'foot' | 'wheeled' | 'tracked'): GridGraph => ({
      w: t.grid,
      h: t.grid,
      cost: (i, j) => {
        const idx = j * t.grid + i;
        if (t.blocked[idx]) return Infinity;
        const f = t.forest[idx] / 255;
        const forestCost = mob === 'foot' ? 1 + f * 0.3 : mob === 'wheeled' ? 1 + f * 2.5 : 1 + f * 1.2;
        return forestCost;
      },
    });
    this.navs = { foot: mk('foot'), wheeled: mk('wheeled'), tracked: mk('tracked') };

    for (const b of setup.buildings) {
      const def = BUILDINGS[b.typeId];
      this.buildings.push({
        id: this.nextId++,
        spec: b,
        x: b.x,
        z: b.z,
        rot: b.rot,
        hp: b.state === 'destroyed' ? 0 : b.hp,
        maxHp: b.maxHp,
        radius: def.battleFootprint,
        side: b.side,
        destroyed: b.state === 'destroyed' || b.hp <= 0,
      });
    }
    for (const side of [0, 1] as SideIndex[]) this.adjustEntry(side);
    for (const side of [0, 1] as SideIndex[]) this.deploySide(side);
    for (const side of [0, 1] as SideIndex[]) {
      this.startPower[side] = this.sidePower(side, true);
    }
    for (const s of opts.aiSides) this.ais[s] = new TacticalAI(this, s);
    this.undefended = (setup.kind === 'base_assault' || setup.kind === 'outpost') && this.units.every((u) => u.side !== 1);
    this.updateVisibility();
  }

  // ---------------------------------------------------------------------------
  // Deployment
  // ---------------------------------------------------------------------------

  /** Move a deployment point inland until there is enough open ground around it. */
  private adjustEntry(side: SideIndex): void {
    const e = this.setup.sides[side].entry;
    const t = this.terrain;
    const siegeDefender = side === 1 && (this.setup.kind === 'base_assault' || this.setup.kind === 'outpost');
    if (siegeDefender) return;
    const openFrac = (x: number, z: number): number => {
      let ok = 0;
      let n = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        for (const r of [25, 55]) {
          n++;
          if (!bBlocked(t, x + Math.cos(a) * r, z + Math.sin(a) * r)) ok++;
        }
      }
      return ok / n;
    };
    const cx = t.size / 2;
    const cz = t.size / 2;
    let x = e.x;
    let z = e.z;
    for (let step = 0; step < 14 && openFrac(x, z) < 0.75; step++) {
      // slide toward the centre line of the battle
      x += (cx - x) * 0.15;
      z += (cz - z) * 0.15;
    }
    const p = this.freeSpot(x, z);
    e.x = p.x;
    e.z = p.z;
  }

  private makeUnit(side: SideIndex, specIndex: number): BUnit {
    const spec = this.setup.sides[side].units[specIndex];
    const stats = statsOf(spec.designId);
    const e = this.setup.sides[side].entry;
    const heading = Math.atan2(e.dirX, e.dirZ);
    return {
      id: this.nextId++,
      spec,
      side,
      stats,
      x: e.x,
      z: e.z,
      heading,
      turret: heading,
      speedNow: 0,
      hp: spec.hp,
      men: spec.men,
      ammo: spec.ammo,
      fuel: spec.fuel,
      alive: spec.hp > 0 && spec.men > 0,
      retreated: false,
      reserve: false,
      order: { type: 'idle' },
      path: [],
      target: null,
      focus: null,
      weaponCd: stats.weapons.map(() => this.rng.range(0, 1.5)),
      seenBy: [side === 0, side === 1],
      lastFired: -99,
      lastHit: -99,
      suppression: 0,
      cover: 0,
      inForest: false,
      nextAcquire: this.rng.range(0, ACQUIRE_INTERVAL),
      ammoSpent: 0,
      fuelSpent: 0,
      kills: 0,
      task: '',
      menStart: spec.men,
    };
  }

  private deploySide(side: SideIndex): void {
    const setup = this.setup.sides[side];
    const order = setup.units
      .map((s, i) => ({ i, fam: statsOf(s.designId).family }))
      // tanks first, then infantry, then jeeps (deployment rows)
      .sort((a, b) => famRank(a.fam) - famRank(b.fam) || a.i - b.i);
    const deployed: BUnit[] = [];
    for (const { i } of order) {
      const u = this.makeUnit(side, i);
      if (!u.alive) {
        u.reserve = false;
        u.alive = false;
        this.units.push(u);
        continue;
      }
      if (deployed.length >= MAX_UNITS_PER_SIDE) {
        u.reserve = true;
        this.units.push(u);
        continue;
      }
      deployed.push(u);
      this.units.push(u);
    }
    const siegeDefender = side === 1 && (this.setup.kind === 'base_assault' || this.setup.kind === 'outpost');
    if (siegeDefender) this.placeDefenders(deployed);
    else this.placeInRows(side, deployed);
  }

  private placeInRows(side: SideIndex, units: BUnit[]): void {
    const e = this.setup.sides[side].entry;
    const px = -e.dirZ;
    const pz = e.dirX;
    const rows: Record<string, BUnit[]> = { tank: [], infantry: [], light_vehicle: [] };
    for (const u of units) rows[u.stats.family].push(u);
    const rowDepth: Record<string, number> = { tank: 0, infantry: -32, light_vehicle: -62 };
    for (const fam of Object.keys(rows)) {
      const list = rows[fam];
      const spacing = fam === 'infantry' ? 20 : 24;
      list.forEach((u, k) => {
        const lateral = (k - (list.length - 1) / 2) * spacing;
        const x = e.x + px * lateral + e.dirX * rowDepth[fam];
        const z = e.z + pz * lateral + e.dirZ * rowDepth[fam];
        const p = this.freeSpot(x, z);
        u.x = p.x;
        u.z = p.z;
      });
    }
  }

  private placeDefenders(units: BUnit[]): void {
    const e = this.setup.sides[1].entry;
    const atk = this.setup.sides[0].entry;
    // attack axis: from centre toward the attacker
    const ax = atk.x - e.x;
    const az = atk.z - e.z;
    const al = Math.hypot(ax, az) || 1;
    const dx = ax / al;
    const dz = az / al;
    const important = this.buildings
      .filter((b) => b.side === 1 && !b.destroyed)
      .sort((a, b) => BUILDINGS[b.spec.typeId].importance - BUILDINGS[a.spec.typeId].importance);
    units.forEach((u, k) => {
      let x: number;
      let z: number;
      if (important.length > 0 && u.stats.family === 'infantry') {
        // infantry hug buildings on the threatened side
        const b = important[k % important.length];
        const off = b.radius + 10;
        const ang = Math.atan2(dx, dz) + (this.rng.next() - 0.5) * 1.6;
        x = b.x + Math.sin(ang) * off;
        z = b.z + Math.cos(ang) * off;
      } else if (u.stats.family === 'tank') {
        const lat = (k % 5) - 2;
        x = e.x + dx * 40 + -dz * lat * 45;
        z = e.z + dz * 40 + dx * lat * 45;
      } else {
        const ang = this.rng.range(0, Math.PI * 2);
        x = e.x + Math.cos(ang) * 50;
        z = e.z + Math.sin(ang) * 50;
      }
      const p = this.freeSpot(x, z);
      u.x = p.x;
      u.z = p.z;
      u.heading = Math.atan2(dx, dz);
      u.turret = u.heading;
    });
  }

  /** Nearest unblocked position to (x, z). */
  freeSpot(x: number, z: number): { x: number; z: number } {
    const t = this.terrain;
    x = clamp(x, 12, t.size - 12);
    z = clamp(z, 12, t.size - 12);
    if (!bBlocked(t, x, z)) return { x, z };
    const i = Math.floor(x / t.cell);
    const j = Math.floor(z / t.cell);
    const p = nearestPassable(this.navs.foot, i, j, 40);
    if (!p) return { x, z };
    return { x: (p.i + 0.5) * t.cell, z: (p.j + 0.5) * t.cell };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  unitById(id: number): BUnit | undefined {
    return this.units.find((u) => u.id === id);
  }

  buildingById(id: number): BBuilding | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  activeUnits(side: SideIndex): BUnit[] {
    return this.units.filter((u) => u.side === side && isActive(u));
  }

  sidePower(side: SideIndex, includeReserves = false): number {
    let p = 0;
    for (const u of this.units) {
      if (u.side !== side || !u.alive || u.retreated) continue;
      if (u.reserve && !includeReserves) continue;
      p += u.stats.power * (u.stats.maxHp > 0 ? u.hp / u.stats.maxHp : 1);
    }
    return p;
  }

  targetPos(t: TargetRef): { x: number; z: number } | null {
    if (t.kind === 'unit') {
      const u = this.unitById(t.id);
      return u && isActive(u) ? { x: u.x, z: u.z } : null;
    }
    const b = this.buildingById(t.id);
    return b && !b.destroyed ? { x: b.x, z: b.z } : null;
  }

  targetValid(u: BUnit, t: TargetRef | null): boolean {
    if (!t) return false;
    if (t.kind === 'unit') {
      const e = this.unitById(t.id);
      return !!e && isActive(e) && e.side !== u.side;
    }
    const b = this.buildingById(t.id);
    return !!b && !b.destroyed && b.side !== u.side;
  }

  maxRange(u: BUnit): number {
    let r = 0;
    for (const w of u.stats.weapons) r = Math.max(r, w.range);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Orders (used by the player UI and the tactical AI)
  // ---------------------------------------------------------------------------

  orderMove(ids: number[], x: number, z: number, attackMove: boolean): void {
    const list = ids.map((id) => this.unitById(id)).filter((u): u is BUnit => !!u && isActive(u));
    if (!list.length) return;
    let cx = 0;
    let cz = 0;
    for (const u of list) {
      cx += u.x;
      cz += u.z;
    }
    cx /= list.length;
    cz /= list.length;
    for (const u of list) {
      // keep the group's shape, compressed
      let ox = (u.x - cx) * 0.55;
      let oz = (u.z - cz) * 0.55;
      const ol = Math.hypot(ox, oz);
      const maxOff = 18 + list.length * 3;
      if (ol > maxOff) {
        ox *= maxOff / ol;
        oz *= maxOff / ol;
      }
      if (list.length === 1) {
        ox = 0;
        oz = 0;
      }
      const dest = this.freeSpot(x + ox, z + oz);
      u.order = { type: 'move', x: dest.x, z: dest.z, attackMove };
      u.target = null;
      this.planPath(u, dest.x, dest.z);
    }
  }

  orderAttack(ids: number[], target: TargetRef): void {
    for (const id of ids) {
      const u = this.unitById(id);
      if (!u || !isActive(u) || !this.targetValid(u, target)) continue;
      u.order = { type: 'attack', target };
      u.target = target;
      u.path = [];
    }
  }

  orderHold(ids: number[]): void {
    for (const id of ids) {
      const u = this.unitById(id);
      if (!u || !isActive(u)) continue;
      u.order = { type: 'hold' };
      u.path = [];
    }
  }

  orderStop(ids: number[]): void {
    for (const id of ids) {
      const u = this.unitById(id);
      if (!u || !isActive(u)) continue;
      u.order = { type: 'idle' };
      u.path = [];
      u.target = null;
    }
  }

  orderRetreat(ids: number[]): void {
    for (const id of ids) {
      const u = this.unitById(id);
      if (!u || !isActive(u)) continue;
      u.order = { type: 'retreat' };
      const exit = this.exitPoint(u.side, u.x, u.z);
      this.planPath(u, exit.x, exit.z);
    }
  }

  /** The map-edge point a side retreats to. */
  exitPoint(side: SideIndex, fromX: number, fromZ: number): { x: number; z: number } {
    const e = this.setup.sides[side].entry;
    // move against the facing direction until the map edge
    const dx = -e.dirX;
    const dz = -e.dirZ;
    const s = this.terrain.size;
    let tMax = Infinity;
    if (dx > 1e-6) tMax = Math.min(tMax, (s - 6 - fromX) / dx);
    if (dx < -1e-6) tMax = Math.min(tMax, (6 - fromX) / dx);
    if (dz > 1e-6) tMax = Math.min(tMax, (s - 6 - fromZ) / dz);
    if (dz < -1e-6) tMax = Math.min(tMax, (6 - fromZ) / dz);
    if (!Number.isFinite(tMax)) tMax = 0;
    return this.freeSpot(fromX + dx * tMax, fromZ + dz * tMax);
  }

  /** Straight path when clear, otherwise A* on the battle grid. */
  planPath(u: BUnit, x: number, z: number): void {
    const t = this.terrain;
    if (this.lineClear(u, u.x, u.z, x, z)) {
      u.path = [{ x, z }];
      return;
    }
    const g = this.navs[u.stats.mobility];
    const si = Math.floor(u.x / t.cell);
    const sj = Math.floor(u.z / t.cell);
    const gi = Math.floor(x / t.cell);
    const gj = Math.floor(z / t.cell);
    const start = nearestPassable(g, si, sj, 4);
    const goal = nearestPassable(g, gi, gj, 8);
    if (!start || !goal) {
      u.path = [];
      return;
    }
    const cells = astar(g, start.i, start.j, goal.i, goal.j, 1, 40000);
    if (!cells) {
      u.path = [];
      return;
    }
    // light smoothing: keep every 3rd waypoint + end
    const pts: { x: number; z: number }[] = [];
    for (let k = 2; k < cells.length; k += 3) {
      const c = cells[k];
      pts.push({ x: ((c % t.grid) + 0.5) * t.cell, z: (Math.floor(c / t.grid) + 0.5) * t.cell });
    }
    pts.push({ x, z });
    u.path = pts;
  }

  private lineClear(u: BUnit, ax: number, az: number, bx: number, bz: number): boolean {
    const t = this.terrain;
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(d / (t.cell * 0.5));
    let forest = 0;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const idx = bCell(t, ax + (bx - ax) * f, az + (bz - az) * f);
      if (t.blocked[idx]) return false;
      forest += t.forest[idx];
    }
    // wheeled vehicles avoid crossing big forests when a path exists
    if (u.stats.mobility === 'wheeled' && forest / 255 > 6) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Simulation
  // ---------------------------------------------------------------------------

  /** Advance by dt seconds (internally sub-stepped). */
  step(dt: number): void {
    if (this.finished) return;
    let remaining = dt;
    while (remaining > 1e-6 && !this.finished) {
      const h = Math.min(0.1, remaining);
      this.substep(h);
      remaining -= h;
    }
  }

  private substep(dt: number): void {
    this.time += dt;
    for (const ai of this.ais) ai?.update(dt);

    this.visTimer -= dt;
    if (this.visTimer <= 0) {
      this.visTimer = VIS_INTERVAL;
      this.updateVisibility();
    }

    for (const u of this.units) {
      if (!isActive(u)) continue;
      this.updateOrder(u);
      if (this.time >= u.nextAcquire) {
        u.nextAcquire = this.time + ACQUIRE_INTERVAL;
        this.acquire(u);
      }
      this.move(u, dt);
      this.fire(u, dt);
      u.suppression = Math.max(0, u.suppression - 0.14 * dt);
    }
    this.separate();
    this.deployReserves();

    this.endTimer -= dt;
    if (this.endTimer <= 0) {
      this.endTimer = 0.5;
      this.checkEnd();
    }
  }

  private updateOrder(u: BUnit): void {
    const o = u.order;
    if (o.type === 'attack') {
      if (!this.targetValid(u, o.target)) {
        u.order = { type: 'idle' };
        u.path = [];
        u.target = null;
        return;
      }
      const p = this.targetPos(o.target)!;
      const d = dist(u.x, u.z, p.x, p.z);
      const range = this.engageRange(u, o.target);
      const visible = o.target.kind === 'building' || this.unitById(o.target.id)!.seenBy[u.side];
      if (d > range * 0.92 || !visible) {
        // close in
        const last = u.path[u.path.length - 1];
        if (!last || dist(last.x, last.z, p.x, p.z) > Math.max(25, range * 0.5) || u.path.length === 0) {
          const k = Math.max(0, (d - range * 0.75) / Math.max(d, 1));
          this.planPath(u, u.x + (p.x - u.x) * k, u.z + (p.z - u.z) * k);
        }
      } else {
        u.path = [];
      }
    } else if (o.type === 'retreat') {
      const s = this.terrain.size;
      const exit = this.exitPoint(u.side, u.x, u.z);
      const nearEdge = u.x < EXIT_MARGIN || u.z < EXIT_MARGIN || u.x > s - EXIT_MARGIN || u.z > s - EXIT_MARGIN;
      // leave the field at the map edge, or at the reachable exit point when terrain blocks the edge
      if (nearEdge || dist(u.x, u.z, exit.x, exit.z) < 14) {
        u.retreated = true;
        u.path = [];
        return;
      }
      if (u.path.length === 0) {
        this.planPath(u, exit.x, exit.z);
        if (u.path.length === 0 && u.stats.fuelCapacity > 0 && u.fuel <= 0) {
          // immobilised vehicles are abandoned; the crew slips away
          this.damageUnit(u, u.hp + 1, null);
        } else if (u.path.length === 0) {
          u.retreated = true;
        }
      }
    }
  }

  /** Range at which a unit stops to engage a target with its best weapon. */
  engageRange(u: BUnit, t: TargetRef): number {
    let r = 0;
    for (const w of u.stats.weapons) {
      if (!this.weaponCanEngage(u, w, t)) continue;
      r = Math.max(r, w.range);
    }
    return r || this.maxRange(u);
  }

  weaponCanEngage(_u: BUnit, w: WeaponDef, t: TargetRef): boolean {
    if (t.kind === 'building') return w.vsStructure > 0.12 || w.antiVehicleOnly === true;
    const e = this.unitById(t.id);
    if (!e) return false;
    if (w.antiVehicleOnly && !e.stats.isVehicle) return false;
    // small arms vs main battle tanks is pointless
    if (e.stats.family === 'tank' && penetrationFactor(w.penetration, e.stats.armor * 0.35) < 0.05) return false;
    return true;
  }

  /** Expected damage per second of unit u against e (rough). */
  effectiveness(u: BUnit, e: BUnit): number {
    let s = 0;
    for (const w of u.stats.weapons) {
      if (w.antiVehicleOnly && !e.stats.isVehicle) continue;
      const pen = penetrationFactor(w.penetration, e.stats.armor * 0.6);
      const vsInf = e.stats.isVehicle ? 1 : w.vsInfantry;
      const men = w.scalesWithMen ? u.men / Math.max(1, u.stats.crew) : 1;
      s += w.damage * w.rof * w.accuracy * pen * vsInf * men;
    }
    return s;
  }

  private acquire(u: BUnit): void {
    if (u.order.type === 'attack') {
      u.target = u.order.target;
      return;
    }
    if (u.order.type === 'retreat') {
      u.target = null;
      return;
    }
    const range = this.maxRange(u);
    let best: TargetRef | null = null;
    let bestScore = 0;
    for (const e of this.units) {
      if (e.side === u.side || !isActive(e) || !e.seenBy[u.side]) continue;
      const d = dist(u.x, u.z, e.x, e.z);
      if (d > range) continue;
      const eff = this.effectiveness(u, e);
      if (eff <= 0.01) continue;
      let score = (eff / Math.max(30, e.hp)) * (0.6 + e.stats.power / 300) * (1.4 - d / (range * 1.6));
      if (u.target && u.target.kind === 'unit' && u.target.id === e.id) score *= 1.35; // persistence
      if (u.focus && u.focus.kind === 'unit' && u.focus.id === e.id) score *= 1.8;
      if (score > bestScore) {
        if (!bLineOfSight(this.terrain, u.x, u.z, eyeHeight(u), e.x, e.z, eyeHeight(e) * 0.7)) continue;
        bestScore = score;
        best = { kind: 'unit', id: e.id };
      }
    }
    // Structures are only engaged on explicit orders (or AI focus), so bases can be captured intact.
    if (!best && u.focus && this.targetValid(u, u.focus) && u.focus.kind === 'building') {
      const p = this.targetPos(u.focus)!;
      if (dist(u.x, u.z, p.x, p.z) < range + 20) best = u.focus;
    }
    u.target = best;
  }

  private terrainSpeed(u: BUnit, x: number, z: number): number {
    const f = bForest(this.terrain, x, z);
    const slope = bSlope(this.terrain, x, z);
    let k = 1;
    if (u.stats.mobility === 'foot') k *= 1 - f * 0.25;
    else if (u.stats.mobility === 'wheeled') k *= 1 - f * 0.6;
    else k *= 1 - f * 0.4;
    k *= clamp(1 - slope * 0.7, 0.35, 1);
    return k;
  }

  private move(u: BUnit, dt: number): void {
    const t = this.terrain;
    const cell = bCell(t, u.x, u.z);
    u.inForest = t.forest[cell] > 100;
    let cover = u.inForest ? 0.35 : 0;
    if (!u.stats.isVehicle) {
      for (const b of this.buildings) {
        if (b.side === u.side && dist(u.x, u.z, b.x, b.z) < b.radius + 18) {
          cover = Math.max(cover, 0.3);
          break;
        }
      }
    }
    u.cover = cover;

    // stop to fight when attack-moving (or for infantry under an attack order in range)
    const o = u.order;
    let wantsMove = u.path.length > 0;
    if (o.type === 'move' && o.attackMove && u.target && this.targetValid(u, u.target)) wantsMove = false;
    if (o.type === 'hold') wantsMove = false;
    if (!wantsMove) {
      u.speedNow = 0;
      if (u.target) this.faceTarget(u, dt);
      return;
    }
    if (u.stats.fuelCapacity > 0 && u.fuel <= 0) {
      u.speedNow = 0;
      u.path = [];
      return;
    }
    const wp = u.path[0];
    const dx = wp.x - u.x;
    const dz = wp.z - u.z;
    const d = Math.hypot(dx, dz);
    const last = u.path.length === 1;
    if (d < (last ? 2.5 : 7)) {
      u.path.shift();
      if (u.path.length === 0) {
        u.speedNow = 0;
        if (o.type === 'move') u.order = { type: 'idle' };
      }
      return;
    }
    const desired = Math.atan2(dx, dz);
    let speed = u.stats.speed * this.terrainSpeed(u, u.x, u.z) * (1 - u.suppression * 0.4);
    let mx: number;
    let mz: number;
    if (u.stats.isVehicle) {
      const turnRate = u.stats.family === 'tank' ? 1.1 : 2.4;
      u.heading = approachAngle(u.heading, desired, turnRate * dt);
      const off = Math.abs(angleDiff(u.heading, desired));
      if (off > 0.8) speed *= 0.12;
      else if (off > 0.3) speed *= 0.6;
      mx = Math.sin(u.heading);
      mz = Math.cos(u.heading);
    } else {
      u.heading = approachAngle(u.heading, desired, 6 * dt);
      mx = dx / d;
      mz = dz / d;
    }
    const stepLen = Math.min(d, speed * dt);
    let nx = u.x + mx * stepLen;
    let nz = u.z + mz * stepLen;
    if (bBlocked(t, nx, nz)) {
      // slide along obstacles
      if (!bBlocked(t, nx, u.z)) nz = u.z;
      else if (!bBlocked(t, u.x, nz)) nx = u.x;
      else {
        nx = u.x;
        nz = u.z;
        // repath around
        const end = u.path[u.path.length - 1];
        if (end) this.planPath(u, end.x, end.z);
      }
    }
    const moved = Math.hypot(nx - u.x, nz - u.z);
    u.x = nx;
    u.z = nz;
    u.speedNow = moved / Math.max(dt, 1e-6);
    if (u.stats.fuelPerMetre > 0 && moved > 0) {
      const f = Math.min(u.fuel, u.stats.fuelPerMetre * moved);
      u.fuel -= f;
      u.fuelSpent += f;
    }
    if (!u.stats.isVehicle && u.target) this.faceTarget(u, dt);
    else if (u.stats.isVehicle) this.faceTarget(u, dt);
  }

  private faceTarget(u: BUnit, dt: number): void {
    const p = u.target ? this.targetPos(u.target) : null;
    if (!p) {
      if (u.stats.isVehicle) u.turret = approachAngle(u.turret, u.heading, 1.2 * dt);
      return;
    }
    const bearing = Math.atan2(p.x - u.x, p.z - u.z);
    if (u.stats.isVehicle) {
      const rate = u.stats.family === 'tank' ? 1.3 : 3.5;
      u.turret = approachAngle(u.turret, bearing, rate * dt);
    } else if (u.speedNow < 0.1) {
      u.heading = approachAngle(u.heading, bearing, 5 * dt);
    }
  }

  private separate(): void {
    const list = this.units.filter(isActive);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const minD = (a.stats.size + b.stats.size) * 0.62;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        const wa = a.stats.isVehicle && !b.stats.isVehicle ? 0.2 : 0.5;
        const wb = 1 - wa;
        const ax = a.x - nx * push * wa * 2;
        const az = a.z - nz * push * wa * 2;
        const bx = b.x + nx * push * wb * 2;
        const bz = b.z + nz * push * wb * 2;
        if (!bBlocked(this.terrain, ax, az)) {
          a.x = ax;
          a.z = az;
        }
        if (!bBlocked(this.terrain, bx, bz)) {
          b.x = bx;
          b.z = bz;
        }
      }
    }
  }

  private deployReserves(): void {
    for (const side of [0, 1] as SideIndex[]) {
      const active = this.units.filter((u) => u.side === side && isActive(u)).length;
      if (active >= MAX_UNITS_PER_SIDE) continue;
      const next = this.units.find((u) => u.side === side && u.reserve && u.alive);
      if (!next) continue;
      const e = this.setup.sides[side].entry;
      const edge = this.exitPoint(side, e.x, e.z);
      const p = this.freeSpot(edge.x + e.dirX * 30 + this.rng.range(-30, 30), edge.z + e.dirZ * 30 + this.rng.range(-30, 30));
      next.x = p.x;
      next.z = p.z;
      next.reserve = false;
      next.order = { type: 'move', x: e.x, z: e.z, attackMove: true };
      this.planPath(next, e.x, e.z);
    }
  }

  // ---------------------------------------------------------------------------
  // Combat
  // ---------------------------------------------------------------------------

  private weaponTarget(u: BUnit, w: WeaponDef): TargetRef | null {
    if (u.target && this.targetValid(u, u.target) && this.weaponCanEngage(u, w, u.target)) {
      const p = this.targetPos(u.target)!;
      const extra = u.target.kind === 'building' ? (this.buildingById(u.target.id)?.radius ?? 0) : 0;
      if (dist(u.x, u.z, p.x, p.z) - extra <= w.range) return u.target;
    }
    // secondary weapons pick their own nearby target (e.g. coax MG vs infantry)
    if (u.order.type === 'retreat') return null;
    let best: BUnit | null = null;
    let bd = w.range;
    for (const e of this.units) {
      if (e.side === u.side || !isActive(e) || !e.seenBy[u.side]) continue;
      if (!this.weaponCanEngage(u, w, { kind: 'unit', id: e.id })) continue;
      const d = dist(u.x, u.z, e.x, e.z);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return best ? { kind: 'unit', id: best.id } : null;
  }

  private fire(u: BUnit, dt: number): void {
    const moving = u.speedNow > 0.5;
    for (let k = 0; k < u.stats.weapons.length; k++) {
      u.weaponCd[k] -= dt;
      if (u.weaponCd[k] > 0) continue;
      const w = u.stats.weapons[k];
      if (u.ammo < w.ammoPerShot) continue;
      // infantry cannot fire effectively while moving under a plain move order
      if (moving && !u.stats.isVehicle && u.order.type === 'move' && !u.order.attackMove) continue;
      const t = this.weaponTarget(u, w);
      if (!t) continue;
      const p = this.targetPos(t)!;
      // turret alignment for main guns
      if (u.stats.isVehicle && (w.weaponClass === 'cannon' || w.weaponClass === 'hmg')) {
        const bearing = Math.atan2(p.x - u.x, p.z - u.z);
        if (Math.abs(angleDiff(u.turret, bearing)) > 0.15) {
          u.weaponCd[k] = 0.1;
          continue;
        }
      }
      u.weaponCd[k] = (1 / w.rof) * this.rng.range(0.85, 1.15);
      u.ammo -= w.ammoPerShot;
      u.ammoSpent += w.ammoPerShot;
      u.lastFired = this.time;
      this.resolveShot(u, w, t, p, moving);
    }
  }

  private resolveShot(u: BUnit, w: WeaponDef, t: TargetRef, p: { x: number; z: number }, moving: boolean): void {
    const d = dist(u.x, u.z, p.x, p.z);
    const fromY = bHeight(this.terrain, u.x, u.z) + eyeHeight(u);
    let toY = bHeight(this.terrain, p.x, p.z) + 1.2;
    let hitChance = w.accuracy * (1 + u.stats.accuracyBonus);
    hitChance *= 1 - 0.45 * Math.pow(Math.min(1, d / w.range), 2);
    if (moving) hitChance *= w.movingAccuracy;
    hitChance *= 1 - 0.5 * u.suppression;
    const heightAdv = fromY - toY;
    if (heightAdv > 6) hitChance *= 1.12;
    let target: BUnit | undefined;
    if (t.kind === 'unit') {
      target = this.unitById(t.id)!;
      toY = bHeight(this.terrain, target.x, target.z) + (target.stats.isVehicle ? 1.6 : 0.9);
      if (!target.stats.isVehicle && target.inForest) hitChance *= 0.62;
      if (target.stats.family === 'tank') hitChance *= 1.15;
      if (target.stats.family === 'light_vehicle' && target.speedNow > 6) hitChance *= 0.72;
    } else {
      hitChance = Math.min(0.95, hitChance * 1.6);
    }
    const hit = this.rng.next() < clamp(hitChance, 0.03, 0.95);
    const travel = d / w.projectileSpeed;
    let tx = p.x;
    let tz = p.z;
    if (!hit) {
      const spread = 4 + d * 0.04;
      tx += this.rng.range(-spread, spread);
      tz += this.rng.range(-spread, spread);
    }
    this.events.push({
      type: 'shot',
      shooter: u.id,
      weapon: w.weaponClass,
      fromX: u.x,
      fromY,
      fromZ: u.z,
      toX: tx,
      toY: hit ? toY : bHeight(this.terrain, tx, tz) + 0.3,
      toZ: tz,
      hit,
      travel,
    });
    const heavy = w.weaponClass === 'cannon' || w.weaponClass === 'at_rocket';
    if (heavy) {
      this.events.push({
        type: 'explosion',
        x: tx,
        y: hit ? toY : bHeight(this.terrain, tx, tz),
        z: tz,
        size: w.weaponClass === 'cannon' ? 1 : 0.7,
        delay: travel,
      });
    }

    if (!hit && heavy) this.collateral(tx, tz, w.damage * w.vsStructure * 0.5);
    if (t.kind === 'building') {
      if (!hit) return;
      const b = this.buildingById(t.id)!;
      const dmg = w.damage * w.vsStructure * (w.scalesWithMen ? u.men / Math.max(1, u.stats.crew) : 1);
      this.damageBuilding(b, dmg);
      return;
    }
    if (!target) return;
    if (!target.stats.isVehicle) {
      // suppression from incoming fire, hit or miss
      target.suppression = Math.min(1, target.suppression + w.suppression * (hit ? 1 : 0.5) * (1 - target.cover));
    }
    if (!hit) return;
    let dmg = w.damage * (w.scalesWithMen ? u.men / Math.max(1, u.stats.crew) : 1);
    if (target.stats.isVehicle) {
      // directional armour: front 100%, side 55%, rear 35%
      const incoming = Math.atan2(u.x - target.x, u.z - target.z);
      const rel = Math.abs(angleDiff(target.heading, incoming));
      const armorMul = rel < Math.PI / 4 ? 1 : rel < (3 * Math.PI) / 4 ? 0.55 : 0.35;
      dmg *= penetrationFactor(w.penetration, target.stats.armor * armorMul);
    } else {
      dmg *= w.vsInfantry * (1 - target.cover);
    }
    this.damageUnit(target, dmg, u);
  }

  damageUnit(target: BUnit, dmg: number, from: BUnit | null): void {
    if (!target.alive) return;
    target.hp -= dmg;
    target.lastHit = this.time;
    if (!target.stats.isVehicle) {
      const men = Math.max(0, Math.ceil(target.hp / target.stats.hpPerMan - 1e-6));
      for (let k = men; k < target.men; k++) this.events.push({ type: 'casualty', id: target.id, x: target.x, z: target.z });
      target.men = Math.min(target.men, men);
    }
    if (target.hp <= 0 || target.men <= 0) {
      target.hp = 0;
      target.alive = false;
      target.path = [];
      if (!target.stats.isVehicle) target.men = 0;
      if (from) from.kills++;
      this.events.push({ type: 'unit_destroyed', id: target.id, x: target.x, z: target.z, vehicle: target.stats.isVehicle });
      if (target.stats.isVehicle) {
        this.events.push({ type: 'explosion', x: target.x, y: bHeight(this.terrain, target.x, target.z) + 1.5, z: target.z, size: 1.8, delay: 0.05 });
      }
    }
  }

  /** Stray heavy rounds damage structures they land on. */
  private collateral(x: number, z: number, dmg: number): void {
    for (const b of this.buildings) {
      if (b.destroyed) continue;
      if (dist(x, z, b.x, b.z) < b.radius * 0.9) this.damageBuilding(b, dmg);
    }
  }

  damageBuilding(b: BBuilding, dmg: number): void {
    if (b.destroyed) return;
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.hp = 0;
      b.destroyed = true;
      this.events.push({ type: 'building_destroyed', id: b.id, x: b.x, z: b.z });
      this.events.push({ type: 'explosion', x: b.x, y: bHeight(this.terrain, b.x, b.z) + 4, z: b.z, size: 3, delay: 0 });
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  updateVisibility(): void {
    for (const side of [0, 1] as SideIndex[]) {
      const eyes = this.units.filter((u) => u.side === side && isActive(u));
      const posts = this.buildings.filter((b) => b.side === side && !b.destroyed);
      for (const e of this.units) {
        if (e.side === side) {
          e.seenBy[side] = true;
          continue;
        }
        if (!isActive(e)) {
          e.seenBy[side] = false;
          continue;
        }
        let conceal = 1;
        if (!e.stats.isVehicle) {
          conceal = e.inForest ? 0.42 : e.speedNow < 0.3 ? 0.9 : 1;
        } else if (e.inForest) {
          conceal = 0.8;
        }
        if (this.time - e.lastFired < 4) conceal = Math.max(conceal, 0.95);
        let seen = false;
        for (const f of eyes) {
          const spotBoost = 1 + f.stats.spotting * (1 - conceal);
          const r = f.stats.vision * conceal * spotBoost;
          const dx = e.x - f.x;
          const dz = e.z - f.z;
          if (dx * dx + dz * dz > r * r) continue;
          if (!bLineOfSight(this.terrain, f.x, f.z, eyeHeight(f), e.x, e.z, eyeHeight(e))) continue;
          seen = true;
          break;
        }
        if (!seen) {
          for (const b of posts) {
            const r = 150 * conceal;
            if (dist(b.x, b.z, e.x, e.z) <= r) {
              seen = true;
              break;
            }
          }
        }
        e.seenBy[side] = seen;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // End of battle
  // ---------------------------------------------------------------------------

  private remaining(side: SideIndex): number {
    return this.units.filter((u) => u.side === side && u.alive && !u.retreated).length;
  }

  private checkEnd(): void {
    if (this.finished) return;
    const a = this.remaining(0);
    const d = this.remaining(1);
    if (this.undefended) {
      if (a === 0) this.finish(1, 'retreat');
      // otherwise the attacker decides when to end (player) or AI ends after a short while
      else if (this.ais[0] && this.time > 20) this.finish(0, 'undefended');
      return;
    }
    if (a === 0 && d === 0) {
      this.finish(1, 'eliminated');
    } else if (a === 0) {
      const anyRetreat = this.units.some((u) => u.side === 0 && u.retreated);
      this.finish(1, anyRetreat ? 'retreat' : 'eliminated');
    } else if (d === 0) {
      const anyRetreat = this.units.some((u) => u.side === 1 && u.retreated);
      this.finish(0, anyRetreat ? 'retreat' : 'eliminated');
    } else if (this.time >= this.setup.timeLimit) {
      if (this.setup.kind === 'field') {
        this.finish(null, 'timeout');
        return;
      }
      // Siege at nightfall: whoever holds the objective area keeps it.
      const objective = this.objectivePoint();
      const near = (side: SideIndex): number =>
        this.units.filter((u) => u.side === side && u.alive && !u.retreated && !u.reserve && dist(u.x, u.z, objective.x, objective.z) < 170).length;
      this.finish(near(0) > 0 && near(1) === 0 ? 0 : 1, 'timeout');
    }
  }

  /** Centre of the fought-over objective (base centre / outpost / map centre). */
  objectivePoint(): { x: number; z: number } {
    const id = this.setup.objectiveBuildingId;
    const ob = id ? this.buildings.find((b) => b.spec.campaignId === id) : undefined;
    if (ob) return { x: ob.x, z: ob.z };
    return { x: this.terrain.size / 2, z: this.terrain.size / 2 };
  }

  /** True when the side has no enemies left that could fight (player may end battle). */
  canSecure(side: SideIndex): boolean {
    const other: SideIndex = side === 0 ? 1 : 0;
    return this.remaining(other) === 0 || (this.undefended && side === 0);
  }

  finish(winner: SideIndex | null, reason: BattleResult['reason']): void {
    if (this.finished) return;
    this.finished = true;
    this.winner = winner;
    this.endReason = reason;
  }

  /** Player (or AI) gives up the field. Engaged units may be caught during the withdrawal. */
  withdraw(side: SideIndex): void {
    if (this.finished) return;
    const other: SideIndex = side === 0 ? 1 : 0;
    const enemyPresent = this.remaining(other) > 0;
    for (const u of this.units) {
      if (u.side !== side || !u.alive || u.retreated || u.reserve) continue;
      const engaged = this.time - u.lastHit < 8 || this.time - u.lastFired < 8;
      if (enemyPresent && engaged) {
        if (u.stats.isVehicle) {
          if (this.rng.next() < 0.25) this.damageUnit(u, u.hp + 1, null);
        } else if (this.rng.next() < 0.6) {
          this.damageUnit(u, u.stats.hpPerMan * this.rng.int(1, 2), null);
        }
      }
      if (u.alive) u.retreated = true;
    }
    if (side === this.setup.playerSide) this.playerWithdrew = true;
    this.finish(other, 'withdrawal');
  }

  /** End a battle the attacker has won/secured (player "End battle" button). */
  secure(side: SideIndex): void {
    if (this.finished || !this.canSecure(side)) return;
    this.finish(side, this.undefended ? 'undefended' : 'eliminated');
  }

  computeResult(): BattleResult {
    const crewRng = new Rng(mixSeed(this.setup.seed, 'crew'));
    const sides: [SideSummary, SideSummary] = [0, 1].map((s) => ({
      factionId: this.setup.sides[s].factionId,
      unitsStart: 0,
      unitsLost: 0,
      menStart: 0,
      menKilled: 0,
      crewSurvivors: 0,
      vehiclesLost: 0,
      squadsLost: 0,
      ammoSpent: 0,
      fuelSpent: 0,
      buildingsLost: 0,
    })) as [SideSummary, SideSummary];
    const units = this.units.map((u) => {
      const s = sides[u.side];
      s.unitsStart++;
      s.menStart += u.menStart;
      s.ammoSpent += u.ammoSpent;
      s.fuelSpent += u.fuelSpent;
      let status: 'alive' | 'destroyed' | 'retreated' = u.alive ? (u.retreated ? 'retreated' : 'alive') : 'destroyed';
      let men = u.men;
      if (status === 'destroyed') {
        s.unitsLost++;
        if (u.stats.isVehicle) {
          s.vehiclesLost++;
          const survivors = Math.round(u.menStart * crewRng.range(0.2, 0.7));
          s.crewSurvivors += survivors;
          s.menKilled += u.menStart - survivors;
        } else {
          s.squadsLost++;
          s.menKilled += u.menStart;
        }
        men = 0;
      } else {
        s.menKilled += Math.max(0, u.menStart - u.men);
      }
      if (status === 'alive' && u.reserve) status = 'alive';
      return {
        campaignId: u.spec.campaignId,
        origin: u.spec.origin,
        side: u.side,
        status,
        hp: Math.max(0, u.hp),
        men,
        ammo: Math.max(0, u.ammo),
        fuel: Math.max(0, u.fuel),
      };
    });
    const buildings = this.buildings.map((b) => {
      if (b.destroyed && b.spec.state !== 'destroyed') sides[b.side].buildingsLost++;
      return { campaignId: b.spec.campaignId, hp: Math.max(0, b.hp), destroyed: b.destroyed };
    });
    return {
      battleId: this.setup.id,
      kind: this.setup.kind,
      winner: this.winner,
      reason: this.endReason,
      durationSeconds: this.time,
      campaignHours: (this.time * BATTLE_TIME_SCALE) / 3600,
      units,
      buildings,
      sides,
      playerWithdrew: this.playerWithdrew,
    };
  }

  /** Drain pending render events. */
  takeEvents(): BattleEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

function famRank(f: string): number {
  return f === 'tank' ? 0 : f === 'infantry' ? 1 : 2;
}
