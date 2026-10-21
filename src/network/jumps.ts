/**
 * Jump network: links between places (single stars or multiple systems) that are at most a jump
 * range apart. Pure computation as specified in docs/JUMP_NETWORK.md; no three.js, no DOM.
 */

/** Why a link exists. */
export const LinkKind = {
  /** Step 1: both places had free capacity. */
  CAPACITY: 0,
  /** Step 2: a place without any link gets one to its nearest candidate. */
  ALONE: 1,
  /** Step 3: joins two components (Kruskal). */
  CONNECT: 2,
} as const;
export type LinkKind = (typeof LinkKind)[keyof typeof LinkKind];

/** log10 L/Lsun at and below which a place gets the faint capacity. */
export const FAINT_LOGL = -4.5;
/** log10 L/Lsun at and above which a place gets the bright capacity. */
export const BRIGHT_LOGL = 1.5;

/** Capacity by luminosity: faint at log L <= -4.5, sun at 0, bright at >= 1.5, linear between. */
export function capacityFromLogL(logL: number, faint: number, sun: number, bright: number): number {
  let k: number;
  if (!(logL > FAINT_LOGL)) k = faint;
  else if (logL < 0) k = faint + ((sun - faint) * (logL - FAINT_LOGL)) / -FAINT_LOGL;
  else if (logL < BRIGHT_LOGL) k = sun + ((bright - sun) * logL) / BRIGHT_LOGL;
  else k = bright;
  return Math.max(0, Math.round(k));
}

/** Capacity by attribute: t (0..1) is the value's position on the attribute's scale. */
export function capacityFromPosition(t: number, faint: number, bright: number): number {
  const u = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0;
  return Math.max(0, Math.round(faint + u * (bright - faint)));
}

export interface JumpPlaces {
  count: number;
  /** x, y, z per place in light years; places with a non-finite coordinate take no part. */
  positions: ArrayLike<number>;
  /** Wanted number of capacity links per place (integers >= 0). */
  capacities: ArrayLike<number>;
  /** Optional tie-break key per place, compared after the coordinates (for coincident places). */
  keys?: ArrayLike<number>;
}

export interface JumpParams {
  /** Jump range in light years; pairs at most this far apart are candidates. */
  range: number;
  /** Hub preference h (0 = pure distance). */
  hub: number;
  /** Capacity of the Sun (jumpSun); at least 1 is used. */
  kSun: number;
  /** Step 3: connect everything the range connects. */
  connect: boolean;
  /** Give up (overflow) when there are more candidate pairs than this. */
  maxCandidates?: number;
}

export interface JumpLinks {
  count: number;
  /** Place indices of the two ends, a < b. */
  a: Uint32Array;
  b: Uint32Array;
  length: Float32Array;
  kind: Uint8Array;
  /** Number of candidate pairs. */
  candidates: number;
  /** True when maxCandidates was exceeded; there are no links then. */
  overflow: boolean;
}

function emptyLinks(candidates: number, overflow: boolean): JumpLinks {
  return {
    count: 0,
    a: new Uint32Array(0),
    b: new Uint32Array(0),
    length: new Float32Array(0),
    kind: new Uint8Array(0),
    candidates,
    overflow,
  };
}

// ------------------------------------------------------------------ candidates

/** Places ordered by grid cell; internal index u is the position in this order. */
interface Grid {
  /** Place index of u. */
  place: Uint32Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

/** Candidate pairs u < v (grid order). */
interface Candidates {
  count: number;
  u: Uint32Array;
  v: Uint32Array;
}

/** Cell budget of the grid; a larger box gets bigger cells. */
const CELLS_PER_PLACE = 4;
const MIN_CELLS = 1 << 16;

/**
 * All pairs at most `range` apart via a uniform grid (cell size = range, larger only for very
 * sparse boxes). Places are sorted by cell, so the 3 neighbour cells of a row are one contiguous
 * run and every pair of cells is visited once (half stencil). Null when more than `max` pairs.
 */
function findCandidates(pos: ArrayLike<number>, n: number, range: number, max: number): { grid: Grid; cand: Candidates } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    valid++;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const grid: Grid = {
    place: new Uint32Array(valid),
    x: new Float64Array(valid),
    y: new Float64Array(valid),
    z: new Float64Array(valid),
  };
  const empty: Candidates = { count: 0, u: new Uint32Array(0), v: new Uint32Array(0) };
  if (valid < 2 || !(range > 0) || !Number.isFinite(range)) return { grid, cand: empty };

