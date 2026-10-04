/** Campaign difficulty: tunes the rival expedition, never the player's own rules. */
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyDef {
  id: Difficulty;
  name: string;
  description: string;
  /** Multiplier on the rival's extraction, refining and production speed. */
  aiIncome: number;
  /** Added to the rival faction's caution when weighing attacks (+ = more careful). */
  aiCaution: number;
  /** Multiplier on the pause between the rival's offensives. */
  offensiveCooldown: number;
  /** Multiplier on how fast tension drifts towards hostilities. */
  tension: number;
  /** Tactical AI decision interval (seconds of battle time). */
  tacticalThink: number;
  /** Whether the tactical AI sends flanking groups. */
  flanking: boolean;
  /** Changes to the rival's starting task force (unit design ids). */
  aiStartForce: { add: string[]; remove: string[] };
}

export const DIFFICULTIES: Record<Difficulty, DifficultyDef> = {
  easy: {
    id: 'easy',
    name: 'Easy',
    description: 'A cautious rival with a slower economy and no tank at the start. Hostilities take longer to break out; its battlefield commanders react slowly and never flank.',
    aiIncome: 0.8,
    aiCaution: 0.35,
    offensiveCooldown: 1.6,
    tension: 0.7,
    tacticalThink: 1.6,
    flanking: false,
    aiStartForce: { add: [], remove: ['mbt'] },
  },
  normal: {
    id: 'normal',
    name: 'Normal',
    description: 'An even match: same economy rules, deliberate attacks, competent battlefield commanders.',
    aiIncome: 1,
    aiCaution: 0,
    offensiveCooldown: 1,
    tension: 1,
    tacticalThink: 1,
    flanking: true,
    aiStartForce: { add: [], remove: [] },
  },
  hard: {
    id: 'hard',
    name: 'Hard',
    description: 'A ruthless rival: a stronger starting force, faster economy, bolder and more frequent offensives, quick tactical reactions.',
    aiIncome: 1.25,
    aiCaution: -0.15,
    offensiveCooldown: 0.7,
    tension: 1.25,
    tacticalThink: 0.75,
    flanking: true,
    aiStartForce: { add: ['mbt', 'rifle_squad'], remove: [] },
  },
};

export const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'normal', 'hard'];

export function difficultyOf(d: string | undefined | null): DifficultyDef {
  return DIFFICULTIES[(d as Difficulty) ?? 'normal'] ?? DIFFICULTIES.normal;
}
