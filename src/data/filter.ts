// Star filter (README "Filter"): the stars within a radius of the Sun or of the view centre that
// meet a set of criteria (spectral class, planets, names, systems, an attribute), as a list sorted
// by distance and as rims on the map.
import type { Vector3 } from 'three';
import type { AttrValue } from './attributes';
import { toCsv } from './csv';
import { Flag, spectralClassOf, type NodeData } from './format';
import type { OctreeNode } from './octree';

/** Spectral classes of the filter; BD: brown dwarfs (L, T, Y), WD: white dwarfs. */
export const CLASS_KEYS = ['O', 'B', 'A', 'F', 'G', 'K', 'M', 'BD', 'WD'] as const;
export type ClassKey = (typeof CLASS_KEYS)[number];

/** 'any': planets do not matter; 'planets': known planets; 'habitable': a potentially habitable one. */
export type PlanetCriterion = 'any' | 'planets' | 'habitable';
export type CentreKind = 'sun' | 'view';
/** 'single': only stars that are not part of a multiple system; 'multiple': only members of one. */
export type SystemCriterion = 'both' | 'single' | 'multiple';

/** An attribute's value: a text equal to `text` (ignoring case), or a number in [min, max]. */
export interface AttrCriterion {
  id: string;
  text?: string;
  min?: number;
  max?: number;
}

export interface FilterCriteria {
  centre: CentreKind;
  /** Light years. */
  radius: number;
  /** Empty: every class. */
  classes: ClassKey[];
  planets: PlanetCriterion;
  named: boolean;
  systems: SystemCriterion;
  attr: AttrCriterion | null;
}

export const RADIUS_PRESETS = [10, 30, 100, 300] as const;
export const MIN_FILTER_RADIUS = 1;
export const MAX_FILTER_RADIUS = 3000;

export const DEFAULT_CRITERIA: FilterCriteria = {
  centre: 'sun',
  radius: 30,
  classes: [],
  planets: 'any',
  named: false,
  systems: 'both',
  attr: null,
};

/** The criteria from stored JSON (anything malformed: the default). */
export function readCriteria(v: unknown): FilterCriteria {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<FilterCriteria> & { multiple?: unknown };
  const d = DEFAULT_CRITERIA;
  const radius = typeof o.radius === 'number' && Number.isFinite(o.radius) ? clampRadius(o.radius) : d.radius;
  const classes = Array.isArray(o.classes) ? CLASS_KEYS.filter((k) => o.classes!.includes(k)) : d.classes;
  const attr = o.attr && typeof o.attr === 'object' && typeof o.attr.id === 'string' ? cleanAttr(o.attr) : null;
  return {
    centre: o.centre === 'view' ? 'view' : 'sun',
    radius,
    classes,
    planets: o.planets === 'planets' || o.planets === 'habitable' ? o.planets : 'any',
    named: o.named === true,
    // (version 1.14 had a checkbox "only members of multiple systems")
    systems: o.systems === 'single' || o.systems === 'multiple' ? o.systems : o.multiple === true ? 'multiple' : 'both',
    attr,
  };
}

function cleanAttr(a: AttrCriterion): AttrCriterion {
  const out: AttrCriterion = { id: a.id };
  if (typeof a.text === 'string') out.text = a.text;
  if (typeof a.min === 'number' && Number.isFinite(a.min)) out.min = a.min;
  if (typeof a.max === 'number' && Number.isFinite(a.max)) out.max = a.max;
  return out;
}

export function clampRadius(r: number): number {
  return Math.min(Math.max(r, MIN_FILTER_RADIUS), MAX_FILTER_RADIUS);
}

/** The filter class of star i, or undefined if its class is unknown. */
export function classKeyOf(node: NodeData, i: number): ClassKey | undefined {
  const f = node.flags[i];
  if (f & Flag.WHITE_DWARF) return 'WD';
  if (f & Flag.BROWN_DWARF) return 'BD';
  const c = spectralClassOf(node.spec[i]);
  if (!c) return undefined;
  const l = c[0];
  if (l === 'L' || l === 'T' || l === 'Y') return 'BD';
  if (l === 'D') return 'WD';
  return (CLASS_KEYS as readonly string[]).includes(l) ? (l as ClassKey) : undefined;
}

