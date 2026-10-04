import { CAMPAIGN_HOURS_PER_SECOND, hourOfDay, type SpeedSetting } from '../core/time';
import { dist } from '../core/math';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { startResearch } from '../research/research';
import { canFoundFrom, foundBase, MAX_FOUND_RANGE, MIN_BASE_SPACING, validateBaseSite } from '../campaign/expansion';
import { sendConvoy, sendSupplyRun } from '../campaign/convoys';
import { addStandingTransfer, cancelStandingTransfer } from '../campaign/logistics';
import type { PartialStock } from '../data/resources';
import { BASE_RADIUS } from '../world/mapgen';
import { statsOf } from '../units/stats';
import {
  formArmyFromGarrison,
  fuelRange,
  garrisonArmy,
  mergeArmies,
  orderAttack,
  orderMove,
  orderReturn,
  reinforceArmy,
  splitArmy,
  stopArmy,
} from '../campaign/armies';
import {
  cancelConstruction,
  rebuildBuilding,
  setRecipeMode,
  startConstruction,
  startOutpost,
  suggestPlacement,
  toggleEnabled,
  validatePlacement,
} from '../campaign/construction';
import { makeContext, syncRng, type SimContext } from '../campaign/context';
import { cancelOrder, queueUnit } from '../campaign/production';
import { basesOf, isOutpost, isVisibleToFaction } from '../campaign/queries';
import { SIM_STEP, stepCampaign } from '../campaign/sim';
import { agoText, SIGHTING_TTL, tally, tallyCount } from '../campaign/intel';
import type { ArmySighting, CampaignState, LogEntry } from '../campaign/types';
import type { World } from '../world/world';
import { createBattleSetup } from '../battle/setup';
import { autoResolveAsync } from '../battle/autoresolve';
import { applyBattleResult } from '../battle/result';
import type { BattleResult, BattleSetup } from '../battle/types';
import { CampaignView } from '../rendering/campaignView';
import type { SymbolKind } from '../rendering/overlay';
import { PointerInput, type PointerInfo } from '../input/pointer';
import { CampaignHud, type CampaignController, type Selection } from '../ui/campaignHud';
import type { App, Mode } from './app';

/** Map symbol for a force from its units by design id. */
function symbolFor(units: Record<string, number>): SymbolKind {
  let tank = 0;
  let inf = 0;
  let jeep = 0;
  let support = 0;
  for (const [id, n] of Object.entries(units)) {
    const f = statsOf(id).family;
    if (f === 'tank') tank += n;
    else if (f === 'infantry') inf += n;
    else if (f === 'support') support += n;
    else jeep += n;
  }
  return tank && inf ? 'mixed' : tank ? 'tank' : inf ? 'infantry' : jeep ? 'light_vehicle' : support ? 'support' : 'light_vehicle';
}

const pipsFor = (n: number): number => (n <= 4 ? 1 : n <= 10 ? 2 : 3);

/** Strategic map mode: drives the campaign simulation and its view/HUD. */
export class CampaignMode implements Mode, CampaignController {
  readonly ctx: SimContext;
  readonly view: CampaignView;
  readonly hud: CampaignHud;
  private input: PointerInput;
  private keys: () => void;
  speed: SpeedSetting = 1;
  selection: Selection = null;
  placing: { kind: 'building' | 'base'; typeId: BuildingTypeId; baseId: string; x: number; z: number; valid: boolean; reason: string } | null = null;
  private acc = 0;
  private hudTimer = 0;
  /** Player bases at the last HUD tick (-1 before the first). */
  private playerBases = -1;
  private autosaveTimer = 0;
  private suspended = false;

  constructor(
    private readonly app: App,
    readonly state: CampaignState,
    readonly world: World,
  ) {
    this.ctx = makeContext(state, world);
    this.view = new CampaignView(app.gr, world, state);
    this.hud = new CampaignHud(app.ui, this);
    this.input = new PointerInput(app.canvas, {
      onTap: (x, y, i) => this.onTap(x, y, i),
      onDoubleTap: (x, y, i) => this.onTap(x, y, i),
      onLongPress: (x, y) => this.onCommand(x, y),
      onDragStart: () => false,
      onDrag: (_x, _y, dx, dy, info) => {
        if (info.pointerType === 'mouse' && (info.button === 2 || info.button === 1)) this.view.rig.rotateBy(dx * 0.006);
        else this.view.rig.panPixels(dx, dy, this.app.gr.height);
      },
      onPinch: (cx, cy, scale, rot, dx, dy) => {
        const g = this.view.groundAt(cx, cy);
        this.view.rig.zoomBy(1 / scale, g ?? undefined);
        this.view.rig.rotateBy(-rot);
        this.view.rig.panPixels(dx, dy, this.app.gr.height);
      },
      onWheel: (x, y, d) => {
        const g = this.view.groundAt(x, y);
        this.view.rig.zoomBy(Math.exp(d * 0.0012), g ?? undefined);
      },
    });
    this.keys = app.keyboard.onKey((e) => this.onKey(e));
    const home = Object.values(state.bases).find((b) => b.factionId === state.playerFactionId);
    if (home) this.hud.focusBaseId = home.id;
  }

