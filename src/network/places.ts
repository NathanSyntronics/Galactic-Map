/**
 * Places of the jump network (docs/JUMP_NETWORK.md): the shown stars around the view centre,
 * grouped by multiple system, each represented by its most luminous shown member. No three.js
 * objects or DOM; the star sources are plain arrays (Starfield's rendered nodes fit).
 */
import type { NodeData } from '../data/format';
import { starLogL } from '../render/starfield';
import { capacityFromLogL, capacityFromPosition, computeJumpLinks, linksOfPlace, type JumpLinks, type PlaceLink } from './jumps';

/** Stars of one loaded octree node. */
export interface PlaceSource {
  data: NodeData;
  /** Symbol size per star; 0 means hidden. */
  sizes: Float32Array;
  /** Current colour per star (RGB 0..255). */
  colors: Uint8Array;
}

/** How many links a place wants. */
export type CapacityRule =
  | { by: 'luminosity'; faint: number; sun: number; bright: number }
  | {
      by: 'position';
      /** Position 0..1 of the star's value on the attribute's scale; undefined without a value. */
      position: (data: NodeData, i: number) => number | undefined;
      faint: number;
      bright: number;
    };

export interface PlaceOptions {
  centre: { x: number; y: number; z: number };
  /** Only stars within this distance of the centre take part. */
  radius: number;
  capacity: CapacityRule;
  /** Stable number per node path, for the tie-break key of a star. */
  nodeKey: (path: string) => number;
  /** Stop when there are more places than this. */
  maxPlaces?: number;
}

export interface PlaceSet {
  count: number;
  /** World position of each place's representative (x, y, z). */
  positions: Float64Array;
  capacities: Int32Array;
  /** Stable key of the representative star (node key * 2^24 + index). */
  keys: Float64Array;
  /** Representative star: index into `sources` and the star's index in its node. */
  repSource: Int32Array;
  repIndex: Int32Array;
  /** System id of each place, -1 for a single star. */
  system: Float64Array;
  sources: PlaceSource[];
  /** Place of every star by node path (-1: not part of the network). */
  starPlace: Map<string, Int32Array>;
  /** More than maxPlaces places: the set is incomplete. */
  overflow: boolean;
}

const KEY_SHIFT = 2 ** 24;

/** More places than this are not computed (keeps a computation well below 0.5 s). */
export const MAX_PLACES = 150_000;
/** More candidate pairs than this are not computed (about 0.2 µs each). */
export const MAX_PAIRS = 1_500_000;

/** Margin around the visible sphere whose stars take part, so links inside it do not depend on the view. */
export function jumpMargin(range: number): number {
  return 3 * range;
}

