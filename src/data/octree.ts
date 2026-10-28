import { Box3, Vector3 } from 'three';
import { FormatError, decodeNode, type NodeData } from './format';

export interface SourceInfo {
  key: string;
  title: string;
  citation?: string;
  url?: string;
  license?: string;
  rows?: number;
  used?: number;
}

/**
 * A node row: [path, count, bytes, childMask, packIndex, byteOffset], and in manifest version 2
 * optionally the file of a sub-manifest that lists the node's descendants (m/<path>.json).
 */
export type NodeRow = [string, number, number, number, number, number, (string | null)?];

export interface Manifest {
  format: string;
  /** 1, or 2 with sub-manifests (docs/SCALING.md). */
  version: number;
  generated: string;
  units: string;
  frame: string;
  root: { center: [number, number, number]; halfSize: number };
  capacity: number;
  starCount: number;
  /** All nodes, including those in sub-manifests. */
  nodeCount: number;
  packs: string[];
  nodes: NodeRow[];
  sources: SourceInfo[];
  params?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

/** A sub-manifest (m/<path>.json): the rows of a node's descendants. */
export interface SubManifest {
  path: string;
  nodes: NodeRow[];
}

export interface OctreeNode {
  path: string;
  level: number;
  count: number;
  bytes: number;
  pack: number;
  offset: number;
  /** Bit i set: child i exists (it may not be loaded yet, see `sub`). */
  childMask: number;
  /** File of the sub-manifest that lists the descendants while they are not loaded, else null. */
  sub: string | null;
  /** Galactic-frame cube. */
  galCenter: [number, number, number];
  halfSize: number;
  /** World-frame bounding box. */
  box: Box3;
  worldCenter: Vector3;
  /** Radius of the circumscribed sphere. */
  radius: number;
  parent: OctreeNode | null;
  children: OctreeNode[];
}

/** Bits of a node key for the star index (keys are nodeKey * 2^13 + index, capacity <= 8192). */
export const NODE_KEY_SHIFT = 2 ** 13;

/**
 * A stable number of a node, for the tie-break keys of the jump network: from its place in the
 * packs, which the writer fills in a fixed order (pre-order of the tree for a single bucket). It
 * does not depend on which sub-manifests are loaded or in which order.
 */
export function nodeKeyOf(node: { pack: number; offset: number }): number {
  return node.pack * 2 ** 24 + node.offset / 8;
}

export type FetchRows = (file: string) => Promise<NodeRow[]>;

export class Octree {
  readonly root: OctreeNode;
  readonly nodes = new Map<string, OctreeNode>();
  /** Sub-manifests being loaded, by node path. */
  private readonly loading = new Map<string, Promise<OctreeNode[]>>();
  /** Called with the nodes a sub-manifest added. */
  onAdded: (nodes: OctreeNode[]) => void = () => {};

  constructor(readonly manifest: Manifest) {
    const entries = new Map(manifest.nodes.map((n) => [n[0], n]));
    if (!entries.get('r')) throw new Error('manifest has no root node');
    this.root = this.build(entries, 'r', null, manifest.root.center, manifest.root.halfSize);
  }

  private build(
    entries: Map<string, NodeRow>,
    path: string,
    parent: OctreeNode | null,
    center: [number, number, number],
    half: number,
    added?: OctreeNode[],
  ): OctreeNode {
    const e = entries.get(path)!;
    const worldCenter = new Vector3(center[0], center[2], -center[1]);
    const node: OctreeNode = {
      path,
      level: path.length - 1,
      count: e[1],
      bytes: e[2],
      pack: e[4],
      offset: e[5],
      childMask: e[3],
      sub: e[6] || null,
      galCenter: center,
      halfSize: half,
      box: new Box3(worldCenter.clone().subScalar(half), worldCenter.clone().addScalar(half)),
      worldCenter,
      radius: half * Math.sqrt(3),
      parent,
      children: [],
    };
    this.nodes.set(path, node);
    added?.push(node);
    if (!node.sub) this.buildChildren(entries, node, added);
    return node;
  }

  private buildChildren(entries: Map<string, NodeRow>, node: OctreeNode, added?: OctreeNode[]): void {
    for (let i = 0; i < 8; i++) {
      if (!(node.childMask & (1 << i))) continue;
      const childPath = node.path + i;
      if (!entries.has(childPath)) continue;
      const h = node.halfSize / 2;
      const c = node.galCenter;
      const center: [number, number, number] = [c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h)];
      node.children.push(this.build(entries, childPath, node, center, h, added));
    }
  }

