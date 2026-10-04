import * as THREE from 'three';
import type { BuildingTypeId, SiteKind } from '../../data/buildings';
import { ModelBuilder } from './builder';

/**
 * Original low-poly expedition structures (metres, origin at ground centre).
 * The same geometry is used on the campaign map (scaled down) and in
 * tactical battles (full scale) so players recognise their base.
 */

const CONCRETE = 0x9b988f;
const CONCRETE_D = 0x7c7a73;
const PAD = 0x6d6a60;
const METAL = 0x8a8f94;
const METAL_D = 0x585d62;
const DARK = 0x2a2c2e;
const WINDOW = 0x2a3843;
const WHITE = 0xd6d6cf;
const RUST = 0x8a5a3c;
const SAND = 0x9a8862;
const GREENHOUSE = 0x9cc9a8;
const ROCK = 0x6e6b63;
const OLIVE = 0x5c6648;
const OLIVE_D = 0x46503a;
const EARTH = 0x6f6248;

export interface BuildingModelOpts {
  accent: THREE.ColorRepresentation;
  siteKind?: SiteKind | null;
  /** Leave out the traversing gun (rendered separately in battles). */
  noTurret?: boolean;
}

function hq(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(42, 0.4, 32, PAD);
  b.box(24, 8, 16, CONCRETE, { y: 0.4 });
  b.box(24.3, 1.3, 16.3, WINDOW, { y: 4.2 });
  b.box(24.4, 0.7, 16.4, accent, { y: 7.9 });
  b.box(14, 5, 10, 0xa9a69c, { x: -3, y: 8.4 });
  b.box(14.3, 1.0, 10.3, WINDOW, { x: -3, y: 10.6 });
  b.sphere(2.4, WHITE, { x: -6, y: 15.2 }, 1); // radome
  b.cyl(0.35, 0.45, 26, 5, METAL, { x: 8, y: 8.4, z: 4 }); // comms mast
  for (const h of [14, 20, 26]) b.box(3.2, 0.25, 0.25, METAL, { x: 8, y: 8.4 + h - 6, z: 4 });
  b.cone(2.4, 1.0, 10, WHITE, { x: 8, y: 21, z: 4, rx: Math.PI * 0.75 }); // dish
  // expedition landing module
  b.cyl(4.6, 4.8, 9, 10, WHITE, { x: 14, y: 0.4, z: -10 });
  b.cyl(4.62, 4.62, 1.2, 10, accent, { x: 14, y: 6.2, z: -10 });
  b.cone(4.6, 3.6, 10, 0xc9c9c0, { x: 14, y: 9.4, z: -10 });
  for (const a of [0, 2.1, 4.2]) {
    b.box(0.5, 3.5, 0.5, METAL_D, { x: 14 + Math.cos(a) * 5.4, y: 0, z: -10 + Math.sin(a) * 5.4, rz: Math.cos(a) * 0.3, rx: -Math.sin(a) * 0.3 });
  }
  // flag
  b.cyl(0.15, 0.15, 12, 5, METAL, { x: -15, y: 0.4, z: 12 });
  b.box(0.15, 2.2, 3.6, accent, { x: -15, y: 10.2, z: 13.9 });
  // generator & solar
  b.box(5, 2.6, 3, METAL_D, { x: -15, y: 0.4, z: -10 });
  for (let k = 0; k < 3; k++) b.box(5, 0.2, 3, 0x22344a, { x: 2 + k * 5.5, y: 2.2, z: 13, rx: -0.5 });
}

