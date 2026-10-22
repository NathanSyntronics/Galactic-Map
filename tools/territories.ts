/**
 * Territories grown along the jump network from capitals (used by tools/factions.ts for the example
 * factions). Pure computation, no I/O.
 */

export interface TerritoryLinks {
  count: number;
  a: ArrayLike<number>;
  b: ArrayLike<number>;
}

export interface TerritorySeed {
  /** Place of the capital. */
  capital: number;
  /** Number of places the territory stops at. */
  size: number;
}

export interface Territories {
  /** Faction (index into the seeds) of each place, -1 for none. */
  owner: Int32Array;
  /** Places of each faction in the order they were claimed (capital first). */
  members: number[][];
}

/** Neighbour lists of the places (compressed: neighbours of p are adj[start[p]] .. adj[start[p + 1] - 1]). */
function adjacency(n: number, links: TerritoryLinks): { start: Int32Array; adj: Int32Array } {
  const start = new Int32Array(n + 1);
  for (let i = 0; i < links.count; i++) {
    start[links.a[i] + 1]++;
    start[links.b[i] + 1]++;
  }
  for (let p = 0; p < n; p++) start[p + 1] += start[p];
  const fill = start.slice(0, n);
  const adj = new Int32Array(2 * links.count);
  for (let i = 0; i < links.count; i++) {
    const a = links.a[i], b = links.b[i];
    adj[fill[a]++] = b;
    adj[fill[b]++] = a;
  }
  return { start, adj };
}

interface Claim {
  dist: number;
  faction: number;
  place: number;
}

/** Order of the claims: nearer to the own capital first, then faction and place. */
function before(x: Claim, y: Claim): boolean {
  if (x.dist !== y.dist) return x.dist < y.dist;
  if (x.faction !== y.faction) return x.faction < y.faction;
  return x.place < y.place;
}

/**
 * Multi-source growth along the jump links: every faction claims the places linked to its
 * territory, all factions together in order of the distance to the claiming faction's capital. A
 * place belongs to at most one faction, and a faction stops at its size. Each territory is
 * connected by jump links. `dist(place, faction)` is the distance of a place to a faction's capital.
 *
 * Ordering the claims by the number of jumps instead lets capitals with many long links (Vega has
 * 12) reach deep into a neighbour's region within a few jumps, which gives ragged borders.
 */
export function growTerritories(
  placeCount: number,
  links: TerritoryLinks,
  seeds: TerritorySeed[],
  dist: (place: number, faction: number) => number,
): Territories {
  const owner = new Int32Array(placeCount).fill(-1);
  const members: number[][] = seeds.map(() => []);
  const { start, adj } = adjacency(placeCount, links);

  // binary min-heap of claims
  const heap: Claim[] = [];
  const push = (c: Claim): void => {
    heap.push(c);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const pop = (): Claim => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && before(heap[l], heap[m])) m = l;
        if (r < heap.length && before(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };

  seeds.forEach((s, f) => {
    if (s.capital >= 0 && s.capital < placeCount && s.size > 0) push({ dist: 0, faction: f, place: s.capital });
  });
  while (heap.length > 0) {
    const c = pop();
    if (owner[c.place] >= 0 || members[c.faction].length >= seeds[c.faction].size) continue;
    owner[c.place] = c.faction;
    members[c.faction].push(c.place);
    if (members[c.faction].length >= seeds[c.faction].size) continue;
    for (let k = start[c.place]; k < start[c.place + 1]; k++) {
      const q = adj[k];
      if (owner[q] < 0) push({ dist: dist(q, c.faction), faction: c.faction, place: q });
    }
  }
  return { owner, members };
}

/** Fewest jumps from `from` to each place of the same faction, along links inside the territory (-1: not reached). */
export function territoryJumps(placeCount: number, links: TerritoryLinks, owner: Int32Array, from: number): Int32Array {
  const jumps = new Int32Array(placeCount).fill(-1);
  if (from < 0 || from >= placeCount) return jumps;
  const { start, adj } = adjacency(placeCount, links);
  const f = owner[from];
  jumps[from] = 0;
  const queue = [from];
  for (let h = 0; h < queue.length; h++) {
    const p = queue[h];
    for (let k = start[p]; k < start[p + 1]; k++) {
      const q = adj[k];
      if (jumps[q] >= 0 || owner[q] !== f) continue;
      jumps[q] = jumps[p] + 1;
      queue.push(q);
    }
  }
  return jumps;
}

/** Number of links between the territories of two factions (k < l at [k][l]). */
export function borderLinks(links: TerritoryLinks, owner: Int32Array, factions: number): number[][] {
  const out = Array.from({ length: factions }, () => new Array<number>(factions).fill(0));
  for (let i = 0; i < links.count; i++) {
    const f = owner[links.a[i]], g = owner[links.b[i]];
    if (f < 0 || g < 0 || f === g) continue;
    out[Math.min(f, g)][Math.max(f, g)]++;
  }
  return out;
}
