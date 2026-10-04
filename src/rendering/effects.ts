import * as THREE from 'three';
import type { WeaponClass } from '../data/components';

interface Tracer {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  t0: number;
  dur: number;
  len: number;
  color: THREE.Color;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  t0: number;
  dur: number;
  size: number;
  rise: number;
  c0: THREE.Color;
  c1: THREE.Color;
}

const UP = new THREE.Vector3(0, 1, 0);

const TRACER_COLORS: Record<WeaponClass, number> = {
  small_arms: 0xffe08a,
  mg: 0xffd070,
  hmg: 0xffb14a,
  at_rocket: 0xfff2d0,
  cannon: 0xffffff,
};

/**
 * Pooled battle effects: tracers (one LineSegments draw call) and
 * flashes/explosions/smoke (one InstancedMesh draw call).
 */
export class Effects {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private puffs: Puff[] = [];
  private lineGeo: THREE.BufferGeometry;
  private linePos: Float32Array;
  private lineCol: Float32Array;
  private puffMesh: THREE.InstancedMesh;
  /** Persistent ground scorch marks (ring buffer, one draw call). */
  private scorchMesh: THREE.InstancedMesh;
  private scorchNext = 0;
  private pendingScorch: { x: number; y: number; z: number; size: number; t: number }[] = [];
  private readonly maxTracers: number;
  private readonly maxPuffs: number;
  private readonly maxScorch: number;
  private time = 0;
  private tmpM = new THREE.Matrix4();
  private tmpC = new THREE.Color();
  private tmpQ = new THREE.Quaternion();
  private tmpS = new THREE.Vector3();
  private tmpP = new THREE.Vector3();

