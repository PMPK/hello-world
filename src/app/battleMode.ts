import * as THREE from 'three';
import { BattleSim, isActive, isArmed, outOfAmmo } from '../battle/sim';
import { bHeight } from '../battle/terrain';
import type { BattleResult, BattleSetup, BUnit, SideIndex } from '../battle/types';
import type { Terrain } from '../world/terrain';
import { BattleView } from '../rendering/battleView';
import { FOE, FRIEND } from '../rendering/overlay';
import { Keyboard, PointerInput, type PointerInfo } from '../input/pointer';
import { BattleHud, type BattleController } from '../ui/battleHud';
import { el } from '../ui/dom';
import { openModal } from '../ui/screens';
import type { App, Mode } from './app';

/** Tactical battle mode. The campaign is frozen while this runs. */
export class BattleMode implements Mode, BattleController {
  readonly sim: BattleSim;
  readonly view: BattleView;
  readonly hud: BattleHud;
  readonly playerSide: SideIndex;
  private input: PointerInput;
  private keysOff: () => void;
  speed = 1;
  selected = new Set<number>();
  boxMode = false;
  attackMoveMode = false;
  /** Camera tracks the selection until the player pans manually. */
  follow = false;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private hudTimer = 0;
  private finishedShown = false;
  private finishTimer = 0;
  private orderMarks: { x: number; z: number; t: number; attack: boolean }[] = [];