function habitat(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(28, 0.35, 22, PAD);
  b.dome(6.5, 10, WHITE, { y: 0.35 });
  b.cyl(6.6, 6.6, 0.8, 10, accent, { y: 0.35 });
  for (const [x, z, ry] of [
    [9, 3, 0.3],
    [-8, 5, -0.4],
  ] as const) {
    b.tube(2.6, 11, 9, WHITE, { x, y: 3.0, z, ry });
    b.tube(2.65, 0.8, 9, accent, { x: x + Math.cos(ry) * 4.8, y: 3.0, z: z - Math.sin(ry) * 4.8, ry });
    b.box(1.2, 2.0, 1.2, METAL_D, { x: x - 3, y: 0.35, z });
    b.box(1.2, 2.0, 1.2, METAL_D, { x: x + 3, y: 0.35, z });
  }
  b.box(2.6, 2.6, 6, METAL, { x: 3, y: 0.35, z: -6 }); // airlock tunnel
  b.box(1.8, 2.2, 0.2, WINDOW, { x: 3, y: 0.6, z: -9.05 });
}

function powerPlant(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(30, 0.35, 24, PAD);
  b.box(18, 7, 12, CONCRETE, { y: 0.35 });
  b.box(18.2, 0.6, 12.2, accent, { y: 7.0 });
  b.box(6, 3, 12, METAL_D, { x: 12, y: 0.35 }); // turbine hall annex
  b.cyl(1.0, 1.5, 22, 8, CONCRETE_D, { x: -5, y: 7.35, z: 2 });
  b.cyl(1.0, 1.5, 22, 8, CONCRETE_D, { x: -1, y: 7.35, z: 2 });
  b.cyl(1.05, 1.05, 1, 8, 0xb0402a, { x: -5, y: 28.5, z: 2 });
  b.cyl(1.05, 1.05, 1, 8, 0xb0402a, { x: -1, y: 28.5, z: 2 });
  for (let k = 0; k < 3; k++) b.box(2.4, 3.2, 2.4, METAL, { x: -8 + k * 4, y: 0.35, z: -9 }); // transformers
  b.box(0.3, 9, 0.3, METAL_D, { x: 10, y: 0.35, z: -9 });
  b.box(6, 0.3, 0.3, METAL_D, { x: 10, y: 9, z: -9 });
}

function mine(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(24, 0.3, 20, PAD);
  // headframe tower
  for (const [x, z] of [
    [-2, -2],
    [2, -2],
    [-2, 2],
    [2, 2],
  ] as const) b.box(0.6, 16, 0.6, RUST, { x, y: 0.3, z, rx: z * -0.035, rz: x * 0.035 });
  for (const h of [5, 10, 15]) b.box(4.6, 0.4, 4.6, RUST, { y: h });
  b.cyl(1.6, 1.6, 0.5, 10, METAL_D, { y: 16.5, rz: Math.PI / 2 }); // sheave wheel
  b.box(8, 5, 6, METAL, { x: 7, y: 0.3, z: 3 }); // hoist house
  b.box(8.2, 0.5, 6.2, accent, { x: 7, y: 5.2, z: 3 });
  b.cone(5, 4, 8, ROCK, { x: -6, y: 0.3, z: 5 }); // ore pile
  b.box(1.2, 0.5, 11, METAL_D, { x: -3, y: 4, z: 0, rx: 0.5 }); // conveyor
}

function oilWell(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(24, 0.3, 20, PAD);
  b.box(3, 1.2, 8, METAL_D, { y: 0.3 }); // pumpjack base
  b.box(0.5, 6, 0.5, accent, { x: -0.9, y: 0.6, rz: 0.12 });
  b.box(0.5, 6, 0.5, accent, { x: 0.9, y: 0.6, rz: -0.12 });
  b.box(0.8, 0.8, 9, accent, { y: 6.4, rx: 0.12 }); // walking beam
  b.box(1.0, 2.6, 1.2, accent, { y: 5.1, z: 4.6 }); // horse head
  b.box(1.6, 1.6, 2, DARK, { y: 1.2, z: -3 }); // counterweight
  b.cyl(2.3, 2.3, 4.5, 10, WHITE, { x: -7, y: 0.3, z: 4 });
  b.cyl(2.3, 2.3, 4.5, 10, WHITE, { x: -7, y: 0.3, z: -2 });
  b.cyl(2.35, 2.35, 0.5, 10, accent, { x: -7, y: 3.6, z: 4 });
  b.tube(0.25, 6, 6, METAL_D, { x: -3.5, y: 1, z: 1 });
}

