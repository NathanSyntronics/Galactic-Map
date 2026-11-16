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
  /** Most colonies: then it stops growing (its region grows as far as needed, see FactionGraph.growable). */
  maxColonies: number;
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
  maxColonies: 50_000,
};

/** The faction's world: places, their links and which places it may settle. */
export interface FactionGraph {
  count: number;
  /** Stable key per place (ties). */
  keys: ArrayLike<number>;
  links: { count: number; a: ArrayLike<number>; b: ArrayLike<number>; length: ArrayLike<number> };
  /** 1 where the faction settles (a colony at the end of a route). */
  target: Uint8Array;
  /**
   * The place that holds the star of a key (-1: none), where the graph can tell it directly;
   * otherwise the keys are indexed (KeyIndex).
   */
  placeOf?: (key: number) => number;
  /**
   * The graph is the network of a region that can grow: once nothing is left within reach in it,
   * the faction asks for a larger one (GROW) instead of stopping.
   */
  growable?: boolean;
}

export const COLONY = 1;
export const STATION = 2;
/** buy(): the search for the next route reached the deadline; it goes on in the next call. */
export const SEARCHING = -2;
/** buy(): nothing is left in the faction's region: it goes on once the graph is larger (moveTo) or final (finalRegion). */
export const GROW = -3;

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

/** Most years simulated (beyond the clock's range of two million years either way). */
export const MAX_YEARS = 5_000_000;

/**
 * The growth of one faction, simulated year by year as far as asked (advanceTo). Each year the
 * colonies' income goes into the pool; then the pool pays for the next jumps of the current route
 * as long as it can: a station at every system on the way, a colony at the end. The next route
 * leads from any of the faction's systems (colonies and stations) to the target place it reaches
 * at the lowest cost (ties: the smaller key).
 */
