import { GAME_INFO } from '../config/gameInfo';
import { DIFFICULTIES, DIFFICULTY_ORDER, type Difficulty } from '../data/difficulty';
import { INTRO_LINES, INTRO_SIGNOFF } from '../data/lore';
import type { Quality, Settings } from '../app/settings';
import type { SaveInfo } from '../persistence/save';
import { btn, el, ICONS } from './dom';

/** Modal dialog helper. Returns a close function. */
export function openModal(
  root: HTMLElement,
  opts: { kicker?: string; title: string; body: (Node | string)[]; actions: { label: string; cls?: string; onClick: () => void; keepOpen?: boolean }[]; dismissable?: boolean },
): () => void {
  const back = el('div', 'modal-back');
  const panel = el('div', 'panel modal');
  const head = el('div', 'panel-head');
  const titleBox = el('div', 'panel-title');
  if (opts.kicker) titleBox.append(el('div', { class: 'kicker', text: opts.kicker }));
  titleBox.append(el('h1', { text: opts.title }));
  head.append(titleBox);
  const close = (): void => back.remove();
  if (opts.dismissable) {
    const x = el('button', { class: 'btn small', attrs: { type: 'button', 'aria-label': 'Close' }, onclick: close });
    x.innerHTML = ICONS.close;
    head.append(x);
  }
  const body = el('div', 'panel-body');
  for (const b of opts.body) body.append(typeof b === 'string' ? el('p', { text: b }) : b);
  const actions = el('div', 'actions');
  for (const a of opts.actions) {
    actions.append(
      btn(a.label, () => {
        if (!a.keepOpen) close();
        a.onClick();
      }, a.cls ?? ''),
    );
  }
  body.append(actions);
  panel.append(head, body);
  back.append(panel);
  if (opts.dismissable) {
    back.addEventListener('click', (e) => {
      if (e.target === back) close();
    });
  }
  root.append(back);
  return close;
}

export function confirmModal(root: HTMLElement, title: string, text: string, okLabel: string, onOk: () => void, danger = false): void {
  openModal(root, {
    title,
    body: [text],
    dismissable: true,
    actions: [
      { label: 'Cancel', onClick: () => undefined },
      { label: okLabel, cls: danger ? 'danger' : 'primary', onClick: onOk },
    ],
  });
}

// ---------------------------------------------------------------------------

export interface MainMenuActions {
  onContinue: (() => void) | null;
  onNew: () => void;
  difficulty: Difficulty;
  onDifficulty: (d: Difficulty) => void;
  onLoad: () => void;
  onSettings: () => void;
  onReset: (() => void) | null;
  onFullscreen: (() => void) | null;
  onInstall: (() => void) | null;
}

