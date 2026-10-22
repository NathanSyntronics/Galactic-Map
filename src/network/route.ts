/**
 * Route planning (docs/ROUTES.md): the best path through the jump network between two places,
 * searched in a corridor around the straight line, and the widening of that corridor. Pure
 * computation; the app supplies the network of a corridor through a callback.
 */
import { segmentDistance2, type Vec3 } from './capsule';
import { jumpMargin } from './places';

/** 'jumps': fewest jumps, then shortest distance; 'distance': shortest distance, then fewest jumps. */
export type RouteMode = 'jumps' | 'distance';

/** Widest search corridor in light years. */
export const MAX_CORRIDOR = 128;

/** Search corridor widths to try: 2 · range, doubled up to `max` (the last one is `max`). */
export function corridorWidths(range: number, max = MAX_CORRIDOR): number[] {
  if (!(range > 0) || !Number.isFinite(range)) throw new RangeError(`invalid jump range ${range}`);
  const out: number[] = [];
  let w = 2 * range;
  for (;;) {
    out.push(w);
    if (w >= max) return out;
    w = Math.min(2 * w, max);
  }
}

/** Width of the corridor whose stars the network is computed from (same margin as the view network). */
export function networkWidth(width: number, range: number): number {
  return width + jumpMargin(range);
}

// ------------------------------------------------------------------ path search

export interface RouteLinks {
  count: number;
  /** Place indices of the two ends. */
  a: ArrayLike<number>;
  b: ArrayLike<number>;
  length: ArrayLike<number>;
}

/** A computed network: places (positions, stable keys) and their links. */
export interface RouteGraph {
  count: number;
  /** x, y, z per place. */
  positions: ArrayLike<number>;
  /** Stable key per place, for ties. */
  keys: ArrayLike<number>;
  links: RouteLinks;
}

export interface PathOptions {
  mode: RouteMode;
  /** Only places within `width` of the segment from–to take part (start and goal always do). */
  corridor?: { from: Vec3; to: Vec3; width: number };
}

export interface Path {
  /** True when the goal was reached. */
  found: boolean;
  /** Places from the start to the goal; when not found, to the reached place closest to the goal. */
  places: number[];
  /** Length of each jump: lengths[i] from places[i] to places[i + 1]. */
  lengths: number[];
  jumps: number;
  /** Sum of the jump lengths. */
  total: number;
  /** Reached place closest to the goal (the goal when found) and its straight distance to it. */
  closest: number;
  closestDistance: number;
  /** Places the search settled. */
  reached: number;
  /** Places of the search corridor. */
  searched: number;
}

/** Neighbours of the places (compressed: p's are to[start[p]] .. to[start[p + 1] - 1]). */
interface Adjacency {
  start: Int32Array;
  to: Int32Array;
  link: Int32Array;
}

function adjacency(graph: RouteGraph, allowed: Uint8Array): Adjacency {
  const { links } = graph;
  const n = graph.count;
  const start = new Int32Array(n + 1);
  for (let i = 0; i < links.count; i++) {
    const a = links.a[i], b = links.b[i];
    if (!allowed[a] || !allowed[b] || a === b) continue;
    start[a + 1]++;
    start[b + 1]++;
  }
  for (let p = 0; p < n; p++) start[p + 1] += start[p];
  const fill = start.slice(0, n);
  const to = new Int32Array(start[n]);
  const link = new Int32Array(start[n]);
  for (let i = 0; i < links.count; i++) {
    const a = links.a[i], b = links.b[i];
    if (!allowed[a] || !allowed[b] || a === b) continue;
    to[fill[a]] = b;
    link[fill[a]++] = i;
    to[fill[b]] = a;
    link[fill[b]++] = i;
  }
  return { start, to, link };
}

/** Binary min-heap of places by (c1, c2), then key. */
class Heap {
  private c1 = new Float64Array(64);
  private c2 = new Float64Array(64);
  private place = new Int32Array(64);
  size = 0;

  constructor(private readonly before: (p: number, q: number) => boolean) {}

  private less(i: number, j: number): boolean {
    if (this.c1[i] !== this.c1[j]) return this.c1[i] < this.c1[j];
    if (this.c2[i] !== this.c2[j]) return this.c2[i] < this.c2[j];
    return this.before(this.place[i], this.place[j]);
  }

