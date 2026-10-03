import { clamp, smoothstep } from '../core/math';
import { Noise2D } from '../core/noise';
import { mixSeed, Rng } from '../core/rng';

/**
 * Strategic terrain: a deterministic heightfield + biome map generated from
 * the campaign seed. Pure data (no Three.js) so it can be used by the
 * simulation, pathfinding, battle-map generation and tests.
 *
 * Coordinates: x grows east, z grows south, both in [0, MAP_SIZE].
 * Heights are in map units; sea level is 0.
 */

export const MAP_SIZE = 240;
export const MAP_GRID = 120;
export const SEA_LEVEL = 0;

export const BIOME = {
  water: 0,
  beach: 1,
  plains: 2,
  forest: 3,
  hills: 4,
  mountains: 5,
  snow: 6,
} as const;
export type BiomeId = (typeof BIOME)[keyof typeof BIOME];

export const BIOME_NAMES: Record<BiomeId, string> = {
  0: 'Water',
  1: 'Coast',
  2: 'Plains',
  3: 'Forest',
  4: 'Hills',
  5: 'Mountains',
  6: 'Peaks',
};

export interface Terrain {
  seed: number;
  size: number;
  grid: number;
  cell: number;
  /** (grid+1)^2 vertex heights, row-major (z rows). */
  heights: Float32Array;
  /** grid^2 cell biomes. */
  biomes: Uint8Array;
  /** grid^2 cell moisture in [-1, 1]. */
  moisture: Float32Array;
}

export function generateTerrain(seed: number, grid = MAP_GRID, size = MAP_SIZE): Terrain {
  const nCont = new Noise2D(mixSeed(seed, 'continent'));
  const nDet = new Noise2D(mixSeed(seed, 'detail'));
  const nMtn = new Noise2D(mixSeed(seed, 'mountain'));
  const nMoist = new Noise2D(mixSeed(seed, 'moisture'));
  const rng = new Rng(mixSeed(seed, 'shape'));
  const ox = rng.range(-500, 500);
  const oz = rng.range(-500, 500);
  // A main mountain spine crossing the continent at a random angle and offset.
  const spineAngle = rng.range(0, Math.PI);
  const spineOffset = rng.range(-0.12, 0.12);
  const sdx = Math.cos(spineAngle);
  const sdz = Math.sin(spineAngle);

  const cell = size / grid;
  const verts = grid + 1;
  const heights = new Float32Array(verts * verts);

  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const u = (i * cell) / size - 0.5;
      const v = (j * cell) / size - 0.5;
      // Domain-warped radial falloff makes a single irregular continent.
      const wx = u + nCont.fbm(u * 2.3 + ox, v * 2.3 + oz, 3) * 0.09;
      const wz = v + nCont.fbm(u * 2.3 + oz + 31.7, v * 2.3 + ox - 17.3, 3) * 0.09;
      const r = Math.sqrt(wx * wx + wz * wz) * 2;
      const coastNoise = nCont.fbm(u * 3.1 + ox, v * 3.1 + oz, 4) * 0.22;
      const land = 1 - smoothstep(0.7, 1.04, r + coastNoise);
      let e = land * 1.0 - 0.28 + nDet.fbm(u * 5 + ox, v * 5 + oz, 5) * 0.24;
      // Occasional inland lakes / bays.
      e -= smoothstep(0.66, 0.9, nDet.fbm(u * 3.7 - oz, v * 3.7 + ox, 3) * 0.5 + 0.5) * 0.5;

      let h: number;
      if (e < 0) {
        h = e * 12;
      } else {
        const landT = smoothstep(0, 0.25, e);
        const hillN = nDet.fbm(u * 7 + 13, v * 7 - 7, 4) * 0.5 + 0.5;
        const hills = smoothstep(0.45, 0.8, hillN) * 4.2;
        const ridged = nMtn.ridged(u * 6 + ox, v * 6 + oz, 4);
        // distance to the spine line through the centre
        const ds = Math.abs(u * sdz - v * sdx - spineOffset);
        const spine = 1 - smoothstep(0.02, 0.1, ds + nMtn.fbm(u * 4, v * 4, 3) * 0.05);
        const scattered = smoothstep(0.62, 0.8, nMtn.fbm(u * 2.4 - ox, v * 2.4 + oz, 3) * 0.5 + 0.5);
        const mountainMask = Math.max(spine, scattered * 0.8) * landT;
        h = 0.6 + e * 2.6 + hills * landT + ridged * ridged * mountainMask * 20;
      }
      heights[j * verts + i] = h;
    }
  }

  const biomes = new Uint8Array(grid * grid);
  const moisture = new Float32Array(grid * grid);
  const t: Terrain = { seed, size, grid, cell, heights, biomes, moisture };
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const u = ((i + 0.5) * cell) / size;
      const v = ((j + 0.5) * cell) / size;
      moisture[j * grid + i] = nMoist.fbm(u * 6 + 3.3, v * 6 - 9.1, 4);
    }
  }
  classifyAllBiomes(t);
  return t;
}

