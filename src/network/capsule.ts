/**
 * Capsules: all points within a distance of a line segment, the corridor of a route
 * (docs/ROUTES.md). Pure geometry; three's Vector3 and Box3 fit the plain types.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box. */
export interface Aabb {
  min: Vec3;
  max: Vec3;
}

/** Squared distance of the point (x, y, z) to the segment a–b (the point a when a = b). */
export function segmentDistance2(x: number, y: number, z: number, a: Vec3, b: Vec3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const px = x - a.x, py = y - a.y, pz = z - a.z;
  const dd = dx * dx + dy * dy + dz * dz;
  let t = dd > 0 ? (px * dx + py * dy + pz * dz) / dd : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
  return ex * ex + ey * ey + ez * ez;
}

/** Distance of p to the segment a–b. */
export function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  return Math.sqrt(segmentDistance2(p.x, p.y, p.z, a, b));
}

/** Squared distance of a point (as an array) to the box (0 inside). */
function pointBoxDistance2(p: number[], lo: number[], hi: number[]): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const e = p[i] < lo[i] ? lo[i] - p[i] : p[i] > hi[i] ? p[i] - hi[i] : 0;
    s += e * e;
  }
  return s;
}

/**
 * Squared distance between the segment a–b and the box (0 when they touch). Along the segment
 * (a + t (b − a), t in 0..1) the squared distance to the box is convex and piecewise quadratic,
 * with pieces between the points where the segment crosses a face plane; each piece is minimised
 * exactly.
 */
export function segmentBoxDistance2(box: Aabb, a: Vec3, b: Vec3): number {
  const a0 = [a.x, a.y, a.z];
  const d = [b.x - a.x, b.y - a.y, b.z - a.z];
  const lo = [box.min.x, box.min.y, box.min.z];
  const hi = [box.max.x, box.max.y, box.max.z];
  const at = (t: number): number[] => [a0[0] + t * d[0], a0[1] + t * d[1], a0[2] + t * d[2]];
  const ts = [0, 1];
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) continue;
    for (const bound of [lo[i], hi[i]]) {
      const t = (bound - a0[i]) / d[i];
      if (t > 0 && t < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  let best = Infinity;
  for (const t of ts) best = Math.min(best, pointBoxDistance2(at(t), lo, hi));
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k], t1 = ts[k + 1];
    if (!(t1 > t0)) continue;
    // on this piece every axis is below, inside or above its slab: sum of (c + t d)²
    const mid = at((t0 + t1) / 2);
    let qa = 0, qb = 0;
    for (let i = 0; i < 3; i++) {
      const c = mid[i] < lo[i] ? a0[i] - lo[i] : mid[i] > hi[i] ? a0[i] - hi[i] : null;
      if (c === null) continue;
      qa += d[i] * d[i];
      qb += c * d[i];
    }
    if (!(qa > 0)) continue;
    const t = Math.min(Math.max(-qb / qa, t0), t1);
    best = Math.min(best, pointBoxDistance2(at(t), lo, hi));
  }
  return best;
}

/** Whether the box and the capsule (all points within r of the segment a–b) have a point in common. */
export function boxIntersectsCapsule(box: Aabb, a: Vec3, b: Vec3, r: number): boolean {
  return segmentBoxDistance2(box, a, b) <= r * r;
}

/**
 * Nodes of a tree of boxes (children inside their parent, like the octree) that intersect the
 * capsule, parents before their children.
 */
export function nodesInCapsule<T extends { box: Aabb; children: readonly T[] }>(root: T, a: Vec3, b: Vec3, r: number): T[] {
  const out: T[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!boxIntersectsCapsule(node.box, a, b, r)) continue;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
}
