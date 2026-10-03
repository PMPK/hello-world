import { formatClock } from '../core/time';
import type { BattleSim } from '../battle/sim';
import type { SideIndex } from '../battle/types';
import { btn, clear, el, ICONS, iconBtn } from './dom';
import { Minimap } from './minimap';
import { confirmModal } from './screens';

export interface BattleController {
  readonly sim: BattleSim;
  readonly playerSide: SideIndex;
  readonly speed: number;
  readonly selected: Set<number>;
  boxMode: boolean;
  attackMoveMode: boolean;
  setSpeed(s: number): void;
  selectAll(): void;
  selectSameType(): void;
  hold(): void;
  stop(): void;
  retreatSelected(): void;
  withdraw(): void;
  secure(): void;
  focusSelection(): void;
  jumpCamera(x: number, z: number): void;
  viewFootprint(): { x: number; z: number }[] | null;
}

export class BattleHud {
  readonly root: HTMLElement;
  private clockEl!: HTMLElement;
  private forces!: HTMLElement;
  private speedBtns: HTMLButtonElement[] = [];
  private endBtn!: HTMLButtonElement;
  private withdrawBtn!: HTMLButtonElement;
  private boxBtn!: HTMLButtonElement;
  private amBtn!: HTMLButtonElement;
  private selInfo: HTMLElement;
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
    this.root.append(this.selInfo);
    host.append(this.root);
    this.minimap = new Minimap(this.root, c.sim, c.playerSide, (x, z) => c.jumpCamera(x, z));
    this.update();
  }

  dispose(): void {
    this.root.remove();
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
    const sel = [...this.c.selected].map((id) => sim.unitById(id)).filter((u) => u && u.alive);
    clear(this.selInfo);
    if (sel.length) {
      const counts: Record<string, number> = {};
      for (const u of sel) counts[u!.stats.short] = (counts[u!.stats.short] ?? 0) + 1;
      this.selInfo.style.display = '';
      this.selInfo.append(el('span', { class: 'accent', text: `${sel.length} selected` }));
      for (const [k, v] of Object.entries(counts)) this.selInfo.append(el('span', { class: 'chip', text: `${k} ${v}` }));
      if (this.c.attackMoveMode) this.selInfo.append(el('span', { class: 'warn', text: 'ATTACK-MOVE' }));
    } else if (!this.hintShown || sim.time < 25) {
      this.selInfo.style.display = '';
      const mouse = !window.matchMedia?.('(pointer: coarse)').matches;
      this.selInfo.append(
        el('span', {
          class: 'muted',
          text: mouse
            ? 'Click or drag-box to select · right-click ground to move · right-click enemy to attack · A = attack-move'
            : 'Tap a unit or use BOX to select · tap ground to move · tap enemy to attack',
        }),
      );
      if (sim.time > 25) this.hintShown = true;
    } else this.selInfo.style.display = 'none';
    this.minimap.draw(this.c.viewFootprint());
  }

  showBanner(text: string, cls: string): void {
    this.banner?.remove();
    this.banner = el('div', { class: `panel banner ${cls}`, text });
    this.root.append(this.banner);
  }
}
