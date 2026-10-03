import * as THREE from 'three';
import { clamp, lerp } from '../core/math';

export interface RigLimits {
  minDist: number;
  maxDist: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Pitch (radians above the horizon) at min and max distance. */
  pitchNear: number;
  pitchFar: number;
}

/**
 * RTS-style orbit camera around a ground target point. Inputs set the
 * desired state; `update` eases toward it for smooth touch control.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  target = new THREE.Vector3();
  dist = 60;
  yaw = 0;
  private want = { x: 0, z: 0, dist: 60, yaw: 0 };
  heightAt: (x: number, z: number) => number = () => 0;

  constructor(
    aspect: number,
    public limits: RigLimits,
    fov = 45,
  ) {
    this.camera = new THREE.PerspectiveCamera(fov, aspect, 0.5, 4000);
  }

  get pitch(): number {
    const t = (this.dist - this.limits.minDist) / Math.max(1, this.limits.maxDist - this.limits.minDist);
    return lerp(this.limits.pitchNear, this.limits.pitchFar, Math.pow(clamp(t, 0, 1), 0.7));
  }

  jumpTo(x: number, z: number, dist?: number): void {
    this.want.x = x;
    this.want.z = z;
    if (dist !== undefined) this.want.dist = clamp(dist, this.limits.minDist, this.limits.maxDist);
    this.target.set(this.want.x, this.heightAt(x, z), this.want.z);
    this.dist = this.want.dist;
    this.yaw = this.want.yaw;
    this.apply();
  }

  focus(x: number, z: number, dist?: number): void {
    this.want.x = clamp(x, this.limits.minX, this.limits.maxX);
    this.want.z = clamp(z, this.limits.minZ, this.limits.maxZ);
    if (dist !== undefined) this.want.dist = clamp(dist, this.limits.minDist, this.limits.maxDist);
  }

  /** Pan by screen pixels (drag): the ground follows the finger. */
  panPixels(dx: number, dy: number, viewportHeight: number): void {
    const worldPerPixel = (2 * this.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, viewportHeight);
    const k = worldPerPixel * 1.05;
    const s = Math.sin(this.want.yaw);
    const c = Math.cos(this.want.yaw);
    // screen right = (cos, -sin), screen up = (-sin, -cos) in xz for yaw convention below
    const mx = -dx * k * c - dy * k * s / Math.max(0.35, Math.sin(this.pitch));
    const mz = dx * k * s - dy * k * c / Math.max(0.35, Math.sin(this.pitch));
    this.want.x = clamp(this.want.x + mx, this.limits.minX, this.limits.maxX);
    this.want.z = clamp(this.want.z + mz, this.limits.minZ, this.limits.maxZ);
  }

  /** Pan in world units relative to the view direction (keyboard). */
  panWorld(right: number, forward: number): void {
    const s = Math.sin(this.want.yaw);
    const c = Math.cos(this.want.yaw);
    this.want.x = clamp(this.want.x + right * c - forward * s, this.limits.minX, this.limits.maxX);
    this.want.z = clamp(this.want.z - right * s - forward * c, this.limits.minZ, this.limits.maxZ);
  }

  zoomBy(factor: number, anchor?: { x: number; z: number }): void {
    const nd = clamp(this.want.dist * factor, this.limits.minDist, this.limits.maxDist);
    const real = nd / this.want.dist;
    if (anchor) {
      // keep the anchor point roughly under the cursor/fingers
      this.want.x = clamp(anchor.x + (this.want.x - anchor.x) * real, this.limits.minX, this.limits.maxX);
      this.want.z = clamp(anchor.z + (this.want.z - anchor.z) * real, this.limits.minZ, this.limits.maxZ);
    }
    this.want.dist = nd;
  }

  rotateBy(dYaw: number): void {
    this.want.yaw += dYaw;
  }

  /** Set the orbit angle immediately (no easing). */
  setYaw(yaw: number): void {
    this.want.yaw = yaw;
    this.yaw = yaw;
  }

  get zoomFraction(): number {
    return (this.dist - this.limits.minDist) / Math.max(1, this.limits.maxDist - this.limits.minDist);
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12);
    this.target.x = lerp(this.target.x, this.want.x, k);
    this.target.z = lerp(this.target.z, this.want.z, k);
    this.dist = lerp(this.dist, this.want.dist, k);
    this.yaw = lerp(this.yaw, this.want.yaw, k);
    const gh = this.heightAt(this.target.x, this.target.z);
    this.target.y = lerp(this.target.y, Math.max(0, gh), 1 - Math.exp(-dt * 6));
    this.apply();
  }

  apply(): void {
    const p = this.pitch;
    const horiz = Math.cos(p) * this.dist;
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * horiz,
      this.target.y + Math.sin(p) * this.dist,
      this.target.z + Math.cos(this.yaw) * horiz,
    );
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Approximate ground point under a screen position (ray vs horizontal plane at target height). */
  groundAt(ndcX: number, ndcY: number, planeY = this.target.y): THREE.Vector3 | null {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }
}
