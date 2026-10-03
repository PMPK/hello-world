import * as THREE from 'three';
import { ModelBuilder, type Xf } from './builder';

/**
 * Original low-poly unit models (metres, origin at ground centre, facing +Z).
 * Faction colours are baked in so each faction gets its own geometry and
 * instanced meshes can use instance colour only for wrecks/highlights.
 */

const DARK = 0x1f2022;
const GUNMETAL = 0x3a3d40;
const TRACK = 0x2c2b28;
const RUBBER = 0x1b1b1b;
const GLASS = 0x2b3a44;
const SKIN = 0xb98e6a;
const LIGHT = 0xe8e2b0;

function shade(c: THREE.ColorRepresentation, k: number): THREE.Color {
  return new THREE.Color(c).multiplyScalar(k);
}

export function buildSoldier(uniform: THREE.ColorRepresentation): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const u = new THREE.Color(uniform);
  const uDark = shade(uniform, 0.72);
  b.box(0.17, 0.82, 0.2, uDark, { x: -0.11 });
  b.box(0.17, 0.82, 0.2, uDark, { x: 0.11 });
  b.box(0.48, 0.58, 0.28, u, { y: 0.82 });
  b.box(0.52, 0.36, 0.33, shade(uniform, 0.55), { y: 0.92 }); // vest
  b.box(0.34, 0.42, 0.18, uDark, { y: 0.92, z: -0.22 }); // pack
  b.box(0.13, 0.5, 0.13, u, { x: -0.31, y: 0.9, rz: 0.15 }); // arms
  b.box(0.13, 0.5, 0.13, u, { x: 0.31, y: 0.9, rz: -0.15 });
  b.sphere(0.12, SKIN, { y: 1.56 });
  b.dome(0.165, 6, uDark, { y: 1.58 });
  b.box(0.06, 0.08, 0.8, DARK, { x: 0.22, y: 1.05, z: 0.22, rx: 0.12 }); // rifle
  return b.build();
}

export function buildJeep(camo: THREE.ColorRepresentation): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const c = new THREE.Color(camo);
  const cd = shade(camo, 0.75);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.cyl(0.43, 0.43, 0.34, 8, RUBBER, { x: sx * 1.0, y: 0.43, z: sz * 1.45, rz: Math.PI / 2 });
    }
  }
  b.box(1.95, 0.5, 4.4, cd, { y: 0.42 }); // chassis
  b.box(2.05, 0.18, 1.3, c, { y: 0.92, z: 1.5 }); // fender line front
  b.box(1.9, 0.38, 1.45, c, { y: 0.92, z: 1.35 }); // hood
  b.box(1.95, 0.55, 2.3, c, { y: 0.92, z: -0.85 }); // rear tub
  b.box(1.82, 0.62, 0.07, GLASS, { y: 1.3, z: 0.62, rx: -0.28 }); // windshield
  b.box(0.08, 0.85, 0.08, DARK, { x: -0.86, y: 1.45, z: -0.25 });
  b.box(0.08, 0.85, 0.08, DARK, { x: 0.86, y: 1.45, z: -0.25 });
  b.box(1.8, 0.08, 0.08, DARK, { y: 2.26, z: -0.25 });
  b.cyl(0.38, 0.38, 0.1, 10, GUNMETAL, { y: 2.3, z: -0.45 }); // ring mount
  b.box(0.13, 0.16, 1.4, DARK, { y: 2.5, z: 0.05 }); // 12.7mm HMG
  b.box(0.6, 0.38, 0.05, GUNMETAL, { y: 2.42, z: -0.12 }); // gun shield
  b.cyl(0.4, 0.4, 0.26, 8, RUBBER, { y: 1.0, z: -2.15, rx: Math.PI / 2 }); // spare tyre
  b.box(0.22, 0.12, 0.05, LIGHT, { x: -0.65, y: 0.98, z: 2.2 });
  b.box(0.22, 0.12, 0.05, LIGHT, { x: 0.65, y: 0.98, z: 2.2 });
  b.box(0.06, 1.9, 0.06, DARK, { x: 0.8, y: 1.0, z: -1.7 }); // antenna
  return b.build();
}

