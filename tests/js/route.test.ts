import { describe, expect, it } from 'vitest';
import { capacityFromLogL, computeJumpLinks } from '../../src/network/jumps';
import { buildPlaces, computeNetwork, placeOfStar, type CapacityRule, type PlaceSource } from '../../src/network/places';
import {
  MAX_CORRIDOR,
  corridorWidths,
  findPath,
  networkWidth,
  planRoute,
  type CorridorGraph,
  type Path,
  type RouteGraph,
  type RouteMode,
} from '../../src/network/route';
import { source, type Star } from './fixtures/stars';

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P3 = [number, number, number];

/** A graph from positions and links (lengths from the positions, as float32 like the network). */
function graph(xyz: P3[], links: [number, number][], keys?: number[]): RouteGraph {
  const positions = new Float64Array(xyz.flat());
  const len = (a: number, b: number) =>
    Math.fround(Math.hypot(xyz[a][0] - xyz[b][0], xyz[a][1] - xyz[b][1], xyz[a][2] - xyz[b][2]));
  return {
    count: xyz.length,
    positions,
    keys: keys ?? xyz.map((_, i) => i),
    links: {
      count: links.length,
      a: links.map((l) => l[0]),
      b: links.map((l) => l[1]),
      length: links.map(([a, b]) => len(a, b)),
    },
  };
}

/** Checks that the path follows links and that its numbers add up. */
function expectValid(g: RouteGraph, path: Path, start: number): void {
  expect(path.places[0]).toBe(start);
  expect(path.lengths).toHaveLength(path.places.length - 1);
  expect(path.jumps).toBe(path.lengths.length);
  let total = 0;
  for (let i = 0; i + 1 < path.places.length; i++) {
    const p = path.places[i], q = path.places[i + 1];
    let found = -1;
    for (let k = 0; k < g.links.count; k++) {
      if ((g.links.a[k] === p && g.links.b[k] === q) || (g.links.a[k] === q && g.links.b[k] === p)) found = k;
    }
    expect(found, `link ${p}-${q}`).toBeGreaterThanOrEqual(0);
    expect(path.lengths[i]).toBe(g.links.length[found]);
    total += path.lengths[i];
  }
  expect(path.total).toBeCloseTo(total, 9);
  expect(new Set(path.places).size).toBe(path.places.length);
}

/** Best (c1, c2) from `start` to every place by label correcting (no tie-breaks). */
function bruteCosts(g: RouteGraph, start: number, mode: RouteMode): [number, number][] {
  const best: [number, number][] = Array.from({ length: g.count }, () => [Infinity, Infinity]);
  best[start] = [0, 0];
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = 0; k < g.links.count; k++) {
      const ends = [g.links.a[k], g.links.b[k]];
      for (const [u, v] of [ends, [ends[1], ends[0]]]) {
        const [c1, c2] = best[u];
        if (c1 === Infinity) continue;
        const len = g.links.length[k];
        const n: [number, number] = mode === 'jumps' ? [c1 + 1, c2 + len] : [c1 + len, c2 + 1];
        const cur = best[v];
        const better = (x: number, y: number) => x < y - 1e-9;
        if (better(n[0], cur[0]) || (Math.abs(n[0] - cur[0]) <= 1e-9 && better(n[1], cur[1]))) {
          best[v] = n;
          changed = true;
        }
      }
    }
  }
  return best;
}

const pathCost = (p: Path, mode: RouteMode): [number, number] => (mode === 'jumps' ? [p.jumps, p.total] : [p.total, p.jumps]);

describe('corridor widths', () => {
  it('start at twice the range and double up to 128 ly', () => {
    expect(corridorWidths(9)).toEqual([18, 36, 72, 128]);
    expect(corridorWidths(2)).toEqual([4, 8, 16, 32, 64, 128]);
    expect(corridorWidths(25)).toEqual([50, 100, 128]);
    expect(corridorWidths(64)).toEqual([128]);
    expect(corridorWidths(100)).toEqual([200]);
    expect(corridorWidths(9, 40)).toEqual([18, 36, 40]);
    expect(MAX_CORRIDOR).toBe(128);
    expect(() => corridorWidths(0)).toThrow(RangeError);
    expect(() => corridorWidths(NaN)).toThrow(RangeError);
  });

  it('add the network margin of three ranges', () => {
    expect(networkWidth(18, 9)).toBe(45);
    expect(networkWidth(128, 9)).toBe(155);
  });
});

