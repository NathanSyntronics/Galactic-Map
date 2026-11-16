import { describe, expect, it } from 'vitest';
import { COLONY, FactionSim, FactionsSim, SOLAR_EMPIRE, STATION, colonyIncome, type FactionDef, type FactionGraph } from '../../src/factions/sim';

/**
 * A grid of w x w places (keys: their numbers), links to the right and down with varied lengths,
 * every seventh place to settle; `part(cx, cy, r)` is its part within r of (cx, cy) as its own
 * graph, whose places farther than r - 1 are outer (their links may lack a neighbour), with the
 * part's place of each grid key.
 */
function grid(w: number) {
  const a: number[] = [];
  const b: number[] = [];
  const len: number[] = [];
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x + 1 < w) a.push(p), b.push(p + 1), len.push(1 + ((p * 7) % 5) / 4);
    if (y + 1 < w) a.push(p), b.push(p + w), len.push(1 + ((p * 3) % 5) / 4);
  }
  const target = new Uint8Array(w * w);
  for (let p = 3; p < w * w; p += 7) target[p] = 1;
  const full: FactionGraph = { count: w * w, keys: Array.from({ length: w * w }, (_, k) => k), links: { count: a.length, a, b, length: len }, target };
  const part = (cx: number, cy: number, r: number): FactionGraph => {
    const index = new Map<number, number>();
    const keys: number[] = [];
    const outer: number[] = [];
    for (let p = 0; p < w * w; p++) {
      const d = Math.hypot((p % w) - cx, Math.floor(p / w) - cy);
      if (d > r) continue;
      index.set(p, keys.length);
      keys.push(p);
      outer.push(d > r - 1 ? 1 : 0);
    }
    const pa: number[] = [];
    const pb: number[] = [];
    const pl: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const u = index.get(a[i]);
      const v = index.get(b[i]);
      if (u === undefined || v === undefined) continue;
      pa.push(u), pb.push(v), pl.push(len[i]);
    }
    return {
      count: keys.length,
      keys,
      links: { count: pa.length, a: pa, b: pb, length: pl },
      target: Uint8Array.from(keys, (k) => target[k]),
      placeOf: (key) => index.get(key) ?? -1,
      outer: Uint8Array.from(outer),
    };
  };
  return { full, part };
}

/** Places 0 (home), 1 (on the way), 2 and 3 (to settle); links 0-1 and 1-2 of 2 ly, 0-3 of 5 ly. */
function graph(): FactionGraph {
  return {
    count: 4,
    keys: [0, 1, 2, 3],
    links: { count: 3, a: [0, 1, 0], b: [1, 2, 3], length: [2, 2, 5] },
    target: Uint8Array.from([0, 0, 1, 1]),
  };
}

const def: FactionDef = { ...SOLAR_EMPIRE, startYear: 2027, incomeStep: 0.2, maxIncome: 100 };
/** Exponential, k = 2 (version 1.19's default). */
const EXP2 = { exp: true, k: 2 };

