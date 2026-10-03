import { clamp } from '../core/math';
import { BIOME } from '../world/terrain';
import type { BattleSim } from '../battle/sim';
import type { SideIndex } from '../battle/types';
import { el } from './dom';

/** Battle minimap: terrain image + live unit dots + camera footprint. Tap to move the camera. */
export class Minimap {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private size = 148;
  private dragging = false;

  constructor(
    host: HTMLElement,
    private readonly sim: BattleSim,
    private readonly playerSide: SideIndex,
    private readonly onJump: (x: number, z: number) => void,
  ) {
    this.root = el('div', 'panel minimap');
    this.canvas = el('canvas');
    this.root.append(this.canvas);
    host.append(this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.bg = this.renderTerrain();
    const toWorld = (e: PointerEvent): { x: number; z: number } => {
      const r = this.canvas.getBoundingClientRect();
      const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
      const fz = clamp((e.clientY - r.top) / r.height, 0, 1);
      return { x: fx * sim.terrain.size, z: fz * sim.terrain.size };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.dragging = true;
      this.canvas.setPointerCapture(e.pointerId);
      const p = toWorld(e);
      this.onJump(p.x, p.z);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      const p = toWorld(e);
      this.onJump(p.x, p.z);
    });
    const stop = (): void => {
      this.dragging = false;
    };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);
  }

  private renderTerrain(): HTMLCanvasElement {
    const t = this.sim.terrain;
    const c = document.createElement('canvas');
    c.width = t.grid;
    c.height = t.grid;
    const g = c.getContext('2d')!;
    const img = g.createImageData(t.grid, t.grid);
    let maxH = 1;
    for (const h of t.heights) maxH = Math.max(maxH, h);
    for (let j = 0; j < t.grid; j++) {
      for (let i = 0; i < t.grid; i++) {
        const idx = j * t.grid + i;
        const h = t.heights[j * (t.grid + 1) + i];
        let r = 108;
        let gg = 128;
        let b = 74;
        if (t.water[idx]) {
          r = 40;
          gg = 88;
          b = 110;
        } else if (t.forest[idx]) {
          r = 50;
          gg = 78;
          b = 44;
        } else if (t.biome[idx] === BIOME.mountains || t.biome[idx] === BIOME.snow) {
          r = 112;
          gg = 108;
          b = 98;
        }
        const k = 0.75 + 0.35 * (h / maxH);
        img.data[idx * 4] = r * k;
        img.data[idx * 4 + 1] = gg * k;
        img.data[idx * 4 + 2] = b * k;
        img.data[idx * 4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  draw(view: { x: number; z: number }[] | null): void {
    const w = this.root.clientWidth - 8;
    if (w > 0 && Math.abs(w - this.size) > 1) this.size = w;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(this.size * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
    }
    const c = this.ctx;
    const s = this.sim.terrain.size;
    const k = px / s;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.bg, 0, 0, px, px);
    for (const b of this.sim.buildings) {
      c.fillStyle = b.destroyed ? '#444' : b.side === this.playerSide ? '#9fd2ff' : '#ffb19f';
      const r = Math.max(2.5, b.radius * k * 0.7);
      c.fillRect(b.x * k - r, b.z * k - r, r * 2, r * 2);
    }
    for (const u of this.sim.units) {
      if (u.reserve || u.retreated) continue;
      const friendly = u.side === this.playerSide;
      if (!u.alive) {
        if (!u.stats.isVehicle) continue;
        c.fillStyle = '#3a3a3a';
      } else if (friendly) c.fillStyle = '#5fb4ff';
      else if (u.seenBy[this.playerSide]) c.fillStyle = '#ff6a4d';
      else continue;
      const r = (u.stats.isVehicle ? 2.6 : 2.1) * dpr;
      c.beginPath();
      c.arc(u.x * k, u.z * k, r, 0, Math.PI * 2);
      c.fill();
    }
    if (view && view.length === 4) {
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.lineWidth = 1.2 * dpr;
      c.beginPath();
      view.forEach((p, i) => (i === 0 ? c.moveTo(p.x * k, p.z * k) : c.lineTo(p.x * k, p.z * k)));
      c.closePath();
      c.stroke();
    }
  }
}
