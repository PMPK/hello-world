import { BUILDABLE_TYPES, BUILDINGS, buildingDisplayName, REBUILD_COST_FACTOR, type BuildingTypeId } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { RESOURCES, STOCK_RESOURCES, canAfford, formatCost, type PartialStock } from '../data/resources';
import { UNIT_DESIGNS } from '../data/unitDesigns';
import { campaignDay, formatCampaignTime, formatDuration, type SpeedSetting } from '../core/time';
import { dist } from '../core/math';
import { ARMY_MAX_UNITS, armyBaseSpeed, armyMen, armySupplies, fuelRange, maxRations, MERGE_RANGE } from '../campaign/armies';
import { canBuildOutpost, canBuildType, OUTPOST_RANGE } from '../campaign/construction';
import { affordability, designsFor, MAX_QUEUE } from '../campaign/production';
import { basesOf, isOutpost, relationOf } from '../campaign/queries';
import type { Army, Base, Building, BuildingStatus, CampaignState, LogEntry, PendingBattle, UnitInstance } from '../campaign/types';
import { FOOD_PER_PERSON_HOUR } from '../economy/economy';
import { statsOf } from '../units/stats';
import { defenseStatsOf } from '../units/defense';
import { bar, btn, clear, el, fmt, ICONS, iconBtn, signed } from './dom';
import { openModal, Toasts } from './screens';

export type Selection =
  | { kind: 'army'; id: string }
  | { kind: 'base'; id: string }
  | { kind: 'building'; id: string }
  | { kind: 'site'; id: string }
  | null;

/** What the HUD needs from the campaign mode. */
export interface CampaignController {
  readonly state: CampaignState;
  /** Interface sound cue (no-op without audio). */
  sound(kind: 'radio' | 'alert' | 'confirm'): void;
  readonly selection: Selection;
  readonly speed: SpeedSetting;
  readonly placing: { typeId: BuildingTypeId; valid: boolean; reason: string } | null;
  setSpeed(s: SpeedSetting): void;
  select(sel: Selection, focus?: boolean): void;
  openMenu(): void;
  armyStop(id: string): void;
  armyReturn(id: string): void;
  armyGarrison(id: string): void;
  armyReinforce(id: string): void;
  armySplit(id: string, unitIds: string[]): void;
  armyMerge(intoId: string, fromId: string): void;
  setRepeat(buildingId: string, designId: string | null): void;
  deployGarrison(baseId: string): void;
  beginPlacement(baseId: string, typeId: BuildingTypeId): void;
  confirmPlacement(): void;
  cancelPlacement(): void;
  buildOutpost(baseId: string, siteId: string): void;
  queueUnit(buildingId: string, designId: string): void;
  cancelOrder(buildingId: string, orderId: string): void;
  setRecipe(buildingId: string, mode: string): void;
  toggleBuilding(id: string): void;
  repair(id: string): void;
  rebuild(id: string): void;
  cancelConstruction(id: string): void;
  commandBattle(): void;
  autoResolveBattle(): void;
}

const STATUS_TEXT: Record<BuildingStatus, [string, string]> = {
  ok: ['Operational', 'ok'],
  constructing: ['Under construction', 'accent'],
  waiting_resources: ['Waiting for materials', 'warn'],
  no_workers: ['Understaffed', 'warn'],
  low_power: ['Low power', 'warn'],
  no_input: ['No input materials', 'warn'],
  storage_full: ['Storage full / target reached', 'muted'],
  idle: ['Idle', 'muted'],
  disabled: ['Disabled', 'muted'],
  destroyed: ['Destroyed', 'bad'],
  damaged: ['Damaged', 'warn'],
  no_population: ['Not enough personnel', 'bad'],
};

function famBadge(designId: string, foe = false): HTMLElement {
  const st = statsOf(designId);
  return el('span', { class: `badge${foe ? ' foe' : ''}`, text: st.short });
}

function unitRow(u: UnitInstance, foe = false): HTMLElement {
  const st = statsOf(u.designId);
  const bars = el('div', 'bars');
  bars.append(bar(st.maxHp > 0 ? u.hp / st.maxHp : 0));
  if (st.ammoCapacity > 0) bars.append(bar(u.ammo / st.ammoCapacity, u.ammo / st.ammoCapacity < 0.25 ? 'bad' : 'ok'));
  if (st.fuelCapacity > 0) bars.append(bar(u.fuel / st.fuelCapacity, u.fuel / st.fuelCapacity < 0.25 ? 'bad' : 'warn'));
  return el(
    'div',
    'item',
    famBadge(u.designId, foe),
    el('span', { class: 'name', text: st.name }),
    el('span', { class: 'meta', text: `${u.men}/${st.crew}` }),
    foe ? null : bars,
  );
}

function composition(units: UnitInstance[]): string {
  const c: Record<string, number> = {};
  for (const u of units) {
    const s = statsOf(u.designId).short;
    c[s] = (c[s] ?? 0) + 1;
  }
  return Object.entries(c)
    .map(([k, v]) => `${v}× ${k}`)
    .join(' · ') || 'none';
}

function costLine(cost: PartialStock, mult = 1): string {
  const scaled: PartialStock = {};
  for (const k of STOCK_RESOURCES) if (cost[k]) scaled[k] = (cost[k] ?? 0) * mult;
  return formatCost(scaled) || 'free';
}

