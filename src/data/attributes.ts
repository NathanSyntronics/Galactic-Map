import { DesignationMap, canonicalDesignation } from './designation';

/** number: measured or counted values; text: categories and notes; color: '#rrggbb' per star. */
export type AttrType = 'number' | 'text' | 'color';
export type AttrValue = number | string;

export interface AttributeDef {
  id: string;
  name: string;
  type: AttrType;
  /** A value stored under a system's primary star applies to every member of the system. */
  system: boolean;
}

export type PaletteId = 'turbo' | 'plasma' | 'blueRed' | 'greens';

/** How an attribute is drawn when the map is coloured or sized by it (user and built-in attributes). */
export interface AttributeScale {
  palette?: PaletteId;
  /** Range of the colour / size scale; undefined: the range of the values. */
  min?: number;
  max?: number;
  log?: boolean;
  /** Colours of text values chosen by the user ('#rrggbb'); the others get palette colours. */
  colors?: Record<string, string>;
}

export interface StoredAttributes {
  v: 1;
  defs: AttributeDef[];
  values: Record<string, Record<string, AttrValue>>;
  scales?: Record<string, AttributeScale>;
}

export type ChangeKind = 'defs' | 'values' | 'scales';
type Listener = (kind: ChangeKind) => void;

const STORAGE_KEY = 'galactic-map:attributes:v1';
export const COLOR_RE = /^#[0-9a-f]{6}$/i;

/** '#abc' / 'ABCDEF' / '#AbCdEf' -> '#abcdef'; null if it is not a hex colour. */
export function normalizeColor(s: string): string | null {
  let v = s.trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return COLOR_RE.test(v) ? v : null;
}

