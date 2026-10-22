import { describe, expect, it } from 'vitest';
import { LinkKind } from '../../src/network/jumps';
import {
  MERGE_DISTANCE,
  attributeCapacity,
  buildPlaces,
  computeNetwork,
  linksOfStar,
  networkServes,
  placeOfStar,
  type CapacityRule,
  type JumpNetwork,
  type NetworkOptions,
  type PlaceSource,
} from '../../src/network/places';
import { capacityFromLogL } from '../../src/network/jumps';
import { source, type Star } from './fixtures/stars';

const capacityOf = (logL: number) => capacityFromLogL(logL, 3, 7, 12);

const ordinals = new Map(['r', 'r0', 'r1', 'r2', 'r3'].map((p, k) => [p, k]));
const luminosity: CapacityRule = { by: 'luminosity', faint: 3, sun: 7, bright: 12 };
const base = {
  centre: { x: 0, y: 0, z: 0 },
  radius: 100,
  capacity: luminosity,
  nodeKey: (p: string) => ordinals.get(p) ?? 99,
};
const netOptions = (patch: Partial<NetworkOptions> = {}): NetworkOptions => ({
  ...base,
  range: 10,
  hub: 1,
  kSun: 7,
  connect: true,
  ...patch,
});

/** Links as sorted pairs of representative keys (independent of place numbering). */
function linkKeys(sources: PlaceSource[], opt: NetworkOptions): string[] {
  const net = computeNetwork(sources, opt);
  const { places, links } = net;
  const out: string[] = [];
  for (let k = 0; k < links.count; k++) {
    const a = places.keys[links.a[k]];
    const b = places.keys[links.b[k]];
    out.push(`${Math.min(a, b)}-${Math.max(a, b)}/${links.kind[k]}`);
  }
  return out.sort();
}