function farm(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(30, 0.3, 26, 0x5e6648);
  for (let k = 0; k < 3; k++) {
    const z = -8 + k * 8;
    b.add(new THREE.CylinderGeometry(3.4, 3.4, 18, 10, 1, false, 0, Math.PI), GREENHOUSE, { y: 0.3, z, rz: Math.PI / 2, ry: 0 });
    b.box(18.2, 0.5, 6.9, accent, { y: 0.3, z });
  }
  b.cyl(1.8, 1.8, 5, 8, WHITE, { x: 11.5, y: 0.3, z: -9 }); // water tank
  b.box(4, 3, 4, METAL, { x: 11.5, y: 0.3, z: 6 });
}

function refinery(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(32, 0.35, 26, PAD);
  b.cyl(1.7, 1.9, 19, 10, METAL, { x: -6, y: 0.35, z: -3 });
  b.cyl(1.3, 1.5, 15, 10, METAL, { x: -2, y: 0.35, z: -5 });
  for (const h of [6, 12]) b.cyl(1.95, 1.95, 0.5, 10, accent, { x: -6, y: h, z: -3 });
  b.sphere(3.2, WHITE, { x: 7, y: 3.6, z: 5 }, 1);
  b.sphere(3.2, WHITE, { x: 7, y: 3.6, z: -4 }, 1);
  for (const z of [5, -4]) {
    for (const sx of [-1, 1]) b.box(0.4, 2.2, 0.4, METAL_D, { x: 7 + sx * 2, y: 0.35, z });
  }
  b.tube(0.4, 16, 6, METAL_D, { x: 0, y: 4, z: 1 });
  b.tube(0.4, 16, 6, METAL_D, { x: 0, y: 5, z: 2 });
  b.box(0.4, 5, 0.4, METAL_D, { x: -7, y: 0.35, z: 1.5 });
  b.box(0.4, 5, 0.4, METAL_D, { x: 7, y: 0.35, z: 1.5 });
  b.cyl(0.35, 0.45, 24, 6, METAL_D, { x: 12, y: 0.35, z: -10 }); // flare stack
  b.cone(0.6, 1.8, 6, 0xf08a2c, { x: 12, y: 24.3, z: -10 });
  b.box(8, 4, 5, CONCRETE, { x: -8, y: 0.35, z: 8 }); // control room
  b.box(8.2, 0.5, 5.2, accent, { x: -8, y: 4.2, z: 8 });
}

function factory(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(36, 0.35, 28, PAD);
  b.box(26, 7, 16, CONCRETE, { y: 0.35 });
  // sawtooth roof
  for (let k = 0; k < 5; k++) {
    b.prism(
      [
        [0, 0],
        [5.2, 0],
        [0, 3],
      ],
      16,
      k % 2 === 0 ? 0x8f949a : 0x9aa0a5,
      { x: -13 + k * 5.2, y: 7.35 },
    );
    b.box(0.15, 2.8, 15.6, 0x3a4a56, { x: -13 + k * 5.2 + 0.1, y: 7.4 }); // north lights
  }
  b.box(26.2, 0.8, 16.2, accent, { y: 6.6 });
  b.box(6, 5, 0.3, DARK, { x: -6, y: 0.35, z: 8.1 }); // loading doors
  b.box(6, 5, 0.3, DARK, { x: 4, y: 0.35, z: 8.1 });
  b.cyl(0.9, 1.2, 16, 8, CONCRETE_D, { x: 10, y: 0.35, z: -6 });
  b.box(5, 2.5, 3, METAL_D, { x: 15, y: 0.35, z: 6 });
}

