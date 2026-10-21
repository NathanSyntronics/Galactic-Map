import { describe, expect, it } from 'vitest';
import { TapDetector } from '../../src/controls/tap';

describe('TapDetector', () => {
  it('accepts a short, still single-pointer press', () => {
    const t = new TapDetector(6, 600);
    t.down(1, 100, 100, 0);
    expect(t.up(1, 102, 101, 150)).toBe(true);
  });

  it('rejects drags and long presses', () => {
    const t = new TapDetector(6, 600);
    t.down(1, 100, 100, 0);
    expect(t.up(1, 120, 100, 150)).toBe(false);
    t.down(1, 100, 100, 1000);
    expect(t.up(1, 100, 100, 1700)).toBe(false);
  });

  it('never counts a pinch as a tap, whichever finger is lifted last', () => {
    // the reviewer's sequence: finger 2 nearly still, whole gesture ~200 ms
    const t = new TapDetector(6, 600);
    t.down(10, 150, 300, 0, true);
    t.down(11, 250, 500, 30, false);
    expect(t.up(10, 90, 200, 130)).toBe(false);
    expect(t.up(11, 251, 501, 190)).toBe(false);
    // a two-finger tap
    t.down(20, 150, 300, 1000, true);
    t.down(21, 250, 500, 1010, false);
    expect(t.up(21, 250, 500, 1080)).toBe(false);
    expect(t.up(20, 150, 300, 1090)).toBe(false);
  });

  it('accepts a new single tap after a multi-touch gesture has ended', () => {
    const t = new TapDetector();
    t.down(1, 0, 0, 0, true);
    t.down(2, 50, 50, 10, false);
    t.up(1, 0, 0, 50);
    t.up(2, 50, 50, 60);
    t.down(3, 10, 10, 200, true);
    expect(t.up(3, 10, 10, 250)).toBe(true);
  });

  it('does not count a finger that stays down after the other one lifted', () => {
    const t = new TapDetector();
    t.down(1, 0, 0, 0, true);
    t.down(2, 50, 50, 10, false);
    expect(t.up(1, 0, 0, 50)).toBe(false);
    // finger 2 is still part of the pinch gesture
    expect(t.up(2, 50, 50, 100)).toBe(false);
  });

  it('treats a cancelled pointer as no tap and recovers from lost pointer-ups', () => {
    const t = new TapDetector();
    t.down(1, 0, 0, 0, true);
    t.cancel(1);
    expect(t.up(1, 0, 0, 50)).toBe(false);
    // pointer 5's "up" was never delivered; a new primary pointer starts a fresh gesture
    t.down(5, 0, 0, 100, true);
    t.down(6, 0, 0, 1000, true);
    expect(t.up(6, 0, 0, 1050)).toBe(true);
    expect(t.activePointers).toBe(0);
  });
});
