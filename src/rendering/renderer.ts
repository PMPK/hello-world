import * as THREE from 'three';
import type { Quality } from '../app/settings';

export interface QualityProfile {
  pixelRatioCap: number;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  treeDensity: number;
  treeShadows: boolean;
  effects: number;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatioCap: 1, antialias: false, shadows: false, shadowMapSize: 512, treeDensity: 0.45, treeShadows: false, effects: 0.5 },
  medium: { pixelRatioCap: 1.5, antialias: true, shadows: true, shadowMapSize: 1024, treeDensity: 0.8, treeShadows: false, effects: 0.8 },
  high: { pixelRatioCap: 2, antialias: true, shadows: true, shadowMapSize: 2048, treeDensity: 1, treeShadows: true, effects: 1 },
};

/** Owns the single WebGL2 renderer shared by every game mode. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  profile: QualityProfile;
  quality: Quality;
  width = 1;
  height = 1;

  constructor(canvas: HTMLCanvasElement, quality: Quality) {
    this.quality = quality;
    this.profile = QUALITY[quality];
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.profile.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.applyQuality(quality);
  }

  applyQuality(q: Quality): void {
    this.quality = q;
    this.profile = QUALITY[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.pixelRatioCap));
    this.renderer.shadowMap.enabled = this.profile.shadows;
    this.resize(this.width, this.height);
  }

  resize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.renderer.setSize(this.width, this.height, false);
  }

  get aspect(): number {
    return this.width / this.height;
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }
}

/** Standard sun + sky lighting rig. */
export function makeLights(scene: THREE.Scene, profile: QualityProfile, span: number): { sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight } {
  const hemi = new THREE.HemisphereLight(0xc4d6e4, 0x4a4535, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  sun.position.set(-0.6, 1, 0.45).multiplyScalar(span);
  sun.castShadow = profile.shadows;
  if (profile.shadows) {
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
  }
  scene.add(sun);
  scene.add(sun.target);
  return { sun, hemi };
}