function barracks(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(32, 0.3, 26, PAD);
  for (const z of [-6, 6]) {
    b.box(20, 4, 7, 0x8b8a70, { y: 0.3, z });
    b.prism(
      [
        [-3.8, 0],
        [3.8, 0],
        [0, 1.8],
      ],
      20.4,
      0x5e6a52,
      { y: 4.3, z, ry: Math.PI / 2 },
    );
    b.box(20.2, 0.5, 7.2, accent, { y: 3.6, z });
  }
  // sandbag ring
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    b.box(4.5, 1.1, 1.2, SAND, { x: Math.cos(a) * 14, y: 0.3, z: Math.sin(a) * 11.5, ry: -a + Math.PI / 2 });
  }
  // watchtower
  for (const [x, z] of [
    [12, -9],
    [14.5, -9],
    [12, -11.5],
    [14.5, -11.5],
  ] as const) b.box(0.35, 8, 0.35, 0x6b5a40, { x, y: 0.3, z });
  b.box(3.6, 0.4, 3.6, 0x6b5a40, { x: 13.25, y: 8.3, z: -10.25 });
  b.box(3.8, 1.2, 3.8, SAND, { x: 13.25, y: 8.7, z: -10.25 });
  b.cyl(0.12, 0.12, 10, 5, METAL, { x: -12, y: 0.3, z: 0 });
  b.box(0.12, 1.6, 2.6, accent, { x: -12, y: 8.6, z: 1.3 });
}

function vehicleDepot(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(44, 0.35, 34, PAD);
  b.add(new THREE.CylinderGeometry(9, 9, 26, 12, 1, false, -Math.PI / 2, Math.PI), METAL, { y: 0.35, rx: Math.PI / 2, z: -2 });
  b.box(13, 8, 0.4, DARK, { y: 0.35, z: 11.1 }); // hangar door
  b.box(18.2, 0.8, 0.5, accent, { y: 8.6, z: 11.1 });
  b.box(18.2, 0.8, 0.5, accent, { y: 8.6, z: -15.1 });
  b.box(18, 0.2, 10, 0x7f7c73, { y: 0.4, z: 16 }); // apron
  // gantry crane
  b.box(0.6, 10, 0.6, 0xc8a02e, { x: -16, y: 0.35, z: 6 });
  b.box(0.6, 10, 0.6, 0xc8a02e, { x: -16, y: 0.35, z: 16 });
  b.box(0.8, 0.8, 11, 0xc8a02e, { x: -16, y: 10.3, z: 11 });
  // fuel tanks
  b.tube(1.6, 7, 10, WHITE, { x: 15, y: 1.9, z: -8 });
  b.tube(1.6, 7, 10, WHITE, { x: 15, y: 1.9, z: -3.5 });
}

function researchLab(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(28, 0.3, 22, PAD);
  // main lab block with a clean-room annex
  b.box(16, 5, 10, WHITE, { x: -3, y: 0.3 });
  b.box(16.3, 0.9, 10.3, WINDOW, { x: -3, y: 2.9 });
  b.box(16.4, 0.5, 10.4, accent, { x: -3, y: 5.2 });
  b.box(7, 3.5, 7, 0xb9bdb8, { x: 8, y: 0.3, z: 2 });
  // observatory dome on the roof
  b.cyl(3.2, 3.2, 1.2, 12, CONCRETE, { x: -6, y: 5.3 });
  b.dome(3.1, 12, 0xdfe3e6, { x: -6, y: 6.5 });
  b.box(0.8, 2.2, 3.4, DARK, { x: -6, y: 7.2, z: 1.2, rx: -0.5 });
  // sensor mast and dish
  b.cyl(0.2, 0.28, 12, 5, METAL, { x: 3, y: 5.3, z: -3 });
  b.cone(1.8, 0.8, 10, WHITE, { x: 3, y: 15.5, z: -3, rx: Math.PI * 0.7 });
  // sample silos and solar field
  for (const z of [-7, -4]) b.cyl(1.1, 1.1, 4.5, 8, METAL_D, { x: 11, y: 0.3, z });
  for (let k = 0; k < 3; k++) b.box(5, 0.2, 3, 0x22344a, { x: -10 + k * 5.5, y: 1.6, z: 8.5, rx: -0.5 });
}

