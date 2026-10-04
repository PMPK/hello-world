import * as THREE from 'three';
import { clamp, dist } from '../core/math';
import { mixSeed, Rng } from '../core/rng';
import { BUILDINGS } from '../data/buildings';
import { FACTION_DEFS } from '../data/factions';
import type { WeaponClass } from '../data/components';
import { BIOME } from '../world/terrain';
import type { BattleSim } from '../battle/sim';
import { bHeight, type BattleTerrain } from '../battle/terrain';
import type { BUnit, SideIndex } from '../battle/types';
import { CameraRig } from '../input/cameraRig';
import { Effects } from './effects';
import { Materials } from './models/builder';
import { Models } from './models/cache';
import { buildRing, TANK_TURRET_HEIGHT } from './models/units';
import { makeLights, type GameRenderer } from './renderer';

/** Visual exaggeration of units on the battlefield for readability. */
export const UNIT_VIS_SCALE = { infantry: 1.75, light_vehicle: 1.35, tank: 1.15, support: 1.3 } as const;

const WRECK = new THREE.Color(0.24, 0.22, 0.2);
const WHITE = new THREE.Color(1, 1, 1);

interface SideMeshes {
  soldiers: THREE.InstancedMesh;
  jeeps: THREE.InstancedMesh;
  hulls: THREE.InstancedMesh;
  turrets: THREE.InstancedMesh;
  trucks: THREE.InstancedMesh;
}

/** Optional sound sink for battle events (implemented by the audio engine). */
export interface BattleSound {
  shot(kind: WeaponClass, x: number, y: number, z: number): void;
  explosion(x: number, y: number, z: number, size: number, delay?: number): void;
}

export type BattlePick = { kind: 'unit'; id: number } | { kind: 'building'; id: number } | { kind: 'ground'; x: number; z: number };

