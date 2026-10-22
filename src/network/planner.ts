/**
 * Route planning in the app (docs/ROUTES.md): the start and destination star, the loading of the
 * octree nodes of a corridor, the corridor's jump network and the widening path search of
 * route.ts. No three.js or DOM: the app supplies data and settings through PlannerHost.
 */
import { designationOf, type NodeData } from '../data/format';
import { nodesInCapsule, type Aabb, type Vec3 } from './capsule';
import { MAX_PAIRS, MAX_PLACES, computeNetwork, placeOfStar, type CapacityRule, type PlaceSource, type PlaceSet } from './places';
import { planRoute, type CorridorGraph, type RouteMode, type RouteTry } from './route';

/** A corridor whose nodes hold more data than this is refused before loading (Sun–Betelgeuse at w = 128: 25 MB). */
export const MAX_CORRIDOR_BYTES = 64e6;

/** An octree node as the planner needs it (OctreeNode fits). */
export interface CorridorNode {
  path: string;
  /** Stars and bytes of the node's file. */
  count: number;
  bytes: number;
  box: Aabb;
  children: readonly CorridorNode[];
}

/** Start or destination: a star, kept by designation and names (stored in the browser). */
export interface RouteEnd {
  designation: string;
  nameEn: string | null;
  nameDe: string | null;
  sun: boolean;
  /** Node path and index of the star; checked against the designation before use. */
  path: string;
  index: number;
  /** World position. */
  pos: Vec3;
}

/** Network settings of the route (the same as the view network's). */
export interface RouteNetworkOptions {
  range: number;
  hub: number;
  kSun: number;
  connect: boolean;
  capacity: CapacityRule;
}

export interface PlannerHost<N extends CorridorNode> {
  /** Root of the octree; null until the catalogue is loaded. */
  root(): N | null;
  node(path: string): N | undefined;
  /** Nodes the route needs loaded besides those of the view (replaces the previous list). */
  want(nodes: N[]): void;
  /** Decoded data of a loaded node. */
  data(path: string): NodeData | undefined;
  /** The node could not be loaded (the loader gave up). */
  failed(path: string): boolean;
  /** Lets the loader try a given-up node again. */
  retry(path: string): void;
  options(): RouteNetworkOptions;
  /** Colours and sizes of a node's stars with the current settings (size 0: hidden). */
  style(data: NodeData, colors: Uint8Array, sizes: Float32Array): void;
  /** Stable number of a node (tie-break keys, as in the view network). */
  nodeKey(path: string): number;
  /** A star by its primary designation, when the stored node and index no longer match. */
  find(designation: string): Promise<{ path: string; index: number } | null>;
  save(route: StoredRoute): void;
}

/** A place of the route: its representative star and the jump that led to it. */
export interface Waypoint {
  data: NodeData;
  index: number;
  pos: Vec3;
  /** Length of the jump from the previous waypoint (0 for the first). */
  jump: number;
}

export interface RouteStats {
  /** Corridor widths whose networks were computed. */
  tried: number[];
  nodes: number;
  bytes: number;
  places: number;
  pairs: number;
  /** Time spent waiting for data, computing networks and searching (ms). */
  loadMs: number;
  networkMs: number;
  searchMs: number;
  totalMs: number;
}

export interface RouteResult {
  waypoints: Waypoint[];
  /** False: the waypoints lead to the reached place closest to the destination. */
  found: boolean;
  jumps: number;
  total: number;
  /** Straight-line distance between the two chosen stars. */
  straight: number;
  /** Search corridor width of the search that gave the waypoints. */
  width: number;
  /** When not found: straight distance from the last waypoint to the destination. */
  short: number;
  mode: RouteMode;
  stats: RouteStats;
}

