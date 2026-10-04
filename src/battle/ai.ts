import { clamp, dist } from '../core/math';
import { BUILDINGS } from '../data/buildings';
import { difficultyOf } from '../data/difficulty';
import type { BattleSim } from './sim';
import { bBlocked, bForest, bHeight } from './terrain';
import type { BBuilding, BUnit, SideIndex, TargetRef } from './types';

interface Memory {
  x: number;
  z: number;
  t: number;
  power: number;
  vehicle: boolean;
  family: string;
  inForest: boolean;
}

/** Base decision interval (seconds); scaled by difficulty for the rival's commanders. */
const THINK_INTERVAL = 1.0;
/** Seconds without sighting an enemy before remembered positions are probed instead of respected. */
const PROBE_AFTER = 12;
/** A remembered position is written off once one of our units stands this close to it and sees nothing. */
const CHECKED_RADIUS = 30;
/** Seconds without any contact after which a side that is not clearly stronger gives up the search. */
const LOST_TRAIL = 300;
/** Seconds without a single shot (after the fighting began / from the start) that count as a stalled fight. */
const QUIET_LIMIT = 150;
const QUIET_START = 420;

function isActive(u: BUnit): boolean {
  return u.alive && !u.retreated && !u.reserve;
}

/** Standing, crewed defence with ammunition (mirrors sim.isArmed; kept local to avoid an import cycle). */
function isArmed(b: BBuilding): boolean {
  const d = b.defense;
  if (!d || b.destroyed || d.crew <= 0) return false;
  return d.weapons.some((w) => d.ammo >= w.ammoPerShot);
}

function centroid(list: { x: number; z: number }[]): { x: number; z: number } | null {
  if (!list.length) return null;
  let x = 0;
  let z = 0;
  for (const p of list) {
    x += p.x;
    z += p.z;
  }
  return { x: x / list.length, z: z / list.length };
}

/**
 * Lightweight battlefield reasoning. Each side's AI:
 *  - remembers enemies it has seen (fog of war is respected),
 *  - picks an objective (enemy forces, base structures, or its own base to defend),
 *  - scouts with jeeps, keeps tanks at standoff range on high ground and away
 *    from infantry hiding in forests, moves infantry through cover,
 *  - sends a flanking group around known enemy concentrations,
 *  - focuses fire on the most valuable target it can actually hurt,
 *  - pulls back damaged / dry units and withdraws when the fight is lost.
 */
export class TacticalAI {
  private readonly sim: BattleSim;
  readonly side: SideIndex;
  private nextThink: number;
  private memory = new Map<number, Memory>();
  private flankers = new Set<number>();
  private flankPoint: { x: number; z: number } | null = null;
  private flankStarted = 0;
  private retreating = false;
  private mode: 'attack' | 'defend';
  private holdSince = -1;
  private contactAt = -1;
  private lastContact = -999;
  /** Strength of the enemy when last seen; kept after contact is lost so a beaten side still withdraws. */
  private enemyEstimate = 0;
  private searchPoints: { x: number; z: number }[] = [];
  private searchIdx = new Map<number, number>();
  private readonly siegeAttacker: boolean;
  private readonly thinkInterval: number;
  private readonly flanking: boolean;

  constructor(sim: BattleSim, side: SideIndex) {
    this.sim = sim;
    this.side = side;
    // difficulty only tunes the rival's commanders (the player's side in auto-resolve plays at Normal)
    const level = difficultyOf(sim.setup.sides[side].isPlayer ? 'normal' : sim.setup.difficulty);
    this.thinkInterval = THINK_INTERVAL * level.tacticalThink;
    this.flanking = level.flanking;
    this.nextThink = 0.4 + side * 0.5;
    const siege = sim.setup.kind !== 'field';
    // Field battles are meeting engagements: both sides manoeuvre. Siege defenders hold their base.
    this.mode = side === 0 || !siege ? 'attack' : 'defend';
    this.siegeAttacker = siege && side === 0;
  }

  get enemySide(): SideIndex {
    return this.side === 0 ? 1 : 0;
  }

  update(_dt: number): void {
    if (this.sim.time < this.nextThink) return;
    this.nextThink = this.sim.time + this.thinkInterval;
    this.think();
  }

  // ---------------------------------------------------------------------------

