import { DesigCat, type NodeData } from './format';

/** A star's primary designation split like the node data stores it (see designationOf). */
export interface ParsedDesignation {
  cat: number;
  lo: number;
  hi: number;
  /** The designation string for DesigCat.STRING. */
  str: string | null;
}

const NUMBERED: [RegExp, number][] = [
  [/^HR\s*(\d{1,6})$/i, DesigCat.HR],
  [/^HIP\s*(\d{1,7})$/i, DesigCat.HIP],
  [/^HD\s*(\d{1,7})$/i, DesigCat.HD],
];

/**
 * Splits a designation the way the node data stores it. Catalogue numbers are recognised in any
 * letter case and spacing ("hip 70890", "Gaia DR3 5853498713190525696"); anything else is a string
 * designation and kept as given (trimmed, inner whitespace collapsed).
 */
export function parseDesignation(text: string): ParsedDesignation {
  const s = /\s\s|^\s|\s$|[^\S ]/.test(text) ? text.trim().replace(/\s+/g, ' ') : text;
  // the first letter tells which patterns can match (this runs for every row of a CSV import)
  const c = s.charCodeAt(0) | 0x20;
  if (c === 0x68 /* h */) {
    for (const [re, cat] of NUMBERED) {
      const m = re.exec(s);
      if (m) return { cat, lo: Number(m[1]), hi: 0, str: null };
    }
  } else if (c === 0x74 /* t */) {
    const m = /^TYC\s*(\d{1,5})-(\d{1,5})-(\d{1,2})$/i.exec(s);
    if (m) {
      const t1 = Number(m[1]);
      const t2 = Number(m[2]);
      if (t1 < 65536 && t2 < 65536) return { cat: DesigCat.TYC, lo: t1 + t2 * 65536, hi: Number(m[3]), str: null };
    }
  } else if (c === 0x67 /* g */) {
    const m = /^Gaia\s*DR3\s*(\d{1,20})$/i.exec(s);
    const id = m ? parseUint64(m[1]) : null;
    if (id) return { cat: DesigCat.GAIA_DR3, lo: id[0], hi: id[1], str: null };
  }
  return { cat: DesigCat.STRING, lo: 0, hi: 0, str: s };
}

/** A decimal number below 2^64 as [low 32 bits, high 32 bits], or null if it is larger. */
function parseUint64(digits: string): [number, number] | null {
  // four 16-bit limbs, least significant first
  let l0 = 0, l1 = 0, l2 = 0, l3 = 0;
  for (let k = 0; k < digits.length; k++) {
    let v = l0 * 10 + (digits.charCodeAt(k) - 48);
    l0 = v & 0xffff;
    v = l1 * 10 + (v >>> 16);
    l1 = v & 0xffff;
    v = l2 * 10 + (v >>> 16);
    l2 = v & 0xffff;
    v = l3 * 10 + (v >>> 16);
    l3 = v & 0xffff;
    if (v >>> 16) return null;
  }
  return [l0 + l1 * 65536, l2 + l3 * 65536];
}

/** The decimal text of the 64-bit number hi * 2^32 + lo. */
function formatUint64(lo: number, hi: number): string {
  if (hi === 0) return String(lo);
  const limbs = [lo & 0xffff, lo >>> 16, hi & 0xffff, hi >>> 16];
  let out = '';
  for (;;) {
    // divide by 10^4, keep the remainder as the next four digits
    let rem = 0;
    let zero = true;
    for (let k = 3; k >= 0; k--) {
      const cur = rem * 65536 + limbs[k];
      limbs[k] = Math.floor(cur / 10000);
      rem = cur % 10000;
      if (limbs[k]) zero = false;
    }
    if (zero) return String(rem) + out;
    out = String(rem).padStart(4, '0') + out;
  }
}

/** The designation text exactly as designationOf() renders it. */
export function formatDesignation(d: ParsedDesignation): string {
  switch (d.cat) {
    case DesigCat.HIP:
      return `HIP ${d.lo}`;
    case DesigCat.HD:
      return `HD ${d.lo}`;
    case DesigCat.HR:
      return `HR ${d.lo}`;
    case DesigCat.TYC:
      return `TYC ${d.lo % 65536}-${Math.floor(d.lo / 65536)}-${d.hi}`;
    case DesigCat.GAIA_DR3:
      return `Gaia DR3 ${formatUint64(d.lo, d.hi)}`;
    default:
      return d.str ?? '';
  }
}

/** The canonical form of a designation typed by a user ("hip  70890" -> "HIP 70890"). */
export function canonicalDesignation(text: string): string {
  return formatDesignation(parseDesignation(text));
}

/** True if the text is a catalogue number in one of the numeric designation systems. */
export function isCatalogueNumber(text: string): boolean {
  return parseDesignation(text).cat !== DesigCat.STRING;
}

/** Entries of a DesignationMap as arrays (DesignationMap.pack). */
export interface PackedDesignations<T> {
  cat: Uint8Array;
  lo: Uint32Array;
  hi: Uint32Array;
  names: string[];
  values: T[];
}

/** Values of the catalogue numbers that share a low word (rarely more than one). */
interface Slot<T> {
  hi: number;
  value: T;
  next: Slot<T> | null;
}

/**
 * Values keyed by star designation, with a lookup for star i of a node that needs no string
 * building for catalogue numbers (it runs for every loaded star whenever the map is restyled).
 * Catalogue numbers are kept as numbers only (a site dataset may hold 200,000 of them): their
 * text is built when the entries are listed.
 */
