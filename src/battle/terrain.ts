import { clamp, smoothstep } from '../core/math';
import { Noise2D } from '../core/noise';
import { mixSeed } from '../core/rng';
import { BUILDINGS } from '../data/buildings';
import { BIOME, biomeAt, heightAt, type Terrain } from '../world/terrain';
import {
  BATTLE_GRID,
  BATTLE_HEIGHT_SCALE,
  BATTLE_POS_SCALE,
  BATTLE_SIZE,
  type BattleBuildingSpec,
} from './types';

/**
 * Tactical terrain is derived from the strategic map around the battle
 * location: hills, forests, coasts and water come from the campaign terrain,
 * with extra local detail added by noise. Buildings get flattened pads.
 */
export interface BattleTerrain {
  size: number;
  grid: number;
  cell: number;
  /** (grid+1)^2 vertex heights in metres. */
  heights: Float32Array;
  /** grid^2 forest density 0..255. */
  forest: Uint8Array;
  /** grid^2: 1 = water. */
  water: Uint8Array;
  /** grid^2: 1 = impassable (water, buildings, cliffs). */
  blocked: Uint8Array;
  /** Strategic biome per cell (for colouring). */
  biome: Uint8Array;
}

/** Convert campaign coordinates to battle metres for a battle centred at (cx, cz). */
export function campaignToBattle(cx: number, cz: number, x: number, z: number): { x: number; z: number } {
  return { x: BATTLE_SIZE / 2 + (x - cx) * BATTLE_POS_SCALE, z: BATTLE_SIZE / 2 + (z - cz) * BATTLE_POS_SCALE };
}

export function createBattleTerrain(
  strategic: Terrain,
  cx: number,
  cz: number,
  seed: number,
  buildings: BattleBuildingSpec[],
): BattleTerrain {
  const grid = BATTLE_GRID;
  const size = BATTLE_SIZE;
  const cell = size / grid;
  const verts = grid + 1;
  const heights = new Float32Array(verts * verts);
  const noise = new Noise2D(mixSeed(seed, 'battle-terrain'));
  const noise2 = new Noise2D(mixSeed(seed, 'battle-forest'));

  const toCampaign = (bx: number, bz: number): { x: number; z: number } => ({
    x: cx + (bx - size / 2) / BATTLE_POS_SCALE,
    z: cz + (bz - size / 2) / BATTLE_POS_SCALE,
  });

  for (let j = 0; j < verts; j++) {
    for (let i = 0; i < verts; i++) {
      const bx = i * cell;
      const bz = j * cell;
      const c = toCampaign(bx, bz);
      const hs = heightAt(strategic, c.x, c.z);
      const land = smoothstep(-0.5, 0.6, hs);
      const detail = noise.fbm(bx / 140, bz / 140, 3) * 5 + noise.fbm(bx / 38, bz / 38, 2) * 1.4;
      heights[j * verts + i] = hs * BATTLE_HEIGHT_SCALE + detail * (0.25 + 0.75 * land);
    }
  }

  const n = grid * grid;
  const forest = new Uint8Array(n);
  const water = new Uint8Array(n);
  const blocked = new Uint8Array(n);
  const biome = new Uint8Array(n);

  // Flatten pads under buildings (before classifying cells).
  for (const b of buildings) {
    const r = BUILDINGS[b.typeId].battleFootprint + 8;
    let sum = 0;
    let cnt = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      sum += sampleHeight(heights, grid, cell, b.x + Math.cos(ang) * r * 0.6, b.z + Math.sin(ang) * r * 0.6);
      cnt++;
    }
    const target = Math.max(1.2, sum / cnt);
    const outer = r * 1.8;
    const i0 = Math.max(0, Math.floor((b.x - outer) / cell));
    const i1 = Math.min(grid, Math.ceil((b.x + outer) / cell));
    const j0 = Math.max(0, Math.floor((b.z - outer) / cell));
    const j1 = Math.min(grid, Math.ceil((b.z + outer) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * cell - b.x, j * cell - b.z);
        const k = 1 - smoothstep(r, outer, d);
        if (k <= 0) continue;
        const idx = j * verts + i;
        heights[idx] = heights[idx] * (1 - k) + target * k;
      }
    }
  }

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const idx = j * grid + i;
      const bx = (i + 0.5) * cell;
      const bz = (j + 0.5) * cell;
      const c = toCampaign(bx, bz);
      const sb = biomeAt(strategic, c.x, c.z);
      biome[idx] = sb;
      const h = sampleHeight(heights, grid, cell, bx, bz);
      if (h < 0) {
        water[idx] = 1;
        blocked[idx] = 1;
        continue;
      }
      // cliffs
      const h00 = heights[j * verts + i];
      const h11 = heights[(j + 1) * verts + i + 1];
      const h10 = heights[j * verts + i + 1];
      const h01 = heights[(j + 1) * verts + i];
      const slope = (Math.max(h00, h10, h01, h11) - Math.min(h00, h10, h01, h11)) / cell;
      if (slope > 1.05) blocked[idx] = 1;
      let density =
        sb === BIOME.forest ? 0.72 : sb === BIOME.hills ? 0.2 : sb === BIOME.plains ? 0.08 : sb === BIOME.mountains ? 0.12 : 0.02;
      density += noise2.fbm(bx / 90, bz / 90, 3) * 0.45 + noise2.noise(bx / 23, bz / 23) * 0.12;
      if (density > 0.52 && h > 0.6) forest[idx] = clamp(Math.round((density - 0.52) * 400 + 90), 90, 255);
    }
  }

  // Clear forests around and block the footprint of structures.
  for (const b of buildings) {
    const fp = BUILDINGS[b.typeId].battleFootprint;
    const clearR = fp + 16;
    const i0 = Math.max(0, Math.floor((b.x - clearR) / cell));
    const i1 = Math.min(grid - 1, Math.ceil((b.x + clearR) / cell));
    const j0 = Math.max(0, Math.floor((b.z - clearR) / cell));
    const j1 = Math.min(grid - 1, Math.ceil((b.z + clearR) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot((i + 0.5) * cell - b.x, (j + 0.5) * cell - b.z);
        const idx = j * grid + i;
        if (d < clearR) forest[idx] = 0;
        if (d < fp * 0.8 && b.state !== 'destroyed') blocked[idx] = 1;
      }
    }
  }

  return { size, grid, cell, heights, forest, water, blocked, biome };
}

