export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  quality: Quality;
  showFps: boolean;
  autosaveMinutes: number;
  /** Seen the intro at least once. */
  introSeen: boolean;
  edgeScroll: boolean;
}

const KEY = 'planet-x:settings';

export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

export function defaultSettings(): Settings {
  return {
    quality: isTouchDevice() ? 'medium' : 'high',
    showFps: false,
    autosaveMinutes: 2,
    introSeen: false,
    edgeScroll: false,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      ...d,
      ...s,
      quality: s.quality === 'low' || s.quality === 'medium' || s.quality === 'high' ? s.quality : d.quality,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
