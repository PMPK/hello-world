/**
 * Generic 8-connected grid A* with a binary heap on typed arrays.
 * Used by the strategic map (armies, roads) and by tactical battles.
 */
export interface GridGraph {
  w: number;
  h: number;
  /** Cost multiplier for entering a cell; Infinity = blocked. */
  cost(i: number, j: number): number;
}

class MinHeap {
  private idx: Int32Array;
  private pri: Float32Array;
  size = 0;

  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.pri = new Float32Array(cap);
  }

  push(i: number, p: number): void {
    if (this.size >= this.idx.length) {
      const ni = new Int32Array(this.idx.length * 2);
      ni.set(this.idx);
      this.idx = ni;
      const np = new Float32Array(this.pri.length * 2);
      np.set(this.pri);
      this.pri = np;
    }
    let k = this.size++;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (this.pri[parent] <= p) break;
      this.idx[k] = this.idx[parent];
      this.pri[k] = this.pri[parent];
      k = parent;
    }
    this.idx[k] = i;
    this.pri[k] = p;
  }

  pop(): number {
    const top = this.idx[0];
    const lastI = this.idx[--this.size];
    const lastP = this.pri[this.size];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.pri[c + 1] < this.pri[c]) c++;
      if (this.pri[c] >= lastP) break;
      this.idx[k] = this.idx[c];
      this.pri[k] = this.pri[c];
      k = c;
    }
    this.idx[k] = lastI;
    this.pri[k] = lastP;
    return top;
  }
}

const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

/**
 * Returns the list of cell indices (j*w+i) from start to goal (inclusive),
 * or null when unreachable. `minCost` is the lowest possible cell cost
 * (heuristic scale, keeps A* admissible).
 */
export function astar(
  g: GridGraph,
  si: number,
  sj: number,
  gi: number,
  gj: number,
  minCost = 1,
  maxExpanded = 200000,
): number[] | null {
  const { w, h } = g;
  if (si < 0 || sj < 0 || si >= w || sj >= h || gi < 0 || gj < 0 || gi >= w || gj >= h) return null;
  const n = w * h;
  const start = sj * w + si;
  const goal = gj * w + gi;
  if (start === goal) return [start];
  if (!Number.isFinite(g.cost(gi, gj))) return null;
  const gScore = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(1024);
  gScore[start] = 0;
  const hfn = (i: number, j: number): number => {
    const dx = Math.abs(i - gi);
    const dy = Math.abs(j - gj);
    return (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)) * minCost;
  };
  heap.push(start, hfn(si, sj));
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxExpanded) return null;
    const ci = cur % w;
    const cj = (cur - ci) / w;
    const cg = gScore[cur];
    for (const [dx, dy, len] of DIRS) {
      const ni = ci + dx;
      const nj = cj + dy;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
      const nIdx = nj * w + ni;
      if (closed[nIdx]) continue;
      const c = g.cost(ni, nj);
      if (!Number.isFinite(c)) continue;
      if (dx !== 0 && dy !== 0) {
        // no corner cutting through blocked cells
        if (!Number.isFinite(g.cost(ci + dx, cj)) || !Number.isFinite(g.cost(ci, cj + dy))) continue;
      }
      const ng = cg + len * c;
      if (ng < gScore[nIdx]) {
        gScore[nIdx] = ng;
        came[nIdx] = cur;
        heap.push(nIdx, ng + hfn(ni, nj));
      }
    }
  }
  if (came[goal] === -1) return null;
  const path: number[] = [];
  let c = goal;
  while (c !== -1) {
    path.push(c);
    if (c === start) break;
    c = came[c];
  }
  path.reverse();
  return path[0] === start ? path : null;
}

/** Nearest passable cell to (i, j) searching outward in rings. */
export function nearestPassable(g: GridGraph, i: number, j: number, maxRadius = 30): { i: number; j: number } | null {
  if (i >= 0 && j >= 0 && i < g.w && j < g.h && Number.isFinite(g.cost(i, j))) return { i, j };
  for (let r = 1; r <= maxRadius; r++) {
    let best: { i: number; j: number } | null = null;
    let bestD = Infinity;
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        if (!Number.isFinite(g.cost(ni, nj))) continue;
        const d = di * di + dj * dj;
        if (d < bestD) {
          bestD = d;
          best = { i: ni, j: nj };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Bresenham-style walk between two cells; returns the max cost encountered
 * (Infinity if blocked). Used for path smoothing.
 */
export function lineMaxCost(g: GridGraph, i0: number, j0: number, i1: number, j1: number): number {
  let maxC = 0;
  const steps = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0)) * 2 + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const i = Math.round(i0 + (i1 - i0) * t);
    const j = Math.round(j0 + (j1 - j0) * t);
    const c = g.cost(i, j);
    if (!Number.isFinite(c)) return Infinity;
    if (c > maxC) maxC = c;
  }
  return maxC;
}

/**
 * String-pulling smoothing: keep a waypoint only when the straight line to
 * a later waypoint would pass through blocked or noticeably costlier cells.
 */
export function smoothCellPath(g: GridGraph, cells: number[], tolerance = 1.05): number[] {
  if (cells.length <= 2) return cells.slice();
  const out = [cells[0]];
  let anchor = 0;
  while (anchor < cells.length - 1) {
    let best = anchor + 1;
    const ai = cells[anchor] % g.w;
    const aj = Math.floor(cells[anchor] / g.w);
    // max cost along the original sub-path, to compare against
    let subMax = g.cost(ai, aj);
    for (let k = anchor + 1; k < cells.length; k++) {
      const ki = cells[k] % g.w;
      const kj = Math.floor(cells[k] / g.w);
      subMax = Math.max(subMax, g.cost(ki, kj));
      const lc = lineMaxCost(g, ai, aj, ki, kj);
      if (lc <= subMax * tolerance) best = k;
      else if (k - anchor > 40) break;
    }
    out.push(cells[best]);
    anchor = best;
  }
  return out;
}
