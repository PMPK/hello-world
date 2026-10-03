/**
 * Tiny async key-value store on IndexedDB, with a localStorage fallback for
 * environments where IndexedDB is unavailable (some private modes, tests).
 */
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

const DB_NAME = 'planet-x';
const STORE = 'saves';

class IdbStore implements KVStore {
  private dbp: Promise<IDBDatabase>;

  constructor() {
    this.dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.dbp;
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
  }

  async get(key: string): Promise<string | null> {
    const v = await this.tx<unknown>('readonly', (s) => s.get(key));
    return typeof v === 'string' ? v : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.tx('readwrite', (s) => s.put(value, key));
  }

  async delete(key: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(key));
  }

  async keys(): Promise<string[]> {
    const k = await this.tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return k.map(String);
  }
}

const LS_PREFIX = 'planet-x:';

class LocalStore implements KVStore {
  async get(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(LS_PREFIX + key);
    } catch {
      return null;
    }
  }
  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(LS_PREFIX + key, value);
  }
  async delete(key: string): Promise<void> {
    try {
      localStorage.removeItem(LS_PREFIX + key);
    } catch {
      /* ignore */
    }
  }
  async keys(): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
      }
    } catch {
      /* ignore */
    }
    return out;
  }
}

/** In-memory store (tests, or when every persistent option fails). */
export class MemoryStore implements KVStore {
  private m = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.m.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.m.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.m.keys()];
  }
}

/** Pick the best available store, verifying IndexedDB actually works. */
export async function openStore(): Promise<KVStore> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const s = new IdbStore();
      await s.set('__probe', '1');
      await s.delete('__probe');
      return s;
    } catch {
      /* fall through */
    }
  }
  try {
    localStorage.setItem(LS_PREFIX + '__probe', '1');
    localStorage.removeItem(LS_PREFIX + '__probe');
    return new LocalStore();
  } catch {
    return new MemoryStore();
  }
}
