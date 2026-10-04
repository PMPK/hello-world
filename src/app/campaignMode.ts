import { CAMPAIGN_HOURS_PER_SECOND, type SpeedSetting } from '../core/time';
import { dist } from '../core/math';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { statsOf } from '../units/stats';
import {
  formArmyFromGarrison,
  fuelRange,
  garrisonArmy,
  orderAttack,
  orderMove,
  orderReturn,
  reinforceArmy,
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
import { isOutpost, isVisibleToFaction } from '../campaign/queries';
import { SIM_STEP, stepCampaign } from '../campaign/sim';
import type { CampaignState } from '../campaign/types';
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

/** Strategic map mode: drives the campaign simulation and its view/HUD. */
export class CampaignMode implements Mode, CampaignController {
  readonly ctx: SimContext;
  readonly view: CampaignView;
  readonly hud: CampaignHud;
  private input: PointerInput;
  private keys: () => void;
  speed: SpeedSetting = 1;
  selection: Selection = null;
  placing: { typeId: BuildingTypeId; baseId: string; x: number; z: number; valid: boolean; reason: string } | null = null;
  private acc = 0;
  private hudTimer = 0;
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
    this.view.sync(this.state, dt);
    this.view.update(dt);
    if (this.placing) this.updateGhost();
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.25;
      this.validateSelection();
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
      let tank = 0;
      let inf = 0;
      let jeep = 0;
      let support = 0;
      for (const u of a.units) {
        const f = statsOf(u.designId).family;
        if (f === 'tank') tank++;
        else if (f === 'infantry') inf++;
        else if (f === 'support') support++;
        else jeep++;
      }
      const kind: SymbolKind = tank && inf ? 'mixed' : tank ? 'tank' : inf ? 'infantry' : jeep ? 'light_vehicle' : support ? 'support' : 'light_vehicle';
      const friendly = a.factionId === s.playerFactionId;
      const selected = this.selection?.kind === 'army' && this.selection.id === a.id;
      const pips = a.units.length <= 4 ? 1 : a.units.length <= 10 ? 2 : 3;
      o.symbol(p.x, p.y, kind, friendly, selected ? 15 : 13, { selected, pips });
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
      void jeep;
    }
    // pending order line for the selected army
    const sel = this.selection;
    if (sel?.kind === 'army') {
      const a = s.armies[sel.id];
      if (a && a.order.type !== 'idle' && a.order.type !== 'move' && a.order.type !== 'return' && a.factionId === s.playerFactionId) {
        const tgt =
          a.order.type === 'attack_army'
            ? s.armies[a.order.targetId]
            : a.order.type === 'attack_base'
              ? s.bases[a.order.targetId]
              : s.buildings[a.order.targetId];
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
        sel.kind === 'army' ? s.armies[sel.id] : sel.kind === 'base' ? s.bases[sel.id] : sel.kind === 'building' ? s.buildings[sel.id] : s.sites[sel.id];
      if (p) this.view.rig.focus(p.x, p.z + 4, sel.kind === 'base' ? 48 : undefined);
    }
    this.hud.update(true);
  }

  private validateSelection(): void {
    const s = this.state;
    const sel = this.selection;
    if (!sel) return;
    const exists =
      (sel.kind === 'army' && s.armies[sel.id] && (s.armies[sel.id].factionId === s.playerFactionId || isVisibleToFaction(s, s.playerFactionId, s.armies[sel.id].x, s.armies[sel.id].z))) ||
      (sel.kind === 'base' && s.bases[sel.id]) ||
      (sel.kind === 'building' && s.buildings[sel.id]) ||
      (sel.kind === 'site' && s.sites[sel.id]);
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
    this.placing = { typeId, baseId, x: spot.x, z: spot.z, valid: true, reason: '' };
    this.view.rig.focus(base.x, base.z + 3, 40);
    this.updateGhost();
    this.hud.update(true);
  }

  private updateGhost(): void {
    const p = this.placing;
    if (!p) {
      this.view.setGhost(null);
      return;
    }
    const base = this.state.bases[p.baseId];
    if (!base) {
      this.cancelPlacement();
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