  private think(): void {
    const sim = this.sim;
    const own = sim.units.filter((u) => u.side === this.side && isActive(u));
    if (!own.length) return;
    this.updateMemory();

    // units plus our own armed defences (same measure as sim.startPower)
    const ownPower = sim.sidePower(this.side);
    const known = [...this.memory.values()];
    const enemyPower = known.reduce((a, m) => a + m.power, 0);
    if (known.length) this.enemyEstimate = enemyPower;
    const start = sim.startPower[this.side] || 1;

    // ---- Withdraw when the fight is clearly lost --------------------------
    const fighters = own.filter((u) => u.stats.weapons.length > 0);
    const allDry = fighters.every((u) => u.ammo < Math.min(...u.stats.weapons.map((w) => w.ammoPerShot)));
    // a siege defender holds its base; anyone else leaves a fight it cannot win or find
    const holdsBase = sim.setup.kind !== 'field' && this.side === 1;
    const stalled = !holdsBase && (this.helpless(fighters) || this.lostTrail(ownPower) || this.stuck(ownPower));
    if (!this.retreating && ((ownPower < start * 0.3 && ownPower < this.enemyEstimate * 0.6) || allDry || stalled)) {
      this.retreating = true;
    }
    if (this.retreating) {
      sim.orderRetreat(own.filter((u) => u.order.type !== 'retreat').map((u) => u.id));
      return;
    }

    if (known.length && this.contactAt < 0) this.contactAt = sim.time;
    if (sim.units.some((e) => e.side !== this.side && isActive(e) && e.seenBy[this.side])) this.lastContact = sim.time;

    // ---- Defender may counter-attack when clearly superior ----------------
    if (this.mode === 'defend' && known.length && ownPower > enemyPower * 1.7 && sim.time > 40) this.mode = 'attack';
    // Field-battle defenders wait for contact, then fight.
    if (this.mode === 'defend' && sim.setup.kind === 'field' && known.length && sim.time > 15) this.mode = 'attack';

    this.assignFocus(fighters);
    this.individualSurvival(own);

    if (this.mode === 'attack') this.planAttack(fighters, ownPower);
    else this.planDefense(fighters);
    this.supportFollow(own.filter((u) => u.stats.weapons.length === 0), fighters);
  }

  /**
   * Nothing we still carry can hurt what stands in our way (e.g. missiles
   * spent and only rifles left against a bunker that cannot see us either):
   * staying only stalls the battle.
   */
  private helpless(fighters: BUnit[]): boolean {
    const sim = this.sim;
    const targets: TargetRef[] = [];
    for (const e of sim.units) if (e.side !== this.side && isActive(e)) targets.push({ kind: 'unit', id: e.id });
    for (const b of sim.buildings) if (b.side !== this.side && isArmed(b)) targets.push({ kind: 'building', id: b.id });
    if (!targets.length) return false;
    return !fighters.some((u) => targets.some((t) => sim.canStillHurt(u, t)));
  }

  /**
   * Contact lost for minutes in a fight with no enemy positions to take, and
   * not the stronger side: the enemy has slipped away, call it a day.
   */
  private lostTrail(ownPower: number): boolean {
    const sim = this.sim;
    if (this.lastContact < 0 || this.enemyEstimate <= 0 || sim.time - this.lastContact < LOST_TRAIL) return false;
    if (sim.buildings.some((b) => b.side !== this.side && isArmed(b))) return false;
    return ownPower <= this.enemyEstimate * 1.1;
  }

  /**
   * Nobody has fired for minutes: a siege attacker facing positions it cannot
   * get at (or hopeless odds) gives up, and in the field the side that is not
   * stronger leaves.
   */
  private stuck(ownPower: number): boolean {
    const sim = this.sim;
    let last = -1;
    for (const u of sim.units) if (u.lastFired > last) last = u.lastFired;
    for (const b of sim.buildings) if (b.defense && b.defense.lastFired > last) last = b.defense.lastFired;
    const quiet = last < 0 ? sim.time > QUIET_START : sim.time - last > QUIET_LIMIT;
    if (!quiet) return false;
    if (this.siegeAttacker && sim.buildings.some((b) => b.side !== this.side && isArmed(b))) return true;
    // hopeless odds or an even match that has gone nowhere
    return this.enemyEstimate > 0 && ownPower <= this.enemyEstimate * (this.siegeAttacker ? 0.5 : 1.1);
  }

  /** Supply trucks trail the fighting force (or stay in the base) out of the line of fire. */
  private supportFollow(trucks: BUnit[], fighters: BUnit[]): void {
    if (!trucks.length) return;
    const c = centroid(fighters);
    if (!c) return;
    let gx = c.x;
    let gz = c.z;
    const enemyC = centroid([...this.memory.values()]);
    const home = this.mode === 'defend' ? centroid(this.ownBuildings()) : null;
    if (home) {
      gx = home.x;
      gz = home.z;
    } else if (enemyC) {
      const dx = c.x - enemyC.x;
      const dz = c.z - enemyC.z;
      const l = Math.hypot(dx, dz) || 1;
      gx = c.x + (dx / l) * 110;
      gz = c.z + (dz / l) * 110;
    } else {
      const e = this.sim.setup.sides[this.side].entry;
      gx = c.x - e.dirX * 90;
      gz = c.z - e.dirZ * 90;
    }
    trucks.forEach((t, k) => {
      if (t.order.type === 'retreat' || t.task === 'fall back') return;
      const lateral = (k - (trucks.length - 1) / 2) * 25;
      this.moveTo(t, gx + lateral, gz - lateral * 0.3, false, 35);
      t.task = 'supply';
    });
  }

