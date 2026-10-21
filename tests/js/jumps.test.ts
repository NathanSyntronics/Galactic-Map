import { describe, expect, it } from 'vitest';
import {
  LinkKind,
  capacityFromLogL,
  capacityFromPosition,
  computeJumpLinks,
  linkDegrees,
  linksOfPlace,
  type JumpLinks,
  type JumpParams,
  type JumpPlaces,
} from '../../src/network/jumps';

const PARAMS: JumpParams = { range: 10, hub: 1, kSun: 7, connect: true };

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function places(xyz: number[][], caps: number[], keys?: number[]): JumpPlaces {
  return { count: xyz.length, positions: new Float64Array(xyz.flat()), capacities: caps, keys };
}

/** A box of random stars, a lattice with many equal distances, a remote pair and a lone star. */
function cloud(seed: number, n = 700): JumpPlaces {
  const r = rng(seed);
  const xyz: number[][] = [];
  const caps: number[] = [];
  for (let i = 0; i < n; i++) {
    xyz.push([r() * 60, r() * 60, r() * 60]);
    caps.push(capacityFromLogL(-6 + 9 * r(), 3, 7, 12));
  }
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++) {
        xyz.push([100 + 3 * i, 3 * j, 3 * k]);
        caps.push(1 + ((i + j + k) % 4));
      }
  xyz.push([300, 0, 0], [306, 0, 0], [500, 500, 500]);
  caps.push(3, 0, 5);
  return places(xyz, caps);
}

function pos(p: JumpPlaces, i: number): [number, number, number] {
  return [p.positions[3 * i], p.positions[3 * i + 1], p.positions[3 * i + 2]];
}

/** All pairs within range, by brute force. */
function bruteCandidates(p: JumpPlaces, range: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i < p.count; i++) {
    const [x, y, z] = pos(p, i);
    for (let j = i + 1; j < p.count; j++) {
      const [u, v, w] = pos(p, j);
      const dx = x - u, dy = y - v, dz = z - w;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= range * range) out.push([i, j, Math.sqrt(d2)]);
    }
  }
  return out;
}

class Components {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a: number, b: number): boolean {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return false;
    this.parent[rb] = ra;
    return true;
  }
}

/** The specification written out plainly: sorted candidate list, greedy, nearest, Kruskal. */
function reference(p: JumpPlaces, prm: JumpParams): string[] {
  const cand = bruteCandidates(p, prm.range);
  const cap = Array.from(p.capacities);
  const kSun = Math.max(1, prm.kSun);
  const placeCmp = (i: number, j: number): number => {
    const a = [...pos(p, i), p.keys?.[i] ?? 0], b = [...pos(p, j), p.keys?.[j] ?? 0];
    for (let c = 0; c < 4; c++) if (a[c] !== b[c]) return a[c] < b[c] ? -1 : 1;
    return 0;
  };
  const ordered = ([i, j]: number[]) => (placeCmp(i, j) <= 0 ? [i, j] : [j, i]);
  const pairCmp = (s: number[], t: number[]): number => {
    const [a, b] = ordered(s), [c, d] = ordered(t);
    return placeCmp(a, c) || placeCmp(b, d);
  };
  const w = (i: number) => Math.pow(kSun / cap[i], prm.hub);
  const cost = ([i, j, d]: number[]) => d * (w(i) * w(j));
  const links: string[] = [];
  const deg = new Array(p.count).fill(0);
  const free = cap.slice();
  const comps = new Components(p.count);
  const add = (i: number, j: number, kind: number) => {
    links.push(`${Math.min(i, j)}-${Math.max(i, j)}:${kind}`);
    comps.union(i, j);
  };
  const step1 = cand.filter(([i, j]) => cap[i] > 0 && cap[j] > 0);
  step1.sort((s, t) => cost(s) - cost(t) || s[2] - t[2] || pairCmp(s, t));
  for (const [i, j] of step1) {
    if (free[i] > 0 && free[j] > 0) {
      free[i]--;
      free[j]--;
      deg[i]++;
      deg[j]++;
      add(i, j, LinkKind.CAPACITY);
    }
  }
  const nearest = new Map<number, [number, number]>();
  for (const [i, j, d] of cand) {
    for (const [a, b] of [[i, j], [j, i]]) {
      if (deg[a] > 0) continue;
      const best = nearest.get(a);
      if (!best || d < best[1] || (d === best[1] && placeCmp(b, best[0]) < 0)) nearest.set(a, [b, d]);
    }
  }
  const added = new Set<string>();
  for (const [a, [b]] of nearest) {
    const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
    if (added.has(key)) continue;
    added.add(key);
    add(a, b, LinkKind.ALONE);
  }
  if (prm.connect) {
    const rest = cand.slice().sort((s, t) => s[2] - t[2] || pairCmp(s, t));
    for (const [i, j] of rest) if (comps.find(i) !== comps.find(j)) add(i, j, LinkKind.CONNECT);
  }
  return links.sort();
}

