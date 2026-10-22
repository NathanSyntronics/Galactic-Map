import { describe, expect, it } from 'vitest';
import { DesigCat, type NodeData } from '../../src/data/format';
import type { Aabb } from '../../src/network/capsule';
import {
  MAX_CORRIDOR_BYTES,
  RoutePlanner,
  parseStoredRoute,
  sameStar,
  type CorridorNode,
  type PlannerHost,
  type RouteEnd,
  type StoredRoute,
} from '../../src/network/planner';
import { source, type Star } from './fixtures/stars';

interface TestNode extends CorridorNode {
  children: TestNode[];
  data: NodeData;
}

const box = (x0: number, x1: number): Aabb => ({ min: { x: x0, y: -64, z: -64 }, max: { x: x1, y: 64, z: 64 } });

/** A node whose stars have the designations "<path>-<index>". */
function node(path: string, x0: number, x1: number, stars: Star[], children: TestNode[] = []): TestNode {
  const { data } = source(path, stars);
  data.desigCat.fill(DesigCat.STRING);
  for (let i = 0; i < data.count; i++) data.designations.set(i, `${path}-${i}`);
  return { path, count: data.count, bytes: 1000 + 40 * data.count, box: box(x0, x1), children, data };
}

const chain = (from: number, to: number, step: number): Star[] => {
  const out: Star[] = [];
  for (let x = from; x <= to + 1e-9; x += step) out.push({ x, logL: 0 });
  return out;
};

/**
 * A small tree along the x axis: r10 holds stars at x = 10 … 30, r11 at 34 … 50 (every 4 ly), r00
 * lies far away at x < -32 and must never be loaded for a route from x = 10 to 50.
 */
function tree(): { root: TestNode; nodes: Map<string, TestNode> } {
  const r10 = node('r10', 0, 32, chain(10, 30, 4));
  const r11 = node('r11', 32, 64, chain34());
  const r00 = node('r00', -64, -32, chain(-60, -40, 4));
  const r01 = node('r01', -32, 0, []);
  const r0 = node('r0', -64, 0, [], [r00, r01]);
  const r1 = node('r1', 0, 64, [], [r10, r11]);
  const root = node('r', -64, 64, [], [r0, r1]);
  const nodes = new Map<string, TestNode>();
  const walk = (n: TestNode) => {
    nodes.set(n.path, n);
    n.children.forEach(walk);
  };
  walk(root);
  return { root, nodes };
}

function chain34(): Star[] {
  return chain(34, 50, 4);
}

/** A host that loads the wanted nodes when `deliver` is called. */
class FakeHost implements PlannerHost<TestNode> {
  readonly tree = tree();
  readonly loaded = new Set<string>();
  readonly failing = new Set<string>();
  readonly requested = new Set<string>();
  wanted: TestNode[] = [];
  hidden = new Set<string>();
  range = 5;
  saved: StoredRoute | null = null;
  finds: string[] = [];
  retried: string[] = [];
  ready = true;
  /** Calls of style() (restyled nodes). */
  styled = 0;
  planner!: RoutePlanner<TestNode>;

  root = () => (this.ready ? this.tree.root : null);
  node = (path: string) => this.tree.nodes.get(path);
  want = (nodes: TestNode[]) => {
    this.wanted = nodes;
    for (const n of nodes) this.requested.add(n.path);
  };
  data = (path: string) => (this.loaded.has(path) ? this.tree.nodes.get(path)?.data : undefined);
  failed = (path: string) => this.failing.has(path);
  retry = (path: string) => {
    this.retried.push(path);
    this.failing.delete(path);
  };
  options = () => ({
    range: this.range,
    hub: 1,
    kSun: 7,
    connect: true,
    capacity: { by: 'luminosity' as const, faint: 3, sun: 7, bright: 12 },
  });
  style = (data: NodeData, _colors: Uint8Array, sizes: Float32Array) => {
    this.styled++;
    for (let i = 0; i < data.count; i++) sizes[i] = this.hidden.has(`${data.path}:${i}`) ? 0 : 0.2;
  };
  nodeKey = (path: string) => [...this.tree.nodes.keys()].indexOf(path);
  find = async (designation: string) => {
    this.finds.push(designation);
    for (const n of this.tree.nodes.values()) {
      for (let i = 0; i < n.data.count; i++) if (n.data.designations.get(i) === designation) return { path: n.path, index: i };
    }
    return null;
  };
  save = (r: StoredRoute) => {
    this.saved = r;
  };

  /** Loads (or fails) the wanted nodes and tells the planner. */
  deliver(): void {
    for (const n of this.wanted) if (!this.failing.has(n.path)) this.loaded.add(n.path);
    this.planner.nodeArrived();
  }

  end(path: string, index: number): RouteEnd {
    const d = this.tree.nodes.get(path)!.data;
    return {
      designation: `${path}-${index}`,
      nameEn: null,
      nameDe: null,
      sun: false,
      path,
      index,
      pos: { x: d.positions[3 * index], y: d.positions[3 * index + 1], z: d.positions[3 * index + 2] },
    };
  }
}

