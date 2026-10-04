import { BUILDABLE_TYPES, BUILDINGS, buildingDisplayName, REBUILD_COST_FACTOR, type BuildingTypeId } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { RESOURCES, STOCK_RESOURCES, canAfford, formatCost, type PartialStock } from '../data/resources';
import { UNIT_DESIGNS } from '../data/unitDesigns';
import { campaignDay, formatCampaignTime, formatDuration, type SpeedSetting } from '../core/time';
import { dist } from '../core/math';
import { ARMY_MAX_UNITS, armyBaseSpeed, armyMen, armySupplies, fuelRange, maxRations, MERGE_RANGE, supplyingBase } from '../campaign/armies';
import { canBuildOutpost, canBuildType, OUTPOST_RANGE } from '../campaign/construction';
import { canFoundFrom, FOUND_COLONISTS, FOUND_COST, MAX_FOUND_RANGE, MIN_BASE_SPACING } from '../campaign/expansion';
import { affordability, designsFor, MAX_QUEUE } from '../campaign/production';
import { basesOf, isOutpost, isVisibleToFaction, PLAYER_VISION_RADIUS, relationOf } from '../campaign/queries';
import { agoText, CLOSE_LOOK, compassPoint, defencesText, observeBase, placeName, plural, SIGHTING_TTL, structureCount, tallyCount, tallyText } from '../campaign/intel';
import type { Army, ArmySighting, Base, BaseReport, Building, BuildingStatus, CampaignState, LogEntry, PendingBattle, UnitInstance } from '../campaign/types';
import { FOOD_PER_PERSON_HOUR } from '../economy/economy';
import { statsOf } from '../units/stats';
import { defenseStatsOf } from '../units/defense';
import { availableTechs, TECHS } from '../research/research';
import { reliefEta } from '../campaign/relief';
import { entriesSince } from '../campaign/context';
import { CONVOY_SPEED, KEEP_AT_HOME, MANUAL_CONVOY_CAPACITY, MANUAL_CONVOY_SEATS, supplyRunProblem, transferProblem } from '../campaign/convoys';
import { bar, btn, clear, el, fmt, ICONS, iconBtn, signed } from './dom';
import { openModal, Toasts } from './screens';

export type Selection =
  | { kind: 'army'; id: string }
  | { kind: 'base'; id: string }
  | { kind: 'building'; id: string }
  | { kind: 'site'; id: string }
  /** A rival force's last known position (id = the army id in the player's intel). */
  | { kind: 'contact'; id: string }
  | null;