  // slightly larger than the range, so rounding never puts a pair two cells apart
  let s = range * (1 + 1e-9);
  const limit = Math.max(MIN_CELLS, CELLS_PER_PLACE * valid);
  let nx: number, ny: number, nz: number;
  for (;;) {
    nx = Math.floor((maxX - minX) / s) + 1;
    ny = Math.floor((maxY - minY) / s) + 1;
    nz = Math.floor((maxZ - minZ) / s) + 1;
    if (nx * ny * nz <= limit) break;
    s *= 1.25;
  }
  const cells = nx * ny * nz;

  // counting sort of the places by cell
  const cellOf = new Int32Array(n).fill(-1);
  const start = new Int32Array(cells + 1);
  for (let i = 0; i < n; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const ix = Math.min(nx - 1, Math.floor((x - minX) / s));
    const iy = Math.min(ny - 1, Math.floor((y - minY) / s));
    const iz = Math.min(nz - 1, Math.floor((z - minZ) / s));
    const c = ix + nx * (iy + ny * iz);
    cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  const { place, x: sx, y: sy, z: sz } = grid;
  for (let i = 0; i < n; i++) {
    const c = cellOf[i];
    if (c < 0) continue;
    const u = fill[c]++;
    place[u] = i;
    sx[u] = pos[3 * i];
    sy[u] = pos[3 * i + 1];
    sz[u] = pos[3 * i + 2];
  }

  let size = Math.min(Math.max(valid * 12, 1024), max + 1);
  let cu = new Uint32Array(size);
  let cv = new Uint32Array(size);
  let m = 0;
  const r2 = range * range;
  // runs of partner places: [0] the own row from u + 1, then up to 4 rows ahead
  const lo = new Int32Array(5);
  const hi = new Int32Array(5);
  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      const row = nx * (iy + ny * iz);
      for (let ix = 0; ix < nx; ix++) {
        const c = row + ix;
        const s0 = start[c], e0 = start[c + 1];
        if (s0 === e0) continue;
        const xlo = ix > 0 ? ix - 1 : 0;
        const xhi = ix + 1 < nx ? ix + 2 : ix + 1;
        hi[0] = start[row + xhi];
        let runs = 1;
        if (iy + 1 < ny) {
          const r = row + nx;
          lo[runs] = start[r + xlo];
          hi[runs++] = start[r + xhi];
        }
        if (iz + 1 < nz) {
          for (let jy = iy > 0 ? iy - 1 : 0, ey = iy + 1 < ny ? iy + 1 : iy; jy <= ey; jy++) {
            const r = nx * (jy + ny * (iz + 1));
            lo[runs] = start[r + xlo];
            hi[runs++] = start[r + xhi];
          }
        }
        for (let u = s0; u < e0; u++) {
          const x = sx[u], y = sy[u], z = sz[u];
          lo[0] = u + 1;
          for (let k = 0; k < runs; k++) {
            for (let v = lo[k], e = hi[k]; v < e; v++) {
              const dx = x - sx[v], dy = y - sy[v], dz = z - sz[v];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > r2) continue;
              if (m === size) {
                if (m > max) return null;
                size = Math.min(size * 2, max + 1);
                const nu = new Uint32Array(size), nv = new Uint32Array(size);
                nu.set(cu);
                nv.set(cv);
                cu = nu;
                cv = nv;
              }
              cu[m] = u;
              cv[m] = v;
              m++;
            }
          }
        }
      }
    }
  }
  if (m > max) return null;
  return { grid, cand: { count: m, u: cu, v: cv } };
}

