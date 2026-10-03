/**
 * Faction definitions are pure data so that the anonymous expeditions can
 * later be replaced by real or fictional nations without code changes.
 */
export interface FactionDef {
  id: string;
  /** Display name, e.g. "MERIDIAN Expedition". */
  name: string;
  codename: string;
  shortName: string;
  /** UI / banner colour. */
  color: string;
  colorDark: string;
  /** Vehicle paint (multiplied over model vertex colours). */
  vehicleTint: string;
  /** Uniform colour for infantry. */
  uniformTint: string;
  /** Building accent / roof colour. */
  structureAccent: string;
  baseNames: string[];
  armyNames: string[];
  commanderNames: string[];
  ai: {
    /** 0..1, willingness to attack. */
    aggression: number;
    /** 0..1, preference to expand to resource sites. */
    expansion: number;
    /** 0..1, how much superiority it wants before attacking. */
    caution: number;
  };
}

export const FACTION_DEFS: Record<string, FactionDef> = {
  meridian: {
    id: 'meridian',
    name: 'MERIDIAN Expedition',
    codename: 'MERIDIAN',
    shortName: 'MRD',
    color: '#4fa3e0',
    colorDark: '#1d4f73',
    vehicleTint: '#7c8a5c',
    uniformTint: '#6f7d58',
    structureAccent: '#3f86c0',
    baseNames: ['Landing Site Meridian', 'Outpost Halyard', 'Station Polaris', 'Camp Sextant'],
    armyNames: ['Task Force Anvil', 'Task Force Lantern', 'Task Force Granite', 'Task Force Harrow', 'Task Force Talon', 'Task Force Rook', 'Task Force Cobalt', 'Task Force Quarry'],
    commanderNames: ['Maj. A. Kessler', 'Capt. R. Okafor', 'Capt. L. Varga', 'Lt. Col. D. Moreau', 'Capt. S. Lindqvist', 'Maj. T. Brandt', 'Capt. J. Reyes', 'Capt. N. Haddad'],
    ai: { aggression: 0.5, expansion: 0.6, caution: 0.5 },
  },
  vantage: {
    id: 'vantage',
    name: 'VANTAGE Expedition',
    codename: 'VANTAGE',
    shortName: 'VTG',
    color: '#e0623f',
    colorDark: '#7a2a17',
    vehicleTint: '#8f8571',
    uniformTint: '#7d745f',
    structureAccent: '#c4532f',
    baseNames: ['Landing Site Vantage', 'Outpost Bastion', 'Station Zenith', 'Camp Ridgeback'],
    armyNames: ['Group Sabre', 'Group Thorn', 'Group Basalt', 'Group Hammer', 'Group Viper', 'Group Ember', 'Group Bulwark', 'Group Falchion'],
    commanderNames: ['Col. I. Sorokin', 'Maj. P. Albrecht', 'Capt. E. Nakamura', 'Maj. F. Castellan', 'Capt. G. Petrov', 'Capt. H. Duval', 'Maj. K. Osei', 'Capt. M. Ivers'],
    ai: { aggression: 0.6, expansion: 0.7, caution: 0.45 },
  },
};

export const PLAYER_FACTION_DEF = 'meridian';
export const ENEMY_FACTION_DEF = 'vantage';
