/**
 * 2D overlay canvas drawn on top of the WebGL view: NATO-style unit symbols,
 * labels, health bars, selection boxes and order markers. Cheap to draw and
 * readable at any zoom level on small screens.
 */
export type SymbolKind = 'infantry' | 'light_vehicle' | 'tank' | 'support' | 'mixed' | 'hq';

export const FRIEND = '#5fb4ff';
export const FOE = '#ff6a4d';

export class Overlay {
  readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  w = 1;
  h = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2D canvas unavailable');
    this.ctx = c;
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  clear(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /** NATO-like symbol: friendly = rectangle, hostile = diamond. */
  /** `dashed` draws the frame broken (a last known position rather than a live track). */
  symbol(x: number, y: number, kind: SymbolKind, friendly: boolean, size = 16, opts: { selected?: boolean; alpha?: number; pips?: number; dashed?: boolean } = {}): void {
    const c = this.ctx;
    const col = friendly ? FRIEND : FOE;
    c.save();
    c.globalAlpha = opts.alpha ?? 1;
    c.translate(x, y);
    const w = size * 1.5;
    const h = size;
    c.lineWidth = 1.6;
    c.fillStyle = friendly ? 'rgba(20,48,70,0.78)' : 'rgba(70,24,16,0.78)';
    c.strokeStyle = opts.selected ? '#ffffff' : col;
    c.beginPath();
    if (friendly) c.rect(-w / 2, -h / 2, w, h);
    else {
      const d = h * 0.85;
      c.moveTo(0, -d);
      c.lineTo(d * 1.15, 0);
      c.lineTo(0, d);
      c.lineTo(-d * 1.15, 0);
      c.closePath();
    }
    c.fill();
    if (opts.dashed) c.setLineDash([3, 2.5]);
    c.stroke();
    c.setLineDash([]);
    c.strokeStyle = col;
    c.lineWidth = 1.4;
    const iw = friendly ? w / 2 : h * 0.55;
    const ih = friendly ? h / 2 : h * 0.4;
    c.beginPath();
    if (kind === 'infantry' || kind === 'mixed') {
      c.moveTo(-iw, -ih);
      c.lineTo(iw, ih);
      c.moveTo(iw, -ih);
      c.lineTo(-iw, ih);
    }
    if (kind === 'light_vehicle') {
      c.moveTo(-iw, ih);
      c.lineTo(iw, -ih);
    }
    if (kind === 'support') {
      // sustainment: bar across the lower part of the frame
      c.moveTo(-iw, ih * 0.45);
      c.lineTo(iw, ih * 0.45);
    }
    c.stroke();
    if (kind === 'tank' || kind === 'mixed') {
      c.beginPath();
      c.ellipse(0, 0, iw * 0.62, ih * 0.5, 0, 0, Math.PI * 2);
      c.stroke();
    }
    if (kind === 'hq') {
      c.beginPath();
      c.moveTo(-iw, ih * 0.9);
      c.lineTo(-iw, -ih * 0.9);
      c.stroke();
    }
    if (opts.pips) {
      c.fillStyle = col;
      for (let k = 0; k < opts.pips; k++) {
        c.beginPath();
        c.arc((k - (opts.pips - 1) / 2) * 5, -h / 2 - 4.5, 1.7, 0, Math.PI * 2);
        c.fill();
      }
    }
    c.restore();
  }

  bar(x: number, y: number, w: number, frac: number, color: string, h = 3): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
    c.fillStyle = color;
    c.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, frac)), h);
  }

  private placed: { x0: number; y0: number; x1: number; y1: number }[] = [];

  /** Forget label positions (call once per frame before drawing labels). */
  resetLabels(): void {
    this.placed.length = 0;
  }

  /** Label that nudges itself down to avoid overlapping earlier labels this frame. */
  labelAvoid(x: number, y: number, text: string, color = '#dfe6e8', size = 11): void {
    const c = this.ctx;
    c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    const w = c.measureText(text).width + 6;
    const h = size + 4;
    let yy = y;
    for (let k = 0; k < 6; k++) {
      const r = { x0: x - w / 2, y0: yy - h / 2, x1: x + w / 2, y1: yy + h / 2 };
      const hit = this.placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      if (!hit) {
        this.placed.push(r);
        break;
      }
      yy += h;
    }
    this.label(x, yy, text, color, size);
  }

  label(x: number, y: number, text: string, color = '#dfe6e8', size = 11, align: CanvasTextAlign = 'center'): void {
    const c = this.ctx;
    c.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    c.textAlign = align;
    c.textBaseline = 'middle';
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(5,8,10,0.85)';
    c.strokeText(text, x, y);
    c.fillStyle = color;
    c.fillText(text, x, y);
  }

  selectionBox(x0: number, y0: number, x1: number, y1: number): void {
    const c = this.ctx;
    c.fillStyle = 'rgba(120,220,140,0.12)';
    c.strokeStyle = 'rgba(140,240,160,0.9)';
    c.lineWidth = 1.2;
    c.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    c.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  marker(x: number, y: number, color: string, r = 7): void {
    const c = this.ctx;
    c.strokeStyle = color;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.moveTo(x - r - 4, y);
    c.lineTo(x - r + 2, y);
    c.moveTo(x + r - 2, y);
    c.lineTo(x + r + 4, y);
    c.stroke();
  }

  line(x0: number, y0: number, x1: number, y1: number, color: string, dash: number[] = [], width = 1.5): void {
    const c = this.ctx;
    c.save();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.restore();
  }
}
