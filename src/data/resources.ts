/**
 * Resource definitions.
 *
 * Stockpiled resources live in base storage (and extractor buffers / convoys).
 * Energy is a *flow* (generation vs. demand per base), not a stockpile.
 * People (population / workforce) are tracked separately on each base.
 */

export const STOCK_RESOURCES = [
  'minerals',
  'hydrocarbons',
  'food',
  'refined',
  'components',
  'fuel',
  'ammo',
] as const;

export type StockResourceId = (typeof STOCK_RESOURCES)[number];
export type ResourceId = StockResourceId | 'energy';

export type Stock = Record<StockResourceId, number>;
export type PartialStock = Partial<Record<StockResourceId, number>>;

export interface ResourceDef {
  id: ResourceId;
  name: string;
  /** Short label for compact HUD chips. */
  short: string;
  category: 'raw' | 'processed';
  color: string;
  description: string;
}

export const RESOURCES: Record<ResourceId, ResourceDef> = {
  minerals: {
    id: 'minerals',
    name: 'Minerals',
    short: 'MIN',
    category: 'raw',
    color: '#9aa7b0',
    description: 'Raw ore hauled from mining outposts. Smelted into refined materials.',
  },
  hydrocarbons: {
    id: 'hydrocarbons',
    name: 'Hydrocarbons',
    short: 'HYD',
    category: 'raw',
    color: '#7d6a4f',
    description: 'Crude pumped from wells. Burned for power, cracked into fuel, used for propellant.',
  },
  food: {
    id: 'food',
    name: 'Food',
    short: 'FOOD',
    category: 'raw',
    color: '#8fbf5a',
    description: 'Grown in agri-domes. Every person and soldier eats.',
  },
  energy: {
    id: 'energy',
    name: 'Energy',
    short: 'PWR',
    category: 'raw',
    color: '#f2c94c',
    description: 'Electrical generation vs. demand. Deficits slow every powered building.',
  },
  refined: {
    id: 'refined',
    name: 'Refined Materials',
    short: 'ALY',
    category: 'processed',
    color: '#c7d0d6',
    description: 'Structural alloys. Used for construction, vehicles and components.',
  },
  components: {
    id: 'components',
    name: 'Components',
    short: 'CMP',
    category: 'processed',
    color: '#5fb3c9',
    description: 'Electronics, optics and machine parts produced in the industrial factory.',
  },
  fuel: {
    id: 'fuel',
    name: 'Fuel',
    short: 'FUEL',
    category: 'processed',
    color: '#d98b3a',
    description: 'Diesel and turbine fuel. Vehicles burn it when moving.',
  },
  ammo: {
    id: 'ammo',
    name: 'Ammunition',
    short: 'AMMO',
    category: 'processed',
    color: '#d35b4a',
    description: 'Small arms, heavy machine gun and tank rounds. Spent in battle.',
  },
};

export function emptyStock(): Stock {
  return { minerals: 0, hydrocarbons: 0, food: 0, refined: 0, components: 0, fuel: 0, ammo: 0 };
}

export function stockFrom(p: PartialStock): Stock {
  const s = emptyStock();
  for (const k of STOCK_RESOURCES) s[k] = p[k] ?? 0;
  return s;
}

/** True if `stock` has at least `cost` of every resource. */
export function canAfford(stock: Stock, cost: PartialStock, multiplier = 1): boolean {
  for (const k of STOCK_RESOURCES) {
    const c = (cost[k] ?? 0) * multiplier;
    if (c > 0 && stock[k] + 1e-9 < c) return false;
  }
  return true;
}

export function payCost(stock: Stock, cost: PartialStock, multiplier = 1): void {
  for (const k of STOCK_RESOURCES) {
    const c = (cost[k] ?? 0) * multiplier;
    if (c > 0) stock[k] = Math.max(0, stock[k] - c);
  }
}

export function addToStock(stock: Stock, add: PartialStock, multiplier = 1): void {
  for (const k of STOCK_RESOURCES) {
    const c = (add[k] ?? 0) * multiplier;
    if (c) stock[k] += c;
  }
}

export function sumPartial(a: PartialStock, b: PartialStock): PartialStock {
  const r: PartialStock = { ...a };
  for (const k of STOCK_RESOURCES) {
    if (b[k]) r[k] = (r[k] ?? 0) + (b[k] ?? 0);
  }
  return r;
}

export function stockTotal(p: PartialStock): number {
  let t = 0;
  for (const k of STOCK_RESOURCES) t += p[k] ?? 0;
  return t;
}

/** Which resources are missing for `cost` (for UI messages). */
export function missingFor(stock: Stock, cost: PartialStock): StockResourceId[] {
  const out: StockResourceId[] = [];
  for (const k of STOCK_RESOURCES) {
    const c = cost[k] ?? 0;
    if (c > 0 && stock[k] + 1e-9 < c) out.push(k);
  }
  return out;
}

export function formatCost(cost: PartialStock): string {
  return STOCK_RESOURCES.filter((k) => (cost[k] ?? 0) > 0)
    .map((k) => `${Math.round(cost[k] ?? 0)} ${RESOURCES[k].short}`)
    .join(' · ');
}
