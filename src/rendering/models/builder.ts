import * as THREE from 'three';

export type ColorLike = THREE.ColorRepresentation;

export interface Xf {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** White = "paint": tinted per instance (faction camo) when rendered instanced. */
export const PAINT = 0xffffff;

/**
 * Accumulates low-poly primitives into a single non-indexed BufferGeometry
 * with flat normals and baked vertex colours. One model = one draw call.
 */
export class ModelBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];

  add(geo: THREE.BufferGeometry, color: ColorLike, xf: Xf = {}, jitter = 0): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _e.set(xf.rx ?? 0, xf.ry ?? 0, xf.rz ?? 0);
    _q.setFromEuler(_e);
    _p.set(xf.x ?? 0, xf.y ?? 0, xf.z ?? 0);
    _s.set(xf.sx ?? 1, xf.sy ?? 1, xf.sz ?? 1);
    _m.compose(_p, _q, _s);
    g.applyMatrix4(_m);
    g.computeVertexNormals();
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    _c.set(color);
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      if (jitter > 0) {
        // per-face variation (same for the 3 vertices of a triangle)
        const face = Math.floor(i / 3);
        const v = 1 + (hash(face + this.pos.length) - 0.5) * jitter;
        this.col.push(_c.r * v, _c.g * v, _c.b * v);
      } else {
        this.col.push(_c.r, _c.g, _c.b);
      }
    }
    g.dispose();
    geo.dispose();
    return this;
  }

  box(w: number, h: number, d: number, color: ColorLike, xf: Xf = {}): this {
    // boxes are positioned by their base (y = bottom) for convenience
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    return this.add(g, color, xf);
  }

  cyl(rTop: number, rBot: number, h: number, seg: number, color: ColorLike, xf: Xf = {}): this {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
    g.translate(0, h / 2, 0);
    return this.add(g, color, xf);
  }

  cone(r: number, h: number, seg: number, color: ColorLike, xf: Xf = {}): this {
    const g = new THREE.ConeGeometry(r, h, seg, 1);
    g.translate(0, h / 2, 0);
    return this.add(g, color, xf);
  }

  sphere(r: number, color: ColorLike, xf: Xf = {}, detail = 0): this {
    return this.add(new THREE.IcosahedronGeometry(r, detail), color, xf);
  }

  dome(r: number, seg: number, color: ColorLike, xf: Xf = {}): this {
    const g = new THREE.SphereGeometry(r, seg, Math.max(2, Math.floor(seg / 2)), 0, Math.PI * 2, 0, Math.PI / 2);
    return this.add(g, color, xf);
  }

  /** Horizontal cylinder along x (pipes, tubes, barrels). */
  tube(r: number, len: number, seg: number, color: ColorLike, xf: Xf = {}): this {
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
    g.rotateZ(Math.PI / 2);
    return this.add(g, color, xf);
  }

  /** Prism from a 2D profile extruded along z (roofs, glacis plates). */
  prism(shape: [number, number][], depth: number, color: ColorLike, xf: Xf = {}): this {
    const s = new THREE.Shape(shape.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
    g.translate(0, 0, -depth / 2);
    return this.add(g, color, xf);
  }

  /** Append another builder's geometry (keeping its colours) with a transform. */
  merge(other: ModelBuilder, xf: Xf = {}): this {
    const g = other.build();
    _e.set(xf.rx ?? 0, xf.ry ?? 0, xf.rz ?? 0);
    _q.setFromEuler(_e);
    _p.set(xf.x ?? 0, xf.y ?? 0, xf.z ?? 0);
    _s.set(xf.sx ?? 1, xf.sy ?? 1, xf.sz ?? 1);
    _m.compose(_p, _q, _s);
    g.applyMatrix4(_m);
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(c.getX(i), c.getY(i), c.getZ(i));
    }
    g.dispose();
    return this;
  }

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Shared materials (few draw-state changes; vertex colours carry the detail). */
export const Materials = {
  standard: new THREE.MeshLambertMaterial({ vertexColors: true }),
  glass: new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }),
  ghostOk: new THREE.MeshBasicMaterial({ color: 0x66e08a, transparent: true, opacity: 0.45, depthWrite: false }),
  ghostBad: new THREE.MeshBasicMaterial({ color: 0xe0563f, transparent: true, opacity: 0.45, depthWrite: false }),
};