function bunker(b: ModelBuilder, accent: THREE.ColorRepresentation): void {
  b.box(13, 0.25, 11, EARTH);
  // earth berm around the casemate
  b.prism(
    [
      [-6, 0],
      [6, 0],
      [4.6, 1.9],
      [-4.6, 1.9],
    ],
    9,
    EARTH,
    { y: 0.25 },
  );
  b.box(8, 2.6, 6.4, CONCRETE, { y: 0.25 });
  b.box(8.6, 0.55, 7, CONCRETE_D, { y: 2.85 });
  b.box(8.7, 0.25, 7.1, accent, { y: 3.4 });
  // firing slit and twin MG barrels facing +z
  b.box(5.2, 0.55, 0.3, DARK, { y: 1.55, z: 3.15 });
  for (const x of [-0.7, 0.7]) b.tube(0.07, 1.3, 5, METAL_D, { x, y: 1.8, z: 3.75, ry: Math.PI / 2 });
  // camouflage net and periscope
  b.box(5, 0.12, 4, OLIVE, { y: 3.65, x: -1, rz: 0.04 });
  b.cyl(0.12, 0.12, 0.9, 5, METAL, { x: 2.5, y: 3.65, z: -1.5 });
  // rear entrance with sandbags
  b.box(1.4, 1.9, 0.3, DARK, { y: 0.25, z: -3.25 });
  for (const x of [-1.6, 1.6]) b.box(1.4, 0.9, 0.8, SAND, { x, y: 0.25, z: -4 });
}

function atGun(b: ModelBuilder): void {
  // facing +z, pivot at the origin
  for (const x of [-1, 1]) b.cyl(0.45, 0.45, 0.28, 8, DARK, { x, y: 0.45, z: -0.1, rz: Math.PI / 2 });
  b.box(2.1, 0.25, 0.5, OLIVE_D, { y: 0.35, z: -0.1 });
  b.box(0.2, 0.2, 2.8, OLIVE_D, { x: -0.55, y: 0.18, z: -1.6, ry: -0.22 });
  b.box(0.2, 0.2, 2.8, OLIVE_D, { x: 0.55, y: 0.18, z: -1.6, ry: 0.22 });
  b.box(2.5, 1.35, 0.12, OLIVE, { y: 0.55, z: 0.45, rx: -0.12 });
  b.box(0.55, 0.5, 1.9, OLIVE_D, { y: 0.9, z: 0.1 });
  b.tube(0.11, 4.4, 6, METAL_D, { y: 1.15, z: 2.9, ry: Math.PI / 2 });
  b.box(0.34, 0.28, 0.45, METAL_D, { y: 1.01, z: 5.1 });
}

function atEmplacement(b: ModelBuilder, accent: THREE.ColorRepresentation, withGun: boolean): void {
  b.box(11, 0.22, 11, EARTH);
  // sandbag ring, open at the rear
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    if (Math.abs(Math.sin(a) + 1) < 0.35) continue; // gap toward -z
    b.box(2.4, 0.95, 1, k % 2 ? SAND : 0x8d7c58, { x: Math.cos(a) * 4.3, y: 0.22, z: Math.sin(a) * 4.3, ry: -a + Math.PI / 2 });
  }
  // ready-ammunition crates and a marker pole
  for (const [x, z] of [
    [-2.4, -2.8],
    [-1.6, -3.1],
  ] as const) b.box(0.8, 0.45, 0.5, OLIVE, { x, y: 0.22, z });
  b.cyl(0.07, 0.07, 3, 4, METAL, { x: 3.2, y: 0.22, z: -3 });
  b.box(0.07, 0.6, 0.9, accent, { x: 3.2, y: 2.6, z: -2.55 });
  if (withGun) atGun(b);
}