export function buildTankHull(camo: THREE.ColorRepresentation): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const c = new THREE.Color(camo);
  const cd = shade(camo, 0.78);
  const cl = shade(camo, 1.08);
  for (const sx of [-1, 1]) {
    b.box(0.72, 1.0, 9.0, TRACK, { x: sx * 1.55 });
    for (let k = 0; k < 6; k++) {
      b.cyl(0.42, 0.42, 0.42, 8, GUNMETAL, { x: sx * 1.55, y: 0.45, z: -3.5 + k * 1.4, rz: Math.PI / 2 });
    }
    b.cyl(0.36, 0.36, 0.45, 8, GUNMETAL, { x: sx * 1.55, y: 0.75, z: 4.2, rz: Math.PI / 2 }); // drive sprocket
    b.box(0.14, 0.62, 7.6, cd, { x: sx * 1.9, y: 0.68, z: 0.2 }); // side skirts
  }
  b.box(2.5, 0.75, 8.8, cd, { y: 0.35 }); // lower hull
  b.box(3.6, 0.55, 7.4, c, { y: 1.05, z: -0.45 }); // upper hull / sponsons
  b.box(3.4, 0.5, 1.6, cl, { y: 0.95, z: 3.7, rx: -0.42 }); // glacis plate
  b.box(3.0, 0.12, 2.4, GUNMETAL, { y: 1.62, z: -3.0 }); // engine deck grilles
  b.box(0.3, 0.2, 0.15, LIGHT, { x: -1.3, y: 1.3, z: 4.15 });
  b.box(0.3, 0.2, 0.15, LIGHT, { x: 1.3, y: 1.3, z: 4.15 });
  b.box(0.5, 0.35, 0.8, cd, { x: -1.1, y: 1.6, z: -4.0 }); // stowage
  b.box(0.5, 0.35, 0.8, cd, { x: 1.1, y: 1.6, z: -4.0 });
  return b.build();
}

/** Turret pivot at its origin; place at TANK_TURRET_HEIGHT on the hull. */
export const TANK_TURRET_HEIGHT = 1.6;

export function buildTankTurret(camo: THREE.ColorRepresentation): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const c = new THREE.Color(camo);
  const cd = shade(camo, 0.8);
  const cl = shade(camo, 1.1);
  b.box(3.0, 0.85, 3.2, c, { z: -0.3 });
  b.box(2.6, 0.75, 1.3, cl, { y: 0.05, z: 1.6, rx: 0.12 }); // angled front armour
  b.box(1.0, 0.6, 0.6, cd, { y: 0.2, z: 2.35 }); // mantlet
  b.cyl(0.11, 0.13, 5.4, 8, cd, { y: 0.5, z: 2.4, rx: Math.PI / 2 }); // 120mm barrel (along +z)
  b.cyl(0.17, 0.17, 0.7, 8, cd, { y: 0.5, z: 4.6, rx: Math.PI / 2 }); // fume extractor
  b.cyl(0.36, 0.36, 0.35, 8, cd, { x: 0.75, y: 0.85, z: -0.5 }); // commander cupola
  b.box(0.1, 0.12, 0.9, DARK, { x: 0.75, y: 1.3, z: -0.2 }); // roof MG
  b.box(2.6, 0.5, 0.9, GUNMETAL, { y: 0.15, z: -2.2 }); // bustle rack
  b.box(0.05, 1.6, 0.05, DARK, { x: -1.1, y: 0.8, z: -1.5 }); // antenna
  return b.build();
}