function sampleHeight(heights: Float32Array, grid: number, cell: number, x: number, z: number): number {
  const verts = grid + 1;
  const fx = clamp(x / cell, 0, grid - 1e-4);
  const fz = clamp(z / cell, 0, grid - 1e-4);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const h00 = heights[j * verts + i];
  const h10 = heights[j * verts + i + 1];
  const h01 = heights[(j + 1) * verts + i];
  const h11 = heights[(j + 1) * verts + i + 1];
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

export function bHeight(t: BattleTerrain, x: number, z: number): number {
  return sampleHeight(t.heights, t.grid, t.cell, x, z);
}

export function bCell(t: BattleTerrain, x: number, z: number): number {
  const i = clamp(Math.floor(x / t.cell), 0, t.grid - 1);
  const j = clamp(Math.floor(z / t.cell), 0, t.grid - 1);
  return j * t.grid + i;
}

export function bForest(t: BattleTerrain, x: number, z: number): number {
  return t.forest[bCell(t, x, z)] / 255;
}

export function bBlocked(t: BattleTerrain, x: number, z: number): boolean {
  if (x < 2 || z < 2 || x > t.size - 2 || z > t.size - 2) return true;
  return t.blocked[bCell(t, x, z)] === 1;
}

export function bSlope(t: BattleTerrain, x: number, z: number): number {
  const e = t.cell * 0.5;
  const dx = bHeight(t, x + e, z) - bHeight(t, x - e, z);
  const dz = bHeight(t, x, z + e) - bHeight(t, x, z - e);
  return Math.sqrt(dx * dx + dz * dz) / (2 * e);
}

/** Terrain line-of-sight between two points with eye heights. */
export function bLineOfSight(t: BattleTerrain, ax: number, az: number, ah: number, bx: number, bz: number, bh: number): boolean {
  const ya = bHeight(t, ax, az) + ah;
  const yb = bHeight(t, bx, bz) + bh;
  const d = Math.hypot(bx - ax, bz - az);
  const steps = Math.min(14, Math.max(3, Math.ceil(d / 30)));
  for (let s = 1; s < steps; s++) {
    const f = s / steps;
    const x = ax + (bx - ax) * f;
    const z = az + (bz - az) * f;
    const ground = bHeight(t, x, z);
    const ray = ya + (yb - ya) * f;
    if (ground > ray + 0.5) return false;
  }
  return true;
}
