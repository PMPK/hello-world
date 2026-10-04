import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BUILDINGS } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import type { Base, CampaignState } from '../campaign/types';
import { statsOf } from '../units/stats';
import { Materials, ModelBuilder, PAINT } from './models/builder';
import { Models } from './models/cache';
import { TANK_TURRET_HEIGHT } from './models/units';

/**
 * Living bases on the strategic map: prefab huts and containers that spread
 * between the structures as the population grows, and the garrison's
 * vehicles parked in rows next to the vehicle depot (or the HQ). One
 * instanced mesh per model, rebuilt only when a base changes.
 */

/** People per hut. */
const PEOPLE_PER_HUT = 4;
const MAX_HUTS_PER_BASE = 40;
const MAX_PARKED_PER_BASE = 24;
/** Instance buffers are sized for this many bases (four per expedition, captures, relief landings). */
const MAX_BASES = 12;

function buildHut(): THREE.BufferGeometry {
  const b = new ModelBuilder();
  b.box(2.6, 1.3, 1.7, PAINT, { y: 0.65 });
  b.box(2.8, 0.2, 1.9, 0x5f625c, { y: 1.4 });
  b.box(0.55, 0.95, 0.06, 0x2a2f31, { y: 0.48, z: 0.86 });
  b.box(0.7, 0.35, 0.06, 0x8fb4c4, { x: 0.8, y: 0.85, z: 0.86 });
  return b.build();
}

/** Stable pseudo-random numbers from a string seed (rendering only). */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const HUT_TINTS = ['#d9d6cc', '#c9bfa6', '#b9c0b0', '#9fa89a', '#d4c49c'];
/** Clearance radius of one hut in model units (it is 2.8 × 1.9). */
const HUT_RADIUS = 1.9;

type ParkedKind = 'tank' | 'jeep' | 'truck';