/** The traversing gun of a defensive emplacement (null if the type has none). */
export function buildDefenseTurret(typeId: BuildingTypeId): THREE.BufferGeometry | null {
  if (typeId !== 'at_emplacement') return null;
  const b = new ModelBuilder();
  atGun(b);
  return b.build();
}

/** Build the full-detail model for a building type. */
export function buildBuildingModel(typeId: BuildingTypeId, opts: BuildingModelOpts): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const a = opts.accent;
  switch (typeId) {
    case 'hq':
      hq(b, a);
      break;
    case 'habitat':
      habitat(b, a);
      break;
    case 'power_plant':
      powerPlant(b, a);
      break;
    case 'extractor':
      if (opts.siteKind === 'hydrocarbons') oilWell(b, a);
      else mine(b, a);
      break;
    case 'farm':
      farm(b, a);
      break;
    case 'refinery':
      refinery(b, a);
      break;
    case 'factory':
      factory(b, a);
      break;
    case 'barracks':
      barracks(b, a);
      break;
    case 'vehicle_depot':
      vehicleDepot(b, a);
      break;
    case 'bunker':
      bunker(b, a);
      break;
    case 'research_lab':
      researchLab(b, a);
      break;
    case 'at_emplacement':
      atEmplacement(b, a, !opts.noTurret);
      break;
  }
  return b.build();
}

/** Construction scaffolding sized to a footprint radius (metres). */
export function buildScaffold(radius: number): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const s = radius * 0.75;
  const h = Math.max(6, radius * 0.7);
  const Y = 0xd9a032;
  for (const [x, z] of [
    [-s, -s],
    [s, -s],
    [-s, s],
    [s, s],
  ] as const) b.box(0.35, h, 0.35, Y, { x, z });
  for (const y of [h * 0.5, h]) {
    b.box(s * 2, 0.3, 0.3, Y, { y, z: -s });
    b.box(s * 2, 0.3, 0.3, Y, { y, z: s });
    b.box(0.3, 0.3, s * 2, Y, { y, x: -s });
    b.box(0.3, 0.3, s * 2, Y, { y, x: s });
  }
  b.box(s * 2.2, 0.3, s * 2.2, PAD);
  // a crane
  b.box(0.6, h * 1.6, 0.6, 0xc8a02e, { x: s + 2, z: -s });
  b.box(s * 1.8, 0.6, 0.6, 0xc8a02e, { x: s + 2 - s * 0.6, y: h * 1.6, z: -s });
  return b.build();
}

/** Rubble left by a destroyed structure. */
export function buildRubble(radius: number, seed = 1): THREE.BufferGeometry {
  const b = new ModelBuilder();
  let s = seed * 9301 + 49297;
  const rnd = (): number => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  b.box(radius * 1.6, 0.3, radius * 1.4, 0x3b3833);
  for (let k = 0; k < 14; k++) {
    const x = (rnd() - 0.5) * radius * 1.4;
    const z = (rnd() - 0.5) * radius * 1.2;
    const w = 1 + rnd() * radius * 0.25;
    const h = 0.5 + rnd() * 3;
    b.box(w, h, w * (0.6 + rnd()), rnd() > 0.5 ? 0x4a4640 : 0x34312d, { x, z, ry: rnd() * 3, rz: (rnd() - 0.5) * 0.6 });
  }
  // burnt frame
  b.box(0.5, 6, 0.5, 0x222120, { x: -radius * 0.3, z: radius * 0.2, rz: 0.2 });
  b.box(0.5, 4.5, 0.5, 0x222120, { x: radius * 0.35, z: -radius * 0.1, rz: -0.3 });
  b.box(radius * 0.8, 0.5, 0.5, 0x222120, { x: 0, y: 4.2, z: radius * 0.05, rz: 0.25 });
  return b.build();
}
