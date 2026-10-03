/**
 * Research — EXTENSION POINT ONLY in the MVP.
 *
 * The full game will add technologies for AI, robotics, drones, alien
 * technology, cybernetics, consciousness transfer, custom vehicles and mechs.
 * Technologies unlock unit components, building types and modifiers. Nothing
 * here is active yet; the types and registry exist so other systems can ask
 * "is X unlocked?" today and get a real answer later without refactoring.
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
}

/** Registry of technologies. Empty in the MVP. */
export const TECHS: Record<string, TechDef> = {};

export function emptyResearch(): ResearchState {
  return { completed: [], current: null };
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