/** The value converted to the attribute type, or null if it does not fit. */
export function coerceValue(type: AttrType, v: AttrValue): AttrValue | null {
  if (type === 'number') {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const n = Number(v.trim());
    return v.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  if (type === 'color') return normalizeColor(String(v));
  const s = String(v).trim();
  return s ? s : null;
}

/**
 * The user's star attributes: definitions plus values keyed by the stars' primary designations.
 * Kept in localStorage; the optional site dataset (public/user/attributes.csv) is only the
 * starting point for visitors who have no data of their own yet.
 */
export class AttributeStore {
  private defsList: AttributeDef[] = [];
  private readonly maps = new Map<string, DesignationMap<AttrValue>>();
  private scaleMap: Record<string, AttributeScale> = {};
  private listeners: Listener[] = [];
  private saveTimer = 0;
  /** Set when the last save failed (storage full or unavailable). */
  saveError: unknown = null;
  onSaveError: (err: unknown) => void = () => {};

  constructor(private readonly persist = true) {}

  get defs(): readonly AttributeDef[] {
    return this.defsList;
  }

  def(id: string): AttributeDef | undefined {
    return this.defsList.find((d) => d.id === id);
  }

  defByName(name: string): AttributeDef | undefined {
    const n = name.trim().toLowerCase();
    return this.defsList.find((d) => d.name.toLowerCase() === n);
  }

  values(id: string): DesignationMap<AttrValue> {
    let m = this.maps.get(id);
    if (!m) this.maps.set(id, (m = new DesignationMap()));
    return m;
  }

  valueCount(id: string): number {
    return this.maps.get(id)?.size ?? 0;
  }

  /** True if no attribute is defined. */
  get isEmpty(): boolean {
    return this.defsList.length === 0;
  }

  scale(id: string): AttributeScale {
    return this.scaleMap[id] ?? {};
  }

  setScale(id: string, patch: Partial<AttributeScale>): void {
    const next: AttributeScale = { ...this.scale(id), ...patch };
    for (const k of Object.keys(next) as (keyof AttributeScale)[]) if (next[k] === undefined) delete next[k];
    this.scaleMap[id] = next;
    this.changed('scales');
  }

  addDef(name: string, type: AttrType, system = false): AttributeDef {
    const clean = name.trim();
    if (!clean) throw new Error('empty attribute name');
    if (this.defByName(clean)) throw new Error(`attribute '${clean}' exists`);
    const base = clean.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'attr';
    let id = base;
    for (let k = 2; this.def(id) || id.startsWith('@'); k++) id = `${base}-${k}`;
    const def: AttributeDef = { id, name: clean, type, system };
    this.defsList = [...this.defsList, def];
    this.changed('defs');
    return def;
  }

  /**
   * Changes name, type or the system flag. A type change converts the values; values that do not
   * fit the new type are dropped and their number is returned.
   */
  updateDef(id: string, patch: Partial<Omit<AttributeDef, 'id'>>): number {
    const def = this.def(id);
    if (!def) return 0;
    if (patch.name !== undefined) {
      const clean = patch.name.trim();
      const other = this.defByName(clean);
      if (!clean || (other && other.id !== id)) throw new Error(`attribute name '${clean}' not available`);
      patch = { ...patch, name: clean };
    }
    let dropped = 0;
    if (patch.type && patch.type !== def.type) {
      const m = this.values(id);
      for (const [k, v] of [...m.entries()]) {
        const c = coerceValue(patch.type, v);
        if (c === null) {
          m.delete(k);
          dropped++;
        } else m.set(k, c);
      }
      const sc = { ...this.scale(id) };
      delete sc.colors;
      this.scaleMap[id] = sc;
    }
    this.defsList = this.defsList.map((d) => (d.id === id ? { ...d, ...patch } : d));
    this.changed('defs');
    return dropped;
  }

  removeDef(id: string): void {
    this.defsList = this.defsList.filter((d) => d.id !== id);
    this.maps.delete(id);
    delete this.scaleMap[id];
    this.changed('defs');
  }

  /** Sets (or with null / '' deletes) the value of a star; returns false if it does not fit the type. */
  setValue(id: string, designation: string, value: AttrValue | null, notify = true): boolean {
    const def = this.def(id);
    if (!def) return false;
    const m = this.values(id);
    if (value === null || (typeof value === 'string' && value.trim() === '')) {
      m.delete(designation);
    } else {
      const c = coerceValue(def.type, value);
      if (c === null) return false;
      m.set(designation, c);
    }
    if (notify) this.changed('values');
    return true;
  }

  getValue(id: string, designation: string): AttrValue | undefined {
    return this.maps.get(id)?.getText(designation);
  }

  /** Removes all values of an attribute. */
  clearValues(id: string, notify = true): void {
    this.maps.get(id)?.clear();
    if (notify) this.changed('values');
  }

  /** Distinct values of a text / colour attribute in first-seen order. */
  distinct(id: string): string[] {
    const seen = new Set<string>();
    for (const v of this.maps.get(id)?.values() ?? []) seen.add(String(v));
    return [...seen];
  }

  /** Min / max of a numeric attribute (positive values only when `positive`). */
  range(id: string, positive = false): [number, number] | null {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of this.maps.get(id)?.values() ?? []) {
      if (typeof v !== 'number' || (positive && v <= 0)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return lo <= hi ? [lo, hi] : null;
  }

  /** Notifies listeners after a batch of changes made with notify = false. */
  commit(kind: ChangeKind = 'values'): void {
    this.changed(kind);
  }

  subscribe(l: Listener): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }

  // ------------------------------------------------------------------ persistence

  toJSON(): StoredAttributes {
    const values: Record<string, Record<string, AttrValue>> = {};
    for (const d of this.defsList) {
      const o: Record<string, AttrValue> = {};
      for (const [k, v] of this.values(d.id).entries()) o[k] = v;
      values[d.id] = o;
    }
    return { v: 1, defs: this.defsList.map((d) => ({ ...d })), values, scales: this.scaleMap };
  }

  /** Replaces the whole state. */
  load(data: StoredAttributes, notify = true): void {
    this.defsList = [];
    this.maps.clear();
    this.scaleMap = {};
    for (const d of data.defs ?? []) {
      if (!d || typeof d.id !== 'string' || typeof d.name !== 'string' || this.def(d.id)) continue;
      const type: AttrType = d.type === 'number' || d.type === 'color' ? d.type : 'text';
      this.defsList.push({ id: d.id, name: d.name, type, system: !!d.system });
      const m = this.values(d.id);
      for (const [k, v] of Object.entries(data.values?.[d.id] ?? {})) {
        const c = coerceValue(type, v);
        if (c !== null) m.set(canonicalDesignation(k), c);
      }
    }
    for (const [k, v] of Object.entries(data.scales ?? {})) if (v && typeof v === 'object') this.scaleMap[k] = { ...v };
    if (notify) this.changed('defs', false);
  }

  /** The stored state of this browser, or null if there is none. */
  static readStored(): StoredAttributes | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredAttributes;
      return parsed && parsed.v === 1 && Array.isArray(parsed.defs) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Forgets this browser's data (the site dataset applies again on the next start). */
  clearStored(): void {
    window.clearTimeout(this.saveTimer);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // nothing stored
    }
  }

  private changed(kind: ChangeKind, save = true): void {
    if (save && this.persist) this.scheduleSave();
    for (const l of this.listeners) l(kind);
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.saveNow(), 300);
  }

  saveNow(): void {
    window.clearTimeout(this.saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      this.saveError = null;
    } catch (err) {
      this.saveError = err;
      this.onSaveError(err);
    }
  }
}