// ------------------------------------------------------------------ sorting

/**
 * Sorts the pairs (u[i], v[i]) by a float32 key (>= 0, given as its bits), then sorts runs of
 * equal keys with the exact comparator. Rounding to float32 keeps the order, so the result is
 * the exact order of `cmp`.
 */
function sortPairs(
  key: Uint32Array,
  u: Uint32Array,
  v: Uint32Array,
  cmp: (u1: number, v1: number, u2: number, v2: number) => number,
): void {
  const n = key.length;
  if (n < 2) return;
  // LSD radix sort, two passes of 16 bits; non-negative floats sort like their bit patterns
  const lo = new Uint32Array(65536);
  const hi = new Uint32Array(65536);
  for (let i = 0; i < n; i++) {
    const k = key[i];
    lo[k & 0xffff]++;
    hi[k >>> 16]++;
  }
  let sl = 0, sh = 0;
  for (let b = 0; b < 65536; b++) {
    const cl = lo[b], ch = hi[b];
    lo[b] = sl;
    hi[b] = sh;
    sl += cl;
    sh += ch;
  }
  const k2 = new Uint32Array(n);
  const u2 = new Uint32Array(n);
  const v2 = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = key[i];
    const p = lo[k & 0xffff]++;
    k2[p] = k;
    u2[p] = u[i];
    v2[p] = v[i];
  }
  for (let i = 0; i < n; i++) {
    const k = k2[i];
    const p = hi[k >>> 16]++;
    key[p] = k;
    u[p] = u2[i];
    v[p] = v2[i];
  }
  // exact order within runs of equal keys
  let s = 0;
  while (s < n) {
    let e = s + 1;
    while (e < n && key[e] === key[s]) e++;
    if (e - s <= 16) {
      // insertion sort in place; most runs are two pairs
      for (let i = s + 1; i < e; i++) {
        const pu = u[i], pv = v[i];
        let j = i - 1;
        while (j >= s && cmp(u[j], v[j], pu, pv) > 0) {
          u[j + 1] = u[j];
          v[j + 1] = v[j];
          j--;
        }
        u[j + 1] = pu;
        v[j + 1] = pv;
      }
    } else {
      const run: number[] = [];
      for (let i = s; i < e; i++) run.push(i);
      run.sort((i, j) => cmp(u[i], v[i], u[j], v[j]));
      const ru = run.map((i) => u[i]);
      const rv = run.map((i) => v[i]);
      u.set(ru, s);
      v.set(rv, s);
    }
    s = e;
  }
}

// ------------------------------------------------------------------ union-find

