type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  onclick?: (e: Event) => void;
  attrs?: Record<string, string>;
  dataset?: Record<string, string>;
}

/** Tiny DOM builder. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps | string = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  const p: ElProps = typeof props === 'string' ? { class: props } : props;
  if (p.class) e.className = p.class;
  if (p.text !== undefined) e.textContent = p.text;
  if (p.html !== undefined) e.innerHTML = p.html;
  if (p.title) e.title = p.title;
  if (p.style) {
    if (typeof p.style === 'string') e.setAttribute('style', p.style);
    else Object.assign(e.style, p.style);
  }
  if (p.onclick) {
    const fn = p.onclick;
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      fn(ev);
    });
  }
  if (p.attrs) for (const [k, v] of Object.entries(p.attrs)) e.setAttribute(k, v);
  if (p.dataset) for (const [k, v] of Object.entries(p.dataset)) e.dataset[k] = v;
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function clear(e: HTMLElement): void {
  while (e.firstChild) e.removeChild(e.firstChild);
}

export function btn(label: string | Node, onclick: () => void, cls = '', title = ''): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}`.trim(), onclick: () => onclick(), title, attrs: { type: 'button' } });
  if (typeof label === 'string') b.textContent = label;
  else b.append(label);
  return b;
}

export function iconBtn(icon: string, label: string, onclick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: `btn ${cls}`.trim(), onclick: () => onclick(), title: label, attrs: { type: 'button', 'aria-label': label } });
  b.innerHTML = icon;
  if (cls.includes('labeled')) b.append(el('span', { text: label }));
  return b;
}

export function bar(frac: number, kind: 'auto' | 'ok' | 'warn' | 'bad' = 'auto'): HTMLDivElement {
  const f = Math.max(0, Math.min(1, frac));
  const k = kind === 'auto' ? (f > 0.6 ? 'ok' : f > 0.3 ? 'warn' : 'bad') : kind;
  const b = el('div', `bar ${k === 'ok' ? '' : k}`);
  b.append(el('i', { style: { width: `${(f * 100).toFixed(1)}%` } }));
  return b;
}

export function fmt(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return n.toFixed(digits);
}

export function signed(n: number, digits = 1): string {
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

/** Inline SVG icons (stroke-based, inherit currentColor). */
export const ICONS = {
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  log: '<svg viewBox="0 0 24 24"><path d="M5 5h14M5 10h14M5 15h9M5 20h6"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/></svg>',
  base: '<svg viewBox="0 0 24 24"><path d="M3 20h18M5 20V10l7-5 7 5v10M10 20v-5h4v5"/></svg>',
  army: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="1"/><path d="M3 7l18 10M21 7L3 17"/></svg>',
  all: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  box: '<svg viewBox="0 0 24 24"><path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/></svg>',
  attackMove: '<svg viewBox="0 0 24 24"><path d="M4 20L14 10M14 10V16M14 10H8"/><circle cx="17" cy="7" r="3"/></svg>',
  hold: '<svg viewBox="0 0 24 24"><path d="M6 4h12v16H6zM10 9v6M14 9v6"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>',
  retreat: '<svg viewBox="0 0 24 24"><path d="M20 12H5M11 6l-6 6 6 6"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h12l-3 4 3 4H5"/></svg>',
  build: '<svg viewBox="0 0 24 24"><path d="M3 21h18M6 21V11h12v10M9 11V7h6v4"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M5 4h11l3 3v13H5zM8 4v5h7M8 20v-6h8v6"/></svg>',
  type: '<svg viewBox="0 0 24 24"><circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><path d="M10 12h4"/></svg>',
  focus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>',
  rotate: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.5"/></svg>',
};