  private updateMemory(): void {
    const sim = this.sim;
    for (const e of sim.units) {
      if (e.side === this.side) continue;
      if (!e.alive || e.retreated) {
        this.memory.delete(e.id);
        continue;
      }
      if (isActive(e) && e.seenBy[this.side]) {
        this.memory.set(e.id, {
          x: e.x,
          z: e.z,
          t: sim.time,
          power: e.stats.power * (e.hp / Math.max(1, e.stats.maxHp)),
          vehicle: e.stats.isVehicle,
          family: e.stats.family,
          inForest: e.inForest,
        });
      }
    }
    // enemy defensive positions are static and in plain sight
    for (const b of sim.buildings) {
      if (b.side === this.side || !b.defense) continue;
      if (!isArmed(b)) {
        this.memory.delete(b.id);
        continue;
      }
      this.memory.set(b.id, {
        x: b.x,
        z: b.z,
        t: sim.time,
        power: b.defense.power * (b.hp / b.maxHp),
        vehicle: true,
        family: 'defense',
        inForest: false,
      });
    }
    for (const [id, m] of this.memory) {
      if (sim.time - m.t > 75) this.memory.delete(id);
      // a spot one of our units has reached without seeing anyone: the enemy has moved on
      else if (m.family !== 'defense' && sim.time - m.t > 3 && sim.units.some((u) => u.side === this.side && isActive(u) && dist(u.x, u.z, m.x, m.z) < CHECKED_RADIUS)) {
        this.memory.delete(id);
      }
    }
  }

  private enemyBuildings(): { x: number; z: number; id: number; importance: number }[] {
    return this.sim.buildings
      .filter((b) => b.side !== this.side && !b.destroyed)
      .map((b) => ({ x: b.x, z: b.z, id: b.id, importance: BUILDINGS[b.spec.typeId].importance }));
  }

  private ownBuildings(): { x: number; z: number; id: number; importance: number; radius: number }[] {
    return this.sim.buildings
      .filter((b) => b.side === this.side && !b.destroyed)
      .map((b) => ({ x: b.x, z: b.z, id: b.id, importance: BUILDINGS[b.spec.typeId].importance, radius: b.radius }));
  }

  /** Issue a move only when it meaningfully changes what the unit is doing. */
  private moveTo(u: BUnit, x: number, z: number, attackMove = true, tolerance = 22): void {
    const o = u.order;
    if (o.type === 'move' && dist(o.x, o.z, x, z) < tolerance && o.attackMove === attackMove) return;
    if (o.type === 'attack' && this.sim.targetValid(u, o.target)) return; // finish the attack first
    if (dist(u.x, u.z, x, z) < 8) {
      if (o.type !== 'hold' && o.type !== 'idle') this.sim.orderStop([u.id]);
      return;
    }
    const p = this.sim.freeSpot(x, z);
    this.sim.orderMove([u.id], p.x, p.z, attackMove);
    u.task = attackMove ? 'advance' : 'reposition';
  }

  private attack(u: BUnit, t: TargetRef): void {
    if (u.order.type === 'attack' && u.order.target.kind === t.kind && u.order.target.id === t.id) return;
    this.sim.orderAttack([u.id], t);
    u.task = 'attack';
  }

