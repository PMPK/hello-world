import { clamp, dist, type Vec2 } from '../core/math';
import { astar, nearestPassable, smoothCellPath, type GridGraph } from './pathfinding';
import {
  BIOME,
  cellOf,
  flattenArea,
  generateTerrain,
  slopeAt,
  strategicCostForBiome,
  type BiomeId,
  type Terrain,
} from './terrain';
import { BASE_RADIUS } from './mapgen';

export const ROAD_COST = 0.55;

export interface RoadLike {
  points: Vec2[];
}

/**
 * Runtime world: terrain + derived navigation data. Not saved; it is rebuilt
 * deterministically from the seed (plus base positions for flattening and
 * the saved road polylines).
 */
export class World {
  readonly terrain: Terrain;
  readonly roadMask: Uint8Array;
  private readonly armyGraph: GridGraph;
  private readonly roadGraph: GridGraph;

  constructor(seed: number, basePositions: Vec2[], roads: RoadLike[] = []) {
    this.terrain = generateTerrain(seed);
    for (const b of basePositions) flattenArea(this.terrain, b.x, b.z, BASE_RADIUS);
    const t = this.terrain;
    this.roadMask = new Uint8Array(t.grid * t.grid);
    for (const r of roads) this.addRoad(r.points);

    this.armyGraph = {
      w: t.grid,
      h: t.grid,
      cost: (i, j) => {
        if (this.roadMask[j * t.grid + i]) return ROAD_COST;
        return strategicCostForBiome(t.biomes[j * t.grid + i] as BiomeId);
      },
    };
    this.roadGraph = {
      w: t.grid,
      h: t.grid,
      cost: (i, j) => {
        const b = t.biomes[j * t.grid + i] as BiomeId;
        if (b === BIOME.water || b === BIOME.snow) return Infinity;
        if (this.roadMask[j * t.grid + i]) return 0.6;
        const s = slopeAt(t, (i + 0.5) * t.cell, (j + 0.5) * t.cell);
        const base = b === BIOME.mountains ? 6 : b === BIOME.forest ? 1.6 : b === BIOME.hills ? 1.4 : 1;
        return base + s * 2.5;
      },
    };
  }

  /** Rasterise a road polyline into the road mask. */
  addRoad(points: Vec2[]): void {
    const t = this.terrain;
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1];
      const b = points[k];
      const len = dist(a.x, a.z, b.x, b.z);
      const steps = Math.max(1, Math.ceil(len / (t.cell * 0.5)));
      for (let s = 0; s <= steps; s++) {
        const x = a.x + ((b.x - a.x) * s) / steps;
        const z = a.z + ((b.z - a.z) * s) / steps;
        const c = cellOf(t, x, z);
        this.roadMask[c.j * t.grid + c.i] = 1;
      }
    }
  }

  rebuildRoads(roads: RoadLike[]): void {
    this.roadMask.fill(0);
    for (const r of roads) this.addRoad(r.points);
  }

  /** Army speed multiplier from terrain at a position (roads fast, hills slow). */
  speedFactorAt(x: number, z: number): number {
    const t = this.terrain;
    const c = cellOf(t, x, z);
    const cost = this.armyGraph.cost(c.i, c.j);
    if (!Number.isFinite(cost)) return 0.5; // stranded on water edge: crawl out
    return clamp(1 / cost, 0.15, 1.9);
  }

  isPassable(x: number, z: number): boolean {
    const c = cellOf(this.terrain, x, z);
    return Number.isFinite(this.armyGraph.cost(c.i, c.j));
  }

  /** Strategic path for armies. Returns world-space waypoints (excluding start). */
  findArmyPath(from: Vec2, to: Vec2): Vec2[] | null {
    return this.findPath(this.armyGraph, from, to, ROAD_COST);
  }

  /** Path suitable for building a road between two points. */
  findRoadPath(from: Vec2, to: Vec2): Vec2[] | null {
    return this.findPath(this.roadGraph, from, to, 0.6, 1.0);
  }

  private findPath(g: GridGraph, from: Vec2, to: Vec2, minCost: number, tolerance = 1.08): Vec2[] | null {
    const t = this.terrain;
    const s = cellOf(t, from.x, from.z);
    const e = cellOf(t, to.x, to.z);
    const sp = nearestPassable(g, s.i, s.j, 6);
    const ep = nearestPassable(g, e.i, e.j, 12);
    if (!sp || !ep) return null;
    const cells = astar(g, sp.i, sp.j, ep.i, ep.j, minCost);
    if (!cells) return null;
    const smooth = smoothCellPath(g, cells, tolerance);
    const pts: Vec2[] = smooth.slice(1).map((c) => ({
      x: ((c % t.grid) + 0.5) * t.cell,
      z: (Math.floor(c / t.grid) + 0.5) * t.cell,
    }));
    // End exactly at the requested target when it is passable.
    const endPassable = ep.i === e.i && ep.j === e.j;
    if (endPassable) {
      if (pts.length === 0) pts.push({ x: to.x, z: to.z });
      else pts[pts.length - 1] = { x: to.x, z: to.z };
    } else if (pts.length === 0) {
      pts.push({ x: (ep.i + 0.5) * t.cell, z: (ep.j + 0.5) * t.cell });
    }
    return pts;
  }
}