  constructor(
    private readonly app: App,
    readonly setup: BattleSetup,
    strategic: Terrain,
    private readonly onFinished: (result: BattleResult) => void,
  ) {
    this.playerSide = setup.playerSide ?? 1;
    const ai: SideIndex[] = [0, 1].filter((s) => s !== setup.playerSide) as SideIndex[];
    this.sim = new BattleSim(setup, strategic, { aiSides: ai });
    this.view = new BattleView(app.gr, this.sim, this.playerSide, app.audio);
    this.hud = new BattleHud(app.ui, this);
    this.input = new PointerInput(app.canvas, {
      onTap: (x, y, i) => this.onTap(x, y, i, false),
      onDoubleTap: (x, y, i) => this.onTap(x, y, i, true),
      onLongPress: (x, y) => this.onLongPress(x, y),
      onDragStart: (x, y, info) => {
        const boxing = (info.pointerType === 'mouse' && info.button === 0) || (info.pointerType !== 'mouse' && this.boxMode);
        if (boxing) this.box = { x0: x, y0: y, x1: x, y1: y };
        return boxing;
      },
      onDrag: (x, y, dx, dy, info, claimed) => {
        if (claimed && this.box) {
          this.box.x1 = x;
          this.box.y1 = y;
          return;
        }
        if (info.pointerType === 'mouse' && info.button === 1) this.view.rig.rotateBy(dx * 0.006);
        else {
          this.view.rig.panPixels(dx, dy, this.app.gr.height);
          this.follow = false;
        }
      },
      onDragEnd: (_x, _y, info, claimed) => {
        if (claimed && this.box) {
          const ids = this.view.unitsInRect(this.box.x0, this.box.y0, this.box.x1, this.box.y1, this.playerSide);
          if (!(info.shift || info.ctrl)) this.selected.clear();
          for (const id of ids) this.selected.add(id);
          this.box = null;
          if (this.boxMode && ids.length) this.boxMode = false;
          this.syncSelection();
        }
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
    this.keysOff = app.keyboard.onKey((e) => this.onKey(e));
    // start with our whole force selected: the common first action is to move it
    this.selectAll();
  }

  // ---------------------------------------------------------------------------

  update(dt: number): void {
    this.keyboardCamera(dt, this.app.keyboard);
    // the ear sits at the camera's focus point; panning follows the camera's screen-right
    const rig = this.view.rig;
    this.app.audio.setListener(rig.target.x, rig.target.z, Math.cos(rig.yaw), -Math.sin(rig.yaw), 280 + rig.dist * 1.6);
    const simDt = this.sim.finished ? 0 : dt * this.speed;
    if (simDt > 0) this.sim.step(simDt);
    this.view.setHour(this.sim.hourNow());
    this.view.sync(this.sim.finished ? dt * 0.5 : simDt);
    this.view.update(dt);
    // drop dead units from selection
    for (const id of [...this.selected]) {
      const u = this.sim.unitById(id);
      if (!u || !isActive(u)) this.selected.delete(id);
    }
    if (this.follow) {
      const c = this.selectionCentre();
      if (c) this.view.rig.focus(c.x, c.z);
      else this.follow = false;
    }
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.2;
      this.hud.update();
    }
    if (this.sim.finished && !this.finishedShown) {
      this.finishTimer += dt;
      if (this.finishTimer > 0.1 && !this.hudBannerShown) {
        this.hudBannerShown = true;
        const won = this.sim.winner === this.playerSide;
        this.hud.showBanner(this.sim.winner === null ? 'STALEMATE' : won ? 'VICTORY' : this.sim.playerWithdrew ? 'WITHDRAWN' : 'DEFEAT', won ? 'ok' : 'bad');
      }
      if (this.finishTimer > 1.4) {
        this.finishedShown = true;
        this.showResult();
      }
    }
    this.drawOverlay();
  }

  private hudBannerShown = false;

  render(): void {
    this.view.render();
  }

  resize(): void {
    this.view.resize();
  }

  dispose(): void {
    this.input.dispose();
    this.keysOff();
    this.hud.dispose();
    this.view.dispose();
    this.app.overlay.clear();
  }

  private showResult(): void {
    const r = this.sim.computeResult();
    const me = r.sides[this.playerSide];
    const them = r.sides[this.playerSide === 0 ? 1 : 0];
    const won = r.winner === this.playerSide;
    const title = r.winner === null ? 'Stalemate' : won ? 'Victory' : r.playerWithdrew ? 'Withdrawal' : 'Defeat';
    const reasons: Record<BattleResult['reason'], string> = {
      eliminated: won ? 'The enemy force was destroyed.' : 'Our force was destroyed.',
      withdrawal: r.playerWithdrew ? 'We withdrew from the field.' : 'The enemy withdrew from the field.',
      timeout: 'Neither side could force a decision before nightfall.',
      undefended: 'The objective was undefended and has been secured.',
      retreat: won ? 'The enemy broke and retreated.' : 'Our forces were forced to retreat.',
    };
    const table = el('div', 'kv');
    const rows: [string, string, string][] = [
      ['Units lost', `${me.unitsLost} / ${me.unitsStart}`, `${them.unitsLost} / ${them.unitsStart}`],
      ['Soldiers killed', `${me.menKilled}`, `${them.menKilled}`],
      ['Vehicles lost', `${me.vehiclesLost}`, `${them.vehiclesLost}`],
      ['Crew rescued', `${me.crewSurvivors}`, '—'],
      ['Ammo spent', `${Math.round(me.ammoSpent)}`, `${Math.round(them.ammoSpent)}`],
      ['Fuel burned', `${me.fuelSpent.toFixed(1)}`, `${them.fuelSpent.toFixed(1)}`],
      ['Structures lost', `${me.buildingsLost}`, `${them.buildingsLost}`],
    ];
    const grid = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '4px 14px', fontSize: '13px' } });
    grid.append(el('div', { class: 'muted', text: '' }), el('div', { class: 'accent', text: 'OURS' }), el('div', { class: 'bad', text: 'ENEMY' }));
    for (const [k, a, b] of rows) grid.append(el('div', { class: 'muted', text: k }), el('div', { class: 'mono', text: a }), el('div', { class: 'mono', text: b }));
    void table;
    const hours = r.campaignHours;
    openModal(this.app.ui, {
      kicker: `Battle report · ${this.setup.locationName}`,
      title,
      body: [
        reasons[r.reason],
        grid,
        el('div', { class: 'hint', text: `Battle time ${Math.round(r.durationSeconds / 60)} min · campaign clock advances ${hours < 1 ? `${Math.round(hours * 60)} min` : `${hours.toFixed(1)} h`}. Results are permanent.` }),
      ],
      actions: [{ label: 'Return to campaign', cls: 'primary', onClick: () => this.onFinished(r) }],
    });
    const btns = this.app.ui.querySelectorAll('.modal-back:last-child .actions button');
    btns.forEach((b) => ((b as HTMLElement).dataset.testid = 'return-campaign'));
  }

  // ---------------------------------------------------------------------------
  // Overlay
  // ---------------------------------------------------------------------------

  private drawOverlay(): void {
    const o = this.app.overlay;
    o.clear();
    const far = this.view.rig.dist > 260;
    for (const u of this.sim.units) {
      if (!isActive(u) || u.inside !== null) continue; // garrisons are shown on their building
      const friendly = u.side === this.playerSide;
      if (!friendly && !u.seenBy[this.playerSide]) continue;
      const p = this.view.unitScreen(u, far ? 4 : 1.5);
      if (!p) continue;
      const sel = this.selected.has(u.id);
      const kind = u.stats.family;
      if (far || sel || !friendly) o.symbol(p.x, p.y - 8, kind, friendly, far ? 11 : 10, { selected: sel, alpha: far ? 1 : 0.85 });
      const hpF = u.hp / u.stats.maxHp;
      if (sel || hpF < 0.999) {
        o.bar(p.x, p.y + (far || sel || !friendly ? 2 : -4), 22, hpF, hpF > 0.6 ? '#6fd08c' : hpF > 0.3 ? '#e8c33c' : '#e2583f');
      }
      if (sel && u.stats.ammoCapacity > 0) {
        const a = u.ammo / u.stats.ammoCapacity;
        o.bar(p.x, p.y + 7, 22, a, a < 0.25 ? '#e2583f' : '#d9a03a', 2);
      }
      if (sel && u.order.type === 'move') {
        const dest = this.view.toScreen(u.order.x, bHeight(this.sim.terrain, u.order.x, u.order.z) + 0.5, u.order.z);
        const here = this.view.unitScreen(u, -2);
        if (dest && here) o.line(here.x, here.y, dest.x, dest.y, u.order.attackMove ? 'rgba(255,190,90,0.55)' : 'rgba(140,240,160,0.5)', [4, 4], 1.2);
      }
      if (sel && u.order.type === 'attack') {
        const tp = this.sim.targetPos(u.order.target);
        const here = this.view.unitScreen(u, -2);
        if (tp && here) {
          const t = this.view.toScreen(tp.x, bHeight(this.sim.terrain, tp.x, tp.z) + 2, tp.z);
          if (t) o.line(here.x, here.y, t.x, t.y, 'rgba(255,106,77,0.6)', [3, 4], 1.2);
        }
      }
      if (friendly && outOfAmmo(u)) o.label(p.x, p.y - 22, 'NO AMMO', '#e2583f', 9);
      else if (friendly && u.stats.fuelCapacity > 0 && u.fuel <= 0) o.label(p.x, p.y - 22, 'NO FUEL', '#e8c33c', 9);
    }
    // enemy structures marker for targeting
    for (const b of this.sim.buildings) {
      if (b.destroyed) continue;
      const hpF = b.hp / b.maxHp;
      if (b.defense) {
        // defensive positions are always marked: type tag, condition and (ours) ammunition
        const p = this.view.toScreen(b.x, bHeight(this.sim.terrain, b.x, b.z) + 9, b.z);
        if (!p) continue;
        const friendly = b.side === this.playerSide;
        const tag = b.defense.weapons.some((w) => w.antiVehicleOnly) ? 'AT GUN' : 'MG NEST';
        const armed = isArmed(b);
        o.label(p.x, p.y - 9, armed ? tag : `${tag} · SILENT`, armed ? (friendly ? FRIEND : FOE) : '#8a8a8a', 9);
        o.bar(p.x, p.y, 30, hpF, friendly ? FRIEND : FOE, 3);
        if (friendly && b.defense.ammoCapacity > 0) {
          const a = b.defense.ammo / b.defense.ammoCapacity;
          o.bar(p.x, p.y + 5, 30, a, a < 0.25 ? '#e2583f' : '#d9a03a', 2);
        }
        continue;
      }
      const friendlyB = b.side === this.playerSide;
      // garrison badge: ours always, theirs once spotted; free room while infantry is selected
      const inside = this.sim.occupants(b).filter((u) => friendlyB || u.seenBy[this.playerSide]);
      const cap = this.sim.garrisonCapacity(b);
      const showRoom = friendlyB && cap > 0 && this.selectionHasInfantry();
      if (inside.length || showRoom) {
        const p = this.view.toScreen(b.x, bHeight(this.sim.terrain, b.x, b.z) + 16, b.z);
        if (p) {
          const sel = inside.some((u) => this.selected.has(u.id));
          const text = friendlyB ? `GARRISON ${inside.length}/${cap}` : `GARRISON ${inside.length}`;
          o.label(p.x, p.y - 10, sel ? `▶ ${text}` : text, friendlyB ? FRIEND : FOE, 9);
        }
      }
      if (hpF >= 0.999 && !far) continue;
      const p = this.view.toScreen(b.x, bHeight(this.sim.terrain, b.x, b.z) + 22, b.z);
      if (!p) continue;
      o.bar(p.x, p.y, 34, hpF, friendlyB ? FRIEND : FOE, 3);
    }
    const now = this.sim.time;
    this.orderMarks = this.orderMarks.filter((m) => now - m.t < 1.2 || this.sim.finished);
    for (const m of this.orderMarks) {
      const p = this.view.toScreen(m.x, bHeight(this.sim.terrain, m.x, m.z) + 0.5, m.z);
      if (p) o.marker(p.x, p.y, m.attack ? '#ffbe5a' : '#8cf0a0', 8 + (now - m.t) * 6);
    }
    if (this.box) o.selectionBox(this.box.x0, this.box.y0, this.box.x1, this.box.y1);
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  private keyboardCamera(dt: number, k: Keyboard): void {
    const sp = this.view.rig.dist * 1.1 * dt;
    let r = 0;
    let f = 0;
    if (k.isDown('KeyA') && !k.isDown('ControlLeft')) r -= 0; // 'A' is attack-move
    if (k.isDown('ArrowLeft')) r -= sp;
    if (k.isDown('ArrowRight')) r += sp;
    if (k.isDown('ArrowUp') || k.isDown('KeyW')) f += sp;
    if (k.isDown('ArrowDown')) f -= sp;
    if (k.isDown('KeyD')) r += sp;
    if (r || f) {
      this.view.rig.panWorld(r, f);
      this.follow = false;
    }
    if (k.isDown('KeyQ')) this.view.rig.rotateBy(-1.6 * dt);
    if (k.isDown('KeyE')) this.view.rig.rotateBy(1.6 * dt);
    if (k.isDown('KeyR') || k.isDown('Equal')) this.view.rig.zoomBy(Math.exp(-1.8 * dt));
    if (k.isDown('KeyF') || k.isDown('Minus')) this.view.rig.zoomBy(Math.exp(1.8 * dt));
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      e.preventDefault();
      this.setSpeed(this.speed === 0 ? 1 : 0);
    } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.selectAll();
    } else if (e.code === 'KeyA') {
      this.attackMoveMode = !this.attackMoveMode;
      this.hud.update();
    } else if (e.code === 'KeyH') this.hold();
    else if (e.code === 'KeyS') this.stop();
    else if (e.code === 'KeyX') this.retreatSelected();
    else if (e.code === 'KeyC') this.focusSelection();
    else if (e.code === 'KeyV') this.toggleFollow();
    else if (e.code === 'Escape') {
      this.boxMode = false;
      this.attackMoveMode = false;
      this.clearSelection();
    } else if (e.code === 'Digit1') this.setSpeed(1);
    else if (e.code === 'Digit2') this.setSpeed(2);
  }

  private mine(u: BUnit | undefined): boolean {
    return !!u && u.side === this.playerSide && isActive(u);
  }

  private onTap(sx: number, sy: number, info: PointerInfo, double: boolean): void {
    if (this.sim.finished) return;
    const touch = info.pointerType !== 'mouse';
    const pick = this.view.pick(sx, sy, touch, this.playerSide);
    if (!pick) return;
    const additive = info.shift || info.ctrl;
    const commandButton = info.pointerType === 'mouse' && info.button === 2;
    if (pick.kind === 'unit') {
      const u = this.sim.unitById(pick.id)!;
      if (this.mine(u) && !commandButton) {
        if (double) {
          this.selectSameTypeAs(u);
          return;
        }
        if (additive) {
          if (this.selected.has(u.id)) this.selected.delete(u.id);
          else this.selected.add(u.id);
        } else if (this.selected.size === 1 && this.selected.has(u.id)) {
          this.selected.clear();
        } else {
          this.selected.clear();
          this.selected.add(u.id);
        }
        this.syncSelection();
        return;
      }
      if (!this.mine(u) && this.selected.size) {
        this.sim.orderAttack([...this.selected], { kind: 'unit', id: u.id });
        this.orderMarks.push({ x: u.x, z: u.z, t: this.sim.time, attack: true });
        this.app.audio.ui('confirm');
        return;
      }
      return;
    }
    if (pick.kind === 'building') {
      const b = this.sim.buildingById(pick.id)!;
      if (b.side !== this.playerSide && this.selected.size) {
        this.sim.orderAttack([...this.selected], { kind: 'building', id: b.id });
        this.orderMarks.push({ x: b.x, z: b.z, t: this.sim.time, attack: true });
        this.app.audio.ui('confirm');
        return;
      }
      if (b.side === this.playerSide && !commandButton && !this.selected.size) {
        // tapping one of our buildings selects its garrison
        const inside = this.sim.occupants(b);
        if (inside.length) {
          for (const u of inside) this.selected.add(u.id);
          this.syncSelection();
        }
        return;
      }
      if (b.side === this.playerSide && this.selected.size) {
        // infantry occupy the building (as many as it holds); everyone else moves next to it
        const ids = [...this.selected];
        const sent = this.sim.orderGarrison(ids, b.id);
        const rest = ids.filter((id) => {
          const u = this.sim.unitById(id);
          return !!u && u.inside !== b.id && !(u.order.type === 'garrison' && u.order.buildingId === b.id);
        });
        const g = this.view.groundAt(sx, sy);
        if (rest.length && g) this.sim.orderMove(rest, g.x, g.z, this.attackMoveMode);
        if (sent || rest.length) {
          this.orderMarks.push({ x: b.x, z: b.z, t: this.sim.time, attack: false });
          this.app.audio.ui('confirm');
        }
        if (sent < ids.filter((id) => this.sim.unitById(id)?.stats.family === 'infantry').length) this.hud.toast(sent ? 'The building is full — the rest wait outside.' : 'No room in that building.');
        return;
      }
      if (this.selected.size) {
        const g = this.view.groundAt(sx, sy);
        if (g) this.issueMove(g.x, g.z, this.attackMoveMode);
      }
      return;
    }
    // ground
    if (!this.selected.size) return;
    if (info.pointerType === 'mouse' && info.button === 0 && !this.attackMoveMode) {
      // RTS mouse convention: left-click on empty ground deselects, right-click moves
      this.clearSelection();
      return;
    }
    this.issueMove(pick.x, pick.z, this.attackMoveMode);
  }

  private onLongPress(sx: number, sy: number): void {
    if (!this.selected.size || this.sim.finished) return;
    const g = this.view.groundAt(sx, sy);
    if (g) this.issueMove(g.x, g.z, true);
  }

  private issueMove(x: number, z: number, attackMove: boolean): void {
    this.sim.orderMove([...this.selected], x, z, attackMove);
    this.orderMarks.push({ x, z, t: this.sim.time, attack: attackMove });
    this.app.audio.ui('confirm');
    if (this.attackMoveMode) {
      this.attackMoveMode = false;
      this.hud.update();
    }
  }

  private selectionHasInfantry(): boolean {
    for (const id of this.selected) if (this.sim.unitById(id)?.stats.family === 'infantry') return true;
    return false;
  }

  private syncSelection(): void {
    this.view.selected = this.selected;
    this.hud.update();
  }

  // ---------------------------------------------------------------------------
  // Controller API
  // ---------------------------------------------------------------------------

  setSpeed(s: number): void {
    this.speed = s;
    this.hud.update();
  }

  selectAll(): void {
    this.selected.clear();
    for (const u of this.sim.units) if (this.mine(u)) this.selected.add(u.id);
    this.syncSelection();
  }

  private selectSameTypeAs(ref: BUnit): void {
    this.selected.clear();
    for (const u of this.sim.units) {
      if (!this.mine(u) || u.stats.family !== ref.stats.family) continue;
      const p = this.view.unitScreen(u);
      if (p && p.x >= 0 && p.y >= 0 && p.x <= this.app.gr.width && p.y <= this.app.gr.height) this.selected.add(u.id);
    }
    this.selected.add(ref.id);
    this.syncSelection();
  }

  selectSameType(): void {
    const first = [...this.selected].map((id) => this.sim.unitById(id)).find((u) => this.mine(u));
    if (!first) {
      this.selectAll();
      return;
    }
    // cycle: infantry -> tanks -> jeeps based on current
    const present = ['infantry', 'tank', 'light_vehicle', 'support'].filter((f) => this.sim.units.some((u) => this.mine(u) && u.stats.family === f));
    const famNow = first.stats.family;
    const allSame = [...this.selected].every((id) => this.sim.unitById(id)?.stats.family === famNow);
    const fam = allSame ? present[(present.indexOf(famNow) + 1) % present.length] : famNow;
    this.selected.clear();
    for (const u of this.sim.units) if (this.mine(u) && u.stats.family === fam) this.selected.add(u.id);
    this.syncSelection();
  }

  hold(): void {
    this.sim.orderHold([...this.selected]);
    this.hud.update();
  }

  stop(): void {
    this.sim.orderStop([...this.selected]);
    this.hud.update();
  }

  retreatSelected(): void {
    if (!this.selected.size) return;
    this.sim.orderRetreat([...this.selected]);
    this.hud.update();
  }

  withdraw(): void {
    this.sim.withdraw(this.playerSide);
  }

  secure(): void {
    this.sim.secure(this.playerSide);
  }

  private centreOf(list: BUnit[]): { x: number; z: number } | null {
    if (!list.length) return null;
    let x = 0;
    let z = 0;
    for (const u of list) {
      x += u.x;
      z += u.z;
    }
    return { x: x / list.length, z: z / list.length };
  }

  private selectionCentre(): { x: number; z: number } | null {
    return this.centreOf([...this.selected].map((id) => this.sim.unitById(id)).filter((u): u is BUnit => !!u && isActive(u)));
  }

  focusSelection(): void {
    const c = this.selectionCentre() ?? this.centreOf(this.sim.units.filter((u) => this.mine(u)));
    if (c) this.view.rig.focus(c.x, c.z);
  }

  selectOnly(id: number): void {
    const u = this.sim.unitById(id);
    if (!this.mine(u)) return;
    this.selected.clear();
    this.selected.add(id);
    this.syncSelection();
  }

  clearSelection(): void {
    this.selected.clear();
    this.follow = false;
    this.syncSelection();
  }

  toggleFollow(): void {
    this.follow = !this.follow && this.selected.size > 0;
    if (this.follow) this.focusSelection();
    this.hud.update();
  }

  jumpCamera(x: number, z: number): void {
    this.follow = false;
    this.view.rig.focus(x, z);
  }

  viewFootprint(): { x: number; z: number }[] | null {
    const w = this.app.gr.width;
    const h = this.app.gr.height;
    const pts: { x: number; z: number }[] = [];
    for (const [sx, sy] of [
      [0, h * 0.18],
      [w, h * 0.18],
      [w, h],
      [0, h],
    ]) {
      const v = this.view.rig.groundAt((sx / w) * 2 - 1, -(sy / h) * 2 + 1, 0);
      if (!v) return null;
      pts.push({ x: THREE.MathUtils.clamp(v.x, -200, 1000), z: THREE.MathUtils.clamp(v.z, -200, 1000) });
    }
    return pts;
  }
}
