export interface PointerInfo {
  button: number;
  pointerType: string;
  shift: boolean;
  ctrl: boolean;
}

export interface PointerHandlers {
  onTap?(x: number, y: number, info: PointerInfo): void;
  onDoubleTap?(x: number, y: number, info: PointerInfo): void;
  onLongPress?(x: number, y: number, info: PointerInfo): void;
  /** Return true to claim the drag (e.g. box selection) instead of panning. */
  onDragStart?(x: number, y: number, info: PointerInfo): boolean;
  onDrag?(x: number, y: number, dx: number, dy: number, info: PointerInfo, claimed: boolean): void;
  onDragEnd?(x: number, y: number, info: PointerInfo, claimed: boolean): void;
  onPinch?(cx: number, cy: number, scale: number, rotation: number, dx: number, dy: number): void;
  onWheel?(x: number, y: number, deltaY: number): void;
  onHover?(x: number, y: number): void;
}

interface Track {
  id: number;
  x: number;
  y: number;
  sx: number;
  sy: number;
  t0: number;
  info: PointerInfo;
}

const TAP_SLOP = 10;
const TAP_TIME = 450;
const LONG_PRESS = 520;
const DOUBLE_TAP = 320;

/**
 * Unified mouse/touch/pen gestures on top of Pointer Events:
 * tap, double-tap, long-press, drag, two-finger pinch/rotate/pan, wheel.
 */
export class PointerInput {
  private tracks = new Map<number, Track>();
  private dragging = false;
  private claimed = false;
  private longTimer: number | null = null;
  private longFired = false;
  private pinchPrev: { d: number; a: number; cx: number; cy: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };
  private hadMulti = false;
  /** Until then, the browser's click that follows a canvas tap is swallowed if it lands elsewhere. */
  private swallowUntil = 0;
  enabled = true;

