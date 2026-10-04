import { describe, expect, it } from 'vitest';
import { makeBuilding, suggestPlacement } from '../src/campaign/construction';
import { designsFor } from '../src/campaign/production';
import { advanceCampaign } from '../src/campaign/sim';
import { addResearchPoints, availableTechs, emptyResearch, researchMultiplier, startResearch, TECHS } from '../src/research/research';
import { STATE_VERSION } from '../src/campaign/types';
import { migrateState } from '../src/persistence/migrations';
import { freshCampaign } from './helpers';

function addLab(c: ReturnType<typeof freshCampaign>, baseId: string): void {
  const base = c.state.bases[baseId];
  const spot = suggestPlacement(c.state, c.world, base, 'research_lab', base.x + 5, base.z)!;
  const lab = makeBuilding(c.state, 'research_lab', base, spot.x, spot.z, 0, null, true);
  c.state.buildings[lab.id] = lab;
}

describe('research', () => {
  it('tracks progress, completes technologies and applies modifiers', () => {
    const r = emptyResearch();
    expect(researchMultiplier(r, 'extraction')).toBe(1);
    expect(availableTechs(r).map((t) => t.id)).toContain('deep_drilling');
    expect(availableTechs(r).map((t) => t.id)).not.toContain('automated_lines'); // needs deep drilling
    expect(startResearch(r, 'automated_lines')).toBe(false);
    expect(startResearch(r, 'deep_drilling')).toBe(true);
    expect(addResearchPoints(r, TECHS.deep_drilling.cost - 1)).toBeNull();
    expect(addResearchPoints(r, 2)?.id).toBe('deep_drilling');
    expect(r.current).toBeNull();
    expect(researchMultiplier(r, 'extraction')).toBeCloseTo(1.25, 6);
    expect(availableTechs(r).map((t) => t.id)).toContain('automated_lines');
  });

  it('keeps progress on a project switched away from', () => {
    const r = emptyResearch();
    startResearch(r, 'hydroponics');
    addResearchPoints(r, 10);
    startResearch(r, 'deep_drilling');
    expect(r.current).toEqual({ techId: 'deep_drilling', progress: 0 });
    expect(r.shelved.hydroponics).toBe(10);
    addResearchPoints(r, 4);
    startResearch(r, 'hydroponics');
    expect(r.current).toEqual({ techId: 'hydroponics', progress: 10 });
    expect(r.shelved).toEqual({ deep_drilling: 4 });
  });

  it('old saves gain an empty shelf (v3 → v4)', () => {
    const c = freshCampaign();
    const raw = JSON.parse(JSON.stringify(c.state));
    raw.version = 3;
    for (const f of Object.values(raw.factions) as { research: Record<string, unknown> }[]) delete f.research.shelved;
    const m = migrateState(raw);
    expect(m.version).toBe(STATE_VERSION);
    for (const f of Object.values(m.factions)) expect(f.research.shelved).toEqual({});
  });

  it('a staffed lab advances the current project over campaign time', () => {
    const c = freshCampaign();
    addLab(c, c.pBase.id);
    const research = c.state.factions[c.player].research;
    expect(startResearch(research, 'hydroponics')).toBe(true);
    advanceCampaign(c, 12);
    expect(research.current?.progress ?? 0).toBeGreaterThan(3);
    advanceCampaign(c, 30);
    expect(research.completed).toContain('hydroponics');
    expect(c.state.log.some((l) => l.text.startsWith('Research complete: Hydroponics II'))).toBe(true);
  });

  it('gates ATGM Teams behind research', () => {
    const c = freshCampaign();
    const barracks = Object.values(c.state.buildings).find((b) => b.baseId === c.pBase.id && b.typeId === 'barracks')!;
    expect(designsFor(barracks, c.state)).not.toContain('atgm_team');
    c.state.factions[c.player].research.completed.push('atgm_teams');
    expect(designsFor(barracks, c.state)).toContain('atgm_team');
  });

  it('the AI picks research projects by itself', () => {
    const c = freshCampaign();
    addLab(c, c.eBase.id);
    advanceCampaign(c, 6);
    const research = c.state.factions[c.enemy].research;
    expect(research.current !== null || research.completed.length > 0).toBe(true);
  });
});