  constructor(quality = 1) {
    this.maxTracers = Math.round(220 * quality);
    this.maxPuffs = Math.round(180 * quality);
    this.linePos = new Float32Array(this.maxTracers * 6);
    this.lineCol = new Float32Array(this.maxTracers * 6);
    this.lineGeo = new THREE.BufferGeometry();
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    const lines = new THREE.LineSegments(
      this.lineGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    lines.frustumCulled = false;
    this.group.add(lines);
    this.puffMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.82, depthWrite: false }),
      this.maxPuffs,
    );
    this.puffMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffMesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.puffMesh.count = 0;
    this.puffMesh.frustumCulled = false;
    this.group.add(this.puffMesh);

    this.maxScorch = Math.max(16, Math.round(90 * quality));
    const disc = new THREE.CircleGeometry(1, 9);
    disc.rotateX(-Math.PI / 2);
    this.scorchMesh = new THREE.InstancedMesh(
      disc,
      new THREE.MeshBasicMaterial({ color: 0x1d1a16, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      this.maxScorch,
    );
    this.scorchMesh.count = 0;
    this.scorchMesh.frustumCulled = false;
    this.scorchMesh.renderOrder = 1;
    this.group.add(this.scorchMesh);
  }

  /** Blackened ground where a heavy round or vehicle exploded (appears after `delay`). */
  scorch(x: number, groundY: number, z: number, size: number, delay = 0): void {
    this.pendingScorch.push({ x, y: groundY + 0.06, z, size, t: this.time + delay });
  }

  /** Dust kicked up behind a moving vehicle; skipped when the pool is busy with combat effects. */
  dust(x: number, y: number, z: number, size: number): void {
    if (this.puffs.length > this.maxPuffs * 0.55) return;
    this.puff(x, y, z, size, 1.5, 1.1, 0xb4a586, 0xa59a86);
  }

  shot(weapon: WeaponClass, ax: number, ay: number, az: number, bx: number, by: number, bz: number, travel: number): void {
    if (this.tracers.length >= this.maxTracers) this.tracers.shift();
    const d = Math.hypot(bx - ax, by - ay, bz - az);
    const len = weapon === 'cannon' ? 22 : weapon === 'at_rocket' ? 6 : 9;
    this.tracers.push({
      ax,
      ay,
      az,
      bx,
      by,
      bz,
      t0: this.time,
      dur: Math.max(0.06, travel),
      len: Math.min(len, d * 0.6),
      color: new THREE.Color(TRACER_COLORS[weapon]),
    });
    // muzzle flash
    const flash = weapon === 'cannon' ? 2.2 : weapon === 'at_rocket' ? 1.4 : weapon === 'hmg' ? 0.7 : 0.45;
    this.puff(ax, ay, az, flash, 0.09, 0, 0xfff1b0, 0xff8a2a);
    if (weapon === 'cannon' || weapon === 'at_rocket') this.puff(ax, ay, az, flash * 1.6, 1.4, 1.5, 0x8a8478, 0x6a665f);
  }

  explosion(x: number, y: number, z: number, size: number, delay = 0): void {
    const t0 = this.time + delay;
    this.puffs.push({ x, y, z, t0, dur: 0.35, size: 2.2 * size, rise: 0, c0: new THREE.Color(0xfff0b0), c1: new THREE.Color(0xff6a1a) });
    this.puffs.push({ x, y: y + 0.5, z, t0: t0 + 0.08, dur: 2.2 + size, size: 3.2 * size, rise: 3 * size, c0: new THREE.Color(0x5a5048), c1: new THREE.Color(0x8e8a84) });
    if (this.puffs.length > this.maxPuffs) this.puffs.splice(0, this.puffs.length - this.maxPuffs);
  }

  puff(x: number, y: number, z: number, size: number, dur: number, rise: number, c0: number, c1: number): void {
    this.puffs.push({ x, y, z, t0: this.time, dur, size, rise, c0: new THREE.Color(c0), c1: new THREE.Color(c1) });
    if (this.puffs.length > this.maxPuffs) this.puffs.shift();
  }

  update(dt: number): void {
    this.time += dt;
    // scorch marks land when the round does
    if (this.pendingScorch.length) {
      const due = this.pendingScorch.filter((p) => p.t <= this.time);
      if (due.length) {
        this.pendingScorch = this.pendingScorch.filter((p) => p.t > this.time);
        for (const p of due) {
          const k = this.scorchNext++ % this.maxScorch;
          const s = p.size * (1.6 + ((k * 37) % 10) / 12);
          this.tmpQ.setFromAxisAngle(UP, k * 2.39);
          this.tmpS.set(s, 1, s * 0.8);
          this.tmpP.set(p.x, p.y, p.z);
          this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
          this.scorchMesh.setMatrixAt(k, this.tmpM);
          this.scorchMesh.count = Math.min(this.maxScorch, Math.max(this.scorchMesh.count, k + 1));
        }
        this.scorchMesh.instanceMatrix.needsUpdate = true;
      }
    }
    // tracers
    let n = 0;
    const alive: Tracer[] = [];
    for (const t of this.tracers) {
      const p = (this.time - t.t0) / t.dur;
      if (p > 1) continue;
      alive.push(t);
      const d = Math.hypot(t.bx - t.ax, t.by - t.ay, t.bz - t.az) || 1;
      const head = Math.min(1, p);
      const tail = Math.max(0, head - t.len / d);
      const o = n * 6;
      this.linePos[o] = t.ax + (t.bx - t.ax) * tail;
      this.linePos[o + 1] = t.ay + (t.by - t.ay) * tail;
      this.linePos[o + 2] = t.az + (t.bz - t.az) * tail;
      this.linePos[o + 3] = t.ax + (t.bx - t.ax) * head;
      this.linePos[o + 4] = t.ay + (t.by - t.ay) * head;
      this.linePos[o + 5] = t.az + (t.bz - t.az) * head;
      this.lineCol[o] = t.color.r * 0.3;
      this.lineCol[o + 1] = t.color.g * 0.3;
      this.lineCol[o + 2] = t.color.b * 0.3;
      this.lineCol[o + 3] = t.color.r;
      this.lineCol[o + 4] = t.color.g;
      this.lineCol[o + 5] = t.color.b;
      n++;
    }
    this.tracers = alive;
    this.lineGeo.setDrawRange(0, n * 2);
    (this.lineGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lineGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    // puffs
    let m = 0;
    const keep: Puff[] = [];
    for (const p of this.puffs) {
      const f = (this.time - p.t0) / p.dur;
      if (f > 1) continue;
      keep.push(p);
      if (f < 0) continue;
      const s = p.size * (0.35 + 0.65 * Math.sin(Math.min(1, f * 1.4) * Math.PI * 0.5)) * (1 - f * 0.25);
      this.tmpQ.identity();
      this.tmpS.set(s, s * 0.85, s);
      this.tmpP.set(p.x, p.y + p.rise * f, p.z);
      this.tmpM.compose(this.tmpP, this.tmpQ, this.tmpS);
      this.puffMesh.setMatrixAt(m, this.tmpM);
      this.tmpC.copy(p.c0).lerp(p.c1, f);
      // fade out by darkening toward the fog-ish grey
      this.tmpC.lerp(new THREE.Color(0x9aa6ab), Math.max(0, f - 0.6) * 1.5);
      this.puffMesh.setColorAt(m, this.tmpC);
      m++;
      if (m >= this.maxPuffs) break;
    }
    this.puffs = keep;
    this.puffMesh.count = m;
    this.puffMesh.instanceMatrix.needsUpdate = true;
    if (this.puffMesh.instanceColor) this.puffMesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.lineGeo.dispose();
    this.puffMesh.geometry.dispose();
    this.scorchMesh.geometry.dispose();
    (this.scorchMesh.material as THREE.Material).dispose();
  }
}
