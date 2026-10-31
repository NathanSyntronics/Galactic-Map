import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { cameraBehind, medianJump, Tour, tourStart } from '../../src/controls/tour';

const route = [new Vector3(0, 0, 0), new Vector3(5, 0, 0), new Vector3(10, 1, 0), new Vector3(18, 0, 2)];

/** Flies the tour in frames of dt seconds; returns the time it took. */
function fly(t: Tour, dt = 1 / 60): number {
  let time = 0;
  while (!t.done && time < 1000) {
    t.advance(dt);
    time += dt;
  }
  return time;
}

describe('route flyby', () => {
  it('passes through every waypoint and ends at the destination', () => {
    const t = new Tour(route, 2.5);
    for (let k = 0; k < route.length; k++) expect(t.position(k).distanceTo(route[k])).toBeLessThan(1e-9);
    fly(t);
    expect(t.done).toBe(true);
    expect(t.index).toBe(route.length - 1);
    expect(t.position(t.s).distanceTo(route[3])).toBeLessThan(1e-9);
  });

  it('takes about `step` seconds per waypoint, plus the start and the stop', () => {
    const slow = fly(new Tour(route, 2.5));
    // 3 jumps of 2.5 s, 0.3 step to speed up, 0.6 jump to brake
    expect(slow).toBeGreaterThan(7.5);
    expect(slow).toBeLessThan(7.5 + 0.3 * 2.5 + 1.2 * 2.5 + 0.1);
    const fast = fly(new Tour(route, 1));
    expect(fast).toBeLessThan(slow / 2);
  });

  it('starts and stops smoothly', () => {
    const t = new Tour(route, 2);
    t.advance(1 / 60);
    const first = t.s;
    t.advance(1 / 60);
    expect(t.s - first).toBeGreaterThan(first * 0.9);
    expect(first).toBeLessThan(0.01);
    // close to the end the steps get shorter
    while (t.s < 2.9) t.advance(1 / 60);
    const a = t.s;
    t.advance(1 / 60);
    const b = t.s;
    t.advance(1 / 60);
    expect(t.s - b).toBeLessThan(b - a);
  });

  it('can start at a waypoint and change its speed on the way', () => {
    const t = new Tour(route, 5, 2);
    expect(t.s).toBe(2);
    expect(t.index).toBe(2);
    t.step = 0.5;
    expect(fly(t)).toBeLessThan(2);
  });

  it('looks along the route from behind and a little above', () => {
    const t = new Tour([new Vector3(0, 0, 0), new Vector3(10, 0, 0), new Vector3(20, 0, 0)], 2);
    const d = t.viewDirection(1);
    expect(d.length()).toBeCloseTo(1, 9);
    expect(d.x).toBeLessThan(-0.9);
    expect(d.y).toBeGreaterThan(0.3);
    expect(Math.abs(d.z)).toBeLessThan(1e-9);
    // a route straight up: not quite vertical (the orbit controls turn about the up axis)
    const up = cameraBehind(new Vector3(0, 1, 0));
    expect(up.length()).toBeCloseTo(1, 9);
    expect(Math.abs(up.y)).toBeLessThanOrEqual(0.97 + 1e-12);
    const cam = new PerspectiveCamera();
    cam.position.copy(up);
    expect(Number.isFinite(cam.position.x)).toBe(true);
  });

  it('continues from the waypoint the view is at, else starts at the start', () => {
    expect(tourStart(route, new Vector3(10.5, 1, 0), 15, 5)).toBe(2);
    // zoomed out over the whole route
    expect(tourStart(route, new Vector3(10.5, 1, 0), 400, 5)).toBe(0);
    // far from the route
    expect(tourStart(route, new Vector3(50, 0, 0), 15, 5)).toBe(0);
    // at the destination: from the start again
    expect(tourStart(route, new Vector3(18, 0, 2), 15, 5)).toBe(0);
  });

  it('measures a typical jump by the median', () => {
    expect(medianJump([0, 5, 7, 6])).toBe(6);
    expect(medianJump([0, 4, 8])).toBe(6);
    expect(medianJump([0])).toBe(0);
  });

  it('a route of one waypoint is over at once', () => {
    expect(new Tour([new Vector3(1, 2, 3)], 2).done).toBe(true);
  });
});
