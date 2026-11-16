// The world a faction grows in (docs/FACTIONS.md): the jump network around its home star as a
// FactionGraph, which places it settles, and the stars of each place (for their rims).
import { CLASS_KEYS, classKeyOf, type ClassKey } from '../data/filter';
import { NODE_KEY_SHIFT } from '../data/octree';
import type { JumpNetwork } from '../network/places';
import { SOLAR_EMPIRE, type FactionDef, type FactionGraph } from './sim';

/**
 * The stars of each place, compactly: place p's are start[p] .. start[p + 1] - 1, each a source
 * of the network (its node) and the star's index there.
 */
export interface PlaceMembers {
  start: Int32Array;
  source: Int32Array;
  index: Int32Array;
}

export interface FactionWorld {
  graph: FactionGraph;
  /** Stars of each place (a system has several). */
  members: PlaceMembers;
  net: JumpNetwork;
}

/** The stars of each place of a network (in node order, then by index). */
export function placeMembers(net: JumpNetwork): PlaceMembers {
  const { places } = net;
  const n = places.count;
  const start = new Int32Array(n + 1);
  const sourceOf = new Map(places.sources.map((s, k) => [s.data.path, k]));
  let total = 0;
  for (const own of places.starPlace.values()) {
    for (let i = 0; i < own.length; i++) {
      if (own[i] < 0) continue;
      start[own[i] + 1]++;
      total++;
    }
  }
  for (let p = 0; p < n; p++) start[p + 1] += start[p];
  const fill = start.slice(0, n);
  const source = new Int32Array(total);
  const index = new Int32Array(total);
  for (const [path, own] of places.starPlace) {
    const s = sourceOf.get(path) ?? -1;
    for (let i = 0; i < own.length; i++) {
      const p = own[i];
      if (p < 0) continue;
      source[fill[p]] = s;
      index[fill[p]++] = i;
    }
  }
  return { start, source, index };
}

/**
 * The faction's graph of a network: its places and links; a place is settled when its brightest
 * shown star is of one of the classes, and (singleOnly) when it is a star of its own, not a system.
 * With the network's node keys (see buildPlaces) a star's key finds its place directly.
 * `growable`: the region can grow (FactionGraph.growable).
 */
export function factionWorld(net: JumpNetwork, def: Pick<FactionDef, 'targets' | 'singleOnly'>, nodeKey?: (path: string) => number, growable = false): FactionWorld {
  const { places, links } = net;
  const members = placeMembers(net);
  const graph: FactionGraph = { count: places.count, keys: places.keys, links, target: targetsOf(net, members, def), growable };
  if (nodeKey) {
    const byKey = new Map<number, Int32Array>();
    for (const [path, own] of places.starPlace) byKey.set(nodeKey(path), own);
    graph.placeOf = (key) => {
      const node = Math.floor(key / NODE_KEY_SHIFT);
      return byKey.get(node)?.[key - node * NODE_KEY_SHIFT] ?? -1;
    };
  }
  return { graph, members, net };
}

/** Which places a faction settles (see factionWorld). */
export function targetsOf(net: JumpNetwork, members: PlaceMembers, def: Pick<FactionDef, 'targets' | 'singleOnly'>): Uint8Array {
  const { places } = net;
  const want = new Set<ClassKey>(def.targets);
  const out = new Uint8Array(places.count);
  for (let p = 0; p < places.count; p++) {
    if (def.singleOnly && (members.start[p + 1] - members.start[p] !== 1 || places.system[p] >= 0)) continue;
    const src = places.sources[places.repSource[p]];
    const k = classKeyOf(src.data, places.repIndex[p]);
    if (k && want.has(k)) out[p] = 1;
  }
  return out;
}

/** (Version 1.19 stored other parameters: those are not read.) */
const STORE_KEY = 'galactic-map:factions:v2';
/**
 * The region a faction grows in (docs/FACTIONS.md, "The region"): first this radius (ly) around
 * its home, then larger by this factor whenever nothing is left within reach in it, at most
 * REGION_MAX (500 ly around the Sun hold some 900,000 places).
 */
