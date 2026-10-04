import * as THREE from 'three';
import { darkness } from '../core/time';

/**
 * Time-of-day lighting. Keyframes are blended by hour; nights stay readable
 * (moonlight, bluish ambient) because the game is played on phone screens.
 */
interface Key {
  hour: number;
  sky: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
}

const KEYS: Key[] = [
  { hour: 0, sky: 0x223046, sun: 0xa8bce6, sunI: 0.75, hemiSky: 0x56678e, hemiGround: 0x262830, hemiI: 1.0 },
  { hour: 4.5, sky: 0x283447, sun: 0xa8bce6, sunI: 0.72, hemiSky: 0x5a6a8c, hemiGround: 0x282a31, hemiI: 1.0 },
  { hour: 6, sky: 0xa89f9a, sun: 0xffc8a0, sunI: 1.5, hemiSky: 0xaeb8c8, hemiGround: 0x4c463a, hemiI: 1.2 },
  { hour: 8, sky: 0xa9b4b8, sun: 0xffe6c8, sunI: 1.9, hemiSky: 0xbccfdc, hemiGround: 0x4a4535, hemiI: 1.25 },
  { hour: 12, sky: 0x9db2bd, sun: 0xfff1dc, sunI: 2.1, hemiSky: 0xc4d6e4, hemiGround: 0x4a4535, hemiI: 1.35 },
  { hour: 16.5, sky: 0xa6aeb0, sun: 0xffe2bc, sunI: 1.95, hemiSky: 0xc2cfd8, hemiGround: 0x4b4434, hemiI: 1.3 },
  { hour: 18.5, sky: 0xb48c74, sun: 0xffa060, sunI: 1.25, hemiSky: 0xa49a9c, hemiGround: 0x403628, hemiI: 1.0 },
  { hour: 20, sky: 0x454862, sun: 0xc2b2da, sunI: 0.8, hemiSky: 0x606884, hemiGround: 0x26262e, hemiI: 1.0 },
  { hour: 24, sky: 0x223046, sun: 0xa8bce6, sunI: 0.75, hemiSky: 0x56678e, hemiGround: 0x262830, hemiI: 1.0 },
];

const ca = new THREE.Color();
const cb = new THREE.Color();

function lerpColor(out: THREE.Color, a: number, b: number, t: number): THREE.Color {
  ca.setHex(a);
  cb.setHex(b);
  return out.copy(ca).lerp(cb, t);
}

export interface DaylightRig {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  scene: THREE.Scene;
}

export class Daylight {
  /** Direction from the ground toward the light (sun by day, moon by night). */
  readonly toLight = new THREE.Vector3(-0.6, 1, 0.45).normalize();
  /** 0 = full day .. 1 = night. */
  dark = 0;
  private hour = -1;

  constructor(private readonly rig: DaylightRig) {}

  /** Apply lighting for an hour of day (0..24). Cheap; skips tiny changes. */
  set(hour: number): void {
    const h = ((hour % 24) + 24) % 24;
    if (Math.abs(h - this.hour) < 0.02) return;
    this.hour = h;
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].hour <= h) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = (h - a.hour) / Math.max(1e-6, b.hour - a.hour);
    const { sun, hemi, scene } = this.rig;
    lerpColor(sun.color, a.sun, b.sun, t);
    sun.intensity = a.sunI + (b.sunI - a.sunI) * t;
    lerpColor(hemi.color, a.hemiSky, b.hemiSky, t);
    lerpColor(hemi.groundColor, a.hemiGround, b.hemiGround, t);
    hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * t;
    const bg = scene.background instanceof THREE.Color ? scene.background : null;
    if (bg) lerpColor(bg, a.sky, b.sky, t);
    if (scene.fog instanceof THREE.Fog && bg) scene.fog.color.copy(bg);
    this.dark = darkness(h);
    // sun path: rises in the east (+x), noon high in the south, sets in the west; the moon
    // takes over at night from a fixed high angle so shadows stay readable
    const dayT = (h - 6) / 12; // 0 at 06:00, 1 at 18:00
    if (dayT > -0.08 && dayT < 1.08) {
      const ang = Math.PI * Math.min(1, Math.max(0, dayT));
      const elev = Math.max(0.38, Math.sin(ang)); // never grazing: keeps slopes readable
      this.toLight.set(Math.cos(ang) * 0.9, elev * 1.2, 0.35).normalize();
    } else {
      this.toLight.set(-0.35, 1, -0.5).normalize();
    }
  }
}
