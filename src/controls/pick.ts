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
