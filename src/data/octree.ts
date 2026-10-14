import { Box3, Vector3 } from 'three';
import { decodeNode, type NodeData } from './format';

export interface SourceInfo {
  key: string;
  title: string;
  citation?: string;
  url?: string;
  license?: string;
  rows?: number;
  used?: number;
}

export interface Manifest {
  format: string;
  version: number;
  generated: string;
  units: string;
  frame: string;
  root: { center: [number, number, number]; halfSize: number };
  capacity: number;
  starCount: number;
  nodeCount: number;
  packs: string[];
  /** [path, count, bytes, childMask, packIndex, byteOffset] */
  nodes: [string, number, number, number, number, number][];
  sources: SourceInfo[];
  params?: Record<string, unknown>;
  stats?: Record<string, unknown>;
}

export interface OctreeNode {
  path: string;
  level: number;
  count: number;
  bytes: number;
  pack: number;
  offset: number;
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

export class Octree {
  readonly root: OctreeNode;
  readonly nodes = new Map<string, OctreeNode>();

  constructor(readonly manifest: Manifest) {
    const entries = new Map(manifest.nodes.map((n) => [n[0], n]));
    const rootEntry = entries.get('r');
    if (!rootEntry) throw new Error('manifest has no root node');
    const build = (path: string, parent: OctreeNode | null, center: [number, number, number], half: number): OctreeNode => {
      const e = entries.get(path)!;
      const worldCenter = new Vector3(center[0], center[2], -center[1]);
      const node: OctreeNode = {
        path,
        level: path.length - 1,
        count: e[1],
        bytes: e[2],
        pack: e[4],
        offset: e[5],
        galCenter: center,
        halfSize: half,
        box: new Box3(
          worldCenter.clone().subScalar(half),
          worldCenter.clone().addScalar(half),
        ),
        worldCenter,
        radius: half * Math.sqrt(3),
        parent,
        children: [],
      };
      this.nodes.set(path, node);
      const mask = e[3];
      for (let i = 0; i < 8; i++) {
        if (!(mask & (1 << i))) continue;
        const childPath = path + i;
        if (!entries.has(childPath)) continue;
        const h = half / 2;
        const c: [number, number, number] = [
          center[0] + (i & 1 ? h : -h),
          center[1] + (i & 2 ? h : -h),
          center[2] + (i & 4 ? h : -h),
        ];
        node.children.push(build(childPath, node, c, h));
      }
      return node;
    };
    this.root = build('r', null, manifest.root.center, manifest.root.halfSize);
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

/** Fetches and decodes node files with limited concurrency and a priority queue. */
export class NodeLoader {
  private readonly loaded = new Map<string, NodeData>();
  private readonly inflight = new Set<string>();
  private readonly failed = new Set<string>();
  private queue: OctreeNode[] = [];
  private lastUse = new Map<string, number>();
  private frame = 0;

  onLoaded: (node: OctreeNode, data: NodeData) => void = () => {};
  onEvicted: (path: string) => void = () => {};

  private rangeSupported: boolean | null = null;
  private readonly packCache = new Map<number, Promise<ArrayBuffer>>();

  constructor(
    private readonly baseUrl: string,
    private readonly packs: string[],
    private readonly maxConcurrent = 6,
  ) {}

  get(path: string): NodeData | undefined {
    return this.loaded.get(path);
  }

  get loadedCount(): number {
    return this.loaded.size;
  }

  get pendingCount(): number {
    return this.queue.length + this.inflight.size;
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
    this.queue = nodes.filter((n) => !this.loaded.has(n.path) && !this.inflight.has(n.path) && !this.failed.has(n.path));
    this.pump();
    this.evict(cacheBudgetPoints);
  }

  private pump(): void {
    while (this.inflight.size < this.maxConcurrent && this.queue.length > 0) {
      const node = this.queue.shift()!;
      this.inflight.add(node.path);
      this.fetchNode(node)
        .then((data) => {
          this.loaded.set(node.path, data);
          this.lastUse.set(node.path, this.frame);
          this.onLoaded(node, data);
        })
        .catch((err) => {
          console.error(`failed to load node ${node.path}`, err);
          this.failed.add(node.path);
        })
        .finally(() => {
          this.inflight.delete(node.path);
          this.pump();
        });
    }
  }

  private async fetchNode(node: OctreeNode): Promise<NodeData> {
    const buf = await this.fetchBlob(node);
    return decodeNode(buf, node.path);
  }

  /**
   * Fetch the node's byte range from its pack file. If the server does not honour Range
   * requests, the whole pack is downloaded once and kept in memory.
   */
  private async fetchBlob(node: OctreeNode): Promise<ArrayBuffer> {
    const url = `${this.baseUrl}${this.packs[node.pack]}`;
    const end = node.offset + node.bytes;
    if (this.rangeSupported !== false) {
      const res = await fetch(url, { headers: { Range: `bytes=${node.offset}-${end - 1}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (res.status === 206) {
        this.rangeSupported = true;
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== node.bytes) throw new Error(`short range read ${buf.byteLength}/${node.bytes}`);
        return buf;
      }
      // Server ignored the range: it sent the whole pack.
      this.rangeSupported = false;
      const whole = await res.arrayBuffer();
      this.packCache.set(node.pack, Promise.resolve(whole));
      return whole.slice(node.offset, end);
    }
    let pack = this.packCache.get(node.pack);
    if (!pack) {
      pack = fetch(url).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      });
      this.packCache.set(node.pack, pack);
      pack.catch(() => this.packCache.delete(node.pack));
    }
    const whole = await pack;
    return whole.slice(node.offset, end);
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