function setup(stored: StoredRoute | null = null): { host: FakeHost; planner: RoutePlanner<TestNode>; kinds: string[] } {
  const host = new FakeHost();
  const planner = new RoutePlanner(host, stored);
  host.planner = planner;
  const kinds: string[] = [];
  planner.onChange = () => kinds.push(planner.status.kind);
  return { host, planner, kinds };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Delivers wanted nodes until the planner is done. */
async function settle(host: FakeHost, planner: RoutePlanner<TestNode>, deliver = true): Promise<void> {
  for (let k = 0; k < 500; k++) {
    await sleep(1);
    if (deliver && host.wanted.length) host.deliver();
    if (!planner.busy && k > 2) return;
  }
  throw new Error(`planner still busy: ${planner.status.kind}`);
}

describe('route planner', () => {
  it('loads the corridor, computes the network and finds the route', async () => {
    const { host, planner, kinds } = setup();
    planner.setEnd('from', host.end('r10', 0));
    expect(planner.status.kind).toBe('incomplete');
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    expect(kinds).toContain('loading');
    expect(kinds).toContain('computing');
    expect(planner.status.kind).toBe('found');
    const r = planner.route!;
    expect(r.found).toBe(true);
    expect(r.jumps).toBeGreaterThan(0);
    expect(r.waypoints[0].data.path).toBe('r10');
    expect(r.waypoints[0].pos.x).toBe(10);
    expect(r.waypoints[r.waypoints.length - 1].pos.x).toBe(50);
    for (const w of r.waypoints.slice(1)) expect(w.jump).toBeLessThanOrEqual(5);
    expect(r.total).toBeCloseTo(40, 4);
    expect(r.straight).toBeCloseTo(40, 4);
    expect(r.stats.tried).toEqual([10]);
    // nothing is wanted any more, the far node was never asked for
    expect(host.wanted).toEqual([]);
    expect(host.requested.has('r00')).toBe(false);
    expect(host.requested.has('r10') && host.requested.has('r11')).toBe(true);
    expect(host.saved?.from?.designation).toBe('r10-0');
  });

  it('reports the loading progress by tiles and bytes', async () => {
    const { host, planner } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await sleep(5);
    host.loaded.add('r10'); // the ends' nodes
    host.loaded.add('r11');
    planner.nodeArrived();
    await sleep(5);
    const st = planner.status;
    expect(st.kind).toBe('loading');
    if (st.kind !== 'loading') return;
    expect(st.width).toBe(10);
    expect(st.total).toBeGreaterThan(st.loaded);
    expect(st.loaded).toBe(2);
    expect(st.totalBytes).toBeGreaterThan(st.loadedBytes);
    await settle(host, planner);
    expect(planner.status.kind).toBe('found');
  });

  it('recomputes from the kept data after a change of the shown stars', async () => {
    const { host, planner } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    const before = planner.route!;
    // the loader evicts everything; hiding the star at x = 30 leaves a gap of 8 ly > range
    host.loaded.clear();
    host.requested.clear();
    host.hidden.add('r10:5');
    const styled = host.styled;
    planner.styleChanged();
    planner.invalidate();
    await settle(host, planner);
    // the nodes of the first corridor are restyled, not loaded again; the widening adds r00
    expect([...host.requested]).toEqual(['r00']);
    expect(host.styled).toBeGreaterThan(styled);
    expect(planner.status.kind).toBe('unreachable');
    expect(planner.route).not.toBe(before);
    expect(planner.route!.found).toBe(false);
    // the partial route ends at the reached place closest to the destination
    expect(planner.route!.waypoints[planner.route!.waypoints.length - 1].pos.x).toBe(26);
    expect(planner.route!.short).toBeCloseTo(24, 4);
  });

  it('keeps the route shown while it is recomputed, and drops it when an end changes', async () => {
    const { host, planner } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    const route = planner.route;
    planner.setMode('distance');
    expect(planner.route).toBe(route);
    await settle(host, planner);
    expect(planner.status.kind).toBe('found');
    planner.setEnd('to', host.end('r11', 2));
    expect(planner.route).toBeNull();
    await settle(host, planner);
    expect(planner.route!.waypoints[planner.route!.waypoints.length - 1].pos.x).toBe(42);
  });

  it('gives the same route reversed when start and destination are swapped', async () => {
    const { host, planner } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    const there = planner.route!.waypoints.map((w) => `${w.data.path}:${w.index}`);
    planner.swap();
    await settle(host, planner);
    expect(planner.route!.waypoints.map((w) => `${w.data.path}:${w.index}`)).toEqual([...there].reverse());
    expect(planner.from!.designation).toBe('r11-4');
  });

  it('reports a hidden start star as missing', async () => {
    const { host, planner } = setup();
    host.hidden.add('r10:0');
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    expect(planner.status).toEqual({ kind: 'missing', end: 'from' });
    expect(planner.route).toBeNull();
  });

  it('reports tiles that cannot be loaded and retries them', async () => {
    const { host, planner } = setup();
    host.failing.add('r11');
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await settle(host, planner);
    expect(planner.status).toEqual({ kind: 'failed', tiles: 1 });
    expect(host.wanted).toEqual([]);
    planner.retry();
    expect(host.retried).toEqual(['r11']);
    await settle(host, planner);
    expect(planner.status.kind).toBe('found');
  });

  it('cancels a running computation when an end changes', async () => {
    const { host, planner, kinds } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    await sleep(5);
    expect(planner.status.kind).toBe('loading');
    planner.setEnd('to', null);
    expect(planner.status.kind).toBe('incomplete');
    expect(host.wanted).toEqual([]);
    host.loaded.add('r10');
    host.loaded.add('r11');
    planner.nodeArrived();
    await sleep(20);
    expect(planner.status.kind).toBe('incomplete');
    expect(kinds.at(-1)).toBe('incomplete');
  });

  it('waits for the catalogue', async () => {
    const { host, planner } = setup();
    host.ready = false;
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r11', 4));
    expect(planner.status.kind).toBe('waiting');
    host.ready = true;
    planner.invalidate();
    await settle(host, planner);
    expect(planner.status.kind).toBe('found');
  });

  it('finds an end by its designation when the stored node and index no longer match', async () => {
    const { host, planner } = setup();
    const stale = { ...host.end('r11', 4), path: 'r10', index: 1 };
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', stale);
    await settle(host, planner);
    expect(host.finds).toEqual(['r11-4']);
    expect(planner.status.kind).toBe('found');
    expect(planner.to).toMatchObject({ path: 'r11', index: 4 });
    expect(host.saved?.to).toMatchObject({ path: 'r11', index: 4 });
    // a designation that no longer exists
    planner.setEnd('to', { ...stale, designation: 'gone' });
    await settle(host, planner);
    expect(planner.status).toEqual({ kind: 'notFound', end: 'to' });
  });

  it('refuses a corridor with too much data before loading it', async () => {
    const { host, planner } = setup();
    host.tree.nodes.get('r11')!.bytes = MAX_CORRIDOR_BYTES + 1;
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r10', 5));
    await settle(host, planner);
    const st = planner.status;
    expect(st.kind).toBe('refused');
    if (st.kind === 'refused') expect(st.reason).toBe('data');
    expect(host.requested.has('r11')).toBe(false);
  });

  it('clears the other end when the same star is chosen for both', () => {
    const { host, planner } = setup();
    planner.setEnd('from', host.end('r10', 0));
    planner.setEnd('to', host.end('r10', 0));
    expect(planner.from).toBeNull();
    expect(planner.to?.designation).toBe('r10-0');
    expect(sameStar(host.end('r10', 0), host.end('r10', 0))).toBe(true);
    planner.clear();
    expect(planner.status.kind).toBe('empty');
    expect(host.saved).toEqual({ v: 1, from: null, to: null, mode: 'jumps' });
  });

  it('restores a stored route', async () => {
    const host0 = new FakeHost();
    const stored: StoredRoute = { v: 1, from: host0.end('r10', 0), to: host0.end('r11', 4), mode: 'distance' };
    const parsed = parseStoredRoute(JSON.stringify(stored));
    expect(parsed).toEqual(stored);
    const { host, planner } = setup(parsed);
    expect(planner.mode).toBe('distance');
    expect(planner.status.kind).toBe('waiting');
    planner.invalidate();
    await settle(host, planner);
    expect(planner.status.kind).toBe('found');
    expect(planner.route!.mode).toBe('distance');
  });
});

describe('stored routes', () => {
  const end = { designation: 'HR 2061', nameEn: 'Betelgeuse', nameDe: 'Beteigeuze', sun: false, path: 'r', index: 12, pos: { x: 1, y: 2, z: 3 } };

  it('accepts one end and defaults the mode', () => {
    expect(parseStoredRoute(JSON.stringify({ v: 1, from: end, to: null }))).toEqual({ v: 1, from: end, to: null, mode: 'jumps' });
  });

  it('rejects malformed data', () => {
    expect(parseStoredRoute(null)).toBeNull();
    expect(parseStoredRoute('{')).toBeNull();
    expect(parseStoredRoute(JSON.stringify({ v: 2, from: end, to: end }))).toBeNull();
    expect(parseStoredRoute(JSON.stringify({ v: 1, from: null, to: null }))).toBeNull();
    expect(parseStoredRoute(JSON.stringify({ v: 1, from: { ...end, pos: { x: 1, y: 'a', z: 3 } }, to: null }))).toBeNull();
    expect(parseStoredRoute(JSON.stringify({ v: 1, from: { ...end, designation: '' }, to: null }))).toBeNull();
    // a bad end is dropped, the good one kept
    expect(parseStoredRoute(JSON.stringify({ v: 1, from: { ...end, index: 'x' }, to: end, mode: 'distance' }))).toEqual({
      v: 1,
      from: null,
      to: end,
      mode: 'distance',
    });
  });
});