export class Settlements {
  private readonly huts: THREE.InstancedMesh;
  private readonly parked: Record<ParkedKind, THREE.InstancedMesh>;
  private key = '';
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    private readonly heightAt: (x: number, z: number) => number,
    private readonly hutScale: number,
    private readonly vehicleScale: number,
    private readonly showVehicles: boolean,
  ) {
    this.huts = new THREE.InstancedMesh(buildHut(), Materials.standard, MAX_BASES * MAX_HUTS_PER_BASE);
    this.huts.count = 0;
    this.huts.castShadow = true;
    this.huts.receiveShadow = true;
    scene.add(this.huts);
    const turret = Models.tankTurret('#ffffff').clone();
    turret.translate(0, TANK_TURRET_HEIGHT, 0);
    const tank = mergeGeometries([Models.tankHull('#ffffff'), turret]);
    turret.dispose();
    const make = (g: THREE.BufferGeometry): THREE.InstancedMesh => {
      const im = new THREE.InstancedMesh(g, Materials.standard, MAX_BASES * MAX_PARKED_PER_BASE);
      im.count = 0;
      im.castShadow = true;
      scene.add(im);
      return im;
    };
    this.parked = { tank: make(tank), jeep: make(Models.jeep('#ffffff')), truck: make(Models.truck('#ffffff')) };
  }

  /** Force a rebuild (e.g. after the terrain under a base changed). */
  invalidate(): void {
    this.key = '';
  }

  /** Rebuild instances when population, structures or garrisons change. */
  sync(state: CampaignState, isVisible: (x: number, z: number) => boolean): void {
    const bases = Object.values(state.bases).sort((a, b) => (a.id < b.id ? -1 : 1));
    const key = bases
      .map((b) => {
        const seen = b.factionId === state.playerFactionId || isVisible(b.x, b.z);
        const parked = seen ? b.garrison.map((u) => u.designId).join(',') : '';
        return `${b.id}:${b.factionId}:${Math.floor(b.population / PEOPLE_PER_HUT)}:${this.structureKey(state, b)}:${parked}`;
      })
      .join('|');
    if (key === this.key) return;
    this.key = key;
    let huts = 0;
    const counts: Record<ParkedKind, number> = { tank: 0, jeep: 0, truck: 0 };
    for (const base of bases) {
      const blockers = this.blockers(state, base);
      // parked vehicles first: their bays are kept clear of huts
      if (this.showVehicles && (base.factionId === state.playerFactionId || isVisible(base.x, base.z))) this.placeVehicles(state, base, blockers, counts);
      huts = this.placeHuts(base, blockers, huts);
    }
    this.huts.count = huts;
    this.commit(this.huts);
    for (const k of Object.keys(this.parked) as ParkedKind[]) {
      this.parked[k].count = counts[k];
      this.commit(this.parked[k]);
    }
  }

  /** Upload changed instances and refresh the culling bounds (they are cached from the first render). */
  private commit(im: THREE.InstancedMesh): void {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
  }

  /** Which structures stand and in what state (a finished depot moves the vehicle park). */
  private structureKey(state: CampaignState, base: Base): string {
    let key = '';
    for (const b of Object.values(state.buildings)) if (b.baseId === base.id) key += `${b.id}${b.state[0]};`;
    return key;
  }

  /** Circles (x, z, r) the settlement keeps clear of: structures and the HQ plaza. */
  private blockers(state: CampaignState, base: Base): { x: number; z: number; r: number }[] {
    const out = [{ x: base.x, z: base.z, r: 2.2 }];
    for (const b of Object.values(state.buildings)) {
      if (b.baseId !== base.id || b.state === 'destroyed') continue;
      if (Math.hypot(b.x - base.x, b.z - base.z) > base.radius + 2) continue; // outposts
      out.push({ x: b.x, z: b.z, r: BUILDINGS[b.typeId].footprint + 0.6 });
    }
    return out;
  }

  private free(x: number, z: number, r: number, blockers: { x: number; z: number; r: number }[]): boolean {
    for (const b of blockers) if (Math.hypot(x - b.x, z - b.z) < b.r + r) return false;
    return true;
  }

  /**
   * Camp blocks of up to six huts (two rows facing the centre) on two rings
   * around the HQ; blocks fill in a fixed per-base order as people arrive.
   */
  private hutSlots(base: Base, blockers: { x: number; z: number; r: number }[]): { x: number; z: number; yaw: number }[] {
    const rnd = seeded(`huts:${base.id}`);
    const blocks: { a: number; ring: number }[] = [];
    const turn = rnd() * Math.PI * 2;
    for (const [ring, n] of [
      [5.4, 7],
      [7.4, 10],
    ] as const) {
      for (let k = 0; k < n; k++) blocks.push({ a: turn + (k / n) * Math.PI * 2 + (ring > 6 ? Math.PI / n : 0), ring });
    }
    // deterministic shuffle so camps grow on all sides
    for (let i = blocks.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
    }
    const w = 2.9 * this.hutScale;
    const d = 2.3 * this.hutScale;
    const r = HUT_RADIUS * this.hutScale * 0.6;
    const out: { x: number; z: number; yaw: number }[] = [];
    for (const b of blocks) {
      const cx = base.x + Math.cos(b.a) * b.ring;
      const cz = base.z + Math.sin(b.a) * b.ring;
      // local axes: "across" is tangential, "deep" points away from the centre
      const ax = -Math.sin(b.a);
      const az = Math.cos(b.a);
      const ox = Math.cos(b.a);
      const oz = Math.sin(b.a);
      const yaw = Math.atan2(-ox, -oz); // doors face the HQ
      for (const row of [0, 1]) {
        for (const col of [-1, 0, 1]) {
          const x = cx + ax * col * w + ox * row * d;
          const z = cz + az * col * w + oz * row * d;
          if (Math.hypot(x - base.x, z - base.z) > base.radius - 0.7) continue;
          if (!this.free(x, z, r, blockers)) continue;
          out.push({ x, z, yaw });
        }
      }
    }
    return out;
  }

  private placeHuts(base: Base, blockers: { x: number; z: number; r: number }[], start: number): number {
    const want = Math.min(MAX_HUTS_PER_BASE, Math.floor(base.population / PEOPLE_PER_HUT));
    const slots = this.hutSlots(base, blockers);
    const rnd = seeded(`tints:${base.id}`);
    let n = start;
    for (let k = 0; k < Math.min(want, slots.length) && n < this.huts.instanceMatrix.count; k++) {
      const sl = slots[k];
      const sc = this.hutScale * (0.92 + rnd() * 0.16);
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, sl.yaw);
      this.p.set(sl.x, this.heightAt(sl.x, sl.z), sl.z);
      this.s.set(sc, sc, sc);
      this.m.compose(this.p, this.q, this.s);
      this.huts.setMatrixAt(n, this.m);
      this.huts.setColorAt(n, this.c.set(HUT_TINTS[Math.floor(rnd() * HUT_TINTS.length)]));
      n++;
    }
    return n;
  }

  /** Garrison vehicles parked in rows on a clear side of the vehicle depot (or the HQ). */
  private placeVehicles(state: CampaignState, base: Base, blockers: { x: number; z: number; r: number }[], counts: Record<ParkedKind, number>): void {
    const vehicles = base.garrison.filter((u) => statsOf(u.designId).isVehicle).slice(0, MAX_PARKED_PER_BASE);
    if (!vehicles.length) return;
    const depot = Object.values(state.buildings).find((b) => b.baseId === base.id && b.typeId === 'vehicle_depot' && b.state === 'active');
    const anchor = depot ?? { x: base.x, z: base.z, typeId: 'hq' as const };
    const startD = BUILDINGS[anchor.typeId].footprint + 0.9;
    const rows = Math.ceil(vehicles.length / 6);
    // pick the side whose parking rows are clear of structures
    let best = 0;
    let bestFree = -1;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      let free = 0;
      for (let row = 0; row < rows; row++) {
        for (const col of [-2.5, 0, 2.5]) {
          const x = anchor.x + Math.sin(a) * (startD + row * 1.3) + Math.cos(a) * col * 0.9;
          const z = anchor.z + Math.cos(a) * (startD + row * 1.3) - Math.sin(a) * col * 0.9;
          if (this.free(x, z, 0.5, blockers.filter((b) => Math.hypot(b.x - anchor.x, b.z - anchor.z) > 0.1))) free++;
        }
      }
      if (free > bestFree) {
        bestFree = free;
        best = a;
      }
    }
    const fx = Math.sin(best);
    const fz = Math.cos(best);
    const px = Math.cos(best);
    const pz = -Math.sin(best);
    const tint = this.c.set(FACTION_DEFS[state.factions[base.factionId]?.defId ?? '']?.vehicleTint ?? '#777766').clone();
    const bays: { x: number; z: number; r: number }[] = [];
    vehicles.forEach((u, k) => {
      const fam = statsOf(u.designId).family;
      const kind: ParkedKind = fam === 'tank' ? 'tank' : fam === 'support' ? 'truck' : 'jeep';
      const im = this.parked[kind];
      if (counts[kind] >= im.instanceMatrix.count) return;
      const row = Math.floor(k / 6);
      const col = (k % 6) - 2.5;
      const x = anchor.x + fx * (startD + row * 1.3) + px * col * 0.9;
      const z = anchor.z + fz * (startD + row * 1.3) + pz * col * 0.9;
      this.q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, best + Math.PI);
      this.p.set(x, this.heightAt(x, z), z);
      this.s.setScalar(this.vehicleScale);
      this.m.compose(this.p, this.q, this.s);
      im.setMatrixAt(counts[kind], this.m);
      im.setColorAt(counts[kind], tint);
      counts[kind]++;
      bays.push({ x, z, r: 0.7 });
    });
    blockers.push(...bays);
  }

  dispose(): void {
    // the hut and merged tank geometries are ours; jeep and truck geometries belong to the model cache
    this.huts.geometry.dispose();
    this.parked.tank.geometry.dispose();
    for (const im of [this.huts, ...Object.values(this.parked)]) {
      im.removeFromParent();
      im.dispose(); // instance matrix / colour buffers
    }
  }
}
