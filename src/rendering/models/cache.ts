import type * as THREE from 'three';
import type { BuildingTypeId, SiteKind } from '../../data/buildings';
import { buildBuildingModel, buildRubble, buildScaffold } from './buildings';
import {
  buildBroadleaf,
  buildBroadleafLow,
  buildConifer,
  buildConiferLow,
  buildCrystals,
  buildJeep,
  buildOilSeep,
  buildRock,
  buildSoldier,
  buildTankHull,
  buildTankTurret,
  buildTruck,
} from './units';

/** Geometry cache: models are generated once per (kind, colour) and shared. */
const cache = new Map<string, THREE.BufferGeometry>();

function get(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = make();
    cache.set(key, g);
  }
  return g;
}

export const Models = {
  soldier: (tint: string) => get(`soldier:${tint}`, () => buildSoldier(tint)),
  jeep: (tint: string) => get(`jeep:${tint}`, () => buildJeep(tint)),
  tankHull: (tint: string) => get(`tankHull:${tint}`, () => buildTankHull(tint)),
  tankTurret: (tint: string) => get(`tankTurret:${tint}`, () => buildTankTurret(tint)),
  truck: (tint: string) => get(`truck:${tint}`, () => buildTruck(tint)),
  building: (typeId: BuildingTypeId, accent: string, siteKind: SiteKind | null) =>
    get(`b:${typeId}:${accent}:${siteKind ?? ''}`, () => buildBuildingModel(typeId, { accent, siteKind })),
  scaffold: (radius: number) => get(`scaffold:${Math.round(radius)}`, () => buildScaffold(radius)),
  rubble: (radius: number, seed: number) => get(`rubble:${Math.round(radius)}:${seed % 4}`, () => buildRubble(radius, (seed % 4) + 1)),
  conifer: () => get('conifer', buildConifer),
  broadleaf: () => get('broadleaf', buildBroadleaf),
  coniferLow: () => get('coniferLow', buildConiferLow),
  broadleafLow: () => get('broadleafLow', buildBroadleafLow),
  rock: () => get('rock', buildRock),
  crystals: () => get('crystals', buildCrystals),
  oilSeep: () => get('oilSeep', buildOilSeep),
};

export function disposeModelCache(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