function classifyCell(t: Terrain, i: number, j: number): BiomeId {
  const verts = t.grid + 1;
  const h00 = t.heights[j * verts + i];
  const h10 = t.heights[j * verts + i + 1];
  const h01 = t.heights[(j + 1) * verts + i];
  const h11 = t.heights[(j + 1) * verts + i + 1];
  const hc = (h00 + h10 + h01 + h11) / 4;
  const slope = (Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11)) / t.cell;
  const m = t.moisture[j * t.grid + i];
  if (hc < SEA_LEVEL) return BIOME.water;
  if (hc > 14.5) return BIOME.snow;
  if (hc > 9 || slope > 2.0) return BIOME.mountains;
  if (hc < 0.55) return m > 0.25 ? BIOME.plains : BIOME.beach;
  if (hc > 4.8 || slope > 1.1) return m > 0.18 ? BIOME.forest : BIOME.hills;
  return m > 0.14 ? BIOME.forest : BIOME.plains;
}

export function classifyAllBiomes(t: Terrain): void {
  for (let j = 0; j < t.grid; j++) {
    for (let i = 0; i < t.grid; i++) t.biomes[j * t.grid + i] = classifyCell(t, i, j);
  }
}

/** Flatten a circular area (used under bases) and clear vegetation there. */
export function flattenArea(t: Terrain, x: number, z: number, radius: number): void {
  const verts = t.grid + 1;
  const target = Math.max(0.9, averageHeight(t, x, z, radius));
  const outer = radius * 1.6;
  const i0 = Math.max(0, Math.floor((x - outer) / t.cell));
  const i1 = Math.min(t.grid, Math.ceil((x + outer) / t.cell));
  const j0 = Math.max(0, Math.floor((z - outer) / t.cell));
  const j1 = Math.min(t.grid, Math.ceil((z + outer) / t.cell));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i * t.cell - x, j * t.cell - z);
      if (d > outer) continue;
      const k = 1 - smoothstep(radius, outer, d);
      const idx = j * verts + i;
      t.heights[idx] = t.heights[idx] * (1 - k) + target * k;
    }
  }
  for (let j = Math.max(0, j0 - 1); j < Math.min(t.grid, j1 + 1); j++) {
    for (let i = Math.max(0, i0 - 1); i < Math.min(t.grid, i1 + 1); i++) {
      const d = Math.hypot((i + 0.5) * t.cell - x, (j + 0.5) * t.cell - z);
      let b = classifyCell(t, i, j);
      if (d < radius * 1.15 && b !== BIOME.water) b = BIOME.plains;
      t.biomes[j * t.grid + i] = b;
    }
  }
}

export function averageHeight(t: Terrain, x: number, z: number, radius: number): number {
  let sum = 0;
  let n = 0;
  for (let a = 0; a < 12; a++) {
    for (const rr of [0, 0.5, 1]) {
      const ang = (a / 12) * Math.PI * 2;
      sum += heightAt(t, x + Math.cos(ang) * radius * rr, z + Math.sin(ang) * radius * rr);
      n++;
    }
  }
  return sum / n;
}

/** Bilinear height at world position (clamped to the map). */
export function heightAt(t: Terrain, x: number, z: number): number {
  const verts = t.grid + 1;
  const fx = clamp(x / t.cell, 0, t.grid - 1e-4);
  const fz = clamp(z / t.cell, 0, t.grid - 1e-4);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const h00 = t.heights[j * verts + i];
  const h10 = t.heights[j * verts + i + 1];
  const h01 = t.heights[(j + 1) * verts + i];
  const h11 = t.heights[(j + 1) * verts + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

export function cellOf(t: Terrain, x: number, z: number): { i: number; j: number } {
  return {
    i: clamp(Math.floor(x / t.cell), 0, t.grid - 1),
    j: clamp(Math.floor(z / t.cell), 0, t.grid - 1),
  };
}

export function biomeAt(t: Terrain, x: number, z: number): BiomeId {
  const { i, j } = cellOf(t, x, z);
  return t.biomes[j * t.grid + i] as BiomeId;
}

export function isWaterAt(t: Terrain, x: number, z: number): boolean {
  return heightAt(t, x, z) < SEA_LEVEL + 0.05;
}

export function inBounds(t: Terrain, x: number, z: number, margin = 0): boolean {
  return x >= margin && z >= margin && x <= t.size - margin && z <= t.size - margin;
}

/** Approximate slope (height units per map unit) at a position. */
export function slopeAt(t: Terrain, x: number, z: number): number {
  const e = t.cell * 0.5;
  const dx = heightAt(t, x + e, z) - heightAt(t, x - e, z);
  const dz = heightAt(t, x, z + e) - heightAt(t, x, z - e);
  return Math.sqrt(dx * dx + dz * dz) / (2 * e);
}

/** Movement cost multiplier for armies on the strategic map (Infinity = impassable). */
export function strategicCostForBiome(b: BiomeId): number {
  switch (b) {
    case BIOME.water:
      return Infinity;
    case BIOME.snow:
      return 6;
    case BIOME.mountains:
      return 3.2;
    case BIOME.hills:
      return 1.6;
    case BIOME.forest:
      return 1.55;
    case BIOME.beach:
      return 1.1;
    default:
      return 1;
  }
}