describe('factions', () => {
  it('earns the step in its first year and as much more each year, up to the maximum', () => {
    expect(colonyIncome(SOLAR_EMPIRE, 0)).toBeCloseTo(0.1, 12);
    expect(colonyIncome(SOLAR_EMPIRE, 9)).toBeCloseTo(1, 12);
    expect(colonyIncome(SOLAR_EMPIRE, 99)).toBe(10);
    expect(colonyIncome(SOLAR_EMPIRE, 2000)).toBe(10);
    expect(colonyIncome(SOLAR_EMPIRE, -1)).toBe(0);
  });

  it('pays the jumps of the cheapest route: stations on the way, a colony at the end', () => {
    const sim = new FactionSim(graph(), 0, { ...def, incomeStep: 1 }, EXP2);
    sim.advanceTo(2040);
    // 2027: 1 credit; 2028: 3, the station at 1 (2^1 = 2 credits); 2029: 4, the colony at 2; 2 earns
    // from 2030; 2032: 23, the 5 ly jump to 3 (2^4 = 16 credits)
    expect(sim.events.map((e) => [e.year, e.place, e.kind, e.from])).toEqual([
      [2027, 0, COLONY, -1],
      [2028, 1, STATION, 0],
      [2029, 2, COLONY, 1],
      [2032, 3, COLONY, 0],
    ]);
    expect(sim.creditsAt(2027)).toBeCloseTo(1, 9);
    expect(sim.creditsAt(2029)).toBeCloseTo(2, 9);
    expect(sim.creditsAt(2031)).toBeCloseTo(14, 9);
    expect(sim.creditsAt(2032)).toBeCloseTo(7, 9);
    expect(sim.incomeAt(2030)).toBeCloseTo(4 + 1, 9);
    expect(sim.exhausted).toBe(true);
    expect(sim.countAt(2026)).toBe(0);
    expect(sim.countAt(2028)).toBe(2);
    expect(sim.countAt(2100)).toBe(4);
    expect([...sim.owned]).toEqual([COLONY, STATION, COLONY, COLONY]);
  });

  it('stops simulating year by year once nothing changes but the pool', () => {
    const sim = new FactionSim(graph(), 0, { ...def, incomeStep: 1, maxIncome: 5 }, EXP2);
    const all = new FactionsSim([sim]);
    all.advanceTo(2100);
    // all settled by 2032, every colony at its maximum (5) a few years later: 3 colonies, 15 a year
    expect(sim.steady).not.toBeNull();
    expect(sim.incomeAt(2100)).toBe(15);
    const at2100 = sim.creditsAt(2100);
    all.advanceTo(1_000_000);
    expect(all.year).toBe(1_000_000);
    expect(sim.creditsAt(1_000_000)).toBeCloseTo(at2100 + 15 * (1_000_000 - 2100), 3);
    expect((sim as unknown as { pool: number[] }).pool.length).toBeLessThan(20);
  });

  it('sums the incomes of the colonies like one by one', () => {
    const d = { ...def, incomeStep: 0.7, maxIncome: 9 };
    const sim = new FactionSim(graph(), 0, d);
    // colonies founded in these years earn from the next one
    const founded = [2030, 2030, 2041, 2050];
    for (const y of founded) (sim as unknown as { addColony(y: number): void }).addColony(y + 1);
    for (let y = 2027; y < 2080; y++) {
      const want = colonyIncome(d, y - 2027) + founded.reduce((s, f) => s + colonyIncome(d, y - f - 1), 0);
      expect(sim.income(y)).toBeCloseTo(want, 9);
    }
  });

  it('takes the jump costs it is given (polynomial: d^k)', () => {
    // with d^2 the route through 1 costs 8, the jump to 3 costs 25
    const sim = new FactionSim(graph(), 0, def, { exp: false, k: 2 });
    sim.advanceTo(2100);
    expect(sim.events.map((e) => e.place)).toEqual([0, 1, 2, 3]);
    expect(sim.events[1].cost).toBe(4);
  });

  it('grows several factions together; a system belongs to one of them', () => {
    // a row of five places 1 ly apart: A at 0, B at 4, both want 2
    const row: FactionGraph = {
      count: 5,
      keys: [10, 11, 12, 13, 14],
      links: { count: 4, a: [0, 1, 2, 3], b: [1, 2, 3, 4], length: [1, 1, 1, 1] },
      target: Uint8Array.from([0, 0, 1, 0, 0]),
    };
    const a = new FactionSim(row, 0, { ...def, id: 'a', incomeStep: 1 }, EXP2);
    const b = new FactionSim(row, 4, { ...def, id: 'b', incomeStep: 1 }, EXP2);
    const all = new FactionsSim([a, b]);
    all.advanceTo(2040);
    // 2027: each buys its station (1 credit each, in turn); 2028: A reaches 2 first, B's route is cut
    expect(a.events.map((e) => [e.year, e.place, e.kind])).toEqual([
      [2027, 0, COLONY],
      [2027, 1, STATION],
      [2028, 2, COLONY],
    ]);
    expect(b.events.map((e) => [e.year, e.place, e.kind])).toEqual([
      [2027, 4, COLONY],
      [2027, 3, STATION],
    ]);
    expect(b.blocked[2]).toBe(1);
    expect(b.exhausted).toBe(true);
    // a faction whose home another one holds never starts
    const c = new FactionSim(row, 0, { ...def, id: 'c' }, EXP2);
    const d = new FactionSim(row, 0, { ...def, id: 'd' }, EXP2);
    new FactionsSim([c, d]).advanceTo(2030);
    expect(d.homeTaken).toBe(true);
    expect(d.events).toEqual([]);
    expect(c.events[0].place).toBe(0);
  });
});