/** Renders a BattleSim. Reads simulation state; owns no game logic. */
export class BattleView {
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly effects: Effects;
  private readonly t: BattleTerrain;
  private sun!: THREE.DirectionalLight;
  private sides: [SideMeshes, SideMeshes];
  private buildingObjs = new Map<number, { obj: THREE.Object3D; key: string }>();
  private turretObjs = new Map<number, THREE.Mesh>();
  private selRings: THREE.InstancedMesh;
  private time = 0;
  private damagedMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: 0x8f7d72 });
  private smokeTimer = 0;
  private readonly tm = new THREE.Matrix4();
  private readonly tq = new THREE.Quaternion();
  private readonly ts = new THREE.Vector3();
  private readonly tp = new THREE.Vector3();
  private readonly te = new THREE.Euler();
  private readonly tv = new THREE.Vector3();
  selected = new Set<number>();
  readonly playerSide: SideIndex;

  constructor(
    private readonly gr: GameRenderer,
    private readonly sim: BattleSim,
    playerSide: SideIndex | null,
    private readonly sound: BattleSound | null = null,
  ) {
    this.playerSide = playerSide ?? 1;
    this.t = sim.terrain;
    const t = this.t;
    this.rig = new CameraRig(gr.aspect, {
      minDist: 22,
      maxDist: 560,
      minX: 0,
      maxX: t.size,
      minZ: 0,
      maxZ: t.size,
      pitchNear: 0.5,
      pitchFar: 1.12,
    });
    this.rig.heightAt = (x, z) => Math.max(0, bHeight(t, x, z));
    const bg = new THREE.Color(0xa4b5bc);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 400, 1400);
    this.sun = makeLights(this.scene, gr.profile, 500).sun;
    this.buildTerrain();
    this.buildVegetation();
    this.effects = new Effects(gr.profile.effects);
    this.scene.add(this.effects.group);

    const counts = [0, 1].map((s) => {
      const c = { inf: 0, jeep: 0, tank: 0, truck: 0 };
      for (const u of sim.units) {
        if (u.side !== s) continue;
        if (u.stats.family === 'infantry') c.inf++;
        else if (u.stats.family === 'light_vehicle') c.jeep++;
        else if (u.stats.family === 'support') c.truck++;
        else c.tank++;
      }
      return c;
    });
    this.sides = [0, 1].map((s) => {
      const side = sim.setup.sides[s];
      const def = FACTION_DEFS[side.factionId];
      const tint = def?.vehicleTint ?? side.vehicleTint;
      const uni = def?.uniformTint ?? side.uniformTint;
      const mk = (geo: THREE.BufferGeometry, n: number): THREE.InstancedMesh => {
        const m = new THREE.InstancedMesh(geo, Materials.standard, Math.max(1, n));
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.setColorAt(0, WHITE);
        m.count = 0;
        m.castShadow = true;
        m.frustumCulled = false;
        this.scene.add(m);
        return m;
      };
      return {
        soldiers: mk(Models.soldier(uni), counts[s].inf * 6),
        jeeps: mk(Models.jeep(tint), counts[s].jeep),
        hulls: mk(Models.tankHull(tint), counts[s].tank),
        turrets: mk(Models.tankTurret(tint), counts[s].tank),
        trucks: mk(Models.truck(tint), counts[s].truck),
      };
    }) as [SideMeshes, SideMeshes];

    this.selRings = new THREE.InstancedMesh(
      buildRing(0.86, 1, 28),
      new THREE.MeshBasicMaterial({ color: 0x9cf0b0, transparent: true, opacity: 0.65, depthWrite: false }),
      Math.max(1, sim.units.length),
    );
    this.selRings.count = 0;
    this.selRings.frustumCulled = false;
    this.selRings.renderOrder = 4;
    this.scene.add(this.selRings);

    this.syncBuildings();
    // look from behind our deployed force toward the enemy, with the force
    // slightly below the screen centre (clear of the command bar on phones)
    const e = sim.setup.sides[this.playerSide].entry;
    let cx = 0;
    let cz = 0;
    let n = 0;
    for (const u of sim.units) {
      if (u.side !== this.playerSide || !u.alive || u.reserve) continue;
      cx += u.x;
      cz += u.z;
      n++;
    }
    if (n) {
      cx /= n;
      cz /= n;
    } else {
      cx = e.x;
      cz = e.z;
    }
    this.rig.setYaw(Math.atan2(-e.dirX, -e.dirZ));
    this.rig.jumpTo(cx + e.dirX * 25, cz + e.dirZ * 25, 230);
  }

  // ---------------------------------------------------------------------------

  private buildTerrain(): void {
    const t = this.t;
    const verts = t.grid + 1;
    const pos = new Float32Array(t.grid * t.grid * 18);
    const col = new Float32Array(t.grid * t.grid * 18);
    const rng = new Rng(mixSeed(this.sim.setup.seed, 'bt-col'));
    const c = new THREE.Color();
    const pads = this.sim.buildings.map((b) => ({ x: b.x, z: b.z, r: BUILDINGS[b.spec.typeId].battleFootprint + 7 }));
    let k = 0;
    const tri = (pts: number[][], cell: number): void => {
      const hAvg = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
      const slope = (Math.max(pts[0][1], pts[1][1], pts[2][1]) - Math.min(pts[0][1], pts[1][1], pts[2][1])) / t.cell;
      const b = t.biome[cell];
      const forest = t.forest[cell] / 255;
      const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
      const cz = (pts[0][2] + pts[1][2] + pts[2][2]) / 3;
      if (t.water[cell]) c.set(0x9c8f6c).lerp(new THREE.Color(0x3c5a5c), clamp(-hAvg / 6, 0, 1));
      else if (b === BIOME.beach) c.set(0xbcae80);
      else if (b === BIOME.mountains || b === BIOME.snow || slope > 0.75) c.set(slope > 0.9 ? 0x6f6a62 : 0x837d70);
      else if (b === BIOME.hills) c.set(0x8a8c58);
      else c.set(0x84a055).lerp(new THREE.Color(0x9b9c62), clamp(hAvg / 40, 0, 1));
      if (forest > 0) c.lerp(new THREE.Color(0x3d5530), clamp(forest * 1.1, 0, 0.85));
      for (const p of pads) {
        const d = dist(p.x, p.z, cx, cz);
        if (d < p.r) c.lerp(new THREE.Color(0x77736a), clamp(1 - d / p.r, 0, 1) * 0.8);
      }
      const j = 1 + (rng.next() - 0.5) * 0.07;
      for (const p of pts) {
        pos.set(p, k);
        col.set([c.r * j, c.g * j, c.b * j], k);
        k += 3;
      }
    };
    for (let j = 0; j < t.grid; j++) {
      for (let i = 0; i < t.grid; i++) {
        const x0 = i * t.cell;
        const x1 = x0 + t.cell;
        const z0 = j * t.cell;
        const z1 = z0 + t.cell;
        const h = (ii: number, jj: number): number => t.heights[jj * verts + ii];
        const a = [x0, h(i, j), z0];
        const b = [x1, h(i + 1, j), z0];
        const cc = [x0, h(i, j + 1), z1];
        const d = [x1, h(i + 1, j + 1), z1];
        const cell = j * t.grid + i;
        if ((i + j) % 2 === 0) {
          tri([a, cc, b], cell);
          tri([b, cc, d], cell);
        } else {
          tri([a, cc, d], cell);
          tri([a, d, b], cell);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    // surrounding ground skirt so the map edge does not float in the void
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(t.size * 6, t.size * 6), new THREE.MeshLambertMaterial({ color: 0x6f7d58 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.set(t.size / 2, -3, t.size / 2);
    this.scene.add(skirt);
    if (t.water.some((w) => w === 1)) {
      const water = new THREE.Mesh(
        new THREE.PlaneGeometry(t.size * 6, t.size * 6),
        new THREE.MeshStandardMaterial({ color: 0x2f6a80, roughness: 0.25, metalness: 0.05, transparent: true, opacity: 0.82 }),
      );
      water.rotation.x = -Math.PI / 2;
      water.position.set(t.size / 2, 0, t.size / 2);
      this.scene.add(water);
    }
  }

  private buildVegetation(): void {
    const t = this.t;
    const rng = new Rng(mixSeed(this.sim.setup.seed, 'bt-trees'));
    const density = this.gr.profile.treeDensity;
    const con: THREE.Matrix4[] = [];
    const brd: THREE.Matrix4[] = [];
    const rocks: THREE.Matrix4[] = [];
    for (let j = 0; j < t.grid; j++) {
      for (let i = 0; i < t.grid; i++) {
        const cell = j * t.grid + i;
        const f = t.forest[cell] / 255;
        if (f > 0 && !t.blocked[cell]) {
          let n = (0.9 + f * 1.5) * density;
          for (; n > 0; n--) {
            if (n < 1 && rng.next() > n) break;
            const x = (i + rng.next()) * t.cell;
            const z = (j + rng.next()) * t.cell;
            const s = rng.range(0.85, 1.35);
            this.tq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6.28));
            const m = new THREE.Matrix4().compose(this.tp.set(x, bHeight(t, x, z) - 0.2, z), this.tq, this.ts.set(s, s * rng.range(0.9, 1.3), s));
            (rng.next() < 0.6 ? con : brd).push(m);
          }
        } else if (!t.water[cell] && rng.next() < 0.012 * density) {
          const x = (i + rng.next()) * t.cell;
          const z = (j + rng.next()) * t.cell;
          const s = rng.range(0.8, 2.2);
          this.tq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, 6.28));
          rocks.push(new THREE.Matrix4().compose(this.tp.set(x, bHeight(t, x, z), z), this.tq, this.ts.set(s, s, s)));
        }
      }
    }
    const make = (geo: THREE.BufferGeometry, list: THREE.Matrix4[], shadow: boolean): void => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, Materials.standard, list.length);
      list.forEach((m, k) => im.setMatrixAt(k, m));
      im.castShadow = shadow;
      im.computeBoundingSphere();
      this.scene.add(im);
    };
    make(Models.conifer(), con, this.gr.profile.treeShadows);
    make(Models.broadleaf(), brd, this.gr.profile.treeShadows);
    make(Models.rock(), rocks, true);
  }

  private syncBuildings(): void {
    for (const b of this.sim.buildings) {
      const def = BUILDINGS[b.spec.typeId];
      const hpF = b.maxHp > 0 ? b.hp / b.maxHp : 0;
      const key = `${b.destroyed}|${hpF < 0.5}`;
      const cur = this.buildingObjs.get(b.id);
      if (cur && cur.key === key) continue;
      if (cur) this.scene.remove(cur.obj);
      this.turretObjs.delete(b.id);
      const accent = FACTION_DEFS[b.spec.factionId]?.structureAccent ?? '#888888';
      let obj: THREE.Object3D;
      if (b.destroyed) {
        obj = new THREE.Mesh(Models.rubble(def.battleFootprint, b.id), Materials.standard);
      } else {
        const g = new THREE.Group();
        // crewed gun emplacements get a separately traversing gun
        const turretGeo = b.defense ? Models.defenseTurret(b.spec.typeId) : null;
        const m = new THREE.Mesh(Models.building(b.spec.typeId, accent, b.spec.siteKind, !!turretGeo), hpF < 0.5 ? this.damagedMat : Materials.standard);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
        if (turretGeo) {
          const gun = new THREE.Mesh(turretGeo, Materials.standard);
          gun.castShadow = true;
          g.add(gun);
          this.turretObjs.set(b.id, gun);
        }
        if (b.spec.state === 'construction') {
          m.scale.y = 0.4;
          g.add(new THREE.Mesh(Models.scaffold(def.battleFootprint), Materials.standard));
        }
        obj = g;
      }
      obj.castShadow = true;
      obj.position.set(b.x, bHeight(this.t, b.x, b.z), b.z);
      obj.rotation.y = b.rot;
      this.scene.add(obj);
      this.buildingObjs.set(b.id, { obj, key });
    }
  }

  // ---------------------------------------------------------------------------

  private visibleToPlayer(u: BUnit): boolean {
    if (u.side === this.playerSide) return true;
    return u.seenBy[this.playerSide];
  }

  /** Read sim state, drain events into effects. */
  sync(dt: number): void {
    this.time += dt;
    const sim = this.sim;
    for (const ev of sim.takeEvents()) {
      if (ev.type === 'shot') {
        // gunfire is heard even when the shooter cannot be seen
        this.sound?.shot(ev.weapon, ev.fromX, ev.fromY, ev.fromZ);
        const shooter = sim.unitById(ev.shooter);
        // hide muzzle flashes of unseen enemies but show incoming tracers' end
        if (shooter && !this.visibleToPlayer(shooter)) {
          if (ev.hit || ev.weapon === 'cannon') this.effects.puff(ev.toX, ev.toY, ev.toZ, 0.6, 0.15, 0, 0xffd27a, 0x8a7a60);
          continue;
        }
        this.effects.shot(ev.weapon, ev.fromX, ev.fromY, ev.fromZ, ev.toX, ev.toY, ev.toZ, ev.travel);
        if (!ev.hit && (ev.weapon === 'small_arms' || ev.weapon === 'mg' || ev.weapon === 'hmg')) {
          // dust kicks
          this.effects.puff(ev.toX, ev.toY, ev.toZ, 0.5, 0.5, 0.6, 0xb8a888, 0x9a8f7a);
        }
      } else if (ev.type === 'explosion') {
        this.effects.explosion(ev.x, ev.y, ev.z, ev.size, ev.delay);
        this.sound?.explosion(ev.x, ev.y, ev.z, ev.size, ev.delay);
      } else if (ev.type === 'building_destroyed') {
        this.syncBuildings();
      }
    }
    // smoke from wrecks and burning buildings
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.35;
      for (const u of sim.units) {
        if (!u.alive && u.stats.isVehicle && Math.random() < 0.5) {
          this.effects.puff(u.x + (Math.random() - 0.5) * 2, bHeight(this.t, u.x, u.z) + 2.5, u.z, 2.2, 3.5, 9, 0x3a3632, 0x7b7874);
        }
      }
      for (const b of sim.buildings) {
        const hpF = b.maxHp > 0 ? b.hp / b.maxHp : 0;
        if ((b.destroyed || hpF < 0.5) && Math.random() < 0.6) {
          this.effects.puff(b.x + (Math.random() - 0.5) * b.radius, bHeight(this.t, b.x, b.z) + 5, b.z + (Math.random() - 0.5) * b.radius, 4, 5, 16, 0x34302c, 0x86827e);
        }
      }
    }
    this.syncBuildings();
    for (const [id, gun] of this.turretObjs) {
      const b = sim.buildingById(id);
      if (b?.defense) gun.rotation.y = b.defense.turret - b.rot;
    }
    this.syncUnits();
    this.effects.update(dt);
  }

  private syncUnits(): void {
    const sim = this.sim;
    const n = [
      { s: 0, j: 0, h: 0, t: 0 },
      { s: 0, j: 0, h: 0, t: 0 },
    ];
    let rings = 0;
    for (const u of sim.units) {
      if (u.reserve || u.retreated) continue;
      const visible = this.visibleToPlayer(u) || (!u.alive && u.stats.isVehicle);
      if (!visible) continue;
      if (!u.alive && !u.stats.isVehicle) continue;
      const meshes = this.sides[u.side];
      const cnt = n[u.side];
      const y = bHeight(this.t, u.x, u.z);
      const fam = u.stats.family;
      if (fam === 'infantry') {
        const sc = UNIT_VIS_SCALE.infantry;
        const moving = u.speedNow > 0.4;
        const spread = u.inForest ? 7 : 5.5;
        for (let k = 0; k < u.men; k++) {
          const ang = u.heading + Math.PI + ((k - (u.men - 1) / 2) * 0.55);
          const r = k === 0 ? 0 : spread * (0.6 + (((u.id * 7 + k * 13) % 10) / 10) * 0.6);
          const ox = k === 0 ? 0 : Math.sin(ang) * r;
          const oz = k === 0 ? 0 : Math.cos(ang) * r;
          const px = u.x + ox;
          const pz = u.z + oz;
          const bob = moving ? Math.abs(Math.sin(this.time * 9 + k * 1.7 + u.id)) * 0.25 : 0;
          const prone = !moving && u.suppression > 0.5;
          this.te.set(prone ? Math.PI / 2.3 : 0, u.heading, 0, 'YXZ');
          this.tq.setFromEuler(this.te);
          this.ts.set(sc, sc, sc);
          this.tp.set(px, bHeight(this.t, px, pz) + bob + (prone ? 0.3 : 0), pz);
          this.tm.compose(this.tp, this.tq, this.ts);
          meshes.soldiers.setMatrixAt(cnt.s, this.tm);
          meshes.soldiers.setColorAt(cnt.s, WHITE);
          cnt.s++;
        }
      } else if (fam === 'support') {
        const sc = UNIT_VIS_SCALE.support;
        this.te.set(0, u.heading, u.alive ? 0 : 0.2, 'YXZ');
        this.tq.setFromEuler(this.te);
        this.ts.set(sc, sc, sc);
        this.tp.set(u.x, y, u.z);
        this.tm.compose(this.tp, this.tq, this.ts);
        meshes.trucks.setMatrixAt(cnt.t, this.tm);
        meshes.trucks.setColorAt(cnt.t, u.alive ? WHITE : WRECK);
        cnt.t++;
      } else if (fam === 'light_vehicle') {
        const sc = UNIT_VIS_SCALE.light_vehicle;
        this.te.set(0, u.heading, u.alive ? 0 : 0.25, 'YXZ');
        this.tq.setFromEuler(this.te);
        this.ts.set(sc, sc, sc);
        this.tp.set(u.x, y + (u.speedNow > 1 ? Math.sin(this.time * 20 + u.id) * 0.05 : 0), u.z);
        this.tm.compose(this.tp, this.tq, this.ts);
        meshes.jeeps.setMatrixAt(cnt.j, this.tm);
        meshes.jeeps.setColorAt(cnt.j, u.alive ? WHITE : WRECK);
        cnt.j++;
      } else {
        const sc = UNIT_VIS_SCALE.tank;
        this.te.set(0, u.heading, 0, 'YXZ');
        this.tq.setFromEuler(this.te);
        this.ts.set(sc, sc, sc);
        this.tp.set(u.x, y, u.z);
        this.tm.compose(this.tp, this.tq, this.ts);
        meshes.hulls.setMatrixAt(cnt.h, this.tm);
        meshes.hulls.setColorAt(cnt.h, u.alive ? WHITE : WRECK);
        this.te.set(0, u.alive ? u.turret : u.turret + 0.6, 0, 'YXZ');
        this.tq.setFromEuler(this.te);
        this.tp.set(u.x, y + TANK_TURRET_HEIGHT * sc, u.z);
        this.tm.compose(this.tp, this.tq, this.ts);
        meshes.turrets.setMatrixAt(cnt.h, this.tm);
        meshes.turrets.setColorAt(cnt.h, u.alive ? WHITE : WRECK);
        cnt.h++;
      }
      if (u.alive && this.selected.has(u.id)) {
        const r = u.stats.isVehicle ? u.stats.size * 1.05 : 7.5;
        this.tq.identity();
        this.ts.set(r, 1, r);
        this.tp.set(u.x, y + 0.4, u.z);
        this.tm.compose(this.tp, this.tq, this.ts);
        this.selRings.setMatrixAt(rings++, this.tm);
      }
    }
    for (const s of [0, 1] as SideIndex[]) {
      const m = this.sides[s];
      m.soldiers.count = n[s].s;
      m.jeeps.count = n[s].j;
      m.hulls.count = n[s].h;
      m.turrets.count = n[s].h;
      m.trucks.count = n[s].t;
      for (const im of [m.soldiers, m.jeeps, m.hulls, m.turrets, m.trucks]) {
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
      }
    }
    this.selRings.count = rings;
    this.selRings.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.rig.update(dt);
    const d = this.rig.dist;
    const fog = this.scene.fog as THREE.Fog;
    fog.near = d * 1.6 + 150;
    fog.far = d * 4 + 700;
    const tgt = this.rig.target;
    if (this.gr.profile.shadows) {
      const span = clamp(d * 1.1, 60, 420);
      const cam = this.sun.shadow.camera;
      cam.left = -span;
      cam.right = span;
      cam.top = span;
      cam.bottom = -span;
      cam.near = 10;
      cam.far = 2000;
      cam.updateProjectionMatrix();
    }
    this.sun.position.set(tgt.x - 300, tgt.y + 520, tgt.z + 220);
    this.sun.target.position.copy(tgt);
  }

  render(): void {
    this.gr.render(this.scene, this.rig.camera);
  }

  resize(): void {
    this.rig.setAspect(this.gr.aspect);
  }

  toScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    this.tv.set(x, y, z).project(this.rig.camera);
    if (this.tv.z > 1 || this.tv.z < -1) return null;
    return { x: ((this.tv.x + 1) / 2) * this.gr.width, y: ((1 - this.tv.y) / 2) * this.gr.height };
  }

  unitScreen(u: BUnit, lift = 0): { x: number; y: number } | null {
    const top = u.stats.isVehicle ? (u.stats.family === 'tank' ? 4.2 : 3.4) : 3.6;
    return this.toScreen(u.x, bHeight(this.t, u.x, u.z) + top + lift, u.z);
  }

  groundAt(sx: number, sy: number): { x: number; z: number } | null {
    const ndc = new THREE.Vector2((sx / this.gr.width) * 2 - 1, -(sy / this.gr.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.rig.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    const step = Math.max(0.6, this.rig.dist / 250);
    let prev = 0;
    for (let s = 0; s < 5000; s++) {
      const tt = s * step;
      const x = o.x + d.x * tt;
      const y = o.y + d.y * tt;
      const z = o.z + d.z * tt;
      const g = Math.max(0, bHeight(this.t, x, z));
      if (y <= g) {
        let lo = prev;
        let hi = tt;
        for (let k = 0; k < 10; k++) {
          const mid = (lo + hi) / 2;
          if (o.y + d.y * mid <= Math.max(0, bHeight(this.t, o.x + d.x * mid, o.z + d.z * mid))) hi = mid;
          else lo = mid;
        }
        return { x: clamp(o.x + d.x * hi, 0, this.t.size), z: clamp(o.z + d.z * hi, 0, this.t.size) };
      }
      if (y < -30) break;
      prev = tt;
    }
    return null;
  }

  /** Pick the unit/building/ground under a screen point. `preferSide` wins ties. */
  pick(sx: number, sy: number, touch: boolean, preferSide: SideIndex | null = null): BattlePick | null {
    const tol = touch ? 30 : 18;
    let best: BUnit | null = null;
    let bd = tol;
    for (const u of this.sim.units) {
      if (!u.alive || u.retreated || u.reserve || !this.visibleToPlayer(u)) continue;
      const ground = bHeight(this.t, u.x, u.z);
      for (const lift of [1, 3.5]) {
        const p = this.toScreen(u.x, ground + lift, u.z);
        if (!p) continue;
        let d = Math.hypot(p.x - sx, p.y - sy);
        if (preferSide !== null && u.side === preferSide) d *= 0.85;
        if (d < bd) {
          bd = d;
          best = u;
        }
      }
    }
    if (best) return { kind: 'unit', id: best.id };
    const g = this.groundAt(sx, sy);
    if (!g) return null;
    for (const b of this.sim.buildings) {
      if (b.destroyed) continue;
      if (dist(b.x, b.z, g.x, g.z) < b.radius * 0.9) return { kind: 'building', id: b.id };
    }
    return { kind: 'ground', x: g.x, z: g.z };
  }

  /** Own units whose screen position falls in the rectangle. */
  unitsInRect(x0: number, y0: number, x1: number, y1: number, side: SideIndex): number[] {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const out: number[] = [];
    for (const u of this.sim.units) {
      if (u.side !== side || !u.alive || u.retreated || u.reserve) continue;
      const p = this.toScreen(u.x, bHeight(this.t, u.x, u.z) + 1.5, u.z);
      if (p && p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) out.push(u.id);
    }
    return out;
  }

  dispose(): void {
    this.effects.dispose();
    this.damagedMat.dispose();
  }
}
