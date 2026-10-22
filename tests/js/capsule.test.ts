import { Box3, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  boxIntersectsCapsule,
  nodesInCapsule,
  segmentBoxDistance2,
  segmentDistance,
  segmentDistance2,
  type Aabb,
  type Vec3,
} from '../../src/network/capsule';

function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const box = (min: [number, number, number], max: [number, number, number]): Aabb => ({ min: v(...min), max: v(...max) });

/** Squared distance of a point to the box. */
function pointBox2(p: Vec3, b: Aabb): number {
  const e = (q: number, lo: number, hi: number) => (q < lo ? lo - q : q > hi ? q - hi : 0);
  return e(p.x, b.min.x, b.max.x) ** 2 + e(p.y, b.min.y, b.max.y) ** 2 + e(p.z, b.min.z, b.max.z) ** 2;
}

/** Segment–box distance by ternary search (the distance is convex along the segment). */
function bruteSegmentBox2(b: Aabb, a: Vec3, c: Vec3): number {
  const at = (t: number) => pointBox2(v(a.x + t * (c.x - a.x), a.y + t * (c.y - a.y), a.z + t * (c.z - a.z)), b);
  let lo = 0, hi = 1;
  for (let k = 0; k < 200; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (at(m1) <= at(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(at(0), at(1), at((lo + hi) / 2));
}

describe('segment distance', () => {
  const a = v(0, 0, 0), b = v(10, 0, 0);
  it('measures to the nearest point of the segment, ends included', () => {
    expect(segmentDistance(v(5, 3, 4), a, b)).toBe(5);
    expect(segmentDistance(v(-3, 4, 0), a, b)).toBe(5);
    expect(segmentDistance(v(13, 0, 4), a, b)).toBe(5);
    expect(segmentDistance2(7, 0, 0, a, b)).toBe(0);
    expect(segmentDistance2(7, 0, 0, b, a)).toBe(0);
  });

  it('treats a segment with start = end as a point', () => {
    expect(segmentDistance(v(3, 4, 0), a, a)).toBe(5);
    expect(segmentDistance2(0, 0, 0, a, a)).toBe(0);
  });
});

describe('segment and box', () => {
  const unit = box([0, 0, 0], [1, 1, 1]);

  it('is 0 when the segment passes through or ends in the box', () => {
    expect(segmentBoxDistance2(unit, v(-5, 0.5, 0.5), v(5, 0.5, 0.5))).toBe(0);
    expect(segmentBoxDistance2(unit, v(0.5, 0.5, 0.5), v(9, 9, 9))).toBe(0);
    // both ends outside, crossing a corner region diagonally
    expect(segmentBoxDistance2(unit, v(-1, 0.5, 2), v(2, 0.5, -1))).toBe(0);
  });

  it('measures parallel, diagonal and end-on approaches', () => {
    // parallel to the top face, 2 above it
    expect(segmentBoxDistance2(unit, v(-5, 3, 0.5), v(5, 3, 0.5))).toBe(4);
    // ends 3 before the face
    expect(segmentBoxDistance2(unit, v(-10, 0.5, 0.5), v(-3, 0.5, 0.5))).toBe(9);
    // passes the edge x = 1, y = 1 diagonally: nearest point (1.5, 1.5) is 0.5·√2 away
    expect(segmentBoxDistance2(unit, v(3, 0, 0.5), v(0, 3, 0.5))).toBeCloseTo(0.5, 12);
    // passes the corner (1, 1, 1): line through (2, 2, 2) perpendicular to the diagonal
    expect(segmentBoxDistance2(unit, v(4, 1, 1), v(0, 3, 3))).toBeCloseTo(3, 12);
  });

  it('treats a segment with start = end as a point', () => {
    expect(segmentBoxDistance2(unit, v(0.5, 0.5, 0.5), v(0.5, 0.5, 0.5))).toBe(0);
    expect(segmentBoxDistance2(unit, v(4, 5, 1), v(4, 5, 1))).toBe(9 + 16);
    expect(boxIntersectsCapsule(unit, v(3, 1, 1), v(3, 1, 1), 2)).toBe(true);
    expect(boxIntersectsCapsule(unit, v(3, 1, 1), v(3, 1, 1), 1.999)).toBe(false);
  });

  it('agrees with a brute-force minimum for random segments and boxes', () => {
    const r = rng(7);
    for (let k = 0; k < 3000; k++) {
      const lo: [number, number, number] = [r() * 20 - 10, r() * 20 - 10, r() * 20 - 10];
      const size = k % 5 === 0 ? 0 : r() * 8;
      const b = box(lo, [lo[0] + size, lo[1] + size * r(), lo[2] + size]);
      const a = v(r() * 40 - 20, r() * 40 - 20, r() * 40 - 20);
      // some segments axis-parallel or degenerate
      const c = k % 7 === 0 ? v(a.x, a.y, a.z) : k % 7 === 1 ? v(a.x + 30 * r() - 15, a.y, a.z) : v(r() * 40 - 20, r() * 40 - 20, r() * 40 - 20);
      const got = segmentBoxDistance2(b, a, c);
      const want = bruteSegmentBox2(b, a, c);
      expect(got).toBeLessThanOrEqual(want + 1e-9);
      expect(got).toBeGreaterThanOrEqual(want - 1e-9 * (1 + want));
      // symmetric in the ends
      expect(segmentBoxDistance2(b, c, a)).toBeCloseTo(got, 9);
    }
  });

  it('decides intersection at exactly the radius', () => {
    const a = v(-5, 3, 0.5), b = v(5, 3, 0.5);
    expect(boxIntersectsCapsule(unit, a, b, 2)).toBe(true);
    expect(boxIntersectsCapsule(unit, a, b, 1.99)).toBe(false);
  });

  it("accepts three's Box3 and Vector3", () => {
    const b = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
    expect(boxIntersectsCapsule(b, new Vector3(-5, 3, 0.5), new Vector3(5, 3, 0.5), 2)).toBe(true);
  });
});

describe('nodes in a capsule', () => {
  interface Node {
    path: string;
    box: Aabb;
    children: Node[];
  }
  /** A full octree of the given depth over the cube [-8, 8]³. */
  function tree(depth: number): { root: Node; all: Node[] } {
    const all: Node[] = [];
    const build = (path: string, c: [number, number, number], half: number, level: number): Node => {
      const node: Node = { path, box: box([c[0] - half, c[1] - half, c[2] - half], [c[0] + half, c[1] + half, c[2] + half]), children: [] };
      all.push(node);
      if (level < depth)
        for (let i = 0; i < 8; i++) {
          const h = half / 2;
          node.children.push(build(path + i, [c[0] + (i & 1 ? h : -h), c[1] + (i & 2 ? h : -h), c[2] + (i & 4 ? h : -h)], h, level + 1));
        }
      return node;
    };
    return { root: build('r', [0, 0, 0], 8, 0), all };
  }

  it('selects exactly the nodes whose box meets the capsule, parents first', () => {
    const { root, all } = tree(3);
    const r = rng(3);
    for (let k = 0; k < 40; k++) {
      const a = v(r() * 24 - 12, r() * 24 - 12, r() * 24 - 12);
      const b = k % 4 === 0 ? a : v(r() * 24 - 12, r() * 24 - 12, r() * 24 - 12);
      const radius = r() * 3;
      const got = nodesInCapsule(root, a, b, radius);
      const want = all.filter((n) => bruteSegmentBox2(n.box, a, b) <= radius * radius + 1e-9);
      expect(got.map((n) => n.path).sort()).toEqual(want.map((n) => n.path).sort());
      const index = new Map(got.map((n, i) => [n.path, i]));
      for (const n of got) if (n.path.length > 1) expect(index.get(n.path.slice(0, -1))).toBeLessThan(index.get(n.path)!);
    }
  });

  it('selects nothing when the root is outside, and one branch for a thin corridor', () => {
    const { root } = tree(2);
    expect(nodesInCapsule(root, v(20, 20, 20), v(30, 30, 30), 1)).toEqual([]);
    // a segment inside the sub-cube [0, 4]³, 1 away from all other cubes
    const got = nodesInCapsule(root, v(1, 1, 1), v(3, 3, 3), 0.5);
    expect(got.map((n) => n.path)).toEqual(['r', 'r7', 'r70']);
    // on the diagonal through (4, 4, 4) it meets all eight sub-cubes of r7
    expect(nodesInCapsule(root, v(2, 2, 2), v(6, 6, 6), 0.5).filter((n) => n.path.length === 3)).toHaveLength(8);
  });
});