describe('growing regions', () => {
  it('grows its region where its search reaches the edge, with the history of the whole network', () => {
    const w = 41;
    const { full, part } = grid(w);
    const homes = [20 * w + 10, 20 * w + 30];
    const history = (sims: FactionSim[]) => sims.map((s) => s.events.map((e) => `${e.year}:${s.graph.keys[e.place]}:${e.kind}`).join(' '));
    const make = (graph: (i: number) => FactionGraph, home: (g: FactionGraph, i: number) => number) =>
      homes.map((_, i) => {
        const g = graph(i);
        return new FactionSim(g, home(g, i), { ...def, id: `f${i}`, incomeStep: 0.5 }, { exp: false, k: 1 });
      });
    const whole = make(() => full, (_, i) => homes[i]);
    new FactionsSim(whole).advanceTo(2400);

    const run = (chunked: boolean) => {
      const radius = [4, 4];
      const sims = make(
        (i) => part(homes[i] % w, Math.floor(homes[i] / w), radius[i]),
        (g, i) => g.placeOf!(homes[i]),
      );
      const all = new FactionsSim(sims);
      let growths = 0;
      for (let k = 0; k < 100_000 && all.year < 2400; k++) {
        all.advanceTo(2400, chunked && k % 3 === 0 ? -1 : Infinity);
        const i = all.growing;
        if (i === null) continue;
        growths++;
        const s = sims[i];
        const before = history(sims);
        radius[i] *= 1.5;
        if (radius[i] > 50) s.finalRegion();
        else {
          const g = part(homes[i] % w, Math.floor(homes[i] / w), radius[i]);
          const old = s.graph;
          s.moveTo(g, (p) => g.placeOf!(old.keys[p] as number));
        }
        all.grown(i);
        // the history so far is the same on the larger graph
        expect(history(sims)).toEqual(before);
      }
      return { history: history(sims), growths };
    };
    const grown = run(false);
    expect(grown.growths).toBeGreaterThan(4);
    expect(grown.history).toEqual(history(whole));
    expect(run(true).history).toEqual(history(whole));
  });

  it('stops at its most colonies', () => {
    const { full } = grid(30);
    const sim = new FactionSim(full, 15 * 30 + 15, { ...def, incomeStep: 1, maxColonies: 12 }, { exp: false, k: 1 });
    sim.advanceTo(2300);
    expect(sim.colonies).toBe(12);
    expect(sim.capped).toBe(true);
    expect(sim.events.filter((e) => e.kind === COLONY)).toHaveLength(12);
  });
});

