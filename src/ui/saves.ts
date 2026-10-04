import { MANUAL_SLOTS, slotLabel, type SaveInfo, type SaveSlot } from '../persistence/save';
import { btn, el } from './dom';
import { openModal } from './screens';

function savedAtText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function slotRow(slot: SaveSlot, info: SaveInfo | undefined, ...actions: HTMLElement[]): HTMLElement {
  const text = el(
    'div',
    { style: { flex: '1', minWidth: '0' } },
    el('div', { class: 'name', text: slotLabel(slot) }),
    el('div', {
      class: 'meta',
      text: info ? `Day ${info.summary.day} · ${info.summary.date} · ${info.summary.bases} base(s) · saved ${savedAtText(info.savedAt)}` : 'Empty',
    }),
  );
  const row = el('div', { class: 'item save-row', dataset: { slot } }, text, ...actions);
  return row;
}

/** Save a file to the device (returns false when the browser blocks downloads). */
export function downloadText(name: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}

interface HostDownloads {
  save(r: { filename: string; data: string }): Promise<{ status: string }>;
}

/**
 * Offer a generated file to the player. Inside the claude.ai artifact viewer
 * plain downloads are blocked, so the host's `downloads` capability is used
 * when the page is framed there; everywhere else a normal browser download.
 */
export async function offerFile(filename: string, text: string): Promise<'saved' | 'declined' | 'blocked'> {
  const host = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
  if (host && typeof host.use === 'function') {
    let dl: HostDownloads | null = null;
    try {
      dl = (await host.use('downloads')) as HostDownloads | null;
    } catch {
      dl = null;
    }
    if (dl) {
      try {
        await dl.save({ filename, data: text });
        return 'saved';
      } catch (e) {
        return (e as { code?: string } | null)?.code === 'declined' ? 'declined' : 'blocked';
      }
    }
  }
  return downloadText(filename, text) ? 'saved' : 'blocked';
}

export interface SaveModalHandlers {
  onSave: (slot: SaveSlot) => void;
  onExport: () => void;
  onCopy: () => void;
}

/** Pause-menu "Save game": choose a manual slot or export a portable file. */
export function saveGameModal(root: HTMLElement, saves: SaveInfo[], h: SaveModalHandlers): void {
  const list = el('div', 'list');
  let close: () => void = () => undefined;
  for (const slot of MANUAL_SLOTS) {
    const info = saves.find((s) => s.slot === slot);
    const b = btn(info ? 'Overwrite' : 'Save', () => {
      close();
      h.onSave(slot);
    }, info ? 'small' : 'small primary');
    b.dataset.testid = `save-${slot}`;
    list.append(slotRow(slot, info, b));
  }
  const exp = btn('Export file', () => h.onExport(), 'small');
  exp.dataset.testid = 'export-save';
  const copy = btn('Copy to clipboard', () => h.onCopy(), 'small');
  const portable = el('div', 'actions', exp, copy);
  close = openModal(root, {
    kicker: 'Save game',
    title: 'Choose a slot',
    body: [
      list,
      el('div', { class: 'hint', text: 'Saves live in this browser. Export a file (or copy the save text) to keep a backup or move the campaign to another device.' }),
      portable,
    ],
    actions: [{ label: 'Cancel', onClick: () => undefined }],
    dismissable: true,
  });
}

export interface LoadModalHandlers {
  onLoad: (slot: SaveSlot) => void;
  onDelete: (slot: SaveSlot) => void;
  /** Raw JSON from a file or pasted text. Resolves to an error message, or null on success. */
  onImport: (json: string) => Promise<string | null>;
}

/** Main-menu "Load game": every stored slot plus importing a save file or pasted save text. */
export function loadGameModal(root: HTMLElement, saves: SaveInfo[], h: LoadModalHandlers): void {
  let close: () => void = () => undefined;
  const list = el('div', 'list');
  if (!saves.length) list.append(el('div', { class: 'hint', text: 'No saved campaigns in this browser.' }));
  for (const info of saves) {
    const load = btn('Load', () => {
      close();
      h.onLoad(info.slot);
    }, 'small primary');
    load.dataset.testid = `load-${info.slot}`;
    const del = btn('Delete', () => {
      close();
      h.onDelete(info.slot);
    }, 'small danger');
    list.append(slotRow(info.slot, info, load, del));
  }
  const status = el('div', { class: 'hint' });
  const run = (json: string): void => {
    status.textContent = 'Importing…';
    status.className = 'hint';
    void h.onImport(json).then((err) => {
      if (err) {
        status.textContent = err;
        status.className = 'hint bad';
      } else close();
    });
  };
  const file = el('input', { attrs: { type: 'file', accept: '.json,application/json,text/plain' }, style: { display: 'none' } });
  file.dataset.testid = 'import-file';
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    void f.text().then(run, () => {
      status.textContent = 'Could not read that file.';
      status.className = 'hint bad';
    });
    file.value = '';
  });
  const pickBtn = btn('Import file…', () => file.click(), 'small');
  const paste = el('textarea', {
    class: 'save-paste',
    attrs: { rows: '2', placeholder: '…or paste save text here', spellcheck: 'false', autocomplete: 'off' },
  });
  const pasteBtn = btn('Import text', () => {
    if (paste.value.trim()) run(paste.value);
  }, 'small');
  close = openModal(root, {
    kicker: 'Load game',
    title: 'Saved campaigns',
    body: [list, el('div', { class: 'label', text: 'Import' }), el('div', 'actions', pickBtn, pasteBtn), paste, file, status],
    actions: [{ label: 'Close', onClick: () => undefined }],
    dismissable: true,
  });
}