  /** Adds the descendants of a node from its sub-manifest's rows; returns the new nodes. */
  addSub(node: OctreeNode, rows: NodeRow[]): OctreeNode[] {
    if (!node.sub) return [];
    const added: OctreeNode[] = [];
    node.sub = null;
    this.buildChildren(new Map(rows.map((r) => [r[0], r])), node, added);
    this.onAdded(added);
    return added;
  }

  /** Loads a node's sub-manifest (once, also when asked again while it loads). */
  loadSub(node: OctreeNode, fetchRows: FetchRows): Promise<OctreeNode[]> {
    if (!node.sub) return Promise.resolve([]);
    let p = this.loading.get(node.path);
    if (!p) {
      const file = node.sub;
      p = fetchRows(file).then(
        (rows) => {
          this.loading.delete(node.path);
          return this.addSub(node, rows);
        },
        (err: unknown) => {
          this.loading.delete(node.path);
          throw err;
        },
      );
      this.loading.set(node.path, p);
    }
    return p;
  }

  /** True while the node's descendants are listed in a sub-manifest that is not loaded. */
  static hasUnloaded(node: OctreeNode): boolean {
    return node.sub !== null && node.childMask !== 0;
  }

  /**
   * Loads the sub-manifests of every node for which `wants` is true, also those that the loaded
   * ones reveal, until the tree is complete where `wants` holds (route corridors).
   */
  async expandWhere(wants: (node: OctreeNode) => boolean, fetchRows: FetchRows): Promise<void> {
    for (;;) {
      const todo: OctreeNode[] = [];
      const stack = [this.root];
      while (stack.length) {
        const n = stack.pop()!;
        if (!wants(n)) continue;
        if (Octree.hasUnloaded(n)) todo.push(n);
        else stack.push(...n.children);
      }
      if (!todo.length) return;
      await Promise.all(todo.map((n) => this.loadSub(n, fetchRows)));
    }
  }

  /** The node of a path, loading the sub-manifests on the way to it; undefined if there is none. */
  async reach(path: string, fetchRows: FetchRows): Promise<OctreeNode | undefined> {
    for (;;) {
      const have = this.nodes.get(path);
      if (have) return have;
      // the deepest loaded ancestor
      let p = path.slice(0, -1);
      while (p.length > 1 && !this.nodes.has(p)) p = p.slice(0, -1);
      const anc = this.nodes.get(p);
      if (!anc || !Octree.hasUnloaded(anc)) return undefined;
      await this.loadSub(anc, fetchRows);
    }
  }
}

export interface SelectionParams {
  cameraPos: Vector3;
  target: Vector3;
  radius: number;
  budget: number;
  /** Projection factor: pixels per (world size / distance). */
  pixelsPerUnitAtUnitDistance: number;
}

const tmpClosest = new Vector3();

function sphereIntersectsBox(center: Vector3, radius: number, box: Box3): boolean {
  box.clampPoint(center, tmpClosest);
  return tmpClosest.distanceToSquared(center) <= radius * radius;
}

/**
 * Chooses the nodes to display: all nodes whose cube intersects the visibility sphere,
 * refined from the root downwards in order of projected size, until the point budget is used up.
 */
export function selectNodes(octree: Octree, p: SelectionParams): OctreeNode[] {
  const selected: OctreeNode[] = [];
  const root = octree.root;
  if (!sphereIntersectsBox(p.target, p.radius, root.box)) return selected;
  const heap: { node: OctreeNode; priority: number }[] = [];
  const push = (node: OctreeNode) => {
    const d = Math.max(node.worldCenter.distanceTo(p.cameraPos) - node.radius, node.halfSize * 0.05, 1e-6);
    const priority = ((2 * node.halfSize) / d) * p.pixelsPerUnitAtUnitDistance;
    heap.push({ node, priority });
    // sift up
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].priority >= heap[i].priority) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].priority > heap[m].priority) m = l;
        if (r < heap.length && heap[r].priority > heap[m].priority) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  push(root);
  let points = 0;
  while (heap.length > 0) {
    const { node } = pop();
    if (selected.length > 0 && points + node.count > p.budget) break;
    selected.push(node);
    points += node.count;
    for (const child of node.children) {
      if (sphereIntersectsBox(p.target, p.radius, child.box)) push(child);
    }
  }
  return selected;
}

