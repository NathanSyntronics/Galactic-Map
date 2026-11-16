// The world a faction grows in (docs/FACTIONS.md): the jump network around its home star as a
// FactionGraph, which places it settles, and the stars of each place (for their rims).
import { CLASS_KEYS, classKeyOf, type ClassKey } from '../data/filter';
import type { JumpNetwork } from '../network/places';
import { SOLAR_EMPIRE, type FactionDef, type FactionGraph } from './sim';

export interface FactionWorld {
  graph: FactionGraph;
  /** Stars of each place: node paths and indices (a system has several). */
  members: { path: string; index: number }[][];
  net: JumpNetwork;
}

/**
 * The faction's graph of a network: its places and links; a place is settled when its brightest
 * shown star is of one of the classes, and (singleOnly) when it is a star of its own, not a system.
 */
export function factionWorld(net: JumpNetwork, def: Pick<FactionDef, 'targets' | 'singleOnly'>): FactionWorld {
  const { places, links } = net;
  const n = places.count;
  const members: { path: string; index: number }[][] = Array.from({ length: n }, () => []);
  for (const [path, own] of places.starPlace) {
    for (let i = 0; i < own.length; i++) if (own[i] >= 0) members[own[i]].push({ path, index: i });
  }
  return { graph: { count: n, keys: places.keys, links, target: targetsOf(net, members, def) }, members, net };
}

/** Which places a faction settles (see factionWorld). */
export function targetsOf(net: JumpNetwork, members: { path: string; index: number }[][], def: Pick<FactionDef, 'targets' | 'singleOnly'>): Uint8Array {
  const { places } = net;
  const want = new Set<ClassKey>(def.targets);
  const out = new Uint8Array(places.count);
  for (let p = 0; p < places.count; p++) {
    if (def.singleOnly && (members[p].length !== 1 || places.system[p] >= 0)) continue;
    const src = places.sources[places.repSource[p]];
    const k = classKeyOf(src.data, places.repIndex[p]);
    if (k && want.has(k)) out[p] = 1;
  }
  return out;
}

const STORE_KEY = 'galactic-map:factions';
/** Largest region (ly): 250 ly around the Sun hold some 130,000 places, close to the network's limit. */
export const MAX_REGION = 250;

/** A stored faction, checked field by field (anything missing or malformed: the Solar Empire's). */
export function readDef(v: unknown, base: FactionDef = SOLAR_EMPIRE): FactionDef {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<FactionDef>;
  const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d);
  const str = (x: unknown, d: string) => (typeof x === 'string' && x.trim() ? x.trim() : d);
  const cost = (o.cost && typeof o.cost === 'object' ? o.cost : {}) as Partial<FactionDef['cost']>;
  return {
    id: str(o.id, base.id),
    name: { en: str(o.name?.en, base.name.en), de: str(o.name?.de, base.name.de) },
    color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : base.color,
    home: str(o.home, base.home),
    startYear: Math.round(num(o.startYear, -100_000, 100_000, base.startYear)),
    startIncome: num(o.startIncome, 0, 1e6, base.startIncome),
    incomeStep: num(o.incomeStep, 0, 1e6, base.incomeStep),
    maxIncome: num(o.maxIncome, 0, 1e9, base.maxIncome),
    cost: { exp: typeof cost.exp === 'boolean' ? cost.exp : base.cost.exp, k: num(cost.k, 0.5, 5, base.cost.k) },
    targets: Array.isArray(o.targets) ? CLASS_KEYS.filter((k) => o.targets!.includes(k)) : [...base.targets],
    singleOnly: typeof o.singleOnly === 'boolean' ? o.singleOnly : base.singleOnly,
    region: num(o.region, 20, MAX_REGION, base.region),
  };
}

export function readDefs(): FactionDef[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (Array.isArray(v) && v.length) return v.slice(0, 4).map((d) => readDef(d));
    }
  } catch {
    // storage unavailable or malformed: the default
  }
  return [{ ...SOLAR_EMPIRE, targets: [...SOLAR_EMPIRE.targets], cost: { ...SOLAR_EMPIRE.cost } }];
}

export function saveDefs(defs: FactionDef[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(defs));
  } catch {
    // storage unavailable: the factions are not kept
  }
}