describe('path search', () => {
  // S = 0, G = 1; a far 2-jump detour X = 2, a straight 3-jump line A = 3, B = 4
  const twoWays = graph(
    [[0, 0, 0], [10, 0, 0], [5, 8, 0], [3, 0, 0], [6, 0, 0]],
    [[0, 2], [2, 1], [0, 3], [3, 4], [4, 1]],
  );

  it('takes the fewest jumps or the shortest distance by mode', () => {
    const j = findPath(twoWays, 0, 1, { mode: 'jumps' });
    expect(j.found).toBe(true);
    expect(j.places).toEqual([0, 2, 1]);
    expect(j.jumps).toBe(2);
    expect(j.total).toBeCloseTo(2 * Math.hypot(5, 8), 5);
    expectValid(twoWays, j, 0);
    const d = findPath(twoWays, 0, 1, { mode: 'distance' });
    expect(d.places).toEqual([0, 3, 4, 1]);
    expect(d.lengths).toEqual([3, 3, 4]);
    expect(d.total).toBe(10);
    expect(d.closest).toBe(1);
    expect(d.closestDistance).toBe(0);
    expectValid(twoWays, d, 0);
  });

  it('breaks a tie in jumps by distance and a tie in distance by jumps', () => {
    // two 2-jump ways of different length
    const g1 = graph(
      [[0, 0, 0], [10, 0, 0], [5, 1, 0], [5, 6, 0]],
      [[0, 3], [3, 1], [0, 2], [2, 1]],
    );
    expect(findPath(g1, 0, 1, { mode: 'jumps' }).places).toEqual([0, 2, 1]);
    // 5 + 5 = 3 + 3 + 4 = 10 exactly: fewer jumps win
    const g2 = graph(
      [[0, 0, 0], [10, 0, 0], [3, 0, 0], [6, 0, 0], [5, 0, 0]],
      [[0, 2], [2, 3], [3, 1], [0, 4], [4, 1]],
    );
    const d = findPath(g2, 0, 1, { mode: 'distance' });
    expect(d.total).toBe(10);
    expect(d.places).toEqual([0, 4, 1]);
  });

  it('breaks exact ties by the keys of the places', () => {
    // a diamond: up (2) and down (3) are equally long
    const xyz: P3[] = [[0, 0, 0], [10, 0, 0], [5, 5, 0], [5, -5, 0]];
    const links: [number, number][] = [[0, 2], [2, 1], [0, 3], [3, 1]];
    for (const mode of ['jumps', 'distance'] as const) {
      expect(findPath(graph(xyz, links, [0, 1, 7, 3]), 0, 1, { mode }).places).toEqual([0, 3, 1]);
      expect(findPath(graph(xyz, links, [0, 1, 3, 7]), 0, 1, { mode }).places).toEqual([0, 2, 1]);
      // the start with the larger key: searched from the goal, the same route
      expect(findPath(graph(xyz, links, [9, 1, 3, 7]), 0, 1, { mode }).places).toEqual([0, 2, 1]);
    }
  });

  it('breaks ties between predecessors that are reached at different costs by key', () => {
    // 3 + 4 via up (2), 4 + 3 via down (3): equal, but up is reached first
    const xyz: P3[] = [[0, 0, 0], [5, 0, 0], [1.8, 2.4, 0], [3.2, -2.4, 0]];
    const links: [number, number][] = [[0, 2], [2, 1], [0, 3], [3, 1]];
    const g = graph(xyz, links, [0, 1, 7, 3]);
    expect(Array.from(g.links.length)).toEqual([3, 4, 4, 3]);
    for (const mode of ['jumps', 'distance'] as const) {
      expect(findPath(g, 0, 1, { mode }).places).toEqual([0, 3, 1]);
      expect(findPath(graph(xyz, links, [0, 1, 3, 7]), 0, 1, { mode }).places).toEqual([0, 2, 1]);
    }
  });

  describe('on a lattice full of ties', () => {
    const N = 7;
    const r = rng(11);
    // lattice point (i, j) has a random but fixed key
    const keyOf = Array.from({ length: N * N }, (_, i) => i).sort(() => r() - 0.5);
    /** The lattice with places in a shuffled order and links in a shuffled order. */
    function lattice(seed: number): { g: RouteGraph; placeOf: number[]; pointOf: number[] } {
      const s = rng(seed);
      const pointOf = Array.from({ length: N * N }, (_, i) => i).sort(() => s() - 0.5);
      const placeOf: number[] = [];
      pointOf.forEach((pt, place) => (placeOf[pt] = place));
      const xyz = pointOf.map((pt): P3 => [pt % N, Math.floor(pt / N), 0]);
      const links: [number, number][] = [];
      for (let pt = 0; pt < N * N; pt++) {
        if (pt % N < N - 1) links.push([placeOf[pt], placeOf[pt + 1]]);
        if (pt + N < N * N) links.push([placeOf[pt + N], placeOf[pt]]);
      }
      links.sort(() => s() - 0.5);
      return { g: graph(xyz, links, pointOf.map((pt) => keyOf[pt])), placeOf, pointOf };
    }

    it('gives the same route whatever the order of places and links', () => {
      const routes = new Set<string>();
      for (const seed of [1, 2, 3, 4, 5]) {
        const { g, placeOf, pointOf } = lattice(seed);
        for (const mode of ['jumps', 'distance'] as const) {
          const p = findPath(g, placeOf[0], placeOf[N * N - 1], { mode });
          expect(p.jumps).toBe(2 * (N - 1));
          expect(p.total).toBe(2 * (N - 1));
          expectValid(g, p, placeOf[0]);
          routes.add(p.places.map((q) => pointOf[q]).join(','));
        }
      }
      expect(routes.size).toBe(1);
    });

    it('follows the documented rule: backwards, the best predecessor with the smaller key', () => {
      const { g, placeOf, pointOf } = lattice(1);
      for (const [a, b] of [[0, N * N - 1], [N - 1, N * (N - 1)], [3, 45], [45, 3]]) {
        const start = placeOf[a], goal = placeOf[b];
        // the search runs from the end with the smaller key
        const [from, to] = g.keys[goal] < g.keys[start] ? [goal, start] : [start, goal];
        const cost = bruteCosts(g, from, 'jumps');
        const want = [to];
        for (let p = to; p !== from; ) {
          const preds: number[] = [];
          for (let k = 0; k < g.links.count; k++) {
            const u = g.links.a[k] === p ? g.links.b[k] : g.links.b[k] === p ? g.links.a[k] : -1;
            if (u >= 0 && cost[u][0] === cost[p][0] - 1) preds.push(u);
          }
          p = preds.sort((x, y) => g.keys[x] - g.keys[y])[0];
          want.push(p);
        }
        if (from === start) want.reverse();
        const got = findPath(g, start, goal, { mode: 'jumps' });
        expect(got.places.map((q) => pointOf[q])).toEqual(want.map((q) => pointOf[q]));
      }
    });

    it('gives the same route reversed when start and goal are swapped', () => {
      const { g, placeOf } = lattice(2);
      for (const [a, b] of [[0, N * N - 1], [5, 43], [20, 22]]) {
        for (const mode of ['jumps', 'distance'] as const) {
          const there = findPath(g, placeOf[a], placeOf[b], { mode });
          const back = findPath(g, placeOf[b], placeOf[a], { mode });
          expect(back.places).toEqual([...there.places].reverse());
          expect(back.lengths).toEqual([...there.lengths].reverse());
          expect(back.total).toBe(there.total);
        }
      }
    });
  });

  it('finds the optimum of both modes in random jump networks', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = rng(seed);
      const n = 80;
      const xyz: P3[] = Array.from({ length: n }, () => [r() * 40, r() * 40, r() * 12]);
      const links = computeJumpLinks(
        { count: n, positions: new Float64Array(xyz.flat()), capacities: xyz.map(() => 1 + Math.floor(r() * 6)) },
        { range: 9, hub: 1, kSun: 6, connect: true },
      );
      const g: RouteGraph = { count: n, positions: new Float64Array(xyz.flat()), keys: xyz.map((_, i) => 1000 - i), links };
      for (const mode of ['jumps', 'distance'] as const) {
        for (let t = 0; t < 6; t++) {
          const s = Math.floor(r() * n), e = Math.floor(r() * n);
          const want = bruteCosts(g, s, mode)[e];
          const p = findPath(g, s, e, { mode });
          expect(p.found).toBe(want[0] !== Infinity);
          if (!p.found) continue;
          expectValid(g, p, s);
          expect(p.places[p.places.length - 1]).toBe(e);
          const got = pathCost(p, mode);
          expect(got[0]).toBeCloseTo(want[0], 6);
          expect(got[1]).toBeCloseTo(want[1], 6);
        }
      }
    }
  });

  it('handles start = goal', () => {
    const p = findPath(twoWays, 3, 3, { mode: 'jumps' });
    expect(p).toMatchObject({ found: true, places: [3], lengths: [], jumps: 0, total: 0, closest: 3, closestDistance: 0 });
  });

  it('rejects places outside the graph', () => {
    expect(() => findPath(twoWays, 0, 5, { mode: 'jumps' })).toThrow(RangeError);
    expect(() => findPath(twoWays, -1, 1, { mode: 'jumps' })).toThrow(RangeError);
  });

  describe('when the goal cannot be reached', () => {
    // a chain 0-2-3-4 towards the goal 1 (alone at x = 20); 5-6 another island near the goal
    const xyz: P3[] = [[0, 0, 0], [20, 0, 0], [4, 0, 0], [8, 3, 0], [11, -1, 0], [19, 6, 0], [24, 6, 0]];
    const links: [number, number][] = [[0, 2], [2, 3], [3, 4], [5, 6]];

    it('leads to the reached place closest to the goal', () => {
      for (const keys of [[0, 9, 2, 3, 4, 5, 6], [9, 0, 2, 3, 4, 5, 6]]) {
        const g = graph(xyz, links, keys);
        for (const mode of ['jumps', 'distance'] as const) {
          const p = findPath(g, 0, 1, { mode });
          expect(p.found).toBe(false);
          expect(p.places).toEqual([0, 2, 3, 4]);
          expect(p.closest).toBe(4);
          expect(p.closestDistance).toBeCloseTo(Math.hypot(9, 1), 12);
          expect(p.reached).toBe(4);
          expectValid(g, p, 0);
        }
      }
    });

    it('stays at the start when it has no links', () => {
      const g = graph(xyz, links);
      const p = findPath(g, 1, 0, { mode: 'jumps' });
      expect(p).toMatchObject({ found: false, places: [1], jumps: 0, total: 0, closest: 1, reached: 1 });
      expect(p.closestDistance).toBe(20);
    });
  });

  describe('in a corridor', () => {
    // straight line 0 → 1 broken in the middle; a detour 2-3 at y = 15
    const xyz: P3[] = [[0, 0, 0], [40, 0, 0], [8, 0, 0], [32, 0, 0], [12, 12, 0], [20, 15, 0], [28, 12, 0]];
    const links: [number, number][] = [[0, 2], [3, 1], [2, 4], [4, 5], [5, 6], [6, 3]];
    const g = graph(xyz, links);
    const corridor = (width: number) => ({ from: { x: 0, y: 0, z: 0 }, to: { x: 40, y: 0, z: 0 }, width });

    it('uses only the places within the width of the segment', () => {
      const narrow = findPath(g, 0, 1, { mode: 'jumps', corridor: corridor(14) });
      expect(narrow.found).toBe(false);
      expect(narrow.searched).toBe(6);
      expect(narrow.places).toEqual([0, 2, 4]);
      const wide = findPath(g, 0, 1, { mode: 'jumps', corridor: corridor(15) });
      expect(wide.found).toBe(true);
      expect(wide.searched).toBe(7);
      expect(wide.places).toEqual([0, 2, 4, 5, 6, 3, 1]);
      expect(findPath(g, 0, 1, { mode: 'jumps' }).searched).toBe(7);
    });

    it('always includes start and goal', () => {
      // a corridor between the stars of start and goal that misses the places' representatives
      const off = { from: { x: 0, y: 0, z: 2 }, to: { x: 40, y: 0, z: 2 }, width: 1 };
      const direct = graph(xyz, [...links, [0, 1]]);
      const p = findPath(direct, 0, 1, { mode: 'jumps', corridor: off });
      expect(p.found).toBe(true);
      expect(p.places).toEqual([0, 1]);
      expect(p.searched).toBe(2);
    });
  });
});

