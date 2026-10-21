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
  const s = text.trim().replace(/\s+/g, ' ');
  for (const [re, cat] of NUMBERED) {
    const m = re.exec(s);
    if (m) return { cat, lo: Number(m[1]), hi: 0, str: null };
  }
  let m = /^TYC\s*(\d{1,5})-(\d{1,5})-(\d{1,2})$/i.exec(s);
  if (m) {
    const t1 = Number(m[1]);
    const t2 = Number(m[2]);
    if (t1 < 65536 && t2 < 65536) return { cat: DesigCat.TYC, lo: t1 + t2 * 65536, hi: Number(m[3]), str: null };
  }
  m = /^Gaia\s*DR3\s*(\d{1,20})$/i.exec(s);
  if (m) {
    const id = BigInt(m[1]);
    if (id < 1n << 64n) {
      return { cat: DesigCat.GAIA_DR3, lo: Number(id & 0xffffffffn), hi: Number(id >> 32n), str: null };
    }
  }
  return { cat: DesigCat.STRING, lo: 0, hi: 0, str: s };
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
      return `Gaia DR3 ${(BigInt(d.hi) << 32n) | BigInt(d.lo)}`;
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

/**
 * Values keyed by star designation, with a lookup for star i of a node that needs no string
 * building for catalogue numbers (it runs for every loaded star whenever the map is restyled).
 */
export class DesignationMap<T> {
  private readonly byText = new Map<string, T>();
  /** cat -> lo -> hi -> value */
  private readonly numeric = new Map<number, Map<number, Map<number, T>>>();

  get size(): number {
    return this.byText.size;
  }

  /** Sets the value of a designation; returns its canonical text. */
  set(designation: string, value: T): string {
    const d = parseDesignation(designation);
    const key = formatDesignation(d);
    this.byText.set(key, value);
    if (d.cat !== DesigCat.STRING) {
      let a = this.numeric.get(d.cat);
      if (!a) this.numeric.set(d.cat, (a = new Map()));
      let b = a.get(d.lo);
      if (!b) a.set(d.lo, (b = new Map()));
      b.set(d.hi, value);
    }
    return key;
  }

  delete(designation: string): boolean {
    const d = parseDesignation(designation);
    const key = formatDesignation(d);
    if (!this.byText.delete(key)) return false;
    if (d.cat !== DesigCat.STRING) {
      const b = this.numeric.get(d.cat)?.get(d.lo);
      b?.delete(d.hi);
      if (b && b.size === 0) this.numeric.get(d.cat)!.delete(d.lo);
    }
    return true;
  }

  clear(): void {
    this.byText.clear();
    this.numeric.clear();
  }

  getText(designation: string): T | undefined {
    return this.byText.get(canonicalDesignation(designation));
  }

  /** Lookup by a designation that is already canonical (taken from the node data). */
  getExact(designation: string): T | undefined {
    return this.byText.get(designation);
  }

  /** Value of star i of a node (by its primary designation). */
  get(node: NodeData, i: number): T | undefined {
    const cat = node.desigCat[i];
    if (cat === DesigCat.STRING || cat > DesigCat.HR) {
      const s = node.designations.get(i);
      return s === undefined ? undefined : this.byText.get(s);
    }
    return this.numeric.get(cat)?.get(node.desigId[2 * i])?.get(cat === DesigCat.TYC || cat === DesigCat.GAIA_DR3 ? node.desigId[2 * i + 1] : 0);
  }

  entries(): IterableIterator<[string, T]> {
    return this.byText.entries();
  }

  values(): IterableIterator<T> {
    return this.byText.values();
  }
}
