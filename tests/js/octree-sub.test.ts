import { readFileSync, readdirSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Octree, nodeKeyOf, selectNodes, selectionComplete, type Manifest, type NodeRow, type SubManifest } from '../../src/data/octree';
import { boxIntersectsCapsule } from '../../src/network/capsule';

const dir = new URL('./fixtures/sub/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as T;
const manifest = read<Manifest>('manifest.json');

function fetcher() {
  const asked: string[] = [];
  const fetchRows = async (file: string): Promise<NodeRow[]> => {
    asked.push(file);
    return read<SubManifest>(file).nodes;
  };
  return { asked, fetchRows };
}

async function complete(): Promise<Octree> {
  const t = new Octree(manifest);
  await t.expandWhere(() => true, fetcher().fetchRows);
  return t;
}

describe('octree with sub-manifests (manifest version 2)', () => {
  it('starts with the main manifest and knows where descendants are missing', () => {
    expect(manifest.version).toBe(2);
    const t = new Octree(manifest);
    expect(t.nodes.size).toBe(manifest.nodes.length);
    expect(t.nodes.size).toBeLessThan(manifest.nodeCount);
    const open = [...t.nodes.values()].filter((n) => Octree.hasUnloaded(n));
    expect(open.length).toBeGreaterThan(0);
    for (const n of open) expect(n.children).toEqual([]);
  });

  it('loads every node once, and keys stay unique and independent of the load order', async () => {
    const t = await complete();
    expect(t.nodes.size).toBe(manifest.nodeCount);
    expect([...t.nodes.values()].every((n) => !Octree.hasUnloaded(n))).toBe(true);
    // children match the masks
    for (const n of t.nodes.values()) {
      let mask = 0;
      for (const c of n.children) mask |= 1 << Number(c.path.slice(-1));
      expect(mask).toBe(n.childMask);
    }
    const keys = [...t.nodes.values()].map(nodeKeyOf);
    expect(new Set(keys).size).toBe(keys.length);
    // a lazily grown tree gives every node the same key
    const u = new Octree(manifest);
    const { fetchRows } = fetcher();
    const deepest = [...t.nodes.keys()].sort((a, b) => b.length - a.length)[0];
    const node = await u.reach(deepest, fetchRows);
    expect(node?.path).toBe(deepest);
    expect(nodeKeyOf(node!)).toBe(nodeKeyOf(t.nodes.get(deepest)!));
    expect(await u.reach(`${deepest}7777`, fetchRows)).toBeUndefined();
  });

  it('asks for a sub-manifest once, also when asked twice while it loads', async () => {
    const t = new Octree(manifest);
    const node = [...t.nodes.values()].find((n) => Octree.hasUnloaded(n))!;
    const { asked, fetchRows } = fetcher();
    let added = 0;
    t.onAdded = (nodes) => (added += nodes.length);
    const [a, b] = await Promise.all([t.loadSub(node, fetchRows), t.loadSub(node, fetchRows)]);
    expect(asked).toEqual([node.sub ?? asked[0]]);
    expect(a).toBe(b);
    expect(added).toBe(a.length);
    expect(a.length).toBeGreaterThan(0);
    expect(await t.loadSub(node, fetchRows)).toEqual([]);
  });

  it('selects in the lazily grown tree what it selects in the complete tree', async () => {
    const full = await complete();
    const lazy = new Octree(manifest);
    const { fetchRows } = fetcher();
    const p = {
      cameraPos: new Vector3(30, 20, 80),
      target: new Vector3(0, 0, 0),
      radius: 300,
      budget: 1e9,
      pixelsPerUnitAtUnitDistance: 800,
    };
    const want = selectNodes(full, p).map((n) => n.path).sort();
    // the app loads the sub-manifests of selected nodes and selects again
    for (let round = 0; round < 20; round++) {
      const sel = selectNodes(lazy, p);
      const open = sel.filter((n) => Octree.hasUnloaded(n));
      expect(selectionComplete(sel, p.target, p.radius)).toBe(open.length === 0 && sel.length === want.length);
      if (!open.length) break;
      await Promise.all(open.map((n) => lazy.loadSub(n, fetchRows)));
    }
    expect(selectNodes(lazy, p).map((n) => n.path).sort()).toEqual(want);
  });

  it('expands exactly the nodes a route corridor touches', async () => {
    const t = new Octree(manifest);
    const { asked, fetchRows } = fetcher();
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 200, y: 50, z: -100 };
    await t.expandWhere((n) => boxIntersectsCapsule(n.box, a, b, 20), fetchRows);
    const full = await complete();
    const inFull = [...full.nodes.values()].filter((n) => boxIntersectsCapsule(n.box, a, b, 20)).map((n) => n.path).sort();
    const inLazy = [...t.nodes.values()].filter((n) => boxIntersectsCapsule(n.box, a, b, 20)).map((n) => n.path).sort();
    expect(inLazy).toEqual(inFull);
    expect(asked.length).toBeLessThan(readdirSync(new URL('m/', dir)).length);
    expect(t.nodes.size).toBeLessThan(full.nodes.size);
  });

  it('reads version 1 manifests (no sub-manifests) as before', () => {
    const v1 = JSON.parse(readFileSync(new URL('./fixtures/data/manifest.json', import.meta.url), 'utf8')) as Manifest;
    expect(v1.version).toBe(1);
    const t = new Octree(v1);
    expect(t.nodes.size).toBe(v1.nodes.length);
    expect([...t.nodes.values()].some((n) => Octree.hasUnloaded(n))).toBe(false);
  });
});