/** Whether a value meets an attribute criterion (no value never does). */
export function attrMatches(v: AttrValue | undefined, a: AttrCriterion): boolean {
  if (v === undefined) return false;
  if (typeof v === 'number') {
    if (a.min !== undefined && v < a.min) return false;
    if (a.max !== undefined && v > a.max) return false;
    return true;
  }
  const want = (a.text ?? '').trim().toLocaleLowerCase();
  // no text given: any value
  return !want || v.trim().toLocaleLowerCase() === want;
}

/** What the matcher needs to know of a star beyond the node data. */
export interface StarContext {
  /** The planet class (render/style planetClass). */
  planetClass(node: NodeData, i: number): 'sun' | 'habitable' | 'planets' | undefined;
  /** The value of the criterion's attribute (render/style valueGetter). */
  value?: (node: NodeData, i: number) => AttrValue | undefined;
}

/** Whether star i meets every criterion except the distance. */
export function starMatcher(c: FilterCriteria, ctx: StarContext): (node: NodeData, i: number) => boolean {
  const classes = c.classes.length ? new Set<ClassKey>(c.classes) : null;
  const attr = c.attr;
  const value = attr ? ctx.value : undefined;
  return (node, i) => {
    if (classes) {
      const k = classKeyOf(node, i);
      if (!k || !classes.has(k)) return false;
    }
    if (c.planets !== 'any') {
      const p = ctx.planetClass(node, i);
      // the Sun has planets, one of them inhabited
      if (!p || (c.planets === 'habitable' && p === 'planets')) return false;
    }
    if (c.named && !node.names.has(i) && !(node.flags[i] & Flag.SUN)) return false;
    if (c.systems !== 'both' && (c.systems === 'multiple') !== ((node.flags[i] & Flag.IN_SYSTEM) !== 0)) return false;
    if (attr) {
      if (!value || !attrMatches(value(node, i), attr)) return false;
    }
    return true;
  };
}

/** Whether a filter selects anything beyond the distance (the list then is every star). */
export function hasCriteria(c: FilterCriteria): boolean {
  return c.classes.length > 0 || c.planets !== 'any' || c.named || c.systems !== 'both' || c.attr !== null;
}

/**
 * The nodes whose cubes reach into the sphere, coarse to fine (the coarser nodes hold the more
 * luminous stars), nearest first within a level, until their files would exceed `maxBytes`.
 * `complete`: every star of the sphere is in them (no node was left out, none has descendants
 * that are not known yet).
 */
export function sphereNodes(root: OctreeNode, centre: Vector3, radius: number, maxBytes: number): { nodes: OctreeNode[]; complete: boolean; bytes: number } {
  const nodes: OctreeNode[] = [];
  let bytes = 0;
  let complete = true;
  let level: OctreeNode[] = root.box.distanceToPoint(centre) <= radius ? [root] : [];
  while (level.length) {
    level.sort((a, b) => a.box.distanceToPoint(centre) - b.box.distanceToPoint(centre));
    const next: OctreeNode[] = [];
    for (const n of level) {
      if (bytes + n.bytes > maxBytes) return { nodes, complete: false, bytes };
      nodes.push(n);
      bytes += n.bytes;
      if (n.childMask !== 0 && n.children.length === 0) complete = false;
      for (const ch of n.children) if (ch.box.distanceToPoint(centre) <= radius) next.push(ch);
    }
    level = next;
  }
  return { nodes, complete, bytes };
}

export interface FilterHit {
  path: string;
  index: number;
  /** Distance from the filter's centre (ly). */
  dist: number;
}

/**
 * The stars of the given nodes within `radius` of `centre` that `match` accepts, nearest first.
 * `pos` is where star i is drawn now.
 */