describe('route planning with widening', () => {
  // start 0 at the origin, goal 1 at x = 100; the only way leads 30 ly off the line
  const xyz: P3[] = [[0, 0, 0], [100, 0, 0]];
  const chain: [number, number][] = [];
  const add = (p: P3) => xyz.push(p) - 1;
  let prev = 0;
  for (const p of [[8, 0, 0], [12, 8, 0], [16, 16, 0], [22, 24, 0], [30, 30, 0], [39, 30, 0], [48, 30, 0], [57, 30, 0], [66, 30, 0], [74, 30, 0], [80, 23, 0], [86, 16, 0], [90, 8, 0], [94, 0, 0]] as P3[]) {
    const q = add(p);
    chain.push([prev, q]);
    prev = q;
  }
  chain.push([prev, 1]);
  const base = graph(xyz, chain);
  const req = { from: { x: 0, y: 0, z: 0 }, to: { x: 100, y: 0, z: 0 }, range: 9, mode: 'jumps' as const };
  const corridorOf = (g: RouteGraph, start = 0, goal = 1): CorridorGraph => ({ ...g, start, goal });

  it('widens the corridor until a path is found', async () => {
    const asked: [number, number][] = [];
    const plan = await planRoute(req, (c) => {
      asked.push([c.width, c.networkWidth]);
      return corridorOf(base);
    });
    expect(plan.status).toBe('found');
    if (plan.status !== 'found') return;
    expect(asked).toEqual([[18, 45], [36, 63]]);
    expect(plan.tried).toEqual([18, 36]);
    expect(plan.route.width).toBe(36);
    expect(plan.route.path.jumps).toBe(15);
    expectValid(base, plan.route.path, 0);
  });

  it('accepts a network that arrives later', async () => {
    const plan = await planRoute(req, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return corridorOf(base);
    });
    expect(plan.status).toBe('found');
  });

  it('reports the closest place when even the widest corridor has no path', async () => {
    const broken = graph(xyz, chain.slice(0, 8));
    const plan = await planRoute(req, () => corridorOf(broken));
    expect(plan.status).toBe('unreachable');
    if (plan.status !== 'unreachable') return;
    expect(plan.tried).toEqual([18, 36, 72, 128]);
    expect(plan.route.width).toBe(128);
    expect(plan.route.path.found).toBe(false);
    expect(plan.route.path.places).toHaveLength(9);
    expect(plan.route.path.closest).toBe(plan.route.path.places[8]);
  });

  it('stops when the app refuses a corridor and keeps the last search', async () => {
    const plan = await planRoute(req, (c) => (c.width > 18 ? { refused: 'places' } : corridorOf(base)));
    expect(plan).toMatchObject({ status: 'refused', width: 36, reason: 'places', tried: [18, 36] });
    if (plan.status !== 'refused') return;
    expect(plan.route?.width).toBe(18);
    expect(plan.route?.path.found).toBe(false);
    const first = await planRoute(req, () => ({ refused: 'pairs' }));
    expect(first).toMatchObject({ status: 'refused', width: 18, reason: 'pairs', route: null });
  });

  it('stops when a star is not part of the network', async () => {
    expect(await planRoute(req, () => corridorOf(base, -1, 1))).toEqual({ status: 'missing', end: 'start', tried: [18] });
    expect(await planRoute(req, () => corridorOf(base, 0, -1))).toEqual({ status: 'missing', end: 'goal', tried: [18] });
  });

  it('can be cancelled', async () => {
    const stop = new AbortController();
    const plan = await planRoute({ ...req, signal: stop.signal }, () => {
      stop.abort();
      return corridorOf(base);
    });
    expect(plan).toEqual({ status: 'cancelled', tried: [18] });
    expect(await planRoute({ ...req, signal: stop.signal }, () => corridorOf(base))).toEqual({ status: 'cancelled', tried: [] });
  });
});

