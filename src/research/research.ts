/**
 * Research. Research Labs produce research points (RP) for their faction's
 * current project; completed technologies unlock unit designs/components/
 * buildings or multiply economic and military values ("modifier" effects,
 * read through researchMultiplier). The first tier is deliberately small;
 * the categories leave room for the planned AI, robotics, drones, alien
 * technology, cybernetics, consciousness transfer, vehicles and mechs.
 */

export type TechCategory =
  | 'industry'
  | 'military'
  | 'ai'
  | 'robotics'
  | 'drones'
  | 'alien'
  | 'cybernetics'
  | 'consciousness'
  | 'vehicles'
  | 'mechs';

export type TechEffect =
  | { type: 'unlock_component'; componentId: string }
  | { type: 'unlock_building'; buildingTypeId: string }
  | { type: 'unlock_design'; designId: string }
  | { type: 'modifier'; target: string; stat: string; multiply: number };

export interface TechDef {
  id: string;
  name: string;
  category: TechCategory;
  description: string;
  /** Research points (future research labs). */
  cost: number;
  prerequisites: string[];
  effects: TechEffect[];
}

export interface ResearchState {
  completed: string[];
  current: { techId: string; progress: number } | null;
  /** Progress kept on projects the player switched away from (resumed when picked again). */
  shelved: Record<string, number>;
}

/**
 * Modifier targets used by the simulation:
 *  extraction (extractor output), farm (food recipes), industry (refinery and
 *  factory recipes), construction (build speed), logistics (supply-truck field
 *  transfers), defense (damage taken by bunkers and gun emplacements).
 */
export const TECHS: Record<string, TechDef> = {
  deep_drilling: {
    id: 'deep_drilling',
    name: 'Deep-Core Drilling',
    category: 'industry',
    description: 'Extractors yield 25% more ore and hydrocarbons.',
    cost: 30,
    prerequisites: [],
    effects: [{ type: 'modifier', target: 'extraction', stat: 'output', multiply: 1.25 }],
  },
  hydroponics: {
    id: 'hydroponics',
    name: 'Hydroponics II',
    category: 'industry',
    description: 'Agri-Domes grow 30% more food.',
    cost: 25,
    prerequisites: [],
    effects: [{ type: 'modifier', target: 'farm', stat: 'output', multiply: 1.3 }],
  },
  prefab_construction: {
    id: 'prefab_construction',
    name: 'Prefab Construction',
    category: 'industry',
    description: 'Construction sites progress 35% faster.',
    cost: 40,
    prerequisites: [],
    effects: [{ type: 'modifier', target: 'construction', stat: 'speed', multiply: 1.35 }],
  },
  automated_lines: {
    id: 'automated_lines',
    name: 'Automated Lines',
    category: 'robotics',
    description: 'Refineries and factories work 20% faster.',
    cost: 60,
    prerequisites: ['deep_drilling'],
    effects: [{ type: 'modifier', target: 'industry', stat: 'speed', multiply: 1.2 }],
  },
  logistics_doctrine: {
    id: 'logistics_doctrine',
    name: 'Logistics Doctrine',
    category: 'military',
    description: 'Supply trucks transfer fuel and ammunition 60% faster in the field.',
    cost: 35,
    prerequisites: [],
    effects: [{ type: 'modifier', target: 'logistics', stat: 'rate', multiply: 1.6 }],
  },
  hardened_positions: {
    id: 'hardened_positions',
    name: 'Hardened Positions',
    category: 'military',
    description: 'Bunkers and gun emplacements take 25% less damage.',
    cost: 45,
    prerequisites: ['prefab_construction'],
    effects: [{ type: 'modifier', target: 'defense', stat: 'damage', multiply: 0.75 }],
  },
  atgm_teams: {
    id: 'atgm_teams',
    name: 'ATGM Teams',
    category: 'military',
    description: 'Barracks can train ATGM Teams: guided anti-tank missiles that out-range tank guns.',
    cost: 70,
    prerequisites: ['logistics_doctrine'],
    effects: [{ type: 'unlock_design', designId: 'atgm_team' }],
  },
};

/** Order the AI researches in. */
export const AI_TECH_ORDER = ['deep_drilling', 'prefab_construction', 'hydroponics', 'automated_lines', 'logistics_doctrine', 'hardened_positions', 'atgm_teams'];

/** Product of all completed "modifier" effects for a target (1 when none). */
export function researchMultiplier(research: ResearchState | undefined, target: string): number {
  if (!research) return 1;
  let m = 1;
  for (const id of research.completed) {
    const t = TECHS[id];
    if (!t) continue;
    for (const e of t.effects) if (e.type === 'modifier' && e.target === target) m *= e.multiply;
  }
  return m;
}

/** Technologies that can be started now (not done, prerequisites complete). */
export function availableTechs(research: ResearchState): TechDef[] {
  return Object.values(TECHS).filter((t) => !research.completed.includes(t.id) && t.prerequisites.every((p) => research.completed.includes(p)));
}

/** Choose (or switch) the current project. Progress on the project switched away from is shelved, not lost. */
export function startResearch(research: ResearchState, techId: string): boolean {
  if (!availableTechs(research).some((t) => t.id === techId)) return false;
  if (research.current?.techId === techId) return true;
  research.shelved ??= {};
  const cur = research.current;
  if (cur && cur.progress > 0) research.shelved[cur.techId] = cur.progress;
  research.current = { techId, progress: research.shelved[techId] ?? 0 };
  delete research.shelved[techId];
  return true;
}

/** Add research points to the current project; returns the technology completed, if any. */
export function addResearchPoints(research: ResearchState, points: number): TechDef | null {
  const cur = research.current;
  if (!cur || points <= 0) return null;
  const tech = TECHS[cur.techId];
  if (!tech) {
    research.current = null;
    return null;
  }
  cur.progress += points;
  if (cur.progress + 1e-9 < tech.cost) return null;
  research.completed.push(tech.id);
  research.current = null;
  return tech;
}

export function emptyResearch(): ResearchState {
  return { completed: [], current: null, shelved: {} };
}

/**
 * Components/buildings/designs that are not gated by any technology are
 * available from the start. This will consult TECHS once research exists.
 */
export function isUnlocked(research: ResearchState, kind: 'component' | 'building' | 'design', id: string): boolean {
  for (const tech of Object.values(TECHS)) {
    for (const eff of tech.effects) {
      const gated =
        (kind === 'component' && eff.type === 'unlock_component' && eff.componentId === id) ||
        (kind === 'building' && eff.type === 'unlock_building' && eff.buildingTypeId === id) ||
        (kind === 'design' && eff.type === 'unlock_design' && eff.designId === id);
      if (gated) return research.completed.includes(tech.id);
    }
  }
  return true;
}