describe('faction world', () => {
  it('lists the stars of each place compactly and finds places by key', async () => {
    const { placeMembers } = await import('../../src/factions/world');
    const { KeyIndex } = await import('../../src/factions/sim');
    // two nodes: place 0 holds r0:1 and r1:0 (a system), place 1 r0:0, place 2 r1:2
    const net = {
      places: {
        count: 3,
        sources: [{ data: { path: 'r0' } }, { data: { path: 'r1' } }],
        starPlace: new Map([
          ['r0', Int32Array.from([1, 0, -1])],
          ['r1', Int32Array.from([0, -1, 2])],
        ]),
      },
    } as unknown as import('../../src/network/places').JumpNetwork;
    const m = placeMembers(net);
    expect([...m.start]).toEqual([0, 2, 3, 4]);
    expect([...m.source]).toEqual([0, 1, 0, 1]);
    expect([...m.index]).toEqual([1, 0, 0, 2]);
    const idx = new KeyIndex([30, 10, 20, 10.5], 4);
    expect([30, 10, 20, 10.5, 11].map((k) => idx.get(k))).toEqual([0, 1, 2, 3, -1]);
  });

  it('settles single stars of the chosen classes', async () => {
    const { targetsOf, readDef } = await import('../../src/factions/world');
    const { Flag } = await import('../../src/data/format');
    // stars: a G dwarf (place 0), a K dwarf in a system with an M dwarf (place 1), an F star (2), an M dwarf (3)
    const data = {
      path: 'r0',
      count: 5,
      flags: new Uint16Array([0, Flag.IN_SYSTEM, Flag.IN_SYSTEM, 0, 0]),
      spec: new Uint8Array([52, 51, 63, 35, 64]),
    } as unknown as import('../../src/data/format').NodeData;
    const net = {
      places: {
        count: 4,
        repSource: Int32Array.from([0, 0, 0, 0]),
        repIndex: Int32Array.from([0, 1, 3, 4]),
        system: Float64Array.from([-1, 7, -1, -1]),
        sources: [{ data }],
      },
    } as unknown as import('../../src/network/places').JumpNetwork;
    const members = { start: Int32Array.from([0, 1, 3, 4, 5]), source: new Int32Array(5), index: Int32Array.from([0, 1, 2, 3, 4]) };
    expect([...targetsOf(net, members, { targets: ['F', 'G', 'K'], singleOnly: true })]).toEqual([1, 0, 1, 0]);
    expect([...targetsOf(net, members, { targets: ['F', 'G', 'K'], singleOnly: false })]).toEqual([1, 1, 1, 0]);
    expect([...targetsOf(net, members, { targets: ['M'], singleOnly: true })]).toEqual([0, 0, 0, 1]);
    // a year typed with a thousands separator is still the year (shown without one)
    const { ungroup } = await import('../../src/ui/faction-box');
    expect(['2.027', '2,027', '2 027', '2027', '-1.000', '2.5', '12.34'].map(ungroup)).toEqual(['2027', '2027', '2027', '2027', '-1000', '2.5', '12.34']);
    // stored parameters are checked
    const d = readDef({ startYear: 2100.4, incomeStep: -3, maxColonies: 1e9, targets: ['G', 'X'], color: 'red' });
    expect(d.startYear).toBe(2100);
    expect(d.incomeStep).toBe(0.001);
    expect(d.maxColonies).toBe(1_000_000);
    expect(readDef({ region: 250 }).maxColonies).toBe(SOLAR_EMPIRE.maxColonies);
    // the region grows from 100 ly by a quarter each time, to 500 ly
    const { nextRegion, REGION_START } = await import('../../src/factions/world');
    const radii = [REGION_START];
    while (radii.length < 20 && radii[radii.length - 1] < 500) radii.push(nextRegion(radii[radii.length - 1]));
    expect(radii).toEqual([100, 125, 156, 195, 244, 305, 381, 500]);
    expect(d.targets).toEqual(['G']);
    expect(d.color).toBe(SOLAR_EMPIRE.color);
  });

  it('grows a large network quickly (incremental costs)', () => {
    // a grid of 120 x 120 places, 1 ly apart, every tenth one to settle
    const w = 120;
    const n = w * w;
    const a: number[] = [];
    const b: number[] = [];
    const len: number[] = [];
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) a.push(p), b.push(p + 1), len.push(1 + ((p * 7) % 5) / 4);
      if (y + 1 < w) a.push(p), b.push(p + w), len.push(1 + ((p * 3) % 5) / 4);
    }
    const target = new Uint8Array(n);
    for (let p = 0; p < n; p += 10) target[p] = 1;
    const g: FactionGraph = { count: n, keys: Array.from({ length: n }, (_, k) => k), links: { count: a.length, a, b, length: len }, target };
    const t0 = performance.now();
    const sim = new FactionSim(g, (w / 2) * w + w / 2, { ...def, incomeStep: 1 }, EXP2);
    sim.advanceTo(2400);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(sim.exhausted).toBe(true);
    // every place to settle became a colony (the home is one of them); stations only on the way
    expect(sim.events.filter((e) => e.kind === COLONY).length).toBe(n / 10);
    for (let p = 0; p < n; p += 10) expect(sim.owned[p]).toBe(COLONY);
    const stations = sim.events.filter((e) => e.kind === STATION);
    expect(stations.every((e) => !target[e.place])).toBe(true);
  });
});