  private swap(i: number, j: number): void {
    const a = this.c1[i], b = this.c2[i], p = this.place[i];
    this.c1[i] = this.c1[j];
    this.c2[i] = this.c2[j];
    this.place[i] = this.place[j];
    this.c1[j] = a;
    this.c2[j] = b;
    this.place[j] = p;
  }

  push(p: number, c1: number, c2: number): void {
    if (this.size === this.place.length) {
      const grow = <T extends Float64Array | Int32Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(2 * a.length);
        b.set(a);
        return b;
      };
      this.c1 = grow(this.c1);
      this.c2 = grow(this.c2);
      this.place = grow(this.place);
    }
    let i = this.size++;
    this.c1[i] = c1;
    this.c2[i] = c2;
    this.place[i] = p;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  pop(): number {
    const top = this.place[0];
    const last = --this.size;
    if (last > 0) {
      this.swap(0, last);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < last && this.less(l, m)) m = l;
        if (r < last && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/**
 * Dijkstra by the lexicographic cost of the mode. Every jump adds a positive cost (one jump), so
 * all best predecessors of a place are settled before it; among them the one with the smallest
 * key is kept, whatever the order of the links.
 */
function search(graph: RouteGraph, adj: Adjacency, from: number, to: number, mode: RouteMode, before: (p: number, q: number) => boolean): Path {
  const n = graph.count;
  const lens = graph.links.length;
  const c1 = new Float64Array(n).fill(Infinity);
  const c2 = new Float64Array(n).fill(Infinity);
  const pred = new Int32Array(n).fill(-1);
  const predLink = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const settled: number[] = [];
  const heap = new Heap(before);
  const byJumps = mode === 'jumps';
  c1[from] = 0;
  c2[from] = 0;
  heap.push(from, 0, 0);
  let found = false;
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    settled.push(u);
    if (u === to) {
      found = true;
      break;
    }
    for (let k = adj.start[u], e = adj.start[u + 1]; k < e; k++) {
      const v = adj.to[k];
      if (done[v]) continue;
      const len = +lens[adj.link[k]];
      const n1 = byJumps ? c1[u] + 1 : c1[u] + len;
      const n2 = byJumps ? c2[u] + len : c2[u] + 1;
      if (n1 < c1[v] || (n1 === c1[v] && n2 < c2[v])) {
        c1[v] = n1;
        c2[v] = n2;
        pred[v] = u;
        predLink[v] = adj.link[k];
        heap.push(v, n1, n2);
      } else if (n1 === c1[v] && n2 === c2[v] && before(u, pred[v])) {
        pred[v] = u;
        predLink[v] = adj.link[k];
      }
    }
  }

  const pos = graph.positions;
  const gx = pos[3 * to], gy = pos[3 * to + 1], gz = pos[3 * to + 2];
  const distToGoal = (p: number): number => Math.hypot(pos[3 * p] - gx, pos[3 * p + 1] - gy, pos[3 * p + 2] - gz);
  let end = to;
  let endDist = 0;
  if (!found) {
    end = from;
    endDist = Infinity;
    for (const p of settled) {
      const d = distToGoal(p);
      if (d < endDist || (d === endDist && before(p, end))) {
        end = p;
        endDist = d;
      }
    }
  }
  const places: number[] = [];
  const lengths: number[] = [];
  for (let p = end; p >= 0; p = pred[p]) {
    places.push(p);
    if (pred[p] >= 0) lengths.push(+lens[predLink[p]]);
  }
  places.reverse();
  lengths.reverse();
  let total = 0;
  for (const l of lengths) total += l;
  return {
    found,
    places,
    lengths,
    jumps: lengths.length,
    total,
    closest: end,
    closestDistance: endDist,
    reached: settled.length,
    searched: 0,
  };
}

/**
 * Best path from `start` to `goal` (place indices) through the links of the graph
 * (docs/ROUTES.md, "What counts as the best route"). Ties: from the goal backwards, the
 * predecessor with the smaller key. The search runs from the end with the smaller key, so
 * swapping start and goal gives the same route reversed. When the goal cannot be reached, the
 * path leads to the reached place closest to it (searched from the start).
 */
export function findPath(graph: RouteGraph, start: number, goal: number, opt: PathOptions): Path {
  const n = graph.count;
  if (!(start >= 0 && start < n && goal >= 0 && goal < n)) throw new RangeError('start or goal is not a place of the graph');
  const keys = graph.keys;
  const before = (p: number, q: number): boolean => (keys[p] !== keys[q] ? keys[p] < keys[q] : p < q);

  const allowed = new Uint8Array(n);
  let searched = 0;
  const c = opt.corridor;
  const w2 = c ? c.width * c.width : Infinity;
  const pos = graph.positions;
  for (let p = 0; p < n; p++) {
    const ok = !c || segmentDistance2(pos[3 * p], pos[3 * p + 1], pos[3 * p + 2], c.from, c.to) <= w2;
    if (ok || p === start || p === goal) {
      allowed[p] = 1;
      searched++;
    }
  }
  const adj = adjacency(graph, allowed);

  let path: Path | null = null;
  if (before(goal, start)) {
    const back = search(graph, adj, goal, start, opt.mode, before);
    if (back.found) {
      path = {
        ...back,
        places: back.places.reverse(),
        lengths: back.lengths.reverse(),
        total: back.lengths.reduce((s, l) => s + l, 0),
        closest: goal,
      };
    }
  }
  path ??= search(graph, adj, start, goal, opt.mode, before);
  path.searched = searched;
  return path;
}

// ------------------------------------------------------------------ widening

/** The network of a corridor, with the places of the start and destination star. */
export interface CorridorGraph extends RouteGraph {
  /** Place of the start star; -1 when it is not part of the network (not shown). */
  start: number;
  /** Place of the destination star; -1 likewise. */
  goal: number;
}

export interface CorridorRequest {
  /** Search corridor width w. */
  width: number;
  /** The network is computed from the shown stars within this distance of the segment. */
  networkWidth: number;
}

/** The network of a corridor, or why it is not computed (too many places or pairs, …). */
export type CorridorAnswer<G extends CorridorGraph> = G | { refused: string };

export interface RouteRequest {
  /** Positions of the start and destination star: the segment of the corridor. */
  from: Vec3;
  to: Vec3;
  /** Jump range of the network. */
  range: number;
  mode: RouteMode;
  /** Widest search corridor (default MAX_CORRIDOR). */
  maxWidth?: number;
  signal?: AbortSignal;
}

/** One search: corridor width, its network and the path. */
export interface RouteTry<G extends CorridorGraph> {
  width: number;
  graph: G;
  path: Path;
}

export type RoutePlan<G extends CorridorGraph> =
  /** `route.path` is the route. */
  | { status: 'found'; route: RouteTry<G>; tried: number[] }
  /** Not reachable at the widest corridor; `route.path` leads to the place closest to the destination. */
  | { status: 'unreachable'; route: RouteTry<G>; tried: number[] }
  /** The network of corridor `width` was refused; `route` is the last narrower search, if any. */
  | { status: 'refused'; width: number; reason: string; route: RouteTry<G> | null; tried: number[] }
  /** The start or destination star is not part of the network. */
  | { status: 'missing'; end: 'start' | 'goal'; tried: number[] }
  | { status: 'cancelled'; tried: number[] };

/**
 * Searches the corridor of width 2 · range and widens it (doubling, up to maxWidth) while there
 * is no path. `networkFor` supplies the network of each corridor (the app loads its stars).
 * `tried` lists the widths whose network was asked for.
 */
export async function planRoute<G extends CorridorGraph>(
  req: RouteRequest,
  networkFor: (c: CorridorRequest) => CorridorAnswer<G> | Promise<CorridorAnswer<G>>,
): Promise<RoutePlan<G>> {
  const tried: number[] = [];
  let last: RouteTry<G> | null = null;
  for (const width of corridorWidths(req.range, req.maxWidth ?? MAX_CORRIDOR)) {
    if (req.signal?.aborted) return { status: 'cancelled', tried };
    tried.push(width);
    const answer = await networkFor({ width, networkWidth: networkWidth(width, req.range) });
    if (req.signal?.aborted) return { status: 'cancelled', tried };
    if ('refused' in answer) return { status: 'refused', width, reason: answer.refused, route: last, tried };
    if (answer.start < 0) return { status: 'missing', end: 'start', tried };
    if (answer.goal < 0) return { status: 'missing', end: 'goal', tried };
    const path = findPath(answer, answer.start, answer.goal, {
      mode: req.mode,
      corridor: { from: req.from, to: req.to, width },
    });
    last = { width, graph: answer, path };
    if (path.found) return { status: 'found', route: last, tried };
  }
  return { status: 'unreachable', route: last!, tried };
}