function linkList(l: JumpLinks): [number, number, number][] {
  return Array.from({ length: l.count }, (_, i) => [l.a[i], l.b[i], l.kind[i]] as [number, number, number]);
}

/** Link set as sorted strings "a-b:kind", with place indices mapped through `id`. */
function linkSet(l: JumpLinks, id: (i: number) => number = (i) => i): string[] {
  return linkList(l)
    .map(([a, b, k]) => {
      const [p, q] = [id(a), id(b)].sort((x, y) => x - y);
      return `${p}-${q}:${k}`;
    })
    .sort();
}

function shuffled(p: JumpPlaces, seed: number): { places: JumpPlaces; orig: number[] } {
  const r = rng(seed);
  const orig = Array.from({ length: p.count }, (_, i) => i);
  for (let i = orig.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [orig[i], orig[j]] = [orig[j], orig[i]];
  }
  return {
    places: {
      count: p.count,
      positions: new Float64Array(orig.flatMap((i) => pos(p, i))),
      capacities: orig.map((i) => p.capacities[i]),
      keys: p.keys ? orig.map((i) => p.keys![i]) : undefined,
    },
    orig,
  };
}

describe('capacity', () => {
  it('is piecewise linear in log L with the anchors of the specification', () => {
    expect(capacityFromLogL(-5, 3, 7, 12)).toBe(3);
    expect(capacityFromLogL(-4.5, 3, 7, 12)).toBe(3);
    expect(capacityFromLogL(-2, 3, 7, 12)).toBe(5);
    expect(capacityFromLogL(0, 3, 7, 12)).toBe(7);
    expect(capacityFromLogL(1.4, 3, 7, 12)).toBe(12);
    expect(capacityFromLogL(1.5, 3, 7, 12)).toBe(12);
    expect(capacityFromLogL(4, 3, 7, 12)).toBe(12);
    expect(capacityFromLogL(0.75, 3, 7, 12)).toBe(10);
    expect(capacityFromLogL(Number.NaN, 3, 7, 12)).toBe(3);
    expect(capacityFromLogL(-1, 0, 0, 0)).toBe(0);
  });

  it('follows the position on an attribute scale', () => {
    expect(capacityFromPosition(0, 3, 12)).toBe(3);
    expect(capacityFromPosition(1, 3, 12)).toBe(12);
    expect(capacityFromPosition(0.5, 3, 12)).toBe(8);
    expect(capacityFromPosition(2, 3, 12)).toBe(12);
    expect(capacityFromPosition(Number.NaN, 3, 12)).toBe(3);
    expect(capacityFromPosition(1, 12, 3)).toBe(3);
  });
});