  /**
   * Knock out enemy defensive positions with the right tool: tanks shell
   * bunkers (then gun pits), infantry rush exposed AT gun pits that cannot
   * fire back at them, and AT-armed infantry take on bunkers only when no
   * tanks are left.
   */
  private reduceDefenses(own: BUnit[]): void {
    const sim = this.sim;
    const forts = sim.buildings.filter((b) => b.side !== this.side && isArmed(b));
    if (!forts.length) return;
    const isAT = (b: BBuilding): boolean => b.defense!.weapons.some((w) => w.antiVehicleOnly);
    const tanks = own.filter((u) => u.stats.family === 'tank' && u.task !== 'fall back' && u.order.type !== 'retreat');
    const nearest = (u: BUnit, list: BBuilding[], maxD: number): BBuilding | undefined => {
      let best: BBuilding | undefined;
      let bd = maxD;
      for (const b of list) {
        const d = dist(u.x, u.z, b.x, b.z);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      return best;
    };
    const bunkers = forts.filter((b) => !isAT(b));
    const guns = forts.filter(isAT);
    for (const u of own) {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') continue;
      if (u.order.type === 'attack' && sim.targetValid(u, u.order.target)) continue;
      let tgt: BBuilding | undefined;
      if (u.stats.family === 'tank') tgt = nearest(u, bunkers, 380) ?? nearest(u, guns, 340);
      else if (u.stats.family === 'infantry') {
        tgt = nearest(u, guns, 250);
        const hasAT = u.stats.weapons.some((w) => w.antiVehicleOnly && u.ammo >= w.ammoPerShot);
        if (!tgt && !tanks.length && hasAT) tgt = nearest(u, bunkers, 230);
      }
      if (tgt) this.attack(u, { kind: 'building', id: tgt.id });
    }
  }

  /**
   * Infantry spotted inside a structure is hard to dig out with rifles:
   * tanks shell the building instead (heavy hits wreck it and hurt the
   * garrison; a collapse throws the survivors into the open).
   */
  private shellGarrisons(own: BUnit[]): void {
    const sim = this.sim;
    const held = sim.buildings.filter((b) => b.side !== this.side && !b.destroyed && sim.occupants(b).some((u) => u.seenBy[this.side]));
    if (!held.length) return;
    for (const u of own) {
      if (u.stats.family !== 'tank' || u.task === 'fall back' || u.order.type === 'retreat') continue;
      if (u.order.type === 'attack' && sim.targetValid(u, u.order.target)) continue;
      let best: BBuilding | undefined;
      let bd = 380;
      for (const b of held) {
        const d = dist(u.x, u.z, b.x, b.z);
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (best) this.attack(u, { kind: 'building', id: best.id });
    }
  }

  /**
   * Siege defenders occupy the structures nearest the threat (up to each
   * building's capacity). Returns the units that are inside or on their way.
   */
  private garrisonBuildings(inf: BUnit[], toward: { x: number; z: number }): Set<number> {
    const sim = this.sim;
    const taken = new Set<number>();
    for (const u of inf) if (u.inside !== null || u.order.type === 'garrison') taken.add(u.id);
    const free = inf.filter(
      (u) => !taken.has(u.id) && u.order.type !== 'retreat' && u.task !== 'rearm' && !(u.order.type === 'attack' && sim.targetValid(u, u.order.target)),
    );
    if (!free.length) return taken;
    const shelters = sim.buildings
      .filter((b) => b.side === this.side && sim.garrisonCapacity(b) > 0)
      .sort((a, b) => dist(a.x, a.z, toward.x, toward.z) - dist(b.x, b.z, toward.x, toward.z));
    for (const b of shelters) {
      while (free.length) {
        // the nearest free squad within a short walk
        let pick = -1;
        let pd = 230;
        free.forEach((u, k) => {
          const d = dist(u.x, u.z, b.x, b.z);
          if (d < pd) {
            pd = d;
            pick = k;
          }
        });
        if (pick < 0 || !sim.canGarrison(free[pick], b)) break;
        const u = free.splice(pick, 1)[0];
        sim.orderGarrison([u.id], b.id);
        u.task = 'garrison';
        taken.add(u.id);
      }
    }
    return taken;
  }

  // ---------------------------------------------------------------------------
  // Focus fire
  // ---------------------------------------------------------------------------

  private assignFocus(own: BUnit[]): void {
    const sim = this.sim;
    const visible = sim.units.filter((e) => e.side !== this.side && isActive(e) && e.seenBy[this.side]);
    if (!visible.length) {
      for (const u of own) if (u.focus?.kind === 'unit') u.focus = null;
      return;
    }
    // Score targets by threat and how close they are to dying.
    let best: BUnit | null = null;
    let bestScore = -Infinity;
    for (const e of visible) {
      let threat = e.stats.power * (0.5 + 0.5 * (e.hp / e.stats.maxHp));
      // AT teams near our tanks and spotting jeeps are priority
      if (!e.stats.isVehicle && own.some((u) => u.stats.family === 'tank' && dist(u.x, u.z, e.x, e.z) < 140)) threat *= 1.6;
      const fragility = 1 - e.hp / e.stats.maxHp;
      const reach = own.filter((u) => dist(u.x, u.z, e.x, e.z) < sim.maxRange(u)).length;
      const score = threat * (1 + fragility * 1.5) * (0.4 + reach * 0.25);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    for (const u of own) {
      if (best && sim.effectiveness(u, best) > 0.5 && dist(u.x, u.z, best.x, best.z) < sim.maxRange(u) * 1.1) {
        u.focus = { kind: 'unit', id: best.id };
      } else if (u.focus?.kind === 'unit') {
        u.focus = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Individual survival: damaged / dry units fall back, AT ambushes
  // ---------------------------------------------------------------------------

  private individualSurvival(own: BUnit[]): void {
    const sim = this.sim;
    const rear = sim.setup.sides[this.side].entry;
    for (const u of own) {
      const minShot = u.stats.weapons.length ? Math.min(...u.stats.weapons.map((w) => w.ammoPerShot)) : 0;
      if (u.stats.weapons.length) {
        const dry = u.ammo < minShot;
        const rearming = u.task === 'rearm' && u.ammo < u.stats.ammoCapacity * 0.6;
        if (dry || rearming) {
          // rearm at a supply truck if one has ammunition, otherwise leave the field when dry
          const truck = own.find((t) => t.stats.family === 'support' && t.ammo > 2);
          if (truck) {
            this.moveTo(u, truck.x, truck.z, false, 20);
            u.task = 'rearm';
            continue;
          }
          if (dry) {
            if (u.order.type !== 'retreat') sim.orderRetreat([u.id]);
            u.task = 'no ammo';
            continue;
          }
        }
        if (u.task === 'rearm') u.task = '';
      }
      const hpF = u.hp / u.stats.maxHp;
      if (u.stats.isVehicle && hpF < 0.28 && u.order.type !== 'retreat') {
        // limp back toward our lines
        this.moveTo(u, rear.x - rear.dirX * 40, rear.z - rear.dirZ * 40, false, 40);
        u.task = 'fall back';
      }
    }
    // Infantry with AT ambush enemy vehicles that come close.
    for (const u of own) {
      if (u.stats.isVehicle || u.order.type === 'retreat') continue;
      const at = u.stats.weapons.find((w) => w.antiVehicleOnly);
      if (!at || u.ammo < at.ammoPerShot) continue;
      let tgt: BUnit | null = null;
      // a garrison fires from its building rather than leaving cover
      let td = u.inside !== null ? at.range : at.range * 1.3;
      for (const e of sim.units) {
        if (e.side === this.side || !isActive(e) || !e.seenBy[this.side] || !e.stats.isVehicle) continue;
        const d = dist(u.x, u.z, e.x, e.z);
        if (d < td) {
          td = d;
          tgt = e;
        }
      }
      if (tgt) this.attack(u, { kind: 'unit', id: tgt.id });
    }
  }

  // ---------------------------------------------------------------------------
  // Attack
  // ---------------------------------------------------------------------------

  private planAttack(own: BUnit[], ownPower: number): void {
    const sim = this.sim;
    const known = [...this.memory.values()];
    const ownC = centroid(own)!;
    const enemyBuildings = this.enemyBuildings();
    const enemyC = centroid(known);
    let objective: { x: number; z: number };
    if (enemyC) objective = enemyC;
    else if (sim.setup.objectiveBuildingId && enemyBuildings.length) objective = centroid(enemyBuildings)!;
    else if (enemyBuildings.length) objective = centroid(enemyBuildings)!;
    else {
      const e = sim.setup.sides[this.enemySide].entry;
      objective = { x: e.x, z: e.z };
    }
    const axX = objective.x - ownC.x;
    const axZ = objective.z - ownC.z;
    const axL = Math.hypot(axX, axZ) || 1;
    const ux = axX / axL;
    const uz = axZ / axL;
    const px = -uz;
    const pz = ux;

    const tanks = own.filter((u) => u.stats.family === 'tank' && u.task !== 'fall back');
    const inf = own.filter((u) => u.stats.family === 'infantry');
    const jeeps = own.filter((u) => u.stats.family === 'light_vehicle' && u.task !== 'fall back');

    // ---- Contact lost: hunt for the enemy instead of waiting for it -------------
    const lost = this.contactAt >= 0 && sim.time - this.lastContact > PROBE_AFTER;
    if (lost && known.length && known.every((m) => m.family !== 'defense' && sim.time - m.t > PROBE_AFTER)) {
      this.probe(own, known);
      return;
    }
    if (lost && !known.length && !(this.siegeAttacker && enemyBuildings.length)) {
      this.sweep(own);
      return;
    }

    // ---- No contact yet: scout and advance in bounds -----------------------
    if (!known.length) {
      jeeps.forEach((j, k) => {
        const lateral = (k - (jeeps.length - 1) / 2) * 110;
        const ahead = Math.min(axL, 260);
        this.moveTo(j, ownC.x + ux * ahead + px * lateral, ownC.z + uz * ahead + pz * lateral, true, 40);
        j.task = 'scout';
      });
      const bound = Math.min(axL * 0.6, 110);
      inf.forEach((u, k) => {
        const lateral = (k - (inf.length - 1) / 2) * 26;
        const goal = this.coverNear(ownC.x + ux * bound + px * lateral, ownC.z + uz * bound + pz * lateral, 40);
        this.moveTo(u, goal.x, goal.z, true, 30);
      });
      tanks.forEach((u, k) => {
        const lateral = (k - (tanks.length - 1) / 2) * 40;
        this.moveTo(u, ownC.x + ux * (bound - 30) + px * lateral, ownC.z + uz * (bound - 30) + pz * lateral, true, 35);
      });
      // When the objective is a base and nobody defends it, sweep it.
      if (this.siegeAttacker && enemyBuildings.length && axL < 260 && sim.time - this.lastContact > 25) this.assaultBuildings(own, enemyBuildings);
      return;
    }

    // ---- Contact: avoid suicide, flank, standoff, cover --------------------
    const enemyNear = known.filter((m) => dist(m.x, m.z, enemyC!.x, enemyC!.z) < 220);
    const enemyNearPower = enemyNear.reduce((a, m) => a + m.power, 0);
    const outmatched = ownPower < enemyNearPower * 0.75;
    if (outmatched) {
      if (this.holdSince < 0) this.holdSince = sim.time;
    } else this.holdSince = -1;
    const waiting = outmatched && sim.time - this.holdSince < 45;

    // flank group
    if (this.flanking && !this.flankPoint && own.length >= 6 && !waiting) {
      const sideSign = this.pickFlankSide(enemyC!, px, pz);
      this.flankPoint = this.sim.freeSpot(enemyC!.x + px * 170 * sideSign - ux * 30, enemyC!.z + pz * 170 * sideSign - uz * 30);
      this.flankStarted = sim.time;
      const candidates = [...jeeps, ...inf.slice().sort((a, b) => dist(b.x, b.z, ownC.x, ownC.z) - dist(a.x, a.z, ownC.x, ownC.z))];
      const n = Math.max(2, Math.round(own.length * 0.3));
      for (const u of candidates.slice(0, n)) this.flankers.add(u.id);
    }
    for (const id of [...this.flankers]) {
      const u = sim.unitById(id);
      if (!u || !isActive(u)) this.flankers.delete(id);
    }
    if (!waiting) {
      this.reduceDefenses(own);
      this.shellGarrisons(own);
    }
    // missile teams only stand off against armour; against infantry they fight as riflemen
    const vehicleC = centroid(known.filter((m) => m.vehicle));

    for (const u of own) {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') continue;
      if (u.order.type === 'attack' && sim.targetValid(u, u.order.target)) continue;
      const isFlanker = this.flankers.has(u.id);
      if (isFlanker && this.flankPoint) {
        const arrived = dist(u.x, u.z, this.flankPoint.x, this.flankPoint.z) < 45;
        const late = sim.time - this.flankStarted > 75;
        if (arrived || late) this.moveTo(u, enemyC!.x, enemyC!.z, true, 40);
        else this.moveTo(u, this.flankPoint.x, this.flankPoint.z, true, 40);
        u.task = 'flank';
        continue;
      }
      if (u.stats.family === 'tank') this.tankStandoff(u, enemyC!, ux, uz, waiting);
      else if (u.stats.family === 'infantry' && this.longRangeAT(u) && vehicleC) this.missileStandoff(u, vehicleC);
      else if (u.stats.family === 'infantry') this.infantryAdvance(u, enemyC!, waiting);
      else this.jeepHarass(u, ownC, ux, uz);
    }


  }

  /** Close in on the last known enemy positions (spread out) to regain sight of them. */
  private probe(own: BUnit[], known: Memory[]): void {
    own.forEach((u, k) => {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') return;
      if (u.order.type === 'attack' && this.sim.targetValid(u, u.order.target)) return;
      let best = known[0];
      let bd = Infinity;
      for (const m of known) {
        const d = dist(u.x, u.z, m.x, m.z);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
      const a = k * 2.4;
      this.moveTo(u, best.x + Math.cos(a) * 14, best.z + Math.sin(a) * 14, true, 18);
      u.task = 'search';
    });
  }

  /**
   * Nothing in sight and nothing remembered: comb the enemy's half of the
   * field, finishing at its rear where damaged vehicles fall back to. Each
   * unit walks the waypoints from a different start.
   */
  private sweep(own: BUnit[]): void {
    const sim = this.sim;
    if (!this.searchPoints.length) {
      const e = sim.setup.sides[this.enemySide].entry;
      const px = -e.dirZ;
      const pz = e.dirX;
      for (const ahead of [150, 60, -40]) {
        for (const lateral of [0, 110, -110]) this.searchPoints.push(sim.freeSpot(e.x + e.dirX * ahead + px * lateral, e.z + e.dirZ * ahead + pz * lateral));
      }
    }
    const pts = this.searchPoints;
    own.forEach((u, k) => {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') return;
      if (u.order.type === 'attack' && sim.targetValid(u, u.order.target)) return;
      let i = this.searchIdx.get(u.id) ?? k % pts.length;
      if (dist(u.x, u.z, pts[i].x, pts[i].z) < CHECKED_RADIUS) i = (i + 1) % pts.length;
      this.searchIdx.set(u.id, i);
      this.moveTo(u, pts[i].x, pts[i].z, true, 20);
      u.task = 'search';
    });
  }

  private pickFlankSide(c: { x: number; z: number }, px: number, pz: number): number {
    // prefer the side with more forest cover and passable terrain
    let left = 0;
    let right = 0;
    for (let k = 40; k <= 200; k += 40) {
      left += bForest(this.sim.terrain, c.x + px * k, c.z + pz * k) - (bBlocked(this.sim.terrain, c.x + px * k, c.z + pz * k) ? 2 : 0);
      right += bForest(this.sim.terrain, c.x - px * k, c.z - pz * k) - (bBlocked(this.sim.terrain, c.x - px * k, c.z - pz * k) ? 2 : 0);
    }
    return left >= right ? 1 : -1;
  }

  /** Tanks hold at standoff range, on high ground, away from infantry in forests. */
  private tankStandoff(u: BUnit, enemyC: { x: number; z: number }, ux: number, uz: number, waiting: boolean): void {
    const sim = this.sim;
    const t = sim.terrain;
    // danger: known enemy infantry close by (AT)
    let danger: Memory | null = null;
    let dd = Infinity;
    for (const m of this.memory.values()) {
      if (m.vehicle) continue;
      const d = dist(u.x, u.z, m.x, m.z);
      if (d < 150 && d < dd) {
        dd = d;
        danger = m;
      }
    }
    if (danger) {
      // back off to beyond AT range and keep shooting
      const bx = u.x - danger.x;
      const bz = u.z - danger.z;
      const bl = Math.hypot(bx, bz) || 1;
      this.moveTo(u, danger.x + (bx / bl) * 210, danger.z + (bz / bl) * 210, true, 30);
      u.task = 'standoff';
      return;
    }
    const range = waiting ? 250 : 205;
    let best: { x: number; z: number } | null = null;
    let bestScore = -Infinity;
    const base = Math.atan2(-ux, -uz); // from enemy toward us
    for (let k = -3; k <= 3; k++) {
      const a = base + k * 0.22;
      const x = enemyC.x + Math.sin(a) * range;
      const z = enemyC.z + Math.cos(a) * range;
      if (bBlocked(t, x, z)) continue;
      const forestPenalty = bForest(t, x, z) * 25;
      let infDanger = 0;
      for (const m of this.memory.values()) if (!m.vehicle && dist(m.x, m.z, x, z) < 155) infDanger += 40;
      const score = bHeight(t, x, z) * 1.4 - forestPenalty - infDanger - dist(u.x, u.z, x, z) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    if (best) {
      this.moveTo(u, best.x, best.z, true, 35);
      u.task = 'overwatch';
    }
  }

  /** Guided-missile teams: AT reach beyond tank guns, but helpless up close. */
  private longRangeAT(u: BUnit): boolean {
    return u.stats.weapons.some((w) => w.antiVehicleOnly && w.range >= 250);
  }

  /** Missile teams hold in cover just inside missile range of the enemy, never closing in. */
  private missileStandoff(u: BUnit, enemyC: { x: number; z: number }): void {
    const reach = Math.max(...u.stats.weapons.filter((w) => w.antiVehicleOnly).map((w) => w.range));
    const want = reach * 0.85;
    const d = dist(u.x, u.z, enemyC.x, enemyC.z);
    if (Math.abs(d - want) < 30 && (u.cover > 0 || u.order.type === 'idle')) return;
    const k = (d - want) / Math.max(d, 1);
    const goal = this.coverNear(u.x + (enemyC.x - u.x) * k, u.z + (enemyC.z - u.z) * k, 50);
    this.moveTo(u, goal.x, goal.z, true, 30);
    u.task = 'overwatch';
  }

  /** Infantry advance through cover; they wait in cover when outmatched. */
  private infantryAdvance(u: BUnit, enemyC: { x: number; z: number }, waiting: boolean): void {
    const d = dist(u.x, u.z, enemyC.x, enemyC.z);
    const want = waiting ? 170 : 105;
    if (Math.abs(d - want) < 20 && u.cover > 0) return; // good spot
    const k = Math.max(0, (d - want) / Math.max(d, 1));
    const gx = u.x + (enemyC.x - u.x) * k;
    const gz = u.z + (enemyC.z - u.z) * k;
    const goal = this.coverNear(gx, gz, 45);
    this.moveTo(u, goal.x, goal.z, true, 25);
    u.task = waiting ? 'take cover' : 'advance';
  }

  /** Jeeps harass infantry in the open and avoid tanks. */
  private jeepHarass(u: BUnit, ownC: { x: number; z: number }, ux: number, uz: number): void {
    const sim = this.sim;
    let tankThreat = false;
    for (const m of this.memory.values()) {
      if ((m.family === 'tank' || m.family === 'defense') && dist(u.x, u.z, m.x, m.z) < 290) tankThreat = true;
    }
    if (tankThreat) {
      this.moveTo(u, ownC.x - ux * 90, ownC.z - uz * 90, false, 40);
      u.task = 'evade';
      return;
    }
    let prey: BUnit | null = null;
    let pd = 260;
    for (const e of sim.units) {
      if (e.side === this.side || !isActive(e) || !e.seenBy[this.side] || e.stats.isVehicle || e.inForest) continue;
      const d = dist(u.x, u.z, e.x, e.z);
      if (d < pd) {
        pd = d;
        prey = e;
      }
    }
    if (prey) this.attack(u, { kind: 'unit', id: prey.id });
    else {
      const c = centroid([...this.memory.values()]);
      if (c) this.moveTo(u, c.x - ux * 170, c.z - uz * 170, true, 40);
    }
  }

  /**
   * No defenders in sight near the objective: sweep through the enemy
   * structures to flush out hidden defenders. Tanks demolish military
   * production (barracks, vehicle depots, factories) but the base itself is
   * left standing so it can be captured.
   */
  private assaultBuildings(own: BUnit[], targets: { x: number; z: number; id: number; importance: number }[]): void {
    const military = new Set(['bunker', 'at_emplacement', 'barracks', 'vehicle_depot', 'factory']);
    const demolish = targets.filter((t) => {
      const b = this.sim.buildingById(t.id);
      return !!b && military.has(b.spec.typeId);
    });
    own.forEach((u, k) => {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') return;
      if (u.order.type === 'attack' && this.sim.targetValid(u, u.order.target)) return;
      if (u.stats.family === 'tank' && demolish.length) {
        this.attack(u, { kind: 'building', id: demolish[k % demolish.length].id });
        return;
      }
      const t = targets[k % targets.length];
      // circle the structure to find hidden defenders
      const a = (k * 2.4 + this.sim.time * 0.01) % (Math.PI * 2);
      this.moveTo(u, t.x + Math.cos(a) * 35, t.z + Math.sin(a) * 35, true, 30);
      u.task = 'sweep';
    });
  }

  // ---------------------------------------------------------------------------
  // Defence
  // ---------------------------------------------------------------------------

  private planDefense(own: BUnit[]): void {
    const sim = this.sim;
    const buildings = this.ownBuildings();
    const known = [...this.memory.values()];
    const home = centroid(buildings) ?? { x: sim.setup.sides[this.side].entry.x, z: sim.setup.sides[this.side].entry.z };
    const infantry = own.filter((u) => u.stats.family === 'infantry');
    if (!known.length) {
      // man the structures facing the attacker's approach while waiting
      const atk = sim.setup.sides[this.enemySide].entry;
      const inside = this.garrisonBuildings(infantry, atk);
      for (const u of own) if (u.order.type === 'idle' && !inside.has(u.id)) this.sim.orderHold([u.id]);
      return;
    }
    // threats: enemies nearest to our structures
    const threats = known
      .map((m) => ({ m, d: Math.min(...buildings.map((b) => dist(b.x, b.z, m.x, m.z)), dist(home.x, home.z, m.x, m.z)) }))
      .sort((a, b) => a.d - b.d);
    const main = threats[0].m;
    const threatC = centroid(threats.slice(0, 6).map((t) => t.m))!;
    // building nearest to the threat: defend it
    const anchor = buildings.slice().sort((a, b) => dist(a.x, a.z, threatC.x, threatC.z) - dist(b.x, b.z, threatC.x, threatC.z))[0] ?? home;
    const garrisoned = this.garrisonBuildings(infantry, threatC);

    for (const u of own) {
      if (u.order.type === 'retreat' || u.task === 'fall back' || u.task === 'rearm') continue;
      if (u.order.type === 'attack' && sim.targetValid(u, u.order.target)) continue;
      const fam = u.stats.family;
      if (fam === 'infantry' && garrisoned.has(u.id)) continue;
      if (fam === 'infantry') {
        // hold near the threatened structure, in cover
        const ax = threatC.x - anchor.x;
        const az = threatC.z - anchor.z;
        const al = Math.hypot(ax, az) || 1;
        const r = ('radius' in anchor ? (anchor as { radius: number }).radius : 15) + 14;
        const spot = this.coverNear(anchor.x + (ax / al) * r + (this.rng() - 0.5) * 30, anchor.z + (az / al) * r + (this.rng() - 0.5) * 30, 25);
        if (dist(u.x, u.z, spot.x, spot.z) > 60) this.moveTo(u, spot.x, spot.z, true, 30);
        else if (u.order.type === 'idle') this.sim.orderHold([u.id]);
        u.task = 'defend';
      } else if (fam === 'tank') {
        // stay inside the base, engage from range
        const ax = threatC.x - home.x;
        const az = threatC.z - home.z;
        const al = Math.hypot(ax, az) || 1;
        const hold = clamp(al - 200, 0, 110);
        this.moveTo(u, home.x + (ax / al) * hold, home.z + (az / al) * hold, true, 35);
        u.task = 'defend';
      } else {
        // jeeps: mobile reserve hitting the nearest infantry threat
        if (!main.vehicle) this.moveTo(u, main.x, main.z, true, 40);
        else this.moveTo(u, home.x, home.z, true, 40);
        u.task = 'reserve';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private seed = 1;
  private rng(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** Find a covered position (forest or next to a friendly building) near (x, z). */
  private coverNear(x: number, z: number, radius: number): { x: number; z: number } {
    const t = this.sim.terrain;
    let best = { x, z };
    let bestScore = bForest(t, x, z) * 2 - (bBlocked(t, x, z) ? 10 : 0);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      for (const rr of [0.5, 1]) {
        const cx = x + Math.cos(a) * radius * rr;
        const cz = z + Math.sin(a) * radius * rr;
        if (bBlocked(t, cx, cz)) continue;
        let s = bForest(t, cx, cz) * 2 - rr * 0.3;
        for (const b of this.sim.buildings) {
          if (b.side === this.side && !b.destroyed && dist(b.x, b.z, cx, cz) < b.radius + 15) s += 1.2;
        }
        if (s > bestScore) {
          bestScore = s;
          best = { x: cx, z: cz };
        }
      }
    }
    return this.sim.freeSpot(best.x, best.z);
  }
}
