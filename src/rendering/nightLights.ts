import * as THREE from 'three';

export interface LightSpot {
  /** Stable key of the structure the lights belong to. */
  key: string;
  x: number;
  y: number;
  z: number;
  /** Ring radius around the structure. */
  radius: number;
  count: number;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Warm lamp points around inhabited structures that fade in after dusk.
 * One additive instanced draw call; rebuilt only when the set of lit
 * structures changes.
 */
export class NightLights {
  readonly mesh: THREE.InstancedMesh;
  private key = '';
  private readonly mat: THREE.MeshBasicMaterial;

  constructor(
    scene: THREE.Scene,
    private readonly size: number,
    private readonly capacity = 400,
  ) {
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffcf86, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), this.mat, capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    scene.add(this.mesh);
  }

  /** Update positions (when the lit set changed) and brightness for the current darkness 0..1. */
  update(spots: LightSpot[], dark: number): void {
    const opacity = Math.max(0, Math.min(0.95, (dark - 0.15) * 1.3));
    this.mat.opacity = opacity;
    this.mesh.visible = opacity > 0.01 && spots.length > 0;
    if (!this.mesh.visible) return;
    const key = spots.map((s) => s.key).join('|');
    if (key === this.key) return;
    this.key = key;
    let n = 0;
    for (const s of spots) {
      const a0 = hash(s.key) * Math.PI * 2;
      for (let k = 0; k < s.count && n < this.capacity; k++) {
        const a = a0 + (k / s.count) * Math.PI * 2;
        tmpP.set(s.x + Math.cos(a) * s.radius, s.y, s.z + Math.sin(a) * s.radius);
        tmpQ.identity();
        tmpS.setScalar(this.size);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.mesh.setMatrixAt(n++, tmpM);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