export const REGION_START = 100;
export const REGION_GROWTH = 1.25;
export const REGION_MAX = 500;

/** The next region's radius: REGION_GROWTH times larger, at most REGION_MAX (also when it would be nearly as large). */
export function nextRegion(radius: number): number {
  const r = Math.round(radius * REGION_GROWTH);
  return r > 0.9 * REGION_MAX ? REGION_MAX : r;
}
/** Most colonies a faction may be given. */
export const MAX_COLONIES = 1_000_000;
/** At most this many factions (the star shader has as many rim colours). */
export const MAX_FACTIONS = 8;
/** Colours of new factions, in turn (the Solar Empire's first). */
export const FACTION_COLORS = ['#40e0d0', '#ff6b6b', '#ffd84d', '#b58cff', '#7ed957', '#ff9f43', '#4e9bff', '#ff7ac6'];

/** A stored faction, checked field by field (anything missing or malformed: the Solar Empire's). */
export function readDef(v: unknown, base: FactionDef = SOLAR_EMPIRE): FactionDef {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<FactionDef>;
  const num = (x: unknown, lo: number, hi: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(Math.max(x, lo), hi) : d);
  const str = (x: unknown, d: string) => (typeof x === 'string' && x.trim() ? x.trim() : d);
  const hint = o.homeHint;
  const out: FactionDef = {
    id: str(o.id, base.id),
    name: { en: str(o.name?.en, base.name.en), de: str(o.name?.de, base.name.de) },
    color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : base.color,
    home: str(o.home, base.home),
    startYear: Math.round(num(o.startYear, -100_000, 100_000, base.startYear)),
    incomeStep: num(o.incomeStep, 0.001, 1e6, base.incomeStep),
    maxIncome: num(o.maxIncome, 0, 1e9, base.maxIncome),
    targets: Array.isArray(o.targets) ? CLASS_KEYS.filter((k) => o.targets!.includes(k)) : [...base.targets],
    singleOnly: typeof o.singleOnly === 'boolean' ? o.singleOnly : base.singleOnly,
    maxColonies: Math.round(num(o.maxColonies, 1, MAX_COLONIES, base.maxColonies)),
  };
  if (typeof o.homeName === 'string' && o.homeName) out.homeName = o.homeName;
  if (hint && typeof hint === 'object' && typeof hint.path === 'string' && [hint.x, hint.y, hint.z].every((c) => typeof c === 'number' && Number.isFinite(c))) {
    out.homeHint = { path: hint.path, x: hint.x, y: hint.y, z: hint.z };
  }
  return out;
}

export function readDefs(): FactionDef[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (Array.isArray(v)) {
        const defs = v.slice(0, MAX_FACTIONS).map((d) => readDef(d));
        // ids are unique (a malformed one takes a fresh id)
        const seen = new Set<string>();
        defs.forEach((d, k) => {
          if (seen.has(d.id)) d.id = `f${k}-${Date.now()}`;
          seen.add(d.id);
        });
        return defs;
      }
    }
  } catch {
    // storage unavailable or malformed: the default
  }
  return [{ ...SOLAR_EMPIRE, targets: [...SOLAR_EMPIRE.targets] }];
}

export function saveDefs(defs: FactionDef[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(defs));
  } catch {
    // storage unavailable: the factions are not kept
  }
}

/** A new faction with the Solar Empire's parameters, its own name, home and the next free colour. */
export function newFaction(name: string, home: { designation: string; name: string; path: string; x: number; y: number; z: number }, existing: FactionDef[]): FactionDef {
  const used = new Set(existing.map((d) => d.color.toLowerCase()));
  const color = FACTION_COLORS.find((c) => !used.has(c)) ?? FACTION_COLORS[existing.length % FACTION_COLORS.length];
  return {
    ...SOLAR_EMPIRE,
    targets: [...SOLAR_EMPIRE.targets],
    id: `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: { en: name, de: name },
    color,
    home: home.designation,
    homeName: home.name,
    homeHint: { path: home.path, x: home.x, y: home.y, z: home.z },
  };
}