  // ---------------------------------------------------------------------------
  // Mode
  // ---------------------------------------------------------------------------

  suspend(): void {
    this.suspended = true;
    this.input.enabled = false;
    this.hud.root.style.display = 'none';
  }

  sound(kind: 'radio' | 'alert' | 'confirm'): void {
    this.app.audio.ui(kind);
  }

  armySplit(id: string, unitIds: string[]): void {
    const fresh = splitArmy(this.ctx, id, unitIds);
    if (!fresh) {
      this.hud.toast('Choose some, but not all, of the units.', 'warn');
      return;
    }
    this.hud.toast(`${fresh.name} formed with ${fresh.units.length} unit(s).`, 'econ');
    this.select({ kind: 'army', id: fresh.id });
  }

  armyMerge(intoId: string, fromId: string): void {
    const from = this.state.armies[fromId]?.name ?? 'Task force';
    if (!mergeArmies(this.ctx, intoId, fromId)) {
      this.hud.toast('Task forces must be close together, with room for all units.', 'warn');
      return;
    }
    this.hud.toast(`${from} merged into ${this.state.armies[intoId]?.name ?? 'the task force'}.`, 'econ');
    this.select({ kind: 'army', id: intoId });
  }

  setResearch(techId: string): void {
    const research = this.state.factions[this.state.playerFactionId]?.research;
    if (!research || !startResearch(research, techId)) {
      this.hud.toast('That project is not available yet.', 'warn');
      return;
    }
    this.sound('confirm');
    this.hud.update(true);
  }

  setRepeat(buildingId: string, designId: string | null): void {
    const b = this.state.buildings[buildingId];
    if (!b) return;
    b.repeat = designId;
    if (designId && b.queue.length === 0) {
      const r = queueUnit(this.state, buildingId, designId);
      if (!r.ok) this.hud.toast(r.reason, 'warn');
    }
    this.hud.update(true);
  }

  resume(): void {
    this.suspended = false;
    this.input.enabled = true;
    this.hud.root.style.display = '';
    this.resize();
  }

