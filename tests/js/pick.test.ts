import { describe, expect, it } from 'vitest';
import { SPRITE_CORE, pickScore, type PickCandidate } from '../../src/controls/pick';
import { spritePx } from '../../src/render/starfield';

/** The winner among candidates (index), as App.pickAt chooses it. */
function pick(cands: PickCandidate[], radiusPx: number): number {
  let best = -1;
  let bestScore = Infinity;
  cands.forEach((c, k) => {
    const s = pickScore(c, radiusPx);
    if (s !== null && s < bestScore) {
      bestScore = s;
      best = k;
    }
  });
  return best;
}

describe('picking', () => {
  it('computes sprite sizes like the shader, within its limits', () => {
    expect(spritePx(0.5, 1, 1000, 100, 2.6, 64)).toBeCloseTo(10, 9);
    expect(spritePx(0.5, 12, 1000, 100, 2.6, 192)).toBeCloseTo(120, 9);
    expect(spritePx(5, 12, 1000, 10, 2.6, 192)).toBe(192);
    expect(spritePx(0.001, 1, 1000, 100, 2.6, 64)).toBe(2.6);
  });

  it('picks a large star anywhere on its solid disc, over a small star hidden under it', () => {
    // 12x: Sirius drawn 192 px wide; Luyten's Star (named, faint) 2 px from the click, 16 px from Sirius
    const sirius = { dist: 16, core: (SPRITE_CORE * 192) / 2, named: true, logL: 1.4 };
    const luyten = { dist: 2, core: 1, named: true, logL: -2 };
    expect(pick([luyten, sirius], 14)).toBe(1);
    // beyond the pick radius but on the disc
    expect(pickScore({ ...sirius, dist: 28 }, 14)).not.toBeNull();
    expect(pickScore({ ...sirius, dist: 40 }, 14)).toBeNull();
  });

  it('keeps the old rule when sprites are smaller than the pick radius', () => {
    const named = { dist: 9, core: 4, named: true, logL: 0 };
    const near = { dist: 3, core: 3, named: false, logL: -1 };
    // 9 - 4 - 0 = 5 against 3 - 0 + 1 = 4: the nearer star wins
    expect(pick([named, near], 14)).toBe(1);
    expect(pick([{ ...named, dist: 6 }, near], 14)).toBe(0);
    expect(pickScore({ ...near, dist: 15 }, 14)).toBeNull();
  });

  it('prefers the larger of two discs that both cover the point', () => {
    const a = { dist: 10, core: 30, named: true, logL: 1 };
    const b = { dist: 5, core: 20, named: true, logL: 2 };
    expect(pick([b, a], 14)).toBe(1);
  });
});