export type RouteStatus =
  /** No end chosen. */
  | { kind: 'empty' }
  /** One end chosen. */
  | { kind: 'incomplete' }
  /** The star catalogue is not loaded yet. */
  | { kind: 'waiting' }
  /** Loading the tiles of the corridor of `width` (0: the tiles of the two stars). */
  | { kind: 'loading'; width: number; loaded: number; total: number; loadedBytes: number; totalBytes: number }
  | { kind: 'computing'; width: number }
  | { kind: 'found'; route: RouteResult }
  /** No path even in the widest corridor; `route` leads to the closest place. */
  | { kind: 'unreachable'; route: RouteResult }
  /** The corridor of `width` holds too many places, pairs or too much data; `route` is the last narrower search. */
  | { kind: 'refused'; reason: 'places' | 'pairs' | 'data'; width: number; route: RouteResult | null }
  /** The star is hidden by the current settings, so it is not part of the network. */
  | { kind: 'missing'; end: 'from' | 'to' }
  /** The star is no longer in the star data. */
  | { kind: 'notFound'; end: 'from' | 'to' }
  /** Tiles of the corridor could not be loaded. */
  | { kind: 'failed'; tiles: number }
  /** An unexpected error. */
  | { kind: 'error' };

/** What the browser keeps of a route. */
export interface StoredRoute {
  v: 1;
  from: RouteEnd | null;
  to: RouteEnd | null;
  mode: RouteMode;
}

export const ROUTE_STORAGE_KEY = 'galactic-map:route:v1';

function parseEnd(x: unknown): RouteEnd | null {
  if (!x || typeof x !== 'object') return null;
  const e = x as Record<string, unknown>;
  const pos = e.pos as Record<string, unknown> | undefined;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const name = (v: unknown) => v === null || typeof v === 'string';
  if (!str(e.designation) || !str(e.path) || !num(e.index) || !name(e.nameEn) || !name(e.nameDe)) return null;
  if (!pos || !num(pos.x) || !num(pos.y) || !num(pos.z)) return null;
  return {
    designation: e.designation as string,
    nameEn: e.nameEn as string | null,
    nameDe: e.nameDe as string | null,
    sun: e.sun === true,
    path: e.path as string,
    index: e.index as number,
    pos: { x: pos.x as number, y: pos.y as number, z: pos.z as number },
  };
}

/** A stored route (anything malformed gives null). */
export function parseStoredRoute(raw: string | null): StoredRoute | null {
  if (!raw) return null;
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!x || typeof x !== 'object' || (x as { v?: unknown }).v !== 1) return null;
  const r = x as Record<string, unknown>;
  const from = parseEnd(r.from);
  const to = parseEnd(r.to);
  if (!from && !to) return null;
  return { v: 1, from, to, mode: r.mode === 'distance' ? 'distance' : 'jumps' };
}

/** Same star (by node and index). */
export function sameStar(a: RouteEnd | null, b: RouteEnd | null): boolean {
  return !!a && !!b && a.path === b.path && a.index === b.index;
}

/** A network of a corridor, kept for the waypoints of the route. */
interface CorridorNet extends CorridorGraph {
  places: PlaceSet;
}

/** A corridor node's data and its own sizes (computed with the current settings). */
interface Cached {
  data: NodeData;
  colors: Uint8Array;
  sizes: Float32Array;
  /** styleVersion the sizes belong to (-1: not computed). */
  version: number;
}

class LoadFailed extends Error {
  constructor(readonly tiles: number) {
    super(`${tiles} tiles could not be loaded`);
  }
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Plans the route between two stars. Every change of the ends or the mode computes it again;
 * `invalidate` does so after a change of the network settings or of the shown stars. The data of
 * the last corridor stays in memory (decoded node data is never modified), so the loader may evict
 * it and a recomputation with other settings loads only what a wider corridor adds.
 */
export class RoutePlanner<N extends CorridorNode> {
  from: RouteEnd | null = null;
  to: RouteEnd | null = null;
  mode: RouteMode = 'jumps';
  status: RouteStatus = { kind: 'empty' };
  /** The route shown: the last result for the current ends (kept while a recomputation runs). */
  route: RouteResult | null = null;
  /** Called after any change of the ends, mode, status or route. */
  onChange: () => void = () => {};