export class CampaignHud {
  readonly root: HTMLElement;
  private top: HTMLElement;
  private clockDate!: HTMLElement;
  private clockDay!: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private resStrip!: HTMLElement;
  private statusChip!: HTMLElement;
  private side: HTMLElement;
  private sidePanel: HTMLElement | null = null;
  private placementBar: HTMLElement;
  private directive: HTMLElement;
  private toasts: Toasts;
  private holding = false;
  private lastScroll = 0;
  private lastHtml = '';
  private seenLog = 0;
  private contactClose: (() => void) | null = null;
  private contactFor: string | null = null;
  focusBaseId: string | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly c: CampaignController,
  ) {
    this.root = el('div', 'passthrough');
    this.root.style.position = 'absolute';
    this.root.style.inset = '0';
    this.top = this.buildTop();
    this.side = el('div', 'side');
    this.placementBar = el('div', 'panel placement-bar');
    this.placementBar.style.display = 'none';
    const fab = el('div', 'fab-col');
    fab.append(
      iconBtn(ICONS.base, 'Focus base', () => {
        const b = basesOf(this.c.state, this.c.state.playerFactionId)[0];
        if (b) this.c.select({ kind: 'base', id: b.id }, true);
      }),
      iconBtn(ICONS.army, 'Next task force', () => this.cycleArmy()),
      iconBtn(ICONS.log, 'Event log', () => this.openLog()),
    );
    this.directive = el('div', 'panel directive');
    this.root.append(this.top, fab, this.side, this.placementBar, this.directive);
    host.append(this.root);
    this.toasts = new Toasts(this.root);
    this.seenLog = this.c.state.log.length;
    window.addEventListener('pointerup', this.release);
    window.addEventListener('pointercancel', this.release);
    this.update(true);
  }

  private release = (): void => {
    this.holding = false;
  };

  dispose(): void {
    window.removeEventListener('pointerup', this.release);
    window.removeEventListener('pointercancel', this.release);
    this.contactClose?.();
    this.root.remove();
  }

  // ---------------------------------------------------------------------------
  // Top bar
  // ---------------------------------------------------------------------------

  private buildTop(): HTMLElement {
    const top = el('div', 'topbar');
    const menu = iconBtn(ICONS.menu, 'Menu', () => this.c.openMenu(), 'panel');
    menu.dataset.testid = 'menu';
    const clock = el('div', 'panel clock');
    this.clockDate = el('div', 'date');
    this.clockDay = el('div', 'day');
    clock.append(this.clockDate, this.clockDay);
    const seg = el('div', 'seg panel');
    const speeds: SpeedSetting[] = [0, 1, 2, 4];
    this.speedBtns = speeds.map((s) => {
      const b = s === 0 ? iconBtn(ICONS.pause, 'Pause', () => this.c.setSpeed(0)) : btn(`${s}×`, () => this.c.setSpeed(s));
      b.dataset.testid = `speed-${s}`;
      return b;
    });
    seg.append(...this.speedBtns);
    this.resStrip = el('div', 'res-strip');
    this.statusChip = el('div', 'panel status-chip');
    this.statusChip.addEventListener('click', () => this.showStandoff());
    top.append(menu, clock, seg, this.resStrip, this.statusChip);
    return top;
  }

  private focusBase(): Base | null {
    const s = this.c.state;
    const sel = this.c.selection;
    if (sel?.kind === 'base' && s.bases[sel.id]?.factionId === s.playerFactionId) return s.bases[sel.id];
    if (sel?.kind === 'building') {
      const b = s.buildings[sel.id];
      if (b && b.factionId === s.playerFactionId && s.bases[b.baseId]) return s.bases[b.baseId];
    }
    if (this.focusBaseId && s.bases[this.focusBaseId]?.factionId === s.playerFactionId) return s.bases[this.focusBaseId];
    return basesOf(s, s.playerFactionId)[0] ?? null;
  }

  private updateTop(): void {
    const s = this.c.state;
    this.clockDate.textContent = formatCampaignTime(s.time);
    this.clockDay.textContent = `Day ${campaignDay(s.time)} · ${this.c.speed === 0 ? 'Paused' : `${this.c.speed}× speed`}`;
    const speeds: SpeedSetting[] = [0, 1, 2, 4];
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', speeds[i] === this.c.speed));
    const base = this.focusBase();
    clear(this.resStrip);
    if (base) {
      const cap = base.econ.storageCap;
      const mk = (label: string, n: string, rate: string, color: string, cls = ''): HTMLElement => {
        const r = el('div', { class: `res ${cls}`, style: `--c:${color}` });
        r.append(el('div', { class: 'n', text: n }), el('div', 't', el('span', { text: label }), el('span', { class: 'r', text: rate })));
        r.addEventListener('click', () => this.c.select({ kind: 'base', id: base.id }, true));
        return r;
      };
      const pop = mk('POP', `${Math.floor(base.population)}`, `/${base.econ.housing}`, '#c9d3d6', base.population >= base.econ.housing ? 'low' : '');
      const work = mk('WORK', `${base.econ.workersEmployed}`, `/${base.econ.workersNeeded}`, '#a7b5b9', base.econ.workersEmployed < base.econ.workersNeeded ? 'low' : '');
      const pwr = mk(
        'PWR',
        `${fmt(base.econ.energyProduced)}`,
        `/${fmt(base.econ.energyDemand)}`,
        RESOURCES.energy.color,
        base.econ.energyProduced + 0.01 < base.econ.energyDemand ? 'low' : '',
      );
      this.resStrip.append(pop, work, pwr);
      for (const k of STOCK_RESOURCES) {
        const v = base.stock[k];
        const rate = base.econ.rates[k] ?? 0;
        const cls = v < 1 ? 'empty' : v < 15 ? 'low' : '';
        const r = mk(RESOURCES[k].short, fmt(v), Math.abs(rate) < 0.05 ? '' : signed(rate), RESOURCES[k].color, cls);
        r.title = `${RESOURCES[k].name}: ${fmt(v)} / ${fmt(cap[k])}`;
        this.resStrip.append(r);
      }
    }
    const rel = relationOf(s, s.playerFactionId, Object.keys(s.factions).find((f) => f !== s.playerFactionId) ?? '');
    clear(this.statusChip);
    if (rel) {
      const hostile = rel.status === 'hostile';
      this.statusChip.append(
        el('div', { class: 's1', text: hostile ? 'STATUS' : 'STANDOFF' }),
        el('div', { class: `s2 ${hostile ? 'bad' : rel.tension > 60 ? 'warn' : 'ok'}`, text: hostile ? 'HOSTILE' : `TENSION ${Math.round(rel.tension)}%` }),
      );
    }
  }

  private showStandoff(): void {
    const s = this.c.state;
    const rel = s.relations[0];
    const other = rel ? (rel.a === s.playerFactionId ? rel.b : rel.a) : '';
    const def = FACTION_DEFS[s.factions[other]?.defId ?? ''];
    openModal(this.host, {
      kicker: 'Intelligence',
      title: rel?.status === 'hostile' ? 'Open hostilities' : 'Armed standoff',
      dismissable: true,
      body: [
        rel?.status === 'hostile'
          ? `${def?.codename ?? 'The other expedition'} forces are hostile. Any contact between armies will lead to combat.`
          : `Both expeditions are under orders to avoid open conflict. Tension rises as Earth communication fails and when forces approach each other's bases. At 100% the other side will go weapons-free. Ordering an attack starts hostilities immediately.`,
        `Tension: ${Math.round(rel?.tension ?? 0)}%`,
      ],
      actions: [{ label: 'Close', onClick: () => undefined }],
    });
  }

  private cycleArmy(): void {
    const s = this.c.state;
    const mine = Object.values(s.armies)
      .filter((a) => a.factionId === s.playerFactionId)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (!mine.length) {
      this.toasts.push('No task forces in the field. Deploy one from a base garrison.', 'warn', 3500);
      return;
    }
    const sel = this.c.selection;
    const i = sel?.kind === 'army' ? mine.findIndex((a) => a.id === sel.id) : -1;
    const next = mine[(i + 1) % mine.length];
    this.c.select({ kind: 'army', id: next.id }, true);
  }

  // ---------------------------------------------------------------------------
  // Frame update (throttled by the caller)
  // ---------------------------------------------------------------------------

  /** First-steps guidance: the next useful objective, derived from the state. */
  private updateDirective(): void {
    const s = this.c.state;
    const pf = s.playerFactionId;
    const has = (t: BuildingTypeId, kind?: string): boolean =>
      Object.values(s.buildings).some((b) => b.factionId === pf && b.typeId === t && b.state !== 'destroyed' && (!kind || (b.siteId && s.sites[b.siteId]?.kind === kind)));
    const units = [...Object.values(s.armies).filter((a) => a.factionId === pf).flatMap((a) => a.units), ...basesOf(s, pf).flatMap((b) => b.garrison)];
    const infantry = units.filter((u) => u.designId === 'rifle_squad').length;
    const steps: [boolean, string][] = [
      [has('refinery'), 'Build a Refinery — tap your base, then Build.'],
      [infantry >= 5, 'Train a Rifle Squad at the Barracks to strengthen the garrison.'],
      [has('extractor', 'hydrocarbons'), 'Claim a hydrocarbon field (amber diamond) with an Oil Well.'],
      [has('power_plant'), 'Build a Power Plant before the grid overloads.'],
      [has('factory'), 'Build an Industrial Factory for components and ammunition.'],
      [has('vehicle_depot'), 'Build a Vehicle Depot to produce jeeps and tanks.'],
      [units.filter((u) => u.designId === 'mbt').length >= 2, 'Produce a second Main Battle Tank at the Vehicle Depot.'],
    ];
    const next = steps.find(([done]) => !done);
    const done = steps.filter(([d]) => d).length;
    if (!next || this.c.placing || basesOf(s, pf).length === 0) {
      this.directive.style.display = 'none';
      return;
    }
    this.directive.style.display = '';
    this.directive.textContent = '';
    this.directive.append(el('span', { class: 'accent mono', text: `DIRECTIVE ${done + 1}/${steps.length}` }), el('span', { text: next[1] }));
  }

  update(force = false): void {
    this.updateDirective();
    this.updateTop();
    this.updateToasts();
    this.updatePlacement();
    this.updateContact();
    if (!force && (this.holding || performance.now() - this.lastScroll < 500)) return;
    this.renderSide();
  }

  private updateToasts(): void {
    const log = this.c.state.log;
    if (this.seenLog > log.length) this.seenLog = 0;
    let fresh = false;
    for (let i = this.seenLog; i < log.length; i++) {
      const e = log[i];
      if (e.factionId && e.factionId !== this.c.state.playerFactionId) continue;
      this.toasts.push(e.text, e.kind);
      fresh = true;
    }
    if (fresh && this.seenLog > 0) this.c.sound('radio');
    this.seenLog = log.length;
  }

  toast(text: string, kind = 'info'): void {
    this.toasts.push(text, kind, 4000);
  }

  private updatePlacement(): void {
    const p = this.c.placing;
    this.side.style.display = p ? 'none' : '';
    if (!p) {
      this.placementBar.style.display = 'none';
      return;
    }
    this.placementBar.style.display = 'flex';
    if (!this.placementBar.dataset.built) {
      this.placementBar.dataset.built = '1';
      const info = el('div', 'info');
      info.dataset.role = 'info';
      const ok = btn('Confirm', () => this.c.confirmPlacement(), 'primary');
      ok.dataset.testid = 'confirm-placement';
      ok.dataset.role = 'ok';
      this.placementBar.append(info, btn('Cancel', () => this.c.cancelPlacement()), ok);
    }
    const info = this.placementBar.querySelector('[data-role="info"]') as HTMLElement;
    info.innerHTML = '';
    info.append(
      el('div', { style: { fontWeight: '700' }, text: `Placing ${BUILDINGS[p.typeId].name}` }),
      el('div', { class: p.valid ? 'muted' : 'bad', text: p.valid ? 'Tap inside the perimeter to move · Confirm to build' : p.reason }),
    );
    const okBtn = this.placementBar.querySelector('[data-role="ok"]') as HTMLButtonElement;
    okBtn.disabled = !p.valid;
  }

  // ---------------------------------------------------------------------------
  // Contact (pending battle)
  // ---------------------------------------------------------------------------

  private updateContact(): void {
    const p = this.c.state.pendingBattle;
    if (!p) {
      if (this.contactClose) {
        this.contactClose();
        this.contactClose = null;
        this.contactFor = null;
      }
      return;
    }
    if (this.contactFor === p.id) return;
    this.contactFor = p.id;
    this.c.sound('alert');
    this.contactClose = this.showContact(p);
  }

  private forcesOf(p: PendingBattle, side: 'attacker' | 'defender'): UnitInstance[] {
    const s = this.c.state;
    const ids = side === 'attacker' ? p.attackerArmyIds : p.defenderArmyIds;
    const out: UnitInstance[] = [];
    for (const id of ids) out.push(...(s.armies[id]?.units ?? []));
    if (side === 'defender' && p.baseId) out.push(...(s.bases[p.baseId]?.garrison ?? []));
    return out;
  }

  private showContact(p: PendingBattle): () => void {
    const s = this.c.state;
    const pf = s.playerFactionId;
    const playerAttacks = p.attackerFactionId === pf;
    const atk = this.forcesOf(p, 'attacker');
    const def = this.forcesOf(p, 'defender');
    const mine = playerAttacks ? atk : def;
    const theirs = playerAttacks ? def : atk;
    const base = p.baseId ? s.bases[p.baseId] : undefined;
    const bld = p.buildingId ? s.buildings[p.buildingId] : undefined;
    const enemyName = FACTION_DEFS[s.factions[playerAttacks ? p.defenderFactionId : p.attackerFactionId]?.defId ?? '']?.codename ?? 'Enemy';
    let title: string;
    if (p.kind === 'base_assault') title = playerAttacks ? `Assault on ${base?.name ?? 'enemy base'}` : `${base?.name ?? 'Our base'} under attack`;
    else if (p.kind === 'outpost') title = playerAttacks ? 'Outpost assault' : `Our ${bld ? buildingDisplayName(bld.typeId, bld.siteId ? s.sites[bld.siteId]?.kind : undefined) : 'outpost'} under attack`;
    else title = playerAttacks ? 'Engaging enemy force' : `${enemyName} force engaging`;
    const col = (h: string, units: UnitInstance[], foe: boolean): HTMLElement => {
      const c = el('div', 'col');
      c.append(el('h3', { class: foe ? 'bad' : 'accent', text: h }));
      c.append(el('div', { class: 'mono', style: { fontSize: '12px', marginBottom: '4px' }, text: `${units.length} units · ${units.reduce((a, u) => a + u.men, 0)} men` }));
      c.append(el('div', { class: 'muted', style: { fontSize: '12px' }, text: composition(units) }));
      return c;
    };
    const vs = el('div', 'vs', col('Our forces', mine, false), el('div', { class: 'mid', text: 'VS' }), col(`${enemyName}`, theirs, true));
    const body: (Node | string)[] = [vs];
    const noDefenders = mine.length === 0;
    if (noDefenders) body.push('No friendly combat units are present. The outcome will be decided without you.');
    else if (base && !playerAttacks) body.push('Your base structures will be on the battlefield. Buildings destroyed in battle stay destroyed.');
    body.push(el('div', { class: 'hint', text: 'The campaign is frozen while the battle is fought. Battle time is added to the campaign clock afterwards.' }));
    const actions: { label: string; cls?: string; onClick: () => void }[] = [];
    if (!noDefenders) actions.push({ label: 'Auto-resolve', onClick: () => this.c.autoResolveBattle() });
    else actions.push({ label: 'Accept outcome', onClick: () => this.c.autoResolveBattle() });
    if (!noDefenders) actions.push({ label: 'Command battle', cls: 'primary', onClick: () => this.c.commandBattle() });
    const close = openModal(this.host, { kicker: `Contact report · ${formatCampaignTime(s.time)}`, title, body, actions });
    // tag for tests
    const last = this.host.querySelector('.modal-back:last-child .actions');
    last?.querySelectorAll('button').forEach((b) => {
      if (b.textContent === 'Command battle') b.dataset.testid = 'command-battle';
      if (b.textContent === 'Auto-resolve' || b.textContent === 'Accept outcome') b.dataset.testid = 'auto-resolve';
    });
    return close;
  }

  /** Blocking progress overlay (e.g. auto-resolve on slow devices). */
  showProgress(title: string, sub: string): { set: (f: number) => void; close: () => void } {
    const back = el('div', 'modal-back');
    const panel = el('div', 'panel modal');
    const body = el('div', 'panel-body');
    const fill = el('i', { style: { width: '0%' } });
    const barEl = el('div', 'bar');
    barEl.append(fill);
    const pct = el('div', { class: 'mono muted', style: { fontSize: '12px', marginTop: '6px' }, text: '0%' });
    body.append(el('div', { class: 'kicker', text: 'Auto-resolve' }), el('h1', { text: title }), el('p', { class: 'muted', text: sub }), barEl, pct);
    panel.append(body);
    back.append(panel);
    back.dataset.testid = 'progress';
    this.host.append(back);
    return {
      set: (f: number) => {
        fill.style.width = `${Math.round(f * 100)}%`;
        pct.textContent = `${Math.round(f * 100)}%`;
      },
      close: () => back.remove(),
    };
  }

  showReport(title: string, lines: string[], won: boolean | null, onClose?: () => void): void {
    openModal(this.host, {
      kicker: 'After-action report',
      title,
      body: lines.map((l) => el('p', { class: won === null ? '' : '', text: l })),
      actions: [{ label: 'Continue', cls: 'primary', onClick: () => onClose?.() }],
    });
  }

  openLog(): void {
    const s = this.c.state;
    const list = el('div', 'list');
    const entries = s.log.filter((e: LogEntry) => !e.factionId || e.factionId === s.playerFactionId).slice(-40).reverse();
    for (const e of entries) {
      list.append(
        el(
          'div',
          'item',
          el('span', { class: 'meta', text: formatCampaignTime(e.t).split(' · ')[1] ?? '' }),
          el('span', { class: `name ${e.kind === 'battle' ? 'bad' : e.kind === 'warn' ? 'warn' : e.kind === 'lore' ? 'accent' : ''}`, style: { whiteSpace: 'normal' }, text: e.text }),
        ),
      );
    }
    openModal(this.host, { kicker: 'Communications', title: 'Event log', body: [list], actions: [{ label: 'Close', onClick: () => undefined }], dismissable: true });
  }

  // ---------------------------------------------------------------------------
  // Side panel
  // ---------------------------------------------------------------------------

  private renderSide(): void {
    const sel = this.c.selection;
    const s = this.c.state;
    let panel: HTMLElement | null = null;
    if (sel?.kind === 'army' && s.armies[sel.id]) panel = this.armyPanel(s.armies[sel.id]);
    else if (sel?.kind === 'base' && s.bases[sel.id]) panel = this.basePanel(s.bases[sel.id]);
    else if (sel?.kind === 'building' && s.buildings[sel.id]) panel = this.buildingPanel(s.buildings[sel.id]);
    else if (sel?.kind === 'site' && s.sites[sel.id]) panel = this.sitePanel(sel.id);
    if (!panel) {
      if (this.sidePanel) {
        this.sidePanel.remove();
        this.sidePanel = null;
        this.lastHtml = '';
      }
      return;
    }
    const html = panel.innerHTML;
    if (this.sidePanel && html === this.lastHtml) return;
    const prevScroll = this.sidePanel?.querySelector('.panel-body')?.scrollTop ?? 0;
    const sameKind = this.sidePanel?.dataset.key === panel.dataset.key;
    this.sidePanel?.remove();
    this.sidePanel = panel;
    this.lastHtml = html;
    panel.addEventListener('pointerdown', () => {
      this.holding = true;
    });
    const body = panel.querySelector('.panel-body') as HTMLElement | null;
    body?.addEventListener('scroll', () => {
      this.lastScroll = performance.now();
    });
    this.side.append(panel);
    if (body && sameKind) body.scrollTop = prevScroll;
  }

  private panelShell(key: string, title: string, sub: string, color?: string): { panel: HTMLElement; body: HTMLElement } {
    const panel = el('div', 'panel');
    panel.dataset.key = key;
    panel.dataset.testid = 'side-panel';
    const head = el('div', 'panel-head');
    const t = el('div', 'panel-title');
    const h = el('h2', { text: title });
    if (color) h.style.color = color;
    t.append(h, el('div', { class: 'sub', text: sub }));
    const x = iconBtn(ICONS.close, 'Close', () => this.c.select(null), 'small');
    head.append(t, x);
    const body = el('div', 'panel-body');
    panel.append(head, body);
    return { panel, body };
  }

  private section(body: HTMLElement, label: string, extra?: string): HTMLElement {
    const sec = el('div', 'section');
    const l = el('div', 'label', el('span', { text: label }));
    if (extra) l.append(el('span', { text: extra }));
    sec.append(l);
    body.append(sec);
    return sec;
  }

  private kv(parent: HTMLElement, rows: [string, string, string?][]): void {
    const g = el('div', 'kv');
    for (const [k, v, cls] of rows) g.append(el('div', { class: 'k', text: k }), el('div', { class: `v ${cls ?? ''}`, text: v }));
    parent.append(g);
  }

  private armyPanel(a: Army): HTMLElement {
    const s = this.c.state;
    const mine = a.factionId === s.playerFactionId;
    const fac = s.factions[a.factionId];
    const cmd = a.commanderId ? s.characters[a.commanderId] : undefined;
    const { panel, body } = this.panelShell(`army:${a.id}`, a.name, `${mine ? 'Task force' : fac?.name ?? 'Unknown'}${cmd ? ` · ${cmd.name}` : ''}`, fac?.color);
    if (!mine) {
      const sec = this.section(body, 'Observed strength');
      this.kv(sec, [
        ['Units', `${a.units.length}`],
        ['Personnel', `~${Math.round(armyMen(a) / 5) * 5}`],
      ]);
      sec.append(el('div', { class: 'hint', text: composition(a.units) }));
      const list = el('div', 'list');
      for (const u of a.units.slice(0, 12)) list.append(unitRow(u, true));
      sec.append(list);
      body.append(el('div', { class: 'hint', text: 'Select one of your task forces, then tap this force to attack it.' }));
      return panel;
    }
    const o = a.order;
    let order = 'Holding position';
    if (o.type === 'move') order = 'Moving';
    else if (o.type === 'attack_army') order = `Pursuing ${s.armies[o.targetId]?.name ?? 'target'}`;
    else if (o.type === 'attack_base') order = `Assaulting ${s.bases[o.targetId]?.name ?? 'base'}`;
    else if (o.type === 'attack_building') order = 'Attacking outpost';
    else if (o.type === 'return') order = 'Returning to base';
    const days = a.food / Math.max(0.001, armyMen(a) * FOOD_PER_PERSON_HOUR * 24);
    const range = fuelRange(a.units);
    const supplies = armySupplies(a.units);
    const sec = this.section(body, 'Status');
    const statusRows: [string, string, string?][] = [
      ['Orders', order, o.type === 'idle' ? 'muted' : 'accent'],
      ['Units / men', `${a.units.length} / ${armyMen(a)}`],
      ['Speed', `${armyBaseSpeed(a).toFixed(1)} km/h`],
      ['Rations', `${days.toFixed(1)} days`, days < 1 ? 'bad' : days < 2 ? 'warn' : ''],
      ['Fuel range', Number.isFinite(range) ? `${Math.floor(range)} km` : 'on foot', range < 40 ? 'bad' : range < 90 ? 'warn' : ''],
    ];
    if (supplies.trucks > 0) {
      statusRows.push([
        'Supply trucks',
        `${supplies.trucks} · ${Math.round(supplies.fuel)} FUEL · ${Math.round(supplies.ammo)} AMMO`,
        supplies.fuel < 10 && supplies.ammo < 5 ? 'warn' : '',
      ]);
    }
    this.kv(sec, statusRows);
    sec.append(el('div', { style: { marginTop: '6px' } }, bar(a.food / Math.max(1, maxRations(a)))));
    const us = this.section(body, 'Units', 'HP · AMMO · FUEL');
    const list = el('div', 'list');
    for (const u of a.units) list.append(unitRow(u));
    us.append(list);
    const actions = el('div', 'actions');
    const atBase = Object.values(s.bases).find((b) => b.factionId === a.factionId && dist(b.x, b.z, a.x, a.z) <= b.radius + 1.5);
    if (a.path.length) actions.append(btn('Stop', () => this.c.armyStop(a.id)));
    if (!atBase) actions.append(btn('Return to base', () => this.c.armyReturn(a.id)));
    if (atBase) {
      actions.append(btn('Garrison', () => this.c.armyGarrison(a.id)));
      if (atBase.garrison.length) actions.append(btn(`Reinforce (${atBase.garrison.length})`, () => this.c.armyReinforce(a.id)));
    }
    if (a.units.length >= 2) {
      const sb = btn('Split…', () => this.openSplit(a));
      sb.dataset.testid = 'army-split';
      actions.append(sb);
    }
    for (const other of Object.values(s.armies)) {
      if (other.id === a.id || other.factionId !== a.factionId) continue;
      if (dist(other.x, other.z, a.x, a.z) > MERGE_RANGE || other.units.length + a.units.length > ARMY_MAX_UNITS) continue;
      const mb = btn(`Merge ${other.name}`, () => this.c.armyMerge(a.id, other.id));
      mb.dataset.testid = 'army-merge';
      actions.append(mb);
    }
    body.append(actions);
    body.append(el('div', { class: 'hint', text: 'Tap terrain to move (right-click with a mouse). Tap an enemy force, base or outpost to attack. Forces resupply automatically near a friendly base.' }));
    return panel;
  }

  /** Choose units to detach into a new task force. */
  private openSplit(a: Army): void {
    const chosen = new Set<string>();
    const list = el('div', 'list');
    const confirm = btn('Split off 0 units', () => undefined, 'primary disabled');
    const refresh = (): void => {
      const n = chosen.size;
      confirm.textContent = `Split off ${n} unit${n === 1 ? '' : 's'}`;
      confirm.classList.toggle('disabled', n === 0 || n >= a.units.length);
    };
    for (const u of a.units) {
      const row = unitRow(u);
      row.classList.add('tap');
      row.dataset.testid = 'split-unit';
      row.addEventListener('click', () => {
        if (chosen.has(u.id)) chosen.delete(u.id);
        else chosen.add(u.id);
        row.classList.toggle('picked', chosen.has(u.id));
        refresh();
      });
      list.append(row);
    }
    const close = openModal(this.host, {
      kicker: a.name,
      title: 'Split task force',
      body: [el('div', { class: 'hint', text: 'Tap the units that form the new task force. Rations are shared by head count; the new force gets its own commander.' }), list],
      actions: [{ label: 'Cancel', onClick: () => undefined }],
      dismissable: true,
    });
    confirm.addEventListener('click', () => {
      if (!chosen.size || chosen.size >= a.units.length) return;
      close();
      this.c.armySplit(a.id, [...chosen]);
    });
    confirm.dataset.testid = 'split-confirm';
    list.after(el('div', 'actions', confirm));
  }

  private basePanel(b: Base): HTMLElement {
    const s = this.c.state;
    const mine = b.factionId === s.playerFactionId;
    const fac = s.factions[b.factionId];
    const { panel, body } = this.panelShell(`base:${b.id}`, b.name, mine ? 'Expedition base' : fac?.name ?? 'Unknown', fac?.color);
    const buildings = Object.values(s.buildings).filter((x) => x.baseId === b.id);
    if (!mine) {
      const sec = this.section(body, 'Intelligence');
      this.kv(sec, [
        ['Structures', `${buildings.filter((x) => x.state !== 'destroyed').length}`],
        ['Garrison', b.garrison.length ? `~${b.garrison.length} units` : 'none observed'],
      ]);
      body.append(el('div', { class: 'hint', text: 'Select one of your task forces, then tap this base to assault it. Captured bases keep their surviving structures and personnel.' }));
      return panel;
    }
    const e = b.econ;
    const p = this.section(body, 'Personnel');
    this.kv(p, [
      ['Population', `${Math.floor(b.population)} / ${e.housing} housing`, b.population >= e.housing ? 'warn' : ''],
      ['Workforce', `${e.workersEmployed} employed / ${e.workersNeeded} needed`, e.workersEmployed < e.workersNeeded ? 'warn' : ''],
      ['Garrison', `${b.garrison.length} units · ${b.garrison.reduce((x, u) => x + u.men, 0)} soldiers`],
    ]);
    const pw = this.section(body, 'Power & food');
    this.kv(pw, [
      ['Energy', `${fmt(e.energyProduced)} / ${fmt(e.energyDemand)} MW`, e.energyProduced + 0.01 < e.energyDemand ? 'bad' : 'ok'],
      ['Food balance', `${signed(e.foodPerHour)} /h`, e.foodPerHour < 0 ? 'bad' : 'ok'],
    ]);
    const st = this.section(body, 'Stores', 'STOCK / CAP · RATE');
    const g = el('div', 'kv');
    for (const k of STOCK_RESOURCES) {
      const rate = e.rates[k] ?? 0;
      g.append(
        el('div', { class: 'k', text: RESOURCES[k].name }),
        el('div', { class: `v ${b.stock[k] < 10 ? 'warn' : ''}`, text: `${fmt(b.stock[k])} / ${fmt(e.storageCap[k])}  ${Math.abs(rate) >= 0.05 ? signed(rate) : '±0'}` }),
      );
    }
    st.append(g);
    const bs = this.section(body, 'Structures');
    const list = el('div', 'list');
    for (const x of buildings.sort((p1, p2) => (BUILDINGS[p1.typeId].category < BUILDINGS[p2.typeId].category ? -1 : 1))) {
      const [txt, cls] = STATUS_TEXT[x.status] ?? ['', ''];
      const item = el(
        'div',
        'item tap',
        el('span', { class: 'badge', text: BUILDINGS[x.typeId].short }),
        el('span', { class: 'name', text: buildingDisplayName(x.typeId, x.siteId ? s.sites[x.siteId]?.kind : undefined) + (isOutpost(s, x) ? ' (outpost)' : '') }),
        el('span', { class: `meta ${cls}`, text: x.state === 'construction' ? `${Math.round(x.buildProgress * 100)}%` : txt }),
      );
      item.addEventListener('click', () => this.c.select({ kind: 'building', id: x.id }, true));
      list.append(item);
    }
    bs.append(list);
    const gs = this.section(body, 'Garrison');
    if (b.garrison.length) {
      const gl = el('div', 'list');
      for (const u of b.garrison) gl.append(unitRow(u));
      gs.append(gl);
    } else gs.append(el('div', { class: 'muted', text: 'No units in garrison.' }));
    const actions = el('div', 'actions');
    const bb = btn('Build…', () => this.openBuildMenu(b), 'primary');
    bb.dataset.testid = 'build';
    actions.append(bb);
    if (b.garrison.length) {
      const d = btn('Deploy task force', () => this.c.deployGarrison(b.id));
      d.dataset.testid = 'deploy';
      actions.append(d);
    }
    body.append(actions);
    return panel;
  }

  private openBuildMenu(b: Base): void {
    const s = this.c.state;
    const grid = el('div', 'build-grid');
    let close: () => void = () => undefined;
    for (const t of BUILDABLE_TYPES) {
      const def = BUILDINGS[t];
      const can = canBuildType(s, b, t);
      const card = el('div', `build-card${can.ok ? '' : ' disabled'}`);
      card.dataset.testid = `build-${t}`;
      card.append(
        el('div', { class: 'bn', text: def.name }),
        el('div', { class: 'bc', text: costLine(def.cost) }),
        el('div', { class: 'bc', text: `${def.workers} ${def.defense ? 'crew' : 'workers'} · ${formatDuration(def.buildHours)}${def.energyUse ? ` · ${def.energyUse} MW` : def.energyOutput ? ` · +${def.energyOutput} MW` : ''}` }),
        el('div', { class: `bc ${can.ok ? '' : 'bad'}`, text: t === 'extractor' ? 'Tap a resource site on the map' : can.ok ? def.description.split('.')[0] : can.reason }),
      );
      card.addEventListener('click', () => {
        if (t === 'extractor') {
          close();
          this.toast('Select a mineral or hydrocarbon site (diamond markers) to build an extractor.', 'info');
          return;
        }
        if (!can.ok) {
          this.toast(`${def.name}: ${can.reason}`, 'warn');
          return;
        }
        close();
        this.c.beginPlacement(b.id, t);
      });
      grid.append(card);
    }
    close = openModal(this.host, { kicker: b.name, title: 'Construction', body: [grid], actions: [{ label: 'Close', onClick: () => undefined }], dismissable: true });
  }

  private buildingPanel(x: Building): HTMLElement {
    const s = this.c.state;
    const def = BUILDINGS[x.typeId];
    const mine = x.factionId === s.playerFactionId;
    const fac = s.factions[x.factionId];
    const site = x.siteId ? s.sites[x.siteId] : undefined;
    const name = buildingDisplayName(x.typeId, site?.kind);
    const base = s.bases[x.baseId];
    const { panel, body } = this.panelShell(`bld:${x.id}`, name, `${mine ? base?.name ?? '' : fac?.name ?? ''}${isOutpost(s, x) ? ' · outpost' : ''}`, fac?.color);
    const hpF = x.hp / def.maxHp;
    const [stTxt, stCls] = STATUS_TEXT[x.status] ?? ['', ''];
    const sec = this.section(body, 'Condition');
    sec.append(bar(x.state === 'construction' ? x.buildProgress : hpF));
    const rows: [string, string, string?][] = [
      ['Status', mine ? stTxt : x.state === 'destroyed' ? 'Destroyed' : 'Operational', mine ? stCls : ''],
      ['Integrity', `${Math.round(x.hp)} / ${def.maxHp}`, hpF < 0.5 ? 'warn' : ''],
    ];
    if (mine && x.state !== 'destroyed') {
      rows.push(['Workers', `${x.workers} / ${x.state === 'construction' ? 4 : def.workers}`, x.workers < def.workers ? 'warn' : '']);
      if (x.state === 'active') rows.push(['Efficiency', `${Math.round((x.efficiency ?? 0) * 100)}%`]);
      if (def.energyUse) rows.push(['Power draw', `${def.energyUse} MW`]);
      if (def.energyOutput) rows.push(['Generation', `${def.energyOutput} MW${def.energyFuel ? ' (burns hydrocarbons)' : ''}`]);
      if (def.housing) rows.push(['Housing', `${def.housing}`]);
    }
    this.kv(sec, rows);
    body.append(el('div', { class: 'hint', text: def.description }));
    if (!mine) {
      body.append(
        el('div', {
          class: 'hint',
          text: isOutpost(s, x) ? 'Select one of your task forces, then tap this outpost to capture it.' : 'Part of an enemy base. Assault the base to take it.',
        }),
      );
      return panel;
    }
    const actions = el('div', 'actions');
    if (x.state === 'construction') {
      const p = this.section(body, 'Construction');
      p.append(bar(x.buildProgress, 'ok'));
      p.append(el('div', { class: 'hint', text: `${Math.round(x.buildProgress * 100)}% · ${formatDuration(def.buildHours * (1 - x.buildProgress))} remaining at full staffing` }));
      actions.append(btn('Cancel (75% refund)', () => this.c.cancelConstruction(x.id), 'danger'));
    } else if (x.state === 'destroyed') {
      actions.append(btn(`Rebuild (${costLine(def.cost, REBUILD_COST_FACTOR)})`, () => this.c.rebuild(x.id), 'primary'));
    } else {
      if (def.recipes && def.recipes.length > 1) {
        const r = this.section(body, 'Production line');
        const seg = el('div', 'seg');
        const modes = ['auto', ...def.recipes.map((rr) => rr.id)];
        for (const m of modes) {
          const label = m === 'auto' ? 'Auto' : def.recipes.find((rr) => rr.id === m)!.name;
          seg.append(btn(label, () => this.c.setRecipe(x.id, m), `small ${x.recipeMode === m ? 'active' : ''}`));
        }
        r.append(seg);
      }
      if (def.recipes) {
        const r = this.section(body, 'Recipes');
        for (const rr of def.recipes) {
          const active = x.activeRecipe === rr.id;
          r.append(
            el('div', { class: `item`, style: { minHeight: '34px' } },
              el('span', { class: `name ${active ? 'accent' : ''}`, text: rr.name }),
              el('span', { class: 'meta', text: `${costLine(rr.inputs)} → ${costLine(rr.outputs)} / ${rr.cycleHours}h` }),
            ),
          );
          if (active) r.append(bar(x.cycleProgress / rr.cycleHours, 'ok'));
        }
      }
      const ds = defenseStatsOf(x.typeId);
      if (ds) {
        const r = this.section(body, 'Defensive position');
        const crewRows: [string, string, string?][] = ds.weapons.map((w) => [w.name, `${Math.round(w.range)} m${w.antiVehicleOnly ? ' · vehicles only' : ''}`]);
        crewRows.push(['Crew on duty', `${x.workers} / ${ds.crew}`, x.workers < ds.crew ? 'warn' : '']);
        crewRows.push(['Ammunition', `${ds.ammoCapacity} rds from base stock (${fmt(base?.stock.ammo ?? 0)} available)`, (base?.stock.ammo ?? 0) < ds.ammoCapacity ? 'warn' : '']);
        crewRows.push(['Observation', `${ds.vision} m`]);
        this.kv(r, crewRows);
        r.append(
          el('div', {
            class: 'hint',
            text: 'Fights automatically when this base is attacked. Needs its full crew and base ammunition; destroyed positions lose part of their crew.',
          }),
        );
      }
      if (def.extraction && site) {
        const ex = def.extraction[site.kind];
        const r = this.section(body, 'Extraction');
        this.kv(r, [
          ['Output', `${(ex.perHour * site.richness).toFixed(1)} ${RESOURCES[ex.resource].short}/h`],
          ['Richness', `${Math.round(site.richness * 100)}%`],
          ['Buffer', `${fmt(Object.values(x.storage).reduce((a: number, v) => a + (v ?? 0), 0))} / 40`],
        ]);
        r.append(el('div', { class: 'hint', text: 'Output is trucked to the base by convoy along the road. Hostile forces can intercept convoys.' }));
      }
      if (def.produces) {
        const r = this.section(body, 'Produce', `QUEUE ${x.queue.length}/${MAX_QUEUE}`);
        for (const d of designsFor(x, s)) {
          const stt = statsOf(d);
          const aff = affordability(s, x.id, d);
          const b = btn('', () => this.c.queueUnit(x.id, d), `${aff.ok ? '' : 'disabled'}`);
          b.style.width = '100%';
          b.style.justifyContent = 'space-between';
          b.style.marginBottom = '6px';
          b.style.textTransform = 'none';
          b.style.letterSpacing = '0.02em';
          b.dataset.testid = `queue-${d}`;
          b.append(
            el('span', { style: { fontWeight: '700' }, text: UNIT_DESIGNS[d].name }),
            el('span', { class: 'mono', style: { fontSize: '11px', opacity: '0.85' }, text: `${stt.crew} ppl · ${costLine(stt.cost)} · ${formatDuration(stt.buildHours)}` }),
          );
          if (!aff.ok) b.title = aff.reason;
          r.append(b);
        }
        const rseg = el('div', 'seg');
        for (const d of [null, ...designsFor(x, s)]) {
          const on = (x.repeat ?? null) === d;
          const rb = btn(d ? UNIT_DESIGNS[d].short : 'Off', () => this.c.setRepeat(x.id, d), `small ${on ? 'active' : ''}`);
          rb.dataset.testid = `repeat-${d ?? 'off'}`;
          rseg.append(rb);
        }
        r.append(el('div', { class: 'label', text: 'Continuous production', style: { marginTop: '4px' } }), rseg);
        if (x.queue.length) {
          const q = el('div', 'list');
          x.queue.forEach((o, i) => {
            const stt = statsOf(o.designId);
            const item = el('div', 'item', famBadge(o.designId), el('span', { class: 'name', text: i === 0 ? `${stt.name}${o.started ? '' : ' (waiting)'}` : stt.name }));
            if (i === 0 && o.started) {
              const bb = el('div', 'bars');
              bb.append(bar(o.progress / stt.buildHours, 'ok'));
              item.append(bb);
            }
            item.append(btn('✕', () => this.c.cancelOrder(x.id, o.id), 'small'));
            q.append(item);
          });
          r.append(q);
        }
        r.append(el('div', { class: 'hint', text: 'Units draw people from the base population and materials when work begins. Finished units join the base garrison.' }));
      }
      if (hpF < 1) actions.append(btn(x.repairing ? 'Repairing…' : 'Repair', () => this.c.repair(x.id), x.repairing ? 'active' : ''));
      if (x.typeId !== 'hq') actions.append(btn(x.enabled ? 'Disable' : 'Enable', () => this.c.toggleBuilding(x.id)));
    }
    if (base) actions.append(btn('Base overview', () => this.c.select({ kind: 'base', id: base.id }, true)));
    body.append(actions);
    return panel;
  }

  private sitePanel(siteId: string): HTMLElement {
    const s = this.c.state;
    const site = s.sites[siteId];
    const title = site.kind === 'minerals' ? 'Mineral deposit' : 'Hydrocarbon field';
    const { panel, body } = this.panelShell(`site:${siteId}`, title, `Richness ${Math.round(site.richness * 100)}%`);
    const sec = this.section(body, 'Survey');
    const yieldH = (BUILDINGS.extractor.extraction![site.kind].perHour * site.richness).toFixed(1);
    this.kv(sec, [
      ['Resource', RESOURCES[site.kind].name],
      ['Extractor yield', `${yieldH} /h`],
      ['Claimed', site.buildingId && s.buildings[site.buildingId]?.state !== 'destroyed' ? 'Yes' : 'No'],
    ]);
    const mineBases = basesOf(s, s.playerFactionId).sort((a, b) => dist(a.x, a.z, site.x, site.z) - dist(b.x, b.z, site.x, site.z));
    const base = mineBases[0];
    const actions = el('div', 'actions');
    if (base) {
      const can = canBuildOutpost(s, base, siteId);
      const d = dist(base.x, base.z, site.x, site.z);
      const b = btn(`Build ${BUILDINGS.extractor.extraction![site.kind].name} (${costLine(BUILDINGS.extractor.cost)})`, () => this.c.buildOutpost(base.id, siteId), can.ok ? 'primary' : 'disabled');
      b.dataset.testid = 'build-outpost';
      actions.append(b);
      body.append(
        el('div', {
          class: `hint ${can.ok ? '' : 'bad'}`,
          text: can.ok ? `Supplied from ${base.name} (${Math.round(d)} km). A road will be built for convoys.` : `${can.reason}${d > OUTPOST_RANGE ? ` (max ${OUTPOST_RANGE} km)` : ''}`,
        }),
      );
      if (!canAfford(base.stock, BUILDINGS.extractor.cost)) actions.querySelector('button')?.classList.add('disabled');
    } else body.append(el('div', { class: 'hint bad', text: 'You have no base to supply an outpost.' }));
    body.append(actions);
    return panel;
  }
}