export function scanStars(
  nodes: Iterable<NodeData>,
  centre: Vector3,
  radius: number,
  match: (node: NodeData, i: number) => boolean,
  pos: (node: NodeData, i: number, out: Vector3) => Vector3,
  scratch: Vector3,
): FilterHit[] {
  const hits: FilterHit[] = [];
  const r2 = radius * radius;
  for (const d of nodes) {
    for (let i = 0; i < d.count; i++) {
      const p = pos(d, i, scratch);
      const dd = p.distanceToSquared(centre);
      if (dd > r2 || !match(d, i)) continue;
      hits.push({ path: d.path, index: i, dist: Math.sqrt(dd) });
    }
  }
  hits.sort((a, b) => a.dist - b.dist || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.index - b.index));
  return hits;
}

/** The keys of the hits ("path" -> star indices), for the rims on the map. */
export function hitSet(hits: FilterHit[]): Map<string, Set<number>> {
  const m = new Map<string, Set<number>>();
  for (const h of hits) {
    let s = m.get(h.path);
    if (!s) m.set(h.path, (s = new Set()));
    s.add(h.index);
  }
  return m;
}

/** A star of the list as the CSV export writes it. */
export interface CsvStar {
  designation: string;
  name: string;
  dist: number;
  spec: string | null;
  planets: number;
}

/**
 * The list as CSV: the designation first (the attribute import's key column, so that a column
 * added in a spreadsheet can be imported back), the name, the distance from the filter's centre,
 * the spectral type and the number of known planets, and the filter attribute's value (`extra`).
 * German: semicolons and decimal commas.
 */
export function starsCsv(
  stars: CsvStar[],
  header: [string, string, string, string, string],
  lang: 'en' | 'de',
  extra?: { header: string; value: (k: number) => string },
): string {
  const num = (x: number) => (lang === 'de' ? x.toFixed(3).replace('.', ',') : x.toFixed(3));
  const head: string[] = extra ? [...header, extra.header] : [...header];
  const rows = [head, ...stars.map((r, k) => {
    const row = [r.designation, r.name, num(r.dist), r.spec ?? '', r.planets ? String(r.planets) : ''];
    if (extra) row.push(extra.value(k));
    return row;
  })];
  return toCsv(rows, lang === 'de' ? ';' : ',');
}

/** What the list can be sorted by: distance, name, spectral class, number of planets, the attribute. */
export type SortKey = 'dist' | 'name' | 'spec' | 'planets' | 'value';
export const SORT_KEYS: readonly SortKey[] = ['dist', 'name', 'spec', 'planets', 'value'];

export interface SortableRow {
  name: string;
  dist: number;
  /** The `spec` code (spectral class × 10 + subclass, hot to cool; 255 unknown). */
  specCode: number;
  planets: number;
  /** The filter attribute's value. */
  valueKey?: number | string;
}

/**
 * The rows sorted by a key (a copy). Rows without a value for it (no spectral class, no attribute
 * value) come last either way; ties go by distance.
 */
export function sortRows<T extends SortableRow>(rows: readonly T[], key: SortKey, desc: boolean, locale?: string): T[] {
  const has = (r: T) => (key === 'spec' ? r.specCode !== 255 : key === 'value' ? r.valueKey !== undefined : true);
  const cmp = (a: T, b: T): number => {
    switch (key) {
      case 'dist':
        return a.dist - b.dist;
      case 'name':
        return a.name.localeCompare(b.name, locale, { numeric: true, sensitivity: 'base' });
      case 'spec':
        return a.specCode - b.specCode;
      case 'planets':
        return a.planets - b.planets;
      case 'value': {
        const x = a.valueKey!;
        const y = b.valueKey!;
        if (typeof x === 'number' && typeof y === 'number') return x - y;
        return String(x).localeCompare(String(y), locale, { numeric: true, sensitivity: 'base' });
      }
    }
  };
  return [...rows].sort((a, b) => {
    const ha = has(a);
    const hb = has(b);
    if (ha !== hb) return ha ? -1 : 1;
    const c = ha ? cmp(a, b) : 0;
    return (desc ? -c : c) || a.dist - b.dist;
  });
}