describe('places', () => {
  it('groups a system across nodes and represents it by its most luminous shown member', () => {
    const a = source('r', [
      { x: 0, logL: 0, system: 7 },
      { x: 5, logL: -1 },
    ]);
    const b = source('r0', [
      { x: 0.01, logL: 1.5, system: 7 },
      { x: 0.02, logL: 2, system: 7, hidden: true },
    ]);
    const p = buildPlaces([a, b], base);
    expect(p.count).toBe(2);
    const sys = placeOfStar(p, 'r', 0);
    expect(placeOfStar(p, 'r0', 0)).toBe(sys);
    // the hidden, brighter member neither represents nor belongs to the place
    expect(placeOfStar(p, 'r0', 1)).toBe(-1);
    expect(p.sources[p.repSource[sys]].data.path).toBe('r0');
    expect(p.repIndex[sys]).toBe(0);
    expect(p.system[sys]).toBe(7);
    expect(p.capacities[sys]).toBe(12);
    expect([...p.positions.subarray(3 * sys, 3 * sys + 3)]).toEqual([Math.fround(0.01), 0, 0]);
    const single = placeOfStar(p, 'r', 1);
    expect(p.system[single]).toBe(-1);
    // log L = -1: 3 + 4 * 3.5 / 4.5 = 6.1
    expect(p.capacities[single]).toBe(6);
  });

  it('takes only the shown stars within the radius', () => {
    const a = source('r', [
      { x: 10, logL: 0 },
      { x: 30, logL: 0 },
      { x: 0, y: 19.9, logL: 0, hidden: true },
    ]);
    const p = buildPlaces([a], { ...base, centre: { x: 0, y: 0, z: 0 }, radius: 20 });
    expect(p.count).toBe(1);
    expect(placeOfStar(p, 'r', 0)).toBe(0);
    expect(placeOfStar(p, 'r', 1)).toBe(-1);
    expect(placeOfStar(p, 'r', 2)).toBe(-1);
    expect(placeOfStar(p, 'r9', 0)).toBe(-1);
  });

  it('chooses the representative of equally luminous members by a stable key', () => {
    const a = source('r1', [{ x: 1, logL: 0, system: 3 }]);
    const b = source('r0', [{ x: 2, logL: 0, system: 3 }]);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const p = buildPlaces(order, base);
      expect(p.count).toBe(1);
      expect(p.sources[p.repSource[0]].data.path).toBe('r0');
      expect(p.positions[0]).toBe(2);
    }
  });

  it('sets capacities by an attribute, with a fallback to other members and to faint', () => {
    const a = source('r', [
      { x: 0, logL: 2, system: 1 },
      { x: 0.1, logL: -2, system: 1 },
      { x: 0.2, logL: -1, system: 1 },
      { x: 20, logL: 0 },
      { x: 40, logL: 0 },
    ]);
    // values: star 1 -> 1.0, star 2 -> 0.5, star 3 -> 0.25, star 4 none
    const values = new Map([
      [1, 1],
      [2, 0.5],
      [3, 0.25],
    ]);
    const rule: CapacityRule = { by: 'position', position: (_d, i) => values.get(i), faint: 2, bright: 10 };
    const p = buildPlaces([a], { ...base, capacity: rule });
    // the representative (star 0) has no value: the most luminous member with one (star 2) counts
    expect(p.capacities[placeOfStar(p, 'r', 0)]).toBe(6);
    expect(p.capacities[placeOfStar(p, 'r', 3)]).toBe(4);
    expect(p.capacities[placeOfStar(p, 'r', 4)]).toBe(2);
  });

  it('merges places closer than 0.1 ly into one, represented by the most luminous member', () => {
    expect(MERGE_DISTANCE).toBe(0.1);
    // a binary without a system id (0.01 ly), a system with a close single star, and a pair
    // just over the distance
    const a = source('r', [
      { x: 0, logL: -1 },
      { x: 0.01, logL: -0.5 },
      { x: 5, logL: 0, system: 4 },
      { x: 5.2, logL: -1, system: 4 },
      { x: 20, logL: 0 },
      { x: 20.15, logL: 0 },
    ]);
    const b = source('r0', [{ x: 5.05, logL: 1 }]);
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const p = buildPlaces(order, base);
      expect(p.count).toBe(4);
      const bin = placeOfStar(p, 'r', 0);
      expect(placeOfStar(p, 'r', 1)).toBe(bin);
      expect(p.repIndex[bin]).toBe(1);
      expect(p.positions[3 * bin]).toBe(Math.fround(0.01));
      // the system and a bright star 0.05 ly from its representative: one place, led by that star
      const sys = placeOfStar(p, 'r', 2);
      expect(placeOfStar(p, 'r', 3)).toBe(sys);
      expect(placeOfStar(p, 'r0', 0)).toBe(sys);
      expect(p.sources[p.repSource[sys]].data.path).toBe('r0');
      expect(p.capacities[sys]).toBe(capacityOf(1));
      expect(p.system[sys]).toBe(-1);
      expect(placeOfStar(p, 'r', 4)).not.toBe(placeOfStar(p, 'r', 5));
    }
    const net = computeNetwork([a, b], netOptions());
    for (let k = 0; k < net.links.count; k++) expect(net.links.length[k]).toBeGreaterThan(MERGE_DISTANCE);
    expect(linksOfStar(net, 'r', 0)).toEqual(linksOfStar(net, 'r', 1));
  });

  it('takes the attribute value of another star of a merged place', () => {
    const a = source('r', [
      { x: 0, logL: 0 },
      { x: 0.05, logL: -2 },
    ]);
    const rule: CapacityRule = { by: 'position', position: (_d, i) => (i === 1 ? 1 : undefined), faint: 2, bright: 10 };
    const p = buildPlaces([a], { ...base, capacity: rule });
    expect(p.count).toBe(1);
    expect(p.repIndex[0]).toBe(0);
    expect(p.capacities[0]).toBe(10);
  });

  it('gives higher attribute values more links, also on a reversed colour scale', () => {
    const a = source('r', [
      { x: 0, logL: 0 },
      { x: 20, logL: 0 },
      { x: 40, logL: 0 },
      { x: 60, logL: 0 },
    ]);
    const values = [3000, 10000, 30000, undefined];
    for (const reverse of [false, true]) {
      const scale = { min: 2000, max: 40000, log: true, reverse };
      const p = buildPlaces([a], { ...base, capacity: attributeCapacity((_d, i) => values[i], scale, 3, 12) });
      const caps = [0, 1, 2, 3].map((i) => p.capacities[placeOfStar(p, 'r', i)]);
      expect(caps[0]).toBeLessThan(caps[1]);
      expect(caps[1]).toBeLessThan(caps[2]);
      // no value: the lowest number
      expect(caps[3]).toBe(3);
    }
    // the ends of the scale give the lowest and the highest number
    const lin = attributeCapacity((_d, i) => [0, 10][i], { min: 0, max: 10 }, 3, 12);
    const p = buildPlaces([source('r', [{ x: 0, logL: 0 }, { x: 20, logL: 0 }])], { ...base, capacity: lin });
    expect([p.capacities[0], p.capacities[1]]).toEqual([3, 12]);
  });

  it('stops at maxPlaces', () => {
    const a = source(
      'r',
      Array.from({ length: 20 }, (_, i) => ({ x: i, logL: 0 })),
    );
    const net = computeNetwork([a], netOptions({ maxPlaces: 10 }));
    expect(net.places.overflow).toBe(true);
    expect(net.overflow).toBe('places');
    expect(net.links.count).toBe(0);
    expect(computeNetwork([a], netOptions({ maxPlaces: 20 })).overflow).toBe(null);
  });

  it('reports too many candidate pairs', () => {
    const a = source(
      'r',
      Array.from({ length: 30 }, (_, i) => ({ x: i * 0.2, logL: 0 })),
    );
    const net = computeNetwork([a], netOptions({ maxCandidates: 100 }));
    expect(net.overflow).toBe('pairs');
    expect(net.links.count).toBe(0);
  });
});

