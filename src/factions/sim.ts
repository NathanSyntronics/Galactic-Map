// Factions (docs/FACTIONS.md): a faction grows from its home system along the jump network. Every
// colony earns credits each year (starting low, rising to a maximum); the faction's pool pays for
// the jumps along a route to the cheapest suitable star: a station at each system on the way, a
// colony at the end. Pure computation on a graph of places and links; the app supplies the network
// and draws the result for the year on the clock.
import type { ClassKey } from '../data/filter';
import { jumpCostFn, type JumpCost } from '../network/route';

export interface FactionDef {
  id: string;
  name: { en: string; de: string };
  /** Colour of its rims and links (#rrggbb). */
  color: string;
  /** Primary designation of the home star ("Sun"). */
  home: string;
  /** The year of the home system's first income. */
  startYear: number;
  /** Credits of a colony's first year, and the rise per year up to the maximum. */
  startIncome: number;
  incomeStep: number;
  maxIncome: number;
  /** What a jump costs (network/route JumpCost). */
  cost: JumpCost;
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
  color: '#ffb347',
  home: 'Sun',
  startYear: 2027,
  startIncome: 1,
  incomeStep: 0.2,
  maxIncome: 100,
  cost: { exp: true, k: 2 },
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

/** Credits of a colony in its n-th year (0: the first). */
export function colonyIncome(def: Pick<FactionDef, 'startIncome' | 'incomeStep' | 'maxIncome'>, n: number): number {
  return n < 0 ? 0 : Math.min(def.startIncome + def.incomeStep * n, def.maxIncome);
}

class MinHeap {
  private cost: number[] = [];
  private key: number[] = [];
  private item: number[] = [];

  get size(): number {
    return this.item.length;
  }

  private less(i: number, j: number): boolean {
    return this.cost[i] !== this.cost[j] ? this.cost[i] < this.cost[j] : this.key[i] < this.key[j];
  }

  private swap(i: number, j: number): void {
    for (const a of [this.cost, this.key, this.item]) [a[i], a[j]] = [a[j], a[i]];
  }

  push(item: number, cost: number, key: number): void {
    this.cost.push(cost);
    this.key.push(key);
    this.item.push(item);
    let i = this.item.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.less(i, up)) break;
      this.swap(i, up);
      i = up;
    }
  }

  pop(): { item: number; cost: number } {
    const top = { item: this.item[0], cost: this.cost[0] };
    const last = this.item.length - 1;
    this.swap(0, last);
    this.cost.pop();
    this.key.pop();
    this.item.pop();
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
  private readonly start: number[];
  private readonly to: number[];
  private readonly len: number[];
  private readonly cost: (d: number) => number;
  private route: Step[] | null = null;
  private routePos = 0;
  /**
   * The cheapest cost from the faction's systems to every place (0 for its own), with the place it
   * is reached from and that jump's cost: kept up to date as systems are added (costs only fall),
   * so a new route needs no search over the whole network.
   */
  private readonly best: Float64Array;
  private readonly pred: Int32Array;
  private readonly jump: Float64Array;
  /** The places to settle by their cost (stale entries are skipped). */
  private readonly targets = new MinHeap();
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
  ) {
    const n = graph.count;
    this.owned = new Uint8Array(n);
    this.best = new Float64Array(n).fill(Infinity);
    this.pred = new Int32Array(n).fill(-1);
    this.jump = new Float64Array(n);
    this.year = def.startYear - 1;
    this.cost = jumpCostFn(def.cost);
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
      this.claim(home);
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
    const span = d.incomeStep > 0 ? Math.ceil((d.maxIncome - d.startIncome) / d.incomeStep - 1e-9) : Infinity;
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
    const rising = active * d.startIncome + d.incomeStep * (active * year - activeSum);
    return this.maxed * d.maxIncome + Math.min(rising, active * d.maxIncome);
  }

  /** Simulates up to and including `year`. */
  advanceTo(year: number): void {
    const last = Math.min(year, this.def.startYear + MAX_YEARS);
    while (this.year < last) {
      const y = this.year + 1;
      const inc = this.income(y);
      this.credits += inc;
      this.spend(y);
      this.year = y;
      this.pool.push(this.credits);
      this.incomes.push(inc);
    }
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

  private spend(year: number): void {
    for (;;) {
      if (!this.route) {
        if (this.exhausted) return;
        this.route = this.nextRoute();
        this.routePos = 0;
        if (!this.route) {
          this.exhausted = true;
          return;
        }
      }
      const step = this.route[this.routePos];
      if (this.credits + 1e-9 < step.cost) return;
      this.credits -= step.cost;
      const last = this.routePos === this.route.length - 1;
      const kind = last ? COLONY : STATION;
      this.owned[step.place] = kind;
      this.events.push({ year, place: step.place, from: step.from, kind, cost: step.cost });
      this.claim(step.place);
      this.routePos++;
      if (last) {
        this.addColony(year + 1);
        this.route = null;
      }
    }
  }

  /** A place becomes the faction's: cost 0, and the costs of the places around fall (Dijkstra). */
  private claim(place: number): void {
    const keys = this.graph.keys;
    const { best, pred, jump } = this;
    best[place] = 0;
    pred[place] = -1;
    const work = new MinHeap();
    work.push(place, 0, keys[place]);
    while (work.size) {
      const { item: u, cost } = work.pop();
      if (cost > best[u]) continue;
      for (let k = this.start[u]; k < this.start[u + 1]; k++) {
        const v = this.to[k];
        if (this.owned[v]) continue;
        const j = this.cost(this.len[k]);
        const c = cost + j;
        if (c < best[v] || (c === best[v] && pred[v] >= 0 && keys[u] < keys[pred[v]])) {
          const fell = c < best[v];
          best[v] = c;
          pred[v] = u;
          jump[v] = j;
          if (fell) {
            work.push(v, c, keys[v]);
            if (this.graph.target[v]) this.targets.push(v, c, keys[v]);
          }
        }
      }
    }
  }

  /** The cheapest route from the faction's systems to a place it settles (null: none left). */
  private nextRoute(): Step[] | null {
    const t = this.targets;
    while (t.size) {
      const { item: u, cost } = t.pop();
      if (this.owned[u] || cost > this.best[u] || !this.graph.target[u]) continue;
      const steps: Step[] = [];
      for (let p = u; !this.owned[p]; p = this.pred[p]) steps.push({ place: p, from: this.pred[p], cost: this.jump[p] });
      return steps.reverse();
    }
    return null;
  }
}