describe('factions in steps', () => {
  it('gives the same history when simulated in small steps (pausing mid-year)', () => {
    // a grid of 60 x 60 places with two factions in opposite corners, every seventh place to settle
    const w = 60;
    const n = w * w;
    const a: number[] = [];
    const b: number[] = [];
    const len: number[] = [];
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) a.push(p), b.push(p + 1), len.push(1 + ((p * 7) % 5) / 4);
      if (y + 1 < w) a.push(p), b.push(p + w), len.push(1 + ((p * 3) % 5) / 4);
    }
    const target = new Uint8Array(n);
    for (let p = 3; p < n; p += 7) target[p] = 1;
    const g: FactionGraph = { count: n, keys: Array.from({ length: n }, (_, k) => k), links: { count: a.length, a, b, length: len }, target };
    const run = (chunked: boolean) => {
      const sims = [
        new FactionSim(g, 0, { ...def, id: 'a', incomeStep: 0.5 }, { exp: false, k: 1 }),
        new FactionSim(g, n - 1, { ...def, id: 'b', incomeStep: 0.5 }, { exp: false, k: 1 }),
      ];
      const all = new FactionsSim(sims);
      if (!chunked) all.advanceTo(2400);
      else for (let k = 0; k < 1e6 && all.year < 2400; k++) all.advanceTo(2400, performance.now() + 0.05);
      return sims.map((s) => s.events.map((e) => `${e.year}:${e.place}:${e.kind}`).join(' '));
    };
    const whole = run(false);
    expect(run(true)).toEqual(whole);
    // also when every search pauses after one place (the deadline long past)
    const batch = FactionSim.SEARCH_BATCH;
    FactionSim.SEARCH_BATCH = 1;
    try {
      const sims = [
        new FactionSim(g, 0, { ...def, id: 'a', incomeStep: 0.5 }, { exp: false, k: 1 }),
        new FactionSim(g, n - 1, { ...def, id: 'b', incomeStep: 0.5 }, { exp: false, k: 1 }),
      ];
      const all = new FactionsSim(sims);
      let calls = 0;
      for (; calls < 1e7 && all.year < 2400; calls++) all.advanceTo(2400, -1);
      expect(calls).toBeGreaterThan(1000);
      expect(sims.map((s) => s.events.map((e) => `${e.year}:${e.place}:${e.kind}`).join(' '))).toEqual(whole);
    } finally {
      FactionSim.SEARCH_BATCH = batch;
    }
    // both grew, and no place belongs to both
    const [pa, pb] = whole.map((h) => new Set(h.split(' ').map((e) => e.split(':')[1])));
    expect(pa.size).toBeGreaterThan(100);
    expect(pb.size).toBeGreaterThan(100);
    expect([...pa].filter((p) => pb.has(p))).toEqual([]);
  });
});
