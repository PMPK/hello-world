import * as THREE from 'three';
import { Materials } from './models/builder';
import { isCachedGeometry } from './models/cache';

const SHARED_MATERIALS = new Set<THREE.Material>(Object.values(Materials));

/**
 * Free the GPU resources a view created: its geometries and materials, the
 * instance buffers of its instanced meshes and the shadow maps of its lights.
 * Cached model geometries and the shared materials stay for the next view.
 * (A disposed resource that is used again is simply uploaded again.)
 */
export function disposeScene(scene: THREE.Scene): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) im.dispose();
    const light = o as THREE.Light;
    if (light.isLight) light.dispose();
    const m = o as THREE.Mesh;
    if (m.geometry && !isCachedGeometry(m.geometry)) geos.add(m.geometry);
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) if (!SHARED_MATERIALS.has(x)) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const x of mats) x.dispose();
}