  private readonly cache = new Map<string, Cached>();
  private styleVersion = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wake: (() => void) | null = null;
  /** Nodes that failed in the last run (for a retry). */
  private failedPaths: string[] = [];
  /** Number of runs started (tests and diagnostics). */
  runs = 0;

  constructor(
    private readonly host: PlannerHost<N>,
    stored: StoredRoute | null = null,
  ) {
    if (stored) {
      this.from = stored.from;
      this.to = stored.to;
      this.mode = stored.mode;
      this.status = { kind: this.from && this.to ? 'waiting' : 'incomplete' };
    }
  }

  /** True while loading or computing. */
  get busy(): boolean {
    return this.status.kind === 'loading' || this.status.kind === 'computing' || this.status.kind === 'waiting';
  }

  /** Sets the start ('from') or destination ('to'). The same star at the other end clears that end. */
  setEnd(which: 'from' | 'to', end: RouteEnd | null): void {
    const other = which === 'from' ? 'to' : 'from';
    if (end && sameStar(end, this[other])) this[other] = null;
    this[which] = end;
    this.route = null;
    this.save();
    this.run();
  }

  swap(): void {
    [this.from, this.to] = [this.to, this.from];
    this.save();
    this.run();
  }

  setMode(mode: RouteMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.save();
    this.run();
  }

  /** Removes the route. */
  clear(): void {
    this.from = this.to = null;
    this.route = null;
    this.cache.clear();
    this.save();
    this.run();
  }

  /** Computes the route again after `delay` ms (settings changed; repeated calls restart the delay). */
  invalidate(delay = 0): void {
    if (!this.from || !this.to) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, delay);
  }

  /** The shown stars changed (filters, data layers): cached sizes are computed again on use. */
  styleChanged(): void {
    this.styleVersion++;
  }

  /** A node was loaded or given up by the loader. */
  nodeArrived(): void {
    this.wake?.();
  }

  /** Tries the tiles that could not be loaded again. */
  retry(): void {
    for (const p of this.failedPaths) this.host.retry(p);
    this.failedPaths = [];
    this.run();
  }

  private save(): void {
    this.host.save({ v: 1, from: this.from, to: this.to, mode: this.mode });
  }

  private setStatus(status: RouteStatus): void {
    this.status = status;
    this.onChange();
  }

