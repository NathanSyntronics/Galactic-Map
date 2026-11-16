import { describe, expect, it } from 'vitest';
import { COLONY, FactionSim, SOLAR_EMPIRE, STATION, colonyIncome, type FactionDef, type FactionGraph } from '../../src/factions/sim';

/** Places 0 (home), 1 (on the way), 2 and 3 (to settle); links 0-1 and 1-2 of 2 ly, 0-3 of 5 ly. */
function graph(): FactionGraph {
  return {
    count: 4,
    keys: [0, 1, 2, 3],
    links: { count: 3, a: [0, 1, 0], b: [1, 2, 3], length: [2, 2, 5] },
    target: Uint8Array.from([0, 0, 1, 1]),
  };
}

const def: FactionDef = { ...SOLAR_EMPIRE, startYear: 2027, startIncome: 1, incomeStep: 0.2, maxIncome: 100, cost: { exp: true, k: 2 } };

describe('factions', () => {
  it('earns from 1 credit a year, 0.2 more each year, up to 100', () => {
    expect(colonyIncome(def, 0)).toBe(1);
    expect(colonyIncome(def, 10)).toBeCloseTo(3, 12);
    expect(colonyIncome(def, 495)).toBe(100);
    expect(colonyIncome(def, 2000)).toBe(100);
    expect(colonyIncome(def, -1)).toBe(0);
  });

  it('pays the jumps of the cheapest route: stations on the way, a colony at the end', () => {
    const sim = new FactionSim(graph(), 0, def);
    sim.advanceTo(2040);
    const ev = sim.events.map((e) => [e.year, e.place, e.kind, e.from]);
    // 2027: 1 credit; 2028: 2.2, the station at 1 (2 credits); 2030: 3.2, the colony at 2 (2 credits);
    // then 2 earns too (from 2031), and 2035 pays for the 5 ly jump to 3 (2^4 = 16 credits)
    expect(ev).toEqual([
      [2027, 0, COLONY, -1],
      [2028, 1, STATION, 0],
      [2030, 2, COLONY, 1],
      [2035, 3, COLONY, 0],
    ]);
    expect(sim.creditsAt(2027)).toBeCloseTo(1, 9);
    expect(sim.creditsAt(2030)).toBeCloseTo(1.2, 9);
    expect(sim.creditsAt(2035)).toBeCloseTo(3.2, 9);
    expect(sim.incomeAt(2031)).toBeCloseTo(1.8 + 1, 9);
    expect(sim.exhausted).toBe(true);
    expect(sim.countAt(2026)).toBe(0);
    expect(sim.countAt(2029)).toBe(2);
    expect(sim.countAt(2100)).toBe(4);
    expect([...sim.owned]).toEqual([COLONY, STATION, COLONY, COLONY]);
  });

  it('sums the incomes of the colonies like one by one', () => {
    const d = { ...def, startIncome: 2, incomeStep: 0.7, maxIncome: 9 };
    const sim = new FactionSim(graph(), 0, d);
    // colonies founded in these years earn from the next one
    const founded = [2030, 2030, 2041, 2050];
    for (const y of founded) (sim as unknown as { addColony(y: number): void }).addColony(y + 1);
    for (let y = 2027; y < 2080; y++) {
      const want = colonyIncome(d, y - 2027) + founded.reduce((s, f) => s + colonyIncome(d, y - f - 1), 0);
      expect(sim.income(y)).toBeCloseTo(want, 9);
    }
  });

  it('polynomial costs and the cheapest target from any of its systems', () => {
    // with d^2 the route through 1 costs 8, the jump to 3 costs 25
    const sim = new FactionSim(graph(), 0, { ...def, cost: { exp: false, k: 2 } });
    sim.advanceTo(2060);
    expect(sim.events.map((e) => e.place)).toEqual([0, 1, 2, 3]);
    expect(sim.events[1].cost).toBe(4);
  });
});

describe('faction world', () => {
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
    const members = [[{ path: 'r0', index: 0 }], [{ path: 'r0', index: 1 }, { path: 'r0', index: 2 }], [{ path: 'r0', index: 3 }], [{ path: 'r0', index: 4 }]];
    expect([...targetsOf(net, members, { targets: ['F', 'G', 'K'], singleOnly: true })]).toEqual([1, 0, 1, 0]);
    expect([...targetsOf(net, members, { targets: ['F', 'G', 'K'], singleOnly: false })]).toEqual([1, 1, 1, 0]);
    expect([...targetsOf(net, members, { targets: ['M'], singleOnly: true })]).toEqual([0, 0, 0, 1]);
    // stored parameters are checked
    const d = readDef({ startYear: 2100.4, cost: { k: 99 }, region: 1e6, targets: ['G', 'X'], color: 'red' });
    expect(d.startYear).toBe(2100);
    expect(d.cost).toEqual({ exp: true, k: 5 });
    expect(d.region).toBe(250);
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
    const sim = new FactionSim(g, (w / 2) * w + w / 2, def);
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