export function mainMenu(root: HTMLElement, latest: SaveInfo | null, a: MainMenuActions): HTMLElement {
  const screen = el('div', 'menu-screen');
  const inner = el('div', 'menu-inner');
  inner.append(el('h1', { class: 'menu-title', text: GAME_INFO.title }), el('div', { class: 'menu-sub', text: GAME_INFO.subtitle }));
  if (a.onContinue && latest) {
    const b = btn('', a.onContinue, 'primary');
    b.append(el('span', { text: 'Continue' }), el('span', { class: 'mono', style: { marginLeft: 'auto', fontSize: '11px', opacity: '0.8' }, text: `Day ${latest.summary.day}` }));
    b.dataset.testid = 'continue';
    inner.append(b);
  }
  const nb = btn('New Campaign', a.onNew, latest ? '' : 'primary');
  nb.dataset.testid = 'new-campaign';
  inner.append(nb);
  // difficulty for the next new campaign
  const dseg = el('div', 'seg menu-diff');
  const dhint = el('div', { class: 'menu-diff-hint', text: DIFFICULTIES[a.difficulty].description });
  const dbtns = DIFFICULTY_ORDER.map((d) => {
    const b = btn(DIFFICULTIES[d].name, () => {
      dbtns.forEach((x, i) => x.classList.toggle('active', DIFFICULTY_ORDER[i] === d));
      dhint.textContent = DIFFICULTIES[d].description;
      a.onDifficulty(d);
    }, `small ${d === a.difficulty ? 'active' : ''}`);
    b.dataset.testid = `difficulty-${d}`;
    return b;
  });
  dseg.append(...dbtns);
  inner.append(el('div', { class: 'menu-diff-row' }, el('span', { class: 'menu-diff-label', text: 'Rival' }), dseg), dhint);
  const lb = btn(latest ? 'Load Game' : 'Import Save', a.onLoad);
  lb.dataset.testid = 'load-game';
  inner.append(lb);
  // secondary actions share one compact row so the menu fits a landscape phone
  const row = el('div', 'menu-row');
  row.append(btn('Settings', a.onSettings));
  if (a.onFullscreen) row.append(btn('Fullscreen', a.onFullscreen));
  if (a.onInstall) row.append(btn('Install', a.onInstall));
  if (a.onReset && latest) row.append(btn('Reset', a.onReset, 'danger'));
  inner.append(row);
  const meta = el('div', 'menu-meta');
  meta.innerHTML = latest
    ? `LAST SAVE · ${latest.summary.date} · ${latest.slot.toUpperCase()}<br/>${latest.summary.bases} base(s) · ${latest.summary.armies} task force(s)`
    : 'NO SAVED CAMPAIGN';
  meta.innerHTML += `<br/>BUILD ${GAME_INFO.version} · MVP`;
  inner.append(meta);
  screen.append(inner, el('div', { class: 'stamp', text: 'CLASSIFIED' }));
  root.append(screen);
  return screen;
}

export function introScreen(root: HTMLElement, onDone: () => void): HTMLElement {
  const s = el('div', 'intro');
  const lines = el('div', 'intro-lines');
  const ps: HTMLElement[] = INTRO_LINES.map((t, i) => el('p', { class: i === 0 ? 'year' : '', text: t }));
  ps.push(el('p', { class: 'sign', text: INTRO_SIGNOFF }));
  lines.append(...ps);
  const done = (): void => {
    s.remove();
    onDone();
  };
  const next = btn('Begin', done, 'primary');
  next.dataset.testid = 'intro-begin';
  const skip = btn('Skip', done);
  skip.dataset.testid = 'intro-skip';
  s.append(lines, el('div', 'intro-actions', skip, next));
  root.append(s);
  ps.forEach((p, i) => setTimeout(() => p.classList.add('on'), 300 + i * 1100));
  return s;
}

