import { formatClock } from '../core/time';
import { buildingDisplayName } from '../data/buildings';
import { outOfAmmo, type BattleSim } from '../battle/sim';
import type { BUnit, SideIndex } from '../battle/types';
import { btn, clear, el, ICONS, iconBtn } from './dom';
import { Minimap } from './minimap';
import { confirmModal, Toasts } from './screens';

export interface BattleController {
  readonly sim: BattleSim;
  readonly playerSide: SideIndex;
  readonly speed: number;
  readonly selected: Set<number>;
  readonly follow: boolean;
  boxMode: boolean;
  attackMoveMode: boolean;
  setSpeed(s: number): void;
  selectAll(): void;
  selectSameType(): void;
  selectOnly(id: number): void;
  clearSelection(): void;
  toggleFollow(): void;
  hold(): void;
  stop(): void;
  retreatSelected(): void;
  withdraw(): void;
  secure(): void;
  focusSelection(): void;
  jumpCamera(x: number, z: number): void;
  viewFootprint(): { x: number; z: number }[] | null;
}

/** Simplified NATO frame + modifier for the unit card (friendly colours). */
const NATO_GLYPH: Record<string, string> = {
  infantry: '<path d="M2 2L22 14M22 2L2 14"/>',
  tank: '<rect x="6" y="4.5" width="12" height="7" rx="3.5"/>',
  light_vehicle: '<path d="M2 14L22 2"/>',
  support: '<path d="M1 11.5H23"/>',
};

function natoIcon(family: string): string {
  return `<svg viewBox="0 0 24 16" class="nato"><rect x="1" y="1" width="22" height="14"/>${NATO_GLYPH[family] ?? ''}</svg>`;
}

/** Human-readable description of what a unit is doing right now. */
export function describeOrder(sim: BattleSim, u: BUnit): string {
  const o = u.order;
  if (!u.stats.weapons.length) {
    // unarmed support vehicles
    if (o.type === 'move') return 'Moving';
    if (o.type === 'retreat') return 'Falling back';
    return u.ammo > 0 || u.fuel > 5 ? 'Standing by · resupplying units nearby' : 'Standing by · cargo empty';
  }
  const engaging = !!u.target && sim.targetValid(u, u.target);
  if (u.inside !== null) {
    const b = sim.buildingById(u.inside);
    const where = b ? buildingDisplayName(b.spec.typeId, b.spec.siteKind ?? undefined) : 'building';
    return `Garrisoned in ${where}${engaging ? ' · firing' : ''} · move to leave`;
  }
  switch (o.type) {
    case 'garrison': {
      const b = sim.buildingById(o.buildingId);
      return `Entering ${b ? buildingDisplayName(b.spec.typeId, b.spec.siteKind ?? undefined) : 'building'}`;
    }
    case 'move':
      if (o.attackMove) return engaging ? 'Attack-move · engaging' : 'Attack-moving';
      return u.path.length ? 'Moving' : engaging ? 'Engaging' : 'Holding ground';
    case 'attack': {
      const t = o.target;
      if (t.kind === 'building') {
        const b = sim.buildingById(t.id);
        return `Attacking ${b ? buildingDisplayName(b.spec.typeId, b.spec.siteKind ?? undefined) : 'structure'}`;
      }
      const e = sim.unitById(t.id);
      return `Attacking ${e ? e.stats.name : 'target'}`;
    }
    case 'hold':
      return engaging ? 'Hold position · firing' : 'Hold position';
    case 'retreat':
      return 'Falling back';
    default:
      return engaging ? 'Engaging' : 'Idle · fires at will';
  }
}

interface CardRefs {
  update(): void;
}