describe('network of places', () => {
  /** Two systems and some single stars spread over three nodes. */
  function cloud(): PlaceSource[] {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const nodes: PlaceSource[] = [];
    for (const path of ['r', 'r0', 'r1']) {
      const stars: Star[] = [];
      for (let i = 0; i < 60; i++) {
        stars.push({ x: rnd() * 60 - 30, y: rnd() * 60 - 30, z: rnd() * 60 - 30, logL: rnd() * 6 - 4.5 });
      }
      stars.push({ x: 1, logL: path === 'r' ? 1 : -2, system: 1 });
      stars.push({ x: -9, y: 3, logL: path === 'r1' ? 0.5 : -3, system: 2 });
      nodes.push(source(path, stars));
    }
    return nodes;
  }

  it('does not depend on the order of the nodes', () => {
    const nodes = cloud();
    const expected = linkKeys(nodes, netOptions());
    expect(expected.length).toBeGreaterThan(100);
    expect(linkKeys([...nodes].reverse(), netOptions())).toEqual(expected);
    expect(linkKeys([nodes[1], nodes[2], nodes[0]], netOptions())).toEqual(expected);
  });

  it('never links members of one system to each other and lists the place links for every member', () => {
    const nodes = cloud();
    const net = computeNetwork(nodes, netOptions());
    const sys = placeOfStar(net.places, 'r', 60);
    expect(placeOfStar(net.places, 'r0', 60)).toBe(sys);
    expect(placeOfStar(net.places, 'r1', 60)).toBe(sys);
    for (let k = 0; k < net.links.count; k++) expect(net.links.a[k]).not.toBe(net.links.b[k]);
    const fromRep = linksOfStar(net, 'r', 60);
    const fromMember = linksOfStar(net, 'r1', 60);
    expect(fromRep?.place).toBe(sys);
    expect(fromMember).toEqual(fromRep);
    expect(fromRep!.links.length).toBeGreaterThan(0);
    // nearest first, all within the range
    const lengths = fromRep!.links.map((l) => l.length);
    expect(lengths).toEqual([...lengths].sort((x, y) => x - y));
    for (const l of fromRep!.links) expect(l.length).toBeLessThanOrEqual(10);
    expect(linksOfStar(net, 'r3', 0)).toBe(null);
  });

  it('gives hidden stars no links, and changes the network when a star is hidden', () => {
    const nodes = cloud();
    const before = computeNetwork(nodes, netOptions());
    const victim = placeOfStar(before.places, 'r0', 5);
    expect(victim).toBeGreaterThanOrEqual(0);
    nodes[1].sizes[5] = 0;
    const after = computeNetwork(nodes, netOptions());
    expect(placeOfStar(after.places, 'r0', 5)).toBe(-1);
    expect(after.places.count).toBe(before.places.count - 1);
  });

  it('marks the links of a lonely pair as nobody-alone links when capacities are zero', () => {
    const a = source('r', [
      { x: 0, logL: -5 },
      { x: 4, logL: -5 },
      { x: 50, logL: -5 },
    ]);
    const net = computeNetwork([a], netOptions({ capacity: { by: 'luminosity', faint: 0, sun: 7, bright: 12 } }));
    expect(net.links.count).toBe(1);
    expect(net.links.kind[0]).toBe(LinkKind.ALONE);
    expect(linksOfStar(net, 'r', 2)?.links).toEqual([]);
  });
});

describe('keeping a network while zooming', () => {
  const net = (region: number, overflow: JumpNetwork['overflow'] = null, x = 0) =>
    ({ centre: { x, y: 0, z: 0 }, region, range: 9, overflow }) as unknown as JumpNetwork;
  const o = { x: 0, y: 0, z: 0 };

  it('serves a smaller radius until its region is 1.5 times the needed one', () => {
    // computed at radius 160: region 160 + 27
    const n = net(187);
    expect(networkServes(n, o, 160)).toBe(true);
    expect(networkServes(n, o, 120)).toBe(true);
    // 187 > 1.5 * (97 + 27)
    expect(networkServes(n, o, 97)).toBe(false);
  });

  it('does not serve a larger radius, a moved centre or an incomplete network', () => {
    expect(networkServes(net(47), o, 21)).toBe(false);
    expect(networkServes(net(47), o, 20)).toBe(true);
    expect(networkServes(net(187), { x: 30, y: 0, z: 0 }, 150)).toBe(false);
    expect(networkServes(net(187, 'detail'), o, 120)).toBe(false);
    expect(networkServes(net(187, 'places'), o, 120)).toBe(false);
    expect(networkServes(null, o, 20)).toBe(false);
  });
});
