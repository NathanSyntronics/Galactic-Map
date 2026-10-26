import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { CROWDED, LABELLED_RADIUS, PRECISE_PX, labelledWins } from '../../src/controls/pick';
import { labelUnder, labelledStarNear, type LabelHit } from '../../src/ui/labels';

const hit = (key: string, x: number, y: number, rect: [number, number, number, number]): LabelHit => ({
  c: { key, pos: new Vector3(), text: key, rank: 0, logL: 0 },
  x,
  y,
  rect: { x: rect[0], y: rect[1], w: rect[2], h: rect[3] },
});

describe('picking by label', () => {
  // Vega's star at (100, 100), its name to the right; Altair at (300, 200), name to the left
  const hits = [hit('vega', 100, 100, [106, 92, 40, 16]), hit('altair', 300, 200, [250, 192, 44, 16])];

  it('finds the label whose text box is under the pointer', () => {
    expect(labelUnder(hits, 120, 100, 2)?.c.key).toBe('vega');
    expect(labelUnder(hits, 270, 205, 2)?.c.key).toBe('altair');
    expect(labelUnder(hits, 147, 100, 2)?.c.key).toBe('vega'); // within the padding
    expect(labelUnder(hits, 160, 100, 2)).toBeNull();
  });

  it('finds the nearest labelled star within the radius', () => {
    expect(labelledStarNear(hits, 110, 108, LABELLED_RADIUS.mouse)?.hit.c.key).toBe('vega');
    expect(labelledStarNear(hits, 130, 130, LABELLED_RADIUS.mouse)).toBeNull();
    expect(labelledStarNear(hits, 120, 115, LABELLED_RADIUS.touch)?.hit.c.key).toBe('vega');
  });

  it('lets the labelled star win unless the click is precise on another star or on a large disc', () => {
    // nothing else under the pointer
    expect(labelledWins(12, null, false)).toBe(true);
    // a faint star 3 px away, the labelled one 12 px away: crowded view, the label wins ...
    expect(labelledWins(12, { dist: 7, disc: false }, false)).toBe(true);
    // ... but a click right on another star that is clearly nearer keeps that star
    expect(labelledWins(12, { dist: PRECISE_PX.mouse - 1, disc: false }, false)).toBe(false);
    expect(labelledWins(5, { dist: 3, disc: false }, false)).toBe(true);
    // a click on the visible disc of a large star keeps it
    expect(labelledWins(10, { dist: 20, disc: true }, false)).toBe(false);
    // fingers are less precise
    expect(labelledWins(20, { dist: 5, disc: false }, true)).toBe(false);
    expect(labelledWins(20, { dist: 8, disc: false }, true)).toBe(true);
    // in a crowded view (many stars under the pointer) even a precise click picks the labelled star
    expect(labelledWins(12, { dist: 1, disc: false }, false, CROWDED + 1)).toBe(true);
    expect(labelledWins(12, { dist: 1, disc: false }, false, CROWDED)).toBe(false);
  });
});
