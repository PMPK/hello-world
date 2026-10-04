import * as THREE from 'three';
import { clamp, dist } from '../core/math';
import { mixSeed, Rng } from '../core/rng';
import { BUILDINGS, type BuildingTypeId } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import { statsOf } from '../units/stats';
import { isVisibleToFaction } from '../campaign/queries';
import type { Army, Building, CampaignState } from '../campaign/types';
import { BIOME, heightAt, type BiomeId, type Terrain } from '../world/terrain';
import type { World } from '../world/world';
import { CameraRig } from '../input/cameraRig';
import { Materials } from './models/builder';
import { Models } from './models/cache';
import { buildRing, TANK_TURRET_HEIGHT } from './models/units';
import { Daylight } from './daylight';
import { makeLights, type GameRenderer } from './renderer';

/** Model scales on the strategic map (models are authored in metres). */
export const CAMPAIGN_BUILDING_SCALE = 0.068;
export const CAMPAIGN_VEHICLE_SCALE = 0.13;
export const CAMPAIGN_SOLDIER_SCALE = 0.3;

export interface PickResult {
  kind: 'army' | 'building' | 'base' | 'site' | 'convoy' | 'ground';
  id?: string;
  x: number;
  z: number;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function terrainColor(b: BiomeId, h: number, slope: number, m: number, out: THREE.Color): THREE.Color {
  switch (b) {
    case BIOME.water: {
      const t = clamp(-h / 5, 0, 1);
      return out.setRGB(0.72 - 0.5 * t, 0.66 - 0.42 * t, 0.48 - 0.2 * t, THREE.SRGBColorSpace);
    }
    case BIOME.beach:
      return out.set(0xc4b383);
    case BIOME.forest:
      return out.set(m > 0.4 ? 0x34502b : 0x3e5a31);
    case BIOME.hills:
      return slope > 0.9 ? out.set(0x857a63) : out.set(0x8c8d58);
    case BIOME.mountains:
      return slope > 1.8 ? out.set(0x5f5b55) : out.set(0x7a766e);
    case BIOME.snow:
      return out.set(0xe9eef0);
    default:
      return m < -0.25 ? out.set(0xa3a065) : m < 0.05 ? out.set(0x8ea25a) : out.set(0x7a9a50);
  }
}

interface ArmyVisual {
  group: THREE.Group;
  key: string;
  heading: number;
  pos: THREE.Vector3;
}

/**
 * Strategic map renderer. Reads CampaignState each frame and keeps Three.js
 * objects in sync. Holds no game logic.
 */
export class CampaignView {
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  private readonly terrain: Terrain;
  private sun!: THREE.DirectionalLight;
  private daylight!: Daylight;
  private terrainMesh!: THREE.Mesh;
  private water!: THREE.Mesh;
  private buildingObjs = new Map<string, { obj: THREE.Object3D; key: string }>();
  private armyObjs = new Map<string, ArmyVisual>();
  private convoyObjs = new Map<string, THREE.Mesh>();
  private siteObjs = new Map<string, { obj: THREE.Object3D; beacon: THREE.Mesh }>();
  private perimeters = new Map<string, { line: THREE.LineLoop; faction: string }>();
  private roadMesh: THREE.Mesh | null = null;
  private roadsKey = '';
  private selRing: THREE.Mesh;
  private destMarker: THREE.Group;
  private pathLine: THREE.Line;
  private ghost: THREE.Mesh | null = null;
  private ghostKey = '';
  private time = 0;
  private damagedMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x8f7d72 });
  private beaconMats: Record<string, THREE.MeshBasicMaterial> = {
    minerals: new THREE.MeshBasicMaterial({ color: 0x8fd3ff }),
    hydrocarbons: new THREE.MeshBasicMaterial({ color: 0xffb347 }),
  };
  selectedArmyId: string | null = null;
  selectedBaseId: string | null = null;
  selectedBuildingId: string | null = null;
  selectedSiteId: string | null = null;
  playerFaction = '';

  constructor(
    private readonly gr: GameRenderer,
    world: World,
    state: CampaignState,
  ) {
    this.terrain = world.terrain;
    this.playerFaction = state.playerFactionId;
    const t = this.terrain;
    this.rig = new CameraRig(gr.aspect, {
      minDist: 9,
      maxDist: 230,
      minX: 0,
      maxX: t.size,
      minZ: 0,
      maxZ: t.size,
      pitchNear: 0.62,
      pitchFar: 1.12,
    });
    this.rig.heightAt = (x, z) => Math.max(0, heightAt(t, x, z));
    const bg = new THREE.Color(0x9db2bd);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 120, 600);
    const lights = makeLights(this.scene, gr.profile, 200);
    this.sun = lights.sun;
    this.daylight = new Daylight({ sun: lights.sun, hemi: lights.hemi, scene: this.scene });
    this.buildTerrain();
    this.buildWater();
    this.buildVegetation(world, state);

    this.selRing = new THREE.Mesh(
      buildRing(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: 0x9cf0b0, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.selRing.visible = false;
    this.selRing.renderOrder = 5;
    this.scene.add(this.selRing);

    this.destMarker = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.1, 6), new THREE.MeshBasicMaterial({ color: 0x9cf0b0 }));
    cone.rotation.x = Math.PI;
    cone.position.y = 1.2;
    this.destMarker.add(cone);
    const dring = new THREE.Mesh(buildRing(0.5, 0.65, 24), new THREE.MeshBasicMaterial({ color: 0x9cf0b0, transparent: true, opacity: 0.8 }));
    dring.position.y = 0.08;
    this.destMarker.add(dring);
    this.destMarker.visible = false;
    this.scene.add(this.destMarker);

    this.pathLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0xbaf5c8, dashSize: 0.7, gapSize: 0.45, transparent: true, opacity: 0.9 }),
    );
    this.pathLine.visible = false;
    this.scene.add(this.pathLine);

    const hqBase = Object.values(state.bases).find((b) => b.factionId === state.playerFactionId);
    if (hqBase) this.rig.jumpTo(hqBase.x, hqBase.z + 8, 55);
    else this.rig.jumpTo(t.size / 2, t.size / 2, 150);
  }

  // ---------------------------------------------------------------------------
  // Static world
  // ---------------------------------------------------------------------------

  private buildTerrain(): void {
    const t = this.terrain;
    const verts = t.grid + 1;
    const triCount = t.grid * t.grid * 2;
    const pos = new Float32Array(triCount * 9);
    const col = new Float32Array(triCount * 9);
    const c = new THREE.Color();
    let k = 0;
    const rng = new Rng(mixSeed(t.seed, 'terrain-colour'));
    const pushTri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, ha: number, hb: number, hc: number, cell: number): void => {
      const b = t.biomes[cell] as BiomeId;
      const hAvg = (ha + hb + hc) / 3;
      const slope = (Math.max(ha, hb, hc) - Math.min(ha, hb, hc)) / t.cell;
      terrainColor(b, hAvg, slope, t.moisture[cell], c);
      // snow line and rocky shoulders regardless of biome
      if (b !== BIOME.water && hAvg > 13.5) c.lerp(new THREE.Color(0xe9eef0), clamp((hAvg - 13.5) / 3, 0, 1));
      const jitter = 1 + (rng.next() - 0.5) * 0.09;
      pos.set([ax, ha, az, bx, hb, bz, cx, hc, cz], k);
      for (let v = 0; v < 3; v++) col.set([c.r * jitter, c.g * jitter, c.b * jitter], k + v * 3);
      k += 9;
    };
    for (let j = 0; j < t.grid; j++) {
      for (let i = 0; i < t.grid; i++) {
        const x0 = i * t.cell;
        const x1 = (i + 1) * t.cell;
        const z0 = j * t.cell;
        const z1 = (j + 1) * t.cell;
        const h00 = t.heights[j * verts + i];
        const h10 = t.heights[j * verts + i + 1];
        const h01 = t.heights[(j + 1) * verts + i];
        const h11 = t.heights[(j + 1) * verts + i + 1];
        const cell = j * t.grid + i;
        if ((i + j) % 2 === 0) {
          pushTri(x0, z0, x0, z1, x1, z0, h00, h01, h10, cell);
          pushTri(x1, z0, x0, z1, x1, z1, h10, h01, h11, cell);
        } else {
          pushTri(x0, z0, x0, z1, x1, z1, h00, h01, h11, cell);
          pushTri(x0, z0, x1, z1, x1, z0, h00, h11, h10, cell);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.terrainMesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.terrainMesh.receiveShadow = true;
    this.scene.add(this.terrainMesh);
  }

  private buildWater(): void {
    const s = this.terrain.size;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(s * 5, s * 5), new THREE.MeshBasicMaterial({ color: 0x1d3d4a }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(s / 2, -7, s / 2);
    this.scene.add(floor);
    const wg = new THREE.PlaneGeometry(s * 5, s * 5, 1, 1);
    this.water = new THREE.Mesh(
      wg,
      new THREE.MeshStandardMaterial({ color: 0x2c6a82, roughness: 0.22, metalness: 0.05, transparent: true, opacity: 0.8 }),
    );
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.set(s / 2, 0, s / 2);
    this.water.receiveShadow = this.gr.profile.shadows;
    this.scene.add(this.water);
  }

  private buildVegetation(world: World, state: CampaignState): void {
    const t = this.terrain;
    const rng = new Rng(mixSeed(t.seed, 'trees'));
    const density = this.gr.profile.treeDensity;
    const conifers: THREE.Matrix4[] = [];
    const broad: THREE.Matrix4[] = [];
    const rocks: THREE.Matrix4[] = [];
    const avoid = [
      ...Object.values(state.bases).map((b) => ({ x: b.x, z: b.z, r: b.radius + 1.5 })),
      ...Object.values(state.sites).map((s) => ({ x: s.x, z: s.z, r: 2.6 })),
    ];
    const blocked = (x: number, z: number): boolean => {
      for (const a of avoid) if (dist(a.x, a.z, x, z) < a.r) return true;
      const ci = Math.floor(x / t.cell);
      const cj = Math.floor(z / t.cell);
      return world.roadMask[cj * t.grid + ci] === 1;
    };
    for (let j = 0; j < t.grid; j++) {
      for (let i = 0; i < t.grid; i++) {
        const b = t.biomes[j * t.grid + i] as BiomeId;
        let n = 0;
        if (b === BIOME.forest) n = 2.6;
        else if (b === BIOME.hills) n = 0.35;
        else if (b === BIOME.plains) n = 0.08;
        else if (b === BIOME.mountains) n = 0.15;
        n *= density;
        let count = Math.floor(n) + (rng.next() < n - Math.floor(n) ? 1 : 0);
        for (; count > 0; count--) {
          const x = (i + rng.next()) * t.cell;
          const z = (j + rng.next()) * t.cell;
          const h = heightAt(t, x, z);
          if (h < 0.4 || h > 13 || blocked(x, z)) continue;
          const s = rng.range(0.1, 0.17);
          tmpQ.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
          tmpS.set(s, s * rng.range(0.85, 1.25), s);
          const m = new THREE.Matrix4().compose(tmpV.set(x, h - 0.05, z), tmpQ, tmpS);
          if (b === BIOME.mountains || h > 8 || rng.next() < 0.62) conifers.push(m);
          else broad.push(m);
        }
        if (b === BIOME.mountains && rng.next() < 0.25 * density) {
          const x = (i + rng.next()) * t.cell;
          const z = (j + rng.next()) * t.cell;
          const s = rng.range(0.35, 0.8);
          tmpQ.setFromAxisAngle(UP, rng.range(0, 6));
          rocks.push(new THREE.Matrix4().compose(tmpV.set(x, heightAt(t, x, z), z), tmpQ, tmpS.set(s, s, s)));
        }
      }
    }
    const make = (geo: THREE.BufferGeometry, list: THREE.Matrix4[]): void => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, Materials.standard, list.length);
      list.forEach((m, k) => im.setMatrixAt(k, m));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = this.gr.profile.treeShadows;
      im.receiveShadow = false;
      im.computeBoundingSphere();
      this.scene.add(im);
    };
    make(Models.coniferLow(), conifers);
    make(Models.broadleafLow(), broad);
    make(Models.rock(), rocks);
  }

  // ---------------------------------------------------------------------------
  // Dynamic sync
  // ---------------------------------------------------------------------------

  private h(x: number, z: number): number {
    return Math.max(0, heightAt(this.terrain, x, z));
  }

  sync(state: CampaignState, dt: number): void {
    this.time += dt;
    this.syncRoads(state);
    this.syncBuildings(state);
    this.syncSites(state);
    this.syncPerimeters(state);
    this.syncArmies(state, dt);
    this.syncConvoys(state);
    this.syncSelection(state);
  }

  private syncRoads(state: CampaignState): void {
    const roads = Object.values(state.roads);
    const key = roads.map((r) => `${r.id}:${r.points.length}`).join('|');
    if (key === this.roadsKey) return;
    this.roadsKey = key;
    if (this.roadMesh) {
      this.scene.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
    }
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color(0x8a7858);
    const half = 0.24;
    for (const r of roads) {
      // densify
      const pts: { x: number; z: number }[] = [];
      for (let k = 0; k < r.points.length - 1; k++) {
        const a = r.points[k];
        const b = r.points[k + 1];
        const n = Math.max(1, Math.ceil(dist(a.x, a.z, b.x, b.z) / 0.7));
        for (let s = 0; s < n; s++) pts.push({ x: a.x + ((b.x - a.x) * s) / n, z: a.z + ((b.z - a.z) * s) / n });
      }
      pts.push(r.points[r.points.length - 1]);
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        const nx = (-dz / l) * half;
        const nz = (dx / l) * half;
        const ha = this.h(a.x, a.z) + 0.07;
        const hb = this.h(b.x, b.z) + 0.07;
        pos.push(a.x + nx, ha, a.z + nz, b.x + nx, hb, b.z + nz, a.x - nx, ha, a.z - nz);
        pos.push(a.x - nx, ha, a.z - nz, b.x + nx, hb, b.z + nz, b.x - nx, hb, b.z - nz);
        for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
      }
    }
    if (!pos.length) {
      this.roadMesh = null;
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    this.roadMesh = new THREE.Mesh(g, mat);
    this.roadMesh.receiveShadow = true;
    this.scene.add(this.roadMesh);
  }

  private buildingKey(b: Building, state: CampaignState): string {
    const hpF = b.hp / BUILDINGS[b.typeId].maxHp;
    const prog = b.state === 'construction' ? Math.round(b.buildProgress * 10) : 0;
    const site = b.siteId ? state.sites[b.siteId]?.kind : '';
    return `${b.typeId}|${b.factionId}|${b.state}|${prog}|${hpF < 0.5 ? 'd' : 'ok'}|${site}`;
  }

  private makeBuildingObject(b: Building, state: CampaignState): THREE.Object3D {
    const def = BUILDINGS[b.typeId];
    const accent = FACTION_DEFS[state.factions[b.factionId]?.defId ?? '']?.structureAccent ?? '#888888';
    const siteKind = b.siteId ? (state.sites[b.siteId]?.kind ?? null) : null;
    const group = new THREE.Group();
    if (b.state === 'destroyed') {
      const m = new THREE.Mesh(Models.rubble(def.battleFootprint, b.id.length + b.typeId.length), Materials.standard);
      m.castShadow = true;
      group.add(m);
    } else {
      const hpF = b.hp / def.maxHp;
      const m = new THREE.Mesh(Models.building(b.typeId, accent, siteKind), hpF < 0.5 ? this.damagedMat : Materials.standard);
      m.castShadow = true;
      m.receiveShadow = true;
      if (b.state === 'construction') {
        m.scale.y = Math.max(0.12, b.buildProgress);
        const sc = new THREE.Mesh(Models.scaffold(def.battleFootprint), Materials.standard);
        group.add(sc);
      }
      group.add(m);
    }
    group.scale.multiplyScalar(CAMPAIGN_BUILDING_SCALE);
    group.position.set(b.x, this.h(b.x, b.z), b.z);
    group.rotation.y = b.rot;
    return group;
  }

  private syncBuildings(state: CampaignState): void {
    const seen = new Set<string>();
    for (const b of Object.values(state.buildings)) {
      seen.add(b.id);
      const key = this.buildingKey(b, state);
      const cur = this.buildingObjs.get(b.id);
      if (cur && cur.key === key) continue;
      if (cur) this.scene.remove(cur.obj);
      const obj = this.makeBuildingObject(b, state);
      this.scene.add(obj);
      this.buildingObjs.set(b.id, { obj, key });
    }
    for (const [id, o] of this.buildingObjs) {
      if (!seen.has(id)) {
        this.scene.remove(o.obj);
        this.buildingObjs.delete(id);
      }
    }
  }

  private syncSites(state: CampaignState): void {
    for (const s of Object.values(state.sites)) {
      let o = this.siteObjs.get(s.id);
      if (!o) {
        const group = new THREE.Group();
        const deco = new THREE.Mesh(s.kind === 'minerals' ? Models.crystals() : Models.oilSeep(), Materials.standard);
        deco.scale.setScalar(0.32);
        group.add(deco);
        const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 0), this.beaconMats[s.kind]);
        beacon.position.y = 2.4;
        group.add(beacon);
        group.position.set(s.x, this.h(s.x, s.z), s.z);
        this.scene.add(group);
        o = { obj: group, beacon };
        this.siteObjs.set(s.id, o);
      }
      const b = s.buildingId ? state.buildings[s.buildingId] : undefined;
      const claimed = !!b && b.state !== 'destroyed';
      o.obj.visible = !claimed;
      o.beacon.position.y = 2.3 + Math.sin(this.time * 2 + s.x) * 0.2;
      o.beacon.rotation.y = this.time;
    }
  }

  private syncPerimeters(state: CampaignState): void {
    for (const base of Object.values(state.bases)) {
      const cur = this.perimeters.get(base.id);
      if (cur && cur.faction === base.factionId) continue;
      if (cur) this.scene.remove(cur.line);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k < 72; k++) {
        const a = (k / 72) * Math.PI * 2;
        const x = base.x + Math.cos(a) * base.radius;
        const z = base.z + Math.sin(a) * base.radius;
        pts.push(new THREE.Vector3(x, this.h(x, z) + 0.15, z));
      }
      const color = state.factions[base.factionId]?.color ?? '#ffffff';
      const line = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
      );
      this.scene.add(line);
      this.perimeters.set(base.id, { line, faction: base.factionId });
    }
  }

  private armyKey(a: Army): string {
    let tank = 0;
    let jeep = 0;
    let inf = 0;
    let truck = 0;
    for (const u of a.units) {
      const f = statsOf(u.designId).family;
      if (f === 'tank') tank++;
      else if (f === 'light_vehicle') jeep++;
      else if (f === 'support') truck++;
      else inf++;
    }
    return `${a.factionId}|${Math.min(tank, 2)}|${Math.min(jeep, 1)}|${Math.min(inf, 3)}|${Math.min(truck, 1)}`;
  }

  private makeArmy(a: Army, state: CampaignState): THREE.Group {
    const def = FACTION_DEFS[state.factions[a.factionId]?.defId ?? ''];
    const tint = def?.vehicleTint ?? '#777766';
    const uni = def?.uniformTint ?? '#666655';
    const color = state.factions[a.factionId]?.color ?? '#ffffff';
    const g = new THREE.Group();
    const [, tankS, jeepS, infS, truckS] = this.armyKey(a).split('|');
    const tanks = Number(tankS);
    const jeeps = Number(jeepS);
    const inf = Number(infS);
    const trucks = Number(truckS);
    const models = new THREE.Group();
    const slots: [number, number][] = [
      [0, 0.5],
      [-1.1, -0.4],
      [1.1, -0.4],
      [0, -1.3],
      [-1.1, 1.1],
      [1.1, 1.1],
    ];
    let si = 0;
    const place = (m: THREE.Object3D): void => {
      const [x, z] = slots[si++ % slots.length];
      m.position.set(x, 0, z);
      models.add(m);
    };
    for (let k = 0; k < tanks; k++) {
      const t = new THREE.Group();
      const hull = new THREE.Mesh(Models.tankHull(tint), Materials.standard);
      const tur = new THREE.Mesh(Models.tankTurret(tint), Materials.standard);
      tur.position.y = TANK_TURRET_HEIGHT;
      t.add(hull, tur);
      t.scale.setScalar(CAMPAIGN_VEHICLE_SCALE);
      place(t);
    }
    for (let k = 0; k < jeeps; k++) {
      const j = new THREE.Mesh(Models.jeep(tint), Materials.standard);
      j.scale.setScalar(CAMPAIGN_VEHICLE_SCALE * 1.15);
      place(j);
    }
    for (let k = 0; k < trucks; k++) {
      const t = new THREE.Mesh(Models.truck(tint), Materials.standard);
      t.scale.setScalar(CAMPAIGN_VEHICLE_SCALE * 1.1);
      place(t);
    }
    for (let k = 0; k < inf; k++) {
      const sq = new THREE.Group();
      for (const [x, z] of [
        [0, 0],
        [0.35, -0.25],
        [-0.35, -0.25],
      ] as const) {
        const s = new THREE.Mesh(Models.soldier(uni), Materials.standard);
        s.scale.setScalar(CAMPAIGN_SOLDIER_SCALE);
        s.position.set(x, 0, z);
        sq.add(s);
      }
      place(sq);
    }
    models.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    g.add(models);
    // standard / banner
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.2, 5), new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
    pole.position.set(-0.2, 1.6, -0.2);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 1.1), new THREE.MeshLambertMaterial({ color }));
    flag.position.set(-0.2, 2.75, 0.35);
    flag.name = 'flag';
    g.add(flag);
    const ring = new THREE.Mesh(buildRing(1.5, 1.75, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.06;
    g.add(ring);
    return g;
  }

  private syncArmies(state: CampaignState, dt: number): void {
    const seen = new Set<string>();
    for (const a of Object.values(state.armies)) {
      const visible = a.factionId === this.playerFaction || isVisibleToFaction(state, this.playerFaction, a.x, a.z);
      let v = this.armyObjs.get(a.id);
      const key = this.armyKey(a);
      if (!v || v.key !== key) {
        if (v) this.scene.remove(v.group);
        const group = this.makeArmy(a, state);
        v = { group, key, heading: 0, pos: new THREE.Vector3(a.x, this.h(a.x, a.z), a.z) };
        this.scene.add(group);
        this.armyObjs.set(a.id, v);
      }
      seen.add(a.id);
      v.group.visible = visible;
      // smooth movement & heading
      const k = 1 - Math.exp(-dt * 10);
      const tx = a.x;
      const tz = a.z;
      const dx = tx - v.pos.x;
      const dz = tz - v.pos.z;
      if (dx * dx + dz * dz > 400) v.pos.set(tx, 0, tz);
      v.pos.x += dx * k;
      v.pos.z += dz * k;
      v.pos.y = this.h(v.pos.x, v.pos.z);
      if (a.path.length > 0) {
        const wp = a.path[0];
        const want = Math.atan2(wp.x - a.x, wp.z - a.z);
        let d = want - v.heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        v.heading += d * Math.min(1, dt * 4);
      }
      v.group.position.copy(v.pos);
      const models = v.group.children[0];
      models.rotation.y = v.heading;
      const moving = a.path.length > 0;
      models.position.y = moving ? Math.abs(Math.sin(this.time * 9 + a.x)) * 0.08 : 0;
      const flag = v.group.getObjectByName('flag');
      if (flag) flag.rotation.y = Math.sin(this.time * 3 + a.z) * 0.25;
    }
    for (const [id, v] of this.armyObjs) {
      if (!seen.has(id)) {
        this.scene.remove(v.group);
        this.armyObjs.delete(id);
      }
    }
  }

  private syncConvoys(state: CampaignState): void {
    const seen = new Set<string>();
    for (const c of Object.values(state.convoys)) {
      seen.add(c.id);
      let m = this.convoyObjs.get(c.id);
      if (!m) {
        const def = FACTION_DEFS[state.factions[c.factionId]?.defId ?? ''];
        m = new THREE.Mesh(Models.truck(def?.vehicleTint ?? '#777766'), Materials.standard);
        m.scale.setScalar(CAMPAIGN_VEHICLE_SCALE * 1.1);
        m.castShadow = true;
        this.scene.add(m);
        this.convoyObjs.set(c.id, m);
      }
      m.visible = c.factionId === this.playerFaction || isVisibleToFaction(state, this.playerFaction, c.x, c.z);
      m.position.set(c.x, this.h(c.x, c.z) + 0.05, c.z);
      if (c.path.length) m.rotation.y = Math.atan2(c.path[0].x - c.x, c.path[0].z - c.z);
    }
    for (const [id, m] of this.convoyObjs) {
      if (!seen.has(id)) {
        this.scene.remove(m);
        this.convoyObjs.delete(id);
      }
    }
  }

  private syncSelection(state: CampaignState): void {
    const pulse = 1 + Math.sin(this.time * 5) * 0.05;
    this.selRing.visible = false;
    this.destMarker.visible = false;
    this.pathLine.visible = false;
    const army = this.selectedArmyId ? state.armies[this.selectedArmyId] : undefined;
    if (army) {
      const v = this.armyObjs.get(army.id);
      const p = v ? v.pos : new THREE.Vector3(army.x, this.h(army.x, army.z), army.z);
      this.selRing.visible = true;
      this.selRing.position.set(p.x, p.y + 0.1, p.z);
      this.selRing.scale.setScalar(2.2 * pulse);
      if (army.path.length > 0 && army.factionId === this.playerFaction) {
        const end = army.path[army.path.length - 1];
        this.destMarker.visible = true;
        this.destMarker.position.set(end.x, this.h(end.x, end.z), end.z);
        const pts = [p.clone().setY(p.y + 0.25)];
        for (const wp of army.path) pts.push(new THREE.Vector3(wp.x, this.h(wp.x, wp.z) + 0.25, wp.z));
        this.pathLine.geometry.dispose();
        this.pathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        this.pathLine.computeLineDistances();
        this.pathLine.visible = true;
      }
      return;
    }
    const b = this.selectedBuildingId ? state.buildings[this.selectedBuildingId] : undefined;
    if (b) {
      this.selRing.visible = true;
      this.selRing.position.set(b.x, this.h(b.x, b.z) + 0.12, b.z);
      this.selRing.scale.setScalar((BUILDINGS[b.typeId].footprint + 0.4) * pulse);
      return;
    }
    const base = this.selectedBaseId ? state.bases[this.selectedBaseId] : undefined;
    if (base) {
      this.selRing.visible = true;
      this.selRing.position.set(base.x, this.h(base.x, base.z) + 0.15, base.z);
      this.selRing.scale.setScalar(base.radius * 0.6 * pulse);
      return;
    }
    const site = this.selectedSiteId ? state.sites[this.selectedSiteId] : undefined;
    if (site) {
      this.selRing.visible = true;
      this.selRing.position.set(site.x, this.h(site.x, site.z) + 0.12, site.z);
      this.selRing.scale.setScalar(2 * pulse);
    }
  }

  /** Placement preview for a building (null to hide). */
  setGhost(typeId: BuildingTypeId | null, x = 0, z = 0, valid = true, accent = '#3f86c0', rot = 0): void {
    if (!typeId) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const key = typeId;
    if (!this.ghost || this.ghostKey !== key) {
      if (this.ghost) this.scene.remove(this.ghost);
      this.ghost = new THREE.Mesh(Models.building(typeId, accent, null), Materials.ghostOk);
      this.ghost.scale.setScalar(CAMPAIGN_BUILDING_SCALE);
      this.ghost.renderOrder = 10;
      this.scene.add(this.ghost);
      this.ghostKey = key;
    }
    this.ghost.visible = true;
    this.ghost.material = valid ? Materials.ghostOk : Materials.ghostBad;
    this.ghost.position.set(x, this.h(x, z) + 0.05, z);
    this.ghost.rotation.y = rot;
  }

  // ---------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------

  update(dt: number): void {
    this.rig.update(dt);
    const d = this.rig.dist;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 1.4 + 20;
    fog.far = d * 4.2 + 120;
    const t = this.rig.target;
    if (this.gr.profile.shadows) {
      const span = clamp(d * 0.9, 20, 160);
      const cam = this.sun.shadow.camera;
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 1;
      cam.far = 600;
      cam.updateProjectionMatrix();
    }
    const L = this.daylight.toLight;
    this.sun.position.set(t.x + L.x * 240, t.y + L.y * 240, t.z + L.z * 240);
    this.sun.target.position.copy(t);
  }

  /** Time-of-day lighting (local hour 0..24). */
  setHour(hour: number): void {
    this.daylight.set(hour);
  }

  render(): void {
    this.gr.render(this.scene, this.rig.camera);
  }

  resize(): void {
    this.rig.setAspect(this.gr.aspect);
  }

  // ---------------------------------------------------------------------------
  // Projection & picking
  // ---------------------------------------------------------------------------

  /** Screen position (CSS pixels) of a world point, or null if behind the camera. */
  toScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    tmpV.set(x, y, z).project(this.rig.camera);
    if (tmpV.z > 1 || tmpV.z < -1) return null;
    return { x: ((tmpV.x + 1) / 2) * this.gr.width, y: ((1 - tmpV.y) / 2) * this.gr.height };
  }

  armyScreenPos(id: string): { x: number; y: number } | null {
    const v = this.armyObjs.get(id);
    if (!v || !v.group.visible) return null;
    return this.toScreen(v.pos.x, v.pos.y + 3.6, v.pos.z);
  }

  isArmyVisible(id: string): boolean {
    return this.armyObjs.get(id)?.group.visible ?? false;
  }

  /** Ray-march the heightfield under a screen point. */
  groundAt(sx: number, sy: number): { x: number; z: number } | null {
    const ndc = new THREE.Vector2((sx / this.gr.width) * 2 - 1, -(sy / this.gr.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    const t = this.terrain;
    let prevT = 0;
    const step = Math.max(0.25, this.rig.dist / 300);
    for (let s = 0; s < 4000; s++) {
      const tt = s * step;
      const x = o.x + d.x * tt;
      const y = o.y + d.y * tt;
      const z = o.z + d.z * tt;
      const ground = Math.max(0, heightAt(t, x, z));
      if (y <= ground) {
        // refine
        let lo = prevT;
        let hi = tt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          const my = o.y + d.y * mid;
          const mx = o.x + d.x * mid;
          const mz = o.z + d.z * mid;
          if (my <= Math.max(0, heightAt(t, mx, mz))) hi = mid;
          else lo = mid;
        }
        return { x: o.x + d.x * hi, z: o.z + d.z * hi };
      }
      if (y < -20) break;
      prevT = tt;
    }
    return null;
  }

  pick(sx: number, sy: number, state: CampaignState, touch: boolean): PickResult | null {
    const tol = touch ? 34 : 22;
    let best: PickResult | null = null;
    let bd = tol;
    for (const a of Object.values(state.armies)) {
      const v = this.armyObjs.get(a.id);
      if (!v || !v.group.visible) continue;
      for (const yOff of [0.6, 3.4]) {
        const p = this.toScreen(v.pos.x, v.pos.y + yOff, v.pos.z);
        if (!p) continue;
        const d = Math.hypot(p.x - sx, p.y - sy);
        if (d < bd) {
          bd = d;
          best = { kind: 'army', id: a.id, x: a.x, z: a.z };
        }
      }
    }
    if (best) return best;
    for (const c of Object.values(state.convoys)) {
      const m = this.convoyObjs.get(c.id);
      if (!m || !m.visible) continue;
      const p = this.toScreen(c.x, m.position.y + 0.3, c.z);
      if (!p) continue;
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < tol * 0.6) return { kind: 'convoy', id: c.id, x: c.x, z: c.z };
    }
    const g = this.groundAt(sx, sy);
    if (!g) return null;
    // buildings (by footprint)
    let bb: Building | null = null;
    let bbd = Infinity;
    for (const b of Object.values(state.buildings)) {
      const d = dist(b.x, b.z, g.x, g.z);
      const r = BUILDINGS[b.typeId].footprint * 1.25 + (touch ? 0.4 : 0);
      if (d < r && d < bbd) {
        bbd = d;
        bb = b;
      }
    }
    if (bb) return { kind: 'building', id: bb.id, x: g.x, z: g.z };
    for (const s of Object.values(state.sites)) {
      if (dist(s.x, s.z, g.x, g.z) < (touch ? 3 : 2.2)) {
        if (s.buildingId && state.buildings[s.buildingId]) return { kind: 'building', id: s.buildingId, x: g.x, z: g.z };
        return { kind: 'site', id: s.id, x: g.x, z: g.z };
      }
    }
    for (const base of Object.values(state.bases)) {
      if (dist(base.x, base.z, g.x, g.z) <= base.radius) return { kind: 'base', id: base.id, x: g.x, z: g.z };
    }
    return { kind: 'ground', x: g.x, z: g.z };
  }

  /** World position under the screen centre (for zoom anchors). */
  heightAtWorld(x: number, z: number): number {
    return this.h(x, z);
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry && !(m instanceof THREE.InstancedMesh)) {
        // shared model geometries are cached; only dispose unique ones
        if (m === this.terrainMesh || m === this.water || m === this.roadMesh) m.geometry.dispose();
      }
    });
    this.damagedMat.dispose();
  }
}