describe('route through a computed corridor network', () => {
  const luminosity: CapacityRule = { by: 'luminosity', faint: 2, sun: 6, bright: 12 };

  /** Random stars at 0.003 per ly³ in a box around the segment (0, 0, 0)–(120, 0, 0), in 4 nodes. */
  function stars(): PlaceSource[] {
    const r = rng(5);
    const nodes: Star[][] = [[], [], [], []];
    const count = Math.round(0.003 * 200 * 110 * 110);
    for (let i = 0; i < count; i++) {
      const s: Star = { x: r() * 200 - 40, y: r() * 110 - 55, z: r() * 110 - 55, logL: -5 + 6.5 * r() ** 2 };
      nodes[Math.floor(r() * 4)].push(s);
    }
    nodes[0].push({ x: 0, logL: 0 }, { x: 120, y: 0, z: 0, logL: 1 });
    return nodes.map((n, k) => source(`r${k}`, n));
  }

  it('finds a route of jumps no longer than the range, independent of the node order', async () => {
    const sources = stars();
    const start = sources[0].data.count - 2, goal = sources[0].data.count - 1;
    const plan = async (order: PlaceSource[]) =>
      planRoute({ from: { x: 0, y: 0, z: 0 }, to: { x: 120, y: 0, z: 0 }, range: 9, mode: 'jumps' }, (c) => {
        const net = computeNetwork(order, {
          centre: { x: 0, y: 0, z: 0 },
          to: { x: 120, y: 0, z: 0 },
          radius: c.networkWidth,
          capacity: luminosity,
          nodeKey: (p) => Number(p.slice(1)),
          range: 9,
          hub: 1,
          kSun: 6,
          connect: true,
        });
        if (net.overflow) return { refused: net.overflow };
        const { places, links } = net;
        return { count: places.count, positions: places.positions, keys: places.keys, links, start: placeOfStar(places, 'r0', start), goal: placeOfStar(places, 'r0', goal) };
      });
    const a = await plan(sources);
    const b = await plan([...sources].reverse());
    expect(a.status).toBe('found');
    if (a.status !== 'found' || b.status !== 'found') throw new Error('no route');
    const p = a.route.path;
    expect(p.jumps).toBeGreaterThanOrEqual(Math.ceil(120 / 9));
    expect(Math.max(...p.lengths)).toBeLessThanOrEqual(9);
    expect(p.total).toBeGreaterThanOrEqual(120);
    expectValid(a.route.graph, p, a.route.graph.start);
    const keysOf = (r: typeof a) => r.route.path.places.map((q) => r.route.graph.keys[q]);
    expect(keysOf(b)).toEqual(keysOf(a));
  });

  it('takes the stars within the radius of the segment as places', () => {
    const src = source('r', [
      { x: -3, logL: 0 },
      { x: -5.5, logL: 0 },
      { x: 50, y: 4.9, logL: 0 },
      { x: 50, y: 5.1, logL: 0 },
      { x: 103, z: 4, logL: 0 },
      { x: 104, z: 4, logL: 0 },
      { x: 60, y: 1, logL: 0, hidden: true },
    ]);
    const opt = { centre: { x: 0, y: 0, z: 0 }, to: { x: 100, y: 0, z: 0 }, radius: 5, capacity: luminosity, nodeKey: () => 0 };
    const p = buildPlaces([src], opt);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => placeOfStar(p, 'r', i) >= 0)).toEqual([true, false, true, false, true, false, false]);
    // start = end: a sphere
    const sphere = buildPlaces([src], { ...opt, to: { x: 0, y: 0, z: 0 } });
    expect(sphere.count).toBe(1);
    expect(capacityFromLogL(0, 2, 6, 12)).toBe(p.capacities[0]);
  });
});