export function settingsModal(root: HTMLElement, s: Settings, onChange: (s: Settings) => void, extra: { onReset?: () => void; onMainMenu?: () => void } = {}): void {
  const body: Node[] = [];
  const q = el('div', 'section');
  q.append(el('div', { class: 'label', text: 'Graphics quality' }));
  const seg = el('div', 'seg');
  const opts: Quality[] = ['low', 'medium', 'high'];
  const btns = opts.map((o) =>
    btn(o, () => {
      s.quality = o;
      btns.forEach((b, i) => b.classList.toggle('active', opts[i] === o));
      onChange(s);
    }, s.quality === o ? 'active' : ''),
  );
  seg.append(...btns);
  q.append(seg, el('div', { class: 'hint', text: 'Low: no shadows, fewer trees, 1x resolution. High: shadows, dense forests, sharp rendering. Changes apply immediately (anti-aliasing after restart).' }));
  body.push(q);
  const f = el('div', 'section');
  f.append(el('div', { class: 'label', text: 'Display' }));
  const fps = btn(s.showFps ? 'FPS counter: on' : 'FPS counter: off', () => {
    s.showFps = !s.showFps;
    fps.textContent = s.showFps ? 'FPS counter: on' : 'FPS counter: off';
    onChange(s);
  });
  f.append(fps);
  body.push(f);
  const snd = el('div', 'section');
  snd.append(el('div', { class: 'label', text: 'Sound' }));
  const levels: [string, number][] = [
    ['Off', 0],
    ['Low', 0.35],
    ['Medium', 0.7],
    ['High', 1],
  ];
  const sseg = el('div', 'seg');
  const isLevel = (v: number): boolean => (v === 0 ? s.muted || s.soundVolume === 0 : !s.muted && Math.abs(s.soundVolume - v) < 0.01);
  const sbtns = levels.map(([label, v]) =>
    btn(label, () => {
      if (v === 0) s.muted = true;
      else {
        s.muted = false;
        s.soundVolume = v;
      }
      sbtns.forEach((b, i) => b.classList.toggle('active', isLevel(levels[i][1])));
      onChange(s);
    }, isLevel(v) ? 'active' : ''),
  );
  sseg.append(...sbtns);
  snd.append(sseg, el('div', { class: 'hint', text: 'Procedural battle sounds, radio and wind. M toggles mute on a keyboard.' }));
  body.push(snd);
  const mus = el('div', 'section');
  mus.append(el('div', { class: 'label', text: 'Music' }));
  const mlevels: [string, number][] = [
    ['Off', 0],
    ['Low', 0.3],
    ['Medium', 0.6],
    ['High', 1],
  ];
  const mseg = el('div', 'seg');
  const mbtns = mlevels.map(([label, v]) =>
    btn(label, () => {
      s.musicVolume = v;
      mbtns.forEach((b, i) => b.classList.toggle('active', Math.abs(s.musicVolume - mlevels[i][1]) < 0.01));
      onChange(s);
    }, Math.abs(s.musicVolume - v) < 0.01 ? 'active' : ''),
  );
  mseg.append(...mbtns);
  mus.append(mseg, el('div', { class: 'hint', text: 'Generated ambient score: calm on the map, darker in battle.' }));
  body.push(mus);
  const a = el('div', 'section');
  a.append(el('div', { class: 'label', text: 'Autosave' }));
  const as = el('div', 'seg');
  const choices = [1, 2, 5];
  const asb = choices.map((m) =>
    btn(`${m} min`, () => {
      s.autosaveMinutes = m;
      asb.forEach((b, i) => b.classList.toggle('active', choices[i] === m));
      onChange(s);
    }, s.autosaveMinutes === m ? 'active' : ''),
  );
  as.append(...asb);
  a.append(as);
  body.push(a);
  const actions: { label: string; cls?: string; onClick: () => void }[] = [];
  if (extra.onMainMenu) actions.push({ label: 'Main menu', onClick: extra.onMainMenu });
  if (extra.onReset) actions.push({ label: 'Reset campaign', cls: 'danger', onClick: extra.onReset });
  actions.push({ label: 'Close', cls: 'primary', onClick: () => undefined });
  openModal(root, { kicker: 'Settings', title: 'Configuration', body, actions, dismissable: true });
}

/** Toast notifications (bottom-left). */
export class Toasts {
  readonly el: HTMLElement;
  constructor(root: HTMLElement) {
    this.el = el('div', 'toasts');
    root.append(this.el);
  }
  push(text: string, kind = 'info', ms = 6500): void {
    const t = el('div', { class: `toast ${kind}`, text });
    this.el.prepend(t);
    while (this.el.children.length > 4) this.el.lastElementChild?.remove();
    setTimeout(() => t.classList.add('fade'), ms);
    setTimeout(() => t.remove(), ms + 700);
  }
  clear(): void {
    this.el.innerHTML = '';
  }
}

export function rotateOverlay(): HTMLElement {
  const o = el('div', 'rotate-overlay');
  const icon = el('div');
  icon.innerHTML = ICONS.phone;
  o.append(
    icon,
    el('div', { style: { fontSize: '18px', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: '700' }, text: 'Rotate your device' }),
    el('div', { class: 'muted', style: { maxWidth: '300px', lineHeight: '1.5' }, text: `${GAME_INFO.shortTitle} is designed for landscape. Turn your phone sideways for the full command view.` }),
    btn('Continue in portrait', () => o.classList.add('dismissed')),
  );
  document.body.append(o);
  return o;
}
