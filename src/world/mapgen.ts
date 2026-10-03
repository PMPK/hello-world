import type { Vec2 } from '../core/math';
import { dist } from '../core/math';
import { mixSeed, Rng } from '../core/rng';
import type { SiteKind } from '../data/buildings';
import { BIOME, biomeAt, heightAt, inBounds, isWaterAt, slopeAt, type Terrain } from './terrain';

export const BASE_RADIUS = 9;

export interface SiteSpec {
  kind: SiteKind;
  x: number;
  z: number;
  richness: number;
}

export interface WorldLayout {
  /** [player base, enemy base] */
  bases: Vec2[];
  sites: SiteSpec[];
}

/** Minimum distance from (x, z) to water, sampled in rings (capped at maxR). */
export function distanceToWater(t: Terrain, x: number, z: number, maxR = 12): number {
  for (let r = 1; r <= maxR; r += 1) {
    const n = Math.max(8, Math.round(r * 3));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (!inBounds(t, px, pz) || isWaterAt(t, px, pz)) return r;
    }
  }
  return maxR;
}

function flatness(t: Terrain, x: number, z: number, r: number): number {
  let maxH = -Infinity;
  let minH = Infinity;
  for (let k = 0; k < 16; k++) {
    for (const rr of [0.4, 1]) {
      const a = (k / 16) * Math.PI * 2;
      const h = heightAt(t, x + Math.cos(a) * r * rr, z + Math.sin(a) * r * rr);
      maxH = Math.max(maxH, h);
      minH = Math.min(minH, h);
    }
  }
  return maxH - minH;
}

interface Candidate {
  x: number;
  z: number;
  score: number;
}

function baseCandidates(t: Terrain): Candidate[] {
  const out: Candidate[] = [];
  const step = 4;
  for (let z = 20; z <= t.size - 20; z += step) {
    for (let x = 20; x <= t.size - 20; x += step) {
      const h = heightAt(t, x, z);
      if (h < 0.7 || h > 7) continue;
      const b = biomeAt(t, x, z);
      if (b === BIOME.mountains || b === BIOME.snow || b === BIOME.water) continue;
      const wd = distanceToWater(t, x, z, 14);
      if (wd < BASE_RADIUS + 2) continue;
      const fl = flatness(t, x, z, BASE_RADIUS);
      if (fl > 4.5) continue;
      out.push({ x, z, score: -fl * 0.6 + Math.min(wd, 14) * 0.08 });
    }
  }
  return out;
}

function siteTerrainOk(t: Terrain, kind: SiteKind, x: number, z: number, strict: boolean): boolean {
  if (!inBounds(t, x, z, 6)) return false;
  const h = heightAt(t, x, z);
  if (h < 0.6) return false;
  const b = biomeAt(t, x, z);
  if (b === BIOME.water || b === BIOME.snow) return false;
  if (slopeAt(t, x, z) > 1.6) return false;
  if (distanceToWater(t, x, z, 3) < 2.5) return false;
  if (!strict) return b !== BIOME.mountains;
  if (kind === 'minerals') return b === BIOME.hills || b === BIOME.forest || (h > 3 && b !== BIOME.mountains);
  return (b === BIOME.plains || b === BIOME.beach || b === BIOME.forest) && h < 4.5;
}

/**
 * Deterministically place both expedition landing sites and the resource
 * sites. Each base is guaranteed nearby minerals and hydrocarbons so the
 * production chain is always possible.
 */
export function generateLayout(t: Terrain, seed: number): WorldLayout {
  const rng = new Rng(mixSeed(seed, 'layout'));
  const cands = baseCandidates(t);
  if (cands.length < 2) throw new Error('Map generation failed: not enough base sites');

  // Player: south-west-most good site. Enemy: far away, preferably north-east.
  let best: Candidate | null = null;
  let bestS = -Infinity;
  for (const c of cands) {
    const s = (c.z - c.x) / t.size + c.score * 0.05 + rng.range(0, 0.04);
    if (s > bestS) {
      bestS = s;
      best = c;
    }
  }
  const pBase = best!;
  let eBase: Candidate | null = null;
  let eS = -Infinity;
  for (const c of cands) {
    const d = dist(c.x, c.z, pBase.x, pBase.z);
    const s = d / t.size + (c.x - c.z) / t.size * 0.35 + c.score * 0.05 + rng.range(0, 0.03);
    if (s > eS) {
      eS = s;
      eBase = c;
    }
  }
  const bases: Vec2[] = [
    { x: pBase.x, z: pBase.z },
    { x: eBase!.x, z: eBase!.z },
  ];

  const sites: SiteSpec[] = [];
  const minSpacing = 11;
  const farFromAll = (x: number, z: number, spacing: number): boolean => {
    for (const s of sites) if (dist(s.x, s.z, x, z) < spacing) return false;
    for (const b of bases) if (dist(b.x, b.z, x, z) < BASE_RADIUS + 4) return false;
    return true;
  };

  // Guaranteed sites around each base (same count for fairness).
  const nearPlan: SiteKind[] = ['minerals', 'hydrocarbons', 'minerals', 'hydrocarbons'];
  for (const b of bases) {
    for (let k = 0; k < nearPlan.length; k++) {
      const kind = nearPlan[k];
      const minR = k < 2 ? 13 : 20;
      const maxR = k < 2 ? 24 : 34;
      let placed = false;
      for (const strict of [true, false]) {
        for (let attempt = 0; attempt < 220 && !placed; attempt++) {
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(minR, maxR);
          const x = b.x + Math.cos(a) * r;
          const z = b.z + Math.sin(a) * r;
          if (!siteTerrainOk(t, kind, x, z, strict)) continue;
          if (!farFromAll(x, z, minSpacing)) continue;
          sites.push({ kind, x, z, richness: Math.round(rng.range(0.9, 1.15) * 100) / 100 });
          placed = true;
        }
        if (placed) break;
      }
    }
  }

  // Additional contested sites across the continent.
  const extra: SiteKind[] = [];
  for (let k = 0; k < 7; k++) extra.push('minerals');
  for (let k = 0; k < 6; k++) extra.push('hydrocarbons');
  for (const kind of extra) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const x = rng.range(10, t.size - 10);
      const z = rng.range(10, t.size - 10);
      if (!siteTerrainOk(t, kind, x, z, true)) continue;
      if (!farFromAll(x, z, minSpacing + 4)) continue;
      sites.push({ kind, x, z, richness: Math.round(rng.range(1.0, 1.45) * 100) / 100 });
      break;
    }
  }
  return { bases, sites };
}