/** What the HUD needs from the campaign mode. */
export interface CampaignController {
  readonly state: CampaignState;
  /** Interface sound cue (no-op without audio). */
  sound(kind: 'radio' | 'alert' | 'confirm'): void;
  readonly selection: Selection;
  readonly speed: SpeedSetting;
  readonly placing: { kind: 'building' | 'base'; typeId: BuildingTypeId; valid: boolean; reason: string } | null;
  setSpeed(s: SpeedSetting): void;
  select(sel: Selection, focus?: boolean): void;
  /** Jump to what a log entry is about (a sighted force, a reported base, or just its position). */
  showLogEntry(e: LogEntry): void;
  openMenu(): void;
  armyStop(id: string): void;
  armyReturn(id: string): void;
  armyGarrison(id: string): void;
  armyReinforce(id: string): void;
  armySplit(id: string, unitIds: string[]): void;
  armyMerge(intoId: string, fromId: string): void;
  setRepeat(buildingId: string, designId: string | null): void;
  setResearch(techId: string): void;
  deployGarrison(baseId: string): void;
  beginPlacement(baseId: string, typeId: BuildingTypeId): void;
  beginBaseFounding(fromBaseId: string): void;
  /** Dispatch a hand-loaded convoy; returns an error message or null. */
  sendConvoy(fromId: string, toId: string, cargo: PartialStock, people: number): string | null;
  /** Dispatch a supply run to a task force; returns an error message or null. */
  sendSupplyRun(fromId: string, armyId: string, cargo: PartialStock): string | null;
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
  /** Newest log entry already toasted. */
  private seenLog: LogEntry | null = null;
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
    const overview = iconBtn(ICONS.all, 'Expedition overview', () => this.openOverview());
    overview.dataset.testid = 'overview';
    fab.append(
      iconBtn(ICONS.base, 'Next base', () => this.cycleBase()),
      iconBtn(ICONS.army, 'Next task force', () => this.cycleArmy()),
      overview,
      iconBtn(ICONS.log, 'Event log', () => this.openLog()),
    );
    this.directive = el('div', 'panel directive');
    this.root.append(this.top, fab, this.side, this.placementBar, this.directive);
    host.append(this.root);
    this.toasts = new Toasts(this.root);
    this.seenLog = this.c.state.log[this.c.state.log.length - 1] ?? null;
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
    // the calendar date is dropped on narrow phones (CSS), the time of day always shows
    const stamp = formatCampaignTime(s.time);
    const cut = stamp.lastIndexOf(' · ');
    clear(this.clockDate);
    this.clockDate.append(el('span', { class: 'cal', text: stamp.slice(0, cut + 3) }), el('span', { text: stamp.slice(cut + 3) }));
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
    } else {
      // every base lost: say whether (and when) Earth's relief landing comes
      const eta = reliefEta(s, s.playerFactionId);
      const r = el('div', { class: 'res empty', style: '--c:#e2583f' });
      r.dataset.testid = 'no-base';
      r.append(
        el('div', { class: 'n', text: 'NO BASE' }),
        el('div', 't', el('span', { text: eta === null ? 'Earth has gone silent' : eta > 0 ? `Relief landing in ${formatDuration(eta)}` : 'Relief landing imminent' })),
      );
      this.resStrip.append(r);
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

  private cycleBase(): void {
    const s = this.c.state;
    const mine = basesOf(s, s.playerFactionId).sort((a, b) => a.founded - b.founded || (a.id < b.id ? -1 : 1));
    if (!mine.length) return;
    const sel = this.c.selection;
    const i = sel?.kind === 'base' ? mine.findIndex((b) => b.id === sel.id) : -1;
    this.c.select({ kind: 'base', id: mine[(i + 1) % mine.length].id }, true);
  }

  /** Everything the player commands at a glance; tap a row to jump there. */
  openOverview(): void {
    const s = this.c.state;
    const pf = s.playerFactionId;
    let close: () => void = () => undefined;
    const go = (sel: Selection): void => {
      close();
      this.c.select(sel, true);
    };
    const bases = el('div', 'list');
    for (const b of basesOf(s, pf).sort((x, y) => x.founded - y.founded)) {
      const e = b.econ;
      const warn: string[] = [];
      if (e.foodPerHour < 0 && b.stock.food < 40) warn.push('food');
      if (e.energyProduced + 0.01 < e.energyDemand) warn.push('power');
      if (e.workersEmployed < e.workersNeeded) warn.push('workers');
      if (b.stock.ammo < 15) warn.push('ammo');
      if (Object.values(s.buildings).some((x) => x.baseId === b.id && x.typeId === 'research_lab' && x.status === 'idle')) warn.push('research (lab idle)');
      const hqBuilding = Object.values(s.buildings).some((x) => x.baseId === b.id && x.typeId === 'hq' && x.state === 'construction');
      const row = el(
        'div',
        'item tap',
        el('span', { class: 'badge', text: 'BASE' }),
        el('span', { class: 'name', text: b.name }),
        el('span', {
          class: `meta ${warn.length ? 'warn' : ''}`,
          text: `${Math.floor(b.population)} ppl · ${b.garrison.length} units${hqBuilding ? ' · HQ assembling' : ''}${warn.length ? ` · low ${warn.join(', ')}` : ''}`,
        }),
      );
      row.dataset.testid = 'overview-base';
      row.addEventListener('click', () => go({ kind: 'base', id: b.id }));
      bases.append(row);
    }
    const armies = el('div', 'list');
    const mine = Object.values(s.armies).filter((a) => a.factionId === pf);
    if (!mine.length) armies.append(el('div', { class: 'muted', text: 'No task forces in the field.' }));
    for (const a of mine) {
      const range = fuelRange(a.units);
      const o = a.order;
      const doing = o.type === 'idle' ? 'holding' : o.type === 'move' ? 'moving' : o.type === 'return' ? 'returning' : o.type === 'attack_base' ? 'assaulting a base' : o.type === 'attack_army' ? 'pursuing' : 'attacking an outpost';
      const row = el(
        'div',
        'item tap',
        el('span', { class: 'badge', text: `${a.units.length}` }),
        el('span', { class: 'name', text: a.name }),
        el('span', {
          class: `meta ${range < 40 ? 'warn' : ''}`,
          text: `${doing} · ${composition(a.units)}${Number.isFinite(range) ? ` · ${Math.floor(range)} km fuel` : ''}`,
        }),
      );
      row.dataset.testid = 'overview-army';
      row.addEventListener('click', () => go({ kind: 'army', id: a.id }));
      armies.append(row);
    }
    const contacts = el('div', 'list');
    const seen = Object.values(s.intel[pf]?.armies ?? {}).sort((a, b) => Number(b.inSight) - Number(a.inSight) || b.t - a.t);
    if (!seen.length) contacts.append(el('div', { class: 'muted', text: 'No rival forces in view or recently seen.' }));
    for (const c of seen) {
      const row = el(
        'div',
        'item tap',
        el('span', { class: 'badge foe', text: `${tallyCount(c.units)}` }),
        el('span', { class: 'name', text: c.name }),
        el('span', {
          class: `meta ${c.inSight ? 'warn' : 'muted'}`,
          text: `${c.inSight ? 'in view' : `last seen ${agoText(s.time - c.t)}`} · ${placeName(s, c.x, c.z)} · ${tallyText(c.units)}`,
        }),
      );
      row.dataset.testid = 'overview-contact';
      row.addEventListener('click', () => go(c.inSight && s.armies[c.armyId] ? { kind: 'army', id: c.armyId } : { kind: 'contact', id: c.armyId }));
      contacts.append(row);
    }
    close = openModal(this.host, {
      kicker: 'Expedition overview',
      title: s.factions[pf]?.name ?? 'Expedition',
      body: [
        el('div', { class: 'label', text: 'Bases' }),
        bases,
        el('div', { class: 'label', text: 'Task forces' }),
        armies,
        el('div', { class: 'label', text: 'Contacts' }),
        contacts,
      ],
      actions: [{ label: 'Close', onClick: () => undefined }],
      dismissable: true,
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
      [
        has('research_lab') && !!(s.factions[pf]?.research.current || s.factions[pf]?.research.completed.length),
        'Build a Research Lab and choose a research project in its panel.',
      ],
      [units.filter((u) => u.designId === 'mbt').length >= 2, 'Produce a second Main Battle Tank at the Vehicle Depot.'],
      [has('bunker') || has('at_emplacement'), 'Fortify: build an MG Bunker or AT Gun on the side facing the rival.'],
      [basesOf(s, pf).length >= 2, 'Expand: found a second base near unclaimed resources (base panel → Found new base).'],
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
    const fresh = entriesSince(log, this.seenLog);
    this.seenLog = log[log.length - 1] ?? this.seenLog;
    let shown = false;
    let alarm = false;
    for (const e of fresh) {
      if (e.factionId && e.factionId !== this.c.state.playerFactionId) continue;
      if (e.at || e.ref) this.toasts.push(e.text, e.kind, 9000, { label: 'Show', onClick: () => this.c.showLogEntry(e) });
      else this.toasts.push(e.text, e.kind);
      shown = true;
      if (e.ref?.kind === 'army' && e.kind === 'warn') alarm = true;
    }
    if (shown) this.c.sound(alarm ? 'alert' : 'radio');
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
    const founding = p.kind === 'base';
    info.append(
      el('div', { style: { fontWeight: '700' }, text: founding ? 'Founding a new base' : `Placing ${BUILDINGS[p.typeId].name}` }),
      el('div', {
        class: p.valid ? 'muted' : 'bad',
        text: p.valid ? (founding ? 'Tap the map to choose the site · Confirm to send the colonists' : 'Tap inside the perimeter to move · Confirm to build') : p.reason,
      }),
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
    let close: () => void = () => undefined;
    const entries = s.log.filter((e: LogEntry) => !e.factionId || e.factionId === s.playerFactionId).slice(-40).reverse();
    for (const e of entries) {
      const where = !!(e.at || e.ref);
      const row = el(
        'div',
        where ? 'item tap' : 'item',
        el('span', { class: 'meta', text: formatCampaignTime(e.t).split(' · ')[1] ?? '' }),
        el('span', { class: `name ${e.kind === 'battle' ? 'bad' : e.kind === 'warn' ? 'warn' : e.kind === 'lore' ? 'accent' : ''}`, style: { whiteSpace: 'normal' }, text: e.text }),
        where ? el('span', { class: 'meta accent', text: 'SHOW' }) : null,
      );
      if (where) {
        row.dataset.testid = 'log-show';
        row.addEventListener('click', () => {
          close();
          this.c.showLogEntry(e);
        });
      }
      list.append(row);
    }
    close = openModal(this.host, { kicker: 'Communications', title: 'Event log', body: [list], actions: [{ label: 'Close', onClick: () => undefined }], dismissable: true });
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
    else if (sel?.kind === 'contact') {
      const seen = s.intel[s.playerFactionId]?.armies[sel.id];
      if (seen) panel = this.contactPanel(seen);
    }
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
      const sec = this.section(body, 'Observed strength', 'IN VIEW');
      const seen = s.intel[s.playerFactionId]?.armies[a.id];
      this.kv(sec, [
        ['Units', `${a.units.length}`],
        ['Personnel', `~${Math.round(armyMen(a) / 5) * 5}`],
        ['Heading', seen && (seen.hx || seen.hz) ? compassPoint(seen.hx, seen.hz) : 'stationary'],
        ['Position', placeName(s, a.x, a.z)],
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
    const supplier = supplyingBase(s, a);
    const sec = this.section(body, 'Status');
    const statusRows: [string, string, string?][] = [
      ['Orders', order, o.type === 'idle' ? 'muted' : 'accent'],
      ['Units / men', `${a.units.length} / ${armyMen(a)}`],
      ['Speed', `${armyBaseSpeed(a).toFixed(1)} km/h`],
      supplier
        ? ['Rations', `Supplied by ${supplier.name}`, 'ok']
        : ['Rations', `${days.toFixed(1)} days`, days < 1 ? 'bad' : days < 2 ? 'warn' : ''],
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
    if (!supplier && a.factionId === s.playerFactionId && basesOf(s, a.factionId).length) {
      const inbound = Object.values(s.convoys).some((c) => c.toArmyId === a.id);
      const sr = btn(inbound ? 'Supply run en route' : 'Supply run…', () => this.openSupplyRun(a), inbound ? 'disabled' : '');
      sr.dataset.testid = 'supply-run';
      actions.append(sr);
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

  /** Load a supply run (fuel, ammunition, rations) from one of our bases to a task force in the field. */
  private openSupplyRun(a: Army): void {
    const s = this.c.state;
    const bases = basesOf(s, a.factionId).sort((p, q) => dist(p.x, p.z, a.x, a.z) - dist(q.x, q.z, a.x, a.z));
    if (!bases.length) return;
    let from = bases[0];
    // what the force could take right now
    const need = { fuel: 0, ammo: 0, food: Math.max(0, Math.floor(maxRations(a) - a.food)) };
    for (const u of a.units) {
      const st = statsOf(u.designId);
      need.fuel += Math.max(0, st.fuelCapacity - u.fuel);
      need.ammo += Math.max(0, st.ammoCapacity - u.ammo);
    }
    const cargo: PartialStock = {};
    const prefill = (): void => {
      let room = MANUAL_CONVOY_CAPACITY;
      for (const k of ['fuel', 'ammo', 'food'] as const) {
        const v = Math.max(0, Math.min(Math.ceil(need[k] / 10) * 10, Math.floor(from.stock[k] / 10) * 10, room));
        cargo[k] = v;
        room -= v;
      }
    };
    prefill();
    const dest = el('div', 'seg convoy-dest');
    const srcBtns = bases.map((b) => {
      const d = btn(`${b.name} · ${Math.round(dist(b.x, b.z, a.x, a.z))} km`, () => {
        from = b;
        prefill();
        refresh();
      }, 'small');
      dest.append(d);
      return { b, d };
    });
    const grid = el('div', 'convoy-grid');
    const values = new Map<string, HTMLElement>();
    const labels: Record<'fuel' | 'ammo' | 'food', string> = { fuel: 'Fuel', ammo: 'Ammunition', food: 'Rations' };
    const haves = new Map<string, HTMLElement>();
    for (const k of ['fuel', 'ammo', 'food'] as const) {
      const v = el('span', { class: 'mono convoy-v' });
      values.set(k, v);
      const have = el('div', { class: 'muted mono' });
      haves.set(k, have);
      const minus = btn('−', () => {
        cargo[k] = Math.max(0, (cargo[k] ?? 0) - 10);
        refresh();
      }, 'convoy-step');
      const plus = btn('+', () => {
        cargo[k] = Math.min(Math.floor(from.stock[k]), (cargo[k] ?? 0) + 10);
        refresh();
      }, 'convoy-step');
      minus.dataset.testid = `supply-minus-${k}`;
      plus.dataset.testid = `supply-plus-${k}`;
      grid.append(el('div', 'convoy-row', el('div', 'convoy-label', el('div', { text: labels[k] }), have), minus, v, plus));
    }
    const info = el('div', 'hint');
    const problemEl = el('div', 'hint bad');
    let close: () => void = () => undefined;
    const go = btn('Dispatch supply run', () => {
      const err = this.c.sendSupplyRun(from.id, a.id, cargo);
      if (err) {
        problemEl.textContent = err;
        return;
      }
      close();
    }, 'primary');
    go.dataset.testid = 'supply-dispatch';
    const refresh = (): void => {
      for (const { b, d } of srcBtns) d.classList.toggle('active', b === from);
      let load = 0;
      for (const k of ['fuel', 'ammo', 'food'] as const) {
        values.get(k)!.textContent = `${cargo[k] ?? 0}`;
        haves.get(k)!.textContent = `needs ${Math.round(need[k])} · base has ${fmt(from.stock[k])}`;
        load += cargo[k] ?? 0;
      }
      const hours = dist(from.x, from.z, a.x, a.z) / CONVOY_SPEED;
      info.textContent = `Load ${load} / ${MANUAL_CONVOY_CAPACITY} · about ${formatDuration(hours)} to reach ${a.name} (it is followed if it moves). What the force cannot take comes back. Convoys can be intercepted.`;
      const problem = load < 1 ? null : supplyRunProblem(from, a, cargo);
      problemEl.textContent = problem ?? '';
      go.classList.toggle('disabled', !!problem || load < 1);
    };
    refresh();
    close = openModal(this.host, {
      kicker: `Supply run · ${a.name}`,
      title: 'Send supplies to the field',
      body: [el('div', { class: 'label', text: 'From' }), dest, grid, info, problemEl, el('div', 'actions', go)],
      actions: [{ label: 'Cancel', onClick: () => undefined }],
      dismissable: true,
    });
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

  /** What the player knows about a rival base: live while in view, otherwise the last dated report. */
  private baseIntel(body: HTMLElement, b: Base): void {
    const s = this.c.state;
    const live = isVisibleToFaction(s, s.playerFactionId, b.x, b.z);
    const r: BaseReport | undefined = live ? observeBase(s, b) : s.intel[s.playerFactionId]?.bases[b.id];
    const sec = this.section(body, 'Intelligence', live ? 'IN VIEW' : r ? `REPORT ${agoText(s.time - r.t)}`.toUpperCase() : 'NO REPORT');
    sec.dataset.testid = 'base-intel';
    if (!r) {
      sec.append(
        el('div', {
          class: 'hint',
          text: `No report yet. Bring a task force within ${PLAYER_VISION_RADIUS} km of the base to observe its defences and garrison.`,
        }),
      );
      return;
    }
    const garrison = tallyCount(r.garrison);
    const def = defencesText(r);
    this.kv(sec, [
      ['Structures', `${structureCount(r)}${r.underConstruction ? ` + ${r.underConstruction} building` : ''}`],
      ['Defences', def || 'none seen', def ? 'warn' : ''],
      ['Garrison', garrison ? `${plural(garrison, 'unit')} · ~${Math.round(r.garrisonMen / 5) * 5} soldiers` : 'none seen', garrison ? 'warn' : ''],
      ['Population', `~${r.population}`],
    ]);
    if (garrison) sec.append(el('div', { class: 'hint', text: tallyText(r.garrison) }));
    if (!live) sec.append(el('div', { class: 'hint', text: `Report from ${formatCampaignTime(r.t)}. Send a task force within ${PLAYER_VISION_RADIUS} km for a fresh look.` }));
  }

  /** A rival force that slipped out of view: where and when it was last seen. */
  private contactPanel(c: ArmySighting): HTMLElement {
    const s = this.c.state;
    const fac = s.factions[c.factionId];
    const { panel, body } = this.panelShell(`contact:${c.armyId}`, c.name, `${fac?.name ?? 'Unknown'} · last known position`, fac?.color);
    const sec = this.section(body, 'Last contact', agoText(s.time - c.t).toUpperCase());
    this.kv(sec, [
      ['Seen', formatCampaignTime(c.t)],
      ['Position', placeName(s, c.x, c.z)],
      ['Heading', c.hx || c.hz ? compassPoint(c.hx, c.hz) : 'stationary'],
      ['Units', `${tallyCount(c.units)}`],
      ['Personnel', `~${Math.round(c.men / 5) * 5}`],
    ]);
    sec.append(el('div', { class: 'hint', text: tallyText(c.units) }));
    body.append(
      el('div', {
        class: 'hint',
        text: `Out of view — it may have moved on. The marker fades after ${SIGHTING_TTL} h, or once one of your forces gets within ${Math.round(PLAYER_VISION_RADIUS * CLOSE_LOOK)} km of the spot. Select a task force and tap the marker to send it there.`,
      }),
    );
    return panel;
  }

  private basePanel(b: Base): HTMLElement {
    const s = this.c.state;
    const mine = b.factionId === s.playerFactionId;
    const fac = s.factions[b.factionId];
    const { panel, body } = this.panelShell(`base:${b.id}`, b.name, mine ? 'Expedition base' : fac?.name ?? 'Unknown', fac?.color);
    const buildings = Object.values(s.buildings).filter((x) => x.baseId === b.id);
    if (!mine) {
      this.baseIntel(body, b);
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
    const can = canFoundFrom(s, b);
    const fb = btn('Found new base…', () => this.c.beginBaseFounding(b.id), can.ok ? '' : 'disabled');
    fb.dataset.testid = 'found-base';
    actions.append(fb);
    if (basesOf(s, b.factionId).length > 1) {
      const sc = btn('Send convoy…', () => this.openConvoy(b));
      sc.dataset.testid = 'send-convoy';
      actions.append(sc);
    }
    body.append(actions);
    body.append(
      el('div', {
        class: can.ok ? 'hint' : 'hint bad',
        text: can.ok
          ? `Send ${FOUND_COLONISTS} colonists with a prefab command post (${costLine(FOUND_COST)}) to a site ${MIN_BASE_SPACING}–${MAX_FOUND_RANGE} km away.`
          : `New base: ${can.reason}.`,
      }),
    );
    return panel;
  }

  /** Load a convoy by hand: supplies and colonists for another of our bases. */
  private openConvoy(from: Base): void {
    const s = this.c.state;
    const others = basesOf(s, from.factionId).filter((x) => x.id !== from.id);
    if (!others.length) return;
    let to = others.slice().sort((p, q) => p.population - q.population)[0];
    const cargo: PartialStock = {};
    let people = 0;
    const dest = el('div', 'seg convoy-dest');
    const destBtns = others.map((o) => {
      const d = btn(`${o.name} · ${Math.round(dist(from.x, from.z, o.x, o.z))} km`, () => {
        to = o;
        refresh();
      }, 'small');
      d.dataset.testid = `convoy-to-${o.id}`;
      dest.append(d);
      return { o, d };
    });
    const grid = el('div', 'convoy-grid');
    const values = new Map<string, HTMLElement>();
    const row = (key: string, label: string, have: () => number, step: number, get: () => number, set: (v: number) => void): void => {
      const v = el('span', { class: 'mono convoy-v' });
      values.set(key, v);
      const minus = btn('−', () => {
        set(Math.max(0, get() - step));
        refresh();
      }, 'convoy-step');
      const plus = btn('+', () => {
        set(Math.min(have(), get() + step));
        refresh();
      }, 'convoy-step');
      minus.dataset.testid = `convoy-minus-${key}`;
      plus.dataset.testid = `convoy-plus-${key}`;
      grid.append(el('div', 'convoy-row', el('div', 'convoy-label', el('div', { text: label }), el('div', { class: 'muted mono', text: `have ${fmt(have())}` })), minus, v, plus));
    };
    for (const k of STOCK_RESOURCES) {
      row(k, RESOURCES[k].name, () => Math.floor(from.stock[k]), 10, () => cargo[k] ?? 0, (n) => {
        cargo[k] = n;
      });
    }
    row('people', 'Colonists', () => Math.max(0, Math.floor(from.population) - KEEP_AT_HOME), 2, () => people, (n) => {
      people = n;
    });
    const info = el('div', 'hint');
    const problemEl = el('div', 'hint bad');
    let close: () => void = () => undefined;
    const go = btn('Dispatch convoy', () => {
      const err = this.c.sendConvoy(from.id, to.id, cargo, people);
      if (err) {
        problemEl.textContent = err;
        return;
      }
      close();
    }, 'primary');
    go.dataset.testid = 'convoy-dispatch';
    const refresh = (): void => {
      for (const { o, d } of destBtns) d.classList.toggle('active', o === to);
      let load = 0;
      for (const k of STOCK_RESOURCES) {
        values.get(k)!.textContent = `${cargo[k] ?? 0}`;
        load += cargo[k] ?? 0;
      }
      values.get('people')!.textContent = `${people}`;
      const hours = dist(from.x, from.z, to.x, to.z) / CONVOY_SPEED;
      const room = to.econ.housing - Math.floor(to.population);
      info.textContent = `Load ${load} / ${MANUAL_CONVOY_CAPACITY} · colonists ${people} / ${MANUAL_CONVOY_SEATS} · about ${formatDuration(hours)} to ${to.name}${people > room ? ` · only ${Math.max(0, room)} free housing there` : ''}. Convoys can be intercepted.`;
      const problem = load < 1 && people < 1 ? null : transferProblem(from, to, cargo, people);
      problemEl.textContent = problem ?? '';
      go.classList.toggle('disabled', !!problem || (load < 1 && people < 1));
    };
    refresh();
    close = openModal(this.host, {
      kicker: `Convoy from ${from.name}`,
      title: 'Send supplies',
      body: [el('div', { class: 'label', text: 'Destination' }), dest, grid, info, problemEl, el('div', 'actions', go)],
      actions: [{ label: 'Cancel', onClick: () => undefined }],
      dismissable: true,
    });
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
      if (def.research) {
        const research = s.factions[x.factionId]?.research;
        if (research) {
          const r = this.section(body, 'Research', `${def.research * (x.efficiency ?? 0) > 0 ? (def.research * (x.efficiency ?? 0)).toFixed(1) : '0'} RP/h`);
          const cur = research.current ? TECHS[research.current.techId] : null;
          if (cur) {
            r.append(el('div', { class: 'name accent', text: cur.name }), bar(research.current!.progress / cur.cost, 'ok'));
            r.append(el('div', { class: 'hint', text: `${Math.floor(research.current!.progress)} / ${cur.cost} RP · ${cur.description}` }));
          } else {
            r.append(el('div', { class: 'hint warn', text: 'No project selected — the lab is idle. Choose one below.' }));
          }
          const avail = availableTechs(research).filter((t) => t.id !== research.current?.techId);
          for (const t of avail) {
            const kept = research.shelved?.[t.id] ?? 0;
            const tb = btn('', () => this.c.setResearch(t.id), 'small tech-btn');
            tb.dataset.testid = `research-${t.id}`;
            tb.append(
              el(
                'div',
                'tech-head',
                el('span', { class: 'tech-name', text: t.name }),
                el('span', { class: 'mono tech-cost', text: kept > 0 ? `${Math.floor(kept)} / ${t.cost} RP` : `${t.cost} RP` }),
              ),
              el('div', { class: 'tech-desc', text: t.description }),
            );
            r.append(tb);
          }
          if (research.current && avail.length) r.append(el('div', { class: 'hint', text: 'Switching projects keeps the progress made so far; it resumes when picked again.' }));
          if (research.completed.length) {
            r.append(el('div', { class: 'hint', text: `Completed: ${research.completed.map((id) => TECHS[id]?.name ?? id).join(', ')}` }));
          }
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