/** Groups the shown stars within `radius` of the centre into places. */
export function buildPlaces(sources: PlaceSource[], opt: PlaceOptions): PlaceSet {
  const { x: cx, y: cy, z: cz } = opt.centre;
  const r2 = opt.radius * opt.radius;
  const max = opt.maxPlaces ?? Infinity;
  const nodeKeys = sources.map((s) => opt.nodeKey(s.data.path) * KEY_SHIFT);
  const byPosition = opt.capacity.by === 'position';

  let size = 1024;
  let repSource = new Int32Array(size);
  let repIndex = new Int32Array(size);
  let repLogL = new Float64Array(size);
  let system = new Float64Array(size);
  let n = 0;
  const grow = (): void => {
    size *= 2;
    const g = <T extends Int32Array | Float64Array>(a: T): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a);
      return b;
    };
    repSource = g(repSource);
    repIndex = g(repIndex);
    repLogL = g(repLogL);
    system = g(system);
  };
  const add = (s: number, i: number, logL: number, sid: number): number => {
    if (n === size) grow();
    repSource[n] = s;
    repIndex[n] = i;
    repLogL[n] = logL;
    system[n] = sid;
    return n++;
  };

  const sysPlace = new Map<number, number>();
  /** Members (source, index pairs) of system places, only needed for attribute fallbacks. */
  const members = new Map<number, number[]>();
  const starPlace = new Map<string, Int32Array>();
  let overflow = false;

  outer: for (let s = 0; s < sources.length; s++) {
    const { data: d, sizes } = sources[s];
    const p = d.positions;
    const hasSystems = d.systems.size > 0;
    let own: Int32Array | null = null;
    for (let i = 0; i < d.count; i++) {
      if (!(sizes[i] > 0)) continue;
      const dx = p[3 * i] - cx;
      const dy = p[3 * i + 1] - cy;
      const dz = p[3 * i + 2] - cz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      if (!own) {
        own = new Int32Array(d.count).fill(-1);
        starPlace.set(d.path, own);
      }
      const logL = starLogL(d, i);
      const sid = hasSystems ? d.systems.get(i) : undefined;
      let place: number;
      if (sid === undefined) {
        place = add(s, i, logL, -1);
      } else {
        const q = sysPlace.get(sid);
        if (q === undefined) {
          place = add(s, i, logL, sid);
          sysPlace.set(sid, place);
        } else {
          place = q;
          const better =
            logL > repLogL[q] || (logL === repLogL[q] && nodeKeys[s] + i < nodeKeys[repSource[q]] + repIndex[q]);
          if (better) {
            repSource[q] = s;
            repIndex[q] = i;
            repLogL[q] = logL;
          }
        }
        if (byPosition) {
          const m = members.get(place);
          if (m) m.push(s, i);
          else members.set(place, [s, i]);
        }
      }
      own[i] = place;
      if (n > max) {
        overflow = true;
        break outer;
      }
    }
  }

  const positions = new Float64Array(3 * n);
  const capacities = new Int32Array(n);
  const keys = new Float64Array(n);
  const rule = opt.capacity;
  for (let k = 0; k < n; k++) {
    const d = sources[repSource[k]].data;
    const i = repIndex[k];
    positions[3 * k] = d.positions[3 * i];
    positions[3 * k + 1] = d.positions[3 * i + 1];
    positions[3 * k + 2] = d.positions[3 * i + 2];
    keys[k] = nodeKeys[repSource[k]] + i;
    if (rule.by === 'luminosity') {
      capacities[k] = capacityFromLogL(repLogL[k], rule.faint, rule.sun, rule.bright);
      continue;
    }
    let t = rule.position(d, i);
    if (t === undefined && system[k] >= 0) {
      // another member's value: the most luminous member that has one
      const m = members.get(k) ?? [];
      let bestL = -Infinity;
      let bestKey = Infinity;
      for (let j = 0; j < m.length; j += 2) {
        const md = sources[m[j]].data;
        const mi = m[j + 1];
        const v = rule.position(md, mi);
        if (v === undefined) continue;
        const l = starLogL(md, mi);
        const key = nodeKeys[m[j]] + mi;
        if (l > bestL || (l === bestL && key < bestKey)) {
          bestL = l;
          bestKey = key;
          t = v;
        }
      }
    }
    capacities[k] = t === undefined ? Math.max(0, Math.round(rule.faint)) : capacityFromPosition(t, rule.faint, rule.bright);
  }

  return {
    count: n,
    positions,
    capacities,
    keys,
    repSource: repSource.slice(0, n),
    repIndex: repIndex.slice(0, n),
    system: system.slice(0, n),
    sources,
    starPlace,
    overflow,
  };
}

/** Place of star `i` of the node at `path`, or -1. */
export function placeOfStar(places: PlaceSet, path: string, i: number): number {
  const own = places.starPlace.get(path);
  return own && i >= 0 && i < own.length ? own[i] : -1;
}

// ------------------------------------------------------------------ network

export interface NetworkOptions extends PlaceOptions {
  range: number;
  hub: number;
  /** Capacity of the Sun (jumpSun). */
  kSun: number;
  connect: boolean;
  maxCandidates?: number;
}

export interface JumpNetwork {
  places: PlaceSet;
  links: JumpLinks;
  /**
   * Why there are no links: too many places or candidate pairs, or the region's stars are not all
   * loaded at this quality ('detail', set by the app).
   */
  overflow: 'places' | 'pairs' | 'detail' | null;
  /** View centre and region radius of the computation. */
  centre: { x: number; y: number; z: number };
  region: number;
  range: number;
}

function noLinks(): JumpLinks {
  const a = new Uint32Array(0);
  return { count: 0, a, b: a, length: new Float32Array(0), kind: new Uint8Array(0), candidates: 0, overflow: false };
}

/** Places and links around the centre (docs/JUMP_NETWORK.md). */
export function computeNetwork(sources: PlaceSource[], opt: NetworkOptions): JumpNetwork {
  const places = buildPlaces(sources, opt);
  const base = { places, centre: { ...opt.centre }, region: opt.radius, range: opt.range };
  if (places.overflow) return { ...base, links: noLinks(), overflow: 'places' };
  const links = computeJumpLinks(
    { count: places.count, positions: places.positions, capacities: places.capacities, keys: places.keys },
    { range: opt.range, hub: opt.hub, kSun: opt.kSun, connect: opt.connect, maxCandidates: opt.maxCandidates },
  );
  return { ...base, links, overflow: links.overflow ? 'pairs' : null };
}

/** Links of a star's place, nearest first, or null when the star is not part of the network. */
export function linksOfStar(net: JumpNetwork, path: string, i: number): { place: number; links: PlaceLink[] } | null {
  const place = placeOfStar(net.places, path, i);
  if (place < 0) return null;
  return { place, links: linksOfPlace(net.links, place) };
}