export class DesignationMap<T> {
  /** String designations (names such as "Sun", other catalogues). */
  private readonly strings = new Map<string, T>();
  /** cat -> lo -> values by hi (a short list, not a map per number) */
  private readonly numeric = new Map<number, Map<number, Slot<T>>>();
  private numericCount = 0;

  get size(): number {
    return this.strings.size + this.numericCount;
  }

  /** Sets the value of a designation (any spelling, or already parsed). */
  set(designation: string | ParsedDesignation, value: T): void {
    const d = typeof designation === 'string' ? parseDesignation(designation) : designation;
    if (d.cat === DesigCat.STRING) {
      this.strings.set(d.str ?? '', value);
      return;
    }
    let a = this.numeric.get(d.cat);
    if (!a) this.numeric.set(d.cat, (a = new Map()));
    const hi = slotHi(d.cat, d.hi);
    const first = a.get(d.lo);
    for (let x: Slot<T> | null | undefined = first; x; x = x.next) {
      if (x.hi === hi) {
        x.value = value;
        return;
      }
    }
    a.set(d.lo, { hi, value, next: first ?? null });
    this.numericCount++;
  }

  delete(designation: string | ParsedDesignation): boolean {
    const d = typeof designation === 'string' ? parseDesignation(designation) : designation;
    if (d.cat === DesigCat.STRING) return this.strings.delete(d.str ?? '');
    const a = this.numeric.get(d.cat);
    const hi = slotHi(d.cat, d.hi);
    let prev: Slot<T> | null = null;
    for (let x = a?.get(d.lo) ?? null; x; prev = x, x = x.next) {
      if (x.hi !== hi) continue;
      if (prev) prev.next = x.next;
      else if (x.next) a!.set(d.lo, x.next);
      else a!.delete(d.lo);
      this.numericCount--;
      return true;
    }
    return false;
  }

  clear(): void {
    this.strings.clear();
    this.numeric.clear();
    this.numericCount = 0;
  }

  /** Value of a designation in any spelling. */
  getText(designation: string | ParsedDesignation): T | undefined {
    const d = typeof designation === 'string' ? parseDesignation(designation) : designation;
    if (d.cat === DesigCat.STRING) return this.strings.get(d.str ?? '');
    const hi = slotHi(d.cat, d.hi);
    for (let x: Slot<T> | null | undefined = this.numeric.get(d.cat)?.get(d.lo); x; x = x.next) if (x.hi === hi) return x.value;
    return undefined;
  }

  /** Lookup by a designation that is already canonical (taken from the node data). */
  getExact(designation: string): T | undefined {
    return this.strings.get(designation) ?? (this.numericCount ? this.getText(designation) : undefined);
  }

  /** Value of star i of a node (by its primary designation). */
  get(node: NodeData, i: number): T | undefined {
    const cat = node.desigCat[i];
    if (cat === DesigCat.STRING || cat > DesigCat.HR) {
      const s = node.designations.get(i);
      return s === undefined ? undefined : this.strings.get(s);
    }
    const hi = slotHi(cat, node.desigId[2 * i + 1]);
    for (let x: Slot<T> | null | undefined = this.numeric.get(cat)?.get(node.desigId[2 * i]); x; x = x.next) if (x.hi === hi) return x.value;
    return undefined;
  }

  /** Designations (canonical text) and values: string designations first, then catalogue numbers. */
  *entries(): IterableIterator<[string, T]> {
    yield* this.strings.entries();
    for (const [cat, a] of this.numeric)
      for (const [lo, first] of a)
        for (let x: Slot<T> | null = first; x; x = x.next) yield [formatDesignation({ cat, lo, hi: x.hi, str: null }), x.value];
  }

  /**
   * All entries as arrays (for storage without building designation texts): catalogue numbers as
   * cat / lo / hi, then the string designations; `values` in the same order.
   */
  pack(): PackedDesignations<T> {
    const n = this.numericCount;
    const cat = new Uint8Array(n);
    const lo = new Uint32Array(n);
    const hi = new Uint32Array(n);
    const values: T[] = new Array(n + this.strings.size);
    let k = 0;
    for (const [c, a] of this.numeric)
      for (const [l, first] of a)
        for (let x: Slot<T> | null = first; x; x = x.next) {
          cat[k] = c;
          lo[k] = l;
          hi[k] = x.hi;
          values[k++] = x.value;
        }
    const names = [...this.strings.keys()];
    for (const v of this.strings.values()) values[k++] = v;
    return { cat, lo, hi, names, values };
  }

  /** Adds packed entries (see pack); `convert` may reject a value with null. */
  unpack(p: PackedDesignations<unknown>, convert: (v: unknown) => T | null): void {
    const n = Math.min(p.cat.length, p.lo.length, p.hi.length);
    for (let k = 0; k < n; k++) {
      const v = convert(p.values[k]);
      if (v !== null && p.cat[k] !== DesigCat.STRING) this.set({ cat: p.cat[k], lo: p.lo[k], hi: p.hi[k], str: null }, v);
    }
    p.names.forEach((name, j) => {
      const v = convert(p.values[n + j]);
      if (v !== null && typeof name === 'string') this.set(name, v);
    });
  }

  *values(): IterableIterator<T> {
    yield* this.strings.values();
    for (const a of this.numeric.values()) for (const first of a.values()) for (let x: Slot<T> | null = first; x; x = x.next) yield x.value;
  }
}

/** The high word that counts for a catalogue (only TYC and Gaia DR3 numbers use it). */
function slotHi(cat: number, hi: number): number {
  return cat === DesigCat.TYC || cat === DesigCat.GAIA_DR3 ? hi : 0;
}
