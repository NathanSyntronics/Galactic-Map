// Factions (docs/FACTIONS.md): a faction grows from its home system along the jump network. Every
// colony earns credits each year (a little more each year, up to a maximum); the faction's pool
// pays for the jumps along a route to the cheapest suitable star: a station at each system on the
// way, a colony at the end. Several factions grow together (FactionsSim), and a system that one of
// them holds is closed to the others. Pure computation on graphs of places and links; the app
// supplies the networks and draws the result for the year on the clock.
import type { ClassKey } from '../data/filter';
import { jumpCostFn, type JumpCost } from '../network/route';

export interface FactionDef {
  id: string;
  name: { en: string; de: string };
  /** Colour of its rims and links (#rrggbb). */
  color: string;
  /** Primary designation of the home star ("Sun"). */
  home: string;
  /** Its name when the faction was made (shown while the star data loads). */
  homeName?: string;
  /** Where the home star was (a node path and a world position: found again after a rebuild). */
  homeHint?: { path: string; x: number; y: number; z: number };
  /** The year of the home system's first income. */
  startYear: number;
  /** Credits of a colony's first year, and as much more each year, up to the maximum. */
  incomeStep: number;
  maxIncome: number;
  /** Spectral classes of the stars it settles. */
  targets: ClassKey[];
  /** Only stars that are not part of a multiple system. */
  singleOnly: boolean;
  /** Radius (ly) of the jump network around the home star the faction grows in. */
  region: number;
}

export const SOLAR_EMPIRE: FactionDef = {
  id: 'sol',
  name: { en: 'Solar Empire', de: 'Solares Imperium' },
  color: '#40e0d0',
  home: 'Sun',
  startYear: 2027,
  incomeStep: 0.1,
  maxIncome: 10,
  targets: ['F', 'G', 'K'],
  singleOnly: true,
  region: 150,
};

/** The faction's world: places, their links and which places it may settle. */
export interface FactionGraph {
  count: number;
  /** Stable key per place (ties). */
  keys: ArrayLike<number>;
  links: { count: number; a: ArrayLike<number>; b: ArrayLike<number>; length: ArrayLike<number> };
  /** 1 where the faction settles (a colony at the end of a route). */
  target: Uint8Array;
}

export const COLONY = 1;
export const STATION = 2;

/** A system becomes the faction's: a station on the way or a colony at the end of a route. */
export interface FactionEvent {
  year: number;
  place: number;
  /** The place the jump came from. */
  from: number;
  kind: typeof COLONY | typeof STATION;
  /** Credits paid for the jump. */
  cost: number;
}

/** Credits of a colony in its n-th year (0: the first): incomeStep · (n + 1), at most maxIncome. */
export function colonyIncome(def: Pick<FactionDef, 'incomeStep' | 'maxIncome'>, n: number): number {
  return n < 0 ? 0 : Math.min(def.incomeStep * (n + 1), def.maxIncome);
}

/** Binary min-heap of items by cost, then key (typed arrays, grown as needed). */
class MinHeap {
  private cost = new Float64Array(256);
  private key = new Float64Array(256);
  private item = new Int32Array(256);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  private less(i: number, j: number): boolean {
    const c = this.cost;
    return c[i] !== c[j] ? c[i] < c[j] : this.key[i] < this.key[j];
  }

  private swap(i: number, j: number): void {
    const c = this.cost;
    const k = this.key;
    const it = this.item;
    const a = c[i];
    c[i] = c[j];
    c[j] = a;
    const b = k[i];
    k[i] = k[j];
    k[j] = b;
    const d = it[i];
    it[i] = it[j];
    it[j] = d;
  }

