export interface Vec2 {
  x: number;
  z: number;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const saturate = (v: number): number => clamp(v, 0, 1);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

export function distV(a: Vec2, b: Vec2): number {
  return dist(a.x, a.z, b.x, b.z);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Signed smallest difference b - a. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Rotate angle `a` toward `b` by at most `maxStep`. */
export function approachAngle(a: number, b: number, maxStep: number): number {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return wrapAngle(a + Math.sign(d) * maxStep);
}

/** Heading such that (sin(h), cos(h)) points along (dx, dz). */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Length of a polyline. */
export function polylineLength(pts: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += distV(pts[i - 1], pts[i]);
  return len;
}

/** Distance from point p to segment ab. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
  t = saturate(t);
  return dist(px, pz, ax + abx * t, az + abz * t);
}
