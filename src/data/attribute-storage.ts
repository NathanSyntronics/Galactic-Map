import type { AttributeStore, PackedAttributes, StoredAttributes } from './attributes';

/** Where the user's attributes are kept between visits. */
export interface AttributeStorage {
  /** The stored state, or null if there is none. */
  read(): Promise<StoredAttributes | PackedAttributes | null>;
  /** Stores the store's current state (taken when the write runs). */
  write(store: AttributeStore): Promise<void>;
  /** Forgets the stored state. */
  clear(): Promise<void>;
}

/** localStorage key of the attributes up to version 1 of the app (now only a fallback). */
export const LOCAL_STORAGE_KEY = 'galactic-map:attributes:v1';

const DB_NAME = 'galactic-map';
const DB_STORE = 'attributes';
const DB_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    req.onblocked = () => reject(new Error('indexedDB blocked'));
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = op(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
  });
}

function readLocal(): StoredAttributes | null {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAttributes;
    return parsed && parsed.v === 1 && Array.isArray(parsed.defs) ? parsed : null;
  } catch {
    return null;
  }
}

function removeLocal(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

function isStored(v: unknown): v is StoredAttributes | PackedAttributes {
  const o = v as { v?: unknown; defs?: unknown } | null;
  return !!o && typeof o === 'object' && (o.v === 1 || o.v === 2) && Array.isArray(o.defs);
}

/**
 * The browser's storage: IndexedDB, with the values packed in typed arrays (a site dataset of
 * 200,000 values is saved in a few milliseconds and does not fit localStorage's 5 MB as text).
 * Data of earlier versions in localStorage is moved over on the first read. Where IndexedDB is
 * unavailable (some private modes), localStorage is used as before.
 * Operations run one after the other, so a write never lands after a later clear.
 */
export class BrowserAttributeStorage implements AttributeStorage {
  private db: Promise<IDBDatabase | null> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private database(): Promise<IDBDatabase | null> {
    if (!this.db) {
      this.db = typeof indexedDB === 'undefined' ? Promise.resolve(null) : openDb().catch((err) => {
        console.warn('indexedDB unavailable, attributes go to localStorage', err);
        return null;
      });
    }
    return this.db;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }

  read(): Promise<StoredAttributes | PackedAttributes | null> {
    return this.enqueue(async () => {
      const db = await this.database();
      if (db) {
        try {
          const v = await run(db, 'readonly', (s) => s.get(DB_KEY));
          if (isStored(v)) return v;
        } catch (err) {
          console.warn('stored attributes unreadable', err);
        }
      }
      const legacy = readLocal();
      if (legacy && db) {
        // moved to IndexedDB; localStorage keeps it until that succeeded
        try {
          await run(db, 'readwrite', (s) => s.put(legacy, DB_KEY));
          removeLocal();
        } catch (err) {
          console.warn('attributes not moved to indexedDB', err);
        }
      }
      return legacy;
    });
  }

  write(store: AttributeStore): Promise<void> {
    return this.enqueue(async () => {
      const db = await this.database();
      if (db) {
        await run(db, 'readwrite', (s) => s.put(store.pack(), DB_KEY));
        removeLocal();
        return;
      }
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(store.toJSON()));
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      removeLocal();
      const db = await this.database();
      if (db) await run(db, 'readwrite', (s) => s.delete(DB_KEY));
    });
  }
}