describe('jump links', () => {
  it('links only candidates, respects capacities, leaves nobody alone and connects what the range connects', () => {
    const p = cloud(1);
    const l = computeJumpLinks(p, PARAMS);
    const cand = bruteCandidates(p, PARAMS.range);
    expect(l.overflow).toBe(false);
    expect(l.candidates).toBe(cand.length);
    const dist = new Map(cand.map(([i, j, d]) => [`${i}-${j}`, d]));

    const seen = new Set<string>();
    for (let i = 0; i < l.count; i++) {
      const key = `${l.a[i]}-${l.b[i]}`;
      expect(l.a[i]).toBeLessThan(l.b[i]);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(dist.has(key)).toBe(true);
      expect(l.length[i]).toBeCloseTo(dist.get(key)!, 4);
      expect(l.length[i]).toBeLessThanOrEqual(PARAMS.range + 1e-6);
    }

    const deg0 = linkDegrees(l, p.count, LinkKind.CAPACITY);
    const deg = linkDegrees(l, p.count);
    for (let i = 0; i < p.count; i++) expect(deg0[i]).toBeLessThanOrEqual(p.capacities[i]);
    for (let i = 0; i < l.count; i++) {
      if (l.kind[i] === LinkKind.ALONE) expect(Math.min(deg0[l.a[i]], deg0[l.b[i]])).toBe(0);
    }
    const hasCandidate = new Set(cand.flatMap(([i, j]) => [i, j]));
    for (let i = 0; i < p.count; i++) expect(deg[i] > 0).toBe(hasCandidate.has(i));
    // the zero-capacity star of the remote pair is linked anyway
    expect(deg[p.count - 2]).toBe(1);
    expect(deg[p.count - 1]).toBe(0);

    // same components as the range graph, with the fewest connection links
    const range = new Components(p.count);
    for (const [i, j] of cand) range.union(i, j);
    const net = new Components(p.count);
    const before = new Components(p.count);
    let parts = p.count;
    for (const [a, b, k] of linkList(l)) {
      net.union(a, b);
      if (k !== LinkKind.CONNECT && before.union(a, b)) parts--;
    }
    let rangeParts = p.count;
    const r2 = new Components(p.count);
    for (const [i, j] of cand) if (r2.union(i, j)) rangeParts--;
    for (const [i, j] of cand) expect(net.find(i)).toBe(net.find(j));
    for (let i = 0; i < p.count; i++)
      for (const j of [0, 300, p.count - 3]) expect(net.find(i) === net.find(j)).toBe(range.find(i) === range.find(j));
    expect(linkList(l).filter(([, , k]) => k === LinkKind.CONNECT).length).toBe(parts - rangeParts);
    expect(parts - rangeParts).toBeGreaterThan(0);
  });

  it('gives exactly the links of a plain implementation of the specification', () => {
    for (const seed of [21, 22, 23]) {
      const p = cloud(seed, 400);
      for (const params of [PARAMS, { ...PARAMS, hub: 0 }, { ...PARAMS, hub: 2, kSun: 5 }, { ...PARAMS, range: 4.5, connect: false }]) {
        expect(linkSet(computeJumpLinks(p, params))).toEqual(reference(p, params));
      }
    }
    // a lattice: almost every distance and cost is tied
    const xyz: number[][] = [];
    const caps: number[] = [];
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++)
        for (let k = 0; k < 6; k++) {
          xyz.push([2 * i, 2 * j, 2 * k]);
          caps.push([0, 1, 2, 3, 7][(i * 7 + j * 3 + k) % 5]);
        }
    const lattice = places(xyz, caps);
    for (const params of [PARAMS, { ...PARAMS, hub: 0, range: 2 }, { ...PARAMS, range: 3 }]) {
      expect(linkSet(computeJumpLinks(lattice, params))).toEqual(reference(lattice, params));
    }
  });

  it('adds no connection links when connecting is off and keeps the other links', () => {
    const p = cloud(2);
    const on = computeJumpLinks(p, PARAMS);
    const off = computeJumpLinks(p, { ...PARAMS, connect: false });
    expect(linkList(off).some(([, , k]) => k === LinkKind.CONNECT)).toBe(false);
    expect(linkSet(off)).toEqual(linkSet(on).filter((s) => !s.endsWith(`:${LinkKind.CONNECT}`)));
  });

  it('follows the three steps on a small example', () => {
    // A - C - B on a line, capacity 1 each: A-C wins the tie, B is left alone and joins C
    const p = places([[0, 0, 0], [2, 0, 0], [1, 0, 0]], [1, 1, 1]);
    const l = computeJumpLinks(p, { range: 1.5, hub: 0, kSun: 7, connect: true });
    expect(linkSet(l)).toEqual([`0-2:${LinkKind.CAPACITY}`, `1-2:${LinkKind.ALONE}`]);
    // a chain of four: two pairs, joined by one connection link
    const chain = places([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]], [1, 1, 1, 1]);
    const c = computeJumpLinks(chain, { range: 1.5, hub: 0, kSun: 7, connect: true });
    expect(linkSet(c)).toEqual([`0-1:${LinkKind.CAPACITY}`, `1-2:${LinkKind.CONNECT}`, `2-3:${LinkKind.CAPACITY}`]);
    const off = computeJumpLinks(chain, { range: 1.5, hub: 0, kSun: 7, connect: false });
    expect(off.count).toBe(2);
  });

  it('serves big places first with the hub preference', () => {
    // ten faint stars on a ring, a bright star above its centre, a bit farther than second neighbours
    const xyz: number[][] = [];
    for (let i = 0; i < 10; i++) xyz.push([5 * Math.cos((i * Math.PI) / 5), 5 * Math.sin((i * Math.PI) / 5), 0]);
    xyz.push([0, 0, 4]);
    const p = places(xyz, [...Array(10).fill(3), 12]);
    const hubDegree = (hub: number) => linkDegrees(computeJumpLinks(p, { ...PARAMS, hub }), p.count)[10];
    expect(hubDegree(1)).toBe(10);
    expect(hubDegree(2)).toBe(10);
    expect(hubDegree(0)).toBeLessThanOrEqual(4);
  });

  it('does not depend on the input order', () => {
    const p = cloud(3);
    for (const params of [PARAMS, { ...PARAMS, hub: 0 }, { ...PARAMS, hub: 2, connect: false }, { ...PARAMS, range: 4 }]) {
      const l = computeJumpLinks(p, params);
      for (const seed of [11, 12]) {
        const s = shuffled(p, seed);
        expect(linkSet(computeJumpLinks(s.places, params), (i) => s.orig[i])).toEqual(linkSet(l));
      }
    }
  });

  it('breaks ties between coincident places by their keys', () => {
    const p = places([[1, 2, 3], [1, 2, 3], [1, 2, 3], [1, 2, 3]], [1, 1, 1, 1], [40, 10, 30, 20]);
    const l = computeJumpLinks(p, { range: 1, hub: 0, kSun: 7, connect: true });
    // keys 10-20 and 30-40 by capacity, then 10-30 connects
    expect(linkSet(l)).toEqual([`0-2:${LinkKind.CAPACITY}`, `1-2:${LinkKind.CONNECT}`, `1-3:${LinkKind.CAPACITY}`]);
    expect(Array.from(l.length)).toEqual([0, 0, 0]);
    for (const seed of [1, 2, 3]) {
      const s = shuffled(p, seed);
      expect(linkSet(computeJumpLinks(s.places, { range: 1, hub: 0, kSun: 7, connect: true }), (i) => s.orig[i])).toEqual(linkSet(l));
    }
  });

  it('handles empty input, a single place, no range and invalid positions', () => {
    const none = computeJumpLinks(places([], []), PARAMS);
    expect(none.count).toBe(0);
    expect(none.overflow).toBe(false);
    expect(computeJumpLinks(places([[0, 0, 0]], [7]), PARAMS).count).toBe(0);
    expect(computeJumpLinks(places([[0, 0, 0], [1, 0, 0]], [7, 7]), { ...PARAMS, range: 0 }).count).toBe(0);
    const l = computeJumpLinks(places([[0, 0, 0], [Number.NaN, 0, 0], [1, 0, 0]], [7, 7, 7]), PARAMS);
    expect(linkSet(l)).toEqual([`0-2:${LinkKind.CAPACITY}`]);
  });

  it('finds all candidates when far apart groups force bigger grid cells', () => {
    const r = rng(9);
    const xyz: number[][] = [];
    for (let g = 0; g < 3; g++) for (let i = 0; i < 40; i++) xyz.push([g * 1e6 + r() * 8, r() * 8, g * -3e5 + r() * 8]);
    const p = places(xyz, xyz.map(() => 4));
    const l = computeJumpLinks(p, { ...PARAMS, range: 2 });
    expect(l.candidates).toBe(bruteCandidates(p, 2).length);
  });

  it('gives up beyond the candidate limit', () => {
    const p = cloud(4);
    const l = computeJumpLinks(p, { ...PARAMS, maxCandidates: 100 });
    expect(l.overflow).toBe(true);
    expect(l.count).toBe(0);
    const all = computeJumpLinks(p, PARAMS);
    expect(computeJumpLinks(p, { ...PARAMS, maxCandidates: all.candidates }).overflow).toBe(false);
  });

  it('lists the links of one place, nearest first', () => {
    const p = places([[0, 0, 0], [3, 0, 0], [0, 1, 0], [0, 0, 2]], [3, 3, 3, 3]);
    const l = computeJumpLinks(p, PARAMS);
    expect(linksOfPlace(l, 0).map((x) => [x.partner, x.length])).toEqual([
      [2, 1],
      [3, 2],
      [1, 3],
    ]);
    expect(linkDegrees(l, 4)[0]).toBe(3);
    expect(linksOfPlace(l, 1).every((x) => x.kind === LinkKind.CAPACITY)).toBe(true);
  });

  it('computes 150 000 places quickly', () => {
    const n = 150_000;
    const r = rng(5);
    const radius = Math.cbrt(n / (0.004 * (4 / 3) * Math.PI));
    const xyz = new Float32Array(3 * n);
    const caps = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let x, y, z;
      do {
        x = 2 * r() - 1;
        y = 2 * r() - 1;
        z = 2 * r() - 1;
      } while (x * x + y * y + z * z > 1);
      xyz.set([x * radius - 3000, y * radius, z * radius + 50], 3 * i);
      caps[i] = capacityFromLogL(-4 + 4 * r(), 3, 7, 12);
    }
    const t0 = performance.now();
    const l = computeJumpLinks({ count: n, positions: xyz, capacities: caps }, PARAMS);
    const ms = performance.now() - t0;
    expect(l.candidates).toBeGreaterThan(1_000_000);
    expect(l.count).toBeGreaterThan(n);
    expect(ms).toBeLessThan(2500);
  }, 20_000);
});