  /** Starts a computation (cancelling a running one). */
  private run(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
    this.wake?.();
    if (!this.from || !this.to) {
      this.host.want([]);
      this.route = null;
      this.setStatus({ kind: this.from || this.to ? 'incomplete' : 'empty' });
      return;
    }
    const root = this.host.root();
    if (!root) {
      this.setStatus({ kind: 'waiting' });
      return;
    }
    const ctl = new AbortController();
    this.abort = ctl;
    this.runs++;
    void this.compute(root, this.from, this.to, ctl.signal).catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      this.host.want([]);
      this.route = null;
      if (err instanceof LoadFailed) return this.setStatus({ kind: 'failed', tiles: err.tiles });
      console.error('route planning failed', err);
      this.setStatus({ kind: 'error' });
    });
  }

  private async compute(root: N, fromEnd: RouteEnd, toEnd: RouteEnd, signal: AbortSignal): Promise<void> {
    const t0 = now();
    const stats: RouteStats = { tried: [], nodes: 0, bytes: 0, places: 0, pairs: 0, loadMs: 0, networkMs: 0, searchMs: 0, totalMs: 0 };
    const from = await this.locate(fromEnd, signal, stats);
    if (signal.aborted) return;
    if (!from) return this.finish({ kind: 'notFound', end: 'from' });
    const to = await this.locate(toEnd, signal, stats);
    if (signal.aborted) return;
    if (!to) return this.finish({ kind: 'notFound', end: 'to' });
    const opt = this.host.options();
    const mode = this.mode;
    let corridor: N[] = [];
    let searchStart = 0;

    const plan = await planRoute<CorridorNet>({ from: from.pos, to: to.pos, range: opt.range, mode, signal }, async (c) => {
      if (searchStart) stats.searchMs += now() - searchStart;
      const nodes = nodesInCapsule<CorridorNode>(root, from.pos, to.pos, c.networkWidth) as N[];
      const bytes = nodes.reduce((s, n) => s + n.bytes, 0);
      if (bytes > MAX_CORRIDOR_BYTES) return { refused: 'data' };
      const tl = now();
      await this.load(nodes, c.width, signal);
      stats.loadMs += now() - tl;
      if (signal.aborted) return { refused: 'cancelled' };
      corridor = nodes;
      this.setStatus({ kind: 'computing', width: c.width });
      // let the status show before the computation blocks
      await new Promise((r) => setTimeout(r, 0));
      if (signal.aborted) return { refused: 'cancelled' };
      const tn = now();
      const sources = nodes.map((n) => this.styled(n.path));
      const net = computeNetwork(sources, {
        centre: from.pos,
        to: to.pos,
        radius: c.networkWidth,
        capacity: opt.capacity,
        nodeKey: (p) => this.host.nodeKey(p),
        maxPlaces: MAX_PLACES,
        range: opt.range,
        hub: opt.hub,
        kSun: opt.kSun,
        connect: opt.connect,
        maxCandidates: MAX_PAIRS,
      });
      stats.networkMs += now() - tn;
      stats.tried.push(c.width);
      stats.nodes = nodes.length;
      stats.bytes = bytes;
      stats.places = net.places.count;
      stats.pairs = net.links.candidates;
      searchStart = now();
      if (net.overflow) return { refused: net.overflow };
      const { places, links } = net;
      return {
        count: places.count,
        positions: places.positions,
        keys: places.keys,
        links,
        start: placeOfStar(places, from.path, from.index),
        goal: placeOfStar(places, to.path, to.index),
        places,
      };
    });
    if (signal.aborted || plan.status === 'cancelled') return;
    if (searchStart) stats.searchMs += now() - searchStart;
    stats.totalMs = now() - t0;
    // keep the data of the last corridor only
    const keep = new Set(corridor.map((n) => n.path));
    for (const p of [...this.cache.keys()]) if (!keep.has(p)) this.cache.delete(p);

    const straight = distance(from.pos, to.pos);
    const result = (t: RouteTry<CorridorNet>): RouteResult => routeResult(t, mode, straight, stats);
    switch (plan.status) {
      case 'found':
        return this.finish({ kind: 'found', route: result(plan.route) });
      case 'unreachable':
        return this.finish({ kind: 'unreachable', route: result(plan.route) });
      case 'refused':
        return this.finish({
          kind: 'refused',
          reason: plan.reason === 'places' || plan.reason === 'pairs' ? plan.reason : 'data',
          width: plan.width,
          route: plan.route ? result(plan.route) : null,
        });
      case 'missing':
        return this.finish({ kind: 'missing', end: plan.end === 'start' ? 'from' : 'to' });
    }
  }

  private finish(status: RouteStatus): void {
    this.host.want([]);
    this.route = 'route' in status ? status.route : null;
    if (import.meta.env?.DEV && this.route) {
      const s = this.route.stats;
      console.debug(
        `route: ${status.kind}, ${this.route.jumps} jumps, ${this.route.total.toFixed(1)} ly, widths ${s.tried.join('/')}, ` +
          `${s.nodes} nodes, ${(s.bytes / 1e6).toFixed(1)} MB, ${s.places} places, load ${s.loadMs.toFixed(0)} ms, ` +
          `network ${s.networkMs.toFixed(0)} ms, search ${s.searchMs.toFixed(0)} ms, total ${s.totalMs.toFixed(0)} ms`,
      );
    }
    this.setStatus(status);
  }

  /**
   * The star of a route end in the current data: its stored node and index when the designation
   * still matches, else found by designation (the star data was rebuilt). Updates the end.
   */
  private async locate(end: RouteEnd, signal: AbortSignal, stats: RouteStats): Promise<RouteEnd | null> {
    const check = async (path: string, index: number): Promise<RouteEnd | null> => {
      const node = this.host.node(path);
      if (!node) return null;
      const t = now();
      await this.load([node], 0, signal);
      stats.loadMs += now() - t;
      const d = this.cache.get(path)?.data;
      if (!d || index < 0 || index >= d.count || designationOf(d, index) !== end.designation) return null;
      const p = d.positions;
      return { ...end, path, index, pos: { x: p[3 * index], y: p[3 * index + 1], z: p[3 * index + 2] } };
    };
    let found = await check(end.path, end.index);
    if (!found && !signal.aborted) {
      const hit = await this.host.find(end.designation);
      if (hit && !signal.aborted) found = await check(hit.path, hit.index);
    }
    if (found && !signal.aborted) {
      // positions, nodes and indices as in the current data
      if (end === this.from) this.from = found;
      if (end === this.to) this.to = found;
      if (found.path !== end.path || found.index !== end.index) this.save();
    }
    return found;
  }

  /** Waits until all nodes are loaded (taking their data into the cache); throws LoadFailed. */
  private async load(nodes: N[], width: number, signal: AbortSignal): Promise<void> {
    const totalBytes = nodes.reduce((s, n) => s + n.bytes, 0);
    for (;;) {
      if (signal.aborted) return;
      const missing: N[] = [];
      const failed: string[] = [];
      let loadedBytes = 0;
      for (const n of nodes) {
        if (!this.cache.has(n.path)) {
          const data = this.host.data(n.path);
          if (data) this.cache.set(n.path, { data, colors: new Uint8Array(3 * data.count), sizes: new Float32Array(data.count), version: -1 });
        }
        if (this.cache.has(n.path)) loadedBytes += n.bytes;
        else if (this.host.failed(n.path)) failed.push(n.path);
        else missing.push(n);
      }
      if (failed.length) {
        this.failedPaths = failed;
        throw new LoadFailed(failed.length);
      }
      this.host.want(missing);
      if (!missing.length) return;
      this.setStatus({ kind: 'loading', width, loaded: nodes.length - missing.length, total: nodes.length, loadedBytes, totalBytes });
      await this.arrival(signal);
    }
  }

  /** Resolves when a node arrives, the run is cancelled, or after a second (a missed event). */
  private arrival(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (this.wake === done) this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, 1000);
      signal.addEventListener('abort', done);
      this.wake = done;
    });
  }

  /** A cached node with sizes for the current settings. */
  private styled(path: string): PlaceSource {
    const c = this.cache.get(path)!;
    if (c.version !== this.styleVersion) {
      this.host.style(c.data, c.colors, c.sizes);
      c.version = this.styleVersion;
    }
    return c;
  }
}

/** The waypoints and numbers of a search. */
function routeResult(t: RouteTry<CorridorNet>, mode: RouteMode, straight: number, stats: RouteStats): RouteResult {
  const { graph, path } = t;
  const { places } = graph;
  const waypoints = path.places.map((p, k): Waypoint => ({
    data: places.sources[places.repSource[p]].data,
    index: places.repIndex[p],
    pos: { x: places.positions[3 * p], y: places.positions[3 * p + 1], z: places.positions[3 * p + 2] },
    jump: k > 0 ? path.lengths[k - 1] : 0,
  }));
  return {
    waypoints,
    found: path.found,
    jumps: path.jumps,
    total: path.total,
    straight,
    width: t.width,
    short: path.found ? 0 : path.closestDistance,
    mode,
    stats: { ...stats, tried: [...stats.tried] },
  };
}
