// Procedurally generates the PWA icons (PNG) and favicon (SVG).
// No external dependencies: a tiny PNG encoder built on node:zlib.
// Run with: npm run icons
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// ---------- PNG encoding ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- tiny procedural "shader" ----------
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return mix(mix(a, b, u), mix(c, d, u), v);
}
function fbm(x, y) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < 5; i++) {
    s += a * vnoise(x * f, y * f);
    f *= 2;
    a *= 0.5;
  }
  return s;
}

/** Returns [r,g,b,a] 0..1 for normalized coords u,v in [0,1]. */
function shade(u, v, maskable) {
  const cx = u - 0.5;
  const cy = v - 0.5;
  const r = Math.hypot(cx, cy);
  // background: dark radial gradient (full bleed for maskable icons)
  let col = [mix(0.07, 0.03, r * 1.6), mix(0.1, 0.04, r * 1.6), mix(0.1, 0.045, r * 1.6)];
  let alpha = 1;
  if (!maskable) {
    // rounded square plate
    const half = 0.47;
    const rad = 0.12;
    const qx = Math.max(Math.abs(cx) - (half - rad), 0);
    const qy = Math.max(Math.abs(cy) - (half - rad), 0);
    const d = Math.hypot(qx, qy) - rad;
    alpha = 1 - smooth(-0.004, 0.004, d);
  }
  const scale = maskable ? 0.8 : 1;
  const pr = 0.27 * scale; // planet radius
  const ringR = 0.385 * scale;
  // reticle ring
  const ringD = Math.abs(r - ringR);
  const ringA = 1 - smooth(0.006, 0.012, ringD);
  // gaps in the ring at 45 degrees -> X pattern ticks
  const ang = Math.atan2(cy, cx);
  const diag = Math.abs(Math.sin(2 * ang)); // 1 at diagonals
  const ringMask = 1 - smooth(0.82, 0.9, diag);
  const amber = [0.95, 0.68, 0.22];
  col = col.map((c, i) => mix(c, amber[i], ringA * ringMask * 0.9));
  // X ticks along the diagonals, crossing the reticle ring
  const perp = Math.abs(Math.abs(cx) - Math.abs(cy)) / Math.SQRT2;
  const tickA =
    (1 - smooth(0.01, 0.017, perp)) * smooth(ringR - 0.075, ringR - 0.065, r) * (1 - smooth(ringR + 0.05, ringR + 0.06, r));
  col = col.map((c, i) => mix(c, amber[i], clamp01(tickA)));
  // planet
  if (r < pr + 0.02) {
    const nx = cx / pr;
    const ny = cy / pr;
    const nz2 = 1 - nx * nx - ny * ny;
    if (nz2 > 0) {
      const nz = Math.sqrt(nz2);
      // light from upper-left
      const L = [-0.55, -0.6, 0.58];
      const ll = Math.hypot(...L);
      const diff = clamp01((nx * L[0] + ny * L[1] + nz * L[2]) / ll);
      // pseudo terrain on the sphere
      const tu = nx / (1.2 + nz) * 2.2 + 3.1;
      const tv = ny / (1.2 + nz) * 2.2 + 1.7;
      const h = fbm(tu * 2.0, tv * 2.0);
      const ocean = [0.06, 0.2, 0.3];
      const land = h > 0.62 ? [0.55, 0.52, 0.42] : h > 0.55 ? [0.36, 0.42, 0.24] : [0.24, 0.36, 0.2];
      let base = h > 0.5 ? land : ocean;
      const lit = 0.18 + 0.95 * diff;
      let pc = base.map((c) => c * lit);
      // atmosphere rim
      const rim = Math.pow(1 - nz, 2.5);
      pc = pc.map((c, i) => mix(c, [0.45, 0.75, 0.85][i], rim * 0.7));
      const edge = 1 - smooth(pr - 0.004, pr + 0.003, r);
      col = col.map((c, i) => mix(c, pc[i], edge));
    }
  }
  // outer atmosphere glow
  const glow = Math.exp(-Math.pow((r - pr) / 0.025, 2)) * 0.35 * (r > pr ? 1 : 0);
  col = col.map((c, i) => c + [0.25, 0.55, 0.65][i] * glow);
  return [clamp01(col[0]), clamp01(col[1]), clamp01(col[2]), alpha];
}

function render(size, maskable) {
  const ss = 3;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const c = shade(u, v, maskable);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      const alpha = a / n;
      buf[o] = Math.round(alpha > 0 ? (r / a) * 255 : 0);
      buf[o + 1] = Math.round(alpha > 0 ? (g / a) * 255 : 0);
      buf[o + 2] = Math.round(alpha > 0 ? (b / a) * 255 : 0);
      buf[o + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, size, buf);
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
];
for (const [name, size, maskable] of targets) {
  writeFileSync(join(outDir, name), render(size, maskable));
  console.log('wrote', name);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="p" cx="38%" cy="35%" r="70%">
      <stop offset="0" stop-color="#6f8a55"/>
      <stop offset="0.55" stop-color="#2f5a52"/>
      <stop offset="1" stop-color="#0c2230"/>
    </radialGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="10" fill="#0d1314"/>
  <circle cx="32" cy="32" r="17" fill="url(#p)"/>
  <circle cx="32" cy="32" r="17" fill="none" stroke="#7fd0e0" stroke-opacity="0.5" stroke-width="1.2"/>
  <circle cx="32" cy="32" r="24.5" fill="none" stroke="#f2ad38" stroke-width="2" stroke-dasharray="14 5.24" stroke-dashoffset="-2.6"/>
  <g stroke="#f2ad38" stroke-width="2.4" stroke-linecap="round">
    <line x1="12" y1="12" x2="18" y2="18"/><line x1="52" y1="12" x2="46" y2="18"/>
    <line x1="12" y1="52" x2="18" y2="46"/><line x1="52" y1="52" x2="46" y2="46"/>
  </g>
</svg>
`;
writeFileSync(join(root, 'public', 'favicon.svg'), svg);
console.log('wrote favicon.svg');