  constructor(
    private readonly el: HTMLElement,
    private readonly h: PointerHandlers,
  ) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    window.addEventListener('pointermove', this.move, { passive: false });
    window.addEventListener('pointerup', this.up, { passive: false });
    window.addEventListener('pointercancel', this.cancel);
    el.addEventListener('wheel', this.wheel, { passive: false });
    el.addEventListener('contextmenu', this.ctx);
    window.addEventListener('click', this.swallowClick, true);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.down);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
    window.removeEventListener('pointercancel', this.cancel);
    this.el.removeEventListener('wheel', this.wheel);
    this.el.removeEventListener('contextmenu', this.ctx);
    window.removeEventListener('click', this.swallowClick, true);
    this.clearLong();
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private clearLong(): void {
    if (this.longTimer !== null) {
      clearTimeout(this.longTimer);
      this.longTimer = null;
    }
  }

  private ctx = (e: Event): void => {
    e.preventDefault();
  };

  private down = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this.local(e);
    const info: PointerInfo = { button: e.button, pointerType: e.pointerType, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    this.tracks.set(e.pointerId, { id: e.pointerId, x: p.x, y: p.y, sx: p.x, sy: p.y, t0: performance.now(), info });
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.tracks.size === 1) {
      this.dragging = false;
      this.claimed = false;
      this.longFired = false;
      this.hadMulti = false;
      this.clearLong();
      if (e.pointerType !== 'mouse') {
        this.longTimer = window.setTimeout(() => {
          const t = this.tracks.get(e.pointerId);
          if (t && !this.dragging && this.tracks.size === 1) {
            this.longFired = true;
            this.h.onLongPress?.(t.x, t.y, t.info);
          }
        }, LONG_PRESS);
      }
    } else if (this.tracks.size === 2) {
      this.clearLong();
      this.hadMulti = true;
      if (this.dragging) {
        const first = [...this.tracks.values()][0];
        this.h.onDragEnd?.(first.x, first.y, first.info, this.claimed);
        this.dragging = false;
        this.claimed = false;
      }
      this.pinchPrev = this.pinchState();
    }
  };

  private pinchState(): { d: number; a: number; cx: number; cy: number } | null {
    const t = [...this.tracks.values()];
    if (t.length < 2) return null;
    const [a, b] = t;
    return {
      d: Math.hypot(b.x - a.x, b.y - a.y),
      a: Math.atan2(b.y - a.y, b.x - a.x),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
    };
  }

  private move = (e: PointerEvent): void => {
    if (!this.enabled) return;
    const t = this.tracks.get(e.pointerId);
    const p = this.local(e);
    if (!t) {
      if (e.pointerType === 'mouse' && this.tracks.size === 0) this.h.onHover?.(p.x, p.y);
      return;
    }
    e.preventDefault();
    const dx = p.x - t.x;
    const dy = p.y - t.y;
    t.x = p.x;
    t.y = p.y;
    if (this.tracks.size >= 2) {
      const now = this.pinchState();
      if (now && this.pinchPrev) {
        const scale = now.d / Math.max(1, this.pinchPrev.d);
        let rot = now.a - this.pinchPrev.a;
        if (rot > Math.PI) rot -= Math.PI * 2;
        if (rot < -Math.PI) rot += Math.PI * 2;
        this.h.onPinch?.(now.cx, now.cy, scale, rot, now.cx - this.pinchPrev.cx, now.cy - this.pinchPrev.cy);
      }
      this.pinchPrev = now;
      return;
    }
    if (this.hadMulti) return; // ignore the leftover finger after a pinch
    if (!this.dragging) {
      if (Math.hypot(p.x - t.sx, p.y - t.sy) > TAP_SLOP) {
        this.dragging = true;
        this.clearLong();
        this.claimed = this.h.onDragStart?.(t.sx, t.sy, t.info) ?? false;
        this.h.onDrag?.(p.x, p.y, p.x - t.sx, p.y - t.sy, t.info, this.claimed);
      }
      return;
    }
    this.h.onDrag?.(p.x, p.y, dx, dy, t.info, this.claimed);
  };

  private up = (e: PointerEvent): void => {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    this.tracks.delete(e.pointerId);
    this.clearLong();
    if (this.tracks.size >= 1) {
      this.pinchPrev = this.pinchState();
      return;
    }
    this.pinchPrev = null;
    if (!this.enabled) return;
    const p = this.local(e);
    if (this.dragging) {
      this.h.onDragEnd?.(p.x, p.y, t.info, this.claimed);
      this.dragging = false;
      this.claimed = false;
      return;
    }
    if (this.hadMulti) return;
    const now = performance.now();
    // a tap or long press may open UI right under the finger; the click the browser sends next must not press it
    this.swallowUntil = now + 450;
    if (this.longFired) return;
    const dtime = now - t.t0;
    if (dtime > TAP_TIME) return;
    if (now - this.lastTap.t < DOUBLE_TAP && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30) {
      this.lastTap.t = 0;
      this.h.onDoubleTap?.(p.x, p.y, t.info);
      return;
    }
    this.lastTap = { t: now, x: p.x, y: p.y };
    this.h.onTap?.(p.x, p.y, t.info);
  };

  private swallowClick = (e: MouseEvent): void => {
    if (performance.now() > this.swallowUntil) return;
    this.swallowUntil = 0;
    if (e.target === this.el) return;
    e.preventDefault();
    e.stopPropagation();
  };

  private cancel = (e: PointerEvent): void => {
    this.tracks.delete(e.pointerId);
    this.clearLong();
    if (this.tracks.size === 0) {
      this.dragging = false;
      this.claimed = false;
      this.pinchPrev = null;
    }
  };

  private wheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const p = this.local(e);
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    this.h.onWheel?.(p.x, p.y, e.deltaY * unit);
  };
}

/** Keyboard state for camera panning and shortcuts. */
export class Keyboard {
  private down = new Set<string>();
  private handlers: ((e: KeyboardEvent) => void)[] = [];

  constructor() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onDown = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    this.down.add(e.code);
    for (const h of this.handlers) h(e);
  };

  private onUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  onKey(fn: (e: KeyboardEvent) => void): () => void {
    this.handlers.push(fn);
    return () => {
      const i = this.handlers.indexOf(fn);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.handlers = [];
  }
}