/**
 * True when a selection holds every node whose cube intersects the sphere, i.e. all stars inside
 * it and not just the brighter part the point budget allowed.
 */
export function selectionComplete(selected: OctreeNode[], center: Vector3, radius: number): boolean {
  const set = new Set(selected);
  for (const node of selected) {
    // descendants not known yet (their sub-manifest is loading): cannot be complete
    if (Octree.hasUnloaded(node) && sphereIntersectsBox(center, radius, node.box)) return false;
    for (const child of node.children) {
      if (!set.has(child) && sphereIntersectsBox(center, radius, child.box)) return false;
    }
  }
  return true;
}

/**
 * Selection for a sphere plus a margin (the jump network's region). The wider selection is taken
 * only when it is complete; otherwise the selection is exactly `selectNodes` for the sphere
 * alone, so the margin never takes points from the visible sphere. (A complete wider selection
 * holds every node that touches the sphere, which is also what the sphere alone gets then.)
 */
export function selectWithMargin(octree: Octree, p: SelectionParams, margin: number): { nodes: OctreeNode[]; wide: boolean } {
  if (margin > 0) {
    const wide = selectNodes(octree, { ...p, radius: p.radius + margin });
    if (selectionComplete(wide, p.target, p.radius + margin)) return { nodes: wide, wide: true };
  }
  return { nodes: selectNodes(octree, p), wide: false };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** An HTTP error response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * Errors a retry cannot fix: missing files and other client errors (except timeouts and rate
 * limits), and malformed data. Network errors, server errors and truncated transfers are transient.
 */
export function isPermanentError(err: unknown): boolean {
  if (err instanceof FormatError) return true;
  if (err instanceof HttpError) return err.status >= 400 && err.status < 500 && ![408, 425, 429].includes(err.status);
  return false;
}

/** Number of attempts to load a node before giving up on transient errors (and reporting it). */
export const MAX_ATTEMPTS = 6;

/** After giving up on transient errors, a node that is still wanted is tried again this rarely. */
export const GIVE_UP_RETRY_MS = 120_000;

/** Delay before the retry after the `failures`-th failed attempt: 1 s, 2 s, 4 s, … at most 30 s. */
export function retryDelay(failures: number): number {
  return Math.min(1000 * 2 ** Math.max(failures - 1, 0), 30_000);
}

/** Map with least-recently-used eviction. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly maxEntries: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value as K);
  }

  /** Removes the entry if it still holds `value`. */
  deleteIf(key: K, value: V): void {
    if (this.map.get(key) === value) this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Reads node blobs from pack files with HTTP Range requests. Whether the server honours a range is
 * decided per response: a `206` carries just the blob; a `200` carries the whole pack, which is
 * then kept in a small LRU cache and serves the pack's other nodes. Until the first `206` has been
 * seen, only one request per pack is in flight, so a server that ignores ranges sends each pack
 * once instead of once per concurrent request.
 */
export class PackFetcher {
  private readonly packs: LruCache<number, Promise<ArrayBuffer>>;
  /** Outstanding first request per pack while range support is unknown; resolves on its headers. */
  private readonly probes = new Map<number, Promise<void>>();
  private rangeSeen = false;
  /** Number of responses that carried a whole pack (statistics). */
  fullDownloads = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly packNames: string[],
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
    /** Whole packs kept in memory (each about 4 MB). */
    maxPacks = 8,
  ) {
    this.packs = new LruCache(maxPacks);
  }

  get cachedPacks(): number {
    return this.packs.size;
  }

  async fetch(pack: number, offset: number, bytes: number): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}${this.packNames[pack]}`;
    for (;;) {
      const cached = this.packs.get(pack);
      if (cached) return this.slice(pack, cached, offset, bytes);
      const probe = this.probes.get(pack);
      if (!probe || this.rangeSeen) break;
      await probe;
    }

    let release = () => {};
    const gate = this.rangeSeen ? null : new Promise<void>((resolve) => (release = resolve));
    if (gate) this.probes.set(pack, gate);
    const open = () => {
      if (gate && this.probes.get(pack) === gate) this.probes.delete(pack);
      release();
    };
    try {
      const range = `bytes=${offset}-${offset + bytes - 1}`;
      const res = await this.fetchFn(url, { headers: { Range: range } });
      if (res.status === 206) {
        this.rangeSeen = true;
        open();
        let buf = await res.arrayBuffer();
        if (buf.byteLength !== bytes) {
          // the browser's HTTP cache sometimes answers a revalidated range with an empty body
          // (seen in Chrome after a reload): ask the server once more, past the cache
          const again = await this.fetchFn(url, { headers: { Range: range }, cache: 'no-store' });
          if (again.status === 206) buf = await again.arrayBuffer();
          else if (again.ok) {
            const whole = await again.arrayBuffer();
            if (whole.byteLength >= offset + bytes) buf = whole.slice(offset, offset + bytes);
          }
        }
        if (buf.byteLength !== bytes) throw new Error(`short range read ${buf.byteLength}/${bytes} from ${url}`);
        return buf;
      }
      if (!res.ok) throw new HttpError(res.status, url);
      // The server ignored the range and sends the whole pack: cache it before reading the body,
      // so that requests for the pack's other nodes wait for this download instead of starting one.
      this.fullDownloads++;
      const whole = res.arrayBuffer();
      this.packs.set(pack, whole);
      whole.catch(() => this.packs.deleteIf(pack, whole));
      open();
      return await this.slice(pack, whole, offset, bytes);
    } finally {
      open();
    }
  }

  private async slice(pack: number, whole: Promise<ArrayBuffer>, offset: number, bytes: number): Promise<ArrayBuffer> {
    const buf = await whole;
    if (buf.byteLength < offset + bytes) {
      this.packs.deleteIf(pack, whole);
      throw new Error(`pack ${this.packNames[pack]} truncated: ${buf.byteLength} < ${offset + bytes}`);
    }
    return buf.slice(offset, offset + bytes);
  }
}

interface Failure {
  attempts: number;
  /** Time (see NodeLoader `now`) after which the node may be fetched again. */
  retryAt: number;
  /** Never fetched again (missing file, malformed data). */
  permanent: boolean;
  /** Given up and reported through onFailed: a permanent error or MAX_ATTEMPTS failures. */
  gaveUp: boolean;
}

/**
 * Fetches and decodes node files with limited concurrency and a priority queue. Failed loads are
 * retried with exponential backoff. Permanent errors (missing file, malformed data) and nodes that
 * failed MAX_ATTEMPTS times are given up and reported through onFailed; after transient errors a
 * node that is still wanted is nevertheless tried again every GIVE_UP_RETRY_MS (the connection may
 * come back), and loads normally if that succeeds.
 */
export class NodeLoader {
  private readonly loaded = new Map<string, NodeData>();
  private readonly inflight = new Set<string>();
  private readonly failures = new Map<string, Failure>();
  private wanted: OctreeNode[] = [];
  private queue: OctreeNode[] = [];
  private lastUse = new Map<string, number>();
  private frame = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerAt = Infinity;
  readonly packs: PackFetcher;
  private readonly maxConcurrent: number;
  private readonly now: () => number;

  onLoaded: (node: OctreeNode, data: NodeData) => void = () => {};
  onEvicted: (path: string) => void = () => {};
  /** A node could not be loaded (reported once; see the class comment for later retries). */
  onFailed: (node: OctreeNode, err: unknown) => void = () => {};

  constructor(
    baseUrl: string,
    packs: string[],
    opts: { maxConcurrent?: number; fetch?: FetchFn; maxPacks?: number; now?: () => number } = {},
  ) {
    this.packs = new PackFetcher(baseUrl, packs, opts.fetch, opts.maxPacks);
    this.maxConcurrent = opts.maxConcurrent ?? 6;
    this.now = opts.now ?? (() => performance.now());
  }

  get(path: string): NodeData | undefined {
    return this.loaded.get(path);
  }

  get loadedCount(): number {
    return this.loaded.size;
  }

  /** Requested nodes that are not loaded yet (queued, in flight or waiting for a retry). */
  get pendingCount(): number {
    let n = this.inflight.size;
    for (const node of this.wanted) {
      if (this.loaded.has(node.path) || this.inflight.has(node.path)) continue;
      if (this.failures.get(node.path)?.gaveUp) continue;
      n++;
    }
    return n;
  }

  /** Paths of the nodes that were given up. */
  get failedPaths(): string[] {
    return [...this.failures].filter(([, f]) => f.gaveUp).map(([p]) => p);
  }

  hasFailed(path: string): boolean {
    return this.failures.get(path)?.gaveUp === true;
  }

  /** Forgets the transient failures of a node, so that it is fetched again while wanted (a retry asked for by the user). */
  retry(path: string): void {
    const f = this.failures.get(path);
    if (!f || f.permanent) return;
    this.failures.delete(path);
    this.refill();
  }

  loadedPoints(): number {
    let n = 0;
    for (const d of this.loaded.values()) n += d.count;
    return n;
  }

  /** Request the given nodes (in priority order). Nodes not requested are kept in an LRU cache. */
  request(nodes: OctreeNode[], cacheBudgetPoints: number): void {
    this.frame++;
    for (const n of nodes) this.lastUse.set(n.path, this.frame);
    this.wanted = nodes;
    this.refill();
    this.evict(cacheBudgetPoints);
  }

  private refill(): void {
    const now = this.now();
    this.queue = this.wanted.filter((n) => {
      if (this.loaded.has(n.path) || this.inflight.has(n.path)) return false;
      const f = this.failures.get(n.path);
      return !f || (!f.permanent && now >= f.retryAt);
    });
    this.pump();
  }

  private pump(): void {
    while (this.inflight.size < this.maxConcurrent && this.queue.length > 0) {
      const node = this.queue.shift()!;
      this.inflight.add(node.path);
      this.fetchNode(node)
        .then((data) => {
          this.failures.delete(node.path);
          this.loaded.set(node.path, data);
          this.lastUse.set(node.path, this.frame);
          this.onLoaded(node, data);
        })
        .catch((err) => this.failed(node, err))
        .finally(() => {
          this.inflight.delete(node.path);
          this.pump();
        });
    }
  }

  private failed(node: OctreeNode, err: unknown): void {
    const f = this.failures.get(node.path) ?? { attempts: 0, retryAt: 0, permanent: false, gaveUp: false };
    f.attempts++;
    f.permanent = isPermanentError(err);
    this.failures.set(node.path, f);
    if (f.permanent || f.attempts >= MAX_ATTEMPTS) {
      if (!f.gaveUp) {
        f.gaveUp = true;
        console.error(`failed to load node ${node.path} (attempt ${f.attempts}), giving up`, err);
        this.onFailed(node, err);
      }
      if (f.permanent) return;
      f.retryAt = this.now() + GIVE_UP_RETRY_MS;
      this.scheduleRetry(f.retryAt);
      return;
    }
    const delay = retryDelay(f.attempts);
    f.retryAt = this.now() + delay;
    console.warn(`failed to load node ${node.path} (attempt ${f.attempts}), retrying in ${delay / 1000} s`, err);
    this.scheduleRetry(f.retryAt);
  }

  /** Re-checks the queue when the earliest pending retry is due, without waiting for a view change. */
  private scheduleRetry(at: number): void {
    if (this.retryTimer !== null && this.retryTimerAt <= at) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimerAt = at;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.retryTimerAt = Infinity;
        this.refill();
        // later retries
        const now = this.now();
        let next = Infinity;
        for (const f of this.failures.values()) if (!f.permanent && f.retryAt > now) next = Math.min(next, f.retryAt);
        if (next < Infinity) this.scheduleRetry(next);
      },
      Math.max(at - this.now(), 0),
    );
  }

  private async fetchNode(node: OctreeNode): Promise<NodeData> {
    const buf = await this.packs.fetch(node.pack, node.offset, node.bytes);
    try {
      return decodeNode(buf, node.path);
    } catch (err) {
      // the blob has the expected size, so a decoding error means malformed data
      throw err instanceof FormatError ? err : new FormatError(`node ${node.path}: ${(err as Error).message}`);
    }
  }

  private evict(cacheBudgetPoints: number): void {
    let total = this.loadedPoints();
    if (total <= cacheBudgetPoints) return;
    const candidates = [...this.loaded.keys()]
      .filter((p) => (this.lastUse.get(p) ?? 0) < this.frame)
      .sort((a, b) => (this.lastUse.get(a) ?? 0) - (this.lastUse.get(b) ?? 0));
    for (const path of candidates) {
      if (total <= cacheBudgetPoints) break;
      const d = this.loaded.get(path)!;
      total -= d.count;
      this.loaded.delete(path);
      this.lastUse.delete(path);
      this.onEvicted(path);
    }
  }
}