function find(parent: Int32Array, i: number): number {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

/** Joins the components of a and b; false if they were one already. */
function union(parent: Int32Array, size: Int32Array, a: number, b: number): boolean {
  let ra = find(parent, a);
  let rb = find(parent, b);
  if (ra === rb) return false;
  if (size[ra] < size[rb]) [ra, rb] = [rb, ra];
  parent[rb] = ra;
  size[ra] += size[rb];
  return true;
}

// ------------------------------------------------------------------ network

/**
 * Links of the jump network (docs/JUMP_NETWORK.md, "Which links"). The time grows with the
 * number of candidate pairs, about 0.2 µs each (150k places at 10 ly: 1.2M pairs, ~0.25 s).
 */
export function computeJumpLinks(places: JumpPlaces, params: JumpParams): JumpLinks {
  const found = findCandidates(places.positions, places.count, params.range, params.maxCandidates ?? Infinity);
  if (!found) return emptyLinks(0, true);
  const { grid, cand } = found;
  const m = cand.count;
  if (m === 0) return emptyLinks(0, false);
  const { place, x: px, y: py, z: pz } = grid;
  const n = place.length;
  const cu = cand.u, cv = cand.v;
  const keys = places.keys;

  // same arithmetic as the candidate search, so equal pairs give equal distances
  const dist = (u: number, v: number): number => {
    const dx = px[u] - px[v], dy = py[u] - py[v], dz = pz[u] - pz[v];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  // stable order of places (coordinates, then key) and of pairs, for ties
  const placeCmp = (p: number, q: number): number => {
    if (p === q) return 0;
    if (px[p] !== px[q]) return px[p] < px[q] ? -1 : 1;
    if (py[p] !== py[q]) return py[p] < py[q] ? -1 : 1;
    if (pz[p] !== pz[q]) return pz[p] < pz[q] ? -1 : 1;
    if (keys) {
      const u = keys[place[p]], v = keys[place[q]];
      if (u !== v) return u < v ? -1 : 1;
    }
    return 0;
  };
  const pairCmp = (u1: number, v1: number, u2: number, v2: number): number => {
    if (placeCmp(u1, v1) > 0) [u1, v1] = [v1, u1];
    if (placeCmp(u2, v2) > 0) [u2, v2] = [v2, u2];
    return placeCmp(u1, u2) || placeCmp(v1, v2);
  };

  const cap = new Int32Array(n);
  let capSum = 0;
  for (let u = 0; u < n; u++) {
    const k = Math.max(0, Math.round(places.capacities[place[u]]) || 0);
    cap[u] = k;
    capSum += k;
  }
  const maxLinks = Math.floor(capSum / 2) + 2 * n;
  const la = new Uint32Array(maxLinks);
  const lb = new Uint32Array(maxLinks);
  const lk = new Uint8Array(maxLinks);
  let count = 0;
  const deg = new Int32Array(n);

  // scratch for the sorts: float32 keys and the pairs
  const keyF = new Float32Array(m);
  const keyBits = new Uint32Array(keyF.buffer);
  const su = new Uint32Array(m);
  const sv = new Uint32Array(m);

  // 1. capacity links by cost d * (kSun² / (ka kb))^h = d * w[a] * w[b]
  const kSun = Number.isFinite(params.kSun) ? Math.max(1, params.kSun) : 1;
  const h = Number.isFinite(params.hub) ? Math.max(0, params.hub) : 0;
  const w = new Float64Array(n);
  for (let u = 0; u < n; u++) w[u] = cap[u] > 0 ? Math.pow(kSun / cap[u], h) : 0;
  let e = 0;
  for (let j = 0; j < m; j++) {
    const u = cu[j], v = cv[j];
    const ww = w[u] * w[v];
    if (ww === 0) continue;
    keyF[e] = dist(u, v) * ww;
    su[e] = u;
    sv[e++] = v;
  }
  if (e > 0) {
    const ku = su.subarray(0, e), kv = sv.subarray(0, e);
    sortPairs(keyBits.subarray(0, e), ku, kv, (u1, v1, u2, v2) => {
      const d1 = dist(u1, v1), d2 = dist(u2, v2);
      const c1 = d1 * (w[u1] * w[v1]), c2 = d2 * (w[u2] * w[v2]);
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (d1 !== d2) return d1 < d2 ? -1 : 1;
      return pairCmp(u1, v1, u2, v2);
    });
    const free = cap.slice();
    for (let i = 0; i < e; i++) {
      const u = ku[i], v = kv[i];
      if (free[u] > 0 && free[v] > 0) {
        free[u]--;
        free[v]--;
        la[count] = u;
        lb[count] = v;
        lk[count++] = LinkKind.CAPACITY;
      }
    }
  }
  for (let i = 0; i < count; i++) {
    deg[la[i]]++;
    deg[lb[i]]++;
  }

  // 2. nobody alone: every place without a link takes its nearest candidate (all at once)
  const best = new Int32Array(n).fill(-1);
  const bestD = new Float64Array(n).fill(Infinity);
  const offer = (p: number, q: number, d: number): void => {
    if (d < bestD[p] || (d === bestD[p] && placeCmp(q, best[p]) < 0)) {
      best[p] = q;
      bestD[p] = d;
    }
  };
  for (let j = 0; j < m; j++) {
    const u = cu[j], v = cv[j];
    if (deg[u] !== 0 && deg[v] !== 0) continue;
    const d = dist(u, v);
    if (deg[u] === 0) offer(u, v, d);
    if (deg[v] === 0) offer(v, u, d);
  }
  for (let p = 0; p < n; p++) {
    const q = best[p];
    if (deg[p] !== 0 || q < 0) continue;
    if (deg[q] === 0 && best[q] === p && q < p) continue; // mutual, added from q
    la[count] = p;
    lb[count] = q;
    lk[count++] = LinkKind.ALONE;
  }

  // 3. connect components with the shortest remaining candidates (Kruskal)
  if (params.connect) {
    const parent = new Int32Array(n);
    const size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) parent[i] = i;
    let parts = n;
    for (let i = 0; i < count; i++) if (union(parent, size, la[i], lb[i])) parts--;
    e = 0;
    if (parts > 1) {
      const comp = new Int32Array(n);
      for (let u = 0; u < n; u++) comp[u] = find(parent, u);
      for (let j = 0; j < m; j++) {
        const u = cu[j], v = cv[j];
        if (comp[u] === comp[v]) continue;
        keyF[e] = dist(u, v);
        su[e] = u;
        sv[e++] = v;
      }
    }
    if (e > 0) {
      const ku = su.subarray(0, e), kv = sv.subarray(0, e);
      sortPairs(keyBits.subarray(0, e), ku, kv, (u1, v1, u2, v2) => {
        const d1 = dist(u1, v1), d2 = dist(u2, v2);
        return d1 !== d2 ? (d1 < d2 ? -1 : 1) : pairCmp(u1, v1, u2, v2);
      });
      for (let i = 0; i < e && parts > 1; i++) {
        const u = ku[i], v = kv[i];
        if (!union(parent, size, u, v)) continue;
        parts--;
        la[count] = u;
        lb[count] = v;
        lk[count++] = LinkKind.CONNECT;
      }
    }
  }

  // back to place indices, a < b
  const a = new Uint32Array(count);
  const b = new Uint32Array(count);
  const length = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const p = place[la[i]], q = place[lb[i]];
    a[i] = p < q ? p : q;
    b[i] = p < q ? q : p;
    length[i] = dist(la[i], lb[i]);
  }
  return { count, a, b, length, kind: lk.slice(0, count), candidates: m, overflow: false };
}

// ------------------------------------------------------------------ queries

/** Number of links per place; only links of `kind` if given. */
export function linkDegrees(links: JumpLinks, placeCount: number, kind?: LinkKind): Uint32Array {
  const deg = new Uint32Array(placeCount);
  for (let i = 0; i < links.count; i++) {
    if (kind !== undefined && links.kind[i] !== kind) continue;
    deg[links.a[i]]++;
    deg[links.b[i]]++;
  }
  return deg;
}

export interface PlaceLink {
  /** Index into the link arrays. */
  link: number;
  partner: number;
  length: number;
  kind: LinkKind;
}

/** Links of one place, nearest partner first. */
export function linksOfPlace(links: JumpLinks, place: number): PlaceLink[] {
  const out: PlaceLink[] = [];
  for (let i = 0; i < links.count; i++) {
    const a = links.a[i], b = links.b[i];
    if (a !== place && b !== place) continue;
    out.push({ link: i, partner: a === place ? b : a, length: links.length[i], kind: links.kind[i] as LinkKind });
  }
  return out.sort((p, q) => p.length - q.length || p.partner - q.partner);
}
