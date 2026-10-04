import { PLAYER_VISION_RADIUS } from '../campaign/queries';
import { btn, el } from './dom';
import { openModal } from './screens';

/**
 * In-game help: a short tips card the first time the player commands a
 * battle, and a "How to play" page reachable from the command menu and the
 * battle bar. Wording follows the input the device actually has.
 */

function list(items: string[]): HTMLElement {
  const ul = el('ul', 'help-list');
  for (const t of items) ul.append(el('li', { text: t }));
  return ul;
}

function campaignTips(touch: boolean): string[] {
  const tap = touch ? 'Tap' : 'Click';
  return [
    `${tap} your base to see its people, power, stores and structures; Build… places new structures (a green ghost means the spot is valid).`,
    touch
      ? 'Drag to pan, pinch to zoom, twist two fingers to rotate. The buttons on the left jump to your bases, task forces, the overview and the event log.'
      : 'Drag or WASD to pan, wheel to zoom, right-drag or Q/E to rotate. Space pauses, 1 / 2 / 4 set the speed.',
    `${tap} a task force, then ${touch ? 'tap' : 'right-click'} the ground to move it or an enemy to attack. Forces need rations, fuel and ammunition — trucks carry more, bases refill them.`,
    'Follow the DIRECTIVE line at the top-left: it walks you through the economy, the military, research, fortifications and expansion.',
    `Rival forces that come into view are reported — ${tap.toLowerCase()} Show to jump to them. When one slips out of view, a dashed ? marker keeps its last known position; rival bases only reveal their defences and garrison while one of your forces is within ${PLAYER_VISION_RADIUS} km (the overview lists every contact).`,
    'The rival will not shoot first while the standoff lasts — but tension rises. Fortify before it reaches 100%.',
  ];
}

function battleTips(touch: boolean): string[] {
  return touch
    ? [
        'Tap a unit to select it, double-tap to select every unit of that type, or use ALL / TYPE / BOX.',
        'Tap the ground to move, tap an enemy to attack, long-press the ground to attack-move (units fight on the way).',
        'Select infantry and tap one of your buildings to garrison it — cover, height and concealment.',
        'Keep tanks back from infantry in forests; use the ridges. FALL BACK pulls the selection off the field.',
      ]
    : [
        'Left-click or drag a box to select; Ctrl+A selects everything; double-click selects that type.',
        'Right-click the ground to move or an enemy to attack; A then click = attack-move. H hold · S stop · X fall back.',
        'Select infantry and click one of your buildings to garrison it — cover, height and concealment.',
        'Keep tanks back from infantry in forests; use the ridges. C centres the camera on the selection.',
      ];
}

/** The full help page (campaign + battle). */
export function howToPlayModal(root: HTMLElement, touch: boolean): void {
  openModal(root, {
    kicker: 'Field manual',
    title: 'How to play',
    body: [
      el('div', { class: 'label', text: 'Campaign map' }),
      list(campaignTips(touch)),
      el('div', { class: 'label', text: 'Tactical battle' }),
      list(battleTips(touch)),
      el('div', {
        class: 'hint',
        text: 'Battles happen when hostile forces meet or a base is attacked: command them yourself or auto-resolve them. Everything that happens in a battle — casualties, ammunition, damaged buildings — carries over to the campaign.',
      }),
    ],
    actions: [{ label: 'Close', cls: 'primary', onClick: () => undefined }],
    dismissable: true,
  });
}

/** Compact card shown once, at the start of the player's first battle. */
export function battleTipsCard(root: HTMLElement, touch: boolean, onClose: () => void): void {
  let close: () => void = () => undefined;
  const more = btn('Full manual', () => {
    close();
    onClose();
    howToPlayModal(root, touch);
  }, 'small');
  close = openModal(root, {
    kicker: 'First engagement',
    title: 'Battle orders',
    body: [list(battleTips(touch)), el('div', { class: 'hint', text: 'The battle is paused until you are ready. The ? button on the battle bar brings this back.' }), el('div', 'actions', more)],
    actions: [{ label: 'Got it — start', cls: 'primary', onClick: onClose }],
  });
  const panel = root.querySelector('.modal-back:last-child .panel');
  panel?.setAttribute('data-testid', 'battle-tips');
}
