/** Choosing the star under the pointer. */

/**
 * Fraction of a sprite's half-size that looks solid (the bright core and the inner glow, which
 * saturates for bright stars): a click there picks the star, however far from its centre.
 */
export const SPRITE_CORE = 0.35;

export interface PickCandidate {
  /** Distance of the pointer from the star's centre (CSS px). */
  dist: number;
  /** Radius of the star's solid-looking disc (CSS px): SPRITE_CORE times half the sprite size. */
  core: number;
  named: boolean;
  logL: number;
}

/**
 * Score of a star near the pointer (lower wins), or null when the pointer misses it. A star is hit
 * within the pick radius or within its solid disc. A point on the disc of a sprite larger than the
 * pick radius belongs to that star (the largest disc first): small stars under it cannot be seen.
 * Otherwise named and brighter stars win among those near the pointer.
 */
export function pickScore(c: PickCandidate, radiusPx: number): number | null {
  if (c.dist > Math.max(radiusPx, c.core)) return null;
  if (c.core > radiusPx && c.dist <= c.core) return -1e6 - c.core;
  return c.dist - (c.named ? 4 : 0) - c.logL;
}

/** Labelled stars win within this radius of the pointer (CSS px), wider for fingers. */
export const LABELLED_RADIUS = { mouse: 18, touch: 30 };
/** A click this close to another star's centre (CSS px) still picks that star, where it is not crowded. */
export const PRECISE_PX = { mouse: 4, touch: 6 };
/** More stars than this within the pick radius make a view crowded. */
export const CROWDED = 3;

/**
 * Whether the nearest labelled star wins over the star the usual rules chose. In crowded views
 * the labelled star is what a user aims at, even if faint stars lie closer to the pointer. The
 * usual choice stays when it is a hit on a large star's visible disc, or, where the view is not
 * crowded (`nearby` stars within the pick radius), a precise click right on another star that is
 * clearly nearer than the labelled one.
 */
export function labelledWins(
  labelledDist: number,
  usual: { dist: number; disc: boolean } | null,
  touch: boolean,
  nearby = 1,
): boolean {
  if (!usual) return true;
  if (usual.disc) return false;
  if (nearby > CROWDED) return true;
  const precise = PRECISE_PX[touch ? 'touch' : 'mouse'];
  return !(usual.dist <= precise && usual.dist < 0.5 * labelledDist);
}