  push(item: number, cost: number, key: number): void {
    if (this.size === this.item.length) {
      const n = 2 * this.size;
      const c = new Float64Array(n);
      c.set(this.cost);
      this.cost = c;
      const k = new Float64Array(n);
      k.set(this.key);
      this.key = k;
      const it = new Int32Array(n);
      it.set(this.item);
      this.item = it;
    }
    let i = this.size++;
    this.cost[i] = cost;
    this.key[i] = key;
    this.item[i] = item;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  /** The cheapest item (topCost: its cost); call only when size > 0. */
  topCost = 0;

  pop(): number {
    const top = this.item[0];
    this.topCost = this.cost[0];
    const last = --this.size;
    if (last > 0) {
      this.swap(0, last);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < last && this.less(l, m)) m = l;
        if (r < last && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** One step of a route: the place reached, where from, and what the jump costs. */
interface Step {
  place: number;
  from: number;
  cost: number;
}

/** Most years simulated (a date far in the future stops here). */
export const MAX_YEARS = 100_000;

/**
 * The growth of one faction, simulated year by year as far as asked (advanceTo). Each year the
 * colonies' income goes into the pool; then the pool pays for the next jumps of the current route
 * as long as it can: a station at every system on the way, a colony at the end. The next route
 * leads from any of the faction's systems (colonies and stations) to the target place it reaches
 * at the lowest cost (ties: the smaller key).
 */
export class FactionSim {
  readonly events: FactionEvent[] = [];
  /** Owner state per place: 0, COLONY or STATION. */
  readonly owned: Uint8Array;
  /** The last year simulated (its income and spending done); startYear - 1 before the start. */
  year: number;
  credits = 0;
  /** No suitable place is left within reach (the region is exhausted). */
  exhausted = false;
  /** Its home system belongs to another faction (it never starts). */
  homeTaken = false;
  /** Places another faction holds: closed to this one. */
  readonly blocked: Uint8Array;
  /** Places were closed since the costs were computed (some costs may be too low now). */
  private closed = false;
  private readonly start: number[];
  private readonly to: number[];
  private readonly len: number[];
  private readonly cost: (d: number) => number;
  private route: Step[] | null = null;
  private routePos = 0;
  /**
   * The cheapest known cost from the faction's systems to the places (0 for its own), with the
   * place each is reached from and that jump's cost. One Dijkstra search runs on over the whole
   * simulation, only as far as the next route needs: a new system enters its frontier at cost 0,
   * and costs only fall, so no place is searched again unless its cost fell.
   */
  private readonly best: Float64Array;
  private readonly pred: Int32Array;
  private readonly jump: Float64Array;
  /** The search's frontier: places by cost (stale entries are skipped). */
  private readonly work = new MinHeap();
  /** Colonies' first income years in order (nondecreasing), for the income in O(1). */
  private readonly firstYears: number[] = [];
  private maxed = 0;
  private sumFirst = 0;
  /** Credits at the end of each simulated year (index: year - startYear). */
  private readonly pool: number[] = [];
  private readonly incomes: number[] = [];

  constructor(
    readonly graph: FactionGraph,
    readonly home: number,
    readonly def: FactionDef,
    cost?: JumpCost,
  ) {
    const n = graph.count;
    this.owned = new Uint8Array(n);
    this.blocked = new Uint8Array(n);
    this.best = new Float64Array(n).fill(Infinity);
    this.pred = new Int32Array(n).fill(-1);
    this.jump = new Float64Array(n);
    this.year = def.startYear - 1;
    this.cost = jumpCostFn(cost);
    // adjacency (both directions)
    const deg = new Int32Array(n + 1);
    const L = graph.links;
    for (let i = 0; i < L.count; i++) {
      deg[L.a[i] + 1]++;
      deg[L.b[i] + 1]++;
    }
    for (let p = 0; p < n; p++) deg[p + 1] += deg[p];
    this.start = Array.from(deg);
    const fill = this.start.slice(0, n);
    this.to = new Array(deg[n]);
    this.len = new Array(deg[n]);
    for (let i = 0; i < L.count; i++) {
      const a = L.a[i];
      const b = L.b[i];
      this.to[fill[a]] = b;
      this.len[fill[a]++] = +L.length[i];
      this.to[fill[b]] = a;
      this.len[fill[b]++] = +L.length[i];
    }
    if (home >= 0 && home < n) {
      this.owned[home] = COLONY;
      this.events.push({ year: def.startYear, place: home, from: -1, kind: COLONY, cost: 0 });
      this.addColony(def.startYear);
      this.relax([home]);
    } else {
      this.exhausted = true;
    }
  }

  private addColony(firstYear: number): void {
    this.firstYears.push(firstYear);
    this.sumFirst += firstYear;
  }

  /** The colonies' income in a year. */
  income(year: number): number {
    const d = this.def;
    // colonies whose income has reached the maximum: a prefix (their first years are in order)
    const span = d.incomeStep > 0 ? Math.ceil(d.maxIncome / d.incomeStep - 1 - 1e-9) : Infinity;
    while (this.maxed < this.firstYears.length && year - this.firstYears[this.maxed] >= span) {
      this.sumFirst -= this.firstYears[this.maxed];
      this.maxed++;
    }
    // (colonies founded this year earn from the next one)
    let u = 0;
    let sum = 0;
    for (let k = this.firstYears.length - 1; k >= this.maxed && this.firstYears[k] > year; k--) {
      u++;
      sum += this.firstYears[k];
    }
    const active = this.firstYears.length - this.maxed - u;
    const activeSum = this.sumFirst - sum;
    const rising = d.incomeStep * (active * (year + 1) - activeSum);
    return this.maxed * d.maxIncome + Math.min(rising, active * d.maxIncome);
  }

  /** Simulates up to and including `year` (on its own; several factions: FactionsSim). */
  advanceTo(year: number): void {
    const last = Math.min(year, this.def.startYear + MAX_YEARS);
    while (this.year < last) {
      const y = this.year + 1;
      this.beginYear(y);
      while (this.buy(y) >= 0);
      this.endYear(y);
    }
  }

  /** The year's income into the pool (nothing before the first year). */
  beginYear(year: number): void {
    if (year < this.def.startYear || this.homeTaken) return;
    const inc = this.income(year);
    this.credits += inc;
    this.incomes.push(inc);
  }

  endYear(year: number): void {
    this.year = year;
    if (year < this.def.startYear || this.homeTaken) return;
    this.pool.push(this.credits);
  }

  /** Credits at the end of a simulated year, and the income of that year. */
  creditsAt(year: number): number {
    const k = year - this.def.startYear;
    return k < 0 ? 0 : this.pool[Math.min(k, this.pool.length - 1)] ?? 0;
  }

  incomeAt(year: number): number {
    const k = year - this.def.startYear;
    return k < 0 ? 0 : this.incomes[Math.min(k, this.incomes.length - 1)] ?? 0;
  }

  /** Number of events up to the end of a year (events are in order of time). */
  countAt(year: number): number {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.events[m].year <= year) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /**
   * Pays the next jump of the route if the pool holds its cost (planning a new route first if
   * there is none): returns the place that became the faction's, or -1.
   */
  buy(year: number): number {
    if (year < this.def.startYear || this.homeTaken) return -1;
    if (!this.route) {
      if (this.exhausted) return -1;
      this.route = this.nextRoute();
      this.routePos = 0;
      if (!this.route) {
        this.exhausted = true;
        return -1;
      }
    }
    const step = this.route[this.routePos];
    if (this.credits + 1e-9 < step.cost) return -1;
    this.credits -= step.cost;
    const last = this.routePos === this.route.length - 1;
    const kind = last ? COLONY : STATION;
    this.owned[step.place] = kind;
    this.events.push({ year, place: step.place, from: step.from, kind, cost: step.cost });
    this.relax([step.place]);
    this.routePos++;
    if (last) {
      this.addColony(year + 1);
      this.route = null;
    }
    return step.place;
  }

  /** Its home system belongs to another faction: it never starts. */
  loseHome(): void {
    this.homeTaken = true;
    this.exhausted = true;
    this.events.length = 0;
    this.firstYears.length = 0;
    this.sumFirst = 0;
    this.maxed = 0;
    this.route = null;
    if (this.home >= 0) {
      this.owned[this.home] = 0;
      this.blocked[this.home] = 1;
    }
  }

  /** Another faction took a place: closed to this one (a route through it is planned anew). */
  block(place: number): void {
    if (this.blocked[place] || this.owned[place]) return;
    this.blocked[place] = 1;
    if (place === this.home) this.homeTaken = true;
    if (this.route) {
      for (let k = this.routePos; k < this.route.length; k++) {
        if (this.route[k].place === place) {
          // the route is planned anew; its target (taken from the search's frontier) goes back in
          const t = this.route[this.route.length - 1].place;
          if (!this.blocked[t] && !this.owned[t]) this.work.push(t, this.best[t], this.graph.keys[t]);
          this.route = null;
          break;
        }
      }
    }
    // the costs through it are too low now; they are checked when a route is chosen (nextRoute)
    if (Number.isFinite(this.best[place])) this.closed = true;
  }

  /** All costs computed again from the faction's systems (one search from all of them), around the closed places. */
  private recompute(): void {
    this.best.fill(Infinity);
    this.pred.fill(-1);
    this.work.clear();
    const own: number[] = [];
    for (let p = 0; p < this.graph.count; p++) if (this.owned[p]) own.push(p);
    this.closed = false;
    this.relax(own);
  }

  /** Places become the faction's: cost 0, into the search's frontier (searched on when needed). */
  private relax(sources: number[]): void {
    const keys = this.graph.keys;
    for (const p of sources) {
      this.best[p] = 0;
      this.pred[p] = -1;
      this.work.push(p, 0, keys[p]);
    }
  }

  /** The costs of the places around u fall where u is the cheaper way to them. */
  private expand(u: number, cost: number): void {
    const keys = this.graph.keys;
    const { best, pred, jump, work } = this;
    for (let k = this.start[u]; k < this.start[u + 1]; k++) {
      const v = this.to[k];
      if (this.owned[v] || this.blocked[v]) continue;
      const j = this.cost(this.len[k]);
      const c = cost + j;
      if (c < best[v] || (c === best[v] && pred[v] >= 0 && keys[u] < keys[pred[v]])) {
        const fell = c < best[v];
        best[v] = c;
        pred[v] = u;
        jump[v] = j;
        if (fell) work.push(v, c, keys[v]);
      }
    }
  }

  /** The cheapest route from the faction's systems to a place it settles (null: none left). */
  private nextRoute(): Step[] | null {
    const w = this.work;
    while (w.size) {
      const u = w.pop();
      const cost = w.topCost;
      if (cost > this.best[u] || this.blocked[u]) continue;
      this.expand(u, cost);
      if (this.owned[u] || !this.graph.target[u]) continue;
      const steps: Step[] = [];
      let open = true;
      for (let p = u; !this.owned[p]; p = this.pred[p]) {
        if (this.blocked[p] || p < 0) {
          open = false;
          break;
        }
        steps.push({ place: p, from: this.pred[p], cost: this.jump[p] });
      }
      // Costs only fall, except where another faction closed a place: they are lower bounds then.
      // A route without a closed place costs what it says, so it is the cheapest; one through a
      // closed place means computing the costs again (and the target again)
      if (open) return steps.reverse();
      if (!this.closed) return null;
      this.recompute();
    }
    return null;
  }
}

/**
 * Several factions growing together: year by year, each gets its income, then they buy their
 * jumps in turn (one each, round and round, as long as any can), so that none is served first. A
 * system (by the stable key of its brightest star) that one faction takes is closed to the others,
 * also in their own networks; a home system already taken leaves the later faction without a start.
 */
export class FactionsSim {
  year: number;
  /** A year begun (incomes paid) but not finished: its purchases go on in the next call. */
  private pending: number | null = null;
  /** The faction whose turn it is to buy in the year begun. */
  private turn = 0;
  /** Purchases checked against the deadline in groups of this many. */
  private static readonly CHECK_EVERY = 4;
  private readonly places: Map<number, number>[];

  constructor(readonly sims: FactionSim[]) {
    this.year = Math.min(...sims.map((s) => s.def.startYear)) - 1;
    this.places = sims.map((s) => {
      const m = new Map<number, number>();
      for (let p = 0; p < s.graph.count; p++) m.set(s.graph.keys[p], p);
      return m;
    });
    // the homes, in order: a later faction whose home another one holds never starts
    const homes = new Set<number>();
    sims.forEach((s, i) => {
      if (s.home < 0 || s.homeTaken) return;
      const key = s.graph.keys[s.home];
      if (homes.has(key)) {
        s.loseHome();
        return;
      }
      homes.add(key);
      this.taken(i, s.home);
    });
  }

  /** Faction i took one of its places: closed to the others. */
  private taken(i: number, place: number): void {
    const key = this.sims[i].graph.keys[place];
    this.sims.forEach((o, j) => {
      if (j === i) return;
      const p = this.places[j].get(key);
      if (p !== undefined) o.block(p);
    });
  }

  /**
   * Simulates up to `year`, or until `deadline` (performance.now(); checked after each year), so
   * that a frame never waits long: the rest follows in the next frames.
   */
  advanceTo(year: number, deadline = Infinity): void {
    const last = Math.min(year, this.year + 1 + MAX_YEARS);
    let bought = 0;
    // (every call gets on by at least a year or a few purchases, whatever the deadline)
    let worked = false;
    while (this.year < last) {
      if (worked && performance.now() > deadline) return;
      const y = this.year + 1;
      if (this.pending !== y) {
        for (const s of this.sims) s.beginYear(y);
        this.pending = y;
        this.turn = 0;
      }
      // purchases in turn (one each, round and round) until none of them can buy any more: as many
      // tries without a purchase in a row as there are factions. A pause mid-year keeps whose turn
      // it is, so that a year continued in the next call goes on exactly as in one go
      const n = this.sims.length;
      for (let idle = 0; idle < n; ) {
        const i = this.turn;
        this.turn = (i + 1) % n;
        const p = this.sims[i].buy(y);
        if (p < 0) {
          idle++;
          continue;
        }
        idle = 0;
        this.taken(i, p);
        if (++bought % FactionsSim.CHECK_EVERY === 0 && performance.now() > deadline) return;
      }
      for (const s of this.sims) s.endYear(y);
      this.pending = null;
      this.year = y;
      worked = true;
    }
  }
}