export class FactionSim {
  /** Places searched between looks at the deadline (see buy). */
  static SEARCH_BATCH = 2048;
  readonly events: FactionEvent[] = [];
  /** Owner state per place: 0, COLONY or STATION. */
  owned: Uint8Array;
  /** The last year simulated (its income and spending done); startYear - 1 before the start. */
  year: number;
  credits = 0;
  /** No suitable place is left within reach, or it has its most colonies (capped). */
  exhausted = false;
  capped = false;
  /** Its home system belongs to another faction (it never starts). */
  homeTaken = false;
  /** Places another faction holds: closed to this one. */
  blocked: Uint8Array;
  /**
   * From this year on nothing changes but the pool: nothing is left to settle and every colony
   * earns its maximum. Later years are not simulated one by one (see creditsAt).
   */
  steady: { year: number; credits: number; income: number } | null = null;
  /** Places were closed since the costs were computed (some costs may be too low now). */
  private closed = false;
  /** Adjacency (both directions): the links of place p are link[start[p] .. start[p + 1] - 1]. */
  private start = new Int32Array(1);
  private link = new Int32Array(0);
  private readonly cost: (d: number) => number;
  private route: Step[] | null = null;
  private routePos = 0;
  /**
   * The cheapest known cost from the faction's systems to the places (0 for its own), with the
   * place each is reached from and that jump's cost. One Dijkstra search runs on over the whole
   * simulation, only as far as the next route needs: a new system enters its frontier at cost 0,
   * and costs only fall, so no place is searched again unless its cost fell.
   */
  private best: Float64Array;
  private pred: Int32Array;
  private jump: Float64Array;
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
    public graph: FactionGraph,
    public home: number,
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
    this.adjacency();
    if (home >= 0 && home < n) {
      this.owned[home] = COLONY;
      this.events.push({ year: def.startYear, place: home, from: -1, kind: COLONY, cost: 0 });
      this.addColony(def.startYear);
      this.relax([home]);
    } else {
      this.exhausted = true;
    }
  }

  /** The links of each place (both directions). */
  private adjacency(): void {
    const n = this.graph.count;
    const deg = new Int32Array(n + 1);
    const L = this.graph.links;
    for (let i = 0; i < L.count; i++) {
      deg[L.a[i] + 1]++;
      deg[L.b[i] + 1]++;
    }
    for (let p = 0; p < n; p++) deg[p + 1] += deg[p];
    this.start = deg;
    const fill = deg.slice(0, n);
    this.link = new Int32Array(deg[n]);
    for (let i = 0; i < L.count; i++) {
      this.link[fill[L.a[i]]++] = i;
      this.link[fill[L.b[i]]++] = i;
    }
  }

  /** Number of colonies (the home system included). */
  get colonies(): number {
    return this.firstYears.length;
  }

  /**
   * The same faction on a larger graph (its region grown): its systems, the places closed to it,
   * its events and its route mapped by `map` (old place to new, -1: gone); the search for the next
   * route starts again from all its systems. Its history so far stays as it was.
   */
  moveTo(graph: FactionGraph, map: (place: number) => number): void {
    const n = graph.count;
    const owned = new Uint8Array(n);
    const blocked = new Uint8Array(n);
    for (let p = 0; p < this.graph.count; p++) {
      if (!this.owned[p] && !this.blocked[p]) continue;
      const q = map(p);
      if (q < 0) continue;
      if (this.owned[p]) owned[q] = this.owned[p];
      else blocked[q] = 1;
    }
    const at = (p: number) => (p < 0 ? -1 : map(p));
    for (const e of this.events) {
      e.place = at(e.place);
      e.from = at(e.from);
    }
    if (this.route) {
      for (const st of this.route) {
        st.place = at(st.place);
        st.from = at(st.from);
      }
      // (a route with a place gone is planned anew)
      if (this.route.some((st) => st.place < 0)) this.route = null;
    }
    this.home = at(this.home);
    this.graph = graph;
    this.owned = owned;
    this.blocked = blocked;
    this.best = new Float64Array(n);
    this.pred = new Int32Array(n);
    this.jump = new Float64Array(n);
    this.adjacency();
    this.recompute();
  }

  /** The graph's region cannot grow any more: with nothing left in it, the faction stops. */
  finalRegion(): void {
    this.graph.growable = false;
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
      if (this.steady) {
        this.year = last;
        return;
      }
      const y = this.year + 1;
      this.beginYear(y);
      while (this.buy(y) >= 0);
      this.endYear(y);
    }
  }

  /** The year's income into the pool (nothing before the first year). */
  beginYear(year: number): void {
    if (this.steady || year < this.def.startYear || this.homeTaken) return;
    const inc = this.income(year);
    this.credits += inc;
    this.incomes.push(inc);
  }

  endYear(year: number): void {
    this.year = year;
    if (this.steady || year < this.def.startYear || this.homeTaken) return;
    this.pool.push(this.credits);
    // nothing left to do but earn: the later years follow from this one
    if (this.exhausted && !this.route && this.maxed === this.firstYears.length) {
      this.steady = { year, credits: this.credits, income: this.incomes[this.incomes.length - 1] ?? 0 };
    }
  }

  /** Whether the years from now on change nothing but the pool (or it never starts). */
  get idle(): boolean {
    return !!this.steady || this.homeTaken;
  }

  /** Credits at the end of a simulated year, and the income of that year. */
  creditsAt(year: number): number {
    const st = this.steady;
    if (st && year > st.year) return st.credits + st.income * (year - st.year);
    const k = year - this.def.startYear;
    return k < 0 ? 0 : this.pool[Math.min(k, this.pool.length - 1)] ?? 0;
  }

  incomeAt(year: number): number {
    const st = this.steady;
    if (st && year > st.year) return st.income;
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
  buy(year: number, deadline = Infinity): number {
    if (year < this.def.startYear || this.homeTaken) return -1;
    if (!this.route) {
      if (this.exhausted) return -1;
      if (this.firstYears.length >= this.def.maxColonies) {
        this.exhausted = true;
        this.capped = true;
        return -1;
      }
      const route = this.nextRoute(deadline);
      if (route === false) return SEARCHING;
      // nothing left in its region: a larger one first, where it can grow
      if (!route && this.graph.growable) return GROW;
      this.route = route;
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
    const { a, b, length } = this.graph.links;
    for (let k = this.start[u]; k < this.start[u + 1]; k++) {
      const i = this.link[k];
      const v = a[i] === u ? b[i] : a[i];
      if (this.owned[v] || this.blocked[v]) continue;
      const j = this.cost(length[i]);
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
  private nextRoute(deadline: number): Step[] | null | false {
    const w = this.work;
    let pops = 0;
    while (w.size) {
      // (a long search, far through a large network, goes on in the next call: false)
      if (pops++ >= FactionSim.SEARCH_BATCH) {
        pops = 0;
        if (performance.now() > deadline) return false;
      }
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
 * Places by their stable key: the keys sorted, with the place of each (12 bytes a place, a third
 * of a Map's). A key held by several places gives the last of them.
 */
export class KeyIndex {
  private readonly sorted: Float64Array;
  private readonly place: Int32Array;

  constructor(keys: ArrayLike<number>, count: number) {
    this.sorted = Float64Array.from({ length: count }, (_, p) => keys[p]).sort();
    this.place = new Int32Array(count).fill(-1);
    for (let p = 0; p < count; p++) {
      const k = this.find(keys[p]);
      // (equal keys: the next free slot of the run, so that each place has one)
      let at = k;
      while (at + 1 < count && this.sorted[at + 1] === keys[p] && this.place[at] >= 0) at++;
      this.place[at] = p;
    }
  }

  /** The first index of `key` in the sorted keys (-1: none). */
  private find(key: number): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sorted[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.sorted.length && this.sorted[lo] === key ? lo : -1;
  }

  /** The place of a key (-1: none). */
  get(key: number): number {
    let k = this.find(key);
    if (k < 0) return -1;
    while (k + 1 < this.sorted.length && this.sorted[k + 1] === key) k++;
    return this.place[k];
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
  /** The faction whose turn it is to buy in the year begun, and the tries without a purchase in a row. */
  private turn = 0;
  private tries = 0;
  /** Purchases checked against the deadline in groups of this many. */
  private static readonly CHECK_EVERY = 4;
  /** Each faction's places by key (only with several factions). */
  private readonly placeOf: ((key: number) => number)[];
  /**
   * The faction (index) whose search reached the edge of its region: the simulation waits until
   * its graph is larger or final (FactionSim.moveTo or finalRegion, then grown).
   */
  growing: number | null = null;

  constructor(readonly sims: FactionSim[]) {
    this.year = Math.min(...sims.map((s) => s.def.startYear)) - 1;
    this.placeOf = sims.length > 1 ? sims.map((s) => FactionsSim.lookup(s.graph)) : [];
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

  private static lookup(graph: FactionGraph): (key: number) => number {
    if (graph.placeOf) return graph.placeOf;
    const index = new KeyIndex(graph.keys, graph.count);
    return (key: number) => index.get(key);
  }

  /**
   * Faction i's graph grew (or became final): the others' systems are closed to it in its new
   * places too, and the simulation goes on.
   */
  grown(i: number): void {
    const s = this.sims[i];
    if (this.placeOf.length) {
      const look = (this.placeOf[i] = FactionsSim.lookup(s.graph));
      this.sims.forEach((o, j) => {
        if (j === i) return;
        for (const e of o.events) {
          if (e.place < 0) continue;
          const p = look(o.graph.keys[e.place]);
          if (p >= 0) s.block(p);
        }
      });
    }
    if (this.growing === i) this.growing = null;
  }

  /** Faction i took one of its places: closed to the others. */
  private taken(i: number, place: number): void {
    const key = this.sims[i].graph.keys[place];
    this.sims.forEach((o, j) => {
      if (j === i) return;
      const p = this.placeOf[j](key);
      if (p >= 0) o.block(p);
    });
  }

  /**
   * Simulates up to `year`, or until `deadline` (performance.now(); checked after each year), so
   * that a frame never waits long: the rest follows in the next frames.
   */
  advanceTo(year: number, deadline = Infinity): void {
    if (this.growing !== null) return;
    const last = Math.min(year, this.year + 1 + MAX_YEARS);
    let bought = 0;
    // (every call gets on by at least a year or a few purchases, whatever the deadline)
    let worked = false;
    while (this.year < last) {
      // nothing changes any more but the pools: straight to the year asked
      if (this.pending === null && this.sims.every((s) => s.idle)) {
        this.year = last;
        for (const s of this.sims) s.year = last;
        return;
      }
      if (worked && performance.now() > deadline) return;
      const y = this.year + 1;
      if (this.pending !== y) {
        for (const s of this.sims) s.beginYear(y);
        this.pending = y;
        this.turn = 0;
        this.tries = 0;
      }
      // purchases in turn (one each, round and round) until none of them can buy any more: as many
      // tries without a purchase in a row as there are factions. A pause mid-year (after a
      // purchase, or in a long search for a route) keeps whose turn it is and the tries, so that a
      // year continued in the next call goes on exactly as in one go
      const n = this.sims.length;
      while (this.tries < n) {
        const i = this.turn;
        const p = this.sims[i].buy(y, deadline);
        if (p === SEARCHING) return;
        if (p === GROW) {
          this.growing = i;
          return;
        }
        this.turn = (i + 1) % n;
        if (p < 0) {
          this.tries++;
          continue;
        }
        this.tries = 0;
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
