import { describe, expect, it } from 'vitest';
import { twoFingerMode } from '../../src/controls/navigation';

describe('two-finger gestures', () => {
  it('waits until the fingers have moved a few pixels', () => {
    expect(twoFingerMode(200, 205, 3)).toBe('undecided');
  });

  it('zooms only on a pinch, also one with a moving midpoint (one finger still)', () => {
    expect(twoFingerMode(200, 240, 2)).toBe('zoom');
    expect(twoFingerMode(200, 160, 0)).toBe('zoom');
    // one finger moves 20 px away from the other: the distance grows by 20, the midpoint by 10
    expect(twoFingerMode(200, 220, 10)).toBe('zoom');
  });

  it('pans when both fingers move together', () => {
    expect(twoFingerMode(200, 203, 30)).toBe('pan');
    expect(twoFingerMode(200, 200, 12)).toBe('pan');
  });
});