export function buildTruck(camo: THREE.ColorRepresentation): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const c = new THREE.Color(camo);
  for (const z of [-1.6, 0, 1.9]) {
    for (const sx of [-1, 1]) b.cyl(0.45, 0.45, 0.35, 8, RUBBER, { x: sx * 1.0, y: 0.45, z, rz: Math.PI / 2 });
  }
  b.box(2.1, 0.45, 6.2, GUNMETAL, { y: 0.5 });
  b.box(2.2, 1.5, 1.7, c, { y: 0.95, z: 2.3 }); // cab
  b.box(2.0, 0.45, 0.06, GLASS, { y: 1.85, z: 3.16 });
  b.box(2.3, 1.9, 4.0, shade(camo, 0.85), { y: 0.95, z: -0.9 }); // tarp
  return b.build();
}

/** Flat ring for selection markers (lies on the XZ plane). */
export function buildRing(inner: number, outer: number, seg = 32): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(inner, outer, seg);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------
// Nature
// ---------------------------------------------------------------------------

/** Open-ended cone/cylinder pieces: hidden bottom caps are skipped to save triangles. */
function openCone(b: ModelBuilder, r: number, h: number, seg: number, color: number, xf: Xf = {}): void {
  const g = new THREE.ConeGeometry(r, h, seg, 1, true);
  g.translate(0, h / 2, 0);
  b.add(g, color, xf);
}

function openTrunk(b: ModelBuilder, r0: number, r1: number, h: number, seg: number, color: number): void {
  const g = new THREE.CylinderGeometry(r0, r1, h, seg, 1, true);
  g.translate(0, h / 2, 0);
  b.add(g, color);
}

/** Battle-scale conifer (~20 triangles). */
export function buildConifer(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  openTrunk(b, 0.22, 0.3, 1.8, 4, 0x4f3d2b);
  openCone(b, 2.0, 3.6, 6, 0x2e4a2b, { y: 1.3 });
  openCone(b, 1.35, 3.0, 6, 0x37562f, { y: 3.4, ry: 0.5 });
  return b.build();
}

/** Battle-scale broadleaf tree (~28 triangles). */
export function buildBroadleaf(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  openTrunk(b, 0.25, 0.35, 2.6, 4, 0x55412d);
  b.sphere(2.2, 0x46663a, { y: 3.8, sy: 0.85 });
  return b.build();
}

/** Strategic-map conifer: a single 6-triangle cone. */
export function buildConiferLow(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  openCone(b, 2.1, 7, 6, 0x2f4b2b);
  return b.build();
}

/** Strategic-map broadleaf: an 8-triangle crown. */
export function buildBroadleafLow(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add(new THREE.OctahedronGeometry(2.3, 0), 0x47663a, { y: 3.2, sy: 1.1 });
  return b.build();
}

export function buildRock(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.add(new THREE.DodecahedronGeometry(1, 0), 0x77756d, { sy: 0.7 });
  b.add(new THREE.DodecahedronGeometry(0.6, 0), 0x6b6a63, { x: 0.9, y: -0.1, z: 0.3, sy: 0.6 });
  return b.build();
}

export function buildCrystals(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  const tint = [0x9fb6c6, 0x86a3b8, 0xb5c9d6];
  b.add(new THREE.DodecahedronGeometry(1.4, 0), 0x6e6c66, { y: 0.4, sy: 0.6 });
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    b.add(new THREE.OctahedronGeometry(0.55, 0), tint[k % 3], {
      x: Math.cos(a) * 0.9,
      y: 1.2 + (k % 2) * 0.3,
      z: Math.sin(a) * 0.9,
      sy: 2.4,
      rx: Math.cos(a) * 0.4,
      rz: Math.sin(a) * 0.4,
    });
  }
  return b.build();
}

export function buildOilSeep(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.cyl(2.2, 2.4, 0.12, 10, 0x141414);
  b.cyl(1.1, 1.3, 0.16, 8, 0x262420, { x: 2.0, z: 1.2 });
  b.box(0.15, 3.2, 0.15, 0x6b5a3c, { x: -1.6, z: -1.6 }); // survey stake
  b.box(1.0, 0.6, 0.05, 0xd9a03a, { x: -1.1, y: 2.5, z: -1.6 }); // flag
  return b.build();
}
