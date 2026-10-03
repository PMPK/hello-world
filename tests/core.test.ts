import { describe, expect, it } from 'vitest';
import { hashString, mixSeed, Rng } from '../src/core/rng';
import { campaignDay, formatCampaignTime, formatDuration } from '../src/core/time';
import { generateTerrain, heightAt, BIOME, MAP_GRID } from '../src/world/terrain';
import { generateLayout, BASE_RADIUS } from '../src/world/mapgen';
import { dist } from '../src/core/math';

describe('rng', () => {
  it('is deterministic for a seed and restorable from state', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    const c = new Rng(1);
    c.next();
    const saved = c.state;
    const next = c.next();
    const d = new Rng(0);
    d.state = saved;
    expect(d.next()).toBe(next);
  });

  it('produces values in range', () => {
    const r = new Rng(9);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 7);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(7);
    }
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(mixSeed(1, 'x')).not.toBe(mixSeed(2, 'x'));
  });
});

describe('time', () => {
  it('formats campaign time from the year 2000 start', () => {
    expect(formatCampaignTime(0)).toContain('2000');
    expect(campaignDay(0)).toBe(1);
    expect(campaignDay(24)).toBe(2);
    expect(formatDuration(1.5)).toBe('1h 30m');
  });
});

describe('terrain & layout', () => {
  it('generates the same terrain for the same seed', () => {
    const a = generateTerrain(77);
    const b = generateTerrain(77);
    expect(a.heights.length).toBe((MAP_GRID + 1) ** 2);
    expect(Array.from(a.heights.slice(0, 500))).toEqual(Array.from(b.heights.slice(0, 500)));
    const c = generateTerrain(78);
    expect(Array.from(c.heights.slice(4000, 4100))).not.toEqual(Array.from(a.heights.slice(4000, 4100)));
  });

  it('has a mix of land and water and places bases on land far apart', () => {
    for (const seed of [1, 2, 3, 4242, 999]) {
      const t = generateTerrain(seed);
      let water = 0;
      let forest = 0;
      for (const b of t.biomes) {
        if (b === BIOME.water) water++;
        if (b === BIOME.forest) forest++;
      }
      const frac = water / t.biomes.length;
      expect(frac).toBeGreaterThan(0.15);
      expect(frac).toBeLessThan(0.7);
      expect(forest).toBeGreaterThan(100);
      const layout = generateLayout(t, seed);
      expect(layout.bases.length).toBe(2);
      for (const b of layout.bases) expect(heightAt(t, b.x, b.z)).toBeGreaterThan(0);
      expect(dist(layout.bases[0].x, layout.bases[0].z, layout.bases[1].x, layout.bases[1].z)).toBeGreaterThan(90);
      const near = (i: number, kind: string) =>
        layout.sites.filter((s) => s.kind === kind && dist(s.x, s.z, layout.bases[i].x, layout.bases[i].z) < 40).length;
      for (const i of [0, 1]) {
        expect(near(i, 'minerals')).toBeGreaterThanOrEqual(1);
        expect(near(i, 'hydrocarbons')).toBeGreaterThanOrEqual(1);
      }
      for (const s of layout.sites) {
        for (const b of layout.bases) expect(dist(s.x, s.z, b.x, b.z)).toBeGreaterThan(BASE_RADIUS);
      }
    }
  });
});
