import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { RouteLine, fitDistance, routeBounds } from '../../src/render/route';

describe('route display', () => {
  it('fits a sphere into the narrower field of view', () => {
    // 55° vertical field of view, landscape: the vertical half angle decides
    const d = fitDistance(100, 55, 1.6, 1);
    expect(d * Math.sin((27.5 * Math.PI) / 180)).toBeCloseTo(100, 9);
    // portrait: the horizontal half angle (narrower) decides, so the camera goes further out
    const portrait = fitDistance(100, 55, 0.5, 1);
    const halfH = Math.atan(Math.tan((27.5 * Math.PI) / 180) * 0.5);
    expect(portrait * Math.sin(halfH)).toBeCloseTo(100, 9);
    expect(portrait).toBeGreaterThan(d);
    expect(fitDistance(100, 55, 1.6)).toBeCloseTo(1.15 * d, 9);
  });

  it('takes the centre of the bounding box and the farthest point as radius', () => {
    const b = routeBounds([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 2, z: 0 },
      { x: 4, y: -2, z: 6 },
    ])!;
    expect(b.centre.toArray()).toEqual([5, 0, 3]);
    expect(b.radius).toBeCloseTo(Math.hypot(5, 2, 3), 12);
    expect(routeBounds([])).toBeNull();
  });

  it('stores the vertices relative to an origin near the middle of the route', () => {
    const line = new RouteLine();
    const pts = [
      { x: -462.83206, y: -77.54161, z: 166.5132 },
      { x: -455.1, y: -70.2, z: 160.25 },
      { x: -0.5, y: 0.25, z: 0.125 },
    ];
    line.set(pts);
    expect(line.shown).toBe(true);
    const o = line.group.position;
    expect(o.x).toBe(Math.fround(o.x));
    expect(o.distanceTo(line.extent!.centre)).toBeLessThan(1e-3);
    const markers = line.group.children.find((c) => c.type === 'Points')!;
    const rel = (markers as unknown as { geometry: { getAttribute(n: string): { array: Float32Array } } }).geometry.getAttribute('position').array;
    for (let i = 0; i < pts.length; i++) {
      const p = new Vector3(rel[3 * i], rel[3 * i + 1], rel[3 * i + 2]).add(o);
      expect(p.distanceTo(new Vector3(pts[i].x, pts[i].y, pts[i].z))).toBeLessThan(1e-4);
    }
    // two lines (casing and line) and the markers
    expect(line.group.children).toHaveLength(3);
    line.set(null);
    expect(line.shown).toBe(false);
    expect(line.group.children).toHaveLength(1);
  });
});