export class BattleHud {
  readonly root: HTMLElement;
  private clockEl!: HTMLElement;
  private toasts: Toasts;
  private forces!: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private endBtn!: HTMLButtonElement;
  private withdrawBtn!: HTMLButtonElement;
  private boxBtn!: HTMLButtonElement;
  private amBtn!: HTMLButtonElement;
  private selInfo: HTMLElement;
  private card: HTMLElement;
  private cardSig = '';
  private cardRefs: CardRefs | null = null;
  private minimap: Minimap;
  private banner: HTMLElement | null = null;
  private hintShown = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly c: BattleController,
  ) {
    this.root = el('div', 'passthrough');
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.root.append(this.buildTop(), this.buildCmd());
    this.selInfo = el('div', 'panel selinfo');
    this.card = el('div', { class: 'panel unitcard', dataset: { testid: 'unit-card' } });
    this.card.style.display = 'none';
    this.root.append(this.selInfo, this.card);
    this.toasts = new Toasts(this.root);
    this.toasts.el.classList.add('battle-toasts');
    host.append(this.root);
    this.minimap = new Minimap(this.root, c.sim, c.playerSide, (x, z) => c.jumpCamera(x, z));
    this.update();
  }

  dispose(): void {
    this.root.remove();
  }

  /** Short notice under the top bar (clear of the minimap and the command bar). */
  toast(text: string, kind = 'warn'): void {
    this.toasts.push(text, kind, 2600);
  }

  private buildTop(): HTMLElement {
    const top = el('div', 'topbar');
    const menuBtn = iconBtn(ICONS.focus, 'Center on selection', () => this.c.focusSelection(), 'panel');
    const clock = el('div', 'panel clock');
    this.clockEl = el('div', 'date');
    const loc = el('div', { class: 'day', text: this.c.sim.setup.locationName });
    clock.append(this.clockEl, loc);
    const seg = el('div', 'seg panel');
    const speeds = [0, 1, 2];
    this.speedBtns = speeds.map((s) => {
      const b = s === 0 ? iconBtn(ICONS.pause, 'Pause', () => this.c.setSpeed(0)) : btn(`${s}×`, () => this.c.setSpeed(s));
      b.dataset.testid = `bspeed-${s}`;
      return b;
    });
    seg.append(...this.speedBtns);
    this.forces = el('div', 'panel forces');
    this.endBtn = btn('End battle', () => this.c.secure(), 'primary');
    this.endBtn.dataset.testid = 'end-battle';
    this.endBtn.style.display = 'none';
    this.withdrawBtn = btn('Withdraw', () =>
      confirmModal(
        this.host,
        'Withdraw from battle?',
        'All our units will pull back. Units currently in contact may be caught during the withdrawal. The enemy holds the field.',
        'Withdraw',
        () => this.c.withdraw(),
        true,
      ),
    'panel danger');
    this.withdrawBtn.dataset.testid = 'withdraw';
    top.append(menuBtn, clock, seg, this.forces, this.endBtn, this.withdrawBtn);
    return top;
  }

  private buildCmd(): HTMLElement {
    const bar = el('div', 'panel cmdbar');
    const mk = (icon: string, label: string, fn: () => void, id: string): HTMLButtonElement => {
      const b = el('button', { class: 'btn', attrs: { type: 'button', 'aria-label': label }, onclick: () => fn() });
      b.innerHTML = icon;
      b.append(el('span', { text: label }));
      b.dataset.testid = id;
      return b;
    };
    this.boxBtn = mk(ICONS.box, 'Box', () => {
      this.c.boxMode = !this.c.boxMode;
      this.update();
    }, 'cmd-box');
    this.amBtn = mk(ICONS.attackMove, 'Atk-Move', () => {
      this.c.attackMoveMode = !this.c.attackMoveMode;
      this.update();
    }, 'cmd-attackmove');
    bar.append(
      mk(ICONS.all, 'All', () => this.c.selectAll(), 'cmd-all'),
      mk(ICONS.type, 'Type', () => this.c.selectSameType(), 'cmd-type'),
      this.boxBtn,
      this.amBtn,
      mk(ICONS.hold, 'Hold', () => this.c.hold(), 'cmd-hold'),
      mk(ICONS.stop, 'Stop', () => this.c.stop(), 'cmd-stop'),
      mk(ICONS.retreat, 'Fall back', () => this.c.retreatSelected(), 'cmd-retreat'),
    );
    return bar;
  }

  update(): void {
    const sim = this.c.sim;
    this.clockEl.textContent = `${formatClock(sim.time)} / ${formatClock(sim.setup.timeLimit)}`;
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', [0, 1, 2][i] === this.c.speed));
    this.boxBtn.classList.toggle('active', this.c.boxMode);
    this.amBtn.classList.toggle('active', this.c.attackMoveMode);
    // forces
    const me = this.c.playerSide;
    const them: SideIndex = me === 0 ? 1 : 0;
    const count = (s: SideIndex): { alive: number; total: number; power: number } => {
      let alive = 0;
      let total = 0;
      for (const u of sim.units) {
        if (u.side !== s) continue;
        total++;
        if (u.alive && !u.retreated) alive++;
      }
      return { alive, total, power: sim.sidePower(s, true) };
    };
    const a = count(me);
    const b = count(them);
    clear(this.forces);
    const mkSide = (label: string, cnt: { alive: number; total: number; power: number }, start: number, color: string, known: boolean): HTMLElement => {
      const f = el('div', 'side-f');
      f.append(el('div', 'lbl', el('span', { text: label, style: { color } }), el('span', { class: 'mono', text: known ? `${cnt.alive}/${cnt.total}` : `?/${cnt.total}` })));
      const bb = el('div', 'bar');
      const frac = start > 0 ? cnt.power / start : 0;
      bb.append(el('i', { style: { width: `${Math.max(0, Math.min(1, frac)) * 100}%`, background: color } }));
      f.append(bb);
      return f;
    };
    this.forces.append(
      mkSide('OURS', a, sim.startPower[me], '#5fb4ff', true),
      mkSide('ENEMY', b, sim.startPower[them], '#ff6a4d', false),
    );
    const canEnd = sim.canSecure(me) && !sim.finished;
    this.endBtn.style.display = canEnd ? '' : 'none';
    this.withdrawBtn.style.display = sim.finished ? 'none' : '';
    // selection
    const sel = [...this.c.selected].map((id) => sim.unitById(id)).filter((u): u is BUnit => !!u && u.alive);
    clear(this.selInfo);
    if (this.c.attackMoveMode && sel.length) {
      this.selInfo.style.display = '';
      this.selInfo.append(el('span', { class: 'warn', text: 'ATTACK-MOVE · choose a destination' }));
    } else if (!sel.length && (!this.hintShown || sim.time < 25)) {
      this.selInfo.style.display = '';
      const mouse = !window.matchMedia?.('(pointer: coarse)').matches;
      this.selInfo.append(
        el('span', {
          class: 'muted',
          text: mouse
            ? 'Click or drag-box to select · right-click ground to move · right-click enemy to attack · A = attack-move'
            : 'Tap a unit or use BOX to select · tap ground to move · tap enemy to attack · hold = attack-move',
        }),
      );
      if (sim.time > 25) this.hintShown = true;
    } else this.selInfo.style.display = 'none';
    this.updateCard(sel);
    this.minimap.draw(this.c.viewFootprint());
  }

  // ---------------------------------------------------------------------------
  // Unit card
  // ---------------------------------------------------------------------------

  /**
   * The card is only rebuilt when the selection changes; periodic updates
   * patch text and bars in place so taps on its buttons are never lost to a
   * DOM rebuild between pointerdown and pointerup.
   */
  private updateCard(sel: BUnit[]): void {
    if (!sel.length || this.c.sim.finished) {
      this.card.style.display = 'none';
      this.cardSig = '';
      this.cardRefs = null;
      return;
    }
    this.card.style.display = '';
    const sig = sel.length === 1 ? `1:${sel[0].id}` : `n:${sel.map((u) => u.id).join(',')}`;
    if (sig !== this.cardSig) {
      this.cardSig = sig;
      clear(this.card);
      this.cardRefs = sel.length === 1 ? this.buildSingle(sel[0]) : this.buildMulti(sel);
    }
    this.cardRefs?.update();
  }

  private cardHead(icon: string, title: string, sub: string): { head: HTMLElement; followBtn: HTMLButtonElement } {
    const head = el('div', 'uc-head');
    const ic = el('div', 'uc-icon');
    ic.innerHTML = icon;
    const txt = el('div', 'uc-title', el('div', { class: 'uc-name', text: title }), el('div', { class: 'uc-sub', text: sub }));
    const followBtn = iconBtn(ICONS.target, 'Follow with camera', () => {
      this.c.toggleFollow();
      followBtn.classList.toggle('active', this.c.follow);
    }, 'ghost');
    followBtn.dataset.testid = 'unit-follow';
    const closeBtn = iconBtn(ICONS.close, 'Clear selection', () => this.c.clearSelection(), 'ghost');
    closeBtn.dataset.testid = 'unit-deselect';
    head.append(ic, txt, followBtn, closeBtn);
    return { head, followBtn };
  }

  /** Short callsign: type code + ordinal among the side's units of that design ("INF 2"). */
  private callsign(u: BUnit): string {
    let n = 0;
    for (const o of this.c.sim.units) {
      if (o.side !== u.side || o.spec.designId !== u.spec.designId) continue;
      n++;
      if (o === u) break;
    }
    return `${u.stats.short} ${n}`;
  }

  private buildSingle(u: BUnit): CardRefs {
    const sim = this.c.sim;
    const crewLabel = u.stats.isVehicle ? 'Crew' : 'Men';
    const { head, followBtn } = this.cardHead(natoIcon(u.stats.family), this.callsign(u), u.stats.name);
    const mkRow = (label: string): { row: HTMLElement; fill: HTMLElement; val: HTMLElement } => {
      const fill = el('i');
      const val = el('span', 'uc-val mono');
      const row = el('div', 'uc-row', el('span', { class: 'uc-lbl', text: label }), el('div', 'bar', fill), val);
      return { row, fill, val };
    };
    const hp = mkRow('HP');
    const ammo = mkRow(u.stats.weapons.length ? 'AMMO' : 'CARGO');
    const fuel = mkRow('FUEL');
    const men = el('div', 'uc-line mono');
    const weapons = el('div', 'uc-weapons');
    for (const w of u.stats.weapons) {
      weapons.append(el('div', 'uc-weapon', el('span', { text: w.name }), el('span', { class: 'mono muted', text: `${Math.round(w.range)} m` })));
    }
    if (!u.stats.weapons.length) {
      weapons.append(el('div', { class: 'muted', text: 'Unarmed · rearms and refuels units within 45 m' }));
    }
    const order = el('div', 'uc-order');
    const flags = el('div', 'uc-flags');
    this.card.append(head, men, hp.row, ammo.row);
    if (u.stats.fuelCapacity > 0) this.card.append(fuel.row);
    this.card.append(weapons, order, flags);
    let flagSig = '';
    const setBar = (r: { fill: HTMLElement; val: HTMLElement }, f: number, text: string, color: string): void => {
      const c = Math.max(0, Math.min(1, f));
      r.fill.style.width = `${(c * 100).toFixed(1)}%`;
      r.fill.style.background = color;
      r.val.textContent = text;
    };
    return {
      update: () => {
        followBtn.classList.toggle('active', this.c.follow);
        men.textContent = `${crewLabel} ${u.men}/${u.menStart || u.stats.crew} · kills ${u.kills}`;
        const hpF = u.hp / u.stats.maxHp;
        setBar(hp, hpF, `${Math.round(hpF * 100)}%`, hpF > 0.6 ? 'var(--ok)' : hpF > 0.3 ? 'var(--warn)' : 'var(--danger)');
        const aF = u.stats.ammoCapacity > 0 ? u.ammo / u.stats.ammoCapacity : 0;
        setBar(ammo, aF, `${Math.round(u.ammo)}/${u.stats.ammoCapacity}`, aF < 0.25 ? 'var(--danger)' : '#d9a03a');
        if (u.stats.fuelCapacity > 0) {
          const fF = u.fuel / u.stats.fuelCapacity;
          setBar(fuel, fF, `${u.fuel.toFixed(1)}/${u.stats.fuelCapacity}`, fF < 0.2 ? 'var(--danger)' : '#7fb2c9');
        }
        order.textContent = describeOrder(sim, u);
        const f: [string, string][] = [];
        if (u.inside !== null) f.push(['In building', 'ok']);
        else if (u.inForest) f.push(['Forest cover', 'ok']);
        else if (u.cover > 0) f.push(['Near structure', 'ok']);
        if (u.suppression > 0.4) f.push(['Suppressed', 'warn']);
        if (outOfAmmo(u)) f.push(['Out of ammo', 'bad']);
        if (u.stats.fuelCapacity > 0 && u.fuel <= 0) f.push(['Out of fuel', 'bad']);
        if (sim.time - u.lastHit < 3) f.push(['Under fire', 'warn']);
        const sig = f.map((x) => x[0]).join('|');
        if (sig !== flagSig) {
          flagSig = sig;
          clear(flags);
          for (const [t, cls] of f) flags.append(el('span', { class: `chip ${cls}`, text: t }));
        }
      },
    };
  }

  private buildMulti(sel: BUnit[]): CardRefs {
    const counts: Record<string, number> = {};
    for (const u of sel) counts[u.stats.short] = (counts[u.stats.short] ?? 0) + 1;
    const sub = Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ');
    const { head, followBtn } = this.cardHead(ICONS.all, `${sel.length} units`, 'selected');
    const grid = el('div', 'uc-grid');
    const small = window.innerHeight <= 430;
    const max = small ? 12 : 20;
    const shown = sel.slice(0, max);
    const badges = shown.map((u) => {
      const fill = el('i');
      const b = el(
        'button',
        {
          class: 'uc-badge',
          attrs: { type: 'button', 'aria-label': `Select ${u.stats.name}` },
          onclick: () => this.c.selectOnly(u.id),
        },
        el('span', { class: 'uc-badge-t', text: u.stats.short }),
        el('div', 'bar', fill),
      );
      return { u, b, fill };
    });
    grid.append(...badges.map((x) => x.b));
    this.card.append(head, el('div', { class: 'uc-line mono', text: sub }), grid);
    if (sel.length > max) this.card.append(el('div', { class: 'uc-more muted', text: `+${sel.length - max} more` }));
    return {
      update: () => {
        followBtn.classList.toggle('active', this.c.follow);
        for (const { u, b, fill } of badges) {
          const f = u.hp / u.stats.maxHp;
          fill.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`;
          fill.style.background = f > 0.6 ? 'var(--ok)' : f > 0.3 ? 'var(--warn)' : 'var(--danger)';
          b.classList.toggle('dry', outOfAmmo(u) || (u.stats.fuelCapacity > 0 && u.fuel <= 0));
          b.classList.toggle('hit', this.c.sim.time - u.lastHit < 2);
        }
      },
    };
  }

  showBanner(text: string, cls: string): void {
    this.banner?.remove();
    this.banner = el('div', { class: `panel banner ${cls}`, text });
    this.root.append(this.banner);
  }
}
