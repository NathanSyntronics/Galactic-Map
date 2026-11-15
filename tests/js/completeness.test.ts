import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { Octree, estimatedMinImp, selectNodes, type Manifest, type NodeRow, type OctreeNode, type SubManifest } from '../../src/data/octree';
import { Flag, UNKNOWN_I16, type NodeData } from '../../src/data/format';
import { NO_CUT, completenessCut, importanceOf } from '../../src/render/starfield';
import { EXPOSURE_TARGET, crowdFactor, exposureFor, minStarAlpha, toneCurve } from '../../src/render/star-buffer';

const dir = new URL('./fixtures/sub/', import.meta.url);
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as T;

async function tree(): Promise<Octree> {
  const t = new Octree(read<Manifest>('manifest.json'));
  await t.expandWhere(() => true, async (file: string): Promise<NodeRow[]> => read<SubManifest>(file).nodes);
  return t;
}

describe('completeness cut', () => {
  it('takes the importance the octree orders by', () => {
    const d = { flags: new Uint16Array([Flag.SUN, 0, 0, 0]), logL: new Int16Array([0, 1500, UNKNOWN_I16, UNKNOWN_I16]), absMag: new Int16Array([0, 0, 474, UNKNOWN_I16]) } as unknown as NodeData;
    expect(importanceOf(d, 0)).toBe(99);
    expect(importanceOf(d, 1)).toBe(1.5);
    expect(importanceOf(d, 2)).toBeCloseTo(0, 12);
    expect(importanceOf(d, 3)).toBe(-3);
  });

  it('is set by the drawn nodes whose children are not all drawn, as seen from the camera', async () => {
    const t = await tree();
    const root = t.root;
    const target = root.worldCenter.clone();
    const radius = root.halfSize * 4;
    const cam = target.clone().add(new Vector3(0, 0, 2.2 * radius));
    const inSphere = (n: OctreeNode) => n.box.distanceToPoint(target) <= radius;
    const nearest = cam.distanceTo(target) - radius;
    // only the root drawn: its faintest star at the nearest point of the sphere
    const cut0 = completenessCut([{ node: root, minImp: 1 }], (p) => p === root.path, inSphere, cam, nearest);
    expect(cut0).toBeCloseTo(1 - 2 * Math.log10(Math.max(root.box.distanceToPoint(cam), nearest)), 9);
    // every node drawn: complete
    const all = [...t.nodes.values()].map((node) => ({ node, minImp: 0 }));
    expect(completenessCut(all, () => true, inSphere, cam, nearest)).toBe(NO_CUT);
    // the root and its children drawn, the grandchildren not: the children limit it
    const level1 = [{ node: root, minImp: 2 }, ...root.children.map((node, k) => ({ node, minImp: 1 - 0.1 * k }))];
    const drawn = new Set(level1.map((x) => x.node.path));
    const cut1 = completenessCut(level1, (p) => drawn.has(p), inSphere, cam, nearest);
    const open = root.children.filter((c) => c.children.length > 0);
    const want = Math.max(...open.map((c) => 1 - 0.1 * root.children.indexOf(c) - 2 * Math.log10(Math.max(c.box.distanceToPoint(cam), nearest))));
    expect(cut1).toBeCloseTo(want, 9);
  });

  it('does not count nodes whose children are on their way (zooming out)', async () => {
    const t = await tree();
    const root = t.root;
    const target = root.worldCenter.clone();
    const radius = root.halfSize * 4;
    const cam = target.clone().add(new Vector3(0, 0, 2.2 * radius));
    const inSphere = (n: OctreeNode) => n.box.distanceToPoint(target) <= radius;
    const nearest = cam.distanceTo(target) - radius;
    // only the root drawn, its children chosen and loading: the view is not cut
    const coming = new Set([root.path, ...root.children.map((c) => c.path)]);
    expect(completenessCut([{ node: root, minImp: 1 }], (p) => coming.has(p), inSphere, cam, nearest)).toBe(NO_CUT);
    // a node whose descendants' list is still loading counts only when it is not being refined
    const fresh = new Octree(read<Manifest>('manifest.json'));
    const withSub = [...fresh.nodes.values()].find((n) => n.sub !== null && n.childMask !== 0 && n.children.length === 0)!;
    expect(withSub).toBeDefined();
    const one = [{ node: withSub, minImp: 0 }];
    const all = () => true;
    expect(completenessCut(one, () => true, all, cam, 1)).toBeGreaterThan(NO_CUT);
    expect(completenessCut(one, () => true, all, cam, 1, () => true)).toBe(NO_CUT);
  });

  it('refines in the order of the cut when the faintest stars are known', async () => {
    const t = await tree();
    const root = t.root;
    const target = root.worldCenter.clone();
    const radius = root.halfSize * 2;
    const cam = target.clone().add(new Vector3(0, 0, 2.2 * radius));
    // a node whose faintest star is very bright limits the view most: its children come first (the
    // nearest first), before those of nodes whose faintest stars are faint
    const bright = root.children[root.children.length - 1];
    const brightChildren = bright.children
      .filter((c) => c.box.distanceToPoint(target) <= radius)
      .sort((x, y) => x.box.distanceToPoint(cam) - y.box.distanceToPoint(cam));
    expect(brightChildren.length).toBeGreaterThan(1);
    const budget = root.count + root.children.reduce((s, c) => s + c.count, 0) + brightChildren[0].count + brightChildren[1].count;
    const base = { cameraPos: cam, target, radius, budget, pixelsPerUnitAtUnitDistance: 1000 };
    const sel = selectNodes(t, { ...base, minImpOf: (n) => (n === root ? 5 : n === bright ? 4 : -2) });
    expect(sel).toContain(brightChildren[0]);
    expect(sel).toContain(brightChildren[1]);
    expect(sel.filter((n) => n.level === 2).every((n) => n.parent === bright)).toBe(true);
    // unknown nodes are estimated by their size
    expect(estimatedMinImp({ halfSize: 256 } as OctreeNode)).toBeCloseTo(0.54, 1);
    expect(estimatedMinImp({ halfSize: 128 } as OctreeNode)).toBeCloseTo(-0.96, 1);
  });
});

describe('star light', () => {
  it('passes light up to the shoulder and compresses more towards 1', () => {
    expect(toneCurve(0.3)).toBe(0.3);
    expect(toneCurve(0.6)).toBe(0.6);
    expect(toneCurve(1)).toBeGreaterThan(0.6);
    expect(toneCurve(1)).toBeLessThan(toneCurve(5));
    expect(toneCurve(50)).toBeLessThanOrEqual(1);
  });

  it('lowers the exposure only for crowded views', () => {
    expect(exposureFor(0.2)).toBe(1);
    expect(exposureFor(EXPOSURE_TARGET)).toBe(1);
    expect(exposureFor(1)).toBeCloseTo(EXPOSURE_TARGET, 12);
    expect(exposureFor(1000)).toBe(0.04);
  });

  it('dims the faint stars of crowded views, more where the light is not clipped', () => {
    expect(minStarAlpha(1000, false)).toBe(0.55);
    expect(minStarAlpha(2_000_000, false)).toBe(0.035);
    expect(minStarAlpha(2_000_000, true)).toBeCloseTo(0.55 * Math.sqrt(2500 / 2_000_000), 12);
    expect(crowdFactor(50_000, true)).toBe(1);
    expect(crowdFactor(2_000_000, false)).toBe(1);
    expect(crowdFactor(2_000_000, true)).toBeCloseTo(0.05 ** 0.6, 12);
  });
});