  update(dt: number): void {
    if (this.suspended) return;
    this.keyboardCamera(dt);
    const modalOpen = !!this.app.ui.querySelector('.modal-back');
    if (!this.state.pendingBattle && this.speed > 0 && !modalOpen) {
      this.acc += dt * this.speed * CAMPAIGN_HOURS_PER_SECOND;
      let steps = 0;
      while (this.acc >= SIM_STEP && steps < 60) {
        stepCampaign(this.ctx, SIM_STEP);
        this.acc -= SIM_STEP;
        steps++;
        if (this.state.pendingBattle) {
          this.acc = 0;
          break;
        }
      }
      if (steps >= 60) this.acc = 0;
    }
    this.view.setHour(hourOfDay(this.state.time));
    this.view.sync(this.state, dt);
    this.view.update(dt);
    if (this.placing) this.updateGhost();
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.25;
      this.validateSelection();
      this.watchReliefLanding();
      const pf = this.state.playerFactionId;
      this.app.audio.setWarFooting(this.state.relations.some((r) => r.status === 'hostile' && (r.a === pf || r.b === pf)));
      this.hud.update();
    }
    this.autosaveTimer += dt;
    if (this.autosaveTimer > this.app.settings.autosaveMinutes * 60 && !this.state.pendingBattle) {
      this.autosaveTimer = 0;
      void this.app.save('autosave', true);
    }
    this.drawOverlay();
  }

  render(): void {
    if (this.suspended) return;
    this.view.render();
  }

  /** When a relief landing gives a baseless expedition a new base, take the player there. */
  private watchReliefLanding(): void {
    const bases = basesOf(this.state, this.state.playerFactionId);
    if (this.playerBases === 0 && bases.length > 0) this.select({ kind: 'base', id: bases[0].id }, true);
    this.playerBases = bases.length;
  }

  resize(): void {
    this.view.resize();
  }

  dispose(): void {
    this.input.dispose();
    this.keys();
    this.hud.dispose();
    this.view.dispose();
  }

  // ---------------------------------------------------------------------------
  // Overlay (symbols & labels)
  // ---------------------------------------------------------------------------

  private drawOverlay(): void {
    const o = this.app.overlay;
    o.clear();
    o.resetLabels();
    if (this.suspended) return;
    const s = this.state;
    const zoomed = this.view.rig.dist < 110;
    for (const base of Object.values(s.bases)) {
      const p = this.view.toScreen(base.x, this.view.heightAtWorld(base.x, base.z) + 5, base.z);
      if (!p) continue;
      const friendly = base.factionId === s.playerFactionId;
      o.symbol(p.x, p.y - 6, 'hq', friendly, 13);
      o.labelAvoid(p.x, p.y + 12, base.name.toUpperCase(), friendly ? '#bfe2ff' : '#ffc4b6', 11);
    }
    for (const a of Object.values(s.armies)) {
      if (!this.view.isArmyVisible(a.id)) continue;
      const p = this.view.armyScreenPos(a.id);
      if (!p) continue;
      const kind = symbolFor(tally(a.units));
      const friendly = a.factionId === s.playerFactionId;
      const selected = this.selection?.kind === 'army' && this.selection.id === a.id;
      o.symbol(p.x, p.y, kind, friendly, selected ? 15 : 13, { selected, pips: pipsFor(a.units.length) });
      if (zoomed || selected) o.labelAvoid(p.x, p.y + 17, `${a.name} · ${a.units.length}`, friendly ? '#d8ecff' : '#ffd2c8', 10);
      if (friendly) {
        const range = fuelRange(a.units);
        const dry = a.units.some((u) => {
          const st = statsOf(u.designId);
          return st.weapons.length > 0 && st.ammoCapacity > 0 && u.ammo < st.ammoCapacity * 0.25;
        });
        if (range < 40) o.label(p.x, p.y - 18, 'LOW FUEL', '#e8c33c', 9);
        else if (dry) o.label(p.x, p.y - 18, 'LOW AMMO', '#e8c33c', 9);
      }
    }
    // last known positions of rival forces that slipped out of view
    for (const g of this.lostContacts()) {
      const p = this.ghostScreen(g);
      if (!p) continue;
      const age = s.time - g.t;
      const selected = this.selection?.kind === 'contact' && this.selection.id === g.armyId;
      const alpha = selected ? 0.9 : Math.max(0.3, 0.65 - (0.35 * age) / SIGHTING_TTL);
      o.symbol(p.x, p.y, symbolFor(g.units), false, selected ? 15 : 12, { selected, alpha, dashed: true, pips: pipsFor(tallyCount(g.units)) });
      o.label(p.x + 14, p.y - 10, '?', `rgba(255,190,170,${alpha})`, 12);
      if (g.hx || g.hz) {
        const q = this.view.toScreen(g.x + g.hx * 6, this.view.heightAtWorld(g.x, g.z) + 2, g.z + g.hz * 6);
        if (q) {
          const dx = q.x - p.x;
          const dy = q.y - p.y;
          const d = Math.hypot(dx, dy) || 1;
          o.line(p.x + (dx / d) * 14, p.y + (dy / d) * 14, p.x + (dx / d) * 30, p.y + (dy / d) * 30, `rgba(255,106,77,${alpha})`, [4, 3], 1.5);
        }
      }
      if (zoomed || selected) o.labelAvoid(p.x, p.y + 17, `${g.name} · ${agoText(age)}`, `rgba(255,210,200,${Math.min(1, alpha + 0.15)})`, 10);
    }
    // pending order line for the selected army
    const sel = this.selection;
    if (sel?.kind === 'army') {
      const a = s.armies[sel.id];
      if (a && a.order.type !== 'idle' && a.order.type !== 'move' && a.order.type !== 'return' && a.factionId === s.playerFactionId) {
        let tgt: { x: number; z: number } | undefined =
          a.order.type === 'attack_army'
            ? s.armies[a.order.targetId]
            : a.order.type === 'attack_base'
              ? s.bases[a.order.targetId]
              : s.buildings[a.order.targetId];
        // a pursued force out of view: point at its last known position, not where it really is
        if (a.order.type === 'attack_army' && tgt && !isVisibleToFaction(s, s.playerFactionId, tgt.x, tgt.z)) {
          tgt = s.intel[s.playerFactionId]?.armies[a.order.targetId];
        }
        const p0 = this.view.armyScreenPos(a.id);
        if (tgt && p0) {
          const p1 = this.view.toScreen(tgt.x, this.view.heightAtWorld(tgt.x, tgt.z) + 2, tgt.z);
          if (p1) {
            o.line(p0.x, p0.y, p1.x, p1.y, 'rgba(255,106,77,0.9)', [6, 5], 2);
            o.marker(p1.x, p1.y, '#ff6a4d', 9);
          }
        }
      }
    }
  }

  /** The player's lost contacts: rival forces out of view, at their last known positions. */
  private lostContacts(): ArmySighting[] {
    const intel = this.state.intel[this.state.playerFactionId];
    return intel ? Object.values(intel.armies).filter((g) => !g.inSight) : [];
  }

  private ghostScreen(g: ArmySighting): { x: number; y: number } | null {
    return this.view.toScreen(g.x, this.view.heightAtWorld(g.x, g.z) + 2, g.z);
  }

  /** The last-known-position marker under a screen point, if any. */
  private ghostAt(sx: number, sy: number, touch: boolean): ArmySighting | null {
    const reach = touch ? 26 : 16;
    let best: ArmySighting | null = null;
    let bestD = reach;
    for (const g of this.lostContacts()) {
      const p = this.ghostScreen(g);
      if (!p) continue;
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) {
        bestD = d;
        best = g;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private keyboardCamera(dt: number): void {
    const k = this.app.keyboard;
    const sp = this.view.rig.dist * 1.1 * dt;
    let r = 0;
    let f = 0;
    if (k.isDown('KeyA') || k.isDown('ArrowLeft')) r -= sp;
    if (k.isDown('KeyD') || k.isDown('ArrowRight')) r += sp;
    if (k.isDown('KeyW') || k.isDown('ArrowUp')) f += sp;
    if (k.isDown('KeyS') || k.isDown('ArrowDown')) f -= sp;
    if (r || f) this.view.rig.panWorld(r, f);
    if (k.isDown('KeyQ')) this.view.rig.rotateBy(-1.6 * dt);
    if (k.isDown('KeyE')) this.view.rig.rotateBy(1.6 * dt);
    if (k.isDown('KeyR') || k.isDown('Equal') || k.isDown('NumpadAdd')) this.view.rig.zoomBy(Math.exp(-1.8 * dt));
    if (k.isDown('KeyF') || k.isDown('Minus') || k.isDown('NumpadSubtract')) this.view.rig.zoomBy(Math.exp(1.8 * dt));
  }

  private onKey(e: KeyboardEvent): void {
    if (this.suspended) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.setSpeed(this.speed === 0 ? 1 : 0);
    } else if (e.code === 'Digit1') this.setSpeed(1);
    else if (e.code === 'Digit2') this.setSpeed(2);
    else if (e.code === 'Digit3' || e.code === 'Digit4') this.setSpeed(4);
    else if (e.code === 'Escape') {
      if (this.placing) this.cancelPlacement();
      else if (this.selection) this.select(null);
      else this.openMenu();
    } else if (e.code === 'Enter' && this.placing) this.confirmPlacement();
  }

  private ownArmySelected(): string | null {
    const sel = this.selection;
    if (sel?.kind !== 'army') return null;
    const a = this.state.armies[sel.id];
    return a && a.factionId === this.state.playerFactionId ? a.id : null;
  }

  private onTap(sx: number, sy: number, info: PointerInfo): void {
    if (this.suspended) return;
    const touch = info.pointerType !== 'mouse';
    if (this.placing) {
      const g = this.view.groundAt(sx, sy);
      if (g) {
        this.placing.x = g.x;
        this.placing.z = g.z;
        this.updateGhost();
      }
      return;
    }
    if (info.button === 2) {
      this.onCommand(sx, sy);
      return;
    }
    const pick = this.view.pick(sx, sy, this.state, touch);
    if (!pick) return;
    // last known positions sit on open ground: they win over a ground or site tap
    const ghost = pick.kind === 'ground' || pick.kind === 'site' ? this.ghostAt(sx, sy, touch) : null;
    if (ghost) {
      const own = touch ? this.ownArmySelected() : null;
      if (own) this.move(own, ghost.x, ghost.z);
      else this.select({ kind: 'contact', id: ghost.armyId });
      return;
    }
    if (!touch) {
      // Mouse: left button selects/inspects, right button commands (RTS convention).
      if (pick.kind === 'army') this.select({ kind: 'army', id: pick.id! });
      else if (pick.kind === 'building') this.select({ kind: 'building', id: pick.id! });
      else if (pick.kind === 'base') this.select({ kind: 'base', id: pick.id! });
      else if (pick.kind === 'site') this.select({ kind: 'site', id: pick.id! });
      else if (pick.kind === 'ground') this.select(null);
      return;
    }
    const s = this.state;
    const pf = s.playerFactionId;
    const army = this.ownArmySelected();
    switch (pick.kind) {
      case 'army': {
        const a = s.armies[pick.id!];
        if (a.factionId === pf) this.select({ kind: 'army', id: a.id });
        else if (army) this.attack(army, { kind: 'army', id: a.id });
        else this.select({ kind: 'army', id: a.id });
        return;
      }
      case 'building': {
        const b = s.buildings[pick.id!];
        if (b.factionId !== pf && army) {
          if (isOutpost(s, b)) this.attack(army, { kind: 'building', id: b.id });
          else this.attack(army, { kind: 'base', id: b.baseId });
          return;
        }
        if (b.factionId === pf && army && !isOutpost(s, b)) {
          // tapping our own base while a force is selected: move there
          this.move(army, pick.x, pick.z);
          return;
        }
        this.select({ kind: 'building', id: b.id });
        return;
      }
      case 'base': {
        const base = s.bases[pick.id!];
        if (base.factionId !== pf && army) {
          this.attack(army, { kind: 'base', id: base.id });
          return;
        }
        if (army) {
          this.move(army, pick.x, pick.z);
          return;
        }
        this.select({ kind: 'base', id: base.id });
        return;
      }
      case 'site':
        if (army) {
          this.move(army, pick.x, pick.z);
          return;
        }
        this.select({ kind: 'site', id: pick.id! });
        return;
      case 'convoy':
        return;
      case 'ground':
        if (army) this.move(army, pick.x, pick.z);
        else this.select(null);
        return;
    }
  }

  /** Explicit command (right-click / long-press): move or attack with the selected force. */
  private onCommand(sx: number, sy: number): void {
    const army = this.ownArmySelected();
    if (!army) return;
    const pick = this.view.pick(sx, sy, this.state, true);
    if (!pick) return;
    const s = this.state;
    if (pick.kind === 'army' && s.armies[pick.id!].factionId !== s.playerFactionId) this.attack(army, { kind: 'army', id: pick.id! });
    else if (pick.kind === 'base' && s.bases[pick.id!].factionId !== s.playerFactionId) this.attack(army, { kind: 'base', id: pick.id! });
    else if (pick.kind === 'building' && s.buildings[pick.id!].factionId !== s.playerFactionId) {
      const b = s.buildings[pick.id!];
      this.attack(army, isOutpost(s, b) ? { kind: 'building', id: b.id } : { kind: 'base', id: b.baseId });
    } else this.move(army, pick.x, pick.z);
  }

  private move(armyId: string, x: number, z: number): void {
    if (!orderMove(this.ctx, armyId, x, z)) this.hud.toast('No route to that location.', 'warn');
    else this.sound('confirm');
    syncRng(this.ctx);
    this.hud.update(true);
  }

  private attack(armyId: string, t: { kind: 'army' | 'base' | 'building'; id: string }): void {
    const s = this.state;
    const rel = s.relations[0];
    const ok = orderAttack(this.ctx, armyId, t);
    if (!ok) {
      this.hud.toast('No route to the target.', 'warn');
      return;
    }
    if (rel && rel.status === 'standoff') this.hud.toast('Attack ordered. Engaging will end the standoff and start open hostilities.', 'warn');
    else this.hud.toast(`${s.armies[armyId]?.name ?? 'Task force'} ordered to attack.`, 'battle');
    this.hud.update(true);
  }

  // ---------------------------------------------------------------------------
  // Controller API (used by the HUD)
  // ---------------------------------------------------------------------------

  setSpeed(s: SpeedSetting): void {
    this.speed = s;
    this.hud.update(true);
  }

  select(sel: Selection, focus = false): void {
    this.selection = sel;
    this.view.selectedArmyId = sel?.kind === 'army' ? sel.id : null;
    this.view.selectedBaseId = sel?.kind === 'base' ? sel.id : null;
    this.view.selectedBuildingId = sel?.kind === 'building' ? sel.id : null;
    this.view.selectedSiteId = sel?.kind === 'site' ? sel.id : null;
    if (sel?.kind === 'base' && this.state.bases[sel.id]?.factionId === this.state.playerFactionId) this.hud.focusBaseId = sel.id;
    if (focus && sel) {
      const s = this.state;
      const p =
        sel.kind === 'army'
          ? s.armies[sel.id]
          : sel.kind === 'base'
            ? s.bases[sel.id]
            : sel.kind === 'building'
              ? s.buildings[sel.id]
              : sel.kind === 'contact'
                ? s.intel[s.playerFactionId]?.armies[sel.id]
                : s.sites[sel.id];
      if (p) this.view.rig.focus(p.x, p.z + 4, sel.kind === 'base' ? 48 : undefined);
    }
    this.hud.update(true);
  }

  showLogEntry(e: LogEntry): void {
    const s = this.state;
    const ref = e.ref;
    if (ref?.kind === 'army') {
      const a = s.armies[ref.id];
      if (a && isVisibleToFaction(s, s.playerFactionId, a.x, a.z)) {
        this.select({ kind: 'army', id: a.id }, true);
        return;
      }
      if (s.intel[s.playerFactionId]?.armies[ref.id]) {
        this.select({ kind: 'contact', id: ref.id }, true);
        return;
      }
    } else if (ref?.kind === 'base' && s.bases[ref.id]) {
      this.select({ kind: 'base', id: ref.id }, true);
      return;
    }
    if (e.at) this.view.rig.focus(e.at.x, e.at.z + 4);
  }

  private validateSelection(): void {
    const s = this.state;
    const sel = this.selection;
    if (!sel) return;
    const pf = s.playerFactionId;
    if (sel.kind === 'army' || sel.kind === 'contact') {
      // a rival force out of view becomes its last known position, and back again
      const a = s.armies[sel.id];
      const visible = !!a && (a.factionId === pf || isVisibleToFaction(s, pf, a.x, a.z));
      if (visible) {
        if (sel.kind === 'contact') this.select({ kind: 'army', id: sel.id });
      } else if (s.intel[pf]?.armies[sel.id]) {
        if (sel.kind === 'army') this.select({ kind: 'contact', id: sel.id });
      } else this.select(null);
      return;
    }
    const exists = (sel.kind === 'base' && s.bases[sel.id]) || (sel.kind === 'building' && s.buildings[sel.id]) || (sel.kind === 'site' && s.sites[sel.id]);
    if (!exists) this.select(null);
  }

  openMenu(): void {
    this.app.openPauseMenu();
  }

  armyStop(id: string): void {
    const a = this.state.armies[id];
    if (a) stopArmy(a);
    this.hud.update(true);
  }

  armyReturn(id: string): void {
    if (!orderReturn(this.ctx, id)) this.hud.toast('No route home.', 'warn');
    this.hud.update(true);
  }

  armyGarrison(id: string): void {
    if (!garrisonArmy(this.ctx, id)) this.hud.toast('Must be inside a friendly base perimeter.', 'warn');
    else this.select(null);
  }

  armyReinforce(id: string): void {
    const n = reinforceArmy(this.ctx, id);
    this.hud.toast(n ? `${n} units joined the task force.` : 'No room or no garrison units.', n ? 'econ' : 'warn');
    this.hud.update(true);
  }

  deployGarrison(baseId: string): void {
    const a = formArmyFromGarrison(this.ctx, baseId);
    syncRng(this.ctx);
    if (a) {
      this.select({ kind: 'army', id: a.id }, true);
      this.hud.toast(`${a.name} deployed. Tap the map to give it orders.`, 'econ');
    }
  }

  beginPlacement(baseId: string, typeId: BuildingTypeId): void {
    const base = this.state.bases[baseId];
    if (!base) return;
    const spot = suggestPlacement(this.state, this.world, base, typeId);
    if (!spot) {
      this.hud.toast('No free space inside the perimeter.', 'warn');
      return;
    }
    this.placing = { kind: 'building', typeId, baseId, x: spot.x, z: spot.z, valid: true, reason: '' };
    this.view.rig.focus(base.x, base.z + 3, 40);
    this.updateGhost();
    this.hud.update(true);
  }

  /** Choose a site for a new base founded from `fromBaseId` (map placement mode). */
  sendConvoy(fromId: string, toId: string, cargo: PartialStock, people: number): string | null {
    const r = sendConvoy(this.ctx, fromId, toId, cargo, people);
    if (!r.ok) return r.reason;
    this.hud.toast(`Convoy on its way to ${this.state.bases[toId]?.name ?? 'the base'}.`, 'econ');
    this.app.audio.ui('confirm');
    this.hud.update(true);
    return null;
  }

  setAutoSupply(armyId: string, on: boolean): void {
    const a = this.state.armies[armyId];
    if (!a || a.factionId !== this.state.playerFactionId) return;
    a.autoSupply = on;
    this.hud.toast(on ? `${a.name}: bases will send supplies when it runs low in the field.` : `${a.name}: automatic supply off.`, 'econ');
    this.hud.update(true);
  }

  addStandingConvoy(fromId: string, toId: string, cargo: PartialStock, people: number, everyHours: number): string | null {
    const err = addStandingTransfer(this.ctx, fromId, toId, cargo, people, everyHours);
    if (err) this.hud.toast(err, 'warn');
    else this.hud.toast(`Standing convoy to ${this.state.bases[toId]?.name ?? 'the base'} every ${everyHours} h.`, 'econ');
    this.hud.update(true);
    return err;
  }

  cancelStandingConvoy(id: string): void {
    cancelStandingTransfer(this.ctx, id);
    this.hud.update(true);
  }

  sendSupplyRun(fromId: string, armyId: string, cargo: PartialStock): string | null {
    const r = sendSupplyRun(this.ctx, fromId, armyId, cargo);
    if (!r.ok) return r.reason;
    this.hud.toast(`Supply run on its way to ${this.state.armies[armyId]?.name ?? 'the task force'}.`, 'econ');
    this.app.audio.ui('confirm');
    this.hud.update(true);
    return null;
  }

  beginBaseFounding(fromBaseId: string): void {
    const from = this.state.bases[fromBaseId];
    if (!from) return;
    const can = canFoundFrom(this.state, from);
    if (!can.ok) {
      this.hud.toast(can.reason, 'warn');
      return;
    }
    // suggest the nearest valid site, searching outwards
    let spot: { x: number; z: number } | null = null;
    for (let r = MIN_BASE_SPACING + 4; r <= MAX_FOUND_RANGE && !spot; r += 10) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = from.x + Math.cos(a) * r;
        const z = from.z + Math.sin(a) * r;
        if (validateBaseSite(this.state, this.world, from, x, z).ok) {
          spot = { x, z };
          break;
        }
      }
    }
    if (!spot) {
      this.hud.toast('No suitable site within range.', 'warn');
      return;
    }
    this.placing = { kind: 'base', typeId: 'hq', baseId: fromBaseId, x: spot.x, z: spot.z, valid: true, reason: '' };
    this.view.rig.focus(spot.x, spot.z, 85);
    this.updateGhost();
    this.hud.update(true);
  }

  private updateGhost(): void {
    const p = this.placing;
    if (!p) {
      this.view.setGhost(null);
      this.view.setGhostRing(null);
      return;
    }
    const base = this.state.bases[p.baseId];
    if (!base) {
      this.cancelPlacement();
      return;
    }
    if (p.kind === 'base') {
      const can = canFoundFrom(this.state, base);
      const r = can.ok ? validateBaseSite(this.state, this.world, base, p.x, p.z) : can;
      p.valid = r.ok;
      p.reason = r.ok ? '' : r.reason;
      const accent = FACTION_DEFS[this.state.factions[base.factionId]?.defId ?? '']?.structureAccent ?? '#3f86c0';
      this.view.setGhost('hq', p.x, p.z, p.valid, accent, Math.atan2(base.x - p.x, base.z - p.z));
      this.view.setGhostRing(p.x, p.z, BASE_RADIUS, p.valid);
      return;
    }
    const r = validatePlacement(this.state, this.world, base, p.typeId, p.x, p.z);
    p.valid = r.ok;
    p.reason = r.ok ? '' : r.reason;
    const accent = FACTION_DEFS[this.state.factions[base.factionId]?.defId ?? '']?.structureAccent ?? '#3f86c0';
    this.view.setGhost(p.typeId, p.x, p.z, p.valid, accent, Math.atan2(base.x - p.x, base.z - p.z) + Math.PI);
  }

  confirmPlacement(): void {
    const p = this.placing;
    if (!p) return;
    if (p.kind === 'base') {
      const fr = foundBase(this.ctx, p.baseId, p.x, p.z);
      if (!fr.ok) {
        this.hud.toast(fr.reason, 'warn');
        return;
      }
      this.placing = null;
      this.view.setGhost(null);
      this.view.setGhostRing(null);
      this.sound('confirm');
      this.select({ kind: 'base', id: fr.base.id });
      return;
    }
    const r = startConstruction(this.ctx, p.baseId, p.typeId, p.x, p.z);
    if (!r.ok) {
      this.hud.toast(r.reason, 'warn');
      return;
    }
    this.placing = null;
    this.view.setGhost(null);
    this.hud.toast(`${BUILDINGS[p.typeId].name} construction started.`, 'econ');
    this.select({ kind: 'building', id: r.building.id });
  }

  cancelPlacement(): void {
    this.placing = null;
    this.view.setGhost(null);
    this.view.setGhostRing(null);
    this.hud.update(true);
  }

  buildOutpost(baseId: string, siteId: string): void {
    const r = startOutpost(this.ctx, baseId, siteId);
    if (!r.ok) this.hud.toast(r.reason, 'warn');
    else {
      this.hud.toast('Outpost construction started. A road is being laid.', 'econ');
      this.select({ kind: 'building', id: r.building.id });
    }
  }

  queueUnit(buildingId: string, designId: string): void {
    const r = queueUnit(this.state, buildingId, designId);
    if (!r.ok) this.hud.toast(r.reason, 'warn');
    this.hud.update(true);
  }

  cancelOrder(buildingId: string, orderId: string): void {
    cancelOrder(this.state, buildingId, orderId);
    this.hud.update(true);
  }

  setRecipe(buildingId: string, mode: string): void {
    setRecipeMode(this.state, buildingId, mode);
    this.hud.update(true);
  }

  toggleBuilding(id: string): void {
    toggleEnabled(this.state, id);
    this.hud.update(true);
  }

  repair(id: string): void {
    const b = this.state.buildings[id];
    if (b) b.repairing = !b.repairing;
    this.hud.update(true);
  }

  rebuild(id: string): void {
    const r = rebuildBuilding(this.ctx, id);
    if (!r.ok) this.hud.toast(r.reason, 'warn');
    this.hud.update(true);
  }

  cancelConstruction(id: string): void {
    cancelConstruction(this.ctx, id);
    this.select(null);
  }

  // ---------------------------------------------------------------------------
  // Battles
  // ---------------------------------------------------------------------------

  commandBattle(): void {
    const p = this.state.pendingBattle;
    if (!p) return;
    const setup = createBattleSetup(this.state, this.world, p);
    void this.app.save('autosave', true);
    this.app.startBattle(setup);
  }

  private resolving = false;

  autoResolveBattle(): void {
    const p = this.state.pendingBattle;
    if (!p || this.resolving) return;
    this.resolving = true;
    const setup = createBattleSetup(this.state, this.world, p);
    const progress = this.hud.showProgress('Resolving engagement', setup.locationName);
    void autoResolveAsync(setup, this.world.terrain, { onProgress: (f) => progress.set(f) })
      .then((result) => {
        progress.close();
        this.finishBattle(setup, result);
      })
      .catch((err) => {
        progress.close();
        console.error(err);
        this.hud.toast('Auto-resolve failed; the engagement was broken off.', 'warn');
        this.state.pendingBattle = null;
      })
      .finally(() => {
        this.resolving = false;
      });
  }

  /** Apply a battle result (tactical or auto-resolved) and show the report. */
  finishBattle(setup: BattleSetup, result: BattleResult): void {
    const summary = applyBattleResult(this.ctx, setup, result);
    syncRng(this.ctx);
    this.validateSelection();
    this.hud.update(true);
    this.hud.showReport(summary.title, summary.lines, summary.playerWon);
    void this.app.save('autosave', true);
  }

  /** Debug/test helper: centre on an entity. */
  focusOn(x: number, z: number, d?: number): void {
    this.view.rig.focus(x, z, d);
  }

  distanceBetween(a: string, b: string): number {
    const A = this.state.armies[a];
    const B = this.state.armies[b];
    return A && B ? dist(A.x, A.z, B.x, B.z) : Infinity;
  }
}
